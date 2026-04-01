import { afterEach, describe, expect, it, vi } from "vitest";
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

describe("public environment and system routes", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("allows status without a merge-base branch and rejects branch-relative diff without one", async () => {
    const harness = await createTestAppHarness();
    try {
      const { host } = seedHostSession(harness.deps);
      const { project } = seedProjectWithSource(harness.deps, {
        hostId: host.id,
        path: "/tmp/environment-merge-base-required",
      });
      const environment = seedEnvironment(harness.deps, {
        hostId: host.id,
        projectId: project.id,
        path: "/tmp/environment-merge-base-required/worktree",
        managed: true,
        workspaceProvisionType: "managed-worktree",
        branchName: "bb/merge-base",
      });

      const statusPromise = harness.app.request(
        `/api/v1/environments/${environment.id}/status`,
      );
      const statusCommand = await waitForQueuedCommand(
        harness,
        ({ command }) =>
          command.type === "workspace.status" &&
          command.environmentId === environment.id,
      );
      expect(statusCommand.command).not.toHaveProperty("mergeBaseBranch");
      await reportQueuedCommandSuccess(harness, statusCommand, {
        workspaceStatus: {
          workingTree: {
            hasUncommittedChanges: false,
            state: "clean",
            changedFiles: 0,
            insertions: 0,
            deletions: 0,
            files: [],
          },
          branch: {
            currentBranch: "bb/merge-base",
            defaultBranch: "main",
          },
          mergeBase: null,
        },
      });
      const statusResponse = await statusPromise;
      expect(statusResponse.status).toBe(200);
      await expect(readJson(statusResponse)).resolves.toMatchObject({
        workspace: {
          mergeBase: null,
        },
      });

      const diffResponse = await harness.app.request(
        `/api/v1/environments/${environment.id}/diff?target=all`,
      );
      expect(diffResponse.status).toBe(400);
      await expect(readJson(diffResponse)).resolves.toMatchObject({
        code: "invalid_request",
        message: "A merge base branch is required",
      });
    } finally {
      await harness.cleanup();
    }
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
        workspaceContext: { workspacePath: "/tmp/environment-details/worktree", workspaceProvisionType: "managed-worktree" },
        mergeBaseBranch: "main",
      });
      await reportQueuedCommandSuccess(harness, statusCommand, {
        workspaceStatus: {
          workingTree: {
            hasUncommittedChanges: true,
            state: "dirty_uncommitted",
            changedFiles: 2,
            insertions: 5,
            deletions: 1,
            files: [],
          },
          branch: {
            currentBranch: "bb/details",
            defaultBranch: "main",
          },
          mergeBase: {
            mergeBaseBranch: "main",
            baseRef: "origin/main",
            aheadCount: 1,
            behindCount: 0,
            hasCommittedUnmergedChanges: true,
            commits: [],
          },
        },
      });
      const statusResponse = await statusPromise;
      expect(statusResponse.status).toBe(200);
      await expect(readJson(statusResponse)).resolves.toEqual({
        workspace: expect.objectContaining({
          workingTree: expect.objectContaining({
            state: "dirty_uncommitted",
          }),
          branch: expect.objectContaining({
            currentBranch: "bb/details",
          }),
        }),
      });

      const diffPromise = harness.app.request(
        `/api/v1/environments/${environment.id}/diff?target=all&mergeBaseBranch=main`,
      );
      const diffCommand = await waitForQueuedCommand(
        harness,
        ({ command }) =>
          command.type === "workspace.diff" &&
          command.environmentId === environment.id,
      );
      expect(diffCommand.command).toMatchObject({
        workspaceContext: { workspacePath: "/tmp/environment-details/worktree", workspaceProvisionType: "managed-worktree" },
        target: { type: "all", mergeBaseBranch: "main" },
      });
      await reportQueuedCommandSuccess(harness, diffCommand, {
        diff: {
          diff: "diff --git a/file.ts b/file.ts",
          truncated: false,
          shortstat: " 1 file changed, 1 insertion(+)\n",
          files: "M\tfile.ts\n",
        },
      });
      const diffResponse = await diffPromise;
      expect(diffResponse.status).toBe(200);
      await expect(readJson(diffResponse)).resolves.toEqual({
        diff: "diff --git a/file.ts b/file.ts",
        truncated: false,
        shortstat: " 1 file changed, 1 insertion(+)\n",
        files: "M\tfile.ts\n",
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
        workspaceContext: { workspacePath: "/tmp/environment-details/worktree", workspaceProvisionType: "managed-worktree" },
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

  it("updates an environment merge base branch", async () => {
    const harness = await createTestAppHarness();
    try {
      const { host } = seedHostSession(harness.deps);
      const { project } = seedProjectWithSource(harness.deps, {
        hostId: host.id,
        path: "/tmp/environment-update",
      });
      const environment = seedEnvironment(harness.deps, {
        hostId: host.id,
        projectId: project.id,
        path: "/tmp/environment-update/worktree",
      });

      const response = await harness.app.request(
        `/api/v1/environments/${environment.id}`,
        {
          method: "PATCH",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ mergeBaseBranch: "release" }),
        },
      );

      expect(response.status).toBe(200);
      await expect(readJson(response)).resolves.toMatchObject({
        id: environment.id,
        mergeBaseBranch: "release",
      });
    } finally {
      await harness.cleanup();
    }
  });

  it("queues workspace.commit after checking status and diff, then returns the reported commit info", async () => {
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
          }),
        },
      );

      // Step 1: Server queries workspace status
      const statusCommand = await waitForQueuedCommand(
        harness,
        ({ command }) =>
          command.type === "workspace.status" &&
          command.environmentId === environment.id,
      );
      await reportQueuedCommandSuccess(harness, statusCommand, {
        workspaceStatus: {
          workingTree: {
            hasUncommittedChanges: true,
            state: "dirty_uncommitted",
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
      });

      // Step 2: Server queries diff for AI commit message generation
      const diffCommand = await waitForQueuedCommand(
        harness,
        ({ command }) =>
          command.type === "workspace.diff" &&
          command.environmentId === environment.id,
      );
      expect(diffCommand.command).toMatchObject({
        target: { type: "uncommitted" },
      });
      await reportQueuedCommandSuccess(harness, diffCommand, {
        diff: {
          diff: "diff --git a/file.ts b/file.ts",
          truncated: false,
          shortstat: " 1 file changed, 1 insertion(+)\n",
          files: "M\tfile.ts\n",
        },
      });

      // Step 3: Server queues commit (AI message generation may fall back)
      const commitCommand = await waitForQueuedCommand(
        harness,
        ({ command }) =>
          command.type === "workspace.commit" &&
          command.environmentId === environment.id,
      );
      expect(commitCommand.command).toMatchObject({
        workspaceContext: { workspacePath: "/tmp/test-environment", workspaceProvisionType: "unmanaged" },
        message: "bb: automated commit",
      });
      await reportQueuedCommandSuccess(harness, commitCommand, {
        commitSha: "abc123",
        commitSubject: "bb: automated commit",
      });

      const response = await responsePromise;
      expect(response.status).toBe(200);
      await expect(readJson(response)).resolves.toMatchObject({
        ok: true,
        action: "commit",
        commitSha: "abc123",
        commitSubject: "bb: automated commit",
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
        mergeBaseBranch: "main",
      });

      const promotePromise = harness.app.request(
        `/api/v1/environments/${environment.id}/actions`,
        {
          method: "POST",
          headers: {
            "content-type": "application/json",
          },
          body: JSON.stringify({ action: "promote" }),
        },
      );

      const promoteCommand = await waitForQueuedCommand(
        harness,
        ({ command }) =>
          command.type === "workspace.promote" &&
          command.environmentId === environment.id,
      );
      expect(promoteCommand.command).toMatchObject({
        workspaceContext: { workspacePath: "/tmp/promote-project/.bb-worktrees/thread", workspaceProvisionType: "managed-worktree" },
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
          body: JSON.stringify({ action: "demote" }),
        },
      );

      const demoteCommand = await waitForQueuedCommand(
        harness,
        ({ command }) =>
          command.type === "workspace.demote" &&
          command.environmentId === environment.id,
      );
      expect(demoteCommand.command).toMatchObject({
        workspaceContext: { workspacePath: "/tmp/promote-project/.bb-worktrees/thread", workspaceProvisionType: "managed-worktree" },
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

  it("queues workspace.squash_merge after checking status and diff, then returns the merge result", async () => {
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
              mergeBaseBranch: "main",
            },
          }),
        },
      );

      // Step 1: Server queries workspace status
      const statusCommand = await waitForQueuedCommand(
        harness,
        ({ command }) =>
          command.type === "workspace.status" &&
          command.environmentId === environment.id,
      );
      await reportQueuedCommandSuccess(harness, statusCommand, {
        workspaceStatus: {
          workingTree: {
            hasUncommittedChanges: false,
            state: "clean",
            changedFiles: 0,
            insertions: 0,
            deletions: 0,
            files: [],
          },
          branch: {
            currentBranch: "bb/feature",
            defaultBranch: "main",
          },
          mergeBase: null,
        },
      });

      // Step 2: Server queries branch_committed diff
      const diffCommand = await waitForQueuedCommand(
        harness,
        ({ command }) =>
          command.type === "workspace.diff" &&
          command.environmentId === environment.id,
      );
      expect(diffCommand.command).toMatchObject({
        target: { type: "branch_committed", mergeBaseBranch: "main" },
      });
      await reportQueuedCommandSuccess(harness, diffCommand, {
        diff: {
          diff: "diff --git a/file.ts b/file.ts",
          truncated: false,
          shortstat: " 1 file changed, 1 insertion(+)\n",
          files: "M\tfile.ts\n",
        },
      });

      // Step 3: Server queues squash_merge with generated message
      const mergeCommand = await waitForQueuedCommand(
        harness,
        ({ command }) =>
          command.type === "workspace.squash_merge" &&
          command.environmentId === environment.id,
      );
      expect(mergeCommand.command).toMatchObject({
        workspaceContext: { workspacePath: "/tmp/test-environment", workspaceProvisionType: "managed-worktree" },
        targetBranch: "main",
        commitMessage: "bb: squash merge",
      });
      await reportQueuedCommandSuccess(harness, mergeCommand, {
        merged: true,
        commitSha: "merge123",
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

  it("rejects squash merge with 409 when workspace is in detached HEAD state", async () => {
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

      const responsePromise = harness.app.request(
        `/api/v1/environments/${environment.id}/actions`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            action: "squash_merge",
            options: { mergeBaseBranch: "main" },
          }),
        },
      );

      const statusCommand = await waitForQueuedCommand(
        harness,
        ({ command }) =>
          command.type === "workspace.status" &&
          command.environmentId === environment.id,
      );
      await reportQueuedCommandSuccess(harness, statusCommand, {
        workspaceStatus: {
          workingTree: {
            hasUncommittedChanges: false,
            state: "clean",
            changedFiles: 0,
            insertions: 0,
            deletions: 0,
            files: [],
          },
          branch: {
            currentBranch: null,
            defaultBranch: "main",
          },
          mergeBase: null,
        },
      });

      const response = await responsePromise;
      expect(response.status).toBe(409);
      await expect(readJson(response)).resolves.toMatchObject({
        code: "invalid_request",
      });
    } finally {
      await harness.cleanup();
    }
  });

  it("rejects commit with 409 when workspace has no uncommitted changes", async () => {
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
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            action: "commit",
          }),
        },
      );

      // Status and diff are fired in parallel; respond to both
      const statusCommand = await waitForQueuedCommand(
        harness,
        ({ command }) =>
          command.type === "workspace.status" &&
          command.environmentId === environment.id,
      );
      const diffCommand = await waitForQueuedCommand(
        harness,
        ({ command }) =>
          command.type === "workspace.diff" &&
          command.environmentId === environment.id,
      );
      await Promise.all([
        reportQueuedCommandSuccess(harness, statusCommand, {
          workspaceStatus: {
            workingTree: {
              hasUncommittedChanges: false,
              state: "clean",
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
        }),
        reportQueuedCommandSuccess(harness, diffCommand, {
          diff: {
            diff: "",
            truncated: false,
            shortstat: "",
            files: "",
          },
        }),
      ]);

      const response = await responsePromise;
      expect(response.status).toBe(409);
      await expect(readJson(response)).resolves.toMatchObject({
        code: "no_changes",
      });
    } finally {
      await harness.cleanup();
    }
  });

  it("auto-commits dirty workspace before squash merge", async () => {
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

      const responsePromise = harness.app.request(
        `/api/v1/environments/${environment.id}/actions`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            action: "squash_merge",
            options: { mergeBaseBranch: "main" },
          }),
        },
      );

      // Step 1: Status reports dirty workspace
      const statusCommand = await waitForQueuedCommand(
        harness,
        ({ command }) =>
          command.type === "workspace.status" &&
          command.environmentId === environment.id,
      );
      await reportQueuedCommandSuccess(harness, statusCommand, {
        workspaceStatus: {
          workingTree: {
            hasUncommittedChanges: true,
            state: "dirty_uncommitted",
            changedFiles: 2,
            insertions: 5,
            deletions: 1,
            files: [],
          },
          branch: {
            currentBranch: "bb/dirty-merge",
            defaultBranch: "main",
          },
          mergeBase: null,
        },
      });

      // Step 2: Server issues pre-merge commit
      const preCommitCommand = await waitForQueuedCommand(
        harness,
        ({ command }) =>
          command.type === "workspace.commit" &&
          command.environmentId === environment.id,
      );
      expect(preCommitCommand.command).toMatchObject({
        message: "bb: pre-merge commit",
      });
      await reportQueuedCommandSuccess(harness, preCommitCommand, {
        commitSha: "pre-merge-sha",
        commitSubject: "bb: pre-merge commit",
      });

      // Step 3: Diff for AI message
      const diffCommand = await waitForQueuedCommand(
        harness,
        ({ command }) =>
          command.type === "workspace.diff" &&
          command.environmentId === environment.id,
      );
      expect(diffCommand.command).toMatchObject({
        target: { type: "branch_committed", mergeBaseBranch: "main" },
      });
      await reportQueuedCommandSuccess(harness, diffCommand, {
        diff: {
          diff: "diff --git a/file.ts b/file.ts",
          truncated: false,
          shortstat: " 1 file changed, 5 insertions(+), 1 deletion(-)\n",
          files: "M\tfile.ts\n",
        },
      });

      // Step 4: Final squash merge
      const mergeCommand = await waitForQueuedCommand(
        harness,
        ({ command }) =>
          command.type === "workspace.squash_merge" &&
          command.environmentId === environment.id,
      );
      expect(mergeCommand.command).toMatchObject({
        targetBranch: "main",
        commitMessage: "bb: squash merge",
      });
      await reportQueuedCommandSuccess(harness, mergeCommand, {
        merged: true,
        commitSha: "squash-sha",
      });

      const response = await responsePromise;
      expect(response.status).toBe(200);
      await expect(readJson(response)).resolves.toMatchObject({
        ok: true,
        action: "squash_merge",
        merged: true,
        commitSha: "squash-sha",
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
        voiceTranscriptionEnabled: true,
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

  it("rejects invalid system query params with a 400", async () => {
    const harness = await createTestAppHarness();
    try {
      const response = await harness.app.request(
        "/api/v1/system/models?providerId=",
      );
      expect(response.status).toBe(400);
      await expect(readJson(response)).resolves.toMatchObject({
        code: "invalid_request",
      });
    } finally {
      await harness.cleanup();
    }
  });

  it("rejects voice transcription requests when the API key is not configured", async () => {
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

      expect(response.status).toBe(501);
      await expect(readJson(response)).resolves.toMatchObject({
        code: "not_configured",
        message: "Voice transcription requires OPENAI_API_KEY to be configured",
      });
    } finally {
      await harness.cleanup();
    }
  });
});
