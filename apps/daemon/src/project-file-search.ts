import { readdir } from "node:fs/promises";
import { join, relative, sep } from "node:path";
import type { ProjectFileSuggestion } from "@beanbag/agent-core";

const DEFAULT_RESULT_LIMIT = 8;
const MAX_RESULT_LIMIT = 25;
const MAX_SCANNED_FILES = 25_000;
const CACHE_TTL_MS = 15_000;
const IGNORED_DIRECTORIES = new Set([
  ".git",
  ".next",
  ".turbo",
  "node_modules",
  "dist",
  "build",
  "coverage",
]);
const IGNORED_FILE_NAMES = new Set([
  ".DS_Store",
  "Thumbs.db",
  "desktop.ini",
]);

interface CachedFileList {
  expiresAt: number;
  files: string[];
}

const projectFileCache = new Map<string, CachedFileList>();

function normalizeLimit(limit: number | undefined): number {
  const parsedLimit = typeof limit === "number" ? limit : DEFAULT_RESULT_LIMIT;
  return Math.max(1, Math.min(MAX_RESULT_LIMIT, Math.floor(parsedLimit)));
}

function normalizePath(path: string): string {
  return path.split(sep).join("/");
}

function isIgnoredFilePath(path: string): boolean {
  const fileName = path.split("/").at(-1) ?? path;
  return IGNORED_FILE_NAMES.has(fileName);
}

function fuzzyMatch(text: string, query: string): boolean {
  let queryIndex = 0;
  for (let i = 0; i < text.length && queryIndex < query.length; i += 1) {
    if (text[i] === query[queryIndex]) {
      queryIndex += 1;
    }
  }
  return queryIndex === query.length;
}

function scoreFilePath(filePath: string, normalizedQuery: string): number {
  if (!normalizedQuery) return 1;

  const lowerPath = filePath.toLowerCase();
  const fileName = lowerPath.split("/").at(-1) ?? "";

  if (fileName === normalizedQuery) return 100;
  if (fileName.startsWith(normalizedQuery)) return 80;
  if (fileName.includes(normalizedQuery)) return 60;
  if (lowerPath.includes(normalizedQuery)) return 40;
  if (fuzzyMatch(lowerPath, normalizedQuery)) return 20;
  return 0;
}

export function rankProjectFiles(
  files: string[],
  query: string,
  limit?: number,
): ProjectFileSuggestion[] {
  const normalizedLimit = normalizeLimit(limit);
  const normalizedQuery = query.trim().toLowerCase();

  const ranked = files
    .map((path) => ({ path, score: scoreFilePath(path, normalizedQuery) }))
    .filter((entry) => entry.score > 0 && !isIgnoredFilePath(entry.path))
    .sort((left, right) => {
      if (right.score !== left.score) {
        return right.score - left.score;
      }
      if (left.path.length !== right.path.length) {
        return left.path.length - right.path.length;
      }
      return left.path.localeCompare(right.path);
    })
    .slice(0, normalizedLimit);

  return ranked.map(({ path }) => ({ path }));
}

async function collectProjectFiles(rootPath: string): Promise<string[]> {
  const files: string[] = [];
  const directories = [rootPath];

  while (directories.length > 0 && files.length < MAX_SCANNED_FILES) {
    const directory = directories.pop();
    if (!directory) break;

    let entries: Array<{
      name: string;
      isDirectory: () => boolean;
      isFile: () => boolean;
    }>;
    try {
      entries = await readdir(directory, { withFileTypes: true, encoding: "utf8" });
    } catch {
      continue;
    }

    for (const entry of entries) {
      const entryName = entry.name;

      if (entry.isDirectory()) {
        if (IGNORED_DIRECTORIES.has(entryName)) continue;
        directories.push(join(directory, entryName));
        continue;
      }
      if (!entry.isFile()) continue;
      if (IGNORED_FILE_NAMES.has(entryName)) continue;

      const absolutePath = join(directory, entryName);
      const relativePath = relative(rootPath, absolutePath);
      if (!relativePath || relativePath.startsWith("..")) continue;
      files.push(normalizePath(relativePath));

      if (files.length >= MAX_SCANNED_FILES) {
        break;
      }
    }
  }

  return files;
}

async function getProjectFiles(rootPath: string): Promise<string[]> {
  const now = Date.now();
  const cached = projectFileCache.get(rootPath);
  if (cached && cached.expiresAt > now) {
    return cached.files;
  }

  const files = await collectProjectFiles(rootPath);
  projectFileCache.set(rootPath, {
    files,
    expiresAt: now + CACHE_TTL_MS,
  });
  return files;
}

export async function searchProjectFiles(
  rootPath: string,
  query: string,
  limit?: number,
): Promise<ProjectFileSuggestion[]> {
  const files = await getProjectFiles(rootPath);
  return rankProjectFiles(files, query, limit);
}

export function clearProjectFileSearchCache(): void {
  projectFileCache.clear();
}
