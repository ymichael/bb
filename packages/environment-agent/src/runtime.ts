import { spawn, type ChildProcess } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  ENVIRONMENT_AGENT_PROTOCOL_VERSION,
  type EnvironmentAgentAckRequest,
  type EnvironmentAgentAckResponse,
  type EnvironmentAgentCommand,
  type EnvironmentAgentCommandEnvelope,
  type EnvironmentAgentCommandAck,
  type EnvironmentAgentDaemonConnectionConfig,
  type EnvironmentAgentDeliveryReason,
  type EnvironmentAgentDeliveryResponse,
  type EnvironmentAgentDeliveryRuntimeState,
  type EnvironmentAgentEvent,
  type EnvironmentAgentEventEnvelope,
  type EnvironmentAgentProviderFile,
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

const INITIAL_DELIVERY_BACKOFF_MS = 250;
const MAX_DELIVERY_BACKOFF_MS = 30_000;
const MAX_AUTOMATIC_DELIVERY_RETRIES = 8;
const DELIVERY_DEBOUNCE_MS = 100;
const DELIVERY_MAX_WAIT_MS = 1_000;

export class EnvironmentAgentRuntime {
  private readonly events: EnvironmentAgentEventEnvelope[] = [];
  private sequence = 0;
  private providerRequestId = 0;
  private lastAckedSequence = 0;
  private providerInitializedPid: number | undefined;
  private providerChild: ChildProcess | null = null;
  private readonly pendingProviderRequests = new Map<
    number,
    {
      resolve: (value: unknown) => void;
      reject: (reason: Error) => void;
      timeout: ReturnType<typeof setTimeout>;
    }
  >();
  private readonly stdoutLineSubscribers = new Set<(line: string) => void>();
  private readonly stderrLineSubscribers = new Set<(line: string) => void>();
  private readonly eventSubscribers = new Set<(event: EnvironmentAgentEventEnvelope) => void>();
  private daemonConnection: EnvironmentAgentDaemonConnectionConfig | undefined;
  private connectedToDaemon = false;
  private deliveryInFlight: Promise<void> | null = null;
  private deliveryFlushTimer: ReturnType<typeof setTimeout> | undefined;
  private deliveryDebounceStartedAt: number | undefined;
  private deliveryRetryTimer: ReturnType<typeof setTimeout> | undefined;
  private deliveryBackoffMs = INITIAL_DELIVERY_BACKOFF_MS;
  private deliveryState: EnvironmentAgentDeliveryRuntimeState = "healthy";
  private deliveryIssue: EnvironmentAgentDeliveryReason | undefined;
  private deliveryRetryAttemptCount = 0;
  private nextRetryAt: number | undefined;
  private lastDeliveryError: string | undefined;
  private shuttingDown = false;
  private shutdownPromise: Promise<void> | null = null;

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

