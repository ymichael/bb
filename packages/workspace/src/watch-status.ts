import parcelWatcher from "@parcel/watcher";
import fs from "node:fs/promises";
import path from "node:path";
import { calculateExponentialBackoffDelay } from "@bb/domain";
import { detectGitRepo, pathExists } from "./git.js";

const WORKSPACE_STATUS_WATCH_DEBOUNCE_MS = 75;
const WORKSPACE_STATUS_WATCH_MAX_WAIT_MS = 500;
const WORKSPACE_STATUS_WATCH_RETRY_DELAY_MS = 250;
const WORKSPACE_STATUS_WATCH_MAX_RETRY_DELAY_MS = 30_000;

export type WorkspaceStatusChangeCallback = () => void;

export interface WorkspaceStatusWatchError {
  message: string;
  rootPath: string;
}

export type WorkspaceStatusWatchErrorCallback = (
  error: WorkspaceStatusWatchError,
) => void;

export interface WorkspaceStatusWatchArgs {
  onChange: WorkspaceStatusChangeCallback;
  onWatchError: WorkspaceStatusWatchErrorCallback;
}

type ParcelWatcherSubscribe = typeof parcelWatcher.subscribe;
type ParcelWatcherAsyncSubscription = Awaited<
  ReturnType<ParcelWatcherSubscribe>
>;
type ParcelWatcherOptions = Parameters<ParcelWatcherSubscribe>[2];

interface GitMetadataLayout {
  commonDirPath: string;
  gitDirPath: string;
}

interface WatchSubscriptionSpec {
  options?: ParcelWatcherOptions;
  rootPath: string;
}

function trimOutput(value: string): string {
  return value.trim().replace(/\n+$/u, "");
}

function toErrorMessage(error: unknown): string {
  if (error instanceof Error && error.message.trim().length > 0) {
    return error.message;
  }
  return "Unknown watch error";
}

async function resolveGitDirectory(cwd: string): Promise<string | undefined> {
  const dotGitPath = path.join(cwd, ".git");
  try {
    const dotGitStat = await fs.lstat(dotGitPath);
    if (dotGitStat.isDirectory()) {
      return dotGitPath;
    }
    if (!dotGitStat.isFile()) {
      return undefined;
    }
    const dotGitContents = await fs.readFile(dotGitPath, "utf8");
    const firstLine = dotGitContents.split("\n")[0]?.trim() ?? "";
    if (!firstLine.startsWith("gitdir:")) {
      return undefined;
    }
    const relativeGitDir = firstLine.slice("gitdir:".length).trim();
    if (relativeGitDir.length === 0) {
      return undefined;
    }
    return path.resolve(cwd, relativeGitDir);
  } catch {
    return undefined;
  }
}

async function resolveGitCommonDirectory(gitDirPath: string): Promise<string> {
  try {
    const relativeCommonDirPath = trimOutput(
      await fs.readFile(path.join(gitDirPath, "commondir"), "utf8"),
    );
    if (relativeCommonDirPath.length === 0) {
      return gitDirPath;
    }
    return path.resolve(gitDirPath, relativeCommonDirPath);
  } catch {
    return gitDirPath;
  }
}

async function resolveGitMetadataLayout(cwd: string): Promise<GitMetadataLayout> {
  const dotGitPath = path.join(cwd, ".git");
  const gitDirPath = (await resolveGitDirectory(cwd)) ?? dotGitPath;
  return {
    commonDirPath: await resolveGitCommonDirectory(gitDirPath),
    gitDirPath,
  };
}

function createCommonDirWatchOptions(): ParcelWatcherOptions {
  return {
    ignore: [
      "hooks",
      "info",
      "logs",
      "modules",
      "objects",
      "worktrees",
    ],
  };
}

async function resolveMetadataWatchSpecs(cwd: string): Promise<WatchSubscriptionSpec[]> {
  const layout = await resolveGitMetadataLayout(cwd);
  const commonDirSpec = {
    options: createCommonDirWatchOptions(),
    rootPath: layout.commonDirPath,
  };
  if (layout.gitDirPath === layout.commonDirPath) {
    return [commonDirSpec];
  }
  return [
    {
      rootPath: layout.gitDirPath,
    },
    commonDirSpec,
  ];
}

