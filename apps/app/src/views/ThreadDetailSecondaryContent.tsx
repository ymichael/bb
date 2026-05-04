import { type ComponentProps, type ReactNode, useEffect, useRef } from "react";
import { cn } from "@/lib/utils";
import { HostStatusBadge } from "@/components/HostStatusIndicator";
import { Check, ChevronDown, ChevronRight, Copy, X } from "lucide-react";
import { Link } from "react-router-dom";
import { Panel, PanelGroup } from "react-resizable-panels";
import { Button } from "@bb/ui-core";
import { COARSE_POINTER_ICON_SIZE_CLASS } from "@bb/ui-core";
import { ResponsiveDrawerShell } from "@bb/ui-core";
import { useIsMobile } from "@bb/ui-core";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@bb/ui-core";
import {
  WorkspaceChangesList,
  type WorkspaceChangedFile,
} from "@/components/shared/WorkspaceChangesList";
import { ArchiveTimestampAction } from "@/components/shared/ArchiveTimestampAction";
import { MergeBaseBranchPicker } from "@/components/thread/MergeBaseBranchPicker";
import { useIsSecondaryPanelOpen } from "@/lib/thread-secondary-panel";
import type { ThreadGitStatusDisplay } from "@/lib/workspace-status";
import { ThreadSecondaryPanel } from "./ThreadSecondaryPanel";
import { ThreadTimelinePane } from "./ThreadTimelinePane";
import { DetailCard, DetailRow, LocalhostBadge } from "@bb/ui-core";
import type { Thread } from "@bb/domain";
import type { WorkspaceFile } from "@bb/server-contract";
import type { FilePreview } from "@/lib/file-preview";
import type { ManagerSelectorOption } from "./threadManagerSelectorOptions";

const TIMELINE_PANEL_DEFAULT_SIZE_PERCENT = 50;
const CLOSED_TIMELINE_PANEL_SIZE_PERCENT = 100;

type ThreadTimelinePaneProps = Omit<
  ComponentProps<typeof ThreadTimelinePane>,
  "footer" | "header"
>;
type ThreadSecondaryPanelProps = Omit<
  ComponentProps<typeof ThreadSecondaryPanel>,
  "threadStorageContent" | "metadataContent"
>;

interface ThreadDetailMetadataProps {
  canAssignToManager: boolean;
  canSelectMergeBase: boolean;
  canTakeOverThread: boolean;
  isLoadingMergeBaseBranchOptions: boolean;
  isManagerThread: boolean;
  managerSelectorOptions: readonly ManagerSelectorOption[];
  managerSelectorValue: string;
  onAssignManager: (parentThreadId: string | null) => void;
  onCopyThreadBranch: () => void;
  onMergeBaseBranchChange: (branch: string) => void;
  onUnarchive: () => void;
  parentThreadId?: string;
  projectId: string;
  selectedManagerOptionLabel?: string;
  showThreadChangedFiles: boolean;
  showMergeBase: boolean;
  showWorkspaceStatus: boolean;
  thread: Thread;
  threadBranchName?: string;
  threadEnvironmentModeLabel?: string;
  threadEnvironmentType?: string;
  threadEnvironmentValue?: ReactNode;
  threadHostConnected?: boolean;
  threadHostIsLocal?: boolean;
  threadHostName?: string;
  threadGitStatusDisplay: ThreadGitStatusDisplay;
  threadGitStatusLabelClass: string;
  mergeBaseBranch?: string;
  mergeBaseCandidates: readonly string[];
  unarchivePending: boolean;
  updateThreadPending: boolean;
  onChangedFileClick?: (file: WorkspaceChangedFile) => void;
  workspaceStatusFiles?: readonly WorkspaceChangedFile[];
  workspaceStatusFilesLabel?: string;
}

interface ThreadDetailThreadStorageProps {
  fileError?: Error | null;
  filePreview?: FilePreview;
  files?: readonly WorkspaceFile[];
  isFileLoading: boolean;
  onTogglePath: (path: string) => void;
  selectedPath: string | null;
}

interface ThreadDetailSecondaryContentProps {
  footer: ReactNode;
  header: ReactNode;
  threadStorage?: ThreadDetailThreadStorageProps;
  metadata: ThreadDetailMetadataProps;
  secondaryPanel: ThreadSecondaryPanelProps;
  showThreadMetadata: boolean;
  timeline: ThreadTimelinePaneProps;
}

