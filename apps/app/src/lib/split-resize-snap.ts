import { clampSplitPairFraction } from "@/lib/split-layout";

export type SplitResizeAxis = "x" | "y";

export const SPLIT_RESIZE_SNAP_CAPTURE_PX = 12;
export const SPLIT_RESIZE_SNAP_RELEASE_PX = 30;

interface ResolveSplitResizePositionArgs {
  end: number;
  pointer: number;
  start: number;
}

export interface ResolvedSplitResizePosition {
  coordinate: number;
  fraction: number;
  snapped: boolean;
}

export interface SplitResizeSnapSession {
  clear: () => void;
  resolve: (
    args: ResolveSplitResizePositionArgs,
  ) => ResolvedSplitResizePosition;
}

export interface SplitResizeGridTarget {
  boundaryIndex: number;
  childCount: number;
}

function createGuide(
  document: Document,
  axis: SplitResizeAxis,
  coordinate: number,
  gridRect: DOMRect,
): HTMLElement {
  const guide = document.createElement("div");
  guide.setAttribute("aria-hidden", "true");
  guide.dataset.splitResizeSnapGuide = axis;
  guide.className =
    axis === "x"
      ? "pointer-events-none fixed z-[100] w-px -translate-x-1/2 bg-ring/50"
      : "pointer-events-none fixed z-[100] h-px -translate-y-1/2 bg-ring/50";
  if (axis === "x") {
    guide.style.height = `${gridRect.height}px`;
    guide.style.left = `${coordinate}px`;
    guide.style.top = `${gridRect.top}px`;
  } else {
    guide.style.left = `${gridRect.left}px`;
    guide.style.top = `${coordinate}px`;
    guide.style.width = `${gridRect.width}px`;
  }
  document.body.appendChild(guide);
  return guide;
}

function axisExtent(rect: DOMRect, axis: SplitResizeAxis): number {
  return axis === "x" ? rect.width : rect.height;
}

function equalGridCoordinate(
  gridRect: DOMRect,
  axis: SplitResizeAxis,
  dividerExtent: number,
  target: SplitResizeGridTarget,
): number | null {
  const { boundaryIndex, childCount } = target;
  if (
    !Number.isInteger(boundaryIndex) ||
    !Number.isInteger(childCount) ||
    childCount < 2 ||
    boundaryIndex < 1 ||
    boundaryIndex >= childCount
  ) {
    return null;
  }
  const span = axisExtent(gridRect, axis);
  const contentSpan = span - dividerExtent * (childCount - 1);
  if (contentSpan <= 0) return null;
  const start = axis === "x" ? gridRect.left : gridRect.top;
  return (
    start +
    (contentSpan * boundaryIndex) / childCount +
    dividerExtent * (boundaryIndex - 0.5)
  );
}

export function createSplitResizeSnapSession(
  divider: HTMLElement,
  axis: SplitResizeAxis,
  target: SplitResizeGridTarget,
): SplitResizeSnapSession {
  let guide: HTMLElement | null = null;
  let fastCrossingAnchor: number | null = null;
  let lastPointer: number | null = null;
  let releasePending = false;
  let snapped = false;
  const grid = divider.closest<HTMLElement>("[data-split-resize-grid-root]");
  const gridRect = grid?.getBoundingClientRect() ?? null;
  const extent = axisExtent(divider.getBoundingClientRect(), axis);
  const gridCoordinate =
    gridRect === null
      ? null
      : equalGridCoordinate(gridRect, axis, extent, target);

  const clear = () => {
    guide?.remove();
    guide = null;
    fastCrossingAnchor = null;
    lastPointer = null;
    releasePending = false;
    snapped = false;
  };

  const showGuide = (coordinate: number) => {
    if (gridRect === null) return;
    guide ??= createGuide(divider.ownerDocument, axis, coordinate, gridRect);
    if (axis === "x") guide.style.left = `${coordinate}px`;
    else guide.style.top = `${coordinate}px`;
  };

  const hideGuide = () => {
    guide?.remove();
    guide = null;
  };

  return {
    clear,
    resolve: ({ end, pointer, start }) => {
      const span = end - start;
      const unsnappedFraction = clampSplitPairFraction(
        span > 0 ? (pointer - start) / span : 0.5,
      );
      const previousPointer = lastPointer;
      lastPointer = pointer;
      const contentSpan = span - extent;
      if (gridCoordinate === null || contentSpan <= 0) {
        releasePending = false;
        snapped = false;
        hideGuide();
        return {
          coordinate: start + span * unsnappedFraction,
          fraction: unsnappedFraction,
          snapped: false,
        };
      }

      const fraction = clampSplitPairFraction(
        (gridCoordinate - start - extent / 2) / contentSpan,
      );
      const coordinate = start + contentSpan * fraction + extent / 2;
      const reachable = Math.abs(coordinate - gridCoordinate) <= 0.01;
      const distance = Math.abs(pointer - gridCoordinate);
      const previousDelta =
        previousPointer === null ? null : previousPointer - gridCoordinate;
      const pointerDelta = pointer - gridCoordinate;
      const crossedGrid =
        previousDelta !== null &&
        ((previousDelta < 0 && pointerDelta >= 0) ||
          (previousDelta > 0 && pointerDelta <= 0));
      let shouldSnap = false;
      if (reachable) {
        if (distance <= SPLIT_RESIZE_SNAP_CAPTURE_PX) {
          fastCrossingAnchor = null;
          releasePending = false;
          shouldSnap = true;
        } else if (crossedGrid) {
          fastCrossingAnchor =
            distance > SPLIT_RESIZE_SNAP_RELEASE_PX ? pointer : null;
          releasePending = false;
          shouldSnap = true;
        } else if (snapped) {
          if (distance <= SPLIT_RESIZE_SNAP_RELEASE_PX) {
            fastCrossingAnchor = null;
            releasePending = false;
            shouldSnap = true;
          } else if (
            fastCrossingAnchor !== null &&
            Math.abs(pointer - fastCrossingAnchor) <=
              SPLIT_RESIZE_SNAP_RELEASE_PX
          ) {
            releasePending = false;
            shouldSnap = true;
          } else if (!releasePending) {
            releasePending = true;
            shouldSnap = true;
          }
        }
      }
      if (!shouldSnap) {
        fastCrossingAnchor = null;
        releasePending = false;
        snapped = false;
        hideGuide();
        return {
          coordinate: start + span * unsnappedFraction,
          fraction: unsnappedFraction,
          snapped: false,
        };
      }

      snapped = true;
      showGuide(coordinate);
      return { coordinate, fraction, snapped: true };
    },
  };
}
