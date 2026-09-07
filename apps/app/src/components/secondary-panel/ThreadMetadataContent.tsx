import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  type ReactNode,
  type UIEvent,
} from "react";
import { ThreadStorageBrowser } from "./ThreadStorageBrowser";
import type { ThreadStorageBrowserController } from "./useThreadStorageBrowser";
import { Link } from "react-router-dom";
import type {
  Environment,
  GitBranchRefClassification,
  Thread,
  ThreadListEntry,
  ThreadPullRequest,
  WorkspaceCommitSummary,
  WorkspaceStatus,
} from "@bb/domain";
import type { WorkspaceResolutionFailure } from "@bb/host-daemon-contract";
import {
  formatEnvironmentDisplay,
  type EnvironmentDisplayHostContext,
} from "@bb/core-ui";
import { cn } from "@bb/shared-ui/lib/utils";
import { copyToClipboardWithToast } from "@/lib/clipboard";
import { getEnvironmentWorkspaceLabelIconName } from "@/lib/environment-workspace-display";
import { formatWorkspaceCheckoutDisplay } from "@/lib/workspace-checkout-display";
import { Button } from "@bb/shared-ui/button";
import {
  COARSE_POINTER_COMPACT_ICON_BUTTON_CLASS,
  COARSE_POINTER_TEXT_SM_CLASS,
} from "@bb/shared-ui/coarse-pointer-sizing";
import { CopyableInlineLabel } from "@/components/ui/copy-button.js";
import { TruncatedList } from "@/components/ui/truncated-list.js";
import {
  DetailCard,
  DetailRow,
  DetailRowIconLabel,
} from "@/components/ui/detail-card.js";
import { CHROME_SECTION_LABEL_CLASS } from "@bb/shared-ui/chrome-style-tokens";
import { useCreateThreadInWorktree } from "@/hooks/useCreateThreadInWorktree";
import { Icon } from "@bb/shared-ui/icon";
import { Tooltip, TooltipContent, TooltipTrigger } from "@bb/shared-ui/tooltip";
import {
  BranchPicker,
  getMergeBaseBranchCandidateGroups,
} from "@/components/pickers/BranchPicker";
import { ThreadUnarchiveButton } from "@/components/thread/ThreadUnarchiveButton";
import { ChangedFilesDetailRow } from "@/components/workspace/ChangedFilesDetailRow";
import {
  selectWorkspaceAheadCommits,
  selectWorkspaceChangedFilesSections,
  type WorkspaceChangedFileSelection,
} from "@/components/workspace/workspace-change-summary";
import { getGitStatusDisplay } from "@/components/workspace/workspace-status";
import { useUnarchiveThread } from "../../hooks/mutations/thread-state-mutations";
import { useThreads } from "@/hooks/queries/thread-queries";
import { buildParentSelectorOptions } from "@/views/thread-detail/threadParentSelectorOptions";
import { getThreadRoutePath } from "@/lib/route-paths";
import { getThreadDisplayTitle } from "@/lib/thread-title";
import {
  PULL_REQUEST_STATE_DISPLAY,
  getPullRequestAttentionDisplay,
  getPullRequestChecksDisplay,
  getPullRequestMergeabilityDisplay,
  getPullRequestReviewDisplay,
} from "@/lib/pull-request-display";
import {
  PullRequestGithubCheckIcon,
  PullRequestStateIcon,
} from "@/components/pull-request/PullRequestStatusPill";
import { GithubFaviconIcon } from "@/components/pull-request/GithubFaviconIcon";
import { useUrlAnchorClickHandler } from "@/lib/url-open-routing";
import { ParentThreadPicker } from "@/components/pickers/ParentThreadPicker";

interface ParentSelectorRowProps {
  thread: Thread;
  projectId: string;
  parentThreadProjectId: string | null;
  parentThreadDisplayName: string | null;
  parentThreads: readonly ThreadListEntry[];
  canAssignToParent: boolean;
  canTakeOverThread: boolean;
  isLoadingParentThreads: boolean;
  isParentThreadsError: boolean;
  updateThreadPending: boolean;
  onAssignParent: (parentThreadId: string | null) => void;
  onParentSelectorOpenChange: (open: boolean) => void;
  onRetryParentThreads: () => void;
  defaultOpen?: boolean;
}

