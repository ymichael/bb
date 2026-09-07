import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import type { ReactNode } from "react";
import { useStore } from "jotai";
import { cn } from "@bb/shared-ui/lib/utils";
import { usePointerCoarse } from "@bb/shared-ui/hooks/use-pointer-coarse";
import { PAGE_SHELL_CONTENT_STYLE } from "./page-shell-content-style.js";
import { supportsScrollAnchoring } from "@/lib/scroll-anchoring-support";
import {
  threadTimelineScrollAnchorAtomFamily,
  type ScrollAnchor,
} from "@/lib/thread-timeline-scroll-anchor.js";

export interface BottomAnchorContextValue {
  getScrollElement: () => HTMLElement | null;
  isAtBottom: boolean;
  scrollToBottom: () => void;
  scrollElementIntoView: (args: ScrollElementIntoViewArgs) => void;
  scrollElementIntoViewClampedToMaxScroll: (
    args: ScrollElementIntoViewClampedToMaxScrollArgs,
  ) => void;
  captureScrollAnchor: () => void;
}

interface BottomAnchoredScrollBodyProps {
  children: ReactNode;
  footer: ReactNode;
  scrollOverlay?: ReactNode;
  scrollAreaClassName?: string;
  contentClassName?: string;
  maxWidthClassName: string;
  scrollAnchorThreadId?: string;
}

interface ScrollElementIntoViewArgs {
  element: HTMLElement;
  options?: ScrollIntoViewOptions;
}

interface ScrollElementIntoViewClampedToMaxScrollArgs {
  element: HTMLElement;
}

interface ElementVisibilityArgs {
  element: HTMLElement;
  scrollArea: HTMLElement;
}

const BOTTOM_ANCHOR_THRESHOLD_PX = 4;
const USER_SCROLL_INTENT_MS = 1_000;
const SCROLLBAR_IDLE_DELAY_MS = 600;
const BOTTOM_RESTORE_SETTLE_FRAME_COUNT = 3;
const SCROLL_ANCHOR_CAPTURE_THROTTLE_MS = 100;
const COARSE_SCROLL_ANCHOR_CAPTURE_THROTTLE_MS = 250;
const SCROLL_ANCHOR_RESTORE_MAX_ATTEMPTS = 8;
const TIMELINE_ROW_ID_SELECTOR = "[data-timeline-row-id]";
const TOP_LEVEL_TIMELINE_ROW_LIST_SELECTOR =
  '[data-timeline-row-list="top-level"]';
const TIMELINE_VIRTUAL_SPACER_SELECTOR =
  ":scope > [data-timeline-virtual-spacer]";
const DIRECT_TIMELINE_ROW_SELECTOR = [
  `:scope > ${TIMELINE_ROW_ID_SELECTOR}`,
  `${TIMELINE_VIRTUAL_SPACER_SELECTOR} > ${TIMELINE_ROW_ID_SELECTOR}`,
].join(", ");
const SCROLL_INTENT_KEYS = new Set([
  "ArrowDown",
  "ArrowUp",
  "End",
  "Home",
  "PageDown",
  "PageUp",
  " ",
]);

export const BottomAnchorContext =
  createContext<BottomAnchorContextValue | null>(null);

export const TimelineScrollRestoreRowIdContext = createContext<string | null>(
  null,
);

export function useBottomAnchoredScroll(): BottomAnchorContextValue | null {
  return useContext(BottomAnchorContext);
}

function getMaxScrollOffset(element: HTMLElement) {
  return Math.max(0, element.scrollHeight - element.clientHeight);
}

function isScrolledNearBottom(maxScrollOffset: number, scrollTop: number) {
  return maxScrollOffset - scrollTop <= BOTTOM_ANCHOR_THRESHOLD_PX;
}

function isElementFullyVisibleInScrollArea({
  element,
  scrollArea,
}: ElementVisibilityArgs) {
  const elementRect = element.getBoundingClientRect();
  const scrollAreaRect = scrollArea.getBoundingClientRect();
  return (
    elementRect.top >= scrollAreaRect.top &&
    elementRect.bottom <= scrollAreaRect.bottom
  );
}

function getScrollOffsetToRevealElement({
  element,
  scrollArea,
}: ElementVisibilityArgs) {
  const elementRect = element.getBoundingClientRect();
  const scrollAreaRect = scrollArea.getBoundingClientRect();
  return Math.max(
    0,
    elementRect.top - scrollAreaRect.top + scrollArea.scrollTop,
  );
}

