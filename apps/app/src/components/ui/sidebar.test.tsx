// @vitest-environment jsdom

import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
} from "@testing-library/react";
import { memo } from "react";
import { flushSync } from "react-dom";
import { renderToString } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CompactViewportOverrideProvider } from "@bb/shared-ui/hooks/use-compact-viewport";
import {
  Sidebar,
  SidebarContent,
  SidebarInset,
  SidebarProvider,
  SidebarTrigger,
  useIsSidebarShowing,
  useOptionalIsSidebarShowing,
  useSidebar,
} from "./sidebar";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.useRealTimers();
});

const MOBILE_TOGGLE_SETTLE_MS = 220;

function settleMobileToggle() {
  act(() => {
    vi.advanceTimersByTime(MOBILE_TOGGLE_SETTLE_MS);
  });
}

function createTouch(clientX: number, clientY: number): Touch {
  return { identifier: 1, clientX, clientY } as Touch;
}

function createTouchList(...touches: Touch[]): TouchList {
  const touchList = {
    length: touches.length,
    item: (index: number) => touches[index] ?? null,
  };
  touches.forEach((touch, index) => {
    Object.defineProperty(touchList, index, { value: touch });
  });
  return touchList as unknown as TouchList;
}

function fireTouch(
  target: Element | Document | Window,
  type: "touchstart" | "touchmove",
  touch: Touch,
) {
  const event = new Event(type, { bubbles: true, cancelable: true });
  Object.defineProperties(event, {
    touches: { value: createTouchList(touch) },
    changedTouches: { value: createTouchList(touch) },
  });
  fireEvent(target, event);
}

function fireTouchEnd(target: Element | Document | Window, touch: Touch) {
  const event = new Event("touchend", { bubbles: true, cancelable: true });
  Object.defineProperties(event, {
    touches: { value: createTouchList() },
    changedTouches: { value: createTouchList(touch) },
  });
  fireEvent(target, event);
}

function firePointer(
  target: Element | Document | Window,
  type: "pointerdown" | "pointermove",
  clientX: number,
  clientY: number,
) {
  const event = new Event(type, { bubbles: true, cancelable: true });
  Object.defineProperties(event, {
    pointerId: { value: 1 },
    pointerType: { value: "touch" },
    isPrimary: { value: true },
    button: { value: 0 },
    buttons: { value: 1 },
    clientX: { value: clientX },
    clientY: { value: clientY },
  });
  fireEvent(target, event);
}

function renderScrollerSwipeHarness() {
  render(
    <CompactViewportOverrideProvider isCompactViewport>
      <SidebarProvider>
        <Sidebar>Sidebar content</Sidebar>
        <SidebarInset>
          <div data-testid="scroller" style={{ overflowX: "auto" }}>
            <div data-sidebar-swipe-selectable>Wide code block</div>
          </div>
        </SidebarInset>
      </SidebarProvider>
    </CompactViewportOverrideProvider>,
  );
  const scroller = screen.getByTestId("scroller");
  let scrollWidthReads = 0;
  Object.defineProperty(scroller, "scrollWidth", {
    get: () => {
      scrollWidthReads += 1;
      return 500;
    },
  });
  Object.defineProperty(scroller, "clientWidth", { get: () => 100 });
  return {
    prose: screen.getByText("Wide code block"),
    getScrollWidthReads: () => scrollWidthReads,
  };
}

function renderSelectableSwipeHarness() {
  render(
    <CompactViewportOverrideProvider isCompactViewport>
      <SidebarProvider>
        <Sidebar>Sidebar content</Sidebar>
        <SidebarInset>
          <div data-sidebar-swipe-selectable>Selectable message prose</div>
        </SidebarInset>
      </SidebarProvider>
    </CompactViewportOverrideProvider>,
  );
}

function OptionalSidebarProbe() {
  const isShowing = useOptionalIsSidebarShowing();
  return <div data-sidebar-showing={String(isShowing)} />;
}

describe("useOptionalIsSidebarShowing", () => {
  it("returns null outside SidebarProvider instead of throwing", () => {
    expect(renderToString(<OptionalSidebarProbe />)).toContain(
      'data-sidebar-showing="null"',
    );
  });
});

