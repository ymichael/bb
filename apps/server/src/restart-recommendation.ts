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
  "__tests__",
  "test",
  "generated",
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
  const serverRoot = resolve(thisDir, "..");
  const repoRoot = resolve(serverRoot, "..", "..");

  // Only watch source directories that affect the running server process.
  // Skip dist/ — the dev supervisor runs from source via tsx, and build
  // artifacts change on every `pnpm build` (including pre-commit hooks)
  // which would cause noisy false-positive restart recommendations.
  // Skip test files via the IGNORED_DIRECTORY_NAMES set (__tests__).
  return [
    resolve(serverRoot, "src"),
    resolve(repoRoot, "packages", "core", "src"),
    resolve(repoRoot, "packages", "db", "src"),
    resolve(repoRoot, "packages", "environment", "src"),
    resolve(repoRoot, "packages", "environment-daemon", "src"),
    resolve(repoRoot, "packages", "provider-adapters", "src"),
    resolve(repoRoot, "packages", "templates", "src"),
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

  const computeNextShouldRestart = () =>
    watchRoots.some((rootPath) => hasChangesSince(rootPath, startedAt));

  const updateShouldRestart = (nextShouldRestart: boolean) => {
    if (nextShouldRestart === shouldRestart) {
      return;
    }
    shouldRestart = nextShouldRestart;
    options.onChange?.(shouldRestart);
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
    updateShouldRestart(computeNextShouldRestart());
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
    shouldRestart: () => {
      if (!closed && !shouldRestart) {
        // Filesystem watch events can be dropped under load; rescan on demand
        // so callers still observe restart recommendations deterministically.
        updateShouldRestart(computeNextShouldRestart());
      }
      return shouldRestart;
    },
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
