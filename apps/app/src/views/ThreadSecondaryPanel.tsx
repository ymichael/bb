import {
  type CSSProperties,
  type ReactNode,
  type Ref,
  useEffect,
  useRef,
  useState,
} from "react";
import {
  Check,
  ChevronDown,
  ChevronRight,
  ChevronsDown,
  ChevronsUp,
  Columns2,
  FileDiff as FileDiffIcon,
  FolderOpen,
  GripVertical,
  Info,
  Loader2,
  Rows2,
  X,
} from "lucide-react";
import { FileDiff as DiffView } from "@pierre/diffs/react";
import {
  type ImperativePanelHandle,
  Panel,
  PanelResizeHandle,
} from "react-resizable-panels";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { openThreadPathInEditor } from "@/lib/api";
import { getPathCommandForTarget } from "@/lib/open-path-preferences";
import { cn } from "@/lib/utils";
import {
  type ThreadSecondaryPanel as ThreadSecondaryPanelTab,
} from "@/lib/thread-secondary-panel";
import {
  formatGitDiffFileLabel,
  getOpenableGitDiffPath,
  summarizeGitDiffFile,
  type ParsedGitDiffFile,
} from "./threadDetailGitDiff";

const THREAD_SECONDARY_PANEL_MIN_SIZE_PERCENT = 24;
const THREAD_SECONDARY_PANEL_MAX_SIZE_PERCENT = 70;
const THREAD_SECONDARY_PANEL_DEFAULT_SIZE_PERCENT = 50;
const GIT_DIFF_SKELETON_FILE_COUNT = 3;
const GIT_DIFF_VIEW_STYLE = {
  "--diffs-font-size": "12px",
  "--diffs-line-height": "18px",
} as CSSProperties;
const THREAD_SECONDARY_PANEL_TRANSITION_CLASS =
  "duration-[220ms] ease-[cubic-bezier(0.32,0.72,0,1)]";

export interface GitDiffSelectionOption {
  value: string;
  label: string;
}

interface ParsedGitDiffFileEntry {
  key: string;
  fileDiff: ParsedGitDiffFile;
}

interface ThreadGitDiffSelection {
  type: string;
  sha?: string;
}

interface ThreadGitDiffCommit {
  sha: string;
  shortSha: string;
  subject: string;
}

interface ThreadGitDiffData {
  mode: string;
  selection: ThreadGitDiffSelection;
  commits?: ThreadGitDiffCommit[];
  diff: string;
  truncated?: boolean;
}

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

