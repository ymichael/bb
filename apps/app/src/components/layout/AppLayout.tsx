import { type MouseEvent as ReactMouseEvent, type ReactNode } from "react";
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import { flushSync } from "react-dom";
import { atom, useAtom, useAtomValue, useStore } from "jotai";
import { atomWithStorage } from "jotai/utils";
import { Link, matchPath, useLocation, useNavigate } from "react-router-dom";
import type { ProjectResponse } from "@bb/server-contract";
import { Icon } from "@bb/shared-ui/icon";
import { RESOURCE_ROUTE_LABEL_EVENT } from "@bb/shared-ui/resource-list";
import {
  SidebarInset,
  SidebarProvider,
  SidebarTrigger,
} from "@/components/ui/sidebar.js";
import {
  ThreadTitleMentionResourcesProvider,
  useSidebarThreadTitleMentionResources,
} from "@/components/thread/ThreadTitleMentions";
import { AppCommandShortcutHint } from "@/components/commands/AppCommandShortcutHint";
import { CommandPalette } from "@/components/commands/CommandPalette";
import { NotificationCenter } from "@/components/notifications/NotificationCenter";
import {
  resolveAutomationBreadcrumbs,
  resolveToolsAreaHeaderMeta,
  resolveToolsBreadcrumbs,
} from "@/components/tools/tools-navigation";
import { AppBreadcrumbs } from "./AppBreadcrumbs";
import { resourceRouteLabelAtom } from "./resourceRouteLabelAtom";
import { AppPageHeader, HEADER_ICON_BUTTON_CLASS } from "./AppPageHeader";
import { stripProjectThreads } from "@/hooks/queries/project-queries";
import { useSidebarNavigation } from "@/hooks/queries/sidebar-navigation-query";
import {
  didThreadDetailBootstrapRefreshAfterMount,
  getLatestPendingInteraction,
  useThread,
  useThreadDetailBootstrap,
  useThreadPendingInteractions,
} from "@/hooks/queries/thread-queries";
import { useRouteState } from "@/hooks/useRouteState";
import { getThreadDisplayTitle } from "@/lib/thread-title";
import { cn } from "@bb/shared-ui/lib/utils";
import { APP_OVERLAY_LAYER } from "@/components/ui/app-overlay-layers";
import {
  getCompactSecondaryPanelPresentation,
  subscribeCompactSecondaryPanelShelfShowing,
} from "@/components/ui/secondary-panel-shelf-visibility";
import { ProjectPathDialog } from "@/components/dialogs/ProjectPathDialog";
import { ProjectActionsMenu } from "@/components/project/ProjectActionsMenu";
import { ProjectActionsProvider } from "@/components/project/ProjectActionsProvider";
import {
  PluginPanelHeaderActions,
  PluginPanelHeaderCenter,
} from "@/components/plugin/PluginPanelHeader";
import { PluginAppOverlays } from "@/components/plugin/PluginAppOverlays";
import { ThreadActionsProvider } from "@/components/thread/ThreadActionsProvider";
import {
  usePluginNavPanelChrome,
  type PluginNavPanelChrome,
} from "@/lib/plugin-nav-panel-chrome";
import type { PluginNavPanelSlot } from "@/lib/plugin-slots";
import { createLocalStorageSyncStorage } from "@/lib/browser-storage";
import {
  BROWSER_SIDEBAR_TRIGGER_INSET_CLASS,
  CHROME_ROW_CLASS,
  getBbDesktopInfo,
  MACOS_CHROME_CONTROL_NO_DRAG_CLASS,
  MACOS_CHROME_TRAFFIC_LIGHT_AXIS_NUDGE_CLASS,
  MACOS_TRAFFIC_LIGHT_RESERVE_OFFSET_CLASS,
  MACOS_WINDOW_DRAG_CLASS,
  shouldReserveMacosTrafficLights,
  shouldUseMacosDesktopChrome,
} from "@/lib/bb-desktop";
import { useDesktopWindowState } from "@/hooks/useDesktopWindowState";
import { useServerDaemonLogsCommand } from "@/hooks/useServerDaemonLogsCommand";
import {
  getLegacyProjectComposeRoutePath,
  getProjectSettingsRoutePath,
  getRootComposeRoutePath,
  getThreadRoutePath,
  isProjectlessProjectId,
  isToolsRoutePath,
  PLUGIN_PANEL_ROUTE_PATH,
  SETTINGS_ROUTE_PATH,
} from "@/lib/route-paths";
import { useQuickCreateProjectController } from "@/hooks/useQuickCreateProject";
import { IframeDragGuardOverlay } from "@/lib/iframe-drag-guard";
import { dispatchBrowserViewBoundsSync } from "@/lib/browser-view-bounds-sync";
import { useFaviconBadge } from "@/lib/favicon-color-preference";
import { shouldShowFaviconAttentionDot } from "./faviconAttentionDot";
import { AppLayoutSidebar } from "./AppLayoutSidebar";
import {
  useAppCommandHandler,
  useAppCommandShortcut,
} from "@/components/commands/AppCommandProvider";
import { useIsCompactViewport } from "@bb/shared-ui/hooks/use-compact-viewport";
import {
  shouldRestoreIOSViewportOnKeyboardDismissal,
  useMobileVisualViewportHeight,
} from "./useMobileVisualViewportHeight";
import { wsManager } from "@/lib/ws";
import { splitLayoutAtom } from "@/lib/split-layout/atoms";
import { findPaneByThread } from "@/lib/split-layout";
import { applyThreadOpenToLayout } from "@/views/thread-detail/splitThreadNavigation";
import { useAppSettingsRouteMemory } from "@/hooks/useAppSettingsRouteMemory";
import { useSetRootComposeProjectId } from "@/lib/root-compose-selection";
import { BackToAppCommandHandler } from "./BackToAppCommandHandler";

