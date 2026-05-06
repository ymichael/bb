import {
  buildThreadTimelineFromEvents,
  THREAD_TIMELINE_EXCLUDED_EVENT_TYPES,
  buildThreadTimelineTurnDetailsFromEvents,
  compactThreadTimelineSummaryEvents,
  type SystemClientRequestVisibility,
  type ThreadEventWithMeta,
} from "@bb/thread-view";
import type { ClientTurnRequestId, Thread } from "@bb/domain";
import type {
  ManagerTimelineView,
  TimelinePaginationCursor,
  ThreadTimelineResponse,
  TimelineRow,
  TimelineTurnSummaryDetailsResponse,
} from "@bb/server-contract";
import {
  listContextWindowUsageRows,
  listStoredClientTurnRequestedRowsByRequestIds,
  listRecentStoredEventRows,
  listStoredClientTurnRequestIdsInRange,
  listStoredEventRowsInRange,
  listStoredEventRowsInSequenceWindow,
  listStoredTurnInputAcceptedRowsByClientRequestIds,
  listStoredTurnStartedRowsByTurnIdsUpToSequence,
  listTimelineTurnPageAnchorRows,
} from "@bb/db";
import type {
  DbConnection,
  StoredEventRow,
  TimelineTurnPageAnchorRow,
} from "@bb/db";
import { ApiError } from "../../errors.js";
import { parseStoredEvent } from "./thread-data.js";

interface TimelineTurnSummarySelection {
  sourceSeqEnd: number;
  sourceSeqStart: number;
  turnId: string;
}

interface BuildThreadTimelineOptions {
  isDevelopment: boolean;
  includeNestedRows?: boolean;
  page: ThreadTimelinePageRequest;
  timelineViewMode: ThreadTimelineServiceViewMode;
}

interface BuildTimelineTurnSummaryDetailsOptions extends TimelineTurnSummarySelection {
  isDevelopment: boolean;
  timelineViewMode: ThreadTimelineServiceViewMode;
}

export type ThreadTimelineServiceViewMode = "manager-conversation" | "standard";

export type ThreadTimelinePageKind = "latest" | "older";

export const STANDARD_THREAD_TIMELINE_INITIAL_TURN_LIMIT = 5;
export const MANAGER_THREAD_TIMELINE_INITIAL_TURN_LIMIT = 20;
export const THREAD_TIMELINE_OLDER_TURN_LIMIT = 20;
export const THREAD_TIMELINE_TURN_LIMIT_MAX = 100;

export interface LatestThreadTimelinePageRequest {
  kind: "latest";
  turnLimit: number;
}

export interface OlderThreadTimelinePageRequest {
  beforeCursor: TimelinePaginationCursor;
  kind: "older";
  turnLimit: number;
}

export type ThreadTimelinePageRequest =
  | LatestThreadTimelinePageRequest
  | OlderThreadTimelinePageRequest;

interface SplitTimelineRowsByActiveTailResult {
  activeTailRows: TimelineRow[];
  historicalRows: TimelineRow[];
}

interface PaginateHistoricalTimelineRowsResult {
  hasOlderRows: boolean;
  olderCursor: TimelinePaginationCursor | null;
  rows: TimelineRow[];
}

interface PaginatedTimelineRowsResult {
  hasOlderRows: boolean;
  kind: ThreadTimelinePageRequest["kind"];
  olderCursor: TimelinePaginationCursor | null;
  returnedTopLevelRowCount: number;
  rows: TimelineRow[];
  turnLimit: number;
}

interface TimelineEventRowsResult {
  hasOlderRows: boolean;
  olderCursor: TimelinePaginationCursor | null;
  requiresProjectedRowPagination: boolean;
  rows: StoredEventRow[];
}

interface ListTimelineEventRowsArgs {
  db: DbConnection;
  page: ThreadTimelinePageRequest;
  threadId: string;
}

interface BuildTurnPageEventRowsArgs extends ListTimelineEventRowsArgs {
  anchors: readonly TimelineTurnPageAnchorRow[];
}

