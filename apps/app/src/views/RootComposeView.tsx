import { useCallback, useEffect, useMemo, useState } from "react";
import { useLocation, useNavigate } from "react-router-dom";
import { useQueryClient } from "@tanstack/react-query";
import {
  findCachedProviderInfo,
  useSystemProviders,
} from "@/hooks/queries/system-queries";
import {
  findLocalPathProjectSourceForHost,
  type EnvironmentStatus,
  type Host,
  type ProviderInfo,
  type ReasoningLevel,
  type ServiceTier,
  type ThreadListEntry,
} from "@bb/domain";
import type {
  SidebarBootstrapResponse,
  TerminalSession,
} from "@bb/server-contract";
import {
  NewThreadComposer,
  type NewThreadComposerState,
  type NewThreadComposerSubmission,
} from "@/components/promptbox/NewThreadComposer";
import { ProviderCliVersionBanner } from "@/components/promptbox/banner/ProviderCliVersionBanner";
import {
  buildProviderCliIssue,
  hasProviderCliAction,
  useProviderCliInstallRunner,
} from "@/components/provider-cli/provider-cli-install";
import { providerCliJobKey } from "@/components/provider-cli/provider-cli-install-store";
import {
  encodeHostValue,
  encodeReuseValue,
} from "@/components/pickers/environment-picker-value";
import {
  ProjectMachineSetupDialog,
  type ProjectMachineSetupCompletion,
  type ProjectMachineSetupDialogTarget,
} from "@/components/dialogs/ProjectMachineSetupDialog";
import { HEADER_ICON_BUTTON_CLASS } from "@/components/layout/AppPageHeader";
import { RIGHT_PANEL_TOGGLE_ICON_NAME } from "@/components/secondary-panel/panelToggleControlState";
import { AppCommandShortcutHint } from "@/components/commands/AppCommandShortcutHint";
import type {
  SecondaryPanelPaneRenderContext,
  SecondaryPanelRenderableTab,
} from "@/components/secondary-panel/ThreadSecondaryPanel";
import {
  LazyBrowserTabDeck,
  preloadThreadSecondaryPanel,
} from "@/components/secondary-panel/lazySecondaryPanelComponents";
import type { BrowserAddressFocusRequest } from "@/components/secondary-panel/BrowserTabContent";
import { EmptyStatePanel } from "@bb/shared-ui/empty-state";
import { Icon } from "@bb/shared-ui/icon";
import { PageShell } from "@/components/ui/page-shell.js";
import { RouteLoadingSkeleton } from "@/components/ui/route-loading-skeleton";
import { Button } from "@bb/shared-ui/button";
import { useIsCompactViewport } from "@bb/shared-ui/hooks/use-compact-viewport";
import { usePointerCoarse } from "@bb/shared-ui/hooks/use-pointer-coarse";
import { COARSE_POINTER_COMPACT_ICON_SIZE_CLASS } from "@bb/shared-ui/coarse-pointer-sizing";
import { PluginIcon } from "@/components/plugin/PluginIcon";
import type { FileOpenerOverride } from "@/lib/plugin-slot-resolvers";
import { usePluginNewThreadPanelActions } from "@/components/plugin/PluginPanelActions";
import { usePluginSlots } from "@/lib/plugin-slots";
import { useCreateThread } from "@/hooks/mutations/thread-runtime-mutations";
import {
  useCloseTerminal,
  useCloseEnvironmentTerminal,
  useCreateTerminal,
  useCreateEnvironmentTerminal,
  useEnvironmentTerminals,
  useTerminals,
} from "@/hooks/queries/thread-terminal-queries";
import { useEnvironment } from "@/hooks/queries/environment-queries";
import { useHostProviderCliStatus } from "@/hooks/queries/system-queries";
import {
  requestComposerFocus,
  subscribeComposerFocusRequests,
} from "@/lib/composer-focus-requests";
import { PluginComposerHostProvider } from "@/components/plugin/plugin-composer-host";
import type { PromptMentionLinkResolver } from "@/components/promptbox/editor/prompt-mention-link";
import { useQuickCreateProjectController } from "@/hooks/useQuickCreateProject";
import type { PromptDraftAttachment } from "@bb/client-core";
import {
  buildForkThreadRequest,
  FORK_THREAD_CREATE_SEED_LOCATION_STATE_KEY,
  type ForkThreadCreateSeed,
} from "@bb/client-core";
import {
  buildThreadHandoffPromptDraft,
  readThreadHandoffCreateSeedFromLocationState,
} from "@bb/client-core";
import { useNavigateToThreadAfterCreatePreference } from "@/lib/root-compose-create-preference";
import {
  readInitialPromptFromSearch,
  stripInitialPromptFromSearch,
} from "./root-compose-initial-prompt";
import {
  getThreadRoutePath,
  getProjectComposeRoutePath,
  getRootComposeRoutePath,
  isRoutePath,
} from "@/lib/route-paths";
import { getBrowserUrlHost } from "@/lib/browser-url";
import {
  getDesktopBrowserApi,
  isDesktopBrowserAvailable,
} from "@/lib/bb-desktop";
import {
  useFixedPanelTabsState,
  useFixedPanelTabsStorageMaintenance,
  useRemoveFixedRightTerminalTab,
  useSetFixedRightTerminalActiveTerminal,
  useTouchFixedPanelTabsState,
  useUpdateFixedPanelTabsState,
} from "@/lib/fixed-panel-tabs";
import { createNewTabFixedPanelTab } from "@/lib/fixed-panel-tabs-state";
import type {
  HostFileTabState,
  ThreadStorageFileTabState,
  WorkspaceFileTabState,
} from "@bb/client-core";
import {
  resolveUrlOpenTarget,
  useOpenLinksInAppBrowserPreference,
} from "@/lib/in-app-browser-link-preference";
import type { MarkdownPreviewLinkHandler } from "@/components/ui/markdown-link";
import { UrlOpenRoutingProvider } from "@/lib/url-open-routing";
import {
  AppNavigationHostProvider,
  type AppFilePreviewIntent,
  type AppFixedTabOpenIntent,
} from "@/lib/app-navigation-host";
import { openAppFixedTabFromDestinations } from "@/lib/app-fixed-tab-navigation";
import {
  normalizeExperimentalFileOpenOptions,
  toFilePreviewLineRange,
} from "@/lib/live-file-navigation";
import {
  useRootComposeProjectId,
  useSetRootComposeProjectId,
} from "@/lib/root-compose-selection";
import {
  ROOT_COMPOSE_PINNED_PANEL_TOGGLE_POSITION_CLASS,
  RootComposeSecondaryContent,
} from "./RootComposeSecondaryContent";
import { resolveComposeHostId } from "./root-compose-environment-selection";
import { RootComposeMobileRecents } from "./RootComposeMobileRecents";
import { RootComposeEmptyWelcome } from "./RootComposeEmptyWelcome";
import {
  shouldLoadThreadStorageFileList,
  useThreadStorageViewer,
} from "@/components/secondary-panel/useThreadStorageViewer";
import {
  useThreadFileTabs,
  type FileSearchSelection,
} from "@/components/secondary-panel/useThreadFileTabs";
import { isSecondaryFileTab } from "@bb/client-core";
import { RightPanelFileTabIcon } from "@/components/secondary-panel/RightPanelFileTabIcon";
import {
  DEFAULT_TERMINAL_COLS,
  DEFAULT_TERMINAL_ROWS,
} from "@/components/thread/terminal/useThreadTerminalController";
import {
  buildTerminalSyncedSecondaryFileTabs,
  getRetainedTerminalTabId,
  syncTerminalTabsInFixedPanelState,
} from "@/components/secondary-panel/terminalPanelTabs";
import {
  getActiveFixedSecondaryTab,
  useSetThreadSecondaryPanelSelection,
} from "./thread-detail/threadSecondaryPanelSelection";
import {
  useThreadSecondaryPanelDrawerVisibility,
  useThreadSecondaryPanelVisibility,
} from "./thread-detail/useThreadSecondaryPanelVisibility";
import type { ThreadSecondaryPanelHostFileOpenHandler } from "./thread-detail/useThreadSecondaryPanelVisibility";
import {
  useAppCommandHandler,
  useAppCommandShortcut,
} from "@/components/commands/AppCommandProvider";
import { useOptionalPaneContext } from "./thread-detail/PaneContext";
import { RootComposePanelCommandHandlers } from "./RootComposePanelCommandHandlers";
import {
  ROOT_COMPOSE_FIXED_PANEL_STATE_ID,
  RootComposePanelTabContent,
  type RootComposeTerminalTarget,
} from "./RootComposePanelTabContent";

