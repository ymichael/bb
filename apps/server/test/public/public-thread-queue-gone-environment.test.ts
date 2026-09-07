import {
  archiveThread,
  getEnvironment,
  getThread,
  listIdleThreadsWithQueuedMessages,
  listQueuedThreadMessages,
} from "@bb/db";
import {
  applyEnvironmentLifecycleEvent,
  requireEnvironmentLifecycleEventApplied,
} from "@bb/db/internal-environment-lifecycle";
import {
  encodeClientTurnRequestIdNumber,
  threadScope,
  type EnvironmentStatus,
} from "@bb/domain";
import { describe, expect, it } from "vitest";
import { readJson } from "../helpers/json.js";
import {
  seedEnvironment,
  seedEvent,
  seedHostSession,
  seedProjectWithSource,
  seedQueuedMessage,
  seedThread,
  seedTurnStarted,
} from "../helpers/seed.js";
import { withTestHarness, type TestAppHarness } from "../helpers/test-app.js";

const earlierTurnEventData = {
  direction: "outbound",
  requestId: encodeClientTurnRequestIdNumber({ value: 1 }),
  input: [{ type: "text", text: "Earlier work" }],
  target: { kind: "new-turn" },
  execution: {
    model: "gpt-5",
    serviceTier: "default",
    reasoningLevel: "medium",
    permissionMode: "full",
    source: "client/turn/requested",
  },
  initiator: "user",
  senderThreadId: null,
  request: { method: "turn/start", params: {} },
  source: "tell",
} as const;

async function postQueuedMessage(
  harness: TestAppHarness,
  threadId: string,
  text: string,
  options: { model?: string } = {},
): Promise<Response> {
  return harness.app.request(`/api/v1/threads/${threadId}/queued-messages`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ input: [{ type: "text", text }], ...options }),
  });
}

