import { Buffer } from "node:buffer";
import {
  HOST_DAEMON_PROTOCOL_VERSION,
  buildHostDaemonWebSocketAuthorizationHeader,
  buildHostDaemonWebSocketProtocols,
  hostDaemonDaemonWsMessageSchema,
  hostDaemonRpcCommandTypeSchema,
  hostDaemonServerWsMessageSchema,
  type HostDaemonSessionCloseReason,
  type HostDaemonSessionOpenResponse,
  type HostDaemonDaemonWsMessage,
} from "@bb/host-daemon-contract";
import { z } from "zod";
import {
  DEFAULT_CONNECTION_TIMEOUT_MS,
  DEFAULT_MAX_RECONNECTION_DELAY,
  DEFAULT_MIN_RECONNECTION_DELAY,
  DEFAULT_RECONNECTION_DELAY_GROW_FACTOR,
  DEFAULT_STARTUP_TIMEOUT_MS,
  OPEN_READY_STATE,
  createDefaultReconnectingWebSocket,
  decodeWebSocketMessageData,
  type CreateReconnectingWebSocket,
  type ReconnectingWebSocketLike,
  type ServerConnectionOptions,
} from "./server-connection-support.js";
import { isLikelySystemSuspensionDelay } from "./system-suspension.js";
import { normalizeCaughtError, runtimeErrorLogFields } from "./error-utils.js";
import { ServerResponseError } from "./server-client.js";

export type {
  CreateReconnectingWebSocket,
  ServerConnectionOptions,
} from "./server-connection-support.js";

interface InvalidServerMessageArgs {
  data: unknown;
  error: Error;
}

const invalidHostRpcRequestEnvelopeSchema = z
  .object({
    type: z.literal("host-rpc.request"),
    requestId: z.string().min(1),
    command: z.object({ type: hostDaemonRpcCommandTypeSchema }).passthrough(),
  })
  .passthrough();

interface ServerMessagePayloadSummary {
  payloadLength: number;
  payloadPreview: string;
  payloadTruncated: boolean;
}

export type ServerSessionInvalidationSource =
  | "callTool"
  | "fetchProjectAttachment"
  | "fetchSkillTree"
  | "fetchPluginHostArtifact"
  | "interruptInteractiveRequests"
  | "postEvents"
  | "registerInteractiveRequest";

export interface HandleServerSessionInvalidatedArgs {
  code: "inactive_session";
  observedSessionId: string;
  source: ServerSessionInvalidationSource;
}

type SessionCloseHandler = (
  reason: HostDaemonSessionCloseReason,
) => void | Promise<void>;

const SERVER_MESSAGE_PAYLOAD_PREVIEW_CHARS = 512;
const TERMINAL_SOCKET_HIGH_WATER_BYTES = 1024 * 1024;
const TERMINAL_SOCKET_MAX_QUEUE_BYTES = 32 * 1024 * 1024;
const TERMINAL_SOCKET_DRAIN_POLL_MS = 10;

interface PendingTerminalSocketPayload {
  bytes: number;
  payload: string;
}

function recoverableMessageKey(
  message: HostDaemonDaemonWsMessage,
): string | null {
  switch (message.type) {
    case "connect-tunnel.identity":
      return "connect-tunnel.identity";
    case "environment-change":
      return `environment-change\u0000${message.environmentId}\u0000${message.change}`;
    case "environment-metadata-change":
      return `environment-metadata-change\u0000${message.environmentId}`;
    default:
      return null;
  }
}

function isTerminalDaemonOutputMessage(
  message: HostDaemonDaemonWsMessage,
): boolean {
  return message.type === "terminal.output";
}

function isTerminalDaemonLifecycleMessage(
  message: HostDaemonDaemonWsMessage,
): boolean {
  switch (message.type) {
    case "terminal.error":
    case "terminal.exited":
    case "terminal.opened":
    case "terminal.replay":
      return true;
    default:
      return false;
  }
}

function summarizeServerMessagePayload(
  data: unknown,
): ServerMessagePayloadSummary {
  const text = decodeWebSocketMessageData(data);
  return {
    payloadLength: text.length,
    payloadPreview: text.slice(0, SERVER_MESSAGE_PAYLOAD_PREVIEW_CHARS),
    payloadTruncated: text.length > SERVER_MESSAGE_PAYLOAD_PREVIEW_CHARS,
  };
}