const ROOT_COMPOSE_SIDEBAR_ACTION_ALIGNED_TOP_PADDING_CLASS = "pt-14";

const ROOT_COMPOSE_EMPTY_WELCOME_CONTENT_CLASS =
  "min-h-full flex-1 items-center justify-center pb-12";
const EMPTY_TERMINAL_SESSIONS: readonly TerminalSession[] = [];

interface LegacyProjectComposeRedirectProps {
  projectId: string;
}

export function readSectionIdFromLocationState(state: unknown): string | null {
  if (typeof state !== "object" || state === null) {
    return null;
  }
  if (!("sectionId" in state) || typeof state.sectionId !== "string") {
    return null;
  }
  const sectionId = state.sectionId.trim();
  return sectionId.length > 0 ? sectionId : null;
}

type RootComposeSectionTarget =
  | { kind: "clear" }
  | { sectionId: string; kind: "set" };

export function readRootComposeSectionTargetFromLocationState(
  state: unknown,
): RootComposeSectionTarget | null {
  if (typeof state !== "object" || state === null) {
    return null;
  }

  if ("sectionId" in state) {
    const sectionId = readSectionIdFromLocationState(state);
    return sectionId ? { sectionId, kind: "set" } : { kind: "clear" };
  }

  if ("focusPrompt" in state && state.focusPrompt === true) {
    return { kind: "clear" };
  }

  return null;
}

export function shouldStartComposingFromLocationState(state: unknown): boolean {
  if (typeof state !== "object" || state === null) {
    return false;
  }
  return "focusPrompt" in state && state.focusPrompt === true;
}

interface BuildMobileRecentThreadsArgs {
  sidebarNavigation: SidebarBootstrapResponse | undefined;
}

interface ShouldNavigateAfterThreadCreateArgs {
  isForkDraft: boolean;
  navigateToThreadAfterCreate: boolean;
}

interface CanCreateRootComposeTerminalArgs {
  connectedHostIds: ReadonlySet<string>;
  environmentHostId: string | null | undefined;
  terminalTarget: RootComposeTerminalTarget | null;
  environmentStatus: EnvironmentStatus | undefined;
}

interface BuildRootComposeTerminalSessionsArgs {
  environmentTerminalSessions: readonly TerminalSession[] | undefined;
  globalTerminalSessions: readonly TerminalSession[] | undefined;
  terminalTarget: RootComposeTerminalTarget | null;
}

interface RootComposeRightPanelToggleProps {
  isOpen: boolean;
  onToggle: () => void;
}

export function RootComposeRightPanelToggle({
  isOpen,
  onToggle,
}: RootComposeRightPanelToggleProps) {
  const shortcut = useAppCommandShortcut("panel.toggle");
  const rightPanelLabel = isOpen ? "Hide right panel" : "Show right panel";
  const rightPanelIconName = RIGHT_PANEL_TOGGLE_ICON_NAME;

  useEffect(() => {
    if (typeof window.requestIdleCallback === "function") {
      const idleCallback = window.requestIdleCallback(
        preloadThreadSecondaryPanel,
        { timeout: 1000 },
      );
      return () => window.cancelIdleCallback(idleCallback);
    }
    const timeout = window.setTimeout(preloadThreadSecondaryPanel, 1000);
    return () => window.clearTimeout(timeout);
  }, []);

  return (
    <Button
      type="button"
      variant="ghost"
      size="icon"
      className={`${HEADER_ICON_BUTTON_CLASS} relative`}
      aria-label={
        shortcut ? `${rightPanelLabel} (${shortcut.label})` : rightPanelLabel
      }
      aria-keyshortcuts={shortcut?.ariaKeyshortcuts}
      aria-expanded={isOpen}
      onFocus={preloadThreadSecondaryPanel}
      onPointerDown={preloadThreadSecondaryPanel}
      onClick={onToggle}
    >
      <Icon name={rightPanelIconName} />
      <AppCommandShortcutHint
        shortcut={shortcut}
        className="absolute right-full mr-1"
      />
    </Button>
  );
}

function readReuseEnvironmentIdFromLocationState(
  state: unknown,
): string | null {
  if (!state || typeof state !== "object") return null;
  const candidate = (state as { reuseEnvironmentId?: unknown })
    .reuseEnvironmentId;
  if (typeof candidate === "string" && candidate.length > 0) return candidate;
  return null;
}

export function shouldNavigateAfterThreadCreate({
  isForkDraft,
  navigateToThreadAfterCreate,
}: ShouldNavigateAfterThreadCreateArgs): boolean {
  return isForkDraft || navigateToThreadAfterCreate;
}

function readForkThreadCreateSeedFromLocationState(
  state: unknown,
): ForkThreadCreateSeed | null {
  if (!state || typeof state !== "object") return null;
  const candidate = (state as Record<string, unknown>)[
    FORK_THREAD_CREATE_SEED_LOCATION_STATE_KEY
  ];
  if (!candidate || typeof candidate !== "object") return null;
  const value = candidate as Record<string, unknown>;
  if (
    typeof value.environmentId !== "string" ||
    value.environmentId.length === 0 ||
    typeof value.model !== "string" ||
    value.model.length === 0 ||
    typeof value.permissionMode !== "string" ||
    value.permissionMode.length === 0 ||
    typeof value.projectId !== "string" ||
    value.projectId.length === 0 ||
    typeof value.providerId !== "string" ||
    value.providerId.length === 0 ||
    typeof value.reasoningLevel !== "string" ||
    value.reasoningLevel.length === 0 ||
    typeof value.sourceThreadId !== "string" ||
    value.sourceThreadId.length === 0 ||
    typeof value.sourceThreadTitle !== "string" ||
    value.sourceThreadTitle.trim().length === 0
  ) {
    return null;
  }
  const seedPermissionMode =
    value.permissionMode === "workspace-write"
      ? "accept-edits"
      : value.permissionMode === "accept-edits" ||
          value.permissionMode === "auto" ||
          value.permissionMode === "full"
        ? value.permissionMode
        : null;
  if (seedPermissionMode === null) {
    return null;
  }
  if (
    value.serviceTier !== undefined &&
    typeof value.serviceTier !== "string"
  ) {
    return null;
  }
  if (
    value.sourceSeqEnd !== undefined &&
    (typeof value.sourceSeqEnd !== "number" ||
      !Number.isInteger(value.sourceSeqEnd) ||
      value.sourceSeqEnd < 0)
  ) {
    return null;
  }
  return {
    environmentId: value.environmentId,
    model: value.model,
    permissionMode: seedPermissionMode,
    projectId: value.projectId,
    providerId: value.providerId,
    reasoningLevel: value.reasoningLevel as ReasoningLevel,
    serviceTier: value.serviceTier as ServiceTier | undefined,
    sourceSeqEnd: value.sourceSeqEnd as number | undefined,
    sourceThreadId: value.sourceThreadId,
    sourceThreadTitle: value.sourceThreadTitle.trim(),
  };
}

export function hasSingleUseRootComposeTargetState(state: unknown): boolean {
  return (
    readRootComposeSectionTargetFromLocationState(state) !== null ||
    readReuseEnvironmentIdFromLocationState(state) !== null ||
    readForkThreadCreateSeedFromLocationState(state) !== null ||
    readThreadHandoffCreateSeedFromLocationState(state) !== null
  );
}

export function readInitialPromptFromLocationState(
  state: unknown,
): string | null {
  if (!state || typeof state !== "object") return null;
  const candidate = (state as { initialPrompt?: unknown }).initialPrompt;
  if (typeof candidate === "string" && candidate.length > 0) return candidate;
  return null;
}

