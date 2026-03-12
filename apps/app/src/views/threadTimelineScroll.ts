export const TIMELINE_SCROLL_PRESERVE_THRESHOLD_PX = 40;

export function calculateComposerResizeScrollTop({
  clientHeight,
  currentScrollTop,
  heightDelta,
  isStickingToBottom,
  scrollHeight,
  threshold = TIMELINE_SCROLL_PRESERVE_THRESHOLD_PX,
}: {
  clientHeight: number;
  currentScrollTop: number;
  heightDelta: number;
  isStickingToBottom: boolean;
  scrollHeight: number;
  threshold?: number;
}): number {
  if (isStickingToBottom) {
    return scrollHeight;
  }

  const maxScrollOffset = scrollHeight - clientHeight;
  const distanceFromBottom = maxScrollOffset - currentScrollTop;
  if (distanceFromBottom <= threshold) {
    return scrollHeight;
  }

  return currentScrollTop + heightDelta;
}

export function shouldRestoreScrollAnchorForWidthChange({
  anchorExists,
  nextWidth,
  previousWidth,
}: {
  anchorExists: boolean;
  nextWidth: number;
  previousWidth: number | null;
}): boolean {
  if (!anchorExists || previousWidth === null) {
    return false;
  }

  return Math.abs(nextWidth - previousWidth) >= 0.5;
}
