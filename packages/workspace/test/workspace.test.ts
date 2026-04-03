import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Workspace } from "../src/workspace.js";
import { WorkspaceError } from "../src/git.js";
import { runGit } from "../src/git.js";

type WatchStatusModule = typeof import("../src/watch-status.js");
type WatchWorkspaceStatus = WatchStatusModule["watchWorkspaceStatus"];
type ParcelWatcherModule = typeof import("@parcel/watcher");
type ParcelWatcherDefault = ParcelWatcherModule["default"];
type ParcelWatcherCallback = Parameters<ParcelWatcherDefault["subscribe"]>[1];
type ParcelWatcherSubscribe = ParcelWatcherDefault["subscribe"];
type ParcelWatcherSubscribeArgs = Parameters<ParcelWatcherSubscribe>;
type ParcelWatcherEventBatch = Parameters<ParcelWatcherCallback>[1];
type ParcelWatcherSubscribeResult = Awaited<ReturnType<ParcelWatcherSubscribe>>;

interface PersistentWorkspaceSubscriptionFailureImport {
  getWorkspaceSubscriptionAttemptCount: () => number;
  ready: Promise<void>;
  watchWorkspaceStatus: WatchWorkspaceStatus;
}

interface WatchSetupSignalImportArgs {
  expectedRootPaths: string[];
  workspaceRootPath: string;
}

interface WatchWorkspaceStatusImport {
  ready: Promise<void>;
  watchWorkspaceStatus: WatchWorkspaceStatus;
}

const tempDirs: string[] = [];
const WATCH_TEST_TIMEOUT_MS = 2_000;

function ignoreWatchError(): void {
  // Ignore watcher warnings in tests that assert only change callbacks.
}

async function makeTempDir(prefix: string): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

async function initRepo(): Promise<string> {
  const repoPath = await makeTempDir("bb-workspace-repo-");
  await runGit(["init", "-b", "main"], { cwd: repoPath });
  await runGit(["config", "user.name", "BB Tests"], { cwd: repoPath });
  await runGit(["config", "user.email", "bb@example.com"], { cwd: repoPath });
  await fs.writeFile(path.join(repoPath, "README.md"), "hello\n", "utf8");
  await runGit(["add", "README.md"], { cwd: repoPath });
  await runGit(["commit", "-m", "Initial commit"], { cwd: repoPath });
  return repoPath;
}

async function initBareRemoteFrom(repoPath: string): Promise<string> {
  const remotePath = await makeTempDir("bb-workspace-remote-");
  const barePath = `${remotePath}.git`;
  await runGit(["clone", "--bare", repoPath, barePath], {
    cwd: path.dirname(repoPath),
  });
  await runGit(["remote", "add", "origin", barePath], { cwd: repoPath });
  await runGit(["push", "-u", "origin", "main"], { cwd: repoPath });
  return barePath;
}

async function addDetachedWorktree(repoPath: string): Promise<string> {
  const worktreeParent = await makeTempDir("bb-workspace-worktree-");
  const worktreePath = path.join(worktreeParent, "env");
  await runGit(["worktree", "add", "--detach", worktreePath, "HEAD"], {
    cwd: repoPath,
  });
  return worktreePath;
}

async function waitForCallCount(
  getCallCount: () => number,
  expectedCount: number,
  timeoutMs = 1_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (getCallCount() >= expectedCount) {
      return;
    }
    await sleep(20);
  }
  throw new Error("Timed out waiting for watcher callback");
}

async function ensureCallCountStays(
  getCallCount: () => number,
  expectedCount: number,
  durationMs = 200,
): Promise<void> {
  const deadline = Date.now() + durationMs;
  while (Date.now() < deadline) {
    if (getCallCount() !== expectedCount) {
      throw new Error("Watcher callback count changed unexpectedly");
    }
    await sleep(20);
  }
}

function isWorkspaceRootSubscription(
  watchArgs: ParcelWatcherSubscribeArgs,
  workspaceRootPath: string,
): boolean {
  const [rootPath, _callback, options] = watchArgs;
  return rootPath === workspaceRootPath && options?.ignore?.includes(".git") === true;
}

