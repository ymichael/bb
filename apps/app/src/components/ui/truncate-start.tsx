import type { HTMLAttributes } from "react";
import { cn } from "./cn.js";

interface TruncateStartProps extends HTMLAttributes<HTMLSpanElement> {
  children: string;
}

/**
 * Truncate LTR text at the start so the end stays visible — e.g. file paths in
 * narrow rows where the basename matters more than the leading directory
 * segments (`…/promptbox/file.tsx` rather than `apps/app/src/components/prom…`).
 *
 * Sizing: the box hugs its content (`width: min-content`) but is capped at the
 * container width (`max-w-full`). When the path fits, the element is exactly
 * its content width — alignment within the parent stays whatever the parent
 * dictates. When it doesn't fit, the box is clamped, content overflows, and
 * `dir="rtl"` puts the CSS ellipsis on the visual left. The leading U+200E
 * (LRM) anchors the contents back to LTR rendering so slashes and other
 * neutral characters keep their natural orientation.
 *
 * Like `truncate`, this requires a flex/grid ancestor that allows the element
 * to shrink (typically `min-w-0` somewhere up the tree).
 */
export function TruncateStart({
  children,
  className,
  ...props
}: TruncateStartProps) {
  return (
    <span
      {...props}
      dir="rtl"
      className={cn("block w-min max-w-full truncate", className)}
    >
      {`‎${children}`}
    </span>
  );
}