const SIDEBAR_WIDTH_KEY = "bb.sidebar.width";
const SIDEBAR_OPEN_KEY = "bb.sidebar.open";
const SIDEBAR_MIN_WIDTH = 240;
const SIDEBAR_MAX_WIDTH = 460;
const SIDEBAR_DEFAULT_WIDTH = 320;

function clampSidebarWidth(value: number) {
  return Math.min(SIDEBAR_MAX_WIDTH, Math.max(SIDEBAR_MIN_WIDTH, value));
}

const sidebarWidthStorage = createLocalStorageSyncStorage<number>({
  parse: (storedValue, initialValue) => {
    if (storedValue === null) {
      return initialValue;
    }
    const parsedValue = Number(storedValue);
    if (!Number.isFinite(parsedValue)) {
      return initialValue;
    }
    return clampSidebarWidth(parsedValue);
  },
  serialize: (value) => String(clampSidebarWidth(value)),
});
const sidebarWidthAtom = atomWithStorage<number>(
  SIDEBAR_WIDTH_KEY,
  SIDEBAR_DEFAULT_WIDTH,
  sidebarWidthStorage,
  { getOnInit: true },
);
const sidebarLiveWidthAtom = atom<number | null>(null);

const sidebarOpenStorage = createLocalStorageSyncStorage<boolean>({
  parse: (storedValue, initialValue) => {
    if (storedValue === "true") return true;
    if (storedValue === "false") return false;
    return initialValue;
  },
  serialize: (value) => String(value),
});
const sidebarOpenAtom = atomWithStorage<boolean>(
  SIDEBAR_OPEN_KEY,
  true,
  sidebarOpenStorage,
  { getOnInit: true },
);

interface SidebarStateBridgeProps {
  children: ReactNode;
}

type SidebarResizeMouseEvent = ReactMouseEvent<HTMLDivElement>;
type SidebarOpenChangeHandler = (open: boolean) => void;

