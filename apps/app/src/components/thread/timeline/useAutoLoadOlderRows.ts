import { useCallback, useEffect, useRef, useState } from "react";
import { useBottomAnchoredScroll } from "@/components/ui/bottom-anchored-scroll-body.js";

const AUTO_LOAD_OLDER_ROWS_PREFETCH_MARGIN_PX = 600;

interface UseAutoLoadOlderRowsArgs {
  hasOlderTimelineRows: boolean;
  isLoadingOlderTimelineRows: boolean;
  onLoadOlderRows: (() => Promise<void> | void) | undefined;
}

interface AutoLoadOlderRows {
  sentinelRef: (node: HTMLElement | null) => void;
  isAutoLoadEnabled: boolean;
  loadOlderRows: () => void;
}

function isSentinelWithinPrefetchRange({
  scrollElement,
  sentinel,
}: {
  scrollElement: HTMLElement;
  sentinel: HTMLElement;
}): boolean {
  const scrollRect = scrollElement.getBoundingClientRect();
  const sentinelRect = sentinel.getBoundingClientRect();
  return (
    sentinelRect.bottom >=
      scrollRect.top - AUTO_LOAD_OLDER_ROWS_PREFETCH_MARGIN_PX &&
    sentinelRect.top <= scrollRect.bottom
  );
}

export function useAutoLoadOlderRows({
  hasOlderTimelineRows,
  isLoadingOlderTimelineRows,
  onLoadOlderRows,
}: UseAutoLoadOlderRowsArgs): AutoLoadOlderRows {
  const bottomAnchor = useBottomAnchoredScroll();
  const sentinelNodeRef = useRef<HTMLElement | null>(null);
  const isIntersectingRef = useRef(false);
  const [sentinelVersion, setSentinelVersion] = useState(0);
  const [intersectionTick, setIntersectionTick] = useState(0);
  const [autoLoadFailed, setAutoLoadFailed] = useState(false);

  const sentinelRef = useCallback((node: HTMLElement | null) => {
    sentinelNodeRef.current = node;
    setSentinelVersion((version) => version + 1);
  }, []);

  const isAutoLoadEnabled =
    bottomAnchor !== null &&
    hasOlderTimelineRows &&
    onLoadOlderRows !== undefined &&
    !autoLoadFailed;

  const startLoad = useCallback(() => {
    if (!onLoadOlderRows) {
      return;
    }
    bottomAnchor?.captureScrollAnchor();
    void (async () => {
      try {
        await onLoadOlderRows();
      } catch {
        setAutoLoadFailed(true);
      }
    })();
  }, [bottomAnchor, onLoadOlderRows]);

  const loadOlderRows = useCallback(() => {
    setAutoLoadFailed(false);
    startLoad();
  }, [startLoad]);

  useEffect(() => {
    if (!isAutoLoadEnabled) {
      isIntersectingRef.current = false;
      return;
    }
    const sentinel = sentinelNodeRef.current;
    if (!sentinel) {
      return;
    }
    const observer = new IntersectionObserver(
      (entries) => {
        const entry = entries.at(-1);
        isIntersectingRef.current = entry?.isIntersecting ?? false;
        if (isIntersectingRef.current) {
          setIntersectionTick((tick) => tick + 1);
        }
      },
      {
        root: bottomAnchor?.getScrollElement() ?? null,
        rootMargin: `${AUTO_LOAD_OLDER_ROWS_PREFETCH_MARGIN_PX}px 0px 0px 0px`,
      },
    );
    observer.observe(sentinel);
    return () => observer.disconnect();
  }, [bottomAnchor, isAutoLoadEnabled, sentinelVersion]);

  useEffect(() => {
    if (
      !isAutoLoadEnabled ||
      isLoadingOlderTimelineRows ||
      !isIntersectingRef.current
    ) {
      return;
    }
    const sentinel = sentinelNodeRef.current;
    const scrollElement = bottomAnchor?.getScrollElement();
    if (!sentinel || !scrollElement) {
      return;
    }
    if (!isSentinelWithinPrefetchRange({ scrollElement, sentinel })) {
      isIntersectingRef.current = false;
      return;
    }
    startLoad();
  }, [
    bottomAnchor,
    intersectionTick,
    isAutoLoadEnabled,
    isLoadingOlderTimelineRows,
    startLoad,
  ]);

  return { sentinelRef, isAutoLoadEnabled, loadOlderRows };
}
