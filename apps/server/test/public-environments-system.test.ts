import { afterEach, describe, expect, it, vi } from "vitest";
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
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("returns environment details and queues status, diff, and branch queries", async () => {
    const harness = await createTestAppHarness();
    try {
      const { host } = seedHostSession(harness.deps);
      const { project } = seedProjectWithSource(harness.deps, {
        hostId: host.id,
        path: "/tmp/environment-details",
      });
      const environment = seedEnvironment(harness.deps, {
        hostId: host.id,
        projectId: project.id,
        path: "/tmp/environment-details/worktree",
        managed: true,
        workspaceProvisionType: "managed-worktree",
        branchName: "bb/details",
      });

      const getResponse = await harness.app.request(
        `/api/v1/environments/${environment.id}`,
      );
      expect(getResponse.status).toBe(200);
      await expect(readJson(getResponse)).resolves.toMatchObject({
        id: environment.id,
        projectId: project.id,
        branchName: "bb/details",
      });

      const statusPromise = harness.app.request(
        `/api/v1/environments/${environment.id}/status?mergeBaseBranch=main`,
      );
      const statusCommand = await waitForQueuedCommand(
        harness,
        ({ command }) =>
          command.type === "workspace.status" &&
          command.environmentId === environment.id,
      );
      expect(statusCommand.command).toMatchObject({
        workspacePath: "/tmp/environment-details/worktree",
        mergeBaseBranch: "main",
      });
      await reportQueuedCommandSuccess(harness, statusCommand, {
        workspaceStatus: {
          state: "dirty_uncommitted",
          changedFiles: 2,
          insertions: 5,
          deletions: 1,
          workspaceChangedFiles: 2,
          workspaceInsertions: 5,
          workspaceDeletions: 1,
          hasUncommittedChanges: true,
          hasCommittedUnmergedChanges: false,
          aheadCount: 1,
          behindCount: 0,
          currentBranch: "bb/details",
        },
      });
      const statusResponse = await statusPromise;
      expect(statusResponse.status).toBe(200);
      await expect(readJson(statusResponse)).resolves.toEqual({
        workspace: expect.objectContaining({
          state: "dirty_uncommitted",
          currentBranch: "bb/details",
        }),
      });

      const diffPromise = harness.app.request(
        `/api/v1/environments/${environment.id}/diff?selection=combined`,
      );
      const diffCommand = await waitForQueuedCommand(
        harness,
        ({ command }) =>
          command.type === "workspace.diff" &&
          command.environmentId === environment.id,
      );
      expect(diffCommand.command).toMatchObject({
        workspacePath: "/tmp/environment-details/worktree",
        selection: { type: "combined" },
      });
      await reportQueuedCommandSuccess(harness, diffCommand, {
        diff: {
          mode: "local_uncommitted",
          currentBranch: "bb/details",
          mergeBaseBranch: "main",
          mergeBaseRef: "origin/main",
          commits: [],
          selection: { type: "combined" },
          diff: "diff --git a/file.ts b/file.ts",
          truncated: false,
        },
      });
      const diffResponse = await diffPromise;
      expect(diffResponse.status).toBe(200);
      await expect(readJson(diffResponse)).resolves.toEqual({
        mode: "local_uncommitted",
        currentBranch: "bb/details",
        mergeBaseBranch: "main",
        mergeBaseRef: "origin/main",
        commits: [],
        selection: { type: "combined" },
        diff: "diff --git a/file.ts b/file.ts",
        truncated: false,
      });

      const branchesPromise = harness.app.request(
        `/api/v1/environments/${environment.id}/diff/branches`,
      );
      const branchesCommand = await waitForQueuedCommand(
        harness,
        ({ command }) =>
          command.type === "workspace.list_branches" &&
          command.environmentId === environment.id,
      );
      expect(branchesCommand.command).toMatchObject({
        workspacePath: "/tmp/environment-details/worktree",
      });
      await reportQueuedCommandSuccess(harness, branchesCommand, {
        branches: ["main", "bb/details"],
        current: "bb/details",
      });
      const branchesResponse = await branchesPromise;
      expect(branchesResponse.status).toBe(200);
      await expect(readJson(branchesResponse)).resolves.toEqual([
        "main",
        "bb/details",
      ]);
    } finally {
      await harness.cleanup();
    }
  });

  it("queues workspace.commit and returns the reported commit info", async () => {
    const harness = await createTestAppHarness();
    try {
      const { host } = seedHostSession(harness.deps);
      const { project } = seedProjectWithSource(harness.deps, { hostId: host.id });
      const environment = seedEnvironment(harness.deps, {
        hostId: host.id,
        projectId: project.id,
      });
      const thread = seedThread(harness.deps, {
        projectId: project.id,
        environmentId: environment.id,
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
            threadId: thread.id,
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
        workspacePath: "/tmp/test-environment",
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
            threadId: primaryThread.id,
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
        workspacePath: "/tmp/promote-project/.bb-worktrees/thread",
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
            threadId: primaryThread.id,
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
        workspacePath: "/tmp/promote-project/.bb-worktrees/thread",
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
      const thread = seedThread(harness.deps, {
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
            threadId: thread.id,
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
        workspacePath: "/tmp/test-environment",
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

  it("queues provider list and provider list_models commands for system routes", async () => {
    const harness = await createTestAppHarness();
    try {
      const { host } = seedHostSession(harness.deps, {
        id: "host-system-routes",
      });

      const modelsPromise = harness.app.request(
        `/api/v1/system/models?hostId=${host.id}&providerId=codex`,
      );
      const modelsCommand = await waitForQueuedCommand(
        harness,
        ({ command }) =>
          command.type === "provider.list_models" &&
          command.providerId === "codex",
      );
      await reportQueuedCommandSuccess(harness, modelsCommand, {
        models: [
          {
            id: "codex-mini",
            model: "gpt-4o-mini",
            displayName: "Codex Mini",
            description: "Fast codex model",
            supportedReasoningEfforts: [
              {
                reasoningEffort: "medium",
                description: "Balanced",
              },
            ],
            defaultReasoningEffort: "medium",
            isDefault: true,
          },
        ],
      });
      const modelsResponse = await modelsPromise;
      expect(modelsResponse.status).toBe(200);
      await expect(readJson(modelsResponse)).resolves.toEqual([
        expect.objectContaining({
          id: "codex-mini",
          model: "gpt-4o-mini",
        }),
      ]);

      const providersPromise = harness.app.request(
        `/api/v1/system/providers?hostId=${host.id}`,
      );
      const providersCommand = await waitForQueuedCommand(
        harness,
        ({ command }) => command.type === "provider.list",
      );
      await reportQueuedCommandSuccess(harness, providersCommand, {
        providers: [
          {
            id: "codex",
            displayName: "Codex",
            capabilities: {
              supportsRename: true,
              supportsServiceTier: true,
            },
            available: true,
          },
        ],
      });
      const providersResponse = await providersPromise;
      expect(providersResponse.status).toBe(200);
      await expect(readJson(providersResponse)).resolves.toEqual([
        {
          id: "codex",
          displayName: "Codex",
          capabilities: {
            supportsRename: true,
            supportsServiceTier: true,
          },
          available: true,
        },
      ]);
    } finally {
      await harness.cleanup();
    }
  });

  it("rejects voice transcription requests when the API key is not configured", async () => {
    const fetchMock = vi.fn(async () =>
      new Response(
        JSON.stringify({
          error: {
            message: "Missing API key",
          },
        }),
        {
          status: 401,
          headers: {
            "content-type": "application/json",
          },
        },
      ));
    vi.stubGlobal("fetch", fetchMock);

    const harness = await createTestAppHarness({
      openAiApiKey: "",
    });
    try {
      const formData = new FormData();
      formData.set(
        "file",
        new File([new Uint8Array([1, 2, 3])], "audio.wav", {
          type: "audio/wav",
        }),
        "audio.wav",
      );

      const response = await harness.app.request(
        "/api/v1/system/voice-transcription",
        {
          method: "POST",
          body: formData,
        },
      );

      expect(response.status).toBe(502);
      await expect(readJson(response)).resolves.toMatchObject({
        code: "provider_rpc_error",
        message: "Missing API key",
      });
      expect(fetchMock).toHaveBeenCalledTimes(1);
    } finally {
      await harness.cleanup();
    }
  });
});
