import { useCallback, useEffect, useMemo, useState, type ReactNode } from "react";
import { ManagerThreadStorageBrowser } from "./ManagerThreadStorageBrowser";
import type { ManagerStorageBrowserController } from "./useManagerStorageBrowser";
import { Link } from "react-router-dom";
import { copyToClipboardWithToast } from "@/lib/clipboard";
import type {
  Environment,
  Host,
  Thread,
  ThreadListEntry,
  WorkspaceStatus,
} from "@bb/domain";
import { formatEnvironmentDisplay } from "@bb/core-ui";
import { cn } from "@/lib/utils";
import { HostStatusBadge } from "@/components/HostStatusIndicator";
import { Button } from "@/components/ui/button.js";
import { COARSE_POINTER_ICON_SIZE_CLASS } from "@/components/ui/coarse-pointer-sizing.js";
import { DetailCard, DetailRow } from "@/components/ui/detail-card.js";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuLabel, DropdownMenuTrigger } from "@/components/ui/dropdown-menu.js";
import { Icon } from "@/components/ui/icon.js";
import { LocalhostBadge } from "@/components/ui/localhost-badge.js";
import {
  BranchPicker,
  getMergeBaseBranchCandidates,
} from "@/components/pickers/BranchPicker";
import { ThreadUnarchiveButton } from "@/components/thread/ThreadUnarchiveButton";
import {
  WorkspaceChangesList,
  type WorkspaceChangedFile,
} from "@/components/thread/WorkspaceChangesList";
import { selectWorkspaceChangedFilesSection } from "@/components/workspace/workspace-change-summary";
import { getGitStatusDisplay } from "@/components/workspace/workspace-status";
import { useUnarchiveThread } from "../../hooks/mutations/thread-state-mutations";
import { buildManagerSelectorOptions } from "@/views/thread-detail/threadManagerSelectorOptions";

// ---------------------------------------------------------------------------
// Each row of the Info tab is a function component that owns its own raw
// inputs and derivation. ThreadMetadataContent is just a DetailCard wrapper
// that composes them. This shape lets per-row stories render exactly one row
// without bypassing the production rendering path.
// ---------------------------------------------------------------------------

export interface ManagerSelectorRowProps {
  thread: Thread;
  projectId: string;
  parentThreadDisplayName: string | null;
  managerThreads: readonly ThreadListEntry[];
  canAssignToManager: boolean;
  canTakeOverThread: boolean;
  updateThreadPending: boolean;
  onAssignManager: (parentThreadId: string | null) => void;
  /** Force the assignment dropdown open on first render. Used by stories. */
  defaultOpen?: boolean;
}

