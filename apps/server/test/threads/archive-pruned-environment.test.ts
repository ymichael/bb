import {
  DEFAULT_DESTROYED_ENVIRONMENT_EVENT_DETACH_BATCH_SIZE,
  DEFAULT_DESTROYED_ENVIRONMENT_PRUNE_BATCH_SIZE,
  DESTROYED_ENVIRONMENT_TTL_MS,
  environments,
  getThread,
  pruneDestroyedEnvironments,
} from "@bb/db";
import type { ThreadStatus } from "@bb/domain";
import { apiErrorSchema } from "@bb/server-contract";
import { eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { readJson } from "../helpers/json.js";
import {
  seedEnvironment,
  seedHostSession,
  seedProjectWithSource,
  seedThread,
} from "../helpers/seed.js";
import { withTestHarness, type TestAppHarness } from "../helpers/test-app.js";

const EIGHT_DAYS_MS = 8 * 24 * 60 * 60_000;

function seedThreadWithPrunedEnvironment(
  deps: Parameters<typeof seedThread>[0],
) {
  const { host } = seedHostSession(deps);
  const { project } = seedProjectWithSource(deps, { hostId: host.id });
  const environment = seedEnvironment(deps, {
    hostId: host.id,
    projectId: project.id,
    managed: true,
    workspaceProvisionType: "managed-worktree",
  });
  const thread = seedThread(deps, {
    environmentId: environment.id,
    projectId: project.id,
    status: "idle",
  });
  deps.db
    .update(environments)
    .set({ status: "destroyed", updatedAt: Date.now() - EIGHT_DAYS_MS })
    .where(eq(environments.id, environment.id))
    .run();
  expect(
    pruneDestroyedEnvironments(deps.db, deps.hub, {
      updatedBefore: Date.now() - DESTROYED_ENVIRONMENT_TTL_MS,
      eventBatchSize: DEFAULT_DESTROYED_ENVIRONMENT_EVENT_DETACH_BATCH_SIZE,
      limit: DEFAULT_DESTROYED_ENVIRONMENT_PRUNE_BATCH_SIZE,
    }).deleted,
  ).toBe(1);

  const threadAfterPrune = getThread(deps.db, thread.id);
  expect(threadAfterPrune?.environmentId).toBeNull();
  expect(threadAfterPrune?.archivedAt).toBeNull();
  return { thread };
}

function seedPointerlessThread(
  deps: Parameters<typeof seedThread>[0],
  status: ThreadStatus,
) {
  const { host } = seedHostSession(deps);
  const { project } = seedProjectWithSource(deps, { hostId: host.id });
  return seedThread(deps, { projectId: project.id, status });
}

async function expectArchiveRefused(
  harness: TestAppHarness,
  threadId: string,
  route: "archive" | "archive-all",
): Promise<void> {
  const response = await harness.app.request(
    `/api/v1/threads/${threadId}/${route}`,
    { method: "POST" },
  );
  expect(response.status).toBe(409);
  expect(apiErrorSchema.parse(await readJson(response))).toMatchObject({
    code: "thread_environment_unavailable",
    details: { reason: "never_attached" },
  });
  expect(getThread(harness.deps.db, threadId)?.archivedAt).toBeNull();
}

describe("archive after environment prune", () => {
  it("POST /threads/:id/archive succeeds for a thread whose environment was pruned", async () => {
    await withTestHarness(async (harness) => {
      const { thread } = seedThreadWithPrunedEnvironment(harness.deps);
      const response = await harness.app.request(
        `/api/v1/threads/${thread.id}/archive`,
        { method: "POST" },
      );
      expect(response.status).toBe(200);
      expect(await readJson(response)).toEqual({ ok: true });
      expect(getThread(harness.deps.db, thread.id)?.archivedAt).not.toBeNull();
    });
  });

  it("POST /threads/:id/archive-all succeeds for a thread whose environment was pruned", async () => {
    await withTestHarness(async (harness) => {
      const { thread } = seedThreadWithPrunedEnvironment(harness.deps);
      const response = await harness.app.request(
        `/api/v1/threads/${thread.id}/archive-all`,
        { method: "POST" },
      );
      expect(response.status).toBe(200);
      expect(await readJson(response)).toEqual({
        ok: true,
        archivedThreadIds: [thread.id],
      });
      expect(getThread(harness.deps.db, thread.id)?.archivedAt).not.toBeNull();
    });
  });

  it.each<ThreadStatus>(["starting", "stopping"])(
    "keeps refusing archive for a %s thread that has no environment yet",
    async (status) => {
      await withTestHarness(async (harness) => {
        const thread = seedPointerlessThread(harness.deps, status);
        await expectArchiveRefused(harness, thread.id, "archive");
        await expectArchiveRefused(harness, thread.id, "archive-all");
      });
    },
  );
});
