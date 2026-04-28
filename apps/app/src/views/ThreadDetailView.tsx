import { useCallback, useMemo, type ReactNode } from "react";
import { useParams } from "react-router-dom";
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
  useThreadTimelineTurnSummaryDetails,
  useThreads,
} from "../hooks/queries/thread-queries";
import { ThreadGitActionDialog } from "@/components/thread/ThreadGitActionDialog";
import { ThreadEnvironmentPromotionDialog } from "@/components/thread/ThreadEnvironmentPromotionDialog";
import { PageShell } from "@/components/layout/PageShell";
import { HEADER_ICON_BUTTON_CLASS } from "@/components/layout/AppPageHeader";
import { ThreadActionsMenu } from "@/components/thread/ThreadActionsMenu";
import { ThreadWorkspaceOpenButton } from "@/components/thread/ThreadWorkspaceOpenButton";
import { findLatestActivityRowId, formatEnvironmentDisplay } from "@bb/core-ui";
import { useHostDaemon } from "@/hooks/useHostDaemon";
import { useWorkspaceOpenTargets } from "@/hooks/useWorkspaceOpenTargets";
import { useHost } from "@/hooks/queries/system-queries";
import { getEnvironmentWorkspaceLabelIcon } from "@/lib/environment-workspace-display";
import { useStoredShowAllEvents } from "@/lib/show-all-events-preference";
import { getGitStatusDisplay } from "@/lib/workspace-status";
import {
  renderChangeSummary,
  selectWorkspaceChangedFilesSection,
  toChangeTally,
} from "@/lib/workspace-change-summary";
import { getThreadDisplayTitle } from "@/lib/thread-title";
import { useGitDiffPanel } from "./useGitDiffPanel";
import { useTurnSummaryRowLoader } from "./useTurnSummaryRowLoader";
import { ThreadDetailHeader } from "./ThreadDetailHeader";
import { ThreadDetailPromptArea } from "./ThreadDetailPromptArea";
import { ThreadDetailSecondaryContent } from "./ThreadDetailSecondaryContent";
import { useThreadStorageViewer } from "./useThreadStorageViewer";
import { useEnvironmentMergeBase } from "./useEnvironmentMergeBase";
import { useThreadGitActions } from "./useThreadGitActions";
import { useThreadEnvironmentPromotionActions } from "./useThreadEnvironmentPromotionActions";
import { useThreadReadTracking } from "./useThreadReadTracking";
import { resolveThreadWorkspaceOpenPath } from "./threadWorkspaceOpenButton";
import { copyToClipboardWithToast } from "@/lib/clipboard";

const PROMPT_BANNER_KIND_PREFIX = {
  uncommitted: "Uncommitted",
  untracked: "Untracked",
  committed: "Committed",
} as const;

