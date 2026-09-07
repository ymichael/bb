// @vitest-environment jsdom

import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { defaultAppSettings } from "@bb/domain";
import { Popover, PopoverContent, PopoverTrigger } from "@bb/shared-ui/popover";
import type { MouseEvent as ReactMouseEvent, ReactNode } from "react";
import { Link, MemoryRouter, useLocation } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AppCommandProvider } from "@/components/commands/AppCommandProvider";
import { AppLayout } from "./AppLayout";

const SIDEBAR_WIDTH_STORAGE_KEY = "bb.sidebar.width";
const APP_ROUTE = "/projects/proj_one/threads/thr_one?message=12#event-12";
const SETTINGS_ROUTE = "/settings/providers/codex?tab=models#preferred";
const EXTENSIONS_ROUTE = "/extensions/plugins/ui-patterns?tab=settings#source";
const SECONDARY_ROUTES = [SETTINGS_ROUTE, EXTENSIONS_ROUTE];

vi.mock("./AppLayoutSidebar", async () => {
  const { Sidebar } = await vi.importActual<
    typeof import("@/components/ui/sidebar")
  >("@/components/ui/sidebar");
  return {
    AppLayoutSidebar: ({
      onResizeMouseDown,
    }: {
      onResizeMouseDown: (event: ReactMouseEvent<HTMLDivElement>) => void;
    }) => (
      <Sidebar>
        <div data-testid="sidebar-body">App sidebar</div>
        <div data-testid="resize-handle" onMouseDown={onResizeMouseDown} />
      </Sidebar>
    ),
  };
});

