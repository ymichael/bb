// @vitest-environment jsdom

import { act, cleanup, render, screen } from "@testing-library/react";
import type { ReactNode } from "react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AppLayout } from "./AppLayout";
import { APP_OVERLAY_LAYER } from "@/components/ui/app-overlay-layers";
import { setCompactSecondaryPanelPresentation } from "@/components/ui/secondary-panel-shelf-visibility";

const viewportState = vi.hoisted(() => ({ compact: false }));

vi.mock("@bb/shared-ui/hooks/use-compact-viewport", () => ({
  useIsCompactViewport: () => viewportState.compact,
  CompactViewportOverrideProvider: ({ children }: { children: ReactNode }) => (
    <>{children}</>
  ),
}));

vi.mock("@/components/sidebar/AppSidebar", () => ({
  AppSidebar: () => <aside data-testid="app-sidebar" />,
}));

vi.mock("@/hooks/queries/system-queries", () => ({
  useSystemConfig: () => ({
    data: {
      experiments: {
        changelogPreview: false,
        editMessages: false,
        mobileApp: false,
        sidebarProgressiveDisclosure: false,
        timelineWindowing: false,
      },
    },
  }),
}));

vi.mock("@/hooks/useHostDaemon", () => ({
  useHostDaemon: () => ({ hasDaemon: false }),
  useLocalHostDaemonAccess: () => ({ accessState: "unavailable" }),
}));

vi.mock("@/lib/plugin-slots", () => ({
  usePluginSlots: () => ({
    appOverlays: [],
    commandPaletteActions: [],
    fileOpeners: [],
    navPanels: [
      {
        pluginId: "helm-wiki",
        path: "wiki",
        title: "Helm Wiki",
        icon: "Book",
      },
    ],
    settingsSections: [],
  }),
}));

vi.mock("@/components/plugin/PluginPanelHeader", () => ({
  PluginPanelHeaderCenter: ({ chrome }: { chrome: { title: string } }) => (
    <span data-testid="plugin-panel-header-center">{chrome.title}</span>
  ),
  PluginPanelHeaderActions: () => null,
}));

vi.mock("@/components/project/ProjectActionsProvider", () => ({
  ProjectActionsProvider: ({ children }: { children: ReactNode }) => (
    <>{children}</>
  ),
}));

vi.mock("@/components/thread/ThreadActionsProvider", () => ({
  ThreadActionsProvider: ({ children }: { children: ReactNode }) => (
    <div data-testid="thread-actions-provider">{children}</div>
  ),
}));

vi.mock("@/components/plugin/PluginAppOverlays", () => ({
  PluginAppOverlays: () => <div data-testid="plugin-app-overlays" />,
}));

vi.mock("@/components/dialogs/ProjectPathDialog", () => ({
  ProjectPathDialog: () => null,
}));

vi.mock("./AppPageHeader", () => ({
  HEADER_ICON_BUTTON_CLASS: "header-icon-button",
  AppPageHeader: ({
    center,
    actions,
  }: {
    center?: ReactNode;
    actions?: ReactNode;
  }) => (
    <header data-testid="app-page-header">
      {center}
      {actions}
    </header>
  ),
}));

vi.mock("@/lib/iframe-drag-guard", () => ({
  IframeDragGuardOverlay: () => null,
}));

vi.mock("@/lib/bb-desktop", () => ({
  BROWSER_SIDEBAR_TRIGGER_INSET_CLASS: "",
  CHROME_ROW_CLASS: "",
  DEFAULT_DESKTOP_WINDOW_STATE: { isFullScreen: false },
  MACOS_CHROME_CONTROL_AXIS_CLASS: "",
  MACOS_CHROME_CONTROL_NO_DRAG_CLASS: "",
  MACOS_CHROME_TRAFFIC_LIGHT_AXIS_NUDGE_CLASS: "",
  MACOS_TRAFFIC_LIGHT_RESERVE_OFFSET_CLASS: "",
  MACOS_WINDOW_DRAG_CLASS: "",
  MACOS_WINDOW_NO_DRAG_CLASS: "",
  getBbDesktopInfo: () => null,
  shouldReserveMacosTrafficLights: () => false,
  shouldUseMacosDesktopChrome: () => false,
}));

vi.mock("@/lib/favicon-color-preference", () => ({
  useFaviconBadge: vi.fn(),
}));

vi.mock("@/hooks/useQuickCreateProject", () => ({
  useQuickCreateProjectController: () => ({
    hostId: null,
    hostName: null,
    isCreating: false,
    platform: "darwin",
    projectPathDialog: {
      onOpenChange: vi.fn(),
      target: null,
    },
    submitProjectPath: vi.fn(),
  }),
}));

vi.mock("@/hooks/queries/sidebar-navigation-query", () => ({
  useSidebarNavigation: () => ({
    data: {
      sections: [],
      personalProject: {
        id: "proj_personal",
        kind: "personal",
        name: "Personal",
        sources: [],
        threads: [],
        defaultExecutionOptions: null,
        createdAt: 1,
        updatedAt: 1,
      },
      projects: [],
    },
    isError: false,
    isSuccess: true,
  }),
}));

vi.mock("@/hooks/queries/thread-queries", () => ({
  didThreadDetailBootstrapRefreshAfterMount: () => true,
  useThread: () => ({ data: undefined }),
  useThreadDetailBootstrap: () => ({ isError: false, isSuccess: true }),
  useThreadPendingInteractions: () => ({ data: undefined }),
  getLatestPendingInteraction: () => null,
}));

function renderPluginPanelRoute(): void {
  render(
    <MemoryRouter initialEntries={["/plugins/helm-wiki/wiki"]}>
      <AppLayout>
        <div>Plugin panel body</div>
      </AppLayout>
    </MemoryRouter>,
  );
}

describe("AppLayout plugin panel header", () => {
  beforeEach(() => {
    viewportState.compact = false;
    setCompactSecondaryPanelPresentation("closed");
  });

  afterEach(() => {
    cleanup();
    setCompactSecondaryPanelPresentation("closed");
    vi.clearAllMocks();
  });

  it("leaves the compact header to the plugin page panel host", () => {
    viewportState.compact = true;
    renderPluginPanelRoute();

    expect(screen.queryByTestId("app-page-header")).toBeNull();
  });

  it("leaves the regular header to the plugin page panel host", () => {
    renderPluginPanelRoute();

    expect(screen.queryByTestId("app-page-header")).toBeNull();
  });

  it("mounts app overlays inside the app-level thread actions provider", () => {
    renderPluginPanelRoute();

    expect(
      screen
        .getByTestId("thread-actions-provider")
        .contains(screen.getByTestId("plugin-app-overlays")),
    ).toBe(true);
  });

  it("shows the fixed left trigger only while the compact right panel is closed", () => {
    viewportState.compact = true;
    renderPluginPanelRoute();

    const trigger = screen.getByTestId("app-sidebar-trigger-overlay");
    expect(trigger.style.zIndex).toBe(String(APP_OVERLAY_LAYER.sidebarTrigger));
    act(() => setCompactSecondaryPanelPresentation("shelf"));
    expect(screen.queryByTestId("app-sidebar-trigger-overlay")).toBeNull();

    act(() => setCompactSecondaryPanelPresentation("full"));
    expect(screen.queryByTestId("app-sidebar-trigger-overlay")).toBeNull();

    act(() => setCompactSecondaryPanelPresentation("closed"));
    expect(screen.getByTestId("app-sidebar-trigger-overlay")).not.toBeNull();
  });
});
