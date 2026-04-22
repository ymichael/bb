import { useMemo, type ReactNode } from "react";
import {
  buildCollapsedTimelineRows,
  buildTimelineRows,
  findLatestActivityRowId,
  formatDelegationSummary,
} from "@bb/core-ui";
import type {
  TimelineRow,
  TimelineTurnSummaryRow,
  ViewDelegationMessage,
  ViewMessage,
} from "@bb/domain";
import { getDetailScrollMaxHeightClass } from "../../detail-scroll-size.js";
import { cn } from "../../cn.js";
import { ExpandablePanel } from "../../disclosure.js";
import { ConversationMarkdown } from "../ConversationMarkdown.js";
import { NestedTimelineRows } from "../NestedTimelineRows.js";
import {
  type NestedTimelineMessageRenderOptions,
  type NestedTimelineRowPresentationOptions,
  type NestedTimelineTurnSummaryRowsController,
} from "../NestedTimelineRows.js";
import { useLatestInitialExpanded } from "../latestInitialExpanded.js";
import { EventTitle, formatSummaryDuration, getEventHeaderToneClass } from "./shared.js";

export { shouldPreferNestedOngoingLabels } from "../NestedTimelineRows.js";

interface DelegationRowProps {
  initialExpanded?: boolean;
  message: ViewDelegationMessage;
  preferOngoingLabels?: boolean;
  renderMessage: (
    message: ViewMessage,
    options?: NestedTimelineMessageRenderOptions,
  ) => ReactNode;
}

function getNestedPresentationOptions(
  preferOngoingLabels: boolean,
): NestedTimelineRowPresentationOptions {
  return {
    expandErrors: true,
    groupedRowsUseOngoingLabels: true,
    preferOngoingLabels,
  };
}

function createTurnSummaryRowsController(): NestedTimelineTurnSummaryRowsController {
  return {
    getRows(row: TimelineTurnSummaryRow): TimelineRow[] | null {
      return row.rows;
    },
    isLoading(): boolean {
      return false;
    },
    loadRows(): void {},
  };
}

export function DelegationRow({
  message,
  initialExpanded = false,
  preferOngoingLabels = false,
  renderMessage,
}: DelegationRowProps) {
  const { isExpanded, onToggle } = useLatestInitialExpanded(initialExpanded);
  const isSubagentPending = message.status === "pending";
  const nestedRows = useMemo(
    () =>
      isSubagentPending
        ? buildTimelineRows(message.childProjection)
        : buildCollapsedTimelineRows(message.childProjection),
    [message.childProjection, isSubagentPending],
  );
  const nestedLatestActivityRowId = useMemo(
    () => findLatestActivityRowId(nestedRows),
    [nestedRows],
  );
  const turnSummaryRowsController = useMemo(
    () => createTurnSummaryRowsController(),
    [],
  );
  const isWorking = message.status === "pending" || preferOngoingLabels;

  return (
    <div className="group w-full" style={{ overflowAnchor: "none" }}>
      <div className="mr-auto w-full">
        <ExpandablePanel
          isExpanded={isExpanded}
          summaryContent={
            <EventTitle
              prefix="Subagent"
              emphasis={formatDelegationSummary(message)}
              suffix={formatSummaryDuration(message.durationMs)}
              tone={message.status === "error" ? "destructive" : "default"}
              shimmerPrefix={isWorking}
            />
          }
          summaryContentClassName="min-w-0"
          headerToneClass={getEventHeaderToneClass(
            isExpanded,
            message.status === "error" ? "destructive" : "default",
          )}
          onToggle={onToggle}
        >
          <div
            className={cn(
              "overflow-auto rounded-md border border-border/60 bg-background/40",
              getDetailScrollMaxHeightClass("large"),
            )}
          >
            <NestedTimelineRows
              latestActivityRowId={nestedLatestActivityRowId}
              presentationOptions={getNestedPresentationOptions(
                preferOngoingLabels,
              )}
              renderMessage={renderMessage}
              rows={nestedRows}
              turnSummaryRowsController={turnSummaryRowsController}
            />
            {message.output ? (
              <div className="px-2 py-2 text-sm leading-relaxed">
                <ConversationMarkdown content={message.output} />
              </div>
            ) : null}
          </div>
        </ExpandablePanel>
      </div>
    </div>
  );
}
