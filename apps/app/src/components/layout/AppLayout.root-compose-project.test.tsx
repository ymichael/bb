// @vitest-environment jsdom

import { act, cleanup, render, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AppLayout } from "./AppLayout";

const ROOT_COMPOSE_PROJECT_ID_STORAGE_KEY = "bb.root-compose.project-id";

const mockUseThread = vi.hoisted(() => vi.fn());
const mockUseThreadDetailBootstrap = vi.hoisted(() => vi.fn());
const commandHandlers = vi.hoisted(() => new Map<string, () => boolean>());

vi.mock("@/components/commands/AppCommandProvider", () => ({
  useAppCommandHandler: (command: string, handler: () => boolean) => {
    commandHandlers.set(command, handler);
  },
  useAppCommandShortcut: () => null,
  useAppCommandShortcuts: () => new Map(),
  useAppCommandRunner: () => ({
    dispatch: () => false,
    isCommandAvailable: () => false,
  }),
  useIsAppCommandModifierHeld: () => false,
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

vi.mock("@/components/project/ProjectActionsProvider", () => ({
  ProjectActionsProvider: ({ children }: { children: ReactNode }) => (
    <>{children}</>
  ),
}));

vi.mock("@/components/thread/ThreadActionsProvider", () => ({
  ThreadActionsProvider: ({ children }: { children: ReactNode }) => (
    <>{children}</>
  ),
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
    <header>
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
      projects: [
        {
          id: "proj_opened",
          kind: "standard",
          name: "Opened Project",
          sources: [],
          threads: [],
          defaultExecutionOptions: null,
          createdAt: 1,
          updatedAt: 1,
        },
      ],
    },
    isError: false,
    isSuccess: true,
  }),
}));

vi.mock("@/hooks/queries/thread-queries", () => ({
  didThreadDetailBootstrapRefreshAfterMount: () => true,
  useThread: (...args: unknown[]) => mockUseThread(...args),
  useThreadDetailBootstrap: (...args: unknown[]) =>
    mockUseThreadDetailBootstrap(...args),
  useThreadPendingInteractions: () => ({ data: undefined }),
  getLatestPendingInteraction: () => null,
}));

describe("AppLayout root compose project preference", () => {
  beforeEach(() => {
    window.localStorage.clear();
    commandHandlers.clear();
    mockUseThread.mockReturnValue({
      data: {
        id: "thr_opened",
        projectId: "proj_opened",
        title: "Opened Thread",
        titleFallback: "Opened Thread",
        lastReadAt: 100,
        latestAttentionAt: 100,
      },
    });
    mockUseThreadDetailBootstrap.mockReturnValue({
      isError: false,
      isSuccess: true,
    });
  });

  afterEach(() => {
    cleanup();
    window.localStorage.clear();
    commandHandlers.clear();
    vi.clearAllMocks();
  });

  it("uses the opened thread project for the new-thread command", async () => {
    window.localStorage.setItem(
      ROOT_COMPOSE_PROJECT_ID_STORAGE_KEY,
      "proj_last_run",
    );

    render(
      <MemoryRouter
        initialEntries={["/projects/proj_opened/threads/thr_opened"]}
      >
        <AppLayout>
          <div>Thread route</div>
        </AppLayout>
      </MemoryRouter>,
    );

    await waitFor(() => {
      expect(document.title).toBe("Opened Thread");
    });

    act(() => {
      expect(commandHandlers.get("thread.new")?.()).toBe(true);
    });

    await waitFor(() => {
      expect(
        window.localStorage.getItem(ROOT_COMPOSE_PROJECT_ID_STORAGE_KEY),
      ).toBe("proj_opened");
    });
  });

  it("keeps the stored project when the route has no project", () => {
    window.localStorage.setItem(
      ROOT_COMPOSE_PROJECT_ID_STORAGE_KEY,
      "proj_last_run",
    );

    render(
      <MemoryRouter initialEntries={["/"]}>
        <AppLayout>
          <div>New thread route</div>
        </AppLayout>
      </MemoryRouter>,
    );

    act(() => {
      expect(commandHandlers.get("thread.new")?.()).toBe(true);
    });

    expect(
      window.localStorage.getItem(ROOT_COMPOSE_PROJECT_ID_STORAGE_KEY),
    ).toBe("proj_last_run");
  });
});
