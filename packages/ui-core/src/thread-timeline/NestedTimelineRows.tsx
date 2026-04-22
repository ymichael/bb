import { useMemo, type ReactNode } from "react";
import {
  buildTimelineAssistantStepSummaryLabel,
  buildTimelineRowActivityInfoMap,
  buildToolBundleSummaryLabel,
  buildTurnSummaryParts,
  shouldPreferOngoingLabelsForRow,
  type TimelineRowActivityInfo,
} from "@bb/core-ui";
import type {
  TimelineAssistantStepSummaryRow,
  TimelineGroupedRowStatus,
  TimelineMessageRow,
  TimelineRow,
  TimelineToolBundleRow,
  TimelineTurnSummaryRow,
  ViewMessage,
} from "@bb/domain";
import { ExpandablePanel } from "../disclosure.js";
import { useLatestInitialExpanded } from "./latestInitialExpanded.js";
import { shouldDeEmphasizeGroupedSummary } from "./grouped-summary-presentation.js";
import { ToolBundleBody } from "./rows/ToolBundleBody.js";
import {
  EventTitle,
  GroupedSummaryText,
  formatSummaryDuration,
  getEventHeaderToneClass,
  type EventTitleTone,
} from "./rows/shared.js";

export interface NestedTimelineMessageRenderOptions {
  initialExpanded?: boolean;
  preferOngoingLabels?: boolean;
}

export interface NestedTimelineRowPresentationOptions {
  expandErrors: boolean;
  groupedRowsUseOngoingLabels: boolean;
  preferOngoingLabels: boolean;
}

export interface NestedTimelineTurnSummaryRowsController {
  getRows: (row: TimelineTurnSummaryRow) => TimelineRow[] | null;
  isLoading: (row: TimelineTurnSummaryRow) => boolean;
  loadRows: (row: TimelineTurnSummaryRow) => void;
}

export interface NestedTimelineRowsProps {
  latestActivityRowId: string | null;
  presentationOptions: NestedTimelineRowPresentationOptions;
  renderMessage: (
    message: ViewMessage,
    options?: NestedTimelineMessageRenderOptions,
  ) => ReactNode;
  rowContainerClassName?: string;
  rows: TimelineRow[];
  turnSummaryRowsController: NestedTimelineTurnSummaryRowsController;
}

export interface NestedRowOngoingLabelInput {
  latestActivityRowId: string | null;
  preferOngoingLabels: boolean;
  row: TimelineRow;
  rowActivityInfo?: TimelineRowActivityInfo;
}

interface NestedTimelineRowState {
  activityInfoById: ReadonlyMap<string, TimelineRowActivityInfo>;
  autoExpandById: ReadonlyMap<string, boolean>;
}

interface GroupedSummaryEntryCommonProps {
  latestActivityRowId: string | null;
  presentationOptions: NestedTimelineRowPresentationOptions;
  renderMessage: (
    message: ViewMessage,
    options?: NestedTimelineMessageRenderOptions,
  ) => ReactNode;
  rowContainerClassName?: string;
  rowState: NestedTimelineRowState;
  turnSummaryRowsController: NestedTimelineTurnSummaryRowsController;
}

interface AssistantStepSummaryEntryProps extends GroupedSummaryEntryCommonProps {
  entry: TimelineAssistantStepSummaryRow;
}

interface ToolBundleEntryProps extends GroupedSummaryEntryCommonProps {
  entry: TimelineToolBundleRow;
}

interface TurnSummaryEntryProps extends GroupedSummaryEntryCommonProps {
  entry: TimelineTurnSummaryRow;
}

interface TimelineRowEntryProps extends GroupedSummaryEntryCommonProps {
  row: TimelineRow;
}

interface ToolBundleMessageRowRenderer {
  (row: TimelineMessageRow): ReactNode;
}

interface NestedTimelineRowsContentProps extends NestedTimelineRowsProps {
  rowState: NestedTimelineRowState;
}

export function shouldPreferNestedOngoingLabels({
  latestActivityRowId,
  preferOngoingLabels,
  row,
  rowActivityInfo,
}: NestedRowOngoingLabelInput): boolean {
  return (
    preferOngoingLabels &&
    (rowActivityInfo?.shouldPreferOngoingLabels ??
      shouldPreferOngoingLabelsForRow(row, latestActivityRowId))
  );
}