function GitDiffSelector({
  value,
  options,
  onChange,
  disabled,
}: {
  value: string;
  options: readonly GitDiffSelectionOption[];
  onChange: (value: string) => void;
  disabled?: boolean;
}) {
  const selectedOption = options.find((option) => option.value === value);
  const selectedLabel = selectedOption?.label ?? value;

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild disabled={disabled}>
        <Button
          type="button"
          variant="ghost"
          size="sm"
          disabled={disabled}
          className={cn(
            "h-8 w-full min-w-0 justify-between gap-2 rounded-lg border border-border/70 bg-transparent px-2.5 text-xs font-normal hover:bg-muted/45 hover:text-foreground",
            disabled && "opacity-60",
          )}
        >
          <span className="truncate">{selectedLabel}</span>
          <ChevronDown className="size-3.5 shrink-0 text-muted-foreground" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent
        align="start"
        className="w-[var(--radix-dropdown-menu-trigger-width)] max-w-[var(--radix-dropdown-menu-trigger-width)]"
      >
        {options.map((option) => (
          <DropdownMenuItem
            key={option.value}
            onSelect={() => onChange(option.value)}
            className="flex items-center justify-between gap-2"
          >
            <span className="truncate" title={option.label}>
              {option.label}
            </span>
            <Check
              className={cn(
                "size-3.5",
                option.value === value ? "opacity-100" : "opacity-0",
              )}
            />
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

function useIsStuck(ref: { current: HTMLDivElement | null }) {
  const [isStuck, setIsStuck] = useState(false);

  useEffect(() => {
    if (typeof IntersectionObserver === "undefined" || !ref.current) {
      return;
    }

    const observer = new IntersectionObserver(
      (entries) => {
        setIsStuck(!(entries[0]?.isIntersecting ?? true));
      },
      { threshold: 1 },
    );

    observer.observe(ref.current);
    return () => {
      observer.disconnect();
    };
  }, [ref]);

  return isStuck;
}

function GitDiffFileCard({
  fileKey,
  fileDiff,
  threadId,
  isCollapsed,
  isRendering,
  setGitDiffFileRef,
  onToggleGitDiffFileCollapsed,
  gitDiffViewOptions,
}: {
  fileKey: string;
  fileDiff: ParsedGitDiffFile;
  threadId: string;
  isCollapsed: boolean;
  isRendering: boolean;
  setGitDiffFileRef: (fileKey: string, element: HTMLDivElement | null) => void;
  onToggleGitDiffFileCollapsed: (fileKey: string) => void;
  gitDiffViewOptions: Record<string, string | boolean>;
}) {
  const sentinelRef = useRef<HTMLDivElement>(null);
  const isHeaderStuck = useIsStuck(sentinelRef);
  const fileDiffStats = summarizeGitDiffFile(fileDiff);
  const fileDiffLabel = formatGitDiffFileLabel(fileDiff);
  const openablePath = getOpenableGitDiffPath(fileDiff);
  const canOpenFile = Boolean(openablePath);

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
          isHeaderStuck && "rounded-t-none",
        )}
      >
        <div className="flex w-full min-w-0 items-center justify-between gap-2">
          <span className="flex min-w-0 items-center gap-1.5">
            <button
              type="button"
              className="inline-flex size-5 shrink-0 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-accent/70 hover:text-foreground"
              onClick={() => onToggleGitDiffFileCollapsed(fileKey)}
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
            {canOpenFile && openablePath ? (
              <button
                type="button"
                className="block min-w-0 truncate text-left underline-offset-2 hover:underline"
                title={fileDiffLabel}
                onClick={() => {
                  void openThreadPathInEditor(threadId, {
                    relativePath: openablePath,
                    target: "file",
                    command: getPathCommandForTarget("file"),
                  });
                }}
              >
                {fileDiffLabel}
              </button>
            ) : (
              <span
                className="block min-w-0 truncate"
                title={fileDiffLabel}
              >
                {fileDiffLabel}
              </span>
            )}
          </span>
          <span className="shrink-0 whitespace-nowrap text-xs text-muted-foreground">
            +{fileDiffStats.additions} -{fileDiffStats.deletions}
          </span>
        </div>
      </div>
      {!isCollapsed ? (
        <div className="overflow-hidden rounded-b-lg bg-background">
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
              <div
                className="w-full max-w-full"
                style={GIT_DIFF_VIEW_STYLE}
              >
                <DiffView
                  fileDiff={fileDiff}
                  options={{
                    ...gitDiffViewOptions,
                    disableFileHeader: true,
                  }}
                />
              </div>
            </div>
          )}
        </div>
      ) : null}
    </div>
  );
}

