// @vitest-environment jsdom

import { cleanup, render, screen } from "@testing-library/react";
import { createRef } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const sidebarMocks = vi.hoisted(() => ({
  scrollElementRef: null as { current: HTMLDivElement | null } | null,
}));

vi.mock("@/components/ui/sidebar.js", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("@/components/ui/sidebar.js")>();
  return {
    ...actual,
    useSidebarContentElementRef: () => {
      const contextRef = actual.useSidebarContentElementRef();
      return sidebarMocks.scrollElementRef ?? contextRef;
    },
  };
});

import {
  SIDEBAR_CONTENT_SELECTOR,
  SidebarContent,
} from "@/components/ui/sidebar.js";
import { SidebarWindowedItems } from "./SidebarWindowedItems";

const selectorMatch = SIDEBAR_CONTENT_SELECTOR.match(/^\[([\w-]+)="(.+)"\]$/);
if (!selectorMatch) {
  throw new Error(
    `Unparseable SIDEBAR_CONTENT_SELECTOR: ${SIDEBAR_CONTENT_SELECTOR}`,
  );
}
const [, SIDEBAR_CONTENT_ATTR, SIDEBAR_CONTENT_VALUE] = selectorMatch;

const VIEWPORT_RECT = new DOMRect(0, 0, 300, 500);

const OFFSCREEN_ROW_RECT = new DOMRect(0, 1_000, 300, 30);

function mountSidebarContentContainer(clientHeight: number) {
  const container = document.createElement("div");
  container.setAttribute(SIDEBAR_CONTENT_ATTR, SIDEBAR_CONTENT_VALUE);
  Object.defineProperty(container, "clientHeight", {
    configurable: true,
    value: clientHeight,
  });
  document.body.appendChild(container);
  return container;
}

function renderList(container?: HTMLElement) {
  return render(
    <SidebarWindowedItems
      itemKeys={["first", "second", "third"]}
      estimateRows={() => 1}
      getNavigationEntries={(index) => [
        { projectId: "proj_test", threadId: `thr_${index}` },
      ]}
      renderItem={(index) => (
        <span data-testid={`real-item-${index}`}>Real item {index}</span>
      )}
    />,
    container ? { container } : undefined,
  );
}

beforeEach(() => {
  const scrollElement = document.createElement("div");
  Object.defineProperty(scrollElement, "clientHeight", {
    configurable: true,
    value: 500,
  });
  sidebarMocks.scrollElementRef = { current: scrollElement };

  vi.stubGlobal(
    "IntersectionObserver",
    class {
      observe() {}
      unobserve() {}
      disconnect() {}
    },
  );

  vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(
    function (this: HTMLElement) {
      if (this === scrollElement || this.matches(SIDEBAR_CONTENT_SELECTOR)) {
        return VIEWPORT_RECT;
      }
      if (this.hasAttribute("data-sidebar-windowed-item")) {
        return OFFSCREEN_ROW_RECT;
      }
      return new DOMRect();
    },
  );
});

afterEach(() => {
  cleanup();
  sidebarMocks.scrollElementRef = null;
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("SidebarWindowedItems", () => {
  it("mounts and focuses an offscreen item on request without refocusing on updates", () => {
    const tree = (focusItemKey?: string) => (
      <SidebarWindowedItems
        itemKeys={["first", "second", "third"]}
        focusItemKey={focusItemKey}
        estimateRows={() => 1}
        renderItem={(index) => (
          <a href="#thread" data-sidebar-thread-id={`thr_${index}`}>
            Thread {index}
          </a>
        )}
      />
    );
    const { rerender } = render(tree());
    expect(screen.queryByText("Thread 1")).toBeNull();
    rerender(tree("second"));
    const target = screen.getByRole("link", { name: "Thread 1" });
    expect(document.activeElement).toBe(target);
    target.blur();
    rerender(tree("second"));
    expect(document.activeElement).not.toBe(target);
  });

  it("focuses a collapsed group disclosure when no thread link is rendered", () => {
    render(
      <SidebarWindowedItems
        itemKeys={["group"]}
        focusItemKey="group"
        estimateRows={() => 1}
        renderItem={() => <button aria-expanded={false}>Worktree</button>}
      />,
    );
    expect(document.activeElement).toBe(
      screen.getByRole("button", { name: "Worktree" }),
    );
  });

  it("windows a short list when every item is outside the viewport margin", () => {
    renderList();

    expect(screen.queryByTestId("real-item-0")).toBeNull();
    expect(
      document.querySelectorAll("[data-sidebar-windowed-item]"),
    ).toHaveLength(3);
    expect(
      document.querySelectorAll("[data-sidebar-windowed-nav]"),
    ).toHaveLength(3);
  });

  it("windows rows when the scroll container ref is not attached yet (same-commit mount)", () => {
    sidebarMocks.scrollElementRef = { current: null };
    const container = mountSidebarContentContainer(500);

    renderList(container);

    expect(screen.queryByTestId("real-item-0")).toBeNull();
    expect(
      container.querySelectorAll("[data-sidebar-windowed-item]"),
    ).toHaveLength(3);
    expect(
      container.querySelectorAll("[data-sidebar-windowed-nav]"),
    ).toHaveLength(3);
  });

  it("windows rows under the real SidebarContent mounted in the same commit", () => {
    sidebarMocks.scrollElementRef = null;
    vi.spyOn(Element.prototype, "clientHeight", "get").mockImplementation(
      function (this: Element) {
        return this.matches(SIDEBAR_CONTENT_SELECTOR) ? 500 : 0;
      },
    );

    const contentRef = createRef<HTMLDivElement>();
    const { container } = render(
      <SidebarContent ref={contentRef}>
        <SidebarWindowedItems
          itemKeys={["first", "second", "third"]}
          estimateRows={() => 1}
          getNavigationEntries={(index) => [
            { projectId: "proj_test", threadId: `thr_${index}` },
          ]}
          renderItem={(index) => (
            <span data-testid={`real-item-${index}`}>Real item {index}</span>
          )}
        />
      </SidebarContent>,
    );

    const scroller = container.querySelector(SIDEBAR_CONTENT_SELECTOR);
    expect(scroller).not.toBeNull();
    expect(scroller).toBe(contentRef.current);
    expect(
      scroller?.querySelectorAll("[data-sidebar-windowed-item]"),
    ).toHaveLength(3);
    expect(screen.queryByTestId("real-item-0")).toBeNull();
    expect(
      document.querySelectorAll("[data-sidebar-windowed-nav]"),
    ).toHaveLength(3);
  });

  it("realizes every row when no scroll container can be found", () => {
    sidebarMocks.scrollElementRef = { current: null };

    renderList();

    expect(screen.getAllByTestId(/^real-item-/)).toHaveLength(3);
    expect(
      document.querySelectorAll("[data-sidebar-windowed-nav]"),
    ).toHaveLength(0);
  });

  it("keeps promote-all for a zero-height container", () => {
    sidebarMocks.scrollElementRef = { current: null };
    const container = mountSidebarContentContainer(0);

    renderList(container);

    expect(screen.getAllByTestId(/^real-item-/)).toHaveLength(3);
  });
});
