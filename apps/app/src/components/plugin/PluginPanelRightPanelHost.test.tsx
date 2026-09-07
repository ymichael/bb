// @vitest-environment jsdom

import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { createStore, Provider as JotaiProvider } from "jotai";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resetFixedPanelTabsStateForTest } from "@/lib/fixed-panel-tabs";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter, useLocation } from "react-router-dom";
import { TooltipProvider } from "@bb/shared-ui/tooltip";
import {
  createEmptyFixedPanelTabsState,
  createPluginPanelFixedPanelTab,
  createTerminalFixedPanelTab,
  getFixedPanelTabsStateStorageKey,
  serializeFixedPanelTabsState,
} from "@/lib/fixed-panel-tabs-state";
import { PluginPanelRightPanelHost } from "./PluginPanelRightPanelHost";
import { getPluginPagePanelStateId } from "./plugin-page-panel-state";
import { useAppNavigationHost } from "@/lib/app-navigation-host";
import {
  getPluginFixedTabOwnerId,
  useAppFixedTabTarget,
} from "@/lib/app-fixed-tab-navigation";
import {
  RouteNavigationProvider,
  useRouteAnchorDelegate,
} from "@/components/ui/app-route-anchor";

interface TestFixedTabRegistration {
  panelId: string;
  id: string;
  title: string;
  icon: string;
  component: (props: { subPath: string }) => ReactNode;
  experimental_target?: {
    validate(value: import("@get-bb/plugin-sdk").JsonValue): boolean;
  };
  layout?: "padded" | "flush";
}

interface TestFileOpenerRegistration {
  id: string;
  title: string;
  extensions: string[];
  component: () => ReactNode;
  pluginId: string;
  generation: number;
}

interface TestNewThreadPanelActionRegistration {
  id: string;
  title: string;
  component: (props: {
    projectId: string | null;
    params: import("@get-bb/plugin-sdk").JsonValue | null;
  }) => ReactNode;
  layout?: "padded" | "flush";
  pluginId: string;
  generation: number;
}

const browserState = vi.hoisted(() => ({ available: false }));
const viewportState = vi.hoisted(() => ({ isCompactViewport: false }));
const createTerminal = vi.hoisted(() => vi.fn());
const catalogQueryState = vi.hoisted(() => ({ queries: [] as string[] }));
const openPaneContentInSplit = vi.hoisted(() => vi.fn());
const threadTabsApi = vi.hoisted(() => ({
  get: vi.fn(),
  update: vi.fn(),
}));
const terminalQueryState = vi.hoisted(() => ({
  sessions: [
    {
      id: "terminal-1",
      threadId: "thread-restored-target",
      environmentId: "environment-1",
      hostId: "host-1",
      title: "Terminal 1",
      initialCwd: "/workspace",
      cols: 100,
      rows: 30,
      status: "running",
      exitCode: null,
      closeReason: null,
      createdAt: 1,
      updatedAt: 1,
      lastUserInputAt: null,
    },
    {
      id: "terminal-2",
      threadId: "thread-restored-target",
      environmentId: "environment-1",
      hostId: "host-1",
      title: "Terminal 2",
      initialCwd: "/workspace",
      cols: 100,
      rows: 30,
      status: "running",
      exitCode: null,
      closeReason: null,
      createdAt: 1,
      updatedAt: 1,
      lastUserInputAt: null,
    },
  ],
}));
const fixedTabState = vi.hoisted(() => ({
  panelRegistered: true,
  registrations: [] as TestFixedTabRegistration[],
  fileOpeners: [] as TestFileOpenerRegistration[],
  newThreadPanelActions: [] as TestNewThreadPanelActionRegistration[],
}));
const hostState = vi.hoisted(() => ({
  hosts: [
    { id: "host-1", name: "Studio", status: "connected" },
    { id: "host-2", name: "Laptop", status: "connected" },
  ],
  primaryHostId: "host-1",
}));
const secondaryPanelState = vi.hoisted(() => ({
  collapseEnabled: false,
  fixedTabs: [] as Array<{
    contentFillsRegion: boolean;
    hasRenderer: boolean;
    title: string;
  }>,
  splitPanelStateId: undefined as string | undefined,
  showsCollapseControl: false,
  tabKinds: [] as string[],
}));

vi.mock("@/hooks/queries/plugin-catalog-queries", () => ({
  usePluginCatalogSearch: (pluginId: string, options: { enabled: boolean }) => {
    catalogQueryState.queries = options.enabled ? [pluginId] : [];
    return {
      data: {
        entries: [
          {
            pluginId,
            displayName:
              pluginId === "secrets"
                ? "Secrets"
                : pluginId === "automations"
                  ? "Automations"
                  : pluginId,
            icon:
              pluginId === "secrets"
                ? "Key"
                : pluginId === "automations"
                  ? "Bot"
                  : null,
          },
        ],
        collections: [],
      },
    };
  },
}));

vi.mock("@/lib/split-layout/openPaneContentInSplit", () => ({
  openPaneContentInSplit,
}));

vi.mock("@/hooks/queries/plugin-settings-queries", () => ({
  usePluginList: () => ({ data: { plugins: [] } }),
}));

