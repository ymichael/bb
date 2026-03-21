import { randomUUID } from "node:crypto";
import {
  type EnvironmentDaemonClient,
  ENVIRONMENT_DAEMON_PROTOCOL_VERSION,
  type EnvironmentDaemonCommand,
  type EnvironmentDaemonCommandAck,
  type EnvironmentDaemonCommandEnvelope,
  type EnvironmentDaemonEventEnvelope,
  type EnvironmentDaemonProviderLaunchWrapper,
  getProviderThreadIdFromCommandResult,
} from "@bb/environment-daemon";
import {
  assertNever,
  type PromptInput,
  type ProviderCapabilities,
  type ProviderDynamicTool,
  type ProviderExecutionOptions,
  type ProviderThreadContext,
  type ProviderToolCallRequest,
  type ProviderToolCallResponse,
  type SpawnThreadRequest,
  type Thread,
  type ThreadEvent,
} from "@bb/core";
import type { ProviderToolHost } from "@bb/provider-adapters";

export type ProviderSessionErrorCode =
  | "inactive_session"
  | "no_active_turn"
  | "unsupported_operation"
  | "provider_rpc_error"
  | "provider_timeout"
  | "provider_unavailable"
  | "missing_provider_thread";

export class ProviderSessionError extends Error {
  constructor(
    readonly code: ProviderSessionErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "ProviderSessionError";
  }
}

export interface ProviderSessionNotification {
  method: string;
  normalizedMethod: string;
  providerId: string;
  translatedEvents: ThreadEvent[];
  shouldPersist: boolean;
  shouldBroadcast: boolean;
  nextStatus?: Thread["status"];
  title?: string;
  turnState?: "active" | "idle";
  turnId?: string;
  providerThreadId?: string;
}

export interface ProviderInfo {
  id: string;
  displayName: string;
  capabilities: ProviderCapabilities;
}

export interface ProviderSessionControllerOptions {
  provider: ProviderInfo;
  dynamicTools?: ProviderDynamicTool[];
  resolveDynamicTools?: (args: {
    request: SpawnThreadRequest;
    context: ProviderThreadContext;
  }) => ProviderDynamicTool[] | undefined;
  toolHost?: ProviderToolHost;
  onNotification?: (threadId: string, event: ProviderSessionNotification) => void;
  onProviderStderrLine?: (threadId: string, line: string) => void;
  logger?: Pick<Console, "warn" | "error">;
}

function isMissingProviderThreadMessage(message: string): boolean {
  const normalized = message.toLowerCase();
  return (
    normalized.includes("no rollout found for thread id") ||
    normalized.includes("thread not found")
  );
}

export class ProviderSessionController {
  private readonly authRefreshWarningThreadIds = new Set<string>();
  private readonly suppressedAuthStderrDepth = new Map<string, number>();
  private readonly rpcIdPrefix = randomUUID();
  private rpcIdCounter = 0;

  constructor(private readonly opts: ProviderSessionControllerOptions) {}

  get providerId(): string {
    return this.opts.provider.id;
  }

  get providerDisplayName(): string {
    return this.opts.provider.displayName;
  }

  get providerCapabilities(): ProviderCapabilities {
    return this.opts.provider.capabilities;
  }

  normalizePromptInput(input: PromptInput[]): PromptInput[] {
    const normalized: PromptInput[] = [];
    for (const chunk of input) {
      switch (chunk.type) {
        case "text":
          normalized.push(chunk);
          break;
        case "localFile":
          normalized.push({
            type: "text",
            text: `Attached local file: ${chunk.path}`,
          });
          break;
        case "image":
          normalized.push(chunk);
          break;
        case "localImage":
          normalized.push(chunk);
          break;
        default:
          assertNever(chunk);
      }
    }
    return normalized;
  }

  getInactiveSessionMessage(threadId: string): string {
    return `Thread ${threadId} has no ${this.opts.provider.displayName} session`;
  }


  async startThreadCommand(args: {
    client: EnvironmentDaemonClient;
    threadId: string;
    projectId: string;
    request: SpawnThreadRequest;
    context: ProviderThreadContext;
    providerLaunch?: EnvironmentDaemonProviderLaunchWrapper;
  }): Promise<{ providerThreadId?: string }> {
    await this.ensureProviderRunningForCommand(
      args.client,
      args.context,
      args.providerLaunch,
    );
    const ack = await this.sendEnvironmentDaemonCommand(args.client, {
      type: "thread.start",
      threadId: args.threadId,
      projectId: args.projectId,
      request: args.request,
      context: args.context,
      dynamicTools:
        this.opts.resolveDynamicTools?.({
          request: args.request,
          context: args.context,
        }) ?? this.opts.dynamicTools,
    });
    const providerThreadId = getProviderThreadIdFromCommandResult(ack);
    return { providerThreadId };
  }