export class ServerConnection {
  private readonly createWebSocket: CreateReconnectingWebSocket;
  private readonly startupTimeoutMs: number;

  private session: HostDaemonSessionOpenResponse | null = null;
  private websocket: ReconnectingWebSocketLike | null = null;
  private heartbeatInterval: ReturnType<typeof setInterval> | null = null;
  private lastHeartbeatAcknowledgedAt: number | null = null;
  private lastHeartbeatTickAt: number | null = null;
  private stopped = false;
  private sessionCloseHandler: SessionCloseHandler | undefined;
  private fatalConnectError: ServerResponseError | null = null;
  private protocolMismatchObserved = false;
  private sessionInvalidationInProgress = false;
  private pendingTerminalSocketBytes = 0;
  private readonly pendingTerminalSocketPayloads: PendingTerminalSocketPayload[] =
    [];
  private terminalSocketDrainTimeout: ReturnType<typeof setTimeout> | null =
    null;
  private readonly pendingRecoverableMessages = new Map<
    string,
    HostDaemonDaemonWsMessage
  >();

  constructor(private readonly options: ServerConnectionOptions) {
    this.createWebSocket =
      options.createWebSocket ?? createDefaultReconnectingWebSocket;
    this.startupTimeoutMs =
      options.startupTimeoutMs ?? DEFAULT_STARTUP_TIMEOUT_MS;
  }

  get sessionId(): string | null {
    return this.session?.sessionId ?? null;
  }

  async start(): Promise<HostDaemonSessionOpenResponse> {
    this.stopped = false;
    return this.connectWebSocket(null);
  }

  async shutdown(): Promise<void> {
    this.stopped = true;
    this.pendingRecoverableMessages.clear();
    this.sessionInvalidationInProgress = false;
    this.clearHeartbeat();
    this.clearSession();

    if (this.websocket) {
      const websocket = this.websocket;
      this.websocket = null;
      websocket.onmessage = null;
      websocket.onclose = null;
      websocket.close();
    }
  }

  sendMessage(message: HostDaemonDaemonWsMessage): boolean {
    const parsed = hostDaemonDaemonWsMessageSchema.parse(message);
    const recoverableKey = recoverableMessageKey(parsed);
    const websocket = this.websocket;
    if (!websocket || websocket.readyState !== OPEN_READY_STATE) {
      if (recoverableKey !== null) {
        this.pendingRecoverableMessages.set(recoverableKey, parsed);
      }
      return false;
    }

    const payload = JSON.stringify(parsed);
    if (
      isTerminalDaemonOutputMessage(parsed) &&
      (this.pendingTerminalSocketPayloads.length > 0 ||
        (websocket.bufferedAmount ?? 0) > TERMINAL_SOCKET_HIGH_WATER_BYTES)
    ) {
      return this.enqueueTerminalSocketPayload(payload);
    }
    if (
      isTerminalDaemonLifecycleMessage(parsed) &&
      this.pendingTerminalSocketPayloads.length > 0
    ) {
      this.flushTerminalSocketPayloads(true);
      if (
        this.pendingTerminalSocketPayloads.length > 0 ||
        websocket.readyState !== OPEN_READY_STATE
      ) {
        return false;
      }
    }
    try {
      websocket.send(payload);
    } catch (error) {
      this.options.logger.warn(
        { ...runtimeErrorLogFields(error), type: parsed.type },
        "Failed to send websocket message",
      );
      websocket.close(1013, "send-failed");
      return false;
    }
    if (recoverableKey !== null) {
      this.pendingRecoverableMessages.delete(recoverableKey);
    }
    return true;
  }

  private enqueueTerminalSocketPayload(payload: string): boolean {
    const bytes = Buffer.byteLength(payload, "utf8");
    if (
      this.pendingTerminalSocketBytes + bytes >
      TERMINAL_SOCKET_MAX_QUEUE_BYTES
    ) {
      this.options.logger.warn(
        {
          maxQueueBytes: TERMINAL_SOCKET_MAX_QUEUE_BYTES,
          pendingBytes: this.pendingTerminalSocketBytes,
        },
        "Terminal websocket output queue exceeded its limit",
      );
      this.clearTerminalSocketPayloads();
      this.websocket?.close(1013, "terminal-backpressure");
      return false;
    }
    this.pendingTerminalSocketPayloads.push({ bytes, payload });
    this.pendingTerminalSocketBytes += bytes;
    this.scheduleTerminalSocketDrain();
    return true;
  }

