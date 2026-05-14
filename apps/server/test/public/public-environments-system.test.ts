import {
  createEnvironment,
  hostDaemonCommands,
  openSession,
  updateHost,
  upsertHost,
} from "@bb/db";
import { HOST_DAEMON_PROTOCOL_VERSION } from "@bb/host-daemon-contract";
import {
  makeWorkspaceMergeBase,
  makeWorkspaceStatus,
  makeWorkspaceWorkingTree,
} from "@bb/test-helpers";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  WORKSPACE_DIFF_MAX_DIFF_BYTES,
  WORKSPACE_DIFF_MAX_FILE_LIST_BYTES,
} from "../../src/constants.js";
import {
  reportNextRuntimeMaterialSyncSuccess,
  reportQueuedCommandSuccess,
  waitForQueuedCommand,
  waitForQueuedCommandAfter,
} from "../helpers/commands.js";
import { readJson } from "../helpers/json.js";
import {
  seedEnvironment,
  seedHost,
  seedHostSession,
  seedProjectWithSource,
} from "../helpers/seed.js";
import { createTestAppHarness } from "../helpers/test-app.js";

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

  it("returns null status for non-git environments without queuing a git probe", async () => {
    const harness = await createTestAppHarness();
    try {
      const { host } = seedHostSession(harness.deps);
      const { project } = seedProjectWithSource(harness.deps, {
        hostId: host.id,
        path: "/tmp/environment-non-git",
      });
      const environment = createEnvironment(harness.db, harness.hub, {
        projectId: project.id,
        hostId: host.id,
        path: "/tmp/environment-non-git/workspace",
        status: "ready",
        managed: false,
        isGitRepo: false,
        isWorktree: false,
        workspaceProvisionType: "unmanaged",
        branchName: null,
        defaultBranch: null,
        mergeBaseBranch: null,
      });
      const commandCountBefore = harness.db
        .select({ id: hostDaemonCommands.id })
        .from(hostDaemonCommands)
        .all().length;

      const response = await harness.app.request(
        `/api/v1/environments/${environment.id}/status`,
      );

      expect(response.status).toBe(200);
      await expect(readJson(response)).resolves.toEqual({ workspace: null });

      const commandCountAfter = harness.db
        .select({ id: hostDaemonCommands.id })
        .from(hostDaemonCommands)
        .all().length;
      expect(commandCountAfter).toBe(commandCountBefore);
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
        workspaceContext: {
          workspacePath: "/tmp/environment-details/worktree",
          workspaceProvisionType: "managed-worktree",
        },
        mergeBaseBranch: "main",
      });
      await reportQueuedCommandSuccess(harness, statusCommand, {
        workspaceStatus: makeWorkspaceStatus({
          workingTree: makeWorkspaceWorkingTree({
            hasUncommittedChanges: true,
            state: "dirty_uncommitted",
            insertions: 5,
            deletions: 1,
          }),
          branch: { currentBranch: "bb/details", defaultBranch: "main" },
          mergeBase: makeWorkspaceMergeBase({
            baseRef: "origin/main",
            aheadCount: 1,
            hasCommittedUnmergedChanges: true,
          }),
        }),
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
        maxDiffBytes: WORKSPACE_DIFF_MAX_DIFF_BYTES,
        maxFileListBytes: WORKSPACE_DIFF_MAX_FILE_LIST_BYTES,
        workspaceContext: {
          workspacePath: "/tmp/environment-details/worktree",
          workspaceProvisionType: "managed-worktree",
        },
        target: { type: "all", mergeBaseBranch: "main" },
      });
      await reportQueuedCommandSuccess(harness, diffCommand, {
        diff: {
          diff: "diff --git a/file.ts b/file.ts",
          truncated: false,
          shortstat: " 1 file changed, 1 insertion(+)\n",
          files: "M\tfile.ts\n",
          mergeBaseRef: "abc1234",
        },
      });
      const diffResponse = await diffPromise;
      expect(diffResponse.status).toBe(200);
      await expect(readJson(diffResponse)).resolves.toEqual({
        diff: "diff --git a/file.ts b/file.ts",
        truncated: false,
        shortstat: " 1 file changed, 1 insertion(+)\n",
        files: "M\tfile.ts\n",
        mergeBaseRef: "abc1234",
      });

      const branchesPromise = harness.app.request(
        `/api/v1/environments/${environment.id}/diff/branches`,
      );
      const branchesCommand = await waitForQueuedCommand(
        harness,
        ({ command }) =>
          command.type === "host.list_branches" &&
          command.path === "/tmp/environment-details/worktree",
      );
      expect(branchesCommand.command).toMatchObject({
        path: "/tmp/environment-details/worktree",
      });
      await reportQueuedCommandSuccess(harness, branchesCommand, {
        branches: ["main", "bb/details"],
        current: "bb/details",
        defaultBranch: "main",
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
      const { project } = seedProjectWithSource(harness.deps, {
        hostId: host.id,
      });
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
        maxDiffBytes: 32_000,
        maxFileListBytes: 4_000,
        target: { type: "uncommitted" },
      });
      await reportQueuedCommandSuccess(harness, diffCommand, {
        diff: {
          diff: "diff --git a/file.ts b/file.ts",
          truncated: false,
          shortstat: " 1 file changed, 1 insertion(+)\n",
          files: "M\tfile.ts\n",
          mergeBaseRef: null,
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
        workspaceContext: {
          workspacePath: "/tmp/test-environment",
          workspaceProvisionType: "unmanaged",
        },
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

  it("queues workspace.squash_merge after checking status and diff, then returns the merge result", async () => {
    const harness = await createTestAppHarness();
    try {
      const { host } = seedHostSession(harness.deps);
      const { project } = seedProjectWithSource(harness.deps, {
        hostId: host.id,
      });
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
          mergeBaseRef: "abc1234",
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
        workspaceContext: {
          workspacePath: "/tmp/test-environment",
          workspaceProvisionType: "managed-worktree",
        },
        targetBranch: "main",
        commitMessage: "bb: squash merge",
      });
      await reportQueuedCommandSuccess(harness, mergeCommand, {
        merged: true,
        commitSha: "merge123",
        commitSubject: "bb: squash merge",
      });

      const response = await responsePromise;
      expect(response.status).toBe(200);
      await expect(readJson(response)).resolves.toMatchObject({
        ok: true,
        action: "squash_merge",
        merged: true,
        commitSha: "merge123",
        commitSubject: "bb: squash merge",
      });
    } finally {
      await harness.cleanup();
    }
  });

  it("rejects squash merge with 409 when workspace is in detached HEAD state", async () => {
    const harness = await createTestAppHarness();
    try {
      const { host } = seedHostSession(harness.deps);
      const { project } = seedProjectWithSource(harness.deps, {
        hostId: host.id,
      });
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
      const { project } = seedProjectWithSource(harness.deps, {
        hostId: host.id,
      });
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
            mergeBaseRef: null,
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
      const { project } = seedProjectWithSource(harness.deps, {
        hostId: host.id,
      });
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
          mergeBaseRef: "abc1234",
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
        commitSubject: "bb: squash merge",
      });

      const response = await responsePromise;
      expect(response.status).toBe(200);
      await expect(readJson(response)).resolves.toMatchObject({
        ok: true,
        action: "squash_merge",
        merged: true,
        commitSha: "squash-sha",
        commitSubject: "bb: squash merge",
      });
    } finally {
      await harness.cleanup();
    }
  });

  it("returns runtime config from GET /system/config", async () => {
    const harness = await createTestAppHarness({
      featureFlags: {
        askUserQuestion: true,
      },
      hostDaemonPort: 4010,
    });
    try {
      const response = await harness.app.request("/api/v1/system/config");
      expect(response.status).toBe(200);
      await expect(readJson(response)).resolves.toEqual({
        featureFlags: {
          askUserQuestion: true,
        },
        githubConnected: false,
        hostDaemonPort: 4010,
        sandboxHostSupported: true,
        voiceTranscriptionEnabled: true,
      });
    } finally {
      await harness.cleanup();
    }
  });

  it("reports sandbox provisioning as disabled when BB_EXTERNAL_URL is unset", async () => {
    const harness = await createTestAppHarness({
      externalUrl: undefined,
    });
    try {
      const response = await harness.app.request("/api/v1/system/config");
      expect(response.status).toBe(200);
      await expect(readJson(response)).resolves.toEqual({
        featureFlags: {
          askUserQuestion: false,
        },
        githubConnected: false,
        hostDaemonPort: 3001,
        sandboxHostSupported: false,
        voiceTranscriptionEnabled: true,
      });
    } finally {
      await harness.cleanup();
    }
  });

  it("lists sandbox backends and availability from GET /system/sandbox-backends", async () => {
    const harness = await createTestAppHarness({
      githubPat: "test-github-pat",
    });
    try {
      const response = await harness.app.request(
        "/api/v1/system/sandbox-backends",
      );
      expect(response.status).toBe(200);
      await expect(readJson(response)).resolves.toEqual([
        {
          available: true,
          capabilities: {
            supportsManagedClone: true,
            supportsManagedWorktree: false,
            supportsSuspend: true,
          },
          displayName: "E2B",
          id: "e2b",
        },
      ]);
    } finally {
      await harness.cleanup();
    }
  });

  it("marks sandbox backends unavailable when BB_EXTERNAL_URL is unset", async () => {
    const harness = await createTestAppHarness({
      githubPat: "test-github-pat",
      externalUrl: undefined,
    });
    try {
      const response = await harness.app.request(
        "/api/v1/system/sandbox-backends",
      );
      expect(response.status).toBe(200);
      await expect(readJson(response)).resolves.toEqual([
        {
          available: false,
          capabilities: {
            supportsManagedClone: true,
            supportsManagedWorktree: false,
            supportsSuspend: true,
          },
          displayName: "E2B",
          id: "e2b",
        },
      ]);
    } finally {
      await harness.cleanup();
    }
  });

  it("returns ok from GET /health", async () => {
    const harness = await createTestAppHarness();
    try {
      const response = await harness.app.request("/health");
      expect(response.status).toBe(200);
      await expect(readJson(response)).resolves.toEqual({ ok: true });
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
              supportsArchive: true,
              supportsRename: true,
              supportsServiceTier: true,
              supportedPermissionModes: ["full", "workspace-write", "readonly"],
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
            supportsArchive: true,
            supportsRename: true,
            supportsServiceTier: true,
            supportedPermissionModes: ["full", "workspace-write", "readonly"],
          },
          available: true,
        },
      ]);

      const executionOptionsPromise = harness.app.request(
        `/api/v1/system/execution-options?hostId=${host.id}&providerId=codex`,
      );
      const executionProvidersCommand = await waitForQueuedCommandAfter(
        harness,
        providersCommand.row.cursor,
        ({ command }) => command.type === "provider.list",
      );
      await reportQueuedCommandSuccess(harness, executionProvidersCommand, {
        providers: [
          {
            id: "codex",
            displayName: "Codex",
            capabilities: {
              supportsArchive: true,
              supportsRename: true,
              supportsServiceTier: true,
              supportedPermissionModes: ["full", "workspace-write", "readonly"],
            },
            available: true,
          },
          {
            id: "claude-code",
            displayName: "Claude Code",
            capabilities: {
              supportsArchive: true,
              supportsRename: true,
              supportsServiceTier: false,
              supportedPermissionModes: ["full"],
            },
            available: true,
          },
        ],
      });
      const executionModelsCommand = await waitForQueuedCommandAfter(
        harness,
        executionProvidersCommand.row.cursor,
        ({ command }) =>
          command.type === "provider.list_models" &&
          command.providerId === "codex",
      );
      await reportQueuedCommandSuccess(harness, executionModelsCommand, {
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
        selectedOnlyModels: [
          {
            id: "gpt-4o-mini-legacy",
            model: "gpt-4o-mini-legacy",
            displayName: "Legacy Mini",
            description: "Retired mini model retained for existing selections",
            supportedReasoningEfforts: [
              {
                reasoningEffort: "medium",
                description: "Balanced",
              },
            ],
            defaultReasoningEffort: "medium",
            isDefault: false,
          },
        ],
      });
      const executionOptionsResponse = await executionOptionsPromise;
      expect(executionOptionsResponse.status).toBe(200);
      await expect(readJson(executionOptionsResponse)).resolves.toEqual({
        providers: [
          expect.objectContaining({
            id: "codex",
          }),
          expect.objectContaining({
            id: "claude-code",
          }),
        ],
        models: [
          expect.objectContaining({
            id: "codex-mini",
          }),
        ],
        selectedOnlyModels: [
          expect.objectContaining({
            id: "gpt-4o-mini-legacy",
          }),
        ],
      });

      // A stale providerId falls back to the first provider in the list and
      // fetches that provider's models — the response still contains the full
      // providers list so the client can recover.
      const missingProviderOptionsPromise = harness.app.request(
        `/api/v1/system/execution-options?hostId=${host.id}&providerId=missing-provider`,
      );
      const missingProviderCommand = await waitForQueuedCommandAfter(
        harness,
        executionModelsCommand.row.cursor,
        ({ command }) => command.type === "provider.list",
      );
      await reportQueuedCommandSuccess(harness, missingProviderCommand, {
        providers: [
          {
            id: "claude-code",
            displayName: "Claude Code",
            capabilities: {
              supportsArchive: true,
              supportsRename: true,
              supportsServiceTier: false,
              supportedPermissionModes: ["full"],
            },
            available: true,
          },
        ],
      });
      const missingProviderModelsCommand = await waitForQueuedCommandAfter(
        harness,
        missingProviderCommand.row.cursor,
        ({ command }) =>
          command.type === "provider.list_models" &&
          command.providerId === "claude-code",
      );
      await reportQueuedCommandSuccess(harness, missingProviderModelsCommand, {
        models: [],
        selectedOnlyModels: [],
      });
      const missingProviderOptionsResponse =
        await missingProviderOptionsPromise;
      expect(missingProviderOptionsResponse.status).toBe(200);
      await expect(readJson(missingProviderOptionsResponse)).resolves.toEqual({
        providers: [
          expect.objectContaining({
            id: "claude-code",
          }),
        ],
        models: [],
        selectedOnlyModels: [],
      });
    } finally {
      await harness.cleanup();
    }
  });

  it("uses a persistent host for default system provider lookups", async () => {
    const harness = await createTestAppHarness();
    try {
      const { host } = seedHostSession(harness.deps, {
        id: "host-system-default-persistent",
      });
      const sandboxHost = upsertHost(harness.db, harness.hub, {
        externalId: "sandbox-system-default",
        id: "host-system-default-sandbox",
        name: "Default Sandbox Host",
        provider: "e2b",
        type: "ephemeral",
      });
      openSession(harness.db, harness.hub, {
        dataDir: "/tmp/bb-host-data/host-system-default-sandbox",
        heartbeatIntervalMs: 5_000,
        hostId: sandboxHost.id,
        hostName: sandboxHost.name,
        hostType: "ephemeral",
        instanceId: "instance-system-default-sandbox",
        leaseTimeoutMs: 30_000,
        protocolVersion: HOST_DAEMON_PROTOCOL_VERSION,
      });

      const providersPromise = harness.app.request("/api/v1/system/providers");
      const providersCommand = await waitForQueuedCommand(
        harness,
        (queued) =>
          queued.command.type === "provider.list" &&
          queued.row.hostId === host.id,
      );
      await reportQueuedCommandSuccess(
        harness,
        providersCommand,
        {
          providers: [
            {
              id: "codex",
              displayName: "Codex",
              capabilities: {
                supportsArchive: true,
                supportsRename: true,
                supportsServiceTier: true,
                supportedPermissionModes: [
                  "full",
                  "workspace-write",
                  "readonly",
                ],
              },
              available: true,
            },
          ],
        },
        { hostId: host.id },
      );

      expect((await providersPromise).status).toBe(200);
    } finally {
      await harness.cleanup();
    }
  });

  it("allows explicit ephemeral host system provider lookups", async () => {
    const harness = await createTestAppHarness();
    try {
      const sandboxHost = upsertHost(harness.db, harness.hub, {
        externalId: "sandbox-system-explicit",
        id: "host-system-explicit-sandbox",
        name: "Explicit Sandbox Host",
        provider: "e2b",
        type: "ephemeral",
      });
      openSession(harness.db, harness.hub, {
        dataDir: "/tmp/bb-host-data/host-system-explicit-sandbox",
        heartbeatIntervalMs: 5_000,
        hostId: sandboxHost.id,
        hostName: sandboxHost.name,
        hostType: "ephemeral",
        instanceId: "instance-system-explicit-sandbox",
        leaseTimeoutMs: 30_000,
        protocolVersion: HOST_DAEMON_PROTOCOL_VERSION,
      });
      harness.deps.sandboxRegistry.set(sandboxHost.id, {
        destroy: vi.fn().mockResolvedValue(undefined),
        extendTimeout: vi.fn().mockResolvedValue(undefined),
        externalId: sandboxHost.externalId ?? "sandbox-system-explicit",
        hostId: sandboxHost.id,
        resume: vi.fn().mockResolvedValue(undefined),
        suspend: vi.fn().mockResolvedValue(undefined),
      });

      const providersPromise = harness.app.request(
        `/api/v1/system/providers?hostId=${sandboxHost.id}`,
      );
      await reportNextRuntimeMaterialSyncSuccess(harness, {
        hostId: sandboxHost.id,
        hostType: "ephemeral",
      });
      const providersCommand = await waitForQueuedCommand(
        harness,
        (queued) =>
          queued.command.type === "provider.list" &&
          queued.row.hostId === sandboxHost.id,
      );
      await reportQueuedCommandSuccess(
        harness,
        providersCommand,
        {
          providers: [
            {
              id: "codex",
              displayName: "Codex",
              capabilities: {
                supportsArchive: true,
                supportsRename: true,
                supportsServiceTier: true,
                supportedPermissionModes: [
                  "full",
                  "workspace-write",
                  "readonly",
                ],
              },
              available: true,
            },
          ],
        },
        { hostId: sandboxHost.id, hostType: "ephemeral" },
      );

      expect((await providersPromise).status).toBe(200);
    } finally {
      await harness.cleanup();
    }
  });

  it("returns 502 when no persistent host is connected for default system provider lookup", async () => {
    const harness = await createTestAppHarness();
    try {
      const sandboxHost = upsertHost(harness.db, harness.hub, {
        externalId: "sandbox-system-no-persistent",
        id: "host-system-no-persistent-sandbox",
        name: "Only Sandbox Host",
        provider: "e2b",
        type: "ephemeral",
      });
      openSession(harness.db, harness.hub, {
        dataDir: "/tmp/bb-host-data/host-system-no-persistent-sandbox",
        heartbeatIntervalMs: 5_000,
        hostId: sandboxHost.id,
        hostName: sandboxHost.name,
        hostType: "ephemeral",
        instanceId: "instance-system-no-persistent-sandbox",
        leaseTimeoutMs: 30_000,
        protocolVersion: HOST_DAEMON_PROTOCOL_VERSION,
      });

      const response = await harness.app.request("/api/v1/system/providers");

      expect(response.status).toBe(502);
      await expect(readJson(response)).resolves.toMatchObject({
        code: "host_disconnected",
        message: "Persistent host is not connected",
      });
    } finally {
      await harness.cleanup();
    }
  });

  it("rejects destroyed hosts for system host lookups", async () => {
    const harness = await createTestAppHarness();
    try {
      const { host } = seedHostSession(harness.deps, {
        id: "host-system-destroyed",
      });
      updateHost(harness.db, harness.hub, host.id, {
        destroyedAt: Date.now(),
      });

      const response = await harness.app.request(
        `/api/v1/system/providers?hostId=${host.id}`,
      );

      expect(response.status).toBe(404);
      await expect(readJson(response)).resolves.toMatchObject({
        code: "host_not_found",
      });
    } finally {
      await harness.cleanup();
    }
  });

  it("rejects destroyed environment hosts for system execution-option lookups", async () => {
    const harness = await createTestAppHarness();
    try {
      const host = seedHost(harness.deps, {
        id: "host-system-env-destroyed",
      });
      const { project } = seedProjectWithSource(harness.deps, {
        hostId: host.id,
      });
      const environment = seedEnvironment(harness.deps, {
        hostId: host.id,
        projectId: project.id,
      });
      updateHost(harness.db, harness.hub, host.id, {
        destroyedAt: Date.now(),
      });

      const response = await harness.app.request(
        `/api/v1/system/execution-options?environmentId=${environment.id}&providerId=codex`,
      );

      expect(response.status).toBe(404);
      await expect(readJson(response)).resolves.toMatchObject({
        code: "host_not_found",
      });
    } finally {
      await harness.cleanup();
    }
  });

  it("rejects invalid system query params with a 400", async () => {
    const harness = await createTestAppHarness();
    try {
      const response = await harness.app.request(
        "/api/v1/system/execution-options?providerId=",
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
