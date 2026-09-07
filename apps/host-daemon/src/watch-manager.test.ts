import type {
  HostWatcher,
  WatchThreadStorageRootArgs,
  WatchWorkspaceArgs,
  WorkspaceWatchError,
} from "@bb/host-watcher";
import type { HostWorkspace } from "@bb/host-workspace";
import {
  createDeferredPromise,
  makeWorkspaceMergeBase,
  makeWorkspaceStatus,
} from "@bb/test-helpers";
import { describe, expect, it, vi } from "vitest";
import { WatchManager, type WatchManagerOptions } from "./watch-manager.js";

type GetLocalStateFingerprintResult = Awaited<
  ReturnType<HostWorkspace["getLocalStateFingerprint"]>
>;
type GetSharedGitRefsFingerprintResult = Awaited<
  ReturnType<HostWorkspace["getSharedGitRefsFingerprint"]>
>;
type StopWatching = () => void | Promise<void>;
type WatchWorkspaceImplementation = (args: WatchWorkspaceArgs) => StopWatching;
type WatchThreadStorageRootImplementation = (
  args: WatchThreadStorageRootArgs,
) => StopWatching;

function createFakeWorkspace(path: string, isGitRepo = true) {
  let localStateFingerprint: GetLocalStateFingerprintResult = `local:${path}:initial`;
  let localStateFingerprintError: Error | null = null;
  let sharedGitRefsFingerprint: GetSharedGitRefsFingerprintResult = `refs:${path}:initial`;
  let sharedGitRefsFingerprintError: Error | null = null;
  const workspace = {
    path,
    managed: false,
    isGitRepo,
    isWorktree: false,
    getDefaultBranch: vi.fn(async () => "main"),
    getCurrentBranch: vi.fn(async () => "main"),
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
    getAdditionalWorkspaceWriteRoots: vi.fn(async () => []),
    getStatus: vi.fn(async () =>
      makeWorkspaceStatus({
        mergeBase: makeWorkspaceMergeBase(),
      }),
    ),
    getDiff: vi.fn(async () => ({
      diff: "",
      truncated: false,
      shortstat: "",
      files: "",
      mergeBaseRef: null,
    })),
    diffFiles: vi.fn(async () => ({
      files: [],
      shortstat: "",
      mergeBaseRef: null,
      truncated: false,
    })),
    diffPatch: vi.fn(async () => []),
    getPullRequest: vi.fn(async () => ({ outcome: "none" as const })),
    runPullRequestAction: vi.fn(async () => undefined),
    listFiles: vi.fn(async () => []),
    commit: vi.fn(async () => ({
      commitSha: "commit-1",
      commitSubject: "commit",
    })),
    reset: vi.fn(async () => undefined),
    setLocalStateFingerprint(value: GetLocalStateFingerprintResult) {
      localStateFingerprint = value;
    },
    setLocalStateFingerprintError(error: Error | null) {
      localStateFingerprintError = error;
    },
    setSharedGitRefsFingerprint(value: GetSharedGitRefsFingerprintResult) {
      sharedGitRefsFingerprint = value;
    },
    setSharedGitRefsFingerprintError(error: Error | null) {
      sharedGitRefsFingerprintError = error;
    },
    destroy: vi.fn(async () => undefined),
  } satisfies HostWorkspace & {
    setLocalStateFingerprint: (value: GetLocalStateFingerprintResult) => void;
    setLocalStateFingerprintError: (error: Error | null) => void;
    setSharedGitRefsFingerprint: (
      value: GetSharedGitRefsFingerprintResult,
    ) => void;
    setSharedGitRefsFingerprintError: (error: Error | null) => void;
  };

  return workspace;
}

