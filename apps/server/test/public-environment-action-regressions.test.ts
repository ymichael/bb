import { describe, expect, it } from "vitest";
import {
  reportQueuedCommandSuccess,
  waitForQueuedCommand,
} from "./helpers/commands.js";
import {
  seedEnvironment,
  seedHostSession,
  seedProjectWithSource,
} from "./helpers/seed.js";
import { createTestAppHarness } from "./helpers/test-app.js";

async function readJson(response: Response): Promise<unknown> {
  return response.json();
}

const CLEAN_STATUS = {
  workspaceStatus: {
    workingTree: {
      hasUncommittedChanges: false,
      state: "clean" as const,
      changedFiles: 0,
      insertions: 0,
      deletions: 0,
      files: [],
    },
    branch: {
      currentBranch: "feature",
      defaultBranch: "main",
    },
    mergeBase: null,
  },
};

const DIRTY_STATUS = {
  workspaceStatus: {
    workingTree: {
      hasUncommittedChanges: true,
      state: "dirty_uncommitted" as const,
      changedFiles: 1,
      insertions: 1,
      deletions: 0,
      files: [],
    },
    branch: {
      currentBranch: "feature",
      defaultBranch: "main",
    },
    mergeBase: null,
  },
};

const STUB_DIFF = {
  diff: {
    diff: "diff --git a/file.ts b/file.ts",
    truncated: false,
    shortstat: " 1 file changed, 1 insertion(+)\n",
    files: "M\tfile.ts\n",
  },
};

/**
 * Drive the server's commit multi-step flow (status -> diff -> commit)
 * by responding to each queued command in order.
 */
async function driveCommitFlow(
  harness: Awaited<ReturnType<typeof createTestAppHarness>>,
  environmentId: string,
  commitResult: { commitSha: string; commitSubject: string },
) {
  const statusCommand = await waitForQueuedCommand(
    harness,
    ({ command }) =>
      command.type === "workspace.status" &&
      command.environmentId === environmentId,
  );
  await reportQueuedCommandSuccess(harness, statusCommand, DIRTY_STATUS);

  const diffCommand = await waitForQueuedCommand(
    harness,
    ({ command }) =>
      command.type === "workspace.diff" &&
      command.environmentId === environmentId,
  );
  await reportQueuedCommandSuccess(harness, diffCommand, STUB_DIFF);

  const commitCommand = await waitForQueuedCommand(
    harness,
    ({ command }) =>
      command.type === "workspace.commit" &&
      command.environmentId === environmentId,
  );
  await reportQueuedCommandSuccess(harness, commitCommand, commitResult);

  return commitCommand;
}

/**
 * Drive the server's squash-merge multi-step flow (status -> diff -> squash_merge)
 * by responding to each queued command in order.
 */
async function driveSquashMergeFlow(
  harness: Awaited<ReturnType<typeof createTestAppHarness>>,
  environmentId: string,
  mergeResult: { merged: boolean; commitSha: string },
) {
  const statusCommand = await waitForQueuedCommand(
    harness,
    ({ command }) =>
      command.type === "workspace.status" &&
      command.environmentId === environmentId,
  );
  await reportQueuedCommandSuccess(harness, statusCommand, CLEAN_STATUS);

  const diffCommand = await waitForQueuedCommand(
    harness,
    ({ command }) =>
      command.type === "workspace.diff" &&
      command.environmentId === environmentId,
  );
  await reportQueuedCommandSuccess(harness, diffCommand, STUB_DIFF);

  const mergeCommand = await waitForQueuedCommand(
    harness,
    ({ command }) =>
      command.type === "workspace.squash_merge" &&
      command.environmentId === environmentId,
  );
  await reportQueuedCommandSuccess(harness, mergeCommand, mergeResult);

  return mergeCommand;
}

describe("public environment action regressions", () => {
  it("rejects malformed squash-merge payload with a 400", async () => {
    const harness = await createTestAppHarness();
    try {
      const squashMergeResponse = await harness.app.request(
        "/api/v1/environments/env_missing/actions",
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            action: "squash_merge",
          }),
        },
      );
      expect(squashMergeResponse.status).toBe(400);
      await expect(readJson(squashMergeResponse)).resolves.toMatchObject({
        code: "invalid_request",
      });
    } finally {
      await harness.cleanup();
    }
  });

  it("rejects legacy environment action payloads that still send threadId", async () => {
    const harness = await createTestAppHarness();
    try {
      const { host } = seedHostSession(harness.deps, { id: "host-thread-target" });
      const { project } = seedProjectWithSource(harness.deps, { hostId: host.id });
      const environment = seedEnvironment(harness.deps, {
        hostId: host.id,
        projectId: project.id,
        managed: true,
        workspaceProvisionType: "managed-worktree",
        path: "/tmp/thread-target",
      });

      const mismatchedResponse = await harness.app.request(
        `/api/v1/environments/${environment.id}/actions`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            action: "commit",
            threadId: "thread-legacy",
          }),
        },
      );
      expect(mismatchedResponse.status).toBe(400);
      await expect(readJson(mismatchedResponse)).resolves.toMatchObject({
        code: "invalid_request",
      });
    } finally {
      await harness.cleanup();
    }
  });

  it("rejects demote when the environment branch or merge base branch is missing", async () => {
    const harness = await createTestAppHarness();
    try {
      const { host } = seedHostSession(harness.deps, { id: "host-demote-guard" });
      const { project } = seedProjectWithSource(harness.deps, {
        hostId: host.id,
        path: "/tmp/demote-guard-project",
      });
      const missingEnvBranch = seedEnvironment(harness.deps, {
        hostId: host.id,
        projectId: project.id,
        managed: true,
        workspaceProvisionType: "managed-worktree",
        path: "/tmp/demote-guard-project/.bb-worktrees/missing-env-branch",
        branchName: null,
        mergeBaseBranch: "main",
      });

      const missingEnvBranchResponse = await harness.app.request(
        `/api/v1/environments/${missingEnvBranch.id}/actions`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ action: "demote" }),
        },
      );
      expect(missingEnvBranchResponse.status).toBe(409);
      await expect(readJson(missingEnvBranchResponse)).resolves.toMatchObject({
        code: "invalid_request",
        message: "Environment cannot be demoted",
      });

      const missingMergeBase = seedEnvironment(harness.deps, {
        hostId: host.id,
        projectId: project.id,
        managed: true,
        workspaceProvisionType: "managed-worktree",
        path: "/tmp/demote-guard-project/.bb-worktrees/missing-merge-base",
        branchName: "bb/demote-guard",
        defaultBranch: null,
        mergeBaseBranch: null,
      });

      const missingMergeBaseResponse = await harness.app.request(
        `/api/v1/environments/${missingMergeBase.id}/actions`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ action: "demote" }),
        },
      );
      expect(missingMergeBaseResponse.status).toBe(409);
      await expect(readJson(missingMergeBaseResponse)).resolves.toMatchObject({
        code: "invalid_request",
        message: "Environment cannot be demoted",
      });
    } finally {
      await harness.cleanup();
    }
  });
});
