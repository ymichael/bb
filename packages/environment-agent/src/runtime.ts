import { spawn, type ChildProcess } from "node:child_process";
import {
  ENVIRONMENT_AGENT_PROTOCOL_VERSION,
  type EnvironmentAgentAckRequest,
  type EnvironmentAgentAckResponse,
  type EnvironmentAgentCommandAck,
  type EnvironmentAgentDaemonConnectionConfig,
  type EnvironmentAgentDeliveryResponse,
  type EnvironmentAgentEvent,
  type EnvironmentAgentEventEnvelope,
  type EnvironmentAgentProviderSpec,
  type EnvironmentAgentProviderStatus,
  type EnvironmentAgentReplayRequest,
  type EnvironmentAgentReplayResponse,
  type EnvironmentAgentStatusSnapshot,
} from "./protocol.js";

export interface EnvironmentAgentRuntimeOptions {
  threadId?: string;
  projectId?: string;
  environmentId?: string;
  daemonConnection?: EnvironmentAgentDaemonConnectionConfig;
  providerCommand?: string;
  providerArgs?: string[];
  providerLaunchCommand?: string;
  providerLaunchArgs?: string[];
  onStdoutLine?: (line: string) => void;
  onStderrLine?: (line: string) => void;
}

export class EnvironmentAgentRuntime {
  private readonly events: EnvironmentAgentEventEnvelope[] = [];
  private sequence = 0;
  private lastAckedSequence = 0;
  private pendingCommandCount = 0;
  private providerChild: ChildProcess | null = null;
  private readonly stdoutLineSubscribers = new Set<(line: string) => void>();
  private readonly stderrLineSubscribers = new Set<(line: string) => void>();
  private readonly eventSubscribers = new Set<(event: EnvironmentAgentEventEnvelope) => void>();
  private daemonConnection: EnvironmentAgentDaemonConnectionConfig | undefined;
  private connectedToDaemon = false;
  private deliveryInFlight: Promise<void> | null = null;
  private deliveryRetryTimer: ReturnType<typeof setTimeout> | undefined;
  private deliveryBackoffMs = 250;

  constructor(private readonly opts: EnvironmentAgentRuntimeOptions) {
    this.daemonConnection = opts.daemonConnection
      ? { ...opts.daemonConnection }
      : undefined;
  }

  start(): ChildProcess | null {
    this.appendEvent({
      type: "environment.ready",
      threadId: this.resolveThreadId(),
    });

    this.triggerDaemonDelivery();

    return this.ensureProviderRunning();
  }

  appendEvent(event: EnvironmentAgentEvent): EnvironmentAgentEventEnvelope {
    const envelope: EnvironmentAgentEventEnvelope = {
      protocolVersion: ENVIRONMENT_AGENT_PROTOCOL_VERSION,
      sequence: ++this.sequence,
      emittedAt: Date.now(),
      threadId: event.threadId,
      event,
    };
    this.events.push(envelope);
    this.emitEvent(envelope);
    this.triggerDaemonDelivery();
    return envelope;
  }

  sendProviderLine(line: string): void {
    if (!line.trim()) return;
    this.providerChild?.stdin?.write(`${line}\n`);
  }

  ensureProviderRunning(spec?: EnvironmentAgentProviderSpec): ChildProcess | null {
    if (this.providerChild && !this.providerChild.killed) {
      return this.providerChild;
    }

    const resolvedSpec = this.resolveProviderSpec(spec);
    if (!resolvedSpec) {
      return null;
    }

    const child = this.spawnProvider(resolvedSpec);
    this.providerChild = child;
    return child;
  }

  getProviderStatus(): EnvironmentAgentProviderStatus {
    const child = this.providerChild;
    const running = Boolean(child && child.exitCode === null && !child.killed);
    return {
      running,
      launched: running,
      ...(typeof child?.pid === "number" ? { pid: child.pid } : {}),
    };
  }

  subscribeToProviderStdout(listener: (line: string) => void): () => void {
    this.stdoutLineSubscribers.add(listener);
    return () => {
      this.stdoutLineSubscribers.delete(listener);
    };
  }

  subscribeToProviderStderr(listener: (line: string) => void): () => void {
    this.stderrLineSubscribers.add(listener);
    return () => {
      this.stderrLineSubscribers.delete(listener);
    };
  }

  subscribeToEvents(listener: (event: EnvironmentAgentEventEnvelope) => void): () => void {
    this.eventSubscribers.add(listener);
    return () => {
      this.eventSubscribers.delete(listener);
    };
  }

