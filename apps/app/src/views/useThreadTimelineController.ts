import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import { useSetAtom } from "jotai";
import type {
  ThreadStatus,
  TimelineRow,
  TimelineTurnSummaryRow,
} from "@bb/domain";
import { useResizeObserver } from "usehooks-ts";
import { threadTimelineShowScrollToBottomAtom } from "./threadTimelineAtoms";
import {
  captureTimelineScrollAnchorFromViewport,
  getTimelineAnchorOffsetDelta,
  hasMeaningfulComposerHeightChange,
  hasMeaningfulTimelineContainerResize,
  isTimelineNearBottom,
  resolveTimelineScrollMode,
  shouldLoadNestedRows,
  shouldShowTimelineScrollToBottom,
  type TimelineScrollAnchor,
  type TimelineScrollMode,
  type TimelineScrollUpdateSource,
  type TimelineViewportRow,
} from "./threadTimelineControllerHelpers";

const TIMELINE_ROW_SELECTOR = "[data-thread-row-id]";
// Mirrors ExpandablePanel's duration-200 row collapse animation with a small
// buffer so a reading-history anchor is restored after completion collapses.
const TIMELINE_LAYOUT_TRANSITION_SETTLE_MS = 260;
// User input can precede the resulting scroll event by a frame or two. Keep a
// short intent window so explicit bottom scrolling wins over layout guards.
const USER_SCROLL_INTENT_WINDOW_MS = 500;
const TIMELINE_SCROLL_INTENT_KEYS = new Set([
  "ArrowDown",
  "ArrowUp",
  "End",
  "Home",
  "PageDown",
  "PageUp",
  " ",
]);

interface LoadTurnSummaryRowsArgs {
  id: string;
  sourceSeqStart: number;
  sourceSeqEnd: number;
  includeAllEvents?: boolean;
}

interface UseThreadTimelineControllerParams {
  threadId?: string;
  threadDetailRows: TimelineRow[];
  threadStatus?: ThreadStatus;
  loadTurnSummaryRows: (
    args: LoadTurnSummaryRowsArgs,
  ) => Promise<{ rows: TimelineRow[] }>;
}

interface SyncScrollStateArgs {
  container: HTMLDivElement;
  preserveReadingHistoryDuringReconcile: boolean;
  source: TimelineScrollUpdateSource;
}

function isAutoExpandedThreadStatus(status: ThreadStatus | undefined): boolean {
  return status === "active" || status === "provisioning";
}

function shouldTrackStatusLayoutTransition(args: {
  previousStatus: ThreadStatus | undefined;
  nextStatus: ThreadStatus | undefined;
}): boolean {
  return (
    isAutoExpandedThreadStatus(args.previousStatus) &&
    !isAutoExpandedThreadStatus(args.nextStatus)
  );
}

function getTimelineViewportRows(
  container: HTMLDivElement,
): TimelineViewportRow[] {
  return Array.from(
    container.querySelectorAll<HTMLElement>(TIMELINE_ROW_SELECTOR),
  )
    .map((row) => {
      const rowId = row.dataset.threadRowId;
      if (!rowId) {
        return null;
      }

      const rowRect = row.getBoundingClientRect();
      return {
        rowId,
        top: rowRect.top,
        bottom: rowRect.bottom,
      };
    })
    .filter((row): row is TimelineViewportRow => row !== null);
}

function captureTimelineScrollAnchor(
  container: HTMLDivElement,
): TimelineScrollAnchor | null {
  const containerRect = container.getBoundingClientRect();

  return captureTimelineScrollAnchorFromViewport({
    clientHeight: container.clientHeight,
    containerTop: containerRect.top,
    rows: getTimelineViewportRows(container),
    scrollHeight: container.scrollHeight,
    scrollTop: container.scrollTop,
  });
}

function findTimelineRowElement(
  container: HTMLDivElement,
  rowId: string,
): HTMLElement | null {
  const rows = Array.from(
    container.querySelectorAll<HTMLElement>(TIMELINE_ROW_SELECTOR),
  );
  return rows.find((row) => row.dataset.threadRowId === rowId) ?? null;
}