  async resumeThreadCommand(args: {
    client: EnvironmentDaemonClient;
    threadId: string;
    projectId: string;
    providerThreadId?: string;
    context: ProviderThreadContext;
    options?: ProviderExecutionOptions;
    resumePath?: string;
    providerLaunch?: EnvironmentDaemonProviderLaunchWrapper;
    dynamicTools?: ProviderDynamicTool[];
  }): Promise<{ providerThreadId?: string }> {
    await this.ensureProviderRunningForCommand(
      args.client,
      args.context,
      args.providerLaunch,
    );
    const ack = await this.sendEnvironmentDaemonCommand(args.client, {
      type: "thread.resume",
      threadId: args.threadId,
      projectId: args.projectId,
      providerThreadId: args.providerThreadId,
      context: args.context,
      ...(args.options ? { options: args.options } : {}),
      ...(args.resumePath ? { resumePath: args.resumePath } : {}),
      ...(args.dynamicTools ? { dynamicTools: args.dynamicTools } : {}),
    });
    const providerThreadId = getProviderThreadIdFromCommandResult(ack);
    return { providerThreadId };
  }

  async sendTurnCommand(args: {
    client: EnvironmentDaemonClient;
    threadId: string;
    providerThreadId?: string;
    activeTurnId?: string;
    input: PromptInput[];
    options?: ProviderExecutionOptions;
    mode?: "auto" | "steer" | "start";
    context: ProviderThreadContext;
    providerLaunch?: EnvironmentDaemonProviderLaunchWrapper;
  }): Promise<{ mode: "steer" | "start"; providerThreadId?: string }> {
    const hasExecutionOverrides = Boolean(
      args.options?.model ||
      args.options?.serviceTier ||
      args.options?.reasoningLevel ||
      args.options?.sandboxMode,
    );
    const requestedMode = args.mode ?? "auto";
    const activeTurnId = args.activeTurnId;
    // The env-daemon resolves steer vs start — we just pass the requested mode.
    // But we can still validate preconditions here.
    const canAutoSteer = Boolean(activeTurnId) && !hasExecutionOverrides;

    if (requestedMode === "steer") {
      if (!activeTurnId) {
        throw new ProviderSessionError("no_active_turn", "No active turn");
      }
      if (hasExecutionOverrides) {
        throw new ProviderSessionError(
          "unsupported_operation",
          "Tell mode 'steer' does not support model, speed, or reasoning overrides",
        );
      }
    }

    await this.ensureProviderRunningForCommand(
      args.client,
      args.context,
      args.providerLaunch,
    );

    const ack = await this.sendEnvironmentDaemonCommand(args.client, {
      type: "turn.run",
      threadId: args.threadId,
      providerThreadId: args.providerThreadId,
      requestedMode,
      ...(requestedMode === "steer" && activeTurnId ? { activeTurnId } : {}),
      input: args.input,
      ...(args.options ? { options: args.options } : {}),
      ...(canAutoSteer && activeTurnId ? { activeTurnId } : {}),
    });
    return {
      mode:
        this.extractTurnModeFromResult(ack.result) ??
        (requestedMode === "steer" ? "steer" : "start"),
      providerThreadId: args.providerThreadId,
    };
  }

  async renameThreadCommand(args: {
    client: EnvironmentDaemonClient;
    threadId: string;
    providerThreadId?: string;
    title: string;
    context: ProviderThreadContext;
    providerLaunch?: EnvironmentDaemonProviderLaunchWrapper;
  }): Promise<void> {
    if (!this.opts.provider.capabilities.supportsRename) return;
    if (!args.providerThreadId) return;

    await this.ensureProviderRunningForCommand(
      args.client,
      args.context,
      args.providerLaunch,
    );
    await this.sendEnvironmentDaemonCommand(args.client, {
      type: "thread.rename",
      threadId: args.threadId,
      providerThreadId: args.providerThreadId,
      title: args.title,
    });
  }

