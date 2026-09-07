import type { TimelineFileChange } from "@bb/server-contract";
import {
  getFileChangeAction,
  isPatchMetadataLine,
  type FileChangeAction,
} from "@bb/thread-view";

export interface RenderablePatchText {
  disableLineNumbers: boolean;
  patch: string;
}

type SyntheticPatchAction = "created" | "deleted";

function splitPatchLines(diff: string): string[] {
  const normalizedDiff = diff.replaceAll("\r\n", "\n");
  if (normalizedDiff.length === 0) {
    return [];
  }
  const lines = normalizedDiff.split("\n");
  const lastLine = lines[lines.length - 1];
  if (lastLine === "") {
    lines.pop();
  }
  return lines;
}

function getPatchBodyLines(diff: string | null): string[] {
  if (!diff) {
    return [];
  }
  return splitPatchLines(diff).filter((line) => !isPatchMetadataLine(line));
}

function normalizePatchPath(path: string): string {
  return path.replaceAll("\\", "/").replace(/^\/+/u, "");
}

function buildSyntheticPatchBodyLines(
  lines: readonly string[],
  action: SyntheticPatchAction,
): string[] {
  const contentPrefix = action === "created" ? "+" : "-";
  const oppositePrefix = action === "created" ? "-" : "+";
  const bodyLines: string[] = [];

  for (const line of lines) {
    if (line.startsWith(contentPrefix)) {
      bodyLines.push(line);
      continue;
    }
    if (line.startsWith(oppositePrefix) || line.startsWith(" ")) {
      continue;
    }
    bodyLines.push(`${contentPrefix}${line}`);
  }

  return bodyLines;
}

function toSyntheticPatch(
  change: TimelineFileChange,
  action: SyntheticPatchAction,
): string | null {
  const lines = getPatchBodyLines(change.diff);
  if (lines.length === 0) return null;
  const normalizedPath = normalizePatchPath(change.path);
  const fromPath = action === "created" ? "/dev/null" : `a/${normalizedPath}`;
  const toPath = action === "created" ? `b/${normalizedPath}` : "/dev/null";
  const bodyLines = buildSyntheticPatchBodyLines(lines, action);
  if (bodyLines.length === 0) return null;
  const oldCount = action === "created" ? 0 : bodyLines.length;
  const newCount = action === "created" ? bodyLines.length : 0;
  const body = bodyLines.join("\n");
  return `diff --git a/${normalizedPath} b/${normalizedPath}\n--- ${fromPath}\n+++ ${toPath}\n@@ -1,${oldCount} +1,${newCount} @@\n${body}\n`;
}

function toSyntheticUpdatePatch(change: TimelineFileChange): string | null {
  const bodyLines = getPatchBodyLines(change.diff);
  if (bodyLines.length === 0) {
    return null;
  }
  const hasUnifiedLines = bodyLines.some(
    (line) => line.startsWith("+") || line.startsWith("-"),
  );
  if (!hasUnifiedLines) {
    return null;
  }

  const normalizedPath = normalizePatchPath(change.movePath ?? change.path);
  const removedCount = bodyLines.filter((line) => line.startsWith("-")).length;
  const addedCount = bodyLines.filter((line) => line.startsWith("+")).length;
  return `diff --git a/${normalizedPath} b/${normalizedPath}\n--- a/${normalizedPath}\n+++ b/${normalizedPath}\n@@ -1,${Math.max(removedCount, 1)} +1,${Math.max(addedCount, 1)} @@\n${bodyLines.join("\n")}\n`;
}

export function getRenderablePatchText(
  change: TimelineFileChange,
): RenderablePatchText | null {
  const patch = change.diff;
  if (patch && patch.trim().length > 0) {
    const trimmedPatch = patch.trimEnd();
    if (
      trimmedPatch.startsWith("diff --git") ||
      (trimmedPatch.includes("--- ") &&
        trimmedPatch.includes("+++ ") &&
        trimmedPatch.includes("@@"))
    ) {
      return {
        patch,
        disableLineNumbers: false,
      };
    }
    if (patch.includes("@@")) {
      const normalizedPath = normalizePatchPath(change.movePath ?? change.path);
      return {
        patch: `diff --git a/${normalizedPath} b/${normalizedPath}\n--- a/${normalizedPath}\n+++ b/${normalizedPath}\n${patch.trimEnd()}\n`,
        disableLineNumbers: false,
      };
    }
  }

  const action: FileChangeAction = getFileChangeAction(change);
  const syntheticPatch =
    (action === "created"
      ? toSyntheticPatch(change, "created")
      : action === "deleted"
        ? toSyntheticPatch(change, "deleted")
        : null) ?? toSyntheticUpdatePatch(change);
  if (!syntheticPatch) {
    return null;
  }
  return {
    patch: syntheticPatch,
    disableLineNumbers: true,
  };
}

export function getPlainDiffFallback(
  change: TimelineFileChange,
  hasRenderablePatch: boolean,
): string | null {
  if (hasRenderablePatch) {
    return null;
  }
  const diff = change.diff?.trimEnd();
  return diff && diff.length > 0 ? diff : null;
}