function SidebarStateBridge({ children }: SidebarStateBridgeProps) {
  const [open, setOpen] = useAtom(sidebarOpenAtom);
  const sidebarWidth = useAtomValue(sidebarWidthAtom);
  const sidebarLiveWidth = useAtomValue(sidebarLiveWidthAtom);
  const handleOpenChange = useCallback<SidebarOpenChangeHandler>(
    (nextOpen) => {
      setOpen(nextOpen);
      window.requestAnimationFrame(dispatchBrowserViewBoundsSync);
    },
    [setOpen],
  );
  useAppCommandHandler("sidebar.toggle", () => {
    handleOpenChange(!open);
    return true;
  });
  return (
    <SidebarProvider
      width={`${sidebarLiveWidth ?? sidebarWidth}px`}
      data-testid="app-layout-root"
      open={open}
      onOpenChange={handleOpenChange}
    >
      {children}
    </SidebarProvider>
  );
}

function resetSidebarResizeDocumentState(): void {
  document.body.classList.remove("sidebar-resizing");
}

interface SidebarTriggerOverlayProps {
  reserveMacosTrafficLights: boolean;
  usesDesktopChrome: boolean;
}

function SidebarTriggerOverlay({
  reserveMacosTrafficLights,
  usesDesktopChrome,
}: SidebarTriggerOverlayProps) {
  const isCompactViewport = useIsCompactViewport();
  const compactSecondaryPanelPresentation = useSyncExternalStore(
    subscribeCompactSecondaryPanelShelfShowing,
    getCompactSecondaryPanelPresentation,
    () => "closed",
  );
  const shortcut = useAppCommandShortcut("sidebar.toggle");
  if (isCompactViewport && compactSecondaryPanelPresentation !== "closed") {
    return null;
  }
  const triggerProps = {
    "aria-label": shortcut
      ? `Toggle sidebar (${shortcut.label})`
      : "Toggle sidebar",
    "aria-keyshortcuts": shortcut?.ariaKeyshortcuts,
  };
  if (usesDesktopChrome) {
    return (
      <div
        data-testid="app-desktop-sidebar-trigger"
        style={{ zIndex: APP_OVERLAY_LAYER.sidebarTrigger }}
        className={cn(
          "fixed top-0",
          CHROME_ROW_CLASS,
          reserveMacosTrafficLights
            ? MACOS_TRAFFIC_LIGHT_RESERVE_OFFSET_CLASS
            : "left-0",
          !reserveMacosTrafficLights && BROWSER_SIDEBAR_TRIGGER_INSET_CLASS,
          MACOS_WINDOW_DRAG_CLASS,
        )}
      >
        {}
        <SidebarTrigger
          className={MACOS_CHROME_CONTROL_NO_DRAG_CLASS}
          {...triggerProps}
        />
        <AppCommandShortcutHint
          shortcut={shortcut}
          className={cn(
            "absolute left-full ml-1",
            MACOS_CHROME_TRAFFIC_LIGHT_AXIS_NUDGE_CLASS,
          )}
        />
      </div>
    );
  }
  return (
    <div
      data-testid="app-sidebar-trigger-overlay"
      style={{ zIndex: APP_OVERLAY_LAYER.sidebarTrigger }}
      className={cn(
        "fixed top-[env(safe-area-inset-top)] left-[env(safe-area-inset-left)]",
        CHROME_ROW_CLASS,
        BROWSER_SIDEBAR_TRIGGER_INSET_CLASS,
      )}
    >
      <SidebarTrigger {...triggerProps} />
      <AppCommandShortcutHint
        shortcut={shortcut}
        className="absolute left-full ml-1"
      />
    </div>
  );
}

const routeTitles: Record<string, { title: string }> = {
  "/": { title: "bb" },
  "/settings": { title: "Settings" },
  "/automations": { title: "Automations" },
  "/skills": { title: "Skills" },
};

