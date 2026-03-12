import { randomUUID } from "node:crypto";
import {
  type EnvironmentAgentClient,
  ENVIRONMENT_AGENT_PROTOCOL_VERSION,
  type EnvironmentAgentCommand,
  type EnvironmentAgentCommandAck,
  type EnvironmentAgentCommandEnvelope,
  type EnvironmentAgentEventEnvelope,
  type EnvironmentAgentProviderLaunchWrapper,
  type EnvironmentAgentProviderSpec,
  type EnvironmentAgentStatusSnapshot,
} from "@beanbag/environment-agent";
import {
  assertNever,
  createProviderEventEnvelope,
  extractTurnIdFromPersistedEventData,
  type AvailableModel,
  type PromptInput,
  type ProviderExecutionOptions,
  type ProviderThreadContext,
  type SpawnThreadRequest,
  type SystemProviderInfo,
  type Thread,
  type ThreadEvent,
  type ThreadEventData,
  type ThreadEventType,
} from "@beanbag/agent-core";
import type { ProviderAdapter } from "./provider-adapter.js";
import type { ProviderRuntimeNotification } from "./provider-runtime.js";

const MODEL_LIST_CACHE_TTL_MS = 60_000;

export type AgentServerSessionErrorCode =
  | "inactive_session"
  | "no_active_turn"
  | "unsupported_operation"
  | "provider_rpc_error"
  | "provider_timeout"
  | "provider_unavailable"
  | "missing_provider_thread";

export class AgentServerSessionError extends Error {
  constructor(
    readonly code: AgentServerSessionErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "AgentServerSessionError";
  }
}

export interface AgentServerNotification {
  method: string;
  normalizedMethod: string;
  eventType: ThreadEventType;
  eventData: ThreadEventData;
  shouldPersist: boolean;
  shouldBroadcast: boolean;
  nextStatus?: Thread["status"];
  title?: string;
  turnState?: "active" | "idle";
  turnId?: string;
}

export interface AgentServerOptions {
  provider: ProviderAdapter;
  providerCatalog?: SystemProviderInfo[];
  onNotification?: (threadId: string, event: AgentServerNotification) => void;
  onProviderStderrLine?: (threadId: string, line: string) => void;
  logger?: Pick<Console, "warn" | "error">;
}

function toProviderEventType(method: string): ThreadEventType {
  return method as ThreadEventType;
}

function toTurnLifecycleState(
  normalizedType: string,
): "active" | "idle" | undefined {
  if (normalizedType === "turn/started" || normalizedType === "turn/start") {
    return "active";
  }
  if (normalizedType === "turn/completed" || normalizedType === "turn/end") {
    return "idle";
  }
  return undefined;
}

function isMissingProviderThreadMessage(message: string): boolean {
  const normalized = message.toLowerCase();
  return (
    normalized.includes("no rollout found for thread id") ||
    normalized.includes("thread not found")
  );
}

export class AgentServer {
  private readonly authRefreshWarningThreadIds = new Set<string>();
  private readonly suppressedAuthStderrDepth = new Map<string, number>();
  private readonly rpcIdPrefix = randomUUID();
  private rpcIdCounter = 0;
  private readonly providerCatalog: SystemProviderInfo[];
  private cachedModels:
    | {
        expiresAt: number;
        value: AvailableModel[];
      }
    | undefined;
  private pendingModelsRequest: Promise<AvailableModel[]> | null = null;

  constructor(private readonly opts: AgentServerOptions) {
    this.providerCatalog =
      opts.providerCatalog ??
      [
        {
          id: opts.provider.id,
          displayName: opts.provider.displayName,
          capabilities: { ...opts.provider.capabilities },
        },
      ];
  }

  getProviderInfo(): SystemProviderInfo {
    return {
      id: this.opts.provider.id,
      displayName: this.opts.provider.displayName,
      capabilities: { ...this.opts.provider.capabilities },
    };
  }

  listProviders(): SystemProviderInfo[] {
    return this.providerCatalog.map((provider) => ({
      ...provider,
      capabilities: { ...provider.capabilities },
    }));
  }

