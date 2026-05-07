import { memo, useMemo, type CSSProperties } from "react";
import { parsePatchFiles, type FileDiffMetadata } from "@pierre/diffs";
import { FileDiff } from "@pierre/diffs/react";
import type { TimelineFileChange } from "@bb/server-contract";
import {
  getFileChangeAction,
  isPatchMetadataLine,
  type FileChangeAction,
} from "@bb/thread-view";
import { EventCodeBlock } from "../ui/event-content.js";
import { TimelineDetailScroll } from "./TimelineDetailScroll.js";
import type { ThreadTimelineTheme } from "./types.js";

export interface TimelineFileDiffBlockProps {
  change: TimelineFileChange;
  themeType: ThreadTimelineTheme;
}

interface TimelineDiffViewStyle extends CSSProperties {
  "--diffs-font-size": string;
  "--diffs-line-height": string;
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
  disableFileHeader: true,
} as const;

const DIFF_VIEW_STYLE: TimelineDiffViewStyle = {
  "--diffs-font-size": "12px",
  "--diffs-line-height": "18px",
};

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
        patch: `--- a/${normalizedPath}\n+++ b/${normalizedPath}\n${patch.trimEnd()}\n`,
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
}: TimelineFileDiffBlockProps) {
  const diffViewOptions = useMemo(
    () => ({
      ...DIFF_VIEW_BASE_OPTIONS,
      themeType,
    }),
    [themeType],
  );
  const renderedChange = useMemo(
    () => buildRenderedFileChange(change),
    [change],
  );
  const renderablePatch = renderedChange.renderablePatch;
  const fileDiffOptions = useMemo(
    () =>
      renderablePatch
        ? {
            ...diffViewOptions,
            disableLineNumbers: renderablePatch.disableLineNumbers,
          }
        : null,
    [diffViewOptions, renderablePatch],
  );

  if (
    renderedChange.renderablePatch === null &&
    renderedChange.plainDiff === null
  ) {
    return (
      <div className="rounded-md border border-border/60 bg-background/40 px-2 py-1.5 text-xs text-muted-foreground">
        No diff available.
      </div>
    );
  }

  const diffContentKey = `${renderablePatch ? "p" : "n"}:${renderedChange.plainDiff?.length ?? 0}`;

  return (
    <TimelineDetailScroll
      size="base"
      contentKey={diffContentKey}
      className="mt-1 rounded-md border border-border/60 bg-background/40"
    >
      <div className="min-w-fit">
        {renderablePatch && fileDiffOptions ? (
          <div data-timeline-file-diff="" style={DIFF_VIEW_STYLE}>
            <FileDiff
              fileDiff={renderablePatch.fileDiff}
              options={fileDiffOptions}
            />
          </div>
        ) : null}
        {renderedChange.plainDiff ? (
          <EventCodeBlock className="rounded-none border-0 bg-transparent">
            {renderedChange.plainDiff}
          </EventCodeBlock>
        ) : null}
      </div>
    </TimelineDetailScroll>
  );
});