function isPendingLikeMessage(message: ViewMessage): boolean {
  switch (message.kind) {
    case "assistant-reasoning":
    case "assistant-text":
      return message.status === "streaming";
    case "tool-call":
    case "tool-exploring":
    case "web-search":
    case "web-fetch":
    case "file-edit":
    case "permission-grant-lifecycle":
    case "tasks":
    case "delegation":
      return message.status === "pending";
    case "operation":
      return message.status === "pending";
    case "user":
    case "error":
    case "debug/raw-event":
      return false;
    default:
      return false;
  }
}

function shouldAutoExpandMessage(
  message: ViewMessage,
  expandErrors: boolean,
): boolean {
  if (message.kind === "error") {
    return expandErrors;
  }
  return isPendingLikeMessage(message);
}

function shouldAutoExpandStatus(
  status: TimelineGroupedRowStatus,
  expandErrors: boolean,
): boolean {
  if (status === "pending") {
    return true;
  }
  if (status === "error") {
    return expandErrors;
  }
  return false;
}

function buildNestedTimelineAutoExpandMap(
  rows: readonly TimelineRow[],
  expandErrors: boolean,
  turnSummaryRowsController: NestedTimelineTurnSummaryRowsController,
): ReadonlyMap<string, boolean> {
  const autoExpandById = new Map<string, boolean>();

  const visitRow = (row: TimelineRow): boolean => {
    const childRows =
      row.kind === "tool-bundle" || row.kind === "assistant-step-summary"
        ? row.rows
        : row.kind === "turn-summary"
          ? turnSummaryRowsController.getRows(row) ?? []
          : [];
    const childShouldAutoExpand = childRows.some((childRow) => visitRow(childRow));
    const shouldAutoExpand =
      row.kind === "message"
        ? shouldAutoExpandMessage(row.message, expandErrors)
        : shouldAutoExpandStatus(row.status, expandErrors) ||
          childShouldAutoExpand;

    autoExpandById.set(row.id, shouldAutoExpand);
    return shouldAutoExpand;
  };

  for (const row of rows) {
    visitRow(row);
  }

  return autoExpandById;
}

function getRowActivityInfo(
  row: TimelineRow,
  rowState: NestedTimelineRowState,
): TimelineRowActivityInfo {
  return (
    rowState.activityInfoById.get(row.id) ?? {
      containsLatestActivity: false,
      shouldPreferOngoingLabels: false,
    }
  );
}

function shouldAutoExpandTimelineRow(
  row: TimelineRow,
  rowState: NestedTimelineRowState,
): boolean {
  return rowState.autoExpandById.get(row.id) ?? false;
}

function getRowIsWorking(
  row: TimelineToolBundleRow | TimelineTurnSummaryRow,
  presentationOptions: NestedTimelineRowPresentationOptions,
  preferOngoingLabels: boolean,
): boolean {
  if (row.status === "pending") {
    return true;
  }

  return presentationOptions.groupedRowsUseOngoingLabels && preferOngoingLabels;
}

function ToolBundleEntry({
  entry,
  latestActivityRowId,
  presentationOptions,
  renderMessage,
  rowState,
}: ToolBundleEntryProps) {
  const preferOngoingLabels = shouldPreferNestedOngoingLabels({
    latestActivityRowId,
    preferOngoingLabels: presentationOptions.preferOngoingLabels,
    row: entry,
    rowActivityInfo: getRowActivityInfo(entry, rowState),
  });
  const { isExpanded, onToggle } = useLatestInitialExpanded(
    shouldAutoExpandTimelineRow(entry, rowState),
  );
  const tone: EventTitleTone = "default";
  const summary = buildToolBundleSummaryLabel(entry);
  const renderMessageRow: ToolBundleMessageRowRenderer = (messageRow) => {
    const rowPreferOngoingLabels = shouldPreferNestedOngoingLabels({
      latestActivityRowId,
      preferOngoingLabels: presentationOptions.preferOngoingLabels,
      row: messageRow,
      rowActivityInfo: getRowActivityInfo(messageRow, rowState),
    });

    return (
      <div key={messageRow.id}>
        {renderMessage(messageRow.message, {
          initialExpanded: shouldAutoExpandTimelineRow(messageRow, rowState),
          preferOngoingLabels: rowPreferOngoingLabels,
        })}
      </div>
    );
  };

  return (
    <div className="group w-full" style={{ overflowAnchor: "none" }}>
      <div className="mr-auto w-full">
        <ExpandablePanel
          isExpanded={isExpanded}
          onToggle={onToggle}
          headerToneClass={getEventHeaderToneClass(isExpanded, tone)}
          summaryContent={
            <GroupedSummaryText
              emphasized={!shouldDeEmphasizeGroupedSummary(entry)}
              isWorking={getRowIsWorking(
                entry,
                presentationOptions,
                preferOngoingLabels,
              )}
              text={summary}
            />
          }
          bodyClassName="duration-300"
          contentClassName="pb-1 duration-300"
        >
          <ToolBundleBody
            entry={entry}
            isExpanded={isExpanded}
            renderMessageRow={renderMessageRow}
          />
        </ExpandablePanel>
      </div>
    </div>
  );
}