describe("useIsSidebarShowing", () => {
  it("re-renders its reader only when the visible bit flips, not on every provider commit", () => {
    vi.useFakeTimers();
    const showingRenders: boolean[] = [];
    const ShowingReader = memo(function ShowingReader() {
      const isShowing = useIsSidebarShowing();
      showingRenders.push(isShowing);
      return <output data-testid="showing">{String(isShowing)}</output>;
    });
    function Controls() {
      const {
        openMobileSidebar,
        closeMobileSidebar,
        setSuppressMobileOpenAnimation,
      } = useSidebar();
      return (
        <>
          <button type="button" onClick={openMobileSidebar}>
            open
          </button>
          <button type="button" onClick={closeMobileSidebar}>
            close
          </button>
          <button
            type="button"
            onClick={() => setSuppressMobileOpenAnimation(true)}
          >
            suppress
          </button>
        </>
      );
    }
    render(
      <CompactViewportOverrideProvider isCompactViewport>
        <SidebarProvider>
          <ShowingReader />
          <Controls />
        </SidebarProvider>
      </CompactViewportOverrideProvider>,
    );
    expect(screen.getByTestId("showing").textContent).toBe("false");
    const settled = showingRenders.length;

    fireEvent.click(screen.getByRole("button", { name: "suppress" }));
    expect(showingRenders).toHaveLength(settled);

    fireEvent.click(screen.getByRole("button", { name: "open" }));
    settleMobileToggle();
    expect(screen.getByTestId("showing").textContent).toBe("true");
    const afterOpen = showingRenders.length;
    expect(afterOpen).toBe(settled + 1);

    fireEvent.click(screen.getByRole("button", { name: "close" }));
    expect(showingRenders).toHaveLength(afterOpen);
    settleMobileToggle();
    expect(screen.getByTestId("showing").textContent).toBe("false");
    expect(showingRenders).toHaveLength(afterOpen + 1);
  });
});

describe("SidebarTrigger", () => {
  it("uses the shared sidebar icon on every viewport", () => {
    const markup = renderToString(
      <SidebarProvider>
        <SidebarTrigger />
      </SidebarProvider>,
    );

    expect(markup).toContain('data-icon="PanelLeft"');
    expect(markup).not.toContain('data-icon="AlignLeft"');
    expect(markup).toContain('aria-expanded="true"');
    expect(markup).not.toContain('aria-pressed="');
  });
});

describe("SidebarContent", () => {
  it("owns the sidebar surface used behind transparent and sticky rows", () => {
    render(<SidebarContent data-testid="content">Rows</SidebarContent>);

    expect(screen.getByTestId("content").classList).toContain("bg-sidebar");
  });
});

function getMobilePanel(): HTMLElement | null {
  const panel = document.querySelector('[data-sidebar="panel"]');
  return panel instanceof HTMLElement ? panel : null;
}

const SHELF_OPEN_TRANSLATE = "320px";
const SHELF_CLOSED_TRANSLATE = "0px";

function getShelfRevealTranslate(): string {
  const backdrop = document.querySelector("[data-sidebar-mobile-backdrop]");
  return backdrop instanceof HTMLElement ? backdrop.style.translate : "";
}

function getShelfInsetTranslate(): string {
  const inset = document.querySelector('[data-sidebar="inset"]');
  return inset instanceof HTMLElement ? inset.style.translate : "";
}

const MOBILE_REALIZE_TIMEOUT_MS = 1000;

function settleMobileRealization() {
  act(() => {
    vi.advanceTimersByTime(MOBILE_REALIZE_TIMEOUT_MS);
  });
}

function renderCompactSidebarHarness() {
  render(
    <CompactViewportOverrideProvider isCompactViewport>
      <SidebarProvider>
        <Sidebar>Sidebar content</Sidebar>
        <SidebarInset>
          <SidebarTrigger />
          Main content
        </SidebarInset>
      </SidebarProvider>
    </CompactViewportOverrideProvider>,
  );
}

