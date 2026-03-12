import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import { type ThreadDetailRow, type UIMessage } from "@beanbag/agent-core";
import { DEFAULT_SCROLL_STICK_THRESHOLD_PX } from "@beanbag/ui-core";
import { type ThreadDetailToolGroupRow } from "./threadDetailRows";

const TIMELINE_ROW_SELECTOR = "[data-thread-row-id]";

type TimelineScrollMode = "pinned_bottom" | "reading_history";

interface TimelineScrollAnchor {
  rowId: string;
  offsetTop: number;
}

interface LoadToolGroupMessagesArgs {
  id: string;
  turnId: string;
  sourceSeqStart: number;
  sourceSeqEnd: number;
}

interface UseThreadTimelineControllerParams {
  threadId?: string;
  threadDetailRows: ThreadDetailRow[];
  isSecondaryPanelOpen: boolean;
  loadToolGroupMessages: (
    args: LoadToolGroupMessagesArgs,
  ) => Promise<{ messages: UIMessage[] }>;
}

function isNearBottom(container: HTMLDivElement): boolean {
  const distanceFromBottom =
    container.scrollHeight - container.scrollTop - container.clientHeight;
  return distanceFromBottom <= DEFAULT_SCROLL_STICK_THRESHOLD_PX;
}

function shouldShowScrollToBottom(container: HTMLDivElement): boolean {
  const maxScrollOffset = container.scrollHeight - container.clientHeight;
  if (maxScrollOffset <= DEFAULT_SCROLL_STICK_THRESHOLD_PX) {
    return false;
  }
  return !isNearBottom(container);
}

function captureTimelineScrollAnchor(
  container: HTMLDivElement,
): TimelineScrollAnchor | null {
  if (isNearBottom(container)) {
    return null;
  }

  const containerRect = container.getBoundingClientRect();
  const rows = Array.from(
    container.querySelectorAll<HTMLElement>(TIMELINE_ROW_SELECTOR),
  );

  for (const row of rows) {
    const rowRect = row.getBoundingClientRect();
    if (rowRect.bottom <= containerRect.top + 1) continue;
    const rowId = row.dataset.threadRowId;
    if (!rowId) continue;
    return {
      rowId,
      offsetTop: rowRect.top - containerRect.top,
    };
  }

  return null;
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
  const offsetDelta = targetRect.top - containerRect.top - anchor.offsetTop;
  if (Math.abs(offsetDelta) >= 0.5) {
    container.scrollTop += offsetDelta;
  }
}

function scrollBottomSentinelIntoView(
  container: HTMLDivElement,
  sentinel: HTMLDivElement,
): void {
  const containerRect = container.getBoundingClientRect();
  const sentinelRect = sentinel.getBoundingClientRect();
  const targetScrollTop =
    container.scrollTop +
    (sentinelRect.bottom - containerRect.top) -
    container.clientHeight;
  container.scrollTop = Math.max(0, targetScrollTop);
}