function resolveRouteTitle(pathname: string): { title: string } | undefined {
  if (matchPath(`${SETTINGS_ROUTE_PATH}/*`, pathname)) {
    return routeTitles[SETTINGS_ROUTE_PATH];
  }
  return routeTitles[pathname];
}

interface AppHeaderProps {
  usesProjectChromeStyle: boolean;
  usesDesktopChrome: boolean;
  isSettingsView: boolean;
  projectId?: string;
  project?: ProjectResponse;
  pluginPanel?: PluginNavPanelSlot;
  pluginPanelChrome?: PluginNavPanelChrome;
  pluginPanelSubPath?: string;
  meta: {
    title: string;
    breadcrumbs?: Array<{ label: string; to?: string }>;
  };
}

function AppHeader({
  usesProjectChromeStyle,
  usesDesktopChrome,
  isSettingsView,
  projectId,
  project,
  pluginPanel,
  pluginPanelChrome,
  pluginPanelSubPath,
  meta,
}: AppHeaderProps) {
  const headerBreadcrumbs = meta.breadcrumbs;
  const headerTitle =
    headerBreadcrumbs || usesProjectChromeStyle ? undefined : meta.title;

  const hasCenterContent = Boolean(headerBreadcrumbs) || Boolean(headerTitle);

  const center = headerBreadcrumbs ? (
    <div className="min-w-0 flex-1">
      <AppBreadcrumbs
        breadcrumbs={headerBreadcrumbs}
        usesDesktopChrome={usesDesktopChrome}
      />
    </div>
  ) : pluginPanelChrome ? (
    <PluginPanelHeaderCenter chrome={pluginPanelChrome} />
  ) : hasCenterContent ? (
    <div className="min-w-0 flex-1">
      {headerTitle ? (
        <p className="truncate text-sm font-semibold">{headerTitle}</p>
      ) : null}
    </div>
  ) : null;

  const actions = pluginPanel ? (
    <PluginPanelHeaderActions
      panel={pluginPanel}
      subPath={pluginPanelSubPath ?? ""}
    />
  ) : usesProjectChromeStyle &&
    projectId &&
    !isProjectlessProjectId(projectId) ? (
    <>
      <Link
        to={getProjectSettingsRoutePath(projectId)}
        className={cn(
          HEADER_ICON_BUTTON_CLASS,
          "inline-flex items-center justify-center transition-colors",
          isSettingsView
            ? "bg-state-active text-foreground"
            : "text-muted-foreground hover:bg-state-hover hover:text-foreground",
        )}
        aria-label="Project settings"
        aria-current={isSettingsView ? "page" : undefined}
      >
        <Icon name="Settings" />
      </Link>
      {project ? (
        <ProjectActionsMenu
          project={project}
          triggerClassName={HEADER_ICON_BUTTON_CLASS}
        />
      ) : null}
    </>
  ) : null;

  return <AppPageHeader center={center} actions={actions} />;
}

interface AppLayoutProps {
  children: ReactNode;
}

