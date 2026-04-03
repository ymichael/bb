import { useCallback, useMemo, useRef, type ReactNode } from "react";
import { useLocation, useNavigate, useParams } from "react-router-dom";
import { useRequestEnvironmentAction } from "../hooks/mutations/environment-mutations";
import {
  useArchiveThread,
  useDeleteThread,
  useMarkThreadRead,
  useMarkThreadUnread,
  useUnarchiveThread,
  useUpdateThread,
} from "../hooks/mutations/thread-state-mutations";
import { useSendThreadMessage } from "../hooks/mutations/thread-runtime-mutations";
import { useUpdateEnvironment } from "../hooks/mutations/environment-mutations";
import { useEnvironment, useEnvironmentWorkStatus } from "../hooks/queries/environment-queries";
import {
  useThread,
  useThreadTimeline,
  useThreadTimelineToolDetails,
  useThreads,
} from "../hooks/queries/thread-queries";
import {
  ThreadGitActionDialog,
} from "@/components/thread/ThreadGitActionDialog";
import {
  ThreadRenameDialog,
  type ThreadRenameDialogTarget,
} from "@/components/thread/ThreadRenameDialog";
import { PageShell } from "@/components/layout/PageShell";
import { ThreadArchiveConfirmationDialog } from "@/components/thread/ThreadArchiveConfirmationDialog";
import { ThreadDeleteDialog } from "@/components/thread/ThreadDeleteDialog";
import { ThreadActionsMenu } from "@/components/thread/ThreadActionsMenu";
import { formatEnvironmentDisplay } from "@bb/core-ui";
import { findLatestActivityRowId } from "@bb/ui-core";
import type { Thread } from "@bb/domain";
import { useDialogState } from "@/hooks/useDialogState";
import { useHostDaemon } from "@/hooks/useHostDaemon";
import { usePreferredTheme } from "@/hooks/useTheme";
import { HttpError } from "@/lib/api";
import { useStoredShowAllEvents } from "@/lib/show-all-events-preference";
import { getGitStatusDisplay } from "@/lib/workspace-status";
import {
  formatChangeSummary,
  formatWorkspaceChangeSummary,
} from "@/lib/workspace-change-summary";
import { getThreadDisplayTitle, threadTypeLabel } from "@/lib/thread-title";
import {
  isArchiveForceRequiredError,
} from "@/lib/thread-archive";
import { useGitDiffPanel } from "./useGitDiffPanel";
import { useThreadTimelineController } from "./useThreadTimelineController";
import { ThreadDetailHeader } from "./ThreadDetailHeader";
import { ThreadDetailPromptArea } from "./ThreadDetailPromptArea";
import { ThreadDetailSecondaryContent } from "./ThreadDetailSecondaryContent";
import { useThreadStorageViewer } from "./useThreadStorageViewer";
import { useEnvironmentMergeBase } from "./useEnvironmentMergeBase";
import { useThreadGitActions } from "./useThreadGitActions";
import { useThreadReadTracking } from "./useThreadReadTracking";
import { toast } from "sonner";