interface BuildProjectedRowPaginationEventRowsArgs extends ListTimelineEventRowsArgs {
  hasKnownTurnAnchors: boolean;
}

interface TimelineEventRowsPageMetadata {
  hasOlderRows: boolean;
  olderCursor: TimelinePaginationCursor | null;
}

interface FilterDirectClientTurnRequestedRowsArgs {
  acceptedClientRequestIdsInWindow: readonly ClientTurnRequestId[];
  db: DbConnection;
  rows: readonly StoredEventRow[];
  threadId: string;
}

export interface ResolveThreadTimelineServiceViewModeArgs {
  managerTimelineView: ManagerTimelineView | undefined;
  thread: Thread;
}

export interface ResolveThreadTimelineDefaultTurnLimitArgs {
  kind: ThreadTimelinePageKind;
  thread: Thread;
}

export interface ResolveSystemClientRequestVisibilityArgs {
  thread: Thread;
  timelineViewMode: ThreadTimelineServiceViewMode;
}

export function resolveThreadTimelineServiceViewMode({
  managerTimelineView,
  thread,
}: ResolveThreadTimelineServiceViewModeArgs): ThreadTimelineServiceViewMode {
  if (thread.type === "manager" && managerTimelineView !== "standard") {
    return "manager-conversation";
  }
  return "standard";
}

export function resolveThreadTimelineDefaultTurnLimit({
  kind,
  thread,
}: ResolveThreadTimelineDefaultTurnLimitArgs): number {
  if (kind === "older") {
    return THREAD_TIMELINE_OLDER_TURN_LIMIT;
  }

  return thread.type === "manager"
    ? MANAGER_THREAD_TIMELINE_INITIAL_TURN_LIMIT
    : STANDARD_THREAD_TIMELINE_INITIAL_TURN_LIMIT;
}

export function resolveSystemClientRequestVisibility({
  thread,
  timelineViewMode,
}: ResolveSystemClientRequestVisibilityArgs): SystemClientRequestVisibility {
  return thread.type === "manager" && timelineViewMode === "standard"
    ? "visible"
    : "hidden";
}

export function toThreadEventWithMeta(
  row: StoredEventRow,
): ThreadEventWithMeta {
  return {
    event: parseStoredEvent(row),
    meta: {
      id: row.id,
      seq: row.sequence,
      createdAt: row.createdAt,
    },
  };
}

export function compactSummaryStoredEventRows(
  rows: readonly StoredEventRow[],
): readonly StoredEventRow[] {
  const events = rows.map((row) => toThreadEventWithMeta(row));
  const compactedEvents = compactThreadTimelineSummaryEvents(events);
  if (compactedEvents === events) {
    return rows;
  }

  const retainedEventIds = new Set(
    compactedEvents.map((eventWithMeta) => eventWithMeta.meta.id),
  );
  return rows.filter((row) => retainedEventIds.has(row.id));
}

function isActiveTopLevelTimelineRow(row: TimelineRow): boolean {
  switch (row.kind) {
    case "conversation":
      return (
        row.role === "user" &&
        row.userRequest.kind === "steer" &&
        row.userRequest.status === "pending"
      );
    case "system":
      return row.status === "pending";
    case "turn":
    case "work":
      return row.status === "pending";
  }
}

function splitTimelineRowsByActiveTail(
  rows: readonly TimelineRow[],
): SplitTimelineRowsByActiveTailResult {
  const activeTailStartIndex = rows.findIndex(isActiveTopLevelTimelineRow);
  if (activeTailStartIndex === -1) {
    return {
      activeTailRows: [],
      historicalRows: [...rows],
    };
  }

  return {
    activeTailRows: rows.slice(activeTailStartIndex),
    historicalRows: rows.slice(0, activeTailStartIndex),
  };
}

function toTimelinePaginationCursor(
  row: TimelineRow,
): TimelinePaginationCursor {
  return {
    seq: row.sourceSeqStart,
    id: row.id,
  };
}

