import { cn } from "@bb/shared-ui/lib/utils";
import type { MiniMapSlot } from "./paneContentSplitIndicator";

const GLYPH_SIZE = 14;
const GLYPH_PADDING = 1;
const INNER = GLYPH_SIZE - 2 * GLYPH_PADDING;
const OUTLINE_WIDTH = 1;

interface SplitPaneMiniMapProps {
  slots: MiniMapSlot[];
  label: string;
  isWorking?: boolean;
}

function offset(value: number): number {
  return GLYPH_PADDING + value * INNER;
}

function extent(value: number): number {
  return value * INNER;
}

function outlineInset(isFilled: boolean): number {
  return isFilled ? 0 : OUTLINE_WIDTH / 2;
}

export function SplitPaneMiniMap({
  slots,
  label,
  isWorking = false,
}: SplitPaneMiniMapProps) {
  const representsFocusedPane = slots.some(
    (slot) => slot.isMe && slot.isFocused,
  );

  return (
    <svg
      width={GLYPH_SIZE}
      height={GLYPH_SIZE}
      viewBox={`0 0 ${GLYPH_SIZE} ${GLYPH_SIZE}`}
      className={cn(
        "pointer-events-none !size-3.5 shrink-0",
        !representsFocusedPane && "opacity-60",
        isWorking && "animate-shine-icon",
      )}
      shapeRendering="crispEdges"
      role="img"
      aria-label={label}
    >
      {slots.map((slot) => {
        const inset = outlineInset(slot.isMe);
        return (
          <rect
            key={slot.paneId}
            x={offset(slot.rect.x) + inset}
            y={offset(slot.rect.y) + inset}
            width={Math.max(extent(slot.rect.w) - 2 * inset, 0)}
            height={Math.max(extent(slot.rect.h) - 2 * inset, 0)}
            strokeWidth={slot.isMe ? 0 : OUTLINE_WIDTH}
            className={cn(
              slot.isMe
                ? slot.isFocused
                  ? "fill-primary/70 stroke-none"
                  : "fill-muted-foreground/45 stroke-none"
                : "fill-none stroke-muted-foreground/30",
            )}
          />
        );
      })}
    </svg>
  );
}
