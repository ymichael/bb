import type { AgentRuntime } from "@bb/agent-runtime";
import type { IWorkspace, ProvisionWorkspaceOpts } from "@bb/workspace";
import { describe, expect, it, vi } from "vitest";
import { RuntimeManager } from "./runtime-manager.js";

type CurrentBranchArgs = Parameters<IWorkspace["currentBranch"]>;
type GetStatusResult = Awaited<ReturnType<IWorkspace["getStatus"]>>;
type GetDiffResult = Awaited<ReturnType<IWorkspace["getDiff"]>>;
type CommitArgs = Parameters<IWorkspace["commit"]>;
type FetchArgs = Parameters<IWorkspace["fetch"]>;
type CheckpointArgs = Parameters<IWorkspace["checkpoint"]>;
type SquashMergeArgs = Parameters<IWorkspace["squashMergeInto"]>;
type PromoteArgs = Parameters<IWorkspace["promote"]>;
type DemoteArgs = Parameters<IWorkspace["demote"]>;
type ProvisionWorkspaceArgs = Parameters<
  (options: ProvisionWorkspaceOpts) => Promise<IWorkspace>
>;
type EnsureProviderArgs = Parameters<AgentRuntime["ensureProvider"]>[0];
type StartThreadArgs = Parameters<AgentRuntime["startThread"]>[0];
type ResumeThreadArgs = Parameters<AgentRuntime["resumeThread"]>[0];
type RunTurnArgs = Parameters<AgentRuntime["runTurn"]>[0];
type SteerTurnArgs = Parameters<AgentRuntime["steerTurn"]>[0];
type StopThreadArgs = Parameters<AgentRuntime["stopThread"]>[0];
type RenameThreadArgs = Parameters<AgentRuntime["renameThread"]>[0];
type ListModelsArgs = Parameters<AgentRuntime["listModels"]>[0];

function createFakeWorkspace(path: string) {
  const status: GetStatusResult = {
    workingTree: {
      hasUncommittedChanges: false,
      state: "clean",
      changedFiles: 0,
      insertions: 0,
      deletions: 0,
      files: [],
    },
    branch: {
      currentBranch: "main",
      defaultBranch: "main",
    },
    mergeBase: {
      mergeBaseBranch: "main",
      baseRef: "main",
      aheadCount: 0,
      behindCount: 0,
      hasCommittedUnmergedChanges: false,
      commits: [],
    },
  };
  const diff: GetDiffResult = {
    diff: "",
    truncated: false,
    shortstat: "",
    files: "",
  };
  const workspace = {
    path,
    managed: false,
    isGitRepo: true,
    isWorktree: false,
    currentBranch: vi.fn(
      async (..._args: CurrentBranchArgs) => "main",
    ),
    getStatus: vi.fn(async () => status),
    getDiff: vi.fn(async () => diff),
    getBranches: vi.fn(async () => ["main"]),
    commit: vi.fn(async (..._args: CommitArgs) => ({
      commitSha: "commit-1",
      commitSubject: "commit",
    })),
    reset: vi.fn(async () => undefined),
    fetch: vi.fn(async (..._args: FetchArgs) => undefined),
    checkpoint: vi.fn(async (..._args: CheckpointArgs) => ({
      commitSha: "commit-1",
      branchName: "main",
      remoteName: "origin",
    })),
    squashMergeInto: vi.fn(async (..._args: SquashMergeArgs) => ({
      merged: true,
      commitSha: "commit-1",
      targetBranch: "main",
    })),
    promote: vi.fn(async (..._args: PromoteArgs) => undefined),
    demote: vi.fn(async (..._args: DemoteArgs) => undefined),
    destroy: vi.fn(async () => undefined),
  } satisfies IWorkspace;

  return workspace;
}

function createFakeRuntime() {
  return {
    ensureProvider: vi.fn(async (_args: EnsureProviderArgs) => undefined),
    startThread: vi.fn(
      async (_args: StartThreadArgs) => ({ providerThreadId: "provider-1" }),
    ),
    resumeThread: vi.fn(
      async (_args: ResumeThreadArgs) => ({ providerThreadId: "provider-1" }),
    ),
    runTurn: vi.fn(async (_args: RunTurnArgs) => undefined),
    steerTurn: vi.fn(async (_args: SteerTurnArgs) => undefined),
    stopThread: vi.fn(async (_args: StopThreadArgs) => undefined),
    renameThread: vi.fn(async (_args: RenameThreadArgs) => undefined),
    listModels: vi.fn(async (_args: ListModelsArgs) => []),
    listRunningProviders: vi.fn((): string[] => []),
    shutdown: vi.fn(async () => undefined),
  } satisfies AgentRuntime;
}

