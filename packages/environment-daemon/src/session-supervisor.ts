import { randomUUID } from "node:crypto";
import type { EnvironmentDaemonCommandAck } from "./protocol.js";
import { type EnvironmentDaemonRuntime } from "./runtime.js";
import { isEnvironmentDaemonSessionInactiveError } from "./session-http-client.js";
import type { EnvironmentDaemonSessionRuntime } from "./session-runtime.js";
import type {
  EnvironmentDaemonPulledCommand,
  EnvironmentDaemonSessionSync,
} from "./session-sync.js";
import type { EnvironmentDaemonSessionControlEndpoint } from "./session-protocol.js";
import type { EnvironmentDaemonSessionProviderResponsePayload } from "./session-protocol.js";
import type {
  EnvironmentDaemonSessionCapabilities,
  EnvironmentDaemonSessionProviderMetadata,
  EnvironmentDaemonSessionProtocolVersion,
  EnvironmentDaemonSessionWorkerMetadata,
} from "./session-protocol.js";
import { ENVIRONMENT_DAEMON_SESSION_SUPPORTED_PROTOCOL_VERSIONS } from "./session-protocol.js";

export interface EnvironmentDaemonSessionSupervisorOptions {
  environmentId: string;
  runtime: EnvironmentDaemonRuntime;
  sessionRuntime: EnvironmentDaemonSessionRuntime;
  sessionSync: EnvironmentDaemonSessionSync;
  supportedProtocolVersions?: readonly EnvironmentDaemonSessionProtocolVersion[];
  advertisedCapabilities?: EnvironmentDaemonSessionCapabilities;
  controlEndpoint?: EnvironmentDaemonSessionControlEndpoint;
  workerMetadata?: EnvironmentDaemonSessionWorkerMetadata;
  providerMetadata?: EnvironmentDaemonSessionProviderMetadata[];
  agentId?: string;
  agentInstanceId?: string;
  pollIntervalMs?: number;
  commandBatchLimit?: number;
  eventFlushDebounceMs?: number;
  onError?: (error: unknown) => void;
}

const DEFAULT_POLL_INTERVAL_MS = 250;
const DEFAULT_COMMAND_BATCH_LIMIT = 50;
const DEFAULT_COMMAND_LONG_POLL_MS = 10_000;
const DEFAULT_HEARTBEAT_INTERVAL_MS = 10_000;
const MAX_ERROR_BACKOFF_MS = 30_000;
const DEFAULT_EVENT_FLUSH_DEBOUNCE_MS = 250;

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
  command: import("./protocol.js").EnvironmentDaemonCommand;
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

function normalizeRejectedCommandError(ack: EnvironmentDaemonCommandAck): {
  errorCode?: string;
  errorMessage: string;
} {
  return {
    ...(ack.errorCode ? { errorCode: ack.errorCode } : {}),
    errorMessage: ack.message ?? "Environment-daemon command rejected",
  };
}

export class EnvironmentDaemonSessionSupervisor {
  private readonly agentId: string;
  private readonly agentInstanceId: string;
  private readonly pollIntervalMs: number;
  private readonly commandBatchLimit: number;
  private readonly eventFlushDebounceMs: number;
  private readonly supportedProtocolVersions: readonly EnvironmentDaemonSessionProtocolVersion[];
  private readonly onError?: (error: unknown) => void;
  private pollTimer: ReturnType<typeof setTimeout> | undefined;
  private eventFlushTimer: ReturnType<typeof setTimeout> | undefined;
  private running = false;
  private cycleInFlight = false;
  private consecutiveFailureCount = 0;
  private heartbeatIntervalMs = DEFAULT_HEARTBEAT_INTERVAL_MS;
  private nextHeartbeatAt = 0;
  private sessionId: string | undefined;
  private commandPullController: AbortController | undefined;
  private lastCommandPullAbortAt = 0;
  private readonly unsubscribeRuntimeEvents: () => void;

