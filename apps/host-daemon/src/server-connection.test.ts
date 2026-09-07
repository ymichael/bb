import { Buffer } from "node:buffer";
import type { HostDaemonSessionOpenResponse } from "@bb/host-daemon-contract";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { HostDaemonLogger } from "./logger.js";
import { ServerResponseError, type ServerClient } from "./server-client.js";
import type { ProtocolSelfUpdater } from "./protocol-self-update.js";
import { ServerConnection } from "./server-connection.js";
import type {
  CreateReconnectingWebSocket,
  ReconnectingWebSocketLike,
} from "./server-connection-support.js";

interface CreateServerClientFixtureArgs {
  heartbeatIntervalMs?: number;
  leaseTimeoutMs?: number;
  sessionIds?: string[];
  openSessionError?: Error;
}

interface CreateWebSocketFixtureArgs {
  autoReconnect?: boolean;
}

interface ConnectionFixtureArgs extends CreateServerClientFixtureArgs {
  autoReconnect?: boolean;
  connectMachineId?: string;
  machineCredential?: string;
  protocolSelfUpdater?: ProtocolSelfUpdater;
  onSelfUpdateInstalled?: () => void | Promise<void>;
  startupTimeoutMs?: number;
}

interface CreateSessionArgs {
  heartbeatIntervalMs: number;
  leaseTimeoutMs: number;
  sessionId: string;
}

function createLogger() {
  return {
    debug: vi.fn(),
    error: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
  } satisfies HostDaemonLogger;
}

function createSession(args: CreateSessionArgs): HostDaemonSessionOpenResponse {
  return {
    heartbeatIntervalMs: args.heartbeatIntervalMs,
    leaseTimeoutMs: args.leaseTimeoutMs,
    retiredEnvironmentIds: [],
    connectShares: { generation: 0, ports: [] },
    pluginHostGenerations: [],
    sessionId: args.sessionId,
    watchSet: {
      generation: 0,
      threadStorageTargets: [],
      workspaceTargets: [],
    },
  };
}

function createServerClientFixture(args: CreateServerClientFixtureArgs = {}) {
  const sessionIds = args.sessionIds ?? ["session-1"];
  let sessionIndex = 0;
  const openSession = vi.fn(async () => {
    if (args.openSessionError) {
      throw args.openSessionError;
    }
    const sessionId = sessionIds[sessionIndex] ?? sessionIds.at(-1);
    sessionIndex += 1;
    if (!sessionId) {
      throw new Error("Expected at least one test session ID");
    }
    return createSession({
      heartbeatIntervalMs: args.heartbeatIntervalMs ?? 5_000,
      leaseTimeoutMs: args.leaseTimeoutMs ?? 30_000,
      sessionId,
    });
  });
  const unused = async () => {
    throw new Error("Unexpected server client call");
  };
  const serverClient = {
    openSession,
    fetchProjectAttachment: unused,
    fetchSkillTree: unused,
    fetchPluginHostArtifact: unused,
    postEvents: unused,
    callTool: unused,
    registerInteractiveRequest: unused,
    interruptInteractiveRequests: unused,
  } satisfies ServerClient;

  return {
    openSession,
    serverClient,
  };
}

function createWebSocketFixture(args: CreateWebSocketFixtureArgs = {}) {
  const sockets: ReconnectingWebSocketLike[] = [];
  const bufferedAmounts = new Map<ReconnectingWebSocketLike, number>();
  const headers: Array<Record<string, string> | undefined> = [];
  const createWebSocket: CreateReconnectingWebSocket = (
    urlProvider,
    options,
  ) => {
    headers.push(options.headers);
    let readyState = 0;
    const socket: ReconnectingWebSocketLike = {
      get bufferedAmount() {
        return bufferedAmounts.get(socket) ?? 0;
      },
      get readyState() {
        return readyState;
      },
      onopen: null,
      onmessage: null,
      onclose: null,
      onerror: null,
      send: vi.fn(),
      close: vi.fn(() => {
        readyState = 3;
      }),
      reconnect: vi.fn(() => {
        if (args.autoReconnect === false) {
          return;
        }
        readyState = 3;
        socket.onclose?.({ code: 1000, reason: "test-reconnect" });
        void openSocket().catch((error) => socket.onerror?.(error));
      }),
    };

    async function openSocket(): Promise<void> {
      await urlProvider();
      queueMicrotask(() => {
        readyState = 1;
        socket.onopen?.({ type: "open" });
      });
    }

    bufferedAmounts.set(socket, 0);
    sockets.push(socket);
    void openSocket().catch((error) => socket.onerror?.(error));
    return socket;
  };

  return {
    createWebSocket,
    headers,
    setBufferedAmount(socket: ReconnectingWebSocketLike, bytes: number) {
      bufferedAmounts.set(socket, bytes);
    },
    sockets,
  };
}