export function AppLayout({ children }: AppLayoutProps) {
  const quickCreateProject = useQuickCreateProjectController();
  const isCompactViewport = useIsCompactViewport();
  const store = useStore();
  const contentShellRef = useRef<HTMLDivElement>(null);
  const restoreIOSViewportOnKeyboardDismissal = useMemo(
    () => shouldRestoreIOSViewportOnKeyboardDismissal(navigator),
    [],
  );
  useMobileVisualViewportHeight(
    contentShellRef,
    isCompactViewport,
    restoreIOSViewportOnKeyboardDismissal,
  );
  const location = useLocation();
  const {
    projectId,
    threadId,
    isThreadView,
    isArchivedView,
    isSettingsView,
    isRootView,
  } = useRouteState();
  const [resourceRouteLabel, setResourceRouteLabel] = useAtom(
    resourceRouteLabelAtom,
  );
  useEffect(() => {
    setResourceRouteLabel(null);
    function handleResourceRouteLabel(event: Event) {
      if (!(event instanceof CustomEvent)) return;
      const detail = event.detail;
      if (
        typeof detail !== "object" ||
        detail === null ||
        !("label" in detail) ||
        (typeof detail.label !== "string" && detail.label !== null)
      ) {
        return;
      }
      setResourceRouteLabel(detail.label);
    }
    window.addEventListener(
      RESOURCE_ROUTE_LABEL_EVENT,
      handleResourceRouteLabel,
    );
    return () => {
      window.removeEventListener(
        RESOURCE_ROUTE_LABEL_EVENT,
        handleResourceRouteLabel,
      );
    };
  }, [location.pathname, setResourceRouteLabel]);
  const navigate = useNavigate();
  const {
    appRoutePath,
    settingsRoutePath,
    toolsBackRoutePath,
    toolsRoutePath,
  } = useAppSettingsRouteMemory();
  const setRootComposeProjectId = useSetRootComposeProjectId();
  useEffect(
    () =>
      wsManager.onThreadOpen((signal) => {
        const route = getThreadRoutePath({
          projectId: signal.projectId,
          threadId: signal.threadId,
        });
        const current = store.get(splitLayoutAtom);
        const alreadyOpen =
          current !== null &&
          findPaneByThread(current.root, signal.projectId, signal.threadId) !==
            null;
        const next = applyThreadOpenToLayout(
          current,
          { projectId: signal.projectId, threadId: signal.threadId },
          isCompactViewport ? "replace" : signal.split,
        );
        if (next !== current) {
          store.set(splitLayoutAtom, next);
        }
        void navigate(route, alreadyOpen ? { replace: true } : undefined);
      }),
    [isCompactViewport, navigate, store],
  );
  useAppCommandHandler("thread.new", () => {
    if (projectId !== undefined) {
      setRootComposeProjectId(projectId);
    }
    void navigate(getRootComposeRoutePath(), {
      state: { focusPrompt: true },
    });
    return true;
  });
  useAppCommandHandler("settings.open", () => {
    void navigate(settingsRoutePath);
    return true;
  });
  useAppCommandHandler("settings.openServers", () => {
    void navigate(`${SETTINGS_ROUTE_PATH}/servers`);
    return true;
  });
  useServerDaemonLogsCommand();
  const archivedSectionId = isArchivedView
    ? new URLSearchParams(location.search).get("sectionId")
    : null;
  const navPanelChrome = usePluginNavPanelChrome();
  const isGlobalSettingsView =
    matchPath(`${SETTINGS_ROUTE_PATH}/*`, location.pathname) !== null;
  const isGlobalToolsView = isToolsRoutePath(location.pathname);
  const backToAppRoutePath = isGlobalSettingsView
    ? appRoutePath
    : isGlobalToolsView
      ? toolsBackRoutePath
      : null;
  const pluginPanelMatch = matchPath(
    PLUGIN_PANEL_ROUTE_PATH,
    location.pathname,
  );
  const pluginPanelEntry = pluginPanelMatch
    ? navPanelChrome.find(
        (candidate) =>
          candidate.chrome.pluginId === pluginPanelMatch.params.pluginId &&
          candidate.chrome.path === pluginPanelMatch.params.panelPath,
      )
    : undefined;
  const pluginPanel = pluginPanelEntry?.panel ?? undefined;
  const pluginPanelChrome = pluginPanelEntry?.chrome;
  const pluginPanelSubPath = pluginPanelMatch?.params["*"] ?? "";
  const sidebarNavigationQuery = useSidebarNavigation();
  const projects = useMemo(
    () => sidebarNavigationQuery.data?.projects.map(stripProjectThreads),
    [sidebarNavigationQuery.data],
  );
  const sidebarThreads = useMemo(() => {
    const sidebarNavigation = sidebarNavigationQuery.data;
    if (!sidebarNavigation) {
      return [];
    }
    return [
      ...sidebarNavigation.projects.flatMap((project) => project.threads),
      ...sidebarNavigation.personalProject.threads,
    ];
  }, [sidebarNavigationQuery.data]);
  const titleMentionResources = useSidebarThreadTitleMentionResources(
    sidebarNavigationQuery.data,
  );
  const threadDetailBootstrapQuery = useThreadDetailBootstrap(threadId ?? "", {
    enabled: isThreadView && Boolean(threadId),
    timelinePrefetch: isThreadView && Boolean(threadId),
  });
  const hasThreadDetailBootstrapSettled =
    threadDetailBootstrapQuery.isSuccess || threadDetailBootstrapQuery.isError;
  const [isSidebarResizing, setIsSidebarResizing] = useState(false);
  const startXRef = useRef(0);
  const startWidthRef = useRef(0);
  const liveWidthRef = useRef(0);
  const animationFrameRef = useRef<number | null>(null);
  const showHeader = !isThreadView && !isRootView && pluginPanelMatch === null;
  const [desktopInfo] = useState(getBbDesktopInfo);
  const desktopWindowState = useDesktopWindowState();
  const usesDesktopChrome = shouldUseMacosDesktopChrome(desktopInfo);
  const reserveMacosTrafficLights = shouldReserveMacosTrafficLights({
    desktopInfo,
    windowState: desktopWindowState,
  });
  const project = projectId
    ? projects?.find((candidate) => candidate.id === projectId)
    : undefined;
  const archivedSectionName = archivedSectionId
    ? (sidebarNavigationQuery.data?.sections.find(
        (section) => section.id === archivedSectionId,
      )?.name ?? archivedSectionId)
    : null;
  const projectName = projectId ? project?.name : undefined;
  const projectLabel = projectName ?? (projectId ? projectId : undefined);
  const { data: thread } = useThread(threadId ?? "", {
    enabled:
      Boolean(threadId) && (!isThreadView || hasThreadDetailBootstrapSettled),
    refetchOnMount:
      isThreadView &&
      didThreadDetailBootstrapRefreshAfterMount(threadDetailBootstrapQuery)
        ? false
        : "always",
  });
  const threadDisplayTitle = thread
    ? getThreadDisplayTitle(thread)
    : threadId
      ? `Thread ${threadId.slice(0, 8)}`
      : "Thread";
  const toolsBreadcrumbs = resolveToolsBreadcrumbs(
    location.pathname,
    location.search,
    resourceRouteLabel,
  );
  const automationBreadcrumbs = resolveAutomationBreadcrumbs(
    location.pathname,
    resourceRouteLabel,
  );
  const documentTitleBreadcrumbs = toolsBreadcrumbs ?? automationBreadcrumbs;
  const toolsAreaHeaderMeta = resolveToolsAreaHeaderMeta(
    location.pathname,
    resourceRouteLabel,
    location.search,
  );
  const meta =
    toolsAreaHeaderMeta?.kind === "extensions-title"
      ? { title: toolsAreaHeaderMeta.title }
      : toolsAreaHeaderMeta?.kind === "breadcrumbs"
        ? {
            title: "",
            breadcrumbs: toolsAreaHeaderMeta.breadcrumbs,
          }
        : isArchivedView && projectId
          ? isProjectlessProjectId(projectId)
            ? {
                title: "",
                breadcrumbs: [
                  { label: "Threads", to: getRootComposeRoutePath() },
                  ...(archivedSectionName
                    ? [{ label: archivedSectionName }]
                    : []),
                  { label: "Archived" },
                ],
              }
            : {
                title: "",
                breadcrumbs: [
                  {
                    label: projectLabel ?? projectId,
                    to: getLegacyProjectComposeRoutePath(projectId),
                  },
                  { label: "Archived" },
                ],
              }
          : isSettingsView && projectId
            ? {
                title: "",
                breadcrumbs: [
                  {
                    label: projectLabel ?? projectId,
                    to: getLegacyProjectComposeRoutePath(projectId),
                  },
                  { label: "Settings" },
                ],
              }
            : projectId
              ? {
                  title: projectLabel ?? projectId,
                }
              : (resolveRouteTitle(location.pathname) ?? { title: "" });

  const documentTitle = (() => {
    if (isThreadView) {
      return threadDisplayTitle;
    }
    if (pluginPanel) {
      return pluginPanel.title;
    }
    if (documentTitleBreadcrumbs) {
      const sectionLabel = documentTitleBreadcrumbs[0]?.label ?? "BB";
      const pageLabel = documentTitleBreadcrumbs.at(-1)?.label ?? sectionLabel;
      return pageLabel === sectionLabel
        ? sectionLabel
        : `${pageLabel} · ${sectionLabel}`;
    }
    if (isArchivedView && projectId) {
      if (isProjectlessProjectId(projectId)) {
        return archivedSectionName
          ? `${archivedSectionName} · Archived`
          : "Threads · Archived";
      }
      return `${projectLabel ?? projectId} · Archived`;
    }
    if (isSettingsView && projectId) {
      return `${projectLabel ?? projectId} · Settings`;
    }
    if (projectId) {
      return projectLabel ?? projectId;
    }
    const routeTitle = resolveRouteTitle(location.pathname)?.title;
    return routeTitle && routeTitle.length > 0 ? routeTitle : "BB";
  })();
  const currentThreadPendingInteractionsQuery = useThreadPendingInteractions(
    threadId ?? "",
    { enabled: isThreadView && Boolean(threadId) },
  );
  const currentThreadHasPendingInteraction =
    getLatestPendingInteraction(currentThreadPendingInteractionsQuery.data) !==
    null;
  const faviconBadge = shouldShowFaviconAttentionDot({
    currentThreadHasPendingInteraction,
    currentThreadId: threadId,
    isThreadView,
    sidebarThreads,
    thread,
  })
    ? "unread"
    : "none";
  useFaviconBadge(faviconBadge);

  const handleResizeMouseDown = useCallback(
    (event: SidebarResizeMouseEvent) => {
      event.preventDefault();
      setIsSidebarResizing(true);
      startXRef.current = event.clientX;
      startWidthRef.current = store.get(sidebarWidthAtom);
      liveWidthRef.current = startWidthRef.current;
      document.body.classList.add("sidebar-resizing");
    },
    [store],
  );

  const finishSidebarResize = useCallback(() => {
    if (animationFrameRef.current !== null) {
      window.cancelAnimationFrame(animationFrameRef.current);
      animationFrameRef.current = null;
    }
    flushSync(() => {
      store.set(sidebarWidthAtom, liveWidthRef.current);
      store.set(sidebarLiveWidthAtom, null);
    });
    dispatchBrowserViewBoundsSync();
    setIsSidebarResizing(false);
    resetSidebarResizeDocumentState();
  }, [store]);

  useEffect(() => {
    if (!isSidebarResizing) return;

    const applyLiveWidth = () => {
      animationFrameRef.current = null;
      flushSync(() => {
        store.set(sidebarLiveWidthAtom, liveWidthRef.current);
      });
      dispatchBrowserViewBoundsSync();
    };

    const handleMouseMove = (event: MouseEvent) => {
      const delta = event.clientX - startXRef.current;
      liveWidthRef.current = clampSidebarWidth(startWidthRef.current + delta);
      if (animationFrameRef.current === null) {
        animationFrameRef.current =
          window.requestAnimationFrame(applyLiveWidth);
      }
    };

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        finishSidebarResize();
      }
    };

    window.addEventListener("mousemove", handleMouseMove);
    window.addEventListener("mouseup", finishSidebarResize);
    window.addEventListener("blur", finishSidebarResize);
    window.addEventListener("keydown", handleKeyDown);
    return () => {
      window.removeEventListener("mousemove", handleMouseMove);
      window.removeEventListener("mouseup", finishSidebarResize);
      window.removeEventListener("blur", finishSidebarResize);
      window.removeEventListener("keydown", handleKeyDown);
      if (animationFrameRef.current !== null) {
        window.cancelAnimationFrame(animationFrameRef.current);
        animationFrameRef.current = null;
      }
      store.set(sidebarLiveWidthAtom, null);
      resetSidebarResizeDocumentState();
    };
  }, [finishSidebarResize, isSidebarResizing, store]);

  useEffect(() => {
    if (typeof document === "undefined") return;
    document.title = documentTitle;
  }, [documentTitle]);

  return (
    <ProjectActionsProvider>
      <ThreadTitleMentionResourcesProvider {...titleMentionResources}>
        <ThreadActionsProvider>
          <SidebarStateBridge>
            {backToAppRoutePath !== null && !isSidebarResizing ? (
              <BackToAppCommandHandler routePath={backToAppRoutePath} />
            ) : null}
            <AppLayoutSidebar
              mode={
                isGlobalSettingsView
                  ? "settings"
                  : isGlobalToolsView
                    ? "tools"
                    : "app"
              }
              onResizeMouseDown={handleResizeMouseDown}
              isResizing={isSidebarResizing}
              appRoutePath={appRoutePath}
              settingsRoutePath={settingsRoutePath}
              toolsBackRoutePath={toolsBackRoutePath}
              toolsRoutePath={toolsRoutePath}
            />
            <SidebarInset>
              <div
                ref={contentShellRef}
                data-testid="app-layout-content-shell"
                className="relative flex h-full min-h-0 min-w-0 w-full flex-col pt-[env(safe-area-inset-top)] pr-[env(safe-area-inset-right)] pb-[var(--bb-safe-area-bottom,env(safe-area-inset-bottom))] pl-[env(safe-area-inset-left)]"
              >
                {showHeader ? (
                  <AppHeader
                    usesDesktopChrome={usesDesktopChrome}
                    usesProjectChromeStyle={
                      isRootView || isArchivedView || isSettingsView
                    }
                    isSettingsView={isSettingsView}
                    projectId={projectId}
                    project={project}
                    pluginPanel={pluginPanel}
                    pluginPanelChrome={pluginPanelChrome}
                    pluginPanelSubPath={pluginPanelSubPath}
                    meta={meta}
                  />
                ) : null}
                <main className="flex min-h-0 flex-1 flex-col p-4 md:p-5">
                  {children}
                </main>
              </div>
            </SidebarInset>
            <SidebarTriggerOverlay
              reserveMacosTrafficLights={reserveMacosTrafficLights}
              usesDesktopChrome={usesDesktopChrome}
            />
          </SidebarStateBridge>
          <PluginAppOverlays />
          <IframeDragGuardOverlay
            active={isSidebarResizing}
            cursor="col-resize"
          />
          <CommandPalette
            threadId={threadId ?? null}
            projectId={projectId ?? null}
          />
          <NotificationCenter />
          <ProjectPathDialog
            target={quickCreateProject.projectPathDialog.target}
            pending={quickCreateProject.isCreating}
            platform={quickCreateProject.platform}
            hostId={quickCreateProject.hostId}
            hostName={quickCreateProject.hostName}
            hosts={quickCreateProject.hosts}
            onOpenChange={quickCreateProject.projectPathDialog.onOpenChange}
            onSubmit={quickCreateProject.submitProjectPath}
          />
        </ThreadActionsProvider>
      </ThreadTitleMentionResourcesProvider>
    </ProjectActionsProvider>
  );
}
