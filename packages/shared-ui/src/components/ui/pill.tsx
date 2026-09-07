import type { ReactNode } from "react";
import { cn } from "../../lib/utils";

export type PillVariant = "secondary" | "destructive" | "outline" | "emphasis";

export type PillSize = "default" | "sm";

const PILL_VARIANT_CLASS: Record<PillVariant, string> = {
  secondary: "border-transparent bg-secondary text-secondary-foreground",
  destructive: "border-transparent bg-destructive text-destructive-foreground",
  outline: "border-border bg-background text-foreground",
  emphasis: "border-transparent bg-foreground text-background",
};

const PILL_SIZE_CLASS: Record<PillSize, string> = {
  default: "px-2 py-0.5",
  sm: "px-1.5 py-0",
};

export interface PillProps {
  variant: PillVariant;
  size?: PillSize;
  className?: string;
  children: ReactNode;
}

export function Pill({
  variant,
  size = "default",
  className,
  children,
}: PillProps) {
  return (
    <span
      className={cn(
        "inline-flex items-center rounded border text-xs",
        PILL_SIZE_CLASS[size],
        PILL_VARIANT_CLASS[variant],
        className,
      )}
    >
      <span className="min-w-0 truncate">{children}</span>
    </span>
  );
}
