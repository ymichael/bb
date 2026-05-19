import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { cn } from "@/lib/utils";
import { PAGE_SHELL_CONTENT_STYLE } from "./page-shell-content-style.js";

// BottomAnchoredScrollBody owns "follow the bottom" behavior for streaming
// surfaces. It combines two mechanisms because neither is sufficient alone:
//
// - At the bottom, CSS scroll anchoring is redirected to the trailing 1px
//   `.scroll-bottom-anchor` sentinel. That lets Chromium/Firefox keep the
//   bottom pinned through width-driven markdown reflow without anchoring to a
//   random message row.
// - ResizeObserver plus a short rAF restore loop covers layout changes that
//   browser anchoring does not reliably handle, such as sidebar collapse,
//   prompt/footer height changes, and async content settling.
//
// When the user intentionally scrolls away, the sentinel class is removed so
// normal browser anchoring can preserve the visible row while reading in the
// middle of the timeline. User intent is inferred from wheel/touch/keyboard
// input and pointer-drag scrolling before a non-bottom scroll event.

export interface BottomAnchorContextValue {
  isAtBottom: boolean;
  scrollToBottom: () => void;
  scrollElementIntoView: (args: ScrollElementIntoViewArgs) => void;
  /**
   * Scroll only far enough to reveal the element, clamped to the scroll area's
   * max offset. If the resulting position is near max, stick-to-bottom is
   * re-enabled so near-bottom reveals keep following later timeline growth.
   */
  scrollElementIntoViewClampedToMaxScroll: (
    args: ScrollElementIntoViewClampedToMaxScrollArgs,
  ) => void;
  // Snapshot the scroll area so the next height growth (e.g. prepending older
  // messages) keeps the visible row at the same Y position instead of jumping.
  captureScrollAnchor: () => void;
}

export interface BottomAnchoredScrollBodyProps {
  children: ReactNode;
  footer: ReactNode;
  scrollAreaClassName?: string;
  contentClassName?: string;
  maxWidthClassName: string;
}

export interface ScrollElementIntoViewArgs {
  element: HTMLElement;
  options?: ScrollIntoViewOptions;
}

export interface ScrollElementIntoViewClampedToMaxScrollArgs {
  element: HTMLElement;
}

interface ElementVisibilityArgs {
  element: HTMLElement;
  scrollArea: HTMLElement;
}

const BOTTOM_ANCHOR_THRESHOLD_PX = 4;
const USER_SCROLL_INTENT_MS = 1_000;
// ResizeObserver can fire before related flex/sidebar/prompt layout settles.
// Re-applying briefly covers cascading layout work without an unbounded loop.
const BOTTOM_RESTORE_SETTLE_FRAME_COUNT = 3;
const SCROLL_INTENT_KEYS = new Set([
  "ArrowDown",
  "ArrowUp",
  "End",
  "Home",
  "PageDown",
  "PageUp",
  " ",
]);

const BottomAnchorContext = createContext<BottomAnchorContextValue | null>(
  null,
);

export function useBottomAnchoredScroll(): BottomAnchorContextValue | null {
  return useContext(BottomAnchorContext);
}

function getMaxScrollOffset(element: HTMLElement) {
  return Math.max(0, element.scrollHeight - element.clientHeight);
}

function isScrolledNearBottom(element: HTMLElement) {
  return (
    getMaxScrollOffset(element) - element.scrollTop <=
    BOTTOM_ANCHOR_THRESHOLD_PX
  );
}