  async handleProviderRequest(args: {
    threadId: string;
    context: ProviderThreadContext;
    requestId: string | number;
    method: string;
    params?: unknown;
  }): Promise<unknown> {
    if (!this.opts.toolHost) {
      throw new ProviderSessionError(
        "unsupported_operation",
        "No provider tool host is configured",
      );
    }

    // The tool call request arrives already decoded from the env-daemon.
    // Parse it from the params.
    const params = (args.params ?? {}) as Record<string, unknown>;
    const threadId = typeof params.threadId === "string" ? params.threadId : args.threadId;
    const turnId = typeof params.turnId === "string" ? params.turnId : "";
    const callId = typeof params.callId === "string" ? params.callId : "";
    const tool = typeof params.tool === "string" ? params.tool : "";

    if (!tool || !callId) {
      throw new ProviderSessionError(
        "unsupported_operation",
        `Unhandled provider request method ${args.method}`,
      );
    }

    const call: ProviderToolCallRequest = {
      requestId: args.requestId,
      threadId,
      turnId,
      callId,
      tool,
      arguments: params.arguments,
    };

    const response = await this.opts.toolHost.execute({
      call,
      context: args.context,
    });

    // Return the response as-is — the env-daemon encodes it for the bridge.
    return {
      contentItems: response.contentItems.map((item) => {
        switch (item.type) {
          case "inputText":
            return { type: "inputText", text: item.text };
          case "inputImage":
            return { type: "inputImage", imageUrl: item.imageUrl };
          default:
            return assertNever(item);
        }
      }),
      success: response.success,
    };
  }

  async ingestReplayedEnvironmentDaemonEvents(args: {
    threadId: string;
    events: EnvironmentDaemonEventEnvelope[];
  }): Promise<void> {
    for (const envelope of args.events) {
      const replayThreadId = envelope.event.threadId || args.threadId;
      this.handleEnvironmentDaemonEvent(replayThreadId, envelope.event);
    }
  }

  clearSessionState(threadId: string): void {
    this.authRefreshWarningThreadIds.delete(threadId);
    this.suppressedAuthStderrDepth.delete(threadId);
  }

  isMissingProviderThreadError(error: unknown): boolean {
    return (
      error instanceof ProviderSessionError &&
      (
        error.code === "missing_provider_thread" ||
        (error.code === "provider_rpc_error" &&
          isMissingProviderThreadMessage(error.message))
      )
    );
  }

  private handleEnvironmentDaemonEvent(
    threadId: string,
    event: EnvironmentDaemonEventEnvelope["event"],
  ): void {
    switch (event.type) {
      case "provider.event":
        if (event.method === "provider.stdout") return;
        // The env-daemon already translated the event and populated metadata
        // fields (normalizedMethod, shouldPersist, shouldBroadcast, etc.).
        // We read them directly instead of re-interpreting.
        this.handleProviderEvent(threadId, event);
        return;
      case "provider.stderr":
        this.handleProviderStderrLine(threadId, event.line);
        return;
      case "provider.rpc_error":
        this.opts.logger?.error(
          `[thread ${threadId}] Provider RPC error (request ${String(event.requestId)}):`,
          event.message,
        );
        return;
      default:
        return;
    }
  }

  private handleProviderEvent(
    threadId: string,
    event: Extract<EnvironmentDaemonEventEnvelope["event"], { type: "provider.event" }>,
  ): void {
    const method = event.method;
    const normalizedMethod = event.normalizedMethod ?? method;
    const translatedEvents = event.translatedEvents ?? [];
    const turnId = event.turnId;
    const turnState = event.turnState ??
      (normalizedMethod === "turn/started" ? "active" as const
        : normalizedMethod === "turn/completed" ? "idle" as const
        : undefined);

    this.opts.onNotification?.(threadId, {
      method,
      normalizedMethod,
      providerId: this.opts.provider.id,
      translatedEvents,
      shouldPersist: event.shouldPersist ?? true,
      shouldBroadcast: event.shouldBroadcast ?? true,
      nextStatus: event.nextStatus,
      title: event.title,
      ...(turnState ? { turnState } : {}),
      ...(turnId ? { turnId } : {}),
    });
  }

