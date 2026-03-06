import { Fragment, createContext, useContext, type ReactNode } from "react";
import { cx } from "./utils.js";

const DETAIL_ROW_GRID_CLASS =
  "grid grid-cols-[92px_minmax(0,1fr)] gap-2 text-sm sm:grid-cols-[124px_minmax(0,1fr)]";
const DETAIL_CARD_COLUMNS_CLASS =
  "grid grid-cols-[92px_minmax(0,1fr)] gap-x-2 text-sm sm:grid-cols-[124px_minmax(0,1fr)]";

type DetailCardLayout = "stack" | "columns";

const DetailCardLayoutContext = createContext<DetailCardLayout>("stack");

export interface DetailCardProps {
  children: ReactNode;
  className?: string;
  layout?: DetailCardLayout;
}

export function DetailCard({
  children,
  className,
  layout = "stack",
}: DetailCardProps) {
  return (
    <DetailCardLayoutContext.Provider value={layout}>
      <dl
        className={cx(
          "rounded-md border border-border/80 bg-background/40 px-2 py-1",
          layout === "columns" ? DETAIL_CARD_COLUMNS_CLASS : null,
          className,
        )}
      >
        {children}
      </dl>
    </DetailCardLayoutContext.Provider>
  );
}

export interface DetailRowProps {
  label: ReactNode;
  children: ReactNode;
  className?: string;
  labelClassName?: string;
  valueClassName?: string;
  align?: "start" | "center";
  layout?: "stack" | "contents";
}

export function DetailRow({
  label,
  children,
  className,
  labelClassName,
  valueClassName,
  align = "center",
  layout,
}: DetailRowProps) {
  const inheritedLayout = useContext(DetailCardLayoutContext);
  const resolvedLayout =
    layout === "contents"
      ? "contents"
      : inheritedLayout === "columns"
      ? "contents"
      : "stack";

  if (resolvedLayout === "contents") {
    return (
      <Fragment>
        <dt
          className={cx(
            "m-0 py-1 text-xs text-muted-foreground",
            className,
            align === "center" ? "self-center" : "self-start",
            labelClassName,
          )}
        >
          {label}
        </dt>
        <dd
          className={cx(
            "m-0 min-w-0 py-1",
            className,
            align === "center" ? "self-center" : "self-start",
            valueClassName,
          )}
        >
          {children}
        </dd>
      </Fragment>
    );
  }

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