function isTimelineRowBeforeCursor(
  row: TimelineRow,
  cursor: TimelinePaginationCursor,
): boolean {
  if (row.sourceSeqStart !== cursor.seq) {
    return row.sourceSeqStart < cursor.seq;
  }
  return row.id < cursor.id;
}

function paginateHistoricalTimelineRows(
  rows: readonly TimelineRow[],
  page: ThreadTimelinePageRequest,
): PaginateHistoricalTimelineRowsResult {
  const candidateRows =
    page.kind === "latest"
      ? rows
      : rows.filter((row) => isTimelineRowBeforeCursor(row, page.beforeCursor));
  // No-anchor fallback has no turn boundaries, so the resolved turn limit is
  // reused as a conservative cap on projected top-level rows.
  const topLevelRowLimit = page.turnLimit;
  const selectedRows = candidateRows.slice(-topLevelRowLimit);
  const hasOlderRows = candidateRows.length > selectedRows.length;
  const oldestSelectedRow = selectedRows[0];

  return {
    hasOlderRows,
    olderCursor:
      hasOlderRows && oldestSelectedRow
        ? toTimelinePaginationCursor(oldestSelectedRow)
        : null,
    rows: selectedRows,
  };
}

function paginateTimelineRows(
  rows: readonly TimelineRow[],
  page: ThreadTimelinePageRequest,
): PaginatedTimelineRowsResult {
  const { activeTailRows, historicalRows } =
    splitTimelineRowsByActiveTail(rows);
  const pageRows = paginateHistoricalTimelineRows(historicalRows, page);
  const returnedRows =
    page.kind === "latest"
      ? [...pageRows.rows, ...activeTailRows]
      : pageRows.rows;

  return {
    rows: returnedRows,
    kind: page.kind,
    turnLimit: page.turnLimit,
    returnedTopLevelRowCount: pageRows.rows.length,
    hasOlderRows: pageRows.hasOlderRows,
    olderCursor: pageRows.olderCursor,
  };
}

function toTurnAnchorCursor(
  anchor: TimelineTurnPageAnchorRow,
): TimelinePaginationCursor {
  return {
    seq: anchor.sequence,
    id: anchor.id,
  };
}

function compareStoredEventRowsBySequence(
  left: StoredEventRow,
  right: StoredEventRow,
): number {
  if (left.sequence !== right.sequence) {
    return left.sequence - right.sequence;
  }
  if (left.id === right.id) {
    return 0;
  }
  return left.id < right.id ? -1 : 1;
}

function mergeStoredEventRows(
  rows: readonly StoredEventRow[],
): StoredEventRow[] {
  const rowsById = new Map<string, StoredEventRow>();
  for (const row of rows) {
    rowsById.set(row.id, row);
  }
  return [...rowsById.values()].sort(compareStoredEventRowsBySequence);
}

function collectAcceptedClientRequestIds(
  rows: readonly StoredEventRow[],
): ClientTurnRequestId[] {
  const requestIds: ClientTurnRequestId[] = [];
  for (const row of rows) {
    const event = parseStoredEvent(row);
    if (event.type === "turn/input/accepted") {
      requestIds.push(event.clientRequestId);
    }
  }
  return requestIds;
}

function collectRequestedClientRequestIds(
  rows: readonly StoredEventRow[],
): ClientTurnRequestId[] {
  const requestIds: ClientTurnRequestId[] = [];
  for (const row of rows) {
    const event = parseStoredEvent(row);
    if (event.type === "client/turn/requested") {
      requestIds.push(event.requestId);
    }
  }
  return requestIds;
}