export function ParentSelectorRow({
  thread,
  projectId,
  parentThreadProjectId,
  parentThreadDisplayName,
  parentThreads,
  canAssignToParent,
  canTakeOverThread,
  isLoadingParentThreads,
  isParentThreadsError,
  updateThreadPending,
  onAssignParent,
  onParentSelectorOpenChange,
  onRetryParentThreads,
  defaultOpen,
}: ParentSelectorRowProps) {
  const parentThreadId = thread.parentThreadId ?? undefined;
  const parentSelectorOptions = useMemo(
    () =>
      buildParentSelectorOptions({
        currentThreadId: thread.id,
        parentThreads,
        parentThreadDisplayName,
        parentThreadId,
      }),
    [parentThreads, parentThreadDisplayName, parentThreadId, thread.id],
  );
  const parentSelectorValue = parentThreadId ?? "none";
  const selectedParentOptionLabel = parentSelectorOptions.find(
    (option) => option.value === parentSelectorValue,
  )?.label;

  if (!parentThreadId && !canAssignToParent && !canTakeOverThread) {
    return null;
  }

  return (
    <DetailRow
      label={<DetailRowIconLabel icon="UserRound">Parent</DetailRowIconLabel>}
      valueClassName="min-w-0"
    >
      {parentThreadId ? (
        <div
          className={cn(
            "inline-flex max-w-full min-w-0 items-center gap-1 text-foreground",
            COARSE_POINTER_TEXT_SM_CLASS,
          )}
        >
          <Link
            to={getThreadRoutePath({
              projectId: parentThreadProjectId ?? projectId,
              threadId: parentThreadId,
            })}
            className={cn(
              "min-w-0 truncate text-foreground no-underline transition-[text-decoration-color] duration-150 hover:underline hover:underline-offset-2",
              COARSE_POINTER_TEXT_SM_CLASS,
            )}
          >
            {selectedParentOptionLabel ?? "Parent thread"}
          </Link>
          <Button
            type="button"
            variant="ghost"
            size="icon"
            className="size-3.5 shrink-0 rounded-full p-0 text-muted-foreground hover:bg-transparent hover:text-foreground [&_svg]:size-3 max-md:pointer-coarse:h-9 max-md:pointer-coarse:w-9 max-md:pointer-coarse:[&_svg]:size-5"
            disabled={updateThreadPending}
            onClick={() => {
              onAssignParent(null);
            }}
            aria-label="Clear parent thread"
          >
            <Icon name="X" />
          </Button>
        </div>
      ) : (
        <ParentThreadPicker
          value={parentSelectorValue}
          options={parentSelectorOptions}
          isLoading={isLoadingParentThreads}
          isError={isParentThreadsError}
          disabled={updateThreadPending}
          onChange={(value) => {
            onAssignParent(value === "none" ? null : value);
          }}
          onOpenChange={onParentSelectorOpenChange}
          onRetry={onRetryParentThreads}
          defaultOpen={defaultOpen}
        />
      )}
    </DetailRow>
  );
}

interface ForksRowProps {
  thread: Thread;
  projectId: string;
}

function ForksRow({ thread, projectId }: ForksRowProps) {
  const forksQuery = useThreads({
    projectId: thread.projectId,
    sourceThreadId: thread.id,
    originKind: "fork",
    archived: false,
  });
  const forks = forksQuery.data ?? [];
  if (forks.length === 0) {
    return null;
  }

  return (
    <DetailRow label="Forks" align="start" valueClassName="min-w-0">
      <TruncatedList
        items={forks}
        getKey={(fork) => fork.id}
        renderItem={(fork) => (
          <Link
            to={getThreadRoutePath({ projectId, threadId: fork.id })}
            className="block min-w-0 truncate text-xs text-foreground no-underline transition-[text-decoration-color] duration-150 hover:underline hover:underline-offset-2"
            title={getThreadDisplayTitle(fork)}
          >
            {getThreadDisplayTitle(fork)}
          </Link>
        )}
      />
    </DetailRow>
  );
}

interface EnvironmentRowProps {
  thread: Thread;
  environment: Environment | null;
  environmentDisplayHost: EnvironmentDisplayHostContext;
}

