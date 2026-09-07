// @vitest-environment jsdom

import { cleanup, fireEvent, render } from "@testing-library/react";
import { getDefaultStore } from "jotai";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { BottomAnchoredScrollBody } from "@/components/ui/bottom-anchored-scroll-body";
import { threadTimelineScrollAnchorAtomFamily } from "@/lib/thread-timeline-scroll-anchor";

interface ScrollMetrics {
  scrollHeight: number;
  clientHeight: number;
  scrollTop: number;
}

const SCROLL_AREA_CLASS = "scroll-area";
const THREAD_ID = "settle-thread";

class ResizeObserverMock implements ResizeObserver {
  static instances: ResizeObserverMock[] = [];
  readonly callback: ResizeObserverCallback;
  constructor(callback: ResizeObserverCallback) {
    this.callback = callback;
    ResizeObserverMock.instances.push(this);
  }
  observe() {}
  unobserve() {}
  disconnect() {}
  trigger(entries: ResizeObserverEntry[] = []) {
    this.callback(entries, this);
  }
}

function getLatestResizeObserver(): ResizeObserverMock {
  const instance = ResizeObserverMock.instances.at(-1);
  if (!instance) throw new Error("Expected a ResizeObserver instance.");
  return instance;
}

interface ManualAnimationFrames {
  runFrame: () => void;
  hasPending: () => boolean;
}