  acknowledge(request: EnvironmentAgentAckRequest): EnvironmentAgentAckResponse {
    this.lastAckedSequence = Math.max(this.lastAckedSequence, request.sequence);
    return {
      protocolVersion: ENVIRONMENT_AGENT_PROTOCOL_VERSION,
      acknowledgedSequence: this.lastAckedSequence,
      ...(request.threadId ? { threadId: request.threadId } : {}),
    };
  }

  replay(request: EnvironmentAgentReplayRequest): EnvironmentAgentReplayResponse {
    const events = this.events.filter((event) => event.sequence > request.afterSequence);
    const limitedEvents =
      request.limit && request.limit > 0 ? events.slice(0, request.limit) : events;
    const toSequenceInclusive =
      limitedEvents.length > 0
        ? limitedEvents[limitedEvents.length - 1]!.sequence
        : request.afterSequence;
    return {
      protocolVersion: ENVIRONMENT_AGENT_PROTOCOL_VERSION,
      fromSequenceExclusive: request.afterSequence,
      toSequenceInclusive,
      events: limitedEvents,
      hasMore: limitedEvents.length < events.length,
    };
  }

  createCommandAck(args: {
    commandId: string;
    idempotencyKey: string;
    state: EnvironmentAgentCommandAck["state"];
    message?: string;
  }): EnvironmentAgentCommandAck {
    return {
      protocolVersion: ENVIRONMENT_AGENT_PROTOCOL_VERSION,
      commandId: args.commandId,
      idempotencyKey: args.idempotencyKey,
      state: args.state,
      acknowledgedAt: Date.now(),
      latestSequence: this.sequence,
      ...(args.message ? { message: args.message } : {}),
    };
  }

  getStatusSnapshot(): EnvironmentAgentStatusSnapshot {
    return {
      protocolVersion: ENVIRONMENT_AGENT_PROTOCOL_VERSION,
      ...(this.opts.threadId ? { threadId: this.opts.threadId } : {}),
      ...(this.opts.projectId ? { projectId: this.opts.projectId } : {}),
      ...(this.opts.environmentId ? { environmentId: this.opts.environmentId } : {}),
      latestSequence: this.sequence,
      ...(this.lastAckedSequence > 0
        ? { lastAckedSequence: this.lastAckedSequence }
        : {}),
      connectedToDaemon: this.connectedToDaemon,
      pendingEventCount: Math.max(0, this.sequence - this.lastAckedSequence),
      pendingCommandCount: this.pendingCommandCount,
    };
  }

  triggerDaemonDelivery(): void {
    if (!this.hasDaemonDeliveryConfig()) {
      this.connectedToDaemon = false;
      return;
    }

    if (this.deliveryRetryTimer) {
      clearTimeout(this.deliveryRetryTimer);
      this.deliveryRetryTimer = undefined;
    }
    if (this.deliveryInFlight) {
      return;
    }

    this.deliveryInFlight = this.flushDaemonDelivery()
      .catch(() => {
        // Retry is scheduled by flushDaemonDelivery on failure.
      })
      .finally(() => {
        this.deliveryInFlight = null;
      });
  }

  private emitProviderStdoutLine(line: string): void {
    for (const subscriber of this.stdoutLineSubscribers) {
      subscriber(line);
    }
  }

  private emitProviderStderrLine(line: string): void {
    for (const subscriber of this.stderrLineSubscribers) {
      subscriber(line);
    }
  }

  private emitEvent(event: EnvironmentAgentEventEnvelope): void {
    for (const subscriber of this.eventSubscribers) {
      subscriber(event);
    }
  }

  ensureProviderStatus(spec?: EnvironmentAgentProviderSpec): EnvironmentAgentProviderStatus {
    const launchedBefore = this.getProviderStatus().running;
    const child = this.ensureProviderRunning(spec);
    const status = this.getProviderStatus();
    if (!launchedBefore && child) {
      return {
        ...status,
        launched: true,
      };
    }
    return status;
  }

  private resolveProviderSpec(
    spec?: EnvironmentAgentProviderSpec,
  ): EnvironmentAgentProviderSpec | null {
    const command = spec?.command ?? this.opts.providerCommand;
    if (!command?.trim()) {
      return null;
    }
    return {
      command: command.trim(),
      args: [...(spec?.args ?? this.opts.providerArgs ?? [])],
      launchCommand: spec?.launchCommand ?? this.opts.providerLaunchCommand,
      launchArgs: [...(spec?.launchArgs ?? this.opts.providerLaunchArgs ?? [])],
    };
  }

