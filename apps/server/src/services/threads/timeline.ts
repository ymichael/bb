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
  listRecentStoredEventRows,
  listStoredClientTurnRequestIdsInRange,
  listStoredEventRowsInRange,
  listStoredTurnInputAcceptedRowsByClientRequestIds,
  listStoredTurnStartedRowsByTurnIdsUpToSequence,
} from "@bb/db";
import type { DbConnection, StoredEventRow } from "@bb/db";
import { ApiError } from "../../errors.js";
import { parseStoredEvent } from "./thread-data.js";

interface TimelineTurnSummarySelection {
  sourceSeqEnd: number;
  sourceSeqStart: number;
  turnId: string;
}

interface PartitionAcceptedInputRowsByRequestedTurnArgs {
  acceptedInputRows: readonly StoredEventRow[];
  turnId: string;
}

interface PartitionAcceptedInputRowsByRequestedTurnResult {
  acceptedClientRequestIdsForOtherTurns: ReadonlySet<ClientTurnRequestId>;
  requestedTurnRows: StoredEventRow[];
}

interface ClientRequestAcceptedByOtherTurnArgs {
  acceptedClientRequestIdsForOtherTurns: ReadonlySet<ClientTurnRequestId>;
  row: StoredEventRow;
}

interface FilterExactEventRowsForRequestedTurnArgs {
  acceptedClientRequestIdsForOtherTurns: ReadonlySet<ClientTurnRequestId>;
  exactEventRows: readonly StoredEventRow[];
}

interface FilterExactEventRowsForRequestedTurnResult {
  removedRows: boolean;
  rows: readonly StoredEventRow[];
}