export function EnvironmentRow({
  thread,
  environment,
  environmentDisplayHost,
}: EnvironmentRowProps) {
  const createThreadInWorktree = useCreateThreadInWorktree({
    projectId: thread.projectId,
    environmentId: environment?.id ?? "",
  });
  if (!environment) return null;
  const display = formatEnvironmentDisplay({
    environment,
    host: environmentDisplayHost,
  });
  const showCreateThreadButton = isProvisionedWorktreeEnvironment(environment);
  return (
    <DetailRow
      label={
        <DetailRowIconLabel
          icon={getEnvironmentWorkspaceLabelIconName(
            display.workspaceDisplayKind,
          )}
        >
          Environment
        </DetailRowIconLabel>
      }
      valueClassName="min-w-0"
    >
      <span className="flex min-w-0 items-center gap-1">
        <span className="min-w-0 truncate" title={display.modeLabel}>
          {display.compactModeLabel}
        </span>
        {environmentDisplayHost.identity ? (
          <span
            className="min-w-0 shrink-0 truncate text-muted-foreground"
            title={`On ${environmentDisplayHost.identity.name} (${
              environmentDisplayHost.identity.connected
                ? "connected"
                : "offline"
            })`}
          >
            · {environmentDisplayHost.identity.name}
            {environmentDisplayHost.identity.connected ? "" : " (offline)"}
          </span>
        ) : null}
        {showCreateThreadButton ? (
          <Tooltip>
            <TooltipTrigger asChild>
              <button
                type="button"
                aria-label="Create thread in worktree"
                onClick={createThreadInWorktree}
                className="inline-flex shrink-0 items-center justify-center rounded-md p-0.5 text-muted-foreground transition-colors hover:bg-state-hover hover:text-foreground"
              >
                <Icon name="MessageSquarePlus" className="size-4" />
              </button>
            </TooltipTrigger>
            <TooltipContent>Create thread in worktree</TooltipContent>
          </Tooltip>
        ) : null}
      </span>
    </DetailRow>
  );
}

interface WorkspacePathRowProps {
  environment: Environment | null;
}

function isWorktreeEnvironment(environment: Environment): boolean {
  return (
    environment.isWorktree ||
    environment.workspaceProvisionType === "managed-worktree"
  );
}

function isProvisionedWorktreeEnvironment(environment: Environment): boolean {
  return (
    environment.status === "ready" &&
    environment.path !== null &&
    isWorktreeEnvironment(environment)
  );
}

export function WorkspacePathRow({ environment }: WorkspacePathRowProps) {
  if (!environment?.path) return null;

  return (
    <DetailRow
      label={<DetailRowIconLabel icon="Folder">Directory</DetailRowIconLabel>}
      valueClassName="min-w-0"
    >
      <CopyableInlineLabel
        text={environment.path}
        label="Copy directory"
        title={environment.path}
        successMessage="Directory copied"
        errorMessage="Failed to copy directory"
      />
    </DetailRow>
  );
}

interface BranchRowProps {
  workspaceStatus: WorkspaceStatus | undefined;
}

export function BranchRow({ workspaceStatus }: BranchRowProps) {
  const checkoutDisplay = workspaceStatus
    ? formatWorkspaceCheckoutDisplay({ checkout: workspaceStatus.checkout })
    : null;
  if (checkoutDisplay === null) return null;
  return (
    <DetailRow
      label={
        <DetailRowIconLabel icon="GitBranch">
          {checkoutDisplay.rowLabel}
        </DetailRowIconLabel>
      }
      valueClassName="min-w-0 truncate"
    >
      {checkoutDisplay.copyValue !== null ? (
        <CopyableInlineLabel
          text={checkoutDisplay.copyValue}
          label={checkoutDisplay.copyLabel ?? "Copy checkout value"}
          title={checkoutDisplay.title}
          successMessage={checkoutDisplay.copySuccessMessage ?? "Value copied"}
          errorMessage={
            checkoutDisplay.copyErrorMessage ?? "Failed to copy value"
          }
        >
          {checkoutDisplay.label}
        </CopyableInlineLabel>
      ) : (
        <span className="block truncate" title={checkoutDisplay.title}>
          {checkoutDisplay.label}
        </span>
      )}
    </DetailRow>
  );
}

