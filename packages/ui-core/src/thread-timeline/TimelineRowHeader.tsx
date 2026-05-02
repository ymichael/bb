import type { ReactNode } from "react";
import {
  COLLAPSIBLE_HEADER_STATIC_TONE_CLASS,
  CollapsibleHeader,
} from "../primitives/disclosure.js";
import { cn } from "../primitives/cn.js";

export type TimelineRowHorizontalPadding = "default" | "flush";

export const TIMELINE_ROW_HEADER_CONTENT_CLASS_NAME = "min-w-0 max-w-full";
const TIMELINE_ROW_HEADER_CONTROL_CLASS_NAME =
  "timeline-row-header flex w-full max-w-full justify-start py-0 leading-5";

export interface TimelineStaticRowHeaderProps {
  children: ReactNode;
  className?: string;
  horizontalPadding?: TimelineRowHorizontalPadding;
}

export function timelineRowHorizontalPaddingClassName(
  horizontalPadding: TimelineRowHorizontalPadding,
): string {
  switch (horizontalPadding) {
    case "default":
      return "px-2";
    case "flush":
      return "px-0";
  }
}

export function timelineRowHeaderClassName(
  horizontalPadding: TimelineRowHorizontalPadding,
): string {
  return cn(
    timelineRowHorizontalPaddingClassName(horizontalPadding),
    TIMELINE_ROW_HEADER_CONTROL_CLASS_NAME,
  );
}

export function TimelineStaticRowHeader({
  children,
  className,
  horizontalPadding = "default",
}: TimelineStaticRowHeaderProps) {
  return (
    <div className={cn("w-full rounded-md text-muted-foreground", className)}>
      <CollapsibleHeader
        toneClassName={COLLAPSIBLE_HEADER_STATIC_TONE_CLASS}
        className={timelineRowHeaderClassName(horizontalPadding)}
        summaryClassName={TIMELINE_ROW_HEADER_CONTENT_CLASS_NAME}
        summaryContent={children}
      />
    </div>
  );
}
