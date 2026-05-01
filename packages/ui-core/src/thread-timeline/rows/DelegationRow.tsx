import { useMemo, type ReactNode } from "react";
import {
  buildCollapsedGroupedTimelineRows,
  buildGroupedTimelineRows,
  findLatestActivityRowId,
  getDelegationSummaryParts,
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
import type {
  NestedTimelineMessageRenderOptions,
  NestedTimelineRowPresentationOptions,
  NestedTimelineTurnSummaryRowsController,
} from "../NestedTimelineRows.js";
import { useLatestInitialExpanded } from "../latestInitialExpanded.js";
import type { ThreadTimelineLocalFileLinkHandler } from "../types.js";
import {
  EventTitle,
  formatSummaryDuration,
  getEventHeaderToneClass,
} from "./shared.js";

export { shouldPreferNestedOngoingLabels } from "../NestedTimelineRows.js";

interface DelegationRowProps {
  initialExpanded?: boolean;
  message: ViewDelegationMessage;
  onOpenLocalFileLink?: ThreadTimelineLocalFileLinkHandler;
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
    isError(): boolean {
      return false;
    },
    loadRows(): void {},
  };
}

function formatDelegationRowSuffix(
  metadata: string | undefined,
  duration: string | undefined,
): ReactNode {
  if (!metadata && !duration) {
    return undefined;
  }
  return (
    <span className="inline-flex min-w-0 items-center gap-1.5">
      {metadata ? <span className="truncate">{metadata}</span> : null}
      {duration ? <span className="shrink-0">{duration}</span> : null}
    </span>
  );
}

export function DelegationRow({
  message,
  initialExpanded = false,
  onOpenLocalFileLink,
  preferOngoingLabels = false,
  renderMessage,
}: DelegationRowProps) {
  const { isExpanded, onToggle } = useLatestInitialExpanded(initialExpanded);
  const isSubagentPending = message.status === "pending";
  const nestedRows = useMemo(
    () =>
      isSubagentPending
        ? buildGroupedTimelineRows(message.childProjection)
        : buildCollapsedGroupedTimelineRows(message.childProjection),
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
  const prefix = isWorking ? "Running subagent:" : "Ran subagent:";
  const summaryParts = getDelegationSummaryParts(message);
  const suffix = formatDelegationRowSuffix(
    summaryParts.metadata,
    formatSummaryDuration(message.durationMs ?? undefined),
  );

  return (
    <div className="group w-full">
      <div className="mr-auto w-full">
        <ExpandablePanel
          isExpanded={isExpanded}
          summaryContent={
            <EventTitle
              prefix={prefix}
              emphasis={summaryParts.label}
              suffix={suffix}
              suffixClassName="min-w-0 shrink"
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
                <ConversationMarkdown
                  content={message.output}
                  onOpenLocalFileLink={onOpenLocalFileLink}
                />
              </div>
            ) : null}
          </div>
        </ExpandablePanel>
      </div>
    </div>
  );
}
