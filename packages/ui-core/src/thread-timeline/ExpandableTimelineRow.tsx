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
  className,
  isExpanded,
  onToggle,
  renderBody,
  title,
}: ExpandableTimelineRowProps) {
  return (
    <ExpandablePanel
      isExpanded={isExpanded}
      onToggle={onToggle}
      headerToneClass={headerToneClass(title, isExpanded)}
      summaryContent={<TimelineTitleView title={title} />}
      summaryContentClassName="min-w-0 max-w-full"
      className={cn(isExpanded ? "w-full" : "group w-full", className)}
      headerClassName="px-2 py-0"
      headerButtonClassName="w-full max-w-full justify-start py-0 leading-4"
      contentClassName="px-2 pb-1 pt-0"
    >
      {isExpanded ? renderBody() : null}
    </ExpandablePanel>
  );
}