interface PullRequestRowProps {
  pullRequest: ThreadPullRequest | null;
}

export function PullRequestRow({ pullRequest }: PullRequestRowProps) {
  const handlePullRequestClick = useUrlAnchorClickHandler(pullRequest?.url);
  if (!pullRequest) return null;
  const stateDisplay = PULL_REQUEST_STATE_DISPLAY[pullRequest.state];
  const attentionDisplay = getPullRequestAttentionDisplay(pullRequest);
  const checksDisplay = getPullRequestChecksDisplay(pullRequest);
  const showGithubCheckIcon =
    (pullRequest.state === "open" || pullRequest.state === "draft") &&
    (pullRequest.checks.state === "passing" ||
      pullRequest.checks.state === "failing" ||
      pullRequest.checks.state === "pending");
  const canShowChecksStatus =
    (pullRequest.state === "open" || pullRequest.state === "draft") &&
    pullRequest.checks.state !== "no_checks" &&
    pullRequest.checks.state !== "unknown";
  const statusDisplay =
    pullRequest.attention === "changes_requested" ||
    pullRequest.attention === "review_requested"
      ? getPullRequestReviewDisplay(pullRequest)
      : pullRequest.attention === "conflicts" ||
          pullRequest.attention === "blocked"
        ? getPullRequestMergeabilityDisplay(pullRequest)
        : attentionDisplay.label !== stateDisplay.label
          ? attentionDisplay
          : canShowChecksStatus
            ? checksDisplay
            : null;
  const useNeutralStatusText =
    pullRequest.attention === "ready_to_merge" ||
    pullRequest.attention === "checks_pending" ||
    ((pullRequest.state === "open" || pullRequest.state === "draft") &&
      (pullRequest.checks.state === "passing" ||
        pullRequest.checks.state === "pending") &&
      (pullRequest.attention === "none" || pullRequest.attention === "draft"));
  const statusTextClassName = useNeutralStatusText
    ? "text-foreground"
    : statusDisplay?.className;
  return (
    <DetailRow
      label={
        <DetailRowIconLabel icon="GitPullRequestArrow">
          Pull request
        </DetailRowIconLabel>
      }
      valueClassName="min-w-0"
    >
      <a
        href={pullRequest.url}
        target="_blank"
        rel="noopener noreferrer"
        onClick={handlePullRequestClick}
        aria-label={`Pull request ${pullRequest.number}: ${attentionDisplay.label}`}
        className="flex h-5 max-w-full min-w-0 items-center gap-2 text-xs text-foreground no-underline transition-opacity hover:opacity-80 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
      >
        {showGithubCheckIcon ? (
          <PullRequestGithubCheckIcon pullRequest={pullRequest} />
        ) : (
          <GithubFaviconIcon />
        )}
        <span className="shrink-0 text-muted-foreground">
          #{pullRequest.number}
        </span>
        <span className="inline-flex h-5 shrink-0 items-center gap-1.5 rounded-full border border-border bg-background px-1.5 text-muted-foreground">
          <PullRequestStateIcon
            state={pullRequest.state}
            className="size-3.5"
          />
          <span>{stateDisplay.label}</span>
        </span>
        {statusDisplay ? (
          <span className={cn("min-w-0 truncate", statusTextClassName)}>
            {statusDisplay.label}
          </span>
        ) : null}
      </a>
    </DetailRow>
  );
}

interface MergeBaseRowProps {
  workspaceStatus: WorkspaceStatus | undefined;
  selectedMergeBaseBranch: string | undefined;
  mergeBaseBranchRef?: GitBranchRefClassification | null;
  mergeBaseBranchOptions: readonly string[] | undefined;
  mergeBaseRemoteBranchOptions?: readonly string[];
  isLoadingMergeBaseBranchOptions: boolean;
  onMergeBaseBranchChange: (branch: string) => void;
  onMergeBasePickerOpenChange?: (open: boolean) => void;
  onMergeBaseBranchSearchQueryChange?: (query: string) => void;
  defaultOpen?: boolean;
}