function filterDirectClientTurnRequestedRows({
  acceptedClientRequestIdsInWindow,
  db,
  rows,
  threadId,
}: FilterDirectClientTurnRequestedRowsArgs): readonly StoredEventRow[] {
  const acceptedInWindow = new Set(acceptedClientRequestIdsInWindow);
  const requestIdsToCheck = collectRequestedClientRequestIds(rows).filter(
    (requestId) => !acceptedInWindow.has(requestId),
  );
  if (requestIdsToCheck.length === 0) {
    return rows;
  }

  const acceptedRows = listStoredTurnInputAcceptedRowsByClientRequestIds(db, {
    threadId,
    clientRequestIds: requestIdsToCheck,
    afterSequence: 0,
  });
  const acceptedOutsideWindow = new Set(
    collectAcceptedClientRequestIds(acceptedRows),
  );
  if (acceptedOutsideWindow.size === 0) {
    return rows;
  }

  return rows.filter((row) => {
    const event = parseStoredEvent(row);
    return (
      event.type !== "client/turn/requested" ||
      !acceptedOutsideWindow.has(event.requestId)
    );
  });
}

function buildTurnPageEventRows({
  anchors,
  db,
  page,
  threadId,
}: BuildTurnPageEventRowsArgs): TimelineEventRowsResult {
  const selectedAnchors = anchors.slice(0, page.turnLimit).reverse();
  const hasOlderRows = anchors.length > selectedAnchors.length;
  const oldestSelectedAnchor = selectedAnchors[0];
  if (!oldestSelectedAnchor) {
    return {
      hasOlderRows: false,
      olderCursor: null,
      requiresProjectedRowPagination: false,
      rows: [],
    };
  }

  const seqStart = hasOlderRows ? oldestSelectedAnchor.sequence : 0;
  const eventRows = listStoredEventRowsInSequenceWindow(db, {
    threadId,
    seqStart,
    seqEndExclusive: page.kind === "older" ? page.beforeCursor.seq : undefined,
    excludedTypes: THREAD_TIMELINE_EXCLUDED_EVENT_TYPES,
  });
  const acceptedClientRequestIds = collectAcceptedClientRequestIds(eventRows);
  const directEventRows = filterDirectClientTurnRequestedRows({
    acceptedClientRequestIdsInWindow: acceptedClientRequestIds,
    db,
    rows: eventRows,
    threadId,
  });
  const clientRequestRows = listStoredClientTurnRequestedRowsByRequestIds(db, {
    threadId,
    requestIds: acceptedClientRequestIds,
  });

  return {
    hasOlderRows,
    olderCursor: hasOlderRows ? toTurnAnchorCursor(oldestSelectedAnchor) : null,
    requiresProjectedRowPagination: false,
    rows: mergeStoredEventRows([...clientRequestRows, ...directEventRows]),
  };
}

function buildProjectedRowPaginationEventRows({
  db,
  hasKnownTurnAnchors,
  page,
  threadId,
}: BuildProjectedRowPaginationEventRowsArgs): TimelineEventRowsResult {
  const seqEndExclusive =
    page.kind === "older" && hasKnownTurnAnchors
      ? page.beforeCursor.seq
      : undefined;
  const rows =
    seqEndExclusive === undefined
      ? listRecentStoredEventRows(db, {
          threadId,
          excludedTypes: THREAD_TIMELINE_EXCLUDED_EVENT_TYPES,
        })
      : listStoredEventRowsInSequenceWindow(db, {
          threadId,
          seqStart: 0,
          seqEndExclusive,
          excludedTypes: THREAD_TIMELINE_EXCLUDED_EVENT_TYPES,
        });

  return {
    hasOlderRows: false,
    olderCursor: null,
    requiresProjectedRowPagination: true,
    rows,
  };
}

function listTimelineEventRows({
  db,
  page,
  threadId,
}: ListTimelineEventRowsArgs): TimelineEventRowsResult {
  const anchors = listTimelineTurnPageAnchorRows(db, {
    threadId,
    before:
      page.kind === "older"
        ? {
            sequence: page.beforeCursor.seq,
            id: page.beforeCursor.id,
          }
        : undefined,
    limit: page.turnLimit + 1,
  });

  if (anchors.length > 0) {
    return buildTurnPageEventRows({
      anchors,
      db,
      page,
      threadId,
    });
  }

  return buildProjectedRowPaginationEventRows({
    db,
    hasKnownTurnAnchors: page.kind === "older",
    page,
    threadId,
  });
}

