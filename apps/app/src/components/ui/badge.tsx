import type { ReactNode } from "react";
import { cn } from "@/lib/utils";

export type BadgeVariant = "primary" | "muted";

const BADGE_VARIANT_CLASS: Record<BadgeVariant, string> = {
  primary: "bg-primary/10 text-primary",
  muted: "bg-muted text-muted-foreground",
};

export interface BadgeProps {
  variant: BadgeVariant;
  className?: string;
  children: ReactNode;
}

export function Badge({ variant, className, children }: BadgeProps) {
  return (
    <span
      className={cn(
        "inline-flex items-center rounded-full px-1.5 py-px text-xs font-medium leading-none",
        BADGE_VARIANT_CLASS[variant],
        className,
      )}
    >
      <span className="min-w-0 truncate">{children}</span>
    </span>
  );
}
