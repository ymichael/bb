import { useEffect, useState, type ReactNode } from "react";
import { cx } from "./utils.js";

const EXPANDABLE_PANEL_TRANSITION_MS = 200;

export const COLLAPSIBLE_HEADER_COLLAPSED_TONE_CLASS =
  "text-muted-foreground/90 transition-colors group-hover:text-foreground/90 group-focus-within:text-foreground/90";
export const COLLAPSIBLE_HEADER_EXPANDED_TONE_CLASS = "text-foreground/90";
export const COLLAPSIBLE_HEADER_STATIC_TONE_CLASS = "text-muted-foreground/90";
export const COLLAPSIBLE_HEADER_BUTTON_BASE_CLASS =
  "inline-flex max-w-full items-center gap-1 overflow-hidden py-0.5 text-left text-sm";
export const COLLAPSIBLE_HEADER_TEXT_CLASS = "min-w-0 truncate";

function Chevron({ className }: { className?: string }) {
  return (
    <svg
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="round"
      strokeLinejoin="round"
      className={cx("lucide lucide-chevron-right", className)}
      aria-hidden="true"
    >
      <path d="M6 4l4 4-4 4" />
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
      <Chevron
        className={cx(
          "size-4 shrink-0 origin-center transition-[opacity,rotate] duration-200 ease-out",
          isExpanded
            ? "rotate-90"
            : "opacity-0 group-hover:opacity-100 max-md:pointer-coarse:opacity-100",
        )}
      />
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
  // Mount children strictly while expanded; keep them mounted through the
  // close animation so grid-template-rows can transition from 1fr → 0fr with
  // real content, then unmount once the animation settles. Collapsed panels
  // pay zero DOM/layout cost for their body.
  const [shouldRenderChildren, setShouldRenderChildren] = useState(isExpanded);
  const [prevIsExpanded, setPrevIsExpanded] = useState(isExpanded);
  if (prevIsExpanded !== isExpanded) {
    // Sync mount with the isExpanded flip so grid-template-rows can
    // transition 0fr → 1fr with actual content already in the DOM.
    setPrevIsExpanded(isExpanded);
    if (isExpanded) {
      setShouldRenderChildren(true);
    }
  }
  useEffect(() => {
    if (isExpanded || !shouldRenderChildren) {
      return;
    }
    const timeout = setTimeout(
      () => setShouldRenderChildren(false),
      EXPANDABLE_PANEL_TRANSITION_MS,
    );
    return () => clearTimeout(timeout);
  }, [isExpanded, shouldRenderChildren]);

  return (
    <div className={cx("rounded-md text-muted-foreground", className)}>
      <div className={cx("px-2 py-1", headerClassName)}>
        <CollapsibleHeader
          isExpanded={isExpanded}
          onToggle={onToggle}
          toneClassName={headerToneClass}
          className={headerButtonClassName}
          summaryClassName={
            summaryContentClassName ?? COLLAPSIBLE_HEADER_TEXT_CLASS
          }
          summaryContent={summaryContent}
        />
      </div>
      <div
        aria-hidden={!isExpanded}
        className={cx(
          "grid transition-[grid-template-rows,opacity] duration-200 ease-out",
          isExpanded
            ? "grid-rows-[1fr] opacity-100"
            : "grid-rows-[0fr] opacity-0",
          bodyClassName,
        )}
      >
        <div className="overflow-hidden">
          <div
            className={cx(
              "px-2 pb-1 pt-0 transition-[transform,opacity] duration-200 ease-out will-change-transform",
              isExpanded
                ? "translate-y-0 opacity-100"
                : "-translate-y-1 opacity-0",
              contentClassName,
            )}
          >
            {shouldRenderChildren ? children : null}
          </div>
        </div>
      </div>
    </div>
  );
}