function createFakeHostWatcher(
  args: {
    watchThreadStorageRootImplementation?: WatchThreadStorageRootImplementation;
    watchWorkspaceImplementation?: WatchWorkspaceImplementation;
  } = {},
) {
  const watchWorkspace = vi.fn<WatchWorkspaceImplementation>(
    args.watchWorkspaceImplementation ?? (() => () => undefined),
  );
  const watchThreadStorageRoot = vi.fn<WatchThreadStorageRootImplementation>(
    args.watchThreadStorageRootImplementation ?? (() => () => undefined),
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

describe("WatchManager", () => {
  it("starts watching before initial workspace fingerprints finish", async () => {
    const workspace = createFakeWorkspace("/tmp/env-watch");
    const localFingerprint =
      createDeferredPromise<GetLocalStateFingerprintResult>();
    workspace.getLocalStateFingerprint.mockImplementationOnce(
      () => localFingerprint.promise,
    );
    const { hostWatcher, watchWorkspace } = createFakeHostWatcher();
    const manager = new WatchManager({
      hostWatcher,
      provisionWorkspace: vi.fn(async () => workspace),
    });

    await manager.replaceWatchSet({
      generation: 1,
      workspaceTargets: [
        {
          environmentId: "env-watch",
          workspaceContext: {
            workspacePath: "/tmp/env-watch",
            workspaceProvisionType: "unmanaged",
          },
        },
      ],
      threadStorageTargets: [],
    });

    expect(watchWorkspace).toHaveBeenCalledTimes(1);
    expect(workspace.getLocalStateFingerprint).toHaveBeenCalledTimes(1);

    localFingerprint.resolve("local:/tmp/env-watch:initial");
    await vi.waitFor(() => {
      expect(workspace.getSharedGitRefsFingerprint).toHaveBeenCalledTimes(1);
    });
  });

  it("reconciles live content when the workspace watcher becomes ready", async () => {
    let watchWorkspaceArgs: WatchWorkspaceArgs | undefined;
    const workspace = createFakeWorkspace("/tmp/env-watch");
    const { hostWatcher } = createFakeHostWatcher({
      watchWorkspaceImplementation: (args) => {
        watchWorkspaceArgs = args;
        return () => undefined;
      },
    });
    const onWorkspaceStatusChanged = vi.fn();
    const manager = new WatchManager({
      hostWatcher,
      provisionWorkspace: vi.fn(async () => workspace),
      onWorkspaceStatusChanged,
    });

    await manager.replaceWatchSet({
      generation: 1,
      workspaceTargets: [
        {
          environmentId: "env-watch",
          workspaceContext: {
            workspacePath: "/tmp/env-watch",
            workspaceProvisionType: "unmanaged",
          },
        },
      ],
      threadStorageTargets: [],
    });

    watchWorkspaceArgs?.onReady();

    expect(onWorkspaceStatusChanged).toHaveBeenCalledWith({
      changeKinds: ["work-status-changed"],
      environmentId: "env-watch",
    });
  });

  it("starts workspace watches from snapshots and stops removed targets", async () => {
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
    const manager = new WatchManager({
      hostWatcher,
      provisionWorkspace: vi.fn(async () => workspace),
      onWorkspaceStatusChanged,
    });

    await manager.replaceWatchSet({
      generation: 1,
      workspaceTargets: [
        {
          environmentId: "env-watch",
          workspaceContext: {
            workspacePath: "/tmp/env-watch",
            workspaceProvisionType: "unmanaged",
          },
        },
      ],
      threadStorageTargets: [],
    });
    await manager.replaceWatchSet({
      generation: 2,
      workspaceTargets: [
        {
          environmentId: "env-watch",
          workspaceContext: {
            workspacePath: "/tmp/env-watch",
            workspaceProvisionType: "unmanaged",
          },
        },
      ],
      threadStorageTargets: [],
    });

    workspace.setLocalStateFingerprint("local:/tmp/env-watch:changed");
    watchWorkspaceArgs?.onChange({
      changedPaths: ["/tmp/env-watch/README.md"],
      changeKinds: ["workspace-content-changed"],
      kind: "workspace-status-changed",
      environmentId: "env-watch",
    });
    await Promise.resolve();
    await Promise.resolve();

    expect(watchWorkspace).toHaveBeenCalledTimes(1);
    expect(onWorkspaceStatusChanged).toHaveBeenCalledWith({
      changeKinds: ["work-status-changed"],
      environmentId: "env-watch",
    });

    await manager.replaceWatchSet({
      generation: 3,
      workspaceTargets: [],
      threadStorageTargets: [],
    });

    expect(stopWatchingStatus).toHaveBeenCalledTimes(1);
  });

  it("reports workspace content changes when the local fingerprint is unchanged", async () => {
    let watchWorkspaceArgs: WatchWorkspaceArgs | undefined;
    const workspace = createFakeWorkspace("/tmp/env-watch");
    const { hostWatcher } = createFakeHostWatcher({
      watchWorkspaceImplementation: (args) => {
        watchWorkspaceArgs = args;
        return () => undefined;
      },
    });
    const onWorkspaceStatusChanged = vi.fn();
    const manager = new WatchManager({
      hostWatcher,
      provisionWorkspace: vi.fn(async () => workspace),
      onWorkspaceStatusChanged,
    });

    await manager.replaceWatchSet({
      generation: 1,
      workspaceTargets: [
        {
          environmentId: "env-watch",
          workspaceContext: {
            workspacePath: "/tmp/env-watch",
            workspaceProvisionType: "unmanaged",
          },
        },
      ],
      threadStorageTargets: [],
    });
    await vi.waitFor(() => {
      expect(workspace.getLocalStateFingerprint).toHaveBeenCalledTimes(1);
    });
    workspace.getLocalStateFingerprint.mockClear();
    workspace.setLocalStateFingerprintError(new Error("status too large"));

    watchWorkspaceArgs?.onChange({
      changedPaths: ["/tmp/env-watch/README.md"],
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
    expect(workspace.getLocalStateFingerprint).not.toHaveBeenCalled();
  });

  it("refreshes workspace metadata when a plain workspace becomes a git repository", async () => {
    let watchWorkspaceArgs: WatchWorkspaceArgs | undefined;
    const plainWorkspace = createFakeWorkspace("/tmp/env-watch", false);
    const gitWorkspace = createFakeWorkspace("/tmp/env-watch");
    const provisionWorkspace = vi
      .fn<NonNullable<WatchManagerOptions["provisionWorkspace"]>>()
      .mockResolvedValue(plainWorkspace);
    const refreshWorkspace = vi
      .fn<NonNullable<WatchManagerOptions["refreshWorkspace"]>>()
      .mockResolvedValue(gitWorkspace);
    const { hostWatcher } = createFakeHostWatcher({
      watchWorkspaceImplementation: (args) => {
        watchWorkspaceArgs = args;
        return () => undefined;
      },
    });
    const onWorkspaceMetadataChanged = vi.fn();
    const onWorkspaceStatusChanged = vi.fn();
    const manager = new WatchManager({
      hostWatcher,
      provisionWorkspace,
      refreshWorkspace,
      onWorkspaceMetadataChanged,
      onWorkspaceStatusChanged,
    });

    await manager.replaceWatchSet({
      generation: 1,
      workspaceTargets: [
        {
          environmentId: "env-watch",
          workspaceContext: {
            workspacePath: "/tmp/env-watch",
            workspaceProvisionType: "unmanaged",
          },
        },
      ],
      threadStorageTargets: [],
    });
    watchWorkspaceArgs?.onChange({
      changedPaths: ["/tmp/env-watch/file.txt"],
      changeKinds: ["workspace-content-changed"],
      kind: "workspace-status-changed",
      environmentId: "env-watch",
    });
    await vi.waitFor(() => {
      expect(onWorkspaceStatusChanged).toHaveBeenCalledWith({
        changeKinds: ["work-status-changed"],
        environmentId: "env-watch",
      });
    });
    expect(provisionWorkspace).toHaveBeenCalledTimes(1);
    expect(refreshWorkspace).not.toHaveBeenCalled();
    expect(onWorkspaceMetadataChanged).not.toHaveBeenCalled();
    onWorkspaceStatusChanged.mockClear();

    watchWorkspaceArgs?.onChange({
      changedPaths: ["/tmp/env-watch/.git"],
      changeKinds: [
        "workspace-content-changed",
        "workspace-git-repository-created",
      ],
      kind: "workspace-status-changed",
      environmentId: "env-watch",
    });

    await vi.waitFor(() => {
      expect(onWorkspaceMetadataChanged).toHaveBeenCalledWith({
        environmentId: "env-watch",
        workspace: {
          path: "/tmp/env-watch",
          isGitRepo: true,
          isWorktree: false,
          branchName: "main",
          defaultBranch: "main",
        },
      });
      expect(onWorkspaceStatusChanged).toHaveBeenCalledWith({
        changeKinds: ["work-status-changed"],
        environmentId: "env-watch",
      });
    });
    expect(provisionWorkspace).toHaveBeenCalledTimes(1);
    expect(refreshWorkspace).toHaveBeenCalledTimes(1);
  });

  it("suppresses git metadata notifications when the local fingerprint is unchanged", async () => {
    let watchWorkspaceArgs: WatchWorkspaceArgs | undefined;
    const workspace = createFakeWorkspace("/tmp/env-watch");
    const { hostWatcher } = createFakeHostWatcher({
      watchWorkspaceImplementation: (args) => {
        watchWorkspaceArgs = args;
        return () => undefined;
      },
    });
    const onWorkspaceStatusChanged = vi.fn();
    const manager = new WatchManager({
      hostWatcher,
      provisionWorkspace: vi.fn(async () => workspace),
      onWorkspaceStatusChanged,
    });

    await manager.replaceWatchSet({
      generation: 1,
      workspaceTargets: [
        {
          environmentId: "env-watch",
          workspaceContext: {
            workspacePath: "/tmp/env-watch",
            workspaceProvisionType: "unmanaged",
          },
        },
      ],
      threadStorageTargets: [],
    });

    watchWorkspaceArgs?.onChange({
      changedPaths: ["/tmp/env-watch/.git/index"],
      changeKinds: ["workspace-git-changed"],
      kind: "workspace-status-changed",
      environmentId: "env-watch",
    });
    await Promise.resolve();
    await Promise.resolve();

    expect(onWorkspaceStatusChanged).not.toHaveBeenCalled();
  });

  it("ignores stale watch-set generations", async () => {
    const workspace = createFakeWorkspace("/tmp/env-watch");
    const { hostWatcher, watchWorkspace } = createFakeHostWatcher();
    const manager = new WatchManager({
      hostWatcher,
      provisionWorkspace: vi.fn(async () => workspace),
    });

    await manager.replaceWatchSet({
      generation: 2,
      workspaceTargets: [],
      threadStorageTargets: [],
    });
    await manager.replaceWatchSet({
      generation: 1,
      workspaceTargets: [
        {
          environmentId: "env-watch",
          workspaceContext: {
            workspacePath: "/tmp/env-watch",
            workspaceProvisionType: "unmanaged",
          },
        },
      ],
      threadStorageTargets: [],
    });

    expect(watchWorkspace).not.toHaveBeenCalled();
    expect(manager.workspaceWatchCount()).toBe(0);
  });

  it("applies authoritative watch-set snapshots even when generation goes backward", async () => {
    const stopWatchingStatus = vi.fn(() => undefined);
    const workspace = createFakeWorkspace("/tmp/env-watch");
    const { hostWatcher, watchWorkspace } = createFakeHostWatcher({
      watchWorkspaceImplementation: () => stopWatchingStatus,
    });
    const manager = new WatchManager({
      hostWatcher,
      provisionWorkspace: vi.fn(async () => workspace),
    });

    await manager.replaceWatchSet({
      generation: 5,
      workspaceTargets: [
        {
          environmentId: "env-watch",
          workspaceContext: {
            workspacePath: "/tmp/env-watch",
            workspaceProvisionType: "unmanaged",
          },
        },
      ],
      threadStorageTargets: [],
    });

    await manager.replaceAuthoritativeWatchSet({
      generation: 0,
      workspaceTargets: [],
      threadStorageTargets: [],
    });
    await manager.replaceWatchSet({
      generation: 1,
      workspaceTargets: [
        {
          environmentId: "env-watch",
          workspaceContext: {
            workspacePath: "/tmp/env-watch",
            workspaceProvisionType: "unmanaged",
          },
        },
      ],
      threadStorageTargets: [],
    });

    expect(stopWatchingStatus).toHaveBeenCalledTimes(1);
    expect(watchWorkspace).toHaveBeenCalledTimes(2);
    expect(manager.workspaceWatchCount()).toBe(1);
  });

  it("serializes watch-set replacement while workspace watch startup is pending", async () => {
    const stopWatchingStatus = vi.fn(() => undefined);
    const workspace = createFakeWorkspace("/tmp/env-watch");
    const pendingWorkspace = createDeferredPromise<HostWorkspace>();
    const provisionWorkspace = vi.fn(() => {
      return pendingWorkspace.promise;
    });
    const { hostWatcher, watchWorkspace } = createFakeHostWatcher({
      watchWorkspaceImplementation: () => stopWatchingStatus,
    });
    const manager = new WatchManager({
      hostWatcher,
      provisionWorkspace,
    });

    const start = manager.replaceWatchSet({
      generation: 1,
      workspaceTargets: [
        {
          environmentId: "env-watch",
          workspaceContext: {
            workspacePath: "/tmp/env-watch",
            workspaceProvisionType: "unmanaged",
          },
        },
      ],
      threadStorageTargets: [],
    });
    const stop = manager.replaceWatchSet({
      generation: 2,
      workspaceTargets: [],
      threadStorageTargets: [],
    });

    await Promise.resolve();
    await Promise.resolve();
    expect(provisionWorkspace).toHaveBeenCalledTimes(1);
    expect(stopWatchingStatus).not.toHaveBeenCalled();

    pendingWorkspace.resolve(workspace);
    await Promise.all([start, stop]);

    expect(watchWorkspace).toHaveBeenCalledTimes(1);
    expect(stopWatchingStatus).toHaveBeenCalledTimes(1);
    expect(manager.workspaceWatchCount()).toBe(0);
  });

  it("waits for pending watch startup before removing an environment watch", async () => {
    const stopWatchingStatus = vi.fn(() => undefined);
    const workspace = createFakeWorkspace("/tmp/env-watch");
    const pendingWorkspace = createDeferredPromise<HostWorkspace>();
    const { hostWatcher, watchWorkspace } = createFakeHostWatcher({
      watchWorkspaceImplementation: () => stopWatchingStatus,
    });
    const manager = new WatchManager({
      hostWatcher,
      provisionWorkspace: vi.fn(() => pendingWorkspace.promise),
    });

    const start = manager.replaceWatchSet({
      generation: 1,
      workspaceTargets: [
        {
          environmentId: "env-watch",
          workspaceContext: {
            workspacePath: "/tmp/env-watch",
            workspaceProvisionType: "unmanaged",
          },
        },
      ],
      threadStorageTargets: [],
    });
    const remove = manager.removeEnvironmentWorkspaceWatch("env-watch");

    await Promise.resolve();
    expect(stopWatchingStatus).not.toHaveBeenCalled();

    pendingWorkspace.resolve(workspace);
    await Promise.all([start, remove]);

    expect(watchWorkspace).toHaveBeenCalledTimes(1);
    expect(stopWatchingStatus).toHaveBeenCalledTimes(1);
    expect(manager.workspaceWatchCount()).toBe(0);
  });

  it("reports shared git ref changes separately from local workspace changes", async () => {
    let watchWorkspaceArgs: WatchWorkspaceArgs | undefined;
    const workspace = createFakeWorkspace("/tmp/env-watch");
    const { hostWatcher } = createFakeHostWatcher({
      watchWorkspaceImplementation: (args) => {
        watchWorkspaceArgs = args;
        return () => undefined;
      },
    });
    const onWorkspaceStatusChanged = vi.fn();
    const manager = new WatchManager({
      hostWatcher,
      provisionWorkspace: vi.fn(async () => workspace),
      onWorkspaceStatusChanged,
    });

    await manager.replaceWatchSet({
      generation: 1,
      workspaceTargets: [
        {
          environmentId: "env-watch",
          workspaceContext: {
            workspacePath: "/tmp/env-watch",
            workspaceProvisionType: "unmanaged",
          },
        },
      ],
      threadStorageTargets: [],
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
    let watchWorkspaceArgs: WatchWorkspaceArgs | undefined;
    const workspace = createFakeWorkspace("/tmp/env-watch");
    const { hostWatcher } = createFakeHostWatcher({
      watchWorkspaceImplementation: (args) => {
        watchWorkspaceArgs = args;
        return () => undefined;
      },
    });
    const onWorkspaceStatusChanged = vi.fn();
    const manager = new WatchManager({
      hostWatcher,
      provisionWorkspace: vi.fn(async () => workspace),
      onWorkspaceStatusChanged,
    });

    await manager.replaceWatchSet({
      generation: 1,
      workspaceTargets: [
        {
          environmentId: "env-watch",
          workspaceContext: {
            workspacePath: "/tmp/env-watch",
            workspaceProvisionType: "unmanaged",
          },
        },
      ],
      threadStorageTargets: [],
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
    let watchWorkspaceArgs: WatchWorkspaceArgs | undefined;
    const workspace = createFakeWorkspace("/tmp/env-watch");
    const { hostWatcher } = createFakeHostWatcher({
      watchWorkspaceImplementation: (args) => {
        watchWorkspaceArgs = args;
        return () => undefined;
      },
    });
    const onWorkspaceStatusChanged = vi.fn();
    const onWorkspaceStatusWatchError = vi.fn();
    const manager = new WatchManager({
      hostWatcher,
      provisionWorkspace: vi.fn(async () => workspace),
      onWorkspaceStatusChanged,
      onWorkspaceStatusWatchError,
    });

    await manager.replaceWatchSet({
      generation: 1,
      workspaceTargets: [
        {
          environmentId: "env-watch",
          workspaceContext: {
            workspacePath: "/tmp/env-watch",
            workspaceProvisionType: "unmanaged",
          },
        },
      ],
      threadStorageTargets: [],
    });

    await vi.waitFor(() => {
      expect(workspace.getLocalStateFingerprint).toHaveBeenCalledTimes(1);
    });
    workspace.getLocalStateFingerprint.mockClear();
    workspace.setLocalStateFingerprintError(new Error("workspace vanished"));
    watchWorkspaceArgs?.onChange({
      changedPaths: ["/tmp/env-watch/.git/index"],
      changeKinds: ["workspace-git-changed"],
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
      changedPaths: ["/tmp/env-watch/.git/index"],
      changeKinds: ["workspace-git-changed"],
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
    let watchWorkspaceArgs: WatchWorkspaceArgs | undefined;
    const workspace = createFakeWorkspace("/tmp/env-watch");
    const { hostWatcher } = createFakeHostWatcher({
      watchWorkspaceImplementation: (args) => {
        watchWorkspaceArgs = args;
        return () => undefined;
      },
    });
    const onWorkspaceStatusChanged = vi.fn();
    const onWorkspaceStatusWatchError = vi.fn();
    const manager = new WatchManager({
      hostWatcher,
      provisionWorkspace: vi.fn(async () => workspace),
      onWorkspaceStatusChanged,
      onWorkspaceStatusWatchError,
    });

    await manager.replaceWatchSet({
      generation: 1,
      workspaceTargets: [
        {
          environmentId: "env-watch",
          workspaceContext: {
            workspacePath: "/tmp/env-watch",
            workspaceProvisionType: "unmanaged",
          },
        },
      ],
      threadStorageTargets: [],
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

  it("forwards workspace watch errors", async () => {
    let watchWorkspaceArgs: WatchWorkspaceArgs | undefined;
    const workspace = createFakeWorkspace("/tmp/env-watch");
    const { hostWatcher } = createFakeHostWatcher({
      watchWorkspaceImplementation: (args) => {
        watchWorkspaceArgs = args;
        return () => undefined;
      },
    });
    const onWorkspaceStatusWatchError = vi.fn();
    const manager = new WatchManager({
      hostWatcher,
      provisionWorkspace: vi.fn(async () => workspace),
      onWorkspaceStatusWatchError,
    });

    await manager.replaceWatchSet({
      generation: 1,
      workspaceTargets: [
        {
          environmentId: "env-watch",
          workspaceContext: {
            workspacePath: "/tmp/env-watch",
            workspaceProvisionType: "unmanaged",
          },
        },
      ],
      threadStorageTargets: [],
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
  });

  it("starts and stops the root thread-storage watcher from snapshots", async () => {
    const stopWatchingPathChanges = vi.fn(() => undefined);
    let watchThreadStorageRootArgs: WatchThreadStorageRootArgs | undefined;
    const { hostWatcher, watchThreadStorageRoot } = createFakeHostWatcher({
      watchThreadStorageRootImplementation: (args) => {
        watchThreadStorageRootArgs = args;
        return stopWatchingPathChanges;
      },
    });
    const onThreadStorageChanged = vi.fn();
    const manager = new WatchManager({
      hostWatcher,
      onThreadStorageChanged,
      threadStorageRootPath: "/tmp/bb-data/thread-storage",
    });

    await manager.replaceWatchSet({
      generation: 1,
      workspaceTargets: [],
      threadStorageTargets: [
        {
          environmentId: "env-storage",
          threadId: "thread-1",
        },
      ],
    });
    watchThreadStorageRootArgs?.onChange({
      kind: "thread-storage-changed",
      environmentId: "env-storage",
      threadId: "thread-1",
    });

    expect(watchThreadStorageRoot).toHaveBeenCalledTimes(1);
    expect(onThreadStorageChanged).toHaveBeenCalledWith({
      environmentId: "env-storage",
      threadId: "thread-1",
    });

    await manager.replaceWatchSet({
      generation: 2,
      workspaceTargets: [],
      threadStorageTargets: [],
    });

    expect(stopWatchingPathChanges).toHaveBeenCalledTimes(1);
  });

  it("keeps the root thread-storage watcher while another target remains", async () => {
    const stopWatchingPathChanges = vi.fn(() => undefined);
    const { hostWatcher } = createFakeHostWatcher({
      watchThreadStorageRootImplementation: () => stopWatchingPathChanges,
    });
    const manager = new WatchManager({
      hostWatcher,
      threadStorageRootPath: "/tmp/bb-data/thread-storage",
    });

    await manager.replaceWatchSet({
      generation: 1,
      workspaceTargets: [],
      threadStorageTargets: [
        {
          environmentId: "env-a",
          threadId: "thread-a",
        },
        {
          environmentId: "env-b",
          threadId: "thread-b",
        },
      ],
    });
    await manager.replaceWatchSet({
      generation: 2,
      workspaceTargets: [],
      threadStorageTargets: [
        {
          environmentId: "env-b",
          threadId: "thread-b",
        },
      ],
    });

    expect(stopWatchingPathChanges).not.toHaveBeenCalled();

    await manager.replaceWatchSet({
      generation: 3,
      workspaceTargets: [],
      threadStorageTargets: [],
    });

    expect(stopWatchingPathChanges).toHaveBeenCalledTimes(1);
  });
});
