import {
  existsSync,
  readdirSync,
  statSync,
  watch,
  type Dirent,
  type FSWatcher,
} from "node:fs";
import { dirname, extname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const RESTART_RECOMMENDATION_WATCH_DEBOUNCE_MS = 150;
const WATCHED_FILE_EXTENSIONS = new Set([
  ".ts",
  ".tsx",
  ".js",
  ".mjs",
  ".cjs",
  ".json",
]);
const IGNORED_DIRECTORY_NAMES = new Set([
  "node_modules",
  "dist",
  ".git",
  ".turbo",
]);

function shouldCheckFile(path: string): boolean {
  return WATCHED_FILE_EXTENSIONS.has(extname(path));
}

function hasChangesSince(rootPath: string, startedAt: number): boolean {
  if (!existsSync(rootPath)) return false;

  const queue = [rootPath];

  while (queue.length > 0) {
    const current = queue.pop();
    if (!current) continue;

    let entries: Dirent<string>[];
    try {
      entries = readdirSync(current, { withFileTypes: true, encoding: "utf8" });
    } catch {
      continue;
    }

    for (const entry of entries) {
      if (entry.isDirectory()) {
        if (IGNORED_DIRECTORY_NAMES.has(entry.name)) {
          continue;
        }
        queue.push(resolve(current, entry.name));
        continue;
      }

      if (!entry.isFile()) continue;

      const fullPath = resolve(current, entry.name);
      if (!shouldCheckFile(fullPath)) {
        continue;
      }

      try {
        if (statSync(fullPath).mtimeMs > startedAt) {
          return true;
        }
      } catch {
        // Ignore transient stat/read failures.
      }
    }
  }

  return false;
}

function resolveWatchRoots(): string[] {
  const thisDir = dirname(fileURLToPath(import.meta.url));
  const daemonRoot = resolve(thisDir, "..");
  const repoRoot = resolve(daemonRoot, "..", "..");

  return [
    resolve(daemonRoot, "src"),
    resolve(daemonRoot, "dist"),
    resolve(repoRoot, "packages", "agent-core", "src"),
    resolve(repoRoot, "packages", "agent-core", "dist"),
    resolve(repoRoot, "packages", "agent-server", "src"),
    resolve(repoRoot, "packages", "agent-server", "dist"),
    resolve(repoRoot, "packages", "db", "src"),
    resolve(repoRoot, "packages", "db", "dist"),
  ];
}

function collectWatchDirectories(rootPath: string): string[] {
  if (!existsSync(rootPath)) {
    return [];
  }

  const directories = [rootPath];
  const queue = [rootPath];

  while (queue.length > 0) {
    const current = queue.pop();
    if (!current) continue;

    let entries: Dirent<string>[];
    try {
      entries = readdirSync(current, { withFileTypes: true, encoding: "utf8" });
    } catch {
      continue;
    }

    for (const entry of entries) {
      if (!entry.isDirectory() || IGNORED_DIRECTORY_NAMES.has(entry.name)) {
        continue;
      }
      const nextDirectory = resolve(current, entry.name);
      directories.push(nextDirectory);
      queue.push(nextDirectory);
    }
  }

  return directories;
}

export interface RestartRecommendationMonitor {
  shouldRestart(): boolean;
  close(): void;
}

interface CreateRestartRecommendationMonitorOptions {
  onChange?: (shouldRestart: boolean) => void;
  watchRoots?: string[];
  debounceMs?: number;
}

export function createRestartRecommendationMonitor(
  startedAt: number,
  options: CreateRestartRecommendationMonitorOptions = {},
): RestartRecommendationMonitor {
  const watchRoots = options.watchRoots ?? resolveWatchRoots();
  const debounceMs =
    options.debounceMs ?? RESTART_RECOMMENDATION_WATCH_DEBOUNCE_MS;
  let shouldRestart = watchRoots.some((rootPath) => hasChangesSince(rootPath, startedAt));
  let closed = false;
  let pendingTimer: ReturnType<typeof setTimeout> | null = null;
  let watchers: FSWatcher[] = [];

  const closeWatchers = () => {
    for (const watcher of watchers) {
      try {
        watcher.close();
      } catch {
        // Ignore close failures.
      }
    }
    watchers = [];
  };

  const refreshWatchers = () => {
    closeWatchers();
    const directories = watchRoots.flatMap((rootPath) => collectWatchDirectories(rootPath));
    watchers = directories.flatMap((directory) => {
      try {
        const watcher = watch(directory, { persistent: false }, () => {
          scheduleRecompute();
        });
        watcher.on("error", () => {
          scheduleRecompute();
        });
        return [watcher];
      } catch {
        return [];
      }
    });
  };

  const recompute = () => {
    if (closed) {
      return;
    }
    refreshWatchers();
    const nextShouldRestart = watchRoots.some((rootPath) =>
      hasChangesSince(rootPath, startedAt)
    );
    if (nextShouldRestart === shouldRestart) {
      return;
    }
    shouldRestart = nextShouldRestart;
    options.onChange?.(shouldRestart);
  };

  const scheduleRecompute = () => {
    if (closed) {
      return;
    }
    if (pendingTimer !== null) {
      clearTimeout(pendingTimer);
    }
    pendingTimer = setTimeout(() => {
      pendingTimer = null;
      recompute();
    }, debounceMs);
  };

  refreshWatchers();

  return {
    shouldRestart: () => shouldRestart,
    close: () => {
      closed = true;
      if (pendingTimer !== null) {
        clearTimeout(pendingTimer);
        pendingTimer = null;
      }
      closeWatchers();
    },
  };
}

export function createRestartRecommendationEvaluator(
  startedAt: number,
): () => boolean {
  const monitor = createRestartRecommendationMonitor(startedAt);
  return () => monitor.shouldRestart();
}