function restoreAnchorPosition(
  container: HTMLDivElement,
  anchor: TimelineScrollAnchor,
): void {
  const targetRow = findTimelineRowElement(container, anchor.rowId);
  if (!targetRow) {
    return;
  }

  const containerRect = container.getBoundingClientRect();
  const targetRect = targetRow.getBoundingClientRect();
  const offsetDelta = getTimelineAnchorOffsetDelta({
    anchor,
    containerTop: containerRect.top,
    targetTop: targetRect.top,
  });
  if (offsetDelta !== 0) {
    container.scrollTop += offsetDelta;
  }
}

function scrollContainerToBottom(container: HTMLDivElement): void {
  container.scrollTop = Math.max(
    0,
    container.scrollHeight - container.clientHeight,
  );
}

export function useThreadTimelineController({
  threadId,
  threadDetailRows,
  threadStatus,
  loadTurnSummaryRows,
}: UseThreadTimelineControllerParams) {
  const [loadingTurnSummaryIds, setLoadingTurnSummaryIds] = useState<Set<string>>(
    new Set(),
  );
  const [turnSummaryRowsById, setTurnSummaryRowsById] = useState<
    Record<string, TimelineRow[]>
  >({});
  const [containerElement, setContainerElement] =
    useState<HTMLDivElement | null>(null);
  const setShowScrollToBottom = useSetAtom(
    threadTimelineShowScrollToBottomAtom,
  );
  const containerRef = useRef<HTMLDivElement>(null!);
  const promptComposerRef = useRef<HTMLDivElement>(null!);
  const modeRef = useRef<TimelineScrollMode>("pinned_bottom");
  const timelineScrollAnchorRef = useRef<TimelineScrollAnchor | null>(null);
  const scheduledFrameRef = useRef<number | null>(null);
  const pendingReasonsRef = useRef<Set<string>>(new Set());
  const layoutTransitionUntilRef = useRef(0);
  const userScrollIntentUntilRef = useRef(0);
  const previousThreadStatusRef = useRef<ThreadStatus | undefined>(undefined);
  const previousComposerHeightRef = useRef<number | null>(null);
  const previousContainerSizeRef = useRef<{
    width: number;
    height: number;
  } | null>(null);
  const postJumpTimeoutRef = useRef<number | null>(null);

  const syncScrollState = useCallback(
    ({
      container,
      preserveReadingHistoryDuringReconcile,
      source,
    }: SyncScrollStateArgs) => {
      const snapshot = {
        clientHeight: container.clientHeight,
        scrollHeight: container.scrollHeight,
        scrollTop: container.scrollTop,
      };
      const nextMode = resolveTimelineScrollMode({
        currentMode: modeRef.current,
        isNearBottom: isTimelineNearBottom(snapshot),
        preserveReadingHistoryDuringReconcile,
        source,
      });
      setShowScrollToBottom((current) => {
        const next = shouldShowTimelineScrollToBottom(snapshot);
        return current === next ? current : next;
      });

      modeRef.current = nextMode;
      timelineScrollAnchorRef.current =
        nextMode === "pinned_bottom"
          ? null
          : captureTimelineScrollAnchor(container);
    },
    [setShowScrollToBottom],
  );

  const reconcileScrollPosition = useCallback(() => {
    const container = containerElement;
    if (!container) {
      pendingReasonsRef.current.clear();
      return;
    }

    const mode = modeRef.current;
    if (mode === "pinned_bottom") {
      scrollContainerToBottom(container);
    } else {
      const anchor = timelineScrollAnchorRef.current;
      if (anchor) {
        restoreAnchorPosition(container, anchor);
      }
    }

    pendingReasonsRef.current.clear();
    syncScrollState({
      container,
      preserveReadingHistoryDuringReconcile: mode === "reading_history",
      source: "controlled_reconcile",
    });
  }, [containerElement, syncScrollState]);

  const scheduleReconcile = useCallback(
    (reason: string) => {
      pendingReasonsRef.current.add(reason);

      if (typeof window === "undefined") {
        reconcileScrollPosition();
        return;
      }

      if (scheduledFrameRef.current !== null) {
        return;
      }

      scheduledFrameRef.current = window.requestAnimationFrame(() => {
        scheduledFrameRef.current = null;
        reconcileScrollPosition();
      });
    },
    [reconcileScrollPosition],
  );

  const setContainerRef = useCallback((element: HTMLDivElement | null) => {
    if (element) {
      containerRef.current = element;
    }
    setContainerElement((currentElement) =>
      currentElement === element ? currentElement : element,
    );
  }, []);

  const captureTimelineScrollPosition = useCallback(() => {
    const container = containerElement;
    if (!container) return;
    timelineScrollAnchorRef.current =
      modeRef.current === "pinned_bottom"
        ? null
        : captureTimelineScrollAnchor(container);
  }, [containerElement]);

  const handleTimelineScroll = useCallback(() => {
    const container = containerElement;
    if (!container) return;
    const hasRecentUserScrollIntent =
      Date.now() < userScrollIntentUntilRef.current;
    syncScrollState({
      container,
      preserveReadingHistoryDuringReconcile:
        !hasRecentUserScrollIntent &&
        (pendingReasonsRef.current.size > 0 ||
          Date.now() < layoutTransitionUntilRef.current),
      source: hasRecentUserScrollIntent
        ? "user_scroll"
        : "controlled_reconcile",
    });
  }, [containerElement, syncScrollState]);

  const markUserScrollIntent = useCallback(() => {
    userScrollIntentUntilRef.current =
      Date.now() + USER_SCROLL_INTENT_WINDOW_MS;
  }, []);

  const handleTimelineKeyDown = useCallback(
    (event: KeyboardEvent) => {
      if (TIMELINE_SCROLL_INTENT_KEYS.has(event.key)) {
        markUserScrollIntent();
      }
    },
    [markUserScrollIntent],
  );

  const scrollToBottom = useCallback(() => {
    const container = containerElement;
    modeRef.current = "pinned_bottom";
    setShowScrollToBottom(false);
    if (container) {
      scrollContainerToBottom(container);
    }
    scheduleReconcile("request_jump_to_bottom");

    if (typeof window !== "undefined") {
      window.requestAnimationFrame(() => {
        scheduleReconcile("request_jump_to_bottom_next_frame");
      });
      if (postJumpTimeoutRef.current !== null) {
        window.clearTimeout(postJumpTimeoutRef.current);
      }
      postJumpTimeoutRef.current = window.setTimeout(() => {
        postJumpTimeoutRef.current = null;
        scheduleReconcile("request_jump_to_bottom_timeout");
      }, 180);
    }
  }, [containerElement, scheduleReconcile, setShowScrollToBottom]);

  const handleLoadTurnSummaryRows = useCallback(
    (entry: TimelineTurnSummaryRow) => {
      const currentThreadId = threadId;

      if (
        !shouldLoadNestedRows({
          cachedRowCount: turnSummaryRowsById[entry.id]?.length ?? 0,
          inlineRowCount: entry.rows?.length ?? 0,
          isLoading: loadingTurnSummaryIds.has(entry.id),
          threadId: currentThreadId,
        })
      ) {
        return;
      }
      if (!currentThreadId) {
        return;
      }

      setLoadingTurnSummaryIds((prev) => new Set(prev).add(entry.id));
      void loadTurnSummaryRows({
        id: currentThreadId,
        sourceSeqStart: entry.sourceSeqStart,
        sourceSeqEnd: entry.sourceSeqEnd,
      })
        .then((response) => {
          setTurnSummaryRowsById((prev) => ({
            ...prev,
            [entry.id]: response.rows,
          }));
        })
        .finally(() => {
          setLoadingTurnSummaryIds((prev) => {
            const next = new Set(prev);
            next.delete(entry.id);
            return next;
          });
        });
    },
    [
      loadTurnSummaryRows,
      loadingTurnSummaryIds,
      threadId,
      turnSummaryRowsById,
    ],
  );

  useEffect(() => {
    setLoadingTurnSummaryIds(new Set());
    setTurnSummaryRowsById({});
  }, [threadId]);

  useEffect(() => {
    modeRef.current = "pinned_bottom";
    timelineScrollAnchorRef.current = null;
    layoutTransitionUntilRef.current = 0;
    userScrollIntentUntilRef.current = 0;
    previousThreadStatusRef.current = undefined;
    previousComposerHeightRef.current = null;
    previousContainerSizeRef.current = null;
    scrollToBottom();
  }, [scrollToBottom, threadId]);

  useEffect(() => {
    scheduleReconcile("timeline_rows_changed");
  }, [scheduleReconcile, threadDetailRows]);

  useLayoutEffect(() => {
    const shouldTrackStatusTransition = shouldTrackStatusLayoutTransition({
      previousStatus: previousThreadStatusRef.current,
      nextStatus: threadStatus,
    });
    previousThreadStatusRef.current = threadStatus;

    if (!shouldTrackStatusTransition) {
      return;
    }

    layoutTransitionUntilRef.current =
      Date.now() + TIMELINE_LAYOUT_TRANSITION_SETTLE_MS;
    reconcileScrollPosition();

    if (typeof window === "undefined") {
      return;
    }

    const timeoutId = window.setTimeout(() => {
      scheduleReconcile("timeline_layout_transition_completed");
    }, TIMELINE_LAYOUT_TRANSITION_SETTLE_MS);

    return () => {
      window.clearTimeout(timeoutId);
    };
  }, [reconcileScrollPosition, scheduleReconcile, threadStatus]);

  useLayoutEffect(() => {
    const container = containerElement;
    if (!container || typeof MutationObserver === "undefined") {
      return;
    }

    const observer = new MutationObserver(() => {
      scheduleReconcile("timeline_dom_changed");
    });
    observer.observe(container, {
      subtree: true,
      childList: true,
    });

    return () => {
      observer.disconnect();
    };
  }, [containerElement, scheduleReconcile]);

  useEffect(() => {
    const container = containerElement;
    if (!container) {
      return;
    }

    container.addEventListener("wheel", markUserScrollIntent, {
      passive: true,
    });
    container.addEventListener("touchmove", markUserScrollIntent, {
      passive: true,
    });
    container.addEventListener("keydown", handleTimelineKeyDown);

    return () => {
      container.removeEventListener("wheel", markUserScrollIntent);
      container.removeEventListener("touchmove", markUserScrollIntent);
      container.removeEventListener("keydown", handleTimelineKeyDown);
    };
  }, [containerElement, handleTimelineKeyDown, markUserScrollIntent]);

  useLayoutEffect(() => {
    const container = containerRef.current;
    if (!container) {
      previousContainerSizeRef.current = null;
      return;
    }

    previousContainerSizeRef.current = {
      width: container.clientWidth,
      height: container.clientHeight,
    };
  }, [containerElement]);

  useLayoutEffect(() => {
    const composer = promptComposerRef.current;
    if (!composer) {
      previousComposerHeightRef.current = null;
      return;
    }

    previousComposerHeightRef.current = composer.getBoundingClientRect().height;
  }, [threadId]);

  useResizeObserver({
    ref: containerRef,
    onResize: ({ width, height }) => {
      const nextWidth =
        width ?? containerRef.current?.getBoundingClientRect().width;
      const nextHeight =
        height ?? containerRef.current?.getBoundingClientRect().height;
      if (nextWidth === undefined || nextHeight === undefined) {
        return;
      }

      const previous = previousContainerSizeRef.current;
      previousContainerSizeRef.current = {
        width: nextWidth,
        height: nextHeight,
      };

      if (
        hasMeaningfulTimelineContainerResize(previous, {
          width: nextWidth,
          height: nextHeight,
        })
      ) {
        scheduleReconcile("container_resized");
      }
    },
  });

  useResizeObserver({
    ref: promptComposerRef,
    onResize: ({ height }) => {
      const nextHeight =
        height ?? promptComposerRef.current?.getBoundingClientRect().height;
      if (nextHeight === undefined) {
        return;
      }

      const previousHeight = previousComposerHeightRef.current;
      previousComposerHeightRef.current = nextHeight;
      if (hasMeaningfulComposerHeightChange(previousHeight, nextHeight)) {
        scheduleReconcile("composer_height_changed");
      }
    },
  });

  useEffect(() => {
    return () => {
      if (scheduledFrameRef.current !== null && typeof window !== "undefined") {
        window.cancelAnimationFrame(scheduledFrameRef.current);
        scheduledFrameRef.current = null;
      }
      if (
        postJumpTimeoutRef.current !== null &&
        typeof window !== "undefined"
      ) {
        window.clearTimeout(postJumpTimeoutRef.current);
        postJumpTimeoutRef.current = null;
      }
    };
  }, []);

  return {
    captureTimelineScrollPosition,
    handleLoadTurnSummaryRows,
    handleTimelineScroll,
    loadingTurnSummaryIds,
    promptComposerRef,
    scrollToBottom,
    setContainerRef,
    turnSummaryRowsById,
  };
}
