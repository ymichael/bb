import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type RefObject,
} from "react";

interface ScrollOverflowSentinelRefs<TElement extends HTMLElement> {
  scrollRef: RefObject<TElement | null>;
  topSentinelRef: RefObject<HTMLDivElement | null>;
  bottomSentinelRef: RefObject<HTMLDivElement | null>;
}

interface ScrollOverflowStateBinding<
  TElement extends HTMLElement,
> extends ScrollOverflowSentinelRefs<TElement> {
  aboveOverflow: boolean;
  belowOverflow: boolean;
}

interface UseScrollOverflowStateOptions {
  enabled?: boolean;
  measureOverflow?: boolean;
}

interface OverflowFlags {
  above: boolean;
  below: boolean;
}

export function useScrollOverflowState<TElement extends HTMLElement>(
  options: UseScrollOverflowStateOptions = {},
): ScrollOverflowStateBinding<TElement> {
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
    if (options.enabled === false) {
      applyFlags({ above: false, below: false });
      return;
    }
    if (!options.measureOverflow || typeof window === "undefined") {
      return;
    }

    const scroll = scrollRef.current;
    if (!scroll) {
      return;
    }

    let frame: number | null = null;
    const measure = () => {
      frame = null;
      applyFlags({
        above: scroll.scrollTop > 1,
        below: scroll.scrollHeight - scroll.scrollTop - scroll.clientHeight > 1,
      });
    };
    const scheduleMeasure = () => {
      if (frame !== null) return;
      frame =
        typeof window.requestAnimationFrame === "function"
          ? window.requestAnimationFrame(measure)
          : window.setTimeout(measure, 0);
    };

    scheduleMeasure();
    scroll.addEventListener("scroll", scheduleMeasure, { passive: true });

    const resizeObserver =
      typeof ResizeObserver === "undefined"
        ? null
        : new ResizeObserver(scheduleMeasure);
    resizeObserver?.observe(scroll);

    const mutationObserver =
      typeof MutationObserver === "undefined"
        ? null
        : new MutationObserver(scheduleMeasure);
    mutationObserver?.observe(scroll, {
      childList: true,
      characterData: true,
      subtree: true,
    });

    return () => {
      if (frame !== null) {
        if (typeof window.cancelAnimationFrame === "function") {
          window.cancelAnimationFrame(frame);
        } else {
          window.clearTimeout(frame);
        }
      }
      scroll.removeEventListener("scroll", scheduleMeasure);
      resizeObserver?.disconnect();
      mutationObserver?.disconnect();
    };
  }, [applyFlags, options.enabled, options.measureOverflow]);

  useEffect(() => {
    if (options.enabled === false) return;
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
        const hasOverflow = scroll.scrollHeight - scroll.clientHeight > 1;
        applyFlags({
          above: hasOverflow && !aboveVisible,
          below: hasOverflow && !belowVisible,
        });
      },
      { root: scroll, threshold: 0 },
    );

    observer.observe(topSentinel);
    observer.observe(bottomSentinel);
    return () => {
      observer.disconnect();
    };
  }, [applyFlags, options.enabled]);

  return {
    scrollRef,
    topSentinelRef,
    bottomSentinelRef,
    aboveOverflow: flags.above,
    belowOverflow: flags.below,
  };
}
