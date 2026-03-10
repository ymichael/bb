import type { CSSProperties, ReactNode } from "react";
import { cx } from "./utils.js";

export const COLLAPSIBLE_HEADER_COLLAPSED_TONE_CLASS =
  "text-muted-foreground/90 transition-colors group-hover:text-foreground/90 group-focus-within:text-foreground/90";
export const COLLAPSIBLE_HEADER_EXPANDED_TONE_CLASS = "text-foreground/90";
export const COLLAPSIBLE_HEADER_STATIC_TONE_CLASS = "text-muted-foreground/90";
export const COLLAPSIBLE_HEADER_BUTTON_BASE_CLASS =
  "inline-flex max-w-full items-center gap-1 overflow-hidden py-0.5 text-left text-sm";
export const COLLAPSIBLE_HEADER_TEXT_CLASS = "min-w-0 truncate";
export const COLLAPSIBLE_HEADER_CHEVRON_COLLAPSED_CLASS =
  "size-4 shrink-0 opacity-0 transition-[opacity,transform] duration-200 group-hover:translate-x-0.5 group-hover:opacity-100";

function Chevron({
  expanded,
  className,
}: {
  expanded: boolean;
  className?: string;
}) {
  const style = expanded
    ? undefined
    : ({ transformBox: "fill-box" } as CSSProperties);

  return (
    <svg
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="round"
      strokeLinejoin="round"
      className={cx(
        expanded ? "lucide lucide-chevron-down" : "lucide lucide-chevron-right",
        className,
      )}
      style={style}
      aria-hidden="true"
    >
      {expanded ? <path d="M4 6l4 4 4-4" /> : <path d="M6 4l4 4-4 4" />}
    </svg>
  );
}

export function getCollapsibleHeaderToneClass(isExpanded: boolean): string {
  return isExpanded
    ? COLLAPSIBLE_HEADER_EXPANDED_TONE_CLASS
    : COLLAPSIBLE_HEADER_COLLAPSED_TONE_CLASS;
}

export interface CollapsibleHeaderProps {
  summaryContent: ReactNode;
  toneClassName: string;
  summaryClassName?: string;
  className?: string;
  isExpanded?: boolean;
  onToggle?: () => void;
}

export function CollapsibleHeader({
  summaryContent,
  toneClassName,
  summaryClassName,
  className,
  isExpanded = false,
  onToggle,
}: CollapsibleHeaderProps) {
  const rootClassName = cx(
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
    <button type="button" onClick={onToggle} className={rootClassName}>
      <span className={summaryClass}>{summaryContent}</span>
      {isExpanded ? (
        <Chevron expanded={true} className="size-4 shrink-0 transition-transform duration-200 ease-out" />
      ) : (
        <Chevron expanded={false} className={COLLAPSIBLE_HEADER_CHEVRON_COLLAPSED_CLASS} />
      )}
    </button>
  );
}

export interface ExpandablePanelProps {
  isExpanded: boolean;
  summaryContent: ReactNode;
  headerToneClass: string;
  onToggle: () => void;
  headerButtonClassName?: string;
  summaryContentClassName?: string;
  children?: ReactNode;
  className?: string;
  headerClassName?: string;
  bodyClassName?: string;
  contentClassName?: string;
}

export function ExpandablePanel({
  isExpanded,
  summaryContent,
  headerToneClass,
  onToggle,
  headerButtonClassName,
  summaryContentClassName,
  children,
  className,
  headerClassName,
  bodyClassName,
  contentClassName,
}: ExpandablePanelProps) {
  return (
    <div className={cx("rounded-md text-muted-foreground", className)}>
      <div className={cx("px-2 py-1", headerClassName)}>
        <CollapsibleHeader
          isExpanded={isExpanded}
          onToggle={onToggle}
          toneClassName={headerToneClass}
          className={headerButtonClassName}
          summaryClassName={summaryContentClassName ?? COLLAPSIBLE_HEADER_TEXT_CLASS}
          summaryContent={summaryContent}
        />
      </div>
      <div
        aria-hidden={!isExpanded}
        className={cx(
          "grid transition-[grid-template-rows,opacity] duration-200 ease-out",
          isExpanded ? "grid-rows-[1fr] opacity-100" : "grid-rows-[0fr] opacity-0",
          bodyClassName,
        )}
      >
        <div className="overflow-hidden">
          <div
            className={cx(
              "px-2 pb-1 pt-0 transition-[transform,opacity] duration-200 ease-out will-change-transform",
              isExpanded ? "translate-y-0 opacity-100" : "-translate-y-1 opacity-0",
              contentClassName,
            )}
          >
            {children}
          </div>
        </div>
      </div>
    </div>
  );
}
