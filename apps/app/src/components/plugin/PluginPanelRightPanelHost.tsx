import {
  lazy,
  Suspense,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useState,
  type ReactNode,
} from "react";
import { createPortal } from "react-dom";
import { atom, useAtom, useAtomValue, useStore } from "jotai";
import { atomFamily } from "jotai-family";
import type { Host, JsonValue } from "@bb/domain";
import { jsonValueSchema } from "@bb/domain";
import type { PluginFixedTabDeclaration } from "@get-bb/plugin-sdk";
import { Button } from "@bb/shared-ui/button";
import { CHROME_SUBTLE_ICON_BUTTON_FOREGROUND_CLASS } from "@bb/shared-ui/chrome-style-tokens";
import { COARSE_POINTER_HEADER_ICON_BUTTON_CLASS } from "@bb/shared-ui/coarse-pointer-sizing";
import { useIsCompactViewport } from "@bb/shared-ui/hooks/use-compact-viewport";
import { Icon } from "@bb/shared-ui/icon";
import { Tooltip, TooltipContent, TooltipTrigger } from "@bb/shared-ui/tooltip";
import { useAppCommandHandler } from "@/components/commands/AppCommandProvider";
import { PluginIcon } from "@/components/plugin/PluginIcon";
import { PluginSlotMount } from "@/components/plugin/PluginSlotMount";
import {
  getCompactPanelPresentation,
  RIGHT_PANEL_TOGGLE_ICON_NAME,
} from "@/components/secondary-panel/panelToggleControlState";
import { SecondaryPanelLayout } from "@/components/secondary-panel/SecondaryPanelLayout";
import {
  LazyBrowserTabDeck,
  LazyHostScopedFilePreviewTabContent,
  LazyNewTabPage,
  SecondaryPanelContentSkeleton,
  LazyThreadSecondaryPanel,
  LazyThreadStorageFilePreviewTabContent,
  LazyThreadTerminalPanel,
  LazyWorkspaceFilePreviewTabContent,
} from "@/components/secondary-panel/lazySecondaryPanelComponents";
import type {
  SecondaryPanelFixedTab,
  SecondaryPanelRenderableTab,
} from "@/components/secondary-panel/ThreadSecondaryPanel";
import { useThreadFileTabs } from "@/components/secondary-panel/useThreadFileTabs";
import {
  useCloseFixedSecondaryPanel,
  useReconciledFixedPanelTabsState,
  useUpdateFixedPanelTabsState,
} from "@/lib/fixed-panel-tabs";
import type { TerminalCreateTarget } from "@bb/server-contract";
import {
  createPluginPageFixedPanelTab,
  createTerminalFixedPanelTab,
  type PluginPageFixedPanelTab,
  type SecondaryFileFixedPanelTab,
  type TerminalFixedPanelTab,
} from "@/lib/fixed-panel-tabs-state";
import { createFileOpenerOriginalTab } from "./file-opener-tabs";
import { activateSecondaryPanelTabInState } from "@bb/client-core";
import {
  useCloseTerminal,
  useCreateTerminal,
  useTerminals,
} from "@/hooks/queries/thread-terminal-queries";
import { useHosts } from "@/hooks/queries/host-queries";
import { useSystemConfig } from "@/hooks/queries/system-queries";
import {
  getDesktopBrowserApi,
  isDesktopBrowserAvailable,
} from "@/lib/bb-desktop";
import { getBrowserUrlHost } from "@/lib/browser-url";
import { isRoutePath } from "@/lib/route-paths";
import { UrlOpenRoutingProvider } from "@/lib/url-open-routing";
import { usePluginSlots } from "@/lib/plugin-slots";
import {
  AppNavigationHostProvider,
  type AppFilePreviewIntent,
} from "@/lib/app-navigation-host";
import {
  AppFixedTabTargetProvider,
  getPluginFixedTabOwnerId,
  openAppFixedTabFromDestinations,
  type AppFixedTabDestination,
  type AppFixedTabTargetState,
} from "@/lib/app-fixed-tab-navigation";
import {
  normalizeExperimentalFileOpenOptions,
  toFilePreviewLineRange,
} from "@/lib/live-file-navigation";
import { useOptionalPaneContext } from "@/views/thread-detail/PaneContext";
import {
  resolveTerminalHost,
  TerminalHostSelector,
} from "@/components/secondary-panel/TerminalHostSelector";
import { getPluginPagePanelStateId } from "./plugin-page-panel-state";
import { PluginPanelTabContent } from "./PluginPanelActions";
import { PluginDetailRouteNavigationProvider } from "@/components/ui/app-route-anchor";
import { usePluginCatalogSearch } from "@/hooks/queries/plugin-catalog-queries";
import { usePluginList } from "@/hooks/queries/plugin-settings-queries";

