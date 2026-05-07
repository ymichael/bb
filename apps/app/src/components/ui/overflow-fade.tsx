import { cn } from "./cn.js";

export type OverflowFadePlacement = "above" | "below";
export type OverflowFadeTone = "background" | "sidebar";

export interface OverflowFadeProps {
  /**
   * OverflowFade is intentionally fixed at 1.5rem. Add a named size prop if a
   * future caller needs another height so the paired offset cannot drift.
   */
  className?: string;
  placement: OverflowFadePlacement;
  tone?: OverflowFadeTone;
}

const OVERFLOW_FADE_PLACEMENT_CLASS_BY_PLACEMENT: Record<
  OverflowFadePlacement,
  string
> = {
  above: "-top-6 bg-gradient-to-b from-transparent",
  below: "-bottom-6 bg-gradient-to-b to-transparent",
};

function getOverflowFadeToneClass(
  placement: OverflowFadePlacement,
  tone: OverflowFadeTone,
): string {
  if (placement === "above") {
    return tone === "background" ? "to-background" : "to-sidebar";
  }

  return tone === "background" ? "from-background" : "from-sidebar";
}

export function OverflowFade({
  className,
  placement,
  tone = "background",
}: OverflowFadeProps) {
  return (
    <div
      aria-hidden
      data-overflow-fade={placement}
      data-overflow-fade-tone={tone}
      className={cn(
        "pointer-events-none absolute inset-x-0 h-6",
        OVERFLOW_FADE_PLACEMENT_CLASS_BY_PLACEMENT[placement],
        getOverflowFadeToneClass(placement, tone),
        className,
      )}
    />
  );
}
