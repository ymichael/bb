import { memo, useMemo } from "react";
import { parsePatchFiles, type FileDiffMetadata } from "@pierre/diffs";
import type { TimelineFileChange } from "@bb/server-contract";
import {
  getFileChangeAction,
  isPatchMetadataLine,
  type FileChangeAction,
} from "@bb/thread-view";
import { GitDiffCard } from "../../git-diff/GitDiffCard.js";
import { EventCodeBlock } from "../../ui/event-code-block.js";
import { TimelineDetailScroll } from "./TimelineDetailScroll.js";
import type { ThreadTimelineTheme } from "./types.js";

export interface TimelineFileDiffBlockProps {
  change: TimelineFileChange;
  themeType: ThreadTimelineTheme;
  /**
   * Workspace root path the agent ran in (`environment.path`). When defined,
   * the prefix is stripped from `change.path`/`change.movePath` before the
   * patch is synthesized so the card header shows repo-relative paths
   * matching what the secondary-panel diff renders. Pass `undefined` only
   * when the environment hasn't loaded yet — the strip becomes a no-op.
   */
  workspaceRootPath: string | undefined;
}

interface RenderablePatch {
  disableLineNumbers: boolean;
  fileDiff: FileDiffMetadata;
}

interface RenderablePatchText {
  disableLineNumbers: boolean;
  patch: string;
}

interface RenderedFileChange {
  plainDiff: string | null;
  renderablePatch: RenderablePatch | null;
}

type SyntheticPatchAction = "created" | "deleted";

const DIFF_VIEW_BASE_OPTIONS = {
  overflow: "scroll",
  diffStyle: "unified",
} as const;

const renderedFileChangeCache = new WeakMap<
  TimelineFileChange,
  RenderedFileChange
>();

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

function stripWorkspaceRoot(
  path: string | null,
  root: string | undefined,
): string | null {
  if (!path || !root) return path;
  const normalizedRoot = root.replace(/\/+$/u, "");
  if (normalizedRoot.length === 0) return path;
  if (path === normalizedRoot) return path;
  if (path.startsWith(`${normalizedRoot}/`)) {
    return path.slice(normalizedRoot.length + 1);
  }
  return path;
}

function normalizeChangePaths(
  change: TimelineFileChange,
  workspaceRootPath: string | undefined,
): TimelineFileChange {
  if (!workspaceRootPath) return change;
  const nextPath = stripWorkspaceRoot(change.path, workspaceRootPath) ?? change.path;
  const nextMovePath = stripWorkspaceRoot(change.movePath, workspaceRootPath);
  if (nextPath === change.path && nextMovePath === change.movePath) {
    return change;
  }
  return { ...change, path: nextPath, movePath: nextMovePath };
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

function getRenderablePatchText(
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
        // The leading `diff --git` line is what flips parsePatchFiles into
        // git-aware mode — without it, the parser keeps the `a/` and `b/`
        // prefixes on the file headers and the card thinks the file was
        // renamed (prevName="a/foo", name="b/foo").
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

function parseRenderablePatch(
  patchText: RenderablePatchText,
): RenderablePatch | null {
  try {
    const parsedPatches = parsePatchFiles(patchText.patch);
    if (parsedPatches.length !== 1) {
      return null;
    }
    const parsedPatch = parsedPatches[0];
    if (!parsedPatch || parsedPatch.files.length !== 1) {
      return null;
    }
    const fileDiff = parsedPatch.files[0];
    if (!fileDiff) {
      return null;
    }
    return {
      disableLineNumbers: patchText.disableLineNumbers,
      fileDiff,
    };
  } catch {
    return null;
  }
}

function getPlainDiffFallback(
  change: TimelineFileChange,
  hasRenderablePatch: boolean,
): string | null {
  if (hasRenderablePatch) {
    return null;
  }
  const diff = change.diff?.trimEnd();
  return diff && diff.length > 0 ? diff : null;
}

function buildRenderedFileChange(
  change: TimelineFileChange,
): RenderedFileChange {
  const cached = renderedFileChangeCache.get(change);
  if (cached) {
    return cached;
  }

  const renderablePatchText = getRenderablePatchText(change);
  const renderablePatch =
    renderablePatchText === null
      ? null
      : parseRenderablePatch(renderablePatchText);
  const renderedChange: RenderedFileChange = {
    renderablePatch,
    plainDiff: getPlainDiffFallback(change, renderablePatch !== null),
  };
  renderedFileChangeCache.set(change, renderedChange);
  return renderedChange;
}

export const TimelineFileDiffBlock = memo(function TimelineFileDiffBlock({
  change,
  themeType,
  workspaceRootPath,
}: TimelineFileDiffBlockProps) {
  const normalizedChange = useMemo(
    () => normalizeChangePaths(change, workspaceRootPath),
    [change, workspaceRootPath],
  );
  const renderedChange = useMemo(
    () => buildRenderedFileChange(normalizedChange),
    [normalizedChange],
  );
  const renderablePatch = renderedChange.renderablePatch;
  const cardDiffViewOptions = useMemo(
    () =>
      renderablePatch
        ? {
            ...DIFF_VIEW_BASE_OPTIONS,
            themeType,
            disableLineNumbers: renderablePatch.disableLineNumbers,
          }
        : null,
    [renderablePatch, themeType],
  );

  if (renderablePatch === null && renderedChange.plainDiff === null) {
    return (
      <div className="rounded-md border border-border bg-surface-raised px-2 py-1.5 text-xs text-muted-foreground">
        No diff available.
      </div>
    );
  }

  const diffContentKey = `${renderablePatch ? "p" : "n"}:${renderedChange.plainDiff?.length ?? 0}`;

  if (renderablePatch && cardDiffViewOptions) {
    return (
      <TimelineDetailScroll
        size="base"
        contentKey={diffContentKey}
        className="mt-1"
      >
        <div data-timeline-file-diff="">
          <GitDiffCard
            fileDiff={renderablePatch.fileDiff}
            diffViewOptions={cardDiffViewOptions}
            filePathRoot={workspaceRootPath}
            stickyHeader
          />
        </div>
      </TimelineDetailScroll>
    );
  }

  return (
    <TimelineDetailScroll
      size="base"
      contentKey={diffContentKey}
      className="mt-1 rounded-md border border-border bg-surface-raised"
    >
      <div className="min-w-fit">
        <EventCodeBlock className="rounded-none border-0 bg-transparent">
          {renderedChange.plainDiff!}
        </EventCodeBlock>
      </div>
    </TimelineDetailScroll>
  );
});
