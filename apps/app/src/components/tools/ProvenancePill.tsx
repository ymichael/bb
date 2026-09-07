import type { ReactNode } from "react";
import { Pill } from "@bb/shared-ui/pill";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@bb/shared-ui/tooltip";

export function ProvenancePill({
  label,
  tooltip,
  accessibleLabel,
}: {
  label: string;
  tooltip?: ReactNode;
  accessibleLabel?: string;
}) {
  const badge = (
    <span
      aria-label={accessibleLabel}
      tabIndex={tooltip === undefined ? undefined : 0}
      className="inline-flex"
    >
      <Pill
        variant="outline"
        size="sm"
        className="rounded-md border-border/40 bg-surface-recessed/45 px-2 py-1 text-2xs font-medium leading-none text-subtle-foreground shadow-none"
      >
        {label}
      </Pill>
    </span>
  );
  if (tooltip === undefined) return badge;
  return (
    <TooltipProvider delayDuration={250}>
      <Tooltip>
        <TooltipTrigger asChild>{badge}</TooltipTrigger>
        <TooltipContent>{tooltip}</TooltipContent>
      </Tooltip>
    </TooltipProvider>
  );
}
