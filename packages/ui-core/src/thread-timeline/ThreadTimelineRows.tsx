import { useMemo } from "react";
import type {
  TimelineRow,
  TimelineTurnSummaryRow,
  ViewMessage,
} from "@bb/domain";
import { ConversationEntry } from "./ConversationEntry.js";
import { NestedTimelineRows } from "./NestedTimelineRows.js";
import type {
  NestedTimelineMessageRenderOptions,
  NestedTimelineRowPresentationOptions,
  NestedTimelineTurnSummaryRowsController,
} from "./NestedTimelineRows.js";
import type {
  ThreadTimelineLocalFileLinkHandler,
  ThreadTimelineTheme,
  UserAttachmentImageSrcResolver,
} from "./types.js";

export interface ThreadTimelineRowsProps {
  erroredTurnSummaryIds: ReadonlySet<string>;
  latestActivityRowId: string | null;
  loadingTurnSummaryIds: ReadonlySet<string>;
  onLoadTurnSummaryRows: (entry: TimelineTurnSummaryRow) => void;
  onOpenLocalFileLink?: ThreadTimelineLocalFileLinkHandler;
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
  erroredTurnSummaryIds: ReadonlySet<string>,
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
    isError(row) {
      return erroredTurnSummaryIds.has(row.id);
    },
    loadRows(row) {
      onLoadTurnSummaryRows(row);
    },
  };
}

export function ThreadTimelineRows({
  erroredTurnSummaryIds,
  latestActivityRowId,
  loadingTurnSummaryIds,
  onLoadTurnSummaryRows,
  onOpenLocalFileLink,
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
        erroredTurnSummaryIds,
        onLoadTurnSummaryRows,
        turnSummaryRowsById,
      ),
    [
      erroredTurnSummaryIds,
      loadingTurnSummaryIds,
      onLoadTurnSummaryRows,
      turnSummaryRowsById,
    ],
  );

  const renderMessage = (
    message: ViewMessage,
    options?: NestedTimelineMessageRenderOptions,
  ) => (
    <ConversationEntry
      message={message}
      projectId={projectId}
      initialExpanded={options?.initialExpanded}
      onOpenLocalFileLink={onOpenLocalFileLink}
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
      rowContainerClassName="pt-1"
      rows={threadDetailRows}
      turnSummaryRowsController={turnSummaryRowsController}
    />
  );
}
