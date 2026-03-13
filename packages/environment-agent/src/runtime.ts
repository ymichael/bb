import { spawn, type ChildProcess } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  ENVIRONMENT_AGENT_PROTOCOL_VERSION,
  type EnvironmentAgentCommand,
  type EnvironmentAgentCommandEnvelope,
  type EnvironmentAgentCommandAck,
  type EnvironmentAgentDaemonConnectionConfig,
  type EnvironmentAgentDeliveryReason,
  type EnvironmentAgentDeliveryRuntimeState,
  type EnvironmentAgentEvent,
  type EnvironmentAgentEventEnvelope,
  type EnvironmentAgentProviderFile,
  type EnvironmentAgentProviderSpec,
  type EnvironmentAgentProviderStatus,
  type EnvironmentAgentStatusSnapshot,
} from "./protocol.js";

type EnvironmentAgentProviderEnsureCommand = Extract<
  EnvironmentAgentCommand,
  { type: "provider.ensure" }
>;
type EnvironmentAgentRpcCommand = Exclude<
  EnvironmentAgentCommand,
  EnvironmentAgentProviderEnsureCommand
>;

export interface EnvironmentAgentRuntimeOptions {
  threadId?: string;
  projectId?: string;
  environmentId?: string;
  daemonConnection?: EnvironmentAgentDaemonConnectionConfig;
  providerCommand?: string;
  providerArgs?: string[];
  providerLaunchCommand?: string;
  providerLaunchArgs?: string[];
  onProviderRequest?: (request: {
    requestId: string | number;
    method: string;
    params?: unknown;
  }) => Promise<unknown> | unknown;
  onStdoutLine?: (line: string) => void;
  onStderrLine?: (line: string) => void;
}

export type EnvironmentAgentRuntimeTurnState = "unknown" | "active" | "idle";

export interface EnvironmentAgentRuntimeQuiescenceSnapshot {
  hasObservedWork: boolean;
  commandExecutionCount: number;
  pendingProviderRequestCount: number;
  turnState: EnvironmentAgentRuntimeTurnState;
}

export class EnvironmentAgentRuntime {
  private readonly events: EnvironmentAgentEventEnvelope[] = [];
  private sequence = 0;
  private providerRequestId = 0;
  private providerInitializedPid: number | undefined;
  private providerChild: ChildProcess | null = null;
  private readonly pendingProviderRequests = new Map<
    string | number,
    {
      resolve: (value: unknown) => void;
      reject: (reason: Error) => void;
      timeout: ReturnType<typeof setTimeout>;
    }
  >();
  private readonly stdoutLineSubscribers = new Set<(line: string) => void>();
  private readonly stderrLineSubscribers = new Set<(line: string) => void>();
  private readonly eventSubscribers = new Set<(event: EnvironmentAgentEventEnvelope) => void>();
  private providerStdoutBuffer = "";
  private providerStderrBuffer = "";
  private shuttingDown = false;
  private shutdownPromise: Promise<void> | null = null;
  private commandExecutionCount = 0;
  private hasObservedWork = false;
  private turnState: EnvironmentAgentRuntimeTurnState = "unknown";
  private deliveryState: EnvironmentAgentDeliveryRuntimeState = "stopped";
  private connectedToDaemon = false;
  private retryAttemptCount = 0;
  private lastAckedSequence: number | undefined;
  private nextRetryAt: number | undefined;
  private deliveryIssue: EnvironmentAgentDeliveryReason | undefined;
  private lastDeliveryError: string | undefined;

  constructor(private readonly opts: EnvironmentAgentRuntimeOptions) {}

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