function trimOutput(value: string): string {
  return value.trim().replace(/\n+$/u, "");
}

async function resolveExpectedWatchRootPaths(cwd: string): Promise<string[]> {
  const gitDir = trimOutput((await runGit(["rev-parse", "--git-dir"], { cwd })).stdout);
  const commonDir = trimOutput(
    (await runGit(["rev-parse", "--git-common-dir"], { cwd })).stdout,
  );
  return Array.from(
    new Set([
      cwd,
      path.resolve(cwd, gitDir),
      path.resolve(cwd, commonDir),
    ]),
  );
}

async function importWatchWorkspaceStatusWithReadySignal(
  args: WatchSetupSignalImportArgs,
): Promise<WatchWorkspaceStatusImport> {
  const ready = createDeferredPromise<void>();
  const seenRootPaths = new Set<string>();
  vi.resetModules();
  vi.doMock("@parcel/watcher", async () => {
    const actualWatcher =
      await vi.importActual<ParcelWatcherModule>("@parcel/watcher");
    const markReady = (rootPath: string) => {
      seenRootPaths.add(rootPath);
      if (args.expectedRootPaths.every((expectedRootPath) => seenRootPaths.has(expectedRootPath))) {
        ready.resolve(undefined);
      }
    };
    return {
      ...actualWatcher,
      default: {
        ...actualWatcher.default,
        async subscribe(
          ...watchArgs: ParcelWatcherSubscribeArgs
        ): Promise<ParcelWatcherSubscribeResult> {
          const subscription = await actualWatcher.default.subscribe(...watchArgs);
          markReady(watchArgs[0]);
          return subscription;
        },
      },
      async subscribe(
        ...watchArgs: ParcelWatcherSubscribeArgs
      ): Promise<ParcelWatcherSubscribeResult> {
        const subscription = await actualWatcher.subscribe(...watchArgs);
        markReady(watchArgs[0]);
        return subscription;
      },
    };
  });
  const watchStatusModule = await import("../src/watch-status.js");
  return {
    ready: ready.promise,
    watchWorkspaceStatus: watchStatusModule.watchWorkspaceStatus,
  };
}

async function importWatchWorkspaceStatusWithTransientWorkspaceSubscriptionFailure(
  workspaceRootPath: string,
): Promise<WatchWorkspaceStatusImport> {
  let failedWorkspaceSubscription = false;
  const ready = createDeferredPromise<void>();
  vi.resetModules();
  vi.doMock("@parcel/watcher", async () => {
    const actualWatcher =
      await vi.importActual<ParcelWatcherModule>("@parcel/watcher");
    return {
      ...actualWatcher,
      default: {
        ...actualWatcher.default,
        async subscribe(
          ...watchArgs: ParcelWatcherSubscribeArgs
        ): Promise<ParcelWatcherSubscribeResult> {
          if (
            isWorkspaceRootSubscription(watchArgs, workspaceRootPath) &&
            !failedWorkspaceSubscription
          ) {
            failedWorkspaceSubscription = true;
            throw new Error("workspace subscription unavailable");
          }
          const subscription = await actualWatcher.default.subscribe(...watchArgs);
          if (isWorkspaceRootSubscription(watchArgs, workspaceRootPath)) {
            ready.resolve(undefined);
          }
          return subscription;
        }
      },
      async subscribe(
        ...watchArgs: ParcelWatcherSubscribeArgs
      ): Promise<ParcelWatcherSubscribeResult> {
        if (
          isWorkspaceRootSubscription(watchArgs, workspaceRootPath) &&
          !failedWorkspaceSubscription
        ) {
          failedWorkspaceSubscription = true;
          throw new Error("workspace subscription unavailable");
        }
        const subscription = await actualWatcher.subscribe(...watchArgs);
        if (isWorkspaceRootSubscription(watchArgs, workspaceRootPath)) {
          ready.resolve(undefined);
        }
        return subscription;
      },
    };
  });
  const watchStatusModule = await import("../src/watch-status.js");
  return {
    ready: ready.promise,
    watchWorkspaceStatus: watchStatusModule.watchWorkspaceStatus,
  };
}

