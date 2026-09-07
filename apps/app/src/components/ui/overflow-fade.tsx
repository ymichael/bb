import { cn } from "@bb/shared-ui/lib/utils";

type OverflowFadePlacement = "above" | "below" | "left" | "right";
export type OverflowFadeTone = "background" | "sidebar" | "surface-raised";
type OverflowFadeSize = "default" | "sm" | "lg";

interface OverflowFadeProps {
  className?: string;
  placement: OverflowFadePlacement;
  tone?: OverflowFadeTone;
  inset?: boolean;
  size?: OverflowFadeSize;
}

interface VerticalSizeClasses {
  height: string;
  aboveOffset: string;
  belowOffset: string;
}

const OVERFLOW_FADE_VERTICAL_SIZE_CLASSES: Record<
  OverflowFadeSize,
  VerticalSizeClasses
> = {
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
  lg: {
    height: "h-24",
    aboveOffset: "-top-24",
    belowOffset: "-bottom-24",
  },
};

const OVERFLOW_FADE_HORIZONTAL_WIDTH_CLASS: Record<OverflowFadeSize, string> = {
  default: "w-6",
  sm: "w-2",
  lg: "w-24",
};

function isHorizontalPlacement(
  placement: OverflowFadePlacement,
): placement is "left" | "right" {
  return placement === "left" || placement === "right";
}

interface OverflowFadeGradientClasses {
  background: string;
  sidebar: string;
  "surface-raised": string;
}

const OVERFLOW_FADE_GRADIENT_CLASSES: Record<
  OverflowFadePlacement,
  OverflowFadeGradientClasses
> = {
  above: {
    background: "bg-gradient-to-b from-transparent to-background",
    sidebar: "bg-gradient-to-b from-transparent to-sidebar",
    "surface-raised":
      "bg-gradient-to-b from-transparent to-surface-raised-solid",
  },
  below: {
    background: "bg-gradient-to-b to-transparent from-background",
    sidebar: "bg-gradient-to-b to-transparent from-sidebar",
    "surface-raised":
      "bg-gradient-to-b to-transparent from-surface-raised-solid",
  },
  left: {
    background: "bg-gradient-to-l from-transparent to-background",
    sidebar: "bg-gradient-to-l from-transparent to-sidebar",
    "surface-raised":
      "bg-gradient-to-l from-transparent to-surface-raised-solid",
  },
  right: {
    background: "bg-gradient-to-r from-transparent to-background",
    sidebar: "bg-gradient-to-r from-transparent to-sidebar",
    "surface-raised":
      "bg-gradient-to-r from-transparent to-surface-raised-solid",
  },
};

const OVERFLOW_FADE_INSET_VERTICAL_GRADIENT_CLASSES: Record<
  "above" | "below",
  OverflowFadeGradientClasses
> = {
  above: {
    background: "bg-gradient-to-b from-background to-transparent",
    sidebar: "bg-gradient-to-b from-sidebar to-transparent",
    "surface-raised":
      "bg-gradient-to-b from-surface-raised-solid to-transparent",
  },
  below: {
    background: "bg-gradient-to-b from-transparent to-background",
    sidebar: "bg-gradient-to-b from-transparent to-sidebar",
    "surface-raised":
      "bg-gradient-to-b from-transparent to-surface-raised-solid",
  },
};

function getOverflowFadeGradientClass(
  placement: OverflowFadePlacement,
  tone: OverflowFadeTone,
  inset: boolean,
): string {
  if (inset && !isHorizontalPlacement(placement)) {
    return OVERFLOW_FADE_INSET_VERTICAL_GRADIENT_CLASSES[placement][tone];
  }
  return OVERFLOW_FADE_GRADIENT_CLASSES[placement][tone];
}

function getOverflowFadeLayoutClasses(
  placement: OverflowFadePlacement,
  size: OverflowFadeSize,
  inset: boolean,
): string {
  if (isHorizontalPlacement(placement)) {
    const widthClass = OVERFLOW_FADE_HORIZONTAL_WIDTH_CLASS[size];
    const sideClass = placement === "left" ? "left-0" : "right-0";
    return cn("inset-y-0", sideClass, widthClass);
  }

  const sizeClasses = OVERFLOW_FADE_VERTICAL_SIZE_CLASSES[size];
  const offsetClass = inset
    ? placement === "above"
      ? "top-0"
      : "bottom-0"
    : placement === "above"
      ? sizeClasses.aboveOffset
      : sizeClasses.belowOffset;
  return cn("inset-x-0", sizeClasses.height, offsetClass);
}

export function OverflowFade({
  className,
  placement,
  tone = "background",
  inset = false,
  size = "default",
}: OverflowFadeProps) {
  return (
    <div
      aria-hidden
      data-overflow-fade={placement}
      data-overflow-fade-tone={tone}
      data-overflow-fade-inset={inset ? "" : undefined}
      className={cn(
        "pointer-events-none absolute",
        getOverflowFadeLayoutClasses(placement, size, inset),
        getOverflowFadeGradientClass(placement, tone, inset),
        className,
      )}
    />
  );
}
