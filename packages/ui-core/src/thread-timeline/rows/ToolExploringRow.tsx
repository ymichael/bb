import { useMemo } from "react";
import {
  buildExploringDetailLines,
  formatExploringCountsLabel,
  summarizeExploringCounts,
} from "@bb/core-ui";
import type { ViewToolExploringMessage } from "@bb/domain";
import { ExpandablePanel } from "../../disclosure.js";
import { useLatestInitialExpanded } from "../latestInitialExpanded.js";
import {
  ExpandableDetailScrollArea,
  EventTitle,
  getEventHeaderToneClass,
  getStaticEventToneClass,
  useStickyBottomAutoScroll,
} from "./shared.js";

export function ToolExploringRow({
  message,
  initialExpanded = false,
  preferOngoingLabels = false,
}: {
  message: ViewToolExploringMessage;
  initialExpanded?: boolean;
  preferOngoingLabels?: boolean;
}) {
  const { isExpanded, onToggle } = useLatestInitialExpanded(initialExpanded);
  const detailLines = useMemo(
    () => buildExploringDetailLines(message.calls, { readPathStyle: "basename" }),
    [message.calls],
  );
  const { elementRef: detailRef, handleScroll: handleDetailScroll } =
    useStickyBottomAutoScroll<HTMLDivElement>({
      isExpanded,
      scrollDep: detailLines,
    });
  const counts = useMemo(() => summarizeExploringCounts(message.calls), [message.calls]);
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
    <EventTitle
      prefix="Explored"
      emphasis={summaryLabel || "workspace"}
    />
  );
  const headerToneClass = getEventHeaderToneClass(isExpanded);

  if (!hasDetails) {
    return (
      <div className="group w-full" style={{ overflowAnchor: "none" }}>
        <div className="mr-auto w-full">
          <div className="rounded-md px-2 py-1 text-sm text-muted-foreground">
            <div className={`py-0.5 ${getStaticEventToneClass()}`}>
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
          <ExpandableDetailScrollArea
            scrollRef={detailRef}
            onScroll={handleDetailScroll}
            className="mt-0.5 space-y-0.5"
          >
            {detailLines.map((line, index) => (
              <div
                key={`${message.id}:${index}`}
                className="min-w-0 truncate font-mono ui-text-sm text-foreground/80"
                title={line}
              >
                {line}
              </div>
            ))}
          </ExpandableDetailScrollArea>
        </ExpandablePanel>
      </div>
    </div>
  );
}