const TERMINAL_COLS = 100;
const TERMINAL_ROWS = 30;
const MARKETPLACE_PLUGIN_DETAIL_TAB_PREFIX = "marketplace-plugin:";
const EMPTY_TERMINAL_HOSTS: readonly Host[] = [];
const RIGHT_PANEL_TOGGLE_CLASS = `${COARSE_POINTER_HEADER_ICON_BUTTON_CLASS} ${CHROME_SUBTLE_ICON_BUTTON_FOREGROUND_CLASS}`;

interface PluginDetailTabMetadata {
  icon: string | null;
  label: string;
}

const compactDrawerOpenAtomFamily = atomFamily((_panelStateId: string) =>
  atom(false),
);
interface FixedTabSessionTarget {
  sequence: number;
  target: JsonValue;
}
const fixedTabTargetAtomFamily = atomFamily((_targetId: string) =>
  atom<FixedTabSessionTarget | null>(null),
);

const LazyPluginDetailPaneView = lazy(() =>
  import("@/views/ToolsView").then(({ PluginDetailPaneView }) => ({
    default: PluginDetailPaneView,
  })),
);

function marketplacePluginDetailTab(pluginId: string) {
  return {
    id: `${MARKETPLACE_PLUGIN_DETAIL_TAB_PREFIX}${pluginId}`,
    kind: "marketplace-plugin-detail" as const,
  };
}

function PluginDetailPanelContent({ pluginId }: { pluginId: string }) {
  return (
    <Suspense fallback={<SecondaryPanelContentSkeleton />}>
      <LazyPluginDetailPaneView pluginId={pluginId} />
    </Suspense>
  );
}

function PluginFixedTabContent({
  fixedTabOwnerId,
  isOpen,
  panelGeneration,
  panelId,
  panelStateId,
  pluginId,
  registration,
  subPath,
}: {
  fixedTabOwnerId: string;
  isOpen: boolean;
  panelGeneration: number;
  panelId: string;
  panelStateId: string;
  pluginId: string;
  registration: PluginFixedTabDeclaration;
  subPath: string;
}) {
  const targetStore = useStore();
  const targetAtom = fixedTabTargetAtomFamily(
    `${panelStateId}\0${registration.id}`,
  );
  const targetSnapshot = useAtomValue(targetAtom);
  const targetState = useMemo<AppFixedTabTargetState | null>(() => {
    if (targetSnapshot === null) return null;
    const { sequence } = targetSnapshot;
    return {
      ...targetSnapshot,
      ownerId: fixedTabOwnerId,
      tabId: registration.id,
      clear: () => {
        targetStore.set(targetAtom, (current) =>
          current?.sequence === sequence ? null : current,
        );
      },
    };
  }, [
    fixedTabOwnerId,
    registration.id,
    targetAtom,
    targetSnapshot,
    targetStore,
  ]);
  if (!isOpen) return null;
  const FixedTabComponent = registration.component;
  return (
    <PluginSlotMount
      key={`${pluginId}/${panelId}/${registration.id}/${panelGeneration}`}
      pluginId={pluginId}
      slotKind="navPanelFixedTab"
      slotId={registration.id}
      instanceId={panelId}
    >
      <AppFixedTabTargetProvider state={targetState}>
        <FixedTabComponent subPath={subPath} />
      </AppFixedTabTargetProvider>
    </PluginSlotMount>
  );
}

function findPluginRightPanelTogglePortal(
  panelStateId: string,
): HTMLElement | null {
  for (const candidate of document.querySelectorAll<HTMLElement>(
    "[data-plugin-right-panel-toggle-portal]",
  )) {
    if (
      candidate.getAttribute("data-plugin-right-panel-toggle-portal") ===
      panelStateId
    ) {
      return candidate;
    }
  }
  return null;
}

function terminalScope(target: TerminalCreateTarget | null) {
  if (target?.kind !== "host_path") return target;
  return {
    kind: "host_path" as const,
    hostId: target.hostId,
    ...(target.cwd === null ? {} : { cwd: target.cwd }),
  };
}

