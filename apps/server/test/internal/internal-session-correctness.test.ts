import { setTimeout as sleep } from "node:timers/promises";
import { WebSocket } from "ws";
import { eq } from "drizzle-orm";
import {
  getThread,
  hostDaemonSessions,
  listEvents,
} from "@bb/db";
import { systemErrorEventDataSchema } from "@bb/domain";
import {
  HOST_DAEMON_PROTOCOL_VERSION,
  buildHostDaemonWebSocketProtocols,
  createHostDaemonClient,
} from "@bb/host-daemon-contract";
import { describe, expect, it, vi } from "vitest";
import { ApiError } from "../../src/errors.js";
import { DAEMON_DISCONNECT_GRACE_MS } from "../../src/constants.js";
import { onDaemonSocketClose, validateDaemonWebSocket } from "../../src/ws/daemon-protocol.js";
import { internalAuthHeaders } from "../helpers/commands.js";
import {
  seedEnvironment,
  seedHostSession,
  seedProjectWithSource,
  seedThread,
} from "../helpers/seed.js";
import {
  createTestDaemonHostKey,
  createTestAppHarness,
  startTestServer,
} from "../helpers/test-app.js";

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

async function waitForUpgradeRejectionStatus(socket: WebSocket): Promise<number> {
  return new Promise((resolve, reject) => {
    const cleanup = () => {
      socket.off("unexpected-response", onUnexpectedResponse);
      socket.off("open", onOpen);
      socket.off("error", onError);
    };

    const onUnexpectedResponse = (_request: unknown, response: { statusCode?: number }) => {
      cleanup();
      resolve(response.statusCode ?? 0);
    };

    const onOpen = () => {
      cleanup();
      reject(new Error("Expected websocket upgrade to be rejected"));
    };

    const onError = (error: Error) => {
      cleanup();
      reject(error);
    };

    socket.once("unexpected-response", onUnexpectedResponse);
    socket.once("open", onOpen);
    socket.once("error", onError);
  });
}

