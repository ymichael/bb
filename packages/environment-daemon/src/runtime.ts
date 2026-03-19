import { spawn, type ChildProcess } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  isThreadProviderId,
  type ProviderAdapter,
  type ProviderToolCallResponse,
} from "@bb/core";
import {
  createProviderAdapter,
  listAvailableProviderInfos,
} from "@bb/provider-adapters";
import {
  ENVIRONMENT_DAEMON_PROTOCOL_VERSION,
  type EnvironmentDaemonCommand,
  type EnvironmentDaemonCommandEnvelope,
  type EnvironmentDaemonCommandAck,
  type EnvironmentDaemonServerConnectionConfig,
  type EnvironmentDaemonDeliveryReason,
  type EnvironmentDaemonDeliveryRuntimeState,
  type EnvironmentDaemonEvent,
  type EnvironmentDaemonEventEnvelope,
  type EnvironmentDaemonProviderFile,
  type EnvironmentDaemonProviderSpec,
  type EnvironmentDaemonProviderStatus,
  type EnvironmentDaemonStatusSnapshot,
} from "./protocol.js";
import { getEnvironmentDaemonProviderSemantics } from "./provider-semantics.js";

type EnvironmentDaemonProviderEnsureCommand = Extract<
  EnvironmentDaemonCommand,
  { type: "provider.ensure" }
>;
type EnvironmentDaemonProviderModelListCommand = Extract<
  EnvironmentDaemonCommand,
  { type: "provider.list_models" }
>;
type EnvironmentDaemonProviderCatalogCommand = Extract<
  EnvironmentDaemonCommand,
  { type: "provider.list_catalog" }
>;
type EnvironmentDaemonRpcCommand = Exclude<
  EnvironmentDaemonCommand,
  | EnvironmentDaemonProviderEnsureCommand
  | EnvironmentDaemonProviderModelListCommand
  | EnvironmentDaemonProviderCatalogCommand
>;

export interface EnvironmentDaemonRuntimeOptions {
  threadId?: string;
  projectId?: string;
  environmentId?: string;
  providerId?: string;
  serverConnection?: EnvironmentDaemonServerConnectionConfig;
  providerCommand?: string;
  providerArgs?: string[];
  providerLaunchCommand?: string;
  providerLaunchArgs?: string[];
  onProviderRequest?: (request: {
    requestId: string | number;
    method: string;
    params?: unknown;
    providerId?: string;
    normalizedMethod?: string;
    toolCall?: import("@bb/core").ProviderToolCallRequest;
    resolvedThreadId?: string;
  }) => Promise<unknown> | unknown;
  onStdoutLine?: (line: string) => void;
  onStderrLine?: (line: string) => void;
  createProviderAdapter?: (providerId: import("@bb/core").ThreadProviderId) => ProviderAdapter;
  listAvailableProviderInfos?: typeof listAvailableProviderInfos;
}

export type EnvironmentDaemonRuntimeTurnState = "unknown" | "active" | "idle";

export interface EnvironmentDaemonRuntimeQuiescenceSnapshot {
  hasObservedWork: boolean;
  commandExecutionCount: number;
  pendingProviderRequestCount: number;
  turnState: EnvironmentDaemonRuntimeTurnState;
}

export class EnvironmentDaemonRuntime {
  private readonly threadIdByProviderThreadKey = new Map<string, string>();
  private readonly threadIdToProviderId = new Map<string, string>();
  private readonly childToProviderId = new Map<ChildProcess, string>();
  private sequence = 0;
  private providerRequestId = 0;
  private readonly providerInitializedPids = new Set<number>();
  private providerChild: ChildProcess | null = null;
  private readonly providerChildren = new Map<string, ChildProcess>();
  private readonly providerStdoutBuffers = new Map<string, string>();
  private readonly providerStderrBuffers = new Map<string, string>();
  /** Maps threadId → ChildProcess so RPC commands route to the correct provider child. */
  private readonly threadIdToChild = new Map<string, ChildProcess>();
  private readonly pendingProviderRequests = new Map<
    string | number,
    {
      child: ChildProcess;
      resolve: (value: unknown) => void;
      reject: (reason: Error) => void;
      timeout: ReturnType<typeof setTimeout>;
    }
  >();
  private readonly stdoutLineSubscribers = new Set<(line: string) => void>();
  private readonly stderrLineSubscribers = new Set<(line: string) => void>();
  private readonly eventSubscribers = new Set<(event: EnvironmentDaemonEventEnvelope) => void>();
  private shuttingDown = false;
  private shutdownPromise: Promise<void> | null = null;
  private commandExecutionCount = 0;
  private hasObservedWork = false;
  private turnState: EnvironmentDaemonRuntimeTurnState = "unknown";
  private deliveryState: EnvironmentDaemonDeliveryRuntimeState = "stopped";
  private connectedToServer = false;
  private retryAttemptCount = 0;
  private lastAckedSequence: number | undefined;
  private nextRetryAt: number | undefined;
  private deliveryIssue: EnvironmentDaemonDeliveryReason | undefined;
  private lastDeliveryError: string | undefined;