  private scheduleTerminalSocketDrain(): void {
    if (this.terminalSocketDrainTimeout !== null) {
      return;
    }
    this.terminalSocketDrainTimeout = setTimeout(() => {
      this.terminalSocketDrainTimeout = null;
      this.flushTerminalSocketPayloads(false);
    }, TERMINAL_SOCKET_DRAIN_POLL_MS);
  }

  private flushTerminalSocketPayloads(ignoreHighWater: boolean): void {
    const websocket = this.websocket;
    if (!websocket || websocket.readyState !== OPEN_READY_STATE) {
      this.clearTerminalSocketPayloads();
      return;
    }
    while (
      this.pendingTerminalSocketPayloads.length > 0 &&
      (ignoreHighWater ||
        (websocket.bufferedAmount ?? 0) <= TERMINAL_SOCKET_HIGH_WATER_BYTES)
    ) {
      const pending = this.pendingTerminalSocketPayloads[0];
      if (!pending) {
        break;
      }
      try {
        websocket.send(pending.payload);
      } catch (error) {
        this.options.logger.warn(
          { ...runtimeErrorLogFields(error) },
          "Failed to drain terminal websocket output",
        );
        websocket.close(1013, "send-failed");
        this.clearTerminalSocketPayloads();
        return;
      }
      this.pendingTerminalSocketPayloads.shift();
      this.pendingTerminalSocketBytes -= pending.bytes;
    }
    if (this.pendingTerminalSocketPayloads.length === 0) {
      this.clearTerminalSocketPayloads();
      return;
    }
    this.scheduleTerminalSocketDrain();
  }

  private clearTerminalSocketPayloads(): void {
    if (this.terminalSocketDrainTimeout !== null) {
      clearTimeout(this.terminalSocketDrainTimeout);
      this.terminalSocketDrainTimeout = null;
    }
    this.pendingTerminalSocketPayloads.length = 0;
    this.pendingTerminalSocketBytes = 0;
  }

  setSessionCloseHandler(handler: SessionCloseHandler | undefined): void {
    this.sessionCloseHandler = handler;
  }

  handleSessionInvalidated(args: HandleServerSessionInvalidatedArgs): void {
    if (this.stopped || this.sessionInvalidationInProgress) {
      return;
    }
    const session = this.session;
    if (!session || session.sessionId !== args.observedSessionId) {
      return;
    }

    this.sessionInvalidationInProgress = true;
    this.options.logger.info(
      {
        code: args.code,
        sessionId: args.observedSessionId,
        source: args.source,
      },
      "Server reported inactive daemon session; reconnecting",
    );
    this.clearHeartbeat();
    this.clearSession();
    this.websocket?.reconnect(1000, "inactive-session");
  }

  private async openSession(): Promise<HostDaemonSessionOpenResponse> {
    this.fatalConnectError = null;
    try {
      const session = await this.options.serverClient.openSession({
        hostId: this.options.hostId,
        instanceId: this.options.instanceId,
        hostName: this.options.hostName,
        hostType: this.options.hostType,
        connectMachineId: this.options.connectMachineId,
        dataDir: this.options.dataDir,
        localApiPort: this.options.localApiPort,
        activeThreads: this.options.getActiveThreads?.() ?? [],
        loadedEnvironments: this.options.getLoadedEnvironments?.() ?? [],
      });
      this.session = session;
      return session;
    } catch (error) {
      if (
        error instanceof ServerResponseError &&
        error.code === "protocol_version_mismatch"
      ) {
        this.protocolMismatchObserved = true;
        const result =
          await this.options.protocolSelfUpdater?.handleProtocolMismatch({
            force: error.protocolUpdateRetryRequested,
          });
        if (result === "updated") {
          await this.options.onSelfUpdateInstalled?.();
        }
      }
      if (
        error instanceof ServerResponseError &&
        !error.retryable &&
        error.code !== "protocol_version_mismatch"
      ) {
        this.fatalConnectError = error;
        this.logFatalConnectError(error);
      }
      throw error;
    }
  }

