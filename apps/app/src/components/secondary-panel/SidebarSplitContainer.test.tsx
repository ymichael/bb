// @vitest-environment jsdom

import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { TooltipProvider } from "@bb/shared-ui/tooltip";
import { useState, type ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SidebarProvider } from "@/components/ui/sidebar";
import {
  SidebarSplitContainer,
  type SidebarSplitPaneRenderArgs,
  type SidebarSplitTabDescriptor,
} from "./SidebarSplitContainer";
import {
  createSidebarSplitState,
  focusSidebarPane,
  moveSidebarTab,
  parseSidebarSplitState,
  serializeSidebarSplitState,
  sidebarSplitStorageKey,
  type SidebarSplitState,
} from "./sidebarSplitLayout";
import { getFixedPanelTabsStateStorageKey } from "@/lib/fixed-panel-tabs-state";

const TABS: readonly SidebarSplitTabDescriptor[] = [
  { id: "tab-a", label: "A" },
  { id: "tab-b", label: "B" },
];
const PANEL_STATE_ID = "sidebar-split-container-test";
let nextPaneInstance = 0;

function listPaneIds(): string[] {
  return Array.from(
    document.querySelectorAll<HTMLElement>("[data-split-pane-id]"),
    (pane) => pane.dataset.splitPaneId,
  ).filter((paneId): paneId is string => paneId !== undefined);
}

function createTwoPaneState(): SidebarSplitState {
  const initial = createSidebarSplitState(
    TABS.map((tab) => tab.id),
    "tab-a",
  );
  return moveSidebarTab(
    initial,
    initial.layout.focusedPaneId,
    "tab-b",
    { paneId: initial.layout.focusedPaneId, zone: "right" },
    { groupId: "group-b" },
  );
}

function createStackedPaneState(): SidebarSplitState {
  const initial = createSidebarSplitState(
    TABS.map((tab) => tab.id),
    "tab-a",
  );
  return moveSidebarTab(
    initial,
    initial.layout.focusedPaneId,
    "tab-b",
    { paneId: initial.layout.focusedPaneId, zone: "bottom" },
    { groupId: "group-b" },
  );
}

function persistState(state: SidebarSplitState): void {
  window.localStorage.setItem(
    sidebarSplitStorageKey(PANEL_STATE_ID),
    serializeSidebarSplitState(state),
  );
}

function renderContainer({
  activeTabId = "tab-a",
  isFullScreen = false,
  onActivateTab = vi.fn(),
  onToggleFullScreen = vi.fn(),
  renderPane,
  tabs = TABS,
}: {
  activeTabId?: string;
  isFullScreen?: boolean;
  onActivateTab?: (tabId: string) => void;
  onToggleFullScreen?: () => void;
  renderPane: (args: SidebarSplitPaneRenderArgs) => ReactNode;
  tabs?: readonly SidebarSplitTabDescriptor[];
}) {
  return render(
    <SidebarProvider>
      <TooltipProvider>
        <SidebarSplitContainer
          activeTabId={activeTabId}
          isFullScreen={isFullScreen}
          onActivateTab={onActivateTab}
          onGlobalTabReorder={vi.fn()}
          onToggleFullScreen={onToggleFullScreen}
          panelStateId={PANEL_STATE_ID}
          renderPane={renderPane}
          tabs={tabs}
        />
      </TooltipProvider>
    </SidebarProvider>,
  );
}

function StatefulPane({
  onMoveActiveTabToSide,
  paneId,
}: {
  onMoveActiveTabToSide: NonNullable<
    SidebarSplitPaneRenderArgs["onMoveActiveTabToSide"]
  >;
  paneId: string;
}) {
  const [instanceId] = useState(() => `${paneId}-${nextPaneInstance++}`);
  return (
    <div data-testid={`pane-content-${paneId}`}>
      <span data-testid={`pane-instance-${paneId}`}>{instanceId}</span>
      <button type="button" onClick={() => onMoveActiveTabToSide("left")}>
        Move {paneId} left
      </button>
    </div>
  );
}

function MultiTabStatefulPane({
  activeTabId,
  canMove,
  onMove,
  paneId,
  side,
}: {
  activeTabId: string;
  canMove: boolean;
  onMove: () => void;
  paneId: string;
  side: "left" | "right" | "top" | "bottom";
}) {
  const [instance] = useState(() => `${paneId}-${nextPaneInstance++}`);
  return (
    <div>
      <span data-testid={`multi-instance-${paneId}`}>{instance}</span>
      {canMove ? (
        <button type="button" onClick={onMove}>
          Move {activeTabId} {side}
        </button>
      ) : null}
    </div>
  );
}