function ThreadManagerSelector({
  canAssignToManager,
  canTakeOverThread,
  managerSelectorOptions,
  managerSelectorValue,
  onAssignManager,
  parentThreadId,
  projectId,
  selectedManagerOptionLabel,
  updateThreadPending,
}: Pick<
  ThreadDetailMetadataProps,
  | "canAssignToManager"
  | "canTakeOverThread"
  | "managerSelectorOptions"
  | "managerSelectorValue"
  | "onAssignManager"
  | "parentThreadId"
  | "projectId"
  | "selectedManagerOptionLabel"
  | "updateThreadPending"
>) {
  if (!parentThreadId && !canAssignToManager && !canTakeOverThread) {
    return null;
  }

  return (
    <DetailRow label="Manager" valueClassName="min-w-0">
      {parentThreadId ? (
        <div className="inline-flex max-w-full min-w-0 items-center gap-1 text-xs text-foreground">
          <Link
            to={`/projects/${projectId}/threads/${parentThreadId}`}
            className="min-w-0 truncate text-xs text-foreground no-underline transition-[text-decoration-color] duration-150 hover:underline hover:underline-offset-2"
          >
            {selectedManagerOptionLabel ?? "Manager"}
          </Link>
          <Button
            type="button"
            variant="ghost"
            size="icon"
            className="size-3.5 shrink-0 rounded-full p-0 text-muted-foreground hover:bg-transparent hover:text-foreground [&_svg]:size-3"
            disabled={updateThreadPending}
            onClick={() => {
              onAssignManager(null);
            }}
            aria-label="Unassign manager"
          >
            <X />
          </Button>
        </div>
      ) : (
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <div
              role="button"
              tabIndex={
                updateThreadPending ||
                (managerSelectorOptions.length <= 1 &&
                  managerSelectorValue === "none")
                  ? -1
                  : 0
              }
              className="inline-flex w-fit max-w-full min-w-0 items-center gap-1 rounded-md px-0 text-xs leading-tight text-foreground outline-none ring-sidebar-ring transition-colors hover:text-foreground focus-visible:ring-2"
            >
              <span className="min-w-0 truncate text-xs text-foreground">
                {selectedManagerOptionLabel ?? "None"}
              </span>
              <ChevronDown className="size-3.5 shrink-0 text-muted-foreground" />
            </div>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="start" className="min-w-40 max-w-72">
            {managerSelectorOptions.map((option) => (
              <DropdownMenuItem
                key={option.value}
                onSelect={() => {
                  onAssignManager(
                    option.value === "none" ? null : option.value,
                  );
                }}
                className="flex items-center justify-between gap-3"
              >
                <span className="truncate" title={option.label}>
                  {option.label}
                </span>
                <Check
                  className={
                    managerSelectorValue === option.value
                      ? cn("opacity-100", COARSE_POINTER_ICON_SIZE_CLASS)
                      : cn("opacity-0", COARSE_POINTER_ICON_SIZE_CLASS)
                  }
                />
              </DropdownMenuItem>
            ))}
          </DropdownMenuContent>
        </DropdownMenu>
      )}
    </DetailRow>
  );
}

