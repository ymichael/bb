import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { nanoid } from "nanoid";
import { useSystemProviderInfo } from "@/hooks/queries/system-queries";
import { useNavigate } from "react-router-dom";
import { useAtom } from "jotai";
import { desktopBrowserRevealAtom } from "@/lib/desktop-browser-presentation";
import { atomWithStorage } from "jotai/utils";
import {
  isRunningThreadRuntimeDisplayStatus,
  type ThreadTimelineEditMessageHandler,
  type ThreadTimelineEditMessageTarget,
  type ThreadTimelineInlineMessageEditor,
  type ThreadTimelineForkMessageHandler,
  type ThreadTimelineSendToMainMessageHandler,
  type ThreadTimelineLinkHandler,
  type ThreadTimelineLocalFileLink,
  type ThreadTimelineLocalFileLinkHandler,
  type ThreadTimelineOpenPluginPanelHandler,
  type TimelineTitleActionResolver,
  useThreadTimelineController,
} from "@/components/thread/timeline";
import { serializePluginPanelParams } from "@/lib/plugin-json-value";
import { ThreadProviderContext } from "@/components/thread/thread-provider-context";
import {
  defaultAppSettings,
  resolveEnvironmentMergeBaseBranch,
  type ThreadListEntry,
  type ThreadWithRuntime,
} from "@bb/domain";
import type {
  PullRequestMergeMethod,
  TerminalSession,
  TimelineRow,
} from "@bb/server-contract";
import type { WorkspaceOpenTarget } from "@bb/host-daemon-contract";
import { appToast } from "@/components/ui/app-toast";
import { copyToClipboardWithToast } from "@/lib/clipboard";
import type { ThreadSecondaryPanel as ThreadSecondaryPanelTab } from "@/lib/thread-secondary-panel";
import { useForkThreadFromMessage } from "@/hooks/useForkThreadFromMessage";
import { isThreadForkable } from "@bb/client-core";
import { useRequestEnvironmentAction } from "../../hooks/mutations/environment-mutations";
import {
  useMarkThreadRead,
  useUpdateThread,
} from "../../hooks/mutations/thread-state-mutations";
import {
  useCreateThreadQueuedMessage,
  useEditThreadMessage,
  useSendThreadMessage,
} from "../../hooks/mutations/thread-runtime-mutations";
import { useUpdateEnvironment } from "../../hooks/mutations/environment-mutations";
import {
  useEnvironment,
  getEnvironmentPullRequestFromResponse,
  useEnvironmentPullRequest,
  useEnvironmentWorkStatus,
} from "../../hooks/queries/environment-queries";
import {
  useChildThreadPendingAttention,
  type ChildThreadPendingAttentionSource,
} from "../../hooks/queries/child-thread-pending-interactions";
import {
  didThreadDetailBootstrapRefreshAfterMount,
  getLatestPendingInteraction,
  isPendingInteractionStateUnknown,
  useChildThreads,
  useProjectThreadSubset,
  useThread,
  useThreadDetailBootstrap,
  useThreadPendingInteractions,
  useThreadQueuedMessages,
  type ProjectThreadSubsetFilters,
} from "../../hooks/queries/thread-queries";
import { isTransientReadError } from "@/hooks/queries/query-helpers";
import { getPromptDraftAccessor } from "@/hooks/usePromptDraftStorage";
import { subscribeComposerFocusRequests } from "@/lib/composer-focus-requests";
import { ThreadGitActionDialog } from "@/components/dialogs/ThreadGitActionDialog";
import { PageShell } from "@/components/ui/page-shell.js";
import { RouteLoadingSkeleton } from "@/components/ui/route-loading-skeleton";
import { HEADER_ICON_BUTTON_CLASS } from "@/components/layout/AppPageHeader";
import {
  ThreadActionsMenu,
  type ThreadActionsMenuResponsiveAction,
} from "@/components/thread/ThreadActionsMenu";
import { PluginThreadHeaderActions } from "@/components/plugin/PluginThreadHeaderActions";
import { ThreadWorkspaceOpenButton } from "@/components/thread/ThreadWorkspaceOpenButton";
import {
  formatEnvironmentDisplay,
  type EnvironmentDisplayHostContext,
} from "@bb/core-ui";
import { assertNever } from "@bb/thread-view";
import { useCreateThreadInWorktree } from "@/hooks/useCreateThreadInWorktree";
import { useHostDaemon } from "@/hooks/useHostDaemon";
import { useLocalOpenTargets } from "@/hooks/useLocalOpenTargets";
import { useHosts } from "@/hooks/queries/host-queries";
import { useSystemConfig } from "@/hooks/queries/system-queries";
import { useConnectionAwareQueryState } from "@/hooks/queries/connection-aware-query-state";
import {
  useCloseThreadTerminal,
  useCreateThreadTerminal,
  useThreadTerminals,
} from "@/hooks/queries/thread-terminal-queries";
import { getEnvironmentWorkspaceSummaryDisplay } from "@/lib/environment-workspace-display";
import { formatWorkspaceCheckoutDisplay } from "@/lib/workspace-checkout-display";
import {
  getAbsoluteDirname,
  isAbsoluteFilePathWithinRoot,
  resolveAbsoluteFilePath,
} from "@/lib/absolute-file-path";
import { getGitStatusDisplay } from "@/components/workspace/workspace-status";
import {
  selectWorkspaceChangedFilesSection,
  type WorkspaceChangedFileSelection,
} from "@/components/workspace/workspace-change-summary";
import { getThreadDisplayTitle } from "@/lib/thread-title";
import { getMutationErrorMessage } from "@/lib/mutation-errors";
import {
  promptInputToDraft,
  type PromptDraftAttachment,
  type PromptDraftState,
} from "@bb/client-core";
import { createLocalStorageEnumStorage } from "@/lib/browser-storage";
import {
  getProjectComposeRoutePath,
  getThreadRoutePath,
  isRoutePath,
  type ThreadRoutePathArgs,
} from "@/lib/route-paths";
import { useGitDiffPanel } from "@/components/secondary-panel/git-diff/useGitDiffPanel";
import {
  createGitDiffFixedTabDestination,
  GIT_DIFF_FIXED_TAB_REFERENCE,
} from "@/components/secondary-panel/git-diff/git-diff-fixed-tab-navigation";
import {
  createThreadInfoFixedTabDestination,
  THREAD_INFO_FIXED_TAB_REFERENCE,
} from "@/components/secondary-panel/thread-info-fixed-tab-navigation";
import { ThreadDetailHeader } from "./ThreadDetailHeader";
import {
  ThreadDetailPromptArea,
  type ThreadDetailSentMessageEdit,
} from "./ThreadDetailPromptArea";
import {
  type ContextBannerMergeBaseConfig,
  isThreadDisplayStatusBannerActive,
  type ThreadPromptParentThreadSection,
  type ThreadPromptChildThreadsSection,
} from "@/components/promptbox/banner/ThreadPromptContextBanner";
import { ThreadDetailSecondaryContent } from "./ThreadDetailSecondaryContent";
import {
  useThreadSecondaryPanelDrawerVisibility,
  useThreadSecondaryPanelVisibility,
  type ThreadSecondaryPanelHostFileOpenHandler,
  type ThreadSecondaryPanelStorageFileOpenHandler,
  type ThreadSecondaryPanelWorkspaceFileOpenHandler,
  type ThreadSecondaryPanelFileOpenOptions,
} from "./useThreadSecondaryPanelVisibility";
import type { HostConnectionNotice } from "@/components/thread/timeline/ThreadTimelineSurface";
import {
  shouldLoadThreadStorageFileList,
  useThreadStorageViewer,
} from "@/components/secondary-panel/useThreadStorageViewer";
import { getThreadConversationCollapsedAtom } from "@/components/secondary-panel/threadSecondaryPanelAtoms";
import { BrowserTabLifecycleObserver } from "@/components/secondary-panel/BrowserTabDeck";
import {
  LazyBrowserTabDeck,
  LazyHostFilePreviewTabContent,
  LazyNewTabPage,
  LazyThreadStorageFilePreviewTabContent,
  LazyThreadTerminalPanel,
  LazyWorkspaceFilePreviewTabContent,
} from "@/components/secondary-panel/lazySecondaryPanelComponents";
import type { BrowserAddressFocusRequest } from "@/components/secondary-panel/BrowserTabContent";
import {
  SIDE_CHAT_PLUGIN_ID,
  SIDE_CHAT_PLUGIN_PANEL_ACTION_ID,
} from "@/lib/side-chat-plugin";
import { RightPanelFileTabIcon } from "@/components/secondary-panel/RightPanelFileTabIcon";
import { COARSE_POINTER_COMPACT_ICON_SIZE_CLASS } from "@bb/shared-ui/coarse-pointer-sizing";
import { PluginIcon } from "@/components/plugin/PluginIcon";
import {
  PluginPanelTabContent,
  usePluginPanelActions,
} from "@/components/plugin/PluginPanelActions";
import { createFileOpenerOriginalTab } from "@/components/plugin/file-opener-tabs";
import {
  PluginThreadPanelNavigationProvider,
  usePublishThreadPanelOpener,
} from "@/components/plugin/plugin-thread-panel-navigation";
import { ThreadTimelineNavigationProvider } from "@/components/thread/timeline/ThreadTimelineNavigationContext";
import { usePluginSlots } from "@/lib/plugin-slots";
import { getFileExtension } from "@/lib/plugin-slot-resolvers";
import { Icon } from "@bb/shared-ui/icon";
import {
  getBbDesktopInfo,
  getDesktopBrowserApi,
  isDesktopBrowserAvailable,
} from "@/lib/bb-desktop";
import {
  openUrlByPreference,
  useOpenLinksInAppBrowserPreference,
} from "@/lib/in-app-browser-link-preference";
import {
  openUrlInExternalBrowser,
  UrlOpenRoutingProvider,
} from "@/lib/url-open-routing";
import {
  AppNavigationHostProvider,
  type AppFilePreviewIntent,
  type AppFixedTabOpenIntent,
} from "@/lib/app-navigation-host";
import { openAppFixedTabFromDestinations } from "@/lib/app-fixed-tab-navigation";
import {
  getFileBasename,
  normalizeExperimentalFileOpenOptions,
  toFilePreviewLineRange,
} from "@/lib/live-file-navigation";
import { getFilePreviewLineRangeStart } from "@bb/client-core";
import { getBrowserUrlHost } from "@/lib/browser-url";
import {
  useThreadStorageBrowser,
  type ThreadStoragePathSelectHandler,
} from "@/components/secondary-panel/useThreadStorageBrowser";
import {
  useThreadFileTabs,
  type FileSearchSelection,
} from "@/components/secondary-panel/useThreadFileTabs";
import { isSecondaryFileTab } from "@bb/client-core";
import { useThreadOpenFileSignal } from "@/components/secondary-panel/useThreadOpenFileSignal";
import type { PromptMentionLinkResolver } from "@/components/promptbox/editor/prompt-mention-link";
import type {
  SecondaryPanelFixedTab,
  SecondaryPanelRenderableTab,
} from "@/components/secondary-panel/ThreadSecondaryPanel";
import { useEnvironmentMergeBase } from "@/components/secondary-panel/git-diff/useEnvironmentMergeBase";
import { useThreadGitActions } from "./useThreadGitActions";
import { useThreadReadTracking } from "@/hooks/useThreadReadTracking";
import { useThreadUnreadDividerState } from "./useThreadUnreadDividerState";
import {
  buildTerminalSyncedSecondaryFileTabs,
  getRetainedTerminalTabId,
  syncTerminalTabsInFixedPanelState,
} from "@/components/secondary-panel/terminalPanelTabs";
import {
  buildOpenInEditorHandler,
  resolveEnvironmentOpenContext,
  resolveWorkspaceChangedFileOpenTarget,
  resolveThreadWorkspaceOpenPath,
} from "./threadWorkspaceOpenPath";
import {
  resolveThreadLocalFileLink,
  type ThreadLocalFileLinkResolution,
} from "@/lib/thread-local-file-links";
import {
  MarkdownLocalFileContextMenuContext,
  type MarkdownLinkRouting,
  type MarkdownLocalFileContextMenuItem,
  type MarkdownLocalFileLinkRouting,
} from "@/components/ui/markdown-link-routing";
import {
  useFixedPanelTabsStorageMaintenance,
  useReconciledFixedPanelTabsState,
  useRemoveFixedRightTerminalTab,
  useSetFixedRightTerminalActiveTerminal,
  useTouchFixedPanelTabsState,
  useUpdateFixedPanelTabsState,
} from "@/lib/fixed-panel-tabs";
import {
  createGitDiffFixedPanelTab,
  createNewTabFixedPanelTab,
  createThreadInfoFixedPanelTab,
  type SecondaryFileFixedPanelTab,
} from "@/lib/fixed-panel-tabs-state";
import { resolveGitDiffTabStatus } from "@/components/secondary-panel/gitDiffTabEligibility";
import { isRootThread } from "./threadParentSelectorOptions";
import { useIsCompactViewport } from "@bb/shared-ui/hooks/use-compact-viewport";
import {
  DEFAULT_TERMINAL_COLS,
  DEFAULT_TERMINAL_ROWS,
} from "@/components/thread/terminal/useThreadTerminalController";
import {
  getActiveFixedSecondaryTab,
  useSetThreadSecondaryPanelSelection,
  useToggleThreadSecondaryPanelSelection,
} from "./threadSecondaryPanelSelection";
import { useRouteState } from "@/hooks/useRouteState";
import { useAppCommandHandler } from "@/components/commands/AppCommandProvider";
import { DefaultPaneContextProvider, usePaneContext } from "./PaneContext";
import { ThreadArchiveCommandHandler } from "./ThreadArchiveCommandHandler";
import { ThreadRenameCommandHandler } from "./ThreadRenameCommandHandler";