vi.mock("@/views/ToolsView", () => ({
  PluginDetailPaneView: ({ pluginId }: { pluginId: string }) => (
    <div data-testid="marketplace-plugin-detail">Details for {pluginId}</div>
  ),
}));

vi.mock("@/lib/sdk", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/sdk")>();
  return {
    ...actual,
    sdk: {
      ...actual.sdk,
      threads: {
        ...actual.sdk.threads,
        tabs: threadTabsApi,
      },
    },
  };
});

vi.mock("@bb/shared-ui/hooks/use-compact-viewport", () => ({
  useIsCompactViewport: () => viewportState.isCompactViewport,
}));

vi.mock("@/components/commands/AppCommandProvider", () => ({
  useAppCommandHandler: () => undefined,
  useAppCommandShortcut: () => null,
}));

vi.mock("@/lib/plugin-slots", () => ({
  usePluginSlots: () => ({
    fileOpeners: fixedTabState.fileOpeners,
    newThreadPanelActions: fixedTabState.newThreadPanelActions,
    navPanels: fixedTabState.panelRegistered
      ? [
          {
            id: "board",
            pluginId: "demo",
            path: "board",
            title: "Board",
            icon: "Columns",
            component: () => null,
            generation: 1,
            fixedTabs: fixedTabState.registrations,
          },
        ]
      : [],
  }),
}));

vi.mock("@/lib/file-opener-preference", () => ({
  useFileOpenerPreferenceValue: () => ({ kind: "automatic" }),
}));

vi.mock("@/lib/bb-desktop", () => ({
  getDesktopBrowserApi: () => null,
  isDesktopBrowserAvailable: () => browserState.available,
}));

vi.mock("@/hooks/queries/thread-terminal-queries", () => ({
  useCreateTerminal: () => ({
    isPending: false,
    mutateAsync: createTerminal,
  }),
  useCreateEnvironmentTerminal: () => ({
    isPending: false,
    mutateAsync: vi.fn(),
  }),
  useCreateThreadTerminal: () => ({
    isPending: false,
    mutateAsync: vi.fn(),
  }),
  useCloseTerminal: () => ({
    isPending: false,
    mutate: vi.fn(),
    mutateAsync: vi.fn(),
    variables: undefined,
  }),
  useCloseEnvironmentTerminal: () => ({
    isPending: false,
    mutate: vi.fn(),
    variables: undefined,
  }),
  useCloseThreadTerminal: () => ({
    isPending: false,
    mutate: vi.fn(),
    variables: undefined,
  }),
  useRenameTerminal: () => ({ mutate: vi.fn() }),
  useRenameEnvironmentTerminal: () => ({ mutate: vi.fn() }),
  useRenameThreadTerminal: () => ({ mutate: vi.fn() }),
  useEnvironmentTerminals: () => ({
    data: terminalQueryState,
    error: null,
    isLoading: false,
  }),
  useThreadTerminals: () => ({
    data: terminalQueryState,
    error: null,
    isLoading: false,
  }),
  useTerminals: () => ({
    data: terminalQueryState,
    error: null,
    isLoading: false,
  }),
}));

vi.mock("@/hooks/queries/host-queries", () => ({
  useHosts: () => ({ data: hostState.hosts, isLoading: false }),
}));

vi.mock("@/hooks/queries/system-queries", () => ({
  useSystemConfig: () => ({
    data: { primaryHostId: hostState.primaryHostId },
  }),
}));

vi.mock("react-resizable-panels", async (importOriginal) => ({
  ...(await importOriginal<typeof import("react-resizable-panels")>()),
  Panel: ({ children }: { children?: ReactNode }) => (
    <div data-testid="panel-placeholder">{children}</div>
  ),
}));

vi.mock("@/components/secondary-panel/SecondaryPanelLayout", () => ({
  SecondaryPanelLayout: ({
    collapse,
    main,
    open,
    renderPanel,
  }: {
    collapse?: { active: boolean; onToggle: () => void };
    main: ReactNode;
    open: boolean;
    renderPanel: (options: {
      presentation: "inline";
      canShowNativeBrowserView: boolean;
      isMainCollapsed: boolean;
      onToggleMainCollapse: () => void;
    }) => ReactNode;
  }) => {
    secondaryPanelState.collapseEnabled = collapse !== undefined;
    return (
      <div data-testid="shared-secondary-panel-layout">
        {main}
        <div data-testid="shared-secondary-panel-region" hidden={!open}>
          {renderPanel({
            presentation: "inline",
            canShowNativeBrowserView: true,
            isMainCollapsed: collapse?.active ?? false,
            onToggleMainCollapse: collapse?.onToggle ?? (() => undefined),
          })}
        </div>
      </div>
    );
  },
}));

