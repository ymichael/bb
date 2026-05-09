import { parsePatchFiles } from "@pierre/diffs";

export type ParsedGitDiffFile = ReturnType<
  typeof parsePatchFiles
>[number]["files"][number];

export interface GitDiffStats {
  filesCount: number;
  insertions: number;
  deletions: number;
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

export function formatGitDiffFileLabel(file: ParsedGitDiffFile): string {
  if (file.prevName && file.prevName !== file.name) {
    return `${file.prevName} -> ${file.name}`;
  }
  return file.name;
}

export function getParsedGitDiffFileKey(
  file: ParsedGitDiffFile,
  index: number,
): string {
  return `${file.name}:${file.prevName ?? ""}:${index}`;
}

function getGitDiffPathAliases(path: string | undefined): string[] {
  if (!path || path === "/dev/null") return [];
  const normalizedPath = path.startsWith("./") ? path.slice(2) : path;
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
