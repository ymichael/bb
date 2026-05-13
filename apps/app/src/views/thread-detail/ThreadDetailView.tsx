import { useCallback, useEffect, useMemo, useState } from "react";
import { useAtomValue } from "jotai";
import { useParams } from "react-router-dom";
import type {
  ThreadTimelineLocalFileLink,
  TimelineTitleActionResolver,
} from "@/components/thread/timeline";
import type {
  ThreadListEntry,
  ThreadWithRuntime,
  WorkspaceFileStatus,
} from "@bb/domain";
import { toast } from "sonner";
import {
  useActiveSecondaryPanel,
  useThreadSecondaryPanelUrlSync,
} from "@/lib/thread-secondary-panel";
import { useRequestEnvironmentAction } from "../../hooks/mutations/environment-mutations";
import {
  useMarkThreadRead,
  useUpdateThread,
} from "../../hooks/mutations/thread-state-mutations";
import { useSendThreadMessage } from "../../hooks/mutations/thread-runtime-mutations";
import { useUpdateEnvironment } from "../../hooks/mutations/environment-mutations";
import {
  useEnvironment,
  useEnvironmentFilePreview,
  useEnvironmentWorkStatus,
} from "../../hooks/queries/environment-queries";
import {
  getLatestPendingInteraction,
  useThread,
  useThreadPendingInteractions,
  useThreads,
} from "../../hooks/queries/thread-queries";
import { ThreadGitActionDialog } from "@/components/dialogs/ThreadGitActionDialog";
import { PageShell } from "@/components/ui/page-shell.js";
import { HEADER_ICON_BUTTON_CLASS } from "@/components/layout/AppPageHeader";
import { ThreadActionsMenu } from "@/components/thread/ThreadActionsMenu";
import { ThreadWorkspaceOpenButton } from "@/components/thread/ThreadWorkspaceOpenButton";
import { formatEnvironmentDisplay } from "@bb/core-ui";
import { assertNever } from "@bb/thread-view";
import { useHostDaemon } from "@/hooks/useHostDaemon";
import { useLocalOpenTargets } from "@/hooks/useLocalOpenTargets";
import { useConnectionAwareQueryState } from "@/hooks/queries/connection-aware-query-state";
import { useEffectiveHost } from "@/hooks/queries/effective-hosts";
import { getEnvironmentWorkspaceLabelIconName } from "@/lib/environment-workspace-display";
import { useStandardManagerTimelinePreference } from "@/lib/manager-timeline-view-preference";
import { getGitStatusDisplay } from "@/components/workspace/workspace-status";
import { selectWorkspaceChangedFilesSection } from "@/components/workspace/workspace-change-summary";
import { getThreadDisplayTitle } from "@/lib/thread-title";
import { useGitDiffPanel } from "@/components/secondary-panel/git-diff/useGitDiffPanel";
import { useThreadDetailTurnSummaryRows } from "./turn-summary/useThreadDetailTurnSummaryRows";
import { ThreadDetailHeader } from "./ThreadDetailHeader";
import { ThreadDetailPromptArea } from "./ThreadDetailPromptArea";
import {
  type ContextBannerMergeBaseConfig,
  isThreadDisplayStatusBannerActive,
  type ThreadPromptManagedBySection,
  type ThreadPromptManagerChildrenSection,
} from "@/components/promptbox/banner/ThreadPromptContextBanner";
import { ThreadDetailSecondaryContent } from "./ThreadDetailSecondaryContent";
import type { HostConnectionNotice } from "./ThreadTimelinePane";
import { useThreadStorageViewer } from "@/components/secondary-panel/useThreadStorageViewer";
import {
  SecondaryPanelFilePreview,
  ThreadStorageFilePreview,
} from "@/components/secondary-panel/ThreadStorageFilePreview";
import { PINNED_STORAGE_FILE_PATH } from "@/components/secondary-panel/managerStorage";
import { useManagerStorageBrowser } from "@/components/secondary-panel/useManagerStorageBrowser";
import { useThreadFileTabs } from "@/components/secondary-panel/useThreadFileTabs";
import {
  activeStorageFilePathAtom,
  activeWorkspaceFilePathAtom,
} from "@/components/secondary-panel/threadSecondaryPanelAtoms";
import type { SecondaryPanelFileTab } from "@/components/secondary-panel/ThreadSecondaryPanel";
import { useEnvironmentMergeBase } from "@/components/secondary-panel/git-diff/useEnvironmentMergeBase";
import { useThreadGitActions } from "./useThreadGitActions";
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