vi.mock("@/hooks/queries/system-queries", () => ({
  useSystemConfig: () => ({
    data: {
      experiments: {
        editMessages: false,
      },
      generalSettings: defaultAppSettings,
      keybindings: [
        {
          command: "app.back",
          desktopOnly: false,
          shortcut: {
            key: "Escape",
            mod: false,
            meta: false,
            control: false,
            alt: false,
            shift: false,
          },
          when: { all: ["mainSurface"], none: ["modalOpen"] },
        },
      ],
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
  AppPageHeader: () => <header />,
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
    projectPathDialog: { onOpenChange: vi.fn(), target: null },
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
  useThreadDetailBootstrap: () => ({ isError: false, isSuccess: false }),
  useThreadPendingInteractions: () => ({ data: undefined }),
  getLatestPendingInteraction: () => null,
}));

function widthVar(element: Element | null): string {
  if (!(element instanceof HTMLElement)) throw new Error("missing element");
  return element.style.getPropertyValue("--sidebar-width");
}

function getRoot(): HTMLElement {
  const root = document.querySelector('[data-testid="app-layout-root"]');
  if (!(root instanceof HTMLElement)) throw new Error("missing app root");
  return root;
}

function RouteContent() {
  const location = useLocation();
  return (
    <>
      <div data-testid="location">
        {location.pathname}
        {location.search}
        {location.hash}
      </div>
      {SECONDARY_ROUTES.map((route) => (
        <Link key={route} to={route}>
          {route}
        </Link>
      ))}
    </>
  );
}

function renderLayout(initialPath = "/", children: ReactNode = null) {
  return render(
    <MemoryRouter initialEntries={[initialPath]}>
      <AppCommandProvider>
        <AppLayout>
          <RouteContent />
          {children}
        </AppLayout>
      </AppCommandProvider>
    </MemoryRouter>,
  );
}

beforeEach(() => {
  window.localStorage.clear();
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  window.localStorage.clear();
});

describe("AppLayout Back to app", () => {
  it.each(SECONDARY_ROUTES)(
    "returns from %s with the remembered query and hash, then releases Escape",
    (route) => {
      renderLayout(APP_ROUTE);
      fireEvent.click(screen.getByRole("link", { name: route }));
      expect(screen.getByTestId("location").textContent).toBe(route);

      expect(fireEvent.keyDown(document, { key: "Escape" })).toBe(false);
      expect(screen.getByTestId("location").textContent).toBe(APP_ROUTE);

      expect(fireEvent.keyDown(document, { key: "Escape" })).toBe(true);
      expect(screen.getByTestId("location").textContent).toBe(APP_ROUTE);
    },
  );

  it("returns from Settings to Extensions before returning to the core app", () => {
    renderLayout(APP_ROUTE);
    fireEvent.click(screen.getByRole("link", { name: EXTENSIONS_ROUTE }));
    fireEvent.click(screen.getByRole("link", { name: SETTINGS_ROUTE }));

    fireEvent.keyDown(document, { key: "Escape" });
    expect(screen.getByTestId("location").textContent).toBe(EXTENSIONS_ROUTE);

    fireEvent.keyDown(document, { key: "Escape" });
    expect(screen.getByTestId("location").textContent).toBe(APP_ROUTE);
  });

  it.each(SECONDARY_ROUTES)(
    "returns to the root when opened directly at %s",
    (route) => {
      renderLayout(route);

      fireEvent.keyDown(document, { key: "Escape" });

      expect(screen.getByTestId("location").textContent).toBe("/");
    },
  );

  it("closes a real popover on the first Escape and returns on the second", async () => {
    renderLayout(
      APP_ROUTE,
      <Popover>
        <PopoverTrigger>Open picker</PopoverTrigger>
        <PopoverContent aria-label="Test picker">
          <button type="button">Picker action</button>
        </PopoverContent>
      </Popover>,
    );
    fireEvent.click(screen.getByRole("link", { name: SETTINGS_ROUTE }));
    fireEvent.click(screen.getByRole("button", { name: "Open picker" }));
    const picker = screen.getByRole("dialog", { name: "Test picker" });

    fireEvent.keyDown(picker, { key: "Escape" });

    await waitFor(() => {
      expect(screen.queryByRole("dialog", { name: "Test picker" })).toBeNull();
    });
    expect(screen.getByTestId("location").textContent).toBe(SETTINGS_ROUTE);

    fireEvent.keyDown(document, { key: "Escape" });
    expect(screen.getByTestId("location").textContent).toBe(APP_ROUTE);
  });

  it("does not navigate while a modal is open even if it does not consume Escape", () => {
    renderLayout(
      SETTINGS_ROUTE,
      <div aria-modal="true" data-state="open" role="dialog">
        <button type="button">Modal action</button>
      </div>,
    );

    fireEvent.keyDown(screen.getByRole("button", { name: "Modal action" }), {
      key: "Escape",
    });

    expect(screen.getByTestId("location").textContent).toBe(SETTINGS_ROUTE);
  });

  it("leaves Escape to a focused interaction that consumes it", () => {
    renderLayout(
      SETTINGS_ROUTE,
      <button
        type="button"
        onKeyDown={(event) => {
          if (event.key === "Escape") event.preventDefault();
        }}
      >
        Cancel editing
      </button>,
    );

    fireEvent.keyDown(screen.getByRole("button", { name: "Cancel editing" }), {
      key: "Escape",
    });

    expect(screen.getByTestId("location").textContent).toBe(SETTINGS_ROUTE);
  });
});

describe("AppLayout sidebar resize drag", () => {
  let frameCallbacks: FrameRequestCallback[];

  beforeEach(() => {
    frameCallbacks = [];
    vi.spyOn(window, "requestAnimationFrame").mockImplementation((cb) => {
      frameCallbacks.push(cb);
      return frameCallbacks.length;
    });
    vi.spyOn(window, "cancelAnimationFrame").mockImplementation(() => {});
  });

  function flushFrames() {
    const callbacks = frameCallbacks;
    frameCallbacks = [];
    act(() => {
      for (const callback of callbacks) callback(0);
    });
  }

  it.each(SECONDARY_ROUTES)(
    "finishes resizing before Escape can leave %s",
    (route) => {
      renderLayout(APP_ROUTE);
      fireEvent.click(screen.getByRole("link", { name: route }));
      fireEvent.mouseDown(screen.getByTestId("resize-handle"), {
        clientX: 320,
      });
      expect(document.body.classList.contains("sidebar-resizing")).toBe(true);

      fireEvent.keyDown(document, { key: "Escape" });

      expect(document.body.classList.contains("sidebar-resizing")).toBe(false);
      expect(screen.getByTestId("location").textContent).toBe(route);

      fireEvent.keyDown(document, { key: "Escape" });
      expect(screen.getByTestId("location").textContent).toBe(APP_ROUTE);
    },
  );

  it("writes the live width on the sidebar gap and panel only, never on the app root or body", () => {
    window.localStorage.setItem(SIDEBAR_WIDTH_STORAGE_KEY, "320");
    renderLayout();

    const root = getRoot();
    const gap = document.querySelector('[data-sidebar="gap"]');
    const panel = document.querySelector('[data-sidebar="panel"]');
    expect(widthVar(gap)).toBe("320px");
    expect(widthVar(panel)).toBe("320px");
    expect(widthVar(root)).toBe("");
    const rootStyleBefore = root.getAttribute("style");

    const handle = document.querySelector('[data-testid="resize-handle"]');
    if (!handle) throw new Error("missing handle");
    act(() => {
      fireEvent.mouseDown(handle, { clientX: 320 });
    });
    act(() => {
      fireEvent.mouseMove(window, { clientX: 360 });
    });
    flushFrames();

    expect(widthVar(gap)).toBe("360px");
    expect(widthVar(panel)).toBe("360px");
    expect(widthVar(root)).toBe("");
    expect(root.getAttribute("style")).toBe(rootStyleBefore);
    expect(document.body.style.cursor).toBe("");
    expect(document.body.style.userSelect).toBe("");
    expect(window.localStorage.getItem(SIDEBAR_WIDTH_STORAGE_KEY)).toBe("320");

    act(() => {
      fireEvent.mouseUp(window);
    });

    expect(widthVar(gap)).toBe("360px");
    expect(widthVar(panel)).toBe("360px");
    expect(widthVar(root)).toBe("");
    expect(window.localStorage.getItem(SIDEBAR_WIDTH_STORAGE_KEY)).toBe("360");
    expect(document.body.classList.contains("sidebar-resizing")).toBe(false);
  });

  it("mounts the drag-guard overlay after the app root and gives it the resize cursor", () => {
    renderLayout();
    const root = getRoot();
    expect(
      document.querySelector('[data-testid="iframe-drag-guard-overlay"]'),
    ).toBeNull();

    const handle = document.querySelector('[data-testid="resize-handle"]');
    if (!handle) throw new Error("missing handle");
    act(() => {
      fireEvent.mouseDown(handle, { clientX: 320 });
    });

    const overlay = document.querySelector(
      '[data-testid="iframe-drag-guard-overlay"]',
    );
    if (!overlay) throw new Error("overlay did not mount");
    expect(overlay.className).toContain("cursor-col-resize");
    expect(
      root.compareDocumentPosition(overlay) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
    expect(root.contains(overlay)).toBe(false);

    act(() => {
      fireEvent.mouseUp(window);
    });
    expect(
      document.querySelector('[data-testid="iframe-drag-guard-overlay"]'),
    ).toBeNull();
  });
});
