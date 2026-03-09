import {
  type EnvironmentAgentClient,
  ENVIRONMENT_AGENT_PROTOCOL_VERSION,
  type EnvironmentAgentAckResponse,
  type EnvironmentAgentEventEnvelope,
  type EnvironmentAgentReplayResponse,
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
import {
  ProviderRuntime,
  ProviderRuntimeRpcError,
  ProviderRuntimeTimeoutError,
  ProviderRuntimeUnavailableError,
  type ProviderRuntimeNotification,
} from "./provider-runtime.js";

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

export interface AgentServerSessionState {
  providerThreadId?: string;
  activeTurnId?: string;
  hasActiveRuntime: boolean;
}

export type AgentServerSessionConnection =
  {
    transport: "http";
    client: EnvironmentAgentClient;
    providerLaunch?: {
      command: string;
      args: string[];
    };
  };

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

export interface AgentServerSessionExit {
  code: number | null;
  signal: string | null;
}

export interface AgentServerOptions {
  provider: ProviderAdapter;
  providerCatalog?: SystemProviderInfo[];
  onNotification?: (threadId: string, event: AgentServerNotification) => void;
  onSessionExit?: (threadId: string, event: AgentServerSessionExit) => void;
  onProviderStderrLine?: (threadId: string, line: string) => void;
  logger?: Pick<Console, "warn" | "error">;
}

interface ManagedSession {
  agentClient: EnvironmentAgentClient;
  runtime: ProviderRuntime;
  providerThreadId?: string;
  activeTurnId?: string;
  lastAckedEnvironmentSequence?: number;
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

export class AgentServer {
  private readonly sessions = new Map<string, ManagedSession>();
  private readonly authRefreshWarningThreadIds = new Set<string>();
  private readonly suppressedAuthStderrDepth = new Map<string, number>();
  private rpcIdCounter = 0;
  private readonly providerCatalog: SystemProviderInfo[];

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
    return this.opts.provider.listModels();
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

  hydrateSessionState(
    threadId: string,
    state: {
      providerThreadId?: string;
      activeTurnId?: string;
    },
  ): void {
    const existing = this.sessions.get(threadId);
    if (!existing) return;
    if (state.providerThreadId) {
      existing.providerThreadId = state.providerThreadId;
    }
    if (state.activeTurnId !== undefined) {
      existing.activeTurnId = state.activeTurnId;
    }
  }

  getSessionState(threadId: string): AgentServerSessionState {
    const session = this.sessions.get(threadId);
    return {
      providerThreadId: session?.providerThreadId,
      activeTurnId: session?.activeTurnId,
      hasActiveRuntime: Boolean(session),
    };
  }

  isSessionActive(threadId: string): boolean {
    return this.sessions.has(threadId);
  }

  getActiveSessionCount(): number {
    return this.sessions.size;
  }

  listActiveSessionIds(): string[] {
    return Array.from(this.sessions.keys());
  }

  async getEnvironmentAgentStatus(
    threadId: string,
  ): Promise<EnvironmentAgentStatusSnapshot> {
    const session = this.requireSession(threadId);
    return session.agentClient.status();
  }

  async retryEnvironmentAgentDelivery(
    threadId: string,
  ): Promise<EnvironmentAgentStatusSnapshot> {
    const session = this.requireSession(threadId);
    return session.agentClient.retryDaemonDelivery();
  }

  async replayEnvironmentAgentEvents(args: {
    threadId: string;
    afterSequence: number;
    limit?: number;
  }): Promise<EnvironmentAgentReplayResponse> {
    const session = this.requireSession(args.threadId);
    return session.agentClient.replay({
      protocolVersion: ENVIRONMENT_AGENT_PROTOCOL_VERSION,
      afterSequence: args.afterSequence,
      limit: args.limit,
      threadId: args.threadId,
    });
  }

  async acknowledgeEnvironmentAgent(args: {
    threadId: string;
    sequence: number;
  }): Promise<EnvironmentAgentAckResponse> {
    const session = this.requireSession(args.threadId);
    return session.agentClient.acknowledge({
      protocolVersion: ENVIRONMENT_AGENT_PROTOCOL_VERSION,
      sequence: args.sequence,
      threadId: args.threadId,
    });
  }

  async ingestReplayedEnvironmentAgentEvents(args: {
    threadId: string;
    events: EnvironmentAgentEventEnvelope[];
  }): Promise<void> {
    const session = this.requireSession(args.threadId);
    let highestSequence = 0;

    for (const envelope of args.events) {
      highestSequence = Math.max(highestSequence, envelope.sequence);
      const event = envelope.event;
      if (event.type !== "provider.event") continue;
      if (event.method === "provider.stdout") continue;
      this.handleNotification(args.threadId, {
        method: event.method,
        params: event.payload,
      });
    }

    if (highestSequence > 0) {
      await this.acknowledgeEnvironmentSequence(args.threadId, session, highestSequence);
    }
  }

  async startSession(args: {
    threadId: string;
    connectSession: () =>
      | AgentServerSessionConnection
      | Promise<AgentServerSessionConnection>;
    request: SpawnThreadRequest;
    context: ProviderThreadContext;
  }): Promise<{ providerThreadId: string }> {
    const session = await this.createManagedSession(
      args.threadId,
      args.connectSession(),
    );
    const params = this.opts.provider.createThreadStartParams(args.request, args.context);
    try {
      const providerThreadId = await this.requestThreadId(
        session.runtime,
        args.threadId,
        this.opts.provider.threadStartMethod,
        params,
      );
      session.providerThreadId = providerThreadId;
      await this.acknowledgeLatestEnvironmentSequence(args.threadId, session);
      return { providerThreadId };
    } catch (error) {
      this.disposeSession(args.threadId);
      throw error;
    }
  }

  async resumeSession(args: {
    threadId: string;
    connectSession: () =>
      | AgentServerSessionConnection
      | Promise<AgentServerSessionConnection>;
    providerThreadId: string;
    context: ProviderThreadContext;
    options?: ProviderExecutionOptions;
  }): Promise<{ providerThreadId: string }> {
    const session = await this.createManagedSession(
      args.threadId,
      args.connectSession(),
      {
      providerThreadId: args.providerThreadId,
      },
    );
    try {
      const providerThreadId = await this.requestThreadId(
        session.runtime,
        args.threadId,
        this.opts.provider.threadResumeMethod,
        this.opts.provider.createThreadResumeParams(
          args.providerThreadId,
          args.context,
          args.options,
        ),
      );
      session.providerThreadId = providerThreadId;
      await this.acknowledgeLatestEnvironmentSequence(args.threadId, session);
      return { providerThreadId };
    } catch (error) {
      this.disposeSession(args.threadId);
      throw error;
    }
  }

  async sendTurn(args: {
    threadId: string;
    input: PromptInput[];
    options?: ProviderExecutionOptions;
    mode?: "auto" | "steer" | "start";
  }): Promise<{ mode: "steer" | "start"; providerThreadId: string }> {
    const session = this.sessions.get(args.threadId);
    if (!session) {
      throw new AgentServerSessionError(
        "inactive_session",
        this.opts.provider.inactiveSessionErrorMessage(args.threadId),
      );
    }
    const providerThreadId = session.providerThreadId;
    if (!providerThreadId) {
      throw new AgentServerSessionError(
        "inactive_session",
        this.opts.provider.inactiveSessionErrorMessage(args.threadId),
      );
    }

    const hasExecutionOverrides = Boolean(
      args.options?.model ||
      args.options?.serviceTier ||
      args.options?.reasoningLevel ||
      args.options?.sandboxMode,
    );
    const requestedMode = args.mode ?? "auto";
    const activeTurnId = session.activeTurnId;
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

    if (shouldUseSteer && activeTurnId) {
      this.send(session.runtime, args.threadId, {
        jsonrpc: "2.0",
        method: this.opts.provider.turnSteerMethod!,
        id: ++this.rpcIdCounter,
        params: this.opts.provider.createTurnSteerParams!(
          providerThreadId,
          activeTurnId,
          args.input,
        ),
      });
      return { mode: "steer", providerThreadId };
    }

    this.send(session.runtime, args.threadId, {
      jsonrpc: "2.0",
      method: this.opts.provider.turnStartMethod,
      id: ++this.rpcIdCounter,
      params: this.opts.provider.createTurnStartParams(
        providerThreadId,
        args.input,
        args.options,
      ),
    });
    return { mode: "start", providerThreadId };
  }

  renameSession(threadId: string, title: string): void {
    if (!this.opts.provider.threadNameSetMethod) return;
    if (!this.opts.provider.createThreadNameSetParams) return;

    const session = this.sessions.get(threadId);
    if (!session?.providerThreadId) return;

    try {
      this.send(session.runtime, threadId, {
        jsonrpc: "2.0",
        method: this.opts.provider.threadNameSetMethod,
        id: ++this.rpcIdCounter,
        params: this.opts.provider.createThreadNameSetParams(session.providerThreadId, title),
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : "Unknown error";
      this.opts.logger?.error(
        `[thread ${threadId}] Failed to send ${this.opts.provider.threadNameSetMethod}: ${message}`,
      );
    }
  }

  stopSession(threadId: string, reason?: string): void {
    const session = this.sessions.get(threadId);
    if (!session) return;

    session.runtime.close(
      reason ? new Error(reason) : undefined,
    );
    this.sessions.delete(threadId);
    this.clearSessionState(threadId);
  }

  stopAllSessions(reason?: string): void {
    for (const [threadId] of this.sessions) {
      this.stopSession(threadId, reason);
    }
  }

  clearSessionState(threadId: string): void {
    this.authRefreshWarningThreadIds.delete(threadId);
    this.suppressedAuthStderrDepth.delete(threadId);
    const session = this.sessions.get(threadId);
    if (session) {
      session.providerThreadId = undefined;
      session.activeTurnId = undefined;
    }
  }

  isMissingProviderThreadError(error: unknown): boolean {
    return (
      error instanceof AgentServerSessionError &&
      error.code === "missing_provider_thread"
    );
  }

  private createManagedSession(
    threadId: string,
    connection:
      | AgentServerSessionConnection
      | Promise<AgentServerSessionConnection>,
    seed?: { providerThreadId?: string; activeTurnId?: string },
  ): Promise<ManagedSession> {
    this.disposeSession(threadId);
    return Promise.resolve(connection).then(async (resolvedConnection) => {
      const agentClient = resolvedConnection.client;
      const runtime = new ProviderRuntime({
        threadId,
        transport: agentClient.providerTransport,
        onNotification: (msg) => {
          this.handleNotification(threadId, msg);
        },
        onUnmatchedRpcError: (requestId, errorMessage) => {
          this.opts.logger?.error(
            `[thread ${threadId}] Provider RPC error (request ${requestId}):`,
            errorMessage,
          );
        },
        onStderrLine: (line) => {
          this.handleProviderStderrLine(threadId, line);
        },
        onClosed: () => {
          const current = this.sessions.get(threadId);
          if (current?.runtime !== runtime) return;
          this.sessions.delete(threadId);
          this.clearSessionState(threadId);
          this.opts.onSessionExit?.(threadId, { code: null, signal: null });
        },
      });

      const session: ManagedSession = {
        agentClient,
        runtime,
        providerThreadId: seed?.providerThreadId,
        activeTurnId: seed?.activeTurnId,
      };
      this.sessions.set(threadId, session);

      await agentClient.ensureProviderRunning({
        command: this.opts.provider.processCommand,
        args: [...this.opts.provider.processArgs],
        ...(resolvedConnection.providerLaunch
          ? {
              launchCommand: resolvedConnection.providerLaunch.command,
              launchArgs: [...resolvedConnection.providerLaunch.args],
            }
          : {}),
      });

      this.send(runtime, threadId, {
        jsonrpc: "2.0",
        method: this.opts.provider.initializeMethod,
        id: ++this.rpcIdCounter,
        params:
          this.opts.provider.createInitializeParams?.(this.opts.provider.clientInfo) ?? {
            clientInfo: this.opts.provider.clientInfo,
          },
      });

      return session;
    });
  }

  private disposeSession(threadId: string): void {
    const existing = this.sessions.get(threadId);
    if (!existing) return;
    existing.agentClient.close();
    existing.runtime.close();
    this.sessions.delete(threadId);
    this.clearSessionState(threadId);
  }

  private requireSession(threadId: string): ManagedSession {
    const session = this.sessions.get(threadId);
    if (!session) {
      throw new AgentServerSessionError(
        "inactive_session",
        this.opts.provider.inactiveSessionErrorMessage(threadId),
      );
    }
    return session;
  }

  private send(runtime: ProviderRuntime, threadId: string, msg: object): void {
    try {
      runtime.send(msg);
    } catch (error) {
      if (error instanceof ProviderRuntimeUnavailableError) {
        throw new AgentServerSessionError("provider_unavailable", error.message);
      }
      throw error;
    }
  }

  private async requestThreadId(
    runtime: ProviderRuntime,
    threadId: string,
    method: string,
    params: Record<string, unknown>,
  ): Promise<string> {
    const requestId = ++this.rpcIdCounter;
    let result: unknown;
    try {
      result = await runtime.request({
        jsonrpc: "2.0",
        method,
        id: requestId,
        params,
      });
    } catch (error) {
      if (error instanceof ProviderRuntimeTimeoutError) {
        throw new AgentServerSessionError("provider_timeout", error.message);
      }
      if (error instanceof ProviderRuntimeRpcError) {
        const message = error.message;
        if (message.toLowerCase().includes("no rollout found for thread id")) {
          throw new AgentServerSessionError("missing_provider_thread", message);
        }
        throw new AgentServerSessionError("provider_rpc_error", message);
      }
      if (error instanceof ProviderRuntimeUnavailableError) {
        throw new AgentServerSessionError("provider_unavailable", error.message);
      }
      throw error;
    }

    const providerThreadId = this.opts.provider.extractThreadIdFromResult(result);
    if (!providerThreadId) {
      throw new AgentServerSessionError(
        "provider_rpc_error",
        `[thread ${threadId}] RPC response missing thread ID. Response: ${JSON.stringify(result)}`,
      );
    }
    return providerThreadId;
  }

  private handleNotification(threadId: string, msg: ProviderRuntimeNotification): void {
    if (typeof msg.method !== "string") return;

    const normalizedMethod = this.opts.provider.normalizeEventType(msg.method);
    const turnState = toTurnLifecycleState(normalizedMethod);
    const turnId = extractTurnIdFromPersistedEventData(msg.params);
    const session = this.sessions.get(threadId);
    if (session) {
      if (turnState === "active") {
        session.activeTurnId = turnId ?? session.activeTurnId;
      } else if (turnState === "idle") {
        session.activeTurnId = undefined;
      }
    }

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

    void this.acknowledgeLatestEnvironmentSequence(threadId, session).catch((error) => {
      this.opts.logger?.warn(
        `[thread ${threadId}] Failed to acknowledge environment-agent sequence: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    });
  }

  private async acknowledgeLatestEnvironmentSequence(
    threadId: string,
    session: ManagedSession | undefined,
  ): Promise<void> {
    if (!session) return;
    const latestObservedSequence = session.agentClient.getLatestObservedSequence();
    if (latestObservedSequence <= 0) return;
    await this.acknowledgeEnvironmentSequence(threadId, session, latestObservedSequence);
  }

  private async acknowledgeEnvironmentSequence(
    threadId: string,
    session: ManagedSession,
    sequence: number,
  ): Promise<void> {
    if ((session.lastAckedEnvironmentSequence ?? 0) >= sequence) return;
    const response = await session.agentClient.acknowledge({
      protocolVersion: ENVIRONMENT_AGENT_PROTOCOL_VERSION,
      sequence,
      threadId,
    });
    session.lastAckedEnvironmentSequence = response.acknowledgedSequence;
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
