import type { ReactNode } from "react";
import { cx } from "./utils.js";

export type StatusPillVariant =
  | "default"
  | "secondary"
  | "destructive"
  | "outline"
  | "emphasis";

const STATUS_PILL_VARIANT_CLASS: Record<StatusPillVariant, string> = {
  default: "border-transparent bg-primary text-primary-foreground",
  secondary: "border-transparent bg-secondary text-secondary-foreground",
  destructive: "border-transparent bg-destructive text-white",
  outline: "border-border bg-background text-foreground",
  emphasis: "border-transparent bg-foreground text-background",
};

export interface StatusPillProps {
  variant: StatusPillVariant;
  className?: string;
  children: ReactNode;
}

export function StatusPill({ variant, className, children }: StatusPillProps) {
  return (
    <span
      className={cx(
        "inline-flex items-center rounded-sm border px-1.5 py-0 ui-text-xs leading-none",
        STATUS_PILL_VARIANT_CLASS[variant],
        className,
      )}
    >
      {children}
    </span>
  );
}
