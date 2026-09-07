// @vitest-environment jsdom

import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { createStore, Provider as JotaiProvider } from "jotai";
import { useContext, useMemo, useState, type ReactNode } from "react";
import { MemoryRouter, useLocation, useNavigate } from "react-router-dom";
import { QueryClientProvider } from "@tanstack/react-query";
import { PERSONAL_PROJECT_ID } from "@bb/domain";
import { TooltipProvider } from "@bb/shared-ui/tooltip";
import type { BbDesktopInfo } from "@bb/desktop-contract";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createQueryClientTestHarness } from "@/test/queryClientTestHarness";
import {
  DIM_INACTIVE_SPLITS_STORAGE_KEY,
  dimInactiveSplitsAtom,
  maximizedPaneIdAtom,
  splitLayoutAtom,
} from "@/lib/split-layout/atoms";
import { wsManager } from "@/lib/ws";
import {
  listPanes,
  movePane,
  serializeSplitLayout,
  SPLIT_LAYOUT_STORAGE_KEY,
} from "@/lib/split-layout";
import type { PaneContent, SplitLayout } from "@/lib/split-layout";
import { usePromptDraftStorage } from "@/hooks/usePromptDraftStorage";
import { createBbDesktopApi } from "@/test/bb-desktop-test-utils";
import { resourceRouteLabelAtom } from "@/components/layout/resourceRouteLabelAtom";
import {
  resetPluginSlotStoreForTest,
  setPluginSlotRegistrations,
} from "@/lib/plugin-slots";
import {
  usePluginComposerHost,
  type PluginComposerHost,
} from "@/components/plugin/plugin-composer-host";
import { PaneContext, usePaneSecondaryPanelRegistration } from "./PaneContext";
import { SplitThreadArea } from "./SplitThreadArea";
import { applyThreadOpenToLayout } from "./splitThreadNavigation";
import { makePluginRegistrationSet } from "@/test/fixtures/plugins";

const threadStore = vi.hoisted(
  () =>
    new Map<string, { archivedAt: number | null; deletedAt: number | null }>(),
);
const viewportState = vi.hoisted(() => ({ compact: false }));
const sidebarState = vi.hoisted(() => ({ showing: true }));
const panelFullScreenState = vi.hoisted(() => ({
  isMainCollapsed: false,
}));
const panelGroupLayoutState = vi.hoisted(() => ({ layout: [100, 0] }));
const panelCallbacks = vi.hoisted(
  () =>
    new Map<
      string,
      { onCollapse?: () => void; onResize?: (size: number) => void }
    >(),
);
const commandHandlers = vi.hoisted(() => new Map<string, () => boolean>());
interface ShortcutPresentationFixture {
  ariaKeyshortcuts: string;
  label: string;
}
const commandPresentationState = vi.hoisted(
  (): {
    isModifierHeld: boolean;
    shortcut: ShortcutPresentationFixture | null;
  } => ({ isModifierHeld: false, shortcut: null }),
);

function HostedComposerScopeProbe({ threadId }: { threadId: string }) {
  const composerHost = usePluginComposerHost();
  return (
    <div data-testid={`hosted-composer-scope-${threadId}`}>
      {composerHost?.scope.kind === "thread"
        ? composerHost.scope.threadId
        : "missing"}
    </div>
  );
}

function RootComposeFixture() {
  const pane = useContext(PaneContext);
  const [isPanelOpen, setIsPanelOpen] = useState(false);
  const panelModel = useMemo(
    () => ({
      composerHost: null,
      contentKey: "new-thread",
      isMainCollapsed: false,
      isOpen: isPanelOpen,
      panel: <div data-testid="hosted-new-thread-panel" />,
      onToggle: () => setIsPanelOpen((open) => !open),
      transitionsReady: true,
    }),
    [isPanelOpen],
  );
  usePaneSecondaryPanelRegistration(
    pane?.secondaryPanelHost ?? null,
    panelModel,
  );
  return <div data-testid="root-compose-view" />;
}

vi.mock("@bb/shared-ui/hooks/use-compact-viewport", () => ({
  useIsCompactViewport: () => viewportState.compact,
}));

vi.mock("@/hooks/queries/thread-queries", () => ({
  useThread: (id: string) => {
    const entry = threadStore.get(id);
    if (entry === undefined) {
      return { data: undefined, isSuccess: false, isError: false, error: null };
    }
    return {
      data: { id, archivedAt: entry.archivedAt, deletedAt: entry.deletedAt },
      isSuccess: true,
      isError: false,
      error: null,
    };
  },
}));

vi.mock("@/components/commands/AppCommandProvider", () => ({
  useAppCommandContext: () => undefined,
  useAppCommandHandler: (command: string, handler: () => boolean) => {
    commandHandlers.set(command, handler);
  },
  useAppCommandShortcut: () => commandPresentationState.shortcut,
  useIsAppCommandModifierHeld: () => commandPresentationState.isModifierHeld,
  useIndexedAppCommandHandlers: () => undefined,
}));

vi.mock("react-resizable-panels", async () => {
  const React = await import("react");
  const PanelGroup = React.forwardRef<
    {
      getLayout: () => number[];
      setLayout: (layout: number[]) => void;
    },
    React.HTMLAttributes<HTMLDivElement> & { children?: ReactNode }
  >(({ children, ...props }, ref) => {
    React.useImperativeHandle(
      ref,
      () => ({
        getLayout: () => panelGroupLayoutState.layout,
        setLayout: (layout: number[]) => {
          panelGroupLayoutState.layout = layout;
        },
      }),
      [],
    );
    return (
      <div {...props} data-testid="workspace-panel-group">
        {children}
      </div>
    );
  });
  PanelGroup.displayName = "MockPanelGroup";
  const Panel = ({
    children,
    id,
    onCollapse,
    onResize,
  }: {
    children?: ReactNode;
    id?: string;
    onCollapse?: () => void;
    onResize?: (size: number) => void;
  }) => {
    if (id !== undefined) panelCallbacks.set(id, { onCollapse, onResize });
    return (
      <div data-testid="workspace-panel" data-panel-id={id}>
        {children}
      </div>
    );
  };
  const PanelResizeHandle = ({
    children,
    className,
    id,
  }: {
    children?: ReactNode;
    className?: string;
    id?: string;
  }) => (
    <div
      id={id}
      className={className}
      data-testid="workspace-panel-resize-handle"
    >
      {children}
    </div>
  );
  return { Panel, PanelGroup, PanelResizeHandle };
});

vi.mock("@/components/ui/sidebar.js", () => ({
  useIsSidebarShowing: () => sidebarState.showing,
}));

vi.mock("@/views/RootComposeView", () => ({
  RootComposeView: RootComposeFixture,
}));

vi.mock("@/components/plugin/PluginPanelRightPanelHost", () => ({
  PluginPanelRightPanelHost: ({
    children,
    flushPageInsets,
    panelPath,
    pluginDetailTabsEnabled,
    pluginId,
  }: {
    children: ReactNode;
    flushPageInsets?: boolean;
    panelPath: string;
    pluginDetailTabsEnabled?: boolean;
    pluginId: string;
  }) => {
    const pane = useContext(PaneContext);
    const [isPanelOpen, setIsPanelOpen] = useState(false);
    const [isDetailTabOpen, setIsDetailTabOpen] = useState(false);
    const panelModel = useMemo(
      () => ({
        composerHost: null,
        contentKey: `plugin-panel:${pluginId}:${panelPath}`,
        isMainCollapsed: false,
        isOpen: isPanelOpen,
        panel: (
          <div data-testid="hosted-plugin-app-panel">
            <div data-testid="workspace-panel-resize-handle" className="z-[30]">
              <span data-panel-resize-hit-target="" />
            </div>
            {isPanelOpen ? (
              <button
                type="button"
                aria-label="Hide right panel"
                onClick={() => setIsPanelOpen(false)}
              />
            ) : null}
          </div>
        ),
        onToggle: () => setIsPanelOpen((open) => !open),
        transitionsReady: true,
      }),
      [isPanelOpen, panelPath, pluginId],
    );
    usePaneSecondaryPanelRegistration(
      pane?.secondaryPanelHost ?? null,
      panelModel,
    );
    return (
      <div
        data-testid="plugin-browser-host"
        data-flush-page-insets={String(flushPageInsets === true)}
        data-panel-path={panelPath}
        data-plugin-detail-tabs-enabled={String(
          pluginDetailTabsEnabled === true,
        )}
        data-plugin-id={pluginId}
        data-detail-tab-open={String(isDetailTabOpen)}
      >
        {children}
        {pluginDetailTabsEnabled === true ? (
          <button type="button" onClick={() => setIsDetailTabOpen(true)}>
            Open plugin detail tab
          </button>
        ) : null}
      </div>
    );
  },
}));

