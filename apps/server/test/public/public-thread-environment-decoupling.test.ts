import { archiveThread, getEnvironment, getThread } from "@bb/db";
import {
  applyEnvironmentLifecycleEvent,
  requireEnvironmentLifecycleEventApplied,
} from "@bb/db/internal-environment-lifecycle";
import type { EnvironmentStatus } from "@bb/domain";
import { describe, expect, it } from "vitest";
import { listQueuedThreadCommands } from "../helpers/commands.js";
import { readJson } from "../helpers/json.js";
import {
  seedEnvironment,
  seedHostSession,
  seedProjectWithSource,
  seedThread,
  seedThreadRuntimeState,
} from "../helpers/seed.js";
import { withTestHarness } from "../helpers/test-app.js";

describe("thread environment decoupling (B*)", () => {
  it("revives a retiring environment on un-archive (lossless undo of an accidental archive)", async () => {
    await withTestHarness(async (harness) => {
      const { host } = seedHostSession(harness.deps, {
        id: "host-unarchive-revive",
      });
      const { project } = seedProjectWithSource(harness.deps, {
        hostId: host.id,
      });
      const environment = seedEnvironment(harness.deps, {
        hostId: host.id,
        managed: true,
        path: "/tmp/unarchive-revive",
        projectId: project.id,
        status: "retiring",
        workspaceProvisionType: "managed-worktree",
      });
      const thread = seedThread(harness.deps, {
        projectId: project.id,
        environmentId: environment.id,
        status: "idle",
      });
      const providerThreadId = "provider-unarchive-revive";
      seedThreadRuntimeState(harness.deps, {
        environmentId: environment.id,
        providerThreadId,
        threadId: thread.id,
      });
      archiveThread(harness.db, harness.hub, thread.id);

      const response = await harness.app.request(
        `/api/v1/threads/${thread.id}/unarchive`,
        { method: "POST" },
      );

      expect(response.status).toBe(200);
      expect(getThread(harness.db, thread.id)?.archivedAt).toBeNull();
      expect(getEnvironment(harness.db, environment.id)).toMatchObject({
        status: "ready",
      });
      expect(
        listQueuedThreadCommands(harness, "thread.unarchive", thread.id),
      ).toEqual([
        expect.objectContaining({
          environmentId: environment.id,
          providerThreadId,
          providerId: thread.providerId,
          threadId: thread.id,
          type: "thread.unarchive",
        }),
      ]);
    });
  });

  it("un-archives a thread whose cleanup is already in progress without a 409", async () => {
    await withTestHarness(async (harness) => {
      const { host } = seedHostSession(harness.deps, {
        id: "host-unarchive-destroying",
      });
      const { project } = seedProjectWithSource(harness.deps, {
        hostId: host.id,
      });
      const environment = seedEnvironment(harness.deps, {
        hostId: host.id,
        managed: true,
        projectId: project.id,
        path: "/tmp/unarchive-destroying",
        status: "retiring",
        workspaceProvisionType: "managed-worktree",
      });
      const thread = seedThread(harness.deps, {
        projectId: project.id,
        environmentId: environment.id,
        status: "idle",
      });
      archiveThread(harness.db, harness.hub, thread.id);
      requireEnvironmentLifecycleEventApplied(
        applyEnvironmentLifecycleEvent(harness.db, harness.hub, {
          environmentId: environment.id,
          event: {
            type: "destroy.started",
            destroyAttemptId: "rpc_unarchive_destroying",
          },
        }),
      );
      expect(getEnvironment(harness.db, environment.id)?.status).toBe(
        "destroying",
      );

      const response = await harness.app.request(
        `/api/v1/threads/${thread.id}/unarchive`,
        { method: "POST" },
      );

      expect(response.status).toBe(200);
      expect(getThread(harness.db, thread.id)?.archivedAt).toBeNull();
      expect(getEnvironment(harness.db, environment.id)?.status).toBe(
        "destroying",
      );
    });
  });

  it("revives a retiring environment when a user sends a follow-up", async () => {
    await withTestHarness(async (harness) => {
      const { host } = seedHostSession(harness.deps, {
        id: "host-send-retiring",
      });
      const { project } = seedProjectWithSource(harness.deps, {
        hostId: host.id,
      });
      const environment = seedEnvironment(harness.deps, {
        hostId: host.id,
        managed: true,
        projectId: project.id,
        path: "/tmp/send-retiring",
        status: "retiring",
        workspaceProvisionType: "managed-worktree",
      });
      const thread = seedThread(harness.deps, {
        projectId: project.id,
        environmentId: environment.id,
        status: "idle",
      });

      const response = await harness.app.request(
        `/api/v1/threads/${thread.id}/send`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            mode: "auto",
            model: "gpt-5",
            input: [{ type: "text", text: "Revive retiring env" }],
          }),
        },
      );

      expect(response.status, await response.text()).toBe(200);
      expect(getEnvironment(harness.db, environment.id)?.status).toBe("ready");
    });
  });

  for (const status of [
    "destroying",
    "destroyed",
  ] as const satisfies readonly EnvironmentStatus[]) {
    it(`rejects a send to a thread whose environment is ${status} without reprovisioning`, async () => {
      await withTestHarness(async (harness) => {
        const { host } = seedHostSession(harness.deps, {
          id: `host-send-${status}`,
        });
        const { project } = seedProjectWithSource(harness.deps, {
          hostId: host.id,
        });
        const environment = seedEnvironment(harness.deps, {
          hostId: host.id,
          managed: true,
          projectId: project.id,
          path: "/tmp/send-gone",
          status,
          workspaceProvisionType: "managed-worktree",
        });
        const thread = seedThread(harness.deps, {
          projectId: project.id,
          environmentId: environment.id,
          status: "idle",
        });
        // An `idle` thread has always run a turn, and the dispatch checkpoint
        // resolves this send's execution tuple before it reaches the
        // environment. Without a prior turn the fixture would fail on the
        // missing model instead of on the gone workspace.
        seedThreadRuntimeState(harness.deps, {
          environmentId: environment.id,
          providerThreadId: `provider-send-${status}`,
          threadId: thread.id,
        });

        const response = await harness.app.request(
          `/api/v1/threads/${thread.id}/send`,
          {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({
              mode: "auto",
              input: [{ type: "text", text: "Try to send into a gone env" }],
            }),
          },
        );

        expect(response.status).toBe(409);
        const body = await readJson(response);
        expect(body).toMatchObject({
          code: "thread_environment_unavailable",
          details: { reason: status, environmentStatus: status },
        });
        expect(getEnvironment(harness.db, environment.id)?.status).toBe(status);
      });
    });
  }
});
