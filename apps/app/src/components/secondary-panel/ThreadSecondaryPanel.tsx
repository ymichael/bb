import { type ReactNode, useMemo } from "react";
import { useAtomValue } from "jotai";
import { Icon } from "@/components/ui/icon.js";
import { Skeleton } from "@/components/ui/skeleton.js";
import { Panel, PanelResizeHandle } from "react-resizable-panels";
import { Button } from "@/components/ui/button.js";
import { cn } from "@/lib/utils";
import { type ThreadSecondaryPanel as ThreadSecondaryPanelTab } from "@/lib/thread-secondary-panel";
import {
  GIT_DIFF_VIEW_BASE_OPTIONS,
  GitDiffCard,
} from "../git-diff/GitDiffCard";
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

const THREAD_SECONDARY_PANEL_MIN_SIZE_PERCENT = 24;
const THREAD_SECONDARY_PANEL_MAX_SIZE_PERCENT = 70;
const GIT_DIFF_SKELETON_FILE_COUNT = 3;
const THREAD_SECONDARY_PANEL_TRANSITION_CLASS =
  "duration-[220ms] ease-[cubic-bezier(0.32,0.72,0,1)]";
const PANEL_SCROLL_SLOT_CLASS =
  "min-h-0 flex-1 overflow-x-hidden overflow-y-auto";

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
          className="rounded-lg border border-border/70 bg-background/70"
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

export interface SecondaryPanelFileTab {
  id: string;
  filename: string;
  isActive: boolean;
  isPinned?: boolean;
  onSelect: () => void;
  onClose: () => void;
}

export interface ThreadSecondaryPanelProps {
  canUseGitUi: boolean;
  defaultMergeBaseBranch?: string;
  environmentId?: string;
  metadataContent: ReactNode;
  fileTabs?: SecondaryPanelFileTab[];
  fileTabContent?: ReactNode;
  showGitDiffTab?: boolean;
  onPanelChange: (panel: ThreadSecondaryPanelTab) => void;
  onCollapse: () => void;
  onClose: () => void;
  onOpenFileInEditor?: (path: string) => void;
  onOpenFilePreview?: (path: string) => void;
  /**
   * When true, render only the aside content — skip the PanelResizeHandle +
   * Panel wrappers that are only meaningful inside a desktop PanelGroup.
   * Caller is responsible for wrapping the content in a Drawer in that case.
   */
  renderAsDrawer: boolean;
}