vi.mock("./ThreadDetailView", () => ({
  ThreadDetailView: ({
    projectId = "proj_personal",
    threadId = "thr-a",
  }: {
    projectId: string;
    threadId: string;
  }) => {
    const pane = useContext(PaneContext);
    const [isPanelOpen, setIsPanelOpen] = useState(threadId === "thr-a");
    const composerHost = useMemo<PluginComposerHost>(() => {
      const draft = { attachments: [], mentions: [], text: "" };
      return {
        scope: { kind: "thread", threadId },
        textEffectKey: `test-draft-${threadId}`,
        getCurrent: () => draft,
        subscribeDraft: () => () => {},
        setDraft: () => undefined,
        focus: () => undefined,
      };
    }, [threadId]);
    const panelModel = useMemo(
      () => ({
        composerHost,
        contentKey: threadId,
        isMainCollapsed: panelFullScreenState.isMainCollapsed,
        isOpen: isPanelOpen,
        panel: (
          <div data-testid={`hosted-panel-${threadId}`}>
            <HostedComposerScopeProbe threadId={threadId} />
          </div>
        ),
        onToggle: () => setIsPanelOpen((open) => !open),
        transitionsReady: true,
      }),
      [composerHost, isPanelOpen, threadId],
    );
    usePaneSecondaryPanelRegistration(
      pane?.secondaryPanelHost ?? null,
      panelModel,
    );
    const draft = usePromptDraftStorage({
      kind: "thread",
      projectId,
      threadId,
    });
    return (
      <div
        data-testid={`pane-${threadId}`}
        data-focused={pane?.isFocused ? "true" : "false"}
        data-window-top-left-owner={pane?.ownsWindowTopLeft ? "true" : "false"}
      >
        <div
          data-testid={`drag-${threadId}`}
          onPointerDown={(event) => pane?.beginPaneDrag?.(event, threadId)}
        />
        <textarea
          data-testid={`draft-${threadId}`}
          value={draft.text}
          onChange={(event) => draft.setTextAndMentions(event.target.value, [])}
        />
        <div
          data-testid={`scroll-${threadId}`}
          style={{ height: 20, overflow: "auto" }}
        >
          <div style={{ height: 100 }} />
        </div>
        {pane?.onRequestClose ? (
          <button
            type="button"
            data-testid={`close-${threadId}`}
            onClick={pane.onRequestClose}
          >
            close
          </button>
        ) : null}
        {pane?.onToggleMaximize ? (
          <button
            type="button"
            data-testid={`maximize-${threadId}`}
            onClick={pane.onToggleMaximize}
          >
            {pane.isMaximized ? "restore" : "maximize"}
          </button>
        ) : null}
        {pane?.onMoveToSide ? (
          <button
            type="button"
            data-testid={`move-right-${threadId}`}
            onClick={() => pane.onMoveToSide?.("right")}
          >
            move right
          </button>
        ) : null}
      </div>
    );
  },
}));

const { queryClient, wrapper: _wrapper } = createQueryClientTestHarness();
void _wrapper;

function threadContent(threadId: string) {
  return {
    kind: "thread" as const,
    projectId: PERSONAL_PROJECT_ID,
    threadId,
  };
}

function stackingLayer(element: HTMLElement): number {
  for (const token of element.classList) {
    const match = /^z-(?:\[(\d+)\]|(\d+))$/.exec(token);
    if (match !== null) {
      return Number(match[1] ?? match[2]);
    }
  }
  return 0;
}

function twoPaneLayout(
  focusedPaneId: "pane-1" | "pane-2",
  dir: "row" | "col" = "row",
): SplitLayout {
  return {
    root: {
      type: "split",
      dir,
      sizes: [0.5, 0.5],
      children: [
        { type: "pane", paneId: "pane-1", content: threadContent("thr-a") },
        { type: "pane", paneId: "pane-2", content: threadContent("thr-b") },
      ],
    },
    focusedPaneId,
  };
}

function eightPaneThreadLayout(): SplitLayout {
  let layout: SplitLayout | null = null;
  for (let index = 0; index < 8; index += 1) {
    layout = applyThreadOpenToLayout(
      layout,
      {
        projectId: PERSONAL_PROJECT_ID,
        threadId: `thr-${String.fromCharCode(97 + index)}`,
      },
      index === 0 ? "replace" : "right",
    );
  }
  if (layout === null) {
    throw new Error("Expected eight-pane layout");
  }
  return layout;
}

const docsContent: PaneContent = {
  kind: "plugin-panel",
  pluginId: "docs",
  panelPath: "docs",
  subPath: "",
};

const pluginGuideContent: PaneContent = {
  kind: "plugin-panel",
  pluginId: "plugin-api-docs",
  panelPath: "plugin-api",
  subPath: "",
};

const newThreadContent: PaneContent = { kind: "new-thread" };

function pluginContent(panelPath: string): PaneContent {
  return {
    kind: "plugin-panel",
    pluginId: "test-plugin",
    panelPath,
    subPath: "",
  };
}

function fourPanePluginLayout(): SplitLayout {
  return {
    root: {
      type: "split",
      dir: "row",
      sizes: [0.5, 0.5],
      children: [
        {
          type: "split",
          dir: "col",
          sizes: [0.5, 0.5],
          children: [
            {
              type: "pane",
              paneId: "pane-top-left",
              content: pluginContent("top-left"),
            },
            {
              type: "pane",
              paneId: "pane-bottom-left",
              content: pluginContent("bottom-left"),
            },
          ],
        },
        {
          type: "split",
          dir: "col",
          sizes: [0.5, 0.5],
          children: [
            {
              type: "pane",
              paneId: "pane-top-right",
              content: pluginContent("top-right"),
            },
            {
              type: "pane",
              paneId: "pane-bottom-right",
              content: pluginContent("bottom-right"),
            },
          ],
        },
      ],
    },
    focusedPaneId: "pane-bottom-right",
  };
}

function pluginSplitLayout(): SplitLayout {
  return {
    root: {
      type: "split",
      dir: "row",
      sizes: [0.5, 0.5],
      children: [
        { type: "pane", paneId: "pane-1", content: threadContent("thr-a") },
        { type: "pane", paneId: "pane-2", content: docsContent },
      ],
    },
    focusedPaneId: "pane-2",
  };
}

function twoPluginSplitLayout(): SplitLayout {
  return {
    root: {
      type: "split",
      dir: "row",
      sizes: [0.5, 0.5],
      children: [
        {
          type: "pane",
          paneId: "pane-automations",
          content: pluginContent("automations"),
        },
        { type: "pane", paneId: "pane-docs", content: docsContent },
      ],
    },
    focusedPaneId: "pane-docs",
  };
}

function threadPath(threadId: string): string {
  return `/threads/${threadId}`;
}

function LocationProbe() {
  const location = useLocation();
  return <div data-testid="location">{location.pathname}</div>;
}

function ExternalNav({ to }: { to: string }) {
  const navigate = useNavigate();
  return (
    <button
      type="button"
      data-testid="external-nav"
      onClick={() => navigate(to)}
    >
      go
    </button>
  );
}

function PluginPanelLifecycleHarness() {
  const [routeContent, setRouteContent] =
    useState<PaneContent>(pluginGuideContent);
  return (
    <>
      <SplitThreadArea routeContent={routeContent} />
      <button
        type="button"
        onClick={() =>
          setRouteContent((current) =>
            current.kind === "plugin-panel" && current.subPath === ""
              ? { ...pluginGuideContent, subPath: "the-composer" }
              : docsContent,
          )
        }
      >
        Navigate plugin panel
      </button>
    </>
  );
}

function RouteAwareSplitArea() {
  const location = useLocation();
  return (
    <SplitThreadArea
      routeContent={
        location.pathname.startsWith("/plugins/") ? docsContent : undefined
      }
    />
  );
}

function renderSplitArea(options: {
  path: string;
  layout?: SplitLayout;
  externalTo?: string;
  routeContent?: PaneContent;
  routeAwareContent?: boolean;
  pluginPanelLifecycle?: boolean;
  maximizedPaneId?: string;
}) {
  const store = createStore();
  if (options.layout !== undefined) {
    store.set(splitLayoutAtom, options.layout);
  }
  if (options.maximizedPaneId !== undefined) {
    store.set(maximizedPaneIdAtom, options.maximizedPaneId);
  }
  render(
    <TooltipProvider delayDuration={0}>
      <JotaiProvider store={store}>
        <QueryClientProvider client={queryClient}>
          <MemoryRouter initialEntries={[options.path]}>
            {options.pluginPanelLifecycle ? (
              <PluginPanelLifecycleHarness />
            ) : options.routeAwareContent ? (
              <RouteAwareSplitArea />
            ) : (
              <SplitThreadArea routeContent={options.routeContent} />
            )}
            <LocationProbe />
            {options.externalTo !== undefined ? (
              <ExternalNav to={options.externalTo} />
            ) : null}
          </MemoryRouter>
        </QueryClientProvider>
      </JotaiProvider>
    </TooltipProvider>,
  );
  return store;
}

beforeEach(() => {
  viewportState.compact = false;
  sidebarState.showing = true;
  panelFullScreenState.isMainCollapsed = false;
  panelGroupLayoutState.layout = [100, 0];
  commandHandlers.clear();
  commandPresentationState.isModifierHeld = false;
  commandPresentationState.shortcut = null;
  threadStore.set("thr-a", { archivedAt: null, deletedAt: null });
  threadStore.set("thr-b", { archivedAt: null, deletedAt: null });
});

afterEach(() => {
  cleanup();
  threadStore.clear();
  panelCallbacks.clear();
  resetPluginSlotStoreForTest();
  delete window.bbDesktop;
  window.localStorage.clear();
  window.sessionStorage.clear();
});

