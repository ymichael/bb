import type { HTMLAttributes } from "react";
import { cn } from "../../lib/utils";
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
            "size-4 shrink-0 text-subtle-foreground",
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

type EmptyStatePanelProps = HTMLAttributes<HTMLDivElement>;

export function EmptyStatePanel({
  className,
  children,
  ...props
}: EmptyStatePanelProps) {
  return (
    <div
      className={cn(
        "rounded-md border border-dashed border-border px-3 py-6 text-center text-sm text-muted-foreground",
        className,
      )}
      {...props}
    >
      {children}
    </div>
  );
}