const EMPTY_PARENT_THREADS: readonly ThreadListEntry[] = [];
const EMPTY_CHILD_THREAD_ITEMS: readonly ChildThreadPendingAttentionSource[] =
  [];
const EMPTY_PROJECT_THREAD_SUBSET_FILTERS =
  {} satisfies ProjectThreadSubsetFilters;
const EMPTY_TERMINAL_SESSIONS: readonly TerminalSession[] = [];
const DEFAULT_PULL_REQUEST_MERGE_METHOD: PullRequestMergeMethod = "merge";
const PULL_REQUEST_MERGE_METHOD_STORAGE_KEY = "bb.pullRequest.mergeMethod";

function isPullRequestMergeMethod(
  value: string,
): value is PullRequestMergeMethod {
  return value === "merge" || value === "squash" || value === "rebase";
}

const pullRequestMergeMethodAtom = atomWithStorage<PullRequestMergeMethod>(
  PULL_REQUEST_MERGE_METHOD_STORAGE_KEY,
  DEFAULT_PULL_REQUEST_MERGE_METHOD,
  createLocalStorageEnumStorage<PullRequestMergeMethod>(
    isPullRequestMergeMethod,
  ),
  { getOnInit: true },
);

type MergeBasePickerOpenChangeHandler = NonNullable<
  ContextBannerMergeBaseConfig["onPickerOpenChange"]
>;
type SecondaryPanelChangeHandler = (panel: ThreadSecondaryPanelTab) => void;
type OpenInEditorHandler = NonNullable<
  ReturnType<typeof buildOpenInEditorHandler>
>;
type OpenFilePreviewHandler = (relativePath: string) => void;

interface SentMessageEditSession {
  draft: PromptDraftState;
  operationId: string;
  target: ThreadTimelineEditMessageTarget;
  threadId: string;
}

function hasTimelineRowId(
  rows: readonly TimelineRow[],
  rowId: string,
): boolean {
  return rows.some(
    (row) =>
      row.id === rowId ||
      (row.kind === "turn" &&
        row.children !== null &&
        hasTimelineRowId(row.children, rowId)),
  );
}

function getPullRequestMergeLoadingTitle(
  method: PullRequestMergeMethod,
): string {
  switch (method) {
    case "merge":
      return "Merging pull request";
    case "squash":
      return "Squash merging pull request";
    case "rebase":
      return "Rebase merging pull request";
  }
}

interface ThreadDetailViewPageProps {
  surface: "page";
}

interface ThreadDetailViewPaneProps extends ThreadRoutePathArgs {
  surface: "pane";
}

type ThreadDetailViewProps =
  | ThreadDetailViewPageProps
  | ThreadDetailViewPaneProps;

interface BuildMarkdownPreviewLinkRoutingArgs {
  baseDir: string | undefined;
  onOpenLink: ThreadTimelineLinkHandler;
  onOpenLocalFileLink: ThreadTimelineLocalFileLinkHandler;
  rootPath: string | null | undefined;
}

interface ResolveHostFilePreviewLinkRootPathArgs {
  baseDir: string | undefined;
  threadStorageRootPath: string | null;
  workspaceRootPath: string | null;
}

function buildHostConnectionNotice(
  thread: ThreadWithRuntime,
  hostName: string | null,
): HostConnectionNotice | null {
  const displayStatus = thread.runtime.displayStatus;
  if (
    displayStatus !== "host-reconnecting" &&
    displayStatus !== "waiting-for-host"
  ) {
    return null;
  }

  const subject = hostName ?? "Host";
  return {
    label:
      displayStatus === "host-reconnecting"
        ? `${subject} disconnected. Waiting for reconnection...`
        : `${subject} disconnected`,
    tone: displayStatus === "host-reconnecting" ? "pending" : "error",
  };
}

function buildMarkdownPreviewLinkRouting({
  baseDir,
  onOpenLink,
  onOpenLocalFileLink,
  rootPath,
}: BuildMarkdownPreviewLinkRoutingArgs): MarkdownLinkRouting {
  if (rootPath === null || rootPath === undefined) {
    return {
      onOpenLink,
    };
  }

  const localFileRouting: MarkdownLocalFileLinkRouting = {
    absoluteLinks: {
      kind: "contained",
      rootPath,
    },
    onOpenLink: onOpenLocalFileLink,
  };
  if (baseDir !== undefined) {
    localFileRouting.relativeLinks = {
      baseDir,
      rootPath,
    };
  }

  return {
    localFile: localFileRouting,
    onOpenLink,
  };
}

function buildOpenTargetMenuItemLabel(target: WorkspaceOpenTarget): string {
  return `Open in ${target.label}`;
}

function resolveHostFilePreviewLinkRootPath({
  baseDir,
  threadStorageRootPath,
  workspaceRootPath,
}: ResolveHostFilePreviewLinkRootPathArgs): string | null {
  if (baseDir === undefined) {
    return null;
  }

  if (
    workspaceRootPath !== null &&
    isAbsoluteFilePathWithinRoot({
      candidatePath: baseDir,
      rootPath: workspaceRootPath,
    })
  ) {
    return workspaceRootPath;
  }

  if (
    threadStorageRootPath !== null &&
    isAbsoluteFilePathWithinRoot({
      candidatePath: baseDir,
      rootPath: threadStorageRootPath,
    })
  ) {
    return threadStorageRootPath;
  }

  return null;
}

function ThreadDetailNotFound() {
  return (
    <PageShell contentClassName="min-h-full items-center justify-center">
      <p className="py-12 text-center text-sm text-destructive">Not found</p>
    </PageShell>
  );
}

function RoutedThreadDetailView() {
  const { projectId, threadId } = useRouteState();

  if (!projectId || !threadId) {
    return <ThreadDetailNotFound />;
  }

  return (
    <DefaultPaneContextProvider>
      <ThreadDetailViewInternal projectId={projectId} threadId={threadId} />
    </DefaultPaneContextProvider>
  );
}

export function ThreadDetailView(props: ThreadDetailViewProps) {
  if (props.surface === "pane") {
    return <ThreadDetailViewInternal {...props} />;
  }
  return <RoutedThreadDetailView />;
}