function ThreadMetadataContent({
  canAssignToManager,
  canSelectMergeBase,
  canTakeOverThread,
  isLoadingMergeBaseBranchOptions,
  isManagerThread,
  managerSelectorOptions,
  managerSelectorValue,
  onAssignManager,
  onCopyThreadBranch,
  onMergeBaseBranchChange,
  onUnarchive,
  parentThreadId,
  projectId,
  selectedManagerOptionLabel,
  showThreadChangedFiles,
  showMergeBase,
  showWorkspaceStatus,
  thread,
  threadBranchName,
  threadEnvironmentModeLabel,
  threadEnvironmentType,
  threadEnvironmentValue,
  threadHostConnected,
  threadHostIsLocal,
  threadHostName,
  threadGitStatusDisplay,
  threadGitStatusLabelClass,
  mergeBaseBranch,
  mergeBaseCandidates,
  unarchivePending,
  updateThreadPending,
  onChangedFileClick,
  workspaceStatusFiles,
  workspaceStatusFilesLabel,
}: ThreadDetailMetadataProps) {
  return (
    <DetailCard
      className={cn(
        "h-full min-h-0 rounded-none border-0 bg-transparent px-0 py-0",
        showThreadChangedFiles ? "flex-1" : "shrink-0",
      )}
    >
      {isManagerThread ? (
        <DetailRow label="Kind" valueClassName="min-w-0 truncate">
          Manager
        </DetailRow>
      ) : null}
      {!isManagerThread ? (
        <ThreadManagerSelector
          canAssignToManager={canAssignToManager}
          canTakeOverThread={canTakeOverThread}
          managerSelectorOptions={managerSelectorOptions}
          managerSelectorValue={managerSelectorValue}
          onAssignManager={onAssignManager}
          parentThreadId={parentThreadId}
          projectId={projectId}
          selectedManagerOptionLabel={selectedManagerOptionLabel}
          updateThreadPending={updateThreadPending}
        />
      ) : null}
      {threadHostName ? (
        <DetailRow label="Host" valueClassName="min-w-0 truncate">
          <span className="flex items-center gap-1.5">
            <span className="truncate">{threadHostName}</span>
            {threadHostIsLocal ? <LocalhostBadge /> : null}
            {threadHostConnected !== undefined ? (
              <HostStatusBadge connected={threadHostConnected} />
            ) : null}
          </span>
        </DetailRow>
      ) : null}
      {!isManagerThread &&
      (threadEnvironmentModeLabel ?? threadEnvironmentType) ? (
        <DetailRow label="Environment" valueClassName="min-w-0 truncate">
          {threadEnvironmentModeLabel ??
            threadEnvironmentValue ??
            threadEnvironmentType}
        </DetailRow>
      ) : null}
      {!isManagerThread && threadBranchName ? (
        <DetailRow label="Branch" valueClassName="min-w-0 truncate">
          <button
            type="button"
            className="inline-flex max-w-full items-center gap-1.5 rounded-md text-left text-foreground transition-colors hover:text-foreground/80"
            onClick={onCopyThreadBranch}
            aria-label="Copy branch name"
            title="Copy branch name"
          >
            <span className="truncate">{threadBranchName}</span>
            <Copy className="size-3.5 shrink-0 text-muted-foreground" />
          </button>
        </DetailRow>
      ) : null}
      {!isManagerThread && showMergeBase ? (
        <DetailRow label="Merge base" valueClassName="min-w-0 truncate">
          {canSelectMergeBase && mergeBaseBranch ? (
            <MergeBaseBranchPicker
              value={mergeBaseBranch}
              options={mergeBaseCandidates}
              variant="minimal"
              loading={isLoadingMergeBaseBranchOptions}
              onChange={onMergeBaseBranchChange}
              className="max-w-full text-foreground"
            />
          ) : (
            mergeBaseBranch
          )}
        </DetailRow>
      ) : null}
      {showWorkspaceStatus ? (
        <DetailRow label="Git status" align="start" valueClassName="min-w-0">
          <div
            className="flex min-w-0 items-baseline gap-2 whitespace-nowrap"
            title={`${threadGitStatusDisplay.label} ${threadGitStatusDisplay.summary}`}
          >
            <span
              className={cn("shrink-0 font-medium", threadGitStatusLabelClass)}
            >
              {threadGitStatusDisplay.label}
            </span>
            <span className="min-w-0 truncate text-muted-foreground">
              {threadGitStatusDisplay.summaryContent}
            </span>
          </div>
        </DetailRow>
      ) : null}
      {thread.archivedAt != null ? (
        <DetailRow label="Archived" valueClassName="min-w-0 truncate">
          <ArchiveTimestampAction
            isPending={unarchivePending}
            onUnarchive={onUnarchive}
            threadType={thread.type}
          />
        </DetailRow>
      ) : null}
      {showThreadChangedFiles ? (
        <DetailRow
          label={workspaceStatusFilesLabel ?? "Changed files"}
          orientation="vertical"
          className="min-h-0 flex-1"
          valueClassName="min-h-0 flex-1"
        >
          <WorkspaceChangesList
            files={workspaceStatusFiles ?? []}
            maxHeightClassName="h-full"
            onFileClick={onChangedFileClick}
          />
        </DetailRow>
      ) : null}
    </DetailCard>
  );
}

