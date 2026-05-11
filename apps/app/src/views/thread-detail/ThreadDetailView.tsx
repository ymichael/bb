import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useParams } from "react-router-dom";
import type {
  ThreadTimelineLocalFileLink,
  TimelineTitleActionResolver,
} from "@/components/thread/timeline";
import type { ThreadListEntry, ThreadWithRuntime } from "@bb/domain";
import { toast } from "sonner";
import { useThreadSecondaryPanelUrlSync } from "@/lib/thread-secondary-panel";
import { useRequestEnvironmentAction } from "../../hooks/mutations/environment-mutations";
import {
  useMarkThreadRead,
  useUpdateThread,
} from "../../hooks/mutations/thread-state-mutations";
import { useSendThreadMessage } from "../../hooks/mutations/thread-runtime-mutations";
import { useUpdateEnvironment } from "../../hooks/mutations/environment-mutations";
import {
  useEnvironment,
  useEnvironmentWorkStatus,
} from "../../hooks/queries/environment-queries";
import {
  getLatestPendingInteraction,
  useThread,
  useThreadPendingInteractions,
  useThreads,
} from "../../hooks/queries/thread-queries";
import { ThreadGitActionDialog } from "@/components/thread/dialogs/ThreadGitActionDialog";
import { ThreadEnvironmentPromotionDialog } from "@/components/thread/dialogs/ThreadEnvironmentPromotionDialog";
import { PageShell } from "@/components/ui";
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
import { getGitStatusDisplay } from "@/components/workspace/workspace-status";
import { selectWorkspaceChangedFilesSection } from "@/components/workspace/workspace-change-summary";
import { getThreadDisplayTitle } from "@/lib/thread-title";
import { useGitDiffPanel } from "@/components/secondary-panel/git-diff/useGitDiffPanel";
import { useThreadDetailTurnSummaryRows } from "./turn-summary/useThreadDetailTurnSummaryRows";
import { ThreadDetailHeader } from "./ThreadDetailHeader";
import { ThreadDetailPromptArea } from "./ThreadDetailPromptArea";
import {
  isThreadDisplayStatusBannerActive,
  type ThreadPromptManagedBySection,
  type ThreadPromptManagerChildrenSection,
} from "@/components/promptbox/banner/ThreadPromptContextBanner";
import { ThreadDetailSecondaryContent } from "./ThreadDetailSecondaryContent";
import type { HostConnectionNotice } from "./ThreadTimelinePane";
import { useThreadStorageViewer } from "@/components/secondary-panel/useThreadStorageViewer";
import { ThreadStorageFilePreview } from "@/components/secondary-panel/ThreadStorageFilePreview";
import { PINNED_STORAGE_FILE_PATH } from "@/components/secondary-panel/managerStorage";
import { useManagerStorageBrowser } from "@/components/secondary-panel/useManagerStorageBrowser";
import type { SecondaryPanelFileTab } from "@/components/secondary-panel/ThreadSecondaryPanel";
import { useEnvironmentMergeBase } from "@/components/secondary-panel/git-diff/useEnvironmentMergeBase";
import { useThreadGitActions } from "./useThreadGitActions";
import { useThreadEnvironmentPromotionActions } from "./useThreadEnvironmentPromotionActions";
import { useThreadReadTracking } from "./useThreadReadTracking";
import { useThreadTimelinePages } from "./useThreadTimelinePages";
import {
  resolveThreadLocalWorkspaceRootPath,
  resolveThreadWorkspaceOpenPath,
} from "./threadWorkspaceOpenPath";
import { resolveThreadLocalFileLink } from "@/lib/thread-local-file-links";
import {
  buildManagerSelectorOptions,
  isUnassignedStandardThread,
} from "./threadManagerSelectorOptions";

const EMPTY_MANAGER_THREADS: readonly ThreadListEntry[] = [];