function createConnectionFixture(args: ConnectionFixtureArgs = {}) {
  const logger = createLogger();
  const serverClient = createServerClientFixture(args);
  const webSocket = createWebSocketFixture({
    autoReconnect: args.autoReconnect,
  });
  const setSession = vi.fn();
  const connection = new ServerConnection({
    dataDir: "/tmp/bb-server-connection-test",
    hostId: "host-server-connection-test",
    hostKey: "host-key-server-connection-test",
    hostName: "Server Connection Test Host",
    hostType: "persistent",
    instanceId: "instance-server-connection-test",
    localApiPort: 38_887,
    logger,
    ...(args.machineCredential !== undefined
      ? { machineCredential: args.machineCredential }
      : {}),
    ...(args.connectMachineId !== undefined
      ? { connectMachineId: args.connectMachineId }
      : {}),
    serverClient: serverClient.serverClient,
    serverUrl: "http://127.0.0.1:3334",
    protocolSelfUpdater: args.protocolSelfUpdater,
    onSelfUpdateInstalled: args.onSelfUpdateInstalled,
    startupTimeoutMs: args.startupTimeoutMs,
    setSession,
    createWebSocket: webSocket.createWebSocket,
  });

  return {
    connection,
    logger,
    openSession: serverClient.openSession,
    setSession,
    webSocket,
  };
}

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("ServerConnection", () => {
  it("runs protocol self-update handling only for protocol mismatch rejection", async () => {
    const handleProtocolMismatch = vi.fn(async () => "updated" as const);
    const onSelfUpdateInstalled = vi.fn();
    const protocolError = new ServerResponseError({
      action: "open session",
      bodyMessage: "protocol mismatch",
      code: "protocol_version_mismatch",
      retryable: false,
      status: 400,
      statusText: "Bad Request",
    });
    const { connection } = createConnectionFixture({
      openSessionError: protocolError,
      protocolSelfUpdater: { handleProtocolMismatch },
      onSelfUpdateInstalled,
    });

    void connection.start();
    await vi.waitFor(() => {
      expect(handleProtocolMismatch).toHaveBeenCalledOnce();
      expect(handleProtocolMismatch).toHaveBeenCalledWith({ force: false });
      expect(onSelfUpdateInstalled).toHaveBeenCalledOnce();
    });
    await connection.shutdown();
  });

  it("forces a self-update attempt when the server accepted a user retry", async () => {
    const handleProtocolMismatch = vi.fn(async () => "failed" as const);
    const protocolError = new ServerResponseError({
      action: "open session",
      bodyMessage: "protocol mismatch",
      code: "protocol_version_mismatch",
      protocolUpdateRetryRequested: true,
      retryable: false,
      status: 400,
      statusText: "Bad Request",
    });
    const { connection } = createConnectionFixture({
      openSessionError: protocolError,
      protocolSelfUpdater: { handleProtocolMismatch },
    });

    void connection.start();
    await vi.waitFor(() => {
      expect(handleProtocolMismatch).toHaveBeenCalledWith({ force: true });
    });
    await connection.shutdown();
  });

  it("keeps retrying after a protocol update failure instead of timing out startup", async () => {
    vi.useFakeTimers();
    const handleProtocolMismatch = vi.fn(async () => "failed" as const);
    const protocolError = new ServerResponseError({
      action: "open session",
      bodyMessage: "protocol mismatch",
      code: "protocol_version_mismatch",
      retryable: false,
      status: 400,
      statusText: "Bad Request",
    });
    const { connection, webSocket } = createConnectionFixture({
      openSessionError: protocolError,
      protocolSelfUpdater: { handleProtocolMismatch },
      startupTimeoutMs: 100,
    });

    void connection.start();
    await vi.advanceTimersByTimeAsync(200);

    expect(handleProtocolMismatch).toHaveBeenCalledOnce();
    expect(webSocket.sockets[0]?.close).not.toHaveBeenCalled();
    await connection.shutdown();
  });

  it("adds the machine credential to WS dial headers only when configured", async () => {
    const configured = createConnectionFixture({
      machineCredential: "bbcm_machine",
    });
    const plain = createConnectionFixture();
    try {
      await configured.connection.start();
      await plain.connection.start();
      expect(configured.webSocket.headers[0]).toEqual({
        authorization: "Bearer host-key-server-connection-test",
        "x-bb-connect-machine": "bbcm_machine",
      });
      expect(plain.webSocket.headers[0]).toEqual({
        authorization: "Bearer host-key-server-connection-test",
      });
    } finally {
      await configured.connection.shutdown();
      await plain.connection.shutdown();
    }
  });

  it("reports the connect machine id when opening a session", async () => {
    const fixture = createConnectionFixture({
      connectMachineId: "machine-cloud-1",
    });
    try {
      await fixture.connection.start();
      expect(fixture.openSession).toHaveBeenCalledWith(
        expect.objectContaining({
          connectMachineId: "machine-cloud-1",
          localApiPort: 38_887,
        }),
      );
    } finally {
      await fixture.connection.shutdown();
    }
  });

  it("logs delayed heartbeat timer ticks without logging normal heartbeats", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    const { connection, logger, webSocket } = createConnectionFixture({
      heartbeatIntervalMs: 5_000,
      leaseTimeoutMs: 30_000,
    });
    try {
      await connection.start();
      const socket = webSocket.sockets[0];
      if (!socket) {
        throw new Error("Expected test socket");
      }

      await vi.advanceTimersByTimeAsync(5_000);
      expect(socket.send).toHaveBeenCalledWith(
        JSON.stringify({ type: "heartbeat" }),
      );
      expect(logger.warn).not.toHaveBeenCalled();

      vi.setSystemTime(25_000);
      await vi.advanceTimersByTimeAsync(5_000);

      expect(logger.warn).toHaveBeenCalledWith(
        expect.objectContaining({
          heartbeatIntervalMs: 5_000,
          leaseTimeoutMs: 30_000,
          sessionId: "session-1",
          websocketReadyState: 1,
        }),
        "Host daemon heartbeat timer delayed",
      );
    } finally {
      await connection.shutdown();
    }
  });

  it("reports a system-suspension gap without calling it a heartbeat stall", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    const { connection, logger, webSocket } = createConnectionFixture({
      heartbeatIntervalMs: 5_000,
      leaseTimeoutMs: 30_000,
    });
    try {
      await connection.start();
      await vi.advanceTimersByTimeAsync(5_000);

      vi.setSystemTime(300_000);
      await vi.advanceTimersByTimeAsync(5_000);

      expect(logger.warn).not.toHaveBeenCalledWith(
        expect.anything(),
        "Host daemon heartbeat timer delayed",
      );
      expect(logger.info).toHaveBeenCalledWith(
        expect.objectContaining({ gapMs: 300_000 }),
        "Host daemon resumed after likely system suspension",
      );
      expect(webSocket.sockets[0]?.reconnect).not.toHaveBeenCalled();
    } finally {
      await connection.shutdown();
    }
  });

  it("grants a fresh acknowledgement lease after a shorter heartbeat delay", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    const { connection, logger, webSocket } = createConnectionFixture({
      heartbeatIntervalMs: 5_000,
      leaseTimeoutMs: 30_000,
    });
    try {
      await connection.start();
      const socket = webSocket.sockets[0];
      if (!socket) {
        throw new Error("Expected test socket");
      }

      await vi.advanceTimersByTimeAsync(5_000);
      vi.setSystemTime(35_000);
      await vi.advanceTimersByTimeAsync(5_000);

      expect(logger.warn).toHaveBeenCalledWith(
        expect.objectContaining({ gapMs: 35_000 }),
        "Host daemon heartbeat timer delayed",
      );
      expect(socket.reconnect).not.toHaveBeenCalled();

      await vi.advanceTimersByTimeAsync(30_000);
      expect(socket.reconnect).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(5_000);
      expect(socket.reconnect).toHaveBeenCalledWith(
        1013,
        "heartbeat-ack-timeout",
      );
    } finally {
      await connection.shutdown();
    }
  });

  it("reconnects when server heartbeat acknowledgements stop", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    const { connection, logger, webSocket } = createConnectionFixture({
      heartbeatIntervalMs: 5_000,
      leaseTimeoutMs: 30_000,
    });
    try {
      await connection.start();
      const socket = webSocket.sockets[0];
      if (!socket) {
        throw new Error("Expected test socket");
      }

      await vi.advanceTimersByTimeAsync(25_000);
      socket.onmessage?.({ data: JSON.stringify({ type: "heartbeat-ack" }) });
      await vi.advanceTimersByTimeAsync(30_000);
      expect(socket.reconnect).not.toHaveBeenCalled();

      await vi.advanceTimersByTimeAsync(5_000);
      expect(socket.reconnect).toHaveBeenCalledWith(
        1013,
        "heartbeat-ack-timeout",
      );
      expect(logger.warn).toHaveBeenCalledWith(
        expect.objectContaining({
          lastAcknowledgedAt: 25_000,
          leaseTimeoutMs: 30_000,
          sessionId: "session-1",
        }),
        "Server heartbeat acknowledgements stopped; reconnecting",
      );
    } finally {
      await connection.shutdown();
    }
  });

  it("queues output above high water and flushes it before lifecycle messages", async () => {
    vi.useFakeTimers();
    const { connection, webSocket } = createConnectionFixture();
    try {
      await connection.start();
      const socket = webSocket.sockets[0];
      if (!socket) {
        throw new Error("Expected test socket");
      }
      webSocket.setBufferedAmount(socket, 2 * 1024 * 1024);
      const output = {
        type: "terminal.output" as const,
        terminalId: "term-1",
        chunk: {
          seq: 0,
          dataBase64: Buffer.from("hello").toString("base64"),
        },
      };
      const exited = {
        type: "terminal.exited" as const,
        terminalId: "term-1",
        exitCode: 0,
        closeReason: "user" as const,
      };

      expect(connection.sendMessage(output)).toBe(true);
      expect(socket.send).not.toHaveBeenCalled();

      expect(connection.sendMessage(exited)).toBe(true);
      expect(socket.send).toHaveBeenNthCalledWith(1, JSON.stringify(output));
      expect(socket.send).toHaveBeenNthCalledWith(2, JSON.stringify(exited));
    } finally {
      await connection.shutdown();
    }
  });

  it("closes the connection when a terminal websocket send throws", async () => {
    const { connection, webSocket } = createConnectionFixture();
    try {
      await connection.start();
      const socket = webSocket.sockets[0];
      if (!socket) {
        throw new Error("Expected test socket");
      }
      vi.mocked(socket.send).mockImplementation(() => {
        throw new Error("send failed");
      });

      expect(
        connection.sendMessage({
          type: "terminal.output",
          terminalId: "term-1",
          chunk: {
            seq: 0,
            dataBase64: Buffer.from("hello").toString("base64"),
          },
        }),
      ).toBe(false);
      expect(socket.close).toHaveBeenCalledWith(1013, "send-failed");
    } finally {
      await connection.shutdown();
    }
  });

  it("rejects a malformed host RPC command without disconnecting", async () => {
    const { connection, logger, setSession, webSocket } =
      createConnectionFixture();
    try {
      await connection.start();
      const socket = webSocket.sockets[0];
      if (!socket) {
        throw new Error("Expected test socket");
      }

      socket.onmessage?.({
        data: JSON.stringify({
          type: "host-rpc.request",
          requestId: "invalid-transcription",
          command: {
            type: "thread.stop",
            intent: "interrupt",
            environmentId: "",
            threadId: "",
          },
        }),
      });

      expect(socket.send).toHaveBeenCalledWith(
        JSON.stringify({
          type: "host-rpc.response",
          requestId: "invalid-transcription",
          commandType: "thread.stop",
          ok: false,
          errorCode: "invalid_command",
          errorMessage: "Invalid host RPC command",
        }),
      );
      expect(socket.close).not.toHaveBeenCalled();
      expect(setSession).not.toHaveBeenLastCalledWith(null);
      expect(logger.warn).toHaveBeenCalledWith(
        expect.objectContaining({
          commandType: "thread.stop",
          requestId: "invalid-transcription",
        }),
        "Rejected invalid host RPC command",
      );
    } finally {
      await connection.shutdown();
    }
  });

  it("deduplicates inactive-session invalidation and reconnects only the current session", async () => {
    const { connection, logger, setSession, webSocket } =
      createConnectionFixture({
        autoReconnect: false,
      });
    try {
      await connection.start();
      const socket = webSocket.sockets[0];
      if (!socket) {
        throw new Error("Expected test socket");
      }

      connection.handleSessionInvalidated({
        code: "inactive_session",
        observedSessionId: "stale-session",
        source: "postEvents",
      });
      expect(socket.reconnect).not.toHaveBeenCalled();

      connection.handleSessionInvalidated({
        code: "inactive_session",
        observedSessionId: "session-1",
        source: "postEvents",
      });
      connection.handleSessionInvalidated({
        code: "inactive_session",
        observedSessionId: "session-1",
        source: "postEvents",
      });

      expect(socket.reconnect).toHaveBeenCalledTimes(1);
      expect(socket.reconnect).toHaveBeenCalledWith(1000, "inactive-session");
      expect(setSession).toHaveBeenLastCalledWith(null);
      expect(logger.info).toHaveBeenCalledWith(
        {
          code: "inactive_session",
          sessionId: "session-1",
          source: "postEvents",
        },
        "Server reported inactive daemon session; reconnecting",
      );
    } finally {
      await connection.shutdown();
    }
  });
});
