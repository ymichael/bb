import { type ThreadWorkStatus } from "@bb/core";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import { useHoverPopover } from "@/hooks/useHoverPopover";
import {
  threadWorkStatusDescription,
} from "@/lib/thread-work-status";
import { cn } from "@/lib/utils";
import { StatusPill, type StatusPillVariant } from "@bb/ui-core";

interface WorkspaceStatusIndicatorProps {
  status: ThreadWorkStatus | undefined;
  label: string;
  variant: StatusPillVariant;
  className?: string;
}

export function WorkspaceStatusIndicator({
  status,
  label,
  variant,
  className,
}: WorkspaceStatusIndicatorProps) {
  const { open, triggerHoverProps, contentHoverProps, handleOpenChange } =
    useHoverPopover();

  const description = threadWorkStatusDescription(status);

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
            "flex w-fit items-center rounded-sm p-0 leading-none text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
            className,
          )}
          aria-label={`${label}: ${description}`}
        >
          <StatusPill variant={variant}>{label}</StatusPill>
        </button>
      </PopoverTrigger>
      <PopoverContent
        side="top"
        align="start"
        sideOffset={8}
        {...contentHoverProps}
        className="w-auto max-w-[240px] border-border/80 bg-popover/95 px-3 py-2 text-sm shadow-lg backdrop-blur-sm"
      >
        <p className="text-muted-foreground">{description}</p>
      </PopoverContent>
    </Popover>
  );
}
