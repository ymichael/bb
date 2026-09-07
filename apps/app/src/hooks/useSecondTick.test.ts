// @vitest-environment jsdom

import { act, renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useSecondTick } from "./useSecondTick";

function setDocumentVisibility(state: "hidden" | "visible"): void {
  Object.defineProperty(document, "visibilityState", {
    configurable: true,
    value: state,
  });
  document.dispatchEvent(new Event("visibilitychange"));
}

describe("useSecondTick", () => {
  afterEach(() => {
    vi.useRealTimers();
    Reflect.deleteProperty(document, "visibilityState");
  });

  it("pauses the shared ticker while hidden and jumps to now on resume", () => {
    vi.useFakeTimers();
    const { result, unmount } = renderHook(() => useSecondTick());
    const initial = result.current;

    act(() => {
      vi.advanceTimersByTime(1_000);
    });
    expect(result.current).toBe(initial + 1_000);

    act(() => {
      setDocumentVisibility("hidden");
    });
    act(() => {
      vi.advanceTimersByTime(5_000);
    });
    expect(result.current).toBe(initial + 1_000);

    act(() => {
      setDocumentVisibility("visible");
    });
    expect(result.current).toBe(initial + 6_000);

    act(() => {
      vi.advanceTimersByTime(1_000);
    });
    expect(result.current).toBe(initial + 7_000);

    unmount();
  });

  it("shares one interval across subscribers and stops with the last one", () => {
    vi.useFakeTimers();
    const first = renderHook(() => useSecondTick());
    const second = renderHook(() => useSecondTick());

    act(() => {
      vi.advanceTimersByTime(1_000);
    });
    expect(first.result.current).toBe(second.result.current);

    first.unmount();
    second.unmount();
    expect(vi.getTimerCount()).toBe(0);
  });
});
