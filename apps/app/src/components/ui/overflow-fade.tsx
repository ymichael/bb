import { cn } from "@/lib/utils";

export type OverflowFadePlacement = "above" | "below";
export type OverflowFadeTone = "background" | "sidebar";
export type OverflowFadeSize = "default" | "sm";

export interface OverflowFadeProps {
  className?: string;
  placement: OverflowFadePlacement;
  tone?: OverflowFadeTone;
  /**
   * Named height variants so the paired offset can't drift from the height.
   * `default` is 1.5rem (page-level fades over body content); `sm` is 0.5rem
   * (sidebar fades where rows are short and a tall fade would mask whole
   * rows).
   */
  size?: OverflowFadeSize;
}

interface SizeClasses {
  height: string;
  aboveOffset: string;
  belowOffset: string;
}

const OVERFLOW_FADE_SIZE_CLASSES: Record<OverflowFadeSize, SizeClasses> = {
  default: {
    height: "h-6",
    aboveOffset: "-top-6",
    belowOffset: "-bottom-6",
  },
  sm: {
    height: "h-2",
    aboveOffset: "-top-2",
    belowOffset: "-bottom-2",
  },
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
  size = "default",
}: OverflowFadeProps) {
  const sizeClasses = OVERFLOW_FADE_SIZE_CLASSES[size];
  const offsetClass =
    placement === "above" ? sizeClasses.aboveOffset : sizeClasses.belowOffset;
  const gradientClass =
    placement === "above"
      ? "bg-gradient-to-b from-transparent"
      : "bg-gradient-to-b to-transparent";

  return (
    <div
      aria-hidden
      data-overflow-fade={placement}
      data-overflow-fade-tone={tone}
      className={cn(
        "pointer-events-none absolute inset-x-0",
        sizeClasses.height,
        offsetClass,
        gradientClass,
        getOverflowFadeToneClass(placement, tone),
        className,
      )}
    />
  );
}
