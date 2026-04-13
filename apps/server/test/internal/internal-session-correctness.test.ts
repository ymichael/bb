import { setTimeout as sleep } from "node:timers/promises";
import { WebSocket } from "ws";
import { eq } from "drizzle-orm";
import {
  getHost,
  getThread,
  hostDaemonSessions,
  listEvents,
} from "@bb/db";
import { systemErrorEventDataSchema } from "@bb/domain";
import {
  HOST_DAEMON_PROTOCOL_VERSION,
  buildHostDaemonWebSocketAuthorizationHeader,
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

function createDaemonWebSocket(
  args: { hostKey: string; serverBaseUrl: string; sessionId: string },
): WebSocket {
  return new WebSocket(
    `${args.serverBaseUrl.replace("http", "ws")}/internal/ws?sessionId=${encodeURIComponent(args.sessionId)}`,
    buildHostDaemonWebSocketProtocols(),
    {
      headers: {
        authorization: buildHostDaemonWebSocketAuthorizationHeader(
          args.hostKey,
        ),
      },
    },
  );
}

describe("internal session correctness", () => {
  it("throws ApiError for daemon websocket upgrades missing a sessionId", async () => {
    const harness = await createTestAppHarness();
    try {
      await expect(
        validateDaemonWebSocket(harness.deps, {
          authorizationHeader: buildHostDaemonWebSocketAuthorizationHeader(
            createTestDaemonHostKey(),
          ),
          protocolHeader: buildHostDaemonWebSocketProtocols().join(", "),
          sessionId: null,
        }),
      ).rejects.toThrowError(ApiError);
      await expect(
        validateDaemonWebSocket(harness.deps, {
          authorizationHeader: buildHostDaemonWebSocketAuthorizationHeader(
            createTestDaemonHostKey(),
          ),
          protocolHeader: buildHostDaemonWebSocketProtocols().join(", "),
          sessionId: null,
        }),
      ).rejects.toThrowError("Unauthorized");
    } finally {
      await harness.cleanup();
    }
  });

  it("rejects daemon websocket upgrades missing the daemon protocol", async () => {
    const harness = await createTestAppHarness();
    try {
      await expect(
        validateDaemonWebSocket(harness.deps, {
          authorizationHeader: buildHostDaemonWebSocketAuthorizationHeader(
            createTestDaemonHostKey(),
          ),
          protocolHeader: undefined,
          sessionId: "session-1",
        }),
      ).rejects.toThrowError("Unsupported host daemon websocket protocol");
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

      const socket = createDaemonWebSocket({
        hostKey,
        serverBaseUrl: server.baseUrl,
        sessionId: session.sessionId,
      });
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
      expect(getHost(server.db, "host-heartbeat")?.lastActivityAt).toBeNull();
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

      const socket = createDaemonWebSocket({
        hostKey,
        serverBaseUrl: server.baseUrl,
        sessionId: session.sessionId,
      });
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

      const socket = createDaemonWebSocket({
        hostKey,
        serverBaseUrl: server.baseUrl,
        sessionId: session.sessionId,
      });
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

      const socket = createDaemonWebSocket({
        hostKey: otherHostKey,
        serverBaseUrl: server.baseUrl,
        sessionId: session.sessionId,
      });

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

      const socket = createDaemonWebSocket({
        hostKey,
        serverBaseUrl: server.baseUrl,
        sessionId: session.sessionId,
      });
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

  it("closes the daemon session immediately when the websocket disconnects", async () => {
    const harness = await createTestAppHarness();
    try {
      const { session } = seedHostSession(harness.deps, {
        id: "host-daemon-disconnect",
      });

      onDaemonSocketClose(harness.deps, session.id);

      const closedSession = harness.db
        .select()
        .from(hostDaemonSessions)
        .where(eq(hostDaemonSessions.id, session.id))
        .get();
      expect(closedSession?.status).toBe("closed");
      expect(closedSession?.closeReason).toBe("daemon-disconnect");
    } finally {
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

  it("interrupts pending interactions after the daemon-disconnect grace period", async () => {
    const harness = await createTestAppHarness();
    try {
      vi.useFakeTimers();
      const { host, session } = seedHostSession(harness.deps, {
        id: "host-daemon-pending-interaction-disconnect",
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
      });

      const registered = harness.deps.pendingInteractions.registerPendingInteraction({
        threadId: thread.id,
        turnId: "turn-disconnect-pending-interaction",
        providerId: "codex",
        providerThreadId: "provider-thread-disconnect-pending-interaction",
        providerRequestId: "request-disconnect-pending-interaction",
        payload: {
          kind: "command_approval",
          itemId: "item-disconnect-pending-interaction",
          reason: "Needs approval",
          command: "git push",
          cwd: "/tmp/project",
          commandActions: [],
          requestedPermissions: null,
          availableDecisions: ["accept", "accept_for_session", "decline", "cancel"],
        },
      });
      if (registered.outcome === "rejected") {
        throw new Error(`Expected interaction registration to succeed: ${registered.reason}`);
      }

      onDaemonSocketClose(harness.deps, session.id);
      await vi.advanceTimersByTimeAsync(DAEMON_DISCONNECT_GRACE_MS);

      const interrupted = harness.deps.pendingInteractions.getThreadInteraction({
        threadId: thread.id,
        interactionId: registered.interaction.id,
      });
      expect(interrupted).toMatchObject({
        status: "interrupted",
        statusReason:
          "Host daemon disconnected while awaiting user interaction; retry the thread to continue",
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
        headers: internalAuthHeaders(harness, { hostId: host.id, hostType: host.type }),
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
      expect(originalSession?.closeReason).toBe("daemon-disconnect");
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

  it("interrupts pending interactions when a replacement daemon session has a new instance id", async () => {
    const harness = await createTestAppHarness();
    try {
      const { host, session } = seedHostSession(harness.deps, {
        id: "host-daemon-session-restart-interaction",
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
      });

      const registered = harness.deps.pendingInteractions.registerPendingInteraction({
        threadId: thread.id,
        turnId: "turn-session-restart-interaction",
        providerId: "codex",
        providerThreadId: "provider-thread-session-restart-interaction",
        providerRequestId: "request-session-restart-interaction",
        payload: {
          kind: "command_approval",
          itemId: "item-session-restart-interaction",
          reason: "Needs approval",
          command: "git push",
          cwd: "/tmp/project",
          commandActions: [],
          requestedPermissions: null,
          availableDecisions: ["accept", "accept_for_session", "decline", "cancel"],
        },
      });
      if (registered.outcome === "rejected") {
        throw new Error(`Expected interaction registration to succeed: ${registered.reason}`);
      }

      const response = await harness.app.request("/internal/session/open", {
        method: "POST",
        headers: internalAuthHeaders(harness, { hostId: host.id, hostType: host.type }),
        body: JSON.stringify({
          hostId: host.id,
          instanceId: "instance-restarted",
          hostName: host.name,
          hostType: host.type,
          dataDir: "/tmp/host-daemon-session-restart-interaction",
          protocolVersion: HOST_DAEMON_PROTOCOL_VERSION,
          activeThreads: [],
        }),
      });

      expect(response.status).toBe(201);
      const interrupted = harness.deps.pendingInteractions.getThreadInteraction({
        threadId: thread.id,
        interactionId: registered.interaction.id,
      });
      expect(interrupted).toMatchObject({
        status: "interrupted",
        statusReason:
          "Host daemon restarted while awaiting user interaction; retry the thread to continue",
      });

      const originalSession = harness.db
        .select()
        .from(hostDaemonSessions)
        .where(eq(hostDaemonSessions.id, session.id))
        .get();
      expect(originalSession?.closeReason).toBe("replaced");
    } finally {
      await harness.cleanup();
    }
  });

  it("interrupts pending interactions for threads missing from a replacement daemon session", async () => {
    const harness = await createTestAppHarness();
    try {
      const { host, session } = seedHostSession(harness.deps, {
        id: "host-daemon-session-same-instance-missing-thread",
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
      });

      const registered = harness.deps.pendingInteractions.registerPendingInteraction({
        threadId: thread.id,
        turnId: "turn-session-same-instance-missing-thread",
        providerId: "codex",
        providerThreadId: "provider-thread-session-same-instance-missing-thread",
        providerRequestId: "request-session-same-instance-missing-thread",
        payload: {
          kind: "command_approval",
          itemId: "item-session-same-instance-missing-thread",
          reason: "Needs approval",
          command: "git push",
          cwd: "/tmp/project",
          commandActions: [],
          requestedPermissions: null,
          availableDecisions: ["accept", "accept_for_session", "decline", "cancel"],
        },
      });
      if (registered.outcome === "rejected") {
        throw new Error(`Expected interaction registration to succeed: ${registered.reason}`);
      }

      const response = await harness.app.request("/internal/session/open", {
        method: "POST",
        headers: internalAuthHeaders(harness, { hostId: host.id, hostType: host.type }),
        body: JSON.stringify({
          hostId: host.id,
          instanceId: "instance-1",
          hostName: host.name,
          hostType: host.type,
          dataDir: "/tmp/host-daemon-session-same-instance-missing-thread",
          protocolVersion: HOST_DAEMON_PROTOCOL_VERSION,
          activeThreads: [],
        }),
      });

      expect(response.status).toBe(201);
      const interrupted = harness.deps.pendingInteractions.getThreadInteraction({
        threadId: thread.id,
        interactionId: registered.interaction.id,
      });
      expect(interrupted).toMatchObject({
        status: "interrupted",
        statusReason:
          "Host daemon session was replaced while awaiting user interaction; retry the thread to continue",
      });

      const originalSession = harness.db
        .select()
        .from(hostDaemonSessions)
        .where(eq(hostDaemonSessions.id, session.id))
        .get();
      expect(originalSession?.closeReason).toBe("replaced");
    } finally {
      await harness.cleanup();
    }
  });
});
