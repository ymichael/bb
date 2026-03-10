import {
  useEffect,
  useRef,
  type ReactNode,
} from "react";
import {
  DEFAULT_SCROLL_STICK_THRESHOLD_PX,
  getScrollAnimationBehavior,
} from "@beanbag/ui-core";
import { cn } from "@/lib/utils";
import {
  useLatestInitialExpanded,
} from "@/lib/latestInitialExpanded";

export const EVENT_DETAIL_MAX_HEIGHT_CLASS = "max-h-[220px]";
export const EVENT_LARGE_DETAIL_MAX_HEIGHT_CLASS = "max-h-[320px]";
export const DEBUG_EVENT_EXPANDED_MAX_LENGTH = 4000;

export type EventTitleTone = "default" | "destructive";

export function OngoingEventLabel({ children }: { children: ReactNode }) {
  return <span className="animate-shine">{children}</span>;
}

export function renderShimmeringSummary(
  content: ReactNode,
  shouldShimmer: boolean,
): ReactNode {
  if (!shouldShimmer) return content;
  return <OngoingEventLabel>{content}</OngoingEventLabel>;
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
  emphasis,
  suffix,
  tone = "default",
  className,
  prefixClassName,
  emphasisClassName,
  suffixClassName,
  emphasisAs: EmphasisTag = "span",
}: {
  prefix: ReactNode;
  emphasis?: ReactNode;
  suffix?: ReactNode;
  tone?: EventTitleTone;
  className?: string;
  prefixClassName?: string;
  emphasisClassName?: string;
  suffixClassName?: string;
  emphasisAs?: "span" | "em";
}) {
  const prefixToneClass =
    tone === "destructive" ? "text-destructive/85" : "text-muted-foreground/90";
  const emphasisToneClass =
    tone === "destructive" ? "text-destructive" : "text-foreground/95";
  const suffixToneClass =
    tone === "destructive" ? "text-destructive/80" : "text-muted-foreground/75";

  return (
    <span className={cn("inline-flex min-w-0 items-center gap-1.5", className)}>
      <span className={cn("shrink-0", prefixToneClass, prefixClassName)}>{prefix}</span>
      {emphasis !== undefined ? (
        <EmphasisTag
          className={cn("truncate font-semibold not-italic", emphasisToneClass, emphasisClassName)}
        >
          {emphasis}
        </EmphasisTag>
      ) : null}
      {suffix !== undefined ? (
        <span className={cn("shrink-0", suffixToneClass, suffixClassName)}>{suffix}</span>
      ) : null}
    </span>
  );
}

export function formatCompactDuration(durationMs: number): string {
  if (!Number.isFinite(durationMs) || durationMs < 0) return "0s";
  if (durationMs < 1_000) return `${Math.round(durationMs)}ms`;
  const totalSeconds = Math.round(durationMs / 1_000);
  if (totalSeconds < 60) return `${totalSeconds}s`;
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${minutes}m ${seconds}s`;
}

export function formatSummaryDuration(
  durationMs: number | undefined,
  minVisibleMs: number = 1_000,
): string | undefined {
  if (durationMs === undefined || durationMs < minVisibleMs) {
    return undefined;
  }
  return formatCompactDuration(durationMs);
}

export { useLatestInitialExpanded };

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