function installManualAnimationFrames(): ManualAnimationFrames {
  let nextHandle = 1;
  const pending = new Map<number, FrameRequestCallback>();
  vi.stubGlobal(
    "requestAnimationFrame",
    vi.fn((callback: FrameRequestCallback) => {
      const handle = nextHandle;
      nextHandle += 1;
      pending.set(handle, callback);
      return handle;
    }),
  );
  vi.stubGlobal(
    "cancelAnimationFrame",
    vi.fn((handle: number) => {
      pending.delete(handle);
    }),
  );
  return {
    runFrame() {
      const callbacks = [...pending.values()];
      pending.clear();
      for (const callback of callbacks) {
        callback(window.performance.now());
      }
    },
    hasPending() {
      return pending.size > 0;
    },
  };
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

interface GeometryReadCounters {
  readScrollHeight: ReturnType<typeof vi.fn>;
  readClientHeight: ReturnType<typeof vi.fn>;
}

function installGeometryReadCounters(
  element: HTMLElement,
  metrics: Pick<ScrollMetrics, "scrollHeight" | "clientHeight">,
): GeometryReadCounters {
  const readScrollHeight = vi.fn(() => metrics.scrollHeight);
  const readClientHeight = vi.fn(() => metrics.clientHeight);
  Object.defineProperty(element, "scrollHeight", {
    configurable: true,
    get: readScrollHeight,
  });
  Object.defineProperty(element, "clientHeight", {
    configurable: true,
    get: readClientHeight,
  });
  return { readScrollHeight, readClientHeight };
}

interface ResizeEntryBoxes {
  contentBlockSize: number;
  borderBlockSize: number;
}

function makeResizeEntry(
  target: Element,
  boxes: ResizeEntryBoxes,
): ResizeObserverEntry {
  const contentBoxSize: ResizeObserverSize = {
    blockSize: boxes.contentBlockSize,
    inlineSize: 100,
  };
  const borderBoxSize: ResizeObserverSize = {
    blockSize: boxes.borderBlockSize,
    inlineSize: 100,
  };
  return {
    target,
    contentRect: new DOMRect(0, 0, 100, boxes.contentBlockSize),
    borderBoxSize: [borderBoxSize],
    contentBoxSize: [contentBoxSize],
    devicePixelContentBoxSize: [contentBoxSize],
  };
}

function requireHTMLElement(element: Element | null) {
  if (!(element instanceof HTMLElement)) {
    throw new Error("Expected HTMLElement.");
  }
  return element;
}

function renderScrollBody() {
  const view = render(
    <BottomAnchoredScrollBody
      footer={<div>Footer</div>}
      maxWidthClassName="max-w-none"
      scrollAreaClassName={SCROLL_AREA_CLASS}
      scrollAnchorThreadId={THREAD_ID}
    >
      <div data-timeline-row-id="row-a">row-a</div>
    </BottomAnchoredScrollBody>,
  );
  const scrollArea = requireHTMLElement(
    view.container.querySelector(`.${SCROLL_AREA_CLASS}`),
  );
  const scrollContent = requireHTMLElement(scrollArea.firstElementChild);
  return { scrollArea, scrollContent };
}

let frames: ManualAnimationFrames;

beforeEach(() => {
  ResizeObserverMock.instances = [];
  vi.stubGlobal("ResizeObserver", ResizeObserverMock);
  frames = installManualAnimationFrames();
});

afterEach(() => {
  cleanup();
  getDefaultStore().set(threadTimelineScrollAnchorAtomFamily(THREAD_ID), null);
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

function growContentWhilePinned() {
  const rendered = renderScrollBody();
  const { scrollArea } = rendered;
  setScrollMetrics(scrollArea, {
    scrollHeight: 400,
    clientHeight: 100,
    scrollTop: 300,
  });
  getLatestResizeObserver().trigger();
  frames.runFrame();

  setScrollMetrics(scrollArea, {
    scrollHeight: 500,
    clientHeight: 100,
    scrollTop: 300,
  });
  getLatestResizeObserver().trigger();
  expect(scrollArea.scrollTop).toBe(400);
  return rendered;
}

describe("BottomAnchoredScrollBody settle tail", () => {
  it("settles without re-reading geometry when the cached restore finds no drift", () => {
    const { scrollArea } = growContentWhilePinned();
    const { readScrollHeight, readClientHeight } = installGeometryReadCounters(
      scrollArea,
      { scrollHeight: 500, clientHeight: 100 },
    );

    frames.runFrame();
    expect(scrollArea.scrollTop).toBe(400);
    expect(readScrollHeight).not.toHaveBeenCalled();
    expect(readClientHeight).not.toHaveBeenCalled();
    expect(frames.hasPending()).toBe(false);
  });

  it("spends at most one live read when the settle tail corrects drift", () => {
    const { scrollArea } = growContentWhilePinned();
    scrollArea.scrollTop = 390;
    const { readScrollHeight, readClientHeight } = installGeometryReadCounters(
      scrollArea,
      { scrollHeight: 500, clientHeight: 100 },
    );

    frames.runFrame();
    expect(scrollArea.scrollTop).toBe(400);
    expect(readScrollHeight).not.toHaveBeenCalled();
    expect(readClientHeight).not.toHaveBeenCalled();

    frames.runFrame();
    expect(readScrollHeight).toHaveBeenCalledTimes(1);
    expect(readClientHeight).toHaveBeenCalledTimes(1);
    expect(scrollArea.scrollTop).toBe(400);

    frames.runFrame();
    expect(readScrollHeight).toHaveBeenCalledTimes(1);
    expect(readClientHeight).toHaveBeenCalledTimes(1);
    expect(frames.hasPending()).toBe(false);
  });

  it("derives the cached max offset from observed box sizes without forcing layout", () => {
    const { scrollArea, scrollContent } = renderScrollBody();
    setScrollMetrics(scrollArea, {
      scrollHeight: 400,
      clientHeight: 100,
      scrollTop: 300,
    });
    getLatestResizeObserver().trigger();
    frames.runFrame();

    scrollArea.scrollTop = 150;
    fireEvent.wheel(scrollArea);
    fireEvent.scroll(scrollArea);

    const liveMetrics = { scrollHeight: 900, clientHeight: 100 };
    const { readScrollHeight, readClientHeight } = installGeometryReadCounters(
      scrollArea,
      liveMetrics,
    );

    getLatestResizeObserver().trigger([
      makeResizeEntry(scrollArea, {
        contentBlockSize: 100,
        borderBlockSize: 108,
      }),
      makeResizeEntry(scrollContent, {
        contentBlockSize: 880,
        borderBlockSize: 900,
      }),
    ]);
    expect(readScrollHeight).not.toHaveBeenCalled();
    expect(readClientHeight).not.toHaveBeenCalled();

    scrollArea.scrollTop = 790;
    fireEvent.scroll(scrollArea);
    liveMetrics.scrollHeight = 950;
    getLatestResizeObserver().trigger([
      makeResizeEntry(scrollArea, {
        contentBlockSize: 100,
        borderBlockSize: 108,
      }),
      makeResizeEntry(scrollContent, {
        contentBlockSize: 930,
        borderBlockSize: 950,
      }),
    ]);
    expect(scrollArea.scrollTop).toBe(790);
    expect(readScrollHeight).not.toHaveBeenCalled();
    expect(readClientHeight).not.toHaveBeenCalled();

    scrollArea.scrollTop = 847;
    fireEvent.scroll(scrollArea);
    expect(readScrollHeight).not.toHaveBeenCalled();
    expect(readClientHeight).not.toHaveBeenCalled();

    liveMetrics.scrollHeight = 1_000;
    getLatestResizeObserver().trigger([
      makeResizeEntry(scrollArea, {
        contentBlockSize: 100,
        borderBlockSize: 108,
      }),
      makeResizeEntry(scrollContent, {
        contentBlockSize: 980,
        borderBlockSize: 1_000,
      }),
    ]);
    expect(scrollArea.scrollTop).toBe(900);
  });
});