export function ThreadDetailView() {
  const { projectId, threadId } = useParams<{
    projectId: string;
    threadId: string;
  }>();
  const location = useLocation();
  const navigate = useNavigate();
  const { data: thread, isLoading, error } = useThread(threadId ?? "", {
    refetchOnMount: "always",
  });
  const { data: parentThread } = useThread(thread?.parentThreadId ?? "");
  const isManagerThread = thread?.type === "manager";
  const [storedShowAllEvents, setStoredShowAllEvents] = useStoredShowAllEvents();
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
  const handleShowAllEventsChange = useCallback((checked: boolean) => {
    if (!isManagerThread) {
      return;
    }

    setStoredShowAllEvents(checked);
  }, [isManagerThread, setStoredShowAllEvents]);
  const { data: allProjectThreads } = useThreads({ projectId });
  const managerThreads = useMemo(
    () => (allProjectThreads ?? []).filter((candidate) => candidate.type === "manager"),
    [allProjectThreads],
  );
  const { data: timeline, isLoading: timelineLoading } = useThreadTimeline(
    threadId ?? "",
    {
      refetchOnMount: "always",
      includeAllEvents: showAllEvents,
    },
  );
  const timelineToolDetails = useThreadTimelineToolDetails();
  const sendMessage = useSendThreadMessage();
  const archiveThread = useArchiveThread();
  const requestEnvironmentAction = useRequestEnvironmentAction();
  const unarchiveThread = useUnarchiveThread();
  const markThreadRead = useMarkThreadRead();
  const markThreadUnread = useMarkThreadUnread();
  const deleteThread = useDeleteThread();
  const updateEnvironment = useUpdateEnvironment();
  const updateThread = useUpdateThread();
  const threadArchiveConfirmationDialog = useDialogState<Thread>();
  const threadRenameDialog = useDialogState<ThreadRenameDialogTarget>();
  const threadDeleteDialog = useDialogState<Thread>();
  const captureTimelineScrollPositionRef = useRef<() => void>(() => {});
  const preferredTheme = usePreferredTheme();
  const threadDetailRows = useMemo(() => timeline?.rows ?? [], [timeline?.rows]);
  const contextWindowUsage = timeline?.contextWindowUsage ?? undefined;
  const latestActivityRowId = useMemo(
    () => findLatestActivityRowId(threadDetailRows),
    [threadDetailRows],
  );
  const environmentQuery = useEnvironment(thread?.environmentId);
  const environment = environmentQuery.data;
  const {
    activeSecondaryPanel,
    areAllGitDiffFilesCollapsed,
    closeThreadSecondaryPanel,
    collapsedGitDiffFileKeys,
    currentGitDiff,
    gitDiffDisplayMode,
    gitDiffError,
    gitDiffSelectOptions,
    gitDiffSelectValue,
    gitDiffStatsLabel,
    gitDiffViewOptions,
    handleGitDiffDisplayModeChange,
    handleSecondaryPanelDragging,
    handleSecondaryPanelResize,
    isDiffPanelActive,
    isGitDiffLoading,
    isLoadingMergeBaseBranchOptions,
    isSecondaryPanelOpen,
    isSecondaryPanelResizing,
    isParsingGitDiffFiles,
    isPreparingGitDiff,
    loadingGitDiffFileKeys,
    mergeBaseBranchOptions,
    onGitDiffSelectionChange,
    onMergeBaseBranchPickerOpenChange,
    openDiffFile,
    openThreadDiffPanel,
    openThreadSecondaryPanel,
    parsedGitDiffFileEntries,
    queuedGitDiffFileRenderKeys,
    secondaryPanelRef,
    secondaryResizablePanelRef,
    selectedMergeBaseBranch,
    setGitDiffFileRef,
    setSelectedMergeBaseBranch,
    threadGitDiff,
    toggleAllGitDiffFilesCollapsed,
    toggleGitDiffFileCollapsed,
    toggleThreadSecondaryPanel,
  } = useGitDiffPanel({
    location,
    navigate,
    onBeforePanelChange: () => {
      captureTimelineScrollPositionRef.current();
    },
    preferredTheme,
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
  const workspaceStatus =
    workspaceStatusError ? undefined : (workStatus ?? undefined);
  const workspaceWorkingTree = workspaceStatus?.workingTree;
  const workspaceBranch = workspaceStatus?.branch;
  const { isLocalHost, openPath } = useHostDaemon();
  const isReasoningBlockActive = false;
  const isThreadTimelinePending = timelineLoading && threadDetailRows.length === 0;
  const {
    bottomSentinelRef,
    captureTimelineScrollPosition,
    handleLoadToolGroupMessages,
    handleTimelineScroll,
    loadingToolGroupIds,
    promptComposerRef,
    scrollToBottom,
    setContainerRef,
    showScrollToBottom,
    toolGroupMessagesById,
  } = useThreadTimelineController({
    threadId,
    threadDetailRows,
    isSecondaryPanelOpen,
    loadToolGroupMessages: (args) =>
      timelineToolDetails.mutateAsync({
        ...args,
        includeAllEvents: showAllEvents,
      }),
  });
  captureTimelineScrollPositionRef.current = captureTimelineScrollPosition;
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

  const renameThread = useCallback(() => {
    if (!thread || updateThread.isPending) return;
    threadRenameDialog.onOpen({
      id: thread.id,
      currentTitle: getThreadDisplayTitle(thread),
      threadType: thread.type,
    });
  }, [thread, threadRenameDialog, updateThread.isPending]);
  const submitThreadRename = useCallback((currentThreadId: string, title: string) => {
    updateThread.mutate(
      {
        id: currentThreadId,
        title,
      },
      {
        onSuccess: () => {
          threadRenameDialog.onClose();
        },
      },
    );
  }, [threadRenameDialog, updateThread]);
  const confirmArchiveThread = useCallback((threadToArchive: Thread) => {
    const label = threadTypeLabel(threadToArchive.type);

    threadArchiveConfirmationDialog.onClose();
    archiveThread.mutate(
      { id: threadToArchive.id, force: true },
      {
        onSuccess: () => {
          navigate(`/projects/${threadToArchive.projectId}`);
        },
        onError: (nextError) => {
          toast.error(
            nextError instanceof Error ? nextError.message : `Failed to archive ${label}.`,
          );
        },
      },
    );
  }, [archiveThread, navigate, threadArchiveConfirmationDialog]);
  const toggleArchiveThread = useCallback(() => {
    if (!thread) return;
    const label = threadTypeLabel(thread.type);
    if (thread.archivedAt != null) {
      unarchiveThread.mutate({ id: thread.id });
      return;
    }

    archiveThread.mutate(
      { id: thread.id, force: false },
      {
        onSuccess: () => {
          navigate(`/projects/${thread.projectId}`);
        },
        onError: (nextError) => {
          if (isArchiveForceRequiredError(nextError)) {
            threadArchiveConfirmationDialog.onOpen(thread);
            return;
          }
          toast.error(
            nextError instanceof Error ? nextError.message : `Failed to archive ${label}.`,
          );
        },
      },
    );
  }, [
    archiveThread,
    environment,
    navigate,
    thread,
    threadArchiveConfirmationDialog,
    unarchiveThread,
  ]);
  const parentThreadId = thread?.parentThreadId;
  const parentThreadDisplayName =
    parentThread?.title && parentThread.title.trim().length > 0
      ? parentThread.title
      : parentThreadId;
  const managerSelectorOptions = useMemo(() => {
    if (!thread || isManagerThread) {
      return [];
    }

    const options: Array<{ value: string; label: string }> = [{ value: "none", label: "None" }];
    const seen = new Set<string>(["none"]);
    const addOption = (value: string | undefined, label: string) => {
      if (!value || value === thread.id || seen.has(value)) {
        return;
      }
      seen.add(value);
      options.push({ value, label });
    };

    addOption(parentThreadId ?? undefined, parentThreadDisplayName ?? "Manager");
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
  const handleAssignManager = useCallback((nextParentThreadId: string | null) => {
    if (!thread || updateThread.isPending) {
      return;
    }

    updateThread.mutate({
      id: thread.id,
      parentThreadId: nextParentThreadId,
    });
  }, [thread, updateThread]);
  const handleThreadStoragePathToggle = useCallback((path: string) => {
    setSelectedThreadStoragePath((currentPath) =>
      currentPath === path ? null : path,
    );
  }, [setSelectedThreadStoragePath]);

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
        <p className="py-12 text-center text-sm text-muted-foreground">Loading...</p>
      </PageShell>
    );
  }
  const isTransientThreadLoadError =
    Boolean(thread) &&
    Boolean(error) &&
    (!(error instanceof HttpError) || error.status >= 500);
  if (
    (!thread && Boolean(error)) ||
    !thread ||
    (!isTransientThreadLoadError && Boolean(error)) ||
    thread.projectId !== projectId
  ) {
    return (
      <PageShell contentClassName="min-h-full items-center justify-center">
        <p className="py-12 text-center text-sm text-destructive">
          {error ? error.message : "Not found"}
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
  const threadEnvironmentLabel = environment
    ? formatEnvironmentDisplay(environment, isLocalHost(environment.hostId)).label
    : undefined;
  const promptBannerSummary = workspaceStatus
    ? showBranchComparisonUi
      ? formatChangeSummary(workspaceStatus.workingTree)
      : formatWorkspaceChangeSummary(workspaceStatus.workingTree)
    : "";
  const showPromptGitStatsBanner = canUseGitUi && Boolean(
    workspaceStatus &&
    workspaceStatus.workingTree.changedFiles > 0,
  );
  const canExpandPromptChangeList = Boolean(
    canUseGitUi &&
    workspaceStatus &&
    (workspaceWorkingTree?.files.length ?? 0) > 0,
  );
  const promptBannerMergeBaseBranch = effectiveMergeBaseBranch;
  const threadEnvironmentType =
    threadEnvironmentLabel ??
    (environment ? "environment" : undefined);
  const threadEnvironmentValue: ReactNode | undefined = threadEnvironmentLabel ?? undefined;
  const threadBranchName = workspaceBranch?.currentBranch ?? undefined;
  const showWorkspaceStatus =
    canUseGitUi &&
    (Boolean(workspaceStatus) || Boolean(workspaceStatusError)) &&
    !(thread.archivedAt != null && environment?.managed !== true);
  const threadGitStatusDisplay = getGitStatusDisplay(
    workspaceStatus,
    {
      mergeBaseBranch,
      showBranchComparison: showBranchComparisonUi,
    },
  );
  const threadGitStatusLabelClass = workspaceWorkingTree?.state === "deleted"
    ? "text-destructive"
    : workspaceWorkingTree?.state === "untracked"
      ? "text-muted-foreground"
      : "text-foreground";
  const showThreadChangedFiles = canUseGitUi && Boolean(
    workspaceStatus &&
      workspaceWorkingTree?.state !== "clean" &&
      (workspaceWorkingTree?.files.length ?? 0) > 0,
  );
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
  const threadActionsDisabled =
    archiveThread.isPending ||
    unarchiveThread.isPending ||
    markThreadRead.isPending ||
    markThreadUnread.isPending ||
    deleteThread.isPending ||
    updateThread.isPending ||
    updateEnvironment.isPending;
  const handleCopyThreadBranch = async () => {
    if (!threadBranchName) {
      return;
    }
    if (typeof navigator === "undefined" || !navigator.clipboard?.writeText) {
      toast.error("Failed to copy branch name");
      return;
    }
    try {
      await navigator.clipboard.writeText(threadBranchName);
      toast.success("Branch name copied");
    } catch {
      toast.error("Failed to copy branch name");
    }
  };
  const threadActionsMenu = (
    <ThreadActionsMenu
      triggerClassName="h-7 w-7 rounded-md p-0 text-muted-foreground"
      disabled={threadActionsDisabled}
      align="end"
      isRead={(thread.lastReadAt ?? 0) >= thread.updatedAt}
      onToggleRead={() => {
        if ((thread.lastReadAt ?? 0) >= thread.updatedAt) {
          markThreadUnread.mutate(thread.id);
          return;
        }
        markThreadRead.mutate(thread.id);
      }}
      onRename={renameThread}
      onToggleArchive={() => {
        void toggleArchiveThread();
      }}
      onDelete={() => {
        threadDeleteDialog.onOpen(thread);
      }}
      viewerToggleLabel={isManagerThread ? "Show all events" : undefined}
      viewerToggleChecked={isManagerThread ? showAllEvents : undefined}
      onViewerToggleCheckedChange={
        isManagerThread ? handleShowAllEventsChange : undefined
      }
      isArchived={thread.archivedAt != null}
      threadType={thread.type}
    />
  );
  const effectiveSecondaryPanel =
    !canUseGitUi && activeSecondaryPanel === "git-diff"
      ? "thread-info"
      : !isManagerThread && activeSecondaryPanel === "thread-storage"
        ? "thread-info"
        : activeSecondaryPanel;
  const hasParsedGitDiffFiles = parsedGitDiffFileEntries.length > 0;
  const timelineHeader = (
    <ThreadDetailHeader
      actionsMenu={threadActionsMenu}
      isManagedThread={Boolean(parentThreadId)}
      isManagerThread={isManagerThread}
      isSecondaryPanelOpen={isSecondaryPanelOpen}
      isThreadGitActionPending={gitActions.isThreadGitActionPending}
      onOpenThreadGitAction={gitActions.threadGitActionDialog.onOpen}
      onToggleSecondaryPanel={toggleThreadSecondaryPanel}
      threadHeaderGitAction={gitActions.threadHeaderGitAction}
      threadTitle={threadTitle}
    />
  );
  const composerFooter = (
    <ThreadDetailPromptArea
      canExpandPromptChangeList={canExpandPromptChangeList}
      canUseGitUi={canUseGitUi}
      contextWindowUsage={contextWindowUsage}
      environmentLabel={threadEnvironmentValue}
      isDiffPanelActive={isDiffPanelActive}
      isEnvironmentActionPending={requestEnvironmentAction.isPending}
      isLoadingMergeBaseBranchOptions={isLoadingMergeBaseBranchOptions}
      mergeBaseBranchOptions={mergeBaseBranchOptions}
      onMergeBaseBranchChange={
        showBranchComparisonUi ? handleMergeBaseBranchChange : undefined
      }
      onMergeBaseBranchPickerOpenChange={
        showBranchComparisonUi ? onMergeBaseBranchPickerOpenChange : undefined
      }
      openDiffFile={openDiffFile}
      openThreadDiffPanel={openThreadDiffPanel}
      projectId={projectId}
      promptBannerMergeBaseBranch={promptBannerMergeBaseBranch}
      promptBannerSummary={promptBannerSummary}
      promptComposerRef={promptComposerRef}
      scrollToBottom={scrollToBottom}
      sendMessage={sendMessage}
      showBranchComparisonUi={showBranchComparisonUi}
      showPromptGitStatsBanner={showPromptGitStatsBanner}
      showScrollToBottom={showScrollToBottom}
      thread={thread}
      threadDetailRows={threadDetailRows}
      workspaceStatus={workspaceStatus}
    />
  );
  const threadStorage = thread.type === "manager"
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
        isSecondaryPanelOpen={isSecondaryPanelOpen}
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
          onMergeBaseBranchPickerOpenChange: onMergeBaseBranchPickerOpenChange,
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
          threadEnvironmentType,
          threadEnvironmentValue,
          threadGitStatusDisplay,
          threadGitStatusLabelClass,
          mergeBaseBranch,
          mergeBaseCandidates,
          unarchivePending:
            unarchiveThread.isPending &&
            unarchiveThread.variables?.id === thread.id,
          updateThreadPending: updateThread.isPending || updateEnvironment.isPending,
          workspaceStatusFiles: workspaceWorkingTree?.files,
        }}
        secondaryPanel={{
          activePanel: effectiveSecondaryPanel,
          areAllGitDiffFilesCollapsed: canUseGitUi ? areAllGitDiffFilesCollapsed : true,
          collapsedGitDiffFileKeys,
          currentGitDiff: canUseGitUi ? currentGitDiff : "",
          gitDiffDisplayMode,
          gitDiffError: canUseGitUi ? gitDiffError : undefined,
          gitDiffSelectOptions,
          gitDiffSelectValue,
          gitDiffStatsLabel: canUseGitUi ? gitDiffStatsLabel : "",
          gitDiffViewOptions,
          hasParsedGitDiffFiles: canUseGitUi ? hasParsedGitDiffFiles : false,
          isGitDiffLoading: canUseGitUi ? isGitDiffLoading : false,
          isOpen: isSecondaryPanelOpen,
          isParsingGitDiffFiles: canUseGitUi ? isParsingGitDiffFiles : false,
          isPreparingGitDiff: canUseGitUi ? isPreparingGitDiff : false,
          isResizing: isSecondaryPanelResizing,
          loadingGitDiffFileKeys,
          onClose: closeThreadSecondaryPanel,
          onCollapse: closeThreadSecondaryPanel,
          onDragging: handleSecondaryPanelDragging,
          onGitDiffDisplayModeChange: handleGitDiffDisplayModeChange,
          onGitDiffSelectionChange: onGitDiffSelectionChange,
          onOpenFile:
            environment?.path && isLocalHost(environment.hostId)
              ? (relativePath: string) => {
                  const fullPath = `${environment.path}/${relativePath}`;
                  void openPath?.(fullPath);
                }
              : undefined,
          onPanelChange: openThreadSecondaryPanel,
          onResize: handleSecondaryPanelResize,
          onToggleAllFiles: toggleAllGitDiffFilesCollapsed,
          onToggleGitDiffFileCollapsed: toggleGitDiffFileCollapsed,
          panelRef: secondaryPanelRef,
          parsedGitDiffFileEntries: canUseGitUi ? parsedGitDiffFileEntries : [],
          queuedGitDiffFileRenderKeys,
          resizablePanelRef: secondaryResizablePanelRef,
          setGitDiffFileRef,
          showGitDiffTab: canUseGitUi,
          showThreadStorageTab: thread.type === "manager",
          threadGitDiff: canUseGitUi ? threadGitDiff : undefined,
          threadId: thread.id,
        }}
        showThreadMetadata={showThreadMetadata}
        timeline={{
          bottomSentinelRef,
          isReasoningBlockActive,
          isThreadTimelinePending,
          isTransientThreadLoadError,
          latestActivityRowId,
          loadingToolGroupIds,
          onLoadToolGroupMessages: handleLoadToolGroupMessages,
          onScroll: handleTimelineScroll,
          projectId,
          scrollRef: setContainerRef,
          showOngoingIndicator:
            thread.status === "active" &&
            !isThreadTimelinePending,
          threadDetailRows,
          threadId: thread.id,
          threadStatus: thread.status,
          toolGroupMessagesById,
        }}
      />
      <ThreadRenameDialog
        target={threadRenameDialog.target}
        pending={updateThread.isPending}
        onOpenChange={threadRenameDialog.onOpenChange}
        onRename={submitThreadRename}
      />
      <ThreadArchiveConfirmationDialog
        target={threadArchiveConfirmationDialog.target}
        pending={archiveThread.isPending}
        onOpenChange={threadArchiveConfirmationDialog.onOpenChange}
        onArchive={confirmArchiveThread}
      />
      <ThreadDeleteDialog
        target={threadDeleteDialog.target}
        pending={deleteThread.isPending}
        onOpenChange={threadDeleteDialog.onOpenChange}
        onDelete={(target) => {
          deleteThread.mutate(
            { id: target.id },
            {
              onSuccess: () => {
                threadDeleteDialog.onClose();
                navigate(`/projects/${target.projectId}`, { replace: true });
              },
              onError: (nextError) => {
                toast.error(
                  nextError instanceof Error ? nextError.message : `Failed to delete ${threadTypeLabel(target.type)}.`,
                );
              },
            },
          );
        }}
      />
      {canUseGitUi ? (
        <ThreadGitActionDialog
          target={gitActions.threadGitActionDialog.target}
          pending={requestEnvironmentAction.isPending}
          askAgentPending={sendMessage.isPending}
          branchName={threadBranchName}
          gitStatusLabel={threadGitStatusDisplay.label}
          gitStatusSummary={threadGitStatusDisplay.summary}
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
          onMergeBaseBranchPickerOpenChange={
            showBranchComparisonUi ? onMergeBaseBranchPickerOpenChange : undefined
          }
          onOpenChange={(open) => {
            if (!open) {
              gitActions.threadGitActionDialog.onClose();
              onMergeBaseBranchPickerOpenChange(false);
            }
          }}
          onCommit={gitActions.handleCommitThread}
          onSquashMerge={gitActions.handleSquashMergeThread}
          onAskAgentToFix={gitActions.handleAskAgentToFixGitAction}
        />
      ) : null}
    </>
  );
}