  private logFatalConnectError(error: ServerResponseError): void {
    const base = {
      hostId: this.options.hostId,
      serverUrl: this.options.serverUrl,
      status: error.status,
      code: error.code,
      detail: error.bodyMessage,
    };
    if (error.status === 401 || error.status === 403) {
      this.options.logger.error(
        base,
        "Server rejected host credentials — this host is not registered with the server.",
      );
      return;
    }
    this.options.logger.error(
      { ...base, daemonProtocolVersion: HOST_DAEMON_PROTOCOL_VERSION },
      "Server rejected the daemon session. This usually means the server is running an incompatible protocol version — restart it (e.g. `pnpm dev:restart`).",
    );
  }

  private async connectWebSocket(
    initialSessionId: string | null,
  ): Promise<HostDaemonSessionOpenResponse> {
    let nextSessionId: string | null = initialSessionId;
    const websocket = this.createWebSocket(
      async () => {
        if (!nextSessionId) {
          nextSessionId = (await this.openSession()).sessionId;
        }
        const sessionId = nextSessionId;
        nextSessionId = null;
        return this.buildWebSocketUrl(sessionId);
      },
      {
        minReconnectionDelay: DEFAULT_MIN_RECONNECTION_DELAY,
        maxReconnectionDelay: DEFAULT_MAX_RECONNECTION_DELAY,
        reconnectionDelayGrowFactor: DEFAULT_RECONNECTION_DELAY_GROW_FACTOR,
        connectionTimeout: DEFAULT_CONNECTION_TIMEOUT_MS,
        headers: {
          authorization: buildHostDaemonWebSocketAuthorizationHeader(
            this.options.hostKey,
          ),
          ...(this.options.machineCredential !== undefined
            ? {
                "x-bb-connect-machine": this.options.machineCredential,
              }
            : {}),
        },
        maxRetries: Number.POSITIVE_INFINITY,
        protocols: buildHostDaemonWebSocketProtocols(),
      },
    );
    this.websocket = websocket;

    return new Promise<HostDaemonSessionOpenResponse>((resolve, reject) => {
      let settled = false;
      let hasOpened = false;

      const startupTimer = setTimeout(() => {
        if (this.protocolMismatchObserved) {
          return;
        }
        fail(
          new Error(
            `Server connection timed out after ${this.startupTimeoutMs}ms`,
          ),
        );
      }, this.startupTimeoutMs);

      const fail = (error: unknown) => {
        if (settled) {
          return;
        }
        settled = true;
        clearTimeout(startupTimer);
        void this.shutdown();
        reject(normalizeCaughtError(error));
      };

      websocket.onopen = () => {
        this.protocolMismatchObserved = false;
        const session = this.session;
        if (!session) {
          fail(new Error("WebSocket opened before session was available"));
          return;
        }

        const handleOpen = async () => {
          hasOpened = true;
          this.sessionInvalidationInProgress = false;
          clearTimeout(startupTimer);
          this.resetHeartbeat();
          this.options.setSession?.(session);
          this.options.logger.info(
            { sessionId: session.sessionId },
            "Connected to server",
          );
          await this.options.onSessionOpened?.(session);
          this.flushPendingRecoverableMessages();
          if (!settled) {
            settled = true;
            resolve(session);
          }
        };

        void handleOpen().catch((error) => {
          if (!settled) {
            fail(error);
            return;
          }
          this.options.logger.error(
            { err: error, sessionId: session.sessionId },
            "Failed to finish websocket open handling",
          );
        });
      };

      websocket.onmessage = (event) => {
        this.handleWebSocketMessage(event.data);
      };

      websocket.onclose = (event) => {
        this.clearHeartbeat();
        this.clearSession();
        if (!hasOpened) {
          this.options.logger.warn(
            { code: event.code, reason: event.reason },
            "Waiting for server connection...",
          );
          return;
        }
        this.options.logger.info(
          { code: event.code, reason: event.reason },
          "Disconnected from server",
        );
        if (this.stopped) {
          return;
        }
      };

      websocket.onerror = (error) => {
        if (hasOpened) {
          this.options.logger.warn({ err: error }, "WebSocket error");
          return;
        }
        if (this.fatalConnectError) {
          fail(this.fatalConnectError);
          return;
        }
        this.options.logger.info(
          { serverUrl: this.options.serverUrl },
          "Waiting for server...",
        );
      };
    });
  }

