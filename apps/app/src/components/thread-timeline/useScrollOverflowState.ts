import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type RefObject,
} from "react";

/**
 * Tracks whether a scroll element has hidden content above and/or below the
 * visible area so callers can render edge-fade affordances only when the
 * fades actually communicate something.
 *
 * Implemented with two zero-height sentinel elements at the top and bottom
 * of the scrolling content and an `IntersectionObserver` rooted on the
 * scroll element. This is intentional: the alternative (`ResizeObserver` +
 * reading `scrollTop`/`scrollHeight`) forces synchronous layout per fire,
 * and ResizeObserver fires every animation frame while a parent expand
 * transition is interpolating the container's height — which made the
 * timeline expand/collapse animation visibly choppy. IntersectionObserver
 * is async and only delivers callbacks when a sentinel actually crosses
 * the visible boundary, so it doesn't pile up work during animations.
 */
export interface ScrollOverflowSentinelRefs<TElement extends HTMLElement> {
  scrollRef: RefObject<TElement | null>;
  topSentinelRef: RefObject<HTMLDivElement | null>;
  bottomSentinelRef: RefObject<HTMLDivElement | null>;
}

export interface ScrollOverflowStateBinding<TElement extends HTMLElement>
  extends ScrollOverflowSentinelRefs<TElement> {
  aboveOverflow: boolean;
  belowOverflow: boolean;
}

interface OverflowFlags {
  above: boolean;
  below: boolean;
}

export function useScrollOverflowState<
  TElement extends HTMLElement,
>(): ScrollOverflowStateBinding<TElement> {
  const scrollRef = useRef<TElement>(null);
  const topSentinelRef = useRef<HTMLDivElement>(null);
  const bottomSentinelRef = useRef<HTMLDivElement>(null);
  const [flags, setFlags] = useState<OverflowFlags>({
    above: false,
    below: false,
  });

  const applyFlags = useCallback((next: OverflowFlags) => {
    setFlags((previous) =>
      previous.above === next.above && previous.below === next.below
        ? previous
        : next,
    );
  }, []);

  useEffect(() => {
    const scroll = scrollRef.current;
    const topSentinel = topSentinelRef.current;
    const bottomSentinel = bottomSentinelRef.current;
    if (
      !scroll ||
      !topSentinel ||
      !bottomSentinel ||
      typeof IntersectionObserver === "undefined"
    ) {
      return;
    }

    let aboveVisible = true;
    let belowVisible = true;

    const observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          if (entry.target === topSentinel) {
            aboveVisible = entry.isIntersecting;
          } else if (entry.target === bottomSentinel) {
            belowVisible = entry.isIntersecting;
          }
        }
        applyFlags({
          above: !aboveVisible,
          below: !belowVisible,
        });
      },
      { root: scroll, threshold: 0 },
    );

    observer.observe(topSentinel);
    observer.observe(bottomSentinel);
    return () => {
      observer.disconnect();
    };
  }, [applyFlags]);

  return {
    scrollRef,
    topSentinelRef,
    bottomSentinelRef,
    aboveOverflow: flags.above,
    belowOverflow: flags.below,
  };
}
