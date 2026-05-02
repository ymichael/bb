import type { ReactNode } from "react";
import type { TimelineTitle } from "@bb/thread-view";
import {
  ExpandablePanel,
  getCollapsibleHeaderToneClass,
} from "../primitives/disclosure.js";
import { cn } from "../primitives/cn.js";
import { TimelineTitleView } from "./TimelineTitleView.js";

export interface ExpandableTimelineRowProps {
  isExpanded: boolean;
  onToggle: () => void;
  renderBody: () => ReactNode;
  title: TimelineTitle;
  className?: string;
  horizontalPadding?: TimelineRowHorizontalPadding;
}

export type TimelineRowHorizontalPadding = "default" | "flush";

function headerToneClass(title: TimelineTitle, isExpanded: boolean): string {
  if (title.tone === "destructive") {
    return "text-destructive";
  }
  if (title.tone === "summary") {
    return "text-muted-foreground/60 transition-colors hover:text-muted-foreground/80 focus-visible:text-muted-foreground/80";
  }
  return getCollapsibleHeaderToneClass(isExpanded);
}

function horizontalPaddingClassName(
  horizontalPadding: TimelineRowHorizontalPadding,
): string {
  switch (horizontalPadding) {
    case "default":
      return "px-2";
    case "flush":
      return "px-0";
  }
}

export function ExpandableTimelineRow({
  className,
  horizontalPadding = "default",
  isExpanded,
  onToggle,
  renderBody,
  title,
}: ExpandableTimelineRowProps) {
  const horizontalPaddingClass = horizontalPaddingClassName(horizontalPadding);

  return (
    <ExpandablePanel
      isExpanded={isExpanded}
      onToggle={onToggle}
      headerToneClass={headerToneClass(title, isExpanded)}
      summaryContent={<TimelineTitleView title={title} />}
      summaryContentClassName="min-w-0 max-w-full"
      className={cn("w-full", className)}
      headerClassName={cn(horizontalPaddingClass, "py-0")}
      headerButtonClassName="w-full max-w-full justify-start py-0 leading-none"
      contentClassName={cn(horizontalPaddingClass, "pb-1 pt-0.5")}
    >
      {isExpanded ? renderBody() : null}
    </ExpandablePanel>
  );
}
