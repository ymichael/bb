import type { ReactNode } from "react";
import { cx } from "./utils.js";

const DETAIL_ROW_GRID_CLASS =
  "grid grid-cols-[92px_minmax(0,1fr)] gap-2 text-sm sm:grid-cols-[124px_minmax(0,1fr)]";

export interface DetailCardProps {
  children: ReactNode;
  className?: string;
}

export function DetailCard({ children, className }: DetailCardProps) {
  return (
    <dl className={cx("rounded-md border border-border/80 bg-background/40 px-2 py-1", className)}>
      {children}
    </dl>
  );
}

export interface DetailRowProps {
  label: ReactNode;
  children: ReactNode;
  className?: string;
  labelClassName?: string;
  valueClassName?: string;
  align?: "start" | "center";
}

export function DetailRow({
  label,
  children,
  className,
  labelClassName,
  valueClassName,
  align = "center",
}: DetailRowProps) {
  return (
    <div
      className={cx(
        DETAIL_ROW_GRID_CLASS,
        align === "center" ? "items-center py-1" : "py-1",
        className,
      )}
    >
      <dt className={cx("m-0 text-xs text-muted-foreground", labelClassName)}>{label}</dt>
      <dd className={cx("m-0 min-w-0", valueClassName)}>{children}</dd>
    </div>
  );
}

export interface DetailMessageRowProps {
  children: ReactNode;
  className?: string;
  contentClassName?: string;
}

export function DetailMessageRow({
  children,
  className,
  contentClassName,
}: DetailMessageRowProps) {
  return (
    <div className={cx(DETAIL_ROW_GRID_CLASS, "py-0.5", className)}>
      <div aria-hidden="true" />
      <div className={contentClassName}>{children}</div>
    </div>
  );
}
