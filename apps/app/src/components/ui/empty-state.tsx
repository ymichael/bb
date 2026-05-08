import type { LucideIcon } from "lucide-react";
import { cn } from "@/lib/utils";

export interface EmptyStateProps {
  message: string;
  icon?: LucideIcon;
  className?: string;
  iconClassName?: string;
  messageClassName?: string;
}

export function EmptyState({
  message,
  icon: Icon,
  className,
  iconClassName,
  messageClassName,
}: EmptyStateProps) {
  return (
    <div className={cn("flex items-center gap-2", className)}>
      {Icon ? (
        <Icon
          aria-hidden="true"
          className={cn(
            "size-4 shrink-0 text-muted-foreground/70",
            iconClassName,
          )}
        />
      ) : null}
      <p
        className={cn(
          "text-xs leading-5 text-muted-foreground",
          messageClassName,
        )}
      >
        {message}
      </p>
    </div>
  );
}
