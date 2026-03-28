import {
  HOST_DAEMON_PROTOCOL_VERSION,
  hostDaemonDaemonWsMessageSchema,
  hostDaemonServerWsMessageSchema,
  type HostDaemonSessionOpenResponse,
} from "@bb/host-daemon-contract";
import {
  DEFAULT_CONNECTION_TIMEOUT_MS,
  DEFAULT_MAX_RECONNECTION_DELAY,
  DEFAULT_MIN_RECONNECTION_DELAY,
  DEFAULT_POLL_AFTER_DISCONNECT_MS,
  DEFAULT_POLL_INTERVAL_MS,
  DEFAULT_RECONNECTION_DELAY_GROW_FACTOR,
  OPEN_READY_STATE,
  createDefaultReconnectingWebSocket,
  decodeWebSocketMessageData,
  type CreateReconnectingWebSocket,
  type IntervalHandle,
  type ReconnectingWebSocketLike,
  type ServerConnectionOptions,
  type TimeoutHandle,
} from "./server-connection-support.js";

export type {
  CreateReconnectingWebSocket,
  ServerConnectionOptions,
} from "./server-connection-support.js";

export class ServerConnection {
  private readonly createWebSocket: CreateReconnectingWebSocket;
  private readonly minReconnectionDelay: number;
  private readonly maxReconnectionDelay: number;
  private readonly reconnectionDelayGrowFactor: number;
  private readonly connectionTimeout: number;
  private readonly pollAfterDisconnectMs: number;
  private readonly pollIntervalMs: number;
  private readonly setTimeoutFn: typeof setTimeout;
  private readonly clearTimeoutFn: typeof clearTimeout;
  private readonly setIntervalFn: typeof setInterval;
  private readonly clearIntervalFn: typeof clearInterval;

  private session: HostDaemonSessionOpenResponse | null = null;
  private websocket: ReconnectingWebSocketLike | null = null;
  private pollingDelayTimer: TimeoutHandle | null = null;
  private pollingInterval: IntervalHandle | null = null;
  private heartbeatInterval: IntervalHandle | null = null;
  private stopped = false;
  private sessionCloseHandler: ServerConnectionOptions["onSessionClose"];

  constructor(private readonly options: ServerConnectionOptions) {
    this.sessionCloseHandler = options.onSessionClose;
    this.createWebSocket = options.createWebSocket ?? createDefaultReconnectingWebSocket;
    this.minReconnectionDelay =
      options.minReconnectionDelay ?? DEFAULT_MIN_RECONNECTION_DELAY;
    this.maxReconnectionDelay =
      options.maxReconnectionDelay ?? DEFAULT_MAX_RECONNECTION_DELAY;
    this.reconnectionDelayGrowFactor =
      options.reconnectionDelayGrowFactor ??
      DEFAULT_RECONNECTION_DELAY_GROW_FACTOR;
    this.connectionTimeout =
      options.connectionTimeout ?? DEFAULT_CONNECTION_TIMEOUT_MS;
    this.pollAfterDisconnectMs =
      options.pollAfterDisconnectMs ?? DEFAULT_POLL_AFTER_DISCONNECT_MS;
    this.pollIntervalMs = options.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
    this.setTimeoutFn = options.setTimeoutFn ?? setTimeout;
    this.clearTimeoutFn = options.clearTimeoutFn ?? clearTimeout;
    this.setIntervalFn = options.setIntervalFn ?? setInterval;
    this.clearIntervalFn = options.clearIntervalFn ?? clearInterval;
  }

  get sessionId(): string | null {
    return this.session?.sessionId ?? null;
  }

  async start(): Promise<HostDaemonSessionOpenResponse> {
    this.stopped = false;
    return this.openSessionAndConnect();
  }

  async shutdown(): Promise<void> {
    this.stopped = true;
    this.stopPollingFallback();
    this.clearHeartbeat();
    this.session = null;
    this.options.setSession?.(null);

    if (this.websocket) {
      this.websocket.close();
      this.websocket = null;
    }
  }

  setSessionCloseHandler(
    handler: ServerConnectionOptions["onSessionClose"],
  ): void {
    this.sessionCloseHandler = handler;
  }

  private async openSessionAndConnect(): Promise<HostDaemonSessionOpenResponse> {
    const session = await this.openSession();
    await this.connectWebSocket(session.sessionId);
    return session;
  }