function arePathListsEqual(
  a: readonly string[],
  b: readonly string[],
): boolean {
  if (a.length !== b.length) return false;
  for (let index = 0; index < a.length; index += 1) {
    if (a[index] !== b[index]) return false;
  }
  return true;
}

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
  const [openFilePaths, setOpenFilePaths] = useState<string[]>([]);
  const [activeFilePath, setActiveFilePath] = useState<string | null>(null);
  const hasDefaultedToPinnedFileRef = useRef(false);
  const {
    isThreadStorageFilePreviewLoading,
    isThreadStorageFilesLoading,
    threadStorageFilePreview,
    threadStorageFilePreviewError,
    threadStorageFiles,
    threadStorageFilesError,
  } = useThreadStorageViewer({
    activePath: activeFilePath,
    threadId,
    threadType: thread?.type,
  });

  // Pin STATUS.md for manager threads as soon as we know the thread type —
  // don't wait for the file list to load, so the tab strip and preview render
  // immediately. If the file later turns out to be missing the prune effect
  // below cleans up.
  useEffect(() => {
    if (!isManagerThread) return;
    setOpenFilePaths((prev) => {
      if (prev[0] === PINNED_STORAGE_FILE_PATH) return prev;
      const withoutPinned = prev.filter(
        (path) => path !== PINNED_STORAGE_FILE_PATH,
      );
      return [PINNED_STORAGE_FILE_PATH, ...withoutPinned];
    });
    if (hasDefaultedToPinnedFileRef.current) return;
    hasDefaultedToPinnedFileRef.current = true;
    setActiveFilePath((prev) => prev ?? PINNED_STORAGE_FILE_PATH);
  }, [isManagerThread]);

  // Prune any open tab whose file no longer appears in the latest file list.
  useEffect(() => {
    const files = threadStorageFiles?.files;
    if (!files) return;
    const known = new Set(files.map((file) => file.path));
    setOpenFilePaths((prev) => {
      const next = prev.filter((path) => known.has(path));
      return arePathListsEqual(next, prev) ? prev : next;
    });
    setActiveFilePath((prev) =>
      prev !== null && !known.has(prev) ? null : prev,
    );
  }, [threadStorageFiles?.files]);

  const handleOpenStorageFile = useCallback((path: string) => {
    setOpenFilePaths((prev) => (prev.includes(path) ? prev : [...prev, path]));
    setActiveFilePath(path);
  }, []);
  const handleCloseStorageFileTab = useCallback((path: string) => {
    if (path === PINNED_STORAGE_FILE_PATH) return;
    setOpenFilePaths((prev) => prev.filter((openPath) => openPath !== path));
    setActiveFilePath((prev) => (prev === path ? null : prev));
  }, []);
  const handleActivateStorageFileTab = useCallback((path: string) => {
    setActiveFilePath(path);
  }, []);
  const storageBrowserController = useManagerStorageBrowser({
    files: threadStorageFiles?.files,
    onSelectPath: handleOpenStorageFile,
    selectedPath: activeFilePath,
  });
  const fileTabs = useMemo<SecondaryPanelFileTab[] | undefined>(() => {
    if (!isManagerThread || openFilePaths.length === 0) {
      return undefined;
    }
    return openFilePaths.map((path) => ({
      id: path,
      filename: path.split("/").at(-1) ?? path,
      isActive: path === activeFilePath,
      isPinned: path === PINNED_STORAGE_FILE_PATH,
      onSelect: () => handleActivateStorageFileTab(path),
      onClose: () => handleCloseStorageFileTab(path),
    }));
  }, [
    isManagerThread,
    openFilePaths,
    activeFilePath,
    handleActivateStorageFileTab,
    handleCloseStorageFileTab,
  ]);
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
    activeThinking,
    contextWindowUsage,
    hasOlderTimelineRows,
    isLoadingOlderTimelineRows,
    loadOlderTimelineRows,
    pendingTodos,
    timelineError,
    timelineLoading,
    timelineRows,
  } = useThreadTimelinePages({
    managerTimelineView,
    threadId: threadId ?? "",
  });
  const sendMessage = useSendThreadMessage();
  const requestEnvironmentAction = useRequestEnvironmentAction();
  const markThreadRead = useMarkThreadRead();
  const updateEnvironment = useUpdateEnvironment();
  const updateThread = useUpdateThread();
  const hostConnectionNotice = useMemo(
    () => (thread ? buildHostConnectionNotice(thread) : null),
    [thread],
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
  const handleSecondaryPanelChange = useCallback(
    (panel: Parameters<typeof openThreadSecondaryPanel>[0]) => {
      setActiveFilePath(null);
      openThreadSecondaryPanel(panel);
    },
    [openThreadSecondaryPanel],
  );
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
  const managedChildrenQuery = useThreads(
    {
      archived: false,
      projectId,
      parentThreadId: thread?.id,
    },
    {
      enabled: isManagerThread && Boolean(thread?.id),
    },
  );
  const managedBySection: ThreadPromptManagedBySection | null = useMemo(() => {
    if (!thread?.parentThreadId) return null;
    const href = `/projects/${projectId}/threads/${thread.parentThreadId}`;
    if (parentThread === undefined) {
      // Parent record not yet loaded — show id-based fallback so the user
      // doesn't get a flicker of "no manager" before resolution.
      return {
        managerName: `Manager ${thread.parentThreadId.slice(0, 8)}`,
        href,
      };
    }
    // Plan ownership invariants: silently exclude dirty references rather
    // than rendering a stale or unreachable manager link.
    if (
      parentThread.type !== "manager" ||
      parentThread.archivedAt !== null ||
      parentThread.deletedAt !== null ||
      parentThread.projectId !== thread.projectId
    ) {
      return null;
    }
    return {
      managerName: getThreadDisplayTitle(parentThread),
      href,
    };
  }, [parentThread, projectId, thread?.parentThreadId, thread?.projectId]);
  const managerChildrenSection: ThreadPromptManagerChildrenSection | null =
    useMemo(() => {
      if (!isManagerThread) return null;
      const list = managedChildrenQuery.data ?? [];
      // Server already filters archived: false; the banner predicate only
      // gates on runtime display status.
      const activeItems = list
        .filter((entry) =>
          isThreadDisplayStatusBannerActive(entry.runtime.displayStatus),
        )
        .map((entry) => ({
          id: entry.id,
          title: getThreadDisplayTitle(entry),
          href: `/projects/${projectId}/threads/${entry.id}`,
        }));
      if (activeItems.length === 0) return null;
      return { items: activeItems };
    }, [isManagerThread, managedChildrenQuery.data, projectId]);
  const isThreadTimelinePending = timelineLoading && timelineRows.length === 0;
  const {
    erroredTurnSummaryIds,
    handleLoadTurnSummaryRows,
    loadingTurnSummaryIds,
    turnSummaryRowsById,
  } = useThreadDetailTurnSummaryRows({
    managerTimelineView,
    timelineRows,
    threadId,
  });
  useThreadReadTracking({
    markThreadRead,
    thread,
  });
  const {
    effectiveMergeBaseBranch,
    handleMergeBaseBranchChange,
    showBranchComparisonUi,
    showMergeBase,
    mergeBaseBranch,
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
        toast.error("Failed to open file locally", {
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
  const turnSummaryRowsIdentity = `${thread.id}:${
    managerTimelineView ?? "default"
  }`;
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
  const promptBannerMergeBaseBranch = effectiveMergeBaseBranch;
  const threadBranchName = workspaceBranch?.currentBranch ?? undefined;
  const isWorkspaceDeleted = environment?.status === "destroyed";
  const threadGitStatusDisplay = getGitStatusDisplay(workspaceStatus, {
    mergeBaseBranch,
    showBranchComparison: showBranchComparisonUi,
    error: workspaceStatusError,
    workspaceDeleted: isWorkspaceDeleted,
  });
  const threadTitle = getThreadDisplayTitle(thread);
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
      canUseGitUi={canUseGitUi}
      contextWindowUsage={contextWindowUsage}
      environmentBranchName={threadBranchName}
      environmentHostConnected={
        environmentHost && !threadEnvironmentIsLocal
          ? environmentHost.status === "connected"
          : undefined
      }
      environmentIcon={threadEnvironmentIcon ?? undefined}
      environmentLabel={threadEnvironmentDisplay?.modeLabel}
      environmentHostLabel={
        threadEnvironmentDisplay?.location === "remote"
          ? (threadEnvironmentDisplay.hostLabel ?? undefined)
          : undefined
      }
      isEnvironmentActionPending={requestEnvironmentAction.isPending}
      openDiffFile={openDiffFile}
      openThreadDiffPanel={openThreadDiffPanel}
      projectId={projectId}
      workspaceChangedFilesSection={
        canUseGitUi ? workspaceChangedFilesSection : null
      }
      workspaceStatusPending={canUseGitUi && workStatusQuery.isLoading}
      contextBannerMergeBase={
        canUseGitUi && showMergeBase && promptBannerMergeBaseBranch
          ? {
              branch: promptBannerMergeBaseBranch,
              options: mergeBaseBranchOptions,
              optionsLoading: isLoadingMergeBaseBranchOptions,
              onChange: handleMergeBaseBranchChange,
            }
          : null
      }
      sendMessage={sendMessage}
      pendingInteractions={pendingInteractions}
      pendingTodos={pendingTodos}
      managedBySection={managedBySection}
      managerChildrenSection={managerChildrenSection}
      thread={thread}
    />
  );
  const metadataStorage =
    thread.type === "manager"
      ? {
          controller: storageBrowserController,
          filesError: threadStorageFilesError,
          isFilesLoading: isThreadStorageFilesLoading,
        }
      : undefined;
  const fileTabContent = activeFilePath ? (
    <ThreadStorageFilePreview
      activePath={activeFilePath}
      error={threadStorageFilePreviewError}
      filePreview={threadStorageFilePreview}
      isLoading={isThreadStorageFilePreviewLoading}
    />
  ) : undefined;

  return (
    <>
      <ThreadDetailSecondaryContent
        footer={composerFooter}
        header={timelineHeader}
        metadata={{
          thread,
          projectId,
          parentThreadDisplayName: parentThreadDisplayName ?? null,
          managerThreads,
          canAssignToManager,
          canTakeOverThread,
          environmentHost: environmentHost ?? null,
          environmentIsLocal: threadEnvironmentIsLocal,
          environment: environment ?? null,
          workspaceStatus,
          workspaceStatusError: workspaceStatusError ?? null,
          selectedMergeBaseBranch,
          mergeBaseBranchOptions,
          isLoadingMergeBaseBranchOptions,
          updateThreadPending:
            updateThread.isPending || updateEnvironment.isPending,
          storage: metadataStorage,
          onAssignManager: handleAssignManager,
          onMergeBaseBranchChange: handleMergeBaseBranchChange,
          onChangedFileClick: canUseGitUi
            ? (file) => {
                openDiffFile(file.path);
              }
            : undefined,
        }}
        secondaryPanel={{
          canUseGitUi,
          defaultMergeBaseBranch: resolvedDefaultMergeBaseBranch,
          environmentId: thread.environmentId ?? undefined,
          fileTabs,
          fileTabContent,
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
          onPanelChange: handleSecondaryPanelChange,
          showGitDiffTab: canUseGitUi,
        }}
        timeline={{
          activeThinking,
          hasOlderTimelineRows,
          hostConnectionNotice,
          isLoadingOlderTimelineRows,
          isThreadTimelinePending,
          timelineError: Boolean(timelineError),
          loadingTurnSummaryIds,
          erroredTurnSummaryIds,
          onLoadOlderRows: loadOlderTimelineRows,
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
          turnSummaryRowsIdentity,
          turnSummaryRowsById,
          workspaceRootPath: environment?.path ?? undefined,
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
