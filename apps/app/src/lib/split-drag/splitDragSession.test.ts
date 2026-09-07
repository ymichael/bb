// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { beginSplitDrag, type SplitDragConfig } from "./splitDragSession";
import { decideThreadDrop, shouldEngageSidebarSplitDrag } from "./zones";

function fakeRect(
  left: number,
  top: number,
  width: number,
  height: number,
): DOMRect {
  return {
    left,
    top,
    width,
    height,
    right: left + width,
    bottom: top + height,
    x: left,
    y: top,
    toJSON: () => ({}),
  } as DOMRect;
}

function fireWindowPointer(type: string, x: number, y: number): void {
  window.dispatchEvent(
    new MouseEvent(type, {
      clientX: x,
      clientY: y,
      bubbles: true,
      cancelable: true,
    }),
  );
}

const SIDEBAR_RIGHT = 248;
const PANE_RECT = fakeRect(300, 0, 900, 800);

describe("beginSplitDrag — sidebar gesture arbitration and fallback", () => {
  let paneEl: HTMLElement;
  let escapeKeydowns: number;
  let escapeListener: (event: KeyboardEvent) => void;
  let originalElementsFromPoint: typeof document.elementsFromPoint;

  beforeEach(() => {
    paneEl = document.createElement("div");
    paneEl.setAttribute("data-split-pane-id", "pane-1");
    Object.defineProperty(paneEl, "getBoundingClientRect", {
      value: () => PANE_RECT,
      configurable: true,
    });
    document.body.append(paneEl);
    originalElementsFromPoint = document.elementsFromPoint;
    document.elementsFromPoint = vi.fn((x: number, y: number) =>
      x >= PANE_RECT.left &&
      x <= PANE_RECT.right &&
      y >= PANE_RECT.top &&
      y <= PANE_RECT.bottom
        ? [paneEl]
        : [],
    ) as typeof document.elementsFromPoint;

    escapeKeydowns = 0;
    escapeListener = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        escapeKeydowns += 1;
      }
    };
    document.addEventListener("keydown", escapeListener);
  });

  afterEach(() => {
    document.removeEventListener("keydown", escapeListener);
    paneEl.remove();
    document.elementsFromPoint = originalElementsFromPoint;
  });

  function baseConfig(
    overrides: Partial<SplitDragConfig> = {},
  ): SplitDragConfig {
    return {
      ghostLabel: "Thread",
      cancelSidebarReorderOnEngage: true,
      shouldEngage: (x, y) =>
        shouldEngageSidebarSplitDrag({
          startX: 20,
          startY: 300,
          x,
          y,
          sidebarRightEdge: SIDEBAR_RIGHT,
        }),
      decide: (_paneId, zone) =>
        decideThreadDrop({
          zone,
          threadAlreadyOpen: false,
          atMaxPanes: false,
        }),
      onDrop: vi.fn(),
      ...overrides,
    };
  }

  it("horizontal tear-out engages, cancels the reorder, and drops a split", () => {
    const onEngage = vi.fn();
    const onEnd = vi.fn();
    const config = baseConfig({ onEngage, onEnd });
    beginSplitDrag(config);

    fireWindowPointer("pointermove", 30, 302);
    expect(escapeKeydowns).toBe(0);
    expect(config.onDrop).not.toHaveBeenCalled();

    fireWindowPointer("pointermove", 900, 400);
    expect(escapeKeydowns).toBe(1);
    expect(onEngage).toHaveBeenCalledTimes(1);

    fireWindowPointer("pointermove", 1150, 400);
    fireWindowPointer("pointerup", 1150, 400);

    expect(config.onDrop).toHaveBeenCalledTimes(1);
    expect(config.onDrop).toHaveBeenCalledWith({
      paneId: "pane-1",
      zone: "right",
    });
    expect(onEnd).toHaveBeenCalledWith({ dropped: true });
  });

  it("a vertical in-sidebar drag never engages: reorder is untouched, no drop", () => {
    const config = baseConfig();
    beginSplitDrag(config);

    fireWindowPointer("pointermove", 24, 380);
    fireWindowPointer("pointermove", 26, 520);
    fireWindowPointer("pointerup", 26, 520);

    expect(escapeKeydowns).toBe(0);
    expect(config.onDrop).not.toHaveBeenCalled();
  });

  it("a plain click (press and release, no movement) does not drop", () => {
    const onEngage = vi.fn();
    const onEnd = vi.fn();
    const config = baseConfig({ onEngage, onEnd });
    beginSplitDrag(config);
    fireWindowPointer("pointerup", 20, 300);
    expect(config.onDrop).not.toHaveBeenCalled();
    expect(escapeKeydowns).toBe(0);
    expect(onEngage).not.toHaveBeenCalled();
    expect(onEnd).not.toHaveBeenCalled();
  });

  it("reports an engaged cancellation without a drop", () => {
    const onEngage = vi.fn();
    const onEnd = vi.fn();
    const config = baseConfig({ onEngage, onEnd });
    beginSplitDrag(config);

    fireWindowPointer("pointermove", 900, 400);
    fireWindowPointer("pointercancel", 900, 400);

    expect(onEngage).toHaveBeenCalledTimes(1);
    expect(config.onDrop).not.toHaveBeenCalled();
    expect(onEnd).toHaveBeenCalledWith({ dropped: false });
  });

  it("falls back to the container when no marked pane is under the pointer", () => {
    document.elementsFromPoint = vi.fn(
      () => [],
    ) as typeof document.elementsFromPoint;
    const container = document.createElement("main");
    Object.defineProperty(container, "getBoundingClientRect", {
      value: () => PANE_RECT,
      configurable: true,
    });
    document.body.append(container);

    const config = baseConfig({
      fallback: { paneId: "pane-1", container },
    });
    beginSplitDrag(config);
    fireWindowPointer("pointermove", 900, 400);
    fireWindowPointer("pointermove", 1150, 400);
    fireWindowPointer("pointerup", 1150, 400);

    expect(config.onDrop).toHaveBeenCalledWith({
      paneId: "pane-1",
      zone: "right",
    });
    container.remove();
  });

  it("rejects marked panes outside a supplied target boundary", () => {
    const boundary = document.createElement("aside");
    document.body.append(boundary);
    const config = baseConfig({ targetBoundary: boundary });

    beginSplitDrag(config);
    fireWindowPointer("pointermove", 900, 400);
    fireWindowPointer("pointerup", 900, 400);

    expect(config.onDrop).not.toHaveBeenCalled();
    boundary.remove();
  });

  it("accepts marked panes inside a supplied target boundary", () => {
    const boundary = document.createElement("aside");
    boundary.append(paneEl);
    document.body.append(boundary);
    const config = baseConfig({ targetBoundary: boundary });

    beginSplitDrag(config);
    fireWindowPointer("pointermove", 900, 400);
    fireWindowPointer("pointerup", 900, 400);

    expect(config.onDrop).toHaveBeenCalledWith({
      paneId: "pane-1",
      zone: "center",
    });
    boundary.remove();
  });

  it("preserves fallback targeting when its container is inside the boundary", () => {
    document.elementsFromPoint = vi.fn(
      () => [],
    ) as typeof document.elementsFromPoint;
    const boundary = document.createElement("aside");
    const container = document.createElement("main");
    Object.defineProperty(container, "getBoundingClientRect", {
      value: () => PANE_RECT,
      configurable: true,
    });
    boundary.append(container);
    document.body.append(boundary);
    const config = baseConfig({
      targetBoundary: boundary,
      fallback: { paneId: "pane-1", container },
    });

    beginSplitDrag(config);
    fireWindowPointer("pointermove", 900, 400);
    fireWindowPointer("pointermove", 1150, 400);
    fireWindowPointer("pointerup", 1150, 400);

    expect(config.onDrop).toHaveBeenCalledWith({
      paneId: "pane-1",
      zone: "right",
    });
    boundary.remove();
  });

  it("rejects a fallback target outside a supplied target boundary", () => {
    document.elementsFromPoint = vi.fn(
      () => [],
    ) as typeof document.elementsFromPoint;
    const boundary = document.createElement("aside");
    const container = document.createElement("main");
    Object.defineProperty(container, "getBoundingClientRect", {
      value: () => PANE_RECT,
      configurable: true,
    });
    document.body.append(boundary, container);
    const config = baseConfig({
      targetBoundary: boundary,
      fallback: { paneId: "pane-1", container },
    });

    beginSplitDrag(config);
    fireWindowPointer("pointermove", 900, 400);
    fireWindowPointer("pointerup", 900, 400);

    expect(config.onDrop).not.toHaveBeenCalled();
    boundary.remove();
    container.remove();
  });
});
