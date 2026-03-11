import { randomUUID } from "node:crypto";
import type { EnvironmentAgentCommandAck } from "./protocol.js";
import { type EnvironmentAgentRuntime } from "./runtime.js";
import { isEnvironmentAgentSessionInactiveError } from "./session-http-client.js";
import type { EnvironmentAgentSessionRuntime } from "./session-runtime.js";
import type {
  EnvironmentAgentPulledCommand,
  EnvironmentAgentSessionSync,
} from "./session-sync.js";

export interface EnvironmentAgentSessionSupervisorOptions {
  threadId: string;
  runtime: EnvironmentAgentRuntime;
  sessionRuntime: EnvironmentAgentSessionRuntime;
  sessionSync: EnvironmentAgentSessionSync;
  agentId?: string;
  agentInstanceId?: string;
  pollIntervalMs?: number;
  commandBatchLimit?: number;
  onError?: (error: unknown) => void;
  onQuiescent?: () => void | Promise<void>;
  selfSuspendDebounceMs?: number;
}

const DEFAULT_POLL_INTERVAL_MS = 250;
const DEFAULT_COMMAND_BATCH_LIMIT = 50;
const DEFAULT_COMMAND_LONG_POLL_MS = 10_000;
const DEFAULT_SELF_SUSPEND_DEBOUNCE_MS = 1_000;
const DEFAULT_HEARTBEAT_INTERVAL_MS = 10_000;
const MAX_ERROR_BACKOFF_MS = 30_000;

function normalizeHeartbeatIntervalMs(value: number): number {
  return Number.isFinite(value) && value > 0
    ? Math.floor(value)
    : DEFAULT_HEARTBEAT_INTERVAL_MS;
}

function isAbortError(error: unknown): error is Error {
  return error instanceof Error && error.name === "AbortError";
}

function toCommandEnvelope(args: {
  threadId: string;
  commandId: string;
  command: import("./protocol.js").EnvironmentAgentCommand;
  sentAt: number;
}) {
  return {
    meta: {
      protocolVersion: 1 as const,
      commandId: args.commandId,
      idempotencyKey: args.commandId,
      sentAt: args.sentAt,
      threadId: args.threadId,
    },
    command: args.command,
  };
}

function normalizeRejectedCommandError(ack: EnvironmentAgentCommandAck): {
  errorCode?: string;
  errorMessage: string;
} {
  return {
    ...(ack.errorCode ? { errorCode: ack.errorCode } : {}),
    errorMessage: ack.message ?? "Environment-agent command rejected",
  };
}

export class EnvironmentAgentSessionSupervisor {
  private readonly agentId: string;
  private readonly agentInstanceId: string;
  private readonly pollIntervalMs: number;
  private readonly commandBatchLimit: number;
  private readonly onError?: (error: unknown) => void;
  private readonly onQuiescent?: () => void | Promise<void>;
  private readonly selfSuspendDebounceMs: number;
  private pollTimer: ReturnType<typeof setTimeout> | undefined;
  private selfSuspendTimer: ReturnType<typeof setTimeout> | undefined;
  private running = false;
  private cycleInFlight = false;
  private selfSuspendInFlight = false;
  private consecutiveFailureCount = 0;
  private heartbeatIntervalMs = DEFAULT_HEARTBEAT_INTERVAL_MS;
  private nextHeartbeatAt = 0;
  private commandPullController: AbortController | undefined;
  private readonly unsubscribeRuntimeEvents: () => void;

  constructor(private readonly options: EnvironmentAgentSessionSupervisorOptions) {
    this.agentId = options.agentId ?? `environment-agent:${options.threadId}`;
    this.agentInstanceId = options.agentInstanceId ?? randomUUID();
    this.pollIntervalMs = options.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
    this.commandBatchLimit = options.commandBatchLimit ?? DEFAULT_COMMAND_BATCH_LIMIT;
    this.onError = options.onError;
    this.onQuiescent = options.onQuiescent;
    this.selfSuspendDebounceMs =
      options.selfSuspendDebounceMs ?? DEFAULT_SELF_SUSPEND_DEBOUNCE_MS;

    this.options.sessionRuntime.initializeThread({
      threadId: options.threadId,
      agentId: this.agentId,
      agentInstanceId: this.agentInstanceId,
      generation: 1,
    });
    this.unsubscribeRuntimeEvents = this.options.runtime.subscribeToEvents((event) => {
      this.options.sessionRuntime.recordEvent({
        threadId: options.threadId,
        eventId: `evt-${event.sequence}`,
        event: event.event,
        emittedAt: event.emittedAt,
      });
      this.cancelSelfSuspend();
      this.cancelPendingCommandPull();
      this.scheduleImmediateCycle();
    });
  }