function ThreadStorageContent({
  fileError,
  filePreview,
  files,
  isFileLoading,
  onTogglePath,
  selectedPath,
}: ThreadDetailThreadStorageProps) {
  if ((files?.length ?? 0) === 0) {
    return (
      <p className="rounded-lg border border-dashed border-border/70 bg-background/45 px-3 py-6 text-center text-sm text-muted-foreground">
        No files yet.
      </p>
    );
  }

  return (
    <div className="space-y-2">
      {files?.map((file) => {
        const isExpanded = selectedPath === file.path;

        return (
          <div
            key={file.path}
            className="overflow-hidden rounded-lg border border-border/70 bg-background/45"
          >
            <button
              type="button"
              className="flex w-full items-center gap-2 px-3 py-2 text-left transition-colors hover:bg-accent/20"
              onClick={() => {
                onTogglePath(file.path);
              }}
              aria-expanded={isExpanded}
            >
              {isExpanded ? (
                <ChevronDown className="size-3.5 shrink-0 text-muted-foreground" />
              ) : (
                <ChevronRight className="size-3.5 shrink-0 text-muted-foreground" />
              )}
              <span className="min-w-0 flex-1 truncate text-xs font-medium text-foreground">
                {file.path}
              </span>
            </button>
            {isExpanded ? (
              <div className="border-t border-border/70 px-3 py-3">
                {isFileLoading ? (
                  <p className="text-xs text-muted-foreground">
                    Loading file...
                  </p>
                ) : fileError ? (
                  <p className="text-xs text-destructive">
                    {fileError.message}
                  </p>
                ) : filePreview?.kind === "text" ? (
                  filePreview.content.length > 0 ? (
                    <pre className="overflow-auto whitespace-pre-wrap break-words font-mono text-xs text-foreground">
                      {filePreview.content}
                    </pre>
                  ) : (
                    <p className="text-xs text-muted-foreground">Empty file.</p>
                  )
                ) : filePreview?.kind === "image" ? (
                  <img
                    src={filePreview.url}
                    alt={filePreview.path}
                    className="max-h-96 w-auto max-w-full rounded-md border border-border/70 bg-background object-contain"
                  />
                ) : filePreview?.kind === "unsupported" ? (
                  <p className="text-xs text-muted-foreground">
                    Preview not available for {filePreview.mimeType}.
                  </p>
                ) : (
                  <p className="text-xs text-muted-foreground">
                    Select a thread storage file to view it.
                  </p>
                )}
              </div>
            ) : null}
          </div>
        );
      })}
    </div>
  );
}

export function ThreadDetailSecondaryContent({
  footer,
  header,
  threadStorage,
  metadata,
  secondaryPanel,
  showThreadMetadata,
  timeline,
}: ThreadDetailSecondaryContentProps) {
  const isMobile = useIsMobile();
  const isSecondaryPanelOpen = useIsSecondaryPanelOpen();
  const didResetOnMobileRef = useRef(false);

  useEffect(() => {
    if (!isMobile) {
      didResetOnMobileRef.current = false;
      return;
    }
    if (didResetOnMobileRef.current) return;
    didResetOnMobileRef.current = true;
    if (isSecondaryPanelOpen) {
      secondaryPanel.onClose();
    }
  }, [isMobile, isSecondaryPanelOpen, secondaryPanel]);

  const metadataContent = showThreadMetadata ? (
    <ThreadMetadataContent {...metadata} />
  ) : (
    <div className="pt-1 text-sm text-muted-foreground">
      No thread details available.
    </div>
  );
  const threadStorageContent = threadStorage ? (
    <ThreadStorageContent {...threadStorage} />
  ) : undefined;
  const desktopSecondaryPanelContent = !isMobile ? (
    <ThreadSecondaryPanel
      {...secondaryPanel}
      isMobile={false}
      metadataContent={metadataContent}
      threadStorageContent={threadStorageContent}
    />
  ) : null;
  const mobileSecondaryPanelContent = isMobile ? (
    <ThreadSecondaryPanel
      {...secondaryPanel}
      isMobile={true}
      metadataContent={metadataContent}
      threadStorageContent={threadStorageContent}
    />
  ) : null;

  return (
    <div className="-mx-4 -mb-4 -mt-4 flex h-full min-h-0 min-w-0 flex-1 flex-col overflow-hidden md:-mx-5 md:-mb-5 md:-mt-5">
      <PanelGroup
        direction="horizontal"
        className="h-full w-full min-w-0"
        autoSaveId="bb.thread.panelLayout"
      >
        <Panel
          id="thread-detail-timeline-panel"
          defaultSize={
            isSecondaryPanelOpen && !isMobile
              ? TIMELINE_PANEL_DEFAULT_SIZE_PERCENT
              : CLOSED_TIMELINE_PANEL_SIZE_PERCENT
          }
          minSize={30}
          order={1}
          className="min-w-0 overflow-hidden"
        >
          <ThreadTimelinePane {...timeline} footer={footer} header={header} />
        </Panel>
        {desktopSecondaryPanelContent}
      </PanelGroup>
      {isMobile ? (
        <ResponsiveDrawerShell
          open={isSecondaryPanelOpen}
          onOpenChange={(open) => {
            if (!open) secondaryPanel.onClose();
          }}
          srLabel="Thread details"
          contentClassName="h-[92dvh] max-h-[92dvh]"
        >
          <div className="flex min-h-0 flex-1 flex-col overflow-hidden">
            {mobileSecondaryPanelContent}
          </div>
        </ResponsiveDrawerShell>
      ) : null}
    </div>
  );
}
