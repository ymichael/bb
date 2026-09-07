import type { ComponentType, ReactNode } from "react";
import { cn } from "../../lib/utils";
import { Tooltip, TooltipContent, TooltipTrigger } from "./tooltip";

export const OPTION_BASE_CLASS_NAME =
  "h-8 w-fit max-w-full min-w-0 items-center justify-start gap-1 px-1 text-xs leading-tight";
export const OPTION_INTERACTIVE_CLASS_NAME =
  "border-none bg-transparent shadow-none";
export const OPTION_CONTENT_CLASS_NAME = "flex min-w-0 items-center gap-1.5";
export const OPTION_TRIGGER_CONTENT_CLASS_NAME = "contents";
export const OPTION_MENU_CONTENT_CLASS_NAME =
  "max-h-[min(var(--radix-dropdown-menu-content-available-height),calc(100dvh-0.5rem))] w-max min-w-0 max-w-96 overflow-y-auto overscroll-contain";
export const OPTION_MUTED_CLASS_NAME =
  "text-muted-foreground hover:text-muted-foreground";

export interface OptionDisplayProps {
  label: string;
  value: ReactNode;
  tone?: "default" | "warning";
  icon?: ComponentType<{ className?: string }>;
  leading?: ReactNode;
  compactValue?: ReactNode;
  compactValueHiddenWhenTiny?: boolean;
  className?: string;
  title?: string;
  tooltip?: ReactNode;
  muted?: boolean;
}

export function OptionDisplay({
  label,
  value,
  tone = "default",
  icon: BrandIcon,
  leading,
  compactValue,
  compactValueHiddenWhenTiny,
  className,
  title,
  tooltip,
  muted,
}: OptionDisplayProps) {
  const defaultTitle =
    typeof value === "string" ? `${label}: ${value}` : undefined;

  const display = (
    <div
      data-option-display=""
      title={tooltip ? undefined : (title ?? defaultTitle)}
      tabIndex={tooltip ? 0 : undefined}
      className={cn(
        "inline-flex",
        OPTION_BASE_CLASS_NAME,
        tooltip &&
          "rounded-md outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background",
        muted && OPTION_MUTED_CLASS_NAME,
        tone === "warning" && "text-warning-text",
        className,
      )}
    >
      <span className={OPTION_CONTENT_CLASS_NAME}>
        {leading ??
          (BrandIcon ? <BrandIcon className="size-4 shrink-0" /> : null)}
        <span className="sr-only">{label}: </span>
        <span className="min-w-0 truncate" data-promptbox-full-label="">
          {value}
        </span>
        {compactValue ? (
          <span
            className="min-w-0 truncate"
            data-promptbox-compact-label=""
            data-promptbox-hide-tiny={
              compactValueHiddenWhenTiny ? "" : undefined
            }
          >
            {compactValue}
          </span>
        ) : null}
      </span>
    </div>
  );

  if (!tooltip) {
    return display;
  }

  return (
    <Tooltip>
      <TooltipTrigger asChild>{display}</TooltipTrigger>
      <TooltipContent>{tooltip}</TooltipContent>
    </Tooltip>
  );
}
