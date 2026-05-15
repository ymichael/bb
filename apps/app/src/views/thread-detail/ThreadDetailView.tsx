import { useCallback, useEffect, useMemo, useState } from "react";
import { useParams } from "react-router-dom";
import type {
  ThreadTimelineLocalFileLink,
  TimelineTitleActionResolver,
} from "@/components/thread/timeline";
import type { ThreadListEntry, ThreadWithRuntime } from "@bb/domain";
import { toast } from "sonner";
import {
  useThreadSecondaryPanelState,
  useThreadSecondaryPanelStorageMaintenance,
  useThreadSecondaryPanelUrlSync,
  useTouchThreadSecondaryPanelState,
  type ThreadSecondaryPanel as ThreadSecondaryPanelTab,
} from "@/lib/thread-secondary-panel";
import { getActiveStorageFilePath } from "@/lib/thread-secondary-panel-state";
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
  useThreadComposerBootstrap,
  useThreadDetailBootstrap,
  useThreadHostFilePreview,
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
import {
  selectWorkspaceChangedFilesSection,
  type WorkspaceChangedFileSelection,
} from "@/components/workspace/workspace-change-summary";
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
import { useThreadSecondaryPanelVisibility } from "./useThreadSecondaryPanelVisibility";
import type { HostConnectionNotice } from "./ThreadTimelinePane";
import { useThreadStorageViewer } from "@/components/secondary-panel/useThreadStorageViewer";
import {
  SecondaryPanelFilePreview,
  ThreadStorageFilePreview,
} from "@/components/secondary-panel/ThreadStorageFilePreview";
import { PINNED_STORAGE_FILE_PATH } from "@/components/secondary-panel/managerStorage";
import { useManagerStorageBrowser } from "@/components/secondary-panel/useManagerStorageBrowser";
import { useThreadFileTabs } from "@/components/secondary-panel/useThreadFileTabs";
import type { SecondaryPanelFileTab } from "@/components/secondary-panel/ThreadSecondaryPanel";
import { useEnvironmentMergeBase } from "@/components/secondary-panel/git-diff/useEnvironmentMergeBase";
import { useThreadGitActions } from "./useThreadGitActions";
import { useThreadReadTracking } from "./useThreadReadTracking";
import { useThreadTimelinePages } from "./useThreadTimelinePages";
import {
  buildOpenInEditorHandler,
  resolveWorkspaceChangedFileOpenTarget,
  resolveThreadLocalWorkspaceRootPath,
  resolveThreadWorkspaceOpenPath,
} from "./threadWorkspaceOpenPath";
import { resolveThreadLocalFileLink } from "@/lib/thread-local-file-links";
import {
  buildManagerSelectorOptions,
  isUnassignedStandardThread,
} from "./threadManagerSelectorOptions";
import { useIsCompactViewport } from "@/components/ui/hooks/use-compact-viewport";

const EMPTY_MANAGER_THREADS: readonly ThreadListEntry[] = [];

type MergeBasePickerOpenChangeHandler = NonNullable<
  ContextBannerMergeBaseConfig["onPickerOpenChange"]