  async start(): Promise<void> {
    if (this.running) {
      return;
    }
    this.running = true;
    try {
      await this.openSession();
      await this.runCycle();
    } catch (error) {
      this.handleError(error);
    }
    this.refreshSelfSuspendState();
    this.scheduleNextCycle();
  }

  async close(): Promise<void> {
    this.running = false;
    if (this.pollTimer) {
      clearTimeout(this.pollTimer);
      this.pollTimer = undefined;
    }
    this.cancelSelfSuspend();
    this.cancelPendingCommandPull();
    const state = this.options.sessionRuntime.loadThreadState(this.options.threadId);
    if (state?.sessionId) {
      try {
        await this.options.sessionSync.closeSession(this.options.threadId, "agent_shutdown");
      } catch (error) {
        this.handleError(error);
      }
    }
    this.unsubscribeRuntimeEvents();
    while (this.cycleInFlight) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
  }

  private async openSession(): Promise<void> {
    const state = this.options.sessionRuntime.loadThreadState(this.options.threadId);
    if (state?.sessionId) {
      return;
    }
    const welcome = await this.options.sessionSync.openSession({
      threadId: this.options.threadId,
      payload: {
        agentId: this.agentId,
        agentInstanceId: this.agentInstanceId,
        supportedProtocolVersions: [1],
        supportedTransports: ["http-long-poll"],
        channels: [
          {
            channelId: this.options.threadId,
            generation: state?.generation ?? 1,
            ...(state?.lastAcked ? { lastDaemonAcked: state.lastAcked } : {}),
          },
        ],
      },
    });
    this.heartbeatIntervalMs = normalizeHeartbeatIntervalMs(
      welcome.payload.heartbeatIntervalMs,
    );
    this.nextHeartbeatAt = Date.now() + this.heartbeatIntervalMs;
  }

  private scheduleNextCycle(): void {
    if (!this.running || this.pollTimer) {
      return;
    }
    const backoffMs =
      this.consecutiveFailureCount > 0
        ? Math.min(
            this.pollIntervalMs * 2 ** Math.min(this.consecutiveFailureCount, 7),
            MAX_ERROR_BACKOFF_MS,
          )
        : this.pollIntervalMs;
    this.pollTimer = setTimeout(() => {
      this.pollTimer = undefined;
      void this.runCycleSafely();
    }, backoffMs);
  }

  private scheduleImmediateCycle(): void {
    if (!this.running) {
      return;
    }
    if (this.pollTimer) {
      clearTimeout(this.pollTimer);
      this.pollTimer = undefined;
    }
    queueMicrotask(() => {
      void this.runCycleSafely();
    });
  }

  private async runCycleSafely(): Promise<void> {
    if (!this.running || this.cycleInFlight) {
      this.scheduleNextCycle();
      return;
    }
    try {
      await this.runCycle();
      this.consecutiveFailureCount = 0;
    } catch (error) {
      const recovered = this.handleSessionError(error);
      this.consecutiveFailureCount = recovered
        ? 0
        : this.consecutiveFailureCount + 1;
      this.handleError(error);
    } finally {
      this.refreshSelfSuspendState();
      this.scheduleNextCycle();
    }
  }

  private async runCycle(): Promise<void> {
    if (this.cycleInFlight) {
      return;
    }
    this.cycleInFlight = true;
    try {
      await this.openSession();
      if (this.isHeartbeatDue()) {
        await this.options.sessionSync.sendHeartbeat(this.options.threadId);
        this.nextHeartbeatAt = Date.now() + this.heartbeatIntervalMs;
      }
      await this.options.sessionSync.flushPendingEvents(this.options.threadId);
      const state = this.options.sessionRuntime.loadThreadState(this.options.threadId);
      const commands = await this.pullCommands(state?.lastDeliveredCommandCursor);
      if (!this.running) {
        return;
      }
      for (const command of commands) {
        if (command.ackState === "duplicate") {
          continue;
        }
        this.options.sessionRuntime.markCommandStarted(command.commandId);
        await this.options.sessionSync.flushPendingCommandResults(this.options.threadId);
        const ack = await this.options.runtime.executeCommand(
          toCommandEnvelope({
            threadId: this.options.threadId,
            commandId: command.commandId,
            command: command.command,
            sentAt: Date.now(),
          }),
        );
        if (ack.state === "accepted") {
          this.options.sessionRuntime.markCommandCompleted({
            commandId: command.commandId,
            ...(ack.result !== undefined ? { result: ack.result } : {}),
          });
        } else {
          this.options.sessionRuntime.markCommandFailed({
            commandId: command.commandId,
            ...normalizeRejectedCommandError(ack),
          });
        }
        await this.options.sessionSync.flushPendingCommandResults(this.options.threadId);
      }
      if (commands.length === 0) {
        await this.options.sessionSync.flushPendingCommandResults(this.options.threadId);
      }
      if (this.isHeartbeatDue()) {
        await this.options.sessionSync.sendHeartbeat(this.options.threadId);
        this.nextHeartbeatAt = Date.now() + this.heartbeatIntervalMs;
      }
    } finally {
      this.cycleInFlight = false;
    }
  }

