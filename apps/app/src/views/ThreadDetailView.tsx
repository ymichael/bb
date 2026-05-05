import { useCallback, useMemo, type ReactNode } from "react";
import { useParams } from "react-router-dom";
import type {
  ThreadTimelineLocalFileLink,
  TimelineTitleActionResolver,
} from "@bb/ui-core";
import type { ThreadListEntry, ThreadWithRuntime } from "@bb/domain";
import { toast } from "sonner";
import { useThreadSecondaryPanelUrlSync } from "@/lib/thread-secondary-panel";
import { useRequestEnvironmentAction } from "../hooks/mutations/environment-mutations";
import {
  useMarkThreadRead,
  useUnarchiveThread,
  useUpdateThread,
} from "../hooks/mutations/thread-state-mutations";
import { useSendThreadMessage } from "../hooks/mutations/thread-runtime-mutations";
import { useUpdateEnvironment } from "../hooks/mutations/environment-mutations";
import {
  useEnvironment,
  useEnvironmentWorkStatus,
} from "../hooks/queries/environment-queries";
import {
  getLatestPendingInteraction,
  useThread,
  useThreadPendingInteractions,
  useThreadTimeline,
  useThreads,
} from "../hooks/queries/thread-queries";
import { ThreadGitActionDialog } from "@/components/thread/ThreadGitActionDialog";
import { ThreadEnvironmentPromotionDialog } from "@/components/thread/ThreadEnvironmentPromotionDialog";
import { PageShell } from "@bb/ui-core";
import { HEADER_ICON_BUTTON_CLASS } from "@/components/layout/AppPageHeader";
import { ThreadActionsMenu } from "@/components/thread/ThreadActionsMenu";
import { ThreadWorkspaceOpenButton } from "@/components/thread/ThreadWorkspaceOpenButton";
import { formatEnvironmentDisplay } from "@bb/core-ui";
import { assertNever } from "@bb/thread-view";
import { useHostDaemon } from "@/hooks/useHostDaemon";
import { useLocalOpenTargets } from "@/hooks/useLocalOpenTargets";
import { useConnectionAwareQueryState } from "@/hooks/queries/connection-aware-query-state";
import { useEffectiveHost } from "@/hooks/queries/effective-hosts";
import { getEnvironmentWorkspaceLabelIcon } from "@/lib/environment-workspace-display";
import { useStandardManagerTimelinePreference } from "@/lib/manager-timeline-view-preference";
import { getGitStatusDisplay } from "@/lib/workspace-status";
import {
  renderChangeSummary,
  selectWorkspaceChangedFilesSection,
  toChangeTally,
} from "@/lib/workspace-change-summary";
import { getThreadDisplayTitle } from "@/lib/thread-title";
import { useGitDiffPanel } from "./useGitDiffPanel";
import { useThreadDetailTurnSummaryRows } from "./useThreadDetailTurnSummaryRows";
import { ThreadDetailHeader } from "./ThreadDetailHeader";
import { ThreadDetailPromptArea } from "./ThreadDetailPromptArea";
import { ThreadDetailSecondaryContent } from "./ThreadDetailSecondaryContent";
import type { HostConnectionNotice } from "./ThreadTimelinePane";
import { useThreadStorageViewer } from "./useThreadStorageViewer";
import { useEnvironmentMergeBase } from "./useEnvironmentMergeBase";
import { useThreadGitActions } from "./useThreadGitActions";
import { useThreadEnvironmentPromotionActions } from "./useThreadEnvironmentPromotionActions";
import { useThreadReadTracking } from "./useThreadReadTracking";
import {
  resolveThreadLocalWorkspaceRootPath,
  resolveThreadWorkspaceOpenPath,
} from "./threadWorkspaceOpenButton";
import { copyToClipboardWithToast } from "@/lib/clipboard";
import { resolveThreadLocalFileLink } from "@/lib/thread-local-file-links";
import {
  buildManagerSelectorOptions,
  isUnassignedStandardThread,
} from "./threadManagerSelectorOptions";

