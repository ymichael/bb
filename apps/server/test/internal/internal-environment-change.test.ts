import { getEnvironment, hostDaemonSessions } from "@bb/db";
import { eq } from "drizzle-orm";
import { describe, expect, it, vi } from "vitest";
import { onDaemonSocketMessage } from "../../src/ws/daemon-protocol.js";
import {
  seedEnvironment,
  seedHostSession,
  seedProjectWithSource,
} from "../helpers/seed.js";
import { withTestHarness } from "../helpers/test-app.js";

interface TestDaemonSocket {
  close: (code?: number, reason?: string) => void;
  send: (data: string) => void;
}

function createTestDaemonSocket(): TestDaemonSocket {
  return {
    close: vi.fn(),
    send: vi.fn(),
  };
}

describe("internal environment change websocket hints", () => {
  it("renews an active session from a late heartbeat after lease expiry", async () => {
    await withTestHarness(async (harness) => {
      const { host, session } = seedHostSession(harness.deps, {
        id: "host-late-heartbeat",
      });
      const socket = createTestDaemonSocket();
      harness.db
        .update(hostDaemonSessions)
        .set({ leaseExpiresAt: Date.now() - 1000 })
        .where(eq(hostDaemonSessions.id, session.id))
        .run();

      onDaemonSocketMessage(harness.deps, {
        hostId: host.id,
        sessionId: session.id,
        socket,
        raw: JSON.stringify({ type: "heartbeat" }),
      });

      const updatedSession = harness.db
        .select()
        .from(hostDaemonSessions)
        .where(eq(hostDaemonSessions.id, session.id))
        .get();
      expect(updatedSession?.status).toBe("active");
      expect(updatedSession?.leaseExpiresAt).toBeGreaterThan(Date.now());
      expect(socket.send).toHaveBeenCalledWith(
        JSON.stringify({ type: "heartbeat-ack" }),
      );
      expect(socket.close).not.toHaveBeenCalled();
    });
  });

  it("does not resolve host RPC waiters from a different daemon session", async () => {
    await withTestHarness(async (harness) => {
      const hostA = seedHostSession(harness.deps, {
        id: "host-rpc-response-a",
      });
      const hostB = seedHostSession(harness.deps, {
        id: "host-rpc-response-b",
      });
      const wait = harness.hub.requestHostOnlineRpc({
        hostId: hostA.host.id,
        timeoutMs: 1_000,
        message: {
          type: "host-rpc.request",
          requestId: "rpc-protocol-session-scoped",
          command: {
            type: "host.list_files",
            path: "/tmp/session-scope-test",
            limit: 10,
          },
        },
      });
      let resolved = false;
      const observed = wait.then((response) => {
        resolved = true;
        return response;
      });
      const socket = createTestDaemonSocket();

      onDaemonSocketMessage(harness.deps, {
        hostId: hostB.host.id,
        sessionId: hostB.session.id,
        socket,
        raw: JSON.stringify({
          type: "host-rpc.response",
          requestId: "rpc-protocol-session-scoped",
          commandType: "host.list_files",
          ok: true,
          result: { files: [], truncated: false },
        }),
      });

      await Promise.resolve();
      expect(resolved).toBe(false);
      expect(socket.close).not.toHaveBeenCalled();

      onDaemonSocketMessage(harness.deps, {
        hostId: hostA.host.id,
        sessionId: hostA.session.id,
        socket,
        raw: JSON.stringify({
          type: "host-rpc.response",
          requestId: "rpc-protocol-session-scoped",
          commandType: "host.list_files",
          ok: true,
          result: { files: [], truncated: false },
        }),
      });

      await expect(observed).resolves.toEqual({
        type: "host-rpc.response",
        requestId: "rpc-protocol-session-scoped",
        commandType: "host.list_files",
        ok: true,
        result: { files: [], truncated: false },
      });
      expect(socket.close).not.toHaveBeenCalled();
    });
  });

  it.each([
    "work-status-changed",
    "thread-storage-changed",
    "git-refs-changed",
  ] as const)(
    "notifies clients for %s hints without mutating rows",
    async (change) => {
      await withTestHarness(async (harness) => {
        const { host, session } = seedHostSession(harness.deps, {
          id: `host-env-change-${change}`,
        });
        const { project } = seedProjectWithSource(harness.deps, {
          hostId: host.id,
        });
        const environment = seedEnvironment(harness.deps, {
          hostId: host.id,
          projectId: project.id,
          path: `/tmp/env-change-${change}`,
          status: "ready",
        });
        const before = getEnvironment(harness.db, environment.id);
        const notifyEnvironmentSpy = vi.spyOn(harness.hub, "notifyEnvironment");
        const socket = createTestDaemonSocket();

        onDaemonSocketMessage(harness.deps, {
          hostId: host.id,
          sessionId: session.id,
          socket,
          raw: JSON.stringify({
            type: "environment-change",
            environmentId: environment.id,
            change,
          }),
        });

        expect(notifyEnvironmentSpy).toHaveBeenCalledWith(environment.id, [
          change,
        ]);
        expect(getEnvironment(harness.db, environment.id)).toEqual(before);
        expect(socket.close).not.toHaveBeenCalled();
      });
    },
  );

  it("records workspace metadata when a watched workspace becomes a repository", async () => {
    await withTestHarness(async (harness) => {
      const { host, session } = seedHostSession(harness.deps, {
        id: "host-env-metadata-change",
      });
      const { project } = seedProjectWithSource(harness.deps, {
        hostId: host.id,
      });
      const environment = seedEnvironment(harness.deps, {
        hostId: host.id,
        projectId: project.id,
        path: "/tmp/env-metadata-change",
        status: "ready",
        isGitRepo: false,
      });
      const notifyEnvironmentSpy = vi.spyOn(harness.hub, "notifyEnvironment");
      const socket = createTestDaemonSocket();

      onDaemonSocketMessage(harness.deps, {
        hostId: host.id,
        sessionId: session.id,
        socket,
        raw: JSON.stringify({
          type: "environment-metadata-change",
          environmentId: environment.id,
          workspace: {
            path: environment.path,
            isGitRepo: true,
            isWorktree: true,
            branchName: "main",
            defaultBranch: "main",
          },
        }),
      });

      expect(socket.close).not.toHaveBeenCalled();
      expect(getEnvironment(harness.db, environment.id)).toMatchObject({
        isGitRepo: true,
        isWorktree: true,
        branchName: "main",
        defaultBranch: "main",
      });
      expect(notifyEnvironmentSpy).toHaveBeenCalledWith(environment.id, [
        "metadata-changed",
      ]);
    });
  });

  it("ignores hints for environments owned by a different host", async () => {
    await withTestHarness(async (harness) => {
      const hostA = seedHostSession(harness.deps, { id: "host-env-change-a" });
      const hostB = seedHostSession(harness.deps, { id: "host-env-change-b" });
      const { project } = seedProjectWithSource(harness.deps, {
        hostId: hostB.host.id,
      });
      const environment = seedEnvironment(harness.deps, {
        hostId: hostB.host.id,
        projectId: project.id,
        path: "/tmp/env-change-other-host",
        status: "ready",
      });
      const notifyEnvironmentSpy = vi.spyOn(harness.hub, "notifyEnvironment");
      const socket = createTestDaemonSocket();

      onDaemonSocketMessage(harness.deps, {
        hostId: hostA.host.id,
        sessionId: hostA.session.id,
        socket,
        raw: JSON.stringify({
          type: "environment-change",
          environmentId: environment.id,
          change: "work-status-changed",
        }),
      });

      expect(notifyEnvironmentSpy).not.toHaveBeenCalled();
      expect(socket.close).not.toHaveBeenCalled();
    });
  });

  it("ignores hints for unknown or destroyed environments", async () => {
    await withTestHarness(async (harness) => {
      const { host, session } = seedHostSession(harness.deps, {
        id: "host-env-change-ignored",
      });
      const { project } = seedProjectWithSource(harness.deps, {
        hostId: host.id,
      });
      const destroyedEnvironment = seedEnvironment(harness.deps, {
        hostId: host.id,
        projectId: project.id,
        path: "/tmp/env-change-destroyed",
        status: "destroyed",
      });
      const notifyEnvironmentSpy = vi.spyOn(harness.hub, "notifyEnvironment");
      const socket = createTestDaemonSocket();

      for (const environmentId of ["env-missing", destroyedEnvironment.id]) {
        onDaemonSocketMessage(harness.deps, {
          hostId: host.id,
          sessionId: session.id,
          socket,
          raw: JSON.stringify({
            type: "environment-change",
            environmentId,
            change: "work-status-changed",
          }),
        });
      }

      expect(notifyEnvironmentSpy).not.toHaveBeenCalled();
      expect(socket.close).not.toHaveBeenCalled();
    });
  });

  it("closes the daemon websocket for invalid environment change kinds", async () => {
    await withTestHarness(async (harness) => {
      const { host, session } = seedHostSession(harness.deps, {
        id: "host-env-change-invalid",
      });
      const notifyEnvironmentSpy = vi.spyOn(harness.hub, "notifyEnvironment");
      const socket = createTestDaemonSocket();

      onDaemonSocketMessage(harness.deps, {
        hostId: host.id,
        sessionId: session.id,
        socket,
        raw: JSON.stringify({
          type: "environment-change",
          environmentId: "env-1",
          change: "status-changed",
        }),
      });

      expect(socket.close).toHaveBeenCalledWith(1008, "invalid-message");
      expect(notifyEnvironmentSpy).not.toHaveBeenCalled();
    });
  });
});
