import { execFile } from "node:child_process";
import fsSync from "node:fs";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { promisify } from "node:util";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createDeferredPromise } from "@bb/test-helpers";

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

interface RunGitArgs {
  args: string[];
  cwd: string;
}

interface WatchSetupSignalImportArgs {
  expectedRootPaths: string[];
  workspaceRootPath: string;
}

interface WatchWorkspaceStatusImport {
  ready: Promise<void>;
  watchWorkspaceStatus: WatchWorkspaceStatus;
}

const execFileAsync = promisify(execFile);
const tempDirs: string[] = [];
const WATCH_READY_SETTLE_MS = 100;
const WATCH_TEST_TIMEOUT_MS = 2_000;

function ignoreWatchError(): void {
  // Ignore watcher warnings in tests that assert only change callbacks.
}

async function runGit(args: RunGitArgs): Promise<{ stdout: string; stderr: string }> {
  return execFileAsync("git", args.args, {
    cwd: args.cwd,
    encoding: "utf8",
  });
}

async function makeTempDir(prefix: string): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

async function initRepo(): Promise<string> {
  const repoPath = await makeTempDir("bb-workspace-repo-");
  await runGit({ args: ["init", "-b", "main"], cwd: repoPath });
  await runGit({ args: ["config", "user.name", "BB Tests"], cwd: repoPath });
  await runGit({ args: ["config", "user.email", "bb@example.com"], cwd: repoPath });
  await fs.writeFile(path.join(repoPath, "README.md"), "hello\n", "utf8");
  await runGit({ args: ["add", "README.md"], cwd: repoPath });
  await runGit({ args: ["commit", "-m", "Initial commit"], cwd: repoPath });
  return repoPath;
}

async function addDetachedWorktree(repoPath: string): Promise<string> {
  const worktreeParent = await makeTempDir("bb-workspace-worktree-");
  const worktreePath = path.join(worktreeParent, "env");
  await runGit({
    args: ["worktree", "add", "--detach", worktreePath, "HEAD"],
    cwd: repoPath,
  });
  return worktreePath;
}

async function replaceDotGitWithSymlink(repoPath: string): Promise<void> {
  const originalDotGitPath = path.join(repoPath, ".git");
  const gitDirParent = await makeTempDir("bb-workspace-gitdir-");
  const movedGitDirPath = path.join(gitDirParent, "gitdir");
  await fs.rename(originalDotGitPath, movedGitDirPath);
  await fs.symlink(movedGitDirPath, originalDotGitPath, "dir");
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
  return (
    normalizeWatchPath(rootPath) === normalizeWatchPath(workspaceRootPath) &&
    options?.ignore?.includes(".git") === true
  );
}

function normalizeWatchPath(inputPath: string): string {
  try {
    return fsSync.realpathSync.native(inputPath);
  } catch {
    return path.resolve(inputPath);
  }
}

function trimOutput(value: string): string {
  return value.trim().replace(/\n+$/u, "");
}

function normalizeEventBatch(
  events: ParcelWatcherEventBatch,
): ParcelWatcherEventBatch {
  return events.map((event) => ({
    ...event,
    path: path.isAbsolute(event.path)
      ? normalizeWatchPath(event.path)
      : event.path,
  }));
}

async function resolveExpectedWatchRootPaths(cwd: string): Promise<string[]> {
  const gitDir = trimOutput(
    (
      await runGit({
        args: ["rev-parse", "--git-dir"],
        cwd,
      })
    ).stdout,
  );
  const commonDir = trimOutput(
    (
      await runGit({
        args: ["rev-parse", "--git-common-dir"],
        cwd,
      })
    ).stdout,
  );
  return Array.from(
    new Set([
      normalizeWatchPath(cwd),
      normalizeWatchPath(path.resolve(cwd, gitDir)),
      normalizeWatchPath(path.resolve(cwd, commonDir)),
    ]),
  );
}

async function importWatchWorkspaceStatusWithReadySignal(
  args: WatchSetupSignalImportArgs,
): Promise<WatchWorkspaceStatusImport> {
  const ready = createDeferredPromise<void>();
  const expectedRootPaths = args.expectedRootPaths.map(normalizeWatchPath);
  const seenRootPaths = new Set<string>();
  let readyScheduled = false;
  vi.resetModules();
  vi.doMock("@parcel/watcher", async () => {
    const actualWatcher =
      await vi.importActual<ParcelWatcherModule>("@parcel/watcher");
    const markReady = (rootPath: string) => {
      seenRootPaths.add(normalizeWatchPath(rootPath));
      if (expectedRootPaths.every((expectedRootPath) => seenRootPaths.has(expectedRootPath))) {
        if (readyScheduled) {
          return;
        }
        readyScheduled = true;
        setTimeout(() => {
          ready.resolve(undefined);
        }, WATCH_READY_SETTLE_MS);
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
  let readyScheduled = false;
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
            if (!readyScheduled) {
              readyScheduled = true;
              setTimeout(() => {
                ready.resolve(undefined);
              }, WATCH_READY_SETTLE_MS);
            }
          }
          return subscription;
        },
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
          if (!readyScheduled) {
            readyScheduled = true;
            setTimeout(() => {
              ready.resolve(undefined);
            }, WATCH_READY_SETTLE_MS);
          }
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
      workspaceRootCallback(null, normalizeEventBatch(events));
    },
    ready: ready.promise,
    watchWorkspaceStatus: watchStatusModule.watchWorkspaceStatus,
  };
}