function resolveTimelinePageMetadata(
  eventRowsPage: TimelineEventRowsResult,
  paginatedTimeline: PaginatedTimelineRowsResult,
): TimelineEventRowsPageMetadata {
  if (!eventRowsPage.requiresProjectedRowPagination) {
    return {
      hasOlderRows: eventRowsPage.hasOlderRows,
      olderCursor: eventRowsPage.olderCursor,
    };
  }

  return {
    hasOlderRows: paginatedTimeline.hasOlderRows,
    olderCursor: paginatedTimeline.olderCursor,
  };
}

export function buildThreadTimeline(
  db: DbConnection,
  thread: Thread,
  options: BuildThreadTimelineOptions,
): ThreadTimelineResponse {
  const includeNestedRows = options.includeNestedRows ?? false;
  const includeProviderUnhandledOperations = options.isDevelopment;
  const eventRowsPage = listTimelineEventRows({
    db,
    page: options.page,
    threadId: thread.id,
  });
  const rawEventRows = eventRowsPage.rows;
  const decodedRawEvents = rawEventRows.map((row) =>
    toThreadEventWithMeta(row),
  );
  const decodedEvents = compactThreadTimelineSummaryEvents(decodedRawEvents);
  const contextWindowUsageRows = listContextWindowUsageRows(db, {
    threadId: thread.id,
  });
  const viewMode = options.timelineViewMode;
  const systemClientRequestVisibility = resolveSystemClientRequestVisibility({
    thread,
    timelineViewMode: viewMode,
  });
  const commonProjectionOptions = {
    includeDebugRawEvents: false,
    includeOptionalOperations: false,
    includeProviderUnhandledOperations,
    systemClientRequestVisibility,
    threadStatus: thread.status,
  };
  const timeline = buildThreadTimelineFromEvents({
    contextWindowEvents: contextWindowUsageRows.map((row) =>
      toThreadEventWithMeta(row),
    ),
    events: decodedEvents,
    options:
      viewMode === "manager-conversation"
        ? {
            ...commonProjectionOptions,
            viewMode,
          }
        : {
            ...commonProjectionOptions,
            includeNestedRows,
            turnMessageDetail: includeNestedRows ? "full" : "summary",
            viewMode,
          },
  });
  const paginatedTimeline = eventRowsPage.requiresProjectedRowPagination
    ? paginateTimelineRows(timeline.rows, options.page)
    : {
        rows: timeline.rows,
        kind: options.page.kind,
        turnLimit: options.page.turnLimit,
        returnedTopLevelRowCount: timeline.rows.length,
        hasOlderRows: eventRowsPage.hasOlderRows,
        olderCursor: eventRowsPage.olderCursor,
      };
  const timelinePageMetadata = resolveTimelinePageMetadata(
    eventRowsPage,
    paginatedTimeline,
  );

  return {
    rows: paginatedTimeline.rows,
    activeThinking:
      options.page.kind === "latest" ? timeline.activeThinking : null,
    contextWindowUsage:
      options.page.kind === "latest"
        ? (timeline.contextWindowUsage ?? undefined)
        : undefined,
    timelinePage: {
      kind: paginatedTimeline.kind,
      turnLimit: paginatedTimeline.turnLimit,
      returnedTopLevelRowCount: paginatedTimeline.returnedTopLevelRowCount,
      hasOlderRows: timelinePageMetadata.hasOlderRows,
      olderCursor: timelinePageMetadata.olderCursor,
    },
  };
}

