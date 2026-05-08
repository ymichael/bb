import { memo, useCallback, useState, type ReactNode } from "react";
import type { TimelineTitle } from "@bb/thread-view";
import {
  ExpandablePanel,
  getCollapsibleHeaderToneClass,
} from "../../ui/disclosure.js";
import { cn } from "@/lib/utils";
import {
  TIMELINE_ROW_HEADER_CONTENT_CLASS_NAME,
  timelineRowHeaderClassName,
  timelineRowHorizontalPaddingClassName,
  type TimelineRowHorizontalPadding,
} from "./TimelineRowHeader.js";
import {
  TimelineTitleView,
  type TimelineTitleActionResolver,
  type TimelineTitleLinkResolver,
} from "./TimelineTitleView.js";

export interface ExpandableTimelineRowProps {
  autoExpanded?: boolean;
  onBeforeExpand?: () => void;
  renderBody: () => ReactNode;
  title: TimelineTitle;
  className?: string;
  horizontalPadding?: TimelineRowHorizontalPadding;
  onTitleAction?: TimelineTitleActionResolver;
  resolveSegmentLinkHref?: TimelineTitleLinkResolver;
}

type ManualExpansionOverride = boolean | null;

function headerToneClass(title: TimelineTitle, isExpanded: boolean): string {
  if (title.tone === "destructive") {
    return "text-destructive";
  }
  if (title.tone === "summary") {
    return "text-muted-foreground/60 transition-colors hover:text-muted-foreground/80 focus-visible:text-muted-foreground/80";
  }
  return getCollapsibleHeaderToneClass(isExpanded);
}

function ExpandableTimelineRowComponent({
  autoExpanded = false,
  className,
  horizontalPadding = "default",
  onBeforeExpand,
  onTitleAction,
  renderBody,
  resolveSegmentLinkHref,
  title,
}: ExpandableTimelineRowProps) {
  const [manualExpansionOverride, setManualExpansionOverride] =
    useState<ManualExpansionOverride>(null);
  const isExpanded = manualExpansionOverride ?? autoExpanded;
  const horizontalPaddingClass =
    timelineRowHorizontalPaddingClassName(horizontalPadding);
  const handleToggle = useCallback((): void => {
    if (!isExpanded) {
      onBeforeExpand?.();
    }
    setManualExpansionOverride(!isExpanded);
  }, [isExpanded, onBeforeExpand]);

  return (
    <ExpandablePanel
      isExpanded={isExpanded}
      onToggle={handleToggle}
      headerToneClass={headerToneClass(title, isExpanded)}
      summaryContent={
        <TimelineTitleView
          title={title}
          onTitleAction={onTitleAction}
          resolveSegmentLinkHref={resolveSegmentLinkHref}
        />
      }
      summaryContentClassName={TIMELINE_ROW_HEADER_CONTENT_CLASS_NAME}
      className={cn("w-full", className)}
      headerClassName={timelineRowHeaderClassName(horizontalPadding)}
      contentClassName={cn(horizontalPaddingClass, "pb-1 pt-0.5")}
      renderBody={renderBody}
    />
  );
}

export const ExpandableTimelineRow = memo(ExpandableTimelineRowComponent);