export function shouldReplaceInitialPromptFromLocationState(
  state: unknown,
): boolean {
  return (
    state !== null &&
    typeof state === "object" &&
    "replaceInitialPrompt" in state &&
    state.replaceInitialPrompt === true
  );
}

export function buildMobileRecentThreads({
  sidebarNavigation,
}: BuildMobileRecentThreadsArgs): ThreadListEntry[] {
  if (!sidebarNavigation) return [];

  const threads: ThreadListEntry[] = [
    ...sidebarNavigation.personalProject.threads,
  ];
  for (const project of sidebarNavigation.projects) {
    threads.push(...project.threads);
  }
  return threads;
}

export function canCreateRootComposeTerminal({
  connectedHostIds,
  environmentHostId,
  terminalTarget,
  environmentStatus,
}: CanCreateRootComposeTerminalArgs): boolean {
  if (terminalTarget === null) {
    return false;
  }
  if (terminalTarget.kind === "environment") {
    return (
      environmentStatus === "ready" &&
      environmentHostId !== null &&
      environmentHostId !== undefined &&
      connectedHostIds.has(environmentHostId)
    );
  }
  return connectedHostIds.has(terminalTarget.hostId);
}

export function buildRootComposeTerminalSessions({
  environmentTerminalSessions,
  globalTerminalSessions,
  terminalTarget,
}: BuildRootComposeTerminalSessionsArgs):
  | readonly TerminalSession[]
  | undefined {
  if (terminalTarget?.kind === "environment") {
    return environmentTerminalSessions;
  }
  if (terminalTarget?.kind === "host_path") {
    return globalTerminalSessions?.filter(
      (session) =>
        session.threadId === null &&
        session.environmentId === null &&
        session.hostId === terminalTarget.hostId &&
        (terminalTarget.cwd === null ||
          session.initialCwd === terminalTarget.cwd),
    );
  }
  return undefined;
}

export function LegacyProjectComposeRedirect({
  projectId,
}: LegacyProjectComposeRedirectProps) {
  const location = useLocation();
  const navigate = useNavigate();
  const setRootComposeProjectId = useSetRootComposeProjectId();

  useEffect(() => {
    setRootComposeProjectId(projectId);
    navigate(getRootComposeRoutePath(), {
      replace: true,
      state: location.state,
    });
  }, [location.state, navigate, projectId, setRootComposeProjectId]);

  return <RouteLoadingSkeleton isBoundedPane={false} />;
}

export function RootComposeView() {
  const [rootComposeProjectId, setRootComposeProjectId] =
    useRootComposeProjectId();
  const location = useLocation();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const createThread = useCreateThread();
  const [rootComposeSectionId, setRootComposeSectionId] = useState<
    string | null
  >(() => readSectionIdFromLocationState(location.state));
  const [lastCreatedThreadId, setLastCreatedThreadId] = useState<string | null>(
    null,
  );
  const [startedComposing, setStartedComposing] = useState(() =>
    shouldStartComposingFromLocationState(location.state),
  );
  const [navigateToThreadAfterCreate] =
    useNavigateToThreadAfterCreatePreference();
  const [forkSeed, setForkSeed] = useState<ForkThreadCreateSeed | null>(() =>
    readForkThreadCreateSeedFromLocationState(location.state),
  );

  const handleProjectChange = useCallback(
    (projectId: string) => {
      setForkSeed(null);
      setRootComposeProjectId(projectId);
    },
    [setRootComposeProjectId],
  );
  const handleSubmit = useCallback(
    async (request: NewThreadComposerSubmission) => {
      const shouldNavigateToCreatedThread = shouldNavigateAfterThreadCreate({
        isForkDraft: forkSeed !== null,
        navigateToThreadAfterCreate,
      });
      const { sendAt, ...requestFields } = request;
      const createRequest =
        forkSeed === null
          ? {
              ...requestFields,
              ...(rootComposeSectionId
                ? { sectionId: rootComposeSectionId }
                : {}),
            }
          : buildForkThreadRequest({
              ...forkSeed,
              input: request.input,
              model: request.model,
              permissionMode: request.permissionMode,
              providerSupportsFork:
                findCachedProviderInfo(queryClient, forkSeed.providerId)
                  ?.capabilities.supportsFork ?? false,
              reasoningLevel: request.reasoningLevel,
              serviceTier: request.serviceTier,
            });
      if (createRequest === null) return;
      const thread = await createThread.mutateAsync(
        sendAt === undefined ? createRequest : { ...createRequest, sendAt },
      );
      setLastCreatedThreadId(thread.id);
      setForkSeed(null);
      setRootComposeSectionId(null);
      if (shouldNavigateToCreatedThread) {
        navigate(
          getThreadRoutePath({
            projectId: thread.projectId,
            threadId: thread.id,
          }),
        );
      }
    },
    [
      createThread,
      forkSeed,
      queryClient,
      navigate,
      navigateToThreadAfterCreate,
      rootComposeSectionId,
    ],
  );
  const composerSeed = useMemo(
    () =>
      forkSeed === null
        ? undefined
        : {
            providerId: forkSeed.providerId,
            model: forkSeed.model,
            reasoningLevel: forkSeed.reasoningLevel,
            serviceTier: forkSeed.serviceTier,
            permissionMode: forkSeed.permissionMode,
            environment: {
              type: "reuse" as const,
              environmentId: forkSeed.environmentId,
            },
          },
    [forkSeed],
  );

  return (
    <NewThreadComposer
      projectId={rootComposeProjectId}
      onProjectChange={handleProjectChange}
      draftStorage={{ kind: "new-thread" }}
      selectionScope="new-thread"
      seed={composerSeed}
      resetKey={forkSeed?.sourceThreadId ?? null}
      preferReadyProviderWhenUnset={forkSeed === null}
      onSubmit={handleSubmit}
    >
      {(composer) => (
        <RootComposeSurface
          composer={composer}
          forkSeed={forkSeed}
          lastCreatedThreadId={lastCreatedThreadId}
          rootComposeProjectId={rootComposeProjectId}
          setForkSeed={setForkSeed}
          setRootComposeProjectId={setRootComposeProjectId}
          setRootComposeSectionId={setRootComposeSectionId}
          setStartedComposing={setStartedComposing}
          startedComposing={startedComposing}
        />
      )}
    </NewThreadComposer>
  );
}

interface RootComposeSurfaceProps {
  composer: NewThreadComposerState;
  forkSeed: ForkThreadCreateSeed | null;
  lastCreatedThreadId: string | null;
  rootComposeProjectId: string;
  setForkSeed: (seed: ForkThreadCreateSeed | null) => void;
  setRootComposeProjectId: (projectId: string) => void;
  setRootComposeSectionId: (sectionId: string | null) => void;
  setStartedComposing: (started: boolean) => void;
  startedComposing: boolean;
}

