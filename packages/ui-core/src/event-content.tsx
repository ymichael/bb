import type { ReactNode } from "react";
import { cx } from "./utils.js";

export interface EventCodeBlockProps {
  children: ReactNode;
  className?: string;
  maxHeightClassName?: string;
  tone?: "default" | "danger";
}

export function EventCodeBlock({
  children,
  className,
  maxHeightClassName,
  tone = "default",
}: EventCodeBlockProps) {
  return (
    <pre
      className={cx(
        "overflow-auto whitespace-pre-wrap break-words rounded-md px-2 py-1.5 font-mono text-xs leading-tight",
        maxHeightClassName,
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