export function PluginPanelRightPanelHost({
  children,
  panelPath,
  pluginId,
  subPath,
  flushPageInsets = false,
  paneId,
  pluginDetailTabsEnabled = false,
}: {
  children: ReactNode;
  panelPath: string;
  pluginId: string;
  subPath: string;
  flushPageInsets?: boolean;
  paneId?: string;
  pluginDetailTabsEnabled?: boolean;
}) {
  const { navPanels } = usePluginSlots();
  const panel =
    navPanels.find(
      (candidate) =>
        candidate.pluginId === pluginId && candidate.path === panelPath,
    ) ?? null;
  const paneContext = useOptionalPaneContext();
  const isFocused = paneContext?.isFocused ?? true;
  const isHostedBySplitWorkspace = paneContext?.secondaryPanelHost != null;
  const resolvedPaneId = paneId ?? paneContext?.paneId;
  const panelHostId = resolvedPaneId ?? "standalone";
  const panelStateId = getPluginPagePanelStateId({
    panelPath,
    paneId: resolvedPaneId,
    pluginId,
  });
  const fixedViewTabs = useMemo<readonly PluginPageFixedPanelTab[]>(
    () =>
      (panel?.fixedTabs ?? []).map((fixedTab) =>
        createPluginPageFixedPanelTab({
          fixedTabId: fixedTab.id,
          pageId: panel?.id ?? panelPath,
          pluginId,
        }),
      ),
    [panel, panelPath, pluginId],
  );
  const panelState = useReconciledFixedPanelTabsState({
    fixedTabs: fixedViewTabs,
    isAuthoritative: panel !== null,
    openFirstFixedTabWhenEmpty: true,
    panelStateId,
    syncThreadId: null,
  });
  const updatePanelState = useUpdateFixedPanelTabsState(panelStateId, null);
  const closePersistedPanel = useCloseFixedSecondaryPanel(panelStateId, null);
  const [openedPluginIds, setOpenedPluginIds] = useState<string[]>([]);
  const [activePluginDetailId, setActivePluginDetailId] = useState<
    string | null
  >(null);
  const [isPluginDetailPanelOpen, setIsPluginDetailPanelOpen] = useState(false);
  const [isPluginDetailFullPage, setIsPluginDetailFullPage] = useState(false);
  const [pluginDetailTabMetadata, setPluginDetailTabMetadata] = useState<
    Record<string, PluginDetailTabMetadata>
  >({});
  const pluginListQuery = usePluginList({
    enabled: openedPluginIds.length > 0,
  });
  const activePluginCatalogQuery = usePluginCatalogSearch(
    activePluginDetailId ?? "",
    {
      enabled: pluginDetailTabsEnabled && activePluginDetailId !== null,
    },
  );
  useEffect(() => {
    if (activePluginDetailId === null) return;
    const catalogEntry = activePluginCatalogQuery.data?.entries.find(
      (entry) => entry.pluginId === activePluginDetailId,
    );
    if (catalogEntry === undefined) return;
    setPluginDetailTabMetadata((current) => {
      const previous = current[activePluginDetailId];
      if (
        previous?.icon === catalogEntry.icon &&
        previous.label === catalogEntry.displayName
      ) {
        return current;
      }
      return {
        ...current,
        [activePluginDetailId]: {
          icon: catalogEntry.icon,
          label: catalogEntry.displayName,
        },
      };
    });
  }, [
    activePluginCatalogQuery.data,
    activePluginDetailId,
    setPluginDetailTabMetadata,
  ]);
  const [isCompactDrawerOpen, setCompactDrawerOpen] = useAtom(
    compactDrawerOpenAtomFamily(panelStateId),
  );
  const closeCompactDrawer = useCallback(() => {
    setCompactDrawerOpen(false);
  }, [setCompactDrawerOpen]);
  const isCompactViewport = useIsCompactViewport();
  const persistedPanelOpen = isCompactViewport
    ? isCompactDrawerOpen
    : panelState.secondary.isOpen;
  const isOpen =
    activePluginDetailId === null
      ? persistedPanelOpen
      : isPluginDetailPanelOpen;
  const activeTab =
    activePluginDetailId === null
      ? (panelState.secondary.tabs.find(
          (tab) => tab.id === panelState.secondary.activeTabId,
        ) ?? null)
      : marketplacePluginDetailTab(activePluginDetailId);
  const activeTerminalTab: TerminalFixedPanelTab | null =
    activeTab?.kind === "terminal" && activeTab.target !== undefined
      ? activeTab
      : null;
  const activeTerminalTarget = activeTerminalTab?.target ?? null;
  const activeTerminalQuery = useTerminals(
    terminalScope(activeTerminalTarget),
    {
      enabled: isOpen && activeTerminalTarget !== null,
    },
  );
  const terminalSessions = activeTerminalQuery.data?.sessions;
  const terminalsById = useMemo(
    () =>
      new Map((terminalSessions ?? []).map((session) => [session.id, session])),
    [terminalSessions],
  );
  const {
    activateTab,
    activeBrowserTab,
    browserTabs,
    closeTab,
    openTab,
    orderedSecondaryFileTabs,
    reopenClosedTab,
    reorderTab,
    updateBrowserTab,
  } = useThreadFileTabs({
    panelStateId,
    syncThreadId: null,
    environmentId: null,
    fileOwnerThreadId: null,
    onCloseLastTab: closeCompactDrawer,
    preserveWorkspaceTabsAcrossContexts: true,
    storageFiles: undefined,
    terminalSessions: undefined,
  });
  const createTerminal = useCreateTerminal();
  const { mutateAsync: closeTerminal } = useCloseTerminal();
  const hostsQuery = useHosts();
  const primaryHostId = useSystemConfig().data?.primaryHostId ?? null;
  const [preferredTerminalHostId, setPreferredTerminalHostId] = useState<
    string | null
  >(null);
  const terminalHosts = hostsQuery.data ?? EMPTY_TERMINAL_HOSTS;
  const selectedTerminalHost = useMemo(
    () =>
      resolveTerminalHost({
        hosts: terminalHosts,
        preferredHostId: preferredTerminalHostId,
        primaryHostId,
      }),
    [preferredTerminalHostId, primaryHostId, terminalHosts],
  );

  useEffect(() => {
    if (
      activeTerminalTab === null ||
      activeTerminalQuery.isLoading ||
      activeTerminalQuery.error !== null ||
      terminalSessions === undefined ||
      terminalsById.has(activeTerminalTab.terminalId)
    ) {
      return;
    }
    closeTab(activeTerminalTab.id);
  }, [
    activeTerminalQuery.error,
    activeTerminalQuery.isLoading,
    activeTerminalTab,
    closeTab,
    terminalSessions,
    terminalsById,
  ]);

  useEffect(() => {
    closeCompactDrawer();
  }, [closeCompactDrawer, subPath]);

  const revealPanel = useCallback(() => {
    setIsPluginDetailPanelOpen(true);
    if (isCompactViewport) {
      setCompactDrawerOpen(true);
      return;
    }
    updatePanelState((state) => ({
      ...state,
      secondary: { ...state.secondary, isOpen: true },
    }));
  }, [isCompactViewport, setCompactDrawerOpen, updatePanelState]);
  const selectPersistedPanelTab = useCallback(() => {
    setActivePluginDetailId(null);
    setIsPluginDetailPanelOpen(false);
    setIsPluginDetailFullPage(false);
  }, []);
  const openPluginDetail = useCallback(
    (nextPluginId: string) => {
      if (!pluginDetailTabsEnabled || panel === null) return false;
      setOpenedPluginIds((current) =>
        current.includes(nextPluginId) ? current : [...current, nextPluginId],
      );
      setActivePluginDetailId(nextPluginId);
      setIsPluginDetailPanelOpen(true);
      revealPanel();
      return true;
    },
    [panel, pluginDetailTabsEnabled, revealPanel],
  );
  const targetStore = useStore();
  const fixedTabOwnerId = getPluginFixedTabOwnerId(
    pluginId,
    panel?.id ?? panelPath,
  );
  const fixedTabDestinations = useMemo<readonly AppFixedTabDestination[]>(
    () =>
      (panel?.fixedTabs ?? []).flatMap((registration) => {
        const tab = fixedViewTabs.find(
          (candidate) => candidate.fixedTabId === registration.id,
        );
        if (tab === undefined) return [];
        return [
          {
            tab: {
              ownerId: fixedTabOwnerId,
              tabId: registration.id,
            },
            open: (target) => {
              if (target !== undefined) {
                const result = jsonValueSchema.safeParse(target);
                if (
                  !result.success ||
                  registration.experimental_target === undefined
                ) {
                  return false;
                }
                try {
                  if (!registration.experimental_target.validate(result.data)) {
                    return false;
                  }
                } catch {
                  return false;
                }
                targetStore.set(
                  fixedTabTargetAtomFamily(
                    `${panelStateId}\0${registration.id}`,
                  ),
                  (current) => ({
                    sequence: (current?.sequence ?? 0) + 1,
                    target: result.data,
                  }),
                );
              }
              selectPersistedPanelTab();
              updatePanelState((state) =>
                activateSecondaryPanelTabInState(state, tab.id),
              );
              revealPanel();
              return true;
            },
          },
        ];
      }),
    [
      fixedViewTabs,
      fixedTabOwnerId,
      panelStateId,
      panel?.fixedTabs,
      revealPanel,
      selectPersistedPanelTab,
      targetStore,
      updatePanelState,
    ],
  );
  const openFixedTab = useCallback(
    (intent: Parameters<typeof openAppFixedTabFromDestinations>[1]) =>
      openAppFixedTabFromDestinations(fixedTabDestinations, intent),
    [fixedTabDestinations],
  );
  const openFilePreview = useCallback(
    (intent: AppFilePreviewIntent) => {
      const normalized = normalizeExperimentalFileOpenOptions(intent);
      if (normalized === null || panel === null) return false;
      selectPersistedPanelTab();
      const lineRange = toFilePreviewLineRange(normalized.location);
      const { target } = normalized;
      const tab =
        target.kind === "workspace"
          ? openTab(
              {
                kind: "workspace-file-preview",
                environmentId: target.environmentId,
                tab: {
                  lineRange,
                  path: target.path,
                  source: { kind: "working-tree" },
                  statusLabel: null,
                },
              },
              { viewer: intent.viewer },
            )
          : target.kind === "host"
            ? openTab(
                {
                  kind: "host-file-preview",
                  hostId: target.hostId,
                  tab: { lineRange, path: target.path },
                },
                { viewer: intent.viewer },
              )
            : openTab(
                {
                  kind: "thread-storage-file-preview",
                  threadId: target.threadId,
                  tab: { lineRange, path: target.path },
                },
                { viewer: intent.viewer },
              );
      if (tab === null) return false;
      revealPanel();
      return true;
    },
    [openTab, panel, revealPanel, selectPersistedPanelTab],
  );
  const navigationCapabilities = useMemo(
    () => ({ openFilePreview, openFixedTab }),
    [openFilePreview, openFixedTab],
  );
  const hidePanel = useCallback(() => {
    setIsPluginDetailPanelOpen(false);
    setIsPluginDetailFullPage(false);
    if (isCompactViewport) {
      closeCompactDrawer();
      return;
    }
    closePersistedPanel();
  }, [closeCompactDrawer, closePersistedPanel, isCompactViewport]);
  const openNewTab = useCallback(() => {
    selectPersistedPanelTab();
    openTab({ kind: "new-tab" });
    revealPanel();
  }, [openTab, revealPanel, selectPersistedPanelTab]);
  const togglePanel = useCallback(() => {
    if (isOpen) {
      hidePanel();
      return;
    }
    if (activeTab === null) openTab({ kind: "new-tab" });
    revealPanel();
  }, [activeTab, hidePanel, isOpen, openTab, revealPanel]);

  useAppCommandHandler("panel.toggle", () => {
    if (!isFocused || panel === null) return false;
    togglePanel();
    return true;
  });
  useAppCommandHandler("panel.newTab", () => {
    if (!isFocused || panel === null) return false;
    openNewTab();
    return true;
  });
  useAppCommandHandler("panel.reopenClosedTab", () => {
    if (!isFocused || panel === null || !reopenClosedTab()) return false;
    revealPanel();
    return true;
  });

  const [togglePortalTarget, setTogglePortalTarget] =
    useState<HTMLElement | null>(null);
  useLayoutEffect(() => {
    setTogglePortalTarget(findPluginRightPanelTogglePortal(panelStateId));
  }, [panel, panelStateId]);

  const openBrowser = useCallback(
    (url = "") => {
      if (!isDesktopBrowserAvailable()) return;
      selectPersistedPanelTab();
      openTab({ kind: "browser", url });
      revealPanel();
    },
    [openTab, revealPanel, selectPersistedPanelTab],
  );
  const browserTabIds = useMemo(
    () => new Set(browserTabs.map((tab) => tab.id)),
    [browserTabs],
  );
  useEffect(() => {
    const browserApi = getDesktopBrowserApi();
    if (browserApi === null) return;
    if (browserApi.onScopedOpenTab) {
      return browserApi.onScopedOpenTab(({ tabId, url }) => {
        if (browserTabIds.has(tabId)) openBrowser(url);
      });
    }
    if (activeBrowserTab === null || !isFocused) return;
    return browserApi.onOpenTab(({ url }) => {
      if (!isRoutePath({ path: url })) openBrowser(url);
    });
  }, [activeBrowserTab, browserTabIds, isFocused, openBrowser]);

  const startTerminal = useCallback(
    (target: TerminalCreateTarget, replaceNewTabId?: string) => {
      if (createTerminal.isPending) return;
      void createTerminal
        .mutateAsync({
          cols: TERMINAL_COLS,
          rows: TERMINAL_ROWS,
          target,
        })
        .then((session) => {
          selectPersistedPanelTab();
          const tab = createTerminalFixedPanelTab({
            terminalId: session.id,
            target,
          });
          updatePanelState((state) => {
            const tabs = state.secondary.tabs.filter(
              (candidate) =>
                candidate.id !==
                  (replaceNewTabId ?? state.secondary.activeTabId) ||
                candidate.kind !== "new-tab",
            );
            return {
              ...state,
              secondary: {
                ...state.secondary,
                tabs: [...tabs, tab],
                activeTabId: tab.id,
                isOpen: isCompactViewport ? state.secondary.isOpen : true,
              },
            };
          });
          revealPanel();
        })
        .catch(() => undefined);
    },
    [
      createTerminal,
      isCompactViewport,
      revealPanel,
      selectPersistedPanelTab,
      updatePanelState,
    ],
  );
  const startSelectedTerminal = useCallback(
    (replaceNewTabId?: string) => {
      if (selectedTerminalHost?.status !== "connected") return;
      startTerminal(
        {
          kind: "host_path",
          hostId: selectedTerminalHost.id,
          cwd: null,
        },
        replaceNewTabId,
      );
    },
    [selectedTerminalHost, startTerminal],
  );

  useAppCommandHandler("terminal.open", () => {
    if (
      !isFocused ||
      panel === null ||
      createTerminal.isPending ||
      selectedTerminalHost?.status !== "connected"
    ) {
      return false;
    }
    startSelectedTerminal();
    return true;
  });

  const closeTerminalTab = useCallback(
    (tab: TerminalFixedPanelTab) => {
      void closeTerminal({ mode: "force", terminalId: tab.terminalId })
        .then(() => closeTab(tab.id))
        .catch(() => undefined);
    },
    [closeTab, closeTerminal],
  );

  const closePluginDetailTab = useCallback(
    (closingPluginId: string) => {
      const closingIndex = openedPluginIds.indexOf(closingPluginId);
      if (closingIndex === -1) return;
      const nextPluginIds = openedPluginIds.filter(
        (candidate) => candidate !== closingPluginId,
      );
      setOpenedPluginIds(nextPluginIds);
      if (activePluginDetailId !== closingPluginId) return;
      const nextActivePluginId =
        nextPluginIds[Math.min(closingIndex, nextPluginIds.length - 1)] ?? null;
      setActivePluginDetailId(nextActivePluginId);
      setIsPluginDetailFullPage(false);
      if (
        nextActivePluginId === null &&
        fixedViewTabs.length === 0 &&
        panelState.secondary.tabs.length === 0
      ) {
        hidePanel();
      }
    },
    [
      activePluginDetailId,
      fixedViewTabs.length,
      hidePanel,
      openedPluginIds,
      panelState.secondary.tabs.length,
    ],
  );

  const pluginDetailTabs = useMemo<readonly SecondaryPanelRenderableTab[]>(
    () =>
      openedPluginIds.map((tabPluginId) => {
        const catalogEntry = pluginDetailTabMetadata[tabPluginId];
        const installedPlugin = pluginListQuery.data?.plugins.find(
          (entry) => entry.id === tabPluginId,
        );
        const label =
          catalogEntry?.label ??
          installedPlugin?.name ??
          installedPlugin?.id ??
          tabPluginId;
        return {
          contentFillsRegion: true,
          label,
          leadingVisual: (
            <PluginIcon
              pluginId={tabPluginId}
              icon={catalogEntry?.icon ?? installedPlugin?.icon ?? null}
              compactIconUrl={installedPlugin?.compactIconUrl}
              className="size-3.5"
            />
          ),
          onClose: () => closePluginDetailTab(tabPluginId),
          onSelect: () => {
            setActivePluginDetailId(tabPluginId);
            revealPanel();
          },
          renderContent: () => (
            <PluginDetailPanelContent pluginId={tabPluginId} />
          ),
          statusLabel: null,
          tab: marketplacePluginDetailTab(tabPluginId),
        };
      }),
    [
      closePluginDetailTab,
      openedPluginIds,
      pluginDetailTabMetadata,
      pluginListQuery.data?.plugins,
      revealPanel,
    ],
  );

  const fixedTabs = useMemo<readonly SecondaryPanelFixedTab[]>(
    () =>
      (panel?.fixedTabs ?? []).flatMap((registration) => {
        const tab = fixedViewTabs.find(
          (candidate) => candidate.fixedTabId === registration.id,
        );
        if (tab === undefined) return [];
        return [
          {
            ariaLabel: registration.title,
            contentFillsRegion: registration.layout === "flush",
            label: registration.title,
            leadingVisual: (
              <PluginIcon
                pluginId={pluginId}
                icon={registration.icon}
                className="size-3.5"
              />
            ),
            onSelect: () => {
              selectPersistedPanelTab();
              openFixedTab({
                surface: { kind: "current" },
                tab: {
                  ownerId: fixedTabOwnerId,
                  tabId: registration.id,
                },
              });
            },
            renderContent: () =>
              panel === null ? null : (
                <PluginFixedTabContent
                  fixedTabOwnerId={fixedTabOwnerId}
                  isOpen={isOpen}
                  panelGeneration={panel.generation}
                  panelId={panel.id}
                  panelStateId={panelStateId}
                  pluginId={pluginId}
                  registration={registration}
                  subPath={subPath}
                />
              ),
            tab,
            title: registration.title,
          },
        ];
      }),
    [
      fixedViewTabs,
      fixedTabOwnerId,
      isOpen,
      openFixedTab,
      panel,
      panelStateId,
      pluginId,
      selectPersistedPanelTab,
      subPath,
    ],
  );

  const renderPanelTabContent = useCallback(
    function renderTabContent(tab: SecondaryFileFixedPanelTab): ReactNode {
      switch (tab.kind) {
        case "browser":
          return null;
        case "terminal":
          if (tab.target === undefined) return null;
          return (
            <LazyThreadTerminalPanel
              canCreateTerminal
              fixedPanelTarget={tab.target}
              fixedTerminalId={tab.terminalId}
              isPanelOpen={isOpen}
              isPanelPersistedOpen={panelState.secondary.isOpen}
              panelStateId={panelStateId}
              syncThreadId={null}
              target={tab.target}
            />
          );
        case "new-tab":
          return (
            <LazyNewTabPage
              autoFocus={false}
              projectId={undefined}
              environmentId={null}
              currentThreadId=""
              onAutoFocusHandled={() => undefined}
              onSelect={() => undefined}
              onOpenBrowser={
                isDesktopBrowserAvailable()
                  ? () => {
                      activateTab(tab.id);
                      openBrowser();
                    }
                  : undefined
              }
              onStartTerminal={() => {
                activateTab(tab.id);
                startSelectedTerminal(tab.id);
              }}
              showFileSearch={false}
              startTerminalDisabled={
                createTerminal.isPending ||
                selectedTerminalHost?.status !== "connected"
              }
              startTerminalTrailing={
                <TerminalHostSelector
                  disabled={createTerminal.isPending}
                  hosts={terminalHosts}
                  isLoading={hostsQuery.isLoading}
                  onChange={setPreferredTerminalHostId}
                  selectedHostId={selectedTerminalHost?.id ?? null}
                />
              }
            />
          );
        case "workspace-file-preview":
          return tab.environmentId === null ? null : (
            <LazyWorkspaceFilePreviewTabContent
              activePath={tab.path}
              environmentId={tab.environmentId}
              isPanelOpen={isOpen}
              lineRange={tab.lineRange}
              source={tab.source}
              statusLabel={tab.statusLabel}
            />
          );
        case "host-file-preview":
          return tab.hostId === null ? null : (
            <LazyHostScopedFilePreviewTabContent
              activePath={tab.path}
              hostId={tab.hostId}
              isPanelOpen={isOpen}
              lineRange={tab.lineRange}
            />
          );
        case "thread-storage-file-preview":
          return tab.threadId === null ? null : (
            <LazyThreadStorageFilePreviewTabContent
              activePath={tab.path}
              isPanelOpen={isOpen}
              lineRange={tab.lineRange}
              threadId={tab.threadId}
            />
          );
        case "plugin-panel": {
          const originalTab = createFileOpenerOriginalTab(tab);
          return (
            <PluginPanelTabContent
              tab={tab}
              context={{ kind: "new-thread", projectId: null }}
              fileOpenerOriginal={
                originalTab === null ? undefined : renderTabContent(originalTab)
              }
            />
          );
        }
      }
    },
    [
      activateTab,
      createTerminal.isPending,
      hostsQuery.isLoading,
      isOpen,
      openBrowser,
      panelState.secondary.isOpen,
      panelStateId,
      selectedTerminalHost,
      startSelectedTerminal,
      terminalHosts,
    ],
  );
  const panelTabs = useMemo<readonly SecondaryPanelRenderableTab[]>(
    () =>
      orderedSecondaryFileTabs.flatMap((tab): SecondaryPanelRenderableTab[] => {
        const shared = {
          onSelect: () => {
            selectPersistedPanelTab();
            activateTab(tab.id);
            revealPanel();
          },
          renderContent: () => renderPanelTabContent(tab),
          tab,
        };
        switch (tab.kind) {
          case "browser": {
            const label =
              tab.title ??
              (tab.url.length > 0 ? getBrowserUrlHost(tab.url) : "");
            return [
              {
                ...shared,
                label: label || "Browser",
                leadingVisual: <Icon name="Globe" className="size-3.5" />,
                statusLabel: null,
                onClose: () => closeTab(tab.id),
              },
            ];
          }
          case "terminal": {
            if (tab.target === undefined) return [];
            const session = terminalsById.get(tab.terminalId);
            return [
              {
                ...shared,
                contentFillsRegion: true,
                label: session?.title ?? "Terminal",
                leadingVisual: <Icon name="Terminal" className="size-3.5" />,
                statusLabel:
                  session === undefined || session.status === "running"
                    ? null
                    : session.status,
                onClose: () => closeTerminalTab(tab),
              },
            ];
          }
          case "new-tab":
            return [
              {
                ...shared,
                label: "New tab",
                leadingVisual: <Icon name="NewTab" className="size-3.5" />,
                statusLabel: null,
                onClose: () => closeTab(tab.id),
              },
            ];
          case "workspace-file-preview":
          case "host-file-preview":
          case "thread-storage-file-preview":
            return [
              {
                ...shared,
                isPinned:
                  tab.kind === "thread-storage-file-preview" && tab.isPinned,
                label: tab.path.split(/[\\/]/u).at(-1) ?? tab.path,
                leadingVisual: <Icon name="File" className="size-3.5" />,
                statusLabel:
                  tab.kind === "workspace-file-preview"
                    ? tab.statusLabel
                    : null,
                onClose: () => closeTab(tab.id),
              },
            ];
          case "plugin-panel":
            return [
              {
                ...shared,
                contentFillsRegion: true,
                label: tab.title,
                leadingVisual: (
                  <PluginIcon
                    pluginId={tab.pluginId}
                    icon={null}
                    className="size-3.5"
                  />
                ),
                statusLabel: null,
                onClose: () => closeTab(tab.id),
              },
            ];
        }
      }),
    [
      activateTab,
      closeTab,
      closeTerminalTab,
      orderedSecondaryFileTabs,
      renderPanelTabContent,
      revealPanel,
      selectPersistedPanelTab,
      terminalsById,
    ],
  );

  const tabs = useMemo<readonly SecondaryPanelRenderableTab[]>(
    () => [...pluginDetailTabs, ...panelTabs],
    [panelTabs, pluginDetailTabs],
  );

  const renderPanel = useCallback(
    ({
      presentation,
      canShowNativeBrowserView,
      isMainCollapsed,
      onToggleMainCollapse,
      resizablePanelId,
    }: {
      presentation: "inline" | "drawer";
      canShowNativeBrowserView: boolean;
      isMainCollapsed: boolean;
      onToggleMainCollapse: () => void;
      resizablePanelId?: string;
    }) => {
      const renderDeck = (
        activeBrowserTabId: string | null,
        canHandleBrowserCommands: boolean,
        onNativeFocus?: () => void,
      ) =>
        browserTabs.length === 0 ? null : (
          <LazyBrowserTabDeck
            browserTabs={browserTabs}
            activeBrowserTabId={activeBrowserTabId}
            environmentId={null}
            canShowNativeBrowserView={canShowNativeBrowserView}
            canHandleBrowserCommands={canHandleBrowserCommands}
            onNativeFocus={onNativeFocus}
            threadId={panelStateId}
            onUpdate={updateBrowserTab}
          />
        );
      const drawerFallback = renderDeck(
        activeBrowserTab?.id ?? null,
        canShowNativeBrowserView,
      );
      return (
        <LazyThreadSecondaryPanel
          drawerFallback={drawerFallback}
          activeTab={activeTab}
          canUseGitUi={false}
          metadataContent={null}
          tabs={tabs}
          splitPanelStateId={
            activePluginDetailId === null ? panelStateId : undefined
          }
          onTabReorder={reorderTab}
          renderBrowserDeck={(activeBrowserTabId, pane) =>
            renderDeck(
              activeBrowserTabId,
              canShowNativeBrowserView && pane.isFocused,
              pane.onFocusPane,
            )
          }
          isOpen={isOpen}
          fixedTabs={fixedTabs}
          showConversationCollapseControl={activePluginDetailId !== null}
          showNewTabButton={activePluginDetailId === null}
          onPanelFocus={() => undefined}
          onCollapse={hidePanel}
          onClose={hidePanel}
          onOpenNewTab={openNewTab}
          isConversationCollapsed={isMainCollapsed}
          onToggleConversationCollapse={onToggleMainCollapse}
          renderAsDrawer={presentation === "drawer"}
          resizablePanelId={resizablePanelId}
        />
      );
    },
    [
      activeBrowserTab,
      activePluginDetailId,
      activeTab,
      browserTabs,
      fixedTabs,
      hidePanel,
      isOpen,
      openNewTab,
      panelStateId,
      reorderTab,
      tabs,
      updateBrowserTab,
    ],
  );

  const toggleLabel = isOpen ? "Hide right panel" : "Show right panel";
  const toggleIconName = RIGHT_PANEL_TOGGLE_ICON_NAME;
  const page = (
    <div
      className={`flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden ${
        flushPageInsets
          ? "-m-4 h-[calc(100%+2rem)] md:-m-5 md:h-[calc(100%+2.5rem)]"
          : "h-full"
      }`}
    >
      <SecondaryPanelLayout
        open={isOpen}
        onToggle={togglePanel}
        onClose={hidePanel}
        panelGroupKey={`plugin-panel-host:${panelHostId}`}
        resetKey={panelStateId}
        contentKey={panelStateId}
        drawerLabel="Right panel"
        drawerFallback={null}
        mainPanelId={`plugin-panel-main-${panelHostId}`}
        collapse={
          activePluginDetailId === null
            ? undefined
            : {
                active: isPluginDetailFullPage,
                onToggle: () =>
                  setIsPluginDetailFullPage((current) => !current),
              }
        }
        main={children}
        composerHost={null}
        compactPresentation={getCompactPanelPresentation(
          activeTab?.kind,
          fixedTabs[0]?.tab.kind ??
            panelTabs.find((tab) => tab.isHidden !== true)?.tab.kind,
        )}
        renderPanel={renderPanel}
      />
    </div>
  );

  const routedPage = (
    <>
      {panel !== null &&
      togglePortalTarget !== null &&
      !isOpen &&
      !isHostedBySplitWorkspace
        ? createPortal(
            <Tooltip>
              <TooltipTrigger asChild>
                <Button
                  type="button"
                  variant="ghost"
                  size="icon"
                  className={RIGHT_PANEL_TOGGLE_CLASS}
                  aria-label={toggleLabel}
                  aria-pressed={isOpen}
                  onClick={togglePanel}
                >
                  <Icon name={toggleIconName} />
                </Button>
              </TooltipTrigger>
              <TooltipContent>{toggleLabel}</TooltipContent>
            </Tooltip>,
            togglePortalTarget,
          )
        : null}
      {page}
    </>
  );

  return (
    <UrlOpenRoutingProvider
      openInAppBrowser={isDesktopBrowserAvailable() ? openBrowser : null}
    >
      <AppNavigationHostProvider capabilities={navigationCapabilities}>
        {pluginDetailTabsEnabled ? (
          <PluginDetailRouteNavigationProvider
            onOpenPluginDetail={openPluginDetail}
          >
            {routedPage}
          </PluginDetailRouteNavigationProvider>
        ) : (
          routedPage
        )}
      </AppNavigationHostProvider>
    </UrlOpenRoutingProvider>
  );
}
