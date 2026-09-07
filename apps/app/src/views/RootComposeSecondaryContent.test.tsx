// @vitest-environment jsdom

import type { ComponentProps, ReactNode } from "react";
import { act, cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CompactViewportOverrideProvider } from "@bb/shared-ui/hooks/use-compact-viewport";
import {
  PaneContext,
  type PaneContextValue,
} from "./thread-detail/PaneContext";
import {
  ROOT_COMPOSE_PINNED_PANEL_TOGGLE_POSITION_CLASS,
  RootComposeSecondaryContent,
} from "./RootComposeSecondaryContent";

type RootComposeSecondaryContentProps = ComponentProps<
  typeof RootComposeSecondaryContent
>;

interface PanelGroupHandle {
  getLayout: () => number[];
  setLayout: (layout: number[]) => void;
}

interface PanelGroupProps {
  children?: ReactNode;
}

interface PanelProps {
  children?: ReactNode;
}

interface RenderRootComposeArgs {
  isCompactViewport: boolean;
  isSecondaryPanelOpen: boolean;
  isTopRow?: boolean;
}

type TestDesktopWindow = {
  bbDesktop?: { platform: "macos" };
};

const panelGroupState = vi.hoisted(() => ({
  getLayout: vi.fn(() => [60, 40]),
  setLayout: vi.fn(),
}));

const noop = () => {};

function setMacosDesktopChrome(): void {
  (window as unknown as TestDesktopWindow).bbDesktop = { platform: "macos" };
}

function clearDesktopChrome(): void {
  delete (window as unknown as TestDesktopWindow).bbDesktop;
}

vi.mock("jotai", async (importOriginal) => ({
  ...(await importOriginal<typeof import("jotai")>()),
  useAtomValue: () => 40,
}));

vi.mock("react-resizable-panels", async () => {
  const React = await import("react");

  const PanelGroup = React.forwardRef<PanelGroupHandle, PanelGroupProps>(
    ({ children }, ref) => {
      React.useImperativeHandle(
        ref,
        () => ({
          getLayout: panelGroupState.getLayout,
          setLayout: panelGroupState.setLayout,
        }),
        [],
      );
      return React.createElement(
        "div",
        { "data-testid": "panel-group" },
        children,
      );
    },
  );
  PanelGroup.displayName = "MockPanelGroup";

  const Panel = ({ children }: PanelProps) =>
    React.createElement("div", { "data-testid": "panel" }, children);

  return { Panel, PanelGroup };
});

vi.mock("@bb/shared-ui/responsive-overlay", async (importOriginal) => {
  const React = await import("react");
  const actual =
    await importOriginal<typeof import("@bb/shared-ui/responsive-overlay")>();

  const PersistentResponsiveDrawerShell = ({
    children,
    open,
  }: {
    children?: ReactNode;
    open: boolean;
  }) =>
    React.createElement(
      "div",
      {
        "data-open": String(open),
        "data-testid": "responsive-drawer-shell",
      },
      children,
    );

  return { ...actual, PersistentResponsiveDrawerShell };
});

vi.mock("@/components/secondary-panel/ThreadSecondaryPanel", async () => {
  const React = await import("react");

  const ThreadSecondaryPanel = ({
    browserDeck,
    isOpen,
    renderAsDrawer,
    showNewTabButton,
  }: {
    browserDeck?: ReactNode;
    isOpen: boolean;
    renderAsDrawer: boolean;
    showNewTabButton?: boolean;
  }) =>
    React.createElement(
      "section",
      {
        "data-open": String(isOpen),
        "data-show-new-tab-button": String(showNewTabButton),
        "data-testid": renderAsDrawer
          ? "drawer-secondary-panel"
          : "inline-secondary-panel",
      },
      browserDeck,
    );

  return { ThreadSecondaryPanel };
});

vi.mock("@/components/plugin/PluginHomepageSections", async () => {
  const React = await import("react");
  return {
    PluginHomepageSections: () =>
      React.createElement("div", { "data-testid": "plugin-homepage-sections" }),
  };
});

function createSecondaryPanel(
  isOpen: boolean,
): RootComposeSecondaryContentProps["secondaryPanel"] {
  return {
    activeTab: null,
    canUseGitUi: false,
    tabs: [],
    fixedTabs: [],
    isOpen,
    metadataContent: null,
    onCollapse: noop,
    onClose: noop,
    onTabReorder: noop,
    onOpenNewTab: noop,
    onPanelFocus: noop,
  };
}

function withPaneContext(
  children: ReactNode,
  isTopRow: boolean | undefined,
): ReactNode {
  if (isTopRow === undefined) return children;
  const value: PaneContextValue = {
    paneId: "pane-test",
    isFocused: true,
    isSplitPane: true,
    secondaryPanelHost: null,
    reservesWindowPanelToggle: false,
    onRequestClose: noop,
    isMaximized: false,
    onToggleMaximize: noop,
    isBoundedPane: true,
    isTopRow,
    ownsWindowTopLeft: isTopRow,
    navigateInPane: noop,
  };
  return <PaneContext.Provider value={value}>{children}</PaneContext.Provider>;
}

