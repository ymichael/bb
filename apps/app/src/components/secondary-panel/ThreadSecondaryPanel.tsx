import { type FocusEvent, type ReactNode, useMemo } from "react";
import { useAtomValue } from "jotai";
import { Icon } from "@/components/ui/icon.js";
import { TabPill } from "@/components/ui/tab-pill";
import { Panel, PanelResizeHandle } from "react-resizable-panels";
import { Button } from "@/components/ui/button.js";
import { cn } from "@/lib/utils";
import type { WorkspaceFilePreviewStatusLabel } from "@/lib/file-preview";
import { type ThreadSecondaryPanel as ThreadSecondaryPanelTab } from "@/lib/thread-secondary-panel";
import { GIT_DIFF_VIEW_BASE_OPTIONS } from "../git-diff/GitDiffCard";
import { usePreferredTheme } from "@/hooks/useTheme";
import { useGitDiffPanelState } from "./git-diff/useGitDiffPanelState";
import { useResponsiveGitDiffPanelDisplay } from "./git-diff/useResponsiveGitDiffPanelDisplay";
import {
  gitDiffCollapsedFileKeysAtom,
  gitDiffLoadingFileKeysAtom,
  threadSecondaryPanelResizingAtom,
} from "./threadSecondaryPanelAtoms";
import { GitDiffToolbar } from "./GitDiffToolbar";
import {
  GitDiffTabContent,
  ThreadInfoTabContent,
} from "./ThreadSecondaryPanelTabContent";
export type {
  GitDiffDisplayMode,
  GitDiffSelectionOption,
} from "./GitDiffToolbar";

const THREAD_SECONDARY_PANEL_MIN_SIZE_PERCENT = 24;
const THREAD_SECONDARY_PANEL_MAX_SIZE_PERCENT = 70;
const THREAD_SECONDARY_PANEL_TRANSITION_CLASS =
  "duration-[220ms] ease-[cubic-bezier(0.32,0.72,0,1)]";
const PANEL_SCROLL_SLOT_CLASS =
  "min-h-0 flex-1 overflow-x-hidden overflow-y-auto";

export interface SecondaryPanelFileTab {
  id: string;
  filename: string;
  isActive: boolean;
  isPinned?: boolean;
  statusLabel: WorkspaceFilePreviewStatusLabel | null;
  onSelect: () => void;
  onClose: () => void;
}