export function MergeBaseRow({
  workspaceStatus,
  selectedMergeBaseBranch,
  mergeBaseBranchRef,
  mergeBaseBranchOptions,
  mergeBaseRemoteBranchOptions,
  isLoadingMergeBaseBranchOptions,
  onMergeBaseBranchChange,
  onMergeBasePickerOpenChange,
  onMergeBaseBranchSearchQueryChange,
  defaultOpen,
}: MergeBaseRowProps) {
  const effectiveMergeBaseBranch =
    selectedMergeBaseBranch ??
    workspaceStatus?.mergeBase?.mergeBaseBranch ??
    workspaceStatus?.branch.defaultBranch;
  const mergeBaseBranch = effectiveMergeBaseBranch;
  const mergeBaseCandidateGroups = useMemo(
    () =>
      getMergeBaseBranchCandidateGroups({
        mergeBaseBranch,
        mergeBaseBranchRef,
        mergeBaseBranchOptions,
        remoteMergeBaseBranchOptions: mergeBaseRemoteBranchOptions,
      }),
    [
      mergeBaseBranch,
      mergeBaseBranchOptions,
      mergeBaseBranchRef,
      mergeBaseRemoteBranchOptions,
    ],
  );
  const mergeBaseCandidates = mergeBaseCandidateGroups.options;
  const remoteMergeBaseCandidates = mergeBaseCandidateGroups.remoteOptions;
  const showBranchComparisonUi = Boolean(
    effectiveMergeBaseBranch || workspaceStatus?.branch.defaultBranch,
  );
  const isOnDefaultBranch =
    workspaceStatus?.branch.currentBranch != null &&
    workspaceStatus.branch.currentBranch ===
      workspaceStatus.branch.defaultBranch;
  const showMergeBase =
    showBranchComparisonUi && Boolean(mergeBaseBranch) && !isOnDefaultBranch;
  if (!showMergeBase) return null;
  const canRequestMergeBaseOptions =
    mergeBaseBranchOptions === undefined &&
    onMergeBasePickerOpenChange !== undefined;
  const canSelectMergeBase = Boolean(
    mergeBaseBranch &&
    (canRequestMergeBaseOptions ||
      isLoadingMergeBaseBranchOptions ||
      mergeBaseCandidates.length > 0 ||
      remoteMergeBaseCandidates.length > 0),
  );

  return (
    <DetailRow
      label={
        <DetailRowIconLabel icon="GitMerge">Merge base</DetailRowIconLabel>
      }
      valueClassName="min-w-0"
    >
      {canSelectMergeBase && mergeBaseBranch ? (
        <BranchPicker
          value={mergeBaseBranch}
          options={mergeBaseCandidates}
          remoteOptions={remoteMergeBaseCandidates}
          variant="minimal"
          emphasizeTriggerValue={false}
          loading={
            isLoadingMergeBaseBranchOptions || canRequestMergeBaseOptions
          }
          onChange={onMergeBaseBranchChange}
          onOpenChange={onMergeBasePickerOpenChange}
          onSearchQueryChange={onMergeBaseBranchSearchQueryChange}
          className="max-w-full"
          defaultOpen={defaultOpen}
        />
      ) : (
        mergeBaseBranch
      )}
    </DetailRow>
  );
}

interface GitStatusRowProps {
  thread: Thread;
  environment: Environment | null;
  workspaceStatus: WorkspaceStatus | undefined;
  workspaceStatusError: Error | null;
  workspaceUnavailable?: WorkspaceResolutionFailure;
  selectedMergeBaseBranch: string | undefined;
}

export function GitStatusRow({
  thread,
  environment,
  workspaceStatus,
  workspaceStatusError,
  workspaceUnavailable,
  selectedMergeBaseBranch,
}: GitStatusRowProps) {
  const isWorkspaceDeleted = environment?.status === "destroyed";
  const showWorkspaceStatus =
    (Boolean(workspaceStatus) ||
      Boolean(workspaceStatusError) ||
      Boolean(workspaceUnavailable) ||
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
    workspaceUnavailable,
    workspaceDeleted: isWorkspaceDeleted,
  });
  const labelClass =
    display.label === "Dirty" ? "text-destructive" : "text-foreground";

  return (
    <DetailRow
      label={
        <DetailRowIconLabel icon="FileDiff">Git status</DetailRowIconLabel>
      }
      align="start"
      valueClassName="min-w-0"
    >
      <div
        className="flex min-w-0 items-end gap-2 whitespace-nowrap"
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

interface ArchivedRowProps {
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
      <ThreadUnarchiveButton isPending={isPending} onUnarchive={onUnarchive} />
    </DetailRow>
  );
}