    return this.ensureProviderRunning();
  }

  async shutdown(opts?: { timeoutMs?: number }): Promise<void> {
    if (this.shutdownPromise) {
      return this.shutdownPromise;
    }

    this.shuttingDown = true;
    this.shutdownPromise = (async () => {
      try {
        await this.drainPendingDaemonDelivery(opts);
      } catch {
        // Best-effort flush during shutdown.
      }
      this.stopDeliveryTimers();
      this.markDeliveryStopped(
        "transport_error",
        "Environment-agent shutdown in progress",
      );
      await this.stopProviderChild(opts?.timeoutMs ?? 1_000);
    })();

    return this.shutdownPromise;
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
    this.triggerDaemonDelivery({
      nudge: shouldNudgeDaemonDeliveryForEvent(event),
    });
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
    errorCode?: string;
    message?: string;
    result?: unknown;
  }): EnvironmentAgentCommandAck {
    return {
      protocolVersion: ENVIRONMENT_AGENT_PROTOCOL_VERSION,
      commandId: args.commandId,
      idempotencyKey: args.idempotencyKey,
      state: args.state,
      acknowledgedAt: Date.now(),
      latestSequence: this.sequence,
      ...(args.errorCode ? { errorCode: args.errorCode } : {}),
      ...(args.message ? { message: args.message } : {}),
      ...(args.result !== undefined ? { result: args.result } : {}),
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
      pendingCommandCount: this.pendingProviderRequests.size,
      deliveryState: this.deliveryState,
      ...(this.deliveryIssue ? { deliveryIssue: this.deliveryIssue } : {}),
      retryAttemptCount: this.deliveryRetryAttemptCount,
      ...(this.nextRetryAt ? { nextRetryAt: this.nextRetryAt } : {}),
      ...(this.lastDeliveryError ? { lastDeliveryError: this.lastDeliveryError } : {}),
    };
  }

  async drainPendingDaemonDelivery(opts?: { timeoutMs?: number }): Promise<void> {
    if (!this.hasDaemonDeliveryConfig()) {
      this.connectedToDaemon = false;
      return;
    }

    const timeoutMs = Math.max(0, opts?.timeoutMs ?? 2_000);
    const deadline = Date.now() + timeoutMs;

    while (this.sequence > this.lastAckedSequence) {
      if (this.deliveryFlushTimer) {
        clearTimeout(this.deliveryFlushTimer);
        this.deliveryFlushTimer = undefined;
      }
      this.deliveryDebounceStartedAt = undefined;

      if (this.deliveryRetryTimer) {
        clearTimeout(this.deliveryRetryTimer);
        this.deliveryRetryTimer = undefined;
        this.nextRetryAt = undefined;
      }

      const remainingMs = deadline - Date.now();
      if (remainingMs < 0) {
        break;
      }

      if (this.deliveryInFlight) {
        await Promise.race([
          this.deliveryInFlight.catch(() => undefined),
          delay(Math.min(remainingMs, 50)),
        ]);
        continue;
      }

      try {
        await this.flushDaemonDelivery();
      } catch {
        if (Date.now() >= deadline) {
          break;
        }
        await delay(Math.min(deadline - Date.now(), 50));
      }
    }
  }

  triggerDaemonDelivery(opts?: { nudge?: boolean }): void {
    if (!this.hasDaemonDeliveryConfig()) {
      this.connectedToDaemon = false;
      return;
    }
    if (this.deliveryState === "stopped") {
      return;
    }
    if (this.deliveryState === "stalled" && !opts?.nudge) {
      return;
    }

    if (this.deliveryRetryTimer) {
      clearTimeout(this.deliveryRetryTimer);
      this.deliveryRetryTimer = undefined;
      this.nextRetryAt = undefined;
    }
    if (this.deliveryFlushTimer && opts?.nudge) {
      clearTimeout(this.deliveryFlushTimer);
      this.deliveryFlushTimer = undefined;
      this.deliveryDebounceStartedAt = undefined;
    }
    if (this.deliveryInFlight) {
      return;
    }
    if (!opts?.nudge) {
      this.scheduleDebouncedDaemonDelivery();
      return;
    }

    this.kickOffDaemonDelivery();
  }

  async executeCommand(
    envelope: EnvironmentAgentCommandEnvelope,
  ): Promise<EnvironmentAgentCommandAck> {
    try {
      await this.ensureProviderForCommand(envelope.command);
      const result = await this.requestProviderCommand(envelope.command);
      return this.createCommandAck({
        commandId: envelope.meta.commandId,
        idempotencyKey: envelope.meta.idempotencyKey,
        state: "accepted",
        result,
      });
    } catch (error) {
      const normalizedError = this.normalizeCommandError(error);
      return this.createCommandAck({
        commandId: envelope.meta.commandId,
        idempotencyKey: envelope.meta.idempotencyKey,
        state: "rejected",
        errorCode: normalizedError.code,
        message: normalizedError.message,
      });
    }
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
      ...(spec?.env ? { env: { ...spec.env } } : {}),
      ...(spec?.files ? { files: spec.files.map((file) => ({ ...file })) } : {}),
    };
  }

  private spawnProvider(spec: EnvironmentAgentProviderSpec): ChildProcess {
    const command = spec.launchCommand?.trim() || spec.command;
    const args = spec.launchCommand?.trim()
      ? [...(spec.launchArgs ?? []), spec.command, ...spec.args]
      : spec.args;
    const env = this.resolveProviderEnvironment(spec);

    const child = spawn(command, args, {
      cwd: process.cwd(),
      env,
      stdio: ["pipe", "pipe", "pipe"],
    });

    child.stdout?.setEncoding("utf-8");
    child.stdout?.on("data", (chunk: string) => {
      for (const line of chunk.split(/\r\n|\n|\r/g)) {
        if (!line.trim()) continue;
        this.opts.onStdoutLine?.(line);
        this.emitProviderStdoutLine(line);
        if (this.tryResolveProviderRequest(line)) {
          continue;
        }
        this.appendEvent(this.toProviderEvent(line));
      }
    });

    child.stderr?.setEncoding("utf-8");
    child.stderr?.on("data", (chunk: string) => {
      for (const line of chunk.split(/\r\n|\n|\r/g)) {
        if (!line.trim()) continue;
        this.opts.onStderrLine?.(line);
        this.emitProviderStderrLine(line);
        this.appendEvent({
          type: "provider.stderr",
          threadId: this.resolveThreadId(),
          line,
        });
      }
    });

    child.once("exit", (_code, _signal) => {
      if (this.providerChild === child) {
        this.providerChild = null;
      }
      if (this.providerInitializedPid === child.pid) {
        this.providerInitializedPid = undefined;
      }
      this.rejectPendingProviderRequests(
        new Error(`Provider runtime exited (code=${String(_code)}, signal=${String(_signal)})`),
      );
      if (this.shuttingDown) {
        return;
      }
      this.opts.onStderrLine?.(
        `provider runtime exited (code=${String(_code)}, signal=${String(_signal)})`,
      );
      this.appendEvent({
        type: "environment.degraded",
        threadId: this.resolveThreadId(),
        message: "Provider runtime exited",
      });
    });

    return child;
  }

  private resolveProviderEnvironment(
    spec: EnvironmentAgentProviderSpec,
  ): NodeJS.ProcessEnv {
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      ...(spec.env ?? {}),
    };
    if (!spec.files || spec.files.length === 0) {
      return env;
    }

    const homeDir = env.HOME?.trim() || this.resolveManagedProviderHomeDir();
    this.materializeProviderFiles(homeDir, spec.files);
    env.HOME = homeDir;
    return env;
  }

  private materializeProviderFiles(
    homeDir: string,
    files: EnvironmentAgentProviderFile[],
  ): void {
    for (const file of files) {
      const targetPath = this.resolveProviderFilePath(homeDir, file);
      mkdirSync(path.dirname(targetPath), { recursive: true });
      writeFileSync(targetPath, file.content, "utf8");
    }
  }

  private resolveManagedProviderHomeDir(): string {
    return path.join(
      tmpdir(),
      "beanbag-environment-agent",
      this.resolveThreadId(),
      "provider-home",
    );
  }

  private resolveProviderFilePath(
    homeDir: string,
    file: EnvironmentAgentProviderFile,
  ): string {
    switch (file.placement) {
      case "home":
        return path.join(homeDir, file.path);
    }
    const exhausted: never = file.placement;
    throw new Error(`Unsupported provider file placement: ${String(exhausted)}`);
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
      this.markDeliveryHealthy();
      return;
    }

    try {
      const response = await fetch(
        this.resolveDaemonEndpointUrl(
          daemonUrl,
          `threads/${threadId}/environment-agent/deliver`,
        ),
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
      const previousAckedSequence = this.lastAckedSequence;
      this.lastAckedSequence = Math.max(this.lastAckedSequence, body.acknowledgedSequence);
      this.connectedToDaemon = true;
      this.lastDeliveryError = undefined;
      this.nextRetryAt = undefined;

      switch (body.state) {
        case "accepted":
          this.deliveryIssue = body.reason;
          if (this.lastAckedSequence > previousAckedSequence) {
            this.markDeliveryHealthy();
          } else if (this.sequence > this.lastAckedSequence) {
            this.markDeliveryStalled(
              body.reason === "accepted" ? "sequence_gap" : body.reason,
              body.message ?? "Daemon accepted delivery without acknowledgement progress",
            );
            return;
          } else {
            this.markDeliveryHealthy();
          }
          if (this.sequence > this.lastAckedSequence) {
            this.triggerDaemonDelivery();
          }
          return;
        case "retry":
          this.markDeliveryRetrying(
            body.reason,
            body.message ?? "Daemon requested delivery retry",
            body.retryAfterMs,
          );
          return;
        case "stalled":
          this.markDeliveryStalled(
            body.reason,
            body.message ?? "Daemon reported stalled delivery",
          );
          return;
        case "stopped":
          this.markDeliveryStopped(
            body.reason,
            body.message ?? "Daemon reported delivery is no longer eligible",
          );
          return;
      }
    } catch (error) {
      this.connectedToDaemon = false;
      const message = error instanceof Error ? error.message : String(error);
      this.opts.onStderrLine?.(`daemon delivery failed: ${message}`);
      this.markDeliveryRetrying("transport_error", message);
      throw error;
    }
  }

  private markDeliveryHealthy(): void {
    this.connectedToDaemon = true;
    this.deliveryState = "healthy";
    this.deliveryIssue = undefined;
    this.deliveryRetryAttemptCount = 0;
    this.deliveryBackoffMs = INITIAL_DELIVERY_BACKOFF_MS;
    this.nextRetryAt = undefined;
    this.lastDeliveryError = undefined;
  }

  private markDeliveryRetrying(
    reason: EnvironmentAgentDeliveryReason,
    message: string,
    requestedDelayMs?: number,
  ): void {
    this.deliveryState = "retrying";
    this.deliveryIssue = reason;
    this.lastDeliveryError = message;
    if (this.deliveryRetryAttemptCount >= MAX_AUTOMATIC_DELIVERY_RETRIES) {
      this.markDeliveryStalled(
        "transport_error",
        `Automatic delivery retry budget exhausted after ${this.deliveryRetryAttemptCount} attempts`,
      );
      return;
    }
    const delayMs = Math.max(100, Math.round(requestedDelayMs ?? this.nextBackoffDelayMs()));
    this.deliveryRetryAttemptCount += 1;
    this.scheduleDaemonDeliveryRetry(delayMs);
  }

  private markDeliveryStalled(
    reason: EnvironmentAgentDeliveryReason,
    message: string,
  ): void {
    this.deliveryState = "stalled";
    this.deliveryIssue = reason;
    this.lastDeliveryError = message;
    if (this.deliveryRetryTimer) {
      clearTimeout(this.deliveryRetryTimer);
      this.deliveryRetryTimer = undefined;
    }
    if (this.deliveryFlushTimer) {
      clearTimeout(this.deliveryFlushTimer);
      this.deliveryFlushTimer = undefined;
    }
    this.deliveryDebounceStartedAt = undefined;
    this.nextRetryAt = undefined;
  }

  private markDeliveryStopped(
    reason: EnvironmentAgentDeliveryReason,
    message: string,
  ): void {
    this.deliveryState = "stopped";
    this.deliveryIssue = reason;
    this.lastDeliveryError = message;
    if (this.deliveryRetryTimer) {
      clearTimeout(this.deliveryRetryTimer);
      this.deliveryRetryTimer = undefined;
    }
    if (this.deliveryFlushTimer) {
      clearTimeout(this.deliveryFlushTimer);
      this.deliveryFlushTimer = undefined;
    }
    this.deliveryDebounceStartedAt = undefined;
    this.nextRetryAt = undefined;
  }

  private stopDeliveryTimers(): void {
    if (this.deliveryRetryTimer) {
      clearTimeout(this.deliveryRetryTimer);
      this.deliveryRetryTimer = undefined;
    }
    if (this.deliveryFlushTimer) {
      clearTimeout(this.deliveryFlushTimer);
      this.deliveryFlushTimer = undefined;
    }
    this.deliveryDebounceStartedAt = undefined;
    this.nextRetryAt = undefined;
  }

  private async stopProviderChild(timeoutMs: number): Promise<void> {
    const child = this.providerChild;
    if (!child) {
      return;
    }

    this.providerChild = null;
    this.providerInitializedPid = undefined;
    this.rejectPendingProviderRequests(
      new Error("Provider runtime stopped during environment-agent shutdown"),
    );

    child.stdin?.end();
    if (child.exitCode !== null || child.killed) {
      return;
    }

    await new Promise<void>((resolve) => {
      let settled = false;

      const finish = () => {
        if (settled) return;
        settled = true;
        resolve();
      };

      const forceKillTimer = setTimeout(() => {
        try {
          child.kill("SIGKILL");
        } catch {
          // Ignore failed hard-kill attempts.
        }
      }, Math.max(100, timeoutMs));
      forceKillTimer.unref?.();

      child.once("exit", () => {
        clearTimeout(forceKillTimer);
        finish();
      });

      try {
        child.kill("SIGTERM");
      } catch {
        clearTimeout(forceKillTimer);
        finish();
      }
    });
  }

  private kickOffDaemonDelivery(): void {
    if (this.deliveryFlushTimer) {
      clearTimeout(this.deliveryFlushTimer);
      this.deliveryFlushTimer = undefined;
    }
    this.deliveryDebounceStartedAt = undefined;
    if (this.deliveryInFlight) {
      return;
    }
    this.deliveryInFlight = this.flushDaemonDelivery()
      .catch(() => {
        // Retry is scheduled by flushDaemonDelivery on failure.
      })
      .finally(() => {
        this.deliveryInFlight = null;
        if (this.sequence > this.lastAckedSequence) {
          this.triggerDaemonDelivery();
        }
      });
  }

  private scheduleDebouncedDaemonDelivery(): void {
    const now = Date.now();
    const debounceStartedAt = this.deliveryDebounceStartedAt ?? now;
    this.deliveryDebounceStartedAt = debounceStartedAt;
    const maxWaitAt = debounceStartedAt + DELIVERY_MAX_WAIT_MS;
    const flushAt = Math.min(now + DELIVERY_DEBOUNCE_MS, maxWaitAt);
    const delayMs = Math.max(0, flushAt - now);

    if (this.deliveryFlushTimer) {
      clearTimeout(this.deliveryFlushTimer);
    }
    this.deliveryFlushTimer = setTimeout(() => {
      this.deliveryFlushTimer = undefined;
      this.kickOffDaemonDelivery();
    }, delayMs);
  }

  private scheduleDaemonDeliveryRetry(delayMs: number): void {
    if (this.deliveryRetryTimer) {
      return;
    }
    this.nextRetryAt = Date.now() + delayMs;
    this.deliveryRetryTimer = setTimeout(() => {
      this.deliveryRetryTimer = undefined;
      this.nextRetryAt = undefined;
      this.triggerDaemonDelivery();
    }, delayMs);
  }

  private nextBackoffDelayMs(): number {
    const baseDelayMs = this.deliveryBackoffMs;
    this.deliveryBackoffMs = Math.min(this.deliveryBackoffMs * 2, MAX_DELIVERY_BACKOFF_MS);
    const jitterFactor = 0.8 + Math.random() * 0.4;
    return Math.min(
      MAX_DELIVERY_BACKOFF_MS,
      Math.max(INITIAL_DELIVERY_BACKOFF_MS, Math.round(baseDelayMs * jitterFactor)),
    );
  }

  private resolveThreadId(): string {
    return this.opts.threadId ?? process.env.BB_THREAD_ID ?? "unknown-thread";
  }

  private resolveDaemonEndpointUrl(daemonUrl: string, relativePath: string): URL {
    const normalizedBase = daemonUrl.endsWith("/") ? daemonUrl : `${daemonUrl}/`;
    return new URL(relativePath, normalizedBase);
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

  private async ensureProviderForCommand(command: EnvironmentAgentCommand): Promise<void> {
    switch (command.type) {
      case "thread.start":
      case "thread.resume":
      case "thread.stop":
      case "turn.start":
      case "turn.steer":
      case "thread.rename": {
        const child = this.ensureProviderRunning();
        if (!child) {
          throw new Error("Provider runtime is unavailable");
        }
        if (!command.initialize) {
          return;
        }
        if (this.providerInitializedPid === child.pid) {
          return;
        }
        await this.requestProvider({
          method: command.initialize.method,
          params: command.initialize.params,
        });
        this.providerInitializedPid = child.pid ?? undefined;
        return;
      }
      case "workspace.status":
      case "workspace.diff":
        return;
    }
  }

  private requestProviderCommand(command: EnvironmentAgentCommand): Promise<unknown> {
    return this.requestProvider({
      method: this.toProviderMethod(command),
      params: this.toProviderParams(command),
    });
  }

  private toProviderMethod(command: EnvironmentAgentCommand): string {
    switch (command.type) {
      case "thread.start":
        return "thread/start";
      case "thread.resume":
        return "thread/resume";
      case "thread.stop":
        return "thread/stop";
      case "turn.start":
        return "turn/start";
      case "turn.steer":
        return "turn/steer";
      case "thread.rename":
        return "thread/name/set";
      case "workspace.status":
        return "workspace/status";
      case "workspace.diff":
        return "workspace/diff";
    }
  }

  private toProviderParams(command: EnvironmentAgentCommand): unknown {
    switch (command.type) {
      case "thread.start":
      case "thread.resume":
      case "turn.start":
      case "turn.steer":
      case "thread.rename":
        return command.params;
      case "thread.stop":
        return command.params ?? {};
      case "workspace.status":
      case "workspace.diff":
        return { threadId: command.threadId };
    }
  }

  private requestProvider(args: {
    method: string;
    params: unknown;
    timeoutMs?: number;
  }): Promise<unknown> {
    const child = this.providerChild;
    const stdin = child?.stdin;
    if (!stdin || child.killed || child.exitCode !== null) {
      return Promise.reject(new Error("Provider runtime is unavailable"));
    }

    const id = ++this.providerRequestId;
    const timeoutMs = Math.max(1, args.timeoutMs ?? 10_000);
    const message = JSON.stringify({
      jsonrpc: "2.0",
      id,
      method: args.method,
      params: args.params,
    });

    return new Promise<unknown>((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.pendingProviderRequests.delete(id);
        reject(
          new Error(
            `Timed out waiting for provider response to ${args.method} (${id})`,
          ),
        );
      }, timeoutMs);
      this.pendingProviderRequests.set(id, { resolve, reject, timeout });
      try {
        stdin.write(`${message}\n`);
      } catch (error) {
        clearTimeout(timeout);
        this.pendingProviderRequests.delete(id);
        reject(error instanceof Error ? error : new Error(String(error)));
      }
    });
  }

  private tryResolveProviderRequest(line: string): boolean {
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      return false;
    }
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return false;
    }
    const record = parsed as Record<string, unknown>;
    const id = typeof record.id === "number" ? record.id : undefined;
    if (id === undefined) {
      return false;
    }
    const pending = this.pendingProviderRequests.get(id);
    if (!pending) {
      if (record.error !== undefined) {
        this.appendEvent({
          type: "provider.rpc_error",
          threadId: this.resolveThreadId(),
          requestId: id,
          message: this.toProviderErrorMessage(record.error),
        });
        return true;
      }
      return false;
    }
    clearTimeout(pending.timeout);
    this.pendingProviderRequests.delete(id);
    if (record.error !== undefined) {
      pending.reject(new Error(this.toProviderErrorMessage(record.error)));
      return true;
    }
    pending.resolve(record.result);
    return true;
  }

  private rejectPendingProviderRequests(error: Error): void {
    for (const [id, pending] of this.pendingProviderRequests) {
      clearTimeout(pending.timeout);
      pending.reject(error);
      this.pendingProviderRequests.delete(id);
    }
  }

  private toProviderErrorMessage(error: unknown): string {
    if (typeof error === "string" && error.length > 0) {
      return error;
    }
    if (!error || typeof error !== "object" || Array.isArray(error)) {
      return JSON.stringify(error);
    }
    const record = error as Record<string, unknown>;
    if (typeof record.message === "string" && record.message.length > 0) {
      return record.message;
    }
    return JSON.stringify(error);
  }

  private normalizeCommandError(error: unknown): { code: string; message: string } {
    const message = error instanceof Error ? error.message : String(error);
    const normalized = message.toLowerCase();
    if (normalized.includes("timed out waiting for provider response")) {
      return { code: "provider_timeout", message };
    }
    if (
      normalized.includes("provider runtime is unavailable") ||
      normalized.includes("provider runtime exited")
    ) {
      return { code: "provider_unavailable", message };
    }
    if (normalized.includes("no rollout found for thread id")) {
      return { code: "missing_provider_thread", message };
    }
    return { code: "provider_rpc_error", message };
  }
}

function shouldNudgeDaemonDeliveryForEvent(
  event: EnvironmentAgentEvent,
): boolean {
  if (event.type !== "provider.event") {
    return false;
  }

  if (event.method === "turn/completed" || event.method === "turn/end") {
    return true;
  }

  if (event.method !== "thread/status/changed") {
    return false;
  }

  const payload = event.payload;
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    return false;
  }

  const status = (payload as { status?: unknown }).status;
  if (!status || typeof status !== "object" || Array.isArray(status)) {
    return false;
  }

  return (status as { type?: unknown }).type === "idle";
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, Math.max(0, ms));
  });
}
