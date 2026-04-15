import type { AgentRuntime } from "@bb/agent-runtime";
import type {
  HostWatcher,
  ThreadStorageWatchError,
  WatchThreadStorageRootArgs,
  WatchWorkspaceArgs,
  WorkspaceWatchError,
} from "@bb/host-watcher";
import type {
  HostWorkspace,
  ProvisionWorkspaceArgs,
} from "@bb/host-workspace";
import { describe, expect, it, vi } from "vitest";
import { RuntimeManager } from "./runtime-manager.js";

type GetCurrentBranchArgs = Parameters<HostWorkspace["getCurrentBranch"]>;
type GetStatusResult = Awaited<ReturnType<HostWorkspace["getStatus"]>>;
type GetDiffResult = Awaited<ReturnType<HostWorkspace["getDiff"]>>;
type GetLocalStateFingerprintResult = Awaited<
  ReturnType<HostWorkspace["getLocalStateFingerprint"]>
>;
type GetSharedGitRefsFingerprintResult = Awaited<
  ReturnType<HostWorkspace["getSharedGitRefsFingerprint"]>
>;
type CommitArgs = Parameters<HostWorkspace["commit"]>;
type FetchArgs = Parameters<HostWorkspace["fetch"]>;
type SquashMergeArgs = Parameters<HostWorkspace["squashMerge"]>;
type PromoteArgs = Parameters<HostWorkspace["promote"]>;
type DemoteArgs = Parameters<HostWorkspace["demote"]>;
type ProvisionWorkspaceMockArgs = Parameters<
  (options: ProvisionWorkspaceArgs) => Promise<HostWorkspace>
>;
type EnsureProviderArgs = Parameters<AgentRuntime["ensureProvider"]>[0];
type StartThreadArgs = Parameters<AgentRuntime["startThread"]>[0];
type ResumeThreadArgs = Parameters<AgentRuntime["resumeThread"]>[0];
type RunTurnArgs = Parameters<AgentRuntime["runTurn"]>[0];
type SteerTurnArgs = Parameters<AgentRuntime["steerTurn"]>[0];
type StopThreadArgs = Parameters<AgentRuntime["stopThread"]>[0];
type RenameThreadArgs = Parameters<AgentRuntime["renameThread"]>[0];
type ListModelsArgs = Parameters<AgentRuntime["listModels"]>[0];
type StopWatchingStatus = () => void;
type StopWatchingPathChanges = () => void;
type WatchWorkspaceImplementation = (
  args: WatchWorkspaceArgs,
) => StopWatchingStatus;
type WatchThreadStorageRootImplementation = (
  args: WatchThreadStorageRootArgs,
) => StopWatchingPathChanges;

function createDeferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((innerResolve, innerReject) => {
    resolve = innerResolve;
    reject = innerReject;
  });
  return {
    promise,
    reject,
    resolve,
  };
}

function getProvisionWorkspacePath(args: ProvisionWorkspaceArgs): string {
  switch (args.workspaceProvisionType) {
    case "managed-clone":
    case "managed-worktree":
      return args.targetPath;
    case "reconnect-managed-clone":
    case "reconnect-managed-worktree":
    case "unmanaged":
      return args.path;
  }
}