interface ThreadCommitsRowProps {
  workspaceStatus: WorkspaceStatus | undefined;
  onCommitClick?: (sha: string) => void;
}

interface ThreadCommitListItemProps {
  commit: WorkspaceCommitSummary;
  onCommitClick?: (sha: string) => void;
}

const COMMIT_SHA_CHIP_CLASS_NAME =
  "inline-flex max-w-[45%] shrink-0 items-center gap-1 rounded-md px-1.5 py-0.5 text-xs text-subtle-foreground transition-colors hover:bg-state-hover hover:text-foreground";

function ThreadCommitListItem({
  commit,
  onCommitClick,
}: ThreadCommitListItemProps) {
  const subject = onCommitClick ? (
    <button
      type="button"
      onClick={() => onCommitClick(commit.sha)}
      title={commit.subject}
      className="group min-w-0 flex-1 text-left"
    >
      <span className="block min-w-0 truncate text-readback-foreground underline-offset-2 group-hover:underline">
        {commit.subject}
      </span>
    </button>
  ) : (
    <span className="min-w-0 flex-1 truncate text-readback-foreground">
      {commit.subject}
    </span>
  );

  return (
    <div className="flex min-w-0 items-center justify-between gap-2">
      {subject}
      <button
        type="button"
        aria-label={`Copy commit ${commit.shortSha} SHA`}
        className={COMMIT_SHA_CHIP_CLASS_NAME}
        onClick={() => {
          void copyToClipboardWithToast(commit.sha, {
            successMessage: "Commit SHA copied",
            errorMessage: "Failed to copy commit SHA",
          });
        }}
      >
        <span className="truncate">{commit.shortSha}</span>
      </button>
    </div>
  );
}

export function ThreadCommitsRow({
  workspaceStatus,
  onCommitClick,
}: ThreadCommitsRowProps) {
  const commits = selectWorkspaceAheadCommits(workspaceStatus);
  if (commits.length === 0) return null;
  return (
    <>
      {}
      <div className="mb-1 mt-3 border-t border-border" aria-hidden />
      <DetailRow
        label="Commits"
        orientation="vertical"
        labelClassName={CHROME_SECTION_LABEL_CLASS}
        valueClassName="min-w-0"
      >
        <TruncatedList
          items={commits}
          getKey={(commit) => commit.sha}
          renderItem={(commit) => (
            <ThreadCommitListItem
              commit={commit}
              onCommitClick={onCommitClick}
            />
          )}
        />
      </DetailRow>
    </>
  );
}

interface ChangedFilesRowProps {
  workspaceStatus: WorkspaceStatus | undefined;
  onChangedFileClick?: (selection: WorkspaceChangedFileSelection) => void;
}

export function ChangedFilesRow({
  workspaceStatus,
  onChangedFileClick,
}: ChangedFilesRowProps) {
  return (
    <ChangedFilesDetailRow
      sections={selectWorkspaceChangedFilesSections(workspaceStatus)}
      onFileClick={onChangedFileClick}
      labelClassName={CHROME_SECTION_LABEL_CLASS}
      rowClassName="mt-3"
      limit={5}
    />
  );
}

interface ThreadStorageRowProps {
  controller: ThreadStorageBrowserController;
  filesError?: Error | null;
  isFilesLoading: boolean;
}

export function ThreadStorageRow({
  controller,
  filesError,
  isFilesLoading,
}: ThreadStorageRowProps) {
  const { isSearchOpen, openSearch } = controller;
  if (controller.loadedFiles.length === 0 && filesError == null) {
    return null;
  }
  return (
    <DetailRow
      orientation="vertical"
      className="mt-3 min-h-32 flex-1"
      valueClassName="min-h-0 flex-1 overflow-hidden"
      labelClassName="flex items-center justify-between gap-2"
      label={
        <>
          <span>Thread storage</span>
          {isSearchOpen ? null : (
            <Button
              type="button"
              variant="ghost"
              size="icon"
              className={cn(
                COARSE_POINTER_COMPACT_ICON_BUTTON_CLASS,
                "shrink-0 text-muted-foreground",
              )}
              aria-label="Search files"
              onClick={openSearch}
            >
              <Icon name="Search" />
            </Button>
          )}
        </>
      }
    >
      <ThreadStorageBrowser
        controller={controller}
        filesError={filesError}
        isFilesLoading={isFilesLoading}
      />
    </DetailRow>
  );
}