async function importWatchWorkspaceStatusWithPersistentWorkspaceSubscriptionFailure(
  workspaceRootPath: string,
): Promise<PersistentWorkspaceSubscriptionFailureImport> {
  let workspaceSubscriptionAttemptCount = 0;
  const ready = createDeferredPromise<void>();
  vi.resetModules();
  vi.doMock("@parcel/watcher", async () => {
    const actualWatcher =
      await vi.importActual<ParcelWatcherModule>("@parcel/watcher");
    return {
      ...actualWatcher,
      default: {
        ...actualWatcher.default,
        subscribe(
          ...watchArgs: ParcelWatcherSubscribeArgs
        ): Promise<ParcelWatcherSubscribeResult> {
          if (isWorkspaceRootSubscription(watchArgs, workspaceRootPath)) {
            workspaceSubscriptionAttemptCount += 1;
            ready.resolve(undefined);
            throw new Error("workspace subscription unavailable");
          }
          return actualWatcher.default.subscribe(...watchArgs);
        },
      },
      subscribe(
        ...watchArgs: ParcelWatcherSubscribeArgs
      ): Promise<ParcelWatcherSubscribeResult> {
        if (isWorkspaceRootSubscription(watchArgs, workspaceRootPath)) {
          workspaceSubscriptionAttemptCount += 1;
          ready.resolve(undefined);
          throw new Error("workspace subscription unavailable");
        }
        return actualWatcher.subscribe(...watchArgs);
      },
    };
  });
  const watchStatusModule = await import("../src/watch-status.js");
  return {
    getWorkspaceSubscriptionAttemptCount: () => workspaceSubscriptionAttemptCount,
    ready: ready.promise,
    watchWorkspaceStatus: watchStatusModule.watchWorkspaceStatus,
  };
}

function createMockWatcherSubscription(): ParcelWatcherSubscribeResult {
  return {
    unsubscribe: async () => undefined,
  };
}

function createDeferredPromise<T>(): {
  promise: Promise<T>;
  resolve: (value: T | PromiseLike<T>) => void;
} {
  let resolve:
    | ((value: T | PromiseLike<T>) => void)
    | null = null;
  const promise = new Promise<T>((promiseResolve) => {
    resolve = promiseResolve;
  });
  if (!resolve) {
    throw new Error("Failed to create deferred promise");
  }
  return {
    promise,
    resolve,
  };
}

async function importWatchWorkspaceStatusWithManualWorkspaceEvents(
  workspaceRootPath: string,
): Promise<{
  emitWorkspaceRootEvents: (events: ParcelWatcherEventBatch) => void;
  ready: Promise<void>;
  watchWorkspaceStatus: WatchWorkspaceStatus;
}> {
  let workspaceRootCallback: ParcelWatcherCallback | null = null;
  const ready = createDeferredPromise<void>();
  vi.resetModules();
  vi.doMock("@parcel/watcher", async () => {
    const mockSubscribe = async (
      ...watchArgs: ParcelWatcherSubscribeArgs
    ): Promise<ParcelWatcherSubscribeResult> => {
      const [_rootPath, callback] = watchArgs;
      if (isWorkspaceRootSubscription(watchArgs, workspaceRootPath)) {
        workspaceRootCallback = callback;
        ready.resolve(undefined);
      }
      return createMockWatcherSubscription();
    };
    return {
      default: {
        subscribe: mockSubscribe,
      },
      subscribe: mockSubscribe,
    };
  });
  const watchStatusModule = await import("../src/watch-status.js");
  return {
    emitWorkspaceRootEvents: (events) => {
      if (!workspaceRootCallback) {
        throw new Error("Workspace root watcher has not been installed");
      }
      workspaceRootCallback(null, events);
    },
    ready: ready.promise,
    watchWorkspaceStatus: watchStatusModule.watchWorkspaceStatus,
  };
}

