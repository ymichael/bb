import { parsePatchFiles } from "@pierre/diffs";

export type ParsedGitDiffFile = ReturnType<
  typeof parsePatchFiles
>[number]["files"][number];

export type GitDiffFileChangeKind =
  | "added"
  | "modified"
  | "deleted"
  | "renamed";

export interface GitDiffStats {
  filesCount: number;
  insertions: number;
  deletions: number;
}

export interface ParsedGitDiffFileEntry {
  key: string;
  fileDiff: ParsedGitDiffFile;
}

export function parseGitDiffFiles(
  diff: string,
): ReturnType<typeof parsePatchFiles>[number]["files"] {
  if (diff.trim().length === 0) return [];
  try {
    return parsePatchFiles(diff).flatMap((patch) => patch.files);
  } catch {
    return [];
  }
}

export function splitGitDiffIntoPatchChunks(diff: string): string[] {
  const trimmedDiff = diff.trim();
  if (trimmedDiff.length === 0) return [];

  const lines = diff.split("\n");
  const chunks: string[] = [];
  let currentChunk: string[] = [];
  let hasGitPatchHeader = false;

  for (const line of lines) {
    const startsPatch = line.startsWith("diff --git ");
    if (startsPatch) {
      hasGitPatchHeader = true;
    }
    if (startsPatch && currentChunk.length > 0) {
      chunks.push(currentChunk.join("\n"));
      currentChunk = [line];
      continue;
    }
    currentChunk.push(line);
  }

  if (currentChunk.length > 0) {
    chunks.push(currentChunk.join("\n"));
  }

  if (!hasGitPatchHeader) {
    return [diff];
  }

  return chunks.filter((chunk) => chunk.trim().length > 0);
}

export function parseGitDiffPatchChunks(
  patchChunks: readonly string[],
): ParsedGitDiffFile[] {
  const files: ParsedGitDiffFile[] = [];
  for (const chunk of patchChunks) {
    files.push(...parseGitDiffFiles(chunk));
  }
  return files;
}

export function getGitDiffParseKey(diff: string): string {
  return `${diff.length}:${diff.slice(0, 120)}:${diff.slice(-120)}`;
}

export function summarizeGitDiff(
  files: ParsedGitDiffFile[],
  diff: string,
): GitDiffStats {
  if (files.length > 0) {
    let insertions = 0;
    let deletions = 0;
    for (const file of files) {
      for (const hunk of file.hunks) {
        insertions += hunk.additionCount;
        deletions += hunk.deletionCount;
      }
    }
    return { filesCount: files.length, insertions, deletions };
  }

  let insertions = 0;
  let deletions = 0;
  let filesCount = 0;
  for (const line of diff.split("\n")) {
    if (line.startsWith("diff --git ")) {
      filesCount += 1;
      continue;
    }
    if (line.startsWith("+++ ")) continue;
    if (line.startsWith("--- ")) continue;
    if (line.startsWith("+")) {
      insertions += 1;
      continue;
    }
    if (line.startsWith("-")) {
      deletions += 1;
    }
  }
  return {
    filesCount:
      filesCount > 0 ? filesCount : insertions > 0 || deletions > 0 ? 1 : 0,
    insertions,
    deletions,
  };
}

export function summarizeGitDiffFile(
  file: ParsedGitDiffFile,
): Pick<GitDiffStats, "insertions" | "deletions"> {
  let insertions = 0;
  let deletions = 0;
  for (const hunk of file.hunks) {
    insertions += hunk.additionCount;
    deletions += hunk.deletionCount;
  }
  return { insertions, deletions };
}

export function getGitDiffFileChangeKind(
  file: ParsedGitDiffFile,
): GitDiffFileChangeKind {
  switch (file.type) {
    case "new":
      return "added";
    case "deleted":
      return "deleted";
    case "rename-pure":
    case "rename-changed":
      return "renamed";
    case "change":
      return "modified";
    default: {
      const _exhaustive: never = file.type;
      return _exhaustive;
    }
  }
}

export function formatGitDiffFileLabel(file: ParsedGitDiffFile): string {
  const name = normalizeGitDiffPath(file.name) ?? file.name;
  const prevName = normalizeGitDiffPath(file.prevName);
  if (prevName && prevName !== name) {
    return `${prevName} -> ${name}`;
  }
  return name;
}

export function getParsedGitDiffFileKey(file: ParsedGitDiffFile): string {
  return `${getGitDiffFileChangeKind(file)}:${normalizeGitDiffPath(file.name) ?? ""}:${normalizeGitDiffPath(file.prevName) ?? ""}`;
}

export function buildParsedGitDiffFileEntries(
  files: readonly ParsedGitDiffFile[],
): ParsedGitDiffFileEntry[] {
  const seenBaseKeyCounts = new Map<string, number>();
  return files.map((fileDiff) => {
    const baseKey = getParsedGitDiffFileKey(fileDiff);
    const seenCount = seenBaseKeyCounts.get(baseKey) ?? 0;
    seenBaseKeyCounts.set(baseKey, seenCount + 1);
    return {
      key: seenCount === 0 ? baseKey : `${baseKey}:${seenCount + 1}`,
      fileDiff,
    };
  });
}

export function normalizeGitDiffPath(
  path: string | undefined,
): string | undefined {
  const trimmedPath = path?.trim();
  return trimmedPath && trimmedPath.length > 0 ? trimmedPath : undefined;
}

function getGitDiffPathAliases(path: string | undefined): string[] {
  const cleanPath = normalizeGitDiffPath(path);
  if (!cleanPath || cleanPath === "/dev/null") return [];
  const normalizedPath = cleanPath.startsWith("./")
    ? cleanPath.slice(2)
    : cleanPath;
  if (normalizedPath.length === 0) return [];
  const aliases = [normalizedPath];
  if (normalizedPath.startsWith("a/") || normalizedPath.startsWith("b/")) {
    aliases.push(normalizedPath.slice(2));
  }
  return Array.from(new Set(aliases.filter((alias) => alias.length > 0)));
}

export function doesGitDiffFileMatchPath(
  file: ParsedGitDiffFile,
  targetPath: string,
): boolean {
  const targetAliases = new Set(getGitDiffPathAliases(targetPath));
  if (targetAliases.size === 0) return false;

  for (const candidatePath of [file.name, file.prevName]) {
    for (const alias of getGitDiffPathAliases(candidatePath)) {
      if (targetAliases.has(alias)) {
        return true;
      }
    }
  }
  return false;
}

export function getOpenableGitDiffPath(file: ParsedGitDiffFile): string | null {
  for (const candidatePath of [file.name, file.prevName]) {
    const aliases = getGitDiffPathAliases(candidatePath);
    if (aliases.length > 0) {
      return aliases[aliases.length - 1] ?? null;
    }
  }
  return null;
}
