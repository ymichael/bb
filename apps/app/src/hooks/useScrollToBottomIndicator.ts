import { useCallback, useEffect, useState, type RefObject } from "react";

const SCROLL_THRESHOLD = 40;

function getScrollAnimationBehavior(): ScrollBehavior {
  if (typeof window !== "undefined" && window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
    return "auto";
  }
  return "smooth";
}

function shouldShowIndicator(el: HTMLDivElement): boolean {
  const maxScrollOffset = el.scrollHeight - el.clientHeight;
  if (maxScrollOffset <= SCROLL_THRESHOLD) {
    return false;
  }
  const distanceFromBottom = maxScrollOffset - el.scrollTop;
  return distanceFromBottom > SCROLL_THRESHOLD;
}

export function useScrollToBottomIndicator({
  containerRef,
  onBaseScroll,
  resetDep,
}: {
  containerRef: RefObject<HTMLDivElement | null>;
  onBaseScroll?: () => void;
  resetDep?: unknown;
}) {
  const [showScrollToBottom, setShowScrollToBottom] = useState(false);

  const syncVisibility = useCallback(() => {
    const el = containerRef.current;
    if (!el) return;
    setShowScrollToBottom(shouldShowIndicator(el));
  }, [containerRef]);

  useEffect(() => {
    setShowScrollToBottom(false);
  }, [resetDep]);

  const handleScroll = useCallback(() => {
    onBaseScroll?.();
    syncVisibility();
  }, [onBaseScroll, syncVisibility]);

  const scrollToBottom = useCallback(() => {
    const el = containerRef.current;
    if (!el) return;
    el.scrollTo({
      top: el.scrollHeight,
      behavior: getScrollAnimationBehavior(),
    });
    // Keep upstream auto-scroll "stick to bottom" state in sync even when a
    // programmatic scroll does not fire a scroll event (or does not change).
    onBaseScroll?.();
    setShowScrollToBottom(false);
  }, [containerRef, onBaseScroll]);

  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;

    let frameId: number | null = null;
    const scheduleSync = () => {
      if (frameId !== null) return;
      frameId = window.requestAnimationFrame(() => {
        frameId = null;
        syncVisibility();
      });
    };

    const mutationObserver = new MutationObserver(() => {
      scheduleSync();
    });
    mutationObserver.observe(el, {
      subtree: true,
      childList: true,
      characterData: true,
      attributes: true,
    });

    let resizeObserver: ResizeObserver | undefined;
    if (typeof ResizeObserver !== "undefined") {
      resizeObserver = new ResizeObserver(() => {
        scheduleSync();
      });
      resizeObserver.observe(el);
    }

    window.addEventListener("resize", scheduleSync);
    scheduleSync();

    return () => {
      mutationObserver.disconnect();
      resizeObserver?.disconnect();
      window.removeEventListener("resize", scheduleSync);
      if (frameId !== null) {
        window.cancelAnimationFrame(frameId);
      }
    };
  }, [containerRef, syncVisibility]);

  return {
    showScrollToBottom,
    handleScroll,
    scrollToBottom,
  };
}
