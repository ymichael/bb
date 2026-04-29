import type { ReactNode } from "react";
import { cn } from "@/lib/utils";

interface ConversationStatusIndicatorProps {
  label: ReactNode;
  className?: string;
}

export function ConversationStatusIndicator({
  label,
  className,
}: ConversationStatusIndicatorProps) {
  return (
    <div className={cn("px-2 text-sm text-muted-foreground", className)}>
      {label}
    </div>
  );
}
