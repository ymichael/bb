import { setTimeout as sleep } from "node:timers/promises";
import { WebSocket } from "ws";
import { eq } from "drizzle-orm";
import {
  getThread,
  hostDaemonSessions,
  listEvents,
  queueCommand,
} from "@bb/db";
import { systemErrorEventDataSchema } from "@bb/domain";
import {
  HOST_DAEMON_PROTOCOL_VERSION,
  createHostDaemonClient,
} from "@bb/host-daemon-contract";
import { describe, expect, it } from "vitest";
import { internalAuthHeaders } from "./helpers/commands.js";
import {
  seedEnvironment,
  seedHostSession,
  seedProjectWithSource,
  seedThread,
} from "./helpers/seed.js";
import {
  createTestAppHarness,
  startTestServer,
} from "./helpers/test-app.js";

async function waitForOpen(socket: WebSocket): Promise<void> {
  return new Promise((resolve, reject) => {
    socket.once("open", () => resolve());
    socket.once("error", reject);
  });
}

async function waitForClose(socket: WebSocket): Promise<void> {
  return new Promise((resolve, reject) => {
    socket.once("close", () => resolve());
    socket.once("error", reject);
  });
}

async function waitForCloseDetails(
  socket: WebSocket,
): Promise<{ code: number; reason: string }> {
  return new Promise((resolve, reject) => {
    socket.once("close", (code, reason) => {
      resolve({
        code,
        reason: reason.toString("utf8"),
      });
    });
    socket.once("error", reject);
  });
}

async function waitForSessionStatus(
  args: {
    server: Awaited<ReturnType<typeof startTestServer>>;
    sessionId: string;
    status: string;
  },
): Promise<typeof hostDaemonSessions.$inferSelect> {
  const deadline = Date.now() + 1_000;

  while (Date.now() < deadline) {
    const session = args.server.db
      .select()
      .from(hostDaemonSessions)
      .where(eq(hostDaemonSessions.id, args.sessionId))
      .get();
    if (session?.status === args.status) {
      return session;
    }
    await sleep(10);
  }

  throw new Error(`Timed out waiting for session ${args.sessionId} to reach ${args.status}`);
}

async function waitForThreadStatus(
  args: {
    server: Awaited<ReturnType<typeof startTestServer>>;
    threadId: string;
    status: string;
  },
): Promise<NonNullable<ReturnType<typeof getThread>>> {
  const deadline = Date.now() + 1_000;

  while (Date.now() < deadline) {
    const thread = getThread(args.server.db, args.threadId);
    if (thread?.status === args.status) {
      return thread;
    }
    await sleep(10);
  }

  throw new Error(`Timed out waiting for thread ${args.threadId} to reach ${args.status}`);
}

