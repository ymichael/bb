import { useCallback, type ReactNode, type UIEvent } from "react";
import { useComposedRefs } from "@radix-ui/react-compose-refs";
import { cn } from "../ui/cn.js";
import {
  getDetailScrollMaxHeightClass,
  type DetailScrollSize,
} from "../ui/detail-scroll-size.js";
import {
  useStickyBottomScroll,
  type StickyBottomScrollBinding,
} from "./useStickyBottomScroll.js";
import {
  useScrollOverflowState,
  type ScrollOverflowStateBinding,
} from "./useScrollOverflowState.js";

export interface TimelineDetailScrollProps {
  size: DetailScrollSize;
  /**
   * When true, the scroll container sticks to the bottom as `contentKey`
   * changes — for incremental streams (command/tool output, growing bundle).
   * When false, the user's scroll position is preserved across content
   * updates and the container does not auto-scroll.
   */
  streaming?: boolean;
  /**
   * Identity string for the rendered content. Required when `streaming` is
   * true so sticky-bottom fires after each chunk. Unused when `streaming` is
   * false — overflow-fade affordances react to actual scroll position via
   * `IntersectionObserver` and don't need a content key.
   */
  contentKey: string;
  className?: string;
  /**
   * Class names applied to the inner scroll element. Use this to add the
   * caller's content padding/typography — `TimelineDetailScroll` itself owns
   * only the scroll mechanics (max-height, overflow, fade affordances).
   */
  scrollClassName?: string;
  children: ReactNode;
}

type StreamingBinding = {
  kind: "streaming";
  overflow: ScrollOverflowStateBinding<HTMLDivElement>;
  sticky: StickyBottomScrollBinding<HTMLDivElement>;
};

type StaticBinding = {
  kind: "static";
  overflow: ScrollOverflowStateBinding<HTMLDivElement>;
};

function StreamingDetailScroll(props: TimelineDetailScrollProps) {
  const sticky = useStickyBottomScroll<HTMLDivElement>({
    contentKey: props.contentKey,
    streaming: true,
  });
  const overflow = useScrollOverflowState<HTMLDivElement>();
  return (
    <DetailScrollContent
      {...props}
      binding={{ kind: "streaming", overflow, sticky }}
    />
  );
}

function StaticDetailScroll(props: TimelineDetailScrollProps) {
  const overflow = useScrollOverflowState<HTMLDivElement>();
  return (
    <DetailScrollContent {...props} binding={{ kind: "static", overflow }} />
  );
}

function DetailScrollContent({
  binding,
  size,
  className,
  scrollClassName,
  children,
}: TimelineDetailScrollProps & {
  binding: StreamingBinding | StaticBinding;
}) {
  const maxHeightClassName = getDetailScrollMaxHeightClass(size);
  const { aboveOverflow, belowOverflow } = binding.overflow;

  const handleScroll = useCallback(
    (event: UIEvent<HTMLDivElement>) => {
      if (binding.kind === "streaming") {
        binding.sticky.onScroll(event);
      }
    },
    [binding],
  );

  const refCallback = useComposedRefs<HTMLDivElement>(
    binding.kind === "streaming" ? binding.sticky.ref : undefined,
    binding.overflow.scrollRef,
  );

  const stickyHandlers =
    binding.kind === "streaming"
      ? {
          onPointerDown: binding.sticky.onPointerDown,
          onTouchMove: binding.sticky.onTouchMove,
          onTouchStart: binding.sticky.onTouchStart,
          onWheel: binding.sticky.onWheel,
        }
      : {};

  return (
    <div
      className={cn("relative isolate min-w-0", className)}
      data-detail-scroll={size}
    >
      <div
        ref={refCallback}
        onScroll={handleScroll}
        {...stickyHandlers}
        data-detail-scroll-area={size}
        className={cn(
          "min-w-0 overflow-auto",
          maxHeightClassName,
          scrollClassName,
        )}
      >
        <div
          ref={binding.overflow.topSentinelRef}
          aria-hidden
          className="h-px w-full"
        />
        {children}
        <div
          ref={binding.overflow.bottomSentinelRef}
          aria-hidden
          className="h-px w-full"
        />
      </div>
      {aboveOverflow ? (
        <div
          aria-hidden
          data-detail-scroll-fade="above"
          className="pointer-events-none absolute inset-x-0 top-0 z-10 h-6 bg-gradient-to-b from-background to-transparent"
        />
      ) : null}
      {belowOverflow ? (
        <div
          aria-hidden
          data-detail-scroll-fade="below"
          className="pointer-events-none absolute inset-x-0 bottom-0 z-10 h-6 bg-gradient-to-t from-background to-transparent"
        />
      ) : null}
    </div>
  );
}

export function TimelineDetailScroll(props: TimelineDetailScrollProps) {
  return props.streaming ? (
    <StreamingDetailScroll {...props} />
  ) : (
    <StaticDetailScroll {...props} />
  );
}
