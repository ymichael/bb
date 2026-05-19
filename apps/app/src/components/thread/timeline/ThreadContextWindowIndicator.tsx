import { Popover, PopoverContent, PopoverTrigger } from "../../ui/popover.js";
import type { ThreadContextWindowUsage } from "@bb/server-contract";
import { useHoverPopover } from "../../ui/hooks/use-hover-popover.js";
import { cn } from "@/lib/utils";
import {
  calculateContextWindowUsagePercent,
  formatCompactTokenCount,
} from "./thread-context-window-usage.js";

export interface ThreadContextWindowIndicatorProps {
  usage: ThreadContextWindowUsage;
  className?: string;
}

export function ThreadContextWindowIndicator({
  usage,
  className,
}: ThreadContextWindowIndicatorProps) {
  const { open, triggerHoverProps, contentHoverProps, handleOpenChange } =
    useHoverPopover();

  const usedPercent = calculateContextWindowUsagePercent(usage);
  const leftPercent = Math.max(0, 100 - usedPercent);
  const visualPercent = Math.min(Math.max(usedPercent, 0), 100);

  const radius = 6.5;
  const circumference = 2 * Math.PI * radius;
  const dashOffset = circumference * (1 - visualPercent / 100);

  const toneClass =
    usedPercent >= 90
      ? "text-destructive"
      : usedPercent >= 75
        ? "text-warning-text"
        : "text-muted-foreground";

  const usedTokensLabel = formatCompactTokenCount(usage.usedTokens);
  const windowTokensLabel = formatCompactTokenCount(usage.modelContextWindow);
  const title = usage.estimated
    ? "Estimated context window usage"
    : "Context window usage";

  return (
    <Popover open={open} onOpenChange={handleOpenChange}>
      <PopoverTrigger asChild>
        <button
          type="button"
          {...triggerHoverProps}
          className={cn(
            "inline-flex size-6 items-center justify-center rounded-full transition-colors hover:bg-state-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
            className,
          )}
          aria-label={`Context window ${usedPercent}% used`}
          title={title}
        >
          <svg
            viewBox="0 0 16 16"
            className={cn("size-4", toneClass)}
            aria-hidden="true"
          >
            <circle
              cx="8"
              cy="8"
              r={radius}
              fill="none"
              strokeWidth="3"
              className="stroke-border-hairline"
            />
            <circle
              cx="8"
              cy="8"
              r={radius}
              fill="none"
              stroke="currentColor"
              strokeWidth="3"
              strokeLinecap="round"
              strokeDasharray={circumference}
              strokeDashoffset={dashOffset}
              transform="rotate(-90 8 8)"
            />
          </svg>
        </button>
      </PopoverTrigger>
      <PopoverContent
        side="top"
        align="end"
        sideOffset={8}
        {...contentHoverProps}
        className="w-auto max-w-[240px] border-border bg-surface-scrim px-3 py-2 text-sm shadow-lg backdrop-blur-sm"
      >
        <div className="space-y-1.5">
          <p className="text-muted-foreground">
            {usage.estimated ? "Estimated context window:" : "Context window:"}
          </p>
          <p className="font-medium">
            {usedPercent}% used ({leftPercent}% left)
          </p>
          <p className="font-medium">
            {usedTokensLabel} / {windowTokensLabel} tokens used
          </p>
        </div>
      </PopoverContent>
    </Popover>
  );
}