describe("SidebarSplitContainer", () => {
  beforeEach(() => {
    window.localStorage.clear();
    nextPaneInstance = 0;
  });

  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
    document.body.style.cursor = "";
    document.body.style.userSelect = "";
  });

  it("activates a pane before a descendant stops pointer propagation", async () => {
    const split = createTwoPaneState();
    const firstPaneId =
      split.layout.root.type === "split"
        ? split.layout.root.children[0]?.type === "pane"
          ? split.layout.root.children[0].paneId
          : null
        : null;
    const secondPaneId =
      split.layout.root.type === "split"
        ? split.layout.root.children[1]?.type === "pane"
          ? split.layout.root.children[1].paneId
          : null
        : null;
    expect(firstPaneId).not.toBeNull();
    expect(secondPaneId).not.toBeNull();
    if (firstPaneId === null || secondPaneId === null) return;
    persistState(focusSidebarPane(split, firstPaneId));

    const activate = vi.fn();
    const consoleError = vi
      .spyOn(console, "error")
      .mockImplementation(() => {});

    function Harness() {
      const [activeTabId, setActiveTabId] = useState("tab-a");
      return (
        <SidebarSplitContainer
          activeTabId={activeTabId}
          isFullScreen={false}
          onActivateTab={(tabId) => {
            activate(tabId);
            setActiveTabId(tabId);
          }}
          onGlobalTabReorder={vi.fn()}
          onToggleFullScreen={vi.fn()}
          panelStateId={PANEL_STATE_ID}
          renderPane={({ paneId }) => (
            <button
              type="button"
              data-testid={`pane-content-${paneId}`}
              onPointerDown={(event) => event.stopPropagation()}
            >
              {paneId}
            </button>
          )}
          tabs={TABS}
        />
      );
    }

    render(
      <SidebarProvider>
        <TooltipProvider>
          <Harness />
        </TooltipProvider>
      </SidebarProvider>,
    );
    fireEvent.pointerDown(screen.getByTestId(`pane-content-${secondPaneId}`));

    await waitFor(() => expect(activate).toHaveBeenCalledWith("tab-b"));
    expect(activate).toHaveBeenCalledTimes(1);
    expect(
      consoleError.mock.calls.some((call) =>
        call.some(
          (value) =>
            typeof value === "string" &&
            value.includes("Cannot update a component while rendering"),
        ),
      ),
    ).toBe(false);
  });

  it("activates a pane when keyboard focus enters it", async () => {
    const split = createTwoPaneState();
    const paneIds =
      split.layout.root.type === "split"
        ? split.layout.root.children.flatMap((child) =>
            child.type === "pane" ? [child.paneId] : [],
          )
        : [];
    expect(paneIds).toHaveLength(2);
    const [firstPaneId, secondPaneId] = paneIds;
    if (firstPaneId === undefined || secondPaneId === undefined) return;
    persistState(focusSidebarPane(split, firstPaneId));
    const activate = vi.fn();

    renderContainer({
      activeTabId: "tab-a",
      onActivateTab: activate,
      renderPane: ({ paneId }) => (
        <button type="button" data-testid={`focus-target-${paneId}`}>
          {paneId}
        </button>
      ),
    });
    fireEvent.focus(screen.getByTestId(`focus-target-${secondPaneId}`));

    await waitFor(() => expect(activate).toHaveBeenCalledWith("tab-b"));
    expect(activate).toHaveBeenCalledTimes(1);
    expect(
      document.querySelector(
        `[data-split-pane-id="${secondPaneId}"][data-focused="true"]`,
      ),
    ).not.toBeNull();
  });

  it("assigns focus and outer controls to the appropriate panes", () => {
    const split = createTwoPaneState();
    const focusedPaneId =
      split.layout.root.type === "split" &&
      split.layout.root.children[0]?.type === "pane"
        ? split.layout.root.children[0].paneId
        : split.layout.focusedPaneId;
    persistState(focusSidebarPane(split, focusedPaneId));

    renderContainer({
      renderPane: ({ isFocused, paneId, showOuterControls }) => (
        <div data-testid={`pane-state-${paneId}`}>
          {`${isFocused}:${showOuterControls}`}
        </div>
      ),
    });

    const paneStates = screen.getAllByTestId(/pane-state-/);
    expect(paneStates.map((pane) => pane.textContent)).toContain("true:false");
    expect(paneStates.map((pane) => pane.textContent)).toContain("false:true");
  });

  it("keeps outer controls in the top pane of a stacked split", () => {
    persistState(createStackedPaneState());

    renderContainer({
      renderPane: ({ isTopRow, paneId, showOuterControls }) => (
        <div data-testid={`pane-edge-${paneId}`}>
          {`${isTopRow}:${showOuterControls}`}
        </div>
      ),
    });

    expect(
      screen.getAllByTestId(/pane-edge-/).map((pane) => pane.textContent),
    ).toEqual(["true:true", "false:false"]);
  });

  it("keeps an active New Tab replacement in the same split pane", async () => {
    persistState(createStackedPaneState());

    function Harness() {
      const [terminalOpen, setTerminalOpen] = useState(false);
      const tabs = terminalOpen
        ? [
            TABS[0] as SidebarSplitTabDescriptor,
            { id: "terminal-a", label: "Terminal" },
          ]
        : TABS;
      return (
        <>
          <button type="button" onClick={() => setTerminalOpen(true)}>
            Start terminal
          </button>
          <SidebarSplitContainer
            activeTabId={terminalOpen ? "terminal-a" : "tab-b"}
            isFullScreen={false}
            onActivateTab={vi.fn()}
            onGlobalTabReorder={vi.fn()}
            onToggleFullScreen={vi.fn()}
            panelStateId={PANEL_STATE_ID}
            renderPane={({ group, paneId }) => (
              <div data-testid={`active-tab-${paneId}`}>
                {group.activeTabId}
              </div>
            )}
            tabs={tabs}
          />
        </>
      );
    }

    render(
      <SidebarProvider>
        <TooltipProvider>
          <Harness />
        </TooltipProvider>
      </SidebarProvider>,
    );
    fireEvent.click(screen.getByRole("button", { name: "Start terminal" }));

    await waitFor(() =>
      expect(
        screen.getAllByTestId(/active-tab-/).map((tab) => tab.textContent),
      ).toEqual(["tab-a", "terminal-a"]),
    );
    expect(document.querySelectorAll("[data-split-pane-id]")).toHaveLength(2);
  });

  it.each([
    ["left", "row", "tab-a,tab-b"],
    ["right", "row", "tab-b,tab-a"],
    ["top", "col", "tab-a,tab-b"],
    ["bottom", "col", "tab-b,tab-a"],
  ] as const)(
    "moves the active tab to the supported %s position without dragging",
    (side, expectedDirection, expectedOrder) => {
      renderContainer({
        renderPane: ({ group, onMoveActiveTabToSide }) => (
          <button type="button" onClick={() => onMoveActiveTabToSide?.(side)}>
            Move active {side}
            <span data-testid="active-pane-tab">{group.activeTabId}</span>
          </button>
        ),
      });

      fireEvent.click(
        screen.getByRole("button", { name: `Move active ${side}tab-a` }),
      );

      const panes = Array.from(
        document.querySelectorAll<HTMLElement>("[data-split-pane-id]"),
      );
      expect(panes).toHaveLength(2);
      expect(
        document.querySelector<HTMLElement>("[data-sidebar-split-container]")
          ?.dataset.sidebarSplitRootDirection,
      ).toBe(expectedDirection);
      expect(
        panes
          .map(
            (pane) =>
              pane.querySelector<HTMLElement>("[data-testid='active-pane-tab']")
                ?.textContent,
          )
          .join(","),
      ).toBe(expectedOrder);
    },
  );

  it.each(["left", "right", "top", "bottom"] as const)(
    "splits the active tab from an unfocused multi-tab pane to the %s",
    (side) => {
      const tabs = [...TABS, { id: "tab-c", label: "C" }];
      const initial = createSidebarSplitState(
        tabs.map((tab) => tab.id),
        "tab-a",
      );
      const split = moveSidebarTab(
        initial,
        initial.layout.focusedPaneId,
        "tab-c",
        { paneId: initial.layout.focusedPaneId, zone: "right" },
        { groupId: "group-c" },
      );
      persistState(split);

      renderContainer({
        tabs,
        renderPane: ({ group, onMoveActiveTabToSide, paneId }) => (
          <MultiTabStatefulPane
            activeTabId={group.activeTabId}
            canMove={group.tabIds.length > 1}
            onMove={() => onMoveActiveTabToSide?.(side)}
            paneId={paneId}
            side={side}
          />
        ),
      });
      const originalPaneIds = listPaneIds();
      const instancesBefore = new Map(
        originalPaneIds.map((paneId) => [
          paneId,
          screen.getByTestId(`multi-instance-${paneId}`).textContent,
        ]),
      );

      fireEvent.click(
        screen.getByRole("button", { name: `Move tab-a ${side}` }),
      );

      expect(listPaneIds()).toHaveLength(3);
      for (const paneId of originalPaneIds) {
        expect(screen.getByTestId(`multi-instance-${paneId}`).textContent).toBe(
          instancesBefore.get(paneId),
        );
      }
    },
  );

  it.each([
    ["left", "row", "tab-a,tab-b"],
    ["right", "row", "tab-b,tab-a"],
    ["top", "col", "tab-a,tab-b"],
    ["bottom", "col", "tab-b,tab-a"],
  ] as const)(
    "moves the unfocused Info pane %s from its own control",
    (side, expectedDirection, expectedOrder) => {
      const split = createTwoPaneState();
      const infoPane =
        split.layout.root.type === "split" &&
        split.layout.root.children[0]?.type === "pane"
          ? split.layout.root.children[0]
          : null;
      const diffPane =
        split.layout.root.type === "split" &&
        split.layout.root.children[1]?.type === "pane"
          ? split.layout.root.children[1]
          : null;
      expect(infoPane).not.toBeNull();
      expect(diffPane).not.toBeNull();
      if (infoPane === null || diffPane === null) return;
      persistState(focusSidebarPane(split, diffPane.paneId));

      renderContainer({
        renderPane: ({ group, onMoveActiveTabToSide, paneId }) => (
          <div>
            <span data-testid="active-pane-tab">{group.activeTabId}</span>
            {paneId === infoPane.paneId ? (
              <button
                type="button"
                onClick={() => onMoveActiveTabToSide?.(side)}
              >
                Move Info {side}
              </button>
            ) : null}
          </div>
        ),
      });

      fireEvent.click(
        screen.getByRole("button", { name: `Move Info ${side}` }),
      );
      expect(
        document.querySelector<HTMLElement>("[data-sidebar-split-container]")
          ?.dataset.sidebarSplitRootDirection,
      ).toBe(expectedDirection);
      expect(
        screen
          .getAllByTestId("active-pane-tab")
          .map((tab) => tab.textContent)
          .join(","),
      ).toBe(expectedOrder);
    },
  );

  it("keeps stateful pane content attached to pane identity after a move", () => {
    const split = createTwoPaneState();
    persistState(split);

    renderContainer({
      renderPane: ({ onMoveActiveTabToSide, paneId }) =>
        onMoveActiveTabToSide ? (
          <StatefulPane
            onMoveActiveTabToSide={onMoveActiveTabToSide}
            paneId={paneId}
          />
        ) : null,
    });

    const paneIds = Array.from(
      document.querySelectorAll<HTMLElement>("[data-split-pane-id]"),
      (pane) => pane.dataset.splitPaneId,
    ).filter((paneId): paneId is string => paneId !== undefined);
    expect(paneIds).toHaveLength(2);
    const before = new Map(
      paneIds.map((paneId) => [
        paneId,
        screen.getByTestId(`pane-instance-${paneId}`).textContent,
      ]),
    );
    const paneToMove = paneIds[1];
    expect(paneToMove).toBeDefined();
    if (paneToMove === undefined) return;

    fireEvent.click(
      screen.getByRole("button", { name: `Move ${paneToMove} left` }),
    );

    for (const paneId of paneIds) {
      expect(screen.getByTestId(`pane-instance-${paneId}`).textContent).toBe(
        before.get(paneId) ?? "missing-instance",
      );
    }
  });

  it("maximizes one pane while preserving the mounted split for restoration", async () => {
    const split = createStackedPaneState();
    const paneIds =
      split.layout.root.type === "split"
        ? split.layout.root.children.flatMap((child) =>
            child.type === "pane" ? [child.paneId] : [],
          )
        : [];
    const paneToMaximize = paneIds[0];
    expect(paneToMaximize).toBeDefined();
    if (paneToMaximize === undefined) return;
    persistState(split);

    function Pane({
      isMaximized,
      onToggleMaximize,
      paneId,
    }: Pick<
      SidebarSplitPaneRenderArgs,
      "isMaximized" | "onToggleMaximize" | "paneId"
    >) {
      const [instance] = useState(() => `${paneId}-${nextPaneInstance++}`);
      return (
        <div>
          <span data-testid={`max-instance-${paneId}`}>{instance}</span>
          <button type="button" onClick={onToggleMaximize}>
            {isMaximized ? `Restore ${paneId}` : `Maximize ${paneId}`}
          </button>
        </div>
      );
    }

    function Harness() {
      const [isFullScreen, setIsFullScreen] = useState(false);
      return (
        <SidebarSplitContainer
          activeTabId="tab-b"
          isFullScreen={isFullScreen}
          onActivateTab={vi.fn()}
          onGlobalTabReorder={vi.fn()}
          onToggleFullScreen={() => setIsFullScreen((current) => !current)}
          panelStateId={PANEL_STATE_ID}
          renderPane={(pane) => <Pane {...pane} />}
          tabs={TABS}
        />
      );
    }

    render(
      <SidebarProvider>
        <TooltipProvider>
          <Harness />
        </TooltipProvider>
      </SidebarProvider>,
    );
    const instancesBefore = new Map(
      paneIds.map((paneId) => [
        paneId,
        screen.getByTestId(`max-instance-${paneId}`).textContent,
      ]),
    );

    fireEvent.click(
      screen.getByRole("button", { name: `Maximize ${paneToMaximize}` }),
    );

    await waitFor(() =>
      expect(
        document.querySelector(
          `[data-split-pane-id="${paneToMaximize}"][data-maximized="true"]`,
        ),
      ).not.toBeNull(),
    );
    const hiddenPaneId = paneIds.find((paneId) => paneId !== paneToMaximize);
    expect(hiddenPaneId).toBeDefined();
    if (hiddenPaneId === undefined) return;
    const hiddenPane = document.querySelector(
      `[data-split-pane-id="${hiddenPaneId}"]`,
    );
    if (!(hiddenPane instanceof HTMLElement)) {
      throw new Error("Expected the preserved hidden split pane");
    }
    expect(hiddenPane.getAttribute("aria-hidden")).toBe("true");
    expect(hiddenPane.style.contentVisibility).toBe("hidden");
    expect(hiddenPane.className).toContain("invisible");
    expect(hiddenPane.className).toContain("pointer-events-none");
    expect(document.querySelector('[role="separator"]')?.className).toContain(
      "invisible",
    );
    for (const paneId of paneIds) {
      expect(screen.getByTestId(`max-instance-${paneId}`).textContent).toBe(
        instancesBefore.get(paneId),
      );
    }

    fireEvent.click(
      screen.getByRole("button", { name: `Restore ${paneToMaximize}` }),
    );
    await waitFor(() =>
      expect(
        document.querySelector('[data-split-pane-id][data-maximized="true"]'),
      ).toBeNull(),
    );
    expect(hiddenPane.getAttribute("aria-hidden")).toBeNull();
    expect(hiddenPane.style.contentVisibility).toBe("");
    expect(screen.getByRole("separator")).not.toBeNull();
    for (const paneId of paneIds) {
      expect(screen.getByTestId(`max-instance-${paneId}`).textContent).toBe(
        instancesBefore.get(paneId),
      );
    }
  });

  it("keeps a newly created split maximized while the right panel is full screen", () => {
    const onToggleFullScreen = vi.fn();
    renderContainer({
      isFullScreen: true,
      onToggleFullScreen,
      renderPane: ({ onMoveActiveTabToSide, paneId }) => (
        <button type="button" onClick={() => onMoveActiveTabToSide?.("bottom")}>
          Split {paneId}
        </button>
      ),
    });

    fireEvent.click(screen.getByRole("button", { name: /^Split / }));

    const panes = Array.from(
      document.querySelectorAll<HTMLElement>("[data-split-pane-id]"),
    );
    expect(panes).toHaveLength(2);
    expect(
      panes.filter((pane) => pane.dataset.maximized === "true"),
    ).toHaveLength(1);
    expect(
      panes.filter((pane) => pane.getAttribute("aria-hidden") === "true"),
    ).toHaveLength(1);
    expect(onToggleFullScreen).not.toHaveBeenCalled();
  });

  it.each([
    [
      "side-by-side",
      createTwoPaneState,
      "Resize right panel panes",
      "vertical",
    ],
    [
      "stacked",
      createStackedPaneState,
      "Resize stacked right panel panes",
      "horizontal",
    ],
  ] as const)(
    "renders %s pane headers and bodies on either side of one continuous divider",
    (_layout, createState, separatorName, orientation) => {
      persistState(createState());
      renderContainer({
        renderPane: ({ group, paneId }) => (
          <div data-testid={`surface-${paneId}`}>
            <div data-testid={`header-${paneId}`}>{group.activeTabId}</div>
            <div data-testid={`body-${paneId}`}>{group.activeTabId}</div>
          </div>
        ),
      });

      const panes = Array.from(
        document.querySelectorAll<HTMLElement>("[data-split-pane-id]"),
      );
      expect(panes).toHaveLength(2);
      for (const pane of panes) {
        const paneId = pane.dataset.splitPaneId;
        expect(
          pane.querySelector(`[data-testid='header-${paneId}']`),
        ).not.toBeNull();
        expect(
          pane.querySelector(`[data-testid='body-${paneId}']`),
        ).not.toBeNull();
      }
      const separator = screen.getByRole("separator", {
        name: separatorName,
      });
      expect(screen.getAllByRole("separator")).toHaveLength(1);
      expect(separator.getAttribute("aria-orientation")).toBe(orientation);
      expect(separator.className).toContain("bg-border-seam");
    },
  );

  it("resizes stacked panes only from vertical pointer movement", () => {
    persistState(createStackedPaneState());
    renderContainer({
      renderPane: ({ paneId }) => <div>{paneId}</div>,
    });

    const separator = screen.getByRole("separator", {
      name: "Resize stacked right panel panes",
    });
    const hitTarget = separator.firstElementChild;
    const previous = separator.previousElementSibling;
    const next = separator.nextElementSibling;
    if (
      !(hitTarget instanceof HTMLElement) ||
      !(previous instanceof HTMLElement) ||
      !(next instanceof HTMLElement)
    ) {
      throw new Error("Expected one stacked-pane resize pair");
    }
    Object.defineProperty(hitTarget, "setPointerCapture", { value: vi.fn() });
    vi.spyOn(previous, "getBoundingClientRect").mockReturnValue({
      bottom: 400,
      height: 400,
      left: 0,
      right: 800,
      top: 0,
      width: 800,
      x: 0,
      y: 0,
      toJSON: () => ({}),
    });
    vi.spyOn(next, "getBoundingClientRect").mockReturnValue({
      bottom: 801,
      height: 400,
      left: 0,
      right: 800,
      top: 401,
      width: 800,
      x: 0,
      y: 401,
      toJSON: () => ({}),
    });

    fireEvent.pointerDown(hitTarget, {
      clientX: 400,
      clientY: 400,
      pointerId: 3,
    });
    fireEvent.pointerMove(hitTarget, {
      clientX: 700,
      clientY: 400,
      pointerId: 3,
    });
    expect(Number.parseFloat(previous.style.flex)).toBeCloseTo(0.499, 3);
    expect(Number.parseFloat(next.style.flex)).toBeCloseTo(0.501, 3);

    fireEvent.pointerMove(hitTarget, {
      clientX: 700,
      clientY: 600,
      pointerId: 3,
    });
    expect(Number.parseFloat(previous.style.flex)).toBeCloseTo(0.749, 3);
    expect(Number.parseFloat(next.style.flex)).toBeCloseTo(0.251, 3);
    const panes = Array.from(
      document.querySelectorAll<HTMLElement>("[data-split-pane-id]"),
    );
    expect(Number.parseFloat(panes[0]?.style.height ?? "0")).toBeCloseTo(
      74.9,
      1,
    );
    expect(Number.parseFloat(panes[1]?.style.height ?? "0")).toBeCloseTo(
      25.1,
      1,
    );
    fireEvent.pointerUp(hitTarget, {
      clientX: 700,
      clientY: 600,
      pointerId: 3,
    });
  });

  it("snaps a right-panel divider to its equal two-pane boundary and persists it", () => {
    persistState(createTwoPaneState());
    renderContainer({
      renderPane: ({ paneId }) => <div>{paneId}</div>,
    });
    const separator = screen.getByRole("separator");
    const hitTarget = separator.firstElementChild;
    const previous = separator.previousElementSibling;
    const next = separator.nextElementSibling;
    if (
      !(hitTarget instanceof HTMLElement) ||
      !(previous instanceof HTMLElement) ||
      !(next instanceof HTMLElement)
    ) {
      throw new Error("Expected adjacent right-panel split items");
    }
    const grid = separator.parentElement;
    if (grid === null) throw new Error("Expected a right-panel split grid");
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
    fireEvent.pointerDown(hitTarget, { clientX: 470, pointerId: 32 });
    fireEvent.pointerMove(hitTarget, { clientX: 518, pointerId: 32 });

    expect(Number.parseFloat(previous.style.flexGrow)).toBeCloseTo(
      199.5 / 599,
      5,
    );
    expect(
      document.querySelector<HTMLElement>("[data-split-resize-snap-guide]")
        ?.style.left,
    ).toBe("500px");

    fireEvent.pointerUp(hitTarget, { clientX: 518, pointerId: 32 });

    const persisted = parseSidebarSplitState(
      window.localStorage.getItem(sidebarSplitStorageKey(PANEL_STATE_ID)),
      TABS.map((tab) => tab.id),
      "tab-a",
    );
    expect(persisted.layout.root.type).toBe("split");
    if (persisted.layout.root.type === "split") {
      expect(persisted.layout.root.sizes[0]).toBeCloseTo(199.5 / 599, 5);
      expect(persisted.layout.root.sizes[1]).toBeCloseTo(399.5 / 599, 5);
    }
    expect(document.querySelector("[data-split-resize-snap-guide]")).toBeNull();
  });

  it("clears the resize overlay when the divider loses pointer capture", () => {
    persistState(createTwoPaneState());
    renderContainer({
      renderPane: ({ paneId }) => <div>{paneId}</div>,
    });
    const separator = screen.getByRole("separator");
    const hitTarget = separator.firstElementChild;
    const previous = separator.previousElementSibling;
    const next = separator.nextElementSibling;
    if (
      !(hitTarget instanceof HTMLElement) ||
      !(previous instanceof HTMLElement) ||
      !(next instanceof HTMLElement)
    ) {
      throw new Error("Expected adjacent right-panel split items");
    }
    Object.defineProperties(hitTarget, {
      releasePointerCapture: { configurable: true, value: vi.fn() },
      setPointerCapture: { configurable: true, value: vi.fn() },
    });
    vi.spyOn(previous, "getBoundingClientRect").mockReturnValue({
      bottom: 600,
      height: 600,
      left: 0,
      right: 400,
      top: 0,
      width: 400,
      x: 0,
      y: 0,
      toJSON: () => ({}),
    });
    vi.spyOn(next, "getBoundingClientRect").mockReturnValue({
      bottom: 600,
      height: 600,
      left: 401,
      right: 801,
      top: 0,
      width: 400,
      x: 401,
      y: 0,
      toJSON: () => ({}),
    });

    fireEvent.pointerDown(hitTarget, { clientX: 400.5, pointerId: 34 });
    expect(screen.getByTestId("iframe-drag-guard-overlay")).not.toBeNull();

    fireEvent.lostPointerCapture(hitTarget, { pointerId: 34 });

    expect(screen.queryByTestId("iframe-drag-guard-overlay")).toBeNull();
  });

  it("keeps right-panel separators out of the tab order", () => {
    persistState(createTwoPaneState());
    renderContainer({
      renderPane: ({ paneId }) => <div>{paneId}</div>,
    });

    const separator = screen.getByRole("separator");
    fireEvent.keyDown(separator, { key: "ArrowRight" });

    expect(separator.tabIndex).toBe(-1);
    expect(document.querySelector("[data-split-resize-snap-guide]")).toBeNull();
  });

  it("does not resize or persist when the divider is pressed and released in place", () => {
    persistState(createTwoPaneState());
    const storageKey = sidebarSplitStorageKey(PANEL_STATE_ID);
    const setItem = vi.spyOn(Storage.prototype, "setItem");
    renderContainer({
      renderPane: ({ paneId }) => <div>{paneId}</div>,
    });
    const storedState = window.localStorage.getItem(storageKey);
    setItem.mockClear();

    const separator = screen.getByRole("separator");
    const hitTarget = separator.firstElementChild;
    const previous = separator.previousElementSibling;
    const next = separator.nextElementSibling;
    if (
      !(hitTarget instanceof HTMLElement) ||
      !(previous instanceof HTMLElement) ||
      !(next instanceof HTMLElement)
    ) {
      throw new Error("Expected a resize pair");
    }
    Object.defineProperty(hitTarget, "setPointerCapture", { value: vi.fn() });
    vi.spyOn(previous, "getBoundingClientRect").mockReturnValue({
      bottom: 600,
      height: 600,
      left: 0,
      right: 400,
      top: 0,
      width: 400,
      x: 0,
      y: 0,
      toJSON: () => ({}),
    });
    vi.spyOn(next, "getBoundingClientRect").mockReturnValue({
      bottom: 600,
      height: 600,
      left: 401,
      right: 801,
      top: 0,
      width: 400,
      x: 401,
      y: 0,
      toJSON: () => ({}),
    });
    const initialFlex = [previous.style.flex, next.style.flex];

    fireEvent.pointerDown(hitTarget, { clientX: 400, pointerId: 22 });
    fireEvent.pointerUp(hitTarget, { clientX: 400, pointerId: 22 });

    expect([previous.style.flex, next.style.flex]).toEqual(initialFlex);
    expect(window.localStorage.getItem(storageKey)).toBe(storedState);
    expect(
      setItem.mock.calls.filter(([key]) => key === storageKey),
    ).toHaveLength(0);
    expect(separator.dataset.dragging).toBeUndefined();
  });

  it("restores both adjacent flex values after pointer cancellation", () => {
    persistState(createTwoPaneState());
    renderContainer({
      renderPane: ({ paneId }) => <div>{paneId}</div>,
    });

    const separator = screen.getByRole("separator");
    expect(separator.className).toContain("bg-border-seam");
    const hitTarget = separator.firstElementChild;
    const previous = separator.previousElementSibling;
    const next = separator.nextElementSibling;
    expect(hitTarget).toBeInstanceOf(HTMLElement);
    expect(previous).toBeInstanceOf(HTMLElement);
    expect(next).toBeInstanceOf(HTMLElement);
    if (
      !(hitTarget instanceof HTMLElement) ||
      !(previous instanceof HTMLElement) ||
      !(next instanceof HTMLElement)
    ) {
      return;
    }
    Object.defineProperty(hitTarget, "setPointerCapture", { value: vi.fn() });
    Object.defineProperty(previous, "getBoundingClientRect", {
      value: () => ({ left: 0, right: 400, top: 0, bottom: 600 }),
    });
    Object.defineProperty(next, "getBoundingClientRect", {
      value: () => ({ left: 401, right: 800, top: 0, bottom: 600 }),
    });
    const previousFlex = previous.style.flex;
    const nextFlex = next.style.flex;

    fireEvent.pointerDown(hitTarget, { clientX: 400, pointerId: 1 });
    fireEvent.pointerMove(hitTarget, { clientX: 560, pointerId: 1 });
    expect(previous.style.flex).not.toBe(previousFlex);
    expect(next.style.flex).not.toBe(nextFlex);

    fireEvent.pointerCancel(hitTarget, { clientX: 560, pointerId: 1 });
    expect(previous.style.flex).toBe(previousFlex);
    expect(next.style.flex).toBe(nextFlex);
    expect(document.body.style.userSelect).toBe("");
  });

  it("keeps divider drag cursor and selection state off the document root", () => {
    persistState(createTwoPaneState());
    renderContainer({
      renderPane: ({ paneId }) => <div>{paneId}</div>,
    });

    const separator = screen.getByRole("separator");
    const hitTarget = separator.firstElementChild;
    const previous = separator.previousElementSibling;
    const next = separator.nextElementSibling;
    if (
      !(hitTarget instanceof HTMLElement) ||
      !(previous instanceof HTMLElement) ||
      !(next instanceof HTMLElement)
    ) {
      throw new Error("Expected a split divider and adjacent panes");
    }
    Object.defineProperty(hitTarget, "setPointerCapture", { value: vi.fn() });
    Object.defineProperty(previous, "getBoundingClientRect", {
      value: () => ({ left: 0, right: 400, top: 0, bottom: 600 }),
    });
    Object.defineProperty(next, "getBoundingClientRect", {
      value: () => ({ left: 401, right: 800, top: 0, bottom: 600 }),
    });
    const bodyStyleBefore = document.body.getAttribute("style");
    const rootStyleBefore = document.documentElement.getAttribute("style");

    expect(
      fireEvent.pointerDown(hitTarget, { clientX: 400, pointerId: 7 }),
    ).toBe(false);
    expect(document.body.getAttribute("style")).toBe(bodyStyleBefore);
    expect(document.documentElement.getAttribute("style")).toBe(
      rootStyleBefore,
    );
    const overlay = screen.getByTestId("iframe-drag-guard-overlay");
    expect(overlay.className).toContain("cursor-col-resize");
    expect(separator.closest("[data-sidebar-split-container]")?.lastChild).toBe(
      overlay,
    );

    fireEvent.pointerCancel(hitTarget, { clientX: 400, pointerId: 7 });
    expect(screen.queryByTestId("iframe-drag-guard-overlay")).toBeNull();
    expect(document.body.getAttribute("style")).toBe(bodyStyleBefore);
    expect(document.documentElement.getAttribute("style")).toBe(
      rootStyleBefore,
    );
  });

  it("uses a row-resize drag guard for stacked panes", () => {
    persistState(createStackedPaneState());
    renderContainer({
      renderPane: ({ paneId }) => <div>{paneId}</div>,
    });

    const separator = screen.getByRole("separator", {
      name: "Resize stacked right panel panes",
    });
    const hitTarget = separator.firstElementChild;
    const previous = separator.previousElementSibling;
    const next = separator.nextElementSibling;
    if (
      !(hitTarget instanceof HTMLElement) ||
      !(previous instanceof HTMLElement) ||
      !(next instanceof HTMLElement)
    ) {
      throw new Error("Expected a stacked split divider and adjacent panes");
    }
    Object.defineProperty(hitTarget, "setPointerCapture", { value: vi.fn() });
    Object.defineProperty(previous, "getBoundingClientRect", {
      value: () => ({ left: 0, right: 800, top: 0, bottom: 400 }),
    });
    Object.defineProperty(next, "getBoundingClientRect", {
      value: () => ({ left: 0, right: 800, top: 401, bottom: 800 }),
    });

    fireEvent.pointerDown(hitTarget, { clientY: 400, pointerId: 9 });
    expect(screen.getByTestId("iframe-drag-guard-overlay").className).toContain(
      "cursor-row-resize",
    );

    fireEvent.pointerCancel(hitTarget, { clientY: 400, pointerId: 9 });
    expect(screen.queryByTestId("iframe-drag-guard-overlay")).toBeNull();
  });

  it("cancels an in-flight divider resize when the split tree unmounts", () => {
    persistState(createTwoPaneState());
    const view = renderContainer({
      renderPane: ({ paneId }) => <div>{paneId}</div>,
    });

    const separator = screen.getByRole("separator");
    const hitTarget = separator.firstElementChild;
    const previous = separator.previousElementSibling;
    const next = separator.nextElementSibling;
    if (
      !(hitTarget instanceof HTMLElement) ||
      !(previous instanceof HTMLElement) ||
      !(next instanceof HTMLElement)
    ) {
      throw new Error("Expected a split divider and adjacent panes");
    }
    Object.defineProperty(hitTarget, "setPointerCapture", { value: vi.fn() });
    Object.defineProperty(previous, "getBoundingClientRect", {
      value: () => ({ left: 0, right: 400, top: 0, bottom: 600 }),
    });
    Object.defineProperty(next, "getBoundingClientRect", {
      value: () => ({ left: 401, right: 800, top: 0, bottom: 600 }),
    });
    const previousFlex = previous.style.flex;
    const nextFlex = next.style.flex;

    fireEvent.pointerDown(hitTarget, { clientX: 400, pointerId: 8 });
    fireEvent.pointerMove(hitTarget, { clientX: 560, pointerId: 8 });
    expect(previous.style.flex).not.toBe(previousFlex);
    expect(next.style.flex).not.toBe(nextFlex);

    view.unmount();
    expect(separator.dataset.dragging).toBeUndefined();
    expect(previous.style.flex).toBe(previousFlex);
    expect(next.style.flex).toBe(nextFlex);
    fireEvent.pointerMove(hitTarget, { clientX: 700, pointerId: 8 });
    expect(previous.style.flex).toBe(previousFlex);
    expect(next.style.flex).toBe(nextFlex);
  });

  it("does not write a canonical layout or rewrite a focused-pane no-op", () => {
    const storageKey = sidebarSplitStorageKey(PANEL_STATE_ID);
    const setItem = vi.spyOn(Storage.prototype, "setItem");

    renderContainer({
      renderPane: ({ paneId }) => (
        <button data-testid="only-pane" type="button">
          {paneId}
        </button>
      ),
      tabs: [TABS[0] as SidebarSplitTabDescriptor],
    });

    fireEvent.pointerDown(screen.getByTestId("only-pane"));
    expect(
      setItem.mock.calls.filter(([key]) => key === storageKey),
    ).toHaveLength(0);
    expect(window.localStorage.getItem(storageKey)).toBeNull();
  });

  it("does not rewrite an unchanged restored split", () => {
    persistState(createTwoPaneState());
    window.localStorage.setItem(
      getFixedPanelTabsStateStorageKey({ threadId: PANEL_STATE_ID }),
      JSON.stringify({ lastUsedAt: Date.now() }),
    );
    const storageKey = sidebarSplitStorageKey(PANEL_STATE_ID);
    const setItem = vi.spyOn(Storage.prototype, "setItem");

    renderContainer({
      renderPane: ({ paneId }) => <div>{paneId}</div>,
    });

    expect(
      setItem.mock.calls.filter(([key]) => key === storageKey),
    ).toHaveLength(0);
  });

  it("uses the canonical layout when localStorage rejects the read", () => {
    const storageKey = sidebarSplitStorageKey(PANEL_STATE_ID);
    const getItem = vi
      .spyOn(Storage.prototype, "getItem")
      .mockImplementation((key) => {
        if (key === storageKey) {
          throw new DOMException("blocked", "SecurityError");
        }
        return null;
      });

    renderContainer({
      renderPane: ({ paneId }) => <div data-testid="only-pane">{paneId}</div>,
      tabs: [TABS[0] as SidebarSplitTabDescriptor],
    });

    expect(screen.getByTestId("only-pane")).not.toBeNull();
    expect(getItem).toHaveBeenCalledWith(storageKey);
  });

  it("keeps a changed layout in memory when localStorage quota is exhausted", () => {
    const storageKey = sidebarSplitStorageKey(PANEL_STATE_ID);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

    renderContainer({
      renderPane: ({ group, onMoveActiveTabToSide }) => (
        <button type="button" onClick={() => onMoveActiveTabToSide?.("right")}>
          Split {group.activeTabId}
        </button>
      ),
    });

    const setItem = vi
      .spyOn(Storage.prototype, "setItem")
      .mockImplementation((key) => {
        if (key === storageKey) {
          throw new DOMException("quota", "QuotaExceededError");
        }
      });

    expect(() =>
      fireEvent.click(screen.getByRole("button", { name: "Split tab-a" })),
    ).not.toThrow();

    expect(document.querySelectorAll("[data-split-pane-id]")).toHaveLength(2);
    expect(window.localStorage.getItem(storageKey)).toBeNull();
    expect(warn).toHaveBeenCalledOnce();
    expect(setItem).toHaveBeenCalledWith(storageKey, expect.any(String));
  });
});
