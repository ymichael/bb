import { Icon } from "@bb/shared-ui/icon";
import { COARSE_POINTER_TEXT_SM_CLASS } from "@bb/shared-ui/coarse-pointer-sizing";
import { cn } from "@bb/shared-ui/lib/utils";
import { LIST_HOVER_TRANSITION } from "@bb/shared-ui/motion";
import type { ReactNode } from "react";
import { CONTEXT_SELECTION_SURFACE_CLASS } from "./context-selection";

const TAB_PILL_DEFAULT_LABEL_MAX_WIDTH_CLASS = "max-w-[180px]";
const TAB_PILL_AFFORDANCE_BUTTON_BASE_CLASS =
  "inline-flex size-4 shrink-0 items-center justify-center rounded-sm hover:bg-muted-foreground/15 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring disabled:pointer-events-none max-md:pointer-coarse:size-5";
const TAB_PILL_AFFORDANCE_ICON_CLASS = "size-3.5 max-md:pointer-coarse:size-5";
const TAB_PILL_CLOSE_BUTTON_CLASS = `pointer-events-none absolute left-1.5 top-1/2 z-10 -translate-y-1/2 ${TAB_PILL_AFFORDANCE_BUTTON_BASE_CLASS} opacity-0 hover:opacity-100 group-hover/tab-pill:pointer-events-auto group-hover/tab-pill:opacity-100 focus-visible:pointer-events-auto focus-visible:opacity-100 disabled:opacity-30 max-md:pointer-coarse:pointer-events-auto max-md:pointer-coarse:opacity-100`;
const TAB_PILL_LARGE_COARSE_POINTER_CLOSE_BUTTON_CLASS =
  "max-md:pointer-coarse:min-h-9 max-md:pointer-coarse:min-w-9";
const TAB_PILL_LEADING_VISUAL_CLASS =
  "inline-flex size-4 shrink-0 items-center justify-center [&_svg]:size-3.5 max-md:pointer-coarse:size-5 max-md:pointer-coarse:[&_svg]:size-5";

interface TabPillCloseAction {
  onClose: () => void;
  closeLabel: string;
  isClosing?: boolean;
}

interface TabPillProps {
  label: string;
  ariaLabel?: string;
  ariaKeyshortcuts?: string;
  iconOnly?: boolean;
  leadingVisual?: ReactNode;
  secondaryLabel?: string | null;
  labelClassName?: string;
  title: string;
  isActive: boolean;
  onSelect: () => void;
  labelMaxWidthClass?: string;
  closeAction: TabPillCloseAction | null;
  enlargeCloseTargetOnCoarsePointer?: boolean;
}

export function TabPill({
  label,
  ariaLabel,
  ariaKeyshortcuts,
  iconOnly = false,
  leadingVisual,
  secondaryLabel = null,
  labelClassName,
  title,
  isActive,
  onSelect,
  labelMaxWidthClass = TAB_PILL_DEFAULT_LABEL_MAX_WIDTH_CLASS,
  closeAction,
  enlargeCloseTargetOnCoarsePointer = false,
}: TabPillProps) {
  return (
    <div
      onAuxClick={(event) => {
        if (
          event.button !== 1 ||
          closeAction === null ||
          closeAction.isClosing
        ) {
          return;
        }
        event.preventDefault();
        event.stopPropagation();
        closeAction.onClose();
      }}
      className={cn(
        `group/tab-pill relative inline-flex h-7 shrink-0 items-center rounded-md ${LIST_HOVER_TRANSITION} max-md:pointer-coarse:h-9`,
        COARSE_POINTER_TEXT_SM_CLASS,
        isActive
          ? cn(CONTEXT_SELECTION_SURFACE_CLASS, "text-foreground")
          : "text-muted-foreground hover:bg-state-hover",
      )}
    >
      <button
        type="button"
        onClick={onSelect}
        aria-label={ariaLabel}
        aria-keyshortcuts={ariaKeyshortcuts}
        aria-pressed={isActive}
        className={cn(
          "flex h-full min-w-0 items-center rounded-md focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring",
          iconOnly ? "px-1.5" : "pl-1.5 pr-2",
          !iconOnly &&
            closeAction !== null &&
            enlargeCloseTargetOnCoarsePointer
            ? "max-md:pointer-coarse:pl-3.5"
            : null,
        )}
      >
        {leadingVisual ? (
          <span
            className={cn(
              TAB_PILL_LEADING_VISUAL_CLASS,
              !iconOnly && "mr-1.5",
              closeAction
                ? "group-hover/tab-pill:opacity-0 tab-pill-close-focus-visible:opacity-0 max-md:pointer-coarse:opacity-0"
                : null,
            )}
          >
            {leadingVisual}
          </span>
        ) : null}
        <span
          className={cn(
            iconOnly ? "sr-only" : "truncate",
            !iconOnly && labelMaxWidthClass,
            labelClassName,
          )}
          title={iconOnly ? undefined : title}
        >
          {label}
        </span>
        {secondaryLabel ? (
          <span className="ml-1 shrink-0 text-muted-foreground">
            {secondaryLabel}
          </span>
        ) : null}
      </button>
      {closeAction ? (
        <button
          type="button"
          onMouseDown={(event) => event.stopPropagation()}
          onTouchStart={(event) => event.stopPropagation()}
          onClick={closeAction.onClose}
          disabled={closeAction.isClosing}
          aria-label={closeAction.closeLabel}
          data-tab-pill-close
          className={cn(
            TAB_PILL_CLOSE_BUTTON_CLASS,
            enlargeCloseTargetOnCoarsePointer &&
              TAB_PILL_LARGE_COARSE_POINTER_CLOSE_BUTTON_CLASS,
          )}
        >
          {closeAction.isClosing ? (
            <Icon
              name="Spinner"
              className={`${TAB_PILL_AFFORDANCE_ICON_CLASS} animate-spin`}
            />
          ) : (
            <Icon name="X" className={TAB_PILL_AFFORDANCE_ICON_CLASS} />
          )}
        </button>
      ) : null}
    </div>
  );
}
