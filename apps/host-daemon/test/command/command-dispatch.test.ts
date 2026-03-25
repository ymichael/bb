import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { AgentRuntime } from "@bb/agent-runtime";
import type { IWorkspace, ProvisionWorkspaceOpts } from "@bb/workspace";
import { afterEach, describe, expect, it } from "vitest";
import { dispatchCommand } from "../../src/command-dispatch.js";
import { RuntimeManager } from "../../src/runtime-manager.js";

const tempDirs: string[] = [];

function createFakeWorkspace(pathname: string) {
  const state = {
    statusReads: 0,
    lastDiffSelection: undefined as unknown,
    lastCommitMessage: undefined as string | undefined,
    resetCount: 0,
    lastCheckpointMessage: undefined as string | undefined,
    promotedPrimaryPath: undefined as string | undefined,
    demotedPrimaryPath: undefined as string | undefined,
    demotedDefaultBranch: undefined as string | undefined,
    destroyed: false,
  };
  const workspace = {
    path: pathname,
    managed: false,
    isGitRepo: true,
    isWorktree: false,
    async currentBranch() {
      return "main";
    },
    async getStatus() {
      state.statusReads += 1;
      return {
        state: "clean" as const,
        changedFiles: 0,
        insertions: 0,
        deletions: 0,
        workspaceChangedFiles: 0,
        workspaceInsertions: 0,
        workspaceDeletions: 0,
        hasUncommittedChanges: false,
        hasCommittedUnmergedChanges: false,
        aheadCount: 0,
        behindCount: 0,
        currentBranch: "main",
        defaultBranch: "main",
        mergeBaseBranch: "main",
        mergeBaseBranches: [],
        baseRef: "main",
        files: [],
      };
    },
    async getDiff(options?: { selection?: unknown }) {
      state.lastDiffSelection = options?.selection;
      return {
        mode: "combined" as const,
        currentBranch: "main",
        mergeBaseBranch: "main",
        mergeBaseRef: "main",
        commits: [],
        selection: { type: "combined" as const },
        diff: "",
        truncated: false,
      };
    },
    async getBranches() {
      return ["main"];
    },
    async commit(options: { message: string }) {
      state.lastCommitMessage = options.message;
      return {
        commitSha: "commit-1",
        commitSubject: options.message,
      };
    },
    async reset() {
      state.resetCount += 1;
    },
    async fetch() {},
    async checkpoint(options: { commitMessage: string; remoteName?: string }) {
      state.lastCheckpointMessage = options.commitMessage;
      return {
        commitSha: "checkpoint-1",
        branchName: "main",
        remoteName: options.remoteName ?? "origin",
      };
    },
    async squashMergeInto(options: { targetBranch: string }) {
      return {
        merged: true,
        commitSha: `merge-${options.targetBranch}`,
        targetBranch: options.targetBranch,
      };
    },
    async promote(primary: IWorkspace) {
      state.promotedPrimaryPath = primary.path;
    },
    async demote(primary: IWorkspace, defaultBranch: string) {
      state.demotedPrimaryPath = primary.path;
      state.demotedDefaultBranch = defaultBranch;
    },
    async destroy() {
      state.destroyed = true;
    },
  } as unknown as IWorkspace;

  return { workspace, state };
}

function createFakeRuntime() {
  const state = {
    startedThreadId: undefined as string | undefined,
    resumedThreadId: undefined as string | undefined,
    resumedProviderThreadId: undefined as string | undefined,
    ranTurnText: undefined as string | undefined,
    steeredTurnId: undefined as string | undefined,
    stoppedThreadId: undefined as string | undefined,
    renamedTitle: undefined as string | undefined,
    shutdownCount: 0,
  };
  const runtime = {
    async ensureProvider() {},
    async startThread(args: { threadId: string }) {
      state.startedThreadId = args.threadId;
      return { providerThreadId: `provider-${args.threadId}` };
    },
    async resumeThread(args: { threadId: string; providerThreadId?: string }) {
      state.resumedThreadId = args.threadId;
      state.resumedProviderThreadId = args.providerThreadId;
      return { providerThreadId: args.providerThreadId };
    },
    async runTurn(args: { input: Array<{ type: string; text: string }> }) {
      state.ranTurnText = args.input[0]?.text;
    },
    async steerTurn(args: { expectedTurnId: string }) {
      state.steeredTurnId = args.expectedTurnId;
    },
    async stopThread(args: { threadId: string }) {
      state.stoppedThreadId = args.threadId;
    },
    async renameThread(args: { title: string }) {
      state.renamedTitle = args.title;
    },
    async shutdown() {
      state.shutdownCount += 1;
    },
  };

  return {
    runtime: runtime as unknown as AgentRuntime,
    state,
  };
}

