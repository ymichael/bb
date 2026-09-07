// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, renderHook } from "@testing-library/react";
import type { ReactNode } from "react";
import { BottomAnchorContext } from "@/components/ui/bottom-anchored-scroll-body.js";
import type { BottomAnchorContextValue } from "@/components/ui/bottom-anchored-scroll-body.js";
import { useAutoLoadOlderRows } from "./useAutoLoadOlderRows.js";

interface ObserverHandle {
  emit: (isIntersecting: boolean) => void;
}

let observers: ObserverHandle[] = [];

function installIntersectionObserverStub(): void {
  class ControllableIntersectionObserver {
    constructor(private readonly callback: IntersectionObserverCallback) {
      observers.push({
        emit: (isIntersecting: boolean) => {
          this.callback(
            [{ isIntersecting } as IntersectionObserverEntry],
            this as unknown as IntersectionObserver,
          );
        },
      });
    }
    observe(): void {}
    unobserve(): void {}
    disconnect(): void {}
    takeRecords(): IntersectionObserverEntry[] {
      return [];
    }
  }
  vi.stubGlobal("IntersectionObserver", ControllableIntersectionObserver);
}

function emitIntersection(isIntersecting: boolean): void {
  act(() => {
    for (const observer of observers) {
      observer.emit(isIntersecting);
    }
  });
}

function createBottomAnchor(
  scrollElement = document.createElement("div"),
): BottomAnchorContextValue {
  return {
    getScrollElement: () => scrollElement,
    isAtBottom: false,
    scrollToBottom: vi.fn(),
    scrollElementIntoView: vi.fn(),
    scrollElementIntoViewClampedToMaxScroll: vi.fn(),
    captureScrollAnchor: vi.fn(),
  };
}

function mockElementRect(
  element: HTMLElement,
  { bottom, top }: { bottom: number; top: number },
): void {
  vi.spyOn(element, "getBoundingClientRect").mockReturnValue({
    bottom,
    height: bottom - top,
    left: 0,
    right: 100,
    top,
    width: 100,
    x: 0,
    y: top,
    toJSON: () => ({}),
  });
}

function renderAutoLoad(args: {
  anchor: BottomAnchorContextValue | null;
  onLoadOlderRows: () => Promise<void> | void;
}) {
  const wrapper = ({ children }: { children: ReactNode }) =>
    args.anchor === null ? (
      <>{children}</>
    ) : (
      <BottomAnchorContext.Provider value={args.anchor}>
        {children}
      </BottomAnchorContext.Provider>
    );
  const result = renderHook(
    ({ isLoading }: { isLoading: boolean }) =>
      useAutoLoadOlderRows({
        hasOlderTimelineRows: true,
        isLoadingOlderTimelineRows: isLoading,
        onLoadOlderRows: args.onLoadOlderRows,
      }),
    { initialProps: { isLoading: false }, wrapper },
  );
  const sentinel = document.createElement("div");
  act(() => {
    result.result.current.sentinelRef(sentinel);
  });
  return { ...result, sentinel };
}

beforeEach(() => {
  observers = [];
  installIntersectionObserverStub();
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("useAutoLoadOlderRows", () => {
  it("loads the next page when the top of the window scrolls into view", async () => {
    const onLoadOlderRows = vi.fn(() => Promise.resolve());
    const anchor = createBottomAnchor();
    const { result } = renderAutoLoad({ anchor, onLoadOlderRows });

    expect(result.current.isAutoLoadEnabled).toBe(true);
    expect(onLoadOlderRows).not.toHaveBeenCalled();

    emitIntersection(true);

    expect(onLoadOlderRows).toHaveBeenCalledTimes(1);
    expect(anchor.captureScrollAnchor).toHaveBeenCalledTimes(1);
  });

  it("stays manual with no bottom anchor to keep the reading position", () => {
    const onLoadOlderRows = vi.fn(() => Promise.resolve());
    const { result } = renderAutoLoad({ anchor: null, onLoadOlderRows });

    expect(result.current.isAutoLoadEnabled).toBe(false);
    emitIntersection(true);
    expect(onLoadOlderRows).not.toHaveBeenCalled();

    act(() => {
      result.current.loadOlderRows();
    });
    expect(onLoadOlderRows).toHaveBeenCalledTimes(1);
  });

  it("keeps loading while the sentinel stays visible after a page settles", async () => {
    const onLoadOlderRows = vi.fn(() => Promise.resolve());
    const { rerender } = renderAutoLoad({
      anchor: createBottomAnchor(),
      onLoadOlderRows,
    });

    emitIntersection(true);
    expect(onLoadOlderRows).toHaveBeenCalledTimes(1);

    await act(async () => {
      rerender({ isLoading: true });
    });
    expect(onLoadOlderRows).toHaveBeenCalledTimes(1);

    await act(async () => {
      rerender({ isLoading: false });
    });
    expect(onLoadOlderRows).toHaveBeenCalledTimes(2);
  });

  it("does not recapture from stale intersection state after a prepend moves the sentinel away", async () => {
    const scrollElement = document.createElement("div");
    mockElementRect(scrollElement, { top: 0, bottom: 500 });
    const anchor = createBottomAnchor(scrollElement);
    const onLoadOlderRows = vi.fn(() => Promise.resolve());
    const { rerender, sentinel } = renderAutoLoad({
      anchor,
      onLoadOlderRows,
    });
    mockElementRect(sentinel, { top: 100, bottom: 120 });

    emitIntersection(true);
    expect(onLoadOlderRows).toHaveBeenCalledTimes(1);
    expect(anchor.captureScrollAnchor).toHaveBeenCalledTimes(1);

    await act(async () => {
      rerender({ isLoading: true });
    });
    mockElementRect(sentinel, { top: -800, bottom: -780 });
    await act(async () => {
      rerender({ isLoading: false });
    });

    expect(onLoadOlderRows).toHaveBeenCalledTimes(1);
    expect(anchor.captureScrollAnchor).toHaveBeenCalledTimes(1);
  });

  it("stops auto-loading after a failure instead of retrying in a loop", async () => {
    const onLoadOlderRows = vi.fn(() => Promise.reject(new Error("boom")));
    const { result, rerender } = renderAutoLoad({
      anchor: createBottomAnchor(),
      onLoadOlderRows,
    });

    emitIntersection(true);
    await act(async () => {});
    expect(onLoadOlderRows).toHaveBeenCalledTimes(1);
    expect(result.current.isAutoLoadEnabled).toBe(false);

    await act(async () => {
      rerender({ isLoading: false });
    });
    emitIntersection(true);
    await act(async () => {});
    expect(onLoadOlderRows).toHaveBeenCalledTimes(1);

    await act(async () => {
      result.current.loadOlderRows();
    });
    expect(onLoadOlderRows).toHaveBeenCalledTimes(2);
  });
});
