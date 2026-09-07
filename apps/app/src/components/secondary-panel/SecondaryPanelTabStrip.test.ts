// @vitest-environment jsdom

import { act, cleanup, fireEvent, render } from "@testing-library/react";
import { createElement } from "react";
import { afterEach, vi } from "vitest";
import { describe, expect, it } from "vitest";
import {
  SecondaryPanelTabStrip,
  SECONDARY_PANEL_TAB_STRIP_FADE_TONE,
} from "./SecondaryPanelTabStrip";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("secondary panel tab-strip edge fades", () => {
  it("uses the themed edge fade", () => {
    expect(SECONDARY_PANEL_TAB_STRIP_FADE_TONE).toBe("sidebar");
  });

  it("keeps the desktop tab viewport outside the window drag region", () => {
    vi.stubGlobal(
      "ResizeObserver",
      class {
        observe() {}
        disconnect() {}
      },
    );
    const tabStrip = (usesDesktopChrome: boolean) =>
      createElement(SecondaryPanelTabStrip, {
        activeTabId: null,
        tabs: [],
        onReorderTab: vi.fn(),
        usesDesktopChrome,
        isPanelOpen: true,
      });
    const view = render(tabStrip(true));
    const viewport = view.container.querySelector(".no-scrollbar");
    expect(viewport?.className).toContain("[app-region:no-drag]");
    expect(viewport?.className).toContain("[-webkit-app-region:no-drag]");

    view.rerender(tabStrip(false));
    expect(
      view.container.querySelector(".no-scrollbar")?.className,
    ).not.toContain("app-region");
  });

  it("enlarges coarse-pointer close targets only for file previews", () => {
    vi.stubGlobal(
      "ResizeObserver",
      class {
        observe() {}
        disconnect() {}
      },
    );
    const { getByRole } = render(
      createElement(SecondaryPanelTabStrip, {
        activeTabId: "file-preview",
        tabs: [
          {
            label: "preview.html",
            isPinned: false,
            leadingVisual: null,
            statusLabel: null,
            onSelect: vi.fn(),
            onClose: vi.fn(),
            renderContent: () => null,
            tab: {
              environmentId: null,
              hostId: null,
              id: "file-preview",
              kind: "host-file-preview" as const,
              lineRange: null,
              path: "preview.html",
              threadId: null,
            },
          },
          {
            label: "Browser",
            isPinned: false,
            leadingVisual: null,
            statusLabel: null,
            onSelect: vi.fn(),
            onClose: vi.fn(),
            renderContent: () => null,
            tab: { id: "browser", kind: "new-tab" as const },
          },
        ],
        onReorderTab: vi.fn(),
        usesDesktopChrome: false,
        isPanelOpen: true,
      }),
    );

    expect(
      getByRole("button", { name: "Close preview.html" }).classList.contains(
        "max-md:pointer-coarse:min-h-9",
      ),
    ).toBe(true);
    expect(
      getByRole("button", { name: "Close Browser" }).classList.contains(
        "max-md:pointer-coarse:min-h-9",
      ),
    ).toBe(false);
  });

  it("observes the intrinsic tab row so async title changes refresh overflow", () => {
    const observed: Element[] = [];
    let resizeCallback: ResizeObserverCallback | undefined;
    let animationFrameCallback: FrameRequestCallback | undefined;
    vi.spyOn(window, "requestAnimationFrame").mockImplementation((callback) => {
      animationFrameCallback = callback;
      return 1;
    });
    vi.stubGlobal(
      "ResizeObserver",
      class {
        constructor(callback: ResizeObserverCallback) {
          resizeCallback = callback;
        }
        observe(element: Element) {
          observed.push(element);
        }
        disconnect() {}
      },
    );

    const { container } = render(
      createElement(SecondaryPanelTabStrip, {
        activeTabId: "browser",
        tabs: [
          {
            label: "Browser",
            isPinned: false,
            leadingVisual: null,
            statusLabel: null,
            onSelect: vi.fn(),
            onClose: vi.fn(),
            renderContent: () => null,
            tab: { id: "browser", kind: "new-tab" },
          },
        ],
        onReorderTab: vi.fn(),
        usesDesktopChrome: false,
        isPanelOpen: true,
      }),
    );

    const viewport = container.querySelector(".no-scrollbar");
    const content = container.querySelector(
      "[data-secondary-panel-tab-content]",
    );
    const strip = container.querySelector(
      '[data-testid="secondary-panel-tab-strip"]',
    );
    expect(content).not.toBeNull();
    expect(strip).not.toBeNull();
    expect(observed).toContain(strip);
    expect(observed).toContain(viewport);
    expect(observed).toContain(content);
    expect(resizeCallback).toBeDefined();
    expect(container.querySelectorAll("[data-overflow-fade]")).toHaveLength(2);
    expect(
      container
        .querySelector("[data-overflow-fade='left']")
        ?.classList.contains("w-6"),
    ).toBe(true);
    const leftButton = container.querySelector<HTMLButtonElement>(
      '[aria-label="Scroll tabs left"]',
    );
    const rightButton = container.querySelector<HTMLButtonElement>(
      '[aria-label="Scroll tabs right"]',
    );
    expect(leftButton?.classList.contains("w-0")).toBe(true);
    expect(rightButton?.classList.contains("w-0")).toBe(true);

    const rightFade = container.querySelector("[data-overflow-fade='right']");
    expect(rightFade?.classList.contains("opacity-0")).toBe(true);
    Object.defineProperties(viewport!, {
      clientWidth: { configurable: true, value: 120 },
      scrollWidth: { configurable: true, value: 240 },
      scrollLeft: { configurable: true, value: 0, writable: true },
    });
    Object.defineProperty(strip!, "clientWidth", {
      configurable: true,
      value: 120,
    });
    Object.defineProperty(content!, "scrollWidth", {
      configurable: true,
      value: 240,
    });
    act(() => {
      resizeCallback?.([], {} as ResizeObserver);
    });
    expect(rightFade?.classList.contains("opacity-100")).toBe(true);

    const scrollRegion = container.querySelector(
      "[data-secondary-panel-tab-scroll-region]",
    );
    expect(strip?.children[0]).toBe(leftButton);
    expect(strip?.children[1]).toBe(scrollRegion);
    expect(strip?.children[2]).toBe(rightButton);
    expect(leftButton?.classList.contains("absolute")).toBe(false);
    expect(rightButton?.classList.contains("absolute")).toBe(false);
    expect(leftButton?.classList.contains("w-5")).toBe(true);
    expect(rightButton?.classList.contains("w-5")).toBe(true);
    expect(leftButton?.classList.contains("opacity-0")).toBe(true);
    expect(leftButton?.tabIndex).toBe(-1);
    expect(rightButton?.classList.contains("opacity-100")).toBe(true);
    expect(rightButton?.tabIndex).toBe(0);
    expect(rightButton?.classList.contains("bg-sidebar")).toBe(true);
    expect(
      rightButton?.classList.contains("hover:bg-surface-raised-solid"),
    ).toBe(true);
    expect(rightButton?.classList.contains("hover:bg-state-hover")).toBe(false);

    const scrollBy = vi.fn();
    Object.defineProperty(viewport!, "scrollBy", {
      configurable: true,
      value: scrollBy,
    });
    fireEvent.click(rightButton!);
    expect(scrollBy).toHaveBeenCalledWith({ left: 140, behavior: "smooth" });

    rightButton?.focus();
    expect(document.activeElement).toBe(rightButton);
    viewport!.scrollLeft = 120;
    fireEvent.scroll(viewport!);
    act(() => animationFrameCallback?.(0));
    expect(rightButton?.getAttribute("aria-hidden")).toBe("true");
    expect(leftButton?.getAttribute("aria-hidden")).toBe("false");
    expect(document.activeElement).toBe(leftButton);

    Object.defineProperty(content!, "scrollWidth", {
      configurable: true,
      value: 100,
    });
    act(() => {
      resizeCallback?.([], {} as ResizeObserver);
    });
    expect(leftButton?.classList.contains("w-0")).toBe(true);
    expect(rightButton?.classList.contains("w-0")).toBe(true);
    expect(document.activeElement).toBe(
      container.querySelector('button[aria-pressed="true"]'),
    );
  });
});