  private handleError(error: unknown): void {
    this.onError?.(error);
  }

  private handleSessionError(error: unknown): boolean {
    if (!isEnvironmentAgentSessionInactiveError(error)) {
      return false;
    }
    this.options.sessionRuntime.clearSession(this.options.threadId);
    this.heartbeatIntervalMs = DEFAULT_HEARTBEAT_INTERVAL_MS;
    this.nextHeartbeatAt = 0;
    return true;
  }

  private isHeartbeatDue(now: number = Date.now()): boolean {
    return now >= this.nextHeartbeatAt;
  }

  private cancelPendingCommandPull(): void {
    if (!this.commandPullController || this.commandPullController.signal.aborted) {
      return;
    }
    this.commandPullController.abort();
  }

  private getCommandPullWaitMs(now: number = Date.now()): number {
    if (this.nextHeartbeatAt <= 0) {
      return DEFAULT_COMMAND_LONG_POLL_MS;
    }
    return Math.max(
      0,
      Math.min(DEFAULT_COMMAND_LONG_POLL_MS, this.nextHeartbeatAt - now),
    );
  }

  private async pullCommands(
    afterCursor?: number,
  ): Promise<EnvironmentAgentPulledCommand[]> {
    const controller = new AbortController();
    this.commandPullController = controller;
    try {
      return await this.options.sessionSync.pullCommands({
        threadId: this.options.threadId,
        ...(afterCursor !== undefined ? { afterCursor } : {}),
        limit: this.commandBatchLimit,
        waitMs: this.getCommandPullWaitMs(),
        signal: controller.signal,
      });
    } catch (error) {
      if (isAbortError(error)) {
        return [];
      }
      throw error;
    } finally {
      if (this.commandPullController === controller) {
        this.commandPullController = undefined;
      }
    }
  }

  private cancelSelfSuspend(): void {
    if (!this.selfSuspendTimer) {
      return;
    }
    clearTimeout(this.selfSuspendTimer);
    this.selfSuspendTimer = undefined;
  }

  private refreshSelfSuspendState(): void {
    if (!this.onQuiescent) {
      return;
    }
    if (!this.isQuiescentForSelfSuspend()) {
      this.cancelSelfSuspend();
      return;
    }
    if (this.selfSuspendTimer || this.selfSuspendInFlight) {
      return;
    }
    this.selfSuspendTimer = setTimeout(() => {
      this.selfSuspendTimer = undefined;
      void this.triggerSelfSuspendIfStillQuiescent();
    }, this.selfSuspendDebounceMs);
    this.selfSuspendTimer.unref?.();
  }

  private async triggerSelfSuspendIfStillQuiescent(): Promise<void> {
    if (!this.isQuiescentForSelfSuspend() || !this.onQuiescent) {
      this.refreshSelfSuspendState();
      return;
    }
    this.selfSuspendInFlight = true;
    try {
      await this.onQuiescent();
    } catch (error) {
      this.handleError(error);
    } finally {
      this.selfSuspendInFlight = false;
    }
  }

  private isQuiescentForSelfSuspend(): boolean {
    if (!this.running || this.cycleInFlight || this.selfSuspendInFlight) {
      return false;
    }
    const runtimeSnapshot = this.options.runtime.getQuiescenceSnapshot();
    const drainSnapshot = this.options.sessionRuntime.getDrainSnapshot(
      this.options.threadId,
    );
    if (!runtimeSnapshot.hasObservedWork) {
      return false;
    }
    if (runtimeSnapshot.turnState !== "idle") {
      return false;
    }
    if (runtimeSnapshot.commandExecutionCount > 0) {
      return false;
    }
    if (runtimeSnapshot.pendingProviderRequestCount > 0) {
      return false;
    }
    if (drainSnapshot.pendingEventCount > 0) {
      return false;
    }
    if (drainSnapshot.pendingCommandAckCount > 0) {
      return false;
    }
    if (drainSnapshot.pendingCommandResultCount > 0) {
      return false;
    }
    return true;
  }
}