describe("internal session correctness", () => {
  it("throws ApiError for daemon websocket upgrades missing a sessionId", async () => {
    const harness = await createTestAppHarness();
    try {
      await expect(
        validateDaemonWebSocket(harness.deps, {
          protocolHeader: buildHostDaemonWebSocketProtocols(
            createTestDaemonHostKey(),
          ).join(", "),
          sessionId: null,
        }),
      ).rejects.toThrowError(ApiError);
      await expect(
        validateDaemonWebSocket(harness.deps, {
          protocolHeader: buildHostDaemonWebSocketProtocols(
            createTestDaemonHostKey(),
          ).join(", "),
          sessionId: null,
        }),
      ).rejects.toThrowError("Unauthorized");
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
        `/internal/session/commands?sessionId=${session.id}&limit=100&waitMs=0`,
        {
          headers: internalAuthHeaders(harness, { hostId: session.hostId }),
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
      const hostKey = createTestDaemonHostKey({ hostId: "host-heartbeat" });
      const daemonClient = createHostDaemonClient(
        server.baseUrl,
        hostKey,
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
        `${server.baseUrl.replace("http", "ws")}/internal/ws?sessionId=${encodeURIComponent(session.sessionId)}`,
        buildHostDaemonWebSocketProtocols(hostKey),
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
      const hostKey = createTestDaemonHostKey({ hostId: "host-malformed-heartbeat" });
      const daemonClient = createHostDaemonClient(
        server.baseUrl,
        hostKey,
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
        `${server.baseUrl.replace("http", "ws")}/internal/ws?sessionId=${encodeURIComponent(session.sessionId)}`,
        buildHostDaemonWebSocketProtocols(hostKey),
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
      const hostKey = createTestDaemonHostKey({ hostId: "host-invalid-heartbeat" });
      const daemonClient = createHostDaemonClient(
        server.baseUrl,
        hostKey,
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
        `${server.baseUrl.replace("http", "ws")}/internal/ws?sessionId=${encodeURIComponent(session.sessionId)}`,
        buildHostDaemonWebSocketProtocols(hostKey),
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

  it("rejects daemon websocket upgrades when the authenticated host does not own the session", async () => {
    const server = await startTestServer();
    try {
      const sessionHostKey = await server.deps.machineAuth.issueDaemonHostKey({
        hostId: "host-ws-owner",
        hostType: "persistent",
      });
      const otherHostKey = await server.deps.machineAuth.issueDaemonHostKey({
        hostId: "host-ws-other",
        hostType: "persistent",
      });
      const daemonClient = createHostDaemonClient(
        server.baseUrl,
        sessionHostKey,
      );
      const sessionResponse = await daemonClient.session.open.$post({
        json: {
          hostId: "host-ws-owner",
          instanceId: "instance-1",
          hostName: "WebSocket Owner",
          hostType: "persistent",
          dataDir: "/tmp/host-ws-owner",
          protocolVersion: HOST_DAEMON_PROTOCOL_VERSION,
          activeThreads: [],
        },
      });
      expect(sessionResponse.status).toBe(201);
      const session = await sessionResponse.json();

      const socket = new WebSocket(
        `${server.baseUrl.replace("http", "ws")}/internal/ws?sessionId=${encodeURIComponent(session.sessionId)}`,
        buildHostDaemonWebSocketProtocols(otherHostKey),
      );

      await expect(waitForUpgradeRejectionStatus(socket)).resolves.toBe(403);
    } finally {
      await server.close();
    }
  });

  it("closes the daemon websocket with 1008 when the session is no longer active", async () => {
    const server = await startTestServer();
    try {
      const hostKey = createTestDaemonHostKey({ hostId: "host-inactive-session" });
      const daemonClient = createHostDaemonClient(
        server.baseUrl,
        hostKey,
      );
      const sessionResponse = await daemonClient.session.open.$post({
        json: {
          hostId: "host-inactive-session",
          instanceId: "instance-1",
          hostName: "Inactive Session Host",
          hostType: "persistent",
          dataDir: "/tmp/host-inactive-session-data",
          protocolVersion: HOST_DAEMON_PROTOCOL_VERSION,
          activeThreads: [],
        },
      });
      expect(sessionResponse.status).toBe(201);
      const session = await sessionResponse.json();

      const socket = new WebSocket(
        `${server.baseUrl.replace("http", "ws")}/internal/ws?sessionId=${encodeURIComponent(session.sessionId)}`,
        buildHostDaemonWebSocketProtocols(hostKey),
      );
      await waitForOpen(socket);

      // Close the session in the DB so the next heartbeat finds it inactive.
      server.db
        .update(hostDaemonSessions)
        .set({ status: "closed", closedAt: Date.now(), closeReason: "replaced" })
        .where(eq(hostDaemonSessions.id, session.sessionId))
        .run();

      const closed = waitForCloseDetails(socket);
      socket.send(JSON.stringify({ type: "heartbeat" }));

      await expect(closed).resolves.toEqual({
        code: 1008,
        reason: "inactive-session",
      });
    } finally {
      await server.close();
    }
  });

  it("keeps the daemon session active during the disconnect grace period", async () => {
    const harness = await createTestAppHarness();
    try {
      vi.useFakeTimers();
      const { session } = seedHostSession(harness.deps, {
        id: "host-daemon-disconnect",
      });

      onDaemonSocketClose(harness.deps, session.id);
      await vi.advanceTimersByTimeAsync(DAEMON_DISCONNECT_GRACE_MS - 1);

      const activeSession = harness.db
        .select()
        .from(hostDaemonSessions)
        .where(eq(hostDaemonSessions.id, session.id))
        .get();
      expect(activeSession?.status).toBe("active");
    } finally {
      vi.useRealTimers();
      await harness.cleanup();
    }
  });

  it("closes the daemon session after the disconnect grace period expires", async () => {
    const harness = await createTestAppHarness();
    try {
      vi.useFakeTimers();
      const { session } = seedHostSession(harness.deps, {
        id: "host-daemon-disconnect-expired",
      });

      onDaemonSocketClose(harness.deps, session.id);
      await vi.advanceTimersByTimeAsync(DAEMON_DISCONNECT_GRACE_MS);

      const closedSession = harness.db
        .select()
        .from(hostDaemonSessions)
        .where(eq(hostDaemonSessions.id, session.id))
        .get();
      expect(closedSession?.status).toBe("closed");
      expect(closedSession?.closeReason).toBe("daemon-disconnect");
    } finally {
      vi.useRealTimers();
      await harness.cleanup();
    }
  });

  it("marks active threads errored and appends a system error after the grace period expires", async () => {
    const harness = await createTestAppHarness();
    try {
      vi.useFakeTimers();
      const { host, session } = seedHostSession(harness.deps, {
        id: "host-daemon-active-disconnect",
      });
      const { project } = seedProjectWithSource(harness.deps, {
        hostId: host.id,
      });
      const environment = seedEnvironment(harness.deps, {
        hostId: host.id,
        projectId: project.id,
      });
      const thread = seedThread(harness.deps, {
        projectId: project.id,
        environmentId: environment.id,
        status: "active",
      });

      onDaemonSocketClose(harness.deps, session.id);
      await vi.advanceTimersByTimeAsync(DAEMON_DISCONNECT_GRACE_MS);

      const closedSession = harness.db
        .select()
        .from(hostDaemonSessions)
        .where(eq(hostDaemonSessions.id, session.id))
        .get();
      expect(closedSession?.closeReason).toBe("daemon-disconnect");
      expect(getThread(harness.db, thread.id)?.status).toBe("error");

      const errorEvent = listEvents(harness.db, { threadId: thread.id }).find(
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
      vi.useRealTimers();
      await harness.cleanup();
    }
  });

  it("cancels daemon-disconnect fallout if a replacement session opens during the grace period", async () => {
    const harness = await createTestAppHarness();
    try {
      vi.useFakeTimers();
      const { host, session } = seedHostSession(harness.deps, {
        id: "host-daemon-reconnect",
      });
      const { project } = seedProjectWithSource(harness.deps, {
        hostId: host.id,
      });
      const environment = seedEnvironment(harness.deps, {
        hostId: host.id,
        projectId: project.id,
      });
      const thread = seedThread(harness.deps, {
        projectId: project.id,
        environmentId: environment.id,
        status: "active",
      });

      onDaemonSocketClose(harness.deps, session.id);

      const response = await harness.app.request("/internal/session/open", {
        method: "POST",
        headers: internalAuthHeaders(harness),
        body: JSON.stringify({
          hostId: host.id,
          instanceId: "instance-2",
          hostName: host.name,
          hostType: host.type,
          dataDir: "/tmp/host-daemon-reconnect-data",
          protocolVersion: HOST_DAEMON_PROTOCOL_VERSION,
          activeThreads: [{ threadId: thread.id }],
        }),
      });
      expect(response.status).toBe(201);
      await vi.advanceTimersByTimeAsync(DAEMON_DISCONNECT_GRACE_MS);

      const originalSession = harness.db
        .select()
        .from(hostDaemonSessions)
        .where(eq(hostDaemonSessions.id, session.id))
        .get();
      expect(originalSession?.closeReason).toBe("replaced");
      expect(getThread(harness.db, thread.id)?.status).toBe("active");
      expect(
        listEvents(harness.db, { threadId: thread.id }).some(
          (event) => event.type === "system/error",
        ),
      ).toBe(false);
    } finally {
      vi.useRealTimers();
      await harness.cleanup();
    }
  });
});