  private spawnProvider(spec: EnvironmentAgentProviderSpec): ChildProcess {
    const command = spec.launchCommand?.trim() || spec.command;
    const args = spec.launchCommand?.trim()
      ? [...(spec.launchArgs ?? []), spec.command, ...spec.args]
      : spec.args;

    const child = spawn(command, args, {
      cwd: process.cwd(),
      env: process.env,
      stdio: ["pipe", "pipe", "pipe"],
    });

    child.stdout?.setEncoding("utf-8");
    child.stdout?.on("data", (chunk: string) => {
      for (const line of chunk.split(/\r\n|\n|\r/g)) {
        if (!line.trim()) continue;
        this.opts.onStdoutLine?.(line);
        this.emitProviderStdoutLine(line);
        this.appendEvent(this.toProviderEvent(line));
      }
    });

    child.stderr?.setEncoding("utf-8");
    child.stderr?.on("data", (chunk: string) => {
      for (const line of chunk.split(/\r\n|\n|\r/g)) {
        if (!line.trim()) continue;
        this.opts.onStderrLine?.(line);
        this.emitProviderStderrLine(line);
      }
    });

    child.once("exit", (_code, _signal) => {
      if (this.providerChild === child) {
        this.providerChild = null;
      }
      this.appendEvent({
        type: "environment.degraded",
        threadId: this.resolveThreadId(),
        message: "Provider runtime exited",
      });
    });

    return child;
  }

  private hasDaemonDeliveryConfig(): boolean {
    return Boolean(
      this.daemonConnection?.daemonUrl?.trim() &&
        this.daemonConnection?.authToken?.trim() &&
        this.resolveThreadId().trim(),
    );
  }

  private async flushDaemonDelivery(): Promise<void> {
    if (!this.hasDaemonDeliveryConfig()) {
      this.connectedToDaemon = false;
      return;
    }

    const daemonUrl = this.daemonConnection!.daemonUrl!.trim();
    const authToken = this.daemonConnection!.authToken!.trim();
    const threadId = this.resolveThreadId();
    const pendingEvents = this.events.filter((event) => event.sequence > this.lastAckedSequence);
    if (pendingEvents.length === 0) {
      this.connectedToDaemon = true;
      this.deliveryBackoffMs = 250;
      return;
    }

    try {
      const response = await fetch(
        new URL(`/threads/${threadId}/environment-agent/deliver`, daemonUrl),
        {
          method: "POST",
          headers: {
            authorization: `Bearer ${authToken}`,
            "content-type": "application/json",
          },
          body: JSON.stringify({
            protocolVersion: ENVIRONMENT_AGENT_PROTOCOL_VERSION,
            threadId,
            ...(this.opts.projectId ? { projectId: this.opts.projectId } : {}),
            ...(this.opts.environmentId ? { environmentId: this.opts.environmentId } : {}),
            afterSequence: this.lastAckedSequence,
            events: pendingEvents,
          }),
        },
      );
      if (!response.ok) {
        throw new Error(`Daemon delivery failed: ${response.status}`);
      }

      const body = (await response.json()) as EnvironmentAgentDeliveryResponse;
      this.lastAckedSequence = Math.max(
        this.lastAckedSequence,
        body.acknowledgedSequence,
      );
      this.connectedToDaemon = true;
      this.deliveryBackoffMs = 250;

      if (this.sequence > this.lastAckedSequence) {
        this.triggerDaemonDelivery();
      }
    } catch (error) {
      this.connectedToDaemon = false;
      this.scheduleDaemonDeliveryRetry();
      throw error;
    }
  }

  private scheduleDaemonDeliveryRetry(): void {
    if (this.deliveryRetryTimer) {
      return;
    }
    const delayMs = this.deliveryBackoffMs;
    this.deliveryBackoffMs = Math.min(this.deliveryBackoffMs * 2, 5_000);
    this.deliveryRetryTimer = setTimeout(() => {
      this.deliveryRetryTimer = undefined;
      this.triggerDaemonDelivery();
    }, delayMs);
  }

  private resolveThreadId(): string {
    return this.opts.threadId ?? process.env.BB_THREAD_ID ?? "unknown-thread";
  }

  private toProviderEvent(line: string): EnvironmentAgentEvent {
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      return {
        type: "provider.event",
        threadId: this.resolveThreadId(),
        method: "provider.stdout",
        payload: { line },
      };
    }

    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return {
        type: "provider.event",
        threadId: this.resolveThreadId(),
        method: "provider.stdout",
        payload: { line },
      };
    }

    const record = parsed as Record<string, unknown>;
    if (typeof record.method !== "string") {
      return {
        type: "provider.event",
        threadId: this.resolveThreadId(),
        method: "provider.stdout",
        payload: { line },
      };
    }

    return {
      type: "provider.event",
      threadId: this.resolveThreadId(),
      method: record.method,
      payload: record.params ?? {},
    };
  }
}