describe("mobile sidebar deferred realization", () => {
  it("mounts the closed panel empty at boot and realizes it after the settle window", () => {
    vi.useFakeTimers();
    renderCompactSidebarHarness();

    const closedPanel = getMobilePanel();
    expect(closedPanel).not.toBeNull();
    expect(closedPanel?.dataset.state).toBe("closed");
    expect(closedPanel?.hasAttribute("inert")).toBe(true);
    expect(closedPanel?.textContent).not.toContain("Sidebar content");

    settleMobileRealization();

    expect(getMobilePanel()).toBe(closedPanel);
    expect(closedPanel?.dataset.state).toBe("closed");
    expect(closedPanel?.textContent).toContain("Sidebar content");
  });

  it("prefers requestIdleCallback with a bounded timeout when available", () => {
    vi.useFakeTimers();
    let idleCallback: (() => void) | null = null;
    let idleTimeout: number | undefined;
    const cancelIdle = vi.fn();
    Object.defineProperty(window, "requestIdleCallback", {
      configurable: true,
      value: (callback: () => void, options?: { timeout?: number }) => {
        idleCallback = callback;
        idleTimeout = options?.timeout;
        return 1;
      },
    });
    Object.defineProperty(window, "cancelIdleCallback", {
      configurable: true,
      value: cancelIdle,
    });
    try {
      renderCompactSidebarHarness();
      expect(idleCallback).not.toBeNull();
      expect(idleTimeout).toBe(MOBILE_REALIZE_TIMEOUT_MS);
      expect(getMobilePanel()?.textContent).not.toContain("Sidebar content");

      act(() => {
        vi.advanceTimersByTime(100);
      });
      expect(getMobilePanel()?.textContent).not.toContain("Sidebar content");

      act(() => {
        idleCallback?.();
      });
      expect(getMobilePanel()?.textContent).toContain("Sidebar content");
    } finally {
      Reflect.deleteProperty(window, "requestIdleCallback");
      Reflect.deleteProperty(window, "cancelIdleCallback");
    }
  });

  it("realizes the subtree at the start of a deferred open before idle", () => {
    vi.useFakeTimers();
    renderCompactSidebarHarness();
    expect(getMobilePanel()?.textContent).not.toContain("Sidebar content");

    fireEvent.click(screen.getByRole("button", { name: "Toggle Sidebar" }));

    const openingPanel = getMobilePanel();
    expect(openingPanel?.dataset.state).toBe("closed");
    expect(openingPanel?.textContent).toContain("Sidebar content");

    settleMobileToggle();
    expect(getMobilePanel()?.dataset.state).toBe("open");
    expect(getMobilePanel()?.textContent).toContain("Sidebar content");

    fireEvent.click(screen.getByTestId("sidebar-mobile-backdrop"));
    settleMobileToggle();
    expect(getMobilePanel()?.dataset.state).toBe("closed");
    expect(getMobilePanel()?.textContent).toContain("Sidebar content");
  });

  it("keeps the realize commit out of the open tap's synchronous flush", () => {
    vi.useFakeTimers();
    renderCompactSidebarHarness();
    const trigger = screen.getByRole("button", { name: "Toggle Sidebar" });

    let panelStyledForSlideInTap = false;
    let realizedInTapFlush = true;
    act(() => {
      flushSync(() => {
        trigger.click();
      });
      const panel = getMobilePanel();
      panelStyledForSlideInTap =
        getShelfRevealTranslate() === SHELF_OPEN_TRANSLATE;
      realizedInTapFlush =
        panel?.textContent?.includes("Sidebar content") ?? false;
    });

    expect(panelStyledForSlideInTap).toBe(true);
    expect(realizedInTapFlush).toBe(false);
    expect(getMobilePanel()?.textContent).toContain("Sidebar content");

    settleMobileToggle();
    expect(getMobilePanel()?.dataset.state).toBe("open");
  });

  it("writes the desktop width on the gap and panel, not on the provider wrapper", () => {
    render(
      <CompactViewportOverrideProvider isCompactViewport={false}>
        <SidebarProvider width="333px" data-testid="wrapper">
          <Sidebar>Sidebar content</Sidebar>
        </SidebarProvider>
      </CompactViewportOverrideProvider>,
    );

    const wrapper = screen.getByTestId("wrapper");
    const gap = document.querySelector('[data-sidebar="gap"]');
    const panel = document.querySelector('[data-sidebar="panel"]');
    if (!(gap instanceof HTMLElement) || !(panel instanceof HTMLElement)) {
      throw new Error("Expected desktop gap and panel");
    }
    expect(gap.style.getPropertyValue("--sidebar-width")).toBe("333px");
    expect(panel.style.getPropertyValue("--sidebar-width")).toBe("333px");
    expect(wrapper.style.getPropertyValue("--sidebar-width")).toBe("");
  });

  it("renders the desktop sidebar subtree synchronously", () => {
    const markup = renderToString(
      <CompactViewportOverrideProvider isCompactViewport={false}>
        <SidebarProvider>
          <Sidebar>Sidebar content</Sidebar>
        </SidebarProvider>
      </CompactViewportOverrideProvider>,
    );

    expect(markup).toContain("Sidebar content");
  });
});