  private flushPendingRecoverableMessages(): void {
    for (const message of Array.from(
      this.pendingRecoverableMessages.values(),
    )) {
      if (!this.sendMessage(message)) {
        return;
      }
    }
  }

  private handleWebSocketMessage(data: unknown): void {
    const text = decodeWebSocketMessageData(data);
    let decoded: unknown;
    try {
      decoded = JSON.parse(text);
    } catch (error) {
      this.handleInvalidServerMessage({
        data,
        error: normalizeCaughtError(error),
      });
      return;
    }

    const message = hostDaemonServerWsMessageSchema.safeParse(decoded);
    if (!message.success) {
      const invalidRpcRequest =
        invalidHostRpcRequestEnvelopeSchema.safeParse(decoded);
      if (invalidRpcRequest.success) {
        this.options.logger.warn(
          {
            commandType: invalidRpcRequest.data.command.type,
            err: message.error,
            requestId: invalidRpcRequest.data.requestId,
          },
          "Rejected invalid host RPC command",
        );
        this.sendMessage({
          type: "host-rpc.response",
          requestId: invalidRpcRequest.data.requestId,
          commandType: invalidRpcRequest.data.command.type,
          ok: false,
          errorCode: "invalid_command",
          errorMessage: "Invalid host RPC command",
        });
        return;
      }
      this.handleInvalidServerMessage({ data, error: message.error });
      return;
    }

    if (message.data.type === "session-close") {
      this.handleSessionCloseMessage(message.data.reason);
      return;
    }

    if (message.data.type === "heartbeat-ack") {
      if (this.session !== null) {
        this.lastHeartbeatAcknowledgedAt = Date.now();
      }
      return;
    }

    if (message.data.type === "host-rpc.request") {
      const rpcRequest = message.data;
      void Promise.resolve(this.options.onHostRpcRequest?.(rpcRequest)).catch(
        (error) => {
          this.options.logger.warn(
            {
              commandType: rpcRequest.command.type,
              ...runtimeErrorLogFields(error),
            },
            "Online host RPC handler failed",
          );
        },
      );
      return;
    }

    if (message.data.type === "watch-set.replace") {
      const watchSetMessage = message.data;
      void Promise.resolve(
        this.options.onWatchSetReplace?.(watchSetMessage),
      ).catch((error) => {
        this.options.logger.warn(
          {
            generation: watchSetMessage.generation,
            ...runtimeErrorLogFields(error),
          },
          "Watch set handler failed",
        );
      });
      return;
    }

    if (message.data.type === "connect-shares.replace") {
      const sharesMessage = message.data;
      void Promise.resolve(
        this.options.onConnectSharesReplace?.(sharesMessage),
      ).catch((error) => {
        this.options.logger.warn(
          {
            generation: sharesMessage.generation,
            ...runtimeErrorLogFields(error),
          },
          "Connect shares handler failed",
        );
      });
      return;
    }

    void Promise.resolve(this.options.onTerminalMessage?.(message.data)).catch(
      (error) => {
        this.options.logger.warn(
          {
            type: message.data.type,
            ...runtimeErrorLogFields(error),
          },
          "Terminal websocket message handler failed",
        );
      },
    );
  }

  private handleSessionCloseMessage(
    reason: HostDaemonSessionCloseReason,
  ): void {
    if (reason === "expired") {
      this.options.logger.info(
        { sessionId: this.session?.sessionId ?? null },
        "Server expired host daemon session; reconnecting",
      );
      this.clearHeartbeat();
      this.clearSession();
      this.websocket?.reconnect(1000, "expired");
      return;
    }

    void Promise.resolve(this.sessionCloseHandler?.(reason)).catch(
      () => undefined,
    );
    this.shutdownAfterServerMessage(
      "Failed to close server-requested websocket connection",
    );
  }

