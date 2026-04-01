import { DEFAULT_SCROLL_STICK_THRESHOLD_PX } from "@bb/ui-core";

export type TimelineScrollMode = "pinned_bottom" | "reading_history";

export interface TimelineScrollAnchor {
  rowId: string;
  offsetTop: number;
}

export interface TimelineScrollSnapshot {
  scrollHeight: number;
  scrollTop: number;
  clientHeight: number;
}

export interface TimelineViewportRow {
  rowId: string;
  top: number;
  bottom: number;
}

export interface TimelineViewportSnapshot extends TimelineScrollSnapshot {
  containerTop: number;
  rows: TimelineViewportRow[];
}

export interface TimelineContainerSize {
  width: number;
  height: number;
}

export interface ToolGroupLoadState {
  cachedMessageCount: number;
  inlineMessageCount: number;
  isLoading: boolean;
  threadId?: string;
}

function getDistanceFromBottom(snapshot: TimelineScrollSnapshot): number {
  return snapshot.scrollHeight - snapshot.scrollTop - snapshot.clientHeight;
}

export function isTimelineNearBottom(
  snapshot: TimelineScrollSnapshot,
): boolean {
  return getDistanceFromBottom(snapshot) <= DEFAULT_SCROLL_STICK_THRESHOLD_PX;
}

export function shouldShowTimelineScrollToBottom(
  snapshot: TimelineScrollSnapshot,
): boolean {
  const maxScrollOffset = snapshot.scrollHeight - snapshot.clientHeight;
  if (maxScrollOffset <= DEFAULT_SCROLL_STICK_THRESHOLD_PX) {
    return false;
  }

  return !isTimelineNearBottom(snapshot);
}

export function captureTimelineScrollAnchorFromViewport({
  clientHeight,
  containerTop,
  rows,
  scrollHeight,
  scrollTop,
}: TimelineViewportSnapshot): TimelineScrollAnchor | null {
  if (
    isTimelineNearBottom({
      clientHeight,
      scrollHeight,
      scrollTop,
    })
  ) {
    return null;
  }

  for (const row of rows) {
    if (row.bottom <= containerTop + 1) {
      continue;
    }

    return {
      rowId: row.rowId,
      offsetTop: row.top - containerTop,
    };
  }

  return null;
}

export function getTimelineAnchorOffsetDelta(args: {
  anchor: TimelineScrollAnchor;
  containerTop: number;
  targetTop: number;
}): number {
  const offsetDelta =
    args.targetTop - args.containerTop - args.anchor.offsetTop;

  return Math.abs(offsetDelta) >= 0.5 ? offsetDelta : 0;
}

export function getScrollBottomTargetScrollTop(args: {
  clientHeight: number;
  containerTop: number;
  scrollTop: number;
  sentinelBottom: number;
}): number {
  const targetScrollTop =
    args.scrollTop +
    (args.sentinelBottom - args.containerTop) -
    args.clientHeight;

  return Math.max(0, targetScrollTop);
}

export function hasMeaningfulTimelineContainerResize(
  previous: TimelineContainerSize | null,
  next: TimelineContainerSize,
): boolean {
  if (!previous) {
    return false;
  }

  return (
    Math.abs(previous.width - next.width) >= 0.5 ||
    Math.abs(previous.height - next.height) >= 0.5
  );
}

export function hasMeaningfulComposerHeightChange(
  previousHeight: number | null,
  nextHeight: number,
): boolean {
  return previousHeight !== null && Math.abs(previousHeight - nextHeight) >= 0.5;
}

export function shouldLoadToolGroupMessages(
  state: ToolGroupLoadState,
): boolean {
  return (
    Boolean(state.threadId) &&
    state.inlineMessageCount === 0 &&
    state.cachedMessageCount === 0 &&
    !state.isLoading
  );
}
