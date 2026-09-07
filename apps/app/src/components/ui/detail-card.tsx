import { type CSSProperties, type ReactNode, type UIEventHandler } from "react";
import { Icon, type IconName } from "@bb/shared-ui/icon";
import { cn } from "@bb/shared-ui/lib/utils";

export function DetailRowIconLabel({
  icon,
  children,
}: {
  icon: IconName;
  children: ReactNode;
}) {
  return (
    <span className="flex items-center gap-1.5">
      <Icon name={icon} className="size-3.5 shrink-0 text-muted-foreground" />
      <span className="min-w-0 truncate">{children}</span>
    </span>
  );
}

export const DETAIL_GRID_CLASS =
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

type DetailCardAppearance = "card" | "flat";

interface DetailCardProps {
  children: ReactNode;
  className?: string;
  onScroll?: UIEventHandler<HTMLDListElement>;
  labelWidth?: string;
  appearance?: DetailCardAppearance;
}

const DETAIL_CARD_BASE_CLASS = "flex flex-col gap-1";
const DETAIL_CARD_CARD_CLASS =
  "rounded-md border border-border bg-surface-raised px-2 py-1";

export function DetailCard({
  children,
  className,
  onScroll,
  labelWidth,
  appearance = "card",
}: DetailCardProps) {
  return (
    <dl
      onScroll={onScroll}
      className={cn(
        DETAIL_CARD_BASE_CLASS,
        appearance === "card" && DETAIL_CARD_CARD_CLASS,
        className,
      )}
      style={labelWidthStyle(labelWidth)}
    >
      {children}
    </dl>
  );
}

interface DetailRowProps {
  label: ReactNode;
  children: ReactNode;
  className?: string;
  labelClassName?: string;
  valueClassName?: string;
  align?: "start" | "center";
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
      <div className={cn("flex flex-col gap-1 py-0.5", className)}>
        <dt className={cn(DETAIL_LABEL_CLASS, labelClassName)}>{label}</dt>
        <dd className={cn(DETAIL_VALUE_CLASS, valueClassName)}>{children}</dd>
      </div>
    );
  }

  return (
    <div
      className={cn(
        DETAIL_GRID_CLASS,
        align === "center" ? "items-center py-0.5" : "py-0.5",
        className,
      )}
    >
      <dt className={cn(DETAIL_LABEL_CLASS, labelClassName)}>{label}</dt>
      <dd className={cn(DETAIL_VALUE_CLASS, valueClassName)}>{children}</dd>
    </div>
  );
}
