// @vitest-environment jsdom

import { act, cleanup, render } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ExpandablePanel } from "@/components/ui/disclosure";
import { observeSharedResize } from "./shared-resize-observer";

class ResizeObserverStub implements ResizeObserver {
  static instances: ResizeObserverStub[] = [];

  readonly observedTargets: Element[] = [];

  constructor(readonly callback: ResizeObserverCallback) {
    ResizeObserverStub.instances.push(this);
  }

  observe: ResizeObserver["observe"] = vi.fn((target: Element) => {
    this.observedTargets.push(target);
  });
  unobserve: ResizeObserver["unobserve"] = vi.fn();
  disconnect: ResizeObserver["disconnect"] = vi.fn();
}

afterEach(() => {
  ResizeObserverStub.instances.length = 0;
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

function lastObserver(): ResizeObserverStub {
  const observer = ResizeObserverStub.instances.at(-1);
  if (!observer) {
    throw new Error("No ResizeObserver was installed");
  }
  return observer;
}

function makeEntry(target: Element, blockSize: number): ResizeObserverEntry {
  return {
    target,
    contentRect: new DOMRect(0, 0, 200, blockSize),
    borderBoxSize: [{ blockSize, inlineSize: 200 }],
    contentBoxSize: [{ blockSize, inlineSize: 200 }],
    devicePixelContentBoxSize: [{ blockSize, inlineSize: 200 }],
  };
}

describe("observeSharedResize", () => {
  it("runs every registration's read before any write within a batch", () => {
    vi.stubGlobal("ResizeObserver", ResizeObserverStub);
    const order: string[] = [];
    const first = document.createElement("div");
    const second = document.createElement("div");
    const unobserveFirst = observeSharedResize(first, {
      read: () => {
        order.push("read:first");
        return "first";
      },
      write: (value) => order.push(`write:${value}`),
    });
    const unobserveSecond = observeSharedResize(second, {
      read: () => {
        order.push("read:second");
        return "second";
      },
      write: (value) => order.push(`write:${value}`),
    });

    expect(ResizeObserverStub.instances).toHaveLength(1);
    lastObserver().callback(
      [makeEntry(first, 10), makeEntry(second, 20)],
      lastObserver(),
    );

    expect(order).toEqual([
      "read:first",
      "read:second",
      "write:first",
      "write:second",
    ]);
    unobserveFirst();
    unobserveSecond();
  });

  it("re-syncs every registration when a synthetic batch carries no entries", () => {
    vi.stubGlobal("ResizeObserver", ResizeObserverStub);
    const order: string[] = [];
    const seenEntries: (ResizeObserverEntry | undefined)[] = [];
    const targets = [
      document.createElement("div"),
      document.createElement("div"),
    ];
    const unobservers = targets.map((target, index) =>
      observeSharedResize(target, {
        read: (entry) => {
          seenEntries.push(entry);
          order.push(`read:${index}`);
          return index;
        },
        write: (value) => order.push(`write:${value}`),
      }),
    );

    lastObserver().callback([], lastObserver());

    expect(order).toEqual(["read:0", "read:1", "write:0", "write:1"]);
    expect(seenEntries).toEqual([undefined, undefined]);
    for (const unobserve of unobservers) unobserve();
  });

  it("releases the shared observer once the last registration leaves", () => {
    vi.stubGlobal("ResizeObserver", ResizeObserverStub);
    const target = document.createElement("div");
    const phases = { read: () => null, write: () => {} };

    const unobserve = observeSharedResize(target, phases);
    const observer = lastObserver();
    expect(observer.observe).toHaveBeenCalledWith(target);

    unobserve();
    expect(observer.unobserve).toHaveBeenCalledWith(target);
    expect(observer.disconnect).toHaveBeenCalled();

    const unobserveAgain = observeSharedResize(target, phases);
    expect(ResizeObserverStub.instances).toHaveLength(2);
    unobserveAgain();
  });
});

describe("ExpandablePanel on the shared observer", () => {
  function renderTwoPanels() {
    return render(
      <>
        <ExpandablePanel
          isExpanded
          summaryContent="First tool call"
          headerToneClass="text-foreground"
          collapsedContent={<span>First summary</span>}
        >
          <span>First body</span>
        </ExpandablePanel>
        <ExpandablePanel
          isExpanded
          summaryContent="Second tool call"
          headerToneClass="text-foreground"
          collapsedContent={<span>Second summary</span>}
        >
          <span>Second body</span>
        </ExpandablePanel>
      </>,
    );
  }

  it("mounts many panels onto one observer and sizes each from its own entry", () => {
    vi.stubGlobal("ResizeObserver", ResizeObserverStub);
    const view = renderTwoPanels();

    expect(ResizeObserverStub.instances).toHaveLength(1);
    expect(lastObserver().observedTargets).toHaveLength(2);

    const regionOf = (text: string) => {
      const region =
        view.getByText(text).parentElement?.parentElement?.parentElement;
      if (!region) {
        throw new Error("Panel body region was not rendered");
      }
      return region;
    };
    const firstRegion = regionOf("First body");
    const secondRegion = regionOf("Second body");
    const [firstTarget, secondTarget] = lastObserver().observedTargets;
    if (!firstTarget || !secondTarget) {
      throw new Error("Panel bodies were not observed");
    }

    act(() => {
      lastObserver().callback(
        [makeEntry(firstTarget, 40), makeEntry(secondTarget, 60)],
        lastObserver(),
      );
    });

    expect(firstRegion.style.height).toBe("40px");
    expect(secondRegion.style.height).toBe("60px");
  });
});
