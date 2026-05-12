import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import parcelWatcher from "@parcel/watcher";
import { afterEach, describe, expect, it, vi } from "vitest";
// Import the ESM namespace so Vitest can spy on the exported pathExists binding.
import * as pathExistsModule from "../src/path-exists.js";
import { watchPathChanges as watchPathChangesImpl } from "../src/watch-path.js";

type WatchPathChanges = typeof watchPathChangesImpl;
type ParcelWatcherSubscribe = (typeof import("@parcel/watcher"))["subscribe"];
type ParcelWatcherCallback = Parameters<ParcelWatcherSubscribe>[1];
type ParcelWatcherSubscribeArgs = Parameters<ParcelWatcherSubscribe>;
type ParcelWatcherEventBatch = Parameters<ParcelWatcherCallback>[1];
type ParcelWatcherSubscribeResult = Awaited<ReturnType<ParcelWatcherSubscribe>>;

interface MockWatchPathImport {
  callbacks: ParcelWatcherCallback[];
  rootPaths: string[];
  subscribeCallCount: () => number;
  unsubscribe: ReturnType<typeof vi.fn<() => Promise<void>>>;
  watchPathChanges: WatchPathChanges;
}

interface ImportWatchPathOptions {
  pathExistsImplementation?: (targetPath: string) => Promise<boolean>;
  subscribeImplementation?: (
    args: ParcelWatcherSubscribeArgs,
  ) => Promise<ParcelWatcherSubscribeResult>;
}

type Sleep = (durationMs: number) => Promise<void>;

const tempDirs: string[] = [];
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

async function makeTempDir(prefix: string): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

async function waitFor<T>(
  getValue: () => T,
  predicate: (value: T) => boolean,
  timeoutMs = 1_000,
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = getValue();
    if (predicate(value)) {
      return value;
    }
    await sleep(20);
  }
  throw new Error("Timed out waiting for watcher state");
}

function createDeferredPromise<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((innerResolve, innerReject) => {
    resolve = innerResolve;
    reject = innerReject;
  });
  return { promise, reject, resolve };
}

async function importWatchPathWithMockedWatcher(
  options: ImportWatchPathOptions = {},
): Promise<MockWatchPathImport> {
  const callbacks: ParcelWatcherCallback[] = [];
  const rootPaths: string[] = [];
  let subscribeCallCount = 0;
  const unsubscribe = vi.fn<() => Promise<void>>(async () => undefined);

  if (options.pathExistsImplementation) {
    vi.spyOn(pathExistsModule, "pathExists").mockImplementation(
      options.pathExistsImplementation,
    );
  }
  const subscribe = async (
    ...args: ParcelWatcherSubscribeArgs
  ): Promise<ParcelWatcherSubscribeResult> => {
    subscribeCallCount += 1;
    rootPaths.push(args[0]);
    callbacks.push(args[1]);
    if (options.subscribeImplementation) {
      return options.subscribeImplementation(args);
    }
    return { unsubscribe };
  };
  vi.spyOn(parcelWatcher, "subscribe").mockImplementation(subscribe);

  return {
    callbacks,
    rootPaths,
    subscribeCallCount: () => subscribeCallCount,
    unsubscribe,
    watchPathChanges: watchPathChangesImpl,
  };
}

function createEventBatch(paths: string[]): ParcelWatcherEventBatch {
  return paths.map((eventPath) => ({
    path: eventPath,
    type: "update",
  }));
}

afterEach(async () => {
  await settleAsyncWatchWork();
  vi.restoreAllMocks();
  await Promise.all(
    tempDirs.splice(0).map(async (dir) => {
      await fs.rm(dir, { force: true, recursive: true });
    }),
  );
});