  private async openSession(): Promise<HostDaemonSessionOpenResponse> {
    const session = await this.options.serverClient.openSession({
      hostId: this.options.hostId,
      instanceId: this.options.instanceId,
      hostName: this.options.hostName,
      hostType: this.options.hostType,
      protocolVersion:
        this.options.protocolVersion ?? HOST_DAEMON_PROTOCOL_VERSION,
      activeThreads: this.options.getActiveThreads?.() ?? [],
    });
    this.session = session;
    this.options.setSession?.(session);
    return session;
  }

  private async connectWebSocket(
    initialSessionId: string,
  ): Promise<void> {
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
        minReconnectionDelay: this.minReconnectionDelay,
        maxReconnectionDelay: this.maxReconnectionDelay,
        reconnectionDelayGrowFactor: this.reconnectionDelayGrowFactor,
        connectionTimeout: this.connectionTimeout,
        maxRetries: Number.POSITIVE_INFINITY,
      },
    );
    this.websocket = websocket;

    return new Promise((resolve, reject) => {
      let settled = false;
      let hasOpened = false;

      const fail = (error: unknown) => {
        if (settled) {
          return;
        }
        settled = true;
        void this.shutdown();
        reject(error instanceof Error ? error : new Error(String(error)));
      };

      websocket.onopen = () => {
        const session = this.session;
        if (!session) {
          fail(new Error("WebSocket opened before session was available"));
          return;
        }

        const handleOpen = async () => {
          hasOpened = true;
          this.stopPollingFallback();
          this.resetHeartbeat();
          await this.options.onSessionOpened?.(session);
          if (!settled) {
            settled = true;
            resolve();
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

      websocket.onclose = () => {
        this.clearHeartbeat();
        if (!hasOpened) {
          fail(new Error("WebSocket closed before opening"));
          return;
        }
        if (this.stopped) {
          return;
        }
        this.startPollingFallback();
      };

      websocket.onerror = (error) => {
        if (!hasOpened) {
          fail(error);
        }
      };
    });
  }

  private handleWebSocketMessage(data: unknown): void {
    const text = decodeWebSocketMessageData(data);
    const message = hostDaemonServerWsMessageSchema.parse(JSON.parse(text));

    if (message.type === "commands-available") {
      void Promise.resolve(this.options.onCommandsAvailable?.()).catch(
        () => undefined,
      );
      return;
    }

    void Promise.resolve(this.sessionCloseHandler?.(message.reason)).catch(
      () => undefined,
    );
    void this.shutdown();
  }

  private resetHeartbeat(): void {
    this.clearHeartbeat();

    if (!this.session) {
      return;
    }

    this.heartbeatInterval = this.setIntervalFn(() => {
      if (!this.websocket || this.websocket.readyState !== OPEN_READY_STATE) {
        return;
      }

      const payload = hostDaemonDaemonWsMessageSchema.parse({
        type: "heartbeat",
        ...(this.options.getHeartbeatPayload?.() ?? { bufferDepth: 0, lastCommandCursor: null }),
      });
      this.websocket.send(JSON.stringify(payload));
    }, this.session.heartbeatIntervalMs);
  }

  private clearHeartbeat(): void {
    if (!this.heartbeatInterval) {
      return;
    }
    this.clearIntervalFn(this.heartbeatInterval);
    this.heartbeatInterval = null;
  }

  private startPollingFallback(): void {
    if (this.pollingDelayTimer || this.pollingInterval || this.stopped) {
      return;
    }

    this.pollingDelayTimer = this.setTimeoutFn(() => {
      this.pollingDelayTimer = null;
      void Promise.resolve(this.options.onCommandsAvailable?.()).catch(
        () => undefined,
      );
      this.pollingInterval = this.setIntervalFn(() => {
        void Promise.resolve(this.options.onCommandsAvailable?.()).catch(
          () => undefined,
        );
      }, this.pollIntervalMs);
    }, this.pollAfterDisconnectMs);
  }

  private stopPollingFallback(): void {
    if (this.pollingDelayTimer) {
      this.clearTimeoutFn(this.pollingDelayTimer);
      this.pollingDelayTimer = null;
    }
    if (this.pollingInterval) {
      this.clearIntervalFn(this.pollingInterval);
      this.pollingInterval = null;
    }
  }

  private buildWebSocketUrl(sessionId: string): string {
    const serverUrl = new URL(this.options.serverUrl);
    serverUrl.protocol = serverUrl.protocol === "https:" ? "wss:" : "ws:";
    serverUrl.pathname = "/internal/ws";
    serverUrl.searchParams.set("sessionId", sessionId);
    serverUrl.searchParams.set("token", this.options.authToken);
    return serverUrl.toString();
  }
}