describe("internal session correctness", () => {
  it("returns an empty command batch instead of timing out when the queue is empty", async () => {
    const harness = await createTestAppHarness();
    try {
      const { session } = seedHostSession(harness.deps, {
        id: "host-empty-queue",
      });

      const response = await harness.app.request(
        `/internal/session/commands?sessionId=${session.id}&limit=100&waitMs=0`,
        {
          headers: {
            authorization: `Bearer ${harness.config.authToken}`,
          },
        },
      );

      expect(response.status).toBe(200);
      await expect(response.json()).resolves.toEqual({
        commands: [],
      });
    } finally {
      await harness.cleanup();
    }
  });

  it("extends the session lease when the daemon websocket sends a heartbeat", async () => {
    const server = await startTestServer();
    try {
      const daemonClient = createHostDaemonClient(
        server.baseUrl,
        server.config.authToken,
      );
      const sessionResponse = await daemonClient.session.open.$post({
        json: {
          hostId: "host-heartbeat",
          instanceId: "instance-1",
          hostName: "Heartbeat Host",
          hostType: "persistent",
          dataDir: "/tmp/host-heartbeat-data",
          protocolVersion: HOST_DAEMON_PROTOCOL_VERSION,
          activeThreads: [],
        },
      });
      expect(sessionResponse.status).toBe(201);
      const session = await sessionResponse.json();
      const initialLease = server.db
        .select()
        .from(hostDaemonSessions)
        .where(eq(hostDaemonSessions.id, session.sessionId))
        .get()?.leaseExpiresAt;
      expect(initialLease).toBeTypeOf("number");

      const socket = new WebSocket(
        `${server.baseUrl.replace("http", "ws")}/internal/ws?sessionId=${encodeURIComponent(session.sessionId)}&token=${encodeURIComponent(server.config.authToken)}`,
      );
      await waitForOpen(socket);
      await sleep(10);
      socket.send(
        JSON.stringify({
          type: "heartbeat",
        }),
      );
      await sleep(25);

      const updatedLease = server.db
        .select()
        .from(hostDaemonSessions)
        .where(eq(hostDaemonSessions.id, session.sessionId))
        .get()?.leaseExpiresAt;
      expect(updatedLease).toBeGreaterThan(initialLease ?? 0);
      const closed = waitForClose(socket);
      socket.close();
      await closed;
    } finally {
      await server.close();
    }
  });

  it("closes the daemon websocket with 1008 on malformed messages", async () => {
    const server = await startTestServer();
    try {
      const daemonClient = createHostDaemonClient(
        server.baseUrl,
        server.config.authToken,
      );
      const sessionResponse = await daemonClient.session.open.$post({
        json: {
          hostId: "host-malformed-heartbeat",
          instanceId: "instance-1",
          hostName: "Malformed Heartbeat Host",
          hostType: "persistent",
          dataDir: "/tmp/host-malformed-heartbeat-data",
          protocolVersion: HOST_DAEMON_PROTOCOL_VERSION,
          activeThreads: [],
        },
      });
      expect(sessionResponse.status).toBe(201);
      const session = await sessionResponse.json();

      const socket = new WebSocket(
        `${server.baseUrl.replace("http", "ws")}/internal/ws?sessionId=${encodeURIComponent(session.sessionId)}&token=${encodeURIComponent(server.config.authToken)}`,
      );
      await waitForOpen(socket);

      const closed = waitForCloseDetails(socket);
      socket.send("{");

      await expect(closed).resolves.toEqual({
        code: 1008,
        reason: "invalid-message",
      });
    } finally {
      await server.close();
    }
  });

  it("closes the daemon websocket with 1008 on invalid heartbeat payloads", async () => {
    const server = await startTestServer();
    try {
      const daemonClient = createHostDaemonClient(
        server.baseUrl,
        server.config.authToken,
      );
      const sessionResponse = await daemonClient.session.open.$post({
        json: {
          hostId: "host-invalid-heartbeat",
          instanceId: "instance-1",
          hostName: "Invalid Heartbeat Host",
          hostType: "persistent",
          dataDir: "/tmp/host-invalid-heartbeat-data",
          protocolVersion: HOST_DAEMON_PROTOCOL_VERSION,
          activeThreads: [],
        },
      });
      expect(sessionResponse.status).toBe(201);
      const session = await sessionResponse.json();

      const socket = new WebSocket(
        `${server.baseUrl.replace("http", "ws")}/internal/ws?sessionId=${encodeURIComponent(session.sessionId)}&token=${encodeURIComponent(server.config.authToken)}`,
      );
      await waitForOpen(socket);

      const closed = waitForCloseDetails(socket);
      socket.send(
        JSON.stringify({
          type: "heartbeat",
          bufferDepth: 1,
        }),
      );

      await expect(closed).resolves.toEqual({
        code: 1008,
        reason: "invalid-message",
      });
    } finally {
      await server.close();
    }
  });

  it("closes the daemon session immediately when the websocket disconnects", async () => {
    const server = await startTestServer();
    try {
      const daemonClient = createHostDaemonClient(
        server.baseUrl,
        server.config.authToken,
      );
      const sessionResponse = await daemonClient.session.open.$post({
        json: {
          hostId: "host-daemon-disconnect",
          instanceId: "instance-1",
          hostName: "Disconnect Host",
          hostType: "persistent",
          dataDir: "/tmp/host-daemon-disconnect-data",
          protocolVersion: HOST_DAEMON_PROTOCOL_VERSION,
          activeThreads: [],
        },
      });
      expect(sessionResponse.status).toBe(201);
      const session = await sessionResponse.json();

      const socket = new WebSocket(
        `${server.baseUrl.replace("http", "ws")}/internal/ws?sessionId=${encodeURIComponent(session.sessionId)}&token=${encodeURIComponent(server.config.authToken)}`,
      );
      await waitForOpen(socket);
      socket.close();

      const closedSession = await waitForSessionStatus({
        server,
        sessionId: session.sessionId,
        status: "closed",
      });
      expect(closedSession.closeReason).toBe("daemon-disconnect");
    } finally {
      await server.close();
    }
  });

  it("marks active threads errored and appends a system error when the daemon disconnects", async () => {
    const server = await startTestServer();
    try {
      const daemonClient = createHostDaemonClient(
        server.baseUrl,
        server.config.authToken,
      );
      const sessionResponse = await daemonClient.session.open.$post({
        json: {
          hostId: "host-daemon-active-disconnect",
          instanceId: "instance-1",
          hostName: "Disconnect Host",
          hostType: "persistent",
          dataDir: "/tmp/host-daemon-active-disconnect-data",
          protocolVersion: HOST_DAEMON_PROTOCOL_VERSION,
          activeThreads: [],
        },
      });
      expect(sessionResponse.status).toBe(201);
      const session = await sessionResponse.json();

      const { project } = seedProjectWithSource(server, {
        hostId: "host-daemon-active-disconnect",
      });
      const environment = seedEnvironment(server, {
        hostId: "host-daemon-active-disconnect",
        projectId: project.id,
      });
      const thread = seedThread(server, {
        projectId: project.id,
        environmentId: environment.id,
        status: "active",
      });

      const socket = new WebSocket(
        `${server.baseUrl.replace("http", "ws")}/internal/ws?sessionId=${encodeURIComponent(session.sessionId)}&token=${encodeURIComponent(server.config.authToken)}`,
      );
      await waitForOpen(socket);
      socket.close();

      await waitForSessionStatus({
        server,
        sessionId: session.sessionId,
        status: "closed",
      });
      await waitForThreadStatus({
        server,
        threadId: thread.id,
        status: "error",
      });

      const errorEvent = listEvents(server.db, { threadId: thread.id }).find(
        (event) => event.type === "system/error",
      );
      expect(errorEvent).toBeDefined();
      expect(
        systemErrorEventDataSchema.parse(JSON.parse(errorEvent?.data ?? "{}")),
      ).toMatchObject({
        code: "host_daemon_disconnected",
        message: "Host daemon disconnected during active work",
      });
    } finally {
      await server.close();
    }
  });
});
