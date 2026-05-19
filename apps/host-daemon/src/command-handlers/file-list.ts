import fs from "node:fs/promises";
import path from "node:path";
import { fuzzyMatchPaths } from "@bb/fuzzy-match";
import type {
  HostPathEntry,
  HostPathEntryKind,
} from "@bb/host-daemon-contract";

export interface FinalizeListedFilesArgs {
  filePaths: string[];
  limit: number;
  query?: string;
}

export interface FinalizedFileList {
  files: FileListEntry[];
  truncated: boolean;
}

export interface FileListEntry {
  path: string;
  name: string;
}

export interface ListedPath {
  kind: HostPathEntryKind;
  path: string;
  name: string;
}

export interface PathListInclusion {
  includeFiles: boolean;
  includeDirectories: boolean;
}

export interface FinalizeListedPathsArgs extends PathListInclusion {
  paths: ListedPath[];
  limit: number;
  query?: string;
}

export interface FinalizedPathList {
  paths: HostPathEntry[];
  truncated: boolean;
}

export interface ListPathsRecursivelyArgs extends PathListInclusion {
  dir: string;
  root: string;
}

function shouldIncludePath(
  pathKind: HostPathEntryKind,
  inclusion: PathListInclusion,
): boolean {
  return pathKind === "directory"
    ? inclusion.includeDirectories
    : inclusion.includeFiles;
}

function toFileListEntry(pathEntry: HostPathEntry): FileListEntry {
  return {
    path: pathEntry.path,
    name: pathEntry.name,
  };
}

function toListedFile(filePath: string): ListedPath {
  return {
    kind: "file",
    path: filePath,
    name: path.basename(filePath),
  };
}

export function normalizeListedPath(relativePath: string): string {
  return relativePath.replace(/\\/g, "/");
}

export function finalizeListedFiles(
  args: FinalizeListedFilesArgs,
): FinalizedFileList {
  const result = finalizeListedPaths({
    paths: args.filePaths.map(toListedFile),
    limit: args.limit,
    includeFiles: true,
    includeDirectories: false,
    ...(args.query ? { query: args.query } : {}),
  });

  return {
    files: result.paths.map(toFileListEntry),
    truncated: result.truncated,
  };
}

export function finalizeListedPaths(
  args: FinalizeListedPathsArgs,
): FinalizedPathList {
  let pathEntries = args.paths.filter((pathEntry) =>
    shouldIncludePath(pathEntry.kind, args),
  );
  let rankedEntries: HostPathEntry[];

  if (args.query) {
    const matches = fuzzyMatchPaths({
      items: pathEntries,
      query: args.query,
      getPath: (pathEntry) => pathEntry.path,
      limit: args.limit + 1,
    });
    rankedEntries = matches.map((match) => ({
      ...match.item,
      score: match.score,
      positions: match.positions,
    }));
  } else {
    rankedEntries = pathEntries.map((pathEntry) => ({
      ...pathEntry,
      score: 0,
      positions: [],
    }));
  }

  let truncated = false;
  if (rankedEntries.length > args.limit) {
    rankedEntries = rankedEntries.slice(0, args.limit);
    truncated = true;
  }

  return {
    paths: rankedEntries,
    truncated,
  };
}

export async function listPathsRecursively(
  args: ListPathsRecursivelyArgs,
): Promise<ListedPath[]> {
  const entries = await fs.readdir(args.dir, { withFileTypes: true });
  const results: ListedPath[] = [];
  for (const entry of entries) {
    if (entry.name.startsWith(".")) continue;
    if (entry.name === "node_modules") continue;

    const fullPath = path.join(args.dir, entry.name);
    const relativePath = normalizeListedPath(
      path.relative(args.root, fullPath),
    );
    if (entry.isDirectory()) {
      if (args.includeDirectories) {
        results.push({
          kind: "directory",
          path: relativePath,
          name: entry.name,
        });
      }
      results.push(
        ...(await listPathsRecursively({
          ...args,
          dir: fullPath,
        })),
      );
      continue;
    }

    if (args.includeFiles) {
      results.push({
        kind: "file",
        path: relativePath,
        name: entry.name,
      });
    }
  }
  return results;
}

export async function listFilesRecursively(
  dir: string,
  root: string,
): Promise<string[]> {
  const paths = await listPathsRecursively({
    dir,
    root,
    includeFiles: true,
    includeDirectories: false,
  });
  return paths.map((pathEntry) => pathEntry.path);
}
