import type { ComponentProps, ReactNode } from "react";
import { Button } from "../button";
import { EmptyStatePanel } from "../empty-state";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "../dropdown-menu";
import { Icon, type IconName } from "../icon";
import { Skeleton } from "../skeleton";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "../tooltip";
import { cn } from "../../../lib/utils";

function targetsResourceAction(target: EventTarget): boolean {
  return (
    target instanceof Element &&
    target.closest("a, button, [data-row-action]") !== null
  );
}

export type ResourceOverflowMenuItem =
  | {
      kind?: "item";
      label: string;
      icon?: IconName;
      tone?: "default" | "destructive";
      disabled?: boolean;
      disabledReason?: string;
      onSelect: () => void;
    }
  | { kind: "separator" };

export function ResourceOverflowMenu({
  label,
  disabled = false,
  items,
}: {
  label: string;
  disabled?: boolean;
  items: readonly ResourceOverflowMenuItem[];
}) {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          type="button"
          variant="ghost"
          size="icon"
          className="size-7 p-0 text-muted-foreground hover:text-foreground"
          aria-label={label}
          disabled={disabled}
        >
          <Icon name="MoreHorizontal" className="size-4" aria-hidden />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent
        align="end"
        className="w-max min-w-32 max-w-72"
        mobileTitle={label}
      >
        {items.map((item, index) => {
          if (item.kind === "separator") {
            return <DropdownMenuSeparator key={`separator-${index}`} />;
          }
          const menuItem = (
            <DropdownMenuItem
              key={item.label}
              variant={item.tone === "destructive" ? "destructive" : "default"}
              disabled={item.disabled && item.disabledReason === undefined}
              aria-disabled={item.disabled || undefined}
              className={cn(
                item.disabled && "text-muted-foreground",
                item.disabledReason !== undefined &&
                  "cursor-not-allowed focus:bg-transparent",
              )}
              onSelect={(event) => {
                if (item.disabled) {
                  event.preventDefault();
                  return;
                }
                item.onSelect();
              }}
            >
              {item.icon ? (
                <Icon
                  name={item.icon}
                  className={cn(
                    "size-4 shrink-0",
                    item.disabled && "opacity-50",
                  )}
                  aria-hidden
                />
              ) : null}
              <span className="min-w-0 truncate">{item.label}</span>
            </DropdownMenuItem>
          );
          if (!item.disabled || item.disabledReason === undefined) {
            return menuItem;
          }
          return (
            <TooltipProvider key={item.label} delayDuration={250}>
              <Tooltip>
                <TooltipTrigger asChild>{menuItem}</TooltipTrigger>
                <TooltipContent side="left">
                  {item.disabledReason}
                </TooltipContent>
              </Tooltip>
            </TooltipProvider>
          );
        })}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

export function ResourceActionButton({
  label,
  tooltipLabel,
  tooltipSide,
  icon,
  tone = "muted",
  loading = false,
  disabled = false,
  disabledReason,
  className,
  onClick,
}: {
  label: string;
  tooltipLabel?: string;
  tooltipSide?: ComponentProps<typeof TooltipContent>["side"];
  icon: IconName;
  tone?: "muted" | "destructive";
  loading?: boolean;
  disabled?: boolean;
  disabledReason?: ReactNode;
  className?: string;
  onClick: () => void;
}) {
  return (
    <TooltipProvider delayDuration={250}>
      <Tooltip>
        <TooltipTrigger asChild>
          <Button
            type="button"
            variant="ghost"
            size="icon"
            className={cn(
              "size-6 p-0 text-muted-foreground hover:text-foreground",
              tone === "destructive" && "hover:text-destructive",
              disabled &&
                disabledReason !== undefined &&
                "cursor-not-allowed opacity-50 hover:bg-transparent hover:text-muted-foreground",
              className,
            )}
            aria-label={label}
            aria-busy={loading}
            aria-disabled={disabled || undefined}
            disabled={disabled && disabledReason === undefined}
            onClick={(event) => {
              if (disabled) {
                event.preventDefault();
                event.stopPropagation();
                return;
              }
              onClick();
            }}
          >
            <Icon
              name={loading ? "Loading" : icon}
              className={cn("size-4", loading && "animate-spin")}
            />
          </Button>
        </TooltipTrigger>
        <TooltipContent side={tooltipSide}>
          {disabled && disabledReason
            ? disabledReason
            : (tooltipLabel ?? label)}
        </TooltipContent>
      </Tooltip>
    </TooltipProvider>
  );
}

export function ResourceRow({
  leading,
  title,
  titleMeta,
  description,
  status,
  state,
  selected = false,
  muted = false,
  persistentActions,
  trailingMeta,
  actions,
  trailingVisual,
  actionsVisibility = "hover",
  className,
  openLabel,
  onOpen,
}: {
  leading?: ReactNode;
  title: ReactNode;
  titleMeta?: ReactNode;
  description?: ReactNode;
  status?: ReactNode;
  state?: ReactNode;
  selected?: boolean;
  muted?: boolean;
  persistentActions?: ReactNode;
  trailingMeta?: ReactNode;
  actions?: ReactNode;
  trailingVisual?: ReactNode;
  actionsVisibility?: "hover" | "always";
  className?: string;
  openLabel?: string;
  onOpen: () => void;
}) {
  const rowState = state ?? status;
  const hasLeading =
    leading !== undefined && leading !== null && leading !== false;
  return (
    <div
      data-resource-row
      className={cn(
        "group grid min-w-0 cursor-pointer items-center gap-3 bg-transparent py-3 text-left focus-visible:outline-none",
        hasLeading
          ? "grid-cols-[1.5rem_minmax(0,1fr)_auto]"
          : "grid-cols-[minmax(0,1fr)_auto]",
        selected && "bg-state-active/50",
        muted && "opacity-60",
        className,
      )}
      onClick={(event) => {
        if (targetsResourceAction(event.target)) return;
        onOpen();
      }}
    >
      {hasLeading ? (
        <span className="flex size-6 shrink-0 items-center justify-center">
          {leading}
        </span>
      ) : null}
      <span className="min-w-0">
        <button
          type="button"
          aria-label={openLabel}
          onClick={onOpen}
          className="block w-full min-w-0 cursor-pointer rounded-sm text-left focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
        >
          <span className="flex min-w-0 items-baseline gap-2">
            <span className="min-w-0 truncate text-sm font-medium text-foreground">
              {title}
            </span>
            {titleMeta ? (
              <span className="min-w-0 truncate text-xs font-normal text-muted-foreground">
                {titleMeta}
              </span>
            ) : null}
            {rowState}
          </span>
        </button>
        {description ? (
          <span className="mt-0.5 block truncate text-xs leading-snug text-muted-foreground">
            {description}
          </span>
        ) : null}
      </span>
      {trailingMeta || persistentActions || actions || trailingVisual ? (
        <span className="flex shrink-0 items-center gap-1">
          {trailingMeta ? (
            <span className="flex shrink-0 items-center">{trailingMeta}</span>
          ) : null}
          {actions ? (
            <span
              data-row-action
              className={cn(
                "flex shrink-0 cursor-default items-center gap-0.5 transition-opacity",
                actionsVisibility === "hover" &&
                  "opacity-0 group-hover:opacity-100 focus-within:opacity-100 [@media(hover:none)]:opacity-100",
              )}
            >
              {actions}
            </span>
          ) : null}
          {persistentActions ? (
            <span
              data-row-action
              className="flex shrink-0 cursor-default items-center gap-0.5"
            >
              {persistentActions}
            </span>
          ) : null}
          {trailingVisual ? (
            <span className="flex size-6 shrink-0 cursor-pointer items-center justify-center rounded-md">
              {trailingVisual}
            </span>
          ) : null}
        </span>
      ) : null}
    </div>
  );
}

export function ResourceRowDetailChevron() {
  return (
    <Icon
      name="ChevronRight"
      className="size-3.5 text-subtle-foreground opacity-0 transition-opacity group-hover:opacity-100 group-focus-within:opacity-100"
      aria-hidden
    />
  );
}

export function ResourceListPanel({
  children,
  maxHeightClassName,
  className,
}: {
  children: ReactNode;
  maxHeightClassName?: string;
  className?: string;
}) {
  return (
    <div
      data-resource-list-panel
      className={cn(
        "overflow-hidden rounded-lg border border-border bg-card px-4 py-1",
        className,
      )}
    >
      <div
        className={cn(
          maxHeightClassName && "overflow-y-auto",
          maxHeightClassName,
        )}
      >
        <div className="cursor-default divide-y divide-border">{children}</div>
      </div>
    </div>
  );
}

export function ResourceListState({
  state,
  message,
  onRetry,
  loadingRows = 4,
  layout = "list",
  maxWidthClassName = "max-w-3xl",
}: {
  state: "loading" | "empty" | "error";
  message: string;
  onRetry?: () => void;
  loadingRows?: number;
  layout?: "list" | "detail";
  maxWidthClassName?: string;
}) {
  const frame = (children: ReactNode) =>
    layout === "detail" ? (
      <div
        data-resource-detail-state
        className={cn("mx-auto w-full", maxWidthClassName)}
      >
        {children}
      </div>
    ) : (
      children
    );

  if (state === "loading") {
    return frame(
      <ResourceListPanel>
        <span role="status" className="sr-only">
          {message}
        </span>
        <div aria-hidden="true">
          {Array.from({ length: loadingRows }, (_, index) => (
            <div
              key={index}
              className="grid grid-cols-[1.5rem_minmax(0,1fr)] items-center gap-3 py-3"
            >
              <Skeleton className="size-6 rounded-sm" />
              <div className="space-y-1.5">
                <Skeleton className="h-3.5 w-36" />
                <Skeleton className="h-3 w-56 max-w-full" />
              </div>
            </div>
          ))}
        </div>
      </ResourceListPanel>,
    );
  }

  return frame(
    <EmptyStatePanel
      role={state === "error" ? "alert" : "status"}
      className="py-6"
    >
      <div className="flex flex-col items-center gap-2">
        <span>{message}</span>
        {state === "error" && onRetry ? (
          <Button variant="outline" size="sm" onClick={onRetry}>
            Retry
          </Button>
        ) : null}
      </div>
    </EmptyStatePanel>,
  );
}
