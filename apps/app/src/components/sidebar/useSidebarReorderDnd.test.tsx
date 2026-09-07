// @vitest-environment jsdom

import { act, cleanup, renderHook } from "@testing-library/react";
import type {
  DragCancelEvent,
  DragEndEvent,
  DragStartEvent,
} from "@dnd-kit/core";
import { afterEach, describe, expect, it, vi } from "vitest";
import { COMPACT_VIEWPORT_QUERY } from "@bb/shared-ui/hooks/use-compact-viewport";
import { setCompactSidebarDrawerShowing } from "@/components/ui/sidebar-mobile-drawer-visibility";
import {
  SidebarTouchSensor,
  useSidebarReorderDnd,
} from "./useSidebarReorderDnd";

const DRAG_START_EVENT = { active: { id: "thread-1" } } as DragStartEvent;
const DRAG_END_EVENT = {
  active: { id: "thread-1" },
  over: { id: "thread-2" },
} as DragEndEvent;
const DRAG_CANCEL_EVENT = { active: { id: "thread-1" } } as DragCancelEvent;

afterEach(() => {
  cleanup();
  delete document.body.dataset.sidebarDragging;
});

describe("useSidebarReorderDnd", () => {
  it("marks the document as dragging until end, cancel, or unmount", () => {
    const onDragEnd = vi.fn();
    const { result, unmount } = renderHook(() =>
      useSidebarReorderDnd({ onDragEnd }),
    );

    act(() => result.current.dndContextProps.onDragStart?.(DRAG_START_EVENT));
    expect(document.body.dataset.sidebarDragging).toBe("true");

    act(() => result.current.dndContextProps.onDragCancel?.(DRAG_CANCEL_EVENT));
    expect(document.body.dataset.sidebarDragging).toBeUndefined();

    act(() => result.current.dndContextProps.onDragStart?.(DRAG_START_EVENT));
    act(() => result.current.dndContextProps.onDragEnd?.(DRAG_END_EVENT));
    expect(document.body.dataset.sidebarDragging).toBeUndefined();

    act(() => result.current.dndContextProps.onDragStart?.(DRAG_START_EVENT));
    unmount();
    expect(document.body.dataset.sidebarDragging).toBeUndefined();
  });

  it("clears app-owned drag state when Escape preempts dnd-kit cancellation", () => {
    const onDragCancel = vi.fn();
    const { result } = renderHook(() =>
      useSidebarReorderDnd({ onDragEnd: vi.fn(), onDragCancel }),
    );

    act(() => result.current.dndContextProps.onDragStart?.(DRAG_START_EVENT));
    expect(document.body.dataset.sidebarDragging).toBe("true");

    act(() => {
      document.dispatchEvent(
        new KeyboardEvent("keydown", {
          key: "Escape",
          code: "Escape",
          bubbles: true,
        }),
      );
    });

    expect(document.body.dataset.sidebarDragging).toBeUndefined();
    expect(onDragCancel).toHaveBeenCalledTimes(1);

    act(() => result.current.dndContextProps.onDragCancel?.(DRAG_CANCEL_EVENT));
    expect(onDragCancel).toHaveBeenCalledTimes(1);
  });
});

describe("SidebarTouchSensor", () => {
  function installMatchMedia(matches: boolean) {
    const listeners = new Set<() => void>();
    const mql = {
      matches,
      media: COMPACT_VIEWPORT_QUERY,
      addEventListener: (_type: string, listener: () => void) => {
        listeners.add(listener);
      },
      removeEventListener: (_type: string, listener: () => void) => {
        listeners.delete(listener);
      },
    };
    vi.stubGlobal(
      "matchMedia",
      vi.fn(() => mql),
    );
    return mql;
  }

  function touchMoveListenerCalls(spy: {
    mock: { calls: readonly (readonly unknown[])[] };
  }) {
    return spy.mock.calls.filter(([type]) => type === "touchmove");
  }

  afterEach(() => {
    setCompactSidebarDrawerShowing(false);
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("keeps the non-passive window touchmove listener off on compact viewports until the drawer shows", () => {
    installMatchMedia(true);
    const addSpy = vi.spyOn(window, "addEventListener");
    const removeSpy = vi.spyOn(window, "removeEventListener");

    const teardown = SidebarTouchSensor.setup();
    expect(touchMoveListenerCalls(addSpy)).toHaveLength(0);

    act(() => setCompactSidebarDrawerShowing(true));
    const installs = touchMoveListenerCalls(addSpy);
    expect(installs).toHaveLength(1);
    expect(installs[0]?.[2]).toEqual({ capture: false, passive: false });

    act(() => setCompactSidebarDrawerShowing(false));
    expect(touchMoveListenerCalls(removeSpy)).toHaveLength(1);

    teardown();
    expect(touchMoveListenerCalls(addSpy)).toHaveLength(1);
  });

  it("installs the listener immediately on wide viewports and removes it on teardown", () => {
    installMatchMedia(false);
    const addSpy = vi.spyOn(window, "addEventListener");
    const removeSpy = vi.spyOn(window, "removeEventListener");

    const teardown = SidebarTouchSensor.setup();
    expect(touchMoveListenerCalls(addSpy)).toHaveLength(1);

    teardown();
    expect(touchMoveListenerCalls(removeSpy)).toHaveLength(1);
  });
});
