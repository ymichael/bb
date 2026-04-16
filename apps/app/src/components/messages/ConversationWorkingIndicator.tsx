import { useState } from "react";
import {
  ExpandablePanel,
  getCollapsibleHeaderToneClass,
} from "@bb/ui-core";
import { ConversationStatusIndicator } from "@/components/messages/ConversationStatusIndicator";
import { cn } from "@/lib/utils";

interface ConversationWorkingIndicatorProps {
  label?: string;
  isThinking?: boolean;
  details?: string;
  className?: string;
}

export function ConversationWorkingIndicator({
  label,
  isThinking = false,
  details,
  className,
}: ConversationWorkingIndicatorProps) {
  const [isExpanded, setIsExpanded] = useState(false);
  const resolvedLabel = label ?? (isThinking ? "Thinking..." : "Working...");
  const trimmedDetails = details?.trim() ?? "";

  if (trimmedDetails.length > 0) {
    return (
      <div style={{ overflowAnchor: "none" }} className={cn("mt-4", className)}>
        <ExpandablePanel
          isExpanded={isExpanded}
          summaryContent={<span className="animate-shine">{resolvedLabel}</span>}
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
    <div style={{ overflowAnchor: "none" }}>
      <ConversationStatusIndicator
        label={resolvedLabel}
        className={cn("mt-4", className)}
      />
    </div>
  );
}