// These tests mutate shared module spies, so keep them out of Vitest parallelism.
describe.sequential("watchPathChanges", () => {
  it("watches the target path and reports changed paths within that subtree", async () => {
    const dataDir = await makeTempDir("bb-watch-path-");
    const threadStorageRoot = path.join(dataDir, "thread-storage");
    await fs.mkdir(threadStorageRoot, { recursive: true });
    const onChange = vi.fn();
    const onWatchError = vi.fn();
    const { callbacks, rootPaths, watchPathChanges } =
      await importWatchPathWithMockedWatcher();

    const stopWatching = watchPathChanges(threadStorageRoot, {
      onChange,
      onWatchError,
    });

    const [callback] = await waitFor(
      () => callbacks,
      (currentCallbacks) => currentCallbacks.length === 1,
    );

    expect(rootPaths).toEqual([threadStorageRoot]);

    callback(
      null,
      createEventBatch([
        path.join(threadStorageRoot, "thread-2", "notes.md"),
        path.join(threadStorageRoot, "thread-1"),
        "../outside-root.txt",
      ]),
    );

    await waitFor(
      () => onChange.mock.calls.length,
      (callCount) => callCount === 1,
    );

    expect(onChange).toHaveBeenCalledWith({
      changedPaths: [
        path.join(threadStorageRoot, "thread-1"),
        path.join(threadStorageRoot, "thread-2", "notes.md"),
      ],
    });
    expect(onWatchError).not.toHaveBeenCalled();

    stopWatching();
  });

  it("reports a missing watched path once and retries until it appears", async () => {
    const threadStorageRoot = path.join("/tmp", "bb-watch-path-missing");
    let pathExistsCallCount = 0;
    const onWatchError = vi.fn();
    const { rootPaths, watchPathChanges } =
      await importWatchPathWithMockedWatcher({
        pathExistsImplementation: async () => {
          pathExistsCallCount += 1;
          return pathExistsCallCount >= 2;
        },
      });

    const stopWatching = watchPathChanges(threadStorageRoot, {
      onChange: () => undefined,
      onWatchError,
    });

    try {
      await waitFor(
        () => onWatchError.mock.calls.length,
        (callCount) => callCount === 1,
      );
      expect(rootPaths).toEqual([]);
      expect(onWatchError).toHaveBeenCalledWith({
        message: `Watched path does not exist yet: ${threadStorageRoot}`,
        rootPath: threadStorageRoot,
      });

      await waitFor(
        () => rootPaths.length,
        (count) => count === 1,
      );

      expect(rootPaths).toEqual([threadStorageRoot]);
      expect(onWatchError).toHaveBeenCalledTimes(1);
    } finally {
      stopWatching();
    }
  });

  it("retries path subscriptions after a startup failure", async () => {
    const threadStorageRoot = path.join("/tmp", "bb-watch-path-retry");
    const onWatchError = vi.fn();
    let shouldFail = true;
    const { rootPaths, subscribeCallCount, watchPathChanges } =
      await importWatchPathWithMockedWatcher({
        pathExistsImplementation: async () => true,
        subscribeImplementation: async () => {
          if (shouldFail) {
            shouldFail = false;
            throw new Error("path subscription unavailable");
          }
          return {
            unsubscribe: async () => undefined,
          };
        },
      });

    const stopWatching = watchPathChanges(threadStorageRoot, {
      onChange: () => undefined,
      onWatchError,
    });

    try {
      await waitFor(subscribeCallCount, (count) => count === 1);
      expect(onWatchError).toHaveBeenCalledWith({
        message: "path subscription unavailable",
        rootPath: threadStorageRoot,
      });

      await waitFor(subscribeCallCount, (count) => count === 2);

      expect(rootPaths).toEqual([threadStorageRoot, threadStorageRoot]);
    } finally {
      stopWatching();
    }
  });

  it("unsubscribes a late subscription if disposed during startup", async () => {
    const threadStorageRoot = path.join("/tmp", "bb-watch-path-late");
    const subscriptionDeferred =
      createDeferredPromise<ParcelWatcherSubscribeResult>();
    const { rootPaths, unsubscribe, watchPathChanges } =
      await importWatchPathWithMockedWatcher({
        pathExistsImplementation: async () => true,
        subscribeImplementation: async () => subscriptionDeferred.promise,
      });

    const stopWatching = watchPathChanges(threadStorageRoot, {
      onChange: () => undefined,
      onWatchError: () => undefined,
    });

    await waitFor(
      () => rootPaths.length,
      (count) => count === 1,
    );
    stopWatching();
    subscriptionDeferred.resolve({ unsubscribe });

    await waitFor(
      () => unsubscribe.mock.calls.length,
      (callCount) => callCount === 1,
    );

    expect(unsubscribe).toHaveBeenCalledTimes(1);
  });

  it("coalesces repeated batches before flushing", async () => {
    const dataDir = await makeTempDir("bb-watch-path-");
    const threadStorageRoot = path.join(dataDir, "thread-storage");
    await fs.mkdir(threadStorageRoot, { recursive: true });
    const onChange = vi.fn();
    const { callbacks, watchPathChanges } =
      await importWatchPathWithMockedWatcher();

    const stopWatching = watchPathChanges(threadStorageRoot, {
      onChange,
      onWatchError: () => undefined,
    });

    const [callback] = await waitFor(
      () => callbacks,
      (currentCallbacks) => currentCallbacks.length === 1,
    );

    callback(
      null,
      createEventBatch([path.join(threadStorageRoot, "thread-1", "notes.md")]),
    );
    callback(
      null,
      createEventBatch([
        path.join(threadStorageRoot, "thread-1", "notes.md"),
        path.join(threadStorageRoot, "thread-1", "todo.md"),
      ]),
    );

    await waitFor(
      () => onChange.mock.calls.length,
      (callCount) => callCount === 1,
    );

    expect(onChange).toHaveBeenCalledWith({
      changedPaths: [
        path.join(threadStorageRoot, "thread-1", "notes.md"),
        path.join(threadStorageRoot, "thread-1", "todo.md"),
      ],
    });

    stopWatching();
  });
});