export function buildTimelineTurnSummaryDetails(
  db: DbConnection,
  thread: Thread,
  options: BuildTimelineTurnSummaryDetailsOptions,
): TimelineTurnSummaryDetailsResponse {
  if (options.sourceSeqStart > options.sourceSeqEnd) {
    throw new ApiError(
      400,
      "invalid_request",
      "sourceSeqStart must be less than or equal to sourceSeqEnd",
    );
  }

  const includeProviderUnhandledOperations = options.isDevelopment;
  const exactEventRows = listStoredEventRowsInRange(db, {
    threadId: thread.id,
    seqStart: options.sourceSeqStart,
    seqEnd: options.sourceSeqEnd,
  });
  const clientRequestIds = listStoredClientTurnRequestIdsInRange(db, {
    threadId: thread.id,
    seqStart: options.sourceSeqStart,
    seqEnd: options.sourceSeqEnd,
  });
  const acceptedInputRows = listStoredTurnInputAcceptedRowsByClientRequestIds(
    db,
    {
      threadId: thread.id,
      afterSequence: options.sourceSeqEnd,
      clientRequestIds,
    },
  );
  const eventRows = [...exactEventRows, ...acceptedInputRows];
  const mismatchedTurnRow = eventRows.find(
    (row) => row.scopeKind === "turn" && row.turnId !== options.turnId,
  );
  if (mismatchedTurnRow) {
    throw new ApiError(
      400,
      "invalid_request",
      `Timeline turn summary details range ${options.sourceSeqStart}-${options.sourceSeqEnd} includes turn ${mismatchedTurnRow.turnId ?? "unknown"} instead of ${options.turnId}`,
    );
  }

  const hasTurnScopedRowsForRequestedTurn = eventRows.some(
    (row) => row.scopeKind === "turn" && row.turnId === options.turnId,
  );
  if (!hasTurnScopedRowsForRequestedTurn) {
    throw new ApiError(
      400,
      "invalid_request",
      `Timeline turn summary details range ${options.sourceSeqStart}-${options.sourceSeqEnd} does not include turn ${options.turnId}`,
    );
  }

  const hasCurrentStartedRow = eventRows.some(
    (row) => row.type === "turn/started" && row.turnId === options.turnId,
  );
  const contextSequenceCutoff = eventRows.reduce(
    (maxSequence, row) => Math.max(maxSequence, row.sequence),
    options.sourceSeqEnd,
  );
  // Summary rows can cover a segment inside a turn. Once the selected rows are
  // validated against the requested turn, that turn's start must be at or
  // before the latest selected turn row. Accepted input rows may sit after
  // sourceSeqEnd, so the lifecycle lookup uses the widened context cutoff while
  // sourceSeqStart/sourceSeqEnd still constrain the returned detail rows.
  const turnStartedRows = hasCurrentStartedRow
    ? []
    : listStoredTurnStartedRowsByTurnIdsUpToSequence(db, {
        threadId: thread.id,
        sequenceCutoff: contextSequenceCutoff,
        turnIds: [options.turnId],
      });
  if (!hasCurrentStartedRow && turnStartedRows.length === 0) {
    throw new ApiError(
      400,
      "invalid_request",
      `Timeline turn summary details range ${options.sourceSeqStart}-${options.sourceSeqEnd} cannot resolve turn/started for ${options.turnId}`,
    );
  }
  const viewMode = options.timelineViewMode;
  const systemClientRequestVisibility = resolveSystemClientRequestVisibility({
    thread,
    timelineViewMode: viewMode,
  });
  const children = buildThreadTimelineTurnDetailsFromEvents({
    events: [...turnStartedRows, ...eventRows].map((row) =>
      toThreadEventWithMeta(row),
    ),
    options: {
      includeOptionalOperations: false,
      includeProviderUnhandledOperations,
      systemClientRequestVisibility,
      sourceSeqEnd: options.sourceSeqEnd,
      sourceSeqStart: options.sourceSeqStart,
      threadStatus: thread.status,
      viewMode,
    },
  });

  if (children.kind !== "missing-match") {
    return {
      rows: children.rows,
    };
  }

  throw new Error(
    `Timeline turn summary details could not match range ${options.sourceSeqStart}-${options.sourceSeqEnd}`,
  );
}
