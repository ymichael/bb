import { useMemo } from "react";
import {
  buildExploringDetailLines,
  formatExploringCountsLabel,
  summarizeExploringCounts,
} from "@bb/core-ui";
import type { ViewToolExploringMessage } from "@bb/domain";
import { cn } from "../../cn.js";
import { ExpandablePanel } from "../../disclosure.js";
import { useLatestInitialExpanded } from "../latestInitialExpanded.js";
import { ExplorationDetailList } from "./ExplorationDetailList.js";
import {
  EventTitle,
  getEventHeaderToneClass,
  getStaticEventToneClass,
} from "./shared.js";

interface ToolExploringRowProps {
  initialExpanded?: boolean;
  message: ViewToolExploringMessage;
  preferOngoingLabels?: boolean;
}

export function ToolExploringRow({
  message,
  initialExpanded = false,
  preferOngoingLabels = false,
}: ToolExploringRowProps) {
  const { isExpanded, onToggle } = useLatestInitialExpanded(initialExpanded);
  const detailLines = useMemo(
    () =>
      buildExploringDetailLines(message.calls, { readPathStyle: "basename" }),
    [message.calls],
  );
  const counts = useMemo(
    () => summarizeExploringCounts(message.calls),
    [message.calls],
  );
  const hasDetails = detailLines.length > 0;
  const isExploring = message.status === "pending" || preferOngoingLabels;
  const summaryLabel = formatExploringCountsLabel(counts);
  const summaryContent = isExploring ? (
    <EventTitle
      prefix="Exploring"
      emphasis={summaryLabel || undefined}
      suffix="..."
      shimmerPrefix
    />
  ) : (
    <EventTitle prefix="Explored" emphasis={summaryLabel || "workspace"} />
  );
  const headerToneClass = getEventHeaderToneClass(isExpanded);

  if (!hasDetails) {
    return (
      <div className="group w-full" style={{ overflowAnchor: "none" }}>
        <div className="mr-auto w-full">
          <div className="rounded-md px-2 py-1 text-sm text-muted-foreground">
            <div className={cn("py-0.5", getStaticEventToneClass())}>
              {summaryContent}
            </div>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="group w-full" style={{ overflowAnchor: "none" }}>
      <div className="mr-auto w-full">
        <ExpandablePanel
          isExpanded={isExpanded}
          summaryContent={summaryContent}
          summaryContentClassName="min-w-0"
          headerToneClass={headerToneClass}
          onToggle={onToggle}
        >
          <ExplorationDetailList
            detailLines={detailLines}
            isExpanded={isExpanded}
          />
        </ExpandablePanel>
      </div>
    </div>
  );
}
