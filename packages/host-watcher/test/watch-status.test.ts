import { execFile } from "node:child_process";
import fsSync from "node:fs";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import parcelWatcher from "@parcel/watcher";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createDeferredPromise } from "@bb/test-helpers";
import { watchWorkspaceStatus as watchWorkspaceStatusImpl } from "../src/watch-status.js";

type WatchWorkspaceStatus = typeof watchWorkspaceStatusImpl;
type WatchWorkspaceStatusArgs = Parameters<WatchWorkspaceStatus>[1];
type WorkspaceStatusChangeEvent = Parameters<
  WatchWorkspaceStatusArgs["onChange"]
>[0];
type ParcelWatcherSubscribe = (typeof import("@parcel/watcher"))["subscribe"];
type ParcelWatcherCallback = Parameters<ParcelWatcherSubscribe>[1];
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

interface ManualWorkspaceEventsImport extends WatchWorkspaceStatusImport {
  emitWorkspaceRootError: (error: Error) => void;
  emitWorkspaceRootEvents: (events: ParcelWatcherEventBatch) => void;
  getWorkspaceRootSubscriptionCount: () => number;
}

type Sleep = (durationMs: number) => Promise<void>;

const execFileAsync = promisify(execFile);
const tempDirs: string[] = [];
const WATCH_READY_SETTLE_MS = 100;
const WATCH_TEST_TIMEOUT_MS = 2_000;
const FSEVENTS_DROPPED_EVENTS_ERROR_MESSAGE =
  "Events were dropped by the FSEvents client. File system must be re-scanned.";
const sleep: Sleep = (durationMs) =>
  new Promise((resolve) => {
    setTimeout(() => {
      resolve();
    }, durationMs);
  });

async function settleAsyncWatchWork(): Promise<void> {
  // Let watcher startup/retry microtasks finish before restoring shared spies.
  await Promise.resolve();
  await sleep(0);
  await Promise.resolve();
}

function ignoreWatchError(): void {
  // Ignore watcher warnings in tests that assert only change callbacks.
}

