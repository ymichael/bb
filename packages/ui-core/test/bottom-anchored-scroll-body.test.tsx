// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  BottomAnchoredScrollBody,
  useBottomAnchoredScroll,
} from "../src/primitives/bottom-anchored-scroll-body.js";

interface ScrollMetrics {
  scrollHeight: number;
  clientHeight: number;
  scrollTop: number;
}

let nextAnimationFrameId = 1;
let animationFrameCallbacks = new Map<number, FrameRequestCallback>();
let requestAnimationFrameMock = vi.fn();
let cancelAnimationFrameMock = vi.fn();

class ResizeObserverMock implements ResizeObserver {
  static instances: ResizeObserverMock[] = [];

  readonly callback: ResizeObserverCallback;
  readonly observeMock = vi.fn();
  readonly unobserveMock = vi.fn();
  readonly disconnectMock = vi.fn();

  constructor(callback: ResizeObserverCallback) {
    this.callback = callback;
    ResizeObserverMock.instances.push(this);
  }

  observe(target: Element, options?: ResizeObserverOptions) {
    this.observeMock(target, options);
  }

  unobserve(target: Element) {
    this.unobserveMock(target);
  }

  disconnect() {
    this.disconnectMock();
  }

  trigger() {
    this.callback([], this);
  }
}

function installAnimationFrameMocks() {
  animationFrameCallbacks = new Map();
  nextAnimationFrameId = 1;
  requestAnimationFrameMock = vi.fn((callback: FrameRequestCallback) => {
    const frameId = nextAnimationFrameId;
    nextAnimationFrameId += 1;
    animationFrameCallbacks.set(frameId, callback);
    return frameId;
  });
  cancelAnimationFrameMock = vi.fn((frameId: number) => {
    animationFrameCallbacks.delete(frameId);
  });

  vi.stubGlobal("requestAnimationFrame", requestAnimationFrameMock);
  vi.stubGlobal("cancelAnimationFrame", cancelAnimationFrameMock);
}

function flushAnimationFrames(frameCount: number) {
  for (let index = 0; index < frameCount; index += 1) {
    const frameCallbacks = [...animationFrameCallbacks.entries()];
    animationFrameCallbacks.clear();
    for (const [, callback] of frameCallbacks) {
      callback(window.performance.now());
    }
  }
}

function setScrollMetrics(element: HTMLElement, metrics: ScrollMetrics) {
  Object.defineProperty(element, "scrollHeight", {
    configurable: true,
    value: metrics.scrollHeight,
  });
  Object.defineProperty(element, "clientHeight", {
    configurable: true,
    value: metrics.clientHeight,
  });
  element.scrollTop = metrics.scrollTop;
}

function requireHTMLElement(element: Element | null) {
  if (!(element instanceof HTMLElement)) {
    throw new Error("Expected HTMLElement.");
  }
  return element;
}

function getResizeObserverInstance() {
  const instance = ResizeObserverMock.instances[0];
  if (!instance) {
    throw new Error("Expected ResizeObserver instance.");
  }
  return instance;
}

function BottomAnchorProbe() {
  const bottomAnchor = useBottomAnchoredScroll();
  return (
    <div>
      <output data-testid="bottom-state">
        {bottomAnchor
          ? bottomAnchor.isAtBottom
            ? "bottom"
            : "away"
          : "null"}
      </output>
      {bottomAnchor ? (
        <button type="button" onClick={bottomAnchor.scrollToBottom}>
          Scroll to bottom
        </button>
      ) : null}
    </div>
  );
}

function renderBody() {
  const view = render(
    <>
      <textarea aria-label="Prompt" />
      <BottomAnchoredScrollBody
        footer={<div data-testid="footer" />}
        maxWidthClassName="max-w-none"
        scrollAreaClassName="scroll-area"
        contentClassName="scroll-content"
      >
        <div>Timeline row</div>
        <BottomAnchorProbe />
      </BottomAnchoredScrollBody>
    </>,
  );

  return {
    scrollArea: requireHTMLElement(view.container.querySelector(".scroll-area")),
    content: requireHTMLElement(view.container.querySelector(".scroll-content")),
    unmount: view.unmount,
  };
}