export interface ThreadMetadataContentProps {
  thread: Thread;
  projectId: string;
  parentThreadProjectId: string | null;
  parentThreadDisplayName: string | null;
  parentThreads: readonly ThreadListEntry[];
  canAssignToParent: boolean;
  canTakeOverThread: boolean;
  isLoadingParentThreads: boolean;
  isParentThreadsError: boolean;
  environment: Environment | null;
  environmentDisplayHost: EnvironmentDisplayHostContext;
  workspaceStatus: WorkspaceStatus | undefined;
  workspaceStatusError: Error | null;
  workspaceUnavailable?: WorkspaceResolutionFailure;
  pullRequest: ThreadPullRequest | null;
  selectedMergeBaseBranch: string | undefined;
  mergeBaseBranchRef?: GitBranchRefClassification | null;
  mergeBaseBranchOptions: readonly string[] | undefined;
  mergeBaseRemoteBranchOptions?: readonly string[];
  isLoadingMergeBaseBranchOptions: boolean;
  updateThreadPending: boolean;
  storage?: ThreadStorageRowProps;
  onAssignParent: (parentThreadId: string | null) => void;
  onParentSelectorOpenChange: (open: boolean) => void;
  onRetryParentThreads: () => void;
  onMergeBaseBranchChange: (branch: string) => void;
  onMergeBasePickerOpenChange?: (open: boolean) => void;
  onMergeBaseBranchSearchQueryChange?: (query: string) => void;
  onChangedFileClick?: (selection: WorkspaceChangedFileSelection) => void;
  onCommitClick?: (sha: string) => void;
}

export function hasAnyThreadMetadata(
  {
    thread,
    parentThreadDisplayName,
    environment,
    workspaceStatus,
    workspaceStatusError,
    workspaceUnavailable,
    pullRequest,
  }: Pick<
    ThreadMetadataContentProps,
    | "thread"
    | "parentThreadDisplayName"
    | "environment"
    | "workspaceStatus"
    | "workspaceStatusError"
    | "workspaceUnavailable"
    | "pullRequest"
  >,
  hasForks: boolean,
): boolean {
  const parentThreadId = thread.parentThreadId ?? undefined;
  const isWorkspaceDeleted = environment?.status === "destroyed";
  const showWorkspaceStatus =
    (Boolean(workspaceStatus) ||
      Boolean(workspaceStatusError) ||
      Boolean(workspaceUnavailable) ||
      isWorkspaceDeleted) &&
    !(thread.archivedAt != null && environment?.managed !== true);
  const branchName = workspaceStatus?.branch.currentBranch ?? null;
  const workspaceChangedFilesSections =
    selectWorkspaceChangedFilesSections(workspaceStatus);
  const showThreadChangedFiles = workspaceChangedFilesSections.length > 0;

  return Boolean(
    parentThreadId ||
    environment ||
    branchName ||
    pullRequest ||
    showWorkspaceStatus ||
    showThreadChangedFiles ||
    thread.archivedAt != null ||
    (parentThreadDisplayName && parentThreadId) ||
    hasForks,
  );
}

interface DetailCardWrapperProps {
  children: ReactNode;
}

const INFO_SCROLLBAR_IDLE_DELAY_MS = 600;