function scrollElementToBottom(element: HTMLElement) {
  element.scrollTop = getMaxScrollOffset(element);
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

function getRevealScrollOffsetClampedToMax(args: ElementVisibilityArgs) {
  return Math.min(
    getMaxScrollOffset(args.scrollArea),
    getScrollOffsetToRevealElement(args),
  );
}

function isScrollIntentKey(event: KeyboardEvent) {
  return SCROLL_INTENT_KEYS.has(event.key);
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
  children,
}: BottomAnchoredScrollBodyProps) {
  const scrollAreaRef = useRef<HTMLDivElement>(null);
  const contentRef = useRef<HTMLDivElement>(null);
  const shouldStickToBottomRef = useRef(true);
  const userScrollIntentUntilRef = useRef(0);
  const pointerScrollIntentRef = useRef(false);
  const restoreFrameRef = useRef<number | null>(null);
  const restoreFramesRemainingRef = useRef(0);
  const pendingPrependAnchorRef = useRef<{
    scrollHeight: number;
    scrollTop: number;
  } | null>(null);
  const [isAtBottom, setIsAtBottom] = useState(true);

  const cancelQueuedRestore = useCallback(() => {
    if (restoreFrameRef.current === null) return;
    window.cancelAnimationFrame(restoreFrameRef.current);
    restoreFrameRef.current = null;
    restoreFramesRemainingRef.current = 0;
  }, []);

  const runQueuedRestore = useCallback(() => {
    restoreFrameRef.current = null;
    const scrollArea = scrollAreaRef.current;
    if (!scrollArea || !shouldStickToBottomRef.current) {
      restoreFramesRemainingRef.current = 0;
      return;
    }

    // CSS scroll anchoring (the trailing sentinel) keeps scrollTop pinned at
    // sub-pixel precision during content growth/shrink. `scrollElementToBottom`
    // sets `scrollTop = scrollHeight - clientHeight` — both integer-rounded
    // Web API values — so calling it while we're already within sub-pixel
    // range yanks scrollTop by ±1px against the browser's fractional value,
    // producing visible jitter on every frame of a row expand/collapse.
    // Restore only when anchoring has actually let us drift away from bottom.
    if (isScrolledNearBottom(scrollArea)) {
      restoreFramesRemainingRef.current = 0;
      return;
    }

    scrollElementToBottom(scrollArea);
    restoreFramesRemainingRef.current -= 1;
    if (restoreFramesRemainingRef.current > 0) {
      restoreFrameRef.current = window.requestAnimationFrame(runQueuedRestore);
    }
  }, []);

  const queueBottomRestore = useCallback(() => {
    if (!shouldStickToBottomRef.current) return;
    restoreFramesRemainingRef.current = BOTTOM_RESTORE_SETTLE_FRAME_COUNT;
    if (restoreFrameRef.current !== null) return;
    restoreFrameRef.current = window.requestAnimationFrame(runQueuedRestore);
  }, [runQueuedRestore]);

  const scrollToBottom = useCallback(() => {
    const scrollArea = scrollAreaRef.current;
    shouldStickToBottomRef.current = true;
    setIsAtBottom(true);
    if (scrollArea) {
      scrollElementToBottom(scrollArea);
    }
    queueBottomRestore();
  }, [queueBottomRestore]);

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

      scrollArea.scrollTop = getRevealScrollOffsetClampedToMax({
        element,
        scrollArea,
      });

      const targetIsAtBottom = isScrolledNearBottom(scrollArea);
      shouldStickToBottomRef.current = targetIsAtBottom;
      setIsAtBottom(targetIsAtBottom);

      if (targetIsAtBottom) {
        queueBottomRestore();
        return;
      }

      cancelQueuedRestore();
    },
    [cancelQueuedRestore, queueBottomRestore],
  );

  const captureScrollAnchor = useCallback(() => {
    const scrollArea = scrollAreaRef.current;
    if (!scrollArea) return;
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
  });

  const markUserScrollIntent = useCallback(() => {
    userScrollIntentUntilRef.current =
      window.performance.now() + USER_SCROLL_INTENT_MS;
  }, []);

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
      if (!isScrollIntentKey(event)) return;
      if (isEditableKeyboardTarget(event.target)) return;
      if (!isKeyboardEventFromScrollArea(event, scrollArea)) return;

      markUserScrollIntent();
    },
    [markUserScrollIntent],
  );

  const syncBottomStateFromScroll = useCallback(() => {
    const scrollArea = scrollAreaRef.current;
    if (!scrollArea) return;

    if (isScrolledNearBottom(scrollArea)) {
      shouldStickToBottomRef.current = true;
      setIsAtBottom(true);
      return;
    }

    const hasUserScrollIntent =
      pointerScrollIntentRef.current ||
      window.performance.now() <= userScrollIntentUntilRef.current;

    if (!hasUserScrollIntent) return;

    shouldStickToBottomRef.current = false;
    setIsAtBottom(false);
    cancelQueuedRestore();
  }, [cancelQueuedRestore]);

  const bottomAnchorContextValue = useMemo<BottomAnchorContextValue>(
    () => ({
      isAtBottom,
      scrollToBottom,
      scrollElementIntoView,
      scrollElementIntoViewClampedToMaxScroll,
      captureScrollAnchor,
    }),
    [
      isAtBottom,
      scrollToBottom,
      scrollElementIntoView,
      scrollElementIntoViewClampedToMaxScroll,
      captureScrollAnchor,
    ],
  );

  useEffect(() => {
    const scrollArea = scrollAreaRef.current;
    const content = contentRef.current;
    if (!scrollArea || !content) return;

    let resizeObserver: ResizeObserver | undefined;
    if (typeof ResizeObserver !== "undefined") {
      resizeObserver = new ResizeObserver(queueBottomRestore);
      resizeObserver.observe(scrollArea);
      resizeObserver.observe(content);
    }

    scrollArea.addEventListener("scroll", syncBottomStateFromScroll, {
      passive: true,
    });
    scrollArea.addEventListener("wheel", markUserScrollIntent, {
      passive: true,
    });
    scrollArea.addEventListener("touchstart", markUserScrollIntent, {
      passive: true,
    });
    scrollArea.addEventListener("touchmove", markUserScrollIntent, {
      passive: true,
    });
    // Captures scrollbar-thumb drags and other pointer-driven scrolling that
    // can produce `scroll` without a preceding wheel/touch event. The matching
    // window listeners clear the flag even if the pointer leaves the scrollport.
    scrollArea.addEventListener("pointerdown", startPointerScrollIntent, {
      passive: true,
    });
    window.addEventListener("pointerup", endPointerScrollIntent);
    window.addEventListener("pointercancel", endPointerScrollIntent);
    window.addEventListener("keydown", markKeyboardScrollIntent);

    queueBottomRestore();

    return () => {
      resizeObserver?.disconnect();
      scrollArea.removeEventListener("scroll", syncBottomStateFromScroll);
      scrollArea.removeEventListener("wheel", markUserScrollIntent);
      scrollArea.removeEventListener("touchstart", markUserScrollIntent);
      scrollArea.removeEventListener("touchmove", markUserScrollIntent);
      scrollArea.removeEventListener("pointerdown", startPointerScrollIntent);
      window.removeEventListener("pointerup", endPointerScrollIntent);
      window.removeEventListener("pointercancel", endPointerScrollIntent);
      window.removeEventListener("keydown", markKeyboardScrollIntent);
      cancelQueuedRestore();
    };
  }, [
    cancelQueuedRestore,
    endPointerScrollIntent,
    markKeyboardScrollIntent,
    markUserScrollIntent,
    queueBottomRestore,
    startPointerScrollIntent,
    syncBottomStateFromScroll,
  ]);

  return (
    <BottomAnchorContext.Provider value={bottomAnchorContextValue}>
      <div className="relative flex min-h-0 flex-1 flex-col overflow-hidden">
        <div
          ref={scrollAreaRef}
          className={cn(
            "@container/page min-h-0 flex-1 overflow-y-auto",
            scrollAreaClassName,
          )}
        >
          <div
            ref={contentRef}
            className={cn(
              "mx-auto flex w-full flex-col px-4 pb-4 pt-2",
              isAtBottom && "scroll-bottom-anchor-content",
              maxWidthClassName,
              contentClassName,
            )}
            style={PAGE_SHELL_CONTENT_STYLE}
          >
            {children}
            <div className="scroll-bottom-anchor" aria-hidden />
          </div>
        </div>
        {footer}
      </div>
    </BottomAnchorContext.Provider>
  );
}