beforeEach(() => {
  ResizeObserverMock.instances = [];
  vi.stubGlobal("ResizeObserver", ResizeObserverMock);
  installAnimationFrameMocks();
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("BottomAnchoredScrollBody", () => {
  it("returns null outside the provider", () => {
    render(<BottomAnchorProbe />);

    expect(screen.getByTestId("bottom-state").textContent).toBe("null");
  });

  it("keeps bottom state when non-bottom scroll is not user initiated", () => {
    const { scrollArea, content } = renderBody();
    setScrollMetrics(scrollArea, {
      scrollHeight: 1_000,
      clientHeight: 100,
      scrollTop: 400,
    });

    fireEvent.scroll(scrollArea);

    expect(screen.getByTestId("bottom-state").textContent).toBe("bottom");
    expect(content.classList.contains("scroll-bottom-anchor-content")).toBe(
      true,
    );
  });

  it("leaves bottom state only when non-bottom scroll follows user intent", () => {
    const { scrollArea, content } = renderBody();
    setScrollMetrics(scrollArea, {
      scrollHeight: 1_000,
      clientHeight: 100,
      scrollTop: 400,
    });

    fireEvent.wheel(scrollArea);
    fireEvent.scroll(scrollArea);

    expect(screen.getByTestId("bottom-state").textContent).toBe("away");
    expect(content.classList.contains("scroll-bottom-anchor-content")).toBe(
      false,
    );
  });

  it("ignores scroll-intent keys typed into editable controls", () => {
    const { scrollArea } = renderBody();
    const textarea = screen.getByRole("textbox", { name: "Prompt" });
    setScrollMetrics(scrollArea, {
      scrollHeight: 1_000,
      clientHeight: 100,
      scrollTop: 400,
    });

    fireEvent.keyDown(textarea, { key: "End" });
    fireEvent.scroll(scrollArea);

    expect(screen.getByTestId("bottom-state").textContent).toBe("bottom");
  });

  it("scrolls to the maximum offset and restores bottom state", () => {
    const { scrollArea } = renderBody();
    setScrollMetrics(scrollArea, {
      scrollHeight: 1_000,
      clientHeight: 100,
      scrollTop: 400,
    });
    fireEvent.wheel(scrollArea);
    fireEvent.scroll(scrollArea);

    fireEvent.click(screen.getByRole("button", { name: "Scroll to bottom" }));

    expect(scrollArea.scrollTop).toBe(900);
    expect(screen.getByTestId("bottom-state").textContent).toBe("bottom");
  });

  it("restores bottom after observed layout changes while sticking", () => {
    const { scrollArea } = renderBody();
    setScrollMetrics(scrollArea, {
      scrollHeight: 1_000,
      clientHeight: 100,
      scrollTop: 900,
    });
    flushAnimationFrames(1);
    setScrollMetrics(scrollArea, {
      scrollHeight: 1_200,
      clientHeight: 100,
      scrollTop: 900,
    });

    getResizeObserverInstance().trigger();
    flushAnimationFrames(1);

    expect(scrollArea.scrollTop).toBe(1_100);
  });

  it("disconnects observers, removes listeners, and cancels pending work", () => {
    const removeElementListenerSpy = vi.spyOn(
      HTMLElement.prototype,
      "removeEventListener",
    );
    const removeWindowListenerSpy = vi.spyOn(window, "removeEventListener");
    const { unmount } = renderBody();
    const observer = getResizeObserverInstance();

    unmount();

    expect(observer.disconnectMock).toHaveBeenCalledTimes(1);
    expect(removeElementListenerSpy).toHaveBeenCalledWith(
      "scroll",
      expect.any(Function),
    );
    expect(removeElementListenerSpy).toHaveBeenCalledWith(
      "wheel",
      expect.any(Function),
    );
    expect(removeElementListenerSpy).toHaveBeenCalledWith(
      "touchstart",
      expect.any(Function),
    );
    expect(removeElementListenerSpy).toHaveBeenCalledWith(
      "touchmove",
      expect.any(Function),
    );
    expect(removeElementListenerSpy).toHaveBeenCalledWith(
      "pointerdown",
      expect.any(Function),
    );
    expect(removeWindowListenerSpy).toHaveBeenCalledWith(
      "pointerup",
      expect.any(Function),
    );
    expect(removeWindowListenerSpy).toHaveBeenCalledWith(
      "pointercancel",
      expect.any(Function),
    );
    expect(removeWindowListenerSpy).toHaveBeenCalledWith(
      "keydown",
      expect.any(Function),
    );
    expect(cancelAnimationFrameMock).toHaveBeenCalled();
  });
});