describe("queued message into a thread whose environment is gone (#1789)", () => {
  for (const status of [
    "destroying",
    "destroyed",
  ] as const satisfies readonly EnvironmentStatus[]) {
    it(`rejects queue-create when the environment is ${status}`, async () => {
      await withTestHarness(async (harness) => {
        const { host } = seedHostSession(harness.deps, {
          id: `host-queue-${status}`,
        });
        const { project } = seedProjectWithSource(harness.deps, {
          hostId: host.id,
        });
        const environment = seedEnvironment(harness.deps, {
          hostId: host.id,
          managed: true,
          projectId: project.id,
          path: null,
          status,
          workspaceProvisionType: "managed-worktree",
        });
        const thread = seedThread(harness.deps, {
          projectId: project.id,
          environmentId: environment.id,
          status: "idle",
        });

        seedEvent(harness.deps, {
          threadId: thread.id,
          environmentId: environment.id,
          sequence: 1,
          type: "client/turn/requested",
          scope: threadScope(),
          data: earlierTurnEventData,
        });

        const sendResponse = await harness.app.request(
          `/api/v1/threads/${thread.id}/send`,
          {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({
              mode: "auto",
              input: [{ type: "text", text: "direct send" }],
            }),
          },
        );
        expect(sendResponse.status).toBe(409);

        const queueResponse = await postQueuedMessage(
          harness,
          thread.id,
          "queued into a gone env",
        );
        const body = await readJson(queueResponse);
        expect(getThread(harness.db, thread.id)?.status).toBe("idle");
        expect(
          queueResponse.status,
          `queue-create answered ${queueResponse.status} ${JSON.stringify(body)}; queued rows: ${
            listQueuedThreadMessages(harness.db, thread.id).length
          }`,
        ).toBe(409);
        expect(body).toMatchObject({
          code: "thread_environment_unavailable",
          details: { reason: status, environmentStatus: status },
        });
        expect(listQueuedThreadMessages(harness.db, thread.id)).toHaveLength(0);
      });
    });
  }

  it("rejects queue-create when a thread that ran before lost its environment row", async () => {
    await withTestHarness(async (harness) => {
      const { host } = seedHostSession(harness.deps, {
        id: "host-queue-pruned",
      });
      const { project } = seedProjectWithSource(harness.deps, {
        hostId: host.id,
      });
      const thread = seedThread(harness.deps, {
        projectId: project.id,
        environmentId: null,
        status: "idle",
      });
      seedEvent(harness.deps, {
        threadId: thread.id,
        environmentId: null,
        sequence: 1,
        type: "client/turn/requested",
        scope: threadScope(),
        data: earlierTurnEventData,
      });
      seedTurnStarted(harness.deps, {
        threadId: thread.id,
        environmentId: null,
        turnId: "turn-1",
      });

      const queueResponse = await postQueuedMessage(
        harness,
        thread.id,
        "queued into a pruned env",
      );
      expect(queueResponse.status).toBe(409);
      expect(await readJson(queueResponse)).toMatchObject({
        code: "thread_environment_unavailable",
        details: { reason: "never_attached", environmentStatus: null },
      });
      expect(listQueuedThreadMessages(harness.db, thread.id)).toHaveLength(0);
    });
  });

  it("still accepts queue-create for a thread that has not run and has no environment yet", async () => {
    await withTestHarness(async (harness) => {
      const { host } = seedHostSession(harness.deps, { id: "host-queue-new" });
      const { project } = seedProjectWithSource(harness.deps, {
        hostId: host.id,
      });
      const thread = seedThread(harness.deps, {
        projectId: project.id,
        environmentId: null,
        status: "idle",
      });

      const queueResponse = await postQueuedMessage(
        harness,
        thread.id,
        "queued before provisioning",
        { model: "gpt-5" },
      );
      expect(queueResponse.status, await queueResponse.text()).toBe(201);
      expect(listQueuedThreadMessages(harness.db, thread.id)).toHaveLength(1);
    });
  });

  it("drops a thread from the auto-send sweep once its environment is gone, so pre-existing queued rows stop failing every cycle", async () => {
    await withTestHarness(async (harness) => {
      const { host } = seedHostSession(harness.deps, {
        id: "host-queue-sweep",
      });
      const { project } = seedProjectWithSource(harness.deps, {
        hostId: host.id,
      });
      const environment = seedEnvironment(harness.deps, {
        hostId: host.id,
        managed: true,
        projectId: project.id,
        status: "ready",
        workspaceProvisionType: "managed-worktree",
      });
      const thread = seedThread(harness.deps, {
        projectId: project.id,
        environmentId: environment.id,
        status: "idle",
      });
      seedTurnStarted(harness.deps, {
        threadId: thread.id,
        environmentId: environment.id,
        turnId: "turn-1",
      });
      seedQueuedMessage(harness.deps, {
        threadId: thread.id,
        content: [
          { type: "text", text: "queued before destroy", mentions: [] },
        ],
      });
      const sweepCandidates = () =>
        listIdleThreadsWithQueuedMessages(harness.db).map(
          (row) => row.threadId,
        );
      expect(sweepCandidates()).toEqual([thread.id]);

      archiveThread(harness.db, harness.hub, thread.id);
      requireEnvironmentLifecycleEventApplied(
        applyEnvironmentLifecycleEvent(harness.db, harness.hub, {
          environmentId: environment.id,
          event: { type: "retire.requested" },
        }),
      );
      requireEnvironmentLifecycleEventApplied(
        applyEnvironmentLifecycleEvent(harness.db, harness.hub, {
          environmentId: environment.id,
          event: { type: "destroy.started", destroyAttemptId: "rpc_sweep" },
        }),
      );
      expect(getEnvironment(harness.db, environment.id)?.status).toBe(
        "destroying",
      );
      expect(sweepCandidates()).toEqual([]);
      requireEnvironmentLifecycleEventApplied(
        applyEnvironmentLifecycleEvent(harness.db, harness.hub, {
          environmentId: environment.id,
          event: { type: "destroy.completed", destroyAttemptId: "rpc_sweep" },
        }),
      );
      expect(getEnvironment(harness.db, environment.id)?.status).toBe(
        "destroyed",
      );
      const unarchiveResponse = await harness.app.request(
        `/api/v1/threads/${thread.id}/unarchive`,
        { method: "POST" },
      );
      expect(unarchiveResponse.status).toBe(200);
      expect(getThread(harness.db, thread.id)).toMatchObject({
        archivedAt: null,
        status: "idle",
      });

      expect(listQueuedThreadMessages(harness.db, thread.id)).toHaveLength(1);
      expect(sweepCandidates()).toEqual([]);
    });
  });
});
