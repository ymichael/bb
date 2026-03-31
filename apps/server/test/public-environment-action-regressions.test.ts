import { getEnvironment, getThread } from "@bb/db";
import { describe, expect, it } from "vitest";
import {
  reportQueuedCommandSuccess,
  waitForQueuedCommand,
  waitForQueuedCommandAfter,
} from "./helpers/commands.js";
import {
  seedEnvironment,
  seedHostSession,
  seedProjectWithSource,
  seedThread,
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
  it("rejects malformed commit and squash-merge payloads with a 400", async () => {
    const harness = await createTestAppHarness();
    try {
      const commitResponse = await harness.app.request(
        "/api/v1/environments/env_missing/actions",
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            action: "commit",
            threadId: "thread_missing",
          }),
        },
      );
      expect(commitResponse.status).toBe(400);
      await expect(readJson(commitResponse)).resolves.toMatchObject({
        code: "invalid_request",
      });

      const squashMergeResponse = await harness.app.request(
        "/api/v1/environments/env_missing/actions",
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            action: "squash_merge",
            threadId: "thread_missing",
            options: {
              autoArchiveOnSuccess: false,
            },
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

  it("archives the primary thread before cleanup on commit auto-archive", async () => {
    const harness = await createTestAppHarness();
    try {
      const { host } = seedHostSession(harness.deps, { id: "host-commit-archive" });
      const { project } = seedProjectWithSource(harness.deps, { hostId: host.id });
      const environment = seedEnvironment(harness.deps, {
        hostId: host.id,
        projectId: project.id,
        managed: true,
        workspaceProvisionType: "managed-worktree",
        path: "/tmp/commit-auto-archive",
      });
      const thread = seedThread(harness.deps, {
        projectId: project.id,
        environmentId: environment.id,
      });

      const responsePromise = harness.app.request(
        `/api/v1/environments/${environment.id}/actions`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            action: "commit",
            threadId: thread.id,
            options: {
              autoArchiveOnSuccess: true,
            },
          }),
        },
      );

      const commitCommand = await driveCommitFlow(harness, environment.id, {
        commitSha: "commit-archive-sha",
        commitSubject: "bb: automated commit",
      });

      const response = await responsePromise;
      expect(response.status).toBe(200);
      await expect(readJson(response)).resolves.toMatchObject({
        action: "commit",
        autoArchived: true,
        commitSha: "commit-archive-sha",
      });
      expect(getThread(harness.db, thread.id)?.archivedAt).toBeTypeOf("number");

      const destroyCommand = await waitForQueuedCommandAfter(
        harness,
        commitCommand.row.cursor,
        ({ command }) =>
          command.type === "environment.destroy" &&
          command.environmentId === environment.id,
      );
      expect(destroyCommand.command).toMatchObject({
        environmentId: environment.id,
      });
      expect(getEnvironment(harness.db, environment.id)?.status).toBe("destroying");
    } finally {
      await harness.cleanup();
    }
  });

  it("archives the primary thread before cleanup on squash-merge auto-archive", async () => {
    const harness = await createTestAppHarness();
    try {
      const { host } = seedHostSession(harness.deps, { id: "host-squash-archive" });
      const { project } = seedProjectWithSource(harness.deps, { hostId: host.id });
      const environment = seedEnvironment(harness.deps, {
        hostId: host.id,
        projectId: project.id,
        managed: true,
        workspaceProvisionType: "managed-worktree",
        path: "/tmp/squash-auto-archive",
        branchName: "bb/squash-auto-archive",
      });
      const thread = seedThread(harness.deps, {
        projectId: project.id,
        environmentId: environment.id,
        mergeBaseBranch: "main",
      });

      const responsePromise = harness.app.request(
        `/api/v1/environments/${environment.id}/actions`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            action: "squash_merge",
            threadId: thread.id,
            options: {
              mergeBaseBranch: "main",
              autoArchiveOnSuccess: true,
            },
          }),
        },
      );

      const mergeCommand = await driveSquashMergeFlow(harness, environment.id, {
        merged: true,
        commitSha: "squash-archive-sha",
      });

      const response = await responsePromise;
      expect(response.status).toBe(200);
      await expect(readJson(response)).resolves.toMatchObject({
        action: "squash_merge",
        autoArchived: true,
        commitSha: "squash-archive-sha",
        merged: true,
      });
      expect(getThread(harness.db, thread.id)?.archivedAt).toBeTypeOf("number");

      const destroyCommand = await waitForQueuedCommandAfter(
        harness,
        mergeCommand.row.cursor,
        ({ command }) =>
          command.type === "environment.destroy" &&
          command.environmentId === environment.id,
      );
      expect(destroyCommand.command).toMatchObject({
        environmentId: environment.id,
      });
      expect(getEnvironment(harness.db, environment.id)?.status).toBe("destroying");
    } finally {
      await harness.cleanup();
    }
  });

  it("uses the requested thread for auto-archive and rejects mismatched thread ids", async () => {
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
      const olderThread = seedThread(harness.deps, {
        projectId: project.id,
        environmentId: environment.id,
        title: "Older sibling",
      });
      const actingThread = seedThread(harness.deps, {
        projectId: project.id,
        environmentId: environment.id,
        title: "Acting thread",
      });
      const otherEnvironment = seedEnvironment(harness.deps, {
        hostId: host.id,
        projectId: project.id,
        path: "/tmp/other-environment",
      });
      const mismatchedThread = seedThread(harness.deps, {
        projectId: project.id,
        environmentId: otherEnvironment.id,
      });

      const responsePromise = harness.app.request(
        `/api/v1/environments/${environment.id}/actions`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            action: "commit",
            threadId: actingThread.id,
            options: {
              autoArchiveOnSuccess: true,
            },
          }),
        },
      );

      await driveCommitFlow(harness, environment.id, {
        commitSha: "targeted-thread-commit",
        commitSubject: "bb: automated commit",
      });

      const response = await responsePromise;
      expect(response.status).toBe(200);
      expect(getThread(harness.db, olderThread.id)?.archivedAt).toBeNull();
      expect(getThread(harness.db, actingThread.id)?.archivedAt).toBeTypeOf("number");

      const mismatchedResponse = await harness.app.request(
        `/api/v1/environments/${environment.id}/actions`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            action: "commit",
            threadId: mismatchedThread.id,
            options: {
              autoArchiveOnSuccess: false,
            },
          }),
        },
      );
      expect(mismatchedResponse.status).toBe(409);
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
      });
      const threadMissingEnvBranch = seedThread(harness.deps, {
        projectId: project.id,
        environmentId: missingEnvBranch.id,
        mergeBaseBranch: "main",
      });

      const missingEnvBranchResponse = await harness.app.request(
        `/api/v1/environments/${missingEnvBranch.id}/actions`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            action: "demote",
            threadId: threadMissingEnvBranch.id,
          }),
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
      });
      const threadMissingMergeBase = seedThread(harness.deps, {
        projectId: project.id,
        environmentId: missingMergeBase.id,
        mergeBaseBranch: null,
      });

      const missingMergeBaseResponse = await harness.app.request(
        `/api/v1/environments/${missingMergeBase.id}/actions`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            action: "demote",
            threadId: threadMissingMergeBase.id,
          }),
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