const PROMPT_BANNER_KIND_PREFIX = {
  uncommitted: "Uncommitted",
  untracked: "Untracked",
  committed: "Committed",
} as const;
const EMPTY_MANAGER_THREADS: readonly ThreadListEntry[] = [];

function buildHostConnectionNotice(
  thread: ThreadWithRuntime,
): HostConnectionNotice | null {
  const displayStatus = thread.runtime.displayStatus;
  if (
    displayStatus !== "host-reconnecting" &&
    displayStatus !== "waiting-for-host"
  ) {
    return null;
  }

  return {
    label:
      displayStatus === "host-reconnecting"
        ? "Host daemon disconnected. Waiting for reconnection..."
        : "Host daemon disconnected",
    tone: displayStatus === "host-reconnecting" ? "pending" : "error",
  };
}

export function ThreadDetailView() {
  const { projectId, threadId } = useParams<{
    projectId: string;
    threadId: string;
  }>();
  useThreadSecondaryPanelUrlSync();
  const {
    data: thread,
    isFetching,
    isLoadingError,
    isPlaceholderData,
    error,
  } = useThread(threadId ?? "", {
    refetchOnMount: "always",
  });
  const threadQueryState = useConnectionAwareQueryState({
    hasResolvedData: thread !== undefined && !isPlaceholderData,
    isFetching,
    isLoadingError,
  });
  const { data: parentThread } = useThread(thread?.parentThreadId ?? "");
  const { data: pendingInteractions = [] } = useThreadPendingInteractions(
    thread?.id ?? "",
  );
  const hasPendingInteraction =
    getLatestPendingInteraction(pendingInteractions) !== null;
  const isManagerThread = thread?.type === "manager";
  const [
    storedUseStandardManagerTimeline,
    setStoredUseStandardManagerTimeline,
  ] = useStandardManagerTimelinePreference();
  const useStandardManagerTimeline =
    isManagerThread && storedUseStandardManagerTimeline;
  const managerTimelineView = useStandardManagerTimeline
    ? "standard"
    : undefined;
  const {
    isThreadStorageFilePreviewLoading,
    threadStorageFilePreview,
    threadStorageFilePreviewError,
    threadStorageFiles,
    selectedThreadStoragePath,
    setSelectedThreadStoragePath,
  } = useThreadStorageViewer({
    threadId,
    threadType: thread?.type,
  });
  const handleUseStandardManagerTimelineChange = useCallback(
    (checked: boolean) => {
      if (!isManagerThread) {
        return;
      }

      setStoredUseStandardManagerTimeline(checked);
    },
    [isManagerThread, setStoredUseStandardManagerTimeline],
  );
  const isUnassignedStandard = isUnassignedStandardThread(thread);
  const shouldLoadManagerThreads =
    threadQueryState.status === "ready" && isUnassignedStandard;
  const managerThreadsQuery = useThreads(
    {
      archived: false,
      projectId,
      type: "manager",
    },
    {
      enabled: shouldLoadManagerThreads,
    },
  );
  const managerThreads = managerThreadsQuery.data ?? EMPTY_MANAGER_THREADS;
  const {
    data: timeline,
    isLoading: timelineLoading,
    error: timelineError,
  } = useThreadTimeline(threadId ?? "", {
    refetchOnMount: "always",
    managerTimelineView,
  });
  const sendMessage = useSendThreadMessage();
  const requestEnvironmentAction = useRequestEnvironmentAction();
  const unarchiveThread = useUnarchiveThread();
  const markThreadRead = useMarkThreadRead();
  const updateEnvironment = useUpdateEnvironment();
  const updateThread = useUpdateThread();
  const timelineRows = useMemo(
    () => [...(timeline?.rows ?? []), ...(timeline?.pendingSteers ?? [])],
    [timeline?.pendingSteers, timeline?.rows],
  );
  const hostConnectionNotice = useMemo(
    () => (thread ? buildHostConnectionNotice(thread) : null),
    [thread],
  );
  const activeThinking = timeline?.activeThinking ?? null;
  const contextWindowUsage = timeline?.contextWindowUsage ?? undefined;
  const environmentQuery = useEnvironment(thread?.environmentId);
  const environment = environmentQuery.data;
  const {
    closeThreadSecondaryPanel,
    defaultMergeBaseBranch: resolvedDefaultMergeBaseBranch,
    isLoadingMergeBaseBranchOptions,
    mergeBaseBranchOptions,
    openDiffFile,
    openThreadDiffPanel,
    openThreadSecondaryPanel,
    selectedMergeBaseBranch,
    setSelectedMergeBaseBranch,
    toggleThreadSecondaryPanel,
  } = useGitDiffPanel({
    defaultMergeBaseBranch:
      environment?.mergeBaseBranch ?? environment?.defaultBranch ?? undefined,
    environmentId: thread?.environmentId ?? undefined,
  });
  const requestedMergeBaseBranch =
    selectedMergeBaseBranch ??
    environment?.mergeBaseBranch ??
    environment?.defaultBranch ??
    undefined;
  const workStatusQuery = useEnvironmentWorkStatus(
    thread?.environmentId,
    requestedMergeBaseBranch,
  );
  const workStatus = workStatusQuery.data;
  const workspaceStatusError = workStatusQuery.error;
  const workspaceStatus = workspaceStatusError
    ? undefined
    : (workStatus ?? undefined);
  const workspaceWorkingTree = workspaceStatus?.workingTree;
  const workspaceBranch = workspaceStatus?.branch;
  const workspaceChangedFilesSection = useMemo(
    () => selectWorkspaceChangedFilesSection(workspaceStatus),
    [workspaceStatus],
  );
  const { isLocalHost } = useHostDaemon();
  const threadEnvironmentIsLocal = environment
    ? isLocalHost(environment.hostId)
    : false;
  const localWorkspaceRootPath = resolveThreadLocalWorkspaceRootPath({
    environment,
    threadEnvironmentIsLocal,
  });
  const {
    canOpenPreferredTarget,
    openPathInPreferredTarget,
    openPathInTarget,
    preferredTarget,
    workspaceOpenTargets,
  } = useLocalOpenTargets({
    enabled: localWorkspaceRootPath !== null,
  });
  const { data: environmentHost } = useEffectiveHost(environment?.hostId);
  const isThreadTimelinePending = timelineLoading && timelineRows.length === 0;
  const {
    erroredTurnSummaryIds,
    handleLoadTurnSummaryRows,
    loadingTurnSummaryIds,
    turnSummaryRowsById,
  } = useThreadDetailTurnSummaryRows({
    managerTimelineView,
    threadId,
  });
  useThreadReadTracking({
    markThreadRead,
    thread,
  });
  const {
    canSelectMergeBase,
    effectiveMergeBaseBranch,
    handleMergeBaseBranchChange,
    showBranchComparisonUi,
    showMergeBase,
    mergeBaseBranch,
    mergeBaseCandidates,
  } = useEnvironmentMergeBase({
    environment,
    mergeBaseBranchOptions,
    selectedMergeBaseBranch,
    setSelectedMergeBaseBranch,
    thread,
    updateEnvironment,
    workspaceStatus,
  });
  const gitActions = useThreadGitActions({
    environment,
    requestEnvironmentAction,
    sendMessage,
    thread,
    workspaceStatus,
  });
  const isAgentActive = thread?.status === "active";
  const promotionActions = useThreadEnvironmentPromotionActions({
    environment,
    isAgentActive,
    requestEnvironmentAction,
    thread,
  });

  const parentThreadId = thread?.parentThreadId;
  const parentThreadDisplayName =
    parentThread?.title && parentThread.title.trim().length > 0
      ? parentThread.title
      : parentThreadId;
  const managerSelectorOptions = useMemo(
    () =>
      buildManagerSelectorOptions({
        currentThreadId: thread?.id,
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
      thread?.id,
    ],
  );
  const managerSelectorValue = parentThreadId ?? "none";
  const selectedManagerOption = managerSelectorOptions.find(
    (option) => option.value === managerSelectorValue,
  );
  const handleAssignManager = useCallback(
    (nextParentThreadId: string | null) => {
      if (!thread || updateThread.isPending) {
        return;
      }

      updateThread.mutate({
        id: thread.id,
        parentThreadId: nextParentThreadId,
      });
    },
    [thread, updateThread],
  );
  const handleThreadStoragePathToggle = useCallback(
    (path: string) => {
      setSelectedThreadStoragePath((currentPath) =>
        currentPath === path ? null : path,
      );
    },
    [setSelectedThreadStoragePath],
  );
  const handleOpenTimelineLocalFileLink = useCallback(
    (link: ThreadTimelineLocalFileLink) => {
      const resolution = resolveThreadLocalFileLink({
        link,
        workspaceRootPath: localWorkspaceRootPath,
      });
      if (resolution.kind === "app-route") {
        return false;
      }
      if (resolution.kind === "error") {
        toast.error("Could not open locally.", {
          description: resolution.description,
        });
        return true;
      }

      void openPathInPreferredTarget(resolution.request);
      return true;
    },
    [localWorkspaceRootPath, openPathInPreferredTarget],
  );
  const handleTimelineTitleAction = useCallback<TimelineTitleActionResolver>(
    (action) => {
      switch (action.kind) {
        case "open-file-diff":
          // Manager threads can't render the diff panel (showGitDiffTab is
          // gated on canUseGitUi); leave the title content as plain text in
          // that case rather than producing a clickable affordance that would
          // route nowhere.
          if (isManagerThread) {
            return null;
          }
          return () => {
            openDiffFile(action.path);
          };
        default:
          // Surfaces a compile-time error if a future TimelineTitleAction
          // variant is added without app-side handling, instead of silently
          // returning undefined and leaving a kind unrouted.
          return assertNever(action.kind);
      }
    },
    [isManagerThread, openDiffFile],
  );

  if (!projectId || !threadId) {
    return (
      <PageShell contentClassName="min-h-full items-center justify-center">
        <p className="py-12 text-center text-sm text-destructive">Not found</p>
      </PageShell>
    );
  }
  if (threadQueryState.status === "loading") {
    return (
      <PageShell contentClassName="min-h-full items-center justify-center">
        <p className="py-12 text-center text-sm text-muted-foreground">
          Loading...
        </p>
      </PageShell>
    );
  }
  if (!thread || thread.projectId !== projectId) {
    return (
      <PageShell contentClassName="min-h-full items-center justify-center">
        <p className="py-12 text-center text-sm text-destructive">
          {error ? "Failed to load thread." : "Not found"}
        </p>
      </PageShell>
    );
  }

  const canUseGitUi = !isManagerThread;
  const hasAssignableManager = managerSelectorOptions.some(
    (option) => option.value !== "none",
  );
  const canAssignToManager = isUnassignedStandard && hasAssignableManager;
  const canTakeOverThread =
    thread.type === "standard" && Boolean(thread.parentThreadId);
  const threadEnvironmentDisplay = environment
    ? formatEnvironmentDisplay({
        environment,
        isLocalHost: threadEnvironmentIsLocal,
        hostName: environmentHost?.name,
        hostType: environmentHost?.type,
        hostProvider: environmentHost?.provider,
      })
    : undefined;
  const threadEnvironmentIcon = threadEnvironmentDisplay
    ? getEnvironmentWorkspaceLabelIcon(
        threadEnvironmentDisplay.workspaceDisplayKind,
      )
    : null;
  const promptBannerSummary: ReactNode = workspaceChangedFilesSection ? (
    <>
      {PROMPT_BANNER_KIND_PREFIX[workspaceChangedFilesSection.kind]} ·{" "}
      {renderChangeSummary(toChangeTally(workspaceChangedFilesSection.stats))}
    </>
  ) : null;
  const showPromptGitStatsBanner =
    canUseGitUi && workspaceChangedFilesSection !== null;
  const canExpandPromptChangeList =
    canUseGitUi && (workspaceChangedFilesSection?.files.length ?? 0) > 0;
  const promptBannerMergeBaseBranch = effectiveMergeBaseBranch;
  const threadEnvironmentType =
    threadEnvironmentDisplay?.modeLabel ??
    (environment ? "environment" : undefined);
  const threadEnvironmentValue: ReactNode | undefined =
    threadEnvironmentDisplay ? (
      threadEnvironmentDisplay.hostLabel &&
      threadEnvironmentDisplay.location === "remote" ? (
        <>
          {threadEnvironmentDisplay.modeLabel}
          <span className="text-muted-foreground/60">
            {" "}
            · {threadEnvironmentDisplay.hostLabel}
          </span>
        </>
      ) : (
        threadEnvironmentDisplay.modeLabel
      )
    ) : undefined;
  const threadEnvironmentModeLabel = threadEnvironmentDisplay?.modeLabel;
  const threadBranchName = workspaceBranch?.currentBranch ?? undefined;
  const isWorkspaceDeleted = environment?.status === "destroyed";
  const showWorkspaceStatus =
    canUseGitUi &&
    (Boolean(workspaceStatus) ||
      Boolean(workspaceStatusError) ||
      isWorkspaceDeleted) &&
    !(thread.archivedAt != null && environment?.managed !== true);
  const threadGitStatusDisplay = getGitStatusDisplay(workspaceStatus, {
    mergeBaseBranch,
    showBranchComparison: showBranchComparisonUi,
    error: workspaceStatusError,
    workspaceDeleted: isWorkspaceDeleted,
  });
  const threadGitStatusLabelClass =
    workspaceWorkingTree?.state === "untracked"
      ? "text-muted-foreground"
      : "text-foreground";
  const showThreadChangedFiles =
    canUseGitUi && workspaceChangedFilesSection !== null;
  const showThreadMetadata = Boolean(
    isManagerThread ||
    parentThreadId ||
    (!isManagerThread && threadEnvironmentType) ||
    (!isManagerThread && threadBranchName) ||
    (!isManagerThread && showMergeBase) ||
    showWorkspaceStatus ||
    showThreadChangedFiles ||
    thread.archivedAt != null,
  );
  const threadTitle = getThreadDisplayTitle(thread);
  const handleCopyThreadBranch = async () => {
    if (!threadBranchName) {
      return;
    }
    await copyToClipboardWithToast(threadBranchName, {
      successMessage: "Branch name copied",
      errorMessage: "Failed to copy branch name",
    });
  };
  const threadActionsMenu = (
    <ThreadActionsMenu
      thread={thread}
      triggerClassName={HEADER_ICON_BUTTON_CLASS}
      align="end"
      viewerToggleLabel={isManagerThread ? "Use standard timeline" : undefined}
      viewerToggleChecked={
        isManagerThread ? useStandardManagerTimeline : undefined
      }
      onViewerToggleCheckedChange={
        isManagerThread ? handleUseStandardManagerTimelineChange : undefined
      }
    />
  );
  const workspaceOpenPath = resolveThreadWorkspaceOpenPath({
    canOpenWorkspace: canOpenPreferredTarget,
    environment,
    hasWorkspaceOpenTargets: workspaceOpenTargets.length > 0,
    threadEnvironmentIsLocal,
  });
  const workspaceOpenButton =
    workspaceOpenPath && preferredTarget ? (
      <ThreadWorkspaceOpenButton
        preferredTarget={preferredTarget}
        targets={workspaceOpenTargets}
        onOpenPreferredTarget={async () => {
          await openPathInPreferredTarget({
            lineNumber: null,
            path: workspaceOpenPath,
            workspaceRootPath: workspaceOpenPath,
          });
        }}
        onOpenTarget={async (targetId) => {
          await openPathInTarget({
            lineNumber: null,
            path: workspaceOpenPath,
            rememberTarget: true,
            targetId,
            workspaceRootPath: workspaceOpenPath,
          });
        }}
      />
    ) : undefined;
  const timelineHeader = (
    <ThreadDetailHeader
      actionsMenu={threadActionsMenu}
      isManagedThread={Boolean(parentThreadId)}
      isManagerThread={isManagerThread}
      isPromoted={promotionActions.isPromoted}
      isThreadGitActionPending={gitActions.isThreadGitActionPending}
      onOpenThreadGitAction={gitActions.threadGitActionDialog.onOpen}
      onOpenThreadPromotionAction={promotionActions.promotionDialog.onOpen}
      onToggleSecondaryPanel={toggleThreadSecondaryPanel}
      threadHeaderGitActions={gitActions.threadHeaderGitActions}
      threadHeaderPromotionAction={promotionActions.headerAction}
      threadTitle={threadTitle}
      workspaceOpenButton={workspaceOpenButton}
    />
  );
  const composerFooter = (
    <ThreadDetailPromptArea
      canExpandPromptChangeList={canExpandPromptChangeList}
      canUseGitUi={canUseGitUi}
      contextWindowUsage={contextWindowUsage}
      environmentBranchName={threadBranchName}
      environmentHostConnected={
        environmentHost ? environmentHost.status === "connected" : undefined
      }
      environmentIcon={threadEnvironmentIcon ?? undefined}
      environmentLabel={threadEnvironmentValue}
      isEnvironmentActionPending={requestEnvironmentAction.isPending}
      isLoadingMergeBaseBranchOptions={isLoadingMergeBaseBranchOptions}
      mergeBaseBranchOptions={mergeBaseBranchOptions}
      onMergeBaseBranchChange={
        showBranchComparisonUi ? handleMergeBaseBranchChange : undefined
      }
      openDiffFile={openDiffFile}
      openThreadDiffPanel={openThreadDiffPanel}
      projectId={projectId}
      promptBannerFiles={workspaceChangedFilesSection?.files}
      promptBannerMergeBaseBranch={promptBannerMergeBaseBranch}
      promptBannerSummary={promptBannerSummary}
      sendMessage={sendMessage}
      showBranchComparisonUi={showBranchComparisonUi}
      showPromptGitStatsBanner={showPromptGitStatsBanner}
      pendingInteractions={pendingInteractions}
      thread={thread}
      workspaceStatus={workspaceStatus}
    />
  );
  const threadStorage =
    thread.type === "manager"
      ? {
          filePreview: threadStorageFilePreview,
          fileError:
            threadStorageFilePreviewError instanceof Error
              ? threadStorageFilePreviewError
              : threadStorageFilePreviewError
                ? new Error("Failed to load thread storage file")
                : null,
          files: threadStorageFiles?.files,
          isFileLoading: isThreadStorageFilePreviewLoading,
          onTogglePath: handleThreadStoragePathToggle,
          selectedPath: selectedThreadStoragePath,
        }
      : undefined;

  return (
    <>
      <ThreadDetailSecondaryContent
        footer={composerFooter}
        header={timelineHeader}
        threadStorage={threadStorage}
        metadata={{
          canAssignToManager,
          canSelectMergeBase,
          canTakeOverThread,
          isLoadingMergeBaseBranchOptions,
          isManagerThread,
          managerSelectorOptions,
          managerSelectorValue,
          onAssignManager: handleAssignManager,
          onCopyThreadBranch: () => {
            void handleCopyThreadBranch();
          },
          onMergeBaseBranchChange: handleMergeBaseBranchChange,
          onUnarchive: () => {
            unarchiveThread.mutate({ id: thread.id });
          },
          parentThreadId: parentThreadId ?? undefined,
          projectId,
          selectedManagerOptionLabel: selectedManagerOption?.label,
          showThreadChangedFiles,
          showMergeBase,
          showWorkspaceStatus,
          thread,
          threadBranchName,
          threadEnvironmentModeLabel,
          threadEnvironmentType,
          threadEnvironmentValue,
          threadHostConnected: environmentHost
            ? environmentHost.status === "connected"
            : undefined,
          threadHostIsLocal: environment ? threadEnvironmentIsLocal : undefined,
          threadHostName: environmentHost?.name,
          threadGitStatusDisplay,
          threadGitStatusLabelClass,
          mergeBaseBranch,
          mergeBaseCandidates,
          unarchivePending:
            unarchiveThread.isPending &&
            unarchiveThread.variables?.id === thread.id,
          updateThreadPending:
            updateThread.isPending || updateEnvironment.isPending,
          onChangedFileClick: canUseGitUi
            ? (file) => {
                openDiffFile(file.path);
              }
            : undefined,
          workspaceStatusFiles: workspaceChangedFilesSection?.files,
          workspaceStatusFilesLabel: workspaceChangedFilesSection?.label,
        }}
        secondaryPanel={{
          canUseGitUi,
          defaultMergeBaseBranch: resolvedDefaultMergeBaseBranch,
          environmentId: thread.environmentId ?? undefined,
          isManagerThread,
          onClose: closeThreadSecondaryPanel,
          onCollapse: closeThreadSecondaryPanel,
          onOpenFileInEditor:
            localWorkspaceRootPath && canOpenPreferredTarget
              ? (relativePath: string) => {
                  const fullPath = `${localWorkspaceRootPath}/${relativePath}`;
                  void openPathInPreferredTarget({
                    lineNumber: null,
                    path: fullPath,
                    workspaceRootPath: localWorkspaceRootPath,
                  });
                }
              : undefined,
          onPanelChange: openThreadSecondaryPanel,
          showGitDiffTab: canUseGitUi,
          showThreadStorageTab: thread.type === "manager",
          threadId: thread.id,
        }}
        showThreadMetadata={showThreadMetadata}
        timeline={{
          activeThinking,
          hostConnectionNotice,
          isThreadTimelinePending,
          timelineError: Boolean(timelineError),
          loadingTurnSummaryIds,
          erroredTurnSummaryIds,
          onLoadTurnSummaryRows: handleLoadTurnSummaryRows,
          onOpenLocalFileLink: handleOpenTimelineLocalFileLink,
          onTitleAction: handleTimelineTitleAction,
          projectId,
          showOngoingIndicator:
            (thread.runtime.displayStatus === "active" ||
              thread.runtime.displayStatus === "host-reconnecting") &&
            !isThreadTimelinePending,
          ongoingIndicatorLabel: hasPendingInteraction
            ? "Waiting for approval"
            : thread.runtime.displayStatus === "host-reconnecting"
              ? "Waiting for reconnection"
              : undefined,
          timelineRows,
          threadId: thread.id,
          threadRuntimeDisplayStatus: thread.runtime.displayStatus,
          turnSummaryRowsById,
        }}
      />
      {canUseGitUi ? (
        <ThreadGitActionDialog
          target={gitActions.threadGitActionDialog.target}
          branchName={threadBranchName}
          gitStatusDisplay={threadGitStatusDisplay}
          changedFiles={workspaceWorkingTree?.files}
          threadId={thread.id}
          threadType={thread.type}
          showMergeBaseDetails={showBranchComparisonUi}
          mergeBaseBranch={effectiveMergeBaseBranch}
          mergeBaseBranchOptions={mergeBaseBranchOptions}
          mergeBaseBranchOptionsLoading={isLoadingMergeBaseBranchOptions}
          onMergeBaseBranchChange={
            showBranchComparisonUi ? handleMergeBaseBranchChange : undefined
          }
          onOpenChange={(open) => {
            if (!open) {
              gitActions.threadGitActionDialog.onClose();
            }
          }}
          onCommit={gitActions.handleCommitThread}
          onSquashMerge={gitActions.handleSquashMergeThread}
        />
      ) : null}
      <ThreadEnvironmentPromotionDialog
        agentActive={isAgentActive}
        blockers={promotionActions.dialogBlockers}
        target={promotionActions.promotionDialog.target}
        pending={promotionActions.isPromotionActionPending}
        branchName={promotionActions.branchName}
        defaultBranch={promotionActions.defaultBranch}
        primaryCheckoutPath={promotionActions.primaryCheckoutPath}
        onOpenChange={promotionActions.promotionDialog.onOpenChange}
        onSubmit={promotionActions.handlePromotionAction}
      />
    </>
  );
}