export function ManagerSelectorRow({
  thread,
  projectId,
  parentThreadDisplayName,
  managerThreads,
  canAssignToManager,
  canTakeOverThread,
  updateThreadPending,
  onAssignManager,
  defaultOpen,
}: ManagerSelectorRowProps) {
  const isManagerThread = thread.type === "manager";
  const parentThreadId = thread.parentThreadId ?? undefined;
  const managerSelectorOptions = useMemo(
    () =>
      buildManagerSelectorOptions({
        currentThreadId: thread.id,
        isManagerThread,
        managerThreads,
        parentThreadDisplayName,
        parentThreadId,
      }),
    [
      isManagerThread,
      managerThreads,
      parentThreadDisplayName,
      parentThreadId,
      thread.id,
    ],
  );
  const managerSelectorValue = parentThreadId ?? "none";
  const selectedManagerOptionLabel = managerSelectorOptions.find(
    (option) => option.value === managerSelectorValue,
  )?.label;

  if (isManagerThread) return null;
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
            <Icon name="X" />
          </Button>
        </div>
      ) : (
        <DropdownMenu defaultOpen={defaultOpen}>
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
              <Icon name="ChevronDown" className="size-3.5 shrink-0 text-muted-foreground" />
            </div>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="start" className="min-w-40 max-w-72">
            <DropdownMenuLabel>Assign to manager</DropdownMenuLabel>
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
                <Icon name="Check"
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

export function KindRow({ thread }: { thread: Thread }) {
  if (thread.type !== "manager") return null;
  return (
    <DetailRow label="Kind" valueClassName="min-w-0 truncate">
      Manager
    </DetailRow>
  );
}

export interface HostRowProps {
  environmentHost: Host | null;
  environment: Environment | null;
  environmentIsLocal: boolean;
}

export function HostRow({
  environmentHost,
  environment,
  environmentIsLocal,
}: HostRowProps) {
  if (!environmentHost) return null;
  const threadHostIsLocal = environment ? environmentIsLocal : undefined;
  const threadHostConnected = environmentHost.status === "connected";

  return (
    <DetailRow label="Host" valueClassName="min-w-0 truncate">
      <span className="flex items-center gap-1.5">
        <span className="truncate">{environmentHost.name}</span>
        {threadHostIsLocal ? <LocalhostBadge /> : null}
        <HostStatusBadge connected={threadHostConnected} />
      </span>
    </DetailRow>
  );
}

export interface EnvironmentRowProps {
  thread: Thread;
  environment: Environment | null;
  environmentHost: Host | null;
  environmentIsLocal: boolean;
}

export function EnvironmentRow({
  thread,
  environment,
  environmentHost,
  environmentIsLocal,
}: EnvironmentRowProps) {
  if (thread.type === "manager") return null;
  if (!environment) return null;
  const display = formatEnvironmentDisplay({
    environment,
    isLocalHost: environmentIsLocal,
    hostName: environmentHost?.name,
    hostType: environmentHost?.type,
    hostProvider: environmentHost?.provider,
  });
  return (
    <DetailRow label="Environment" valueClassName="min-w-0 truncate">
      {display.modeLabel}
    </DetailRow>
  );
}

export interface BranchRowProps {
  thread: Thread;
  workspaceStatus: WorkspaceStatus | undefined;
}

export function BranchRow({ thread, workspaceStatus }: BranchRowProps) {
  const branchName = workspaceStatus?.branch.currentBranch ?? null;
  const [copied, setCopied] = useState(false);
  useEffect(() => {
    if (!copied) return;
    const timeoutId = window.setTimeout(() => {
      setCopied(false);
    }, 2000);
    return () => window.clearTimeout(timeoutId);
  }, [copied]);
  const onCopyClick = useCallback(async () => {
    if (!branchName) return;
    const success = await copyToClipboardWithToast(branchName, {
      successMessage: "Branch name copied",
      errorMessage: "Failed to copy branch name",
    });
    if (success) setCopied(true);
  }, [branchName]);
  if (thread.type === "manager") return null;
  if (!branchName) return null;
  return (
    <DetailRow label="Branch" valueClassName="min-w-0 truncate">
      <button
        type="button"
        className="inline-flex max-w-full items-center gap-1.5 rounded-md text-left text-foreground transition-colors hover:text-foreground/80"
        onClick={() => {
          void onCopyClick();
        }}
        aria-label="Copy branch name"
        title="Copy branch name"
      >
        <span className="truncate">{branchName}</span>
        {copied ? (
          <Icon name="Check" className="size-3.5 shrink-0 text-muted-foreground" />
        ) : (
          <Icon name="Copy" className="size-3.5 shrink-0 text-muted-foreground" />
        )}
      </button>
    </DetailRow>
  );
}

export interface MergeBaseRowProps {
  thread: Thread;
  workspaceStatus: WorkspaceStatus | undefined;
  selectedMergeBaseBranch: string | undefined;
  mergeBaseBranchOptions: readonly string[] | undefined;
  isLoadingMergeBaseBranchOptions: boolean;
  onMergeBaseBranchChange: (branch: string) => void;
  /** Force the BranchPicker popover open on first render. Used by stories. */
  defaultOpen?: boolean;
}

export function MergeBaseRow({
  thread,
  workspaceStatus,
  selectedMergeBaseBranch,
  mergeBaseBranchOptions,
  isLoadingMergeBaseBranchOptions,
  onMergeBaseBranchChange,
  defaultOpen,
}: MergeBaseRowProps) {
  const effectiveMergeBaseBranch =
    selectedMergeBaseBranch ??
    workspaceStatus?.mergeBase?.mergeBaseBranch ??
    workspaceStatus?.branch.defaultBranch;
  const mergeBaseBranch = effectiveMergeBaseBranch;
  const mergeBaseCandidates = useMemo(
    () =>
      getMergeBaseBranchCandidates({
        mergeBaseBranch,
        mergeBaseBranchOptions,
      }),
    [mergeBaseBranch, mergeBaseBranchOptions],
  );
  const showBranchComparisonUi = Boolean(
    effectiveMergeBaseBranch || workspaceStatus?.branch.defaultBranch,
  );
  const isOnDefaultBranch =
    workspaceStatus?.branch.currentBranch != null &&
    workspaceStatus.branch.currentBranch ===
      workspaceStatus.branch.defaultBranch;
  const showMergeBase =
    showBranchComparisonUi && Boolean(mergeBaseBranch) && !isOnDefaultBranch;
  if (thread.type === "manager") return null;
  if (!showMergeBase) return null;
  const canSelectMergeBase = Boolean(
    mergeBaseBranch && mergeBaseCandidates.length > 0,
  );

  return (
    <DetailRow label="Merge base" valueClassName="min-w-0 truncate">
      {canSelectMergeBase && mergeBaseBranch ? (
        <BranchPicker
          value={mergeBaseBranch}
          options={mergeBaseCandidates}
          variant="minimal"
          loading={isLoadingMergeBaseBranchOptions}
          onChange={onMergeBaseBranchChange}
          className="max-w-full"
          defaultOpen={defaultOpen}
        />
      ) : (
        mergeBaseBranch
      )}
    </DetailRow>
  );
}

export interface GitStatusRowProps {
  thread: Thread;
  environment: Environment | null;
  workspaceStatus: WorkspaceStatus | undefined;
  workspaceStatusError: Error | null;
  selectedMergeBaseBranch: string | undefined;
}

export function GitStatusRow({
  thread,
  environment,
  workspaceStatus,
  workspaceStatusError,
  selectedMergeBaseBranch,
}: GitStatusRowProps) {
  const isManagerThread = thread.type === "manager";
  const canUseGitUi = !isManagerThread;
  const isWorkspaceDeleted = environment?.status === "destroyed";
  const showWorkspaceStatus =
    canUseGitUi &&
    (Boolean(workspaceStatus) ||
      Boolean(workspaceStatusError) ||
      isWorkspaceDeleted) &&
    !(thread.archivedAt != null && environment?.managed !== true);
  if (!showWorkspaceStatus) return null;

  const effectiveMergeBaseBranch =
    selectedMergeBaseBranch ??
    workspaceStatus?.mergeBase?.mergeBaseBranch ??
    workspaceStatus?.branch.defaultBranch;
  const showBranchComparisonUi = Boolean(
    effectiveMergeBaseBranch || workspaceStatus?.branch.defaultBranch,
  );
  const display = getGitStatusDisplay(workspaceStatus, {
    mergeBaseBranch: effectiveMergeBaseBranch,
    showBranchComparison: showBranchComparisonUi,
    error: workspaceStatusError,
    workspaceDeleted: isWorkspaceDeleted,
  });
  const labelClass =
    workspaceStatus?.workingTree.state === "untracked"
      ? "text-muted-foreground"
      : "text-foreground";

  return (
    <DetailRow label="Git status" align="start" valueClassName="min-w-0">
      <div
        className="flex min-w-0 items-baseline gap-2 whitespace-nowrap"
        title={`${display.label} ${display.summary}`}
      >
        <span className={cn("shrink-0 font-medium", labelClass)}>
          {display.label}
        </span>
        <span className="min-w-0 truncate text-muted-foreground">
          {display.summaryContent}
        </span>
      </div>
    </DetailRow>
  );
}

export interface ArchivedRowProps {
  thread: Thread;
}

export function ArchivedRow({ thread }: ArchivedRowProps) {
  const unarchiveThread = useUnarchiveThread();
  const isPending =
    unarchiveThread.isPending && unarchiveThread.variables?.id === thread.id;
  const onUnarchive = useCallback(() => {
    unarchiveThread.mutate({ id: thread.id });
  }, [thread.id, unarchiveThread]);
  if (thread.archivedAt == null) return null;
  return (
    <DetailRow label="Archived" valueClassName="min-w-0 truncate">
      <ThreadUnarchiveButton
        isPending={isPending}
        onUnarchive={onUnarchive}
        threadType={thread.type}
      />
    </DetailRow>
  );
}

export interface ChangedFilesRowProps {
  thread: Thread;
  workspaceStatus: WorkspaceStatus | undefined;
  onChangedFileClick?: (file: WorkspaceChangedFile) => void;
}

export function ChangedFilesRow({
  thread,
  workspaceStatus,
  onChangedFileClick,
}: ChangedFilesRowProps) {
  const canUseGitUi = thread.type !== "manager";
  const section = selectWorkspaceChangedFilesSection(workspaceStatus);
  if (!canUseGitUi || section === null) return null;
  return (
    <DetailRow
      label={section.label ?? "Changed files"}
      orientation="vertical"
      className="min-h-0 flex-1"
      valueClassName="min-h-0 flex-1"
    >
      <WorkspaceChangesList
        files={section.files}
        maxHeightClassName="h-full"
        onFileClick={onChangedFileClick}
      />
    </DetailRow>
  );
}

export interface ManagerWorkspaceRowProps {
  controller: ManagerStorageBrowserController;
  filesError?: Error | null;
  isFilesLoading: boolean;
}

export function ManagerWorkspaceRow({
  controller,
  filesError,
  isFilesLoading,
}: ManagerWorkspaceRowProps) {
  const { isSearchOpen, openSearch } = controller;
  return (
    <DetailRow
      orientation="vertical"
      className="min-h-0 flex-1"
      valueClassName="min-h-0 flex-1 overflow-hidden"
      labelClassName="flex items-center justify-between gap-2"
      label={
        <>
          <span>Manager workspace</span>
          {isSearchOpen ? null : (
            <Button
              type="button"
              variant="ghost"
              size="icon"
              className="h-5 w-5 shrink-0 rounded-md p-0 text-muted-foreground"
              aria-label="Search files"
              onClick={openSearch}
            >
              <Icon name="Search" className="size-3.5" />
            </Button>
          )}
        </>
      }
    >
      <ManagerThreadStorageBrowser
        controller={controller}
        filesError={filesError}
        isFilesLoading={isFilesLoading}
      />
    </DetailRow>
  );
}

// ---------------------------------------------------------------------------
// Composition + helper
// ---------------------------------------------------------------------------

export interface ThreadMetadataContentProps {
  thread: Thread;
  projectId: string;
  parentThreadDisplayName: string | null;
  managerThreads: readonly ThreadListEntry[];
  canAssignToManager: boolean;
  canTakeOverThread: boolean;
  environmentHost: Host | null;
  environmentIsLocal: boolean;
  environment: Environment | null;
  workspaceStatus: WorkspaceStatus | undefined;
  workspaceStatusError: Error | null;
  selectedMergeBaseBranch: string | undefined;
  mergeBaseBranchOptions: readonly string[] | undefined;
  isLoadingMergeBaseBranchOptions: boolean;
  updateThreadPending: boolean;
  storage?: ManagerWorkspaceRowProps;
  onAssignManager: (parentThreadId: string | null) => void;
  onMergeBaseBranchChange: (branch: string) => void;
  onChangedFileClick?: (file: WorkspaceChangedFile) => void;
}

/**
 * Returns true when the rendered card would have at least one row to show.
 * The caller can use this to decide between rendering the card and rendering
 * its "no thread details available" fallback.
 */
export function hasAnyThreadMetadata({
  thread,
  parentThreadDisplayName,
  environment,
  workspaceStatus,
  workspaceStatusError,
}: Pick<
  ThreadMetadataContentProps,
  | "thread"
  | "parentThreadDisplayName"
  | "environment"
  | "workspaceStatus"
  | "workspaceStatusError"
>): boolean {
  const isManagerThread = thread.type === "manager";
  const parentThreadId = thread.parentThreadId ?? undefined;
  const canUseGitUi = !isManagerThread;
  const isWorkspaceDeleted = environment?.status === "destroyed";
  const showWorkspaceStatus =
    canUseGitUi &&
    (Boolean(workspaceStatus) ||
      Boolean(workspaceStatusError) ||
      isWorkspaceDeleted) &&
    !(thread.archivedAt != null && environment?.managed !== true);
  const branchName = workspaceStatus?.branch.currentBranch ?? null;
  const workspaceChangedFilesSection =
    selectWorkspaceChangedFilesSection(workspaceStatus);
  const showThreadChangedFiles =
    canUseGitUi && workspaceChangedFilesSection !== null;

  return Boolean(
    isManagerThread ||
      parentThreadId ||
      (!isManagerThread && environment) ||
      (!isManagerThread && branchName) ||
      showWorkspaceStatus ||
      showThreadChangedFiles ||
      thread.archivedAt != null ||
      (parentThreadDisplayName && parentThreadId),
  );
}

interface DetailCardWrapperProps {
  hasFlexibleHeight: boolean;
  children: ReactNode;
}

/**
 * Shared DetailCard styling used by ThreadMetadataContent and the per-row
 * stories so a single row in isolation looks the same as it does inside the
 * full panel.
 */
export function ThreadMetadataCard({
  hasFlexibleHeight,
  children,
}: DetailCardWrapperProps) {
  return (
    <DetailCard
      className={cn(
        "h-full min-h-0 rounded-none border-0 bg-transparent px-0 py-0",
        hasFlexibleHeight ? "flex-1" : "shrink-0",
      )}
    >
      {children}
    </DetailCard>
  );
}

export function ThreadMetadataContent(props: ThreadMetadataContentProps) {
  const {
    thread,
    projectId,
    parentThreadDisplayName,
    managerThreads,
    canAssignToManager,
    canTakeOverThread,
    environmentHost,
    environmentIsLocal,
    environment,
    workspaceStatus,
    workspaceStatusError,
    selectedMergeBaseBranch,
    mergeBaseBranchOptions,
    isLoadingMergeBaseBranchOptions,
    updateThreadPending,
    storage,
    onAssignManager,
    onMergeBaseBranchChange,
    onChangedFileClick,
  } = props;

  const hasFlexibleHeight =
    storage !== undefined ||
    (thread.type !== "manager" &&
      selectWorkspaceChangedFilesSection(workspaceStatus) !== null);

  return (
    <ThreadMetadataCard hasFlexibleHeight={hasFlexibleHeight}>
      <KindRow thread={thread} />
      <ManagerSelectorRow
        thread={thread}
        projectId={projectId}
        parentThreadDisplayName={parentThreadDisplayName}
        managerThreads={managerThreads}
        canAssignToManager={canAssignToManager}
        canTakeOverThread={canTakeOverThread}
        updateThreadPending={updateThreadPending}
        onAssignManager={onAssignManager}
      />
      <HostRow
        environmentHost={environmentHost}
        environment={environment}
        environmentIsLocal={environmentIsLocal}
      />
      <EnvironmentRow
        thread={thread}
        environment={environment}
        environmentHost={environmentHost}
        environmentIsLocal={environmentIsLocal}
      />
      <BranchRow thread={thread} workspaceStatus={workspaceStatus} />
      <MergeBaseRow
        thread={thread}
        workspaceStatus={workspaceStatus}
        selectedMergeBaseBranch={selectedMergeBaseBranch}
        mergeBaseBranchOptions={mergeBaseBranchOptions}
        isLoadingMergeBaseBranchOptions={isLoadingMergeBaseBranchOptions}
        onMergeBaseBranchChange={onMergeBaseBranchChange}
      />
      <GitStatusRow
        thread={thread}
        environment={environment}
        workspaceStatus={workspaceStatus}
        workspaceStatusError={workspaceStatusError}
        selectedMergeBaseBranch={selectedMergeBaseBranch}
      />
      <ArchivedRow thread={thread} />
      <ChangedFilesRow
        thread={thread}
        workspaceStatus={workspaceStatus}
        onChangedFileClick={onChangedFileClick}
      />
      {storage ? <ManagerWorkspaceRow {...storage} /> : null}
    </ThreadMetadataCard>
  );
}