function AssistantStepSummaryEntry({
  entry,
  latestActivityRowId,
  presentationOptions,
  renderMessage,
  rowContainerClassName,
  rowState,
  turnSummaryRowsController,
}: AssistantStepSummaryEntryProps) {
  const { isExpanded, onToggle } = useLatestInitialExpanded(
    shouldAutoExpandTimelineRow(entry, rowState),
  );
  const tone: EventTitleTone = "default";

  return (
    <div className="group w-full" style={{ overflowAnchor: "none" }}>
      <div className="mr-auto w-full">
        <ExpandablePanel
          isExpanded={isExpanded}
          onToggle={onToggle}
          headerToneClass={getEventHeaderToneClass(isExpanded, tone)}
          summaryContent={
            <GroupedSummaryText
              emphasized={!shouldDeEmphasizeGroupedSummary(entry)}
              isWorking={false}
              text={buildTimelineAssistantStepSummaryLabel(entry.rows)}
            />
          }
          bodyClassName="duration-300"
          contentClassName="pb-1 duration-300"
        >
          <div className="overflow-hidden rounded-md border border-border/60 bg-background/40">
            <NestedTimelineRowsContent
              latestActivityRowId={latestActivityRowId}
              presentationOptions={presentationOptions}
              renderMessage={renderMessage}
              rowContainerClassName={rowContainerClassName}
              rowState={rowState}
              rows={entry.rows}
              turnSummaryRowsController={turnSummaryRowsController}
            />
          </div>
        </ExpandablePanel>
      </div>
    </div>
  );
}

function TurnSummaryEntry({
  entry,
  latestActivityRowId,
  presentationOptions,
  renderMessage,
  rowContainerClassName,
  rowState,
  turnSummaryRowsController,
}: TurnSummaryEntryProps) {
  const preferOngoingLabels = shouldPreferNestedOngoingLabels({
    latestActivityRowId,
    preferOngoingLabels: presentationOptions.preferOngoingLabels,
    row: entry,
    rowActivityInfo: getRowActivityInfo(entry, rowState),
  });
  const rows = turnSummaryRowsController.getRows(entry);
  const isLoadingRows = turnSummaryRowsController.isLoading(entry);
  const { isExpanded, onToggle } = useLatestInitialExpanded(
    shouldAutoExpandTimelineRow(entry, rowState),
  );
  const tone: EventTitleTone = "default";
  const summary = buildTurnSummaryParts({
    duration: formatSummaryDuration(entry.durationMs),
    status: entry.status,
    summaryCount: entry.summaryCount,
  });

  const handleToggle = () => {
    if (!isExpanded && rows === null && !isLoadingRows) {
      turnSummaryRowsController.loadRows(entry);
    }
    onToggle();
  };

  return (
    <div className="group w-full" style={{ overflowAnchor: "none" }}>
      <div className="mr-auto w-full">
        <ExpandablePanel
          isExpanded={isExpanded}
          onToggle={handleToggle}
          headerToneClass={getEventHeaderToneClass(isExpanded, tone)}
          summaryContent={
            <EventTitle
              prefix={summary.prefix}
              emphasis={summary.emphasis}
              shimmerPrefix={getRowIsWorking(
                entry,
                presentationOptions,
                preferOngoingLabels,
              )}
              suffixClassName="truncate"
              tone={tone}
            />
          }
          bodyClassName="duration-300"
          contentClassName="pb-1 duration-300"
        >
          <div className="overflow-hidden rounded-md border border-border/60 bg-background/40">
            {isLoadingRows ? (
              <div className="px-3 py-2 text-xs text-muted-foreground">
                <span className="animate-shine">Loading details...</span>
              </div>
            ) : null}
            {rows ? (
              <NestedTimelineRowsContent
                latestActivityRowId={latestActivityRowId}
                presentationOptions={presentationOptions}
                renderMessage={renderMessage}
                rowContainerClassName={rowContainerClassName}
                rowState={rowState}
                rows={rows}
                turnSummaryRowsController={turnSummaryRowsController}
              />
            ) : null}
          </div>
        </ExpandablePanel>
      </div>
    </div>
  );
}