function createProvisionWorkspaceMock(path: string) {
  return vi.fn(
    async (..._args: ProvisionWorkspaceArgs) => createFakeWorkspace(path),
  );
}

describe("RuntimeManager", () => {
  it("creates a runtime the first time an environment is requested", async () => {
    const provisionWorkspace = createProvisionWorkspaceMock("/tmp/env-1");
    const createRuntime = vi.fn(() => createFakeRuntime());
    const manager = new RuntimeManager({
      provisionWorkspace,
      createRuntime,
    });

    const entry = await manager.ensureEnvironment({
      environmentId: "env-1",
      workspacePath: "/tmp/env-1",
    });

    expect(provisionWorkspace).toHaveBeenCalledTimes(1);
    expect(createRuntime).toHaveBeenCalledTimes(1);
    expect(entry.path).toBe("/tmp/env-1");
  });

  it("reuses the existing runtime for subsequent requests", async () => {
    const provisionWorkspace = createProvisionWorkspaceMock("/tmp/env-1");
    const createRuntime = vi.fn(() => createFakeRuntime());
    const manager = new RuntimeManager({
      provisionWorkspace,
      createRuntime,
    });

    const first = await manager.ensureEnvironment({
      environmentId: "env-1",
      workspacePath: "/tmp/env-1",
    });
    const second = await manager.ensureEnvironment({
      environmentId: "env-1",
      workspacePath: "/tmp/env-1",
    });

    expect(second).toBe(first);
    expect(provisionWorkspace).toHaveBeenCalledTimes(1);
    expect(createRuntime).toHaveBeenCalledTimes(1);
  });

  it("shuts down the runtime and destroys the workspace", async () => {
    const workspace = createFakeWorkspace("/tmp/env-1");
    const runtime = createFakeRuntime();
    const manager = new RuntimeManager({
      provisionWorkspace: createProvisionWorkspaceMock("/tmp/env-1").mockResolvedValue(
        workspace,
      ),
      createRuntime: vi.fn(() => runtime),
    });

    await manager.ensureEnvironment({
      environmentId: "env-1",
      workspacePath: "/tmp/env-1",
    });
    await manager.destroyEnvironment("env-1");

    expect(runtime.shutdown).toHaveBeenCalledTimes(1);
    expect(workspace.destroy).toHaveBeenCalledTimes(1);
  });

  it("tracks active threads for session reconciliation", async () => {
    const manager = new RuntimeManager({
      provisionWorkspace: createProvisionWorkspaceMock("/tmp/env-1"),
      createRuntime: vi.fn(() => createFakeRuntime()),
    });

    await manager.ensureEnvironment({
      environmentId: "env-1",
      workspacePath: "/tmp/env-1",
    });

    manager.markThreadActive("env-1", "thread-1", "provider-1");
    expect(manager.listActiveThreads()).toEqual([
      {
        threadId: "thread-1",
      },
    ]);

    manager.markThreadInactive("env-1", "thread-1");
    expect(manager.listActiveThreads()).toEqual([]);
  });

  it("remembers known threads after a turn completes so follow-ups reuse the runtime", async () => {
    const manager = new RuntimeManager({
      provisionWorkspace: createProvisionWorkspaceMock("/tmp/env-1"),
      createRuntime: vi.fn(() => createFakeRuntime()),
    });

    await manager.ensureEnvironment({
      environmentId: "env-1",
      workspacePath: "/tmp/env-1",
    });

    manager.markThreadActive("env-1", "thread-1", "provider-1");
    manager.markThreadInactive("env-1", "thread-1");

    expect(manager.hasThread("env-1", "thread-1")).toBe(true);
    expect(manager.listActiveThreads()).toEqual([]);

    manager.markThreadActive("env-1", "thread-1", "provider-1");
    expect(manager.listActiveThreads()).toEqual([
      {
        threadId: "thread-1",
      },
    ]);
  });

  it("removes stale entries when the provider process exits", async () => {
    const workspace = createFakeWorkspace("/tmp/env-exit");
    const runtime = createFakeRuntime();
    let onProcessExit:
      | ((info: {
          code: number | null;
          providerId: string;
          signal: string | null;
          threadIds: string[];
        }) => void)
      | undefined;
    const manager = new RuntimeManager({
      provisionWorkspace: createProvisionWorkspaceMock("/tmp/env-exit").mockResolvedValue(
        workspace,
      ),
      createRuntime: vi.fn((options) => {
        onProcessExit = options.onProcessExit;
        return runtime;
      }),
    });

    await manager.ensureEnvironment({
      environmentId: "env-exit",
      workspacePath: "/tmp/env-exit",
    });
    manager.markThreadActive("env-exit", "thread-1", "provider-1");

    onProcessExit?.({
      providerId: "fake",
      threadIds: ["thread-1"],
      code: 1,
      signal: null,
    });

    expect(manager.get("env-exit")).toBeUndefined();
    expect(manager.hasThread("env-exit", "thread-1")).toBe(false);
    expect(runtime.shutdown).not.toHaveBeenCalled();
  });

  it("keeps sibling provider threads running when one provider exits", async () => {
    const workspace = createFakeWorkspace("/tmp/env-shared");
    const runtime = createFakeRuntime();
    let runningProviders = ["fake-alpha", "fake-beta"];
    runtime.listRunningProviders.mockImplementation(() => runningProviders);
    let onProcessExit:
      | ((info: {
          code: number | null;
          providerId: string;
          signal: string | null;
          threadIds: string[];
        }) => void)
      | undefined;
    const manager = new RuntimeManager({
      provisionWorkspace: createProvisionWorkspaceMock("/tmp/env-shared").mockResolvedValue(
        workspace,
      ),
      createRuntime: vi.fn((options) => {
        onProcessExit = options.onProcessExit;
        return runtime;
      }),
    });

    await manager.ensureEnvironment({
      environmentId: "env-shared",
      workspacePath: "/tmp/env-shared",
    });
    manager.markThreadActive("env-shared", "thread-a", "provider-a");
    manager.markThreadActive("env-shared", "thread-b", "provider-b");

    runningProviders = ["fake-beta"];
    onProcessExit?.({
      providerId: "fake-alpha",
      threadIds: ["thread-a"],
      code: 1,
      signal: null,
    });

    expect(manager.get("env-shared")).toBeDefined();
    expect(manager.hasThread("env-shared", "thread-a")).toBe(false);
    expect(manager.hasThread("env-shared", "thread-b")).toBe(true);
    expect(runtime.shutdown).not.toHaveBeenCalled();
  });

  it("shuts down all tracked environments", async () => {
    const workspaceA = createFakeWorkspace("/tmp/env-a");
    const workspaceB = createFakeWorkspace("/tmp/env-b");
    const runtimeA = createFakeRuntime();
    const runtimeB = createFakeRuntime();
    const provisionWorkspace = createProvisionWorkspaceMock("/tmp/env-a")
      .mockResolvedValueOnce(workspaceA)
      .mockResolvedValueOnce(workspaceB);
    const createRuntime = vi
      .fn()
      .mockReturnValueOnce(runtimeA)
      .mockReturnValueOnce(runtimeB);
    const manager = new RuntimeManager({
      provisionWorkspace,
      createRuntime,
    });

    await manager.ensureEnvironment({
      environmentId: "env-a",
      workspacePath: "/tmp/env-a",
    });
    await manager.ensureEnvironment({
      environmentId: "env-b",
      workspacePath: "/tmp/env-b",
    });

    await manager.shutdownAll();

    expect(runtimeA.shutdown).toHaveBeenCalledTimes(1);
    expect(runtimeB.shutdown).toHaveBeenCalledTimes(1);
    // shutdownAll does NOT destroy workspaces — the server owns managed
    // workspace lifecycle via explicit environment.destroy commands
    expect(workspaceA.destroy).not.toHaveBeenCalled();
    expect(workspaceB.destroy).not.toHaveBeenCalled();
  });
});
