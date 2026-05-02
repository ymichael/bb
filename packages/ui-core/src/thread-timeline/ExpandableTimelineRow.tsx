import type { ReactNode } from "react";
import type { TimelineTitle } from "@bb/thread-view";
import {
  ExpandablePanel,
  getCollapsibleHeaderToneClass,
} from "../primitives/disclosure.js";
import { cn } from "../primitives/cn.js";
import { TimelineTitleView } from "./TimelineTitleView.js";

export interface ExpandableTimelineRowProps {
  body: ReactNode;
  isExpanded: boolean;
  onToggle: () => void;
  title: TimelineTitle;
  className?: string;
}

function headerToneClass(title: TimelineTitle, isExpanded: boolean): string {
  if (title.tone === "destructive") {
    return "text-destructive";
  }
  if (title.tone === "summary") {
    return "text-muted-foreground/60 transition-colors group-hover:text-muted-foreground/80 group-focus-within:text-muted-foreground/80";
  }
  return getCollapsibleHeaderToneClass(isExpanded);
}

export function ExpandableTimelineRow({
  body,
  className,
  isExpanded,
  onToggle,
  title,
}: ExpandableTimelineRowProps) {
  return (
    <ExpandablePanel
      isExpanded={isExpanded}
      onToggle={onToggle}
      headerToneClass={headerToneClass(title, isExpanded)}
      summaryContent={<TimelineTitleView title={title} />}
      summaryContentClassName="min-w-0 max-w-full"
      className={cn("group w-full", className)}
      headerClassName="px-2 py-1"
      contentClassName="px-2 pb-2 pt-0"
    >
      {body}
    </ExpandablePanel>
  );
}
