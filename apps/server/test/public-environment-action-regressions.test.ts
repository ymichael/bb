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

describe("public environment action regressions", () => {
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
            options: {
              message: "Archive after commit",
              autoArchiveOnSuccess: true,
            },
          }),
        },
      );

      const commitCommand = await waitForQueuedCommand(
        harness,
        ({ command }) =>
          command.type === "workspace.commit" &&
          command.environmentId === environment.id,
      );
      await reportQueuedCommandSuccess(harness, commitCommand, {
        commitSha: "commit-archive-sha",
        commitSubject: "Archive after commit",
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
        path: "/tmp/commit-auto-archive",
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
            options: {
              squashMessage: "Squash and archive",
              autoArchiveOnSuccess: true,
            },
          }),
        },
      );

      const mergeCommand = await waitForQueuedCommand(
        harness,
        ({ command }) =>
          command.type === "workspace.squash_merge" &&
          command.environmentId === environment.id,
      );
      await reportQueuedCommandSuccess(harness, mergeCommand, {
        merged: true,
        commitSha: "squash-archive-sha",
        message: "Squash merge complete",
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
        path: "/tmp/squash-auto-archive",
      });
      expect(getEnvironment(harness.db, environment.id)?.status).toBe("destroying");
    } finally {
      await harness.cleanup();
    }
  });
});
