import { memo, useEffect, useMemo, useState } from "react";
import { useIntersectionObserver } from "usehooks-ts";
import { cn } from "@bb/shared-ui/lib/utils";
import type { DiffPresentation } from "@/components/code/code-rendering";
import {
  GitDiffCardBody,
  useGitDiffCardBody,
  type GitDiffCardSvgDisplayMode,
  type RequestDiffFileContents,
} from "./GitDiffCardBody";
import {
  GitDiffCardHeader,
  GitDiffCardImageSizeStat,
  GitDiffCardRawToggle,
  gitDiffCardHeaderWrapperClass,
  type GitDiffCardHeaderModel,
} from "./GitDiffCardHeader";
import {
  formatGitDiffFileLabel,
  getGitDiffFileChangeKind,
  getOpenableGitDiffPath,
  normalizeGitDiffPath,
  summarizeGitDiffFile,
  type ParsedGitDiffFile,
} from "./git-diff-parsing";

interface GitDiffCardProps {
  fileDiff: ParsedGitDiffFile;
  presentation: DiffPresentation;
  patchText?: string;
  filePathRoot?: string | null;
  onOpenFileInEditor?: (path: string) => void;
  isCollapsed?: boolean;
  onToggleCollapsed?: () => void;
  stickyHeader?: boolean;
  isRendering?: boolean;
  cardClassName?: string;
  showStuckHeaderEdge?: boolean;
  onRequestFileContents?: RequestDiffFileContents;
}

function buildGitDiffCardHeaderModel(
  fileDiff: ParsedGitDiffFile,
): GitDiffCardHeaderModel {
  const stats = summarizeGitDiffFile(fileDiff);
  return {
    label: formatGitDiffFileLabel(fileDiff),
    path: normalizeGitDiffPath(fileDiff.name) ?? fileDiff.name,
    openablePath: getOpenableGitDiffPath(fileDiff),
    changeKind: getGitDiffFileChangeKind(fileDiff),
    insertions: stats.insertions,
    deletions: stats.deletions,
  };
}

export const GitDiffCard = memo(function GitDiffCard({
  fileDiff,
  presentation,
  patchText,
  filePathRoot,
  onOpenFileInEditor,
  isCollapsed,
  onToggleCollapsed,
  stickyHeader = false,
  isRendering = false,
  cardClassName,
  showStuckHeaderEdge = true,
  onRequestFileContents,
}: GitDiffCardProps) {
  const headerModel = useMemo(
    () => buildGitDiffCardHeaderModel(fileDiff),
    [fileDiff],
  );
  const previousPath = normalizeGitDiffPath(fileDiff.prevName) ?? null;
  const bodyState = useGitDiffCardBody({
    fileDiff,
    changeKind: headerModel.changeKind,
    isRendering,
    onRequestFileContents,
    patchText,
  });
  const [svgDisplayMode, setSvgDisplayMode] =
    useState<GitDiffCardSvgDisplayMode>("preview");
  useEffect(() => {
    setSvgDisplayMode("preview");
  }, [fileDiff]);
  const toggleSvgDisplayMode = () => {
    setSvgDisplayMode((currentMode) =>
      currentMode === "preview" ? "raw" : "preview",
    );
  };
  const hasChanges = fileDiff.hunks.length > 0 || bodyState.isImageCard;
  const supportsCollapse =
    isCollapsed !== undefined && onToggleCollapsed !== undefined;
  const isBodyHidden = !hasChanges || (supportsCollapse && isCollapsed);
  const { ref: stickySentinelRef, isIntersecting } = useIntersectionObserver({
    initialIsIntersecting: true,
    threshold: 1,
  });
  const isHeaderStuck = stickyHeader && !isIntersecting;

  return (
    <div
      className={cn(
        "rounded-lg border border-border bg-background",
        cardClassName,
      )}
    >
      {stickyHeader ? <div ref={stickySentinelRef} className="h-0" /> : null}
      <div
        className={gitDiffCardHeaderWrapperClass({
          stickyHeader,
          isBodyHidden,
          isStuck: isHeaderStuck,
          showStuckHeaderEdge,
        })}
      >
        <GitDiffCardHeader
          model={headerModel}
          previousPath={previousPath}
          filePathRoot={filePathRoot}
          onOpenFileInEditor={onOpenFileInEditor}
          isCollapsed={isCollapsed}
          onToggleCollapsed={onToggleCollapsed}
          hasChanges={hasChanges}
          statSlot={
            bodyState.isImageCard ? (
              bodyState.imageSizeStat !== null ? (
                <GitDiffCardImageSizeStat stat={bodyState.imageSizeStat} />
              ) : (
                <span />
              )
            ) : undefined
          }
          actionSlot={
            bodyState.isSvgPreviewCard && !isBodyHidden ? (
              <GitDiffCardRawToggle
                fileLabel={bodyState.fileDiffLabel}
                isRaw={svgDisplayMode === "raw"}
                onToggle={toggleSvgDisplayMode}
              />
            ) : undefined
          }
        />
      </div>
      {!isBodyHidden ? (
        <GitDiffCardBody
          state={bodyState}
          presentation={presentation}
          svgDisplayMode={svgDisplayMode}
          reservesCollapseGutter={supportsCollapse}
        />
      ) : null}
    </div>
  );
});