  constructor(private readonly opts: EnvironmentDaemonRuntimeOptions) {}

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
      await this.stopProviderChild(opts?.timeoutMs ?? 1_000);
    })();

    return this.shutdownPromise;
  }

  appendEvent(event: EnvironmentDaemonEvent): EnvironmentDaemonEventEnvelope {
    this.applyEventToQuiescenceState(event);
    const envelope: EnvironmentDaemonEventEnvelope = {
      protocolVersion: ENVIRONMENT_DAEMON_PROTOCOL_VERSION,
      sequence: ++this.sequence,
      emittedAt: Date.now(),
      threadId: event.threadId,
      event,
    };
    this.emitEvent(envelope);
    return envelope;
  }

  sendProviderLine(line: string): void {
    if (!line.trim()) return;
    this.providerChild?.stdin?.write(`${line}\n`);
  }

  ensureProviderRunning(spec?: EnvironmentDaemonProviderSpec): ChildProcess | null {
    const resolvedSpec = this.resolveProviderSpec(spec);
    if (!resolvedSpec) {
      // No spec and no default command — return the active child if alive,
      // falling back to any live child in the map.
      if (this.providerChild && !this.providerChild.killed) {
        return this.providerChild;
      }
      for (const child of this.providerChildren.values()) {
        if (!child.killed && child.exitCode === null) {
          this.providerChild = child;
          return child;
        }
      }
      return null;
    }

    // Look up an existing child for this provider spec (keyed by the full
    // launch configuration so that two threads using the same binary but
    // different env/files/args get separate children).
    const key = providerSpecKey(resolvedSpec);
    const existing = this.providerChildren.get(key);
    if (existing && !existing.killed && existing.exitCode === null) {
      // Switch the active child so stdin writes target this provider.
      this.providerChild = existing;
      return existing;
    }

    // Spawn a new child for this provider spec.
    const child = this.spawnProvider(resolvedSpec, key);
    this.providerChildren.set(key, child);
    this.providerChild = child;
    return child;
  }

  getProviderStatus(): EnvironmentDaemonProviderStatus {
    // Report running if any provider child is alive.
    const child = this.providerChild;
    const running = Boolean(child && child.exitCode === null && !child.killed)
      || [...this.providerChildren.values()].some(
        (c) => c.exitCode === null && !c.killed,
      );
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

  subscribeToEvents(listener: (event: EnvironmentDaemonEventEnvelope) => void): () => void {
    this.eventSubscribers.add(listener);
    return () => {
      this.eventSubscribers.delete(listener);
    };
  }

  createCommandAck(args: {
    commandId: string;
    idempotencyKey: string;
    state: EnvironmentDaemonCommandAck["state"];
    errorCode?: string;
    message?: string;
    result?: unknown;
  }): EnvironmentDaemonCommandAck {
    return {
      protocolVersion: ENVIRONMENT_DAEMON_PROTOCOL_VERSION,
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

  getStatusSnapshot(): EnvironmentDaemonStatusSnapshot {
    const pendingEventCount = Math.max(
      0,
      this.sequence - (this.lastAckedSequence ?? 0),
    );
    return {
      protocolVersion: ENVIRONMENT_DAEMON_PROTOCOL_VERSION,
      ...(this.opts.threadId ? { threadId: this.opts.threadId } : {}),
      ...(this.opts.projectId ? { projectId: this.opts.projectId } : {}),
      ...(this.opts.environmentId ? { environmentId: this.opts.environmentId } : {}),
      latestSequence: this.sequence,
      ...(this.lastAckedSequence !== undefined
        ? { lastAckedSequence: this.lastAckedSequence }
        : {}),
      connectedToServer: this.connectedToServer,
      pendingEventCount,
      pendingCommandCount: this.pendingProviderRequests.size,
      deliveryState: this.deliveryState,
      ...(this.deliveryIssue ? { deliveryIssue: this.deliveryIssue } : {}),
      retryAttemptCount: this.retryAttemptCount,
      ...(this.nextRetryAt !== undefined ? { nextRetryAt: this.nextRetryAt } : {}),
      ...(this.lastDeliveryError ? { lastDeliveryError: this.lastDeliveryError } : {}),
    };
  }

  setDaemonDeliveryState(args: {
    connectedToServer: boolean;
    deliveryState: EnvironmentDaemonDeliveryRuntimeState;
    retryAttemptCount: number;
    lastAckedSequence?: number;
    nextRetryAt?: number;
    deliveryIssue?: EnvironmentDaemonDeliveryReason;
    lastDeliveryError?: string;
  }): void {
    this.connectedToServer = args.connectedToServer;
    this.deliveryState = args.deliveryState;
    this.retryAttemptCount = args.retryAttemptCount;
    this.lastAckedSequence = args.lastAckedSequence;
    this.nextRetryAt = args.nextRetryAt;
    this.deliveryIssue = args.deliveryIssue;
    this.lastDeliveryError = args.lastDeliveryError;
  }

  getQuiescenceSnapshot(): EnvironmentDaemonRuntimeQuiescenceSnapshot {
    return {
      hasObservedWork: this.hasObservedWork,
      commandExecutionCount: this.commandExecutionCount,
      pendingProviderRequestCount: this.pendingProviderRequests.size,
      turnState: this.turnState,
    };
  }

  async executeCommand(
    envelope: EnvironmentDaemonCommandEnvelope,
  ): Promise<EnvironmentDaemonCommandAck> {
    this.commandExecutionCount += 1;
    try {
      const result =
        envelope.command.type === "provider.ensure"
          ? this.ensureProviderStatus(
              await this.toProviderEnsureSpec(envelope.command),
              envelope.command.forThreadId,
              envelope.command.providerId,
            )
          : envelope.command.type === "provider.list_models"
            ? await this.listProviderModels(envelope.command.providerId)
          : envelope.command.type === "provider.list_catalog"
            ? this.listProviderCatalog()
          : await this.executeRpcCommand(envelope.command);
      this.learnProviderThreadMapping(envelope.command, result);
      this.trackAcceptedCommand(envelope.command);
      return this.createCommandAck({
        commandId: envelope.meta.commandId,
        idempotencyKey: envelope.meta.idempotencyKey,
        state: "accepted",
        result,
      });
    } catch (error) {
      const normalizedError = this.normalizeCommandError(error);
      this.trackRejectedCommand();
      return this.createCommandAck({
        commandId: envelope.meta.commandId,
        idempotencyKey: envelope.meta.idempotencyKey,
        state: "rejected",
        errorCode: normalizedError.code,
        message: normalizedError.message,
      });
    } finally {
      this.commandExecutionCount = Math.max(0, this.commandExecutionCount - 1);
    }
  }

  private async executeRpcCommand(
    command: EnvironmentDaemonRpcCommand,
  ): Promise<unknown> {
    const child = await this.ensureProviderForCommand(command);
    return this.requestProviderCommand(command, child);
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

  private emitEvent(event: EnvironmentDaemonEventEnvelope): void {
    for (const subscriber of this.eventSubscribers) {
      subscriber(event);
    }
  }

  private trackAcceptedCommand(command: EnvironmentDaemonCommand): void {
    this.hasObservedWork = true;
    switch (command.type) {
      case "thread.start":
      case "thread.resume":
      case "turn.run":
        this.turnState = "active";
        return;
      case "thread.stop":
        this.turnState = "idle";
        return;
      case "provider.ensure":
      case "provider.list_models":
      case "provider.list_catalog":
      case "thread.rename":
      case "workspace.status":
      case "workspace.diff":
        return;
      default:
        return command satisfies never;
    }
  }

  private trackRejectedCommand(): void {
    this.hasObservedWork = true;
  }

  private applyEventToQuiescenceState(event: EnvironmentDaemonEvent): void {
    switch (event.type) {
      case "environment.ready":
        return;
      case "environment.degraded":
        this.hasObservedWork = true;
        this.turnState = "idle";
        return;
      case "thread.started":
        this.hasObservedWork = true;
        return;
      case "thread.stopped":
      case "turn.completed":
        this.hasObservedWork = true;
        this.turnState = "idle";
        return;
      case "turn.started":
        this.hasObservedWork = true;
        this.turnState = "active";
        return;
      case "provider.event": {
        this.hasObservedWork = true;
        const normalizedMethod = normalizeRuntimeEventMethod(event.method);
        if (normalizedMethod === "turn/start" || normalizedMethod === "turn/started") {
          this.turnState = "active";
          return;
        }
        if (normalizedMethod === "turn/completed" || normalizedMethod === "turn/end") {
          this.turnState = "idle";
        }
        return;
      }
      case "provider.stderr":
      case "provider.rpc_error":
      case "workspace.status.changed":
        this.hasObservedWork = true;
        return;
      default:
        return event satisfies never;
    }
  }

  ensureProviderStatus(
    spec?: EnvironmentDaemonProviderSpec,
    forThreadId?: string,
    providerId?: string,
  ): EnvironmentDaemonProviderStatus {
    const launchedBefore = this.getProviderStatus().running;
    const child = this.ensureProviderRunning(spec);
    if (child && forThreadId) {
      this.threadIdToChild.set(forThreadId, child);
      const resolvedProviderId = providerId?.trim() || this.opts.providerId?.trim();
      if (resolvedProviderId) {
        this.threadIdToProviderId.set(forThreadId, resolvedProviderId);
        this.childToProviderId.set(child, resolvedProviderId);
      }
    }
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
    spec?: EnvironmentDaemonProviderSpec,
  ): EnvironmentDaemonProviderSpec | null {
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

  private spawnProvider(spec: EnvironmentDaemonProviderSpec, specKey: string): ChildProcess {
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
      const updated = this.processBufferedLines({
        buffer: this.providerStdoutBuffers.get(specKey) ?? "",
        chunk,
        onLine: (line) => {
          this.opts.onStdoutLine?.(line);
          this.emitProviderStdoutLine(line);
          // Capture `child` in this closure so provider-initiated RPCs
          // are routed back to the originating process, not whichever
          // child happens to be `this.providerChild` at response time.
          if (this.tryHandleProviderRpcMessage(line, child)) {
            return;
          }
          this.appendEvent(this.toProviderEvent(line, child));
        },
      });
      this.providerStdoutBuffers.set(specKey, updated);
    });

    child.stderr?.setEncoding("utf-8");
    child.stderr?.on("data", (chunk: string) => {
      const updated = this.processBufferedLines({
        buffer: this.providerStderrBuffers.get(specKey) ?? "",
        chunk,
        onLine: (line) => {
          this.opts.onStderrLine?.(line);
          this.emitProviderStderrLine(line);
          this.appendEvent({
            type: "provider.stderr",
            threadId: this.resolveThreadId(),
            line,
          });
        },
      });
      this.providerStderrBuffers.set(specKey, updated);
    });

    child.once("exit", (_code, _signal) => {
      if (this.providerChild === child) {
        this.providerChild = null;
      }
      this.childToProviderId.delete(child);
      this.providerChildren.delete(specKey);
      this.providerStdoutBuffers.delete(specKey);
      this.providerStderrBuffers.delete(specKey);
      // Remove any threadId → child mappings that point to this child.
      for (const [tid, c] of this.threadIdToChild) {
        if (c === child) this.threadIdToChild.delete(tid);
      }
      if (child.pid !== undefined) {
        this.providerInitializedPids.delete(child.pid);
      }
      // Only reject requests that belong to the exiting child — other
      // children may still be healthy with in-flight RPCs.
      this.rejectPendingProviderRequestsForChild(
        child,
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
    spec: EnvironmentDaemonProviderSpec,
  ): NodeJS.ProcessEnv {
    const explicitHome = spec.env?.HOME?.trim();
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      ...(spec.env ?? {}),
    };
    if (!spec.files || spec.files.length === 0) {
      return env;
    }

    const homeDir = explicitHome || this.resolveManagedProviderHomeDir(spec);
    this.materializeProviderFiles(homeDir, spec.files);
    env.HOME = homeDir;
    env.CODEX_HOME = env.CODEX_HOME?.trim() || path.join(homeDir, ".codex");
    return env;
  }

  private materializeProviderFiles(
    homeDir: string,
    files: EnvironmentDaemonProviderFile[],
  ): void {
    for (const file of files) {
      const targetPath = this.resolveProviderFilePath(homeDir, file);
      mkdirSync(path.dirname(targetPath), { recursive: true });
      writeFileSync(targetPath, file.content, "utf8");
    }
  }

  private resolveManagedProviderHomeDir(spec: EnvironmentDaemonProviderSpec): string {
    // Each provider spec gets its own managed HOME so that concurrent
    // children with different auth files don't overwrite each other.
    const specHash = createHash("sha256")
      .update(providerSpecKey(spec))
      .digest("hex")
      .slice(0, 32);
    return path.join(
      tmpdir(),
      "bb-environment-daemon",
      this.resolveThreadId(),
      `provider-home-${specHash}`,
    );
  }

  private resolveProviderFilePath(
    homeDir: string,
    file: EnvironmentDaemonProviderFile,
  ): string {
    switch (file.placement) {
      case "home":
        return path.join(homeDir, file.path);
    }
    const exhausted: never = file.placement;
    throw new Error(`Unsupported provider file placement: ${String(exhausted)}`);
  }

  private async stopProviderChild(timeoutMs: number): Promise<void> {
    // Collect all live children (the active one plus any others in the map).
    const children = new Set<ChildProcess>();
    if (this.providerChild) {
      children.add(this.providerChild);
    }
    for (const child of this.providerChildren.values()) {
      children.add(child);
    }

    this.providerChild = null;
    this.providerChildren.clear();
    this.providerStdoutBuffers.clear();
    this.providerStderrBuffers.clear();
    this.threadIdToChild.clear();
    this.providerInitializedPids.clear();
    this.rejectPendingProviderRequests(
      new Error("Provider runtime stopped during environment-daemon shutdown"),
    );

    if (children.size === 0) {
      return;
    }

    await Promise.all(
      [...children].map((child) => this.stopSingleChild(child, timeoutMs)),
    );
  }

  private async stopSingleChild(child: ChildProcess, timeoutMs: number): Promise<void> {
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

  private resolveThreadId(): string {
    return this.opts.threadId ?? process.env.BB_THREAD_ID ?? "unknown-thread";
  }

  private resolveProviderEventThreadId(
    params: unknown,
    providerId: string | undefined,
  ): string {
    const providerThreadId = this.extractProviderThreadId(params, providerId);
    if (!providerThreadId) {
      return this.resolveThreadId();
    }
    return (
      this.threadIdByProviderThreadKey.get(
        this.createProviderThreadKey(providerId, providerThreadId),
      ) ??
      this.resolveThreadId()
    );
  }

  private toProviderEvent(
    line: string,
    sourceChild?: ChildProcess,
  ): EnvironmentDaemonEvent {
    let parsed: unknown;
    const providerId = this.resolveProviderIdForChild(sourceChild);
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

    const payload = record.params ?? {};
    const normalized = this.getProviderSemanticsForProviderId(providerId)
      ?.normalizeEvent(record.method, payload);
    return {
      type: "provider.event",
      threadId: this.resolveProviderEventThreadId(payload, providerId),
      method: record.method,
      payload,
      ...(normalized?.providerId ? { providerId: normalized.providerId } : {}),
      ...(normalized?.normalizedMethod
        ? { normalizedMethod: normalized.normalizedMethod }
        : {}),
      ...(normalized ? { shouldPersist: normalized.shouldPersist } : {}),
      ...(normalized ? { shouldBroadcast: normalized.shouldBroadcast } : {}),
      ...(normalized?.nextStatus ? { nextStatus: normalized.nextStatus } : {}),
      ...(normalized?.title ? { title: normalized.title } : {}),
      ...(normalized?.turnState ? { turnState: normalized.turnState } : {}),
      ...(normalized?.turnId ? { turnId: normalized.turnId } : {}),
    };
  }

  private learnProviderThreadMapping(
    command: EnvironmentDaemonCommand,
    result: unknown,
  ): void {
    const providerId = this.resolveProviderIdForCommand(command);
    switch (command.type) {
      case "thread.start":
        this.recordProviderThreadMapping(
          command.threadId,
          this.extractProviderThreadId(result, providerId),
          providerId,
        );
        return;
      case "thread.resume":
        this.recordProviderThreadMapping(
          command.threadId,
          this.extractProviderThreadId(result, providerId) ?? command.providerThreadId,
          providerId,
        );
        return;
      case "turn.run":
      case "thread.rename":
        this.recordProviderThreadMapping(
          command.threadId,
          command.providerThreadId,
          providerId,
        );
        return;
      case "thread.stop":
      case "workspace.status":
      case "workspace.diff":
      case "provider.ensure":
      case "provider.list_models":
      case "provider.list_catalog":
        return;
      default:
        return command satisfies never;
    }
  }

  private recordProviderThreadMapping(
    threadId: string,
    providerThreadId: string | undefined,
    providerId: string | undefined,
  ): void {
    if (!providerThreadId) {
      return;
    }
    this.threadIdByProviderThreadKey.set(
      this.createProviderThreadKey(providerId, providerThreadId),
      threadId,
    );
  }

  private extractProviderThreadId(
    value: unknown,
    providerId?: string,
  ): string | undefined {
    const normalizedThreadId =
      this.getProviderSemanticsForProviderId(providerId)?.extractThreadId(value);
    if (normalizedThreadId) {
      return normalizedThreadId;
    }
    const record = this.asRecord(value);
    if (!record) {
      return undefined;
    }
    // Check all known thread ID field variants: direct threadId, thread_id,
    // conversationId/conversation_id (Codex), and nested thread.id.
    const candidates: (string | undefined)[] = [
      typeof record.threadId === "string" && record.threadId.length > 0
        ? record.threadId : undefined,
      typeof record.thread_id === "string" && record.thread_id.length > 0
        ? record.thread_id : undefined,
      typeof record.conversationId === "string" && record.conversationId.length > 0
        ? record.conversationId : undefined,
      typeof record.conversation_id === "string" && record.conversation_id.length > 0
        ? record.conversation_id : undefined,
    ];
    const directMatch = candidates.find((c): c is string => c !== undefined);
    if (directMatch) {
      return directMatch;
    }
    const nestedThread = this.asRecord(record.thread);
    if (nestedThread && typeof nestedThread.id === "string" && nestedThread.id.length > 0) {
      return nestedThread.id;
    }
    return undefined;
  }

  private asRecord(value: unknown): Record<string, unknown> | undefined {
    return value !== null && typeof value === "object" && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : undefined;
  }

  private async toProviderEnsureSpec(
    command: EnvironmentDaemonProviderEnsureCommand,
  ): Promise<EnvironmentDaemonProviderSpec> {
    if (
      command.command === undefined ||
      command.args === undefined
    ) {
      const provider = this.getProviderAdapterForId(
        command.providerId ?? this.opts.providerId ?? process.env.BB_THREAD_PROVIDER_ID,
      );
      if (!provider || !command.context) {
        throw new Error("provider.ensure spec is unavailable");
      }
      const launchConfig = await provider.resolveLaunchConfiguration?.(command.context);
      return {
        command: provider.processCommand,
        args: [...provider.processArgs],
        ...(launchConfig?.env ? { env: { ...launchConfig.env } } : {}),
        ...(launchConfig?.files
          ? { files: launchConfig.files.map((file) => ({ ...file })) }
          : {}),
        ...(command.providerLaunch
          ? {
              launchCommand: command.providerLaunch.command,
              launchArgs: [...command.providerLaunch.args],
            }
          : {}),
      };
    }

    return {
      command: command.command,
      args: [...command.args],
      ...(command.launchCommand ? { launchCommand: command.launchCommand } : {}),
      ...(command.launchArgs ? { launchArgs: [...command.launchArgs] } : {}),
      ...(command.env ? { env: { ...command.env } } : {}),
      ...(command.files
        ? { files: command.files.map((file) => ({ ...file })) }
        : {}),
    };
  }

  private async ensureProviderForCommand(
    command: EnvironmentDaemonRpcCommand,
  ): Promise<ChildProcess | undefined> {
    switch (command.type) {
      case "thread.start":
      case "thread.resume":
      case "thread.stop":
      case "turn.run":
      case "thread.rename": {
        // Route per-thread commands to the child registered via
        // provider.ensure(forThreadId). Single-provider runtimes may not
        // have a per-thread mapping, so they fall back to the shared child.
        const mapped = this.resolveChildForThread(command.threadId);
        const child = mapped ?? this.ensureProviderRunning();
        if (!child) {
          throw new Error("Provider runtime is unavailable");
        }
        const initialize = command.initialize ?? this.buildInitializeRequest();
        if (!initialize) {
          return child;
        }
        if (child.pid !== undefined && this.providerInitializedPids.has(child.pid)) {
          return child;
        }
        await this.requestProvider({
          method: initialize.method,
          params: initialize.params,
          child,
        });
        if (child.pid !== undefined) {
          this.providerInitializedPids.add(child.pid);
        }
        return child;
      }
      case "workspace.status":
      case "workspace.diff": {
        // Workspace commands also need routing to the correct child so
        // they reach the provider that owns the thread's workspace.
        const mapped = this.resolveChildForThread(command.threadId);
        return mapped ?? this.providerChild ?? this.ensureProviderRunning() ?? undefined;
      }
      default:
        return command satisfies never;
    }
  }

  /**
   * Look up the provider child that was registered for a given threadId
   * via a preceding provider.ensure command.  Returns undefined when
   * no mapping exists or the mapped child has already exited.
   */
  private resolveChildForThread(threadId: string): ChildProcess | undefined {
    const child = this.threadIdToChild.get(threadId);
    if (!child) return undefined;
    if (child.killed || child.exitCode !== null) {
      this.threadIdToChild.delete(threadId);
      return undefined;
    }
    return child;
  }

  private requestProviderCommand(
    command: EnvironmentDaemonRpcCommand,
    child?: ChildProcess,
  ): Promise<unknown> {
    if (command.type === "turn.run") {
      return this.requestProvider({
        ...this.resolveTurnRunRequest(command),
        child,
      });
    }
    return this.requestProvider({
      method: this.toProviderMethod(command),
      params: this.toProviderParams(command),
      child,
    });
  }

  private async listProviderModels(
    providerId?: string,
  ): Promise<import("@bb/core").AvailableModel[]> {
    const provider = this.getProviderAdapterForId(
      providerId ?? this.opts.providerId ?? process.env.BB_THREAD_PROVIDER_ID,
    );
    if (!provider) {
      throw new Error("Provider runtime is unavailable");
    }
    return provider.listModels();
  }

  private listProviderCatalog(): import("@bb/core").SystemProviderInfo[] {
    return (this.opts.listAvailableProviderInfos ?? listAvailableProviderInfos)().map((provider) => ({
      ...provider,
      capabilities: { ...provider.capabilities },
    }));
  }

  private resolveTurnRunRequest(command: Extract<EnvironmentDaemonRpcCommand, { type: "turn.run" }>): {
    method: string;
    params: unknown;
  } {
    const provider = this.getProviderAdapterForThread(command.threadId);
    const requestedMode = command.requestedMode ?? "auto";
    const canSteer = Boolean(command.activeTurnId) && Boolean(
      provider?.turnSteerMethod &&
      provider.createTurnSteerParams &&
      command.input !== undefined,
    );

    if (requestedMode === "steer") {
      if (!command.activeTurnId) {
        throw new Error("No active turn");
      }
      const steerParams = this.resolveTurnSteerParams(command);
      if (steerParams === undefined) {
        throw new Error("turn/steer is unsupported");
      }
      return {
        method: provider?.turnSteerMethod ?? "turn/steer",
        params: steerParams,
      };
    }

    if (requestedMode !== "start" && canSteer) {
      const steerParams = this.resolveTurnSteerParams(command);
      if (steerParams !== undefined) {
        return {
          method: provider?.turnSteerMethod ?? "turn/steer",
          params: steerParams,
        };
      }
    }

    return {
      method: provider?.turnStartMethod ?? "turn/start",
      params: this.resolveTurnStartParams(command),
    };
  }

  private resolveTurnStartParams(
    command: Extract<EnvironmentDaemonRpcCommand, { type: "turn.run" }>,
  ): unknown {
    const provider = this.getProviderAdapterForThread(command.threadId);
    if (!provider || command.input === undefined) {
      throw new Error("turn/start params are unavailable");
    }
    return provider.createTurnStartParams(
      command.providerThreadId,
      command.input,
      command.options,
    );
  }

  private resolveTurnSteerParams(
    command: Extract<EnvironmentDaemonRpcCommand, { type: "turn.run" }>,
  ): unknown | undefined {
    const provider = this.getProviderAdapterForThread(command.threadId);
    if (
      !provider?.turnSteerMethod ||
      !provider.createTurnSteerParams ||
      !command.activeTurnId ||
      command.input === undefined
    ) {
      return undefined;
    }
    return provider.createTurnSteerParams(
      command.providerThreadId,
      command.activeTurnId,
      command.input,
    );
  }

  private toProviderMethod(command: EnvironmentDaemonRpcCommand): string {
    const provider = this.getProviderAdapterForThread(command.threadId);
    switch (command.type) {
      case "thread.start":
        return provider?.threadStartMethod ?? "thread/start";
      case "thread.resume":
        return provider?.threadResumeMethod ?? "thread/resume";
      case "thread.stop":
        return "thread/stop";
      case "turn.run":
        return provider?.turnStartMethod ?? "turn/start";
      case "thread.rename":
        return provider?.threadNameSetMethod ?? "thread/name/set";
      case "workspace.status":
        return "workspace/status";
      case "workspace.diff":
        return "workspace/diff";
    }
  }

  private toProviderParams(command: EnvironmentDaemonRpcCommand): unknown {
    const provider = this.getProviderAdapterForThread(command.threadId);
    switch (command.type) {
      case "thread.start":
        if (!provider || !command.request || !command.context) {
          throw new Error("thread/start params are unavailable");
        }
        return provider.createThreadStartParams(
          command.request,
          command.context,
          command.dynamicTools,
        );
      case "thread.resume":
        if (!provider || !command.context) {
          throw new Error("thread/resume params are unavailable");
        }
        return provider.createThreadResumeParams(
          command.providerThreadId,
          command.context,
          command.options,
          command.resumePath,
        );
      case "thread.rename":
        if (!provider?.createThreadNameSetParams) {
          throw new Error("thread/name/set params are unavailable");
        }
        return provider.createThreadNameSetParams(
          command.providerThreadId,
          command.title,
        );
      case "turn.run":
        return this.resolveTurnStartParams(command);
      case "thread.stop":
        return {};
      case "workspace.status":
      case "workspace.diff":
        return { threadId: command.threadId };
    }
  }

  private requestProvider(args: {
    method: string;
    params: unknown;
    timeoutMs?: number;
    child?: ChildProcess;
  }): Promise<unknown> {
    const child = args.child ?? this.providerChild;
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
      this.pendingProviderRequests.set(id, { child, resolve, reject, timeout });
      try {
        stdin.write(`${message}\n`);
      } catch (error) {
        clearTimeout(timeout);
        this.pendingProviderRequests.delete(id);
        reject(error instanceof Error ? error : new Error(String(error)));
      }
    });
  }

  private tryHandleProviderRpcMessage(line: string, sourceChild: ChildProcess): boolean {
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
    const id =
      typeof record.id === "number" || typeof record.id === "string"
        ? record.id
        : undefined;
    if (id === undefined) {
      return false;
    }
    if (typeof record.method === "string") {
      void this.handleProviderServerRequest(sourceChild, {
        requestId: id,
        method: record.method,
        params: record.params,
      });
      return true;
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

  private async handleProviderServerRequest(
    sourceChild: ChildProcess,
    args: {
      requestId: string | number;
      method: string;
      params?: unknown;
    },
  ): Promise<void> {
    // Route the response back to the child that emitted the request,
    // not whichever child happens to be active right now.
    const stdin = sourceChild.stdin;
    if (!stdin || sourceChild.killed || sourceChild.exitCode !== null) {
      return;
    }

    if (!this.opts.onProviderRequest) {
      stdin.write(
        `${JSON.stringify({
          jsonrpc: "2.0",
          id: args.requestId,
          error: {
            code: -32601,
            message: `Unhandled provider request method ${args.method}`,
          },
        })}\n`,
      );
      return;
    }

    const providerId = this.resolveProviderIdForChild(sourceChild);
    const providerSemantics = this.getProviderSemanticsForProviderId(providerId);
    const resolvedThreadId = this.resolveProviderEventThreadId(args.params, providerId);

    try {
      const response = await this.opts.onProviderRequest({
        ...args,
        resolvedThreadId,
        ...(providerSemantics
          ? {
              providerId,
              normalizedMethod: normalizeRuntimeEventMethod(args.method),
              toolCall: providerSemantics.decodeToolCallRequest(
                args.requestId,
                args.method,
                args.params,
              ) ?? undefined,
            }
          : {}),
      });
      const result =
        isProviderToolCallResponse(response) && providerSemantics
          ? providerSemantics.encodeToolCallResponse(response)
          : response;
      stdin.write(
        `${JSON.stringify({
          jsonrpc: "2.0",
          id: args.requestId,
          result,
        })}\n`,
      );
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.appendEvent({
        type: "provider.rpc_error",
        threadId: this.resolveThreadId(),
        requestId: args.requestId,
        message,
      });
      stdin.write(
        `${JSON.stringify({
          jsonrpc: "2.0",
          id: args.requestId,
          error: {
            code: -32000,
            message,
          },
        })}\n`,
      );
    }
  }

  private rejectPendingProviderRequests(error: Error): void {
    for (const [id, pending] of this.pendingProviderRequests) {
      clearTimeout(pending.timeout);
      pending.reject(error);
      this.pendingProviderRequests.delete(id);
    }
  }

  private rejectPendingProviderRequestsForChild(child: ChildProcess, error: Error): void {
    for (const [id, pending] of this.pendingProviderRequests) {
      if (pending.child !== child) continue;
      clearTimeout(pending.timeout);
      pending.reject(error);
      this.pendingProviderRequests.delete(id);
    }
  }

  private processBufferedLines(args: {
    buffer: string;
    chunk: string;
    onLine: (line: string) => void;
  }): string {
    const combined = args.buffer + args.chunk;
    const parts = combined.split(/\r\n|\n|\r/g);
    const remainder = parts.pop() ?? "";
    for (const line of parts) {
      if (!line.trim()) continue;
      args.onLine(line);
    }
    return remainder;
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
    if (
      this.getProviderSemanticsForProviderId(
        this.opts.providerId ?? process.env.BB_THREAD_PROVIDER_ID,
      )?.isMissingProviderThreadMessage(message) ||
      normalized.includes("no rollout found for thread id")
    ) {
      return { code: "missing_provider_thread", message };
    }
    return { code: "provider_rpc_error", message };
  }

  private getProviderSemanticsForProviderId(providerId: string | undefined) {
    return getEnvironmentDaemonProviderSemantics(providerId);
  }

  private getProviderAdapterForThread(threadId: string): ProviderAdapter | undefined {
    return this.getProviderAdapterForId(this.resolveProviderIdForThread(threadId));
  }

  private getProviderAdapterForId(providerId: string | undefined): ProviderAdapter | undefined {
    if (!providerId || !isThreadProviderId(providerId)) {
      return undefined;
    }
    if (this.opts.createProviderAdapter) {
      return this.opts.createProviderAdapter(providerId);
    }
    return createProviderAdapter({ providerId });
  }

  private buildInitializeRequest() {
    const provider = this.getProviderAdapterForId(
      this.opts.providerId ?? process.env.BB_THREAD_PROVIDER_ID,
    );
    if (!provider) {
      return undefined;
    }
    return {
      method: provider.initializeMethod,
      params:
        provider.createInitializeParams?.(provider.clientInfo) ?? {
          clientInfo: provider.clientInfo,
        },
    };
  }

  private resolveProviderIdForThread(threadId: string): string | undefined {
    return (
      this.threadIdToProviderId.get(threadId) ??
      this.opts.providerId ??
      process.env.BB_THREAD_PROVIDER_ID
    );
  }

  private resolveProviderIdForCommand(
    command: EnvironmentDaemonCommand,
  ): string | undefined {
    switch (command.type) {
      case "provider.ensure":
        return command.providerId ?? this.opts.providerId ?? process.env.BB_THREAD_PROVIDER_ID;
      case "provider.list_models":
        return command.providerId ?? this.opts.providerId ?? process.env.BB_THREAD_PROVIDER_ID;
      case "thread.start":
      case "thread.resume":
      case "thread.stop":
      case "turn.run":
      case "thread.rename":
      case "workspace.status":
      case "workspace.diff":
        return this.resolveProviderIdForThread(command.threadId);
      case "provider.list_catalog":
        return this.opts.providerId ?? process.env.BB_THREAD_PROVIDER_ID;
      default:
        return command satisfies never;
    }
  }

  private resolveProviderIdForChild(child: ChildProcess | undefined): string | undefined {
    return (
      (child ? this.childToProviderId.get(child) : undefined) ??
      this.opts.providerId ??
      process.env.BB_THREAD_PROVIDER_ID
    );
  }

  private createProviderThreadKey(
    providerId: string | undefined,
    providerThreadId: string,
  ): string {
    return `${providerId ?? "__unknown__"}:${providerThreadId}`;
  }
}

function isProviderToolCallResponse(value: unknown): value is ProviderToolCallResponse {
  return (
    value !== null &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    Array.isArray((value as { contentItems?: unknown }).contentItems) &&
    typeof (value as { success?: unknown }).success === "boolean"
  );
}

function normalizeRuntimeEventMethod(method: string): string {
  return method.toLowerCase().replaceAll(".", "/");
}

/**
 * Produce a stable key for a provider spec so that children are only reused
 * when the full launch configuration matches — not just the command name.
 */
function providerSpecKey(spec: EnvironmentDaemonProviderSpec): string {
  return JSON.stringify([
    spec.command,
    spec.args,
    spec.launchCommand ?? null,
    spec.launchArgs ?? [],
    spec.env ?? null,
    spec.files?.map((f) => [f.path, f.content, f.placement]) ?? null,
  ]);
}