export function ThreadDetailView() {
  const { projectId, threadId } = useParams<{
    projectId: string;
    threadId: string;
  }>();
  useThreadSecondaryPanelUrlSync();
  const {
    data: thread,
    isLoading,
    error,
  } = useThread(threadId ?? "", {
    refetchOnMount: "always",
  });
  const { data: parentThread } = useThread(thread?.parentThreadId ?? "");
  const { data: pendingInteractions = [] } = useThreadPendingInteractions(
    thread?.id ?? "",
  );
  const hasPendingInteraction =
    getLatestPendingInteraction(pendingInteractions) !== null;
  const isManagerThread = thread?.type === "manager";
  const [storedShowAllEvents, setStoredShowAllEvents] =
    useStoredShowAllEvents();
  const showAllEvents = isManagerThread ? storedShowAllEvents : false;
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
  const handleShowAllEventsChange = useCallback(
    (checked: boolean) => {
      if (!isManagerThread) {
        return;
      }

      setStoredShowAllEvents(checked);
    },
    [isManagerThread, setStoredShowAllEvents],
  );
  const { data: allProjectThreads } = useThreads({ projectId });
  const managerThreads = useMemo(
    () =>
      (allProjectThreads ?? []).filter(
        (candidate) => candidate.type === "manager",
      ),
    [allProjectThreads],
  );
  const {
    data: timeline,
    isLoading: timelineLoading,
    error: timelineError,
  } = useThreadTimeline(threadId ?? "", {
    refetchOnMount: "always",
    includeAllEvents: showAllEvents,
  });
  const timelineTurnSummaryDetails = useThreadTimelineTurnSummaryDetails();
  const sendMessage = useSendThreadMessage();
  const requestEnvironmentAction = useRequestEnvironmentAction();
  const unarchiveThread = useUnarchiveThread();
  const markThreadRead = useMarkThreadRead();
  const updateEnvironment = useUpdateEnvironment();
  const updateThread = useUpdateThread();
  const threadDetailRows = useMemo(
    () => timeline?.rows ?? [],
    [timeline?.rows],
  );
  const activeThinking = timeline?.activeThinking ?? null;
  const contextWindowUsage = timeline?.contextWindowUsage ?? undefined;
  const latestActivityRowId = useMemo(
    () => findLatestActivityRowId(threadDetailRows),
    [threadDetailRows],
  );
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
  const { isLocalHost, openPath } = useHostDaemon();
  const threadEnvironmentIsLocal = environment
    ? isLocalHost(environment.hostId)
    : false;
  const { openWorkspace, workspaceOpenTargets } = useWorkspaceOpenTargets({
    enabled: Boolean(
      environment && threadEnvironmentIsLocal && environment.status === "ready",
    ),
  });
  const { data: environmentHost } = useHost(environment?.hostId);
  const isThreadTimelinePending =
    timelineLoading && threadDetailRows.length === 0;
  const {
    erroredTurnSummaryIds,
    handleLoadTurnSummaryRows,
    loadingTurnSummaryIds,
    turnSummaryRowsById,
  } = useTurnSummaryRowLoader({
    threadId,
    loadTurnSummaryRows: (args) =>
      timelineTurnSummaryDetails.mutateAsync({
        ...args,
        includeAllEvents: showAllEvents,
      }),
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
  const promotionActions = useThreadEnvironmentPromotionActions({
    environment,
    requestEnvironmentAction,
    thread,
  });

  const parentThreadId = thread?.parentThreadId;
  const parentThreadDisplayName =
    parentThread?.title && parentThread.title.trim().length > 0
      ? parentThread.title
      : parentThreadId;
  const managerSelectorOptions = useMemo(() => {
    if (!thread || isManagerThread) {
      return [];
    }

    const options: Array<{ value: string; label: string }> = [
      { value: "none", label: "None" },
    ];
    const seen = new Set<string>(["none"]);
    const addOption = (value: string | undefined, label: string) => {
      if (!value || value === thread.id || seen.has(value)) {
        return;
      }
      seen.add(value);
      options.push({ value, label });
    };

    addOption(
      parentThreadId ?? undefined,
      parentThreadDisplayName ?? "Manager",
    );
    for (const manager of managerThreads) {
      addOption(manager.id, manager.title?.trim() ? manager.title : "Manager");
    }

    return options;
  }, [
    isManagerThread,
    managerThreads,
    parentThreadDisplayName,
    parentThreadId,
    thread,
  ]);
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

  if (!projectId || !threadId) {
    return (
      <PageShell contentClassName="min-h-full items-center justify-center">
        <p className="py-12 text-center text-sm text-destructive">Not found</p>
      </PageShell>
    );
  }
  if (isLoading) {
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
  const canAssignToManager =
    thread.type === "standard" &&
    !thread.parentThreadId &&
    managerThreads.length > 0 &&
    !managerThreads.some((manager) => manager.id === thread.id);
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
      viewerToggleLabel={isManagerThread ? "Show all events" : undefined}
      viewerToggleChecked={isManagerThread ? showAllEvents : undefined}
      onViewerToggleCheckedChange={
        isManagerThread ? handleShowAllEventsChange : undefined
      }
    />
  );
  const workspaceOpenPath = resolveThreadWorkspaceOpenPath({
    canOpenWorkspace: openWorkspace !== null,
    environment,
    hasWorkspaceOpenTargets: workspaceOpenTargets.length > 0,
    threadEnvironmentIsLocal,
  });
  const workspaceOpenButton =
    workspaceOpenPath && openWorkspace ? (
      <ThreadWorkspaceOpenButton
        targets={workspaceOpenTargets}
        onOpenWorkspace={(targetId) =>
          openWorkspace({
            path: workspaceOpenPath,
            targetId,
          })
        }
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
          onOpenFile:
            environment?.path && threadEnvironmentIsLocal
              ? (relativePath: string) => {
                  const fullPath = `${environment.path}/${relativePath}`;
                  void openPath?.(fullPath);
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
          isThreadTimelinePending,
          timelineError: Boolean(timelineError),
          latestActivityRowId,
          loadingTurnSummaryIds,
          erroredTurnSummaryIds,
          onLoadTurnSummaryRows: handleLoadTurnSummaryRows,
          projectId,
          showOngoingIndicator:
            thread.status === "active" && !isThreadTimelinePending,
          ongoingIndicatorLabel: hasPendingInteraction
            ? "Waiting for approval"
            : undefined,
          threadDetailRows,
          threadId: thread.id,
          threadStatus: thread.status,
          turnSummaryRowsById,
        }}
      />
      {canUseGitUi ? (
        <ThreadGitActionDialog
          target={gitActions.threadGitActionDialog.target}
          pending={requestEnvironmentAction.isPending}
          askAgentPending={sendMessage.isPending}
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
          onAskAgentToFix={gitActions.handleAskAgentToFixGitAction}
        />
      ) : null}
      <ThreadEnvironmentPromotionDialog
        target={promotionActions.promotionDialog.target}
        pending={promotionActions.isPromotionActionPending}
        branchName={promotionActions.branchName}
        primaryCheckoutPath={promotionActions.primaryCheckoutPath}
        onOpenChange={promotionActions.promotionDialog.onOpenChange}
        onSubmit={promotionActions.handlePromotionAction}
      />
    </>
  );
}
