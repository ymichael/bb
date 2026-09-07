import { parsePatchFiles, processFile, type FileContents } from "@pierre/diffs";
import type { GitDiffFileChangeKind } from "@bb/server-contract";

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

interface NormalizedFilePatch {
  patch: string;
  file: ParsedGitDiffFile;
}

export function normalizeFilePatch({
  patch,
  path,
}: {
  patch: string;
  path: string;
}): NormalizedFilePatch | null {
  const normalizedPatch = patch.replace(/\r\n/g, "\n").trimEnd();
  if (normalizedPatch.length === 0) return null;
  const normalizedPath = normalizeGitDiffPath(path) ?? path;
  const patchText = normalizedPatch.startsWith("diff --git")
    ? `${normalizedPatch}\n`
    : `diff --git a/${normalizedPath} b/${normalizedPath}\n--- a/${normalizedPath}\n+++ b/${normalizedPath}\n${normalizedPatch}\n`;
  const file = parseGitDiffFiles(patchText)[0];
  if (file === undefined || file.hunks.length === 0) return null;
  return { patch: patchText, file };
}

interface GitDiffContextEnrichmentInput {
  fileDiff: ParsedGitDiffFile;
  oldFile: FileContents;
  newFile: FileContents;
  patchText?: string;
}

export function enrichGitDiffFileForContext({
  fileDiff,
  oldFile,
  newFile,
  patchText,
}: GitDiffContextEnrichmentInput): ParsedGitDiffFile {
  if (!patchText || !doFullFilePathsMatch(fileDiff, oldFile, newFile)) {
    return fileDiff;
  }

  const enrichedFile = processFile(patchText, { oldFile, newFile });
  if (
    enrichedFile === undefined ||
    enrichedFile.isPartial ||
    !doFullFileHunksMatch(fileDiff, enrichedFile)
  ) {
    return fileDiff;
  }
  return enrichedFile;
}

function doFullFilePathsMatch(
  fileDiff: ParsedGitDiffFile,
  oldFile: FileContents,
  newFile: FileContents,
): boolean {
  const expectedNewPath = normalizeGitDiffPath(fileDiff.name);
  const expectedOldPath =
    normalizeGitDiffPath(fileDiff.prevName) ?? expectedNewPath;
  return (
    expectedOldPath !== undefined &&
    expectedNewPath !== undefined &&
    normalizeGitDiffPath(oldFile.name) === expectedOldPath &&
    normalizeGitDiffPath(newFile.name) === expectedNewPath
  );
}

function doFullFileHunksMatch(
  partialFile: ParsedGitDiffFile,
  fullFile: ParsedGitDiffFile,
): boolean {
  return partialFile.hunks.every(
    (hunk) =>
      doLineRangesMatch({
        expectedLines: partialFile.deletionLines,
        expectedStart: hunk.deletionLineIndex,
        actualLines: fullFile.deletionLines,
        actualStart: hunk.deletionStart - 1,
        count: hunk.deletionCount,
      }) &&
      doLineRangesMatch({
        expectedLines: partialFile.additionLines,
        expectedStart: hunk.additionLineIndex,
        actualLines: fullFile.additionLines,
        actualStart: hunk.additionStart - 1,
        count: hunk.additionCount,
      }),
  );
}

function doLineRangesMatch({
  expectedLines,
  expectedStart,
  actualLines,
  actualStart,
  count,
}: {
  expectedLines: string[];
  expectedStart: number;
  actualLines: string[];
  actualStart: number;
  count: number;
}): boolean {
  if (
    expectedStart < 0 ||
    actualStart < 0 ||
    count < 0 ||
    expectedStart + count > expectedLines.length ||
    actualStart + count > actualLines.length
  ) {
    return false;
  }
  for (let index = 0; index < count; index += 1) {
    if (
      normalizeComparableDiffLine(expectedLines[expectedStart + index]) !==
      normalizeComparableDiffLine(actualLines[actualStart + index])
    ) {
      return false;
    }
  }
  return true;
}

function normalizeComparableDiffLine(line: string | undefined): string {
  return line?.endsWith("\r\n") ? `${line.slice(0, -2)}\n` : (line ?? "");
}

export function summarizeGitDiffFile(
  file: ParsedGitDiffFile,
): Pick<GitDiffStats, "insertions" | "deletions"> {
  let insertions = 0;
  let deletions = 0;
  for (const hunk of file.hunks) {
    insertions += hunk.additionLines;
    deletions += hunk.deletionLines;
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

export function normalizeGitDiffPath(
  path: string | undefined,
): string | undefined {
  const trimmedPath = path?.trim();
  return trimmedPath && trimmedPath.length > 0 ? trimmedPath : undefined;
}

const IMAGE_GIT_DIFF_FILE_EXTENSIONS: ReadonlySet<string> = new Set([
  "avif",
  "bmp",
  "gif",
  "ico",
  "jpeg",
  "jpg",
  "png",
  "webp",
]);

export function isPreviewableImagePath(path: string | undefined): boolean {
  const normalizedPath = normalizeGitDiffPath(path);
  if (normalizedPath === undefined) return false;
  const extension = normalizedPath.split(".").pop()?.toLowerCase();
  return (
    extension !== undefined && IMAGE_GIT_DIFF_FILE_EXTENSIONS.has(extension)
  );
}

export function isSvgGitDiffFile(file: ParsedGitDiffFile): boolean {
  const path = normalizeGitDiffPath(file.name) ?? file.name;
  return path.toLowerCase().endsWith(".svg");
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

export function getOpenableGitDiffPath(file: ParsedGitDiffFile): string | null {
  for (const candidatePath of [file.name, file.prevName]) {
    const aliases = getGitDiffPathAliases(candidatePath);
    if (aliases.length > 0) {
      return aliases[aliases.length - 1] ?? null;
    }
  }
  return null;
}