function ThreadDetailViewInternal(props: ThreadRoutePathArgs) {
  const { projectId, threadId } = props;
  const { isFocused, navigateInPane, onRequestClose, isBoundedPane } =
    usePaneContext();
  const navigate = useNavigate();
  useFixedPanelTabsStorageMaintenance();
  const systemConfigQuery = useSystemConfig();
  const threadDetailBootstrapQuery = useThreadDetailBootstrap(threadId);
  const hasThreadDetailBootstrapSettled =
    threadDetailBootstrapQuery.isSuccess || threadDetailBootstrapQuery.isError;
  const {
    data: thread,
    isFetching,
    isLoadingError,
    error,
  } = useThread(threadId, {
    enabled: hasThreadDetailBootstrapSettled,
    refetchOnMount: didThreadDetailBootstrapRefreshAfterMount(
      threadDetailBootstrapQuery,
    )
      ? false
      : "always",
  });
  const environmentQuery = useEnvironment(thread?.environmentId, {
    enabled: hasThreadDetailBootstrapSettled,
    staleTime: 5_000,
  });
  const environment = environmentQuery.data;
  const gitDiffTabStatus = resolveGitDiffTabStatus({
    environmentId: thread?.environmentId ?? null,
    environmentIsGitRepo: environment?.isGitRepo,
    environmentLoadFailed: environmentQuery.isError,
    hasResolvedThread: thread !== undefined,
  });
  const threadFixedViewTabs = useMemo(
    () => [
      createThreadInfoFixedPanelTab(),
      ...(gitDiffTabStatus === "ineligible"
        ? []
        : [createGitDiffFixedPanelTab()]),
    ],
    [gitDiffTabStatus],
  );
  const fixedPanelTabsState = useReconciledFixedPanelTabsState({
    fixedTabs: threadFixedViewTabs,
    isAuthoritative:
      gitDiffTabStatus === "eligible" || gitDiffTabStatus === "ineligible",
    panelStateId: threadId,
    syncThreadId: threadId,
  });
  const isPersistedSecondaryPanelOpen = fixedPanelTabsState.secondary.isOpen;
  const activeFixedSecondaryTab = getActiveFixedSecondaryTab({
    fixedPanelTabsState,
  });
  const openFixedSecondaryTab = isPersistedSecondaryPanelOpen
    ? activeFixedSecondaryTab
    : null;
  const retainedTerminalId = getRetainedTerminalTabId({
    activeTab: activeFixedSecondaryTab,
    isPanelOpen: isPersistedSecondaryPanelOpen,
  });
  const activeFixedSecondaryTabId = activeFixedSecondaryTab?.id ?? null;
  const renderSecondaryPanelAsDrawer = useIsCompactViewport();
  const secondaryPanelDrawerVisibility =
    useThreadSecondaryPanelDrawerVisibility({
      isCompactViewport: renderSecondaryPanelAsDrawer,
      threadId,
    });
  const isSecondaryPanelOpen = renderSecondaryPanelAsDrawer
    ? secondaryPanelDrawerVisibility.isDrawerVisible
    : isPersistedSecondaryPanelOpen;
  const touchFixedPanelTabsState = useTouchFixedPanelTabsState(
    threadId,
    threadId,
  );
  const setActiveFixedTerminal = useSetFixedRightTerminalActiveTerminal(
    threadId,
    threadId,
  );
  const [shouldAutoFocusTerminal, setShouldAutoFocusTerminal] = useState(false);
  const handleTerminalAutoFocusHandled = useCallback(
    () => setShouldAutoFocusTerminal(false),
    [],
  );
  const removeFixedTerminalTab = useRemoveFixedRightTerminalTab(
    threadId,
    threadId,
    secondaryPanelDrawerVisibility.closeDrawer,
  );
  const updateFixedPanelTabsState = useUpdateFixedPanelTabsState(
    threadId,
    threadId,
  );
  const setThreadSecondaryPanel = useSetThreadSecondaryPanelSelection(
    threadId,
    threadId,
  );
  const toggleDefaultPersistedSecondaryPanel =
    useToggleThreadSecondaryPanelSelection(threadId, threadId);
  const threadQueryState = useConnectionAwareQueryState({
    hasResolvedData: thread !== undefined,
    isFetching: threadDetailBootstrapQuery.isFetching || isFetching,
    isLoadingError,
    isRecoverableLoadingError: isTransientReadError(error),
  });
  const threadOriginKind = thread?.originKind ?? null;
  const isSideChatThread =
    threadOriginKind === "fork" &&
    thread?.originPluginId === SIDE_CHAT_PLUGIN_ID;
  const threadSourceThreadId =
    thread?.sourceThreadId ??
    (thread && threadOriginKind ? thread.parentThreadId : null);
  const { data: parentThread } = useThread(thread?.parentThreadId ?? "");
  const { data: sourceThread } = useThread(threadSourceThreadId ?? "");
  const pendingInteractionsQuery = useThreadPendingInteractions(
    thread?.id ?? "",
    {
      enabled: threadQueryState.status === "ready" && Boolean(thread?.id),
    },
  );
  const pendingInteractions = pendingInteractionsQuery.data ?? [];
  const pendingInteractionsInitialLoading = isPendingInteractionStateUnknown(
    pendingInteractionsQuery.data,
    pendingInteractionsQuery.isFetching,
  );
  const hasPendingInteraction =
    getLatestPendingInteraction(pendingInteractions) !== null;
  const { data: queuedMessagesForEditEligibility = [] } =
    useThreadQueuedMessages(thread?.id ?? "", {
      enabled: threadQueryState.status === "ready" && Boolean(thread?.id),
    });
  const unreadDividerState = useThreadUnreadDividerState({
    routeThreadId: threadId,
    thread,
  });
  const [hasRequestedMergeBaseOptions, setHasRequestedMergeBaseOptions] =
    useState(false);
  const [shouldAutoFocusNewTab, setShouldAutoFocusNewTab] = useState(false);
  const handleNewTabAutoFocusHandled = useCallback(
    () => setShouldAutoFocusNewTab(false),
    [],
  );
  const [browserAddressFocusRequest, setBrowserAddressFocusRequest] =
    useState<BrowserAddressFocusRequest | null>(null);
  const shouldLoadThreadStorageFiles = shouldLoadThreadStorageFileList({
    hasThread: thread !== undefined,
    isSecondaryPanelOpen,
    secondaryTabs: fixedPanelTabsState.secondary.tabs,
  });
  const {
    checkThreadStorageFileExists,
    isThreadStorageFilesLoading,
    refetchThreadStorageFiles,
    threadStorageFiles,
    threadStorageFilesError,
    threadStorageRootPath,
  } = useThreadStorageViewer({
    fileListEnabled: shouldLoadThreadStorageFiles,
    threadId,
  });
  const terminalsListQuery = useThreadTerminals(threadId, {
    enabled: isSecondaryPanelOpen,
  });
  const {
    activeBrowserTab,
    activeHostFileLineRange,
    activeHostFilePath,
    activeStorageFilePath,
    activeWorkspaceFilePath,
    browserTabs,
    clearActiveFileTabs,
    activateTab,
    closeTab,
    openTab,
    openPluginPanel,
    orderedSecondaryFileTabs,
    reopenClosedTab,
    reorderTab,
    selectFileSearchResult,
    updateBrowserTab,
  } = useThreadFileTabs({
    panelStateId: threadId,
    syncThreadId: threadId,
    environmentId: thread?.environmentId,
    onCloseLastTab: secondaryPanelDrawerVisibility.closeDrawer,
    retainedTerminalId,
    storageFileExists: checkThreadStorageFileExists,
    storageFiles: threadStorageFiles,
    terminalSessions: terminalsListQuery.data?.sessions,
  });
  const pluginPanelActions = usePluginPanelActions({
    openPluginPanel,
    threadId,
  });
  const {
    fileOpeners: pluginFileOpeners,
    threadPanelActions: pluginThreadPanelActions,
  } = usePluginSlots();
  useThreadOpenFileSignal({
    threadId,
    environmentId: thread?.environmentId,
    openTab,
  });
  const browserDeckThreadId = thread?.id ?? null;
  const browserDeckEnvironmentId = thread?.environmentId ?? null;
  const handleBrowserAddressFocusRequestConsumed = useCallback(
    (request: BrowserAddressFocusRequest) => {
      setBrowserAddressFocusRequest((current) =>
        current?.requestId === request.requestId &&
        current.tabId === request.tabId
          ? null
          : current,
      );
    },
    [],
  );
  const renderBrowserDeck = useCallback(
    ({
      canHandleBrowserCommands,
      canShowNativeBrowserView,
      onNativeFocus,
      activeBrowserTabId = activeBrowserTab?.id ?? null,
    }: {
      canHandleBrowserCommands?: boolean;
      canShowNativeBrowserView: boolean;
      onNativeFocus?: () => void;
      activeBrowserTabId?: string | null;
    }) => {
      if (browserDeckThreadId === null) {
        return null;
      }
      return (
        <LazyBrowserTabDeck
          browserTabs={browserTabs}
          activeBrowserTabId={activeBrowserTabId}
          addressFocusRequest={browserAddressFocusRequest}
          onAddressFocusRequestConsumed={
            handleBrowserAddressFocusRequestConsumed
          }
          environmentId={browserDeckEnvironmentId}
          canShowNativeBrowserView={canShowNativeBrowserView}
          canHandleBrowserCommands={canHandleBrowserCommands}
          onNativeFocus={onNativeFocus}
          threadId={browserDeckThreadId}
          onUpdate={updateBrowserTab}
        />
      );
    },
    [
      activeBrowserTab?.id,
      browserAddressFocusRequest,
      browserTabs,
      browserDeckEnvironmentId,
      browserDeckThreadId,
      handleBrowserAddressFocusRequestConsumed,
      updateBrowserTab,
    ],
  );
  const openPersistedWorkspaceFile =
    useCallback<ThreadSecondaryPanelWorkspaceFileOpenHandler>(
      (file, options) =>
        openTab({ kind: "workspace-file-preview", tab: file }, options),
      [openTab],
    );
  const openPersistedStorageFile =
    useCallback<ThreadSecondaryPanelStorageFileOpenHandler>(
      (file, options) =>
        openTab({ kind: "thread-storage-file-preview", tab: file }, options),
      [openTab],
    );
  const openPersistedHostFile =
    useCallback<ThreadSecondaryPanelHostFileOpenHandler>(
      (file, options) =>
        openTab({ kind: "host-file-preview", tab: file }, options),
      [openTab],
    );
  const openBrowserTab = useCallback(
    (url?: string) => {
      const browserUrl = url ?? "";
      const tab = openTab({ kind: "browser", url: browserUrl });
      if (browserUrl.length === 0 && tab?.kind === "browser") {
        setBrowserAddressFocusRequest((current) => ({
          requestId: (current?.requestId ?? 0) + 1,
          tabId: tab.id,
        }));
      }
    },
    [openTab],
  );
  const openNewTab = useCallback(() => {
    openTab({ kind: "new-tab" });
  }, [openTab]);
  const [openLinksInAppBrowser] = useOpenLinksInAppBrowserPreference();
  const desktopBrowserAvailable = isDesktopBrowserAvailable();
  const canOpenUrlsInAppBrowser = desktopBrowserAvailable;
  const browserTabIds = useMemo(
    () => new Set(browserTabs.map((tab) => tab.id)),
    [browserTabs],
  );
  const isThreadRoot = isRootThread(thread);
  const [
    parentThreadsRequestedForThreadId,
    setParentThreadsRequestedForThreadId,
  ] = useState<string | null>(null);
  const shouldLoadParentThreads =
    threadQueryState.status === "ready" &&
    isThreadRoot &&
    parentThreadsRequestedForThreadId === thread?.id;
  const parentThreadSubsetQuery = useProjectThreadSubset({
    enabled: shouldLoadParentThreads,
    filters: EMPTY_PROJECT_THREAD_SUBSET_FILTERS,
    projectId,
  });
  const childThreadSubsetQuery = useChildThreads({
    enabled: threadQueryState.status === "ready" && Boolean(thread?.id),
    parentThreadId: thread?.id,
  });
  const parentThreads = useMemo(
    () =>
      shouldLoadParentThreads
        ? (parentThreadSubsetQuery.data ?? EMPTY_PARENT_THREADS)
        : EMPTY_PARENT_THREADS,
    [parentThreadSubsetQuery.data, shouldLoadParentThreads],
  );
  const handleParentSelectorOpenChange = useCallback(
    (open: boolean) => {
      if (open && thread?.id) {
        setParentThreadsRequestedForThreadId(thread.id);
      }
    },
    [thread?.id],
  );
  const handleRetryParentThreads = parentThreadSubsetQuery.retry;
  const {
    activePromptMode,
    activeThinking,
    activeWorkflows,
    activeBackgroundCommands,
    contextBoundarySeq,
    contextWindowUsage,
    goal,
    hasOlderTimelineRows,
    isLoadingOlderTimelineRows,
    loadOlderTimelineRows,
    modelFallback,
    pendingTodos,
    timelineError,
    timelineLoading,
    timelineRows,
  } = useThreadTimelineController({
    threadId,
  });
  const sendMessage = useSendThreadMessage();
  const editMessage = useEditThreadMessage();
  const createQueuedMessage = useCreateThreadQueuedMessage();
  const requestEnvironmentAction = useRequestEnvironmentAction();
  const [pullRequestMergeMethod, setPullRequestMergeMethod] = useAtom(
    pullRequestMergeMethodAtom,
  );
  const markThreadRead = useMarkThreadRead();
  const updateEnvironment = useUpdateEnvironment();
  const updateThread = useUpdateThread({
    errorMessage: "Failed to assign parent thread.",
  });
  const createTerminal = useCreateThreadTerminal();
  const closeTerminal = useCloseThreadTerminal();
  const loadedTerminalSessions = terminalsListQuery.data?.sessions;
  const terminalSessions = loadedTerminalSessions ?? EMPTY_TERMINAL_SESSIONS;
  const terminalsById = useMemo(
    () => new Map(terminalSessions.map((session) => [session.id, session])),
    [terminalSessions],
  );
  const syncedOrderedSecondaryFileTabs = useMemo(
    () =>
      loadedTerminalSessions === undefined
        ? orderedSecondaryFileTabs
        : buildTerminalSyncedSecondaryFileTabs({
            orderedTabs: orderedSecondaryFileTabs,
            retainedTerminalId,
            terminalSessions: loadedTerminalSessions,
          }),
    [loadedTerminalSessions, orderedSecondaryFileTabs, retainedTerminalId],
  );
  useEffect(() => {
    if (terminalsListQuery.data === undefined) {
      return;
    }
    updateFixedPanelTabsState((state) =>
      syncTerminalTabsInFixedPanelState({
        retainedTerminalId,
        state,
        terminalSessions,
      }),
    );
  }, [
    retainedTerminalId,
    terminalSessions,
    terminalsListQuery.data,
    updateFixedPanelTabsState,
  ]);
  const hostsQuery = useHosts({
    enabled:
      hasThreadDetailBootstrapSettled &&
      thread?.environmentId !== null &&
      thread?.environmentId !== undefined,
  });
  const connectedHostIds = useMemo(
    () =>
      new Set(
        (hostsQuery.data ?? [])
          .filter((host) => host.status === "connected")
          .map((host) => host.id),
      ),
    [hostsQuery.data],
  );
  const resolvedThreadEnvironmentHost = useMemo(() => {
    const hosts = hostsQuery.data ?? [];
    const environmentHostId = environment?.hostId;
    if (!environmentHostId) return null;
    return hosts.find((host) => host.id === environmentHostId) ?? null;
  }, [environment?.hostId, hostsQuery.data]);
  const threadEnvironmentHost =
    (hostsQuery.data?.length ?? 0) > 1 ? resolvedThreadEnvironmentHost : null;
  const hostConnectionNotice = useMemo(
    () =>
      thread
        ? buildHostConnectionNotice(thread, threadEnvironmentHost?.name ?? null)
        : null,
    [thread, threadEnvironmentHost],
  );
  const forkThreadFromMessage = useForkThreadFromMessage({
    sourceThread: thread ?? null,
  });
  const handleForkMessage = useCallback<ThreadTimelineForkMessageHandler>(
    (target) => {
      void forkThreadFromMessage(target);
    },
    [forkThreadFromMessage],
  );
  const threadProviderInfo = useSystemProviderInfo(
    thread?.environmentId
      ? {
          enabled: true,
          environmentId: thread.environmentId,
          providerId: thread.providerId,
        }
      : {
          enabled: thread !== undefined,
          providerId: thread?.providerId,
        },
  );
  const threadProviderPluginId = threadProviderInfo?.pluginId ?? null;
  const threadProviderContextValue = useMemo(
    () => ({
      providerId: thread?.providerId ?? null,
      pluginId: threadProviderPluginId,
    }),
    [thread?.providerId, threadProviderPluginId],
  );
  const isForkAvailable = isThreadForkable(
    thread ?? null,
    threadProviderInfo?.capabilities.supportsFork ?? false,
  );
  const dismissCompactKeyboard = useCallback(() => {
    if (!renderSecondaryPanelAsDrawer) {
      return;
    }
    const activeElement = document.activeElement;
    if (activeElement instanceof HTMLElement) {
      activeElement.blur();
    }
  }, [renderSecondaryPanelAsDrawer]);
  const selectionPromptDraftProjectId = thread?.projectId ?? projectId;
  const selectionPromptDraftThreadId = thread?.id ?? "";
  const selectionPromptDraft = useMemo(
    () =>
      getPromptDraftAccessor({
        kind: "thread",
        projectId: selectionPromptDraftProjectId,
        threadId: selectionPromptDraftThreadId,
      }),
    [selectionPromptDraftProjectId, selectionPromptDraftThreadId],
  );
  const addQuoteToComposer = selectionPromptDraft.addQuote;
  const [composerFocusRequestNonce, setComposerFocusRequestNonce] = useState(0);
  const [sentMessageEditSession, setSentMessageEditSession] =
    useState<SentMessageEditSession | null>(null);
  const [sentMessageEditHostElement, setSentMessageEditHostElement] =
    useState<HTMLDivElement | null>(null);
  const activeSentMessageEditSession =
    sentMessageEditSession?.threadId === thread?.id
      ? sentMessageEditSession
      : null;
  const canEditSentMessages =
    thread !== undefined &&
    (systemConfigQuery.data?.experiments.editMessages ?? false) &&
    (threadProviderInfo?.capabilities.supportsSessionRewind ?? false) &&
    thread.archivedAt === null &&
    thread.deletedAt === null &&
    !hasPendingInteraction &&
    sentMessageEditSession === null &&
    !sendMessage.isPending &&
    !createQueuedMessage.isPending &&
    !editMessage.isPending &&
    !(timelineLoading && timelineRows.length === 0) &&
    queuedMessagesForEditEligibility.length === 0 &&
    activeWorkflows.length === 0 &&
    thread.activeBackgroundAgentCount === 0 &&
    activeBackgroundCommands.length === 0;
  const sentMessageEditEntryRef = useRef({ canEditSentMessages, thread });
  sentMessageEditEntryRef.current = { canEditSentMessages, thread };
  const handleEditSentMessage = useCallback<ThreadTimelineEditMessageHandler>(
    (target: ThreadTimelineEditMessageTarget) => {
      const current = sentMessageEditEntryRef.current;
      if (!current.thread || !current.canEditSentMessages) {
        return;
      }
      const editDraft = promptInputToDraft(target.input);
      setSentMessageEditHostElement(null);
      setSentMessageEditSession({
        draft: editDraft,
        operationId: nanoid(),
        target,
        threadId: current.thread.id,
      });
    },
    [],
  );
  const sentMessageEditThreadId = sentMessageEditSession?.threadId ?? null;
  const sentMessageEditTargetMessageId =
    sentMessageEditSession?.target.messageId ?? null;
  const currentThreadId = thread?.id ?? null;
  const sentMessageEditTargetStillPresent =
    sentMessageEditThreadId === currentThreadId &&
    sentMessageEditTargetMessageId !== null
      ? hasTimelineRowId(timelineRows, sentMessageEditTargetMessageId)
      : true;
  const shouldDiscardMissingSentMessageEdit =
    sentMessageEditThreadId !== null &&
    sentMessageEditThreadId === currentThreadId &&
    !timelineLoading &&
    !sentMessageEditTargetStillPresent;
  useEffect(() => {
    if (!shouldDiscardMissingSentMessageEdit) {
      return;
    }
    setSentMessageEditHostElement(null);
    setSentMessageEditSession(null);
    appToast.warning("The message being edited is no longer available.");
  }, [shouldDiscardMissingSentMessageEdit]);
  const activeSentMessageEditOperationId =
    activeSentMessageEditSession?.operationId ?? null;
  const updateSentMessageEditDraft = useCallback(
    (update: (current: PromptDraftState) => PromptDraftState) => {
      setSentMessageEditSession((current) =>
        current?.operationId === activeSentMessageEditOperationId
          ? { ...current, draft: update(current.draft) }
          : current,
      );
    },
    [activeSentMessageEditOperationId],
  );
  const closeSentMessageEdit = useCallback((operationId: string) => {
    setSentMessageEditSession((current) =>
      current?.operationId === operationId ? null : current,
    );
  }, []);
  const cancelSentMessageEdit = useCallback(() => {
    if (!activeSentMessageEditSession) {
      return;
    }
    closeSentMessageEdit(activeSentMessageEditSession.operationId);
  }, [activeSentMessageEditSession, closeSentMessageEdit]);
  const submitSentMessageEdit = useCallback<
    ThreadDetailSentMessageEdit["onSubmit"]
  >(
    (target) => {
      if (!activeSentMessageEditSession) {
        return;
      }
      const session = activeSentMessageEditSession;
      const execution = target.execution;
      void editMessage
        .mutateAsync({
          id: session.threadId,
          operationId: session.operationId,
          expectedRequestSequence: session.target.expectedRequestSequence,
          input: target.input,
          ...(execution
            ? {
                model: execution.model,
                permissionMode: execution.permissionMode,
                reasoningLevel: execution.reasoningLevel,
                executionInputSources: execution.executionInputSources,
                ...(execution.supportsServiceTier && execution.serviceTier
                  ? { serviceTier: execution.serviceTier }
                  : {}),
              }
            : {}),
        })
        .then(() => {
          closeSentMessageEdit(session.operationId);
        })
        .catch((error) => {
          appToast.error(
            getMutationErrorMessage({
              error,
              fallbackMessage: "Failed to edit the message",
              lifecycleOperation: "edit_message",
            }),
          );
        });
    },
    [activeSentMessageEditSession, closeSentMessageEdit, editMessage],
  );
  const activeSentMessageEditTargetMessageId =
    activeSentMessageEditSession?.target.messageId ?? null;
  const inlineMessageEditor = useMemo<
    ThreadTimelineInlineMessageEditor | undefined
  >(
    () =>
      activeSentMessageEditTargetMessageId !== null
        ? {
            messageId: activeSentMessageEditTargetMessageId,
            onHostElementChange: setSentMessageEditHostElement,
          }
        : undefined,
    [activeSentMessageEditTargetMessageId],
  );
  const sentMessageEdit = useMemo<ThreadDetailSentMessageEdit | undefined>(
    () =>
      activeSentMessageEditSession
        ? {
            draft: activeSentMessageEditSession.draft,
            hostElement: sentMessageEditHostElement,
            isSubmitting: editMessage.isPending,
            operationId: activeSentMessageEditSession.operationId,
            onCancel: cancelSentMessageEdit,
            onSubmit: submitSentMessageEdit,
            updateDraft: updateSentMessageEditDraft,
          }
        : undefined,
    [
      activeSentMessageEditSession,
      cancelSentMessageEdit,
      editMessage.isPending,
      sentMessageEditHostElement,
      submitSentMessageEdit,
      updateSentMessageEditDraft,
    ],
  );
  useEffect(
    () =>
      subscribeComposerFocusRequests(selectionPromptDraft.storageKey, () =>
        setComposerFocusRequestNonce((nonce) => nonce + 1),
      ),
    [selectionPromptDraft.storageKey],
  );
  const handleSelectionAddToChat = useCallback(
    (text: string, attachments?: readonly PromptDraftAttachment[]) => {
      dismissCompactKeyboard();
      addQuoteToComposer(text, attachments);
      setComposerFocusRequestNonce((nonce) => nonce + 1);
    },
    [addQuoteToComposer, dismissCompactKeyboard],
  );
  const sendSideChatMessageToMain =
    useCallback<ThreadTimelineSendToMainMessageHandler>(
      (target) => {
        if (
          thread?.id === undefined ||
          !isSideChatThread ||
          threadSourceThreadId === null ||
          createQueuedMessage.isPending
        ) {
          return;
        }

        createQueuedMessage.mutate({
          id: threadSourceThreadId,
          input: [{ type: "text", text: target.messageText, mentions: [] }],
          senderThreadId: thread.id,
        });
      },
      [createQueuedMessage, isSideChatThread, thread?.id, threadSourceThreadId],
    );
  const handleSendToMainMessage =
    isSideChatThread && threadSourceThreadId !== null
      ? sendSideChatMessageToMain
      : undefined;
  const canUseGitUi = gitDiffTabStatus === "eligible";
  const canCreateTerminal =
    thread?.environmentId !== null &&
    thread?.environmentId !== undefined &&
    environment?.status === "ready" &&
    connectedHostIds.has(environment.hostId);
  const createThreadInWorktree = useCreateThreadInWorktree({
    projectId,
    environmentId: thread?.environmentId ?? "",
  });
  const environmentMergeBaseBranch =
    resolveEnvironmentMergeBaseBranch(environment);
  const {
    clearPendingGitDiffIntent,
    closeThreadSecondaryPanel,
    isLoadingMergeBaseBranchOptions,
    mergeBaseBranchOptions,
    mergeBaseRemoteBranchOptions,
    openCommitDiff: openPersistedCommitDiff,
    openDiffFile: openPersistedDiffFile,
    openThreadDiffPanel: openPersistedDiffPanel,
    pendingGitDiffCommitSha,
    pendingGitDiffScrollPath,
    requestedMergeBaseBranch,
    selectedMergeBaseBranch,
    selectedMergeBaseBranchRef,
    setMergeBaseBranchSearchQuery,
    setSelectedMergeBaseBranch,
  } = useGitDiffPanel({
    activeSecondaryTab: openFixedSecondaryTab,
    clearActiveFileTabs,
    defaultMergeBaseBranch: environmentMergeBaseBranch,
    environmentId: canUseGitUi
      ? (thread?.environmentId ?? undefined)
      : undefined,
    mergeBaseBranchOptionsEnabled: hasRequestedMergeBaseOptions,
    setThreadSecondaryPanel,
    threadId,
  });
  const {
    closePanel: closeSecondaryPanel,
    openCommitDiff: openGitDiffCommitDestination,
    openCompactDrawer,
    openDiffFile: openGitDiffFileDestination,
    openDiffPanel: openGitDiffDestination,
    openHostFile,
    openPanel: openFixedViewDestination,
    openStorageFile,
    openWorkspaceFile,
    togglePanel: toggleSecondaryPanel,
  } = useThreadSecondaryPanelVisibility({
    closePersistedPanel: closeThreadSecondaryPanel,
    drawerVisibility: secondaryPanelDrawerVisibility,
    isPersistedOpen: isPersistedSecondaryPanelOpen,
    isCompactViewport: renderSecondaryPanelAsDrawer,
    openPersistedCommitDiff,
    openPersistedDiffFile,
    openPersistedDiffPanel,
    openPersistedHostFile,
    openPersistedPanel: setThreadSecondaryPanel,
    openPersistedStorageFile,
    openPersistedWorkspaceFile,
    togglePersistedPanel: toggleDefaultPersistedSecondaryPanel,
  });
  const fixedTabDestinations = useMemo(
    () => [
      createThreadInfoFixedTabDestination(() =>
        openFixedViewDestination("thread-info"),
      ),
      createGitDiffFixedTabDestination({
        eligible: canUseGitUi,
        openCommit: openGitDiffCommitDestination,
        openFile: openGitDiffFileDestination,
        openOrdinary: openGitDiffDestination,
      }),
    ],
    [
      canUseGitUi,
      openFixedViewDestination,
      openGitDiffCommitDestination,
      openGitDiffDestination,
      openGitDiffFileDestination,
    ],
  );
  const openFixedTab = useCallback(
    (intent: AppFixedTabOpenIntent): boolean =>
      openAppFixedTabFromDestinations(fixedTabDestinations, intent),
    [fixedTabDestinations],
  );
  const openSecondaryPanel = useCallback(
    (panel: ThreadSecondaryPanelTab) =>
      openFixedTab({
        surface: { kind: "current" },
        tab:
          panel === "git-diff"
            ? GIT_DIFF_FIXED_TAB_REFERENCE
            : THREAD_INFO_FIXED_TAB_REFERENCE,
      }),
    [openFixedTab],
  );
  const openSecondaryPanelDiffPanel = useCallback(
    () =>
      openFixedTab({
        surface: { kind: "current" },
        tab: GIT_DIFF_FIXED_TAB_REFERENCE,
      }),
    [openFixedTab],
  );
  const openSecondaryPanelDiffFile = useCallback(
    (path: string) =>
      openFixedTab({
        surface: { kind: "current" },
        tab: GIT_DIFF_FIXED_TAB_REFERENCE,
        target: { kind: "file", path },
      }),
    [openFixedTab],
  );
  const openSecondaryPanelCommitDiff = useCallback(
    (sha: string) =>
      openFixedTab({
        surface: { kind: "current" },
        tab: GIT_DIFF_FIXED_TAB_REFERENCE,
        target: { kind: "commit", sha },
      }),
    [openFixedTab],
  );
  const handleOpenLiveFilePreview = useCallback(
    (intent: AppFilePreviewIntent): boolean => {
      const normalized = normalizeExperimentalFileOpenOptions(intent);
      if (normalized === null || thread === undefined) return false;
      const lineRange = toFilePreviewLineRange(normalized.location);
      const options =
        intent.viewer === undefined ? undefined : { viewer: intent.viewer };
      switch (normalized.target.kind) {
        case "workspace":
          if (normalized.target.environmentId !== thread.environmentId) {
            return false;
          }
          openWorkspaceFile(
            {
              lineRange,
              path: normalized.target.path,
              source: { kind: "working-tree" },
              statusLabel: null,
            },
            options,
          );
          return true;
        case "host":
          if (normalized.target.hostId !== environment?.hostId) return false;
          openHostFile({ lineRange, path: normalized.target.path }, options);
          return true;
        case "thread-storage":
          if (normalized.target.threadId !== thread.id) return false;
          openStorageFile({ lineRange, path: normalized.target.path }, options);
          return true;
      }
    },
    [
      environment?.hostId,
      openHostFile,
      openStorageFile,
      openWorkspaceFile,
      thread,
    ],
  );
  const appNavigationCapabilities = useMemo(
    () => ({ openFilePreview: handleOpenLiveFilePreview, openFixedTab }),
    [handleOpenLiveFilePreview, openFixedTab],
  );
  const handleOpenTimelinePluginPanel =
    useCallback<ThreadTimelineOpenPluginPanelHandler>(
      ({ pluginId, actionId, title, params }) => {
        const action = pluginThreadPanelActions.find(
          (candidate) =>
            candidate.pluginId === pluginId && candidate.id === actionId,
        );
        if (action === undefined) return false;
        let paramsJson: string | null;
        try {
          paramsJson = serializePluginPanelParams(params);
        } catch (error) {
          console.warn(
            `[plugin:${pluginId}] messageDirective openThreadPanel params are invalid: ${
              error instanceof Error ? error.message : String(error)
            }`,
          );
          return false;
        }
        openPluginPanel({
          pluginId,
          actionId,
          title: title ?? action.title,
          paramsJson,
        });
        openCompactDrawer();
        return true;
      },
      [openCompactDrawer, openPluginPanel, pluginThreadPanelActions],
    );
  const openBrowserTabAndReveal = useCallback(
    (url?: string) => {
      openBrowserTab(url);
      openCompactDrawer();
    },
    [openBrowserTab, openCompactDrawer],
  );
  const handleOpenUrlByPreference = useCallback(
    (url: string) =>
      openUrlByPreference({
        desktopBrowserAvailable: canOpenUrlsInAppBrowser,
        openExternalBrowser: openUrlInExternalBrowser,
        openInAppBrowser: openBrowserTabAndReveal,
        openLinksInAppBrowser,
        url,
      }),
    [canOpenUrlsInAppBrowser, openBrowserTabAndReveal, openLinksInAppBrowser],
  );
  const handleSelectFileSearchResult = useCallback(
    (selection: FileSearchSelection) => {
      selectFileSearchResult(selection);
      openCompactDrawer();
    },
    [openCompactDrawer, selectFileSearchResult],
  );
  const handleActivateFileTab = useCallback(
    (tabId: string) => {
      activateTab(tabId);
      openCompactDrawer();
    },
    [activateTab, openCompactDrawer],
  );
  const [nativeReveal, setNativeReveal] = useAtom(desktopBrowserRevealAtom);
  useEffect(() => {
    if (
      !isFocused ||
      nativeReveal === null ||
      nativeReveal.threadId !== threadId ||
      !browserTabs.some((tab) => tab.id === nativeReveal.tabId)
    )
      return;
    handleActivateFileTab(nativeReveal.tabId);
    setNativeReveal(null);
  }, [
    nativeReveal,
    isFocused,
    threadId,
    browserTabs,
    handleActivateFileTab,
    setNativeReveal,
  ]);
  useEffect(() => {
    const browserApi = getDesktopBrowserApi();
    if (browserApi === null) {
      return;
    }
    if (browserApi.onScopedOpenTab) {
      return browserApi.onScopedOpenTab(({ tabId, url }) => {
        if (browserTabIds.has(tabId)) {
          handleOpenUrlByPreference(url);
        }
      });
    }
    return browserApi.onOpenTab(({ url }) => {
      if (isRoutePath({ path: url })) {
        return;
      }
      handleOpenUrlByPreference(url);
    });
  }, [browserTabIds, handleOpenUrlByPreference]);
  const handleSelectStorageBrowserPath =
    useCallback<ThreadStoragePathSelectHandler>(
      (path) => {
        openStorageFile({
          lineRange: null,
          path,
        });
      },
      [openStorageFile],
    );
  const storageBrowserController = useThreadStorageBrowser({
    files: threadStorageFiles?.files,
    onSelectPath: handleSelectStorageBrowserPath,
    selectedPath: activeStorageFilePath,
  });
  const [storedConversationCollapsed, setStoredConversationCollapsed] = useAtom(
    getThreadConversationCollapsedAtom(threadId),
  );
  const isConversationCollapsed = storedConversationCollapsed;
  const toggleConversationCollapse = useCallback(() => {
    setStoredConversationCollapsed((collapsed) => !collapsed);
  }, [setStoredConversationCollapsed]);
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
  const secondaryPanelFixedTabs = useMemo<readonly SecondaryPanelFixedTab[]>(
    () =>
      threadFixedViewTabs.map((tab) =>
        tab.kind === "thread-info"
          ? {
              ariaLabel: "Show thread info panel",
              label: "Info",
              leadingVisual: <Icon name="Info" />,
              onSelect: () => handleSecondaryPanelChange("thread-info"),
              tab,
              title: "Thread info",
            }
          : {
              ariaLabel: "Show diff panel",
              label: "Diff",
              leadingVisual: <Icon name="FileDiff" />,
              onSelect: () => handleSecondaryPanelChange("git-diff"),
              tab,
              title: "Diff",
            },
      ),
    [handleSecondaryPanelChange, threadFixedViewTabs],
  );
  const resolveMentionLink = useCallback<PromptMentionLinkResolver>(
    (resource) => {
      if (resource.kind === "thread") {
        const targetProjectId = resource.projectId ?? projectId;
        if (!targetProjectId) return null;
        return () =>
          navigateInPane({
            projectId: targetProjectId,
            threadId: resource.threadId,
          });
      }
      if (resource.kind === "project") {
        return () => navigate(getProjectComposeRoutePath(resource.projectId));
      }
      if (resource.kind !== "path" || resource.entryKind !== "file") {
        return null;
      }
      if (resource.source === "thread-storage") {
        return () =>
          openStorageFile({
            lineRange: null,
            path: resource.path,
          });
      }
      if (!thread?.environmentId) return null;
      return () =>
        openWorkspaceFile({
          lineRange: null,
          path: resource.path,
          source: { kind: "working-tree" },
          statusLabel: null,
        });
    },
    [
      navigate,
      navigateInPane,
      openStorageFile,
      openWorkspaceFile,
      projectId,
      thread?.environmentId,
    ],
  );
  const handleOpenNewTab = useCallback(() => {
    openNewTab();
    openCompactDrawer();
    setShouldAutoFocusNewTab(true);
  }, [openCompactDrawer, openNewTab]);
  useAppCommandHandler("panel.newTab", () => {
    if (!isFocused) return false;
    handleOpenNewTab();
    return true;
  });
  useAppCommandHandler("panel.reopenClosedTab", () => {
    if (!isFocused || !reopenClosedTab()) return false;
    openCompactDrawer();
    return true;
  });
  useAppCommandHandler("file.quickOpen", () => {
    if (!isFocused) return false;
    handleOpenNewTab();
    return true;
  });
  useEffect(() => {
    if (!isFocused) {
      return;
    }
    const desktopInfo = getBbDesktopInfo();
    if (
      desktopInfo === null ||
      desktopInfo.onAppCommand !== undefined ||
      desktopInfo.onOpenNewTab === undefined
    ) {
      return;
    }
    return desktopInfo.onOpenNewTab(handleOpenNewTab);
  }, [handleOpenNewTab, isFocused]);
  const handleStartTerminal = useCallback(() => {
    if (!canCreateTerminal || createTerminal.isPending || !threadId) {
      return;
    }
    const newTab = createNewTabFixedPanelTab();
    void createTerminal
      .mutateAsync({
        threadId,
        cols: DEFAULT_TERMINAL_COLS,
        rows: DEFAULT_TERMINAL_ROWS,
      })
      .then((session) => {
        closeTab(newTab.id);
        setShouldAutoFocusTerminal(true);
        setActiveFixedTerminal(session.id);
        openCompactDrawer();
      })
      .catch(() => undefined);
  }, [
    canCreateTerminal,
    closeTab,
    createTerminal,
    openCompactDrawer,
    setActiveFixedTerminal,
    threadId,
  ]);
  useAppCommandHandler("terminal.open", () => {
    if (
      !isFocused ||
      !canCreateTerminal ||
      createTerminal.isPending ||
      !threadId
    ) {
      return false;
    }
    handleStartTerminal();
    return true;
  });
  const handleActivateTerminalTab = useCallback(
    (terminalId: string) => {
      setShouldAutoFocusTerminal(true);
      setActiveFixedTerminal(terminalId);
      openCompactDrawer();
    },
    [openCompactDrawer, setActiveFixedTerminal],
  );
  const handleCloseTerminalTab = useCallback(
    (terminalId: string) => {
      if (!threadId) {
        removeFixedTerminalTab(terminalId);
        return;
      }
      closeTerminal.mutate(
        { mode: "force", threadId, terminalId },
        {
          onSuccess: () => {
            removeFixedTerminalTab(terminalId);
          },
        },
      );
    },
    [closeTerminal, removeFixedTerminalTab, threadId],
  );
  const handleCloseWindowRequest = useCallback(() => {
    if (!isSecondaryPanelOpen) {
      return false;
    }
    if (
      activeFixedSecondaryTab !== null &&
      isSecondaryFileTab(activeFixedSecondaryTab)
    ) {
      if (activeFixedSecondaryTab.kind === "terminal") {
        handleCloseTerminalTab(activeFixedSecondaryTab.terminalId);
      } else {
        closeTab(activeFixedSecondaryTab.id);
      }
      return true;
    }
    closeSecondaryPanel();
    return true;
  }, [
    activeFixedSecondaryTab,
    closeSecondaryPanel,
    closeTab,
    handleCloseTerminalTab,
    isSecondaryPanelOpen,
  ]);
  useAppCommandHandler("panel.toggle", () => {
    if (!isFocused) return false;
    toggleSecondaryPanel();
    return true;
  });
  useAppCommandHandler("panel.close", () => {
    if (!isFocused) return false;
    return handleCloseWindowRequest();
  });
  useAppCommandHandler("diff.toggle", () => {
    if (!isFocused || !canUseGitUi) {
      return false;
    }
    if (isSecondaryPanelOpen && activeFixedSecondaryTab?.kind === "git-diff") {
      closeSecondaryPanel();
    } else {
      openSecondaryPanelDiffPanel();
    }
    return true;
  });
  useEffect(() => {
    if (!isFocused) {
      return;
    }
    const desktopInfo = getBbDesktopInfo();
    if (
      desktopInfo === null ||
      desktopInfo.onCloseWindowRequest === undefined
    ) {
      return;
    }
    return desktopInfo.onCloseWindowRequest(handleCloseWindowRequest);
  }, [handleCloseWindowRequest, isFocused]);
  const handleChangedFileClick = useCallback(
    (selection: WorkspaceChangedFileSelection) => {
      const openTarget = resolveWorkspaceChangedFileOpenTarget(selection);
      if (openTarget.kind === "preview") {
        openWorkspaceFile({
          lineRange: null,
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
  const workStatusQuery = useEnvironmentWorkStatus(
    thread?.environmentId,
    requestedMergeBaseBranch,
    {
      enabled: canUseGitUi && environment !== undefined,
    },
  );
  const workspaceStatusError = workStatusQuery.error;
  const workStatusResponse = workspaceStatusError
    ? undefined
    : workStatusQuery.data;
  const workspaceStatus =
    workStatusResponse?.outcome === "available"
      ? workStatusResponse.workspace
      : undefined;
  const workspaceUnavailable =
    workStatusResponse?.outcome === "unavailable"
      ? workStatusResponse.failure
      : undefined;
  const pullRequestQuery = useEnvironmentPullRequest(thread?.environmentId, {
    enabled: canUseGitUi && environment !== undefined,
  });
  const pullRequest = getEnvironmentPullRequestFromResponse(
    pullRequestQuery.data,
  );
  const handlePullRequestReady = useCallback(async () => {
    const environmentId = thread?.environmentId;
    if (!environmentId) {
      return;
    }
    const toastId = appToast.loading("Marking pull request ready");
    try {
      const response = await requestEnvironmentAction.mutateAsync({
        id: environmentId,
        action: "pull_request_ready",
      });
      if (response.action !== "pull_request_ready") {
        throw new Error("Expected pull request ready action response.");
      }
      appToast.success(response.message, { id: toastId });
    } catch (error) {
      appToast.error("Failed to update pull request", {
        id: toastId,
        description: getMutationErrorMessage({
          error,
          fallbackMessage: "Pull request was not updated",
        }),
      });
    }
  }, [requestEnvironmentAction, thread?.environmentId]);
  const handlePullRequestDraft = useCallback(async () => {
    const environmentId = thread?.environmentId;
    if (!environmentId) {
      return;
    }
    const toastId = appToast.loading("Converting pull request to draft");
    try {
      const response = await requestEnvironmentAction.mutateAsync({
        id: environmentId,
        action: "pull_request_draft",
      });
      if (response.action !== "pull_request_draft") {
        throw new Error("Expected pull request draft action response.");
      }
      appToast.success(response.message, { id: toastId });
    } catch (error) {
      appToast.error("Failed to update pull request", {
        id: toastId,
        description: getMutationErrorMessage({
          error,
          fallbackMessage: "Pull request was not updated",
        }),
      });
    }
  }, [requestEnvironmentAction, thread?.environmentId]);
  const handlePullRequestMerge = useCallback(
    async (method: PullRequestMergeMethod) => {
      const environmentId = thread?.environmentId;
      if (!environmentId) {
        return;
      }
      setPullRequestMergeMethod(method);
      const toastId = appToast.loading(getPullRequestMergeLoadingTitle(method));
      try {
        const response = await requestEnvironmentAction.mutateAsync({
          id: environmentId,
          action: "pull_request_merge",
          options: { method },
        });
        if (response.action !== "pull_request_merge") {
          throw new Error("Expected pull request merge action response.");
        }
        appToast.success(response.message, { id: toastId });
      } catch (error) {
        appToast.error("Failed to merge pull request", {
          id: toastId,
          description: getMutationErrorMessage({
            error,
            fallbackMessage: "Pull request was not merged",
          }),
        });
      }
    },
    [
      requestEnvironmentAction,
      setPullRequestMergeMethod,
      thread?.environmentId,
    ],
  );
  const workspaceBranch = workspaceStatus?.branch;
  const workspaceChangedFilesSection = useMemo(
    () => selectWorkspaceChangedFilesSection(workspaceStatus),
    [workspaceStatus],
  );
  const workingTreeChangedFilesSection = useMemo(() => {
    if (
      workspaceChangedFilesSection === null ||
      workspaceChangedFilesSection.kind === "committed"
    ) {
      return null;
    }
    return workspaceChangedFilesSection;
  }, [workspaceChangedFilesSection]);
  const { isLocalDaemonHost } = useHostDaemon();
  const threadEnvironmentIsLocal = environment
    ? isLocalDaemonHost(environment.hostId)
    : false;
  const environmentDisplayHostContext = useMemo<EnvironmentDisplayHostContext>(
    () => ({
      locality: threadEnvironmentIsLocal ? "local" : "remote",
      identity: threadEnvironmentHost
        ? {
            name: threadEnvironmentHost.name,
            connected: threadEnvironmentHost.status === "connected",
          }
        : null,
    }),
    [threadEnvironmentIsLocal, threadEnvironmentHost],
  );
  const workspacePreviewRootPath = environment?.path ?? null;
  const threadOpenContext = resolveEnvironmentOpenContext({
    environment,
    serverOrigin: window.location.origin,
    threadEnvironmentIsLocal,
  });
  const {
    canOpenPreferredDirectoryTarget,
    canOpenPreferredFileTarget,
    directoryOpenTargets,
    fileOpenTargets,
    openPathInDirectoryTarget,
    openPathInFileTarget,
    openPathInPreferredDirectoryTarget,
    openPathInPreferredFileTarget,
    preferredDirectoryTarget,
  } = useLocalOpenTargets({
    enabled: threadOpenContext !== null,
    ...(threadOpenContext ? { openContext: threadOpenContext } : {}),
  });
  const parentThreadSection: ThreadPromptParentThreadSection | null =
    useMemo(() => {
      const relatedThreadId =
        threadOriginKind !== null
          ? threadSourceThreadId
          : thread?.parentThreadId;
      if (!thread || !relatedThreadId) return null;
      const relationship = isSideChatThread
        ? "side-chat"
        : threadOriginKind === "fork"
          ? "fork"
          : "parent";
      const relatedThread =
        relationship === "parent" ? parentThread : sourceThread;
      const href = getThreadRoutePath({
        projectId: relatedThread?.projectId ?? thread.projectId,
        threadId: relatedThreadId,
      });
      if (relatedThread === undefined) {
        return {
          parentThreadTitle: relatedThreadId.slice(0, 8),
          href,
          relationship,
        };
      }
      if (
        relatedThread.archivedAt !== null ||
        relatedThread.deletedAt !== null ||
        (relationship !== "parent" &&
          relatedThread.projectId !== thread.projectId)
      ) {
        return null;
      }
      return {
        parentThreadTitle: getThreadDisplayTitle(relatedThread),
        href,
        relationship,
      };
    }, [
      isSideChatThread,
      parentThread,
      sourceThread,
      thread,
      threadOriginKind,
      threadSourceThreadId,
    ]);
  const childThreadsSection: ThreadPromptChildThreadsSection | null =
    useMemo(() => {
      const list = childThreadSubsetQuery.data ?? [];
      const activeItems = list
        .filter(
          (entry) =>
            entry.originKind === null &&
            (isThreadDisplayStatusBannerActive(entry.runtime.displayStatus) ||
              entry.hasPendingInteraction),
        )
        .map((entry) => ({
          id: entry.id,
          title: getThreadDisplayTitle(entry),
          href: getThreadRoutePath({
            projectId: entry.projectId,
            threadId: entry.id,
          }),
          hasPendingInteraction: entry.hasPendingInteraction,
        }))
        .sort((left, right) =>
          left.hasPendingInteraction === right.hasPendingInteraction
            ? 0
            : left.hasPendingInteraction
              ? -1
              : 1,
        );
      if (activeItems.length === 0) return null;
      return { items: activeItems };
    }, [childThreadSubsetQuery.data]);
  const childPendingInteractions = useChildThreadPendingAttention(
    childThreadsSection?.items ?? EMPTY_CHILD_THREAD_ITEMS,
  );
  const isThreadTimelinePending = timelineLoading && timelineRows.length === 0;
  useThreadReadTracking({
    markThreadRead,
    thread,
  });
  const {
    effectiveMergeBaseBranch,
    handleMergeBaseBranchChange,
    showBranchComparisonUi,
    showMergeBase,
  } = useEnvironmentMergeBase({
    environment,
    selectedMergeBaseBranch,
    setSelectedMergeBaseBranch,
    thread,
    updateEnvironment,
    workspaceStatus,
  });
  const gitActions = useThreadGitActions({
    environment,
    requestEnvironmentAction,
    thread,
    workspaceStatus,
  });
  const parentThreadId = thread?.parentThreadId;
  const parentThreadDisplayName =
    parentThread?.title && parentThread.title.trim().length > 0
      ? parentThread.title
      : parentThreadId;
  const handleAssignParent = useCallback(
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
  const handleTimelineLocalFileLinkResolution = useCallback(
    (
      resolution: ThreadLocalFileLinkResolution,
      options?: ThreadSecondaryPanelFileOpenOptions,
    ) => {
      if (resolution.kind === "app-route") {
        return false;
      }
      if (resolution.kind === "error") {
        appToast.error("Failed to open file locally", {
          description: resolution.description,
        });
        return true;
      }

      if (resolution.kind === "open-workspace-path") {
        openWorkspaceFile(
          {
            lineRange: resolution.request.lineRange,
            path: resolution.request.relativePath,
            source: { kind: "working-tree" },
            statusLabel: null,
          },
          options,
        );
        return true;
      }

      if (resolution.kind === "open-thread-storage-path") {
        openStorageFile(
          {
            lineRange: resolution.request.lineRange,
            path: resolution.request.relativePath,
          },
          options,
        );
        return true;
      }

      openHostFile(
        {
          lineRange: resolution.request.lineRange,
          path: resolution.request.path,
        },
        options,
      );
      return true;
    },
    [openHostFile, openStorageFile, openWorkspaceFile],
  );
  const handleOpenTimelineLocalFileLink = useCallback(
    (
      link: ThreadTimelineLocalFileLink,
      options?: ThreadSecondaryPanelFileOpenOptions,
    ) => {
      const resolution = resolveThreadLocalFileLink({
        hostFileLinksAvailable:
          thread?.environmentId !== null && thread?.environmentId !== undefined,
        link,
        threadStorageRootPath,
        workspaceRootPath: workspacePreviewRootPath,
      });

      if (
        resolution.kind !== "open-host-path" ||
        threadStorageRootPath !== null
      ) {
        return handleTimelineLocalFileLinkResolution(resolution, options);
      }

      void refetchThreadStorageFiles()
        .then((result) => {
          const resolvedThreadStorageRootPath =
            result.data?.storageRootPath ?? null;
          if (resolvedThreadStorageRootPath === null) {
            appToast.error("Failed to open file locally", {
              description: "Thread storage path is not available yet.",
            });
            return;
          }

          const resolvedResolution = resolveThreadLocalFileLink({
            hostFileLinksAvailable: true,
            link,
            threadStorageRootPath: resolvedThreadStorageRootPath,
            workspaceRootPath: workspacePreviewRootPath,
          });
          handleTimelineLocalFileLinkResolution(resolvedResolution, options);
        })
        .catch((error: Error) => {
          appToast.error("Failed to open file locally", {
            description: error.message,
          });
        });

      return true;
    },
    [
      handleTimelineLocalFileLinkResolution,
      refetchThreadStorageFiles,
      thread?.environmentId,
      threadStorageRootPath,
      workspacePreviewRootPath,
    ],
  );
  const handleOpenTimelineLink = useCallback<ThreadTimelineLinkHandler>(
    ({ href }) => handleOpenUrlByPreference(href),
    [handleOpenUrlByPreference],
  );
  const handleTimelineTitleAction = useCallback<TimelineTitleActionResolver>(
    (action) => {
      switch (action.kind) {
        case "open-file-diff":
          return () => {
            openSecondaryPanelDiffFile(action.path);
          };
        case "open-plugin-side-chat":
          return () => {
            handleOpenTimelinePluginPanel({
              pluginId: SIDE_CHAT_PLUGIN_ID,
              actionId: SIDE_CHAT_PLUGIN_PANEL_ACTION_ID,
              params: { threadId: action.threadId, sourceThreadId: threadId },
            });
          };
        default:
          return assertNever(action);
      }
    },
    [openSecondaryPanelDiffFile, handleOpenTimelinePluginPanel, threadId],
  );
  const metadataStorage = useMemo(
    () => ({
      controller: storageBrowserController,
      filesError: threadStorageFilesError,
      isFilesLoading: isThreadStorageFilesLoading,
    }),
    [
      isThreadStorageFilesLoading,
      storageBrowserController,
      threadStorageFilesError,
    ],
  );
  const handleOpenFileInEditor = useMemo(
    () =>
      buildOpenInEditorHandler({
        rootPath: workspacePreviewRootPath,
        canOpenPreferredTarget: canOpenPreferredFileTarget,
        openInPreferredTarget: openPathInPreferredFileTarget,
      }),
    [
      canOpenPreferredFileTarget,
      openPathInPreferredFileTarget,
      workspacePreviewRootPath,
    ],
  );
  const handleOpenStorageFileInEditor = useMemo(
    () =>
      buildOpenInEditorHandler({
        rootPath: threadStorageRootPath,
        canOpenPreferredTarget: canOpenPreferredFileTarget,
        openInPreferredTarget: openPathInPreferredFileTarget,
      }),
    [
      canOpenPreferredFileTarget,
      openPathInPreferredFileTarget,
      threadStorageRootPath,
    ],
  );
  const handleOpenHostFileInEditor = useMemo<
    OpenInEditorHandler | undefined
  >(() => {
    if (!canOpenPreferredFileTarget) {
      return undefined;
    }
    return (path) => {
      void openPathInPreferredFileTarget({
        lineNumber: getFilePreviewLineRangeStart({
          lineRange: activeHostFileLineRange,
        }),
        path,
      });
    };
  }, [
    activeHostFileLineRange,
    canOpenPreferredFileTarget,
    openPathInPreferredFileTarget,
  ]);
  const workspaceOpenPath = resolveThreadWorkspaceOpenPath({
    canOpenWorkspace: canOpenPreferredDirectoryTarget,
    environment,
    hasWorkspaceOpenTargets: directoryOpenTargets.length > 0,
  });
  usePublishThreadPanelOpener(handleOpenTimelinePluginPanel, isFocused);
  useAppCommandHandler("workspace.openPreferred", () => {
    if (!isFocused) return false;
    if (activeWorkspaceFilePath && handleOpenFileInEditor) {
      handleOpenFileInEditor(activeWorkspaceFilePath);
      return true;
    }
    if (activeHostFilePath && handleOpenHostFileInEditor) {
      handleOpenHostFileInEditor(activeHostFilePath);
      return true;
    }
    if (activeStorageFilePath && handleOpenStorageFileInEditor) {
      handleOpenStorageFileInEditor(activeStorageFilePath);
      return true;
    }
    if (workspaceOpenPath && preferredDirectoryTarget) {
      void openPathInPreferredDirectoryTarget({
        lineNumber: null,
        path: workspaceOpenPath,
      });
      return true;
    }
    return false;
  });
  const getLocalFileContextMenuItems = useCallback(
    (link: ThreadTimelineLocalFileLink) => {
      const extension = getFileExtension(link.path);
      const matching =
        extension === null
          ? []
          : pluginFileOpeners.filter((opener) =>
              opener.extensions.includes(extension),
            );
      const lineNumber = getFilePreviewLineRangeStart({
        lineRange: link.lineRange,
      });
      const openTargetItems = fileOpenTargets.map((target) => ({
        id: `open-target:${target.id}`,
        label: buildOpenTargetMenuItemLabel(target),
        onSelect: () => {
          void openPathInFileTarget({
            lineNumber,
            path: link.path,
            rememberTarget: false,
            targetId: target.id,
          });
        },
      }));
      const items: MarkdownLocalFileContextMenuItem[] = [];
      if (openTargetItems.length > 0) {
        items.push({
          id: "open-in",
          items: openTargetItems,
          label: "Open in",
          type: "submenu",
        });
      }
      if (matching.length > 0) {
        if (items.length > 0) {
          items.push({ id: "open-with-separator", type: "separator" });
        }
        items.push(
          {
            id: "builtin",
            label: "Open with built-in preview",
            onSelect: () => {
              handleOpenTimelineLocalFileLink(link, { viewer: "builtin" });
            },
          },
          ...matching.map((opener) => ({
            id: `${opener.pluginId}:${opener.id}`,
            label: `Open with ${opener.title}`,
            onSelect: () => {
              handleOpenTimelineLocalFileLink(link, {
                viewer: { pluginId: opener.pluginId, openerId: opener.id },
              });
            },
          })),
        );
      }
      if (items.length > 0) {
        items.push({ id: "copy-separator", type: "separator" });
      }
      items.push(
        {
          id: "copy-path",
          label: "Copy file path",
          onSelect: () => {
            void copyToClipboardWithToast(link.path, {
              successMessage: "File path copied",
              errorMessage: "Failed to copy file path",
            });
          },
        },
        {
          id: "copy-name",
          label: "Copy file name",
          onSelect: () => {
            void copyToClipboardWithToast(getFileBasename(link.path), {
              successMessage: "File name copied",
              errorMessage: "Failed to copy file name",
            });
          },
        },
      );
      return items;
    },
    [
      fileOpenTargets,
      handleOpenTimelineLocalFileLink,
      openPathInFileTarget,
      pluginFileOpeners,
    ],
  );
  const handleOpenFilePreview = useCallback<OpenFilePreviewHandler>(
    (relativePath) => {
      if (
        thread?.environmentId === null ||
        thread?.environmentId === undefined
      ) {
        return;
      }
      handleOpenLiveFilePreview({
        target: {
          kind: "workspace",
          environmentId: thread.environmentId,
          path: relativePath,
        },
        location: null,
      });
    },
    [handleOpenLiveFilePreview, thread?.environmentId],
  );

  if (threadQueryState.status === "loading") {
    return <RouteLoadingSkeleton isBoundedPane={isBoundedPane} />;
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
  const canAssignToParent = isThreadRoot;
  const canTakeOverThread = Boolean(thread.parentThreadId);
  const threadEnvironmentDisplay = environment
    ? formatEnvironmentDisplay({
        environment,
        host: environmentDisplayHostContext,
      })
    : undefined;
  const environmentMachinePrefix =
    threadEnvironmentHost !== null ? `${threadEnvironmentHost.name} · ` : "";
  const composerEnvironmentSummary = threadEnvironmentDisplay
    ? getEnvironmentWorkspaceSummaryDisplay({
        display: threadEnvironmentDisplay,
        environmentName: environment?.name ?? null,
        locality: environmentDisplayHostContext.locality,
        hostName: resolvedThreadEnvironmentHost?.name,
        machinePrefix: environmentMachinePrefix,
      })
    : undefined;
  const isThreadOnProvisionedWorktreeEnvironment =
    environment !== undefined &&
    environment.status === "ready" &&
    environment.path !== null &&
    (environment.isWorktree ||
      environment.workspaceProvisionType === "managed-worktree");
  const onCreateNewThreadInWorktree =
    isThreadOnProvisionedWorktreeEnvironment &&
    projectId &&
    thread.environmentId !== null
      ? createThreadInWorktree
      : undefined;
  const promptBannerMergeBaseBranch = effectiveMergeBaseBranch;
  const threadBranchName = workspaceBranch?.currentBranch ?? undefined;
  const threadCheckoutDisplay = workspaceStatus
    ? formatWorkspaceCheckoutDisplay({ checkout: workspaceStatus.checkout })
    : undefined;
  const isWorkspaceDeleted = environment?.status === "destroyed";
  const threadEnvironmentGoneStatus =
    environment?.status === "destroying" || environment?.status === "destroyed"
      ? environment.status
      : null;
  const threadGitStatusDisplay = getGitStatusDisplay(workspaceStatus, {
    mergeBaseBranch: effectiveMergeBaseBranch,
    showBranchComparison: showBranchComparisonUi,
    error: workspaceStatusError,
    workspaceUnavailable,
    workspaceDeleted: isWorkspaceDeleted,
  });
  const threadTitle = getThreadDisplayTitle(thread);
  const responsiveWorkspaceActions: ThreadActionsMenuResponsiveAction[] =
    workspaceOpenPath && preferredDirectoryTarget
      ? [
          preferredDirectoryTarget,
          ...directoryOpenTargets.filter(
            (target) => target.id !== preferredDirectoryTarget.id,
          ),
        ].map((target) => ({
          icon: "FolderOpen" as const,
          label: `Open workspace in ${target.label}`,
          onSelect: async () => {
            if (target.id === preferredDirectoryTarget.id) {
              await openPathInPreferredDirectoryTarget({
                lineNumber: null,
                path: workspaceOpenPath,
              });
              return;
            }
            await openPathInDirectoryTarget({
              lineNumber: null,
              path: workspaceOpenPath,
              rememberTarget: true,
              targetId: target.id,
            });
          },
        }))
      : [];
  const responsiveGitActions: ThreadActionsMenuResponsiveAction[] =
    gitActions.threadHeaderGitActions.map((action) => ({
      icon: "GitBranch" as const,
      label: action.label,
      onSelect: () => {
        gitActions.threadGitActionDialog.onOpen(action.target);
      },
    }));
  const responsiveHeaderActions = [
    ...responsiveWorkspaceActions,
    ...responsiveGitActions,
  ];
  const workspaceOpenButton =
    workspaceOpenPath && preferredDirectoryTarget ? (
      <ThreadWorkspaceOpenButton
        preferredTarget={preferredDirectoryTarget}
        targets={directoryOpenTargets}
        onOpenPreferredTarget={async () => {
          await openPathInPreferredDirectoryTarget({
            lineNumber: null,
            path: workspaceOpenPath,
          });
        }}
        onOpenTarget={async (targetId) => {
          await openPathInDirectoryTarget({
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
      actionsMenu={(includeResponsiveActions) => (
        <ThreadActionsMenu
          thread={thread}
          triggerClassName={HEADER_ICON_BUTTON_CLASS}
          responsiveActions={
            includeResponsiveActions ? responsiveHeaderActions : undefined
          }
        />
      )}
      childPillLabel={
        isSideChatThread ? "side chat" : parentThreadId ? "child" : null
      }
      isSecondaryPanelOpen={isSecondaryPanelOpen}
      onClosePane={onRequestClose ?? undefined}
      onOpenThreadGitAction={gitActions.threadGitActionDialog.onOpen}
      onToggleSecondaryPanel={toggleSecondaryPanel}
      pluginActions={
        <PluginThreadHeaderActions
          threadId={thread.id}
          projectId={thread.projectId}
        />
      }
      threadHeaderGitActions={gitActions.threadHeaderGitActions}
      threadId={thread.id}
      threadTitle={threadTitle}
      workspaceOpenButton={workspaceOpenButton}
    />
  );
  const composerFooter = (
    <ThreadDetailPromptArea
      activeBackgroundAgentCount={thread.activeBackgroundAgentCount}
      canUseGitUi={canUseGitUi}
      contextWindowUsage={contextWindowUsage}
      environmentCheckout={threadCheckoutDisplay}
      environmentCompactLabel={composerEnvironmentSummary?.compactLabel}
      environmentIcon={composerEnvironmentSummary?.icon}
      environmentLabel={composerEnvironmentSummary?.label}
      environmentTypeLabel={composerEnvironmentSummary?.typeLabel}
      environmentGoneStatus={threadEnvironmentGoneStatus}
      environmentHostId={environment?.hostId}
      isEnvironmentActionPending={requestEnvironmentAction.isPending}
      onCreateNewThreadInWorktree={onCreateNewThreadInWorktree}
      onPullRequestMerge={handlePullRequestMerge}
      onPullRequestDraft={handlePullRequestDraft}
      onPullRequestReady={handlePullRequestReady}
      pullRequestMergeMethod={pullRequestMergeMethod}
      onChangedFileClick={handleChangedFileClick}
      projectId={projectId}
      resolveMentionLink={resolveMentionLink}
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
              branchRef: selectedMergeBaseBranchRef,
              options: mergeBaseBranchOptions,
              remoteOptions: mergeBaseRemoteBranchOptions,
              optionsLoading: isLoadingMergeBaseBranchOptions,
              onChange: handleMergeBaseBranchChange,
              onPickerOpenChange: handleMergeBasePickerOpenChange,
              onSearchQueryChange: setMergeBaseBranchSearchQuery,
            }
          : null
      }
      composerFocusRequestNonce={composerFocusRequestNonce}
      sendMessage={sendMessage}
      sentMessageEdit={sentMessageEdit}
      steerActiveThreadOnEnter={
        systemConfigQuery.data?.generalSettings.steerActiveThreadOnEnter ??
        defaultAppSettings.steerActiveThreadOnEnter
      }
      pendingInteractions={pendingInteractions}
      pendingInteractionsInitialLoading={pendingInteractionsInitialLoading}
      queuedMessageCount={thread.queuedMessageCount}
      pendingTodos={pendingTodos}
      activePromptMode={activePromptMode}
      goal={goal}
      modelFallback={modelFallback}
      activeWorkflows={activeWorkflows}
      activeBackgroundCommands={activeBackgroundCommands}
      parentThreadSection={parentThreadSection}
      childPendingInteractions={childPendingInteractions}
      childThreadsSection={childThreadsSection}
      pullRequest={pullRequest}
      thread={thread}
    />
  );
  const renderSecondaryTabContent = (
    tab: SecondaryFileFixedPanelTab,
  ): ReactNode => {
    switch (tab.kind) {
      case "browser":
        return null;
      case "terminal":
        return (
          <LazyThreadTerminalPanel
            autoFocus={
              tab.id === activeFixedSecondaryTabId && shouldAutoFocusTerminal
            }
            canCreateTerminal={canCreateTerminal}
            isPanelOpen={isSecondaryPanelOpen}
            isPanelPersistedOpen={isPersistedSecondaryPanelOpen}
            onAutoFocusHandled={handleTerminalAutoFocusHandled}
            onOpenLink={handleOpenTimelineLink}
            onSelectionAddToChat={handleSelectionAddToChat}
            syncThreadId={thread.id}
            target={{ kind: "thread", threadId: thread.id }}
            terminalId={tab.terminalId}
          />
        );
      case "new-tab":
        return (
          <LazyNewTabPage
            autoFocus={
              tab.id === activeFixedSecondaryTabId && shouldAutoFocusNewTab
            }
            projectId={projectId ?? undefined}
            environmentId={thread.environmentId ?? null}
            currentThreadId={thread.id}
            onAutoFocusHandled={handleNewTabAutoFocusHandled}
            onSelect={handleSelectFileSearchResult}
            onOpenBrowser={() => {
              activateTab(tab.id);
              openBrowserTabAndReveal();
            }}
            onStartTerminal={
              canCreateTerminal
                ? () => {
                    activateTab(tab.id);
                    handleStartTerminal();
                  }
                : undefined
            }
            pluginActions={pluginPanelActions}
          />
        );
      case "workspace-file-preview": {
        const copyPath = resolveAbsoluteFilePath({
          path: tab.path,
          rootPath: workspacePreviewRootPath,
        });
        return (
          <LazyWorkspaceFilePreviewTabContent
            activePath={tab.path}
            copyPath={copyPath}
            environmentId={tab.environmentId}
            isPanelOpen={isSecondaryPanelOpen}
            lineRange={tab.lineRange}
            markdownLinkRouting={buildMarkdownPreviewLinkRouting({
              baseDir: copyPath
                ? getAbsoluteDirname({ path: copyPath })
                : undefined,
              onOpenLink: handleOpenTimelineLink,
              onOpenLocalFileLink: handleOpenTimelineLocalFileLink,
              rootPath: workspacePreviewRootPath,
            })}
            onOpenInEditor={handleOpenFileInEditor}
            onSelectionAddToChat={handleSelectionAddToChat}
            source={tab.source}
            statusLabel={tab.statusLabel}
            threadId={thread.id}
          />
        );
      }
      case "host-file-preview": {
        const baseDir = getAbsoluteDirname({ path: tab.path });
        return (
          <LazyHostFilePreviewTabContent
            activePath={tab.path}
            copyPath={tab.path}
            environmentId={tab.environmentId}
            isPanelOpen={isSecondaryPanelOpen}
            lineRange={tab.lineRange}
            markdownLinkRouting={buildMarkdownPreviewLinkRouting({
              baseDir,
              onOpenLink: handleOpenTimelineLink,
              onOpenLocalFileLink: handleOpenTimelineLocalFileLink,
              rootPath: resolveHostFilePreviewLinkRootPath({
                baseDir,
                threadStorageRootPath,
                workspaceRootPath: workspacePreviewRootPath,
              }),
            })}
            onOpenInEditor={handleOpenHostFileInEditor}
            onSelectionAddToChat={handleSelectionAddToChat}
            threadId={thread.id}
          />
        );
      }
      case "thread-storage-file-preview": {
        const copyPath = resolveAbsoluteFilePath({
          path: tab.path,
          rootPath: threadStorageRootPath,
        });
        return (
          <LazyThreadStorageFilePreviewTabContent
            activePath={tab.path}
            copyPath={copyPath}
            isPanelOpen={isSecondaryPanelOpen}
            lineRange={tab.lineRange}
            markdownLinkRouting={buildMarkdownPreviewLinkRouting({
              baseDir: copyPath
                ? getAbsoluteDirname({ path: copyPath })
                : undefined,
              onOpenLink: handleOpenTimelineLink,
              onOpenLocalFileLink: handleOpenTimelineLocalFileLink,
              rootPath: threadStorageRootPath,
            })}
            onOpenInEditor={handleOpenStorageFileInEditor}
            onSelectionAddToChat={handleSelectionAddToChat}
            threadId={thread.id}
          />
        );
      }
      case "plugin-panel": {
        const originalTab = createFileOpenerOriginalTab(tab);
        const fileOpenerOriginal =
          originalTab === null
            ? undefined
            : renderSecondaryTabContent(originalTab);
        return (
          <ThreadTimelineNavigationProvider
            environmentId={thread.environmentId}
            onOpenLink={handleOpenTimelineLink}
            onOpenLocalFileLink={handleOpenTimelineLocalFileLink}
            resolveMentionLink={resolveMentionLink}
            workspaceRootPath={environment?.path ?? undefined}
          >
            <PluginPanelTabContent
              tab={tab}
              context={{ kind: "thread", threadId: thread.id }}
              fileOpenerOriginal={fileOpenerOriginal}
            />
          </ThreadTimelineNavigationProvider>
        );
      }
    }
  };
  const filenameOfPanelTab = (path: string) => path.split("/").at(-1) ?? path;
  const panelTabs: readonly SecondaryPanelRenderableTab[] =
    syncedOrderedSecondaryFileTabs.map((tab): SecondaryPanelRenderableTab => {
      const pluginAction =
        tab.kind === "plugin-panel"
          ? pluginThreadPanelActions.find(
              (action) =>
                action.pluginId === tab.pluginId && action.id === tab.actionId,
            )
          : undefined;
      const shared = {
        contentFillsRegion:
          tab.kind === "plugin-panel" &&
          (tab.fileOpenerOwner !== undefined ||
            pluginAction?.layout === "flush"),
        onClose: () => closeTab(tab.id),
        renderContent: () => renderSecondaryTabContent(tab),
        tab,
      };
      switch (tab.kind) {
        case "browser": {
          const browserLabel =
            tab.title ?? (tab.url.length > 0 ? getBrowserUrlHost(tab.url) : "");
          return {
            ...shared,
            label: browserLabel.length > 0 ? browserLabel : "Browser",
            leadingVisual: (
              <Icon
                name="Globe"
                className={COARSE_POINTER_COMPACT_ICON_SIZE_CLASS}
                aria-hidden
              />
            ),
            statusLabel: null,
            onSelect: () => handleActivateFileTab(tab.id),
          };
        }
        case "terminal": {
          const session = terminalsById.get(tab.terminalId);
          return {
            ...shared,
            label: session?.title ?? "Terminal",
            leadingVisual: (
              <Icon
                name="Terminal"
                className={COARSE_POINTER_COMPACT_ICON_SIZE_CLASS}
                aria-hidden
              />
            ),
            statusLabel:
              session === undefined || session.status === "running"
                ? null
                : session.status,
            onSelect: () => handleActivateTerminalTab(tab.terminalId),
            onClose: () => handleCloseTerminalTab(tab.terminalId),
          };
        }
        case "workspace-file-preview":
          return {
            ...shared,
            label: filenameOfPanelTab(tab.path),
            leadingVisual: <RightPanelFileTabIcon path={tab.path} />,
            statusLabel: tab.statusLabel,
            onSelect: () => handleActivateFileTab(tab.id),
          };
        case "host-file-preview":
          return {
            ...shared,
            label: filenameOfPanelTab(tab.path),
            leadingVisual: <RightPanelFileTabIcon path={tab.path} />,
            statusLabel: null,
            onSelect: () => handleActivateFileTab(tab.id),
          };
        case "thread-storage-file-preview":
          return {
            ...shared,
            label: filenameOfPanelTab(tab.path),
            isPinned: tab.isPinned,
            leadingVisual: <RightPanelFileTabIcon path={tab.path} />,
            statusLabel: null,
            onSelect: () => handleActivateFileTab(tab.id),
          };
        case "new-tab":
          return {
            ...shared,
            label: "New tab",
            leadingVisual: (
              <Icon
                name="NewTab"
                className={COARSE_POINTER_COMPACT_ICON_SIZE_CLASS}
                aria-hidden
              />
            ),
            statusLabel: null,
            onSelect: () => handleActivateFileTab(tab.id),
          };
        case "plugin-panel":
          return {
            ...shared,
            label: tab.title,
            leadingVisual: (
              <PluginIcon
                pluginId={tab.pluginId}
                icon={pluginAction?.icon ?? null}
                className={COARSE_POINTER_COMPACT_ICON_SIZE_CLASS}
              />
            ),
            statusLabel: null,
            onSelect: () => handleActivateFileTab(tab.id),
          };
      }
    });
  const threadDetailContent = (
    <MarkdownLocalFileContextMenuContext.Provider
      value={getLocalFileContextMenuItems}
    >
      <BrowserTabLifecycleObserver
        browserTabs={browserTabs}
        threadId={thread.id}
      />
      <UrlOpenRoutingProvider
        openInAppBrowser={
          canOpenUrlsInAppBrowser ? openBrowserTabAndReveal : null
        }
      >
        <AppNavigationHostProvider capabilities={appNavigationCapabilities}>
          <ThreadDetailSecondaryContent
            footer={composerFooter}
            header={timelineHeader}
            isMetadataLoading={environmentQuery.isLoading}
            isSecondaryPanelOpen={isSecondaryPanelOpen}
            isConversationCollapsed={isConversationCollapsed}
            isBoundedPane={isBoundedPane}
            onToggleSecondaryPanel={toggleSecondaryPanel}
            onToggleConversationCollapse={toggleConversationCollapse}
            renderHostedPanel={(panel) => (
              <MarkdownLocalFileContextMenuContext.Provider
                value={getLocalFileContextMenuItems}
              >
                <UrlOpenRoutingProvider
                  openInAppBrowser={
                    canOpenUrlsInAppBrowser ? openBrowserTabAndReveal : null
                  }
                >
                  {panel}
                </UrlOpenRoutingProvider>
              </MarkdownLocalFileContextMenuContext.Provider>
            )}
            metadata={{
              thread,
              projectId,
              parentThreadProjectId: parentThread?.projectId ?? null,
              parentThreadDisplayName: parentThreadDisplayName ?? null,
              parentThreads,
              canAssignToParent,
              canTakeOverThread,
              isLoadingParentThreads: parentThreadSubsetQuery.isLoading,
              isParentThreadsError: parentThreadSubsetQuery.isError,
              environment: environment ?? null,
              environmentDisplayHost: environmentDisplayHostContext,
              workspaceStatus,
              workspaceStatusError: workspaceStatusError ?? null,
              workspaceUnavailable,
              pullRequest,
              selectedMergeBaseBranch,
              mergeBaseBranchRef: selectedMergeBaseBranchRef,
              mergeBaseBranchOptions,
              mergeBaseRemoteBranchOptions,
              isLoadingMergeBaseBranchOptions,
              updateThreadPending:
                updateThread.isPending || updateEnvironment.isPending,
              storage: metadataStorage,
              onAssignParent: handleAssignParent,
              onParentSelectorOpenChange: handleParentSelectorOpenChange,
              onRetryParentThreads: handleRetryParentThreads,
              onMergeBaseBranchChange: handleMergeBaseBranchChange,
              onMergeBasePickerOpenChange: handleMergeBasePickerOpenChange,
              onMergeBaseBranchSearchQueryChange: setMergeBaseBranchSearchQuery,
              onChangedFileClick: canUseGitUi
                ? handleChangedFileClick
                : undefined,
              onCommitClick: canUseGitUi
                ? openSecondaryPanelCommitDiff
                : undefined,
            }}
            secondaryPanel={{
              activeTab: activeFixedSecondaryTab,
              canUseGitUi,
              gitDiffTabStatus,
              environmentId: thread.environmentId ?? undefined,
              workspaceRootPath: environment?.path,
              tabs: panelTabs,
              fixedTabs: secondaryPanelFixedTabs,
              splitPanelStateId: thread.id,
              renderBrowserDeck,
              isOpen: isSecondaryPanelOpen,
              onClose: closeSecondaryPanel,
              onCollapse: closeSecondaryPanel,
              onClearPendingGitDiffIntent: clearPendingGitDiffIntent,
              onOpenFileInEditor: handleOpenFileInEditor,
              onTabReorder: reorderTab,
              onOpenNewTab: handleOpenNewTab,
              onRetryGitDiffEligibility: () => {
                void environmentQuery.refetch();
              },
              onOpenFilePreview: handleOpenFilePreview,
              onSelectionAddToChat: handleSelectionAddToChat,
              pendingGitDiffCommitSha,
              pendingGitDiffScrollPath,
              requestedMergeBaseBranch,
              onPanelFocus: touchFixedPanelTabsState,
            }}
            timeline={{
              activeThinking,
              canSpawnChild: thread.canSpawnChild,
              contextBoundarySeq,
              threadOriginKind,
              hasOlderTimelineRows,
              hostConnectionNotice,
              isLoadingOlderTimelineRows,
              isThreadTimelinePending,
              timelineError: Boolean(timelineError),
              onForkMessage: isForkAvailable ? handleForkMessage : undefined,
              onEditMessage: canEditSentMessages
                ? handleEditSentMessage
                : undefined,
              inlineMessageEditor,
              onMessageAddToChat: handleSelectionAddToChat,
              onSendToMainMessage: handleSendToMainMessage,
              onSelectionAddToChat: handleSelectionAddToChat,
              onLoadOlderRows: loadOlderTimelineRows,
              onOpenLink: handleOpenTimelineLink,
              onOpenLocalFileLink: handleOpenTimelineLocalFileLink,
              onOpenPluginPanel: handleOpenTimelinePluginPanel,
              onTitleAction: handleTimelineTitleAction,
              projectId,
              resolveMentionLink,
              showOngoingIndicator:
                thread.status !== "stopping" &&
                !hasPendingInteraction &&
                isRunningThreadRuntimeDisplayStatus(
                  thread.runtime.displayStatus,
                ) &&
                !isThreadTimelinePending,
              ongoingIndicatorLabel:
                thread.runtime.displayStatus === "host-reconnecting"
                  ? "Waiting for reconnection"
                  : undefined,
              timelineRows,
              isStopping: thread.status === "stopping",
              stoppingAnchorAt: thread.updatedAt,
              threadId: thread.id,
              threadRuntimeDisplayStatus: thread.runtime.displayStatus,
              unreadDividerAutoScroll: unreadDividerState.autoScroll,
              unreadDividerPlacement: unreadDividerState.placement,
              workspaceRootPath: environment?.path ?? undefined,
            }}
          />
          {canUseGitUi ? (
            <ThreadGitActionDialog
              target={gitActions.threadGitActionDialog.target}
              branchName={threadBranchName}
              gitStatusDisplay={threadGitStatusDisplay}
              changedFilesSection={workingTreeChangedFilesSection}
              onOpenChange={(open) => {
                if (!open) {
                  gitActions.threadGitActionDialog.onClose();
                }
              }}
              onCommit={gitActions.handleCommitThread}
            />
          ) : null}
        </AppNavigationHostProvider>
      </UrlOpenRoutingProvider>
    </MarkdownLocalFileContextMenuContext.Provider>
  );
  return (
    <>
      <ThreadArchiveCommandHandler thread={thread} />
      <ThreadRenameCommandHandler thread={thread} />
      <ThreadProviderContext.Provider value={threadProviderContextValue}>
        <PluginThreadPanelNavigationProvider
          openThreadPanel={handleOpenTimelinePluginPanel}
        >
          {threadDetailContent}
        </PluginThreadPanelNavigationProvider>
      </ThreadProviderContext.Provider>
    </>
  );
}
