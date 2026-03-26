import { setTimeout as sleep } from "node:timers/promises";
import { WebSocket } from "ws";
import { eq } from "drizzle-orm";
import {
  hostDaemonCursors,
  hostDaemonSessions,
  queueCommand,
} from "@bb/db";
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

describe("internal session correctness", () => {
  it("advances host cursors only across contiguous completed commands", async () => {
    const harness = await createTestAppHarness();
    try {
      const { host, session } = seedHostSession(harness.deps, {
        id: "host-cursor-ordering",
      });
      const { project } = seedProjectWithSource(harness.deps, { hostId: host.id });
      const environment = seedEnvironment(harness.deps, {
        hostId: host.id,
        projectId: project.id,
      });
      const thread = seedThread(harness.deps, {
        projectId: project.id,
        environmentId: environment.id,
      });

      const command1 = queueCommand(harness.db, harness.hub, {
        hostId: host.id,
        sessionId: session.id,
        type: "thread.stop",
        payload: JSON.stringify({
          type: "thread.stop",
          environmentId: environment.id,
          threadId: thread.id,
        }),
      });
      const command2 = queueCommand(harness.db, harness.hub, {
        hostId: host.id,
        sessionId: session.id,
        type: "thread.stop",
        payload: JSON.stringify({
          type: "thread.stop",
          environmentId: environment.id,
          threadId: thread.id,
        }),
      });
      const command3 = queueCommand(harness.db, harness.hub, {
        hostId: host.id,
        sessionId: session.id,
        type: "thread.stop",
        payload: JSON.stringify({
          type: "thread.stop",
          environmentId: environment.id,
          threadId: thread.id,
        }),
      });
      expect(command1.cursor).toBe(1);
      expect(command2.cursor).toBe(2);
      expect(command3.cursor).toBe(3);

      const outOfOrderResponse = await harness.app.request(
        "/internal/session/command-result",
        {
          method: "POST",
          headers: internalAuthHeaders(harness),
          body: JSON.stringify({
            sessionId: session.id,
            commandId: command3.id,
            cursor: command3.cursor,
            completedAt: Date.now(),
            type: "thread.stop",
            ok: true,
            result: {},
          }),
        },
      );
      expect(outOfOrderResponse.status).toBe(200);
      const initialCursor = harness.db
        .select()
        .from(hostDaemonCursors)
        .where(eq(hostDaemonCursors.hostId, host.id))
        .get();
      expect(initialCursor?.cursor ?? 0).toBe(0);

      const firstContiguousResponse = await harness.app.request(
        "/internal/session/command-result",
        {
          method: "POST",
          headers: internalAuthHeaders(harness),
          body: JSON.stringify({
            sessionId: session.id,
            commandId: command1.id,
            cursor: command1.cursor,
            completedAt: Date.now(),
            type: "thread.stop",
            ok: true,
            result: {},
          }),
        },
      );
      expect(firstContiguousResponse.status).toBe(200);
      const afterFirst = harness.db
        .select()
        .from(hostDaemonCursors)
        .where(eq(hostDaemonCursors.hostId, host.id))
        .get();
      expect(afterFirst?.cursor).toBe(1);

      const secondContiguousResponse = await harness.app.request(
        "/internal/session/command-result",
        {
          method: "POST",
          headers: internalAuthHeaders(harness),
          body: JSON.stringify({
            sessionId: session.id,
            commandId: command2.id,
            cursor: command2.cursor,
            completedAt: Date.now(),
            type: "thread.stop",
            ok: true,
            result: {},
          }),
        },
      );
      expect(secondContiguousResponse.status).toBe(200);
      const finalCursor = harness.db
        .select()
        .from(hostDaemonCursors)
        .where(eq(hostDaemonCursors.hostId, host.id))
        .get();
      expect(finalCursor?.cursor).toBe(3);
    } finally {
      await harness.cleanup();
    }
  });

  it("returns an empty command batch instead of timing out when the queue is empty", async () => {
    const harness = await createTestAppHarness();
    try {
      const { session } = seedHostSession(harness.deps, {
        id: "host-empty-queue",
      });

      const response = await harness.app.request(
        `/internal/session/commands?sessionId=${session.id}&afterCursor=0`,
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
          protocolVersion: HOST_DAEMON_PROTOCOL_VERSION,
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
          bufferDepth: 0,
        }),
      );
      await sleep(25);

      const updatedLease = server.db
        .select()
        .from(hostDaemonSessions)
        .where(eq(hostDaemonSessions.id, session.sessionId))
        .get()?.leaseExpiresAt;
      expect(updatedLease).toBeGreaterThan(initialLease ?? 0);
      socket.close();
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
          protocolVersion: HOST_DAEMON_PROTOCOL_VERSION,
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
});