interface TopMostVisibleRow {
  rowId: string;
  offsetWithinRow: number;
}

interface ScrollAnchorRowQuery {
  rows: NodeListOf<HTMLElement>;
  windowed: boolean;
}

function getScrollAnchorRows(scrollArea: HTMLElement): ScrollAnchorRowQuery {
  const topLevelList = scrollArea.querySelector<HTMLElement>(
    TOP_LEVEL_TIMELINE_ROW_LIST_SELECTOR,
  );
  if (topLevelList) {
    return {
      rows: topLevelList.querySelectorAll<HTMLElement>(
        DIRECT_TIMELINE_ROW_SELECTOR,
      ),
      windowed:
        topLevelList.querySelector(TIMELINE_VIRTUAL_SPACER_SELECTOR) !== null,
    };
  }
  return {
    rows: scrollArea.querySelectorAll<HTMLElement>(TIMELINE_ROW_ID_SELECTOR),
    windowed: false,
  };
}

function getTopMostVisibleRow(
  scrollArea: HTMLElement,
  rows: NodeListOf<HTMLElement>,
): TopMostVisibleRow | null {
  const scrollAreaTop = scrollArea.getBoundingClientRect().top;
  let low = 0;
  let high = rows.length - 1;
  let visibleRow: HTMLElement | null = null;
  let visibleRowRect: DOMRect | null = null;

  while (low <= high) {
    const index = low + Math.floor((high - low) / 2);
    const row = rows[index];
    if (!row) break;
    const rowRect = row.getBoundingClientRect();
    if (rowRect.bottom <= scrollAreaTop + 1) {
      low = index + 1;
      continue;
    }
    visibleRow = row;
    visibleRowRect = rowRect;
    high = index - 1;
  }

  const rowId = visibleRow?.dataset.timelineRowId;
  if (!rowId || !visibleRowRect) return null;
  return {
    rowId,
    offsetWithinRow: Math.max(0, scrollAreaTop - visibleRowRect.top),
  };
}

function findTimelineRowElement(
  scrollArea: HTMLElement,
  rowId: string,
): HTMLElement | null {
  const rows = scrollArea.querySelectorAll<HTMLElement>(
    TIMELINE_ROW_ID_SELECTOR,
  );
  for (const row of rows) {
    if (row.dataset.timelineRowId === rowId) return row;
  }
  return null;
}

function isEditableKeyboardTarget(target: EventTarget | null) {
  if (!(target instanceof HTMLElement)) return false;

  return (
    target.tagName === "INPUT" ||
    target.tagName === "TEXTAREA" ||
    target.tagName === "SELECT" ||
    target.isContentEditable ||
    target.closest("[contenteditable='true']") !== null
  );
}

function isKeyboardEventFromScrollArea(
  event: KeyboardEvent,
  scrollArea: HTMLElement,
) {
  const target = event.target;
  if (!(target instanceof Node)) return true;
  if (target === document.body || target === document.documentElement) {
    return true;
  }
  return scrollArea.contains(target);
}

