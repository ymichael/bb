import type { ReactNode } from "react";
import { ChevronDown, ChevronRight } from "lucide-react";
import { cn } from "@/lib/utils";

export const COLLAPSIBLE_HEADER_COLLAPSED_TONE_CLASS =
  "text-muted-foreground/90 transition-colors group-hover:text-foreground/90 group-focus-within:text-foreground/90";
export const COLLAPSIBLE_HEADER_EXPANDED_TONE_CLASS = "text-foreground/90";
export const COLLAPSIBLE_HEADER_STATIC_TONE_CLASS = "text-muted-foreground/90";
export const COLLAPSIBLE_HEADER_BUTTON_BASE_CLASS =
  "inline-flex max-w-full items-center gap-1 overflow-hidden py-0.5 text-left text-sm";
export const COLLAPSIBLE_HEADER_TEXT_CLASS = "min-w-0 truncate";
export const COLLAPSIBLE_HEADER_CHEVRON_COLLAPSED_CLASS =
  "size-4 shrink-0 opacity-0 transition-opacity group-hover:opacity-100";

export function getCollapsibleHeaderToneClass(isExpanded: boolean): string {
  return isExpanded
    ? COLLAPSIBLE_HEADER_EXPANDED_TONE_CLASS
    : COLLAPSIBLE_HEADER_COLLAPSED_TONE_CLASS;
}

export function CollapsibleHeader({
  summaryContent,
  toneClassName,
  summaryClassName,
  className,
  isExpanded = false,
  onToggle,
}: {
  summaryContent: ReactNode;
  toneClassName: string;
  summaryClassName?: string;
  className?: string;
  isExpanded?: boolean;
  onToggle?: () => void;
}) {
  const rootClassName = cn(
    COLLAPSIBLE_HEADER_BUTTON_BASE_CLASS,
    toneClassName,
    className,
  );
  const summaryClass = summaryClassName ?? COLLAPSIBLE_HEADER_TEXT_CLASS;

  if (!onToggle) {
    return (
      <div className={rootClassName}>
        <span className={summaryClass}>{summaryContent}</span>
      </div>
    );
  }

  return (
    <button
      type="button"
      onClick={onToggle}
      className={rootClassName}
    >
      <span className={summaryClass}>{summaryContent}</span>
      {isExpanded ? (
        <ChevronDown className="size-4 shrink-0" />
      ) : (
        <ChevronRight className={COLLAPSIBLE_HEADER_CHEVRON_COLLAPSED_CLASS} />
      )}
    </button>
  );
}