vi.mock("@/components/secondary-panel/ThreadSecondaryPanel", () => ({
  ThreadSecondaryPanel: ({
    activeTab,
    tabs,
    fixedTabs,
    isOpen,
    onClose,
    onOpenNewTab,
    renderBrowserDeck,
    showConversationCollapseControl,
    splitPanelStateId,
  }: {
    activeTab: { id: string } | null;
    tabs: Array<{
      contentFillsRegion?: boolean;
      label: string;
      onClose: () => void;
      onSelect: () => void;
      renderContent: (pane: {
        isFocused: boolean;
        onFocusPane: () => void;
      }) => ReactNode;
      tab: { id: string; kind: string };
    }>;
    fixedTabs: Array<{
      tab: { id: string };
      title: string;
      onSelect: () => void;
      contentFillsRegion?: boolean;
      renderContent?: (pane: {
        isFocused: boolean;
        onFocusPane: () => void;
      }) => ReactNode;
    }>;
    isOpen: boolean;
    onClose: () => void;
    onOpenNewTab: () => void;
    renderBrowserDeck?: (
      activeBrowserTabId: string | null,
      pane: { isFocused: boolean; onFocusPane: () => void },
    ) => ReactNode;
    showConversationCollapseControl?: boolean;
    splitPanelStateId?: string;
  }) => {
    const pane = { isFocused: true, onFocusPane: () => undefined };
    const activeFixedTab = fixedTabs.find(
      (tab) => tab.tab.id === activeTab?.id,
    );
    const activeRenderableTab = tabs.find(
      (tab) => tab.tab.id === activeTab?.id,
    );
    secondaryPanelState.fixedTabs = fixedTabs.map((tab) => ({
      contentFillsRegion: tab.contentFillsRegion === true,
      hasRenderer: tab.renderContent !== undefined,
      title: tab.title,
    }));
    secondaryPanelState.splitPanelStateId = splitPanelStateId;
    secondaryPanelState.showsCollapseControl =
      showConversationCollapseControl === true;
    secondaryPanelState.tabKinds = tabs.map((tab) => tab.tab.kind);
    return (
      <aside
        data-testid="shared-thread-secondary-panel"
        data-file-tab-content-fills-region={
          activeRenderableTab?.contentFillsRegion === true ? "true" : "false"
        }
      >
        {tabs.map((tab) => (
          <div key={tab.tab.id}>
            <button type="button" onClick={tab.onSelect}>
              {tab.label}
            </button>
            <button
              type="button"
              aria-label={`Close ${tab.label}`}
              onClick={tab.onClose}
            />
          </div>
        ))}
        {fixedTabs.map((tab) => (
          <button key={tab.tab.id} type="button" onClick={tab.onSelect}>
            {tab.title}
          </button>
        ))}
        <button type="button" onClick={onOpenNewTab}>
          Add tab
        </button>
        <button type="button" aria-label="Hide right panel" onClick={onClose} />
        {activeFixedTab?.renderContent?.(pane)}
        {activeRenderableTab?.tab.kind === "browser"
          ? null
          : activeRenderableTab?.renderContent(pane)}
        {isOpen && fixedTabs.length === 0 && tabs.length === 0 ? (
          <div>This panel view is unavailable.</div>
        ) : null}
        {renderBrowserDeck?.(
          activeRenderableTab?.tab.kind === "browser"
            ? activeRenderableTab.tab.id
            : null,
          pane,
        )}
      </aside>
    );
  },
}));

vi.mock("@/components/secondary-panel/NewTabPage", () => ({
  NewTabPage: ({
    onOpenBrowser,
    onStartTerminal,
    startTerminalDisabled,
    startTerminalTrailing,
  }: {
    onOpenBrowser?: () => void;
    onStartTerminal?: () => void;
    startTerminalDisabled?: boolean;
    startTerminalTrailing?: ReactNode;
  }) => (
    <div data-testid="plugin-page-new-tab">
      {onOpenBrowser ? (
        <button type="button" onClick={onOpenBrowser}>
          Open browser
        </button>
      ) : null}
      {onStartTerminal ? (
        <>
          <button
            type="button"
            disabled={startTerminalDisabled}
            onClick={onStartTerminal}
          >
            Start terminal
          </button>
          {startTerminalTrailing}
        </>
      ) : null}
    </div>
  ),
}));

vi.mock("@/components/secondary-panel/BrowserTabDeck", () => ({
  BrowserTabDeck: ({
    activeBrowserTabId,
  }: {
    activeBrowserTabId: string | null;
  }) =>
    activeBrowserTabId === null ? null : (
      <div data-testid="plugin-page-browser" />
    ),
}));

vi.mock("@/components/thread/terminal/ThreadTerminalPanel", async () => {
  const { useThreadTerminalController } =
    await import("@/components/thread/terminal/useThreadTerminalController");
  return {
    ThreadTerminalPanel: (
      props: Parameters<typeof useThreadTerminalController>[0],
    ) => {
      const controller = useThreadTerminalController(props);
      return (
        <div data-testid="plugin-page-terminal">
          <button
            type="button"
            onClick={() => controller.handleSelectTerminal("terminal-2")}
          >
            Select sibling terminal
          </button>
        </div>
      );
    },
  };
});

