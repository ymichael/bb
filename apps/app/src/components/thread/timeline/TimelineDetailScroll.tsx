import { useCallback, type ReactNode, type UIEvent } from "react";
import { useComposedRefs } from "@radix-ui/react-compose-refs";
import { cn } from "../../ui/cn.js";
import {
  getDetailScrollMaxHeightClass,
  type DetailScrollSize,
} from "../../ui/detail-scroll-size.js";
import { useStickyBottomScroll } from "./useStickyBottomScroll.js";
import { useScrollOverflowState } from "./useScrollOverflowState.js";

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

// Single component for both streaming and static modes. The previous design
// rendered separate `<StreamingDetailScroll>` / `<StaticDetailScroll>`
// subtrees, but flipping `streaming` on completion swapped one for the other,
// remounting a fresh scroll container with `scrollTop: 0` and snapping the
// view back to the top. `useStickyBottomScroll` is already dormant when
// `streaming === false` (see its `if (!streaming) return;` guards), so the
// hook can stay wired through the lifecycle while the auto-scroll effect
// flips off without remounting.
export function TimelineDetailScroll({
  size,
  streaming = false,
  contentKey,
  className,
  scrollClassName,
  children,
}: TimelineDetailScrollProps) {
  const sticky = useStickyBottomScroll<HTMLDivElement>({
    contentKey,
    streaming,
  });
  const overflow = useScrollOverflowState<HTMLDivElement>();
  const maxHeightClassName = getDetailScrollMaxHeightClass(size);
  const { aboveOverflow, belowOverflow } = overflow;

  const handleScroll = useCallback(
    (event: UIEvent<HTMLDivElement>) => {
      sticky.onScroll(event);
    },
    [sticky],
  );

  const refCallback = useComposedRefs<HTMLDivElement>(
    sticky.ref,
    overflow.scrollRef,
  );

  return (
    <div
      className={cn("relative isolate min-w-0", className)}
      data-detail-scroll={size}
    >
      <div
        ref={refCallback}
        onScroll={handleScroll}
        onPointerDown={sticky.onPointerDown}
        onTouchMove={sticky.onTouchMove}
        onTouchStart={sticky.onTouchStart}
        onWheel={sticky.onWheel}
        data-detail-scroll-area={size}
        className={cn(
          "min-w-0 overflow-auto",
          maxHeightClassName,
          scrollClassName,
        )}
      >
        <div
          ref={overflow.topSentinelRef}
          aria-hidden
          className="h-px w-full"
        />
        {children}
        <div
          ref={overflow.bottomSentinelRef}
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