function createFakeWorkspace(
  path: string,
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
  let localStateFingerprint: GetLocalStateFingerprintResult = `local:${path}:initial`;
  let localStateFingerprintError: Error | null = null;
  let sharedGitRefsFingerprint: GetSharedGitRefsFingerprintResult = `refs:${path}:initial`;
  let sharedGitRefsFingerprintError: Error | null = null;
  const workspace = {
    path,
    managed: false,
    isGitRepo: true,
    isWorktree: false,
    getCurrentBranch: vi.fn(
      async (..._args: GetCurrentBranchArgs) => "main",
    ),
    getHeadSha: vi.fn(async () => "commit-1"),
    getLocalStateFingerprint: vi.fn(async () => {
      if (localStateFingerprintError) {
        throw localStateFingerprintError;
      }
      return localStateFingerprint;
    }),
    getSharedGitRefsFingerprint: vi.fn(async () => {
      if (sharedGitRefsFingerprintError) {
        throw sharedGitRefsFingerprintError;
      }
      return sharedGitRefsFingerprint;
    }),
    getStatus: vi.fn(async () => status),
    getDiff: vi.fn(async () => diff),
    listBranches: vi.fn(async () => ["main"]),
    listFiles: vi.fn(async () => []),
    commit: vi.fn(async (..._args: CommitArgs) => ({
      commitSha: "commit-1",
      commitSubject: "commit",
    })),
    reset: vi.fn(async () => undefined),
    fetch: vi.fn(async (..._args: FetchArgs) => undefined),
    squashMerge: vi.fn(async (..._args: SquashMergeArgs) => ({
      merged: true,
      commitSha: "commit-1",
      targetBranch: "main",
    })),
    setLocalStateFingerprint(value: GetLocalStateFingerprintResult) {
      localStateFingerprint = value;
    },
    setLocalStateFingerprintError(value: Error | null) {
      localStateFingerprintError = value;
    },
    setSharedGitRefsFingerprint(value: GetSharedGitRefsFingerprintResult) {
      sharedGitRefsFingerprint = value;
    },
    setSharedGitRefsFingerprintError(value: Error | null) {
      sharedGitRefsFingerprintError = value;
    },
    promote: vi.fn(async (..._args: PromoteArgs) => undefined),
    demote: vi.fn(async (..._args: DemoteArgs) => undefined),
    destroy: vi.fn(async () => undefined),
  } satisfies HostWorkspace & {
    setLocalStateFingerprint: (value: GetLocalStateFingerprintResult) => void;
    setLocalStateFingerprintError: (value: Error | null) => void;
    setSharedGitRefsFingerprint: (
      value: GetSharedGitRefsFingerprintResult,
    ) => void;
    setSharedGitRefsFingerprintError: (value: Error | null) => void;
  };

  return workspace;
}