vi.mock("@/components/secondary-panel/ThreadSecondaryPanelTabContent", () => ({
  WorkspaceFilePreviewTabContent: ({
    activePath,
    environmentId,
  }: {
    activePath: string;
    environmentId: string;
  }) => (
    <div>
      workspace:{environmentId}:{activePath}
    </div>
  ),
  HostScopedFilePreviewTabContent: ({
    activePath,
    hostId,
    isPanelOpen,
  }: {
    activePath: string;
    hostId: string;
    isPanelOpen: boolean;
  }) => (
    <div
      data-testid="host-scoped-file-preview"
      data-panel-open={isPanelOpen ? "true" : "false"}
    >
      host:{hostId}:{activePath}
    </div>
  ),
  ThreadStorageFilePreviewTabContent: ({
    activePath,
    threadId,
  }: {
    activePath: string;
    threadId: string;
  }) => (
    <div>
      storage:{threadId}:{activePath}
    </div>
  ),
}));

function FileIntentButtons() {
  const navigation = useAppNavigationHost();
  return (
    <>
      <button
        type="button"
        onClick={() =>
          navigation.openFilePreview({
            target: {
              kind: "workspace",
              environmentId: "env-explicit",
              path: "src/example.ts",
            },
            location: { kind: "line", line: 7, column: null },
          })
        }
      >
        Open workspace file
      </button>
      <button
        type="button"
        onClick={() =>
          navigation.openFilePreview({
            target: {
              kind: "host",
              hostId: "host-explicit",
              path: "/tmp/example.log",
            },
            location: null,
          })
        }
      >
        Open host file
      </button>
      <button
        type="button"
        onClick={() =>
          navigation.openFilePreview({
            target: {
              kind: "thread-storage",
              threadId: "thr-explicit",
              path: "reports/result.md",
            },
            location: { kind: "range", startLine: 2, endLine: 4 },
          })
        }
      >
        Open storage file
      </button>
      <button
        type="button"
        onClick={() =>
          navigation.openFixedTab({
            surface: { kind: "current" },
            tab: {
              ownerId: getPluginFixedTabOwnerId("demo", "board"),
              tabId: "details",
            },
            target: { kind: "record", recordId: "issue-42" },
          })
        }
      >
        Open targeted fixed tab
      </button>
      <button
        type="button"
        onClick={() =>
          navigation.openFixedTab({
            surface: { kind: "current" },
            tab: {
              ownerId: getPluginFixedTabOwnerId("demo", "board"),
              tabId: "details",
            },
            target: { kind: "wrong" },
          })
        }
      >
        Open invalid fixed tab target
      </button>
    </>
  );
}

function PluginDetailNavigationLink() {
  const onRouteAnchorClick = useRouteAnchorDelegate();
  return (
    <div onClick={onRouteAnchorClick}>
      <a href="/extensions/plugins/secrets">Open Secrets plugin</a>
      <a href="/extensions/plugins/automations">Open Automations plugin</a>
    </div>
  );
}

function CurrentPath() {
  return <output data-testid="current-path">{useLocation().pathname}</output>;
}

function renderHost(
  panelPath = "board",
  subPath = "",
  store = createStore(),
  pluginDetailTabsEnabled = false,
) {
  const panelStateId = getPluginPagePanelStateId({
    panelPath,
    pluginId: "demo",
  });
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return render(
    <QueryClientProvider client={queryClient}>
      <JotaiProvider store={store}>
        <TooltipProvider>
          <MemoryRouter initialEntries={["/plugins/demo/board"]}>
            <RouteNavigationProvider>
              <CurrentPath />
              <div data-plugin-right-panel-toggle-portal={panelStateId} />
              <PluginPanelRightPanelHost
                panelPath={panelPath}
                pluginId="demo"
                subPath={subPath}
                pluginDetailTabsEnabled={pluginDetailTabsEnabled}
              >
                <div>Plugin page</div>
                <PluginDetailNavigationLink />
                <FileIntentButtons />
              </PluginPanelRightPanelHost>
            </RouteNavigationProvider>
          </MemoryRouter>
        </TooltipProvider>
      </JotaiProvider>
    </QueryClientProvider>,
  );
}