describe("mobile sidebar shelf stacking", () => {
  it("keeps the panel beneath the page and moves the page to reveal it", () => {
    vi.useFakeTimers();
    renderCompactSidebarHarness();
    settleMobileRealization();

    const panel = getMobilePanel();
    const inset = document.querySelector('[data-sidebar="inset"]');
    if (!(inset instanceof HTMLElement) || panel === null) {
      throw new Error("Expected a compact panel and page inset");
    }

    expect(panel.className).toContain("z-0");
    expect(panel.className).toContain("data-[side=left]:border-r");
    expect(panel.className).toContain("data-[side=right]:border-l");
    expect(inset.className).toContain("max-md:z-30");
    expect(inset.className).toContain("motion-reduce:transition-none!");
    expect(inset.dataset.sidebarShelf).toBe("closed");

    fireEvent.click(screen.getByRole("button", { name: "Toggle Sidebar" }));
    settleMobileToggle();

    expect(inset.dataset.sidebarShelf).toBe("open");
    expect(getMobilePanel()?.style.translate).toBe("");
  });

  it("keeps the center pane square for both shelves", () => {
    vi.useFakeTimers();
    renderCompactSidebarHarness();
    settleMobileRealization();

    const inset = document.querySelector('[data-sidebar="inset"]');
    if (!(inset instanceof HTMLElement)) {
      throw new Error("Expected a page inset");
    }

    expect(inset.className).not.toContain("data-[sidebar-shelf=open]:rounded");
    expect(inset.className).not.toContain("data-[panel-shelf=shelf]:rounded");
    expect(inset.className).not.toContain(
      "data-[sidebar-shelf=open]:overflow-hidden",
    );
    expect(inset.className).not.toContain(
      "data-[panel-shelf=shelf]:overflow-hidden",
    );
    expect(inset.className).not.toContain("data-[sidebar-shelf=open]:shadow");
    expect(inset.className).not.toContain("data-[panel-shelf=shelf]:shadow");
  });

  it("leaves the page untouched by the shelf on desktop", () => {
    render(
      <CompactViewportOverrideProvider isCompactViewport={false}>
        <SidebarProvider>
          <Sidebar>Sidebar content</Sidebar>
          <SidebarInset>Main content</SidebarInset>
        </SidebarProvider>
      </CompactViewportOverrideProvider>,
    );

    const inset = document.querySelector('[data-sidebar="inset"]');
    if (!(inset instanceof HTMLElement)) {
      throw new Error("Expected a page inset");
    }
    expect(inset.dataset.sidebarShelf).toBeUndefined();
  });
});

