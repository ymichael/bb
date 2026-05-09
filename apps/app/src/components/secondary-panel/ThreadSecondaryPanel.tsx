import { type CSSProperties, type ReactNode, memo, useMemo } from "react";
import { useAtomValue } from "jotai";
import {
  ChevronRight,
  FileDiff as FileDiffIcon,
  FolderOpen,
  GripVertical,
  Info,
  MoreHorizontal,
  X,
} from "lucide-react";
import { FileDiff as DiffView } from "@pierre/diffs/react";
import { DiffStatsTally, FilePathLink, Skeleton } from "@/components/ui";
import { copyToClipboardWithToast } from "@/lib/clipboard";
import { Panel, PanelResizeHandle } from "react-resizable-panels";
import { useIntersectionObserver } from "usehooks-ts";
import {
  Button,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui";
import { cn } from "@/lib/utils";
import { type ThreadSecondaryPanel as ThreadSecondaryPanelTab } from "@/lib/thread-secondary-panel";
import {
  formatGitDiffFileLabel,
  getOpenableGitDiffPath,
  summarizeGitDiffFile,
  type ParsedGitDiffFile,
} from "./git-diff/git-diff-parsing";
import { usePreferredTheme } from "@/hooks/useTheme";
import {
  useActiveSecondaryPanel,
  useIsSecondaryPanelOpen,
} from "@/lib/thread-secondary-panel";
import { useGitDiffPanelState } from "./git-diff/useGitDiffPanelState";
import { useResponsiveGitDiffPanelDisplay } from "./git-diff/useResponsiveGitDiffPanelDisplay";
import {
  gitDiffCollapsedFileKeysAtom,
  gitDiffLoadingFileKeysAtom,
  threadSecondaryPanelResizingAtom,
} from "./threadSecondaryPanelAtoms";
import { GitDiffToolbar } from "./GitDiffToolbar";
export type {
  GitDiffDisplayMode,
  GitDiffSelectionOption,
} from "./GitDiffToolbar";

export const GIT_DIFF_VIEW_BASE_OPTIONS = {
  overflow: "scroll",
  disableFileHeader: false,
} as const;

const THREAD_SECONDARY_PANEL_MIN_SIZE_PERCENT = 24;
const THREAD_SECONDARY_PANEL_MAX_SIZE_PERCENT = 70;
const THREAD_SECONDARY_PANEL_DEFAULT_SIZE_PERCENT = 50;
const GIT_DIFF_SKELETON_FILE_COUNT = 3;
const GIT_DIFF_VIEW_STYLE = {
  "--diffs-font-size": "12px",
  "--diffs-line-height": "18px",
} as CSSProperties;
const GIT_DIFF_CARD_BODY_STYLE: CSSProperties = {
  contain: "layout paint style",
  contentVisibility: "auto",
  containIntrinsicSize: "0 600px",
};
const THREAD_SECONDARY_PANEL_TRANSITION_CLASS =
  "duration-[220ms] ease-[cubic-bezier(0.32,0.72,0,1)]";

function ThreadDiffSkeleton({
  count = GIT_DIFF_SKELETON_FILE_COUNT,
}: {
  count?: number;
}) {
  return (
    <div className="space-y-2 pt-2">
      {Array.from({ length: count }).map((_, index) => (
        <div
          key={`git-diff-skeleton-${index}`}
          className="rounded-lg border border-border/70 bg-background/70 shadow-sm"
        >
          <div className="border-b border-border/70 bg-card/70 px-3 py-1.5">
            <div className="flex items-center justify-between gap-2">
              <div className="flex min-w-0 flex-1 items-center gap-1.5">
                <Skeleton className="size-4 shrink-0 rounded-sm" />
                <Skeleton className="h-3 w-48 max-w-full rounded-sm" />
              </div>
              <Skeleton className="h-3 w-14 shrink-0 rounded-sm" />
            </div>
          </div>
          <div className="space-y-1.5 px-2.5 py-2">
            <Skeleton className="h-3 w-full rounded-sm" />
            <Skeleton className="h-3 w-[94%] rounded-sm" />
            <Skeleton className="h-3 w-[90%] rounded-sm" />
            <Skeleton className="h-3 w-[86%] rounded-sm" />
          </div>
        </div>
      ))}
    </div>
  );
}

interface StuckState {
  isStuck: boolean;
  sentinelRef: (node?: Element | null) => void;
}

function useIsStuck(): StuckState {
  const { ref: sentinelRef, isIntersecting } = useIntersectionObserver({
    initialIsIntersecting: true,
    threshold: 1,
  });

  return {
    isStuck: !isIntersecting,
    sentinelRef,
  };
}

export interface GitDiffFileCardProps {
  fileKey: string;
  fileDiff: ParsedGitDiffFile;
  threadId: string;
  isCollapsed: boolean;
  isRendering: boolean;
  setGitDiffFileRef: (fileKey: string, element: HTMLDivElement | null) => void;
  toggleGitDiffFileCollapsed: (fileKey: string) => void;
  gitDiffViewOptions: Record<string, string | boolean>;
  onOpenFileInEditor?: (path: string) => void;
}

export const GitDiffFileCard = memo(function GitDiffFileCard({
  fileKey,
  fileDiff,
  threadId,
  isCollapsed,
  isRendering,
  setGitDiffFileRef,
  toggleGitDiffFileCollapsed,
  gitDiffViewOptions,
  onOpenFileInEditor,
}: GitDiffFileCardProps) {
  const { isStuck: isHeaderStuck, sentinelRef } = useIsStuck();
  const fileDiffStats = useMemo(
    () => summarizeGitDiffFile(fileDiff),
    [fileDiff],
  );
  const fileDiffLabel = useMemo(
    () => formatGitDiffFileLabel(fileDiff),
    [fileDiff],
  );
  const openablePath = useMemo(
    () => getOpenableGitDiffPath(fileDiff),
    [fileDiff],
  );
  const canOpenFile = Boolean(openablePath);
  const diffViewOptions = useMemo(
    () => ({ ...gitDiffViewOptions, disableFileHeader: true }),
    [gitDiffViewOptions],
  );

  return (
    <div
      ref={(element) => setGitDiffFileRef(fileKey, element)}
      className="rounded-lg border border-border/70 bg-background shadow-sm"
    >
      <div ref={sentinelRef} className="h-0" />
      <div
        className={cn(
          "sticky top-0 z-30 rounded-lg bg-background px-3 py-1.5 text-xs font-medium text-foreground",
          !isCollapsed && "rounded-b-none",
          // When stuck, the card's own rounded top border scrolls out of view;
          // add a matching top border on the sticky so it still reads as the
          // top edge of the card instead of a flat-cut slab.
          isHeaderStuck && "rounded-t-none border-t border-border/70",
        )}
      >
        <div className="flex w-full min-w-0 items-center justify-between gap-2">
          <span className="flex min-w-0 items-center gap-1.5">
            <button
              type="button"
              className="inline-flex size-5 shrink-0 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-accent/70 hover:text-foreground"
              onClick={() => toggleGitDiffFileCollapsed(fileKey)}
              aria-label={`${isCollapsed ? "Expand" : "Collapse"} ${fileDiffLabel}`}
              aria-expanded={!isCollapsed}
            >
              <ChevronRight
                className={cn(
                  "size-3.5 shrink-0 transition-transform duration-150",
                  !isCollapsed && "rotate-90",
                )}
              />
            </button>
            <FilePathLink
              path={openablePath ?? fileDiff.name}
              displayName={fileDiffLabel}
              onClick={
                canOpenFile && openablePath && onOpenFileInEditor
                  ? () => onOpenFileInEditor(openablePath)
                  : undefined
              }
              variant="external"
              className="font-medium text-foreground"
            />
          </span>
          <span className="flex shrink-0 items-center gap-1">
            <DiffStatsTally
              insertions={fileDiffStats.insertions}
              deletions={fileDiffStats.deletions}
              className="text-xs"
            />
            {openablePath ? (
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon"
                    className="size-5 rounded-md p-0 text-muted-foreground hover:bg-accent/70 hover:text-foreground data-[state=open]:bg-accent/45 data-[state=open]:text-foreground"
                    aria-label={`More actions for ${fileDiffLabel}`}
                    title="More actions"
                  >
                    <MoreHorizontal className="size-3.5" />
                  </Button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="end" className="w-40">
                  <DropdownMenuItem
                    onSelect={() => {
                      void copyToClipboardWithToast(openablePath, {
                        successMessage: "Path copied",
                        errorMessage: "Could not copy path",
                      });
                    }}
                  >
                    Copy path
                  </DropdownMenuItem>
                </DropdownMenuContent>
              </DropdownMenu>
            ) : null}
          </span>
        </div>
      </div>
      {!isCollapsed ? (
        <div
          className="overflow-hidden rounded-b-lg bg-background"
          style={GIT_DIFF_CARD_BODY_STYLE}
        >
          {isRendering ? (
            <div className="space-y-1.5 px-3 py-3">
              <Skeleton className="h-3 w-full rounded-sm" />
              <Skeleton className="h-3 w-[96%] rounded-sm" />
              <Skeleton className="h-3 w-[93%] rounded-sm" />
              <Skeleton className="h-3 w-[90%] rounded-sm" />
              <Skeleton className="h-3 w-[87%] rounded-sm" />
              <Skeleton className="h-3 w-[84%] rounded-sm" />
            </div>
          ) : (
            <div className="overflow-x-auto">
              <div className="w-full max-w-full" style={GIT_DIFF_VIEW_STYLE}>
                <DiffView fileDiff={fileDiff} options={diffViewOptions} />
              </div>
            </div>
          )}
        </div>
      ) : null}
    </div>
  );
});

export interface ThreadSecondaryPanelProps {
  canUseGitUi: boolean;
  defaultMergeBaseBranch?: string;
  environmentId?: string;
  isManagerThread: boolean;
  metadataContent: ReactNode;
  threadStorageContent?: ReactNode;
  showThreadStorageTab?: boolean;
  showGitDiffTab?: boolean;
  onPanelChange: (panel: ThreadSecondaryPanelTab) => void;
  threadId: string;
  onCollapse: () => void;
  onClose: () => void;
  onOpenFileInEditor?: (path: string) => void;
  /**
   * When true, render only the aside content — skip the PanelResizeHandle +
   * Panel wrappers that are only meaningful inside a desktop PanelGroup.
   * Caller is responsible for wrapping the content in a Drawer on mobile.
   */
  isMobile?: boolean;
}

export function ThreadSecondaryPanel({
  canUseGitUi,
  defaultMergeBaseBranch,
  environmentId,
  isManagerThread,
  metadataContent,
  threadStorageContent,
  showThreadStorageTab = false,
  showGitDiffTab = true,
  onPanelChange,
  threadId,
  onCollapse,
  onClose,
  onOpenFileInEditor,
  isMobile = false,
}: ThreadSecondaryPanelProps) {
  const rawActivePanel = useActiveSecondaryPanel();
  const isOpen = useIsSecondaryPanelOpen();
  const {
    gitDiffDisplayMode,
    handleGitDiffDisplayModeChange,
    handleSecondaryPanelDragging,
    handleSecondaryPanelResize,
    secondaryPanelRef: panelRef,
    secondaryResizablePanelRef: resizablePanelRef,
  } = useResponsiveGitDiffPanelDisplay({ isSecondaryPanelOpen: isOpen });
  const activePanel =
    !canUseGitUi && rawActivePanel === "git-diff"
      ? "thread-info"
      : !isManagerThread && rawActivePanel === "thread-storage"
        ? "thread-info"
        : rawActivePanel;
  const isDiffPanelActive = activePanel === "git-diff";
  const isThreadStoragePanelActive = activePanel === "thread-storage";
  const {
    currentGitDiff,
    gitDiffError,
    gitDiffSelectOptions,
    gitDiffSelectValue,
    gitDiffStats,
    hasParsedGitDiffFiles,
    isGitDiffLoading,
    isParsingGitDiffFiles,
    isPreparingGitDiff,
    onGitDiffSelectionChange,
    parsedGitDiffFileEntries,
    queuedGitDiffFileRenderKeys,
    setGitDiffFileRef,
    threadGitDiff,
    toggleAllGitDiffFilesCollapsed,
    toggleGitDiffFileCollapsed,
  } = useGitDiffPanelState({
    environmentId,
    isDiffPanelActive,
    defaultMergeBaseBranch,
  });
  const hasCurrentGitDiff = currentGitDiff.trim().length > 0;
  const collapsedGitDiffFileKeys = useAtomValue(gitDiffCollapsedFileKeysAtom);
  const loadingGitDiffFileKeys = useAtomValue(gitDiffLoadingFileKeysAtom);
  const areAllGitDiffFilesCollapsed =
    hasParsedGitDiffFiles &&
    parsedGitDiffFileEntries.every(({ key }) =>
      collapsedGitDiffFileKeys.has(key),
    );
  const preferredTheme = usePreferredTheme();
  const gitDiffViewOptions = useMemo(
    () => ({
      ...GIT_DIFF_VIEW_BASE_OPTIONS,
      diffStyle: gitDiffDisplayMode,
      themeType: preferredTheme,
    }),
    [gitDiffDisplayMode, preferredTheme],
  );

  const asideMarkup = (
    <aside
      ref={panelRef}
      aria-hidden={!isOpen}
      className={cn(
        "flex h-full min-h-0 min-w-0 flex-1 flex-col overflow-hidden bg-background",
        !isMobile && [
          "transition-[transform,opacity,background-color]",
          THREAD_SECONDARY_PANEL_TRANSITION_CLASS,
          isOpen
            ? "opacity-100"
            : "pointer-events-none translate-x-[8%] opacity-0",
        ],
      )}
    >
      <div className="bg-background">
        <div className="flex h-12 min-w-0 items-center justify-between gap-3 px-4">
          <div
            className="inline-flex items-center gap-1"
            role="tablist"
            aria-label="Secondary panel views"
          >
            <Button
              type="button"
              variant="ghost"
              size="sm"
              className={cn(
                "h-7 w-7 rounded-md p-0",
                activePanel === "thread-info"
                  ? "bg-accent/35 text-foreground hover:bg-accent/45"
                  : "text-muted-foreground hover:bg-muted/45 hover:text-foreground",
              )}
              onClick={() => onPanelChange("thread-info")}
              aria-label="Show thread info panel"
              aria-pressed={activePanel === "thread-info"}
              title="Info"
            >
              <Info className="size-3.5" />
            </Button>
            {showGitDiffTab !== false ? (
              <Button
                type="button"
                variant="ghost"
                size="sm"
                className={cn(
                  "h-7 w-7 rounded-md p-0",
                  isDiffPanelActive
                    ? "bg-accent/35 text-foreground hover:bg-accent/45"
                    : "text-muted-foreground hover:bg-muted/45 hover:text-foreground",
                )}
                onClick={() => onPanelChange("git-diff")}
                aria-label="Show diff panel"
                aria-pressed={isDiffPanelActive}
                title="Diff"
              >
                <FileDiffIcon className="size-3.5" />
              </Button>
            ) : null}
            {showThreadStorageTab ? (
              <Button
                type="button"
                variant="ghost"
                size="sm"
                className={cn(
                  "h-7 w-7 rounded-md p-0",
                  isThreadStoragePanelActive
                    ? "bg-accent/35 text-foreground hover:bg-accent/45"
                    : "text-muted-foreground hover:bg-muted/45 hover:text-foreground",
                )}
                onClick={() => onPanelChange("thread-storage")}
                aria-label="Show thread storage panel"
                aria-pressed={isThreadStoragePanelActive}
                title="Storage"
              >
                <FolderOpen className="size-3.5" />
              </Button>
            ) : null}
          </div>
          <Button
            type="button"
            variant="ghost"
            size="icon"
            className="h-7 w-7 shrink-0 rounded-md p-0 text-muted-foreground hover:bg-accent/45 hover:text-foreground"
            onClick={onClose}
            aria-label="Close secondary panel"
            title="Close secondary panel"
          >
            <X className="size-3.5" />
          </Button>
        </div>
        {isDiffPanelActive ? (
          <GitDiffToolbar
            selectionValue={gitDiffSelectValue}
            selectionOptions={gitDiffSelectOptions}
            onSelectionChange={onGitDiffSelectionChange}
            isSelectorDisabled={isGitDiffLoading || threadGitDiff === undefined}
            stats={gitDiffStats}
            isParsing={isParsingGitDiffFiles}
            areAllFilesCollapsed={areAllGitDiffFilesCollapsed}
            isCollapseAllDisabled={!hasParsedGitDiffFiles || isGitDiffLoading}
            onToggleAllCollapsed={toggleAllGitDiffFilesCollapsed}
            displayMode={gitDiffDisplayMode}
            onDisplayModeChange={handleGitDiffDisplayModeChange}
          />
        ) : null}
      </div>
      <div
        className={cn(
          "min-h-0 flex-1 overflow-x-hidden overflow-y-auto bg-background px-4 pb-3",
          isDiffPanelActive ? "pt-0" : "pt-1",
        )}
      >
        {isDiffPanelActive ? (
          isPreparingGitDiff ? (
            <ThreadDiffSkeleton />
          ) : gitDiffError ? (
            <p className="rounded-lg border border-destructive/20 bg-destructive/5 px-3 py-2 text-xs text-destructive">
              {gitDiffError instanceof Error
                ? gitDiffError.message
                : "Failed to load git diff"}
            </p>
          ) : threadGitDiff && hasCurrentGitDiff ? (
            <>
              {parsedGitDiffFileEntries.length > 0 ? (
                <div className="space-y-2">
                  {parsedGitDiffFileEntries.map(({ key, fileDiff }) => {
                    const isCollapsed = collapsedGitDiffFileKeys.has(key);
                    const hasQueuedFileRender =
                      queuedGitDiffFileRenderKeys.has(key);
                    const isRendering =
                      !hasQueuedFileRender || loadingGitDiffFileKeys.has(key);

                    return (
                      <GitDiffFileCard
                        key={key}
                        fileKey={key}
                        fileDiff={fileDiff}
                        threadId={threadId}
                        isCollapsed={isCollapsed}
                        isRendering={isRendering}
                        setGitDiffFileRef={setGitDiffFileRef}
                        toggleGitDiffFileCollapsed={toggleGitDiffFileCollapsed}
                        gitDiffViewOptions={gitDiffViewOptions}
                        onOpenFileInEditor={onOpenFileInEditor}
                      />
                    );
                  })}
                  {isParsingGitDiffFiles ? (
                    <div className="rounded-lg border border-border/70 bg-background/70 px-3 py-3 shadow-sm">
                      <div className="space-y-1.5">
                        <Skeleton className="h-3 w-52 max-w-full rounded-sm" />
                        <Skeleton className="h-3 w-5/6 rounded-sm" />
                      </div>
                    </div>
                  ) : null}
                </div>
              ) : (
                <pre className="overflow-auto whitespace-pre rounded-lg border border-border/70 bg-background/70 p-3 font-mono text-xs text-foreground shadow-sm">
                  {threadGitDiff.diff}
                </pre>
              )}
              {threadGitDiff.truncated ? (
                <p className="pt-2 text-xs text-muted-foreground">
                  Diff output was truncated for display.
                </p>
              ) : null}
            </>
          ) : (
            <p className="rounded-lg border border-dashed border-border/70 bg-background/45 px-3 py-6 text-center text-sm text-muted-foreground">
              No diff to display.
            </p>
          )
        ) : isThreadStoragePanelActive ? (
          (threadStorageContent ?? (
            <p className="rounded-lg border border-dashed border-border/70 bg-background/45 px-3 py-6 text-center text-sm text-muted-foreground">
              No thread storage available.
            </p>
          ))
        ) : (
          metadataContent
        )}
      </div>
    </aside>
  );

  if (isMobile) {
    return asideMarkup;
  }

  return (
    <>
      <SecondaryPanelResizeHandle
        isOpen={isOpen}
        onDragging={handleSecondaryPanelDragging}
      />
      <Panel
        ref={resizablePanelRef}
        id="thread-detail-secondary-panel"
        collapsible
        collapsedSize={0}
        defaultSize={isOpen ? THREAD_SECONDARY_PANEL_DEFAULT_SIZE_PERCENT : 0}
        minSize={THREAD_SECONDARY_PANEL_MIN_SIZE_PERCENT}
        maxSize={THREAD_SECONDARY_PANEL_MAX_SIZE_PERCENT}
        onCollapse={onCollapse}
        onResize={handleSecondaryPanelResize}
        order={2}
        className={cn(
          "min-w-0 overflow-hidden transition-[flex-grow,flex-basis,opacity]",
          THREAD_SECONDARY_PANEL_TRANSITION_CLASS,
          isOpen ? "opacity-100" : "opacity-0",
        )}
      >
        {asideMarkup}
      </Panel>
    </>
  );
}

function SecondaryPanelResizeHandle({
  isOpen,
  onDragging,
}: {
  isOpen: boolean;
  onDragging: (isDragging: boolean) => void;
}) {
  const isResizing = useAtomValue(threadSecondaryPanelResizingAtom);
  return (
    <PanelResizeHandle
      id="thread-detail-secondary-panel-handle"
      disabled={!isOpen}
      onDragging={onDragging}
      className={cn(
        "group relative shrink-0 cursor-col-resize overflow-visible bg-transparent transition-[width,opacity,background-color] before:absolute before:inset-y-0 before:-left-1.5 before:-right-1.5 before:content-['']",
        THREAD_SECONDARY_PANEL_TRANSITION_CLASS,
        isOpen ? "w-px opacity-100" : "pointer-events-none w-0 opacity-0",
        isResizing && "bg-accent/20",
      )}
      aria-label="Resize thread and secondary panels"
    >
      <span
        className={cn(
          "pointer-events-none absolute inset-y-0 left-1/2 w-px -translate-x-1/2 bg-border/70 transition-colors",
          isResizing
            ? "bg-accent-foreground/50"
            : "group-hover:bg-accent-foreground/35",
        )}
      />
      <span
        className={cn(
          "pointer-events-none absolute left-1/2 top-1/2 flex h-8 w-1.5 -translate-x-1/2 -translate-y-1/2 items-center justify-center rounded-full border border-border/70 bg-background/95 opacity-0 shadow-sm transition-opacity",
          isResizing ? "opacity-100" : "group-hover:opacity-100",
        )}
      >
        <GripVertical className="size-3 text-muted-foreground" />
      </span>
    </PanelResizeHandle>
  );
}