  constructor(private readonly options: EnvironmentDaemonSessionSupervisorOptions) {
    this.agentId = options.agentId ?? `environment-daemon:${options.environmentId}`;
    this.agentInstanceId = options.agentInstanceId ?? randomUUID();
    this.pollIntervalMs = options.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
    this.commandBatchLimit = options.commandBatchLimit ?? DEFAULT_COMMAND_BATCH_LIMIT;
    this.eventFlushDebounceMs =
      options.eventFlushDebounceMs ?? DEFAULT_EVENT_FLUSH_DEBOUNCE_MS;
    this.supportedProtocolVersions =
      options.supportedProtocolVersions ??
      ENVIRONMENT_DAEMON_SESSION_SUPPORTED_PROTOCOL_VERSIONS;
    this.onError = options.onError;

    this.unsubscribeRuntimeEvents = this.options.runtime.subscribeToEvents((event) => {
      this.ensureThreadState(event.threadId);
      this.options.sessionRuntime.recordEvent({
        threadId: event.threadId,
        eventId: `evt-${event.sequence}`,
        event: event.event,
        emittedAt: event.emittedAt,
      });
      this.requestEventFlush();
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
    this.publishRuntimeDeliveryState();
    this.scheduleNextCycle();
  }

  poke(): void {
    if (!this.running) {
      return;
    }
    this.consecutiveFailureCount = 0;
    this.cancelPendingCommandPull();
    this.publishRuntimeDeliveryState();
    this.scheduleImmediateCycle();
  }

  async close(): Promise<void> {
    this.running = false;
    if (this.pollTimer) {
      clearTimeout(this.pollTimer);
      this.pollTimer = undefined;
    }
    if (this.eventFlushTimer) {
      clearTimeout(this.eventFlushTimer);
      this.eventFlushTimer = undefined;
    }
    this.cancelPendingCommandPull();
    while (this.cycleInFlight) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    this.unsubscribeRuntimeEvents();
    this.publishRuntimeDeliveryState();

    if (!this.sessionId) {
      return;
    }

    try {
      await this.flushPendingEventsWithReplay();
      await this.options.sessionSync.flushPendingCommandResultsForThreads({
        sessionId: this.sessionId,
        threadIds: this.getThreadIds(),
      });
      await this.flushPendingEventsWithReplay();
      await this.options.sessionSync.closeSession(this.sessionId, "agent_shutdown");
    } catch (error) {
      const recovered = this.handleSessionError(error);
      if (!recovered) {
        this.handleError(error);
      }
    }
  }

  async forwardProviderRequest(args: {
    requestId: string | number;
    method: string;
    params?: unknown;
    providerId?: string;
    normalizedMethod?: string;
    toolCall?: import("@bb/core").ProviderToolCallRequest;
    threadId?: string;
  }): Promise<EnvironmentDaemonSessionProviderResponsePayload> {
    await this.openSession();
    if (!args.threadId) {
      throw new Error("Environment-daemon provider request is missing a resolved threadId");
    }
    const sessionId = this.requireSessionId();
    return this.options.sessionSync.forwardProviderRequest({
      sessionId,
      threadId: args.threadId,
      requestId: args.requestId,
      method: args.method,
      ...(args.params !== undefined ? { params: args.params } : {}),
      ...(args.providerId ? { providerId: args.providerId } : {}),
      ...(args.normalizedMethod
        ? { normalizedMethod: args.normalizedMethod }
        : {}),
      ...(args.toolCall ? { toolCall: args.toolCall } : {}),
    });
  }

  private async openSession(): Promise<void> {
    if (this.sessionId) {
      return;
    }
    const channelBootstraps = this.options.sessionRuntime.listThreadIds().map((threadId) => {
      const state = this.options.sessionRuntime.loadThreadState(threadId);
      return {
        channelId: threadId,
        generation: state?.generation ?? 1,
        ...(state?.lastAcked ? { lastServerAcked: state.lastAcked } : {}),
      };
    });
    const welcome = await this.options.sessionSync.openSession({
      payload: {
        agentId: this.agentId,
        agentInstanceId: this.agentInstanceId,
        supportedProtocolVersions: [...this.supportedProtocolVersions],
        ...(this.options.advertisedCapabilities
          ? { capabilities: this.options.advertisedCapabilities }
          : {}),
        ...(this.options.workerMetadata ? { worker: this.options.workerMetadata } : {}),
        ...(this.options.providerMetadata ? { providers: this.options.providerMetadata } : {}),
        ...(this.options.controlEndpoint
          ? { controlEndpoint: this.options.controlEndpoint }
          : {}),
        channels: channelBootstraps,
      },
    });
    this.sessionId = welcome.sessionId;
    this.heartbeatIntervalMs = normalizeHeartbeatIntervalMs(
      welcome.payload.heartbeatIntervalMs,
    );
    this.options.sessionSync.bindWelcomeChannels({
      welcome,
      agentId: this.agentId,
      agentInstanceId: this.agentInstanceId,
    });
    this.nextHeartbeatAt = Date.now() + this.heartbeatIntervalMs;
    this.publishRuntimeDeliveryState();
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
      this.publishRuntimeDeliveryState();
    } catch (error) {
      const recovered = this.handleSessionError(error);
      this.consecutiveFailureCount = recovered
        ? 0
        : this.consecutiveFailureCount + 1;
      this.publishRuntimeDeliveryState(error);
      this.handleError(error);
    } finally {
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
      const sessionId = this.requireSessionId();
      const threadIds = this.getThreadIds();
      if (this.isHeartbeatDue()) {
        await this.options.sessionSync.sendHeartbeat({ sessionId, threadIds });
        this.nextHeartbeatAt = Date.now() + this.heartbeatIntervalMs;
      }
      await this.flushPendingEventsWithReplay();
      const singleThreadState =
        threadIds.length === 1
          ? this.options.sessionRuntime.loadThreadState(threadIds[0]!)
          : undefined;
      const commands = await this.pullCommands({
        sessionId,
        threadIds,
        agentId: this.agentId,
        agentInstanceId: this.agentInstanceId,
        ...(singleThreadState?.lastDeliveredCommandCursor !== undefined
          ? { afterCursor: singleThreadState.lastDeliveredCommandCursor }
          : {}),
      });
      if (!this.running) {
        return;
      }
      for (const command of commands) {
        if (command.ackState === "duplicate") {
          continue;
        }
        this.options.sessionRuntime.markCommandStarted(command.commandId);
        await this.options.sessionSync.flushPendingCommandResults({
          sessionId,
          threadId: command.threadId,
        });
        const ack = await this.options.runtime.executeCommand(
          toCommandEnvelope({
            threadId: command.threadId,
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
        await this.options.sessionSync.flushPendingCommandResults({
          sessionId,
          threadId: command.threadId,
        });
      }
      if (commands.length === 0) {
        await this.options.sessionSync.flushPendingCommandResultsForThreads({
          sessionId,
          threadIds,
        });
      }
      if (this.isHeartbeatDue()) {
        await this.options.sessionSync.sendHeartbeat({ sessionId, threadIds });
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
    if (!isEnvironmentDaemonSessionInactiveError(error)) {
      return false;
    }
    for (const threadId of this.getThreadIds()) {
      this.options.sessionRuntime.clearSession(threadId);
    }
    this.sessionId = undefined;
    this.heartbeatIntervalMs = DEFAULT_HEARTBEAT_INTERVAL_MS;
    this.nextHeartbeatAt = 0;
    return true;
  }

  private publishRuntimeDeliveryState(error?: unknown): void {
    const lastAckedSequence = this.getThreadIds()
      .map((threadId) => this.options.sessionRuntime.loadThreadState(threadId)?.lastAcked?.sequence)
      .filter((sequence): sequence is number => sequence !== undefined)
      .reduce<number | undefined>(
        (max, sequence) => max === undefined ? sequence : Math.max(max, sequence),
        undefined,
      );
    const retryAttemptCount = this.consecutiveFailureCount;
    const nextRetryAt = !this.running
      ? undefined
      : retryAttemptCount > 0
        ? Date.now() + Math.min(
            this.pollIntervalMs * 2 ** Math.min(retryAttemptCount, 7),
            MAX_ERROR_BACKOFF_MS,
          )
        : undefined;

    this.options.runtime.setDaemonDeliveryState({
      connectedToServer: this.running && Boolean(this.sessionId) && retryAttemptCount === 0,
      deliveryState: !this.running
        ? "stopped"
        : retryAttemptCount > 0
          ? "retrying"
          : "healthy",
      retryAttemptCount,
      ...(lastAckedSequence !== undefined ? { lastAckedSequence } : {}),
      ...(nextRetryAt !== undefined ? { nextRetryAt } : {}),
      ...(retryAttemptCount > 0 ? { deliveryIssue: "transport_error" as const } : {}),
      ...(error instanceof Error ? { lastDeliveryError: error.message } : {}),
    });
  }

  private isHeartbeatDue(now: number = Date.now()): boolean {
    return now >= this.nextHeartbeatAt;
  }

  private requestEventFlush(): void {
    if (!this.running) {
      return;
    }
    const now = Date.now();
    const debounceRemaining = Math.max(
      0,
      this.eventFlushDebounceMs - (now - this.lastCommandPullAbortAt),
    );

    if (this.commandPullController && debounceRemaining === 0) {
      this.lastCommandPullAbortAt = now;
      this.cancelPendingCommandPull();
      this.scheduleImmediateCycle();
      return;
    }

    if (this.eventFlushTimer) {
      return;
    }
    this.eventFlushTimer = setTimeout(() => {
      this.eventFlushTimer = undefined;
      if (!this.running) {
        return;
      }
      this.lastCommandPullAbortAt = Date.now();
      this.cancelPendingCommandPull();
      this.scheduleImmediateCycle();
    }, debounceRemaining);
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

  private async pullCommands(args: {
    sessionId: string;
    threadIds: readonly string[];
    agentId: string;
    agentInstanceId: string;
    afterCursor?: number;
  }): Promise<EnvironmentDaemonPulledCommand[]> {
    const controller = new AbortController();
    this.commandPullController = controller;
    try {
      return await this.options.sessionSync.pullCommands({
        sessionId: args.sessionId,
        threadIds: args.threadIds,
        agentId: args.agentId,
        agentInstanceId: args.agentInstanceId,
        ...(args.afterCursor !== undefined ? { afterCursor: args.afterCursor } : {}),
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

  private async flushPendingEventsWithReplay(): Promise<void> {
    const sessionId = this.requireSessionId();
    for (let attempt = 0; attempt < 4; attempt += 1) {
      const flushResult = await this.options.sessionSync.flushPendingEvents({
        sessionId,
        threadIds: this.getThreadIds(),
      });
      const needsReset = flushResult.channelResults.filter((result) => !result.acknowledged);
      if (needsReset.length === 0) {
        return;
      }
      for (const result of needsReset) {
        if (!result.resetCursor) {
          continue;
        }
        this.options.sessionRuntime.alignEventCursor(
          result.threadId,
          {
            generation: result.resetCursor.generation,
            sequence: result.resetCursor.sequence,
          },
          Date.now(),
        );
      }
    }
    throw new Error(
      `Environment-daemon event reset did not converge for environment ${this.options.environmentId}`,
    );
  }

  private ensureThreadState(threadId: string): void {
    if (this.options.sessionRuntime.loadThreadState(threadId)) {
      return;
    }
    this.options.sessionRuntime.initializeThread({
      threadId,
      agentId: this.agentId,
      agentInstanceId: this.agentInstanceId,
      generation: 1,
    });
  }

  private getThreadIds(): string[] {
    return this.options.sessionRuntime.listThreadIds();
  }

  private requireSessionId(): string {
    if (!this.sessionId) {
      throw new Error(
        `Environment-daemon session is not open for environment ${this.options.environmentId}`,
      );
    }
    return this.sessionId;
  }
}