function RootComposeSurface({
  composer,
  forkSeed,
  lastCreatedThreadId,
  rootComposeProjectId,
  setForkSeed,
  setRootComposeProjectId,
  setRootComposeSectionId,
  setStartedComposing,
  startedComposing,
}: RootComposeSurfaceProps) {
  const paneContext = useOptionalPaneContext();
  const isFocusedPane = paneContext?.isFocused ?? true;
  const location = useLocation();
  const navigate = useNavigate();
  const isPointerCoarse = usePointerCoarse();
  const quickCreateProject = useQuickCreateProjectController();
  const {
    projectId,
    isProjectless,
    projects,
    sidebarNavigation,
    sidebarNavigationError,
    currentProject,
    projectSources,
    connectedHostIds,
    primaryHostId,
    parsedEnvironment,
    projectHostId: rootProjectHostId,
    panelThreadId: rootPanelThreadId,
    selectedProviderId,
    promptDraft,
    promptBoxRef,
    pluginComposerHost: sharedPluginComposerHost,
    textEffects: promptTextEffects,
    isSubmitting,
    seedEnvironmentSelectionValue,
    setEnvironmentSelectionValue,
    setProviderModelReasoning,
    setPermissionMode,
    setServiceTier,
    renderPromptBox,
  } = composer;
  const rootPanelEnvironmentId =
    parsedEnvironment?.type === "reuse"
      ? parsedEnvironment.environmentId
      : null;
  const pluginComposerHost = useMemo(
    () => ({
      ...sharedPluginComposerHost,
      focus: () => requestComposerFocus(promptDraft.storageKey),
    }),
    [promptDraft.storageKey, sharedPluginComposerHost],
  );

  useEffect(() => {
    if (projectId === rootComposeProjectId) return;
    setRootComposeProjectId(projectId);
  }, [projectId, rootComposeProjectId, setRootComposeProjectId]);
  useEffect(
    () =>
      subscribeComposerFocusRequests(promptDraft.storageKey, () => {
        setStartedComposing(true);
        window.requestAnimationFrame(() => promptBoxRef.current?.focusEnd());
      }),
    [promptBoxRef, promptDraft.storageKey, setStartedComposing],
  );
  const handleRootPanelSelectionAddToChat = useCallback(
    (text: string, attachments?: readonly PromptDraftAttachment[]) => {
      promptDraft.addQuote(text, attachments);
      setStartedComposing(true);
      window.requestAnimationFrame(() => promptBoxRef.current?.focusEnd());
    },
    [promptBoxRef, promptDraft, setStartedComposing],
  );

  const setPromptDraft = promptDraft.setDraft;
  const restorePromptDraftIfEmpty = promptDraft.restoreIfEmpty;

  useEffect(() => {
    const initialPrompt = readInitialPromptFromSearch(location.search);
    if (initialPrompt === null) return;
    setStartedComposing(true);
    setPromptDraft({ text: initialPrompt, mentions: [], attachments: [] });
    navigate(
      getRootComposeRoutePath() + stripInitialPromptFromSearch(location.search),
      { replace: true, state: location.state },
    );
  }, [
    location.search,
    location.state,
    navigate,
    setPromptDraft,
    setStartedComposing,
  ]);
  useEffect(() => {
    const sectionTarget = readRootComposeSectionTargetFromLocationState(
      location.state,
    );
    const reuseEnvironmentId = readReuseEnvironmentIdFromLocationState(
      location.state,
    );
    const nextForkSeed = readForkThreadCreateSeedFromLocationState(
      location.state,
    );
    const nextHandoffSeed = readThreadHandoffCreateSeedFromLocationState(
      location.state,
    );
    if (!hasSingleUseRootComposeTargetState(location.state)) return;
    if (shouldStartComposingFromLocationState(location.state)) {
      setStartedComposing(true);
    }
    if (sectionTarget?.kind === "set") {
      setRootComposeSectionId(sectionTarget.sectionId);
    } else if (sectionTarget?.kind === "clear") {
      setRootComposeSectionId(null);
    }
    if (reuseEnvironmentId !== null) {
      seedEnvironmentSelectionValue(encodeReuseValue(reuseEnvironmentId));
    }
    if (nextForkSeed !== null && nextHandoffSeed === null) {
      setForkSeed(nextForkSeed);
      setRootComposeProjectId(nextForkSeed.projectId);
      setProviderModelReasoning(nextForkSeed);
      setPermissionMode(nextForkSeed.permissionMode);
      setServiceTier(nextForkSeed.serviceTier);
      seedEnvironmentSelectionValue(
        encodeReuseValue(nextForkSeed.environmentId),
      );
    }
    if (nextHandoffSeed !== null) {
      setStartedComposing(true);
      setRootComposeProjectId(nextHandoffSeed.projectId);
      setForkSeed(null);
      if (nextHandoffSeed.environmentId !== null) {
        seedEnvironmentSelectionValue(
          encodeReuseValue(nextHandoffSeed.environmentId),
        );
      }
      setPromptDraft(buildThreadHandoffPromptDraft(nextHandoffSeed));
    }
    navigate(getRootComposeRoutePath() + location.search, {
      replace: true,
      state: null,
    });
  }, [
    location.search,
    location.state,
    navigate,
    seedEnvironmentSelectionValue,
    setForkSeed,
    setPermissionMode,
    setPromptDraft,
    setProviderModelReasoning,
    setRootComposeProjectId,
    setRootComposeSectionId,
    setServiceTier,
    setStartedComposing,
  ]);
  useEffect(() => {
    const initialPrompt = readInitialPromptFromLocationState(location.state);
    if (initialPrompt === null) return;
    const nextDraft = { text: initialPrompt, mentions: [], attachments: [] };
    if (shouldReplaceInitialPromptFromLocationState(location.state)) {
      setPromptDraft(nextDraft);
    } else {
      restorePromptDraftIfEmpty(nextDraft);
    }
    navigate(getRootComposeRoutePath() + location.search, {
      replace: true,
      state: { focusPrompt: true },
    });
  }, [
    location.search,
    location.state,
    navigate,
    restorePromptDraftIfEmpty,
    setPromptDraft,
  ]);
  const shouldFocusPrompt =
    typeof location.state === "object" &&
    location.state !== null &&
    "focusPrompt" in location.state &&
    location.state.focusPrompt === true;
  useEffect(() => {
    if (!shouldFocusPrompt || isPointerCoarse) return;
    const handle = window.requestAnimationFrame(() => {
      promptBoxRef.current?.focusEnd();
    });
    return () => window.cancelAnimationFrame(handle);
  }, [isPointerCoarse, location.key, promptBoxRef, shouldFocusPrompt]);

  const mobileRecentThreads = useMemo(
    () => buildMobileRecentThreads({ sidebarNavigation }),
    [sidebarNavigation],
  );
  const systemProviders = useSystemProviders().data;
  const mobileRecentProvidersById = useMemo(() => {
    const byId = new Map<string, ProviderInfo>();
    for (const provider of systemProviders ?? []) {
      byId.set(provider.id, provider);
    }
    return byId;
  }, [systemProviders]);
  const mobileRecentProjectNamesById = useMemo(() => {
    const namesById = new Map<string, string>();
    if (!sidebarNavigation) return namesById;
    namesById.set(
      sidebarNavigation.personalProject.id,
      sidebarNavigation.personalProject.name,
    );
    for (const project of sidebarNavigation.projects) {
      namesById.set(project.id, project.name);
    }
    return namesById;
  }, [sidebarNavigation]);

  const composeHostId = resolveComposeHostId(parsedEnvironment, primaryHostId);
  const providerCliStatus = useHostProviderCliStatus({
    hostId: composeHostId,
    enabled: composeHostId !== null,
  });
  const { queuedJobKeys, runningJobKey, startInstall } =
    useProviderCliInstallRunner();
  const selectedProviderCliStatus =
    providerCliStatus.data?.[selectedProviderId] ?? null;
  const isProviderCliVersionBlocked =
    selectedProviderCliStatus?.versionUnsupported === true;
  const selectedProviderCliIssue = useMemo(() => {
    if (!isProviderCliVersionBlocked || selectedProviderCliStatus === null) {
      return null;
    }
    const issue = buildProviderCliIssue({
      provider: selectedProviderId,
      status: selectedProviderCliStatus,
    });
    return issue && hasProviderCliAction(issue) ? issue : null;
  }, [
    isProviderCliVersionBlocked,
    selectedProviderCliStatus,
    selectedProviderId,
  ]);
  const handleUpdateProviderCli = useCallback(() => {
    if (selectedProviderCliIssue === null || composeHostId === null) return;
    startInstall({ hostId: composeHostId, issue: selectedProviderCliIssue });
  }, [selectedProviderCliIssue, composeHostId, startInstall]);

  useFixedPanelTabsStorageMaintenance();
  const fixedPanelTabsState = useFixedPanelTabsState(
    ROOT_COMPOSE_FIXED_PANEL_STATE_ID,
    null,
  );
  const isPersistedSecondaryPanelOpen = fixedPanelTabsState.secondary.isOpen;
  const activeFixedSecondaryTab = getActiveFixedSecondaryTab({
    fixedPanelTabsState,
  });
  const retainedTerminalId = useMemo(
    () =>
      getRetainedTerminalTabId({
        activeTab: activeFixedSecondaryTab,
        isPanelOpen: isPersistedSecondaryPanelOpen,
      }),
    [activeFixedSecondaryTab, isPersistedSecondaryPanelOpen],
  );
  const activeFixedSecondaryTabId = activeFixedSecondaryTab?.id ?? null;
  const isCompactViewport = useIsCompactViewport();
  const secondaryPanelDrawerVisibility =
    useThreadSecondaryPanelDrawerVisibility({
      isCompactViewport,
      threadId: ROOT_COMPOSE_FIXED_PANEL_STATE_ID,
    });
  const isSecondaryPanelOpen = isCompactViewport
    ? secondaryPanelDrawerVisibility.isDrawerVisible
    : isPersistedSecondaryPanelOpen;
  const touchFixedPanelTabsState = useTouchFixedPanelTabsState(
    ROOT_COMPOSE_FIXED_PANEL_STATE_ID,
    null,
  );
  const updateFixedPanelTabsState = useUpdateFixedPanelTabsState(
    ROOT_COMPOSE_FIXED_PANEL_STATE_ID,
    null,
  );
  const setActiveFixedTerminal = useSetFixedRightTerminalActiveTerminal(
    ROOT_COMPOSE_FIXED_PANEL_STATE_ID,
    null,
  );
  const [shouldAutoFocusTerminal, setShouldAutoFocusTerminal] = useState(false);
  const handleTerminalAutoFocusHandled = useCallback(
    () => setShouldAutoFocusTerminal(false),
    [],
  );
  const removeFixedTerminalTab = useRemoveFixedRightTerminalTab(
    ROOT_COMPOSE_FIXED_PANEL_STATE_ID,
    null,
    secondaryPanelDrawerVisibility.closeDrawer,
  );
  const setRootSecondaryPanel = useSetThreadSecondaryPanelSelection(
    ROOT_COMPOSE_FIXED_PANEL_STATE_ID,
    null,
  );
  const rootPanelEnvironmentQuery = useEnvironment(rootPanelEnvironmentId, {
    enabled: rootPanelEnvironmentId !== null,
    staleTime: 5_000,
  });
  const rootPanelEnvironment = rootPanelEnvironmentQuery.data;
  const rootPanelHostPathTerminalTarget =
    useMemo<RootComposeTerminalTarget | null>(() => {
      if (rootPanelEnvironmentId !== null) {
        return null;
      }
      const selectedHostId = resolveComposeHostId(
        parsedEnvironment,
        primaryHostId,
      );
      if (selectedHostId === null) {
        return null;
      }
      const source =
        findLocalPathProjectSourceForHost(projectSources, selectedHostId) ??
        projectSources.find((projectSource) => projectSource.isDefault) ??
        null;
      if (!source) {
        return {
          kind: "host_path",
          hostId: selectedHostId,
          cwd: null,
        };
      }
      return {
        kind: "host_path",
        hostId: source.hostId,
        cwd: source.path,
      };
    }, [
      parsedEnvironment,
      primaryHostId,
      projectSources,
      rootPanelEnvironmentId,
    ]);
  const rootPanelTerminalTarget = useMemo<RootComposeTerminalTarget | null>(
    () =>
      rootPanelEnvironmentId !== null
        ? { kind: "environment", environmentId: rootPanelEnvironmentId }
        : rootPanelHostPathTerminalTarget,
    [rootPanelEnvironmentId, rootPanelHostPathTerminalTarget],
  );
  const {
    checkThreadStorageFileExists: checkRootThreadStorageFileExists,
    threadStorageFiles: rootThreadStorageFiles,
  } = useThreadStorageViewer({
    fileListEnabled: shouldLoadThreadStorageFileList({
      hasThread: rootPanelThreadId !== null,
      isSecondaryPanelOpen,
      secondaryTabs: fixedPanelTabsState.secondary.tabs,
    }),
    threadId: rootPanelThreadId ?? undefined,
  });
  const environmentTerminalsListQuery = useEnvironmentTerminals(
    rootPanelEnvironmentId ?? "",
    {
      enabled:
        isSecondaryPanelOpen && rootPanelTerminalTarget?.kind === "environment",
    },
  );
  const globalTerminalsListQuery = useTerminals(
    rootPanelTerminalTarget?.kind === "host_path"
      ? {
          kind: "host_path",
          hostId: rootPanelTerminalTarget.hostId,
          ...(rootPanelTerminalTarget.cwd === null
            ? {}
            : { cwd: rootPanelTerminalTarget.cwd }),
        }
      : null,
    {
      enabled:
        isSecondaryPanelOpen && rootPanelTerminalTarget?.kind === "host_path",
    },
  );
  const loadedTerminalSessions = useMemo(
    () =>
      buildRootComposeTerminalSessions({
        environmentTerminalSessions:
          environmentTerminalsListQuery.data?.sessions,
        globalTerminalSessions: globalTerminalsListQuery.data?.sessions,
        terminalTarget: rootPanelTerminalTarget,
      }),
    [
      environmentTerminalsListQuery.data?.sessions,
      globalTerminalsListQuery.data?.sessions,
      rootPanelTerminalTarget,
    ],
  );
  const terminalSessions = loadedTerminalSessions ?? EMPTY_TERMINAL_SESSIONS;
  const terminalsListLoaded = loadedTerminalSessions !== undefined;
  const terminalsById = useMemo(
    () => new Map(terminalSessions.map((session) => [session.id, session])),
    [terminalSessions],
  );
  const [shouldAutoFocusNewTab, setShouldAutoFocusNewTab] = useState(false);
  const handleNewTabAutoFocusHandled = useCallback(
    () => setShouldAutoFocusNewTab(false),
    [],
  );
  const [browserAddressFocusRequest, setBrowserAddressFocusRequest] =
    useState<BrowserAddressFocusRequest | null>(null);
  const { newThreadPanelActions: rootPanelNewThreadPanelActions } =
    usePluginSlots();
  const {
    browserTabs,
    activateTab,
    closeTab,
    openPluginPanel,
    openTab,
    orderedSecondaryFileTabs,
    reopenClosedTab,
    reorderTab,
    selectFileSearchResult,
    updateBrowserTab,
  } = useThreadFileTabs({
    panelStateId: ROOT_COMPOSE_FIXED_PANEL_STATE_ID,
    syncThreadId: null,
    environmentId: rootPanelEnvironmentId,
    fileOwnerThreadId: rootPanelThreadId,
    onCloseLastTab: secondaryPanelDrawerVisibility.closeDrawer,
    preserveWorkspaceTabsAcrossContexts: true,
    projectHostId: rootProjectHostId,
    projectId: isProjectless ? null : projectId,
    retainedTerminalId,
    storageFileExists: checkRootThreadStorageFileExists,
    storageFiles: rootThreadStorageFiles,
    terminalSessions: loadedTerminalSessions,
  });
  const rootPluginPanelActions = usePluginNewThreadPanelActions({
    openPluginPanel,
    projectId: isProjectless ? null : projectId,
  });
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
    if (!terminalsListLoaded) {
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
    terminalsListLoaded,
    updateFixedPanelTabsState,
  ]);
  const canCreateRootTerminal = canCreateRootComposeTerminal({
    connectedHostIds,
    environmentHostId: rootPanelEnvironment?.hostId,
    terminalTarget: rootPanelTerminalTarget,
    environmentStatus: rootPanelEnvironment?.status,
  });
  const openPersistedWorkspaceFile = useCallback(
    (
      file: WorkspaceFileTabState,
      options?: { viewer?: FileOpenerOverride },
    ) => {
      openTab({ kind: "workspace-file-preview", tab: file }, options);
    },
    [openTab],
  );
  const openPersistedStorageFile = useCallback(
    (
      file: ThreadStorageFileTabState,
      options?: { viewer?: FileOpenerOverride },
    ) => {
      openTab({ kind: "thread-storage-file-preview", tab: file }, options);
    },
    [openTab],
  );
  const openPersistedHostFile =
    useCallback<ThreadSecondaryPanelHostFileOpenHandler>(
      (file: HostFileTabState, options) => {
        openTab({ kind: "host-file-preview", tab: file }, options);
      },
      [openTab],
    );
  const closeRootSecondaryPanel = useCallback(() => {
    setRootSecondaryPanel(null);
  }, [setRootSecondaryPanel]);
  const toggleRootPersistedSecondaryPanel = useCallback(() => {
    if (isPersistedSecondaryPanelOpen) {
      closeRootSecondaryPanel();
      return;
    }
    openTab({ kind: "new-tab" });
  }, [closeRootSecondaryPanel, isPersistedSecondaryPanelOpen, openTab]);
  const {
    closePanel: closeSecondaryPanel,
    openCompactDrawer,
    openHostFile,
    openStorageFile,
    openWorkspaceFile,
  } = useThreadSecondaryPanelVisibility({
    closePersistedPanel: closeRootSecondaryPanel,
    drawerVisibility: secondaryPanelDrawerVisibility,
    isCompactViewport,
    isPersistedOpen: isPersistedSecondaryPanelOpen,
    openPersistedCommitDiff: () => undefined,
    openPersistedDiffFile: () => undefined,
    openPersistedDiffPanel: () => undefined,
    openPersistedHostFile,
    openPersistedPanel: setRootSecondaryPanel,
    openPersistedStorageFile,
    openPersistedWorkspaceFile,
    togglePersistedPanel: toggleRootPersistedSecondaryPanel,
  });
  const handleOpenLiveFilePreview = useCallback(
    (intent: AppFilePreviewIntent): boolean => {
      const normalized = normalizeExperimentalFileOpenOptions(intent);
      if (normalized === null) return false;
      const lineRange = toFilePreviewLineRange(normalized.location);
      const options =
        intent.viewer === undefined ? undefined : { viewer: intent.viewer };
      switch (normalized.target.kind) {
        case "workspace":
          if (normalized.target.environmentId !== rootPanelEnvironmentId) {
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
          if (
            rootPanelThreadId === null ||
            normalized.target.hostId !== rootPanelEnvironment?.hostId
          ) {
            return false;
          }
          openHostFile({ lineRange, path: normalized.target.path }, options);
          return true;
        case "thread-storage":
          if (normalized.target.threadId !== rootPanelThreadId) return false;
          openStorageFile({ lineRange, path: normalized.target.path }, options);
          return true;
      }
    },
    [
      openHostFile,
      openStorageFile,
      openWorkspaceFile,
      rootPanelEnvironment?.hostId,
      rootPanelEnvironmentId,
      rootPanelThreadId,
    ],
  );
  const appNavigationCapabilities = useMemo(
    () => ({
      openFilePreview: handleOpenLiveFilePreview,
      openFixedTab: (intent: AppFixedTabOpenIntent) =>
        openAppFixedTabFromDestinations([], intent),
    }),
    [handleOpenLiveFilePreview],
  );
  const resolveMentionLink = useCallback<PromptMentionLinkResolver>(
    (resource) => {
      if (resource.kind === "thread") {
        return () =>
          navigate(
            getThreadRoutePath({
              projectId: resource.projectId ?? projectId,
              threadId: resource.threadId,
            }),
          );
      }
      if (resource.kind === "project") {
        return () => navigate(getProjectComposeRoutePath(resource.projectId));
      }
      if (resource.kind !== "path" || resource.entryKind !== "file") {
        return null;
      }
      if (resource.source === "thread-storage") {
        if (rootPanelThreadId === null) {
          return null;
        }
        return () => {
          handleOpenLiveFilePreview({
            target: {
              kind: "thread-storage",
              threadId: rootPanelThreadId,
              path: resource.path,
            },
            location: null,
          });
        };
      }
      if (isProjectless) {
        return null;
      }
      if (rootPanelEnvironmentId === null) return null;
      return () => {
        handleOpenLiveFilePreview({
          target: {
            kind: "workspace",
            environmentId: rootPanelEnvironmentId,
            path: resource.path,
          },
          location: null,
        });
      };
    },
    [
      isProjectless,
      handleOpenLiveFilePreview,
      navigate,
      projectId,
      rootPanelEnvironmentId,
      rootPanelThreadId,
    ],
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
  const openBrowserTabAndReveal = useCallback(
    (url?: string) => {
      if (rootPanelThreadId === null) {
        return;
      }
      openBrowserTab(url);
      openCompactDrawer();
    },
    [openBrowserTab, openCompactDrawer, rootPanelThreadId],
  );
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
  const browserTabIds = useMemo(
    () => new Set(browserTabs.map((tab) => tab.id)),
    [browserTabs],
  );
  useEffect(() => {
    const browserApi = getDesktopBrowserApi();
    if (browserApi === null) {
      return;
    }
    if (browserApi.onScopedOpenTab) {
      return browserApi.onScopedOpenTab(({ tabId, url }) => {
        if (browserTabIds.has(tabId)) {
          openBrowserTabAndReveal(url);
        }
      });
    }
    return browserApi.onOpenTab(({ url }) => {
      if (isRoutePath({ path: url })) {
        return;
      }
      openBrowserTabAndReveal(url);
    });
  }, [browserTabIds, openBrowserTabAndReveal]);
  const renderBrowserDeck = useCallback(
    ({
      activeBrowserTabId,
      canHandleBrowserCommands,
      canShowNativeBrowserView,
      onNativeFocus,
    }: {
      activeBrowserTabId: string | null;
      canHandleBrowserCommands: boolean;
      canShowNativeBrowserView: boolean;
      onNativeFocus: () => void;
    }) => {
      if (rootPanelThreadId === null) {
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
          environmentId={rootPanelEnvironmentId}
          canShowNativeBrowserView={canShowNativeBrowserView}
          canHandleBrowserCommands={canHandleBrowserCommands}
          onNativeFocus={onNativeFocus}
          threadId={rootPanelThreadId}
          onUpdate={updateBrowserTab}
        />
      );
    },
    [
      browserAddressFocusRequest,
      browserTabs,
      handleBrowserAddressFocusRequestConsumed,
      rootPanelEnvironmentId,
      rootPanelThreadId,
      updateBrowserTab,
    ],
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
  const handleOpenNewTab = useCallback(() => {
    openTab({ kind: "new-tab" });
    openCompactDrawer();
    setShouldAutoFocusNewTab(true);
  }, [openCompactDrawer, openTab]);
  useAppCommandHandler("panel.newTab", () => {
    if (!isFocusedPane) return false;
    handleOpenNewTab();
    return true;
  });
  useAppCommandHandler("panel.reopenClosedTab", () => {
    if (!isFocusedPane || !reopenClosedTab()) return false;
    openCompactDrawer();
    return true;
  });
  useAppCommandHandler("file.quickOpen", () => {
    if (!isFocusedPane) return false;
    handleOpenNewTab();
    return true;
  });
  const handleToggleSecondaryPanel = useCallback(() => {
    if (isSecondaryPanelOpen) {
      closeSecondaryPanel();
      return;
    }
    handleOpenNewTab();
  }, [closeSecondaryPanel, handleOpenNewTab, isSecondaryPanelOpen]);
  const createEnvironmentTerminalMutation = useCreateEnvironmentTerminal();
  const createHostPathTerminalMutation = useCreateTerminal();
  const closeEnvironmentTerminalMutation = useCloseEnvironmentTerminal();
  const closeHostPathTerminalMutation = useCloseTerminal();
  const handleStartTerminal = useCallback(() => {
    if (
      !canCreateRootTerminal ||
      rootPanelTerminalTarget === null ||
      createEnvironmentTerminalMutation.isPending ||
      createHostPathTerminalMutation.isPending
    ) {
      return;
    }
    const newTab = createNewTabFixedPanelTab();
    const createTerminal =
      rootPanelTerminalTarget.kind === "environment"
        ? createEnvironmentTerminalMutation.mutateAsync({
            environmentId: rootPanelTerminalTarget.environmentId,
            cols: DEFAULT_TERMINAL_COLS,
            rows: DEFAULT_TERMINAL_ROWS,
          })
        : createHostPathTerminalMutation.mutateAsync({
            cols: DEFAULT_TERMINAL_COLS,
            rows: DEFAULT_TERMINAL_ROWS,
            target: rootPanelTerminalTarget,
          });
    void createTerminal
      .then((session) => {
        closeTab(newTab.id);
        setShouldAutoFocusTerminal(true);
        setActiveFixedTerminal(session.id);
        openCompactDrawer();
      })
      .catch(() => undefined);
  }, [
    canCreateRootTerminal,
    closeTab,
    createEnvironmentTerminalMutation,
    createHostPathTerminalMutation,
    openCompactDrawer,
    rootPanelTerminalTarget,
    setActiveFixedTerminal,
  ]);
  useAppCommandHandler("terminal.open", () => {
    if (
      !isFocusedPane ||
      !canCreateRootTerminal ||
      rootPanelTerminalTarget === null ||
      createEnvironmentTerminalMutation.isPending ||
      createHostPathTerminalMutation.isPending
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
      if (rootPanelTerminalTarget === null) {
        removeFixedTerminalTab(terminalId);
        return;
      }
      const options = {
        onSuccess: () => {
          removeFixedTerminalTab(terminalId);
        },
      };
      if (rootPanelTerminalTarget.kind === "environment") {
        closeEnvironmentTerminalMutation.mutate(
          {
            mode: "force",
            environmentId: rootPanelTerminalTarget.environmentId,
            terminalId,
          },
          options,
        );
        return;
      }
      closeHostPathTerminalMutation.mutate(
        { mode: "force", terminalId },
        options,
      );
    },
    [
      closeEnvironmentTerminalMutation,
      closeHostPathTerminalMutation,
      removeFixedTerminalTab,
      rootPanelTerminalTarget,
    ],
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
  const [openLinksInAppBrowser] = useOpenLinksInAppBrowserPreference();
  const desktopBrowserAvailable = isDesktopBrowserAvailable();
  const handleOpenPanelLink = useCallback<MarkdownPreviewLinkHandler>(
    ({ href }) => {
      if (
        rootPanelThreadId === null ||
        resolveUrlOpenTarget({
          desktopBrowserAvailable,
          openLinksInAppBrowser,
          url: href,
        }) !== "in-app-browser"
      ) {
        return false;
      }
      openBrowserTabAndReveal(href);
      return true;
    },
    [
      desktopBrowserAvailable,
      openBrowserTabAndReveal,
      openLinksInAppBrowser,
      rootPanelThreadId,
    ],
  );
  const renderRootPanelTabContent = useCallback(
    (
      tab: (typeof syncedOrderedSecondaryFileTabs)[number],
      pane: SecondaryPanelPaneRenderContext,
    ) => (
      <RootComposePanelTabContent
        activeTabId={activeFixedSecondaryTabId}
        canCreateTerminal={canCreateRootTerminal}
        currentProjectId={projectId}
        isPanelOpen={isSecondaryPanelOpen}
        isPanelPersistedOpen={isPersistedSecondaryPanelOpen}
        isProjectless={isProjectless}
        onActivateTab={activateTab}
        onAutoFocusNewTabHandled={handleNewTabAutoFocusHandled}
        onAutoFocusTerminalHandled={handleTerminalAutoFocusHandled}
        onOpenBrowser={openBrowserTabAndReveal}
        onOpenPanelLink={handleOpenPanelLink}
        onSelectFileSearchResult={handleSelectFileSearchResult}
        onSelectionAddToChat={handleRootPanelSelectionAddToChat}
        onStartTerminal={handleStartTerminal}
        pane={pane}
        primaryHostId={primaryHostId}
        pluginActions={rootPluginPanelActions}
        projectSources={projectSources}
        projects={projects}
        rootPanelEnvironmentId={rootPanelEnvironmentId}
        rootPanelThreadId={rootPanelThreadId}
        rootProjectHostId={rootProjectHostId}
        shouldAutoFocusNewTab={shouldAutoFocusNewTab}
        shouldAutoFocusTerminal={shouldAutoFocusTerminal}
        tab={tab}
        terminalTarget={rootPanelTerminalTarget}
      />
    ),
    [
      activateTab,
      activeFixedSecondaryTabId,
      canCreateRootTerminal,
      handleNewTabAutoFocusHandled,
      handleOpenPanelLink,
      handleRootPanelSelectionAddToChat,
      handleSelectFileSearchResult,
      handleStartTerminal,
      handleTerminalAutoFocusHandled,
      isPersistedSecondaryPanelOpen,
      isProjectless,
      isSecondaryPanelOpen,
      openBrowserTabAndReveal,
      projectId,
      primaryHostId,
      projectSources,
      projects,
      rootPanelEnvironmentId,
      rootPanelThreadId,
      rootPanelTerminalTarget,
      rootPluginPanelActions,
      rootProjectHostId,
      shouldAutoFocusNewTab,
      shouldAutoFocusTerminal,
    ],
  );
  const panelTabs = useMemo<readonly SecondaryPanelRenderableTab[]>(() => {
    const filenameOf = (path: string) => path.split("/").at(-1) ?? path;
    const tabs = syncedOrderedSecondaryFileTabs.map(
      (tab): SecondaryPanelRenderableTab => {
        const pluginAction =
          tab.kind === "plugin-panel"
            ? rootPanelNewThreadPanelActions.find(
                (action) =>
                  action.pluginId === tab.pluginId &&
                  action.id === tab.actionId,
              )
            : undefined;
        const shared = {
          contentFillsRegion:
            tab.kind === "plugin-panel" &&
            (tab.fileOpenerOwner !== undefined ||
              pluginAction?.layout === "flush"),
          onClose: () => closeTab(tab.id),
          renderContent: (pane: SecondaryPanelPaneRenderContext) =>
            renderRootPanelTabContent(tab, pane),
          tab,
        };
        switch (tab.kind) {
          case "browser": {
            const browserLabel =
              tab.title ??
              (tab.url.length > 0 ? getBrowserUrlHost(tab.url) : "");
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
              label: filenameOf(tab.path),
              leadingVisual: <RightPanelFileTabIcon path={tab.path} />,
              statusLabel: tab.statusLabel,
              onSelect: () => handleActivateFileTab(tab.id),
            };
          case "host-file-preview":
            return {
              ...shared,
              label: filenameOf(tab.path),
              leadingVisual: <RightPanelFileTabIcon path={tab.path} />,
              statusLabel: null,
              onSelect: () => handleActivateFileTab(tab.id),
            };
          case "thread-storage-file-preview":
            return {
              ...shared,
              label: filenameOf(tab.path),
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
      },
    );
    return tabs;
  }, [
    closeTab,
    handleActivateFileTab,
    handleActivateTerminalTab,
    handleCloseTerminalTab,
    renderRootPanelTabContent,
    rootPanelNewThreadPanelActions,
    syncedOrderedSecondaryFileTabs,
    terminalsById,
  ]);
  const rootPanelMetadataContent = useMemo(
    () => (
      <div className="flex min-h-0 flex-1 flex-col overflow-hidden px-4 pt-1">
        <EmptyStatePanel className="rounded-lg">
          No thread details available.
        </EmptyStatePanel>
      </div>
    ),
    [],
  );
  const handleOpenFilePreview = useCallback(
    (relativePath: string) => {
      openWorkspaceFile({
        lineRange: null,
        path: relativePath,
        source: { kind: "working-tree" },
        statusLabel: null,
      });
    },
    [openWorkspaceFile],
  );
  const showPinnedToggle =
    (paneContext?.secondaryPanelHost ?? null) === null &&
    (!isSecondaryPanelOpen || isCompactViewport);
  const rootPanelToggle = showPinnedToggle ? (
    <div
      className={`fixed z-40 ${ROOT_COMPOSE_PINNED_PANEL_TOGGLE_POSITION_CLASS} ${
        isSecondaryPanelOpen ? "pointer-events-none invisible" : ""
      }`}
    >
      <RootComposeRightPanelToggle
        isOpen={isSecondaryPanelOpen}
        onToggle={handleToggleSecondaryPanel}
      />
    </div>
  ) : null;
  const isForkDraft = forkSeed !== null;
  const showEmptyWelcome =
    !isForkDraft &&
    !startedComposing &&
    projects !== undefined &&
    projects.length === 0;
  const setPromptTextAndMentions = promptDraft.setTextAndMentions;
  const handleStartComposing = useCallback(
    (prefill?: string) => {
      if (prefill) {
        setPromptTextAndMentions(prefill, []);
      }
      setStartedComposing(true);
    },
    [setPromptTextAndMentions, setStartedComposing],
  );
  useEffect(() => {
    if (!startedComposing) return;
    if (isProviderCliVersionBlocked) return;
    if (isPointerCoarse) return;
    const handle = window.requestAnimationFrame(() => {
      promptBoxRef.current?.focusEnd();
    });
    return () => window.cancelAnimationFrame(handle);
  }, [
    isProviderCliVersionBlocked,
    isPointerCoarse,
    promptBoxRef,
    startedComposing,
  ]);
  const [machineSetupTarget, setMachineSetupTarget] =
    useState<ProjectMachineSetupDialogTarget | null>(null);
  const currentProjectName = currentProject?.name ?? null;
  const currentProjectGitRemoteUrl = currentProject?.gitRemoteUrl ?? null;
  const handleRequestMachineSetup = useCallback(
    (setupHost: Host) => {
      if (!projectId || currentProjectName === null) return;
      setMachineSetupTarget({
        projectId,
        projectName: currentProjectName,
        gitRemoteUrl: currentProjectGitRemoteUrl,
        hostId: setupHost.id,
        hostName: setupHost.name,
      });
    },
    [currentProjectGitRemoteUrl, currentProjectName, projectId],
  );
  const handleMachineSetupComplete = useCallback(
    ({ hostId: setUpHostId }: ProjectMachineSetupCompletion) => {
      setMachineSetupTarget(null);
      setEnvironmentSelectionValue(encodeHostValue(setUpHostId, "worktree"));
    },
    [setEnvironmentSelectionValue],
  );
  const handleCancelForkDraft = useCallback(() => {
    setForkSeed(null);
    window.requestAnimationFrame(() => {
      promptBoxRef.current?.focusEnd();
    });
  }, [promptBoxRef, setForkSeed]);

  const promptHeader = useMemo(() => {
    if (forkSeed === null) {
      return null;
    }
    return (
      <div className="flex">
        {}
        <div
          aria-label={`Forking ${forkSeed.sourceThreadTitle}`}
          className="-ml-1.5 inline-flex h-7 max-w-full items-center gap-1.5 rounded-full bg-muted py-0 pl-2.5 pr-1 text-xs font-medium text-muted-foreground"
        >
          <Icon name="Fork" className="size-3.5 shrink-0" aria-hidden />
          <span className="min-w-0 truncate">
            Forking {forkSeed.sourceThreadTitle}
          </span>
          <button
            type="button"
            aria-label="Cancel fork"
            className="inline-flex size-5 shrink-0 cursor-pointer items-center justify-center rounded-full text-muted-foreground hover:bg-surface-hover hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            onClick={handleCancelForkDraft}
          >
            <Icon name="X" className="size-3" aria-hidden />
          </button>
        </div>
      </div>
    );
  }, [forkSeed, handleCancelForkDraft]);

  const promptBanner = useMemo(() => {
    if (!isProviderCliVersionBlocked || selectedProviderCliStatus === null) {
      return null;
    }
    return (
      <ProviderCliVersionBanner
        displayName={selectedProviderCliStatus.displayName}
        currentVersion={selectedProviderCliStatus.currentVersion}
        minimumSupportedVersion={
          selectedProviderCliStatus.minimumSupportedVersion
        }
        canUpdate={selectedProviderCliIssue !== null}
        updating={
          composeHostId !== null &&
          (runningJobKey ===
            providerCliJobKey(composeHostId, selectedProviderId) ||
            queuedJobKeys.has(
              providerCliJobKey(composeHostId, selectedProviderId),
            ))
        }
        onUpdate={handleUpdateProviderCli}
      />
    );
  }, [
    composeHostId,
    handleUpdateProviderCli,
    isProviderCliVersionBlocked,
    queuedJobKeys,
    runningJobKey,
    selectedProviderCliIssue,
    selectedProviderCliStatus,
    selectedProviderId,
  ]);

  if (!projects && sidebarNavigationError) {
    return (
      <PageShell contentClassName="min-h-full items-center justify-center">
        <p className="py-12 text-center text-sm text-destructive">
          Failed to load projects.
        </p>
      </PageShell>
    );
  }

  const machineSetupDialog = (
    <ProjectMachineSetupDialog
      target={machineSetupTarget}
      onOpenChange={(open) => {
        if (!open) setMachineSetupTarget(null);
      }}
      onComplete={handleMachineSetupComplete}
    />
  );

  const promptBox = renderPromptBox({
    id: "root-compose-prompt",
    autoFocus: !isProviderCliVersionBlocked,
    allowSoftKeyboardAutoFocus: isCompactViewport,
    banner: promptBanner,
    header: promptHeader,
    blockedReason: isProviderCliVersionBlocked
      ? `Update ${selectedProviderCliStatus?.displayName ?? selectedProviderId} before starting a thread.`
      : undefined,
    resolveMentionLink,
    pluginComposerHost,
    textEffects: promptTextEffects,
    allowNoProject: true,
    createProject: {
      onCreate: quickCreateProject.openCreateDialog,
      disabled:
        !quickCreateProject.isAvailable || quickCreateProject.isCreating,
      isCreating: quickCreateProject.isCreating,
    },
    onRequestMachineSetup: handleRequestMachineSetup,
    locks: {
      project: isForkDraft,
      provider: isForkDraft,
      environment: isForkDraft,
      branch: isForkDraft,
    },
  });

  return (
    <>
      <RootComposePanelCommandHandlers
        isFocused={isFocusedPane}
        onClose={handleCloseWindowRequest}
        onToggle={handleToggleSecondaryPanel}
      />
      {machineSetupDialog}
      {rootPanelToggle}
      <PluginComposerHostProvider value={pluginComposerHost}>
        <UrlOpenRoutingProvider
          openInAppBrowser={
            desktopBrowserAvailable && rootPanelThreadId !== null
              ? openBrowserTabAndReveal
              : null
          }
        >
          <AppNavigationHostProvider capabilities={appNavigationCapabilities}>
            <RootComposeSecondaryContent
              contentClassName={
                showEmptyWelcome
                  ? ROOT_COMPOSE_EMPTY_WELCOME_CONTENT_CLASS
                  : ROOT_COMPOSE_SIDEBAR_ACTION_ALIGNED_TOP_PADDING_CLASS
              }
              compactScrollContent={
                showEmptyWelcome ? null : (
                  <RootComposeMobileRecents
                    highlightedThreadId={lastCreatedThreadId}
                    projectNamesById={mobileRecentProjectNamesById}
                    providersById={mobileRecentProvidersById}
                    showCreatingRow={isSubmitting}
                    threads={mobileRecentThreads}
                  />
                )
              }
              isSecondaryPanelOpen={isSecondaryPanelOpen}
              onToggleSecondaryPanel={handleToggleSecondaryPanel}
              secondaryPanel={{
                activeTab: activeFixedSecondaryTab,
                canUseGitUi: false,
                environmentId: rootPanelEnvironmentId ?? undefined,
                metadataContent: rootPanelMetadataContent,
                workspaceRootPath:
                  rootPanelEnvironment?.path ??
                  (rootPanelTerminalTarget?.kind === "host_path"
                    ? (rootPanelTerminalTarget.cwd ?? undefined)
                    : undefined),
                tabs: panelTabs,
                splitPanelStateId: ROOT_COMPOSE_FIXED_PANEL_STATE_ID,
                renderBrowserDeck,
                isOpen: isSecondaryPanelOpen,
                fixedTabs: [],
                showConversationCollapseControl: false,
                onClose: closeSecondaryPanel,
                onCollapse: closeSecondaryPanel,
                onTabReorder: reorderTab,
                onOpenNewTab: handleOpenNewTab,
                onOpenFilePreview: handleOpenFilePreview,
                onSelectionAddToChat: handleRootPanelSelectionAddToChat,
                onPanelFocus: touchFixedPanelTabsState,
              }}
            >
              {showEmptyWelcome ? (
                <RootComposeEmptyWelcome
                  onCompose={handleStartComposing}
                  onAddProject={quickCreateProject.openCreateDialog}
                  addProjectDisabled={
                    !quickCreateProject.isAvailable ||
                    quickCreateProject.isCreating
                  }
                />
              ) : (
                promptBox
              )}
            </RootComposeSecondaryContent>
          </AppNavigationHostProvider>
        </UrlOpenRoutingProvider>
      </PluginComposerHostProvider>
    </>
  );
}
