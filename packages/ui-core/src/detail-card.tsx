import { Fragment, createContext, useContext, type ReactNode } from "react";
import { cx } from "./utils.js";

const DETAIL_ROW_GRID_CLASS =
  "grid grid-cols-[80px_minmax(0,1fr)] gap-x-3 gap-y-1 sm:grid-cols-[112px_minmax(0,1fr)]";
const DETAIL_CARD_COLUMNS_CLASS =
  "grid grid-cols-[80px_minmax(0,1fr)] gap-x-3 gap-y-1 sm:grid-cols-[112px_minmax(0,1fr)]";
const DETAIL_LABEL_CLASS = "m-0 text-xs leading-5 text-muted-foreground";
const DETAIL_VALUE_CLASS = "m-0 min-w-0 text-xs leading-5 text-foreground";

type DetailCardLayout = "stack" | "columns";
type DetailRowLayout = "stack" | "contents" | "vertical";

const DetailCardLayoutContext = createContext<DetailCardLayout>("stack");

function assertNever(value: never, message: string): never {
  throw new Error(`${message}: ${String(value)}`);
}

function resolveDetailRowLayout(
  layout: DetailRowLayout | undefined,
  inheritedLayout: DetailCardLayout,
): DetailRowLayout {
  if (layout !== undefined) {
    switch (layout) {
      case "stack":
      case "contents":
      case "vertical":
        return layout;
    }

    return assertNever(layout, "Unhandled detail row layout");
  }

  switch (inheritedLayout) {
    case "stack":
      return "stack";
    case "columns":
      return "contents";
  }

  return assertNever(inheritedLayout, "Unhandled inherited detail row layout");
}

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
          "rounded-md border border-border/80 bg-background/40 px-2.5 py-1.5",
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
  layout?: DetailRowLayout;
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
  const resolvedLayout = resolveDetailRowLayout(layout, inheritedLayout);

  if (resolvedLayout === "contents") {
    return (
      <Fragment>
        <dt
          className={cx(
            DETAIL_LABEL_CLASS,
            "py-1.5",
            className,
            align === "center" ? "self-center" : "self-start",
            labelClassName,
          )}
        >
          {label}
        </dt>
        <dd
          className={cx(
            DETAIL_VALUE_CLASS,
            "py-1.5",
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

  if (resolvedLayout === "vertical") {
    return (
      <div
        className={cx(
          "space-y-1.5 py-1.5",
          inheritedLayout === "columns" ? "col-span-2" : null,
          className,
        )}
      >
        <dt className={cx(DETAIL_LABEL_CLASS, labelClassName)}>{label}</dt>
        <dd className={cx(DETAIL_VALUE_CLASS, valueClassName)}>{children}</dd>
      </div>
    );
  }

  return (
    <div
      className={cx(
        DETAIL_ROW_GRID_CLASS,
        align === "center" ? "items-center py-1.5" : "py-1.5",
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
    <div className={cx(DETAIL_ROW_GRID_CLASS, "py-1.5", className)}>
      <div aria-hidden="true" />
      <div className={contentClassName}>{children}</div>
    </div>
  );
}
