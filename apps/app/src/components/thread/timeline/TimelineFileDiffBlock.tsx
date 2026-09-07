import { memo, useMemo } from "react";
import { parsePatchFiles, type FileDiffMetadata } from "@pierre/diffs";
import type { TimelineFileChange } from "@bb/server-contract";
import {
  getPlainDiffFallback,
  getRenderablePatchText,
  type RenderablePatchText,
} from "@bb/client-core";
import { GitDiffCard } from "../../git-diff/GitDiffCard.js";
import { EventCodeBlock } from "../../ui/event-code-block.js";
import type { DiffPresentation } from "@/components/code/code-rendering";
import { TimelineDetailScroll } from "./TimelineDetailScroll.js";

export interface TimelineFileDiffBlockProps {
  change: TimelineFileChange;
  workspaceRootPath: string | undefined;
}

interface RenderablePatch {
  disableLineNumbers: boolean;
  fileDiff: FileDiffMetadata;
  patch: string;
}

interface RenderedFileChange {
  plainDiff: string | null;
  renderablePatch: RenderablePatch | null;
}

const renderedFileChangeCache = new WeakMap<
  TimelineFileChange,
  RenderedFileChange
>();

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
      patch: patchText.patch,
    };
  } catch {
    return null;
  }
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
  workspaceRootPath,
}: TimelineFileDiffBlockProps) {
  const renderedChange = useMemo(
    () => buildRenderedFileChange(change),
    [change],
  );
  const renderablePatch = renderedChange.renderablePatch;
  const cardPresentation = useMemo<DiffPresentation | null>(
    () =>
      renderablePatch
        ? {
            view: "unified",
            overflow: "scroll",
            showLineNumbers: !renderablePatch.disableLineNumbers,
          }
        : null,
    [renderablePatch],
  );

  if (renderablePatch === null && renderedChange.plainDiff === null) {
    return (
      <div className="rounded-md border border-border bg-surface-raised px-2 py-1.5 text-xs text-muted-foreground">
        No diff available.
      </div>
    );
  }

  const diffContentKey = `${renderablePatch ? "p" : "n"}:${renderedChange.plainDiff?.length ?? 0}`;

  if (renderablePatch && cardPresentation) {
    return (
      <TimelineDetailScroll
        size="base"
        contentKey={diffContentKey}
        className="mt-1"
        scrollClassName="rounded-lg border border-border bg-background"
        showAboveFade={false}
      >
        <div data-timeline-file-diff="">
          <GitDiffCard
            fileDiff={renderablePatch.fileDiff}
            patchText={renderablePatch.patch}
            presentation={cardPresentation}
            filePathRoot={workspaceRootPath}
            cardClassName="rounded-none border-0 bg-transparent"
            showStuckHeaderEdge={false}
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
