import type { ReactNode } from "react";
import type { TimelineTitle } from "@bb/thread-view";
import {
  ExpandablePanel,
  getCollapsibleHeaderToneClass,
} from "../primitives/disclosure.js";
import { cn } from "../primitives/cn.js";
import {
  TIMELINE_ROW_HEADER_CONTENT_CLASS_NAME,
  timelineRowHeaderClassName,
  timelineRowHorizontalPaddingClassName,
  type TimelineRowHorizontalPadding,
} from "./TimelineRowHeader.js";
import { TimelineTitleView } from "./TimelineTitleView.js";

export interface ExpandableTimelineRowProps {
  isExpanded: boolean;
  onToggle: () => void;
  renderBody: () => ReactNode;
  title: TimelineTitle;
  className?: string;
  horizontalPadding?: TimelineRowHorizontalPadding;
}

function headerToneClass(title: TimelineTitle, isExpanded: boolean): string {
  if (title.tone === "destructive") {
    return "text-destructive";
  }
  if (title.tone === "summary") {
    return "text-muted-foreground/60 transition-colors hover:text-muted-foreground/80 focus-visible:text-muted-foreground/80";
  }
  return getCollapsibleHeaderToneClass(isExpanded);
}

export function ExpandableTimelineRow({
  className,
  horizontalPadding = "default",
  isExpanded,
  onToggle,
  renderBody,
  title,
}: ExpandableTimelineRowProps) {
  const horizontalPaddingClass =
    timelineRowHorizontalPaddingClassName(horizontalPadding);

  return (
    <ExpandablePanel
      isExpanded={isExpanded}
      onToggle={onToggle}
      headerToneClass={headerToneClass(title, isExpanded)}
      summaryContent={<TimelineTitleView title={title} />}
      summaryContentClassName={TIMELINE_ROW_HEADER_CONTENT_CLASS_NAME}
      className={cn("w-full", className)}
      headerClassName={timelineRowHeaderClassName(horizontalPadding)}
      contentClassName={cn(horizontalPaddingClass, "pb-1 pt-0.5")}
      renderBody={renderBody}
    />
  );
}
