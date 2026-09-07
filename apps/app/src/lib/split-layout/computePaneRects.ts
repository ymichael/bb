import type { LayoutNode } from "./types";

export interface PaneRect {
  x: number;
  y: number;
  w: number;
  h: number;
}

const FULL_RECT: PaneRect = { x: 0, y: 0, w: 1, h: 1 };

export function computePaneRects(root: LayoutNode): Map<string, PaneRect> {
  const rects = new Map<string, PaneRect>();
  collectPaneRects(root, FULL_RECT, rects);
  return rects;
}

function collectPaneRects(
  node: LayoutNode,
  rect: PaneRect,
  out: Map<string, PaneRect>,
): void {
  if (node.type === "pane") {
    out.set(node.paneId, rect);
    return;
  }
  const childCount = node.children.length;
  const total = node.sizes.reduce((sum, size) => sum + size, 0);
  const usableTotal = Number.isFinite(total) && total > 0 ? total : childCount;
  let offset = 0;
  node.children.forEach((child, index) => {
    const size = node.sizes[index];
    const fraction =
      usableTotal > 0 && size !== undefined && size > 0
        ? size / usableTotal
        : childCount > 0
          ? 1 / childCount
          : 1;
    const childRect: PaneRect =
      node.dir === "row"
        ? {
            x: rect.x + rect.w * offset,
            y: rect.y,
            w: rect.w * fraction,
            h: rect.h,
          }
        : {
            x: rect.x,
            y: rect.y + rect.h * offset,
            w: rect.w,
            h: rect.h * fraction,
          };
    collectPaneRects(child, childRect, out);
    offset += fraction;
  });
}
