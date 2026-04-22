import { useMemo } from "react";
import type { TimelineRow, TimelineTurnSummaryRow, ViewMessage } from "@bb/domain";
import { ConversationEntry } from "./ConversationEntry.js";
import { NestedTimelineRows } from "./NestedTimelineRows.js";
import type {
  NestedTimelineMessageRenderOptions,
  NestedTimelineRowPresentationOptions,
  NestedTimelineTurnSummaryRowsController,
} from "./NestedTimelineRows.js";
import type {
  ThreadTimelineTheme,
  UserAttachmentImageSrcResolver,
} from "./types.js";

export interface ThreadTimelineRowsProps {
  latestActivityRowId: string | null;
  loadingTurnSummaryIds: ReadonlySet<string>;
  onLoadTurnSummaryRows: (entry: TimelineTurnSummaryRow) => void;
  projectId?: string;
  resolveUserAttachmentImageSrc?: UserAttachmentImageSrcResolver;
  themeType?: ThreadTimelineTheme;
  threadDetailRows: TimelineRow[];
  threadStatus: string;
  turnSummaryRowsById: Record<string, TimelineRow[]>;
}

function getPresentationOptions(
  threadStatus: string,
): NestedTimelineRowPresentationOptions {
  return {
    expandErrors: threadStatus === "error",
    groupedRowsUseOngoingLabels: false,
    preferOngoingLabels:
      threadStatus !== "completed" && threadStatus !== "error",
  };
}

function createTurnSummaryRowsController(
  loadingTurnSummaryIds: ReadonlySet<string>,
  onLoadTurnSummaryRows: (entry: TimelineTurnSummaryRow) => void,
  turnSummaryRowsById: Record<string, TimelineRow[]>,
): NestedTimelineTurnSummaryRowsController {
  return {
    getRows(row) {
      return turnSummaryRowsById[row.id] ?? row.rows;
    },
    isLoading(row) {
      return loadingTurnSummaryIds.has(row.id);
    },
    loadRows(row) {
      onLoadTurnSummaryRows(row);
    },
  };
}

export function ThreadTimelineRows({
  latestActivityRowId,
  loadingTurnSummaryIds,
  onLoadTurnSummaryRows,
  projectId,
  resolveUserAttachmentImageSrc,
  themeType,
  threadDetailRows,
  threadStatus,
  turnSummaryRowsById,
}: ThreadTimelineRowsProps) {
  const turnSummaryRowsController = useMemo(
    () =>
      createTurnSummaryRowsController(
        loadingTurnSummaryIds,
        onLoadTurnSummaryRows,
        turnSummaryRowsById,
      ),
    [loadingTurnSummaryIds, onLoadTurnSummaryRows, turnSummaryRowsById],
  );

  const renderMessage = (
    message: ViewMessage,
    options?: NestedTimelineMessageRenderOptions,
  ) => (
    <ConversationEntry
      message={message}
      projectId={projectId}
      initialExpanded={options?.initialExpanded}
      preferOngoingLabels={options?.preferOngoingLabels}
      resolveUserAttachmentImageSrc={resolveUserAttachmentImageSrc}
      themeType={themeType}
    />
  );

  return (
    <NestedTimelineRows
      latestActivityRowId={latestActivityRowId}
      presentationOptions={getPresentationOptions(threadStatus)}
      renderMessage={renderMessage}
      rowContainerClassName="pt-2"
      rows={threadDetailRows}
      turnSummaryRowsController={turnSummaryRowsController}
    />
  );
}