  async listModels(): Promise<AvailableModel[]> {
    if (!this.opts.provider.capabilities.supportsModelList) {
      return [];
    }
    const now = Date.now();
    if (this.cachedModels && this.cachedModels.expiresAt > now) {
      return this.cachedModels.value;
    }
    if (this.pendingModelsRequest) {
      return this.pendingModelsRequest;
    }

    this.pendingModelsRequest = this.opts.provider.listModels()
      .then((models) => {
        this.cachedModels = {
          value: models,
          expiresAt: Date.now() + MODEL_LIST_CACHE_TTL_MS,
        };
        return models;
      })
      .finally(() => {
        this.pendingModelsRequest = null;
      });

    return this.pendingModelsRequest;
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
          if (this.opts.provider.capabilities.supportsMultimodalInput) {
            normalized.push(chunk);
          } else {
            normalized.push({
              type: "text",
              text: `Attached image URL: ${chunk.url}`,
            });
          }
          break;
        case "localImage":
          if (this.opts.provider.capabilities.supportsMultimodalInput) {
            normalized.push(chunk);
          } else {
            normalized.push({
              type: "text",
              text: `Attached local image: ${chunk.path}`,
            });
          }
          break;
        default:
          assertNever(chunk);
      }
    }
    return normalized;
  }

  deriveThreadTitle(input?: PromptInput[]): string | undefined {
    return this.opts.provider.deriveThreadTitle(input);
  }

  getInactiveSessionMessage(threadId: string): string {
    return this.opts.provider.inactiveSessionErrorMessage(threadId);
  }

  normalizeEventType(method: string): string {
    return this.opts.provider.normalizeEventType(method);
  }

  outputFromEvent(event: ThreadEvent): string | undefined {
    return this.opts.provider.outputFromEvent(event);
  }

  async startThreadCommand(args: {
    client: EnvironmentAgentClient;
    threadId: string;
    projectId: string;
    request: SpawnThreadRequest;
    context: ProviderThreadContext;
    providerLaunch?: EnvironmentAgentProviderLaunchWrapper;
  }): Promise<{ providerThreadId: string }> {
    await this.ensureProviderRunningForCommand(
      args.client,
      args.context,
      args.providerLaunch,
    );
    const ack = await this.sendEnvironmentAgentCommand(args.client, {
      type: "thread.start",
      threadId: args.threadId,
      projectId: args.projectId,
      params: this.opts.provider.createThreadStartParams(args.request, args.context),
      initialize: this.buildInitializeRequest(),
    });
    const providerThreadId = this.opts.provider.extractThreadIdFromResult(ack.result);
    if (!providerThreadId) {
      throw new AgentServerSessionError(
        "provider_rpc_error",
        `[thread ${args.threadId}] RPC response missing thread ID. Response: ${JSON.stringify(ack.result)}`,
      );
    }
    return { providerThreadId };
  }

  async resumeThreadCommand(args: {
    client: EnvironmentAgentClient;
    threadId: string;
    projectId: string;
    providerThreadId: string;
    context: ProviderThreadContext;
    options?: ProviderExecutionOptions;
    resumePath?: string;
    providerLaunch?: EnvironmentAgentProviderLaunchWrapper;
  }): Promise<{ providerThreadId: string }> {
    await this.ensureProviderRunningForCommand(
      args.client,
      args.context,
      args.providerLaunch,
    );
    const ack = await this.sendEnvironmentAgentCommand(args.client, {
      type: "thread.resume",
      threadId: args.threadId,
      projectId: args.projectId,
      providerThreadId: args.providerThreadId,
      params: this.opts.provider.createThreadResumeParams(
        args.providerThreadId,
        args.context,
        args.options,
        args.resumePath,
      ),
      initialize: this.buildInitializeRequest(),
    });
    const providerThreadId = this.opts.provider.extractThreadIdFromResult(ack.result);
    if (!providerThreadId) {
      throw new AgentServerSessionError(
        "provider_rpc_error",
        `[thread ${args.threadId}] RPC response missing thread ID. Response: ${JSON.stringify(ack.result)}`,
      );
    }
    return { providerThreadId };
  }

  async sendTurnCommand(args: {
    client: EnvironmentAgentClient;
    threadId: string;
    providerThreadId: string;
    activeTurnId?: string;
    input: PromptInput[];
    options?: ProviderExecutionOptions;
    mode?: "auto" | "steer" | "start";
    context: ProviderThreadContext;
    providerLaunch?: EnvironmentAgentProviderLaunchWrapper;
  }): Promise<{ mode: "steer" | "start"; providerThreadId: string }> {
    const hasExecutionOverrides = Boolean(
      args.options?.model ||
      args.options?.serviceTier ||
      args.options?.reasoningLevel ||
      args.options?.sandboxMode,
    );
    const requestedMode = args.mode ?? "auto";
    const activeTurnId = args.activeTurnId;
    const steerSupported = Boolean(
      this.opts.provider.turnSteerMethod && this.opts.provider.createTurnSteerParams,
    );
    const shouldUseSteer =
      requestedMode !== "start" &&
      steerSupported &&
      Boolean(activeTurnId) &&
      (requestedMode === "steer" || !hasExecutionOverrides);

    if (requestedMode === "steer") {
      if (!steerSupported) {
        throw new AgentServerSessionError(
          "unsupported_operation",
          `${this.opts.provider.displayName} does not support turn/steer`,
        );
      }
      if (!activeTurnId) {
        throw new AgentServerSessionError("no_active_turn", "No active turn");
      }
      if (hasExecutionOverrides) {
        throw new AgentServerSessionError(
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

    if (shouldUseSteer && activeTurnId) {
      await this.sendEnvironmentAgentCommand(args.client, {
        type: "turn.steer",
        threadId: args.threadId,
        providerThreadId: args.providerThreadId,
        turnId: activeTurnId,
        params: this.opts.provider.createTurnSteerParams!(
          args.providerThreadId,
          activeTurnId,
          args.input,
        ),
        initialize: this.buildInitializeRequest(),
      });
      return { mode: "steer", providerThreadId: args.providerThreadId };
    }

    await this.sendEnvironmentAgentCommand(args.client, {
      type: "turn.start",
      threadId: args.threadId,
      providerThreadId: args.providerThreadId,
      params: this.opts.provider.createTurnStartParams(
        args.providerThreadId,
        args.input,
        args.options,
      ),
      initialize: this.buildInitializeRequest(),
    });
    return { mode: "start", providerThreadId: args.providerThreadId };
  }

  async renameThreadCommand(args: {
    client: EnvironmentAgentClient;
    threadId: string;
    providerThreadId: string;
    title: string;
    context: ProviderThreadContext;
    providerLaunch?: EnvironmentAgentProviderLaunchWrapper;
  }): Promise<void> {
    if (!this.opts.provider.threadNameSetMethod) return;
    if (!this.opts.provider.createThreadNameSetParams) return;

    await this.ensureProviderRunningForCommand(
      args.client,
      args.context,
      args.providerLaunch,
    );
    await this.sendEnvironmentAgentCommand(args.client, {
      type: "thread.rename",
      threadId: args.threadId,
      providerThreadId: args.providerThreadId,
      title: args.title,
      params: this.opts.provider.createThreadNameSetParams(
        args.providerThreadId,
        args.title,
      ),
      initialize: this.buildInitializeRequest(),
    });
  }

  async ingestReplayedEnvironmentAgentEvents(args: {
    threadId: string;
    events: EnvironmentAgentEventEnvelope[];
  }): Promise<void> {
    for (const envelope of args.events) {
      this.handleEnvironmentAgentEvent(args.threadId, envelope.event);
    }
  }

  clearSessionState(threadId: string): void {
    this.authRefreshWarningThreadIds.delete(threadId);
    this.suppressedAuthStderrDepth.delete(threadId);
  }

  isMissingProviderThreadError(error: unknown): boolean {
    return (
      error instanceof AgentServerSessionError &&
      (
        error.code === "missing_provider_thread" ||
        (error.code === "provider_rpc_error" &&
          isMissingProviderThreadMessage(error.message))
      )
    );
  }

  private handleEnvironmentAgentEvent(
    threadId: string,
    event: EnvironmentAgentEventEnvelope["event"],
  ): void {
    switch (event.type) {
      case "provider.event":
        if (event.method === "provider.stdout") return;
        this.handleNotification(threadId, {
          method: event.method,
          params: event.payload,
        });
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

  private handleNotification(threadId: string, msg: ProviderRuntimeNotification): void {
    if (typeof msg.method !== "string") return;

    const normalizedMethod = this.opts.provider.normalizeEventType(msg.method);
    const turnState = toTurnLifecycleState(normalizedMethod);
    const turnId = extractTurnIdFromPersistedEventData(msg.params);

    this.opts.onNotification?.(threadId, {
      method: msg.method,
      normalizedMethod,
      eventType: toProviderEventType(msg.method),
      eventData: createProviderEventEnvelope({
        providerId: this.opts.provider.id,
        method: msg.method,
        payload: msg.params ?? {},
      }),
      shouldPersist: this.opts.provider.shouldPersistEvent?.(msg.method, msg.params) !== false,
      shouldBroadcast: this.opts.provider.shouldBroadcastForEvent(msg.method),
      nextStatus: this.opts.provider.statusForEvent(msg.method),
      title: this.opts.provider.titleFromEvent(msg.method, msg.params ?? {}),
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
            "If requests start failing, re-authenticate with `codex login` and restart Beanbag daemon.",
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

  private buildInitializeRequest() {
    return {
      method: this.opts.provider.initializeMethod,
      params:
        this.opts.provider.createInitializeParams?.(this.opts.provider.clientInfo) ?? {
          clientInfo: this.opts.provider.clientInfo,
        },
    };
  }

  private async ensureProviderRunningForCommand(
    client: EnvironmentAgentClient,
    context: ProviderThreadContext,
    providerLaunch?: EnvironmentAgentProviderLaunchWrapper,
  ): Promise<void> {
    const spec = await this.buildProviderSpec(context, providerLaunch);
    await client.ensureProviderRunning(spec);
  }

  private async buildProviderSpec(
    context: ProviderThreadContext,
    providerLaunch?: EnvironmentAgentProviderLaunchWrapper,
  ): Promise<EnvironmentAgentProviderSpec> {
    const launchConfig = await this.opts.provider.resolveLaunchConfiguration?.(context);
    return {
      command: this.opts.provider.processCommand,
      args: [...this.opts.provider.processArgs],
      ...(launchConfig?.env ? { env: { ...launchConfig.env } } : {}),
      ...(launchConfig?.files
        ? {
            files: launchConfig.files.map((file) => ({ ...file })),
          }
        : {}),
      ...(providerLaunch
        ? {
            launchCommand: providerLaunch.command,
            launchArgs: [...providerLaunch.args],
          }
        : {}),
    };
  }

  private async sendEnvironmentAgentCommand(
    client: EnvironmentAgentClient,
    command: EnvironmentAgentCommand,
  ): Promise<EnvironmentAgentCommandAck> {
    const commandToken = `cmd-${this.rpcIdPrefix}-${++this.rpcIdCounter}`;
    const envelope: EnvironmentAgentCommandEnvelope = {
      meta: {
        protocolVersion: ENVIRONMENT_AGENT_PROTOCOL_VERSION,
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

  private toCommandError(ack: EnvironmentAgentCommandAck): AgentServerSessionError {
    const message = ack.message ?? "Environment-agent command failed";
    switch (ack.errorCode) {
      case "missing_provider_thread":
        return new AgentServerSessionError("missing_provider_thread", message);
      case "provider_timeout":
        return new AgentServerSessionError("provider_timeout", message);
      case "provider_unavailable":
        return new AgentServerSessionError("provider_unavailable", message);
      case "unsupported_operation":
        return new AgentServerSessionError("unsupported_operation", message);
      case "provider_rpc_error":
      case undefined:
        if (isMissingProviderThreadMessage(message)) {
          return new AgentServerSessionError("missing_provider_thread", message);
        }
        return new AgentServerSessionError("provider_rpc_error", message);
      default:
        return new AgentServerSessionError("provider_rpc_error", message);
    }
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