  appendEvent(event: EnvironmentAgentEvent): EnvironmentAgentEventEnvelope {
    this.applyEventToQuiescenceState(event);
    const envelope: EnvironmentAgentEventEnvelope = {
      protocolVersion: ENVIRONMENT_AGENT_PROTOCOL_VERSION,
      sequence: ++this.sequence,
      emittedAt: Date.now(),
      threadId: event.threadId,
      event,
    };
    this.events.push(envelope);
    this.emitEvent(envelope);
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
    const pendingEventCount = Math.max(
      0,
      this.sequence - (this.lastAckedSequence ?? 0),
    );
    return {
      protocolVersion: ENVIRONMENT_AGENT_PROTOCOL_VERSION,
      ...(this.opts.threadId ? { threadId: this.opts.threadId } : {}),
      ...(this.opts.projectId ? { projectId: this.opts.projectId } : {}),
      ...(this.opts.environmentId ? { environmentId: this.opts.environmentId } : {}),
      latestSequence: this.sequence,
      ...(this.lastAckedSequence !== undefined
        ? { lastAckedSequence: this.lastAckedSequence }
        : {}),
      connectedToDaemon: this.connectedToDaemon,
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
    connectedToDaemon: boolean;
    deliveryState: EnvironmentAgentDeliveryRuntimeState;
    retryAttemptCount: number;
    lastAckedSequence?: number;
    nextRetryAt?: number;
    deliveryIssue?: EnvironmentAgentDeliveryReason;
    lastDeliveryError?: string;
  }): void {
    this.connectedToDaemon = args.connectedToDaemon;
    this.deliveryState = args.deliveryState;
    this.retryAttemptCount = args.retryAttemptCount;
    this.lastAckedSequence = args.lastAckedSequence;
    this.nextRetryAt = args.nextRetryAt;
    this.deliveryIssue = args.deliveryIssue;
    this.lastDeliveryError = args.lastDeliveryError;
  }

  getQuiescenceSnapshot(): EnvironmentAgentRuntimeQuiescenceSnapshot {
    return {
      hasObservedWork: this.hasObservedWork,
      commandExecutionCount: this.commandExecutionCount,
      pendingProviderRequestCount: this.pendingProviderRequests.size,
      turnState: this.turnState,
    };
  }

  async executeCommand(
    envelope: EnvironmentAgentCommandEnvelope,
  ): Promise<EnvironmentAgentCommandAck> {
    this.commandExecutionCount += 1;
    try {
      const result =
        envelope.command.type === "provider.ensure"
          ? this.ensureProviderStatus(
              this.toProviderEnsureSpec(envelope.command),
            )
          : await this.executeRpcCommand(envelope.command);
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
    command: EnvironmentAgentRpcCommand,
  ): Promise<unknown> {
    await this.ensureProviderForCommand(command);
    return this.requestProviderCommand(command);
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

  private trackAcceptedCommand(command: EnvironmentAgentCommand): void {
    this.hasObservedWork = true;
    switch (command.type) {
      case "thread.start":
      case "thread.resume":
      case "turn.start":
      case "turn.steer":
        this.turnState = "active";
        return;
      case "thread.stop":
        this.turnState = "idle";
        return;
      case "provider.ensure":
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

  private applyEventToQuiescenceState(event: EnvironmentAgentEvent): void {
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
      this.providerStdoutBuffer = this.processBufferedLines({
        buffer: this.providerStdoutBuffer,
        chunk,
        onLine: (line) => {
          this.opts.onStdoutLine?.(line);
          this.emitProviderStdoutLine(line);
          if (this.tryHandleProviderRpcMessage(line)) {
            return;
          }
          this.appendEvent(this.toProviderEvent(line));
        },
      });
    });

    child.stderr?.setEncoding("utf-8");
    child.stderr?.on("data", (chunk: string) => {
      this.providerStderrBuffer = this.processBufferedLines({
        buffer: this.providerStderrBuffer,
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

  private toProviderEnsureSpec(
    command: EnvironmentAgentProviderEnsureCommand,
  ): EnvironmentAgentProviderSpec {
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
    command: EnvironmentAgentRpcCommand,
  ): Promise<void> {
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

  private requestProviderCommand(
    command: EnvironmentAgentRpcCommand,
  ): Promise<unknown> {
    return this.requestProvider({
      method: this.toProviderMethod(command),
      params: this.toProviderParams(command),
    });
  }

  private toProviderMethod(command: EnvironmentAgentRpcCommand): string {
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

  private toProviderParams(command: EnvironmentAgentRpcCommand): unknown {
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

  private tryHandleProviderRpcMessage(line: string): boolean {
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
      void this.handleProviderServerRequest({
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

  private async handleProviderServerRequest(args: {
    requestId: string | number;
    method: string;
    params?: unknown;
  }): Promise<void> {
    const child = this.providerChild;
    const stdin = child?.stdin;
    if (!stdin || child.killed || child.exitCode !== null) {
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

    try {
      const result = await this.opts.onProviderRequest(args);
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
    if (normalized.includes("no rollout found for thread id")) {
      return { code: "missing_provider_thread", message };
    }
    return { code: "provider_rpc_error", message };
  }
}

function normalizeRuntimeEventMethod(method: string): string {
  return method.toLowerCase().replaceAll(".", "/");
}
