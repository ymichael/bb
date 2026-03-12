import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import { type ThreadDetailRow, type UIMessage } from "@beanbag/agent-core";
import { DEFAULT_SCROLL_STICK_THRESHOLD_PX } from "@beanbag/ui-core";
import { useAutoScroll } from "@/hooks/useAutoScroll";
import { type ThreadDetailToolGroupRow } from "./threadDetailRows";

const SCROLL_THRESHOLD = 40;
const TIMELINE_ROW_SELECTOR = "[data-thread-row-id]";

interface TimelineScrollAnchor {
  rowId: string;
  offsetTop: number;
}

function isNearBottom(container: HTMLDivElement): boolean {
  const distanceFromBottom =
    container.scrollHeight - container.scrollTop - container.clientHeight;
  return distanceFromBottom <= DEFAULT_SCROLL_STICK_THRESHOLD_PX;
}

function captureTimelineScrollAnchor(
  container: HTMLDivElement,
): TimelineScrollAnchor | null {
  if (isNearBottom(container)) return null;

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
  const {
    containerElement,
    setContainerRef,
    handleScroll,
    scrollToBottom,
    isStickingToBottom,
    showScrollToBottom,
  } = useAutoScroll(threadDetailRows, threadId);
  const promptComposerRef = useRef<HTMLDivElement>(null);
  const promptComposerHeightRef = useRef<number | null>(null);
  const timelineScrollAnchorRef = useRef<TimelineScrollAnchor | null>(null);
  const timelineContainerWidthRef = useRef<number | null>(null);

  const captureTimelineScrollPosition = useCallback(() => {
    const scrollContainer = containerElement;
    if (!scrollContainer) return;
    timelineScrollAnchorRef.current = isStickingToBottom
      ? null
      : captureTimelineScrollAnchor(scrollContainer);
    timelineContainerWidthRef.current = scrollContainer.clientWidth;
  }, [containerElement, isStickingToBottom]);

  const syncTimelineScrollAnchor = useCallback(() => {
    captureTimelineScrollPosition();
  }, [captureTimelineScrollPosition]);

  const handleTimelineScroll = useCallback(() => {
    handleScroll();
    syncTimelineScrollAnchor();
  }, [handleScroll, syncTimelineScrollAnchor]);

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
    timelineScrollAnchorRef.current = null;
    timelineContainerWidthRef.current = null;
  }, [threadId]);

  useEffect(() => {
    if (typeof window === "undefined") {
      syncTimelineScrollAnchor();
      return;
    }

    const frameId = window.requestAnimationFrame(() => {
      syncTimelineScrollAnchor();
    });

    return () => {
      window.cancelAnimationFrame(frameId);
    };
  }, [syncTimelineScrollAnchor, threadDetailRows, isSecondaryPanelOpen]);

  useLayoutEffect(() => {
    const scrollContainer = containerElement;
    if (!scrollContainer || typeof ResizeObserver === "undefined") {
      return;
    }

    timelineContainerWidthRef.current = scrollContainer.clientWidth;

    let frameId: number | null = null;
    const observer = new ResizeObserver((entries) => {
      const nextWidth =
        entries[0]?.contentRect.width ?? scrollContainer.getBoundingClientRect().width;
      const previousWidth = timelineContainerWidthRef.current;
      timelineContainerWidthRef.current = nextWidth;

      if (previousWidth === null || Math.abs(nextWidth - previousWidth) < 0.5) {
        return;
      }

      const anchor = timelineScrollAnchorRef.current;
      if (!anchor) {
        return;
      }

      if (frameId !== null) {
        window.cancelAnimationFrame(frameId);
      }
      frameId = window.requestAnimationFrame(() => {
        const targetRow = findTimelineRowElement(scrollContainer, anchor.rowId);
        if (!targetRow) {
          syncTimelineScrollAnchor();
          return;
        }

        const containerRect = scrollContainer.getBoundingClientRect();
        const targetRect = targetRow.getBoundingClientRect();
        const offsetDelta = targetRect.top - containerRect.top - anchor.offsetTop;
        if (Math.abs(offsetDelta) >= 0.5) {
          scrollContainer.scrollTop += offsetDelta;
        }
        syncTimelineScrollAnchor();
      });
    });

    observer.observe(scrollContainer);
    return () => {
      observer.disconnect();
      if (frameId !== null) {
        window.cancelAnimationFrame(frameId);
      }
    };
  }, [containerElement, syncTimelineScrollAnchor]);

  useLayoutEffect(() => {
    const scrollContainer = containerElement;
    const promptComposer = promptComposerRef.current;
    if (!scrollContainer || !promptComposer || typeof ResizeObserver === "undefined") {
      return;
    }

    promptComposerHeightRef.current = promptComposer.getBoundingClientRect().height;
    const observer = new ResizeObserver((entries) => {
      const nextHeight =
        entries[0]?.contentRect.height ?? promptComposer.getBoundingClientRect().height;
      const previousHeight = promptComposerHeightRef.current;
      promptComposerHeightRef.current = nextHeight;
      if (previousHeight === null) return;
      const heightDelta = nextHeight - previousHeight;
      if (Math.abs(heightDelta) < 0.5) return;
      if (isStickingToBottom) {
        scrollContainer.scrollTop = scrollContainer.scrollHeight;
        return;
      }
      const maxScrollOffset = scrollContainer.scrollHeight - scrollContainer.clientHeight;
      const distanceFromBottom = maxScrollOffset - scrollContainer.scrollTop;
      if (distanceFromBottom <= SCROLL_THRESHOLD) {
        scrollContainer.scrollTop = scrollContainer.scrollHeight;
        return;
      }
      scrollContainer.scrollTop += heightDelta;
    });

    observer.observe(promptComposer);
    return () => {
      observer.disconnect();
      promptComposerHeightRef.current = null;
    };
  }, [containerElement, isStickingToBottom, threadId]);

  return {
    captureTimelineScrollPosition,
    handleLoadToolGroupMessages,
    handleTimelineScroll,
    loadingToolGroupIds,
    promptComposerRef,
    scrollToBottom,
    setContainerRef,
    showScrollToBottom,
    toolGroupMessagesById,
  };
}