afterEach(async () => {
  vi.useRealTimers();
  vi.doUnmock("@parcel/watcher");
  vi.resetModules();
  await Promise.all(
    tempDirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })),
  );
});

describe("Workspace", () => {
  it("reports clean, dirty, untracked-only, and mixed workspace states", async () => {
    const repoPath = await initRepo();
    const workspace = new Workspace(repoPath);

    expect((await workspace.getStatus()).workingTree.state).toBe("clean");

    await fs.writeFile(path.join(repoPath, "README.md"), "dirty\n", "utf8");
    expect((await workspace.getStatus()).workingTree.state).toBe("dirty_uncommitted");

    await workspace.reset();
    await fs.writeFile(path.join(repoPath, "notes.txt"), "note\n", "utf8");
    const untrackedStatus = await workspace.getStatus();
    expect(untrackedStatus.workingTree.state).toBe("untracked");
    expect(untrackedStatus.workingTree.changedFiles).toBe(1);

    await fs.writeFile(path.join(repoPath, "README.md"), "dirty with note\n", "utf8");
    const mixedStatus = await workspace.getStatus();
    expect(mixedStatus.workingTree.state).toBe("dirty_uncommitted");
    expect(mixedStatus.workingTree.changedFiles).toBe(2);
  });

  it("returns grouped status details only when merge-base data is requested", async () => {
    const repoPath = await initRepo();
    await runGit(["checkout", "-b", "feature"], { cwd: repoPath });
    await fs.writeFile(path.join(repoPath, "README.md"), "feature\n", "utf8");
    await runGit(["add", "README.md"], { cwd: repoPath });
    await runGit(["commit", "-m", "Feature commit"], { cwd: repoPath });

    const workspace = new Workspace(repoPath);
    const localOnlyStatus = await workspace.getStatus();
    expect(localOnlyStatus.mergeBase).toBeNull();
    expect(localOnlyStatus.workingTree.state).toBe("clean");

    const status = await workspace.getStatus({ mergeBaseBranch: "main" });
    expect(status.branch.currentBranch).toBe("feature");
    expect(status.branch.defaultBranch).toBe("main");
    expect(status.mergeBase).toMatchObject({
      mergeBaseBranch: "main",
      aheadCount: 1,
      behindCount: 0,
      hasCommittedUnmergedChanges: true,
    });
    expect(status.mergeBase?.commits[0]?.subject).toBe("Feature commit");
  });

  it("reports untracked files plus committed unmerged changes as dirty_and_committed_unmerged", async () => {
    const repoPath = await initRepo();
    await runGit(["checkout", "-b", "feature"], { cwd: repoPath });
    await fs.writeFile(path.join(repoPath, "README.md"), "feature\n", "utf8");
    await runGit(["add", "README.md"], { cwd: repoPath });
    await runGit(["commit", "-m", "Feature commit"], { cwd: repoPath });
    await fs.writeFile(path.join(repoPath, "notes.txt"), "untracked pending\n", "utf8");

    const workspace = new Workspace(repoPath);
    const status = await workspace.getStatus({ mergeBaseBranch: "main" });

    expect(status.workingTree.state).toBe("dirty_and_committed_unmerged");
    expect(status.workingTree.changedFiles).toBe(1);
    expect(status.workingTree.files).toEqual([
      {
        path: "notes.txt",
        status: "??",
      },
    ]);
    expect(status.mergeBase).toMatchObject({
      mergeBaseBranch: "main",
      hasCommittedUnmergedChanges: true,
      aheadCount: 1,
      behindCount: 0,
    });
  });

  it("returns diff content for each supported target", async () => {
    const repoPath = await initRepo();
    await runGit(["checkout", "-b", "feature"], { cwd: repoPath });
    await fs.writeFile(path.join(repoPath, "README.md"), "feature\n", "utf8");
    await runGit(["add", "README.md"], { cwd: repoPath });
    await runGit(["commit", "-m", "Feature commit"], { cwd: repoPath });
    await fs.writeFile(path.join(repoPath, "README.md"), "feature plus pending\n", "utf8");
    await fs.writeFile(path.join(repoPath, "notes.txt"), "untracked pending\n", "utf8");

    const workspace = new Workspace(repoPath);
    const status = await workspace.getStatus({ mergeBaseBranch: "main" });
    const commitSha = status.mergeBase?.commits[0]?.sha;
    expect(commitSha).toBeDefined();

    const uncommitted = await workspace.getDiff({
      target: { type: "uncommitted" },
    });
    expect(uncommitted.diff).toContain("feature plus pending");
    expect(uncommitted.diff).toContain("untracked pending");
    expect(uncommitted.files).toContain("README.md");
    expect(uncommitted.files).toContain("notes.txt");
    expect(uncommitted.shortstat).toContain("2 files changed");

    const branchCommitted = await workspace.getDiff({
      target: { type: "branch_committed", mergeBaseBranch: "main" },
    });
    expect(branchCommitted.diff).toContain("+feature");

    const all = await workspace.getDiff({
      target: { type: "all", mergeBaseBranch: "main" },
    });
    expect(all.diff).toContain("feature plus pending");
    expect(all.diff).toContain("untracked pending");
    expect(all.files).toContain("README.md");
    expect(all.files).toContain("notes.txt");
    expect(all.shortstat).toContain("2 files changed");

    const commitOnly = await workspace.getDiff({
      target: { type: "commit", sha: commitSha! },
    });
    expect(commitOnly.diff).toContain("+feature");
  });

  it("includes untracked files across multiple diff batches", async () => {
    const repoPath = await initRepo();
    const workspace = new Workspace(repoPath);

    await Promise.all(
      Array.from({ length: 12 }, async (_, index) => {
        await fs.writeFile(
          path.join(repoPath, `note-${index}.txt`),
          `untracked ${index}\n`,
          "utf8",
        );
      }),
    );

    const diff = await workspace.getDiff({
      target: { type: "uncommitted" },
    });

    expect(diff.diff).toContain("untracked 11");
    expect(diff.files).toContain("note-11.txt");
    expect(diff.shortstat).toContain("12 files changed");
  });

  it("commits staged work and resets dirty changes", async () => {
    const repoPath = await initRepo();
    const workspace = new Workspace(repoPath);

    await fs.writeFile(path.join(repoPath, "README.md"), "commit me\n", "utf8");
    const commit = await workspace.commit({
      message: "Commit from workspace",
      noVerify: false,
    });
    const head = (
      await runGit(["rev-parse", "HEAD"], { cwd: repoPath })
    ).stdout.trim();
    expect(commit.commitSha).toBe(head);

    await fs.writeFile(path.join(repoPath, "README.md"), "modified again\n", "utf8");
    await fs.writeFile(path.join(repoPath, "temp.txt"), "temporary\n", "utf8");
    await workspace.reset();

    expect((await workspace.getStatus()).workingTree.state).toBe("clean");
    await expect(fs.stat(path.join(repoPath, "temp.txt"))).rejects.toThrow();
  });

  it("supports checkout, detach, stash, and stashPop", async () => {
    const repoPath = await initRepo();
    await runGit(["checkout", "-b", "feature"], { cwd: repoPath });
    await fs.writeFile(path.join(repoPath, "README.md"), "stash me\n", "utf8");

    const workspace = new Workspace(repoPath);
    const stashRef = await workspace.stash("save changes");
    expect(stashRef).toMatch(/^stash@\{/u);
    expect((await workspace.getStatus()).workingTree.state).toBe("clean");

    await workspace.detachHead();
    expect(await workspace.currentBranch).toBeUndefined();

    await workspace.checkoutBranch("feature");
    expect(await workspace.currentBranch).toBe("feature");

    await workspace.stashPop(stashRef ?? undefined);
    expect((await workspace.getStatus()).workingTree.state).toBe("dirty_uncommitted");
  });

  it("squash merges into the target branch using a temporary worktree", async () => {
    const repoPath = await initRepo();
    await initBareRemoteFrom(repoPath);
    await runGit(["checkout", "-b", "feature"], { cwd: repoPath });
    await fs.writeFile(path.join(repoPath, "README.md"), "squash\n", "utf8");
    await runGit(["add", "README.md"], { cwd: repoPath });
    await runGit(["commit", "-m", "Feature work"], { cwd: repoPath });
    await runGit(["branch", "-D", "main"], { cwd: repoPath });

    const workspace = new Workspace(repoPath);
    const result = await workspace.squashMergeInto({
      targetBranch: "main",
      commitMessage: "feat: squash merge feature into main",
    });

    const targetBranchSubject = (
      await runGit(["log", "-1", "--pretty=%s", "main"], { cwd: repoPath })
    ).stdout.trim();
    expect(result.merged).toBe(true);
    expect(targetBranchSubject).toBe("feat: squash merge feature into main");
  });

  it("rejects git mutations for non-git directories", async () => {
    const folder = await makeTempDir("bb-workspace-nongit-");
    const workspace = new Workspace(folder);

    expect(await workspace.isGitRepo).toBe(false);
    expect(await workspace.currentBranch).toBeUndefined();
    await expect(
      workspace.commit({ message: "nope", noVerify: false }),
    ).rejects.toThrow(/not a git repository/u);
    await expect(workspace.getStatus()).rejects.toThrow(WorkspaceError);
  });

  it("watches workspace status changes without duplicate callbacks for the same burst", async () => {
    const repoPath = await initRepo();
    const { ready, watchWorkspaceStatus } = await importWatchWorkspaceStatusWithReadySignal({
      expectedRootPaths: await resolveExpectedWatchRootPaths(repoPath),
      workspaceRootPath: repoPath,
    });
    const calls: number[] = [];
    const stopWatching = watchWorkspaceStatus(repoPath, {
      onChange: () => {
        calls.push(Date.now());
      },
      onWatchError: ignoreWatchError,
    });

    try {
      await ready;
      await fs.writeFile(path.join(repoPath, "README.md"), "watch me\n", "utf8");
      await waitForCallCount(() => calls.length, 1, WATCH_TEST_TIMEOUT_MS);
      expect(calls).toHaveLength(1);
    } finally {
      stopWatching();
    }
  });

  it("flushes sustained workspace event bursts at max wait", async () => {
    vi.useFakeTimers();
    const repoPath = await initRepo();
    const {
      emitWorkspaceRootEvents,
      ready,
      watchWorkspaceStatus,
    } = await importWatchWorkspaceStatusWithManualWorkspaceEvents(repoPath);
    const calls: number[] = [];
    const stopWatching = watchWorkspaceStatus(repoPath, {
      onChange: () => {
        calls.push(Date.now());
      },
      onWatchError: ignoreWatchError,
    });

    try {
      await ready;
      for (let elapsedMs = 0; elapsedMs < 480; elapsedMs += 60) {
        emitWorkspaceRootEvents([
          {
            path: path.join(repoPath, "README.md"),
            type: "update",
          },
        ]);
        await vi.advanceTimersByTimeAsync(60);
      }

      expect(calls).toHaveLength(0);

      await vi.advanceTimersByTimeAsync(20);
      expect(calls).toHaveLength(1);
    } finally {
      stopWatching();
      vi.useRealTimers();
    }
  });

  it("does not emit callbacks when a clean workspace watch starts", async () => {
    const repoPath = await initRepo();
    const { ready, watchWorkspaceStatus } = await importWatchWorkspaceStatusWithReadySignal({
      expectedRootPaths: await resolveExpectedWatchRootPaths(repoPath),
      workspaceRootPath: repoPath,
    });
    const calls: number[] = [];
    const stopWatching = watchWorkspaceStatus(repoPath, {
      onChange: () => {
        calls.push(Date.now());
      },
      onWatchError: ignoreWatchError,
    });

    try {
      await ready;
      await ensureCallCountStays(() => calls.length, 0);
    } finally {
      stopWatching();
    }
  });

  it("detects branch-ref updates through metadata watches", async () => {
    const repoPath = await initRepo();
    const workspace = new Workspace(repoPath);
    const { ready, watchWorkspaceStatus } = await importWatchWorkspaceStatusWithReadySignal({
      expectedRootPaths: await resolveExpectedWatchRootPaths(repoPath),
      workspaceRootPath: repoPath,
    });
    const calls: number[] = [];
    const stopWatching = watchWorkspaceStatus(repoPath, {
      onChange: () => {
        calls.push(Date.now());
      },
      onWatchError: ignoreWatchError,
    });

    try {
      await ready;
      await runGit(["checkout", "-b", "feature"], { cwd: repoPath });
      await waitForCallCount(() => calls.length, 1, WATCH_TEST_TIMEOUT_MS);
      expect(await workspace.currentBranch).toBe("feature");
    } finally {
      stopWatching();
    }
  });

  it("detects repeated edits to an already dirty file", async () => {
    const repoPath = await initRepo();
    const workspace = new Workspace(repoPath);
    const { ready, watchWorkspaceStatus } = await importWatchWorkspaceStatusWithReadySignal({
      expectedRootPaths: await resolveExpectedWatchRootPaths(repoPath),
      workspaceRootPath: repoPath,
    });
    const calls: number[] = [];
    const stopWatching = watchWorkspaceStatus(repoPath, {
      onChange: () => {
        calls.push(Date.now());
      },
      onWatchError: ignoreWatchError,
    });

    try {
      await ready;
      await fs.writeFile(path.join(repoPath, "README.md"), "first edit\n", "utf8");
      await waitForCallCount(() => calls.length, 1, WATCH_TEST_TIMEOUT_MS);

      await fs.writeFile(path.join(repoPath, "README.md"), "second edit\n", "utf8");
      await waitForCallCount(() => calls.length, 2, WATCH_TEST_TIMEOUT_MS);

      const diff = await workspace.getDiff({
        target: { type: "uncommitted" },
      });
      expect(diff.diff).toContain("second edit");
    } finally {
      stopWatching();
    }
  });

  it("detects repeated edits to dirty files with spaced file names", async () => {
    const repoPath = await initRepo();
    await fs.writeFile(path.join(repoPath, "a b.txt"), "base\n", "utf8");
    await runGit(["add", "a b.txt"], { cwd: repoPath });
    await runGit(["commit", "-m", "Add spaced file"], { cwd: repoPath });

    const workspace = new Workspace(repoPath);
    const { ready, watchWorkspaceStatus } = await importWatchWorkspaceStatusWithReadySignal({
      expectedRootPaths: await resolveExpectedWatchRootPaths(repoPath),
      workspaceRootPath: repoPath,
    });
    const calls: number[] = [];
    const stopWatching = watchWorkspaceStatus(repoPath, {
      onChange: () => {
        calls.push(Date.now());
      },
      onWatchError: ignoreWatchError,
    });

    try {
      await ready;
      await fs.writeFile(path.join(repoPath, "a b.txt"), "first edit\n", "utf8");
      await waitForCallCount(() => calls.length, 1, WATCH_TEST_TIMEOUT_MS);

      await fs.writeFile(path.join(repoPath, "a b.txt"), "second edit\n", "utf8");
      await waitForCallCount(() => calls.length, 2, WATCH_TEST_TIMEOUT_MS);

      const diff = await workspace.getDiff({
        target: { type: "uncommitted" },
      });
      expect(diff.diff).toContain("second edit");
    } finally {
      stopWatching();
    }
  });

  it("retries workspace subscriptions when setup fails", async () => {
    const repoPath = await initRepo();
    const {
      ready,
      watchWorkspaceStatus,
    } = await importWatchWorkspaceStatusWithTransientWorkspaceSubscriptionFailure(repoPath);
    const calls: number[] = [];
    const stopWatching = watchWorkspaceStatus(repoPath, {
      onChange: () => {
        calls.push(Date.now());
      },
      onWatchError: ignoreWatchError,
    });

    try {
      await ready;
      expect(calls).toHaveLength(0);

      await fs.writeFile(path.join(repoPath, "README.md"), "retried edit\n", "utf8");
      await waitForCallCount(() => calls.length, 1, WATCH_TEST_TIMEOUT_MS);
      expect(calls).toHaveLength(1);
    } finally {
      stopWatching();
    }
  });

  it("reports persistent workspace watch startup failures once while retries continue", async () => {
    const repoPath = await initRepo();
    const {
      getWorkspaceSubscriptionAttemptCount,
      ready,
      watchWorkspaceStatus,
    } =
      await importWatchWorkspaceStatusWithPersistentWorkspaceSubscriptionFailure(repoPath);
    const calls: number[] = [];
    const watchErrors: string[] = [];
    const stopWatching = watchWorkspaceStatus(repoPath, {
      onChange: () => {
        calls.push(Date.now());
      },
      onWatchError: (error) => {
        watchErrors.push(`${error.rootPath}:${error.message}`);
      },
    });

    try {
      await ready;
      await waitForCallCount(() => watchErrors.length, 1, WATCH_TEST_TIMEOUT_MS);
      await waitForCallCount(
        getWorkspaceSubscriptionAttemptCount,
        2,
        WATCH_TEST_TIMEOUT_MS,
      );
      expect(calls).toHaveLength(0);
      expect(watchErrors).toHaveLength(1);
      expect(watchErrors[0]).toContain(repoPath);
      expect(watchErrors[0]).toContain("workspace subscription unavailable");
      expect(getWorkspaceSubscriptionAttemptCount()).toBeGreaterThan(1);
    } finally {
      stopWatching();
    }
  });

  it("detects namespaced branch ref updates for detached worktree environments", async () => {
    const repoPath = await initRepo();
    const initialHead = (await runGit(["rev-parse", "HEAD"], { cwd: repoPath })).stdout.trim();
    await fs.writeFile(path.join(repoPath, "README.md"), "second commit\n", "utf8");
    await runGit(["add", "README.md"], { cwd: repoPath });
    await runGit(["commit", "-m", "Second commit"], { cwd: repoPath });
    const nextHead = (await runGit(["rev-parse", "HEAD"], { cwd: repoPath })).stdout.trim();
    const worktreePath = await addDetachedWorktree(repoPath);
    const workspace = new Workspace(worktreePath);
    const { ready, watchWorkspaceStatus } = await importWatchWorkspaceStatusWithReadySignal({
      expectedRootPaths: await resolveExpectedWatchRootPaths(worktreePath),
      workspaceRootPath: worktreePath,
    });
    const calls: number[] = [];
    const stopWatching = watchWorkspaceStatus(worktreePath, {
      onChange: () => {
        calls.push(Date.now());
      },
      onWatchError: ignoreWatchError,
    });

    try {
      await ready;
      await runGit(["update-ref", "refs/heads/feature/foo", initialHead], {
        cwd: repoPath,
      });
      await waitForCallCount(() => calls.length, 1, WATCH_TEST_TIMEOUT_MS);

      await runGit(["update-ref", "refs/heads/feature/foo", nextHead], {
        cwd: repoPath,
      });
      await waitForCallCount(() => calls.length, 2, WATCH_TEST_TIMEOUT_MS);
    } finally {
      stopWatching();
    }
  });

  it("stops emitting callbacks after watch teardown", async () => {
    const repoPath = await initRepo();
    const { ready, watchWorkspaceStatus } = await importWatchWorkspaceStatusWithReadySignal({
      expectedRootPaths: await resolveExpectedWatchRootPaths(repoPath),
      workspaceRootPath: repoPath,
    });
    const calls: number[] = [];
    const stopWatching = watchWorkspaceStatus(repoPath, {
      onChange: () => {
        calls.push(Date.now());
      },
      onWatchError: ignoreWatchError,
    });

    await ready;
    stopWatching();
    await fs.writeFile(path.join(repoPath, "README.md"), "no callbacks\n", "utf8");
    await ensureCallCountStays(() => calls.length, 0);

    expect(calls).toHaveLength(0);
  });
});
