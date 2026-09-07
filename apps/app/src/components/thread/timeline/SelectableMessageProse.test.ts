import { describe, expect, it } from "vitest";
import {
  isSelectionWithinNode,
  selectionAnchorFromPointerRelease,
} from "./SelectableMessageProse.js";

class FakeNode {
  descendants = new Set<FakeNode>();
  contains(other: unknown): boolean {
    if (other === this) return true;
    return this.descendants.has(other as FakeNode);
  }
}

function makeProse() {
  const node = new FakeNode();
  const inside = new FakeNode();
  const alsoInside = new FakeNode();
  node.descendants.add(inside);
  node.descendants.add(alsoInside);
  return { node, inside, alsoInside, outside: new FakeNode() };
}

describe("isSelectionWithinNode", () => {
  it("rejects a collapsed selection", () => {
    const { node, inside } = makeProse();
    expect(
      isSelectionWithinNode(node as unknown as Node, {
        isCollapsed: true,
        anchorNode: inside as unknown as Node,
        focusNode: inside as unknown as Node,
        commonAncestorContainer: inside as unknown as Node,
      }),
    ).toBe(false);
  });

  it("rejects a selection with an endpoint outside the node", () => {
    const { node, inside, outside } = makeProse();
    expect(
      isSelectionWithinNode(node as unknown as Node, {
        isCollapsed: false,
        anchorNode: inside as unknown as Node,
        focusNode: outside as unknown as Node,
        commonAncestorContainer: outside as unknown as Node,
      }),
    ).toBe(false);
  });

  it("accepts an in-bounds non-empty selection", () => {
    const { node, inside, alsoInside } = makeProse();
    expect(
      isSelectionWithinNode(node as unknown as Node, {
        isCollapsed: false,
        anchorNode: inside as unknown as Node,
        focusNode: alsoInside as unknown as Node,
        commonAncestorContainer: node as unknown as Node,
      }),
    ).toBe(true);
  });

  it("rejects a null node or null selection", () => {
    expect(isSelectionWithinNode(null, null)).toBe(false);
  });
});

describe("selectionAnchorFromPointerRelease", () => {
  it("uses the live range instead of a stale touch release point", () => {
    expect(
      selectionAnchorFromPointerRelease(
        { x: 10, y: 20 },
        { clientX: 30, clientY: 40, pointerType: "touch" },
      ),
    ).toBeNull();
  });

  it("keeps mouse release anchoring", () => {
    expect(
      selectionAnchorFromPointerRelease(
        { x: 10, y: 20 },
        { clientX: 30, clientY: 40, pointerType: "mouse" },
      ),
    ).toEqual({ point: { x: 30, y: 40 }, side: "bottom" });
  });
});
