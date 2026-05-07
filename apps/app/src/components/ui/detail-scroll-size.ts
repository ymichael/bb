/**
 * Cap sizes for expandable detail scroll containers in the thread timeline.
 *
 *   summary    — bundle/step summaries whose children are inherently
 *                non-expandable (exploration intents, web research). Sized to
 *                make the cap visibly engage on a typical 10-row listing.
 *   base       — leaf content bodies: command/tool output, file diff,
 *                tool args, system detail, file-change stderr.
 *   delegation — delegation childRows (subagent scope).
 *
 * Bundle/step summaries that contain expandable children leave the cap off
 * entirely so a child's own scroll body never lives inside a parent scroll.
 * The turn-summary expanded body is also intentionally uncapped — turns are
 * read linearly.
 *
 * Tailwind's JIT scans source for literal class names, so the table below has
 * to spell `max-h-[…px]` out explicitly. The numeric pixel values stay
 * adjacent so a future tier change touches one block.
 */
export const detailScrollSizeValues = [
  "summary",
  "base",
  "delegation",
] as const;
export type DetailScrollSize = (typeof detailScrollSizeValues)[number];

const DETAIL_SCROLL_MAX_HEIGHT_CLASS_BY_SIZE: Record<DetailScrollSize, string> =
  {
    summary: "max-h-[240px]",
    base: "max-h-[384px]",
    delegation: "max-h-[768px]",
  };

export function getDetailScrollMaxHeightClass(size: DetailScrollSize): string {
  return DETAIL_SCROLL_MAX_HEIGHT_CLASS_BY_SIZE[size];
}