async function importWatchWorkspaceStatusWithManualRootEvents(
  args: WatchSetupSignalImportArgs,
): Promise<{
  emitEvents: (rootPath: string, events: ParcelWatcherEventBatch) => void;
  ready: Promise<void>;
  watchWorkspaceStatus: WatchWorkspaceStatus;
}> {
  const callbacksByRootPath = new Map<string, ParcelWatcherCallback>();
  const ready = createDeferredPromise<void>();
  const expectedRootPaths = args.expectedRootPaths.map(normalizeWatchPath);
  const seenRootPaths = new Set<string>();
  vi.resetModules();
  vi.doMock("@parcel/watcher", async () => {
    const mockSubscribe = async (
      ...watchArgs: ParcelWatcherSubscribeArgs
    ): Promise<ParcelWatcherSubscribeResult> => {
      const [rootPath, callback] = watchArgs;
      const normalizedRootPath = normalizeWatchPath(rootPath);
      callbacksByRootPath.set(normalizedRootPath, callback);
      seenRootPaths.add(normalizedRootPath);
      if (expectedRootPaths.every((expectedRootPath) => seenRootPaths.has(expectedRootPath))) {
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
    emitEvents: (rootPath, events) => {
      const callback = callbacksByRootPath.get(normalizeWatchPath(rootPath));
      if (!callback) {
        throw new Error(`Watcher has not been installed for ${rootPath}`);
      }
      callback(null, normalizeEventBatch(events));
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

describe("watchWorkspaceStatus", () => {
  it("watches workspace status changes without duplicate callbacks for the same burst", async () => {
    const repoPath = await initRepo();
    const { ready, watchWorkspaceStatus } =
      await importWatchWorkspaceStatusWithReadySignal({
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

  it("reports change callback failures and continues watching", async () => {
    vi.useFakeTimers();
    const repoPath = await initRepo();
    const {
      emitWorkspaceRootEvents,
      ready,
      watchWorkspaceStatus,
    } = await importWatchWorkspaceStatusWithManualWorkspaceEvents(repoPath);
    let callbackCount = 0;
    const watchErrors: string[] = [];
    const stopWatching = watchWorkspaceStatus(repoPath, {
      onChange: () => {
        callbackCount += 1;
        if (callbackCount === 1) {
          throw new Error("boom");
        }
      },
      onWatchError: (error) => {
        watchErrors.push(`${error.rootPath}:${error.message}`);
      },
    });

    try {
      await ready;
      emitWorkspaceRootEvents([
        {
          path: path.join(repoPath, "README.md"),
          type: "update",
        },
      ]);
      await vi.advanceTimersByTimeAsync(75);
      expect(callbackCount).toBe(1);
      expect(watchErrors).toHaveLength(1);
      expect(watchErrors[0]).toContain(repoPath);
      expect(watchErrors[0]).toContain("Workspace status callback failed: boom");

      emitWorkspaceRootEvents([
        {
          path: path.join(repoPath, "README.md"),
          type: "update",
        },
      ]);
      await vi.advanceTimersByTimeAsync(75);
      expect(callbackCount).toBe(2);
      expect(watchErrors).toHaveLength(1);
    } finally {
      stopWatching();
      vi.useRealTimers();
    }
  });

  it("does not emit callbacks when a clean workspace watch starts", async () => {
    const repoPath = await initRepo();
    const { ready, watchWorkspaceStatus } =
      await importWatchWorkspaceStatusWithReadySignal({
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

  it("keeps workspace root watching when git metadata watch resolution fails", async () => {
    const repoPath = await initRepo();
    await replaceDotGitWithSymlink(repoPath);
    const { ready, watchWorkspaceStatus } = await importWatchWorkspaceStatusWithReadySignal({
      expectedRootPaths: [repoPath],
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
      await fs.writeFile(path.join(repoPath, "README.md"), "symlink edit\n", "utf8");
      await waitForCallCount(() => calls.length, 1, WATCH_TEST_TIMEOUT_MS);
    } finally {
      stopWatching();
    }
  });

  it("detects branch-ref updates through metadata watches", async () => {
    const repoPath = await initRepo();
    const { ready, watchWorkspaceStatus } =
      await importWatchWorkspaceStatusWithReadySignal({
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
      await runGit({ args: ["checkout", "-b", "feature"], cwd: repoPath });
      await waitForCallCount(() => calls.length, 1, WATCH_TEST_TIMEOUT_MS);
      const branchOutput = await runGit({
        args: ["branch", "--show-current"],
        cwd: repoPath,
      });
      expect(branchOutput.stdout.trim()).toBe("feature");
    } finally {
      stopWatching();
    }
  });

  it("detects repeated edits to an already dirty file", async () => {
    const repoPath = await initRepo();
    const { ready, watchWorkspaceStatus } =
      await importWatchWorkspaceStatusWithReadySignal({
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

      const diffOutput = await runGit({
        args: ["diff", "HEAD", "--"],
        cwd: repoPath,
      });
      expect(diffOutput.stdout).toContain("second edit");
    } finally {
      stopWatching();
    }
  });

  it("detects repeated edits to dirty files with spaced file names", async () => {
    const repoPath = await initRepo();
    await fs.writeFile(path.join(repoPath, "a b.txt"), "base\n", "utf8");
    await runGit({ args: ["add", "a b.txt"], cwd: repoPath });
    await runGit({ args: ["commit", "-m", "Add spaced file"], cwd: repoPath });

    const { ready, watchWorkspaceStatus } =
      await importWatchWorkspaceStatusWithReadySignal({
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

      const diffOutput = await runGit({
        args: ["diff", "HEAD", "--"],
        cwd: repoPath,
      });
      expect(diffOutput.stdout).toContain("second edit");
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
      const initialCallCount = calls.length;
      await fs.writeFile(path.join(repoPath, "README.md"), "retried edit\n", "utf8");
      await waitForCallCount(
        () => calls.length,
        initialCallCount + 1,
        WATCH_TEST_TIMEOUT_MS,
      );
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
      expect(watchErrors).toHaveLength(1);
      expect(watchErrors[0]).toContain(repoPath);
      expect(watchErrors[0]).toContain("workspace subscription unavailable");
      expect(getWorkspaceSubscriptionAttemptCount()).toBeGreaterThan(1);
    } finally {
      stopWatching();
    }
  });

  it("ignores shared common-dir index updates for detached worktree environments", async () => {
    const repoPath = await initRepo();
    const worktreePath = await addDetachedWorktree(repoPath);
    const expectedRootPaths = await resolveExpectedWatchRootPaths(worktreePath);
    const commonDirPath = path.resolve(
      worktreePath,
      trimOutput(
        (
          await runGit({
            args: ["rev-parse", "--git-common-dir"],
            cwd: worktreePath,
          })
        ).stdout,
      ),
    );
    const {
      emitEvents,
      ready,
      watchWorkspaceStatus,
    } = await importWatchWorkspaceStatusWithManualRootEvents({
      expectedRootPaths,
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
      emitEvents(commonDirPath, [
        {
          path: path.join(commonDirPath, "index"),
          type: "update",
        },
      ]);
      await ensureCallCountStays(() => calls.length, 0);
    } finally {
      stopWatching();
    }
  });

  it("detects namespaced branch ref updates for detached worktree environments", async () => {
    const repoPath = await initRepo();
    const initialHead = (
      await runGit({ args: ["rev-parse", "HEAD"], cwd: repoPath })
    ).stdout.trim();
    await fs.writeFile(path.join(repoPath, "README.md"), "second commit\n", "utf8");
    await runGit({ args: ["add", "README.md"], cwd: repoPath });
    await runGit({ args: ["commit", "-m", "Second commit"], cwd: repoPath });
    const nextHead = (
      await runGit({ args: ["rev-parse", "HEAD"], cwd: repoPath })
    ).stdout.trim();
    const worktreePath = await addDetachedWorktree(repoPath);
    const { ready, watchWorkspaceStatus } =
      await importWatchWorkspaceStatusWithReadySignal({
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
      await runGit({
        args: ["update-ref", "refs/heads/feature/foo", initialHead],
        cwd: repoPath,
      });
      await waitForCallCount(() => calls.length, 1, WATCH_TEST_TIMEOUT_MS);

      await runGit({
        args: ["update-ref", "refs/heads/feature/foo", nextHead],
        cwd: repoPath,
      });
      await waitForCallCount(() => calls.length, 2, WATCH_TEST_TIMEOUT_MS);
    } finally {
      stopWatching();
    }
  });

  it("stops emitting callbacks after watch teardown", async () => {
    const repoPath = await initRepo();
    const { ready, watchWorkspaceStatus } =
      await importWatchWorkspaceStatusWithReadySignal({
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
