import { Icon } from "@/components/ui/icon.js";
import { cn } from "@/lib/utils";

const TAB_PILL_DEFAULT_LABEL_MAX_WIDTH_CLASS = "max-w-[180px]";

export interface TabPillCloseAction {
  onClose: () => void;
  closeLabel: string;
  closeTooltip: string;
  isClosing?: boolean;
}

export interface TabPillProps {
  label: string;
  secondaryLabel?: string | null;
  title: string;
  isActive: boolean;
  onSelect: () => void;
  labelMaxWidthClass?: string;
  closeAction: TabPillCloseAction | null;
}

export function TabPill({
  label,
  secondaryLabel = null,
  title,
  isActive,
  onSelect,
  labelMaxWidthClass = TAB_PILL_DEFAULT_LABEL_MAX_WIDTH_CLASS,
  closeAction,
}: TabPillProps) {
  const isClosable = closeAction !== null;
  return (
    <div
      className={cn(
        "inline-flex h-7 shrink-0 items-center rounded-md text-xs transition-colors",
        isActive
          ? "bg-muted text-foreground"
          : "text-muted-foreground hover:bg-state-hover",
      )}
    >
      <button
        type="button"
        onClick={onSelect}
        aria-pressed={isActive}
        title={title}
        className={cn(
          "flex h-full min-w-0 items-center rounded-l-md pl-2 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring",
          isClosable ? "pr-1" : "rounded-r-md pr-2",
        )}
      >
        <span className={cn("truncate", labelMaxWidthClass)}>{label}</span>
        {secondaryLabel ? (
          <span className="ml-1 shrink-0 text-muted-foreground">
            {secondaryLabel}
          </span>
        ) : null}
      </button>
      {closeAction ? (
        <button
          type="button"
          onClick={closeAction.onClose}
          disabled={closeAction.isClosing}
          aria-label={closeAction.closeLabel}
          title={closeAction.closeTooltip}
          className="mr-1 ml-0.5 inline-flex size-4 shrink-0 items-center justify-center rounded opacity-70 transition-opacity hover:bg-muted-foreground/15 hover:opacity-100 focus-visible:opacity-100 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring disabled:pointer-events-none disabled:opacity-30"
        >
          {closeAction.isClosing ? (
            <Icon name="Spinner" className="size-3 animate-spin" />
          ) : (
            <Icon name="X" className="size-3" />
          )}
        </button>
      ) : null}
    </div>
  );
}