export function ThreadSecondaryPanel({
  canUseGitUi,
  defaultMergeBaseBranch,
  environmentId,
  metadataContent,
  fileTabs,
  fileTabContent,
  showGitDiffTab = true,
  onPanelChange,
  onCollapse,
  onClose,
  onOpenFileInEditor,
  onOpenFilePreview,
  renderAsDrawer,
}: ThreadSecondaryPanelProps) {
  const activeFileTab = fileTabs?.find((tab) => tab.isActive);
  const hasActiveFileTab = activeFileTab !== undefined;
  const togglePanelIconName = renderAsDrawer ? "X" : "PanelRight";
  const rawActivePanel = useActiveSecondaryPanel();
  const isOpen = useIsSecondaryPanelOpen();
  const {
    gitDiffDisplayMode,
    handleGitDiffDisplayModeChange,
    handleSecondaryPanelDragging,
    handleSecondaryPanelResize,
    persistedWidthPercent,
    secondaryPanelRef: panelRef,
    secondaryResizablePanelRef: resizablePanelRef,
  } = useResponsiveGitDiffPanelDisplay({ isSecondaryPanelOpen: isOpen });
  const activePanel =
    !canUseGitUi && rawActivePanel === "git-diff"
      ? "thread-info"
      : rawActivePanel;
  const isDiffPanelActive = activePanel === "git-diff";
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
    onRequestFileContents,
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
        !renderAsDrawer && [
          "transition-[transform,opacity,background-color]",
          THREAD_SECONDARY_PANEL_TRANSITION_CLASS,
          isOpen
            ? "opacity-100"
            : "pointer-events-none translate-x-[8%] opacity-0",
        ],
      )}
    >
      <div className="bg-background">
        <div className="flex h-12 min-w-0 items-center justify-between gap-2 px-4">
          <div
            className="flex min-w-0 flex-1 items-center gap-1"
            role="tablist"
            aria-label="Secondary panel views"
          >
            <Button
              type="button"
              variant="ghost"
              size="sm"
              className="h-7 w-7 shrink-0 rounded-md p-0 text-muted-foreground"
              onClick={() => onPanelChange("thread-info")}
              aria-label="Show thread info panel"
              aria-pressed={activePanel === "thread-info" && !hasActiveFileTab}
              title="Info"
            >
              <Icon name="Info" className="size-3.5" />
            </Button>
            {showGitDiffTab !== false ? (
              <Button
                type="button"
                variant="ghost"
                size="sm"
                className="h-7 w-7 shrink-0 rounded-md p-0 text-muted-foreground"
                onClick={() => onPanelChange("git-diff")}
                aria-label="Show diff panel"
                aria-pressed={isDiffPanelActive && !hasActiveFileTab}
                title="Diff"
              >
                <Icon name="FileDiff" className="size-3.5" />
              </Button>
            ) : null}
            {fileTabs && fileTabs.length > 0 ? (
              <div className="flex min-w-0 items-center gap-1 overflow-x-auto">
                {fileTabs.map((tab) => (
                  <FileTabPill key={tab.id} tab={tab} />
                ))}
              </div>
            ) : null}
          </div>
          <Button
            type="button"
            variant="ghost"
            size="icon"
            className="h-7 w-7 shrink-0 rounded-md p-0 text-muted-foreground"
            onClick={onClose}
            aria-label={renderAsDrawer ? "Close secondary panel" : "Hide secondary panel"}
            title={renderAsDrawer ? "Close secondary panel" : "Hide secondary panel"}
          >
            <Icon name={togglePanelIconName} className="size-3.5" />
          </Button>
        </div>
        {isDiffPanelActive && !hasActiveFileTab ? (
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
      <div className="flex min-h-0 flex-1 flex-col overflow-hidden bg-background">
        {hasActiveFileTab ? (
          <div className={cn(PANEL_SCROLL_SLOT_CLASS, "pb-3")}>
            {fileTabContent ?? (
              <p className="mx-4 rounded-lg border border-dashed border-border/70 bg-background/45 px-3 py-6 text-center text-sm text-muted-foreground">
                No file preview content provided.
              </p>
            )}
          </div>
        ) : isDiffPanelActive ? (
          <div className={cn(PANEL_SCROLL_SLOT_CLASS, "px-4 pb-3")}>
            {isPreparingGitDiff ? (
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
                        !hasQueuedFileRender ||
                        loadingGitDiffFileKeys.has(key);

                      return (
                        <GitDiffCard
                          key={key}
                          fileDiff={fileDiff}
                          diffViewOptions={gitDiffViewOptions}
                          onOpenFileInEditor={onOpenFileInEditor}
                          onOpenFilePreview={onOpenFilePreview}
                          isCollapsed={isCollapsed}
                          onToggleCollapsed={() =>
                            toggleGitDiffFileCollapsed(key)
                          }
                          stickyHeader
                          isRendering={isRendering}
                          cardRef={(element) =>
                            setGitDiffFileRef(key, element)
                          }
                          onRequestFileContents={onRequestFileContents}
                        />
                      );
                    })}
                    {isParsingGitDiffFiles ? (
                      <div className="rounded-lg border border-border/70 bg-background/70 px-3 py-3">
                        <div className="space-y-1.5">
                          <Skeleton className="h-3 w-52 max-w-full rounded-sm" />
                          <Skeleton className="h-3 w-5/6 rounded-sm" />
                        </div>
                      </div>
                    ) : null}
                  </div>
                ) : (
                  <pre className="overflow-auto whitespace-pre rounded-lg border border-border/70 bg-background/70 p-3 font-mono text-xs text-foreground">
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
            )}
          </div>
        ) : (
          <div className="flex min-h-0 flex-1 flex-col px-4 pb-3">
            {metadataContent}
          </div>
        )}
      </div>
    </aside>
  );

  if (renderAsDrawer) {
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
        defaultSize={isOpen ? persistedWidthPercent : 0}
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

function FileTabPill({ tab }: { tab: SecondaryPanelFileTab }) {
  return (
    <div
      className={cn(
        "group/file-tab relative inline-flex h-7 shrink-0 items-center rounded-md text-xs transition-colors",
        tab.isActive
          ? "bg-muted text-foreground"
          : "text-muted-foreground hover:bg-muted/60",
      )}
    >
      <button
        type="button"
        onClick={tab.onSelect}
        aria-pressed={tab.isActive}
        title={tab.filename}
        className={cn(
          "flex h-full min-w-0 items-center rounded-l-md pl-2 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring",
          tab.isPinned ? "pr-2 rounded-r-md" : "pr-1",
        )}
      >
        <span className="max-w-[160px] truncate">{tab.filename}</span>
      </button>
      {tab.isPinned ? null : (
        <button
          type="button"
          onClick={tab.onClose}
          aria-label={`Close ${tab.filename}`}
          title="Close tab"
          className="mr-1 ml-0.5 inline-flex size-4 shrink-0 items-center justify-center rounded opacity-70 transition-opacity hover:bg-muted-foreground/15 hover:opacity-100 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring focus-visible:opacity-100"
        >
          <Icon name="X" className="size-3" />
        </button>
      )}
    </div>
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
    </PanelResizeHandle>
  );
}
