import { useEffect, type CSSProperties, type ReactNode } from "react";
import { Icon, type IconName } from "../icon";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "../tooltip";
import { cn } from "../../../lib/utils";

export type ResourceStatusTone = "success" | "warning" | "error" | "muted";

export const RESOURCE_ROUTE_LABEL_EVENT = "bb:resource-route-label";

export function useResourceRouteLabel(label: string | null | undefined) {
  useEffect(() => {
    if (!label || typeof window === "undefined") return;

    let active = true;
    queueMicrotask(() => {
      if (!active) return;
      window.dispatchEvent(
        new CustomEvent(RESOURCE_ROUTE_LABEL_EVENT, { detail: { label } }),
      );
    });

    return () => {
      active = false;
      window.dispatchEvent(
        new CustomEvent(RESOURCE_ROUTE_LABEL_EVENT, {
          detail: { label: null },
        }),
      );
    };
  }, [label]);
}

export function ResourceState({
  tone,
  showLabel = true,
  showIndicator = true,
  tooltip,
  accessibleLabel,
  children,
}: {
  tone: ResourceStatusTone;
  showLabel?: boolean;
  showIndicator?: boolean;
  tooltip?: ReactNode;
  accessibleLabel?: string;
  children: ReactNode;
}) {
  const status = (
    <span
      aria-label={accessibleLabel}
      className="inline-flex min-w-0 items-center gap-1.5 text-xs text-muted-foreground"
    >
      {showIndicator ? (
        <span
          aria-hidden
          className={cn(
            "size-1.5 shrink-0 rounded-full",
            tone === "success" && "bg-success",
            tone === "warning" && "bg-warning",
            tone === "error" && "bg-destructive",
            tone === "muted" && "bg-muted-foreground/50",
          )}
        />
      ) : null}
      {showLabel ? <span className="truncate">{children}</span> : null}
    </span>
  );
  if (tooltip === undefined || tooltip === null) return status;
  return (
    <TooltipProvider delayDuration={250}>
      <Tooltip>
        <TooltipTrigger asChild>{status}</TooltipTrigger>
        <TooltipContent className="max-w-sm">{tooltip}</TooltipContent>
      </Tooltip>
    </TooltipProvider>
  );
}

export const ResourceStatus = ResourceState;

export const RESOURCE_ICON_FRAME_SIZES = {
  sm: { frame: "size-5", glyph: "size-3" },
  md: { frame: "size-6", glyph: "size-3.5" },
  lg: { frame: "size-8", glyph: "size-[1.125rem]" },
} as const;

export type ResourceIconFrameSize = keyof typeof RESOURCE_ICON_FRAME_SIZES;

export function ResourceIconFrame({
  size = "md",
  className,
  style,
  children,
}: {
  size?: ResourceIconFrameSize;
  className?: string;
  style?: CSSProperties;
  children: (glyphClassName: string) => ReactNode;
}) {
  const { frame, glyph } = RESOURCE_ICON_FRAME_SIZES[size];
  return (
    <span
      className={cn(
        "flex shrink-0 items-center justify-center overflow-hidden",
        frame,
        className,
      )}
      style={style}
    >
      {children(glyph)}
    </span>
  );
}

export function ResourceMeta({
  items,
}: {
  items: readonly (ReactNode | null | undefined | false)[];
}) {
  const visibleItems = items.filter(Boolean);
  return (
    <span className="inline-flex min-w-0 flex-wrap items-center gap-x-1.5 gap-y-0.5">
      {visibleItems.map((item, index) => (
        <span key={index} className="inline-flex min-w-0 items-center gap-1.5">
          {index > 0 ? (
            <span aria-hidden className="text-subtle-foreground">
              ·
            </span>
          ) : null}
          <span className="min-w-0 truncate">{item}</span>
        </span>
      ))}
    </span>
  );
}

export function ResourceLocationMeta({
  label,
  icon = "Folder",
}: {
  label: string;
  icon?: IconName;
}) {
  return (
    <span className="inline-flex min-w-0 items-center gap-1.5" title={label}>
      <Icon name={icon} className="size-3.5 shrink-0" aria-hidden />
      <span className="min-w-0 truncate">{label}</span>
    </span>
  );
}

export function ResourceCardStat({
  icon,
  iconClassName,
  className,
  accessibleLabel,
  children,
}: {
  icon: IconName;
  iconClassName?: string;
  className?: string;
  accessibleLabel?: string;
  children: ReactNode;
}) {
  return (
    <span
      aria-label={accessibleLabel}
      className={cn(
        "inline-flex h-7 shrink-0 items-center gap-1 whitespace-nowrap px-1 text-muted-foreground",
        className,
      )}
    >
      <Icon
        name={icon}
        className={cn("size-3 shrink-0", iconClassName)}
        aria-hidden
      />
      <span>{children}</span>
    </span>
  );
}
