import { useMemo, type ReactNode } from "react";
import { cn } from "../../cn.js";
import {
  buildTimelineRowsFromMessagesForNestedDisplay,
  buildToolGroupSummaryParts,
  formatDelegationSummary,
} from "@bb/core-ui";
import type {
  TimelineRow,
  TimelineToolGroupRow,
  ViewDelegationMessage,
  ViewMessage,
} from "@bb/domain";
import { ExpandablePanel } from "../../disclosure.js";
import { ConversationMarkdown } from "../ConversationMarkdown.js";
import { useLatestInitialExpanded } from "../latestInitialExpanded.js";
import {
  findLatestActivityRowId,
  shouldPreferOngoingLabelsForRow,
} from "../threadDetailActivity.js";
import {
  EVENT_LARGE_DETAIL_MAX_HEIGHT_CLASS,
  EventTitle,
  formatSummaryDuration,
  getEventHeaderToneClass,
} from "./shared.js";

interface NestedRenderOptions {
  initialExpanded?: boolean;
  preferOngoingLabels?: boolean;
}

interface NestedToolGroupProps {
  entry: TimelineToolGroupRow;
  preferOngoingLabels?: boolean;
  renderMessage: (message: ViewMessage, options?: NestedRenderOptions) => ReactNode;
}

interface NestedRowOngoingLabelInput {
  latestActivityRowId: string | null;
  preferOngoingLabels: boolean;
  row: TimelineRow;
}

export function shouldPreferNestedOngoingLabels({
  latestActivityRowId,
  preferOngoingLabels,
  row,
}: NestedRowOngoingLabelInput): boolean {
  return (
    preferOngoingLabels &&
    shouldPreferOngoingLabelsForRow(row, latestActivityRowId)
  );
}

function NestedToolGroup({
  entry,
  preferOngoingLabels = false,
  renderMessage,
}: NestedToolGroupProps) {
  const { isExpanded, onToggle } = useLatestInitialExpanded(false);
  const duration = formatSummaryDuration(entry.durationMs);
  const isWorking = entry.status === "pending" || preferOngoingLabels;
  const tone = "default";
  const summary = buildToolGroupSummaryParts({
    duration,
    status: isWorking ? "pending" : entry.status,
    summaryCount: entry.summaryCount,
  });
  const summaryContent = (
    <EventTitle
      prefix={summary.prefix}
      emphasis={summary.emphasis}
      suffix={summary.suffix}
      shimmerPrefix={isWorking}
      tone={tone}
    />
  );

  return (
    <ExpandablePanel
      isExpanded={isExpanded}
      summaryContent={summaryContent}
      headerToneClass={getEventHeaderToneClass(isExpanded, tone)}
      onToggle={onToggle}
    >
      <div className="overflow-hidden rounded-md border border-border/60 bg-background/40">
        {entry.messages.map((message, index) => {
          const isLastMessage = index === entry.messages.length - 1;
          const shouldAutoExpand = isLastMessage && entry.status === "pending";
          return (
            <div key={message.id}>
              {renderMessage(message, {
                initialExpanded: shouldAutoExpand,
                preferOngoingLabels: preferOngoingLabels && isLastMessage,
              })}
            </div>
          );
        })}
      </div>
    </ExpandablePanel>
  );
}

export function DelegationRow({
  message,
  initialExpanded = false,
  preferOngoingLabels = false,
  renderMessage,
}: {
  message: ViewDelegationMessage;
  initialExpanded?: boolean;
  preferOngoingLabels?: boolean;
  renderMessage: (message: ViewMessage, options?: NestedRenderOptions) => ReactNode;
}) {
  const { isExpanded, onToggle } = useLatestInitialExpanded(initialExpanded);
  const nestedRows = useMemo(
    () =>
      buildTimelineRowsFromMessagesForNestedDisplay(message.children, {
        collapseAll: true,
      }),
    [message.children],
  );
  const nestedLatestActivityRowId = useMemo(
    () => findLatestActivityRowId(nestedRows),
    [nestedRows],
  );
  const isWorking = message.status === "pending" || preferOngoingLabels;
  const summaryContent = (
    <EventTitle
      prefix="Subagent"
      emphasis={formatDelegationSummary(message)}
      suffix={formatSummaryDuration(message.durationMs)}
      tone={message.status === "error" ? "destructive" : "default"}
      shimmerPrefix={isWorking}
    />
  );

  return (
    <div className="group w-full" style={{ overflowAnchor: "none" }}>
      <div className="mr-auto w-full">
        <ExpandablePanel
          isExpanded={isExpanded}
          summaryContent={summaryContent}
          summaryContentClassName="min-w-0"
          headerToneClass={getEventHeaderToneClass(
            isExpanded,
            message.status === "error" ? "destructive" : "default",
          )}
          onToggle={onToggle}
        >
          <div className={cn("overflow-auto rounded-md border border-border/60 bg-background/40", EVENT_LARGE_DETAIL_MAX_HEIGHT_CLASS)}>
            {nestedRows.map((row, index) => {
              const isLastRow = index === nestedRows.length - 1 && !message.output;
              const shouldAutoExpand = isLastRow && isWorking;
              const rowPreferOngoingLabels = shouldPreferNestedOngoingLabels({
                latestActivityRowId: nestedLatestActivityRowId,
                preferOngoingLabels,
                row,
              });
              if (row.kind === "tool-group") {
                return (
                  <NestedToolGroup
                    key={row.id}
                    entry={row}
                    preferOngoingLabels={rowPreferOngoingLabels}
                    renderMessage={renderMessage}
                  />
                );
              }
              return (
                <div key={row.id}>
                  {renderMessage(row.message, {
                    initialExpanded: shouldAutoExpand,
                    preferOngoingLabels: rowPreferOngoingLabels,
                  })}
                </div>
              );
            })}
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
