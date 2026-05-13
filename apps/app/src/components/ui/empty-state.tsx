import { cn } from "@/lib/utils";
import { Icon, type IconName } from "./icon";

export interface EmptyStateProps {
  message: string;
  icon?: IconName;
  className?: string;
  iconClassName?: string;
  messageClassName?: string;
}

export function EmptyState({
  message,
  icon,
  className,
  iconClassName,
  messageClassName,
}: EmptyStateProps) {
  return (
    <div className={cn("flex items-center gap-2", className)}>
      {icon ? (
        <Icon
          name={icon}
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
