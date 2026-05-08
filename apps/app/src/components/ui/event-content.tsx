import type { ReactNode } from "react";
import { cn } from "@/lib/utils";

export interface EventCodeBlockProps {
  children: ReactNode;
  className?: string;
  tone?: "default" | "danger";
}

/**
 * Code-styling primitive — renders monospace text with the standard event
 * surface treatment, but does not own scroll behavior. Wrap with
 * `TimelineDetailScroll` (or another scroll container) when the content can
 * exceed its available height; this primitive only controls typography,
 * padding, and tone.
 */
export function EventCodeBlock({
  children,
  className,
  tone = "default",
}: EventCodeBlockProps) {
  return (
    <pre
      className={cn(
        "whitespace-pre-wrap break-words rounded-md px-2 py-1.5 font-mono text-xs leading-tight",
        tone === "danger"
          ? "text-destructive/90"
          : "border border-border/70 bg-background/70 text-muted-foreground",
        className,
      )}
    >
      {children}
    </pre>
  );
}