export interface ThreadSecondaryPanelProps {
  activePanel: ThreadSecondaryPanelTab | null;
  canUseGitUi: boolean;
  defaultMergeBaseBranch?: string;
  environmentId?: string;
  metadataContent: ReactNode;
  fileTabs?: SecondaryPanelFileTab[];
  fileTabContent?: ReactNode;
  isOpen: boolean;
  showGitDiffTab?: boolean;
  onPanelFocus: () => void;
  onPanelChange: (panel: ThreadSecondaryPanelTab) => void;
  onCollapse: () => void;
  onClose: () => void;
  workspaceRootPath?: string | null;
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
  activePanel: rawActivePanel,
  canUseGitUi,
  defaultMergeBaseBranch,
  environmentId,
  metadataContent,
  fileTabs,
  fileTabContent,
  isOpen,
  showGitDiffTab = true,
  onPanelFocus,
  onPanelChange,
  onCollapse,
  onClose,
  workspaceRootPath,
  onOpenFileInEditor,
  onOpenFilePreview,
  renderAsDrawer,
}: ThreadSecondaryPanelProps) {
  const activeFileTab = fileTabs?.find((tab) => tab.isActive);
  const hasActiveFileTab = activeFileTab !== undefined;
  const togglePanelIconName = renderAsDrawer ? "X" : "PanelRight";
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
  const collapsedGitDiffFileKeys = useAtomValue(gitDiffCollapsedFileKeysAtom);
  const loadingGitDiffFileKeys = useAtomValue(gitDiffLoadingFileKeysAtom);
  const areAllGitDiffFilesCollapsed = useMemo(
    () =>
      hasParsedGitDiffFiles &&
      parsedGitDiffFileEntries.every(({ key }) =>
        collapsedGitDiffFileKeys.has(key),
      ),
    [collapsedGitDiffFileKeys, hasParsedGitDiffFiles, parsedGitDiffFileEntries],
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
  const handlePanelFocusCapture = (event: FocusEvent<HTMLElement>) => {
    const previousTarget = event.relatedTarget;
    if (
      previousTarget instanceof Node &&
      event.currentTarget.contains(previousTarget)
    ) {
      return;
    }
    onPanelFocus();
  };

  const asideMarkup = (
    <aside
      ref={panelRef}
      aria-hidden={!isOpen}
      onFocusCapture={handlePanelFocusCapture}
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
              className="h-7 w-7 shrink-0 rounded-md p-0"
              onClick={() => onPanelChange("thread-info")}
              aria-label="Show thread info panel"
              aria-pressed={activePanel === "thread-info" && !hasActiveFileTab}
              title="Info"
            >
              <Icon name="Info" />
            </Button>
            {showGitDiffTab !== false ? (
              <Button
                type="button"
                variant="ghost"
                size="sm"
                className="h-7 w-7 shrink-0 rounded-md p-0"
                onClick={() => onPanelChange("git-diff")}
                aria-label="Show diff panel"
                aria-pressed={isDiffPanelActive && !hasActiveFileTab}
                title="Diff"
              >
                <Icon name="FileDiff" />
              </Button>
            ) : null}
            {fileTabs && fileTabs.length > 0 ? (
              <div className="flex min-w-0 items-center gap-1 overflow-x-auto">
                {fileTabs.map((tab) => (
                  <FileTab key={tab.id} tab={tab} />
                ))}
              </div>
            ) : null}
          </div>
          <Button
            type="button"
            variant="ghost"
            size="icon"
            className="h-7 w-7 shrink-0 rounded-md p-0"
            onClick={onClose}
            aria-label={
              renderAsDrawer ? "Close secondary panel" : "Hide secondary panel"
            }
            title={
              renderAsDrawer ? "Close secondary panel" : "Hide secondary panel"
            }
          >
            <Icon name={togglePanelIconName} />
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
              <p className="mx-4 rounded-lg border border-dashed border-border bg-surface-raised px-3 py-6 text-center text-sm text-muted-foreground">
                No file preview content provided.
              </p>
            )}
          </div>
        ) : isDiffPanelActive ? (
          <GitDiffTabContent
            collapsedGitDiffFileKeys={collapsedGitDiffFileKeys}
            currentGitDiff={currentGitDiff}
            gitDiffError={
              gitDiffError instanceof Error
                ? gitDiffError
                : gitDiffError
                  ? new Error("Failed to load git diff")
                  : null
            }
            gitDiffViewOptions={gitDiffViewOptions}
            isParsingGitDiffFiles={isParsingGitDiffFiles}
            isPreparingGitDiff={isPreparingGitDiff}
            loadingGitDiffFileKeys={loadingGitDiffFileKeys}
            onOpenFileInEditor={onOpenFileInEditor}
            onOpenFilePreview={onOpenFilePreview}
            onRequestFileContents={onRequestFileContents}
            parsedGitDiffFileEntries={parsedGitDiffFileEntries}
            queuedGitDiffFileRenderKeys={queuedGitDiffFileRenderKeys}
            setGitDiffFileRef={setGitDiffFileRef}
            threadGitDiff={threadGitDiff}
            toggleGitDiffFileCollapsed={toggleGitDiffFileCollapsed}
            workspaceRootPath={workspaceRootPath}
          />
        ) : (
          <ThreadInfoTabContent metadataContent={metadataContent} />
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

function FileTab({ tab }: { tab: SecondaryPanelFileTab }) {
  const title =
    tab.statusLabel === null
      ? tab.filename
      : `${tab.filename} (${tab.statusLabel})`;
  return (
    <TabPill
      label={tab.filename}
      secondaryLabel={tab.statusLabel === null ? null : `(${tab.statusLabel})`}
      title={title}
      isActive={tab.isActive}
      onSelect={tab.onSelect}
      labelMaxWidthClass="max-w-[160px]"
      closeAction={
        tab.isPinned
          ? null
          : {
              onClose: tab.onClose,
              closeLabel: `Close ${tab.filename}`,
              closeTooltip: "Close tab",
            }
      }
    />
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
          "pointer-events-none absolute inset-y-0 left-1/2 w-px -translate-x-1/2 bg-border transition-colors",
          isResizing
            ? "bg-accent-foreground/50"
            : "group-hover:bg-accent-foreground/35",
        )}
      />
    </PanelResizeHandle>
  );
}
