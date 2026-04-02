import type { AgentRuntime } from "@bb/agent-runtime";
import type { IWorkspace, ProvisionWorkspaceOpts } from "@bb/workspace";
import { describe, expect, it, vi } from "vitest";
import { RuntimeManager } from "./runtime-manager.js";

type CurrentBranchArgs = Parameters<IWorkspace["currentBranch"]>;
type GetStatusResult = Awaited<ReturnType<IWorkspace["getStatus"]>>;
type GetDiffResult = Awaited<ReturnType<IWorkspace["getDiff"]>>;
type WatchStatusArgs = Parameters<IWorkspace["watchStatus"]>;
type StopWatchingStatus = ReturnType<IWorkspace["watchStatus"]>;
type CommitArgs = Parameters<IWorkspace["commit"]>;
type FetchArgs = Parameters<IWorkspace["fetch"]>;
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

function createFakeWorkspace(
  path: string,
  options: {
    watchStatus?: (...args: WatchStatusArgs) => StopWatchingStatus;
  } = {},
) {
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
  const watchStatus =
    options.watchStatus ??
    vi.fn((_onChange: WatchStatusArgs[0]) => () => undefined);
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
    watchStatus: vi.fn(watchStatus),
    commit: vi.fn(async (..._args: CommitArgs) => ({
      commitSha: "commit-1",
      commitSubject: "commit",
    })),
    reset: vi.fn(async () => undefined),
    fetch: vi.fn(async (..._args: FetchArgs) => undefined),
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
    const stopWatchingStatus = vi.fn(() => undefined);
    const workspace = createFakeWorkspace("/tmp/env-1", {
      watchStatus: (_args) => stopWatchingStatus,
    });
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
    expect(workspace.watchStatus).toHaveBeenCalledTimes(1);
    expect(stopWatchingStatus).toHaveBeenCalledTimes(1);
    expect(workspace.destroy).toHaveBeenCalledTimes(1);
  });

  it("installs the workspace status watcher once and reports workspace status changes", async () => {
    const stopWatchingStatus = vi.fn(() => undefined);
    let watchStatusArgs: WatchStatusArgs[0] | undefined;
    const workspace = createFakeWorkspace("/tmp/env-watch", {
      watchStatus: (args) => {
        watchStatusArgs = args;
        return stopWatchingStatus;
      },
    });
    const onWorkspaceStatusChanged = vi.fn();
    const manager = new RuntimeManager({
      provisionWorkspace: createProvisionWorkspaceMock("/tmp/env-watch").mockResolvedValue(
        workspace,
      ),
      createRuntime: vi.fn(() => createFakeRuntime()),
      onWorkspaceStatusChanged,
    });

    await manager.ensureEnvironment({
      environmentId: "env-watch",
      workspacePath: "/tmp/env-watch",
    });
    await manager.ensureEnvironment({
      environmentId: "env-watch",
      workspacePath: "/tmp/env-watch",
    });
    watchStatusArgs?.onChange();

    expect(workspace.watchStatus).toHaveBeenCalledTimes(1);
    expect(onWorkspaceStatusChanged).toHaveBeenCalledWith({
      environmentId: "env-watch",
    });
    expect(stopWatchingStatus).not.toHaveBeenCalled();
  });

  it("forwards workspace watch startup failures with the environment id", async () => {
    const stopWatchingStatus = vi.fn(() => undefined);
    let watchStatusArgs: WatchStatusArgs[0] | undefined;
    const workspace = createFakeWorkspace("/tmp/env-watch", {
      watchStatus: (args) => {
        watchStatusArgs = args;
        return stopWatchingStatus;
      },
    });
    const onWorkspaceStatusWatchError = vi.fn();
    const manager = new RuntimeManager({
      provisionWorkspace: createProvisionWorkspaceMock("/tmp/env-watch").mockResolvedValue(
        workspace,
      ),
      createRuntime: vi.fn(() => createFakeRuntime()),
      onWorkspaceStatusWatchError,
    });

    await manager.ensureEnvironment({
      environmentId: "env-watch",
      workspacePath: "/tmp/env-watch",
    });

    watchStatusArgs?.onWatchError?.({
      message: "Error starting FSEvents stream",
      rootPath: "/tmp/env-watch",
    });

    expect(onWorkspaceStatusWatchError).toHaveBeenCalledWith({
      environmentId: "env-watch",
      error: {
        message: "Error starting FSEvents stream",
        rootPath: "/tmp/env-watch",
      },
    });
    expect(stopWatchingStatus).not.toHaveBeenCalled();
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
    const stopWatchingStatus = vi.fn(() => undefined);
    const workspace = createFakeWorkspace("/tmp/env-exit", {
      watchStatus: (_args) => stopWatchingStatus,
    });
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
    expect(stopWatchingStatus).toHaveBeenCalledTimes(1);
    expect(runtime.shutdown).not.toHaveBeenCalled();
  });

  it("keeps sibling provider threads running when one provider exits", async () => {
    const stopWatchingStatus = vi.fn(() => undefined);
    const workspace = createFakeWorkspace("/tmp/env-shared", {
      watchStatus: (_args) => stopWatchingStatus,
    });
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
    expect(stopWatchingStatus).not.toHaveBeenCalled();
    expect(runtime.shutdown).not.toHaveBeenCalled();
  });

  it("shuts down all tracked environments", async () => {
    const stopWatchingStatusA = vi.fn(() => undefined);
    const stopWatchingStatusB = vi.fn(() => undefined);
    const workspaceA = createFakeWorkspace("/tmp/env-a", {
      watchStatus: (_args) => stopWatchingStatusA,
    });
    const workspaceB = createFakeWorkspace("/tmp/env-b", {
      watchStatus: (_args) => stopWatchingStatusB,
    });
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
    expect(stopWatchingStatusA).toHaveBeenCalledTimes(1);
    expect(stopWatchingStatusB).toHaveBeenCalledTimes(1);
    // shutdownAll does NOT destroy workspaces — the server owns managed
    // workspace lifecycle via explicit environment.destroy commands
    expect(workspaceA.destroy).not.toHaveBeenCalled();
    expect(workspaceB.destroy).not.toHaveBeenCalled();
  });
});
