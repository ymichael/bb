import { describe, expect, it } from "vitest";
import {
  decidePaneDrop,
  decideThreadDrop,
  pickZone,
  shouldEngageSidebarSplitDrag,
  zoneBox,
  type Rect,
} from "./zones";

const RECT: Rect = { left: 100, top: 200, width: 400, height: 300 };

function at(fx: number, fy: number): [number, number] {
  return [RECT.left + fx * RECT.width, RECT.top + fy * RECT.height];
}

describe("pickZone", () => {
  it("classifies the outer horizontal bands as left/right", () => {
    expect(pickZone(RECT, ...at(0.1, 0.5))).toBe("left");
    expect(pickZone(RECT, ...at(0.9, 0.5))).toBe("right");
  });

  it("classifies the outer vertical bands as top/bottom in the middle column", () => {
    expect(pickZone(RECT, ...at(0.5, 0.1))).toBe("top");
    expect(pickZone(RECT, ...at(0.5, 0.9))).toBe("bottom");
  });

  it("classifies the middle as center", () => {
    expect(pickZone(RECT, ...at(0.5, 0.5))).toBe("center");
  });

  it("prefers left/right over top/bottom in the shared corner region", () => {
    expect(pickZone(RECT, ...at(0.1, 0.1))).toBe("left");
  });

  it("respects the exact edge thresholds", () => {
    expect(pickZone(RECT, ...at(0.27, 0.5))).toBe("left");
    expect(pickZone(RECT, ...at(0.29, 0.5))).toBe("center");
    expect(pickZone(RECT, ...at(0.5, 0.29))).toBe("top");
    expect(pickZone(RECT, ...at(0.5, 0.31))).toBe("center");
  });

  it("falls back to center for a degenerate rect", () => {
    expect(pickZone({ left: 0, top: 0, width: 0, height: 0 }, 0, 0)).toBe(
      "center",
    );
  });
});

describe("zoneBox", () => {
  it("keeps the highlighted region inside the pane rect", () => {
    for (const zone of ["left", "right", "top", "bottom", "center"] as const) {
      const box = zoneBox(RECT, zone);
      expect(box.left).toBeGreaterThanOrEqual(RECT.left);
      expect(box.top).toBeGreaterThanOrEqual(RECT.top);
      expect(box.left + box.width).toBeLessThanOrEqual(
        RECT.left + RECT.width + 1e-6,
      );
      expect(box.top + box.height).toBeLessThanOrEqual(
        RECT.top + RECT.height + 1e-6,
      );
    }
  });

  it("places the right box in the pane's right half", () => {
    const box = zoneBox(RECT, "right");
    expect(box.left).toBeCloseTo(RECT.left + RECT.width / 2, 6);
  });
});

describe("decideThreadDrop", () => {
  it("passes an edge zone through as a split when there is room", () => {
    expect(
      decideThreadDrop({
        zone: "left",
        threadAlreadyOpen: false,
        atMaxPanes: false,
      }),
    ).toEqual({ zone: "left", label: "Split left" });
  });

  it("labels a center zone as replace", () => {
    expect(
      decideThreadDrop({
        zone: "center",
        threadAlreadyOpen: false,
        atMaxPanes: false,
      }),
    ).toEqual({ zone: "center", label: "Replace this chat" });
  });

  it("coerces edges to center-replace at the pane cap", () => {
    expect(
      decideThreadDrop({
        zone: "top",
        threadAlreadyOpen: false,
        atMaxPanes: true,
      }),
    ).toEqual({ zone: "center", label: "Replace this chat" });
  });

  it("coerces to focus-pane when the thread is already open, overriding the cap", () => {
    expect(
      decideThreadDrop({
        zone: "right",
        threadAlreadyOpen: true,
        atMaxPanes: true,
      }),
    ).toEqual({ zone: "center", label: "Already open — focus pane" });
  });
});

describe("decidePaneDrop", () => {
  it("is a no-op over itself", () => {
    expect(decidePaneDrop({ zone: "center", isSelf: true })).toBeNull();
    expect(decidePaneDrop({ zone: "left", isSelf: true })).toBeNull();
  });

  it("swaps on center and moves on an edge", () => {
    expect(decidePaneDrop({ zone: "center", isSelf: false })).toEqual({
      zone: "center",
      label: "Swap chats",
    });
    expect(decidePaneDrop({ zone: "bottom", isSelf: false })).toEqual({
      zone: "bottom",
      label: "Move bottom",
    });
  });
});

describe("shouldEngageSidebarSplitDrag", () => {
  const base = { startX: 20, startY: 300, sidebarRightEdge: 248 };

  it("does not engage while the pointer is still inside the sidebar", () => {
    expect(shouldEngageSidebarSplitDrag({ ...base, x: 200, y: 340 })).toBe(
      false,
    );
  });

  it("engages once the pointer crosses the edge moving mostly horizontally", () => {
    expect(shouldEngageSidebarSplitDrag({ ...base, x: 300, y: 320 })).toBe(
      true,
    );
  });

  it("lets reorder win on a mostly-vertical drag even past the edge", () => {
    expect(shouldEngageSidebarSplitDrag({ ...base, x: 288, y: 700 })).toBe(
      false,
    );
  });

  it("requires travel beyond the activation distance even just past the edge", () => {
    expect(
      shouldEngageSidebarSplitDrag({
        startX: 245,
        startY: 300,
        sidebarRightEdge: 248,
        x: 250,
        y: 301,
        distance: 12,
      }),
    ).toBe(false);
  });
});