  private handleInvalidServerMessage(args: InvalidServerMessageArgs): void {
    this.options.logger.error(
      {
        err: args.error,
        ...summarizeServerMessagePayload(args.data),
      },
      "Invalid server websocket message; closing connection",
    );

    void Promise.resolve(this.sessionCloseHandler?.("daemon-disconnect")).catch(
      (error) => {
        this.options.logger.error(
          { err: error },
          "Failed to handle invalid server message shutdown",
        );
      },
    );
    this.shutdownAfterServerMessage(
      "Failed to close invalid server websocket connection",
    );
  }

  private shutdownAfterServerMessage(logMessage: string): void {
    void this.shutdown().catch((error) => {
      this.options.logger.error({ err: error }, logMessage);
    });
  }

  private resetHeartbeat(): void {
    this.clearHeartbeat();

    if (!this.session) {
      return;
    }

    const startedAt = Date.now();
    this.lastHeartbeatAcknowledgedAt = startedAt;
    this.lastHeartbeatTickAt = startedAt;
    this.heartbeatInterval = setInterval(() => {
      const session = this.session;
      if (!session) {
        return;
      }
      const now = Date.now();
      const lastTickAt = this.lastHeartbeatTickAt;
      if (lastTickAt !== null) {
        const gapMs = now - lastTickAt;
        const thresholdMs = session.leaseTimeoutMs / 2;
        if (gapMs > session.leaseTimeoutMs) {
          this.lastHeartbeatAcknowledgedAt = now;
        }
        const resumedAfterSuspension = isLikelySystemSuspensionDelay({
          gapMs,
          intervalMs: session.heartbeatIntervalMs,
        });
        if (resumedAfterSuspension) {
          this.options.logger.info(
            {
              gapMs,
              heartbeatIntervalMs: session.heartbeatIntervalMs,
              leaseTimeoutMs: session.leaseTimeoutMs,
              sessionId: session.sessionId,
              websocketReadyState: this.websocket?.readyState ?? null,
            },
            "Host daemon resumed after likely system suspension",
          );
        } else if (gapMs > thresholdMs) {
          this.options.logger.warn(
            {
              gapMs,
              heartbeatIntervalMs: session.heartbeatIntervalMs,
              leaseTimeoutMs: session.leaseTimeoutMs,
              sessionId: session.sessionId,
              websocketReadyState: this.websocket?.readyState ?? null,
            },
            "Host daemon heartbeat timer delayed",
          );
        }
      }
      this.lastHeartbeatTickAt = now;

      if (!this.websocket || this.websocket.readyState !== OPEN_READY_STATE) {
        return;
      }

      const lastAcknowledgedAt = this.lastHeartbeatAcknowledgedAt;
      if (
        lastAcknowledgedAt !== null &&
        now - lastAcknowledgedAt > session.leaseTimeoutMs
      ) {
        this.options.logger.warn(
          {
            lastAcknowledgedAt,
            leaseTimeoutMs: session.leaseTimeoutMs,
            sessionId: session.sessionId,
          },
          "Server heartbeat acknowledgements stopped; reconnecting",
        );
        this.clearHeartbeat();
        this.websocket.reconnect(1013, "heartbeat-ack-timeout");
        return;
      }

      this.sendMessage({ type: "heartbeat" });
    }, this.session.heartbeatIntervalMs);
  }

  private clearHeartbeat(): void {
    if (this.heartbeatInterval) {
      clearInterval(this.heartbeatInterval);
      this.heartbeatInterval = null;
    }
    this.lastHeartbeatAcknowledgedAt = null;
    this.lastHeartbeatTickAt = null;
  }

  private clearSession(): void {
    this.clearTerminalSocketPayloads();
    if (!this.session) {
      return;
    }

    this.session = null;
    this.options.setSession?.(null);
  }

  private buildWebSocketUrl(sessionId: string): string {
    const serverUrl = new URL(this.options.serverUrl);
    serverUrl.protocol = serverUrl.protocol === "https:" ? "wss:" : "ws:";
    serverUrl.pathname = "/internal/ws";
    serverUrl.searchParams.set("sessionId", sessionId);
    return serverUrl.toString();
  }
}