describe("mobile sidebar persistence", () => {
  it("closes from an exposed-content swipe after committing the closed state", () => {
    vi.useFakeTimers();
    renderCompactSidebarHarness();

    fireEvent.click(screen.getByRole("button", { name: "Toggle Sidebar" }));
    settleMobileToggle();

    const panel = getMobilePanel();
    const backdrop = screen.getByTestId("sidebar-mobile-backdrop");
    const inset = document.querySelector('[data-sidebar="inset"]');
    if (!(inset instanceof HTMLElement)) {
      throw new Error("Expected a page inset");
    }
    const shelfStatesAtDragStyleClear: string[] = [];
    const removeInsetAttribute = inset.removeAttribute.bind(inset);
    vi.spyOn(inset, "removeAttribute").mockImplementation((name) => {
      if (name === "data-vaul-animate") {
        shelfStatesAtDragStyleClear.push(
          inset.dataset.sidebarShelf ?? "missing",
        );
      }
      removeInsetAttribute(name);
    });
    expect(panel?.dataset.state).toBe("open");

    fireTouch(backdrop, "touchstart", createTouch(360, 160));
    fireTouch(window, "touchmove", createTouch(180, 164));
    fireTouchEnd(window, createTouch(180, 164));
    expect(inset.getAttribute("data-vaul-animate")).toBe("false");
    settleMobileToggle();

    expect(panel?.dataset.state).toBe("closed");
    expect(shelfStatesAtDragStyleClear).toEqual(["closed"]);
    act(() => {
      vi.advanceTimersByTime(400);
    });
  });

  it("ignores a closing swipe from the right browser edge", () => {
    vi.useFakeTimers();
    renderCompactSidebarHarness();

    fireEvent.click(screen.getByRole("button", { name: "Toggle Sidebar" }));
    settleMobileToggle();

    const panel = getMobilePanel();
    const backdrop = screen.getByTestId("sidebar-mobile-backdrop");
    const startX = window.innerWidth - 12;

    fireTouch(backdrop, "touchstart", createTouch(startX, 160));
    fireTouch(window, "touchmove", createTouch(startX - 180, 164));
    fireTouchEnd(window, createTouch(startX - 180, 164));
    settleMobileToggle();

    expect(panel?.dataset.state).toBe("open");
  });

  it("keeps closed drawer content mounted, inert, and offscreen", () => {
    vi.useFakeTimers();
    renderCompactSidebarHarness();
    settleMobileRealization();

    const closedPanel = getMobilePanel();
    expect(closedPanel).not.toBeNull();
    expect(closedPanel?.textContent).toContain("Sidebar content");
    expect(closedPanel?.dataset.state).toBe("closed");
    expect(closedPanel?.hasAttribute("inert")).toBe(true);
    expect(closedPanel?.className).not.toContain("invisible");

    const inset = document.querySelector('[data-sidebar="inset"]');
    expect(inset?.hasAttribute("inert")).toBe(false);

    fireEvent.click(screen.getByRole("button", { name: "Toggle Sidebar" }));

    const openingPanel = getMobilePanel();
    expect(openingPanel?.dataset.state).toBe("closed");
    expect(getShelfInsetTranslate()).toBe(SHELF_OPEN_TRANSLATE);
    settleMobileToggle();

    const openPanel = getMobilePanel();
    expect(openPanel?.dataset.state).toBe("open");
    expect(openPanel?.hasAttribute("inert")).toBe(false);

    const panelParent = openPanel?.parentElement;
    const backdrop = screen.getByTestId("sidebar-mobile-backdrop");
    for (const sibling of panelParent?.children ?? []) {
      expect(sibling.hasAttribute("inert")).toBe(false);
    }
    expect(inset?.hasAttribute("inert")).toBe(false);

    fireEvent.click(backdrop);
    const closingPanel = getMobilePanel();
    expect(closingPanel?.dataset.state).toBe("open");
    expect(getShelfInsetTranslate()).toBe(SHELF_CLOSED_TRANSLATE);

    settleMobileToggle();

    const reclosedPanel = getMobilePanel();
    expect(reclosedPanel?.dataset.state).toBe("closed");
    expect(reclosedPanel?.hasAttribute("inert")).toBe(true);
    expect(reclosedPanel?.textContent).toContain("Sidebar content");
    expect(inset?.hasAttribute("inert")).toBe(false);
  });

  it("blocks tap-through with the backdrop during the deferred open", () => {
    vi.useFakeTimers();
    render(
      <CompactViewportOverrideProvider isCompactViewport>
        <SidebarProvider>
          <Sidebar>Sidebar content</Sidebar>
          <SidebarInset>
            <SidebarTrigger />
            Main content
          </SidebarInset>
        </SidebarProvider>
      </CompactViewportOverrideProvider>,
    );

    fireEvent.click(screen.getByRole("button", { name: "Toggle Sidebar" }));

    const backdrop = screen.getByTestId("sidebar-mobile-backdrop");
    expect(getMobilePanel()?.dataset.state).toBe("closed");
    expect(backdrop.style.pointerEvents).toBe("auto");

    fireEvent.click(backdrop);
    settleMobileToggle();
    expect(getMobilePanel()?.dataset.state).toBe("open");
    expect(backdrop.style.pointerEvents).toBe("");

    fireEvent.click(backdrop);
    settleMobileToggle();
    expect(getMobilePanel()?.dataset.state).toBe("closed");
    expect(backdrop.style.pointerEvents).not.toBe("auto");
  });

  it("keeps the pinned trigger interactive and closes on a second press", () => {
    vi.useFakeTimers();
    render(
      <CompactViewportOverrideProvider isCompactViewport>
        <SidebarProvider>
          <Sidebar>Sidebar content</Sidebar>
          <SidebarInset>Main content</SidebarInset>
          {}
          <div data-testid="trigger-overlay">
            <SidebarTrigger />
          </div>
        </SidebarProvider>
      </CompactViewportOverrideProvider>,
    );

    const trigger = screen.getByRole("button", { name: "Toggle Sidebar" });
    const overlay = screen.getByTestId("trigger-overlay");

    fireEvent.click(trigger);
    settleMobileToggle();
    expect(getMobilePanel()?.dataset.state).toBe("open");
    expect(overlay.hasAttribute("inert")).toBe(false);
    expect(trigger.getAttribute("aria-expanded")).toBe("true");

    fireEvent.click(trigger);
    expect(getMobilePanel()?.dataset.state).toBe("open");
    expect(getShelfRevealTranslate()).toBe(SHELF_CLOSED_TRANSLATE);

    settleMobileToggle();
    expect(getMobilePanel()?.dataset.state).toBe("closed");
    expect(getMobilePanel()?.hasAttribute("inert")).toBe(true);
    expect(trigger.getAttribute("aria-expanded")).toBe("false");

    fireEvent.click(trigger);
    settleMobileToggle();
    expect(getMobilePanel()?.dataset.state).toBe("open");
  });

  it("traps Tab between the trigger and the open drawer", () => {
    vi.useFakeTimers();
    render(
      <CompactViewportOverrideProvider isCompactViewport>
        <SidebarProvider>
          <Sidebar>
            <button type="button">Sidebar row</button>
          </Sidebar>
          <SidebarInset>
            <button type="button">Inset action</button>
          </SidebarInset>
          <div data-testid="trigger-overlay">
            <SidebarTrigger />
          </div>
        </SidebarProvider>
      </CompactViewportOverrideProvider>,
    );

    const trigger = screen.getByRole("button", { name: "Toggle Sidebar" });
    const insetAction = screen.getByRole("button", { name: "Inset action" });

    fireEvent.click(trigger);
    settleMobileToggle();
    expect(getMobilePanel()?.dataset.state).toBe("open");
    const row = screen.getByRole("button", { name: "Sidebar row" });

    act(() => trigger.focus());
    fireEvent.keyDown(trigger, { key: "Tab" });
    expect(document.activeElement).toBe(row);

    fireEvent.keyDown(row, { key: "Tab" });
    expect(document.activeElement).toBe(trigger);

    fireEvent.keyDown(trigger, { key: "Tab", shiftKey: true });
    expect(document.activeElement).toBe(row);

    act(() => insetAction.focus());
    fireEvent.keyDown(insetAction, { key: "Tab" });
    expect(document.activeElement).toBe(trigger);
  });

  it("moves focus only when a focus-visible trigger opens the drawer", () => {
    vi.useFakeTimers();
    render(
      <CompactViewportOverrideProvider isCompactViewport>
        <SidebarProvider>
          <Sidebar>Sidebar content</Sidebar>
          <SidebarInset>
            <SidebarTrigger />
            Main content
          </SidebarInset>
        </SidebarProvider>
      </CompactViewportOverrideProvider>,
    );

    const trigger = screen.getByRole("button", { name: "Toggle Sidebar" });
    const panel = getMobilePanel();
    if (!panel) throw new Error("Expected mobile sidebar panel");
    const focusSpy = vi.spyOn(panel, "focus");

    fireEvent.click(trigger);
    settleMobileToggle();
    expect(focusSpy).not.toHaveBeenCalled();

    fireEvent.click(screen.getByTestId("sidebar-mobile-backdrop"));
    settleMobileToggle();
    trigger.focus();
    const matches = trigger.matches.bind(trigger);
    vi.spyOn(trigger, "matches").mockImplementation((selector) =>
      selector === '[data-sidebar="trigger"]:focus-visible'
        ? true
        : matches(selector),
    );
    fireEvent.click(trigger);
    settleMobileToggle();

    expect(focusSpy).toHaveBeenCalledOnce();
    expect(document.activeElement).toBe(panel);
  });
});