export function watchWorkspaceStatus(
  cwd: string,
  args: WorkspaceStatusWatchArgs,
): () => void {
  let debounceTimer: ReturnType<typeof setTimeout> | null = null;
  let disposed = false;
  let maxWaitTimer: ReturnType<typeof setTimeout> | null = null;
  let metadataRetryAttempt = 0;
  let metadataStartRetryTimer: ReturnType<typeof setTimeout> | null = null;
  const retryAttempts = new Map<string, number>();
  const retryTimers = new Map<string, ReturnType<typeof setTimeout>>();
  const subscriptions = new Map<string, ParcelWatcherAsyncSubscription>();
  const warnedRootPaths = new Set<string>();

  const clearChangeTimers = () => {
    if (debounceTimer !== null) {
      clearTimeout(debounceTimer);
      debounceTimer = null;
    }
    if (maxWaitTimer !== null) {
      clearTimeout(maxWaitTimer);
      maxWaitTimer = null;
    }
  };

  const clearMetadataStartRetryTimer = () => {
    if (metadataStartRetryTimer === null) {
      return;
    }
    clearTimeout(metadataStartRetryTimer);
    metadataStartRetryTimer = null;
  };

  const flushChange = () => {
    clearChangeTimers();
    if (disposed) {
      return;
    }
    args.onChange();
  };

  const resetWatchRetryState = (rootPath: string) => {
    retryAttempts.delete(rootPath);
    warnedRootPaths.delete(rootPath);
  };

  const stopSubscription = (rootPath: string) => {
    const retryTimer = retryTimers.get(rootPath);
    if (retryTimer !== undefined) {
      clearTimeout(retryTimer);
      retryTimers.delete(rootPath);
    }
    const subscription = subscriptions.get(rootPath);
    if (!subscription) {
      return;
    }
    subscriptions.delete(rootPath);
    void subscription.unsubscribe().catch(() => {
      // Ignore unsubscribe failures during watcher teardown.
    });
  };

  const scheduleChange = () => {
    if (disposed) {
      return;
    }
    if (debounceTimer !== null) {
      clearTimeout(debounceTimer);
    }
    debounceTimer = setTimeout(flushChange, WORKSPACE_STATUS_WATCH_DEBOUNCE_MS);
    if (maxWaitTimer === null) {
      maxWaitTimer = setTimeout(flushChange, WORKSPACE_STATUS_WATCH_MAX_WAIT_MS);
    }
  };

  const reportWatchError = (spec: WatchSubscriptionSpec, error: unknown) => {
    if (warnedRootPaths.has(spec.rootPath)) {
      return;
    }
    warnedRootPaths.add(spec.rootPath);
    args.onWatchError({
      message: toErrorMessage(error),
      rootPath: spec.rootPath,
    });
  };

  const scheduleMetadataWatchRetry = () => {
    if (disposed || metadataStartRetryTimer !== null) {
      return;
    }
    metadataRetryAttempt += 1;
    metadataStartRetryTimer = setTimeout(() => {
      metadataStartRetryTimer = null;
      startMetadataWatchSubscriptions();
    }, calculateExponentialBackoffDelay({
      attempt: metadataRetryAttempt,
      baseDelayMs: WORKSPACE_STATUS_WATCH_RETRY_DELAY_MS,
      maxDelayMs: WORKSPACE_STATUS_WATCH_MAX_RETRY_DELAY_MS,
    }));
  };

  const scheduleWatchRetry = (spec: WatchSubscriptionSpec) => {
    if (
      disposed ||
      subscriptions.has(spec.rootPath) ||
      retryTimers.has(spec.rootPath)
    ) {
      return;
    }
    const retryAttempt = (retryAttempts.get(spec.rootPath) ?? 0) + 1;
    retryAttempts.set(spec.rootPath, retryAttempt);
    const retryTimer = setTimeout(() => {
      retryTimers.delete(spec.rootPath);
      if (disposed) {
        return;
      }
      startWatchSubscription(spec);
    }, calculateExponentialBackoffDelay({
      attempt: retryAttempt,
      baseDelayMs: WORKSPACE_STATUS_WATCH_RETRY_DELAY_MS,
      maxDelayMs: WORKSPACE_STATUS_WATCH_MAX_RETRY_DELAY_MS,
    }));
    retryTimers.set(spec.rootPath, retryTimer);
  };

  const handleWatchFailure = (spec: WatchSubscriptionSpec) => {
    stopSubscription(spec.rootPath);
    scheduleWatchRetry(spec);
  };

  function startWatchSubscription(spec: WatchSubscriptionSpec): void {
    void (async () => {
      if (disposed || subscriptions.has(spec.rootPath)) {
        return;
      }
      if (!(await pathExists(spec.rootPath))) {
        scheduleWatchRetry(spec);
        return;
      }
      try {
        const subscription = await parcelWatcher.subscribe(
          spec.rootPath,
          (error, events) => {
            if (disposed) {
              return;
            }
            if (error) {
              reportWatchError(spec, error);
              handleWatchFailure(spec);
              return;
            }
            if (events.length === 0) {
              return;
            }
            scheduleChange();
          },
          spec.options,
        );
        if (disposed) {
          void subscription.unsubscribe().catch(() => {
            // Ignore unsubscribe failures after late subscription setup.
          });
          return;
        }
        if (subscriptions.has(spec.rootPath)) {
          void subscription.unsubscribe().catch(() => {
            // Ignore duplicate unsubscribe failures.
          });
          return;
        }
        resetWatchRetryState(spec.rootPath);
        subscriptions.set(spec.rootPath, subscription);
      } catch (error) {
        if (disposed) {
          return;
        }
        reportWatchError(spec, error);
        scheduleWatchRetry(spec);
      }
    })();
  }

  function startMetadataWatchSubscriptions(): void {
    void (async () => {
      try {
        const metadataSpecs = await resolveMetadataWatchSpecs(cwd);
        if (disposed) {
          return;
        }
        metadataRetryAttempt = 0;
        for (const spec of metadataSpecs) {
          startWatchSubscription(spec);
        }
      } catch {
        if (disposed) {
          return;
        }
        scheduleMetadataWatchRetry();
      }
    })();
  }

  void (async () => {
    if (!(await detectGitRepo(cwd))) {
      return;
    }
    if (disposed) {
      return;
    }
    startWatchSubscription({
      options: {
        ignore: [".git"],
      },
      rootPath: cwd,
    });
    startMetadataWatchSubscriptions();
  })();

  return () => {
    disposed = true;
    clearChangeTimers();
    clearMetadataStartRetryTimer();
    for (const retryTimer of retryTimers.values()) {
      clearTimeout(retryTimer);
    }
    retryTimers.clear();
    for (const rootPath of subscriptions.keys()) {
      stopSubscription(rootPath);
    }
  };
}