function TimelineRowEntry({
  latestActivityRowId,
  presentationOptions,
  renderMessage,
  row,
  rowContainerClassName,
  rowState,
  turnSummaryRowsController,
}: TimelineRowEntryProps) {
  const preferOngoingLabels = shouldPreferNestedOngoingLabels({
    latestActivityRowId,
    preferOngoingLabels: presentationOptions.preferOngoingLabels,
    row,
    rowActivityInfo: getRowActivityInfo(row, rowState),
  });

  if (row.kind === "message") {
    return (
      <div data-thread-row-id={row.id} className={rowContainerClassName}>
        {renderMessage(row.message, {
          initialExpanded: shouldAutoExpandTimelineRow(row, rowState),
          preferOngoingLabels,
        })}
      </div>
    );
  }

  return (
    <div data-thread-row-id={row.id} className={rowContainerClassName}>
      {row.kind === "tool-bundle" ? (
        <ToolBundleEntry
          entry={row}
          latestActivityRowId={latestActivityRowId}
          presentationOptions={presentationOptions}
          renderMessage={renderMessage}
          rowContainerClassName={rowContainerClassName}
          rowState={rowState}
          turnSummaryRowsController={turnSummaryRowsController}
        />
      ) : row.kind === "assistant-step-summary" ? (
        <AssistantStepSummaryEntry
          entry={row}
          latestActivityRowId={latestActivityRowId}
          presentationOptions={presentationOptions}
          renderMessage={renderMessage}
          rowContainerClassName={rowContainerClassName}
          rowState={rowState}
          turnSummaryRowsController={turnSummaryRowsController}
        />
      ) : (
        <TurnSummaryEntry
          entry={row}
          latestActivityRowId={latestActivityRowId}
          presentationOptions={presentationOptions}
          renderMessage={renderMessage}
          rowContainerClassName={rowContainerClassName}
          rowState={rowState}
          turnSummaryRowsController={turnSummaryRowsController}
        />
      )}
    </div>
  );
}

function NestedTimelineRowsContent({
  latestActivityRowId,
  presentationOptions,
  renderMessage,
  rowContainerClassName,
  rowState,
  rows,
  turnSummaryRowsController,
}: NestedTimelineRowsContentProps) {
  return (
    <>
      {rows.map((row) => (
        <TimelineRowEntry
          key={row.id}
          latestActivityRowId={latestActivityRowId}
          presentationOptions={presentationOptions}
          renderMessage={renderMessage}
          row={row}
          rowContainerClassName={rowContainerClassName}
          rowState={rowState}
          turnSummaryRowsController={turnSummaryRowsController}
        />
      ))}
    </>
  );
}

export function NestedTimelineRows({
  latestActivityRowId,
  presentationOptions,
  renderMessage,
  rowContainerClassName,
  rows,
  turnSummaryRowsController,
}: NestedTimelineRowsProps) {
  const rowState = useMemo<NestedTimelineRowState>(
    () => ({
      activityInfoById: buildTimelineRowActivityInfoMap(
        rows,
        latestActivityRowId,
      ),
      autoExpandById: buildNestedTimelineAutoExpandMap(
        rows,
        presentationOptions.expandErrors,
        turnSummaryRowsController,
      ),
    }),
    [
      latestActivityRowId,
      presentationOptions.expandErrors,
      rows,
      turnSummaryRowsController,
    ],
  );

  return (
    <NestedTimelineRowsContent
      latestActivityRowId={latestActivityRowId}
      presentationOptions={presentationOptions}
      renderMessage={renderMessage}
      rowContainerClassName={rowContainerClassName}
      rowState={rowState}
      rows={rows}
      turnSummaryRowsController={turnSummaryRowsController}
    />
  );
}