describe("PluginPanelRightPanelHost", () => {
  beforeEach(() => {
    browserState.available = false;
    viewportState.isCompactViewport = false;
    createTerminal.mockReset();
    createTerminal.mockResolvedValue({ id: "terminal-1" });
    threadTabsApi.get.mockReset();
    threadTabsApi.get.mockResolvedValue({ revision: 4, tabs: [] });
    threadTabsApi.update.mockReset();
    threadTabsApi.update.mockResolvedValue({ revision: 5, tabs: [] });
    fixedTabState.panelRegistered = true;
    fixedTabState.registrations = [];
    fixedTabState.fileOpeners = [];
    fixedTabState.newThreadPanelActions = [];
    catalogQueryState.queries = [];
    openPaneContentInSplit.mockReset();
    secondaryPanelState.collapseEnabled = false;
    secondaryPanelState.fixedTabs = [];
    secondaryPanelState.splitPanelStateId = undefined;
    secondaryPanelState.showsCollapseControl = false;
    secondaryPanelState.tabKinds = [];
    localStorage.clear();
    resetFixedPanelTabsStateForTest();
  });

  afterEach(() => {
    cleanup();
  });

  it("shows the side-panel glyph on the trigger for a compact viewport", async () => {
    viewportState.isCompactViewport = true;
    renderHost();

    const showButton = await screen.findByRole("button", {
      name: "Show right panel",
    });
    expect(showButton.querySelector('[data-icon="PanelRight"]')).toBeTruthy();
  });

  it("shows the side-panel glyph on the trigger for a wide viewport", async () => {
    renderHost();

    const showButton = await screen.findByRole("button", {
      name: "Show right panel",
    });
    expect(showButton.querySelector('[data-icon="PanelRight"]')).toBeTruthy();
  });

  it("keeps one panel toggle and mounts the collapsed panel before opening", async () => {
    renderHost();

    expect(screen.getByTestId("shared-secondary-panel-layout")).toBeTruthy();
    const collapsedPanel = await screen.findByTestId(
      "shared-thread-secondary-panel",
    );
    await waitFor(() =>
      expect(
        screen
          .getByTestId("shared-secondary-panel-region")
          .hasAttribute("hidden"),
      ).toBe(true),
    );

    const showButton = await screen.findByRole("button", {
      name: "Show right panel",
    });
    fireEvent.click(showButton);

    expect(screen.getByTestId("shared-thread-secondary-panel")).toBe(
      collapsedPanel,
    );
    expect(
      screen
        .getByTestId("shared-secondary-panel-region")
        .hasAttribute("hidden"),
    ).toBe(false);
    expect(
      screen.queryByRole("button", { name: "Show right panel" }),
    ).toBeNull();
    expect(
      screen.getAllByRole("button", { name: "Hide right panel" }),
    ).toHaveLength(1);
    expect(await screen.findByTestId("plugin-page-new-tab")).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Close New tab" }));
    expect(
      await screen.findByRole("button", { name: "Show right panel" }),
    ).toBeTruthy();
    expect(screen.queryByTestId("plugin-page-new-tab")).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "Show right panel" }));
    expect(await screen.findByTestId("plugin-page-new-tab")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Hide right panel" }));
    expect(
      await screen.findByRole("button", { name: "Show right panel" }),
    ).toBeTruthy();
  });

  it("opens plugin detail links in a header-controlled tab without leaving the plugin page", async () => {
    renderHost("board", "", createStore(), true);

    fireEvent.click(screen.getByRole("link", { name: "Open Secrets plugin" }));

    expect(await screen.findByText("Details for secrets")).toBeTruthy();
    expect(screen.getByText("Plugin page")).toBeTruthy();
    expect(screen.getByTestId("current-path").textContent).toBe(
      "/plugins/demo/board",
    );
    expect(secondaryPanelState.tabKinds).toContain("marketplace-plugin-detail");
    expect(secondaryPanelState.splitPanelStateId).toBeUndefined();
    expect(secondaryPanelState.collapseEnabled).toBe(true);
    expect(secondaryPanelState.showsCollapseControl).toBe(true);

    fireEvent.click(screen.getByRole("button", { name: "Close Secrets" }));

    expect(screen.queryByTestId("marketplace-plugin-detail")).toBeNull();
    expect(
      await screen.findByRole("button", { name: "Show right panel" }),
    ).toBeTruthy();
    expect(screen.getByTestId("current-path").textContent).toBe(
      "/plugins/demo/board",
    );
  });

  it("observes only the selected detail tab while retaining inactive tab metadata", async () => {
    renderHost("board", "", createStore(), true);

    fireEvent.click(screen.getByRole("link", { name: "Open Secrets plugin" }));
    expect(await screen.findByText("Details for secrets")).toBeTruthy();
    expect(catalogQueryState.queries).toEqual(["secrets"]);

    fireEvent.click(
      screen.getByRole("link", { name: "Open Automations plugin" }),
    );
    expect(await screen.findByText("Details for automations")).toBeTruthy();
    expect(catalogQueryState.queries).toEqual(["automations"]);
    expect(screen.getByRole("button", { name: "Secrets" })).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Secrets" }));
    expect(await screen.findByText("Details for secrets")).toBeTruthy();
    expect(catalogQueryState.queries).toEqual(["secrets"]);
  });

  it("keeps split navigation for plugin-detail links outside the Plugin Guide", () => {
    renderHost();

    fireEvent.click(screen.getByRole("link", { name: "Open Secrets plugin" }));

    expect(openPaneContentInSplit).toHaveBeenCalledTimes(1);
    expect(openPaneContentInSplit).toHaveBeenCalledWith(
      expect.objectContaining({
        content: { kind: "plugin-detail", pluginId: "secrets" },
        route: "/extensions/plugins/secrets",
      }),
    );
    expect(screen.queryByTestId("marketplace-plugin-detail")).toBeNull();
    expect(secondaryPanelState.tabKinds).not.toContain(
      "marketplace-plugin-detail",
    );
  });

  it("closes the compact drawer when its remaining tab closes", async () => {
    viewportState.isCompactViewport = true;
    renderHost();

    fireEvent.click(
      await screen.findByRole("button", { name: "Show right panel" }),
    );
    expect(await screen.findByTestId("plugin-page-new-tab")).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Close New tab" }));

    expect(
      await screen.findByRole("button", { name: "Show right panel" }),
    ).toBeTruthy();
    expect(screen.queryByText("This panel view is unavailable.")).toBeNull();
  });

  it("uses the shared panel state and chrome for plugin fixed tabs", async () => {
    function Navigation({ subPath }: { subPath: string }) {
      return <div>Navigation for {subPath}</div>;
    }
    function Details({ subPath }: { subPath: string }) {
      return <div>Details for {subPath}</div>;
    }
    fixedTabState.registrations = [
      {
        panelId: "board",
        id: "navigation",
        title: "Navigation",
        icon: "PanelRight",
        component: Navigation,
      },
      {
        panelId: "board",
        id: "details",
        title: "Details",
        icon: "Info",
        component: Details,
        layout: "flush",
      },
    ];

    renderHost("board", "task/123");

    expect(secondaryPanelState.splitPanelStateId).toBe(
      getPluginPagePanelStateId({
        panelPath: "board",
        pluginId: "demo",
      }),
    );
    expect(secondaryPanelState.fixedTabs).toEqual([
      {
        contentFillsRegion: false,
        hasRenderer: true,
        title: "Navigation",
      },
      { contentFillsRegion: true, hasRenderer: true, title: "Details" },
    ]);

    expect(
      screen
        .getByTestId("shared-secondary-panel-region")
        .hasAttribute("hidden"),
    ).toBe(false);
    expect(await screen.findByText("Navigation for task/123")).toBeTruthy();
    expect(screen.queryByText("Details for task/123")).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "Hide right panel" }));
    expect(screen.queryByText("Navigation for task/123")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Show right panel" }));
    expect(await screen.findByText("Navigation for task/123")).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Details" }));
    expect(await screen.findByText("Details for task/123")).toBeTruthy();
    expect(screen.queryByText("Navigation for task/123")).toBeNull();

    fireEvent.click(screen.getByText("Add tab"));
    expect(await screen.findByTestId("plugin-page-new-tab")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Close New tab" }));
    expect(screen.getByText("Navigation for task/123")).toBeTruthy();
    expect(
      screen
        .getByTestId("shared-secondary-panel-region")
        .hasAttribute("hidden"),
    ).toBe(false);
  });

  it("retains a validated fixed-tab target across panel and route remounts for the app session", async () => {
    function Details() {
      const targetState = useAppFixedTabTarget(
        getPluginFixedTabOwnerId("demo", "board"),
        "details",
      );
      return (
        <div data-testid="targeted-details-content">
          Details
          {targetState === null ? null : (
            <>
              <output>{JSON.stringify(targetState.target)}</output>
              <button type="button" onClick={targetState.clear}>
                Clear target
              </button>
            </>
          )}
        </div>
      );
    }
    fixedTabState.registrations = [
      {
        panelId: "board",
        id: "navigation",
        title: "Navigation",
        icon: "PanelRight",
        component: () => <div data-testid="navigation-content">Navigation</div>,
      },
      {
        panelId: "board",
        id: "details",
        title: "Details",
        icon: "Info",
        component: Details,
        experimental_target: {
          validate: (value) =>
            typeof value === "object" &&
            value !== null &&
            !Array.isArray(value) &&
            value.kind === "record" &&
            typeof value.recordId === "string",
        },
      },
    ];
    browserState.available = true;

    const store = createStore();
    const initialRender = renderHost("board", "", store);
    expect(await screen.findByTestId("navigation-content")).toBeTruthy();

    fireEvent.click(
      screen.getByRole("button", { name: "Open invalid fixed tab target" }),
    );
    expect(screen.getByTestId("navigation-content")).toBeTruthy();
    expect(screen.queryByTestId("targeted-details-content")).toBeNull();

    fireEvent.click(
      screen.getByRole("button", { name: "Open targeted fixed tab" }),
    );
    expect(await screen.findByTestId("targeted-details-content")).toBeTruthy();
    expect(
      screen.getByText('{"kind":"record","recordId":"issue-42"}'),
    ).toBeTruthy();

    fireEvent.click(screen.getByText("Add tab"));
    expect(await screen.findByTestId("plugin-page-new-tab")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Open browser" }));
    expect(await screen.findByTestId("plugin-page-browser")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Details" }));
    expect(
      await screen.findByText('{"kind":"record","recordId":"issue-42"}'),
    ).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Hide right panel" }));
    expect(screen.queryByTestId("targeted-details-content")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Show right panel" }));
    expect(
      await screen.findByText('{"kind":"record","recordId":"issue-42"}'),
    ).toBeTruthy();

    initialRender.unmount();
    const routeRemount = renderHost("board", "", store);
    expect(
      await screen.findByText('{"kind":"record","recordId":"issue-42"}'),
    ).toBeTruthy();

    routeRemount.unmount();
    renderHost();
    expect(await screen.findByTestId("navigation-content")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Details" }));
    expect(await screen.findByTestId("targeted-details-content")).toBeTruthy();
    expect(screen.queryByText(/issue-42/)).toBeNull();

    fireEvent.click(
      screen.getByRole("button", { name: "Open targeted fixed tab" }),
    );
    expect(
      await screen.findByText('{"kind":"record","recordId":"issue-42"}'),
    ).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Clear target" }));
    expect(screen.queryByRole("button", { name: "Clear target" })).toBeNull();
    const persistedValues = Array.from(
      { length: localStorage.length },
      (_, index) => localStorage.getItem(localStorage.key(index) ?? "") ?? "",
    ).join("\n");
    expect(persistedValues).not.toContain("issue-42");
  });

  it("opens every explicit live-file identity through the shared panel host", async () => {
    renderHost();

    fireEvent.click(
      screen.getByRole("button", { name: "Open workspace file" }),
    );
    expect(
      await screen.findByText("workspace:env-explicit:src/example.ts"),
    ).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Open host file" }));
    expect(
      await screen.findByText("host:host-explicit:/tmp/example.log"),
    ).toBeTruthy();
    expect(
      screen.getByTestId("host-scoped-file-preview").dataset.panelOpen,
    ).toBe("true");
    fireEvent.click(screen.getByRole("button", { name: "Hide right panel" }));
    await waitFor(() => {
      expect(
        screen.getByTestId("host-scoped-file-preview").dataset.panelOpen,
      ).toBe("false");
    });

    fireEvent.click(screen.getByRole("button", { name: "Open storage file" }));
    expect(
      await screen.findByText("storage:thr-explicit:reports/result.md"),
    ).toBeTruthy();
  });

  it("gives plugin-page file openers the full content region", async () => {
    fixedTabState.fileOpeners = [
      {
        id: "editor",
        title: "Demo editor",
        extensions: ["ts"],
        component: () => <div>Plugin file editor</div>,
        pluginId: "demo",
        generation: 1,
      },
    ];
    renderHost();

    fireEvent.click(
      screen.getByRole("button", { name: "Open workspace file" }),
    );

    expect(await screen.findByText("Plugin file editor")).toBeTruthy();
    expect(
      screen.getByTestId("shared-thread-secondary-panel").dataset
        .fileTabContentFillsRegion,
    ).toBe("true");
  });

  it("lets a restored padded action own its single padded scroll frame", async () => {
    fixedTabState.newThreadPanelActions = [
      {
        id: "canvas",
        title: "Canvas",
        component: () => <div>Plugin canvas</div>,
        layout: "padded",
        pluginId: "demo",
        generation: 1,
      },
    ];
    const panelStateId = getPluginPagePanelStateId({
      panelPath: "board",
      pluginId: "demo",
    });
    const actionTab = createPluginPanelFixedPanelTab({
      actionId: "canvas",
      paramsJson: null,
      pluginId: "demo",
      title: "Canvas",
    });
    localStorage.setItem(
      getFixedPanelTabsStateStorageKey({ threadId: panelStateId }),
      serializeFixedPanelTabsState({
        state: createEmptyFixedPanelTabsState({
          lastUsedAt: Date.now(),
          secondary: {
            activeTabId: actionTab.id,
            isOpen: true,
            tabs: [actionTab],
          },
        }),
      }),
    );

    renderHost();

    expect(await screen.findByText("Plugin canvas")).toBeTruthy();
    expect(
      screen.getByTestId("shared-thread-secondary-panel").dataset
        .fileTabContentFillsRegion,
    ).toBe("true");
  });

  it("does not reopen fixed tabs after navigating away and back", async () => {
    fixedTabState.registrations = [
      {
        panelId: "board",
        id: "navigation",
        title: "Navigation",
        icon: "PanelRight",
        component: () => <div>Navigation</div>,
      },
    ];
    const store = createStore();
    const firstRender = renderHost("board", "", store);
    fireEvent.click(
      await screen.findByRole("button", { name: "Hide right panel" }),
    );
    await screen.findByRole("button", { name: "Show right panel" });
    const panelStateId = getPluginPagePanelStateId({
      panelPath: "board",
      pluginId: "demo",
    });
    await waitFor(() => {
      const storedValue = localStorage.getItem(
        getFixedPanelTabsStateStorageKey({ threadId: panelStateId }),
      );
      expect(storedValue).not.toBeNull();
      expect(JSON.parse(storedValue!)).toMatchObject({
        secondary: {
          isOpen: false,
          tabs: [{ kind: "plugin-page-fixed", fixedTabId: "navigation" }],
        },
      });
    });
    firstRender.unmount();

    renderHost("board", "", store);

    await waitFor(() =>
      expect(
        screen
          .getByTestId("shared-secondary-panel-region")
          .hasAttribute("hidden"),
      ).toBe(true),
    );
    expect(
      await screen.findByRole("button", { name: "Show right panel" }),
    ).toBeTruthy();
  });

  it("preserves a closed fixed tab while its plugin registration is loading", async () => {
    fixedTabState.registrations = [
      {
        panelId: "board",
        id: "navigation",
        title: "Navigation",
        icon: "PanelRight",
        component: () => <div>Navigation</div>,
      },
    ];
    const store = createStore();
    const initial = renderHost("board", "", store);
    fireEvent.click(
      await screen.findByRole("button", { name: "Hide right panel" }),
    );
    await screen.findByRole("button", { name: "Show right panel" });
    initial.unmount();

    fixedTabState.panelRegistered = false;
    const loading = renderHost("board", "", store);
    await waitFor(() =>
      expect(
        screen
          .getByTestId("shared-secondary-panel-region")
          .hasAttribute("hidden"),
      ).toBe(true),
    );
    loading.unmount();

    fixedTabState.panelRegistered = true;
    renderHost("board", "", store);

    await waitFor(() =>
      expect(
        screen
          .getByTestId("shared-secondary-panel-region")
          .hasAttribute("hidden"),
      ).toBe(true),
    );
    expect(
      await screen.findByRole("button", { name: "Show right panel" }),
    ).toBeTruthy();
  });

  it("opens Browser without a plugin allowlist", async () => {
    browserState.available = true;
    renderHost();
    fireEvent.click(
      await screen.findByRole("button", { name: "Show right panel" }),
    );
    fireEvent.click(
      await screen.findByRole("button", { name: "Open browser" }),
    );

    expect(await screen.findByTestId("plugin-page-browser")).toBeTruthy();
    expect(secondaryPanelState.tabKinds).toContain("browser");
    fireEvent.click(screen.getByRole("button", { name: "Close Browser" }));
    expect(
      await screen.findByRole("button", { name: "Show right panel" }),
    ).toBeTruthy();
    expect(screen.queryByTestId("plugin-page-new-tab")).toBeNull();
    expect(screen.queryByTestId("plugin-page-browser")).toBeNull();
  });

  it("closes an open panel when refresh leaves no persisted tabs", async () => {
    const firstRender = renderHost();
    fireEvent.click(
      await screen.findByRole("button", { name: "Show right panel" }),
    );
    expect(await screen.findByTestId("plugin-page-new-tab")).toBeTruthy();

    const panelStateId = getPluginPagePanelStateId({
      panelPath: "board",
      pluginId: "demo",
    });
    const storedValue = localStorage.getItem(
      getFixedPanelTabsStateStorageKey({ threadId: panelStateId }),
    );
    if (storedValue === null) {
      throw new Error("Expected open plugin panel state to be persisted");
    }
    expect(JSON.parse(storedValue)).toMatchObject({
      secondary: { activeTabId: null, isOpen: true, tabs: [] },
    });

    firstRender.unmount();
    renderHost();

    expect(
      screen
        .getByTestId("shared-secondary-panel-region")
        .hasAttribute("hidden"),
    ).toBe(true);
    expect(screen.queryByTestId("plugin-page-new-tab")).toBeNull();
    expect(
      await screen.findByRole("button", { name: "Show right panel" }),
    ).toBeTruthy();
  });

  it("starts a terminal on the machine selected in the New tab row", async () => {
    renderHost();
    fireEvent.click(
      await screen.findByRole("button", { name: "Show right panel" }),
    );
    fireEvent.pointerDown(
      await screen.findByRole("button", { name: "Machine" }),
      { button: 0 },
    );
    fireEvent.click(screen.getByRole("menuitem", { name: /Laptop/u }));
    fireEvent.click(screen.getByRole("button", { name: "Start terminal" }));

    await waitFor(() =>
      expect(createTerminal).toHaveBeenCalledWith({
        cols: 100,
        rows: 30,
        target: { kind: "host_path", hostId: "host-2", cwd: null },
      }),
    );
    expect(await screen.findByTestId("plugin-page-terminal")).toBeTruthy();
    expect(secondaryPanelState.tabKinds).toContain("terminal");
  });

  it("keeps a restored thread-targeted terminal out of thread tab sync", async () => {
    const panelStateId = getPluginPagePanelStateId({
      panelPath: "board",
      pluginId: "demo",
    });
    const restoredTarget = {
      kind: "thread" as const,
      threadId: "thread-restored-target",
    };
    const restoredTab = createTerminalFixedPanelTab({
      terminalId: "terminal-1",
      target: restoredTarget,
    });
    localStorage.setItem(
      getFixedPanelTabsStateStorageKey({ threadId: panelStateId }),
      serializeFixedPanelTabsState({
        state: createEmptyFixedPanelTabsState({
          lastUsedAt: Date.now(),
          secondary: {
            activeTabId: restoredTab.id,
            isOpen: true,
            tabs: [restoredTab],
          },
        }),
      }),
    );

    renderHost();
    expect(await screen.findByTestId("plugin-page-terminal")).toBeTruthy();
    fireEvent.click(
      screen.getByRole("button", { name: "Select sibling terminal" }),
    );

    const siblingTab = createTerminalFixedPanelTab({
      terminalId: "terminal-2",
      target: restoredTarget,
    });
    await waitFor(() => {
      const storedValue = localStorage.getItem(
        getFixedPanelTabsStateStorageKey({ threadId: panelStateId }),
      );
      if (storedValue === null) {
        throw new Error("Expected plugin panel state to remain persisted");
      }
      expect(JSON.parse(storedValue)).toMatchObject({
        secondary: { activeTabId: siblingTab.id },
      });
    });
    expect(threadTabsApi.get).not.toHaveBeenCalled();
    expect(threadTabsApi.update).not.toHaveBeenCalled();
  });
});
