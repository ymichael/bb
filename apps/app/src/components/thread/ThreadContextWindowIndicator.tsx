import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import { useHoverPopover } from "@/hooks/useHoverPopover";
import type { ThreadContextWindowUsage } from "@bb/server-contract";
import {
  calculateContextWindowUsagePercent,
  formatCompactTokenCount,
} from "@/lib/thread-context-window-usage";
import { cn } from "@/lib/utils";

interface ThreadContextWindowIndicatorProps {
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

  const toneClass = usedPercent >= 90
    ? "text-destructive/75"
    : usedPercent >= 75
      ? "text-amber-500/75"
      : "text-muted-foreground/60";

  const usedTokensLabel = formatCompactTokenCount(usage.usedTokens);
  const windowTokensLabel = formatCompactTokenCount(usage.modelContextWindow);
  const title = usage.estimated ? "Estimated context window usage" : "Context window usage";

  return (
    <Popover
      open={open}
      onOpenChange={handleOpenChange}
    >
      <PopoverTrigger asChild>
        <button
          type="button"
          {...triggerHoverProps}
          className={cn(
            "inline-flex size-6 items-center justify-center rounded-full transition-colors hover:bg-accent/50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
            className,
          )}
          aria-label={`Context window ${usedPercent}% used`}
          title={title}
        >
          <span
            className={cn(
              "relative block size-4 rounded-full border border-border/80",
              toneClass,
            )}
            aria-hidden="true"
          >
            <span
              className="absolute inset-0 rounded-full"
              style={{
                background: `conic-gradient(currentColor ${visualPercent}%, transparent 0%)`,
              }}
            />
            <span className="absolute inset-[3px] rounded-full bg-background" />
          </span>
        </button>
      </PopoverTrigger>
      <PopoverContent
        side="top"
        align="end"
        sideOffset={8}
        {...contentHoverProps}
        className="w-auto max-w-[240px] border-border/80 bg-popover/95 px-3 py-2 text-sm shadow-lg backdrop-blur-sm"
      >
        <div className="space-y-1.5">
          <p className="text-muted-foreground">
            {usage.estimated ? "Estimated context window:" : "Context window:"}
          </p>
          <p className="font-medium">{usedPercent}% used ({leftPercent}% left)</p>
          <p className="font-medium">{usedTokensLabel} / {windowTokensLabel} tokens used</p>
        </div>
      </PopoverContent>
    </Popover>
  );
}