function createFakeHostWatcher(args: {
  watchThreadStorageRootImplementation?: WatchThreadStorageRootImplementation;
  watchWorkspaceImplementation?: WatchWorkspaceImplementation;
} = {}) {
  const watchWorkspace = vi.fn<WatchWorkspaceImplementation>(
    args.watchWorkspaceImplementation ??
      ((_args) => () => undefined),
  );
  const watchThreadStorageRoot = vi.fn<WatchThreadStorageRootImplementation>(
    args.watchThreadStorageRootImplementation ??
      ((_args) => () => undefined),
  );
  const hostWatcher = {
    watchWorkspace,
    watchThreadStorageRoot,
  } satisfies HostWatcher;

  return {
    hostWatcher,
    watchThreadStorageRoot,
    watchWorkspace,
  };
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
    async (..._args: ProvisionWorkspaceMockArgs) => createFakeWorkspace(path),
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

  it("passes shell env through to created runtimes", async () => {
    const provisionWorkspace = createProvisionWorkspaceMock("/tmp/env-1");
    const createRuntime = vi.fn(() => createFakeRuntime());
    const manager = new RuntimeManager({
      provisionWorkspace,
      createRuntime,
      shellEnv: {
        PATH: "/tmp/bb-bin:/usr/bin",
        BB_SERVER_URL: "http://127.0.0.1:3334",
      },
    });

    await manager.ensureEnvironment({
      environmentId: "env-1",
      workspacePath: "/tmp/env-1",
    });

    expect(createRuntime).toHaveBeenCalledWith(
      expect.objectContaining({
        shellEnv: {
          PATH: "/tmp/bb-bin:/usr/bin",
          BB_SERVER_URL: "http://127.0.0.1:3334",
        },
      }),
    );
  });

  it("merges managed shell env into future runtime creation", async () => {
    const provisionWorkspace = createProvisionWorkspaceMock("/tmp/env-1");
    const createRuntime = vi.fn(() => createFakeRuntime());
    const manager = new RuntimeManager({
      provisionWorkspace,
      createRuntime,
      shellEnv: {
        PATH: "/tmp/bb-bin:/usr/bin",
      },
    });

    await manager.ensureEnvironment({
      environmentId: "env-1",
      workspacePath: "/tmp/env-1",
    });

    manager.replaceManagedShellEnv({
      GITHUB_TOKEN: "test-github-token",
      OPENAI_API_KEY: "test-openai-key",
    });
    await manager.ensureEnvironment({
      environmentId: "env-2",
      workspacePath: "/tmp/env-2",
    });

    expect(createRuntime).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        shellEnv: {
          GITHUB_TOKEN: "test-github-token",
          OPENAI_API_KEY: "test-openai-key",
          PATH: "/tmp/bb-bin:/usr/bin",
        },
      }),
    );
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

  it("evicts only idle environments and keeps their workspaces intact", async () => {
    const runtimes: AgentRuntime[] = [];
    const workspaces: HostWorkspace[] = [];
    const createRuntime = vi.fn(() => {
      const runtime = createFakeRuntime();
      runtimes.push(runtime);
      return runtime;
    });
    const provisionWorkspace = vi.fn(
      async (...args: ProvisionWorkspaceMockArgs) => {
        const workspace = createFakeWorkspace(getProvisionWorkspacePath(args[0]));
        workspaces.push(workspace);
        return workspace;
      },
    );
    const manager = new RuntimeManager({
      createRuntime,
      provisionWorkspace,
    });

    await manager.ensureEnvironment({
      environmentId: "env-idle",
      workspacePath: "/tmp/env-idle",
    });
    await manager.ensureEnvironment({
      environmentId: "env-active",
      workspacePath: "/tmp/env-active",
    });
    manager.markThreadActive("env-active", "thr-active", "provider-thread-active");

    await expect(manager.evictIdleEnvironments()).resolves.toEqual(["env-idle"]);

    expect(manager.get("env-idle")).toBeUndefined();
    expect(manager.get("env-active")).toBeDefined();
    expect(runtimes[0]?.shutdown).toHaveBeenCalledTimes(1);
    expect(runtimes[1]?.shutdown).not.toHaveBeenCalled();
    // Idle eviction only tears down daemon-owned runtime processes. Workspace
    // destruction remains a server-owned explicit lifecycle action.
    expect(workspaces[0]?.destroy).not.toHaveBeenCalled();
    expect(workspaces[1]?.destroy).not.toHaveBeenCalled();
  });

  it("skips idle eviction while environment creation is still pending", async () => {
    const deferredWorkspace = createDeferred<HostWorkspace>();
    const manager = new RuntimeManager({
      provisionWorkspace: vi.fn(async () => deferredWorkspace.promise),
      createRuntime: vi.fn(() => createFakeRuntime()),
    });

    const pendingEnvironment = manager.ensureEnvironment({
      environmentId: "env-pending",
      workspacePath: "/tmp/env-pending",
    });

    await expect(manager.evictIdleEnvironments()).resolves.toEqual([]);

    deferredWorkspace.resolve(createFakeWorkspace("/tmp/env-pending"));
    await expect(pendingEnvironment).resolves.toMatchObject({
      environmentId: "env-pending",
    });
    expect(manager.get("env-pending")).toBeDefined();
  });

  it("shuts down the runtime and destroys the workspace", async () => {
    const stopWatchingStatus = vi.fn(() => undefined);
    const workspace = createFakeWorkspace("/tmp/env-1");
    const { hostWatcher, watchWorkspace } = createFakeHostWatcher({
      watchWorkspaceImplementation: (_args) => stopWatchingStatus,
    });
    const runtime = createFakeRuntime();
    const manager = new RuntimeManager({
      hostWatcher,
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
    expect(watchWorkspace).toHaveBeenCalledTimes(1);
    expect(stopWatchingStatus).toHaveBeenCalledTimes(1);
    expect(workspace.destroy).toHaveBeenCalledTimes(1);
  });

  it("installs the workspace status watcher once and reports workspace status changes", async () => {
    const stopWatchingStatus = vi.fn(() => undefined);
    let watchWorkspaceArgs: WatchWorkspaceArgs | undefined;
    const workspace = createFakeWorkspace("/tmp/env-watch");
    const { hostWatcher, watchWorkspace } = createFakeHostWatcher({
      watchWorkspaceImplementation: (args) => {
        watchWorkspaceArgs = args;
        return stopWatchingStatus;
      },
    });
    const onWorkspaceStatusChanged = vi.fn();
    const manager = new RuntimeManager({
      hostWatcher,
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
    workspace.setLocalStateFingerprint("local:/tmp/env-watch:changed");
    await manager.ensureEnvironment({
      environmentId: "env-watch",
      workspacePath: "/tmp/env-watch",
    });
    watchWorkspaceArgs?.onChange({
      changedPaths: ["/tmp/env-watch/README.md"],
      changeKinds: ["workspace-content-changed"],
      kind: "workspace-status-changed",
      environmentId: "env-watch",
    });
    await Promise.resolve();
    await Promise.resolve();

    expect(watchWorkspace).toHaveBeenCalledTimes(1);
    expect(watchWorkspace).toHaveBeenCalledWith(
      expect.objectContaining({
        environmentId: "env-watch",
        workspacePath: "/tmp/env-watch",
      }),
    );
    expect(onWorkspaceStatusChanged).toHaveBeenCalledWith({
      changeKinds: ["work-status-changed"],
      environmentId: "env-watch",
    });
    expect(stopWatchingStatus).not.toHaveBeenCalled();
  });

  it("suppresses workspace change notifications when the local fingerprint is unchanged", async () => {
    const stopWatchingStatus = vi.fn(() => undefined);
    let watchWorkspaceArgs: WatchWorkspaceArgs | undefined;
    const workspace = createFakeWorkspace("/tmp/env-watch");
    const { hostWatcher } = createFakeHostWatcher({
      watchWorkspaceImplementation: (args) => {
        watchWorkspaceArgs = args;
        return stopWatchingStatus;
      },
    });
    const onWorkspaceStatusChanged = vi.fn();
    const manager = new RuntimeManager({
      hostWatcher,
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

    watchWorkspaceArgs?.onChange({
      changedPaths: ["/tmp/env-watch/README.md"],
      changeKinds: ["workspace-content-changed"],
      kind: "workspace-status-changed",
      environmentId: "env-watch",
    });
    await Promise.resolve();
    await Promise.resolve();

    expect(onWorkspaceStatusChanged).not.toHaveBeenCalled();
  });

  it("reports shared git ref changes separately from local workspace changes", async () => {
    const stopWatchingStatus = vi.fn(() => undefined);
    let watchWorkspaceArgs: WatchWorkspaceArgs | undefined;
    const workspace = createFakeWorkspace("/tmp/env-watch");
    const { hostWatcher } = createFakeHostWatcher({
      watchWorkspaceImplementation: (args) => {
        watchWorkspaceArgs = args;
        return stopWatchingStatus;
      },
    });
    const onWorkspaceStatusChanged = vi.fn();
    const manager = new RuntimeManager({
      hostWatcher,
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
    workspace.setSharedGitRefsFingerprint("refs:/tmp/env-watch:changed");

    watchWorkspaceArgs?.onChange({
      changedPaths: ["/tmp/shared/.git/refs/heads/main"],
      changeKinds: ["shared-git-refs-changed"],
      kind: "workspace-status-changed",
      environmentId: "env-watch",
    });
    await Promise.resolve();
    await Promise.resolve();

    expect(onWorkspaceStatusChanged).toHaveBeenCalledWith({
      changeKinds: ["git-refs-changed"],
      environmentId: "env-watch",
    });
  });

  it("reports shared git ref changes from single-dir git watcher events", async () => {
    const stopWatchingStatus = vi.fn(() => undefined);
    let watchWorkspaceArgs: WatchWorkspaceArgs | undefined;
    const workspace = createFakeWorkspace("/tmp/env-watch");
    const { hostWatcher } = createFakeHostWatcher({
      watchWorkspaceImplementation: (args) => {
        watchWorkspaceArgs = args;
        return stopWatchingStatus;
      },
    });
    const onWorkspaceStatusChanged = vi.fn();
    const manager = new RuntimeManager({
      hostWatcher,
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
    workspace.setSharedGitRefsFingerprint("refs:/tmp/env-watch:changed");

    watchWorkspaceArgs?.onChange({
      changedPaths: ["/tmp/env-watch/.git/refs/heads/feature"],
      changeKinds: ["workspace-git-changed", "shared-git-refs-changed"],
      kind: "workspace-status-changed",
      environmentId: "env-watch",
    });
    await Promise.resolve();
    await Promise.resolve();

    expect(onWorkspaceStatusChanged).toHaveBeenCalledWith({
      changeKinds: ["git-refs-changed"],
      environmentId: "env-watch",
    });
  });

  it("reports local fingerprint recomputation failures and recovers on the next change", async () => {
    const stopWatchingStatus = vi.fn(() => undefined);
    let watchWorkspaceArgs: WatchWorkspaceArgs | undefined;
    const workspace = createFakeWorkspace("/tmp/env-watch");
    const { hostWatcher } = createFakeHostWatcher({
      watchWorkspaceImplementation: (args) => {
        watchWorkspaceArgs = args;
        return stopWatchingStatus;
      },
    });
    const onWorkspaceStatusChanged = vi.fn();
    const onWorkspaceStatusWatchError = vi.fn();
    const manager = new RuntimeManager({
      hostWatcher,
      provisionWorkspace: createProvisionWorkspaceMock("/tmp/env-watch").mockResolvedValue(
        workspace,
      ),
      createRuntime: vi.fn(() => createFakeRuntime()),
      onWorkspaceStatusChanged,
      onWorkspaceStatusWatchError,
    });

    await manager.ensureEnvironment({
      environmentId: "env-watch",
      workspacePath: "/tmp/env-watch",
    });

    workspace.setLocalStateFingerprintError(new Error("workspace vanished"));
    watchWorkspaceArgs?.onChange({
      changedPaths: ["/tmp/env-watch/README.md"],
      changeKinds: ["workspace-content-changed"],
      kind: "workspace-status-changed",
      environmentId: "env-watch",
    });
    await Promise.resolve();
    await Promise.resolve();

    expect(onWorkspaceStatusChanged).not.toHaveBeenCalled();
    expect(onWorkspaceStatusWatchError).toHaveBeenCalledWith({
      error: {
        environmentId: "env-watch",
        kind: "workspace-watch-error",
        message: "workspace vanished",
        rootPath: "/tmp/env-watch",
      },
    });

    workspace.setLocalStateFingerprintError(null);
    workspace.setLocalStateFingerprint("local:/tmp/env-watch:changed");
    watchWorkspaceArgs?.onChange({
      changedPaths: ["/tmp/env-watch/src/index.ts"],
      changeKinds: ["workspace-content-changed"],
      kind: "workspace-status-changed",
      environmentId: "env-watch",
    });
    await Promise.resolve();
    await Promise.resolve();

    expect(onWorkspaceStatusChanged).toHaveBeenCalledWith({
      changeKinds: ["work-status-changed"],
      environmentId: "env-watch",
    });
  });

  it("reports shared git ref fingerprint recomputation failures and recovers on the next change", async () => {
    const stopWatchingStatus = vi.fn(() => undefined);
    let watchWorkspaceArgs: WatchWorkspaceArgs | undefined;
    const workspace = createFakeWorkspace("/tmp/env-watch");
    const { hostWatcher } = createFakeHostWatcher({
      watchWorkspaceImplementation: (args) => {
        watchWorkspaceArgs = args;
        return stopWatchingStatus;
      },
    });
    const onWorkspaceStatusChanged = vi.fn();
    const onWorkspaceStatusWatchError = vi.fn();
    const manager = new RuntimeManager({
      hostWatcher,
      provisionWorkspace: createProvisionWorkspaceMock("/tmp/env-watch").mockResolvedValue(
        workspace,
      ),
      createRuntime: vi.fn(() => createFakeRuntime()),
      onWorkspaceStatusChanged,
      onWorkspaceStatusWatchError,
    });

    await manager.ensureEnvironment({
      environmentId: "env-watch",
      workspacePath: "/tmp/env-watch",
    });

    workspace.setSharedGitRefsFingerprintError(new Error("refs unavailable"));
    watchWorkspaceArgs?.onChange({
      changedPaths: ["/tmp/shared/.git/refs/heads/main"],
      changeKinds: ["shared-git-refs-changed"],
      kind: "workspace-status-changed",
      environmentId: "env-watch",
    });
    await Promise.resolve();
    await Promise.resolve();

    expect(onWorkspaceStatusChanged).not.toHaveBeenCalled();
    expect(onWorkspaceStatusWatchError).toHaveBeenCalledWith({
      error: {
        environmentId: "env-watch",
        kind: "workspace-watch-error",
        message: "refs unavailable",
        rootPath: "/tmp/env-watch",
      },
    });

    workspace.setSharedGitRefsFingerprintError(null);
    workspace.setSharedGitRefsFingerprint("refs:/tmp/env-watch:changed");
    watchWorkspaceArgs?.onChange({
      changedPaths: ["/tmp/shared/.git/refs/heads/feature"],
      changeKinds: ["shared-git-refs-changed"],
      kind: "workspace-status-changed",
      environmentId: "env-watch",
    });
    await Promise.resolve();
    await Promise.resolve();

    expect(onWorkspaceStatusChanged).toHaveBeenCalledWith({
      changeKinds: ["git-refs-changed"],
      environmentId: "env-watch",
    });
  });

  it("forwards workspace watch startup failures with the environment id", async () => {
    const stopWatchingStatus = vi.fn(() => undefined);
    let watchWorkspaceArgs: WatchWorkspaceArgs | undefined;
    const workspace = createFakeWorkspace("/tmp/env-watch");
    const { hostWatcher } = createFakeHostWatcher({
      watchWorkspaceImplementation: (args) => {
        watchWorkspaceArgs = args;
        return stopWatchingStatus;
      },
    });
    const onWorkspaceStatusWatchError = vi.fn();
    const manager = new RuntimeManager({
      hostWatcher,
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

    watchWorkspaceArgs?.onWatchError({
      kind: "workspace-watch-error",
      environmentId: "env-watch",
      message: "Error starting FSEvents stream",
      rootPath: "/tmp/env-watch",
    } satisfies WorkspaceWatchError);

    expect(onWorkspaceStatusWatchError).toHaveBeenCalledWith({
      error: {
        kind: "workspace-watch-error",
        environmentId: "env-watch",
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

  it("forgets stopped threads so follow-ups resume the provider session", async () => {
    const manager = new RuntimeManager({
      provisionWorkspace: createProvisionWorkspaceMock("/tmp/env-1"),
      createRuntime: vi.fn(() => createFakeRuntime()),
    });

    await manager.ensureEnvironment({
      environmentId: "env-1",
      workspacePath: "/tmp/env-1",
    });

    manager.markThreadActive("env-1", "thread-1", "provider-1");
    manager.forgetThread("env-1", "thread-1");

    expect(manager.hasThread("env-1", "thread-1")).toBe(false);
    expect(manager.listActiveThreads()).toEqual([]);
  });

  it("installs one shared thread storage root watcher for tracked threads", async () => {
    const stopWatchingPathChanges = vi.fn(() => undefined);
    let watchThreadStorageRootArgs: WatchThreadStorageRootArgs | undefined;
    const { hostWatcher, watchThreadStorageRoot } = createFakeHostWatcher({
      watchThreadStorageRootImplementation: (args) => {
        watchThreadStorageRootArgs = args;
        return stopWatchingPathChanges;
      },
    });
    const onThreadStorageChanged = vi.fn();
    const manager = new RuntimeManager({
      hostWatcher,
      provisionWorkspace: createProvisionWorkspaceMock("/tmp/env-storage"),
      createRuntime: vi.fn(() => createFakeRuntime()),
      onThreadStorageChanged,
      threadStorageRootPath: "/tmp/bb-data/thread-storage",
    });

    await manager.ensureEnvironment({
      environmentId: "env-storage",
      workspacePath: "/tmp/env-storage",
    });

    manager.markThreadActive("env-storage", "thread-1", "provider-1");
    manager.markThreadActive("env-storage", "thread-2", "provider-2");
    watchThreadStorageRootArgs?.onChange({
      kind: "thread-storage-changed",
      environmentId: "env-storage",
      threadId: "thread-1",
    });
    watchThreadStorageRootArgs?.onChange({
      kind: "thread-storage-changed",
      environmentId: "env-storage",
      threadId: "thread-2",
    });

    expect(watchThreadStorageRoot).toHaveBeenCalledTimes(1);
    expect(watchThreadStorageRoot).toHaveBeenCalledWith(
      expect.objectContaining({
        threadStorageRootPath: "/tmp/bb-data/thread-storage",
      }),
    );
    expect(onThreadStorageChanged).toHaveBeenNthCalledWith(1, {
      environmentId: "env-storage",
      threadId: "thread-1",
    });
    expect(onThreadStorageChanged).toHaveBeenNthCalledWith(2, {
      environmentId: "env-storage",
      threadId: "thread-2",
    });
    expect(onThreadStorageChanged).toHaveBeenCalledTimes(2);
    expect(stopWatchingPathChanges).not.toHaveBeenCalled();

    await manager.destroyEnvironment("env-storage");

    expect(stopWatchingPathChanges).toHaveBeenCalledTimes(1);
  });

  it("watches tracked thread storage targets restored from session state", async () => {
    let watchThreadStorageRootArgs: WatchThreadStorageRootArgs | undefined;
    const { hostWatcher, watchThreadStorageRoot } = createFakeHostWatcher({
      watchThreadStorageRootImplementation: (args) => {
        watchThreadStorageRootArgs = args;
        return () => undefined;
      },
    });
    const onThreadStorageChanged = vi.fn();
    const manager = new RuntimeManager({
      hostWatcher,
      provisionWorkspace: createProvisionWorkspaceMock("/tmp/env-storage"),
      createRuntime: vi.fn(() => createFakeRuntime()),
      onThreadStorageChanged,
      threadStorageRootPath: "/tmp/bb-data/thread-storage",
    });

    manager.replaceTrackedThreadStorageTargets([
      {
        environmentId: "env-storage",
        threadId: "thread-1",
      },
    ]);

    expect(watchThreadStorageRoot).toHaveBeenCalledTimes(1);
    watchThreadStorageRootArgs?.onChange({
      kind: "thread-storage-changed",
      environmentId: "env-storage",
      threadId: "thread-1",
    });

    expect(onThreadStorageChanged).toHaveBeenCalledWith({
      environmentId: "env-storage",
      threadId: "thread-1",
    });
  });

  it("forwards thread storage watch failures for the shared root watcher", async () => {
    let watchThreadStorageRootArgs: WatchThreadStorageRootArgs | undefined;
    const { hostWatcher } = createFakeHostWatcher({
      watchThreadStorageRootImplementation: (args) => {
        watchThreadStorageRootArgs = args;
        return () => undefined;
      },
    });
    const onThreadStorageWatchError = vi.fn();
    const manager = new RuntimeManager({
      hostWatcher,
      provisionWorkspace: createProvisionWorkspaceMock("/tmp/env-storage"),
      createRuntime: vi.fn(() => createFakeRuntime()),
      onThreadStorageWatchError,
      threadStorageRootPath: "/tmp/bb-data/thread-storage",
    });

    await manager.ensureEnvironment({
      environmentId: "env-storage",
      workspacePath: "/tmp/env-storage",
    });

    manager.markThreadActive("env-storage", "thread-1", "provider-1");
    watchThreadStorageRootArgs?.onWatchError({
      kind: "thread-storage-watch-error",
      message: "watch failed",
      rootPath: "/tmp/bb-data/thread-storage",
    } satisfies ThreadStorageWatchError);

    expect(onThreadStorageWatchError).toHaveBeenCalledWith({
      error: {
        kind: "thread-storage-watch-error",
        message: "watch failed",
        rootPath: "/tmp/bb-data/thread-storage",
      },
    });
  });

  it("keeps the shared thread storage watcher running while other environments still have tracked threads", async () => {
    const stopWatchingPathChanges = vi.fn(() => undefined);
    const { hostWatcher } = createFakeHostWatcher({
      watchThreadStorageRootImplementation: (_args) => stopWatchingPathChanges,
    });
    const provisionWorkspace = createProvisionWorkspaceMock("/tmp/env-a");
    provisionWorkspace
      .mockResolvedValueOnce(createFakeWorkspace("/tmp/env-a"))
      .mockResolvedValueOnce(createFakeWorkspace("/tmp/env-b"));
    const manager = new RuntimeManager({
      hostWatcher,
      provisionWorkspace,
      createRuntime: vi.fn(() => createFakeRuntime()),
      threadStorageRootPath: "/tmp/bb-data/thread-storage",
    });

    await manager.ensureEnvironment({
      environmentId: "env-a",
      workspacePath: "/tmp/env-a",
    });
    await manager.ensureEnvironment({
      environmentId: "env-b",
      workspacePath: "/tmp/env-b",
    });

    manager.markThreadActive("env-a", "thread-a", "provider-a");
    manager.markThreadActive("env-b", "thread-b", "provider-b");

    await manager.destroyEnvironment("env-a");
    expect(stopWatchingPathChanges).not.toHaveBeenCalled();

    await manager.destroyEnvironment("env-b");
    expect(stopWatchingPathChanges).toHaveBeenCalledTimes(1);
  });

  it("removes stale entries when the provider process exits", async () => {
    const stopWatchingStatus = vi.fn(() => undefined);
    const workspace = createFakeWorkspace("/tmp/env-exit");
    const { hostWatcher } = createFakeHostWatcher({
      watchWorkspaceImplementation: (_args) => stopWatchingStatus,
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
      hostWatcher,
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
    const workspace = createFakeWorkspace("/tmp/env-shared");
    const { hostWatcher } = createFakeHostWatcher({
      watchWorkspaceImplementation: (_args) => stopWatchingStatus,
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
      hostWatcher,
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
    const workspaceA = createFakeWorkspace("/tmp/env-a");
    const workspaceB = createFakeWorkspace("/tmp/env-b");
    const { hostWatcher } = createFakeHostWatcher({
      watchWorkspaceImplementation: vi
        .fn<WatchWorkspaceImplementation>()
        .mockImplementationOnce((_args) => stopWatchingStatusA)
        .mockImplementationOnce((_args) => stopWatchingStatusB),
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
      hostWatcher,
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