function createHarness(args: {
  workspacePath?: string;
  currentBranch?: string;
  isWorktree?: boolean;
} = {}) {
  const { workspace, state: workspaceState } = createFakeWorkspace(
    args.workspacePath ?? "/tmp/env-1",
  );
  workspace.currentBranch = async () => args.currentBranch ?? "main";
  (workspace as { isWorktree: boolean }).isWorktree = args.isWorktree ?? false;
  const { runtime, state: runtimeState } = createFakeRuntime();
  const provisions: ProvisionWorkspaceOpts[] = [];
  const manager = new RuntimeManager({
    provisionWorkspace: async (options) => {
      provisions.push(options);
      if ("path" in options && options.path !== workspace.path) {
        return createFakeWorkspace(options.path).workspace;
      }
      return workspace;
    },
    createRuntime: () => runtime,
  });

  return {
    manager,
    provisions,
    runtimeState,
    workspaceState,
    workspace,
  };
}

async function makeTempDir(prefix: string): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

afterEach(async () => {
  await Promise.all(
    tempDirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })),
  );
});

describe("dispatchCommand", () => {
  it("covers thread lifecycle commands", async () => {
    const harness = createHarness();

    const startResult = await dispatchCommand(
      {
        type: "thread.start",
        environmentId: "env-1",
        threadId: "thread-1",
        workspacePath: "/tmp/env-1",
        projectId: "project-1",
        providerId: "fake",
      },
      { runtimeManager: harness.manager },
    );
    const resumeResult = await dispatchCommand(
      {
        type: "thread.resume",
        environmentId: "env-1",
        threadId: "thread-1",
        workspacePath: "/tmp/env-1",
        providerThreadId: "provider-1",
      },
      { runtimeManager: harness.manager },
    );
    const renameResult = await dispatchCommand(
      {
        type: "thread.rename",
        environmentId: "env-1",
        threadId: "thread-1",
        title: "Renamed",
      },
      { runtimeManager: harness.manager },
    );
    const stopResult = await dispatchCommand(
      {
        type: "thread.stop",
        environmentId: "env-1",
        threadId: "thread-1",
      },
      { runtimeManager: harness.manager },
    );

    expect(startResult).toEqual({ providerThreadId: "provider-thread-1" });
    expect(resumeResult).toEqual({ providerThreadId: "provider-1" });
    expect(renameResult).toEqual({});
    expect(stopResult).toEqual({});
    expect(harness.runtimeState.startedThreadId).toBe("thread-1");
    expect(harness.runtimeState.resumedThreadId).toBe("thread-1");
    expect(harness.runtimeState.renamedTitle).toBe("Renamed");
    expect(harness.runtimeState.stoppedThreadId).toBe("thread-1");
    expect(harness.manager.listActiveThreads()).toEqual([]);
  });

  it("covers turn.run and turn.steer", async () => {
    const harness = createHarness();
    await harness.manager.ensureEnvironment({
      environmentId: "env-1",
      workspacePath: "/tmp/env-1",
    });
    harness.manager.markThreadActive("env-1", "thread-1", "provider-1");

    const runResult = await dispatchCommand(
      {
        type: "turn.run",
        environmentId: "env-1",
        threadId: "thread-1",
        input: [{ type: "text", text: "hello" }],
      },
      { runtimeManager: harness.manager },
    );
    const steerResult = await dispatchCommand(
      {
        type: "turn.steer",
        environmentId: "env-1",
        threadId: "thread-1",
        expectedTurnId: "turn-1",
        input: [{ type: "text", text: "adjust" }],
      },
      { runtimeManager: harness.manager },
    );

    expect(runResult).toEqual({});
    expect(steerResult).toEqual({});
    expect(harness.runtimeState.ranTurnText).toBe("hello");
    expect(harness.runtimeState.steeredTurnId).toBe("turn-1");
  });

  it("lazily resumes a missing thread runtime before turn.run", async () => {
    const harness = createHarness({ workspacePath: "/tmp/env-lazy" });

    const result = await dispatchCommand(
      {
        type: "turn.run",
        environmentId: "env-lazy",
        threadId: "thread-1",
        input: [{ type: "text", text: "hello" }],
      },
      {
        runtimeManager: harness.manager,
        resolveThreadRuntime: async () => ({
          workspacePath: "/tmp/env-lazy",
          projectId: "project-1",
          providerId: "fake",
          providerThreadId: "provider-1",
        }),
      },
    );

    expect(result).toEqual({});
    expect(harness.provisions).toEqual([
      {
        workspaceProvisionType: "unmanaged",
        path: "/tmp/env-lazy",
      },
    ]);
    expect(harness.runtimeState.resumedProviderThreadId).toBe("provider-1");
    expect(harness.runtimeState.ranTurnText).toBe("hello");
  });

  it("covers provider.list_models", async () => {
    const harness = createHarness();

    const result = await dispatchCommand(
      {
        type: "provider.list_models",
        providerId: "fake",
      },
      {
        runtimeManager: harness.manager,
        listModels: async () => [
          {
            id: "model-1",
            model: "model-1",
            displayName: "Model 1",
            description: "Test model",
            supportedReasoningEfforts: [],
            defaultReasoningEffort: "medium",
            isDefault: true,
          },
        ],
      },
    );

    expect(result).toEqual({
      models: [
        {
          id: "model-1",
          model: "model-1",
          displayName: "Model 1",
          description: "Test model",
          supportedReasoningEfforts: [],
          defaultReasoningEffort: "medium",
          isDefault: true,
        },
      ],
    });
  });

  it("covers environment.provision in unmanaged mode", async () => {
    const harness = createHarness({ workspacePath: "/tmp/unmanaged" });
    const sourcePath = await makeTempDir("bb-dispatch-unmanaged-");

    const result = await dispatchCommand(
      {
        type: "environment.provision",
        environmentId: "env-unmanaged",
        projectId: "project-1",
        workspaceProvisionType: "unmanaged",
        path: sourcePath,
      },
      { runtimeManager: harness.manager },
    );

    expect(result).toEqual({
      path: sourcePath,
      isGitRepo: true,
      isWorktree: false,
      branchName: "main",
      ranSetup: false,
    });
    expect(harness.provisions).toEqual([
      {
        workspaceProvisionType: "unmanaged",
        path: sourcePath,
      },
    ]);
  });

  it("covers environment.provision in managed-worktree mode", async () => {
    const harness = createHarness({ workspacePath: "/tmp/worktree", isWorktree: true });
    const sourcePath = await makeTempDir("bb-dispatch-worktree-");

    const result = await dispatchCommand(
      {
        type: "environment.provision",
        environmentId: "env-worktree",
        projectId: "project-1",
        workspaceProvisionType: "managed-worktree",
        sourcePath,
        targetPath: "/tmp/worktree",
        branchName: "bb/test",
        scriptName: "setup.sh",
        timeoutMs: 60_000,
      },
      { runtimeManager: harness.manager },
    );

    expect(result).toEqual({
      path: "/tmp/worktree",
      isGitRepo: true,
      isWorktree: true,
      branchName: "main",
      ranSetup: false,
    });
    expect(harness.provisions).toEqual([
      {
        workspaceProvisionType: "managed-worktree",
        sourcePath,
        targetPath: "/tmp/worktree",
        branchName: "bb/test",
        scriptName: "setup.sh",
        timeoutMs: 60_000,
      },
    ]);
  });

  it("covers environment.provision in managed-clone mode", async () => {
    const harness = createHarness({ workspacePath: "/tmp/clone", isWorktree: false });
    const sourcePath = await makeTempDir("bb-dispatch-clone-");

    const result = await dispatchCommand(
      {
        type: "environment.provision",
        environmentId: "env-clone",
        projectId: "project-1",
        workspaceProvisionType: "managed-clone",
        sourcePath,
        targetPath: "/tmp/clone",
        branchName: "bb/clone",
      },
      { runtimeManager: harness.manager },
    );

    expect(result).toEqual({
      path: "/tmp/clone",
      isGitRepo: true,
      isWorktree: false,
      branchName: "main",
      ranSetup: false,
    });
    expect(harness.provisions).toEqual([
      {
        workspaceProvisionType: "managed-clone",
        sourcePath,
        targetPath: "/tmp/clone",
        branchName: "bb/clone",
        scriptName: undefined,
        timeoutMs: undefined,
      },
    ]);
  });

  it("covers environment.destroy", async () => {
    const harness = createHarness();
    await harness.manager.ensureEnvironment({
      environmentId: "env-1",
      workspacePath: "/tmp/env-1",
    });

    const result = await dispatchCommand(
      {
        type: "environment.destroy",
        environmentId: "env-1",
        path: "/tmp/env-1",
        workspaceProvisionType: "managed-worktree",
      },
      { runtimeManager: harness.manager },
    );

    expect(result).toEqual({});
    expect(harness.runtimeState.shutdownCount).toBe(1);
    expect(harness.workspaceState.destroyed).toBe(true);
  });

  it("covers workspace command results", async () => {
    const harness = createHarness();
    await harness.manager.ensureEnvironment({
      environmentId: "env-1",
      workspacePath: "/tmp/env-1",
    });

    const statusResult = await dispatchCommand(
      {
        type: "workspace.status",
        environmentId: "env-1",
        threadId: "thread-1",
      },
      { runtimeManager: harness.manager },
    );
    const diffResult = await dispatchCommand(
      {
        type: "workspace.diff",
        environmentId: "env-1",
        threadId: "thread-1",
      },
      { runtimeManager: harness.manager },
    );
    const commitResult = await dispatchCommand(
      {
        type: "workspace.commit",
        environmentId: "env-1",
        threadId: "thread-1",
        message: "Commit message",
      },
      { runtimeManager: harness.manager },
    );
    const squashResult = await dispatchCommand(
      {
        type: "workspace.squash_merge",
        environmentId: "env-1",
        threadId: "thread-1",
        targetBranch: "main",
        commitMessage: "Squash",
      },
      { runtimeManager: harness.manager },
    );
    const resetResult = await dispatchCommand(
      {
        type: "workspace.reset",
        environmentId: "env-1",
        threadId: "thread-1",
      },
      { runtimeManager: harness.manager },
    );
    const checkpointResult = await dispatchCommand(
      {
        type: "workspace.checkpoint",
        environmentId: "env-1",
        threadId: "thread-1",
        commitMessage: "Checkpoint",
      },
      { runtimeManager: harness.manager },
    );
    const promoteResult = await dispatchCommand(
      {
        type: "workspace.promote",
        environmentId: "env-1",
        threadId: "thread-1",
        primaryPath: "/tmp/primary",
      },
      { runtimeManager: harness.manager },
    );
    const demoteResult = await dispatchCommand(
      {
        type: "workspace.demote",
        environmentId: "env-1",
        threadId: "thread-1",
        primaryPath: "/tmp/primary",
        defaultBranch: "main",
        envBranch: "feature",
      },
      { runtimeManager: harness.manager },
    );

    expect(statusResult.workspaceStatus?.state).toBe("clean");
    expect(diffResult.diff.diff).toBe("");
    expect(commitResult).toEqual({
      commitSha: "commit-1",
      commitSubject: "Commit message",
    });
    expect(squashResult).toEqual({
      merged: true,
      commitSha: "merge-main",
    });
    expect(resetResult).toEqual({});
    expect(checkpointResult).toEqual({
      commitSha: "checkpoint-1",
      branchName: "main",
      remoteName: "origin",
    });
    expect(promoteResult).toEqual({ ok: true });
    expect(demoteResult).toEqual({ ok: true });
    expect(harness.workspaceState.statusReads).toBe(1);
    expect(harness.workspaceState.lastCommitMessage).toBe("Commit message");
    expect(harness.workspaceState.resetCount).toBe(1);
    expect(harness.workspaceState.lastCheckpointMessage).toBe("Checkpoint");
    expect(harness.workspaceState.promotedPrimaryPath).toBe("/tmp/primary");
    expect(harness.workspaceState.demotedPrimaryPath).toBe("/tmp/primary");
    expect(harness.workspaceState.demotedDefaultBranch).toBe("main");
    expect(harness.provisions.at(-1)).toEqual({
      workspaceProvisionType: "unmanaged",
      path: "/tmp/primary",
    });
  });
});