export function ThreadSecondaryPanel({
  activePanel,
  metadataContent,
  managerWorkspaceContent,
  showManagerWorkspaceTab = false,
  showGitDiffTab = true,
  onPanelChange,
  threadId,
  panelRef,
  resizablePanelRef,
  isOpen,
  isResizing,
  onCollapse,
  onClose,
  onDragging,
  onResize,
  gitDiffSelectValue,
  gitDiffSelectOptions,
  onGitDiffSelectionChange,
  isGitDiffLoading,
  gitDiffError,
  threadGitDiff,
  currentGitDiff,
  isPreparingGitDiff,
  isParsingGitDiffFiles,
  gitDiffStatsLabel,
  hasParsedGitDiffFiles,
  areAllGitDiffFilesCollapsed,
  onToggleAllFiles,
  gitDiffDisplayMode,
  onGitDiffDisplayModeChange,
  parsedGitDiffFileEntries,
  collapsedGitDiffFileKeys,
  queuedGitDiffFileRenderKeys,
  loadingGitDiffFileKeys,
  setGitDiffFileRef,
  onToggleGitDiffFileCollapsed,
  gitDiffViewOptions,
}: {
  activePanel: ThreadSecondaryPanelTab | null;
  metadataContent: ReactNode;
  managerWorkspaceContent?: ReactNode;
  showManagerWorkspaceTab?: boolean;
  showGitDiffTab?: boolean;
  onPanelChange: (panel: ThreadSecondaryPanelTab) => void;
  threadId: string;
  panelRef: Ref<HTMLElement>;
  resizablePanelRef: Ref<ImperativePanelHandle>;
  isOpen: boolean;
  isResizing: boolean;
  onCollapse: () => void;
  onClose: () => void;
  onDragging: (isDragging: boolean) => void;
  onResize: (size: number) => void;
  gitDiffSelectValue: string;
  gitDiffSelectOptions: readonly GitDiffSelectionOption[];
  onGitDiffSelectionChange: (value: string) => void;
  isGitDiffLoading: boolean;
  gitDiffError: unknown;
  threadGitDiff?: ThreadGitDiffData;
  currentGitDiff: string;
  isPreparingGitDiff: boolean;
  isParsingGitDiffFiles: boolean;
  gitDiffStatsLabel: string;
  hasParsedGitDiffFiles: boolean;
  areAllGitDiffFilesCollapsed: boolean;
  onToggleAllFiles: () => void;
  gitDiffDisplayMode: "unified" | "split";
  onGitDiffDisplayModeChange: (value: "unified" | "split") => void;
  parsedGitDiffFileEntries: readonly ParsedGitDiffFileEntry[];
  collapsedGitDiffFileKeys: ReadonlySet<string>;
  queuedGitDiffFileRenderKeys: ReadonlySet<string>;
  loadingGitDiffFileKeys: ReadonlySet<string>;
  setGitDiffFileRef: (fileKey: string, element: HTMLDivElement | null) => void;
  onToggleGitDiffFileCollapsed: (fileKey: string) => void;
  gitDiffViewOptions: Record<string, string | boolean>;
}) {
  const isDiffPanelActive = activePanel === "git-diff";
  const isManagerWorkspacePanelActive = activePanel === "manager-workspace";
  const hasCurrentGitDiff = currentGitDiff.trim().length > 0;

  return (
    <>
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
      <Panel
        ref={resizablePanelRef}
        id="thread-detail-secondary-panel"
        collapsible
        collapsedSize={0}
        defaultSize={isOpen ? THREAD_SECONDARY_PANEL_DEFAULT_SIZE_PERCENT : 0}
        minSize={THREAD_SECONDARY_PANEL_MIN_SIZE_PERCENT}
        maxSize={THREAD_SECONDARY_PANEL_MAX_SIZE_PERCENT}
        onCollapse={onCollapse}
        onResize={onResize}
        order={2}
        className={cn(
          "min-w-0 overflow-hidden transition-[flex-grow,flex-basis,opacity]",
          THREAD_SECONDARY_PANEL_TRANSITION_CLASS,
          isOpen ? "opacity-100" : "opacity-0",
        )}
      >
        <aside
          ref={panelRef}
          aria-hidden={!isOpen}
          className={cn(
            "flex h-full min-h-0 min-w-0 flex-1 flex-col overflow-hidden bg-background transition-[transform,opacity,background-color]",
            THREAD_SECONDARY_PANEL_TRANSITION_CLASS,
            isOpen ? "opacity-100" : "pointer-events-none translate-x-[8%] opacity-0",
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
                {showManagerWorkspaceTab ? (
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    className={cn(
                      "h-7 w-7 rounded-md p-0",
                      isManagerWorkspacePanelActive
                        ? "bg-accent/35 text-foreground hover:bg-accent/45"
                        : "text-muted-foreground hover:bg-muted/45 hover:text-foreground",
                    )}
                    onClick={() => onPanelChange("manager-workspace")}
                    aria-label="Show manager workspace panel"
                    aria-pressed={isManagerWorkspacePanelActive}
                    title="Workspace"
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
              <div className="px-4 pb-3">
                <div className="flex min-w-0 items-center gap-3">
                  <div className="min-w-0 flex-1">
                    <GitDiffSelector
                      value={gitDiffSelectValue}
                      options={gitDiffSelectOptions}
                      onChange={onGitDiffSelectionChange}
                      disabled={isGitDiffLoading || threadGitDiff === undefined}
                    />
                  </div>
                  <span
                    className="min-w-0 shrink truncate text-xs text-muted-foreground"
                    title={gitDiffStatsLabel}
                  >
                    {gitDiffStatsLabel}
                  </span>
                  {isParsingGitDiffFiles ? (
                    <span className="inline-flex shrink-0 items-center gap-1 text-xs text-muted-foreground">
                      <Loader2 className="size-3 animate-spin" />
                      Parsing
                    </span>
                  ) : null}
                  <div className="ml-auto flex min-w-0 shrink-0 items-center justify-end gap-1">
                    <Button
                      type="button"
                      variant="ghost"
                      size="sm"
                      className="h-7 w-7 rounded-md p-0 text-muted-foreground hover:bg-accent/70 hover:text-foreground"
                      onClick={onToggleAllFiles}
                      disabled={!hasParsedGitDiffFiles || isGitDiffLoading}
                      aria-label={
                        areAllGitDiffFilesCollapsed ? "Expand all files" : "Collapse all files"
                      }
                      title={
                        areAllGitDiffFilesCollapsed ? "Expand all files" : "Collapse all files"
                      }
                    >
                      {areAllGitDiffFilesCollapsed ? (
                        <ChevronsDown className="size-3.5" />
                      ) : (
                        <ChevronsUp className="size-3.5" />
                      )}
                    </Button>
                    <div
                      className="inline-flex items-center gap-1 rounded-lg border border-border/70 p-0.5"
                      role="tablist"
                      aria-label="Diff view mode"
                    >
                      <Button
                        type="button"
                        variant="ghost"
                        size="sm"
                        className={cn(
                          "h-7 w-7 rounded-md p-0",
                          gitDiffDisplayMode === "unified"
                            ? "bg-accent/35 text-foreground hover:bg-accent/45"
                            : "text-muted-foreground hover:bg-muted/45 hover:text-foreground",
                        )}
                        onClick={() => onGitDiffDisplayModeChange("unified")}
                        aria-label="Stacked diff view"
                        aria-pressed={gitDiffDisplayMode === "unified"}
                        title="Stacked diff view"
                      >
                        <Rows2 className="size-3.5" />
                      </Button>
                      <Button
                        type="button"
                        variant="ghost"
                        size="sm"
                        className={cn(
                          "h-7 w-7 rounded-md p-0",
                          gitDiffDisplayMode === "split"
                            ? "bg-accent/35 text-foreground hover:bg-accent/45"
                            : "text-muted-foreground hover:bg-muted/45 hover:text-foreground",
                        )}
                        onClick={() => onGitDiffDisplayModeChange("split")}
                        aria-label="Split diff view"
                        aria-pressed={gitDiffDisplayMode === "split"}
                        title="Split diff view"
                      >
                        <Columns2 className="size-3.5" />
                      </Button>
                    </div>
                  </div>
                </div>
              </div>
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
                        const hasQueuedFileRender = queuedGitDiffFileRenderKeys.has(key);
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
                            onToggleGitDiffFileCollapsed={onToggleGitDiffFileCollapsed}
                            gitDiffViewOptions={gitDiffViewOptions}
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
            ) : isManagerWorkspacePanelActive ? (
              managerWorkspaceContent ?? (
                <p className="rounded-lg border border-dashed border-border/70 bg-background/45 px-3 py-6 text-center text-sm text-muted-foreground">
                  No manager workspace available.
                </p>
              )
            ) : (
              metadataContent
            )}
          </div>
        </aside>
      </Panel>
    </>
  );
}