function renderRootCompose(args: RenderRootComposeArgs) {
  let renderArgs = args;
  const content = (
    <CompactViewportOverrideProvider
      isCompactViewport={renderArgs.isCompactViewport}
    >
      <RootComposeSecondaryContent
        compactScrollContent={null}
        isSecondaryPanelOpen={renderArgs.isSecondaryPanelOpen}
        onToggleSecondaryPanel={() => undefined}
        secondaryPanel={createSecondaryPanel(renderArgs.isSecondaryPanelOpen)}
      >
        <div data-testid="root-compose-content" />
      </RootComposeSecondaryContent>
    </CompactViewportOverrideProvider>
  );
  const view = render(withPaneContext(content, renderArgs.isTopRow));

  return {
    ...view,
    rerenderWith(nextArgs: Partial<RenderRootComposeArgs>) {
      renderArgs = { ...renderArgs, ...nextArgs };
      const nextContent = (
        <CompactViewportOverrideProvider
          isCompactViewport={renderArgs.isCompactViewport}
        >
          <RootComposeSecondaryContent
            compactScrollContent={null}
            isSecondaryPanelOpen={renderArgs.isSecondaryPanelOpen}
            onToggleSecondaryPanel={() => undefined}
            secondaryPanel={createSecondaryPanel(
              renderArgs.isSecondaryPanelOpen,
            )}
          >
            <div data-testid="root-compose-content" />
          </RootComposeSecondaryContent>
        </CompactViewportOverrideProvider>
      );
      view.rerender(withPaneContext(nextContent, renderArgs.isTopRow));
    },
  };
}

afterEach(() => {
  cleanup();
  clearDesktopChrome();
  panelGroupState.setLayout.mockReset();
});

describe("RootComposeSecondaryContent desktop layout", () => {
  it("always offers a new tab from the new-thread right panel", async () => {
    renderRootCompose({
      isCompactViewport: false,
      isSecondaryPanelOpen: true,
    });

    expect(
      (await screen.findByTestId("inline-secondary-panel")).getAttribute(
        "data-show-new-tab-button",
      ),
    ).toBe("true");
    expect(screen.getByTestId("root-compose-content")).not.toBeNull();
    expect(screen.getByTestId("plugin-homepage-sections")).not.toBeNull();
  });

  it("keeps the drag strip on a split pane that touches the window top edge", () => {
    setMacosDesktopChrome();

    renderRootCompose({
      isCompactViewport: false,
      isSecondaryPanelOpen: false,
      isTopRow: true,
    });

    expect(
      screen.getByTestId("root-compose-main-window-drag-strip"),
    ).toBeTruthy();
  });

  it("does not create a native pointer dead zone in a lower split pane", () => {
    setMacosDesktopChrome();

    renderRootCompose({
      isCompactViewport: false,
      isSecondaryPanelOpen: false,
      isTopRow: false,
    });

    expect(
      screen.queryByTestId("root-compose-main-window-drag-strip"),
    ).toBeNull();
  });

  it("carves the pinned toggle footprint out of the drag strip while the panel is closed", () => {
    setMacosDesktopChrome();

    renderRootCompose({
      isCompactViewport: false,
      isSecondaryPanelOpen: false,
    });

    const strip = screen.getByTestId("root-compose-main-window-drag-strip");
    const cutout = screen.getByTestId("root-compose-drag-strip-toggle-cutout");
    expect(cutout.parentElement).toBe(strip);
    expect(cutout.className).toContain("[app-region:no-drag]");
    expect(cutout.className).toContain("[-webkit-app-region:no-drag]");
    for (const positionClass of ROOT_COMPOSE_PINNED_PANEL_TOGGLE_POSITION_CLASS.split(
      " ",
    )) {
      expect(cutout.className).toContain(positionClass);
    }
  });

  it("keeps the drag strip whole while the panel is open (the panel chrome carves instead)", () => {
    setMacosDesktopChrome();

    renderRootCompose({
      isCompactViewport: false,
      isSecondaryPanelOpen: true,
    });

    expect(
      screen.getByTestId("root-compose-main-window-drag-strip"),
    ).toBeTruthy();
    expect(
      screen.queryByTestId("root-compose-drag-strip-toggle-cutout"),
    ).toBeNull();
  });

  it("forwards root panel open and close state to the shared desktop layout", () => {
    const view = renderRootCompose({
      isCompactViewport: false,
      isSecondaryPanelOpen: false,
    });

    expect(panelGroupState.setLayout).toHaveBeenCalledTimes(1);
    expect(panelGroupState.setLayout).toHaveBeenLastCalledWith([100, 0]);
    panelGroupState.setLayout.mockClear();

    view.rerenderWith({ isSecondaryPanelOpen: true });
    expect(panelGroupState.setLayout).toHaveBeenCalledTimes(1);
    expect(panelGroupState.setLayout).toHaveBeenLastCalledWith([60, 40]);

    panelGroupState.setLayout.mockClear();
    view.rerenderWith({ isSecondaryPanelOpen: false });
    expect(panelGroupState.setLayout).toHaveBeenCalledTimes(1);
    expect(panelGroupState.setLayout).toHaveBeenLastCalledWith([100, 0]);
  });

  it("shows the root fallback before realizing compact drawer content", () => {
    vi.useFakeTimers();
    try {
      renderRootCompose({
        isCompactViewport: true,
        isSecondaryPanelOpen: true,
      });

      expect(panelGroupState.setLayout).not.toHaveBeenCalled();
      expect(screen.queryByTestId("drawer-secondary-panel")).toBeNull();
      expect(
        screen.getByTestId("drawer-panel-loading-skeleton"),
      ).not.toBeNull();

      act(() => {
        vi.advanceTimersByTime(120);
      });

      expect(screen.getByTestId("drawer-secondary-panel")).not.toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });
});
