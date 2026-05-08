import type { ReactNode } from "react";
import { cn } from "@/lib/utils";

export interface TimelineStatusIndicatorProps {
  label: ReactNode;
  className?: string;
}

export function TimelineStatusIndicator({
  label,
  className,
}: TimelineStatusIndicatorProps) {
  return (
    <div className={cn("px-2 text-sm text-muted-foreground", className)}>
      {label}
    </div>
  );
}
