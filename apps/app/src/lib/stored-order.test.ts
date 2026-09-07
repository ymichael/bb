import { describe, expect, it } from "vitest";
import {
  arrangeByStoredOrder,
  haveSameOrder,
  reorderStoredOrder,
} from "./stored-order";

const getId = (item: { id: string }) => item.id;

describe("arrangeByStoredOrder", () => {
  it("keeps registration order before anything has been reordered", () => {
    const { ordered, normalizedOrder } = arrangeByStoredOrder({
      items: [{ id: "browser" }, { id: "terminal" }],
      getId,
      storedOrder: [],
    });

    expect(ordered.map(getId)).toEqual(["browser", "terminal"]);
    expect(normalizedOrder).toEqual(["browser", "terminal"]);
  });

  it("appends items that appeared after the user customized the order", () => {
    const { ordered } = arrangeByStoredOrder({
      items: [{ id: "browser" }, { id: "terminal" }, { id: "side-chat" }],
      getId,
      storedOrder: ["terminal", "browser"],
    });

    expect(ordered.map(getId)).toEqual(["terminal", "browser", "side-chat"]);
  });

  it("keeps the slot of an absent item so its position survives a reload", () => {
    const { ordered, normalizedOrder } = arrangeByStoredOrder({
      items: [{ id: "browser" }, { id: "terminal" }],
      getId,
      storedOrder: ["side-chat", "terminal", "browser"],
    });

    expect(ordered.map(getId)).toEqual(["terminal", "browser"]);
    expect(normalizedOrder).toEqual(["side-chat", "terminal", "browser"]);
  });

  it("drops duplicate stored ids", () => {
    const { ordered, normalizedOrder } = arrangeByStoredOrder({
      items: [{ id: "browser" }],
      getId,
      storedOrder: ["browser", "browser"],
    });

    expect(ordered.map(getId)).toEqual(["browser"]);
    expect(normalizedOrder).toEqual(["browser"]);
  });
});

describe("reorderStoredOrder", () => {
  it("moves an item onto its drop target", () => {
    expect(
      reorderStoredOrder({
        activeId: "terminal",
        overId: "browser",
        order: ["browser", "terminal", "side-chat"],
        visibleIds: ["browser", "terminal", "side-chat"],
      }),
    ).toEqual(["terminal", "browser", "side-chat"]);
  });

  it("leaves absent items pinned to their slot while visible items move", () => {
    expect(
      reorderStoredOrder({
        activeId: "side-chat",
        overId: "browser",
        order: ["browser", "quickstart", "side-chat"],
        visibleIds: ["browser", "side-chat"],
      }),
    ).toEqual(["side-chat", "quickstart", "browser"]);
  });

  it("declines a drag that ends where it started or outside the list", () => {
    expect(
      reorderStoredOrder({
        activeId: "browser",
        overId: "browser",
        order: ["browser", "terminal"],
        visibleIds: ["browser", "terminal"],
      }),
    ).toBeNull();
    expect(
      reorderStoredOrder({
        activeId: "browser",
        overId: "elsewhere",
        order: ["browser", "terminal"],
        visibleIds: ["browser", "terminal"],
      }),
    ).toBeNull();
  });
});

describe("haveSameOrder", () => {
  it("compares by position, not membership", () => {
    expect(haveSameOrder(["a", "b"], ["a", "b"])).toBe(true);
    expect(haveSameOrder(["a", "b"], ["b", "a"])).toBe(false);
    expect(haveSameOrder(["a"], ["a", "b"])).toBe(false);
  });
});