export function useThreadTimelineController({
  threadId,
  threadDetailRows,
  isSecondaryPanelOpen,
  loadToolGroupMessages,
}: UseThreadTimelineControllerParams) {
  const [loadingToolGroupIds, setLoadingToolGroupIds] = useState<Set<string>>(
    new Set(),
  );
  const [toolGroupMessagesById, setToolGroupMessagesById] = useState<
    Record<string, UIMessage[]>
  >({});
  const [containerElement, setContainerElement] = useState<HTMLDivElement | null>(
    null,
  );
  const [isStickingToBottom, setIsStickingToBottom] = useState(true);
  const [showScrollToBottom, setShowScrollToBottom] = useState(false);
  const promptComposerRef = useRef<HTMLDivElement>(null);
  const bottomSentinelRef = useRef<HTMLDivElement | null>(null);
  const modeRef = useRef<TimelineScrollMode>("pinned_bottom");
  const timelineScrollAnchorRef = useRef<TimelineScrollAnchor | null>(null);
  const scheduledFrameRef = useRef<number | null>(null);
  const pendingReasonsRef = useRef<Set<string>>(new Set());
  const previousComposerHeightRef = useRef<number | null>(null);
  const previousContainerSizeRef = useRef<{
    width: number;
    height: number;
  } | null>(null);
  const postJumpTimeoutRef = useRef<number | null>(null);

  const syncScrollState = useCallback((container: HTMLDivElement) => {
    const sticking = isNearBottom(container);
    setIsStickingToBottom((current) => (current === sticking ? current : sticking));
    setShowScrollToBottom((current) => {
      const next = shouldShowScrollToBottom(container);
      return current === next ? current : next;
    });

    modeRef.current = sticking ? "pinned_bottom" : "reading_history";
    timelineScrollAnchorRef.current = sticking
      ? null
      : captureTimelineScrollAnchor(container);
  }, []);

  const reconcileScrollPosition = useCallback(() => {
    const container = containerElement;
    if (!container) {
      pendingReasonsRef.current.clear();
      return;
    }

    const mode = modeRef.current;
    if (mode === "pinned_bottom") {
      const sentinel = bottomSentinelRef.current;
      if (sentinel) {
        scrollBottomSentinelIntoView(container, sentinel);
      } else {
        container.scrollTop = container.scrollHeight;
      }
    } else {
      const anchor = timelineScrollAnchorRef.current;
      if (anchor) {
        restoreAnchorPosition(container, anchor);
      }
    }

    pendingReasonsRef.current.clear();
    syncScrollState(container);
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
    syncScrollState(container);
  }, [containerElement, syncScrollState]);

  const scrollToBottom = useCallback(() => {
    const container = containerElement;
    modeRef.current = "pinned_bottom";
    setIsStickingToBottom(true);
    setShowScrollToBottom(false);
    if (container) {
      const sentinel = bottomSentinelRef.current;
      if (sentinel) {
        scrollBottomSentinelIntoView(container, sentinel);
      } else {
        container.scrollTop = container.scrollHeight;
      }
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
  }, [containerElement, scheduleReconcile]);

  const handleLoadToolGroupMessages = useCallback(
    (entry: ThreadDetailToolGroupRow) => {
      if (!threadId) return;
      if (entry.messages.length > 0 || toolGroupMessagesById[entry.id]) return;
      if (loadingToolGroupIds.has(entry.id)) return;
      setLoadingToolGroupIds((prev) => new Set(prev).add(entry.id));
      void loadToolGroupMessages({
        id: threadId,
        turnId: entry.turnId,
        sourceSeqStart: entry.sourceSeqStart,
        sourceSeqEnd: entry.sourceSeqEnd,
      })
        .then((response) => {
          setToolGroupMessagesById((prev) => ({
            ...prev,
            [entry.id]: response.messages,
          }));
        })
        .finally(() => {
          setLoadingToolGroupIds((prev) => {
            const next = new Set(prev);
            next.delete(entry.id);
            return next;
          });
        });
    },
    [loadToolGroupMessages, loadingToolGroupIds, threadId, toolGroupMessagesById],
  );

  useEffect(() => {
    setLoadingToolGroupIds(new Set());
    setToolGroupMessagesById({});
  }, [threadId]);

  useEffect(() => {
    modeRef.current = "pinned_bottom";
    timelineScrollAnchorRef.current = null;
    previousComposerHeightRef.current = null;
    previousContainerSizeRef.current = null;
    scrollToBottom();
  }, [scrollToBottom, threadId]);

  useEffect(() => {
    scheduleReconcile("timeline_rows_changed");
  }, [scheduleReconcile, threadDetailRows, isSecondaryPanelOpen]);

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
      characterData: true,
      attributes: true,
    });

    return () => {
      observer.disconnect();
    };
  }, [containerElement, scheduleReconcile]);

  useLayoutEffect(() => {
    const container = containerElement;
    if (!container || typeof ResizeObserver === "undefined") {
      return;
    }

    previousContainerSizeRef.current = {
      width: container.clientWidth,
      height: container.clientHeight,
    };

    const observer = new ResizeObserver((entries) => {
      const nextWidth =
        entries[0]?.contentRect.width ?? container.getBoundingClientRect().width;
      const nextHeight =
        entries[0]?.contentRect.height ?? container.getBoundingClientRect().height;
      const previous = previousContainerSizeRef.current;
      previousContainerSizeRef.current = {
        width: nextWidth,
        height: nextHeight,
      };

      if (!previous) {
        scheduleReconcile("container_resized");
        return;
      }

      if (
        Math.abs(previous.width - nextWidth) >= 0.5 ||
        Math.abs(previous.height - nextHeight) >= 0.5
      ) {
        scheduleReconcile("container_resized");
      }
    });

    observer.observe(container);
    return () => {
      observer.disconnect();
      previousContainerSizeRef.current = null;
    };
  }, [containerElement, scheduleReconcile]);

  useLayoutEffect(() => {
    const composer = promptComposerRef.current;
    if (!composer || typeof ResizeObserver === "undefined") {
      return;
    }

    previousComposerHeightRef.current = composer.getBoundingClientRect().height;

    const observer = new ResizeObserver((entries) => {
      const nextHeight =
        entries[0]?.contentRect.height ?? composer.getBoundingClientRect().height;
      const previousHeight = previousComposerHeightRef.current;
      previousComposerHeightRef.current = nextHeight;
      if (previousHeight === null) {
        return;
      }
      if (Math.abs(previousHeight - nextHeight) >= 0.5) {
        scheduleReconcile("composer_height_changed");
      }
    });

    observer.observe(composer);
    return () => {
      observer.disconnect();
      previousComposerHeightRef.current = null;
    };
  }, [scheduleReconcile, threadId]);

  useEffect(() => {
    return () => {
      if (scheduledFrameRef.current !== null && typeof window !== "undefined") {
        window.cancelAnimationFrame(scheduledFrameRef.current);
        scheduledFrameRef.current = null;
      }
      if (postJumpTimeoutRef.current !== null && typeof window !== "undefined") {
        window.clearTimeout(postJumpTimeoutRef.current);
        postJumpTimeoutRef.current = null;
      }
    };
  }, []);

  return {
    bottomSentinelRef,
    captureTimelineScrollPosition,
    handleLoadToolGroupMessages,
    handleTimelineScroll,
    isStickingToBottom,
    loadingToolGroupIds,
    promptComposerRef,
    scrollToBottom,
    setContainerRef,
    showScrollToBottom,
    toolGroupMessagesById,
  };
}
