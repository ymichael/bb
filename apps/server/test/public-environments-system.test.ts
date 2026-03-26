import { describe, expect, it } from "vitest";
import {
  reportQueuedCommandSuccess,
  waitForQueuedCommand,
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

describe("public environment and system routes", () => {
  it("queues workspace.commit and returns the reported commit info", async () => {
    const harness = await createTestAppHarness();
    try {
      const { host } = seedHostSession(harness.deps);
      const { project } = seedProjectWithSource(harness.deps, { hostId: host.id });
      const environment = seedEnvironment(harness.deps, {
        hostId: host.id,
        projectId: project.id,
      });

      const responsePromise = harness.app.request(
        `/api/v1/environments/${environment.id}/actions`,
        {
          method: "POST",
          headers: {
            "content-type": "application/json",
          },
          body: JSON.stringify({
            action: "commit",
            options: {
              message: "Checkpoint changes",
            },
          }),
        },
      );

      const queued = await waitForQueuedCommand(
        harness,
        ({ command }) =>
          command.type === "workspace.commit" &&
          command.environmentId === environment.id,
      );
      expect(queued.command).toMatchObject({
        message: "Checkpoint changes",
      });

      await reportQueuedCommandSuccess(harness, queued, {
        commitSha: "abc123",
        commitSubject: "Checkpoint changes",
      });

      const response = await responsePromise;
      expect(response.status).toBe(200);
      await expect(readJson(response)).resolves.toMatchObject({
        ok: true,
        action: "commit",
        commitSha: "abc123",
        commitSubject: "Checkpoint changes",
      });
    } finally {
      await harness.cleanup();
    }
  });

  it("queues workspace.promote and workspace.demote for the primary thread", async () => {
    const harness = await createTestAppHarness();
    try {
      const { host } = seedHostSession(harness.deps);
      const { project, source } = seedProjectWithSource(harness.deps, {
        hostId: host.id,
        path: "/tmp/promote-project",
      });
      const environment = seedEnvironment(harness.deps, {
        hostId: host.id,
        projectId: project.id,
        path: "/tmp/promote-project/.bb-worktrees/thread",
        managed: true,
        workspaceProvisionType: "managed-worktree",
        branchName: "bb/promote-test",
      });
      const primaryThread = seedThread(harness.deps, {
        projectId: project.id,
        environmentId: environment.id,
        mergeBaseBranch: "main",
      });

      const promotePromise = harness.app.request(
        `/api/v1/environments/${environment.id}/actions`,
        {
          method: "POST",
          headers: {
            "content-type": "application/json",
          },
          body: JSON.stringify({
            action: "promote",
          }),
        },
      );

      const promoteCommand = await waitForQueuedCommand(
        harness,
        ({ command }) =>
          command.type === "workspace.promote" &&
          command.environmentId === environment.id,
      );
      expect(promoteCommand.command).toMatchObject({
        threadId: primaryThread.id,
        primaryPath: source.path,
      });
      await reportQueuedCommandSuccess(harness, promoteCommand, { ok: true });

      const promoteResponse = await promotePromise;
      expect(promoteResponse.status).toBe(200);
      await expect(readJson(promoteResponse)).resolves.toMatchObject({
        ok: true,
        action: "promote",
      });

      const demotePromise = harness.app.request(
        `/api/v1/environments/${environment.id}/actions`,
        {
          method: "POST",
          headers: {
            "content-type": "application/json",
          },
          body: JSON.stringify({
            action: "demote",
          }),
        },
      );

      const demoteCommand = await waitForQueuedCommand(
        harness,
        ({ command }) =>
          command.type === "workspace.demote" &&
          command.environmentId === environment.id,
      );
      expect(demoteCommand.command).toMatchObject({
        threadId: primaryThread.id,
        primaryPath: source.path,
        defaultBranch: "main",
        envBranch: "bb/promote-test",
      });
      await reportQueuedCommandSuccess(harness, demoteCommand, { ok: true });

      const demoteResponse = await demotePromise;
      expect(demoteResponse.status).toBe(200);
      await expect(readJson(demoteResponse)).resolves.toMatchObject({
        ok: true,
        action: "demote",
      });
    } finally {
      await harness.cleanup();
    }
  });

  it("queues workspace.squash_merge and returns the merge result", async () => {
    const harness = await createTestAppHarness();
    try {
      const { host } = seedHostSession(harness.deps);
      const { project } = seedProjectWithSource(harness.deps, { hostId: host.id });
      const environment = seedEnvironment(harness.deps, {
        hostId: host.id,
        projectId: project.id,
        managed: true,
        workspaceProvisionType: "managed-worktree",
      });
      seedThread(harness.deps, {
        projectId: project.id,
        environmentId: environment.id,
        mergeBaseBranch: "main",
      });

      const responsePromise = harness.app.request(
        `/api/v1/environments/${environment.id}/actions`,
        {
          method: "POST",
          headers: {
            "content-type": "application/json",
          },
          body: JSON.stringify({
            action: "squash_merge",
            options: {
              squashMessage: "Squash merge from tests",
            },
          }),
        },
      );

      const queued = await waitForQueuedCommand(
        harness,
        ({ command }) =>
          command.type === "workspace.squash_merge" &&
          command.environmentId === environment.id,
      );
      expect(queued.command).toMatchObject({
        targetBranch: "main",
        commitMessage: "Squash merge from tests",
      });
      await reportQueuedCommandSuccess(harness, queued, {
        merged: true,
        commitSha: "merge123",
        message: "Merge complete",
      });

      const response = await responsePromise;
      expect(response.status).toBe(200);
      await expect(readJson(response)).resolves.toMatchObject({
        ok: true,
        action: "squash_merge",
        merged: true,
        commitSha: "merge123",
      });
    } finally {
      await harness.cleanup();
    }
  });

  it("returns runtime config from GET /system/config", async () => {
    const harness = await createTestAppHarness({
      hostDaemonPort: 4010,
    });
    try {
      const response = await harness.app.request("/api/v1/system/config");
      expect(response.status).toBe(200);
      await expect(readJson(response)).resolves.toEqual({
        hostDaemonPort: 4010,
      });
    } finally {
      await harness.cleanup();
    }
  });
});