async function runGit(
  args: RunGitArgs,
): Promise<{ stdout: string; stderr: string }> {
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
  await runGit({
    args: ["config", "user.email", "bb@example.com"],
    cwd: repoPath,
  });
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

async function importWatchWorkspaceStatusWithTransientWorkspaceSubscriptionFailure(
  workspaceRootPath: string,
): Promise<ManualWorkspaceEventsImport> {
  let failedWorkspaceSubscription = false;
  let workspaceRootCallback: ParcelWatcherCallback | null = null;
  let workspaceRootSubscriptionCount = 0;
  const ready = createDeferredPromise<void>();
  let readyScheduled = false;
  const mockSubscribe = async (
    ...watchArgs: ParcelWatcherSubscribeArgs
  ): Promise<ParcelWatcherSubscribeResult> => {
    const [_rootPath, callback] = watchArgs;
    const isWorkspaceRoot = isWorkspaceRootSubscription(
      watchArgs,
      workspaceRootPath,
    );
    if (isWorkspaceRoot && !failedWorkspaceSubscription) {
      failedWorkspaceSubscription = true;
      throw new Error("workspace subscription unavailable");
    }
    if (isWorkspaceRoot) {
      workspaceRootSubscriptionCount += 1;
      workspaceRootCallback = callback;
      if (!readyScheduled) {
        readyScheduled = true;
        setTimeout(() => {
          ready.resolve(undefined);
        }, WATCH_READY_SETTLE_MS);
      }
    }
    return createMockWatcherSubscription();
  };
  vi.spyOn(parcelWatcher, "subscribe").mockImplementation(mockSubscribe);
  return {
    emitWorkspaceRootError: (error) => {
      if (!workspaceRootCallback) {
        throw new Error("Workspace root watcher has not been installed");
      }
      workspaceRootCallback(error, []);
    },
    emitWorkspaceRootEvents: (events) => {
      if (!workspaceRootCallback) {
        throw new Error("Workspace root watcher has not been installed");
      }
      workspaceRootCallback(null, normalizeEventBatch(events));
    },
    getWorkspaceRootSubscriptionCount: () => workspaceRootSubscriptionCount,
    ready: ready.promise,
    watchWorkspaceStatus: watchWorkspaceStatusImpl,
  };
}

async function importWatchWorkspaceStatusWithPersistentWorkspaceSubscriptionFailure(
  workspaceRootPath: string,
): Promise<PersistentWorkspaceSubscriptionFailureImport> {
  let workspaceSubscriptionAttemptCount = 0;
  const ready = createDeferredPromise<void>();
  const mockSubscribe = (
    ...watchArgs: ParcelWatcherSubscribeArgs
  ): Promise<ParcelWatcherSubscribeResult> => {
    if (isWorkspaceRootSubscription(watchArgs, workspaceRootPath)) {
      workspaceSubscriptionAttemptCount += 1;
      ready.resolve(undefined);
      throw new Error("workspace subscription unavailable");
    }
    return Promise.resolve(createMockWatcherSubscription());
  };
  vi.spyOn(parcelWatcher, "subscribe").mockImplementation(mockSubscribe);
  return {
    getWorkspaceSubscriptionAttemptCount: () =>
      workspaceSubscriptionAttemptCount,
    ready: ready.promise,
    watchWorkspaceStatus: watchWorkspaceStatusImpl,
  };
}

function createMockWatcherSubscription(): ParcelWatcherSubscribeResult {
  return {
    unsubscribe: async () => undefined,
  };
}

async function importWatchWorkspaceStatusWithManualWorkspaceEvents(
  workspaceRootPath: string,
): Promise<ManualWorkspaceEventsImport> {
  let workspaceRootCallback: ParcelWatcherCallback | null = null;
  let workspaceRootSubscriptionCount = 0;
  const ready = createDeferredPromise<void>();
  const mockSubscribe = (
    ...watchArgs: ParcelWatcherSubscribeArgs
  ): Promise<ParcelWatcherSubscribeResult> =>
    new Promise<ParcelWatcherSubscribeResult>((resolve) => {
      const [_rootPath, callback] = watchArgs;
      const isWorkspaceRoot = isWorkspaceRootSubscription(
        watchArgs,
        workspaceRootPath,
      );
      if (isWorkspaceRoot) {
        workspaceRootSubscriptionCount += 1;
        workspaceRootCallback = callback;
        ready.resolve(undefined);
      }
      resolve(createMockWatcherSubscription());
    });
  vi.spyOn(parcelWatcher, "subscribe").mockImplementation(mockSubscribe);
  return {
    emitWorkspaceRootError: (error) => {
      if (!workspaceRootCallback) {
        throw new Error("Workspace root watcher has not been installed");
      }
      workspaceRootCallback(error, []);
    },
    emitWorkspaceRootEvents: (events) => {
      if (!workspaceRootCallback) {
        throw new Error("Workspace root watcher has not been installed");
      }
      workspaceRootCallback(null, normalizeEventBatch(events));
    },
    getWorkspaceRootSubscriptionCount: () => workspaceRootSubscriptionCount,
    ready: ready.promise,
    watchWorkspaceStatus: watchWorkspaceStatusImpl,
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
  const mockSubscribe = async (
    ...watchArgs: ParcelWatcherSubscribeArgs
  ): Promise<ParcelWatcherSubscribeResult> => {
    const [rootPath, callback] = watchArgs;
    const normalizedRootPath = normalizeWatchPath(rootPath);
    callbacksByRootPath.set(normalizedRootPath, callback);
    seenRootPaths.add(normalizedRootPath);
    if (
      expectedRootPaths.every((expectedRootPath) =>
        seenRootPaths.has(expectedRootPath),
      )
    ) {
      ready.resolve(undefined);
    }
    return createMockWatcherSubscription();
  };
  vi.spyOn(parcelWatcher, "subscribe").mockImplementation(mockSubscribe);
  return {
    emitEvents: (rootPath, events) => {
      const callback = callbacksByRootPath.get(normalizeWatchPath(rootPath));
      if (!callback) {
        throw new Error(`Watcher has not been installed for ${rootPath}`);
      }
      callback(null, normalizeEventBatch(events));
    },
    ready: ready.promise,
    watchWorkspaceStatus: watchWorkspaceStatusImpl,
  };
}

afterEach(async () => {
  await settleAsyncWatchWork();
  vi.restoreAllMocks();
  await Promise.all(
    tempDirs
      .splice(0)
      .map((dir) => fs.rm(dir, { recursive: true, force: true })),
  );
});

// These tests mutate shared module spies, so keep them out of Vitest parallelism.
describe.sequential("watchWorkspaceStatus", () => {
  it("watches workspace status changes without duplicate callbacks for the same burst", async () => {
    const repoPath = await initRepo();
    const { emitWorkspaceRootEvents, ready, watchWorkspaceStatus } =
      await importWatchWorkspaceStatusWithManualWorkspaceEvents(repoPath);
    const calls: number[] = [];
    const stopWatching = watchWorkspaceStatus(repoPath, {
      onChange: () => {
        calls.push(Date.now());
      },
      onWatchError: ignoreWatchError,
    });

    try {
      await ready;
      emitWorkspaceRootEvents([
        {
          path: path.join(repoPath, "README.md"),
          type: "update",
        },
        {
          path: path.join(repoPath, "README.md"),
          type: "update",
        },
      ]);
      await waitForCallCount(() => calls.length, 1, WATCH_TEST_TIMEOUT_MS);
      expect(calls).toHaveLength(1);
    } finally {
      stopWatching();
    }
  });

  it("flushes sustained workspace event bursts at max wait", async () => {
    const repoPath = await initRepo();
    const { emitWorkspaceRootEvents, ready, watchWorkspaceStatus } =
      await importWatchWorkspaceStatusWithManualWorkspaceEvents(repoPath);
    const calls: number[] = [];
    const stopWatching = watchWorkspaceStatus(repoPath, {
      onChange: () => {
        calls.push(Date.now());
      },
      onWatchError: ignoreWatchError,
    });

    try {
      await ready;
      const firstEventAt = Date.now();
      const eventIntervalMs = 60;
      const earlyFlushGuardMs = 180;
      for (
        let elapsedMs = 0;
        elapsedMs < 600;
        elapsedMs += eventIntervalMs
      ) {
        emitWorkspaceRootEvents([
          {
            path: path.join(repoPath, "README.md"),
            type: "update",
          },
        ]);
        await sleep(eventIntervalMs);
        if (elapsedMs + eventIntervalMs <= earlyFlushGuardMs) {
          expect(calls).toHaveLength(0);
        }
        if (calls.length > 0) {
          break;
        }
      }

      await waitForCallCount(() => calls.length, 1, WATCH_TEST_TIMEOUT_MS);
      expect(calls).toHaveLength(1);
      expect(calls[0] - firstEventAt).toBeLessThan(800);
    } finally {
      stopWatching();
    }
  });

  it("reports change callback failures and continues watching", async () => {
    const repoPath = await initRepo();
    const { emitWorkspaceRootEvents, ready, watchWorkspaceStatus } =
      await importWatchWorkspaceStatusWithManualWorkspaceEvents(repoPath);
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
      await waitForCallCount(
        () => callbackCount,
        1,
        WATCH_TEST_TIMEOUT_MS,
      );
      expect(callbackCount).toBe(1);
      expect(watchErrors).toHaveLength(1);
      expect(watchErrors[0]).toContain(repoPath);
      expect(watchErrors[0]).toContain(
        "Workspace status callback failed: boom",
      );

      emitWorkspaceRootEvents([
        {
          path: path.join(repoPath, "README.md"),
          type: "update",
        },
      ]);
      await waitForCallCount(
        () => callbackCount,
        2,
        WATCH_TEST_TIMEOUT_MS,
      );
      expect(callbackCount).toBe(2);
      expect(watchErrors).toHaveLength(1);
    } finally {
      stopWatching();
    }
  });

  it("rescans after dropped FSEvents errors and after watcher recovery", async () => {
    const repoPath = await initRepo();
    const {
      emitWorkspaceRootError,
      getWorkspaceRootSubscriptionCount,
      ready,
      watchWorkspaceStatus,
    } = await importWatchWorkspaceStatusWithManualWorkspaceEvents(repoPath);
    const calls: WorkspaceStatusChangeEvent[] = [];
    const watchErrors: string[] = [];
    const stopWatching = watchWorkspaceStatus(repoPath, {
      onChange: (event) => {
        calls.push(event);
      },
      onWatchError: (error) => {
        watchErrors.push(`${error.rootPath}:${error.message}`);
      },
    });

    try {
      await ready;
      await sleep(20);
      expect(getWorkspaceRootSubscriptionCount()).toBe(1);
      emitWorkspaceRootError(new Error(FSEVENTS_DROPPED_EVENTS_ERROR_MESSAGE));
      await waitForCallCount(() => calls.length, 1, WATCH_TEST_TIMEOUT_MS);

      expect(watchErrors).toHaveLength(0);
      const expectedChange: WorkspaceStatusChangeEvent = {
        changedPaths: [normalizeWatchPath(repoPath)],
        changeKinds: [
          "workspace-content-changed",
          "workspace-git-changed",
          "shared-git-refs-changed",
        ],
      };
      expect(calls[0]).toEqual(expectedChange);

      await waitForCallCount(
        getWorkspaceRootSubscriptionCount,
        2,
        WATCH_TEST_TIMEOUT_MS,
      );
      await waitForCallCount(() => calls.length, 2, WATCH_TEST_TIMEOUT_MS);
      expect(watchErrors).toHaveLength(0);
      expect(calls).toEqual([expectedChange, expectedChange]);
    } finally {
      stopWatching();
    }
  });

  it("does not emit callbacks when a clean workspace watch starts", async () => {
    const repoPath = await initRepo();
    const { ready, watchWorkspaceStatus } =
      await importWatchWorkspaceStatusWithManualWorkspaceEvents(repoPath);
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
    const { emitWorkspaceRootEvents, ready, watchWorkspaceStatus } =
      await importWatchWorkspaceStatusWithManualWorkspaceEvents(repoPath);
    const calls: number[] = [];
    const stopWatching = watchWorkspaceStatus(repoPath, {
      onChange: () => {
        calls.push(Date.now());
      },
      onWatchError: ignoreWatchError,
    });

    try {
      await ready;
      emitWorkspaceRootEvents([
        {
          path: path.join(repoPath, "README.md"),
          type: "update",
        },
      ]);
      await waitForCallCount(() => calls.length, 1, WATCH_TEST_TIMEOUT_MS);
    } finally {
      stopWatching();
    }
  });

  it("detects branch-ref updates through metadata watches", async () => {
    const repoPath = await initRepo();
    const gitDirPath = normalizeWatchPath(
      path.resolve(
        repoPath,
        trimOutput(
          (
            await runGit({
              args: ["rev-parse", "--git-dir"],
              cwd: repoPath,
            })
          ).stdout,
        ),
      ),
    );
    const { emitEvents, ready, watchWorkspaceStatus } =
      await importWatchWorkspaceStatusWithManualRootEvents({
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
      emitEvents(gitDirPath, [
        {
          path: path.join(gitDirPath, "HEAD"),
          type: "update",
        },
      ]);
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
    const { emitWorkspaceRootEvents, ready, watchWorkspaceStatus } =
      await importWatchWorkspaceStatusWithManualWorkspaceEvents(repoPath);
    const calls: number[] = [];
    const stopWatching = watchWorkspaceStatus(repoPath, {
      onChange: () => {
        calls.push(Date.now());
      },
      onWatchError: ignoreWatchError,
    });

    try {
      await ready;
      await fs.writeFile(
        path.join(repoPath, "README.md"),
        "first edit\n",
        "utf8",
      );
      emitWorkspaceRootEvents([
        {
          path: path.join(repoPath, "README.md"),
          type: "update",
        },
      ]);
      await waitForCallCount(() => calls.length, 1, WATCH_TEST_TIMEOUT_MS);

      await fs.writeFile(
        path.join(repoPath, "README.md"),
        "second edit\n",
        "utf8",
      );
      emitWorkspaceRootEvents([
        {
          path: path.join(repoPath, "README.md"),
          type: "update",
        },
      ]);
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

    const { emitWorkspaceRootEvents, ready, watchWorkspaceStatus } =
      await importWatchWorkspaceStatusWithManualWorkspaceEvents(repoPath);
    const calls: number[] = [];
    const stopWatching = watchWorkspaceStatus(repoPath, {
      onChange: () => {
        calls.push(Date.now());
      },
      onWatchError: ignoreWatchError,
    });

    try {
      await ready;
      await fs.writeFile(
        path.join(repoPath, "a b.txt"),
        "first edit\n",
        "utf8",
      );
      emitWorkspaceRootEvents([
        {
          path: path.join(repoPath, "a b.txt"),
          type: "update",
        },
      ]);
      await waitForCallCount(() => calls.length, 1, WATCH_TEST_TIMEOUT_MS);

      await fs.writeFile(
        path.join(repoPath, "a b.txt"),
        "second edit\n",
        "utf8",
      );
      emitWorkspaceRootEvents([
        {
          path: path.join(repoPath, "a b.txt"),
          type: "update",
        },
      ]);
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
    const { emitWorkspaceRootEvents, ready, watchWorkspaceStatus } =
      await importWatchWorkspaceStatusWithTransientWorkspaceSubscriptionFailure(
        repoPath,
      );
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
      await fs.writeFile(
        path.join(repoPath, "README.md"),
        "retried edit\n",
        "utf8",
      );
      emitWorkspaceRootEvents([
        {
          path: path.join(repoPath, "README.md"),
          type: "update",
        },
      ]);
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
      await importWatchWorkspaceStatusWithPersistentWorkspaceSubscriptionFailure(
        repoPath,
      );
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
      await waitForCallCount(
        () => watchErrors.length,
        1,
        WATCH_TEST_TIMEOUT_MS,
      );
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
    const { emitEvents, ready, watchWorkspaceStatus } =
      await importWatchWorkspaceStatusWithManualRootEvents({
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
    await fs.writeFile(
      path.join(repoPath, "README.md"),
      "second commit\n",
      "utf8",
    );
    await runGit({ args: ["add", "README.md"], cwd: repoPath });
    await runGit({ args: ["commit", "-m", "Second commit"], cwd: repoPath });
    const nextHead = (
      await runGit({ args: ["rev-parse", "HEAD"], cwd: repoPath })
    ).stdout.trim();
    const worktreePath = await addDetachedWorktree(repoPath);
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
    const { emitEvents, ready, watchWorkspaceStatus } =
      await importWatchWorkspaceStatusWithManualRootEvents({
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
      emitEvents(commonDirPath, [
        {
          path: path.join(commonDirPath, "refs", "heads", "feature", "foo"),
          type: "update",
        },
      ]);
      await waitForCallCount(() => calls.length, 1, WATCH_TEST_TIMEOUT_MS);

      await runGit({
        args: ["update-ref", "refs/heads/feature/foo", nextHead],
        cwd: repoPath,
      });
      emitEvents(commonDirPath, [
        {
          path: path.join(commonDirPath, "refs", "heads", "feature", "foo"),
          type: "update",
        },
      ]);
      await waitForCallCount(() => calls.length, 2, WATCH_TEST_TIMEOUT_MS);
    } finally {
      stopWatching();
    }
  });

  it("classifies direct checkout ref updates as shared git ref changes", async () => {
    const repoPath = await initRepo();
    const gitDirPath = normalizeWatchPath(
      path.resolve(
        repoPath,
        trimOutput(
          (
            await runGit({
              args: ["rev-parse", "--git-dir"],
              cwd: repoPath,
            })
          ).stdout,
        ),
      ),
    );
    const { emitEvents, ready, watchWorkspaceStatus } =
      await importWatchWorkspaceStatusWithManualRootEvents({
        expectedRootPaths: await resolveExpectedWatchRootPaths(repoPath),
        workspaceRootPath: repoPath,
      });
    const calls: Array<{ changeKinds: string[]; changedPaths: string[] }> = [];
    const stopWatching = watchWorkspaceStatus(repoPath, {
      onChange: (event) => {
        calls.push(event);
      },
      onWatchError: ignoreWatchError,
    });

    try {
      await ready;
      emitEvents(gitDirPath, [
        {
          path: path.join(gitDirPath, "refs/heads/feature"),
          type: "update",
        },
      ]);
      await waitForCallCount(() => calls.length, 1, WATCH_TEST_TIMEOUT_MS);
      expect(calls[0]?.changeKinds).toEqual(
        expect.arrayContaining([
          "shared-git-refs-changed",
          "workspace-git-changed",
        ]),
      );
    } finally {
      stopWatching();
    }
  });

  it("stops emitting callbacks after watch teardown", async () => {
    const repoPath = await initRepo();
    const { emitWorkspaceRootEvents, ready, watchWorkspaceStatus } =
      await importWatchWorkspaceStatusWithManualWorkspaceEvents(repoPath);
    const calls: number[] = [];
    const stopWatching = watchWorkspaceStatus(repoPath, {
      onChange: () => {
        calls.push(Date.now());
      },
      onWatchError: ignoreWatchError,
    });

    await ready;
    stopWatching();
    await fs.writeFile(
      path.join(repoPath, "README.md"),
      "no callbacks\n",
      "utf8",
    );
    emitWorkspaceRootEvents([
      {
        path: path.join(repoPath, "README.md"),
        type: "update",
      },
    ]);
    await ensureCallCountStays(() => calls.length, 0);

    expect(calls).toHaveLength(0);
  });
});