interface ResolveTurnSummaryDetailsSourceRangeArgs {
  exactEventRows: readonly StoredEventRow[];
  fallbackRange: TimelineTurnSummarySelection;
  useExactEventRowBounds: boolean;
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

export const STANDARD_THREAD_TIMELINE_INITIAL_SEGMENT_LIMIT = 20;
export const MANAGER_THREAD_TIMELINE_INITIAL_SEGMENT_LIMIT = 30;
export const THREAD_TIMELINE_OLDER_SEGMENT_LIMIT = 20;
export const THREAD_TIMELINE_SEGMENT_LIMIT_MAX = 100;

export interface LatestThreadTimelinePageRequest {
  kind: "latest";
  segmentLimit: number;
}

export interface OlderThreadTimelinePageRequest {
  beforeCursor: TimelinePaginationCursor;
  kind: "older";
  segmentLimit: number;
}

export type ThreadTimelinePageRequest =
  | LatestThreadTimelinePageRequest
  | OlderThreadTimelinePageRequest;

interface TimelineLogicalSegment {
  cursor: TimelinePaginationCursor;
  rows: TimelineRow[];
}

interface PaginatedTimelineRowsResult {
  hasOlderRows: boolean;
  kind: ThreadTimelinePageKind;
  olderCursor: TimelinePaginationCursor | null;
  returnedSegmentCount: number;
  rows: TimelineRow[];
  segmentLimit: number;
}

export interface ResolveThreadTimelineServiceViewModeArgs {
  managerTimelineView: ManagerTimelineView | undefined;
  thread: Thread;
}

export interface ResolveThreadTimelineDefaultSegmentLimitArgs {
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

export function resolveThreadTimelineDefaultSegmentLimit({
  kind,
  thread,
}: ResolveThreadTimelineDefaultSegmentLimitArgs): number {
  if (kind === "older") {
    return THREAD_TIMELINE_OLDER_SEGMENT_LIMIT;
  }

  return thread.type === "manager"
    ? MANAGER_THREAD_TIMELINE_INITIAL_SEGMENT_LIMIT
    : STANDARD_THREAD_TIMELINE_INITIAL_SEGMENT_LIMIT;
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

function parseAcceptedInputClientRequestId(
  row: StoredEventRow,
): ClientTurnRequestId {
  const event = parseStoredEvent(row);
  switch (event.type) {
    case "turn/input/accepted":
      return event.clientRequestId;
    default:
      throw new Error(`Expected turn/input/accepted row ${row.id}`);
  }
}

function tryReadClientTurnRequestedRequestId(
  row: StoredEventRow,
): ClientTurnRequestId | null {
  const event = parseStoredEvent(row);
  if (event.type !== "client/turn/requested") {
    return null;
  }
  return event.requestId;
}

function partitionAcceptedInputRowsByRequestedTurn(
  args: PartitionAcceptedInputRowsByRequestedTurnArgs,
): PartitionAcceptedInputRowsByRequestedTurnResult {
  const acceptedClientRequestIdsForOtherTurns = new Set<ClientTurnRequestId>();
  const requestedTurnRows: StoredEventRow[] = [];
  for (const row of args.acceptedInputRows) {
    if (row.scopeKind !== "turn" || row.turnId === null) {
      throw new Error(`Expected turn-scoped turn/input/accepted row ${row.id}`);
    }
    if (row.turnId === args.turnId) {
      requestedTurnRows.push(row);
      continue;
    }
    acceptedClientRequestIdsForOtherTurns.add(
      parseAcceptedInputClientRequestId(row),
    );
  }

  return {
    acceptedClientRequestIdsForOtherTurns,
    requestedTurnRows,
  };
}

function isClientRequestAcceptedByOtherTurn(
  args: ClientRequestAcceptedByOtherTurnArgs,
): boolean {
  const requestId = tryReadClientTurnRequestedRequestId(args.row);
  return (
    requestId !== null &&
    args.acceptedClientRequestIdsForOtherTurns.has(requestId)
  );
}

function filterExactEventRowsForRequestedTurn(
  args: FilterExactEventRowsForRequestedTurnArgs,
): FilterExactEventRowsForRequestedTurnResult {
  if (args.acceptedClientRequestIdsForOtherTurns.size === 0) {
    return {
      removedRows: false,
      rows: args.exactEventRows,
    };
  }

  const rows: StoredEventRow[] = [];
  let removedRows = false;
  for (const row of args.exactEventRows) {
    if (
      isClientRequestAcceptedByOtherTurn({
        acceptedClientRequestIdsForOtherTurns:
          args.acceptedClientRequestIdsForOtherTurns,
        row,
      })
    ) {
      removedRows = true;
      continue;
    }
    rows.push(row);
  }

  return {
    removedRows,
    rows,
  };
}

function resolveTurnSummaryDetailsSourceRange(
  args: ResolveTurnSummaryDetailsSourceRangeArgs,
): TimelineTurnSummarySelection {
  const fallbackRange = args.fallbackRange;
  if (!args.useExactEventRowBounds) {
    return fallbackRange;
  }

  const firstRow = args.exactEventRows[0];
  const lastRow = args.exactEventRows.at(-1);
  if (!firstRow || !lastRow) {
    return fallbackRange;
  }

  return {
    sourceSeqEnd: lastRow.sequence,
    sourceSeqStart: firstRow.sequence,
    turnId: fallbackRange.turnId,
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

function isTimelineSegmentAnchorRow(row: TimelineRow): boolean {
  return (
    row.kind === "conversation" &&
    row.role === "user" &&
    row.userRequest.kind === "message"
  );
}

function toTimelinePaginationCursor(
  row: TimelineRow,
): TimelinePaginationCursor {
  return {
    anchorSeq: row.sourceSeqStart,
    anchorId: row.id,
  };
}

function buildTimelineLogicalSegment(
  rows: TimelineRow[],
): TimelineLogicalSegment {
  const anchorRow = rows[0];
  if (!anchorRow) {
    throw new Error("Cannot build a timeline segment without rows");
  }

  return {
    cursor: toTimelinePaginationCursor(anchorRow),
    rows,
  };
}

function buildTimelineLogicalSegments(
  rows: readonly TimelineRow[],
): TimelineLogicalSegment[] {
  const segments: TimelineLogicalSegment[] = [];
  let currentRows: TimelineRow[] = [];

  for (const row of rows) {
    if (isTimelineSegmentAnchorRow(row) && currentRows.length > 0) {
      segments.push(buildTimelineLogicalSegment(currentRows));
      currentRows = [row];
      continue;
    }

    currentRows.push(row);
  }

  if (currentRows.length > 0) {
    segments.push(buildTimelineLogicalSegment(currentRows));
  }

  return segments;
}

function isTimelinePaginationCursorMatch(
  segment: TimelineLogicalSegment,
  cursor: TimelinePaginationCursor,
): boolean {
  return (
    segment.cursor.anchorSeq === cursor.anchorSeq &&
    segment.cursor.anchorId === cursor.anchorId
  );
}

function findTimelineSegmentCursorIndex(
  segments: readonly TimelineLogicalSegment[],
  cursor: TimelinePaginationCursor,
): number {
  return segments.findIndex((segment) =>
    isTimelinePaginationCursorMatch(segment, cursor),
  );
}

function requireTimelineSegmentCursorIndex(
  segments: readonly TimelineLogicalSegment[],
  cursor: TimelinePaginationCursor,
): number {
  const index = findTimelineSegmentCursorIndex(segments, cursor);
  if (index !== -1) {
    return index;
  }

  throw new ApiError(
    400,
    "invalid_request",
    "Timeline pagination cursor is no longer available",
  );
}

function flattenTimelineSegments(
  segments: readonly TimelineLogicalSegment[],
): TimelineRow[] {
  const rows: TimelineRow[] = [];
  for (const segment of segments) {
    rows.push(...segment.rows);
  }
  return rows;
}

function paginateTimelineRows(
  rows: readonly TimelineRow[],
  page: ThreadTimelinePageRequest,
): PaginatedTimelineRowsResult {
  const segments = buildTimelineLogicalSegments(rows);
  const candidateSegments =
    page.kind === "latest"
      ? segments
      : segments.slice(
          0,
          requireTimelineSegmentCursorIndex(segments, page.beforeCursor),
        );
  const selectedSegments = candidateSegments.slice(-page.segmentLimit);
  const hasOlderRows = candidateSegments.length > selectedSegments.length;
  const oldestSelectedSegment = selectedSegments[0];

  return {
    hasOlderRows,
    kind: page.kind,
    olderCursor:
      hasOlderRows && oldestSelectedSegment
        ? oldestSelectedSegment.cursor
        : null,
    returnedSegmentCount: selectedSegments.length,
    rows: flattenTimelineSegments(selectedSegments),
    segmentLimit: page.segmentLimit,
  };
}

export function buildThreadTimeline(
  db: DbConnection,
  thread: Thread,
  options: BuildThreadTimelineOptions,
): ThreadTimelineResponse {
  const includeNestedRows = options.includeNestedRows ?? false;
  const includeProviderUnhandledOperations = options.isDevelopment;
  const rawEventRows = listRecentStoredEventRows(db, {
    threadId: thread.id,
    excludedTypes: THREAD_TIMELINE_EXCLUDED_EVENT_TYPES,
  });
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
  const paginatedTimeline = paginateTimelineRows(timeline.rows, options.page);

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
      segmentLimit: paginatedTimeline.segmentLimit,
      returnedSegmentCount: paginatedTimeline.returnedSegmentCount,
      hasOlderRows: paginatedTimeline.hasOlderRows,
      olderCursor: paginatedTimeline.olderCursor,
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
  const acceptedInputRowsByTurn = partitionAcceptedInputRowsByRequestedTurn({
    acceptedInputRows,
    turnId: options.turnId,
  });
  const exactEventRowsForRequestedTurn = filterExactEventRowsForRequestedTurn({
    acceptedClientRequestIdsForOtherTurns:
      acceptedInputRowsByTurn.acceptedClientRequestIdsForOtherTurns,
    exactEventRows,
  });
  const eventRows = [
    ...exactEventRowsForRequestedTurn.rows,
    ...acceptedInputRowsByTurn.requestedTurnRows,
  ];
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
  // sourceSeqEnd, so the lifecycle lookup uses the widened context cutoff.
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
  const sourceRange = resolveTurnSummaryDetailsSourceRange({
    exactEventRows: exactEventRowsForRequestedTurn.rows,
    fallbackRange: {
      sourceSeqEnd: options.sourceSeqEnd,
      sourceSeqStart: options.sourceSeqStart,
      turnId: options.turnId,
    },
    useExactEventRowBounds: exactEventRowsForRequestedTurn.removedRows,
  });
  const children = buildThreadTimelineTurnDetailsFromEvents({
    events: [...turnStartedRows, ...eventRows].map((row) =>
      toThreadEventWithMeta(row),
    ),
    options: {
      includeOptionalOperations: false,
      includeProviderUnhandledOperations,
      systemClientRequestVisibility,
      sourceSeqEnd: sourceRange.sourceSeqEnd,
      sourceSeqStart: sourceRange.sourceSeqStart,
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