describe("SplitThreadArea", () => {
  it("hosts Browser-tab navigation on compact plugin-panel routes", async () => {
    viewportState.compact = true;

    renderSplitArea({
      path: "/plugins/docs/docs",
      layout: pluginSplitLayout(),
      routeContent: docsContent,
    });

    const host = await screen.findByTestId("plugin-browser-host");
    expect(host.dataset.pluginId).toBe("docs");
    expect(host.dataset.panelPath).toBe("docs");
    expect(host.dataset.flushPageInsets).toBe("true");
    expect(host.dataset.pluginDetailTabsEnabled).toBe("false");
  });

  it("preserves detail state within the Guide and clears it for another plugin page", async () => {
    renderSplitArea({
      path: "/plugins/plugin-api-docs/plugin-api",
      pluginPanelLifecycle: true,
    });

    const host = await screen.findByTestId("plugin-browser-host");
    expect(host.dataset.pluginDetailTabsEnabled).toBe("true");
    fireEvent.click(
      screen.getByRole("button", { name: "Open plugin detail tab" }),
    );
    expect(host.dataset.detailTabOpen).toBe("true");

    fireEvent.click(
      screen.getByRole("button", { name: "Navigate plugin panel" }),
    );
    await waitFor(() =>
      expect(
        screen.getByTestId("plugin-browser-host").dataset.detailTabOpen,
      ).toBe("true"),
    );

    fireEvent.click(
      screen.getByRole("button", { name: "Navigate plugin panel" }),
    );
    await waitFor(() =>
      expect(
        screen.getByTestId("plugin-browser-host").dataset.detailTabOpen,
      ).toBe("false"),
    );
  });

  it("applies spotlight pane actions to the targeted open split and preference", async () => {
    const store = renderSplitArea({
      path: threadPath("thr-b"),
      layout: twoPaneLayout("pane-2"),
    });
    store.set(dimInactiveSplitsAtom, false);

    act(() => {
      wsManager.handleIncomingMessage(
        JSON.stringify({
          type: "thread-pane-action",
          projectId: PERSONAL_PROJECT_ID,
          threadId: "thr-a",
          action: "spotlight",
        }),
      );
    });

    await waitFor(() => {
      expect(store.get(splitLayoutAtom)?.focusedPaneId).toBe("pane-1");
      expect(store.get(dimInactiveSplitsAtom)).toBe(true);
      expect(screen.getByTestId("location").textContent).toBe(
        threadPath("thr-a"),
      );
    });

    act(() => {
      wsManager.handleIncomingMessage(
        JSON.stringify({
          type: "thread-pane-action",
          projectId: PERSONAL_PROJECT_ID,
          threadId: "thr-b",
          action: "clear-spotlight",
        }),
      );
    });

    await waitFor(() => {
      expect(store.get(splitLayoutAtom)?.focusedPaneId).toBe("pane-2");
      expect(store.get(dimInactiveSplitsAtom)).toBe(false);
      expect(screen.getByTestId("location").textContent).toBe(
        threadPath("thr-b"),
      );
    });
    expect(window.localStorage.getItem(DIM_INACTIVE_SPLITS_STORAGE_KEY)).toBe(
      "false",
    );
  });

  it("maximizes without changing the split tree and restores mounted pane state", async () => {
    const initialLayout = twoPaneLayout("pane-1");
    const store = renderSplitArea({
      path: threadPath("thr-a"),
      layout: initialLayout,
    });
    fireEvent.change(await screen.findByTestId("draft-thr-b"), {
      target: { value: "preserve this hidden draft" },
    });

    fireEvent.click(screen.getByTestId("maximize-thr-a"));

    const paneA = document.querySelector<HTMLElement>(
      '[data-split-pane-id="pane-1"]',
    );
    const paneB = document.querySelector<HTMLElement>(
      '[data-split-pane-id="pane-2"]',
    );
    expect(paneA?.getAttribute("data-maximized")).toBe("true");
    expect(paneA?.className).toContain("absolute");
    expect(paneB?.className).toContain("invisible");
    expect(paneB?.getAttribute("aria-hidden")).toBe("true");
    expect(paneB?.style.contentVisibility).toBe("hidden");
    expect(screen.getByTestId("draft-thr-b")).toBeTruthy();
    expect(store.get(splitLayoutAtom)?.root).toEqual(initialLayout.root);
    expect(store.get(maximizedPaneIdAtom)).toBe("pane-1");

    fireEvent.click(screen.getByTestId("maximize-thr-a"));

    expect(paneA?.getAttribute("data-maximized")).toBeNull();
    expect(paneB?.className).not.toContain("invisible");
    expect(paneB?.style.contentVisibility).toBe("");
    expect(
      (screen.getByTestId("draft-thr-b") as HTMLTextAreaElement).value,
    ).toBe("preserve this hidden draft");
    expect(store.get(splitLayoutAtom)?.root).toEqual(initialLayout.root);
    expect(store.get(maximizedPaneIdAtom)).toBeNull();
    fireEvent.change(screen.getByTestId("draft-thr-b"), {
      target: { value: "" },
    });
  });

  it("temporarily replaces panel full screen with a clean thread full screen", async () => {
    panelFullScreenState.isMainCollapsed = true;
    renderSplitArea({
      path: threadPath("thr-a"),
      layout: twoPaneLayout("pane-1"),
    });

    expect(screen.queryByTestId("mock-collapsed-thread-rail")).toBeNull();
    fireEvent.click(screen.getByTestId("maximize-thr-a"));

    expect(screen.getByTestId("maximize-thr-a").textContent).toBe("restore");
    await waitFor(() => {
      expect(panelGroupLayoutState.layout).toEqual([100, 0]);
    });

    fireEvent.click(screen.getByTestId("maximize-thr-a"));
    expect(screen.queryByTestId("mock-collapsed-thread-rail")).toBeNull();
    await waitFor(() => {
      expect(panelGroupLayoutState.layout).toEqual([0, 100]);
    });
  });

  it("preserves a hidden pane's mounted scroll position through restore", async () => {
    renderSplitArea({
      path: threadPath("thr-a"),
      layout: twoPaneLayout("pane-1"),
    });
    const hiddenScroller = screen.getByTestId("scroll-thr-b");
    hiddenScroller.scrollTop = 12;
    fireEvent.scroll(hiddenScroller);

    fireEvent.click(screen.getByTestId("maximize-thr-a"));
    const hiddenPane = screen
      .getByTestId("pane-thr-b")
      .closest("[data-split-pane-id]");
    await waitFor(() =>
      expect(hiddenPane?.getAttribute("aria-hidden")).toBe("true"),
    );

    hiddenScroller.scrollTop = 0;
    fireEvent.scroll(hiddenScroller);
    fireEvent.click(screen.getByTestId("maximize-thr-a"));

    await waitFor(() => expect(hiddenScroller.scrollTop).toBe(12));
    expect(hiddenPane?.getAttribute("aria-hidden")).toBeNull();

    hiddenScroller.scrollTop = 0;
    fireEvent.click(screen.getByTestId("maximize-thr-a"));
    fireEvent.click(screen.getByTestId("maximize-thr-a"));
    await waitFor(() => expect(hiddenScroller.scrollTop).toBe(0));
  });

  it("stops the restore loop once positions settle instead of burning 30 frames", async () => {
    renderSplitArea({
      path: threadPath("thr-a"),
      layout: twoPaneLayout("pane-1"),
    });
    const hiddenScroller = screen.getByTestId("scroll-thr-b");
    hiddenScroller.scrollTop = 12;
    fireEvent.scroll(hiddenScroller);

    let scrollTopValue = 12;
    const writes: number[] = [];
    Object.defineProperty(hiddenScroller, "scrollTop", {
      configurable: true,
      get: () => scrollTopValue,
      set: (value: number) => {
        writes.push(value);
        scrollTopValue = value;
      },
    });

    fireEvent.click(screen.getByTestId("maximize-thr-a"));
    await new Promise((resolve) => setTimeout(resolve, 600));
    expect(writes).toHaveLength(0);

    Object.defineProperty(hiddenScroller, "scrollTop", {
      configurable: true,
      get: () => 0,
      set: (value: number) => {
        writes.push(value);
      },
    });
    fireEvent.click(screen.getByTestId("maximize-thr-a"));
    await new Promise((resolve) => setTimeout(resolve, 600));
    expect(writes.length).toBeGreaterThan(0);
    expect(writes.length).toBeLessThanOrEqual(6);
  });

  it("toggles the focused pane through the discoverable app command", async () => {
    const store = renderSplitArea({
      path: threadPath("thr-b"),
      layout: twoPaneLayout("pane-2"),
    });
    await screen.findByTestId("pane-thr-b");

    expect(commandHandlers.get("pane.maximize.toggle")?.()).toBe(true);
    await waitFor(() => expect(store.get(maximizedPaneIdAtom)).toBe("pane-2"));
    expect(commandHandlers.get("pane.maximize.toggle")?.()).toBe(true);
    await waitFor(() => expect(store.get(maximizedPaneIdAtom)).toBeNull());
  });

  it("routes arrangement actions through the existing split move operation", async () => {
    const store = renderSplitArea({
      path: threadPath("thr-a"),
      layout: twoPaneLayout("pane-1"),
    });

    fireEvent.click(await screen.findByTestId("move-right-thr-a"));

    expect(
      listPanes(
        store.get(splitLayoutAtom)?.root ?? twoPaneLayout("pane-1").root,
      ).map((pane) => pane.paneId),
    ).toEqual(["pane-2", "pane-1"]);
    expect(store.get(splitLayoutAtom)?.focusedPaneId).toBe("pane-1");
  });

  it("carries maximization through focus, CLI-style open, and pane move", async () => {
    const store = renderSplitArea({
      path: threadPath("thr-a"),
      layout: twoPaneLayout("pane-1"),
      maximizedPaneId: "pane-1",
    });
    await screen.findByTestId("pane-thr-a");

    expect(commandHandlers.get("pane.focus.next")?.()).toBe(true);
    await waitFor(() => expect(store.get(maximizedPaneIdAtom)).toBe("pane-2"));

    const opened = applyThreadOpenToLayout(
      store.get(splitLayoutAtom),
      { projectId: PERSONAL_PROJECT_ID, threadId: "thr-c" },
      "right",
    );
    store.set(splitLayoutAtom, opened);
    await waitFor(() => expect(store.get(maximizedPaneIdAtom)).toBe("pane-3"));

    store.set(splitLayoutAtom, movePane(opened, "pane-3", "pane-1", "left"));
    await waitFor(() => expect(store.get(maximizedPaneIdAtom)).toBe("pane-3"));
    expect(document.querySelectorAll("[data-split-pane-id]")).toHaveLength(3);
  });

  it("reveals move targets during a maximized drag and restores after drop", async () => {
    const store = renderSplitArea({
      path: threadPath("thr-a"),
      layout: twoPaneLayout("pane-1"),
      maximizedPaneId: "pane-1",
    });
    await screen.findByTestId("pane-thr-a");
    const paneA = document.querySelector<HTMLElement>(
      '[data-split-pane-id="pane-1"]',
    );
    const paneB = document.querySelector<HTMLElement>(
      '[data-split-pane-id="pane-2"]',
    );
    if (paneA === null || paneB === null)
      throw new Error("Missing split panes");
    const originalElementsFromPoint = document.elementsFromPoint;
    document.elementsFromPoint = vi.fn((x: number) =>
      x >= 500 ? [paneB] : [paneA],
    ) as typeof document.elementsFromPoint;
    Object.defineProperty(paneA, "getBoundingClientRect", {
      configurable: true,
      value: () => ({
        left: 0,
        right: 500,
        top: 0,
        bottom: 800,
        width: 500,
        height: 800,
        x: 0,
        y: 0,
        toJSON: () => ({}),
      }),
    });
    Object.defineProperty(paneB, "getBoundingClientRect", {
      configurable: true,
      value: () => ({
        left: 500,
        right: 1000,
        top: 0,
        bottom: 800,
        width: 500,
        height: 800,
        x: 500,
        y: 0,
        toJSON: () => ({}),
      }),
    });

    try {
      fireEvent.pointerDown(screen.getByTestId("drag-thr-a"), {
        button: 0,
        clientX: 100,
        clientY: 100,
      });
      fireEvent.pointerMove(window, { clientX: 130, clientY: 100 });
      await waitFor(() => expect(store.get(maximizedPaneIdAtom)).toBeNull());
      expect(paneB.className).not.toContain("invisible");

      fireEvent.pointerMove(window, { clientX: 750, clientY: 400 });
      fireEvent.pointerUp(window, { clientX: 750, clientY: 400 });
      fireEvent.click(window);

      await waitFor(() =>
        expect(store.get(maximizedPaneIdAtom)).toBe("pane-2"),
      );
      expect(store.get(splitLayoutAtom)?.root).toMatchObject({
        type: "split",
        children: [
          {
            type: "pane",
            paneId: "pane-1",
            content: { kind: "thread", threadId: "thr-b" },
          },
          {
            type: "pane",
            paneId: "pane-2",
            content: { kind: "thread", threadId: "thr-a" },
          },
        ],
      });
      expect(paneA.className).toContain("invisible");
      expect(paneB.getAttribute("data-maximized")).toBe("true");
    } finally {
      document.elementsFromPoint = originalElementsFromPoint;
    }
  });

  it("restores maximization when an engaged pane drag is cancelled", async () => {
    const initialLayout = twoPaneLayout("pane-1");
    const store = renderSplitArea({
      path: threadPath("thr-a"),
      layout: initialLayout,
      maximizedPaneId: "pane-1",
    });
    await screen.findByTestId("pane-thr-a");

    const originalElementsFromPoint = document.elementsFromPoint;
    document.elementsFromPoint = vi.fn(
      () => [],
    ) as typeof document.elementsFromPoint;
    try {
      fireEvent.pointerDown(screen.getByTestId("drag-thr-a"), {
        button: 0,
        clientX: 100,
        clientY: 100,
      });
      fireEvent.pointerMove(window, { clientX: 130, clientY: 100 });
      await waitFor(() => expect(store.get(maximizedPaneIdAtom)).toBeNull());
      fireEvent.pointerCancel(window, { clientX: 130, clientY: 100 });
      fireEvent.click(window);

      await waitFor(() =>
        expect(store.get(maximizedPaneIdAtom)).toBe("pane-1"),
      );
      expect(store.get(splitLayoutAtom)?.root).toEqual(initialLayout.root);
    } finally {
      document.elementsFromPoint = originalElementsFromPoint;
    }
  });

  it("restores survivors when the maximized pane closes", async () => {
    const store = renderSplitArea({
      path: threadPath("thr-b"),
      layout: twoPaneLayout("pane-2"),
      maximizedPaneId: "pane-2",
    });
    await screen.findByTestId("pane-thr-b");

    fireEvent.click(screen.getByTestId("close-thr-b"));

    await waitFor(() => expect(screen.queryByTestId("pane-thr-b")).toBeNull());
    expect(store.get(maximizedPaneIdAtom)).toBeNull();
    expect(document.querySelector('[data-split-pane-id="pane-1"]')).toBeNull();
    expect(screen.getByTestId("pane-thr-a")).toBeTruthy();
  });

  it("suppresses split maximization on compact viewports without discarding it", async () => {
    viewportState.compact = true;
    const store = renderSplitArea({
      path: threadPath("thr-a"),
      layout: twoPaneLayout("pane-1"),
      maximizedPaneId: "pane-1",
    });

    expect(await screen.findByTestId("pane-thr-a")).toBeTruthy();
    expect(screen.queryByTestId("pane-thr-b")).toBeNull();
    expect(screen.queryByTestId("maximize-thr-a")).toBeNull();
    expect(store.get(splitLayoutAtom)?.root.type).toBe("split");
    expect(store.get(maximizedPaneIdAtom)).toBe("pane-1");
  });

  it("keeps the divider above pane headers so stacked splits stay resizable", () => {
    renderSplitArea({
      path: "/",
      layout: {
        root: {
          type: "split",
          dir: "col",
          sizes: [0.5, 0.5],
          children: [
            { type: "pane", paneId: "pane-1", content: threadContent("thr-a") },
            { type: "pane", paneId: "pane-2", content: newThreadContent },
          ],
        },
        focusedPaneId: "pane-2",
      },
      routeContent: newThreadContent,
    });

    const separator = screen.getByRole("separator");
    const dividerLayer = stackingLayer(separator);
    const lowerHeader = document
      .querySelector<HTMLElement>('[data-split-pane-id="pane-2"]')
      ?.querySelector("header");
    const scrim = document.querySelector<HTMLElement>(
      "[data-pane-focus-scrim]",
    );
    expect(lowerHeader).toBeInstanceOf(HTMLElement);
    expect(scrim).toBeInstanceOf(HTMLElement);
    if (lowerHeader === null || lowerHeader === undefined || scrim === null) {
      return;
    }
    expect(stackingLayer(lowerHeader)).toBeLessThan(dividerLayer);
    expect(stackingLayer(scrim)).toBeLessThan(dividerLayer);
  });

  it("keeps drag updates local and persists the resized pair once on release", () => {
    const store = renderSplitArea({
      path: threadPath("thr-a"),
      layout: twoPaneLayout("pane-1"),
    });
    const separator = screen.getByRole("separator");
    const previous = separator.previousElementSibling;
    const next = separator.nextElementSibling;
    if (!(previous instanceof HTMLElement) || !(next instanceof HTMLElement)) {
      throw new Error("Expected adjacent split flex items");
    }

    const hitTarget = separator.querySelector<HTMLElement>(
      "[data-split-divider-hit-target]",
    );
    if (hitTarget === null) {
      throw new Error("Expected split divider hit target");
    }
    Object.defineProperty(hitTarget, "setPointerCapture", {
      configurable: true,
      value: vi.fn(),
    });
    vi.spyOn(previous, "getBoundingClientRect").mockReturnValue({
      bottom: 300,
      height: 300,
      left: 0,
      right: 400,
      top: 0,
      width: 400,
      x: 0,
      y: 0,
      toJSON: () => ({}),
    });
    vi.spyOn(next, "getBoundingClientRect").mockReturnValue({
      bottom: 300,
      height: 300,
      left: 406,
      right: 806,
      top: 0,
      width: 400,
      x: 406,
      y: 0,
      toJSON: () => ({}),
    });

    const scrollViewport = document.createElement("div");
    scrollViewport.style.overflowY = "auto";
    Object.defineProperties(scrollViewport, {
      clientHeight: { configurable: true, value: 300 },
      scrollHeight: { configurable: true, value: 1_000 },
    });
    vi.spyOn(scrollViewport, "getBoundingClientRect").mockReturnValue({
      bottom: 300,
      height: 300,
      left: 0,
      right: 400,
      top: 0,
      width: 400,
      x: 0,
      y: 0,
      toJSON: () => ({}),
    });
    const offscreenRow = document.createElement("div");
    offscreenRow.dataset.timelineRowId = "offscreen-row";
    vi.spyOn(offscreenRow, "getBoundingClientRect").mockReturnValue({
      bottom: -450,
      height: 50,
      left: 0,
      right: 400,
      top: -500,
      width: 400,
      x: 0,
      y: -500,
      toJSON: () => ({}),
    });
    scrollViewport.appendChild(offscreenRow);
    previous.appendChild(scrollViewport);

    const splitSizes = () => {
      const root = store.get(splitLayoutAtom)?.root;
      if (root?.type !== "split") {
        throw new Error("Expected split layout");
      }
      return root.sizes;
    };

    fireEvent.pointerDown(hitTarget, { clientX: 403, pointerId: 1 });
    fireEvent.pointerMove(hitTarget, { clientX: 564.2, pointerId: 1 });

    expect(splitSizes()).toEqual([0.5, 0.5]);
    expect(offscreenRow.style.contentVisibility).toBe("hidden");
    expect(offscreenRow.style.containIntrinsicBlockSize).toBe("50px");
    expect(Number.parseFloat(previous.style.flexGrow)).toBeCloseTo(0.7, 5);
    expect(Number.parseFloat(next.style.flexGrow)).toBeCloseTo(0.3, 5);

    fireEvent.pointerUp(hitTarget, { clientX: 564.2, pointerId: 1 });

    expect(splitSizes()[0]).toBeCloseTo(0.7, 5);
    expect(splitSizes()[1]).toBeCloseTo(0.3, 5);
    expect(offscreenRow.style.contentVisibility).toBe("");
    expect(offscreenRow.style.containIntrinsicBlockSize).toBe("");
  });

  it("snaps a workspace divider to its equal two-pane boundary and clears its guide", () => {
    const store = renderSplitArea({
      path: threadPath("thr-a"),
      layout: twoPaneLayout("pane-1"),
    });
    const separator = screen.getByRole("separator");
    const previous = separator.previousElementSibling;
    const next = separator.nextElementSibling;
    const hitTarget = separator.querySelector<HTMLElement>(
      "[data-split-divider-hit-target]",
    );
    if (
      hitTarget === null ||
      !(previous instanceof HTMLElement) ||
      !(next instanceof HTMLElement)
    ) {
      throw new Error("Expected adjacent workspace split items");
    }
    const grid = separator.parentElement;
    if (grid === null) throw new Error("Expected a workspace split grid");
    expect(separator.dataset.splitResizeGridBoundary).toBe("1");
    expect(separator.dataset.splitResizeGridCount).toBe("2");
    Object.defineProperties(hitTarget, {
      releasePointerCapture: { configurable: true, value: vi.fn() },
      setPointerCapture: { configurable: true, value: vi.fn() },
    });
    vi.spyOn(previous, "getBoundingClientRect").mockReturnValue({
      bottom: 600,
      height: 600,
      left: 300,
      right: 500,
      top: 0,
      width: 200,
      x: 300,
      y: 0,
      toJSON: () => ({}),
    });
    vi.spyOn(next, "getBoundingClientRect").mockReturnValue({
      bottom: 600,
      height: 600,
      left: 501,
      right: 900,
      top: 0,
      width: 399,
      x: 501,
      y: 0,
      toJSON: () => ({}),
    });
    vi.spyOn(separator, "getBoundingClientRect").mockReturnValue({
      bottom: 600,
      height: 600,
      left: 500,
      right: 501,
      top: 0,
      width: 1,
      x: 500,
      y: 0,
      toJSON: () => ({}),
    });
    vi.spyOn(grid, "getBoundingClientRect").mockReturnValue({
      bottom: 600,
      height: 600,
      left: 100,
      right: 900,
      top: 0,
      width: 800,
      x: 100,
      y: 0,
      toJSON: () => ({}),
    });
    fireEvent.pointerDown(hitTarget, { clientX: 470, pointerId: 31 });
    fireEvent.pointerMove(hitTarget, { clientX: 518, pointerId: 31 });

    expect(Number.parseFloat(previous.style.flexGrow)).toBeCloseTo(
      199.5 / 599,
      5,
    );
    expect(
      document.querySelector<HTMLElement>("[data-split-resize-snap-guide]")
        ?.style.left,
    ).toBe("500px");

    fireEvent.pointerUp(hitTarget, { clientX: 518, pointerId: 31 });

    const root = store.get(splitLayoutAtom)?.root;
    expect(root?.type).toBe("split");
    if (root?.type === "split") {
      expect(root.sizes[0]).toBeCloseTo(199.5 / 599, 5);
      expect(root.sizes[1]).toBeCloseTo(399.5 / 599, 5);
    }
    expect(document.querySelector("[data-split-resize-snap-guide]")).toBeNull();
  });

  it("keeps workspace separators out of the tab order", () => {
    renderSplitArea({
      path: threadPath("thr-a"),
      layout: twoPaneLayout("pane-1"),
    });

    const separator = screen.getByRole("separator");
    fireEvent.keyDown(separator, { key: "ArrowRight" });

    expect(separator.tabIndex).toBe(-1);
    expect(document.querySelector("[data-split-resize-snap-guide]")).toBeNull();
  });

  it("gives a top-to-bottom split a full-width drag target without thickening its seam", () => {
    const store = renderSplitArea({
      path: threadPath("thr-a"),
      layout: twoPaneLayout("pane-1", "col"),
    });
    const separator = screen.getByRole("separator");
    expect(separator.getAttribute("aria-orientation")).toBe("horizontal");

    const hitTarget = separator.querySelector<HTMLElement>(
      "[data-split-divider-hit-target]",
    );
    const previous = separator.previousElementSibling;
    const next = separator.nextElementSibling;
    if (
      hitTarget === null ||
      !(previous instanceof HTMLElement) ||
      !(next instanceof HTMLElement)
    ) {
      throw new Error("Expected a divider hit target between split panes");
    }

    Object.defineProperty(hitTarget, "setPointerCapture", {
      configurable: true,
      value: vi.fn(),
    });
    vi.spyOn(previous, "getBoundingClientRect").mockReturnValue({
      bottom: 300,
      height: 300,
      left: 0,
      right: 800,
      top: 0,
      width: 800,
      x: 0,
      y: 0,
      toJSON: () => ({}),
    });
    vi.spyOn(next, "getBoundingClientRect").mockReturnValue({
      bottom: 606,
      height: 300,
      left: 0,
      right: 800,
      top: 306,
      width: 800,
      x: 0,
      y: 306,
      toJSON: () => ({}),
    });

    fireEvent.pointerDown(hitTarget, { clientY: 303, pointerId: 1 });
    fireEvent.pointerMove(hitTarget, { clientY: 424.2, pointerId: 1 });

    expect(Number.parseFloat(previous.style.flexGrow)).toBeCloseTo(0.7, 5);
    expect(Number.parseFloat(next.style.flexGrow)).toBeCloseTo(0.3, 5);
    expect(store.get(splitLayoutAtom)?.root).toMatchObject({
      dir: "col",
      sizes: [0.5, 0.5],
    });

    fireEvent.pointerUp(hitTarget, { clientY: 424.2, pointerId: 1 });

    const resizedRoot = store.get(splitLayoutAtom)?.root;
    expect(resizedRoot).toMatchObject({ dir: "col" });
    if (resizedRoot?.type !== "split") {
      throw new Error("Expected resized split layout");
    }
    expect(resizedRoot.sizes[0]).toBeCloseTo(0.7, 5);
    expect(resizedRoot.sizes[1]).toBeCloseTo(0.3, 5);
  });

  it("hosts one panel whose visibility survives focus changes between panes", async () => {
    renderSplitArea({
      path: threadPath("thr-a"),
      layout: twoPaneLayout("pane-1"),
    });

    const toggle = await screen.findByTestId("split-workspace-panel-toggle");
    expect(
      screen.getByTestId("workspace-panel-group").dataset.splitResizeGridRoot,
    ).toBe("");
    expect(
      screen.queryAllByTestId("split-workspace-panel-toggle"),
    ).toHaveLength(1);
    expect(screen.getByTestId("hosted-panel-thr-a")).toBeTruthy();
    expect(screen.getByTestId("hosted-composer-scope-thr-a").textContent).toBe(
      "thr-a",
    );
    expect(screen.queryByTestId("hosted-panel-thr-b")).toBeNull();
    expect(toggle.querySelector("button")?.getAttribute("aria-expanded")).toBe(
      "true",
    );
    expect(toggle.classList).toContain("hidden");
    expect(toggle.querySelector("button")?.hasAttribute("aria-pressed")).toBe(
      false,
    );

    fireEvent.pointerDown(screen.getByTestId("pane-thr-b"));
    await screen.findByTestId("hosted-panel-thr-b");
    expect(screen.getByTestId("hosted-composer-scope-thr-b").textContent).toBe(
      "thr-b",
    );
    expect(screen.queryByTestId("hosted-panel-thr-a")).toBeNull();
    expect(
      screen
        .getByTestId("split-workspace-panel-toggle")
        .querySelector("button")
        ?.getAttribute("aria-expanded"),
    ).toBe("true");

    fireEvent.click(screen.getByRole("button", { name: "Hide right panel" }));
    expect(
      screen
        .getByTestId("split-workspace-panel-toggle")
        .querySelector("button")
        ?.getAttribute("aria-expanded"),
    ).toBe("false");
    expect(toggle.classList).not.toContain("hidden");

    fireEvent.pointerDown(screen.getByTestId("pane-thr-a"));
    await screen.findByTestId("hosted-panel-thr-a");
    expect(
      screen
        .getByTestId("split-workspace-panel-toggle")
        .querySelector("button")
        ?.getAttribute("aria-expanded"),
    ).toBe("false");
  });

  it("keeps the panel available for a focused new-thread pane", async () => {
    renderSplitArea({
      path: "/",
      layout: {
        root: {
          type: "split",
          dir: "row",
          sizes: [0.5, 0.5],
          children: [
            { type: "pane", paneId: "pane-1", content: threadContent("thr-a") },
            { type: "pane", paneId: "pane-2", content: newThreadContent },
          ],
        },
        focusedPaneId: "pane-2",
      },
      routeContent: newThreadContent,
    });

    const showPanel = await screen.findByRole("button", {
      name: "Show right panel",
    });
    expect(showPanel.hasAttribute("disabled")).toBe(false);
    fireEvent.click(showPanel);

    expect(await screen.findByTestId("hosted-new-thread-panel")).toBeTruthy();
    expect(
      screen
        .getByRole("button", { name: "Hide right panel" })
        .getAttribute("aria-expanded"),
    ).toBe("true");
  });

  it("hosts the app panel while a plugin pane is focused", async () => {
    const layout = pluginSplitLayout();
    layout.focusedPaneId = "pane-1";
    renderSplitArea({
      path: threadPath("thr-a"),
      layout,
      routeAwareContent: true,
    });

    const toggle = await screen.findByTestId("split-workspace-panel-toggle");
    expect(toggle.querySelector("button")?.getAttribute("aria-expanded")).toBe(
      "true",
    );
    expect(
      screen.queryByTestId("split-workspace-empty-panel-state"),
    ).toBeNull();
    const pluginPane = document.querySelector('[data-split-pane-id="pane-2"]');
    if (!(pluginPane instanceof HTMLElement)) {
      throw new Error("Expected plugin split pane");
    }

    fireEvent.pointerDown(pluginPane);
    expect(await screen.findByTestId("hosted-plugin-app-panel")).toBeTruthy();
    expect(
      screen.queryByTestId("split-workspace-empty-panel-state"),
    ).toBeNull();
    const panelResizeHandle = screen.getByTestId(
      "workspace-panel-resize-handle",
    );
    expect(
      panelResizeHandle.querySelector("[data-panel-resize-hit-target]"),
    ).not.toBeNull();
    const pluginToggle = screen
      .getByTestId("split-workspace-panel-toggle")
      .querySelector("button");
    expect(pluginToggle?.hasAttribute("disabled")).toBe(false);
    expect(
      pluginPane.querySelector('button[aria-label*="Maximize pane"]'),
    ).not.toBeNull();

    fireEvent.click(pluginToggle!);
    await waitFor(() =>
      expect(
        screen
          .getByTestId("split-workspace-panel-toggle")
          .querySelector("button")
          ?.getAttribute("aria-expanded"),
      ).toBe("false"),
    );

    fireEvent.pointerDown(screen.getByTestId("pane-thr-a"));
    expect(screen.getByTestId("hosted-panel-thr-a")).toBeTruthy();
    expect(
      screen.queryByTestId("split-workspace-empty-panel-state"),
    ).toBeNull();
  });

  it("keeps the right-panel resize target above a bounded pane header", async () => {
    const layout = pluginSplitLayout();
    layout.focusedPaneId = "pane-1";
    renderSplitArea({
      path: threadPath("thr-a"),
      layout,
      routeAwareContent: true,
    });

    const pluginPane = document.querySelector('[data-split-pane-id="pane-2"]');
    if (!(pluginPane instanceof HTMLElement)) {
      throw new Error("Expected plugin split pane");
    }

    fireEvent.pointerDown(pluginPane);
    await screen.findByTestId("hosted-plugin-app-panel");

    const panelResizeHandle = screen.getByTestId(
      "workspace-panel-resize-handle",
    );
    const pluginPaneHeader = pluginPane.querySelector("header");
    expect(pluginPaneHeader).toBeInstanceOf(HTMLElement);
    if (pluginPaneHeader instanceof HTMLElement) {
      expect(stackingLayer(pluginPaneHeader)).toBeLessThan(
        stackingLayer(panelResizeHandle),
      );
    }
  });

  it("keeps a thread's open panel after focusing a plugin page", async () => {
    const layout = pluginSplitLayout();
    layout.focusedPaneId = "pane-2";
    renderSplitArea({
      path: "/plugins/docs/docs",
      layout,
      routeAwareContent: true,
    });

    await screen.findByTestId("hosted-plugin-app-panel");
    fireEvent.click(screen.getByRole("button", { name: "Show right panel" }));
    await within(screen.getByTestId("hosted-plugin-app-panel")).findByRole(
      "button",
      { name: "Hide right panel" },
    );

    fireEvent.pointerDown(screen.getByTestId("pane-thr-a"));
    expect(await screen.findByTestId("hosted-panel-thr-a")).toBeTruthy();
    await waitFor(() =>
      expect(screen.queryByTestId("hosted-plugin-app-panel")).toBeNull(),
    );
    expect(
      screen.getByRole("button", { name: "Hide right panel" }),
    ).toBeTruthy();
  });

  it("drops the corner reserve while the hosted plugin panel holds the toggle", async () => {
    const layout = pluginSplitLayout();
    layout.focusedPaneId = "pane-2";
    renderSplitArea({
      path: "/plugins/docs/docs",
      layout,
      routeAwareContent: true,
    });

    await screen.findByTestId("hosted-plugin-app-panel");
    const close = screen.getByRole("button", { name: "Close pane" });
    expect(close.nextElementSibling?.tagName).toBe("SPAN");

    fireEvent.click(screen.getByRole("button", { name: "Show right panel" }));
    await waitFor(() =>
      expect(
        screen.getByRole("button", { name: "Close pane" }).nextElementSibling,
      ).toBeNull(),
    );
    expect(
      screen.getByTestId("split-workspace-panel-toggle").classList,
    ).toContain("hidden");
    expect(
      within(screen.getByTestId("hosted-plugin-app-panel")).getByRole(
        "button",
        { name: "Hide right panel" },
      ),
    ).toBeTruthy();
  });

  it("preserves plugin-owned right panels with and without a plugin split", async () => {
    setPluginSlotRegistrations(
      "test-plugin",
      makePluginRegistrationSet({
        navPanels: [
          {
            id: "automations",
            title: "Automations",
            icon: "Clock",
            path: "automations",
            component: () => <div>Automations content</div>,
          },
        ],
        threadPanelActions: [],
        pendingInteractions: [],
        sidebarFooterActions: [],
        fileOpeners: [],
      }),
    );
    setPluginSlotRegistrations(
      "docs",
      makePluginRegistrationSet({
        navPanels: [
          {
            id: "docs",
            title: "Docs",
            icon: "FileText",
            path: "docs",
            component: () => <div>Docs content with notes sidebar</div>,
            headerContent: () => (
              <button type="button">Collapse notes sidebar</button>
            ),
          },
        ],
        threadPanelActions: [],
        pendingInteractions: [],
        sidebarFooterActions: [],
        fileOpeners: [],
      }),
    );

    renderSplitArea({
      path: "/plugins/docs/docs",
      layout: twoPluginSplitLayout(),
      routeContent: docsContent,
    });

    expect(await screen.findByText("Automations content")).toBeTruthy();
    const docsPanelContent = screen.getByText(
      "Docs content with notes sidebar",
    );
    expect(docsPanelContent).toBeTruthy();
    expect(
      screen
        .getAllByTestId("plugin-browser-host")
        .every((host) => host.dataset.flushPageInsets === "false"),
    ).toBe(true);
    expect(docsPanelContent.closest(".isolate")).not.toBeNull();
    expect(
      screen.getByRole("button", { name: "Collapse notes sidebar" }),
    ).toBeTruthy();
    expect(screen.getByTestId("split-workspace-panel-toggle")).toBeTruthy();
    expect(
      screen.getAllByRole("button", { name: /Maximize pane/ }),
    ).toHaveLength(2);

    fireEvent.click(screen.getAllByRole("button", { name: "Close pane" })[0]!);

    await waitFor(() =>
      expect(screen.queryByText("Automations content")).toBeNull(),
    );
    expect(
      screen.getByText("Docs content with notes sidebar").closest(".isolate"),
    ).toBeNull();
    expect(
      screen.getByRole("button", { name: "Collapse notes sidebar" }),
    ).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Close pane" })).toBeNull();
    expect(screen.queryByTestId("split-workspace-panel-toggle")).toBeNull();
    const remainingHost = screen.getByTestId("plugin-browser-host");
    expect(remainingHost.dataset.flushPageInsets).toBe("true");
  });

  it("mounts both panes with independent, threadId-keyed drafts", async () => {
    renderSplitArea({
      path: threadPath("thr-b"),
      layout: twoPaneLayout("pane-2"),
    });

    expect(await screen.findByTestId("pane-thr-a")).toBeTruthy();
    expect(screen.getByTestId("pane-thr-b")).toBeTruthy();

    fireEvent.change(screen.getByTestId("draft-thr-a"), {
      target: { value: "note for A" },
    });

    expect(
      (screen.getByTestId("draft-thr-a") as HTMLTextAreaElement).value,
    ).toBe("note for A");
    expect(
      (screen.getByTestId("draft-thr-b") as HTMLTextAreaElement).value,
    ).toBe("");
  });

  it("replaces the focused pane's content on external navigation without dismantling the layout", async () => {
    renderSplitArea({
      path: threadPath("thr-b"),
      layout: twoPaneLayout("pane-2"),
      externalTo: threadPath("thr-c"),
    });
    await screen.findByTestId("pane-thr-b");

    expect(
      screen
        .getAllByTestId(/^pane-thr-/)
        .filter(
          (pane) => pane.getAttribute("data-window-top-left-owner") === "true",
        ),
    ).toEqual([screen.getByTestId("pane-thr-a")]);

    fireEvent.click(screen.getByTestId("external-nav"));

    expect(await screen.findByTestId("pane-thr-c")).toBeTruthy();
    expect(screen.getByTestId("pane-thr-a")).toBeTruthy();
    expect(screen.queryByTestId("pane-thr-b")).toBeNull();
    expect(
      screen
        .getAllByTestId(/^pane-thr-/)
        .filter(
          (pane) => pane.getAttribute("data-window-top-left-owner") === "true",
        ),
    ).toEqual([screen.getByTestId("pane-thr-a")]);
  });

  it("focuses an already-open pane instead of duplicating on external navigation", async () => {
    renderSplitArea({
      path: threadPath("thr-b"),
      layout: twoPaneLayout("pane-2"),
      externalTo: threadPath("thr-a"),
    });
    await screen.findByTestId("pane-thr-b");

    fireEvent.click(screen.getByTestId("external-nav"));

    await waitFor(() => {
      expect(screen.getByTestId("pane-thr-a").dataset.focused).toBe("true");
    });
    expect(screen.getByTestId("pane-thr-b").dataset.focused).toBe("false");
    expect(screen.queryAllByTestId(/^pane-/)).toHaveLength(2);
  });

  it("restores a persisted layout on load", async () => {
    renderSplitArea({
      path: threadPath("thr-a"),
      layout: twoPaneLayout("pane-1"),
    });

    expect(await screen.findByTestId("pane-thr-a")).toBeTruthy();
    expect(screen.getByTestId("pane-thr-b")).toBeTruthy();
  });

  it("restores eight successive default-right opens, then focuses and closes with valid URL state", async () => {
    const layout = eightPaneThreadLayout();
    expect(layout.root).toMatchObject({
      type: "split",
      dir: "row",
      sizes: Array.from({ length: 8 }, () => 1 / 8),
    });
    window.localStorage.setItem(
      SPLIT_LAYOUT_STORAGE_KEY,
      serializeSplitLayout(layout),
    );

    const store = renderSplitArea({ path: threadPath("thr-h") });

    for (const suffix of ["a", "b", "c", "d", "e", "f", "g", "h"]) {
      expect(await screen.findByTestId(`pane-thr-${suffix}`)).toBeTruthy();
    }
    expect(document.querySelectorAll("[data-split-pane-id]")).toHaveLength(8);
    expect(screen.getByTestId("pane-thr-h").dataset.focused).toBe("true");

    fireEvent.pointerDown(screen.getByTestId("pane-thr-f"));
    await waitFor(() => {
      expect(screen.getByTestId("pane-thr-f").dataset.focused).toBe("true");
      expect(screen.getByTestId("location").textContent).toBe(
        threadPath("thr-f"),
      );
    });

    fireEvent.click(screen.getByTestId("close-thr-f"));
    await waitFor(() => {
      expect(screen.queryByTestId("pane-thr-f")).toBeNull();
      expect(screen.getByTestId("location").textContent).toBe(
        threadPath("thr-g"),
      );
    });
    expect(store.get(splitLayoutAtom)?.focusedPaneId).toBe("pane-7");
    expect(document.querySelectorAll("[data-split-pane-id]")).toHaveLength(7);
  });

  it("carves a plugin pane drag handle out of the macOS window-drag region", async () => {
    const desktopInfo: BbDesktopInfo = {
      lastCheckedAt: null,
      latestVersion: null,
      pendingVersion: null,
      platform: "macos",
      updateAvailable: false,
      updateDownloaded: false,
      version: "0.0.0-test",
    };
    window.bbDesktop = createBbDesktopApi(desktopInfo);
    setPluginSlotRegistrations(
      "docs",
      makePluginRegistrationSet({
        navPanels: [
          {
            id: "docs",
            title: "Docs",
            icon: "FileText",
            path: "docs",
            component: () => <div>Docs panel</div>,
          },
        ],
        threadPanelActions: [],
        pendingInteractions: [],
        sidebarFooterActions: [],
        fileOpeners: [],
      }),
    );

    renderSplitArea({
      path: "/plugins/docs/docs",
      layout: pluginSplitLayout(),
      routeContent: docsContent,
    });

    const title = await screen.findByText("Docs");
    const dragHandle = title.parentElement?.parentElement;
    expect(dragHandle?.className).toContain("[app-region:no-drag]");
    expect(dragHandle?.className).toContain("[-webkit-app-region:no-drag]");
  });

  it("makes only top-row split headers desktop window-drag regions", async () => {
    const desktopInfo: BbDesktopInfo = {
      lastCheckedAt: null,
      latestVersion: null,
      pendingVersion: null,
      platform: "macos",
      updateAvailable: false,
      updateDownloaded: false,
      version: "0.0.0-test",
    };
    window.bbDesktop = createBbDesktopApi(desktopInfo);
    setPluginSlotRegistrations(
      "test-plugin",
      makePluginRegistrationSet({
        navPanels: ["top-left", "bottom-left", "top-right", "bottom-right"].map(
          (path) => ({
            id: path,
            title: path,
            icon: "FileText",
            path,
            component: () => <div>{path} panel</div>,
          }),
        ),
        threadPanelActions: [],
        pendingInteractions: [],
        sidebarFooterActions: [],
        fileOpeners: [],
      }),
    );

    renderSplitArea({
      path: "/plugins/test-plugin/bottom-right",
      layout: fourPanePluginLayout(),
      routeContent: pluginContent("bottom-right"),
    });

    for (const path of ["top-left", "top-right"]) {
      const header = (await screen.findByText(path)).closest("header");
      expect(header?.className).toContain("[app-region:drag]");
      expect(header?.className).toContain("[-webkit-app-region:drag]");
    }
    for (const path of ["bottom-left", "bottom-right"]) {
      const header = (await screen.findByText(path)).closest("header");
      expect(header?.className).not.toContain("[app-region:drag]");
      expect(header?.className).not.toContain("[-webkit-app-region:drag]");
    }
  });

  it("reserves collapsed window-left chrome only for the structural top-left plugin pane", async () => {
    const desktopInfo: BbDesktopInfo = {
      lastCheckedAt: null,
      latestVersion: null,
      pendingVersion: null,
      platform: "macos",
      updateAvailable: false,
      updateDownloaded: false,
      version: "0.0.0-test",
    };
    window.bbDesktop = createBbDesktopApi(desktopInfo);
    sidebarState.showing = false;
    setPluginSlotRegistrations(
      "test-plugin",
      makePluginRegistrationSet({
        navPanels: ["top-left", "bottom-left", "top-right", "bottom-right"].map(
          (path) => ({
            id: path,
            title: path,
            icon: "FileText",
            path,
            component: () => <div>{path} panel</div>,
          }),
        ),
        threadPanelActions: [],
        pendingInteractions: [],
        sidebarFooterActions: [],
        fileOpeners: [],
      }),
    );

    renderSplitArea({
      path: "/plugins/test-plugin/bottom-right",
      layout: fourPanePluginLayout(),
      routeContent: pluginContent("bottom-right"),
    });

    const contentRow = async (path: string) =>
      (await screen.findByText(path))
        .closest("header")
        ?.querySelector('[data-testid="app-page-header-content-row"]');
    expect((await contentRow("top-left"))?.className).toContain("pl-[104px]");
    for (const path of ["top-right", "bottom-left", "bottom-right"]) {
      expect((await contentRow(path))?.className).not.toContain("pl-[104px]");
    }

    expect(screen.getAllByRole("button", { name: /Full Screen/ })).toHaveLength(
      4,
    );
  });

  it("assigns exactly one top-left owner through eight-pane structural changes", async () => {
    for (const threadId of [
      "thr-c",
      "thr-d",
      "thr-e",
      "thr-f",
      "thr-g",
      "thr-h",
    ]) {
      threadStore.set(threadId, { archivedAt: null, deletedAt: null });
    }
    const initialLayout = eightPaneThreadLayout();
    const store = renderSplitArea({
      path: threadPath("thr-h"),
      layout: initialLayout,
    });
    await screen.findByTestId("pane-thr-h");

    const owners = () =>
      screen
        .getAllByTestId(/^pane-thr-/)
        .filter(
          (pane) => pane.getAttribute("data-window-top-left-owner") === "true",
        );
    expect(owners()).toHaveLength(1);
    expect(owners()[0]?.getAttribute("data-testid")).toBe("pane-thr-a");

    const moved = movePane(initialLayout, "pane-8", "pane-1", "left");
    store.set(splitLayoutAtom, moved);
    await waitFor(() => expect(owners()).toHaveLength(1));
    expect(owners()[0]?.getAttribute("data-testid")).toBe("pane-thr-h");

    fireEvent.click(screen.getByTestId("close-thr-h"));
    await waitFor(() => expect(screen.queryByTestId("pane-thr-h")).toBeNull());
    expect(owners()).toHaveLength(1);
    expect(owners()[0]?.getAttribute("data-testid")).toBe("pane-thr-a");
  });

  it("places plugin header actions before the pane close button", async () => {
    setPluginSlotRegistrations(
      "docs",
      makePluginRegistrationSet({
        navPanels: [
          {
            id: "docs",
            title: "Docs",
            icon: "FileText",
            path: "docs",
            component: () => <div>Docs panel</div>,
            headerContent: () => (
              <button type="button">Toggle docs sidebar</button>
            ),
          },
        ],
        threadPanelActions: [],
        pendingInteractions: [],
        sidebarFooterActions: [],
        fileOpeners: [],
      }),
    );

    renderSplitArea({
      path: "/plugins/docs/docs",
      layout: pluginSplitLayout(),
      routeContent: docsContent,
    });

    const toggle = await screen.findByRole("button", {
      name: "Toggle docs sidebar",
    });
    const close = screen.getByRole("button", { name: "Close pane" });
    const closeIcon = close.querySelector('[data-icon="ClosePluginPane"]');
    expect(closeIcon).not.toBeNull();
    expect(closeIcon?.querySelectorAll("path")).toHaveLength(1);
    expect(closeIcon?.querySelector("path")?.getAttribute("d")).toContain(
      "M18 6L6.00081 17.9992",
    );
    expect(
      toggle.compareDocumentPosition(close) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).not.toBe(0);
  });

  it("reserves the window toggle corner for a plugin pane at the top right", async () => {
    setPluginSlotRegistrations(
      "docs",
      makePluginRegistrationSet({
        navPanels: [
          {
            id: "docs",
            title: "Docs",
            icon: "FileText",
            path: "docs",
            component: () => <div>Docs panel</div>,
          },
        ],
        threadPanelActions: [],
        pendingInteractions: [],
        sidebarFooterActions: [],
        fileOpeners: [],
      }),
    );

    renderSplitArea({
      path: "/",
      layout: {
        root: {
          type: "split",
          dir: "col",
          sizes: [0.5, 0.5],
          children: [
            { type: "pane", paneId: "pane-docs", content: docsContent },
            { type: "pane", paneId: "pane-new", content: newThreadContent },
          ],
        },
        focusedPaneId: "pane-new",
      },
      routeContent: newThreadContent,
    });

    await screen.findByText("Docs panel");
    expect(screen.getByTestId("split-workspace-panel-toggle")).toBeTruthy();
    const [pluginClose] = screen.getAllByRole("button", { name: "Close pane" });
    const reserve = pluginClose?.nextElementSibling;
    expect(reserve?.tagName).toBe("SPAN");
    expect(reserve?.getAttribute("aria-hidden")).toBe("true");

    fireEvent.click(
      screen.getAllByRole("button", { name: /Maximize pane/ })[0]!,
    );
    await waitFor(() =>
      expect(
        screen.getAllByRole("button", { name: "Close pane" })[0]
          ?.nextElementSibling,
      ).toBeNull(),
    );
  });

  it("drops the corner reserve once an open panel hosts the toggle", async () => {
    const layout = pluginSplitLayout();
    layout.focusedPaneId = "pane-1";
    renderSplitArea({
      path: threadPath("thr-a"),
      layout,
      routeAwareContent: true,
    });

    const pluginClose = await screen.findByRole("button", {
      name: "Close pane",
    });
    expect(pluginClose.nextElementSibling).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "Hide right panel" }));
    await waitFor(() =>
      expect(
        screen.getByRole("button", { name: "Close pane" }).nextElementSibling
          ?.tagName,
      ).toBe("SPAN"),
    );
  });

  it("uses automation breadcrumbs in the split-owned plugin header", async () => {
    setPluginSlotRegistrations(
      "automations",
      makePluginRegistrationSet({
        navPanels: [
          {
            id: "automations",
            title: "Automations",
            icon: "Clock",
            path: "automations",
            component: () => <div>Automation detail</div>,
          },
        ],
        threadPanelActions: [],
        pendingInteractions: [],
        sidebarFooterActions: [],
        fileOpeners: [],
      }),
    );
    const content: PaneContent = {
      kind: "plugin-panel",
      pluginId: "automations",
      panelPath: "automations",
      subPath: "proj_personal/weekly-review",
    };
    const store = renderSplitArea({
      path: "/plugins/automations/automations/proj_personal/weekly-review",
      layout: {
        root: { type: "pane", paneId: "pane-automation", content },
        focusedPaneId: "pane-automation",
      },
      routeContent: content,
    });

    const breadcrumb = await screen.findByRole("navigation", {
      name: "Breadcrumb",
    });
    expect(breadcrumb.textContent).toContain("Automations");
    expect(breadcrumb.textContent).toContain("Installed");
    expect(breadcrumb.textContent).toContain("weekly-review");

    store.set(resourceRouteLabelAtom, "Weekly review");
    await waitFor(() =>
      expect(breadcrumb.textContent).toContain("Weekly review"),
    );

    fireEvent.click(screen.getByRole("link", { name: "Installed" }));
    expect(screen.getByTestId("location").textContent).toBe(
      "/plugins/automations/automations",
    );
  });

  it("ignores a layout written by another tab (issue #873)", async () => {
    renderSplitArea({ path: threadPath("thr-a") });
    expect(await screen.findByTestId("pane-thr-a")).toBeTruthy();

    const otherTabLayout = serializeSplitLayout({
      root: { type: "pane", paneId: "pane-1", content: threadContent("thr-b") },
      focusedPaneId: "pane-1",
    });
    window.localStorage.setItem(SPLIT_LAYOUT_STORAGE_KEY, otherTabLayout);
    fireEvent(
      window,
      new StorageEvent("storage", {
        key: SPLIT_LAYOUT_STORAGE_KEY,
        newValue: otherTabLayout,
        storageArea: window.localStorage,
      }),
    );

    await waitFor(() => {
      expect(screen.getByTestId("location").textContent).toBe(
        threadPath("thr-a"),
      );
    });
    expect(screen.queryAllByTestId(/^pane-/)).toHaveLength(1);
    expect(screen.getByTestId("pane-thr-a")).toBeTruthy();
    expect(screen.queryByTestId("pane-thr-b")).toBeNull();
  });

  it("falls back to a single pane from the route when persisted state is malformed", async () => {
    window.localStorage.setItem(SPLIT_LAYOUT_STORAGE_KEY, "not json");
    renderSplitArea({ path: threadPath("thr-a") });

    expect(await screen.findByTestId("pane-thr-a")).toBeTruthy();
    expect(screen.queryAllByTestId(/^pane-/)).toHaveLength(1);
    expect(screen.queryByTestId("close-thr-a")).toBeNull();
  });

  it("moves the URL to the surviving pane when the focused pane is closed", async () => {
    renderSplitArea({
      path: threadPath("thr-b"),
      layout: twoPaneLayout("pane-2"),
    });
    await screen.findByTestId("pane-thr-b");

    fireEvent.click(screen.getByTestId("close-thr-b"));

    await waitFor(() => {
      expect(screen.getByTestId("location").textContent).toBe(
        threadPath("thr-a"),
      );
    });
    expect(screen.getByTestId("pane-thr-a")).toBeTruthy();
    expect(screen.queryByTestId("pane-thr-b")).toBeNull();
  });

  it("prunes a stale (archived) pane from a restored split", async () => {
    threadStore.set("thr-b", { archivedAt: 123, deletedAt: null });
    renderSplitArea({
      path: threadPath("thr-a"),
      layout: twoPaneLayout("pane-1"),
    });

    await waitFor(() => {
      expect(screen.queryByTestId("pane-thr-b")).toBeNull();
    });
    expect(screen.getByTestId("pane-thr-a")).toBeTruthy();
    expect(screen.getByTestId("location").textContent).toBe(
      threadPath("thr-a"),
    );
  });

  it("prunes a stale focused pane and moves focus + URL to the survivor", async () => {
    threadStore.set("thr-b", { archivedAt: null, deletedAt: 456 });
    renderSplitArea({
      path: threadPath("thr-b"),
      layout: twoPaneLayout("pane-2"),
    });

    await waitFor(() => {
      expect(screen.queryByTestId("pane-thr-b")).toBeNull();
    });
    expect(screen.getByTestId("pane-thr-a")).toBeTruthy();
    await waitFor(() => {
      expect(screen.getByTestId("location").textContent).toBe(
        threadPath("thr-a"),
      );
    });
  });
});