export function ThreadMetadataCard({ children }: DetailCardWrapperProps) {
  const scrollbarIdleTimeoutRef = useRef<number | null>(null);

  useEffect(
    () => () => {
      if (scrollbarIdleTimeoutRef.current !== null) {
        window.clearTimeout(scrollbarIdleTimeoutRef.current);
      }
    },
    [],
  );

  const handleScroll = useCallback((event: UIEvent<HTMLDListElement>) => {
    const scrollArea = event.currentTarget;
    if (scrollArea.dataset.scrollbarScrolling !== "true") {
      scrollArea.dataset.scrollbarScrolling = "true";
    }
    if (scrollbarIdleTimeoutRef.current !== null) {
      window.clearTimeout(scrollbarIdleTimeoutRef.current);
    }
    scrollbarIdleTimeoutRef.current = window.setTimeout(() => {
      scrollbarIdleTimeoutRef.current = null;
      scrollArea.removeAttribute("data-scrollbar-scrolling");
    }, INFO_SCROLLBAR_IDLE_DELAY_MS);
  }, []);

  return (
    <DetailCard
      appearance="flat"
      className="transient-scrollbar min-h-0 flex-1 gap-1.5 overflow-x-hidden overflow-y-auto px-4 py-3"
      onScroll={handleScroll}
    >
      {children}
    </DetailCard>
  );
}

export function ThreadMetadataContent(props: ThreadMetadataContentProps) {
  const {
    thread,
    projectId,
    parentThreadProjectId,
    parentThreadDisplayName,
    parentThreads,
    canAssignToParent,
    canTakeOverThread,
    isLoadingParentThreads,
    isParentThreadsError,
    environment,
    environmentDisplayHost,
    workspaceStatus,
    workspaceStatusError,
    workspaceUnavailable,
    pullRequest,
    selectedMergeBaseBranch,
    mergeBaseBranchRef,
    mergeBaseBranchOptions,
    mergeBaseRemoteBranchOptions,
    isLoadingMergeBaseBranchOptions,
    updateThreadPending,
    storage,
    onAssignParent,
    onParentSelectorOpenChange,
    onRetryParentThreads,
    onMergeBaseBranchChange,
    onMergeBasePickerOpenChange,
    onMergeBaseBranchSearchQueryChange,
    onChangedFileClick,
    onCommitClick,
  } = props;

  return (
    <ThreadMetadataCard>
      <ParentSelectorRow
        thread={thread}
        projectId={projectId}
        parentThreadProjectId={parentThreadProjectId}
        parentThreadDisplayName={parentThreadDisplayName}
        parentThreads={parentThreads}
        canAssignToParent={canAssignToParent}
        canTakeOverThread={canTakeOverThread}
        isLoadingParentThreads={isLoadingParentThreads}
        isParentThreadsError={isParentThreadsError}
        updateThreadPending={updateThreadPending}
        onAssignParent={onAssignParent}
        onParentSelectorOpenChange={onParentSelectorOpenChange}
        onRetryParentThreads={onRetryParentThreads}
      />
      <ForksRow thread={thread} projectId={projectId} />
      <EnvironmentRow
        thread={thread}
        environment={environment}
        environmentDisplayHost={environmentDisplayHost}
      />
      <WorkspacePathRow environment={environment} />
      <BranchRow workspaceStatus={workspaceStatus} />
      <MergeBaseRow
        workspaceStatus={workspaceStatus}
        selectedMergeBaseBranch={selectedMergeBaseBranch}
        mergeBaseBranchRef={mergeBaseBranchRef}
        mergeBaseBranchOptions={mergeBaseBranchOptions}
        mergeBaseRemoteBranchOptions={mergeBaseRemoteBranchOptions}
        isLoadingMergeBaseBranchOptions={isLoadingMergeBaseBranchOptions}
        onMergeBaseBranchChange={onMergeBaseBranchChange}
        onMergeBasePickerOpenChange={onMergeBasePickerOpenChange}
        onMergeBaseBranchSearchQueryChange={onMergeBaseBranchSearchQueryChange}
      />
      <GitStatusRow
        thread={thread}
        environment={environment}
        workspaceStatus={workspaceStatus}
        workspaceStatusError={workspaceStatusError}
        workspaceUnavailable={workspaceUnavailable}
        selectedMergeBaseBranch={selectedMergeBaseBranch}
      />
      <PullRequestRow pullRequest={pullRequest} />
      <ArchivedRow thread={thread} />
      <ThreadCommitsRow
        workspaceStatus={workspaceStatus}
        onCommitClick={onCommitClick}
      />
      <ChangedFilesRow
        workspaceStatus={workspaceStatus}
        onChangedFileClick={onChangedFileClick}
      />
      {storage ? <ThreadStorageRow {...storage} /> : null}
    </ThreadMetadataCard>
  );
}