type MergeBasePickerOpenChangeHandler = NonNullable<
  ContextBannerMergeBaseConfig["onPickerOpenChange"]
>;

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
  const canUseGitUi = thread?.type === "standard";
  const [
    storedUseStandardManagerTimeline,
    setStoredUseStandardManagerTimeline,
  ] = useStandardManagerTimelinePreference();
  const useStandardManagerTimeline =
    isManagerThread && storedUseStandardManagerTimeline;
  const managerTimelineView = useStandardManagerTimeline
    ? "standard"
    : undefined;
  const [hasRequestedMergeBaseOptions, setHasRequestedMergeBaseOptions] =
    useState(false);
  const activeSecondaryPanel = useActiveSecondaryPanel();
  const isSecondaryPanelActive = activeSecondaryPanel !== null;
  const shouldLoadManagerStorageFiles =
    isSecondaryPanelActive && isManagerThread;
  // Read the active storage path directly for the storage viewer query; the
  // file-tabs hook owns mutation but the viewer needs the value before the
  // hook returns (it sits earlier in the render order).
  const activeWorkspaceFilePathForViewer = useAtomValue(
    activeWorkspaceFilePathAtom,
  );
  const rawActiveStorageFilePath = useAtomValue(activeStorageFilePathAtom);
  const activeStorageFilePathForViewer =
    activeWorkspaceFilePathForViewer === null
      ? rawActiveStorageFilePath
      : null;
  const {
    isThreadStorageFilePreviewLoading,
    isThreadStorageFilesLoading,
    threadStorageFilePreview,
    threadStorageFilePreviewError,
    threadStorageFiles,
    threadStorageFilesError,
  } = useThreadStorageViewer({
    activePath: activeStorageFilePathForViewer,
    fileListEnabled: shouldLoadManagerStorageFiles,
    filePreviewEnabled: isSecondaryPanelActive,
    threadId,
    threadType: thread?.type,
  });
  const {
    activateStorageFileTab,
    activateWorkspaceFileTab,
    activeStorageFilePath,
    activeWorkspaceFileLineNumber,
    activeWorkspaceFilePath,
    clearActiveFileTabs,
    closeStorageFileTab,
    closeWorkspaceFileTab,
    openStorageFile,
    openStorageFilePaths,
    openWorkspaceFile,
    openWorkspaceFileTabs,
  } = useThreadFileTabs({
    threadId,
    environmentId: thread?.environmentId,
    isManagerThread,
    storageFiles: threadStorageFiles?.files,
  });
  const storageBrowserController = useManagerStorageBrowser({
    files: threadStorageFiles?.files,
    onSelectPath: openStorageFile,
    selectedPath: activeStorageFilePath,
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
  const environmentMergeBaseBranch =
    environment?.mergeBaseBranch ?? environment?.defaultBranch ?? undefined;
  const {
    data: workspaceFilePreview,
    error: workspaceFilePreviewError,
    isLoading: isWorkspaceFilePreviewLoading,
  } = useEnvironmentFilePreview(thread?.environmentId, activeWorkspaceFilePath);
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
    defaultMergeBaseBranch: environmentMergeBaseBranch,
    environmentId: canUseGitUi
      ? (thread?.environmentId ?? undefined)
      : undefined,
    mergeBaseBranchOptionsEnabled: hasRequestedMergeBaseOptions,
  });
  useEffect(() => {
    setHasRequestedMergeBaseOptions(false);
  }, [thread?.environmentId]);
  const handleMergeBasePickerOpenChange =
    useCallback<MergeBasePickerOpenChangeHandler>((open) => {
      if (open) {
        setHasRequestedMergeBaseOptions(true);
      }
    }, []);
  const handleSecondaryPanelChange = useCallback(
    (panel: Parameters<typeof openThreadSecondaryPanel>[0]) => {
      clearActiveFileTabs();
      openThreadSecondaryPanel(panel);
    },
    [clearActiveFileTabs, openThreadSecondaryPanel],
  );
  const handleChangedFileClick = useCallback(
    (file: WorkspaceFileStatus) => {
      // Added or deleted files have nothing meaningful to diff against — the
      // diff card would just render the full file with +/- gutter. Show the
      // file preview instead so the content is readable.
      if (file.status === "A" || file.status === "??" || file.status === "D") {
        openWorkspaceFile({ lineNumber: null, path: file.path });
        return;
      }
      openDiffFile(file.path);
    },
    [openDiffFile, openWorkspaceFile],
  );
  const fileTabs = useMemo<SecondaryPanelFileTab[] | undefined>(() => {
    const workspaceTabs = openWorkspaceFileTabs.map((tab) => ({
      id: `workspace:${tab.path}`,
      filename: tab.path.split("/").at(-1) ?? tab.path,
      isActive: tab.path === activeWorkspaceFilePath,
      onSelect: () => activateWorkspaceFileTab(tab.path),
      onClose: () => closeWorkspaceFileTab(tab.path),
    }));
    const storageTabs = isManagerThread
      ? openStorageFilePaths.map((path) => ({
          id: `storage:${path}`,
          filename: path.split("/").at(-1) ?? path,
          isActive: path === activeStorageFilePath,
          isPinned: path === PINNED_STORAGE_FILE_PATH,
          onSelect: () => activateStorageFileTab(path),
          onClose: () => closeStorageFileTab(path),
        }))
      : [];
    const tabs = [...workspaceTabs, ...storageTabs];
    return tabs.length > 0 ? tabs : undefined;
  }, [
    activateStorageFileTab,
    activateWorkspaceFileTab,
    activeStorageFilePath,
    activeWorkspaceFilePath,
    closeStorageFileTab,
    closeWorkspaceFileTab,
    isManagerThread,
    openStorageFilePaths,
    openWorkspaceFileTabs,
  ]);
  const requestedMergeBaseBranch =
    selectedMergeBaseBranch ?? environmentMergeBaseBranch;
  const workStatusQuery = useEnvironmentWorkStatus(
    thread?.environmentId,
    requestedMergeBaseBranch,
    {
      enabled: canUseGitUi && environment !== undefined,
    },
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

      openWorkspaceFile({
        lineNumber: resolution.request.lineNumber,
        path: resolution.request.relativePath,
      });
      return true;
    },
    [openWorkspaceFile, localWorkspaceRootPath],
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
    ? getEnvironmentWorkspaceLabelIconName(
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
      isThreadGitActionPending={gitActions.isThreadGitActionPending}
      onOpenThreadGitAction={gitActions.threadGitActionDialog.onOpen}
      onToggleSecondaryPanel={toggleThreadSecondaryPanel}
      threadHeaderGitActions={gitActions.threadHeaderGitActions}
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
      onChangedFileClick={handleChangedFileClick}
      openThreadDiffPanel={openThreadDiffPanel}
      projectId={projectId}
      workspaceChangedFilesSection={
        canUseGitUi ? workspaceChangedFilesSection : null
      }
      workspaceStatusPending={
        canUseGitUi && (environmentQuery.isLoading || workStatusQuery.isLoading)
      }
      contextBannerMergeBase={
        canUseGitUi && showMergeBase && promptBannerMergeBaseBranch
          ? {
              branch: promptBannerMergeBaseBranch,
              options: mergeBaseBranchOptions,
              optionsLoading: isLoadingMergeBaseBranchOptions,
              onChange: handleMergeBaseBranchChange,
              onPickerOpenChange: handleMergeBasePickerOpenChange,
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
  const handleOpenFileInEditor =
    localWorkspaceRootPath && canOpenPreferredTarget
      ? (relativePath: string) => {
          const fullPath = `${localWorkspaceRootPath}/${relativePath}`;
          void openPathInPreferredTarget({
            lineNumber: null,
            path: fullPath,
            workspaceRootPath: localWorkspaceRootPath,
          });
        }
      : undefined;
  const fileTabContent = activeWorkspaceFilePath ? (
    <SecondaryPanelFilePreview
      activePath={activeWorkspaceFilePath}
      error={workspaceFilePreviewError}
      filePreview={workspaceFilePreview}
      isLoading={isWorkspaceFilePreviewLoading}
      lineNumber={activeWorkspaceFileLineNumber}
      onOpenInEditor={handleOpenFileInEditor}
    />
  ) : activeStorageFilePath ? (
    <ThreadStorageFilePreview
      activePath={activeStorageFilePath}
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
        isMetadataLoading={environmentQuery.isLoading}
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
          onChangedFileClick: canUseGitUi ? handleChangedFileClick : undefined,
        }}
        secondaryPanel={{
          canUseGitUi,
          defaultMergeBaseBranch: resolvedDefaultMergeBaseBranch,
          environmentId: thread.environmentId ?? undefined,
          fileTabs,
          fileTabContent,
          onClose: closeThreadSecondaryPanel,
          onCollapse: closeThreadSecondaryPanel,
          onOpenFileInEditor: handleOpenFileInEditor,
          onOpenFilePreview: (relativePath: string) => {
            openWorkspaceFile({ lineNumber: null, path: relativePath });
          },
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
    </>
  );
}