  private handleProviderStderrLine(threadId: string, line: string): void {
    if (this.consumeSuppressedAuthStderrLine(threadId, line)) {
      return;
    }

    const normalized = line.toLowerCase();
    const isRefreshTokenConflict =
      normalized.includes("refresh_token_reused") ||
      normalized.includes("refresh token has already been used") ||
      normalized.includes("your access token could not be refreshed");
    const isRefreshTokenFailure = normalized.includes("failed to refresh token");

    if (isRefreshTokenFailure || isRefreshTokenConflict) {
      if (!this.authRefreshWarningThreadIds.has(threadId)) {
        this.authRefreshWarningThreadIds.add(threadId);
        this.opts.logger?.warn(
          `[thread ${threadId}] provider auth refresh conflict (refresh token reused). ` +
            "Another Codex process likely refreshed credentials first. " +
            "If requests start failing, re-authenticate with `codex login` and restart BB server.",
        );
      }

      if (isRefreshTokenFailure && line.includes("{")) {
        const depth = this.braceDepthDelta(line);
        if (depth > 0) {
          this.suppressedAuthStderrDepth.set(threadId, depth);
        }
      }
      return;
    }

    this.opts.onProviderStderrLine?.(threadId, line);
    this.opts.logger?.error(`[thread ${threadId}] stderr: ${line}`);
  }

  private async ensureProviderRunningForCommand(
    client: EnvironmentDaemonClient,
    context: ProviderThreadContext,
    providerLaunch?: EnvironmentDaemonProviderLaunchWrapper,
  ): Promise<void> {
    await this.sendEnvironmentDaemonCommand(client, {
      type: "provider.ensure",
      providerId: this.opts.provider.id,
      context,
      ...(providerLaunch ? { providerLaunch } : {}),
      forThreadId: context.threadId,
    });
  }

  private async sendEnvironmentDaemonCommand(
    client: EnvironmentDaemonClient,
    command: EnvironmentDaemonCommand,
  ): Promise<EnvironmentDaemonCommandAck> {
    const commandToken = `cmd-${this.rpcIdPrefix}-${++this.rpcIdCounter}`;
    const envelope: EnvironmentDaemonCommandEnvelope = {
      meta: {
        protocolVersion: ENVIRONMENT_DAEMON_PROTOCOL_VERSION,
        commandId: commandToken,
        idempotencyKey: commandToken,
        sentAt: Date.now(),
      },
      command,
    };
    const ack = await client.sendCommand(envelope);
    if (ack.state === "accepted" || ack.state === "duplicate") {
      return ack;
    }
    throw this.toCommandError(ack);
  }

  private toCommandError(ack: EnvironmentDaemonCommandAck): ProviderSessionError {
    const message = ack.message ?? "Environment-daemon command failed";
    switch (ack.errorCode) {
      case "missing_provider_thread":
        return new ProviderSessionError("missing_provider_thread", message);
      case "provider_timeout":
        return new ProviderSessionError("provider_timeout", message);
      case "provider_unavailable":
        return new ProviderSessionError("provider_unavailable", message);
      case "unsupported_operation":
        return new ProviderSessionError("unsupported_operation", message);
      case "provider_rpc_error":
      case undefined:
        if (isMissingProviderThreadMessage(message)) {
          return new ProviderSessionError("missing_provider_thread", message);
        }
        return new ProviderSessionError("provider_rpc_error", message);
      default:
        return new ProviderSessionError("provider_rpc_error", message);
    }
  }

  private extractTurnModeFromResult(
    result: unknown,
  ): "steer" | "start" | undefined {
    if (
      result !== null &&
      typeof result === "object" &&
      !Array.isArray(result) &&
      "mode" in result
    ) {
      const mode = (result as { mode?: unknown }).mode;
      if (mode === "steer" || mode === "start") {
        return mode;
      }
    }
    return undefined;
  }

  private consumeSuppressedAuthStderrLine(threadId: string, line: string): boolean {
    const currentDepth = this.suppressedAuthStderrDepth.get(threadId);
    if (!currentDepth || currentDepth <= 0) return false;

    const nextDepth = currentDepth + this.braceDepthDelta(line);
    if (nextDepth > 0) {
      this.suppressedAuthStderrDepth.set(threadId, nextDepth);
    } else {
      this.suppressedAuthStderrDepth.delete(threadId);
    }
    return true;
  }

  private braceDepthDelta(line: string): number {
    let delta = 0;
    for (const ch of line) {
      if (ch === "{") delta += 1;
      else if (ch === "}") delta -= 1;
    }
    return delta;
  }
}
