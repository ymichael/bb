import { existsSync, readdirSync, statSync, type Dirent } from "node:fs";
import { dirname, extname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const RESTART_RECOMMENDATION_CACHE_MS = 1_000;
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
    resolve(repoRoot, "packages", "agent-core", "src"),
    resolve(repoRoot, "packages", "agent-server", "src"),
    resolve(repoRoot, "packages", "db", "src"),
  ];
}

export function createRestartRecommendationEvaluator(
  startedAt: number,
): () => boolean {
  const watchRoots = resolveWatchRoots();
  let cachedValue = false;
  let cachedAt = 0;

  return () => {
    const now = Date.now();
    if (now - cachedAt < RESTART_RECOMMENDATION_CACHE_MS) {
      return cachedValue;
    }
    cachedAt = now;
    cachedValue = watchRoots.some((rootPath) => hasChangesSince(rootPath, startedAt));
    return cachedValue;
  };
}
