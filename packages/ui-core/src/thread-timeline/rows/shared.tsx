import {
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type Ref,
  type ReactNode,
  type RefObject,
  type UIEvent,
} from "react";
import { durationToCompactString } from "@bb/core-ui";
import {
  DEFAULT_SCROLL_STICK_THRESHOLD_PX,
  getScrollAnimationBehavior,
} from "../../scroll.js";
import { cx } from "../../utils.js";

export const EVENT_DETAIL_MAX_HEIGHT_CLASS = "max-h-[220px]";
export const EVENT_LARGE_DETAIL_MAX_HEIGHT_CLASS = "max-h-[320px]";
export const DEBUG_EVENT_EXPANDED_MAX_LENGTH = 4000;

export type EventTitleTone = "default" | "destructive";

function OngoingEventLabel({ children }: { children: ReactNode }) {
  return <span className="animate-shine">{children}</span>;
}

export function getEventHeaderToneClass(
  isExpanded: boolean,
  tone: EventTitleTone = "default",
): string {
  if (tone === "destructive") {
    return isExpanded
      ? "text-destructive"
      : "text-destructive/90 transition-colors group-hover:text-destructive group-focus-within:text-destructive";
  }
  return isExpanded
    ? "text-foreground/90"
    : "text-muted-foreground/90 transition-colors group-hover:text-foreground/90 group-focus-within:text-foreground/90";
}

export function getStaticEventToneClass(tone: EventTitleTone = "default"): string {
  if (tone === "destructive") return "text-destructive/90";
  return "text-muted-foreground/90";
}

export function EventTitle({
  prefix,
  detail,
  emphasis,
  suffix,
  tone = "default",
  shimmerPrefix = false,
  className,
  prefixClassName,
  detailClassName,
  emphasisClassName,
  suffixClassName,
  emphasisAs: EmphasisTag = "span",
}: {
  prefix: ReactNode;
  detail?: ReactNode;
  emphasis?: ReactNode;
  suffix?: ReactNode;
  tone?: EventTitleTone;
  shimmerPrefix?: boolean;
  className?: string;
  prefixClassName?: string;
  detailClassName?: string;
  emphasisClassName?: string;
  suffixClassName?: string;
  emphasisAs?: "span" | "em";
}) {
  const prefixToneClass =
    tone === "destructive" ? "text-destructive/85" : "text-muted-foreground/90";
  const detailToneClass =
    tone === "destructive" ? "text-destructive/90" : "text-foreground/85";
  const emphasisToneClass =
    tone === "destructive" ? "text-destructive" : "text-foreground/95";
  const suffixToneClass =
    tone === "destructive" ? "text-destructive/80" : "text-muted-foreground/75";
  const prefixContent = shimmerPrefix ? <OngoingEventLabel>{prefix}</OngoingEventLabel> : prefix;

  return (
    <span className={cx("inline-flex min-w-0 items-center gap-1.5", className)}>
      <span className={cx("shrink-0", prefixToneClass, prefixClassName)}>{prefixContent}</span>
      {detail !== undefined ? (
        <span className={cx("min-w-0 truncate", detailToneClass, detailClassName)}>{detail}</span>
      ) : null}
      {emphasis !== undefined ? (
        <EmphasisTag
          className={cx("truncate font-semibold not-italic", emphasisToneClass, emphasisClassName)}
        >
          {emphasis}
        </EmphasisTag>
      ) : null}
      {suffix !== undefined ? (
        <span className={cx("shrink-0", suffixToneClass, suffixClassName)}>{suffix}</span>
      ) : null}
    </span>
  );
}

export function ExpandableDetailScrollArea({
  children,
  className,
  maxHeightClassName = EVENT_DETAIL_MAX_HEIGHT_CLASS,
  onScroll,
  scrollRef,
}: {
  children: ReactNode;
  className?: string;
  maxHeightClassName?: string;
  onScroll?: (event: UIEvent<HTMLDivElement>) => void;
  scrollRef?: Ref<HTMLDivElement>;
}) {
  return (
    <div
      ref={scrollRef}
      onScroll={onScroll}
      className={cx(maxHeightClassName, "overflow-auto", className)}
    >
      {children}
    </div>
  );
}

export function formatSummaryDuration(
  durationMs: number | undefined,
  minVisibleMs: number = 1_000,
): string | undefined {
  if (durationMs === undefined || durationMs < minVisibleMs) {
    return undefined;
  }
  return durationToCompactString(durationMs);
}

function isScrolledNearBottom(
  element: Pick<HTMLElement, "scrollHeight" | "clientHeight" | "scrollTop">,
): boolean {
  const maxScrollOffset = element.scrollHeight - element.clientHeight;
  if (maxScrollOffset <= DEFAULT_SCROLL_STICK_THRESHOLD_PX) {
    return true;
  }
  const distanceFromBottom = maxScrollOffset - element.scrollTop;
  return distanceFromBottom <= DEFAULT_SCROLL_STICK_THRESHOLD_PX;
}

/**
 * Returns whether `ref`'s element has content that exceeds its visible height.
 * Uses ResizeObserver to re-measure on width changes; additional content-level
 * dependencies can be passed via `deps` to re-run the check when the contents
 * change without triggering a size change (e.g. when the element is clamped).
 * When `enabled` is false the observer is skipped and the result stays `false`.
 */
export function useIsOverflowing(
  ref: RefObject<HTMLElement | null>,
  enabled: boolean,
  deps: readonly unknown[] = [],
): boolean {
  const [isOverflowing, setIsOverflowing] = useState(false);

  useLayoutEffect(() => {
    if (!enabled) {
      setIsOverflowing(false);
      return;
    }
    const el = ref.current;
    if (!el) return;
    const check = () => {
      setIsOverflowing(el.scrollHeight > el.clientHeight + 1);
    };
    check();
    const observer = new ResizeObserver(check);
    observer.observe(el);
    return () => observer.disconnect();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [enabled, ref, ...deps]);

  return isOverflowing;
}

export function useStickyBottomAutoScroll<ElementType extends HTMLElement>({
  isExpanded,
  scrollDep,
}: {
  isExpanded: boolean;
  scrollDep: unknown;
}) {
  const elementRef = useRef<ElementType | null>(null);
  const shouldStickToBottomRef = useRef(true);

  useEffect(() => {
    if (!isExpanded) return;
    shouldStickToBottomRef.current = true;
  }, [isExpanded]);

  useEffect(() => {
    if (!isExpanded || !shouldStickToBottomRef.current) return;
    const element = elementRef.current;
    if (!element) return;
    element.scrollTo({
      top: element.scrollHeight,
      behavior: getScrollAnimationBehavior(),
    });
  }, [isExpanded, scrollDep]);

  const handleScroll = () => {
    const element = elementRef.current;
    if (!element) return;
    shouldStickToBottomRef.current = isScrolledNearBottom(element);
  };

  return { elementRef, handleScroll };
}