describe("mobile sidebar swipe-open touch listener scoping", () => {
  function touchMoveRegistrations(spy: {
    mock: { calls: readonly (readonly unknown[])[] };
  }) {
    return spy.mock.calls.filter(([type]) => type === "touchmove");
  }

  it("registers a passive touchmove for touches that start deep in the content", () => {
    renderSelectableSwipeHarness();
    const prose = screen.getByText("Selectable message prose");
    const addSpy = vi.spyOn(window, "addEventListener");

    fireTouch(prose, "touchstart", createTouch(120, 160));

    const registrations = touchMoveRegistrations(addSpy);
    expect(registrations).toHaveLength(1);
    expect(registrations[0]?.[2]).toEqual({ passive: true });

    const move = new Event("touchmove", { bubbles: true, cancelable: true });
    Object.defineProperties(move, {
      touches: { value: createTouchList(createTouch(260, 164)) },
      changedTouches: { value: createTouchList(createTouch(260, 164)) },
    });
    fireEvent(window, move);
    expect(getMobilePanel()?.dataset.state).toBe("open");
    expect(move.defaultPrevented).toBe(false);
  });

  it("keeps the non-passive touchmove for edge-zone touches so the swipe can claim the gesture", () => {
    renderSelectableSwipeHarness();
    const prose = screen.getByText("Selectable message prose");
    const addSpy = vi.spyOn(window, "addEventListener");

    fireTouch(prose, "touchstart", createTouch(40, 160));

    const registrations = touchMoveRegistrations(addSpy);
    expect(registrations).toHaveLength(1);
    expect(registrations[0]?.[2]).toEqual({ passive: false });

    const move = new Event("touchmove", { bubbles: true, cancelable: true });
    Object.defineProperties(move, {
      touches: { value: createTouchList(createTouch(180, 164)) },
      changedTouches: { value: createTouchList(createTouch(180, 164)) },
    });
    fireEvent(window, move);
    expect(getMobilePanel()?.dataset.state).toBe("open");
    expect(move.defaultPrevented).toBe(true);
  });
});

