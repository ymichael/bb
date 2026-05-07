import { type CSSProperties, type ReactNode } from "react";
import { cx } from "./utils.js";

const DETAIL_GRID_CLASS =
  "grid grid-cols-[var(--detail-label-width,96px)_minmax(0,1fr)] gap-x-3";
const DETAIL_LABEL_CLASS = "m-0 text-xs leading-5 text-muted-foreground";
const DETAIL_VALUE_CLASS = "m-0 min-w-0 text-xs leading-5 text-foreground";

type DetailRowOrientation = "horizontal" | "vertical";

function labelWidthStyle(
  labelWidth: string | undefined,
): CSSProperties | undefined {
  if (!labelWidth) {
    return undefined;
  }
  return { "--detail-label-width": labelWidth } as CSSProperties;
}

export interface DetailCardProps {
  children: ReactNode;
  className?: string;
  /**
   * Width of the label column. Applied as a CSS custom property so descendant
   * rows inherit it without prop drilling. Defaults to 96px.
   */
  labelWidth?: string;
}

export function DetailCard({
  children,
  className,
  labelWidth,
}: DetailCardProps) {
  return (
    <dl
      className={cx(
        "flex flex-col gap-1 rounded-md border border-border/80 bg-background/40 px-2 py-1",
        className,
      )}
      style={labelWidthStyle(labelWidth)}
    >
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
  /**
   * `horizontal` (default): label sits left of the value in the shared label column.
   * `vertical`: label sits above the value. Use for wide/tall content like lists.
   */
  orientation?: DetailRowOrientation;
}

export function DetailRow({
  label,
  children,
  className,
  labelClassName,
  valueClassName,
  align = "center",
  orientation = "horizontal",
}: DetailRowProps) {
  if (orientation === "vertical") {
    return (
      <div className={cx("flex flex-col gap-1 py-0.5", className)}>
        <dt className={cx(DETAIL_LABEL_CLASS, labelClassName)}>{label}</dt>
        <dd className={cx(DETAIL_VALUE_CLASS, valueClassName)}>{children}</dd>
      </div>
    );
  }

  return (
    <div
      className={cx(
        DETAIL_GRID_CLASS,
        align === "center" ? "items-center py-0.5" : "py-0.5",
        className,
      )}
    >
      <dt className={cx(DETAIL_LABEL_CLASS, labelClassName)}>{label}</dt>
      <dd className={cx(DETAIL_VALUE_CLASS, valueClassName)}>{children}</dd>
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
    <div className={cx(DETAIL_GRID_CLASS, "py-0.5", className)}>
      <div aria-hidden="true" />
      <div className={contentClassName}>{children}</div>
    </div>
  );
}
