import fs from "node:fs/promises";
import path from "node:path";
import {
  RootSubscription,
  type ParcelWatcherEventBatch,
} from "./root-subscription.js";
import { createDebouncedCallbackScheduler } from "./watch-callback-scheduler.js";
import { toWatchErrorMessage } from "./watch-error.js";
import type {
  PathChangeEvent,
  PathChangeCallback,
  PathChangeWatchArgs,
  PathChangeWatchError,
  PathChangeWatchErrorCallback,
} from "./watch-path-types.js";

const PATH_CHANGE_WATCH_DEBOUNCE_MS = 75;
const PATH_CHANGE_WATCH_MAX_WAIT_MS = 500;
const PATH_CHANGE_WATCH_RETRY_DELAY_MS = 250;
const PATH_CHANGE_WATCH_MAX_RETRY_DELAY_MS = 30_000;

interface PathChangeWatcherArgs extends PathChangeWatchArgs {
  path: string;
  debounceMs: number;
  maxRetryDelayMs: number;
  maxWaitMs: number;
  retryDelayMs: number;
}

function createPathChangeCallbackError(
  watchedPath: string,
  error: unknown,
): PathChangeWatchError {
  return {
    message: `Path change callback failed: ${toWatchErrorMessage(error)}`,
    rootPath: watchedPath,
  };
}

function isPathWithinTarget(
  targetPath: string,
  candidatePath: string,
): boolean {
  const relativePath = path.relative(targetPath, candidatePath);
  return (
    relativePath.length === 0 ||
    (!relativePath.startsWith("..") && !path.isAbsolute(relativePath))
  );
}

function resolveEventPath(watchedPath: string, eventPath: string): string {
  return path.isAbsolute(eventPath)
    ? path.normalize(eventPath)
    : path.resolve(watchedPath, eventPath);
}

function collectTouchedTargetPaths(
  targetPath: string,
  events: ParcelWatcherEventBatch,
): string[] {
  const touchedPaths = new Set<string>();
  for (const event of events) {
    const candidatePath = resolveEventPath(targetPath, event.path);
    if (isPathWithinTarget(targetPath, candidatePath)) {
      touchedPaths.add(candidatePath);
    }
  }
  return Array.from(touchedPaths).sort();
}

class PathChangeWatcher {
  private disposed = false;
  private readonly changedPaths = new Set<string>();
  private readonly subscription: RootSubscription;
  private readonly changeScheduler;
  private readonly targetPath: string;

  constructor(private readonly args: PathChangeWatcherArgs) {
    this.targetPath = path.resolve(args.path);
    this.changeScheduler = createDebouncedCallbackScheduler({
      debounceMs: args.debounceMs,
      maxWaitMs: args.maxWaitMs,
      onFlush: () => {
        if (this.disposed) {
          return;
        }
        try {
          const changedPaths = Array.from(this.changedPaths).sort();
          this.changedPaths.clear();
          if (changedPaths.length === 0) {
            return;
          }
          this.args.onChange({ changedPaths });
        } catch (error) {
          this.args.onWatchError(
            createPathChangeCallbackError(this.targetPath, error),
          );
        }
      },
    });
    this.subscription = new RootSubscription({
      rootPath: this.targetPath,
      retryDelayMs: args.retryDelayMs,
      maxRetryDelayMs: args.maxRetryDelayMs,
      onEvents: (events) => {
        const touchedPaths = collectTouchedTargetPaths(this.targetPath, events);
        if (touchedPaths.length === 0) {
          return;
        }
        for (const touchedPath of touchedPaths) {
          this.changedPaths.add(touchedPath);
        }
        this.changeScheduler.schedule();
      },
      onDroppedEvents: () => {
        void this.rescanAfterDroppedEvents();
      },
      onWatchError: (message) => {
        this.args.onWatchError({ message, rootPath: this.targetPath });
      },
    });
  }

  start(): void {
    this.subscription.start();
  }

  async dispose(): Promise<void> {
    this.disposed = true;
    this.changeScheduler.dispose();
    this.changedPaths.clear();
    await this.subscription.dispose();
  }

  private async rescanAfterDroppedEvents(): Promise<void> {
    let entries: string[];
    try {
      entries = await fs.readdir(this.targetPath);
    } catch {
      return;
    }
    if (this.disposed || entries.length === 0) {
      return;
    }
    for (const entry of entries) {
      this.changedPaths.add(path.join(this.targetPath, entry));
    }
    this.changeScheduler.schedule();
  }
}

export type {
  PathChangeEvent,
  PathChangeCallback,
  PathChangeWatchArgs,
  PathChangeWatchError,
  PathChangeWatchErrorCallback,
};

export function watchPathChanges(
  watchedPath: string,
  args: PathChangeWatchArgs,
): () => Promise<void> {
  const watcher = new PathChangeWatcher({
    path: watchedPath,
    debounceMs: PATH_CHANGE_WATCH_DEBOUNCE_MS,
    maxRetryDelayMs: PATH_CHANGE_WATCH_MAX_RETRY_DELAY_MS,
    maxWaitMs: PATH_CHANGE_WATCH_MAX_WAIT_MS,
    onChange: args.onChange,
    onWatchError: args.onWatchError,
    retryDelayMs: PATH_CHANGE_WATCH_RETRY_DELAY_MS,
  });
  watcher.start();
  return () => watcher.dispose();
}