export function BottomAnchoredScrollBody({
  scrollAreaClassName,
  contentClassName,
  maxWidthClassName,
  footer,
  scrollOverlay,
  children,
  scrollAnchorThreadId,
}: BottomAnchoredScrollBodyProps) {
  const store = useStore();
  const isPointerCoarse = usePointerCoarse();
  const scrollAreaRef = useRef<HTMLDivElement>(null);
  const scrollContentRef = useRef<HTMLDivElement>(null);
  const shouldStickToBottomRef = useRef(true);
  const userScrollIntentUntilRef = useRef(0);
  const userScrollInputPendingRef = useRef(false);
  const pointerScrollIntentRef = useRef(false);
  const restoreFrameRef = useRef<number | null>(null);
  const restoreFramesRemainingRef = useRef(0);
  const restoreTailLiveReadRef = useRef(false);
  const pendingPrependAnchorRef = useRef<{
    scrollHeight: number;
    scrollTop: number;
  } | null>(null);
  const pendingScrollRestoreRef = useRef<{
    anchor: ScrollAnchor;
    attemptsRemaining: number;
    lastAppliedScrollTop: number | null;
  } | null>(null);
  const scrollAnchorCaptureThrottleRef = useRef<{
    lastWriteAt: number;
    trailingTimeout: number | null;
  }>({ lastWriteAt: 0, trailingTimeout: null });
  const userDetachedFromBottomRef = useRef(false);
  const maxScrollOffsetRef = useRef(0);
  const resizeObserverHasDeliveredRef = useRef(false);
  const observedScrollGeometryRef = useRef<{
    scrollAreaClientHeight: number | null;
    scrollContentHeight: number | null;
  }>({ scrollAreaClientHeight: null, scrollContentHeight: null });
  const scrollAnchorRowsRef = useRef<NodeListOf<HTMLElement> | null>(null);
  const [isAtBottom, setIsAtBottom] = useState(true);
  const initialScrollRestoreRowId = useMemo(() => {
    if (scrollAnchorThreadId === undefined) return null;
    const anchor = store.get(
      threadTimelineScrollAnchorAtomFamily(scrollAnchorThreadId),
    );
    return anchor !== null && anchor !== undefined && !anchor.atBottom
      ? anchor.rowId
      : null;
  }, [scrollAnchorThreadId, store]);

  const getScrollElement = useCallback(() => scrollAreaRef.current, []);

  const refreshMaxScrollOffset = useCallback((scrollArea: HTMLElement) => {
    const maxScrollOffset = getMaxScrollOffset(scrollArea);
    maxScrollOffsetRef.current = maxScrollOffset;
    return maxScrollOffset;
  }, []);

  const readMaxScrollOffset = useCallback(
    (scrollArea: HTMLElement) =>
      resizeObserverHasDeliveredRef.current
        ? maxScrollOffsetRef.current
        : refreshMaxScrollOffset(scrollArea),
    [refreshMaxScrollOffset],
  );

  const cancelPendingScrollRestore = useCallback(() => {
    pendingScrollRestoreRef.current = null;
  }, []);

  const cancelQueuedRestore = useCallback(() => {
    if (restoreFrameRef.current === null) return;
    window.cancelAnimationFrame(restoreFrameRef.current);
    restoreFrameRef.current = null;
    restoreFramesRemainingRef.current = 0;
    restoreTailLiveReadRef.current = false;
  }, []);

  const restoreBottomOnce = useCallback(() => {
    const scrollArea = scrollAreaRef.current;
    if (!scrollArea || !shouldStickToBottomRef.current) return false;
    const maxScrollOffset = refreshMaxScrollOffset(scrollArea);
    if (isScrolledNearBottom(maxScrollOffset, scrollArea.scrollTop)) {
      return false;
    }
    scrollArea.scrollTop = maxScrollOffset;
    return true;
  }, [refreshMaxScrollOffset]);

  const restoreBottomFromCacheOnce = useCallback(() => {
    const scrollArea = scrollAreaRef.current;
    if (!scrollArea || !shouldStickToBottomRef.current) return false;
    const maxScrollOffset = readMaxScrollOffset(scrollArea);
    if (isScrolledNearBottom(maxScrollOffset, scrollArea.scrollTop)) {
      return false;
    }
    scrollArea.scrollTop = maxScrollOffset;
    return true;
  }, [readMaxScrollOffset]);

  const queueBottomRestore = useCallback(() => {
    if (!shouldStickToBottomRef.current) return;
    restoreBottomOnce();
    restoreFramesRemainingRef.current = BOTTOM_RESTORE_SETTLE_FRAME_COUNT;
    restoreTailLiveReadRef.current = false;
    if (restoreFrameRef.current !== null) return;
    const runQueuedRestore = () => {
      restoreFrameRef.current = null;
      const useLiveRead = restoreTailLiveReadRef.current;
      restoreTailLiveReadRef.current = false;
      const restored = useLiveRead
        ? restoreBottomOnce()
        : restoreBottomFromCacheOnce();
      if (!restored) {
        restoreFramesRemainingRef.current = 0;
        return;
      }
      if (!useLiveRead) {
        restoreTailLiveReadRef.current = true;
      }
      restoreFramesRemainingRef.current -= 1;
      if (restoreFramesRemainingRef.current > 0) {
        restoreFrameRef.current =
          window.requestAnimationFrame(runQueuedRestore);
      }
    };
    restoreFrameRef.current = window.requestAnimationFrame(runQueuedRestore);
  }, [restoreBottomOnce, restoreBottomFromCacheOnce]);

  const scrollToBottom = useCallback(() => {
    const scrollArea = scrollAreaRef.current;
    cancelPendingScrollRestore();
    userScrollIntentUntilRef.current = 0;
    pointerScrollIntentRef.current = false;
    userDetachedFromBottomRef.current = false;
    shouldStickToBottomRef.current = true;
    setIsAtBottom(true);
    if (scrollArea) {
      scrollArea.scrollTop = refreshMaxScrollOffset(scrollArea);
    }
    queueBottomRestore();
  }, [cancelPendingScrollRestore, queueBottomRestore, refreshMaxScrollOffset]);

  const scrollElementIntoView = useCallback(
    ({ element, options }: ScrollElementIntoViewArgs) => {
      const scrollArea = scrollAreaRef.current;
      if (
        scrollArea &&
        isElementFullyVisibleInScrollArea({ element, scrollArea })
      ) {
        return;
      }
      shouldStickToBottomRef.current = false;
      setIsAtBottom(false);
      cancelQueuedRestore();
      element.scrollIntoView(options);
    },
    [cancelQueuedRestore],
  );

  const scrollElementIntoViewClampedToMaxScroll = useCallback(
    ({ element }: ScrollElementIntoViewClampedToMaxScrollArgs) => {
      const scrollArea = scrollAreaRef.current;
      if (!scrollArea) {
        element.scrollIntoView({ block: "start", inline: "nearest" });
        return;
      }

      const maxScrollOffset = refreshMaxScrollOffset(scrollArea);
      scrollArea.scrollTop = Math.min(
        maxScrollOffset,
        getScrollOffsetToRevealElement({ element, scrollArea }),
      );

      const targetIsAtBottom = isScrolledNearBottom(
        maxScrollOffset,
        scrollArea.scrollTop,
      );
      shouldStickToBottomRef.current = targetIsAtBottom;
      setIsAtBottom(targetIsAtBottom);

      if (targetIsAtBottom) {
        queueBottomRestore();
        return;
      }

      cancelQueuedRestore();
    },
    [cancelQueuedRestore, queueBottomRestore, refreshMaxScrollOffset],
  );

  const captureScrollAnchor = useCallback(() => {
    const scrollArea = scrollAreaRef.current;
    if (!scrollArea) return;
    userScrollInputPendingRef.current = false;
    pendingPrependAnchorRef.current = {
      scrollHeight: scrollArea.scrollHeight,
      scrollTop: scrollArea.scrollTop,
    };
  }, []);

  useLayoutEffect(() => {
    const scrollArea = scrollAreaRef.current;
    const anchor = pendingPrependAnchorRef.current;
    if (!scrollArea || !anchor) return;
    const delta = scrollArea.scrollHeight - anchor.scrollHeight;
    if (delta <= 0) return;
    scrollArea.scrollTop = anchor.scrollTop + delta;
    pendingPrependAnchorRef.current = null;
    refreshMaxScrollOffset(scrollArea);
  });

  const hasRecentUserScrollIntent = useCallback(() => {
    return (
      pointerScrollIntentRef.current ||
      window.performance.now() <= userScrollIntentUntilRef.current
    );
  }, []);

  const getScrollAnchorRowsCached = useCallback((scrollArea: HTMLElement) => {
    const cached = scrollAnchorRowsRef.current;
    if (
      cached &&
      (cached.length === 0 ||
        (cached[0]?.isConnected === true &&
          cached[cached.length - 1]?.isConnected === true))
    ) {
      return cached;
    }
    const { rows, windowed } = getScrollAnchorRows(scrollArea);
    scrollAnchorRowsRef.current = windowed ? null : rows;
    return rows;
  }, []);

  const writeScrollAnchor = useCallback(
    (scrollAreaOverride?: HTMLElement) => {
      if (scrollAnchorThreadId === undefined) return;
      const scrollArea = scrollAreaOverride ?? scrollAreaRef.current;
      if (!scrollArea) return;
      let atBottomByGeometry = isScrolledNearBottom(
        readMaxScrollOffset(scrollArea),
        scrollArea.scrollTop,
      );
      if (!atBottomByGeometry && shouldStickToBottomRef.current) {
        atBottomByGeometry = isScrolledNearBottom(
          refreshMaxScrollOffset(scrollArea),
          scrollArea.scrollTop,
        );
      }
      const recentUserIntent = hasRecentUserScrollIntent();
      const anchorAtom =
        threadTimelineScrollAnchorAtomFamily(scrollAnchorThreadId);
      if (atBottomByGeometry) {
        userDetachedFromBottomRef.current = false;
        store.set(anchorAtom, {
          rowId: "",
          offsetWithinRow: 0,
          atBottom: true,
        });
        return;
      }
      if (recentUserIntent) {
        userDetachedFromBottomRef.current = true;
      }
      if (
        shouldStickToBottomRef.current &&
        !userDetachedFromBottomRef.current
      ) {
        store.set(anchorAtom, {
          rowId: "",
          offsetWithinRow: 0,
          atBottom: true,
        });
        return;
      }
      const topMostRow = getTopMostVisibleRow(
        scrollArea,
        getScrollAnchorRowsCached(scrollArea),
      );
      if (!topMostRow) return;
      store.set(anchorAtom, {
        rowId: topMostRow.rowId,
        offsetWithinRow: topMostRow.offsetWithinRow,
        atBottom: false,
      });
    },
    [
      getScrollAnchorRowsCached,
      hasRecentUserScrollIntent,
      readMaxScrollOffset,
      refreshMaxScrollOffset,
      scrollAnchorThreadId,
      store,
    ],
  );

  const scrollAnchorCaptureThrottleMs = isPointerCoarse
    ? COARSE_SCROLL_ANCHOR_CAPTURE_THROTTLE_MS
    : SCROLL_ANCHOR_CAPTURE_THROTTLE_MS;

  const captureScrollAnchorThrottled = useCallback(() => {
    if (scrollAnchorThreadId === undefined) return;
    const throttle = scrollAnchorCaptureThrottleRef.current;
    const now = window.performance.now();
    const elapsed = now - throttle.lastWriteAt;
    if (elapsed >= scrollAnchorCaptureThrottleMs) {
      throttle.lastWriteAt = now;
      writeScrollAnchor();
      return;
    }
    if (throttle.trailingTimeout !== null) return;
    throttle.trailingTimeout = window.setTimeout(() => {
      throttle.trailingTimeout = null;
      throttle.lastWriteAt = window.performance.now();
      writeScrollAnchor();
    }, scrollAnchorCaptureThrottleMs - elapsed);
  }, [scrollAnchorCaptureThrottleMs, scrollAnchorThreadId, writeScrollAnchor]);

  const applyScrollRestore = useCallback(
    (anchor: ScrollAnchor): number | null => {
      const scrollArea = scrollAreaRef.current;
      if (!scrollArea) return null;
      const rowElement = findTimelineRowElement(scrollArea, anchor.rowId);
      if (!rowElement) return null;
      shouldStickToBottomRef.current = false;
      setIsAtBottom(false);
      cancelQueuedRestore();
      const revealOffset = getScrollOffsetToRevealElement({
        element: rowElement,
        scrollArea,
      });
      const targetScrollTop = Math.min(
        refreshMaxScrollOffset(scrollArea),
        revealOffset + anchor.offsetWithinRow,
      );
      scrollArea.scrollTop = targetScrollTop;
      return targetScrollTop;
    },
    [cancelQueuedRestore, refreshMaxScrollOffset],
  );

  const markUserScrollIntent = useCallback(() => {
    userScrollInputPendingRef.current = true;
    userScrollIntentUntilRef.current =
      window.performance.now() + USER_SCROLL_INTENT_MS;
  }, []);

  const markWheelScrollIntent = useCallback(
    (event: WheelEvent) => {
      const scrollArea = scrollAreaRef.current;
      if (event.deltaY > 0 && scrollArea) {
        const nearBottom =
          isScrolledNearBottom(
            readMaxScrollOffset(scrollArea),
            scrollArea.scrollTop,
          ) ||
          (shouldStickToBottomRef.current &&
            isScrolledNearBottom(
              refreshMaxScrollOffset(scrollArea),
              scrollArea.scrollTop,
            ));
        if (nearBottom) {
          userScrollIntentUntilRef.current = 0;
          return;
        }
      }
      markUserScrollIntent();
    },
    [markUserScrollIntent, readMaxScrollOffset, refreshMaxScrollOffset],
  );

  const markTouchStartScrollIntent = useCallback(() => {
    markUserScrollIntent();
  }, [markUserScrollIntent]);

  const markTouchMoveScrollIntent = useCallback(() => {
    markUserScrollIntent();
  }, [markUserScrollIntent]);

  const startPointerScrollIntent = useCallback(() => {
    pointerScrollIntentRef.current = true;
  }, []);

  const endPointerScrollIntent = useCallback(() => {
    pointerScrollIntentRef.current = false;
  }, []);

  const markKeyboardScrollIntent = useCallback(
    (event: KeyboardEvent) => {
      const scrollArea = scrollAreaRef.current;
      if (!scrollArea) return;
      if (!SCROLL_INTENT_KEYS.has(event.key)) return;
      if (isEditableKeyboardTarget(event.target)) return;
      if (!isKeyboardEventFromScrollArea(event, scrollArea)) return;

      markUserScrollIntent();
    },
    [markUserScrollIntent],
  );

  const attachToBottom = useCallback(() => {
    userDetachedFromBottomRef.current = false;
    shouldStickToBottomRef.current = true;
    userScrollIntentUntilRef.current = 0;
    setIsAtBottom(true);
    pendingScrollRestoreRef.current = null;
  }, []);

  const syncBottomStateFromScroll = useCallback(() => {
    const scrollArea = scrollAreaRef.current;
    if (!scrollArea) return;
    const hasDirectUserScrollInput =
      userScrollInputPendingRef.current || pointerScrollIntentRef.current;
    userScrollInputPendingRef.current = false;

    if (
      pendingPrependAnchorRef.current !== null &&
      hasRecentUserScrollIntent()
    ) {
      if (hasDirectUserScrollInput) {
        pendingPrependAnchorRef.current.scrollTop = scrollArea.scrollTop;
      }
      userDetachedFromBottomRef.current = true;
      shouldStickToBottomRef.current = false;
      setIsAtBottom(false);
      cancelQueuedRestore();
      return;
    }

    let nearBottom = isScrolledNearBottom(
      readMaxScrollOffset(scrollArea),
      scrollArea.scrollTop,
    );
    if (
      !nearBottom &&
      shouldStickToBottomRef.current &&
      hasRecentUserScrollIntent()
    ) {
      nearBottom = isScrolledNearBottom(
        refreshMaxScrollOffset(scrollArea),
        scrollArea.scrollTop,
      );
    }

    if (nearBottom) {
      attachToBottom();
      return;
    }

    if (!hasRecentUserScrollIntent()) return;

    userDetachedFromBottomRef.current = true;
    shouldStickToBottomRef.current = false;
    setIsAtBottom(false);
    cancelQueuedRestore();
    pendingScrollRestoreRef.current = null;
  }, [
    attachToBottom,
    cancelQueuedRestore,
    hasRecentUserScrollIntent,
    readMaxScrollOffset,
    refreshMaxScrollOffset,
  ]);

  const handleScroll = useCallback(() => {
    syncBottomStateFromScroll();
    captureScrollAnchorThrottled();
  }, [syncBottomStateFromScroll, captureScrollAnchorThrottled]);

  const advancePendingScrollRestore = useCallback((): boolean => {
    const pending = pendingScrollRestoreRef.current;
    if (!pending) return false;
    pending.attemptsRemaining -= 1;
    const appliedScrollTop = applyScrollRestore(pending.anchor);
    if (appliedScrollTop !== null) {
      if (pending.lastAppliedScrollTop === appliedScrollTop) {
        pendingScrollRestoreRef.current = null;
        return true;
      }
      pending.lastAppliedScrollTop = appliedScrollTop;
    }
    if (pending.attemptsRemaining <= 0) {
      pendingScrollRestoreRef.current = null;
      if (appliedScrollTop === null) {
        shouldStickToBottomRef.current = true;
        setIsAtBottom(true);
        queueBottomRestore();
      }
    }
    return true;
  }, [applyScrollRestore, queueBottomRestore]);

  const handleScrollAreaResize = useCallback(
    (entries: ResizeObserverEntry[]) => {
      const scrollArea = scrollAreaRef.current;
      scrollAnchorRowsRef.current = null;
      let shrankOntoBottomWhileDetached = false;
      if (scrollArea) {
        const previousMaxScrollOffset = maxScrollOffsetRef.current;
        const cacheWasAuthoritative = resizeObserverHasDeliveredRef.current;
        const observedGeometry = observedScrollGeometryRef.current;
        for (const entry of entries) {
          if (entry.target === scrollArea) {
            observedGeometry.scrollAreaClientHeight =
              entry.contentBoxSize[0]?.blockSize ?? entry.contentRect.height;
          } else if (entry.target === scrollContentRef.current) {
            observedGeometry.scrollContentHeight =
              entry.borderBoxSize[0]?.blockSize ?? entry.contentRect.height;
          }
        }
        let maxScrollOffset: number;
        if (
          observedGeometry.scrollAreaClientHeight !== null &&
          observedGeometry.scrollContentHeight !== null
        ) {
          maxScrollOffset = Math.max(
            0,
            Math.round(observedGeometry.scrollContentHeight) -
              Math.round(observedGeometry.scrollAreaClientHeight),
          );
          maxScrollOffsetRef.current = maxScrollOffset;
        } else {
          maxScrollOffset = refreshMaxScrollOffset(scrollArea);
        }
        resizeObserverHasDeliveredRef.current = true;
        shrankOntoBottomWhileDetached =
          cacheWasAuthoritative &&
          !shouldStickToBottomRef.current &&
          maxScrollOffset < previousMaxScrollOffset &&
          isScrolledNearBottom(maxScrollOffset, scrollArea.scrollTop);
      }
      if (advancePendingScrollRestore()) return;
      if (shrankOntoBottomWhileDetached && scrollArea) {
        attachToBottom();
        writeScrollAnchor(scrollArea);
      }
      queueBottomRestore();
    },
    [
      advancePendingScrollRestore,
      attachToBottom,
      queueBottomRestore,
      refreshMaxScrollOffset,
      writeScrollAnchor,
    ],
  );

  useLayoutEffect(() => {
    if (scrollAnchorThreadId === undefined) return;
    const anchor = store.get(
      threadTimelineScrollAnchorAtomFamily(scrollAnchorThreadId),
    );
    if (!anchor || anchor.atBottom) return;
    shouldStickToBottomRef.current = false;
    setIsAtBottom(false);
    pendingScrollRestoreRef.current = {
      anchor,
      attemptsRemaining: SCROLL_ANCHOR_RESTORE_MAX_ATTEMPTS,
      lastAppliedScrollTop: null,
    };
    advancePendingScrollRestore();
  }, [scrollAnchorThreadId, store, advancePendingScrollRestore]);

  const bottomAnchorContextValue = useMemo<BottomAnchorContextValue>(
    () => ({
      getScrollElement,
      isAtBottom,
      scrollToBottom,
      scrollElementIntoView,
      scrollElementIntoViewClampedToMaxScroll,
      captureScrollAnchor,
    }),
    [
      getScrollElement,
      isAtBottom,
      scrollToBottom,
      scrollElementIntoView,
      scrollElementIntoViewClampedToMaxScroll,
      captureScrollAnchor,
    ],
  );

  const flushScrollAnchorCapture = useCallback(
    (scrollArea: HTMLElement) => {
      const captureThrottle = scrollAnchorCaptureThrottleRef.current;
      if (captureThrottle.trailingTimeout !== null) {
        window.clearTimeout(captureThrottle.trailingTimeout);
        captureThrottle.trailingTimeout = null;
      }
      refreshMaxScrollOffset(scrollArea);
      writeScrollAnchor(scrollArea);
    },
    [refreshMaxScrollOffset, writeScrollAnchor],
  );

  useLayoutEffect(() => {
    const scrollArea = scrollAreaRef.current;
    if (!scrollArea) return;

    return () => {
      flushScrollAnchorCapture(scrollArea);
    };
  }, [flushScrollAnchorCapture]);

  useEffect(() => {
    const scrollArea = scrollAreaRef.current;
    const scrollContent = scrollContentRef.current;
    if (!scrollArea || !scrollContent) return;

    let scrollbarIdleTimeout: number | null = null;
    const handleScrollEvent = () => {
      if (scrollArea.dataset.scrollbarScrolling !== "true") {
        scrollArea.dataset.scrollbarScrolling = "true";
      }
      if (scrollbarIdleTimeout !== null) {
        window.clearTimeout(scrollbarIdleTimeout);
      }
      scrollbarIdleTimeout = window.setTimeout(() => {
        scrollbarIdleTimeout = null;
        scrollArea.removeAttribute("data-scrollbar-scrolling");
      }, SCROLLBAR_IDLE_DELAY_MS);
      handleScroll();
    };

    let resizeObserver: ResizeObserver | undefined;
    if (typeof ResizeObserver !== "undefined") {
      resizeObserver = new ResizeObserver(handleScrollAreaResize);
      resizeObserver.observe(scrollArea);
      resizeObserver.observe(scrollContent);
    }

    scrollArea.addEventListener("scroll", handleScrollEvent, {
      passive: true,
    });
    scrollArea.addEventListener("wheel", markWheelScrollIntent, {
      passive: true,
    });
    scrollArea.addEventListener("touchstart", markTouchStartScrollIntent, {
      passive: true,
    });
    scrollArea.addEventListener("touchmove", markTouchMoveScrollIntent, {
      passive: true,
    });
    scrollArea.addEventListener("pointerdown", startPointerScrollIntent, {
      passive: true,
    });
    window.addEventListener("pointerup", endPointerScrollIntent);
    window.addEventListener("pointercancel", endPointerScrollIntent);
    window.addEventListener("keydown", markKeyboardScrollIntent);

    queueBottomRestore();

    return () => {
      resizeObserver?.disconnect();
      scrollArea.removeEventListener("scroll", handleScrollEvent);
      scrollArea.removeEventListener("wheel", markWheelScrollIntent);
      scrollArea.removeEventListener("touchstart", markTouchStartScrollIntent);
      scrollArea.removeEventListener("touchmove", markTouchMoveScrollIntent);
      scrollArea.removeEventListener("pointerdown", startPointerScrollIntent);
      window.removeEventListener("pointerup", endPointerScrollIntent);
      window.removeEventListener("pointercancel", endPointerScrollIntent);
      window.removeEventListener("keydown", markKeyboardScrollIntent);
      if (scrollbarIdleTimeout !== null) {
        window.clearTimeout(scrollbarIdleTimeout);
      }
      scrollArea.removeAttribute("data-scrollbar-scrolling");
      cancelQueuedRestore();
    };
  }, [
    cancelQueuedRestore,
    endPointerScrollIntent,
    handleScroll,
    handleScrollAreaResize,
    markKeyboardScrollIntent,
    markTouchMoveScrollIntent,
    markTouchStartScrollIntent,
    markWheelScrollIntent,
    queueBottomRestore,
    startPointerScrollIntent,
  ]);

  return (
    <BottomAnchorContext.Provider value={bottomAnchorContextValue}>
      <TimelineScrollRestoreRowIdContext.Provider
        value={initialScrollRestoreRowId}
      >
        <div className="grid min-h-0 flex-1 overflow-hidden">
          <div
            ref={scrollAreaRef}
            className={cn(
              "thread-scrollbar @container/page col-start-1 row-start-1 min-h-0 overflow-x-hidden overflow-y-auto",
              scrollAreaClassName,
            )}
          >
            <div
              ref={scrollContentRef}
              className="flex min-h-full min-w-0 flex-col"
            >
              {}
              <div
                className={cn(
                  "mx-auto flex w-full min-w-0 flex-1 flex-col px-4 pb-4 pt-2",
                  maxWidthClassName,
                  contentClassName,
                  isAtBottom &&
                    supportsScrollAnchoring() &&
                    "scroll-bottom-anchor-content",
                )}
                style={PAGE_SHELL_CONTENT_STYLE}
              >
                {children}
              </div>
              <div className="scroll-bottom-anchor" aria-hidden />
              {footer ? (
                <div
                  data-scroll-footer=""
                  className="sticky bottom-0 z-20 shrink-0 [overflow-anchor:none]"
                >
                  {footer}
                </div>
              ) : null}
            </div>
          </div>
          {scrollOverlay ? (
            <div
              data-scroll-overlay=""
              className="pointer-events-none z-30 col-start-1 row-start-1 flex min-h-0 min-w-0 items-center justify-end px-3 py-3"
            >
              <div className="pointer-events-auto">{scrollOverlay}</div>
            </div>
          ) : null}
        </div>
      </TimelineScrollRestoreRowIdContext.Provider>
    </BottomAnchorContext.Provider>
  );
}
