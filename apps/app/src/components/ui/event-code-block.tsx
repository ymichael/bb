import type { ReactNode } from "react";
import { cn } from "@bb/shared-ui/lib/utils";

interface EventCodeBlockProps {
  children: ReactNode;
  className?: string;
  tone?: "default" | "danger";
}

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
          ? "text-destructive"
          : "border border-border bg-surface-raised text-muted-foreground",
        className,
      )}
    >
      {children}
    </pre>
  );
}
