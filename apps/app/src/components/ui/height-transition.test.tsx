// @vitest-environment jsdom

import { act, cleanup, render } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AutoHeightContainer, HeightTransition } from "./height-transition";

class ResizeObserverStub implements ResizeObserver {
  static instances: ResizeObserverStub[] = [];

  constructor(readonly callback: ResizeObserverCallback) {
    ResizeObserverStub.instances.push(this);
  }

  observe: ResizeObserver["observe"] = vi.fn();
  unobserve: ResizeObserver["unobserve"] = vi.fn();
  disconnect: ResizeObserver["disconnect"] = vi.fn();
}

afterEach(() => {
  ResizeObserverStub.instances.length = 0;
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("HeightTransition", () => {
  it("pauses descendant animations while preserving collapsed content state", () => {
    const view = render(
      <HeightTransition visible={false}>
        <span data-testid="animated-child">Working...</span>
      </HeightTransition>,
    );

    const child = view.getByTestId("animated-child");
    const wrapper = child.parentElement?.parentElement;
    expect(wrapper?.className).toContain(
      "[&_*]:![animation-play-state:paused]",
    );

    view.rerender(
      <HeightTransition visible>
        <span data-testid="animated-child">Working...</span>
      </HeightTransition>,
    );

    expect(view.getByTestId("animated-child")).toBe(child);
    expect(wrapper?.className).not.toContain(
      "[&_*]:![animation-play-state:paused]",
    );
  });

  it("snap-syncs its height after a mobile pageshow restore", () => {
    vi.stubGlobal("ResizeObserver", ResizeObserverStub);
    const offsetHeight = vi
      .spyOn(HTMLElement.prototype, "offsetHeight", "get")
      .mockReturnValue(40);
    const view = render(
      <HeightTransition visible>
        <span data-testid="restored-child">Restored content</span>
      </HeightTransition>,
    );
    const wrapper =
      view.getByTestId("restored-child").parentElement?.parentElement;

    expect(wrapper?.style.height).toBe("40px");
    offsetHeight.mockReturnValue(80);

    act(() => {
      window.dispatchEvent(new Event("pageshow"));
    });

    expect(wrapper?.style.height).toBe("80px");
    expect(wrapper?.style.transitionDuration).toBe("0s");
  });
});

function makeResizeEntry(
  target: Element,
  borderBoxBlockSize: number,
  contentRectHeight: number,
): ResizeObserverEntry {
  return {
    target,
    contentRect: new DOMRect(0, 0, 200, contentRectHeight),
    borderBoxSize: [{ blockSize: borderBoxBlockSize, inlineSize: 200 }],
    contentBoxSize: [{ blockSize: contentRectHeight, inlineSize: 200 }],
    devicePixelContentBoxSize: [
      { blockSize: borderBoxBlockSize, inlineSize: 200 },
    ],
  };
}

describe("AutoHeightContainer", () => {
  it("sizes the wrapper from the observed border box", () => {
    vi.stubGlobal("ResizeObserver", ResizeObserverStub);

    const view = render(
      <AutoHeightContainer>
        <span>Streaming response</span>
      </AutoHeightContainer>,
    );
    const inner = view.getByText("Streaming response").parentElement;
    const wrapper = inner?.parentElement;
    const observer = ResizeObserverStub.instances[0];
    if (!inner || !wrapper || !observer) {
      throw new Error("AutoHeightContainer did not render");
    }

    act(() => {
      observer.callback([makeResizeEntry(inner, 120, 112)], observer);
    });

    expect(wrapper.style.height).toBe("120px");
  });

  it("snap-syncs an authoritative layout revision", () => {
    vi.stubGlobal("ResizeObserver", ResizeObserverStub);

    const view = render(
      <AutoHeightContainer snapRevision="active">
        <span>Streaming response</span>
      </AutoHeightContainer>,
    );
    const inner = view.getByText("Streaming response").parentElement;
    const wrapper = inner?.parentElement;
    const observer = ResizeObserverStub.instances[0];
    expect(inner).not.toBeNull();
    expect(wrapper?.style.height).toBe("0px");
    expect(observer).toBeDefined();

    Object.defineProperty(inner, "offsetHeight", {
      configurable: true,
      value: 480,
    });
    view.rerender(
      <AutoHeightContainer snapRevision="completed-turn:1:2000">
        <span>Completed response</span>
      </AutoHeightContainer>,
    );

    expect(wrapper?.style.height).toBe("480px");
    expect(wrapper?.style.transitionDuration).toBe("0s");
    expect(ResizeObserverStub.instances).toEqual([observer]);
    expect(observer?.disconnect).not.toHaveBeenCalled();
  });
});

function stubMediaQueries(matching: ReadonlySet<string>): void {
  vi.spyOn(window, "matchMedia").mockImplementation((query: string) => ({
    matches: matching.has(query),
    media: query,
    onchange: null,
    addListener: () => {},
    removeListener: () => {},
    addEventListener: () => {},
    removeEventListener: () => {},
    dispatchEvent: () => false,
  }));
}

function stubScrollAnchoringSupport(supported: boolean): void {
  vi.stubGlobal("CSS", {
    supports: (property: string, value: string) =>
      supported && property === "overflow-anchor" && value === "none",
  });
}

describe("AutoHeightContainer growth easing", () => {
  function renderWrapper(): HTMLElement {
    const view = render(
      <AutoHeightContainer>
        <span>Streaming response</span>
      </AutoHeightContainer>,
    );
    const wrapper =
      view.getByText("Streaming response").parentElement?.parentElement;
    if (!wrapper) {
      throw new Error("AutoHeightContainer wrapper was not rendered");
    }
    return wrapper;
  }

  it("eases growth on a fine pointer with scroll anchoring available", () => {
    vi.stubGlobal("ResizeObserver", ResizeObserverStub);
    stubMediaQueries(new Set());
    stubScrollAnchoringSupport(true);

    expect(renderWrapper().style.transition).toContain("height 180ms");
  });

  it("snaps growth on a coarse pointer", () => {
    vi.stubGlobal("ResizeObserver", ResizeObserverStub);
    stubMediaQueries(new Set(["(pointer: coarse)"]));
    stubScrollAnchoringSupport(true);

    expect(renderWrapper().style.transition).toContain("height 0ms");
  });

  it("snaps growth under reduced motion", () => {
    vi.stubGlobal("ResizeObserver", ResizeObserverStub);
    stubMediaQueries(new Set(["(prefers-reduced-motion: reduce)"]));
    stubScrollAnchoringSupport(true);

    expect(renderWrapper().style.transition).toContain("height 0ms");
  });

  it("snaps growth where the browser has no scroll anchoring", () => {
    vi.stubGlobal("ResizeObserver", ResizeObserverStub);
    stubMediaQueries(new Set());
    stubScrollAnchoringSupport(false);

    expect(renderWrapper().style.transition).toContain("height 0ms");
  });
});
