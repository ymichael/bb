import { useEffect, type CSSProperties, type RefObject } from "react";
import type { ThreadTimelineViewRow } from "@bb/thread-view";
import { supportsScrollAnchoring } from "@/lib/scroll-anchoring-support";

export const TOP_LEVEL_TIMELINE_ROW_INTRINSIC_SIZE_CLASS_NAME =
  "max-md:[contain-intrinsic-block-size:auto_1.25rem]";
const CONTENT_VISIBILITY_CLASS_NAME = "max-md:[content-visibility:auto]";
export const TOP_LEVEL_TIMELINE_ROW_CLASS_NAME = `${CONTENT_VISIBILITY_CLASS_NAME} ${TOP_LEVEL_TIMELINE_ROW_INTRINSIC_SIZE_CLASS_NAME}`;

export function useArmTopLevelTimelineRowContainment(
  wrapperRef: RefObject<HTMLElement | null>,
  enabled = true,
): void {
  useEffect(() => {
    const wrapper = wrapperRef.current;
    if (!enabled || wrapper === null || !supportsScrollAnchoring()) {
      return;
    }
    let cancelled = false;
    let secondFrame: number | null = null;
    const firstFrame = requestAnimationFrame(() => {
      if (cancelled) {
        return;
      }
      secondFrame = requestAnimationFrame(() => {
        if (!cancelled) {
          wrapper.classList.add(CONTENT_VISIBILITY_CLASS_NAME);
        }
      });
    });
    return () => {
      cancelled = true;
      cancelAnimationFrame(firstFrame);
      if (secondFrame !== null) {
        cancelAnimationFrame(secondFrame);
      }
    };
  }, [enabled, wrapperRef]);
}

const CONVERSATION_ROW_BASE_PX = 48;
const CONVERSATION_ROW_LINE_PX = 23;
const COMPACT_CHARS_PER_LINE = 44;
const CONVERSATION_ROW_BUCKET_PX = 24;
const USER_MESSAGE_MAX_LINES = 15;

export function estimateTimelineRowIntrinsicBlockSizePx(
  row: ThreadTimelineViewRow,
): number | null {
  if (row.kind !== "conversation") {
    return null;
  }
  let lines = Math.max(1, Math.ceil(row.text.length / COMPACT_CHARS_PER_LINE));
  if (row.role === "user") {
    lines = Math.min(lines, USER_MESSAGE_MAX_LINES);
  }
  const estimate = CONVERSATION_ROW_BASE_PX + lines * CONVERSATION_ROW_LINE_PX;
  return (
    Math.ceil(estimate / CONVERSATION_ROW_BUCKET_PX) *
    CONVERSATION_ROW_BUCKET_PX
  );
}

export function timelineRowContainmentStyle(
  row: ThreadTimelineViewRow,
): CSSProperties | undefined {
  const estimate = estimateTimelineRowIntrinsicBlockSizePx(row);
  if (estimate === null) {
    return undefined;
  }
  return { containIntrinsicBlockSize: `auto ${estimate}px` };
}