describe("mobile sidebar text-selection arbitration", () => {
  it("opens from a right swipe that starts over selectable message prose", () => {
    renderSelectableSwipeHarness();
    const prose = screen.getByText("Selectable message prose");

    fireTouch(prose, "touchstart", createTouch(120, 160));
    fireTouch(window, "touchmove", createTouch(260, 164));

    expect(getMobilePanel()?.dataset.state).toBe("open");
    expect(getMobilePanel()?.textContent).toContain("Sidebar content");
  });

  it("defers the horizontal-scroll-region probe until horizontal intent", () => {
    const { prose, getScrollWidthReads } = renderScrollerSwipeHarness();

    fireTouch(prose, "touchstart", createTouch(120, 160));

    expect(getScrollWidthReads()).toBe(0);

    fireTouch(window, "touchmove", createTouch(260, 164));
    fireTouch(window, "touchmove", createTouch(280, 164));

    expect(getScrollWidthReads()).toBe(1);
    expect(getMobilePanel()?.dataset.state).toBe("closed");
  });

  it("defers the probe on the pointer path as well", () => {
    const { prose, getScrollWidthReads } = renderScrollerSwipeHarness();

    firePointer(prose, "pointerdown", 120, 160);

    expect(getScrollWidthReads()).toBe(0);

    firePointer(window, "pointermove", 260, 164);
    firePointer(window, "pointermove", 280, 164);

    expect(getScrollWidthReads()).toBe(1);
    expect(getMobilePanel()?.dataset.state).toBe("closed");
  });

  it("cancels a swipe whose start target detached before the probe", () => {
    const { prose, getScrollWidthReads } = renderScrollerSwipeHarness();

    fireTouch(prose, "touchstart", createTouch(120, 160));
    prose.remove();
    fireTouch(window, "touchmove", createTouch(260, 164));

    expect(getScrollWidthReads()).toBe(0);
    expect(getMobilePanel()?.dataset.state).toBe("closed");
  });

  it("cancels a pending prose swipe when native text selection begins", () => {
    let hasSelection = false;
    let selectionNode: Node | null = null;
    vi.spyOn(document, "getSelection").mockImplementation(() =>
      hasSelection
        ? ({
            anchorNode: selectionNode,
            focusNode: selectionNode,
            isCollapsed: false,
          } as Selection)
        : null,
    );
    renderSelectableSwipeHarness();
    const prose = screen.getByText("Selectable message prose");
    selectionNode = prose.firstChild;

    fireTouch(prose, "touchstart", createTouch(120, 160));
    hasSelection = true;
    fireEvent(document, new Event("selectionchange"));
    fireTouch(window, "touchmove", createTouch(260, 164));

    expect(getMobilePanel()?.dataset.state).toBe("closed");
  });
});
