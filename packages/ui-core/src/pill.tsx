import type { ReactNode } from "react";
import { cx } from "./utils.js";

export type PillVariant =
  | "default"
  | "secondary"
  | "destructive"
  | "outline"
  | "emphasis";

const PILL_VARIANT_CLASS: Record<PillVariant, string> = {
  default: "border-transparent bg-primary text-primary-foreground",
  secondary: "border-transparent bg-secondary text-secondary-foreground",
  destructive: "border-transparent bg-destructive text-white",
  outline: "border-border bg-background text-foreground",
  emphasis: "border-transparent bg-foreground text-background",
};

export interface PillProps {
  variant: PillVariant;
  className?: string;
  children: ReactNode;
}

export function Pill({ variant, className, children }: PillProps) {
  return (
    <span
      className={cx(
        "inline-flex items-center rounded-sm border px-1.5 py-0 text-xs leading-none",
        PILL_VARIANT_CLASS[variant],
        className,
      )}
    >
      {children}
    </span>
  );
}
