import { afterEach, describe, expect, it, vi } from "vitest";
import {
  HOST_DAEMON_PROTOCOL_VERSION,
  hostDaemonCommandResultReportSchema,
  type HostDaemonActiveThread,
} from "@bb/host-daemon-contract";
import type { HostDaemonLogger } from "../../src/logger.js";
import { createServerClient } from "../../src/server-client.js";
import {
  ServerConnection,
  type ReconnectingWebSocketLike,
} from "../../src/server-connection.js";
import {
  createTestServer,
  type TestServer,
} from "../helpers/test-server.js";

async function waitFor(
  predicate: () => boolean,
  timeoutMs = 1_000,
): Promise<void> {
  const startedAt = Date.now();
  while (!predicate()) {
    if (Date.now() - startedAt > timeoutMs) {
      throw new Error("Timed out waiting for condition");
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

function createLogger(): HostDaemonLogger {
  return {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  };
}

function createConnection(
  testServer: TestServer,
  overrides: Partial<ConstructorParameters<typeof ServerConnection>[0]> = {},
) {
  const sessionState = { value: "" };
  const logger = createLogger();
  const serverClient = createServerClient({
    serverUrl: testServer.baseUrl,
    authToken: "secret",
    logger,
    getSessionId: () => sessionState.value,
  });

  const connection = new ServerConnection({
    serverUrl: testServer.baseUrl,
    authToken: "secret",
    hostId: "host-1",
    hostName: "Host One",
    hostType: "persistent",
    dataDir: "/tmp/daemon-data",
    instanceId: "instance-1",
    logger,
    serverClient,
    setSession: (session) => {
      sessionState.value = session?.sessionId ?? "";
    },
    ...overrides,
  });

  return { connection, logger, serverClient };
}

class FakeReconnectingWebSocket implements ReconnectingWebSocketLike {
  readyState = 0;
  onopen: ((event: any) => void) | null = null;
  onmessage: ((event: any) => void) | null = null;
  onclose: ((event: any) => void) | null = null;
  onerror: ((event: any) => void) | null = null;

  constructor(private readonly urlProvider: () => Promise<string>) {}

  async open(): Promise<void> {
    await this.urlProvider();
    this.readyState = 1;
    this.onopen?.({});
  }

  disconnect(): void {
    this.readyState = 3;
    this.onclose?.({});
  }

  close(): void {
    this.disconnect();
  }

  send(_data: string): void {}
}

describe("ServerConnection", () => {
  let testServer: TestServer | null = null;

  afterEach(async () => {
    vi.useRealTimers();
    await testServer?.close();
    testServer = null;
  });

  it("opens a session and returns the server config", async () => {
    testServer = await createTestServer();
    const { connection } = createConnection(testServer);

    const session = await connection.start();

    expect(session.sessionId).toBe("session-1");
    expect(session.threadHighWaterMarks).toEqual({ threadA: 4 });
    expect(testServer.sessionOpenCalls).toHaveLength(1);

    await connection.shutdown();
  });

  it("sends heartbeat messages over the websocket", async () => {
    testServer = await createTestServer();
    const { connection } = createConnection(testServer);

    await connection.start();
    await waitFor(() => testServer!.heartbeats.length > 0);

    expect(testServer.heartbeats[0]).toEqual({
      sessionId: "session-1",
      message: {
        type: "heartbeat",
      },
    });

    await connection.shutdown();
  });

  it("triggers the fetch callback when commands become available", async () => {
    testServer = await createTestServer();
    const onCommandsAvailable = vi.fn();
    const { connection } = createConnection(testServer, {
      onCommandsAvailable,
    });

    await connection.start();
    testServer.sendWebSocketMessage({ type: "commands-available" });
    await waitFor(() => onCommandsAvailable.mock.calls.length === 1);

    expect(onCommandsAvailable).toHaveBeenCalledTimes(1);
    await connection.shutdown();
  });

  it("triggers the shutdown callback when the server closes the session", async () => {
    testServer = await createTestServer();
    const onSessionClose = vi.fn();
    const { connection } = createConnection(testServer, {
      onSessionClose,
    });

    await connection.start();
    testServer.sendWebSocketMessage({
      type: "session-close",
      reason: "replaced",
    });
    await waitFor(() => onSessionClose.mock.calls.length === 1);
    await waitFor(() => testServer!.socketCount() === 0);

    expect(onSessionClose).toHaveBeenCalledWith("replaced");
  });

  it("reconnects after the websocket disconnects", async () => {
    testServer = await createTestServer();
    const { connection } = createConnection(testServer, {
      minReconnectionDelay: 20,
      maxReconnectionDelay: 20,
      pollAfterDisconnectMs: 40,
      pollIntervalMs: 40,
    });

    await connection.start();
    expect(testServer.sessionOpenCalls).toHaveLength(1);

    testServer.closeWebSockets();

    await waitFor(() => testServer!.sessionOpenCalls.length >= 2);
    expect(testServer.sessionOpenCalls).toHaveLength(2);

    await connection.shutdown();
  });

  it("retries command result delivery until the server accepts it", async () => {
    testServer = await createTestServer({ commandResultFailures: 1 });
    const { connection, serverClient } = createConnection(testServer);

    await connection.start();
    await serverClient.reportCommandResult({
      commandId: "cmd-1",
      completedAt: 1,
      type: "turn.run",
      ok: true,
      result: {},
    });

    expect(testServer.commandResultAttemptCount).toBe(2);
    expect(testServer.commandResultReports).toEqual([
      hostDaemonCommandResultReportSchema.parse({
        sessionId: "session-1",
        commandId: "cmd-1",
        completedAt: 1,
        type: "turn.run",
        ok: true,
        result: {},
      }),
      hostDaemonCommandResultReportSchema.parse({
        sessionId: "session-1",
        commandId: "cmd-1",
        completedAt: 1,
        type: "turn.run",
        ok: true,
        result: {},
      }),
    ]);

    await connection.shutdown();
  });

  it("stops retrying command results after the retry budget is exhausted", async () => {
    testServer = await createTestServer({
      commandResultFailures: 10,
      commandResultFailureStatus: 500,
    });
    const { connection, logger, serverClient } = createConnection(testServer);

    await connection.start();

    await expect(
      serverClient.reportCommandResult({
        commandId: "cmd-1",
        completedAt: 1,
        type: "turn.run",
        ok: true,
        result: {},
      }),
    ).rejects.toThrow(/Failed to report command result/u);

    expect(testServer.commandResultAttemptCount).toBe(6);
    expect(logger.warn).toHaveBeenCalledTimes(6);
    await connection.shutdown();
  });

  it("does not retry command results after a 4xx response", async () => {
    testServer = await createTestServer({
      commandResultFailures: 1,
      commandResultFailureStatus: 400,
    });
    const { connection, logger, serverClient } = createConnection(testServer);

    await connection.start();

    await expect(
      serverClient.reportCommandResult({
        commandId: "cmd-1",
        completedAt: 1,
        type: "turn.run",
        ok: true,
        result: {},
      }),
    ).rejects.toThrow(/Failed to report command result/u);

    expect(testServer.commandResultAttemptCount).toBe(1);
    expect(logger.warn).not.toHaveBeenCalled();
    await connection.shutdown();
  });

  it("posts tool calls through the session API", async () => {
    testServer = await createTestServer();
    const { connection, serverClient } = createConnection(testServer);

    await connection.start();
    const response = await serverClient.callTool({
      requestId: 1,
      threadId: "thread-1",
      turnId: "turn-1",
      callId: "call-1",
      tool: "message_user",
      arguments: { foo: "bar" },
    });

    expect(response).toEqual({
      success: true,
      contentItems: [{ type: "inputText", text: "ok" }],
    });
    expect(testServer.toolCalls).toEqual([
      {
        sessionId: "session-1",
        tool: "message_user",
      },
    ]);

    await connection.shutdown();
  });

  it("includes active threads when opening the session", async () => {
    testServer = await createTestServer();
    const activeThreads: HostDaemonActiveThread[] = [
      {
        threadId: "thread-1",
      },
    ];
    const { connection } = createConnection(testServer, {
      getActiveThreads: () => activeThreads,
      protocolVersion: HOST_DAEMON_PROTOCOL_VERSION,
    });

    await connection.start();

    expect(testServer.sessionOpenCalls[0]?.activeThreads).toEqual(activeThreads);

    await connection.shutdown();
  });

  it("polls for commands while the websocket stays down and stops after reconnect", async () => {
    vi.useFakeTimers();
    testServer = await createTestServer();
    const onCommandsAvailable = vi.fn();
    const sockets: FakeReconnectingWebSocket[] = [];
    const { connection } = createConnection(testServer, {
      onCommandsAvailable,
      pollAfterDisconnectMs: 5_000,
      pollIntervalMs: 10_000,
      createWebSocket: (urlProvider) => {
        const socket = new FakeReconnectingWebSocket(urlProvider);
        sockets.push(socket);
        queueMicrotask(() => {
          void socket.open();
        });
        return socket;
      },
    });

    await connection.start();
    const socket = sockets[0];
    if (!socket) {
      throw new Error("Expected fake websocket instance");
    }

    socket.disconnect();

    await vi.advanceTimersByTimeAsync(5_000);
    expect(onCommandsAvailable).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(10_000);
    expect(onCommandsAvailable).toHaveBeenCalledTimes(2);

    await socket.open();
    expect(testServer.sessionOpenCalls).toHaveLength(2);

    const callsAfterReconnect = onCommandsAvailable.mock.calls.length;
    await vi.advanceTimersByTimeAsync(20_000);
    expect(onCommandsAvailable).toHaveBeenCalledTimes(callsAfterReconnect);

    await connection.shutdown();
  });
});
