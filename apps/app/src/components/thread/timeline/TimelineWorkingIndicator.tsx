import { useState } from "react";
import {
  ExpandablePanel,
  getCollapsibleHeaderToneClass,
} from "../../ui/disclosure.js";
import { cn } from "@/lib/utils";
import { TimelineStatusIndicator } from "./TimelineStatusIndicator.js";

export interface TimelineWorkingIndicatorProps {
  label?: string;
  isThinking?: boolean;
  details?: string;
  className?: string;
}

export function TimelineWorkingIndicator({
  label,
  isThinking = false,
  details,
  className,
}: TimelineWorkingIndicatorProps) {
  const [isExpanded, setIsExpanded] = useState(false);
  const resolvedLabel = label ?? (isThinking ? "Thinking..." : "Working...");
  const trimmedDetails = details?.trim() ?? "";

  if (trimmedDetails.length > 0) {
    return (
      <div className={cn("mt-4", className)}>
        <ExpandablePanel
          isExpanded={isExpanded}
          summaryContent={
            <span className="animate-shine">{resolvedLabel}</span>
          }
          headerToneClass={getCollapsibleHeaderToneClass(isExpanded)}
          onToggle={() => setIsExpanded((current) => !current)}
        >
          <div className="max-h-80 overflow-auto whitespace-pre-wrap text-sm italic leading-relaxed text-muted-foreground">
            {details}
          </div>
        </ExpandablePanel>
      </div>
    );
  }

  return (
    <TimelineStatusIndicator
      label={<span className="animate-shine">{resolvedLabel}</span>}
      className={cn("mt-4", className)}
    />
  );
}