>;
type SecondaryPanelChangeHandler = (panel: ThreadSecondaryPanelTab) => void;

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
  useThreadSecondaryPanelStorageMaintenance(threadId);
  useThreadSecondaryPanelUrlSync(threadId);
  const secondaryPanelState = useThreadSecondaryPanelState(threadId);
  const activeSecondaryPanel = secondaryPanelState.activePanel;
  const renderSecondaryPanelAsDrawer = useIsCompactViewport();
  const touchSecondaryPanelState = useTouchThreadSecondaryPanelState(threadId);
  const threadDetailBootstrapQuery = useThreadDetailBootstrap(threadId ?? "");
  const hasThreadDetailBootstrapSettled =
    threadDetailBootstrapQuery.isSuccess || threadDetailBootstrapQuery.isError;
  const {
    data: thread,
    isFetching,
    isLoadingError,
    isPlaceholderData,
    error,
  } = useThread(threadId ?? "", {
    enabled: hasThreadDetailBootstrapSettled,
    refetchOnMount: threadDetailBootstrapQuery.isSuccess ? true : "always",
  });
  const threadQueryState = useConnectionAwareQueryState({
    hasResolvedData: thread !== undefined && !isPlaceholderData,
    isFetching: threadDetailBootstrapQuery.isFetching || isFetching,
    isLoadingError,
  });
  const threadComposerBootstrapQuery = useThreadComposerBootstrap(
    thread?.id ?? "",
    {
      enabled: threadQueryState.status === "ready" && Boolean(thread?.id),
      environmentId: thread?.environmentId ?? undefined,
    },
  );
  const hasThreadComposerBootstrapSettled =
    threadComposerBootstrapQuery.isSuccess ||
    threadComposerBootstrapQuery.isError;
  const composerSeededStaleTime = threadComposerBootstrapQuery.isSuccess
    ? 10_000
    : undefined;
  const { data: parentThread } = useThread(thread?.parentThreadId ?? "");
  const { data: pendingInteractions = [] } = useThreadPendingInteractions(
    thread?.id ?? "",
    {
      enabled: hasThreadComposerBootstrapSettled,
      refetchOnMount: threadComposerBootstrapQuery.isSuccess ? false : "always",
      staleTime: composerSeededStaleTime,
    },
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
  const isSecondaryPanelActive = activeSecondaryPanel !== null;
  const shouldLoadManagerStorageFiles =
    isSecondaryPanelActive && isManagerThread;
  const activeStorageFilePathForViewer = isManagerThread
    ? getActiveStorageFilePath(secondaryPanelState)
    : null;
  const {
    isThreadStorageFilePreviewLoading,
    isThreadStorageFilesLoading,
    threadStorageFilePreview,
    threadStorageFilePreviewError,
    threadStorageFiles,
    threadStorageFilesError,
    threadStorageRootPath,
  } = useThreadStorageViewer({
    activePath: activeStorageFilePathForViewer,
    fileListEnabled: shouldLoadManagerStorageFiles,
    filePreviewEnabled: isSecondaryPanelActive,
    threadId,
    threadType: thread?.type,
  });
  const {
    activateHostFileTab,
    activateStorageFileTab,
    activateWorkspaceFileTab,
    activeHostFileLineNumber,
    activeHostFilePath,
    activeStorageFilePath,
    activeWorkspaceFileLineNumber,
    activeWorkspaceFilePath,
    activeWorkspaceFileSource,
    activeWorkspaceFileStatusLabel,
    clearActiveFileTabs,
    closeHostFileTab,
    closeStorageFileTab,
    closeWorkspaceFileTab,
    openHostFile,
    openHostFileTabs,
    openStorageFile,
    openStorageFilePaths,
    openWorkspaceFile,
    openWorkspaceFileTabs,
  } = useThreadFileTabs({
    threadId,
    environmentId: thread?.environmentId,
    threadType: thread?.type,
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
  const environmentQuery = useEnvironment(thread?.environmentId, {
    enabled: hasThreadDetailBootstrapSettled,
    staleTime: 5_000,
  });
  const environment = environmentQuery.data;
  const environmentMergeBaseBranch =
    environment?.mergeBaseBranch ?? environment?.defaultBranch ?? undefined;
  const {
    data: workspaceFilePreview,
    error: workspaceFilePreviewError,
    isLoading: isWorkspaceFilePreviewLoading,
  } = useEnvironmentFilePreview(
    thread?.environmentId,
    activeWorkspaceFilePath,
    activeWorkspaceFileSource,
  );
  const {
    data: hostFilePreview,
    error: hostFilePreviewError,
    isLoading: isHostFilePreviewLoading,
  } = useThreadHostFilePreview(
    thread?.id ?? "",
    thread?.environmentId,
    activeHostFilePath,
    {
      enabled: isSecondaryPanelActive && activeHostFilePath !== null,
    },
  );
  const {
    closeThreadSecondaryPanel,
    defaultMergeBaseBranch: resolvedDefaultMergeBaseBranch,
    isLoadingMergeBaseBranchOptions,
    mergeBaseBranchOptions,
    openDiffFile: openPersistedDiffFile,
    openThreadDiffPanel: openPersistedDiffPanel,
    openThreadSecondaryPanel: openPersistedSecondaryPanel,
    selectedMergeBaseBranch,
    setSelectedMergeBaseBranch,
    toggleThreadSecondaryPanel: togglePersistedSecondaryPanel,
  } = useGitDiffPanel({
    clearActiveFileTabs,
    defaultMergeBaseBranch: environmentMergeBaseBranch,
    environmentId: canUseGitUi
      ? (thread?.environmentId ?? undefined)
      : undefined,
    mergeBaseBranchOptionsEnabled: hasRequestedMergeBaseOptions,
    threadId,
  });
  const {
    closePanel: closeSecondaryPanel,
    isOpen: isSecondaryPanelOpen,
    openDiffFile: openSecondaryPanelDiffFile,
    openDiffPanel: openSecondaryPanelDiffPanel,
    openPanel: openSecondaryPanel,
    togglePanel: toggleSecondaryPanel,
  } = useThreadSecondaryPanelVisibility({
    activePanel: activeSecondaryPanel,
    closePersistedPanel: closeThreadSecondaryPanel,
    isCompactViewport: renderSecondaryPanelAsDrawer,
    openPersistedDiffFile,
    openPersistedDiffPanel,
    openPersistedPanel: openPersistedSecondaryPanel,
    threadId,
    togglePersistedPanel: togglePersistedSecondaryPanel,
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
  const handleSecondaryPanelChange = useCallback<SecondaryPanelChangeHandler>(
    (panel) => {
      clearActiveFileTabs();
      openSecondaryPanel(panel);
    },
    [clearActiveFileTabs, openSecondaryPanel],
  );
  const handleChangedFileClick = useCallback(
    (selection: WorkspaceChangedFileSelection) => {
      const openTarget = resolveWorkspaceChangedFileOpenTarget(selection);
      if (openTarget.kind === "preview") {
        openWorkspaceFile({
          lineNumber: null,
          path: selection.file.path,
          source: openTarget.source,
          statusLabel: openTarget.statusLabel,
        });
        return;
      }
      openSecondaryPanelDiffFile(selection.file.path);
    },
    [openSecondaryPanelDiffFile, openWorkspaceFile],
  );
  const fileTabs = useMemo<SecondaryPanelFileTab[] | undefined>(() => {
    const workspaceTabs = openWorkspaceFileTabs.map((tab) => ({
      id: `workspace:${tab.path}`,
      filename: tab.path.split("/").at(-1) ?? tab.path,
      isActive: tab.path === activeWorkspaceFilePath,
      statusLabel: tab.statusLabel,
      onSelect: () => activateWorkspaceFileTab(tab.path),
      onClose: () => closeWorkspaceFileTab(tab.path),
    }));
    const storageTabs = isManagerThread
      ? openStorageFilePaths.map((path) => ({
          id: `storage:${path}`,
          filename: path.split("/").at(-1) ?? path,
          isActive: path === activeStorageFilePath,
          isPinned: path === PINNED_STORAGE_FILE_PATH,
          statusLabel: null,
          onSelect: () => activateStorageFileTab(path),
          onClose: () => closeStorageFileTab(path),
        }))
      : [];
    const hostFileTabs = openHostFileTabs.map((tab) => ({
      id: `host-file:${tab.path}`,
      filename: tab.path.split("/").at(-1) ?? tab.path,
      isActive: tab.path === activeHostFilePath,
      statusLabel: null,
      onSelect: () => activateHostFileTab(tab.path),
      onClose: () => closeHostFileTab(tab.path),
    }));
    const tabs = [...workspaceTabs, ...hostFileTabs, ...storageTabs];
    return tabs.length > 0 ? tabs : undefined;
  }, [
    activateHostFileTab,
    activateStorageFileTab,
    activateWorkspaceFileTab,
    activeHostFilePath,
    activeStorageFilePath,
    activeWorkspaceFilePath,
    closeHostFileTab,
    closeStorageFileTab,
    closeWorkspaceFileTab,
    isManagerThread,
    openHostFileTabs,
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
    enabled: threadEnvironmentIsLocal,
  });
  const bootstrapResolvedMissingEnvironmentHost =
    threadDetailBootstrapQuery.isSuccess &&
    threadDetailBootstrapQuery.data.environment !== undefined &&
    threadDetailBootstrapQuery.data.environment !== null &&
    threadDetailBootstrapQuery.data.host === null;
  const { data: environmentHost } = useEffectiveHost(environment?.hostId, {
    enabled: !bootstrapResolvedMissingEnvironmentHost,
  });
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
        hostFileLinksAvailable:
          thread?.environmentId !== null && thread?.environmentId !== undefined,
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

      if (resolution.kind === "open-workspace-path") {
        openWorkspaceFile({
          lineNumber: resolution.request.lineNumber,
          path: resolution.request.relativePath,
          source: { kind: "working-tree" },
          statusLabel: null,
        });
        return true;
      }

      openHostFile({
        lineNumber: resolution.request.lineNumber,
        path: resolution.request.path,
      });
      return true;
    },
    [
      localWorkspaceRootPath,
      openHostFile,
      openWorkspaceFile,
      thread?.environmentId,
    ],
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
            openSecondaryPanelDiffFile(action.path);
          };
        default:
          // Surfaces a compile-time error if a future TimelineTitleAction
          // variant is added without app-side handling, instead of silently
          // returning undefined and leaving a kind unrouted.
          return assertNever(action.kind);
      }
    },
    [isManagerThread, openSecondaryPanelDiffFile],
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
          });
        }}
        onOpenTarget={async (targetId) => {
          await openPathInTarget({
            lineNumber: null,
            path: workspaceOpenPath,
            rememberTarget: true,
            targetId,
          });
        }}
      />
    ) : undefined;
  const timelineHeader = (
    <ThreadDetailHeader
      actionsMenu={threadActionsMenu}
      isManagedThread={Boolean(parentThreadId)}
      isManagerThread={isManagerThread}
      isSecondaryPanelOpen={isSecondaryPanelOpen}
      isThreadGitActionPending={gitActions.isThreadGitActionPending}
      onOpenThreadGitAction={gitActions.threadGitActionDialog.onOpen}
      onToggleSecondaryPanel={toggleSecondaryPanel}
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
      composerQueriesEnabled={hasThreadComposerBootstrapSettled}
      composerQueriesRefetchOnMount={
        threadComposerBootstrapQuery.isSuccess ? false : "always"
      }
      composerQueriesStaleTime={composerSeededStaleTime}
      onChangedFileClick={handleChangedFileClick}
      openThreadDiffPanel={openSecondaryPanelDiffPanel}
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
  const handleOpenFileInEditor = buildOpenInEditorHandler({
    rootPath: localWorkspaceRootPath,
    canOpenPreferredTarget,
    openInPreferredTarget: openPathInPreferredTarget,
  });
  const handleOpenStorageFileInEditor = buildOpenInEditorHandler({
    rootPath: threadEnvironmentIsLocal ? threadStorageRootPath : null,
    canOpenPreferredTarget,
    openInPreferredTarget: openPathInPreferredTarget,
  });
  const handleOpenHostFileInEditor =
    threadEnvironmentIsLocal && canOpenPreferredTarget
      ? (path: string) => {
          void openPathInPreferredTarget({
            lineNumber: activeHostFileLineNumber,
            path,
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
      statusLabel={activeWorkspaceFileStatusLabel}
    />
  ) : activeHostFilePath ? (
    <SecondaryPanelFilePreview
      activePath={activeHostFilePath}
      error={hostFilePreviewError}
      filePreview={hostFilePreview}
      isLoading={isHostFilePreviewLoading}
      lineNumber={activeHostFileLineNumber}
      onOpenInEditor={handleOpenHostFileInEditor}
      statusLabel={null}
    />
  ) : activeStorageFilePath ? (
    <ThreadStorageFilePreview
      activePath={activeStorageFilePath}
      error={threadStorageFilePreviewError}
      filePreview={threadStorageFilePreview}
      isLoading={isThreadStorageFilePreviewLoading}
      onOpenInEditor={handleOpenStorageFileInEditor}
    />
  ) : undefined;

  return (
    <>
      <ThreadDetailSecondaryContent
        footer={composerFooter}
        header={timelineHeader}
        isMetadataLoading={environmentQuery.isLoading}
        isSecondaryPanelOpen={isSecondaryPanelOpen}
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
          activePanel: activeSecondaryPanel,
          canUseGitUi,
          defaultMergeBaseBranch: resolvedDefaultMergeBaseBranch,
          environmentId: thread.environmentId ?? undefined,
          fileTabs,
          fileTabContent,
          isOpen: isSecondaryPanelOpen,
          onClose: closeSecondaryPanel,
          onCollapse: closeSecondaryPanel,
          onOpenFileInEditor: handleOpenFileInEditor,
          onOpenFilePreview: (relativePath: string) => {
            openWorkspaceFile({
              lineNumber: null,
              path: relativePath,
              source: { kind: "working-tree" },
              statusLabel: null,
            });
          },
          onPanelFocus: touchSecondaryPanelState,
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
            thread.stopRequestedAt === null &&
            (thread.runtime.displayStatus === "active" ||
              thread.runtime.displayStatus === "host-reconnecting") &&
            !isThreadTimelinePending,
          ongoingIndicatorLabel: hasPendingInteraction
            ? "Waiting for approval"
            : thread.runtime.displayStatus === "host-reconnecting"
              ? "Waiting for reconnection"
              : undefined,
          timelineRows,
          stopRequestedAt: thread.stopRequestedAt,
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
