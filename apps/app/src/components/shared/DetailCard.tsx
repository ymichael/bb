import type { ReactNode } from "react";
import { cn } from "@/lib/utils";

const DETAIL_ROW_GRID_CLASS =
  "grid grid-cols-[92px_minmax(0,1fr)] gap-2 text-sm sm:grid-cols-[124px_minmax(0,1fr)]";

export function DetailCard({
  children,
  className,
}: {
  children: ReactNode;
  className?: string;
}) {
  return (
    <dl className={cn("rounded-md border border-border/80 bg-background/40 px-2 py-1", className)}>
      {children}
    </dl>
  );
}

export function DetailRow({
  label,
  children,
  className,
  labelClassName,
  valueClassName,
  align = "center",
}: {
  label: ReactNode;
  children: ReactNode;
  className?: string;
  labelClassName?: string;
  valueClassName?: string;
  align?: "start" | "center";
}) {
  return (
    <div
      className={cn(
        DETAIL_ROW_GRID_CLASS,
        align === "center" ? "items-center py-1" : "py-1",
        className,
      )}
    >
      <dt className={cn("text-xs text-muted-foreground", labelClassName)}>{label}</dt>
      <dd className={cn("min-w-0", valueClassName)}>{children}</dd>
    </div>
  );
}

export function DetailMessageRow({
  children,
  className,
  contentClassName,
}: {
  children: ReactNode;
  className?: string;
  contentClassName?: string;
}) {
  return (
    <div className={cn(DETAIL_ROW_GRID_CLASS, "py-0.5", className)}>
      <div aria-hidden="true" />
      <div className={contentClassName}>{children}</div>
    </div>
  );
}
