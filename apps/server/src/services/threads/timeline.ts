import {
  buildThreadTimelineFromEvents,
  MANAGER_CONVERSATION_TIMELINE_EVENT_SELECTION,
  THREAD_TIMELINE_EXCLUDED_EVENT_TYPES,
  buildThreadTimelineTurnDetailsFromEvents,
  compactThreadTimelineSummaryEvents,
  type SystemClientRequestVisibility,
  type ThreadEventWithMeta,
} from "@bb/thread-view";
import { performance } from "node:perf_hooks";
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
  listFilteredStoredEventRows,
  listRecentStoredEventRows,
  listStandardTimelineSegmentAnchorRows,
  listStoredClientTurnRequestIdsInRange,
  listStoredEventRowsInRange,
  listStoredTimelineWindowEventRows,
  listStoredTurnInputAcceptedRowsByClientRequestIds,
  listStoredTurnStartedRowsByTurnIdsUpToSequence,
} from "@bb/db";
import type {
  DbConnection,
  StandardTimelineSegmentAnchorRow,
  StoredEventRow,
} from "@bb/db";
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

export type ThreadTimelineBuildProfileStage =
  | "event-query"
  | "event-json-decode"
  | "summary-compaction"
  | "context-window-query"
  | "context-window-json-decode"
  | "thread-view-projection"
  | "pagination-segmentation"
  | "response-serialization";

export type ThreadTimelineEventSelectionStrategy =
  | "full"
  | "manager-conversation-filtered"
  | "standard-window";

export interface ThreadTimelineBuildProfileStageTiming {
  durationMs: number;
  stage: ThreadTimelineBuildProfileStage;
}

export interface ThreadTimelineBuildProfile {
  compactedEventCount: number;
  contextWindowEventDataBytes: number;
  contextWindowEventRowCount: number;
  decodedEventCount: number;
  eventDataBytes: number;
  eventRowCount: number;
  pageKind: ThreadTimelinePageKind;
  projectedRowCount: number;
  responseJsonBytes: number;
  responseRowCount: number;
  returnedSegmentCount: number;
  segmentLimit: number;
  selectionStrategy: ThreadTimelineEventSelectionStrategy;
  stageTimings: ThreadTimelineBuildProfileStageTiming[];
  timelineViewMode: ThreadTimelineServiceViewMode;
}

export interface ProfileThreadTimelineResult {
  profile: ThreadTimelineBuildProfile;
  response: ThreadTimelineResponse;
}

interface BuildThreadTimelineInternalResult {
  profile: ThreadTimelineBuildProfile | null;
  response: ThreadTimelineResponse;
}

interface ThreadTimelineBuildProfileDraft {
  compactedEventCount: number;
  contextWindowEventDataBytes: number;
  contextWindowEventRowCount: number;
  decodedEventCount: number;
  eventDataBytes: number;
  eventRowCount: number;
  projectedRowCount: number;
  responseJsonBytes: number;
  responseRowCount: number;
  returnedSegmentCount: number;
  selectionStrategy: ThreadTimelineEventSelectionStrategy;
  stageTimings: ThreadTimelineBuildProfileStageTiming[];
}

interface BuildThreadTimelineInternalOptions extends BuildThreadTimelineOptions {
  includeProfile: boolean;
}

interface TimelineEventRowSelection {
  paginationPage: ThreadTimelinePageRequest;
  responsePageKind: ThreadTimelinePageKind;
  rows: StoredEventRow[];
  strategy: ThreadTimelineEventSelectionStrategy;
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

function selectFullTimelineEventRows(
  db: DbConnection,
  thread: Thread,
  page: ThreadTimelinePageRequest,
): TimelineEventRowSelection {
  return {
    paginationPage: page,
    responsePageKind: page.kind,
    rows: listRecentStoredEventRows(db, {
      threadId: thread.id,
      excludedTypes: THREAD_TIMELINE_EXCLUDED_EVENT_TYPES,
    }),
    strategy: "full",
  };
}

function isStandardTimelineAnchorCursorMatch(
  anchor: StandardTimelineSegmentAnchorRow,
  cursor: TimelinePaginationCursor,
): boolean {
  return (
    anchor.sequence === cursor.anchorSeq && anchor.rowId === cursor.anchorId
  );
}

function requireStandardTimelineAnchorCursorIndex(
  anchors: readonly StandardTimelineSegmentAnchorRow[],
  cursor: TimelinePaginationCursor,
): number {
  const index = anchors.findIndex((anchor) =>
    isStandardTimelineAnchorCursorMatch(anchor, cursor),
  );
  if (index !== -1) {
    return index;
  }

  throw new ApiError(
    400,
    "invalid_request",
    "Timeline pagination cursor is no longer available",
  );
}

function selectStandardTimelineEventRows(
  db: DbConnection,
  thread: Thread,
  page: ThreadTimelinePageRequest,
  systemClientRequestVisibility: SystemClientRequestVisibility,
): TimelineEventRowSelection {
  const anchors = listStandardTimelineSegmentAnchorRows(db, {
    includeSystemClientRequests: systemClientRequestVisibility === "visible",
    threadId: thread.id,
  });
  if (anchors.length === 0) {
    return selectFullTimelineEventRows(db, thread, page);
  }

  const candidateAnchorEndExclusive =
    page.kind === "older"
      ? requireStandardTimelineAnchorCursorIndex(anchors, page.beforeCursor)
      : anchors.length;
  const selectedAnchorStartIndex = Math.max(
    0,
    candidateAnchorEndExclusive - page.segmentLimit,
  );
  const windowAnchorIndex =
    selectedAnchorStartIndex > 0 ? selectedAnchorStartIndex - 1 : null;
  const sequenceStart =
    windowAnchorIndex === null
      ? 0
      : (anchors[windowAnchorIndex]?.sequence ?? 0);
  const beforeSequence =
    page.kind === "older" ? page.beforeCursor.anchorSeq : undefined;

  return {
    paginationPage: {
      kind: "latest",
      segmentLimit: page.segmentLimit,
    },
    responsePageKind: page.kind,
    rows: listStoredTimelineWindowEventRows(db, {
      beforeSequence,
      excludedTypes: THREAD_TIMELINE_EXCLUDED_EVENT_TYPES,
      sequenceStart,
      threadId: thread.id,
    }),
    strategy:
      sequenceStart === 0 && beforeSequence === undefined
        ? "full"
        : "standard-window",
  };
}

function selectTimelineEventRows(
  db: DbConnection,
  thread: Thread,
  options: BuildThreadTimelineOptions,
  systemClientRequestVisibility: SystemClientRequestVisibility,
): TimelineEventRowSelection {
  if (options.timelineViewMode === "manager-conversation") {
    return {
      paginationPage: options.page,
      responsePageKind: options.page.kind,
      rows: listFilteredStoredEventRows(db, {
        filter: MANAGER_CONVERSATION_TIMELINE_EVENT_SELECTION,
        threadId: thread.id,
      }),
      strategy: "manager-conversation-filtered",
    };
  }

  return selectStandardTimelineEventRows(
    db,
    thread,
    options.page,
    systemClientRequestVisibility,
  );
}

function byteLengthOfStoredEventRows(rows: readonly StoredEventRow[]): number {
  let byteLength = 0;
  for (const row of rows) {
    byteLength += Buffer.byteLength(row.data, "utf8");
  }
  return byteLength;
}

function createThreadTimelineBuildProfileDraft(): ThreadTimelineBuildProfileDraft {
  return {
    compactedEventCount: 0,
    contextWindowEventDataBytes: 0,
    contextWindowEventRowCount: 0,
    decodedEventCount: 0,
    eventDataBytes: 0,
    eventRowCount: 0,
    projectedRowCount: 0,
    responseJsonBytes: 0,
    responseRowCount: 0,
    returnedSegmentCount: 0,
    selectionStrategy: "full",
    stageTimings: [],
  };
}

function measureThreadTimelineStage<TResult>(
  profile: ThreadTimelineBuildProfileDraft | null,
  stage: ThreadTimelineBuildProfileStage,
  fn: () => TResult,
): TResult {
  if (!profile) {
    return fn();
  }

  const startTime = performance.now();
  const result = fn();
  profile.stageTimings.push({
    durationMs: performance.now() - startTime,
    stage,
  });
  return result;
}

function completeThreadTimelineBuildProfile(
  draft: ThreadTimelineBuildProfileDraft,
  options: BuildThreadTimelineOptions,
  response: ThreadTimelineResponse,
): ThreadTimelineBuildProfile {
  draft.responseJsonBytes = measureThreadTimelineStage(
    draft,
    "response-serialization",
    () => Buffer.byteLength(JSON.stringify(response), "utf8"),
  );
  return {
    compactedEventCount: draft.compactedEventCount,
    contextWindowEventDataBytes: draft.contextWindowEventDataBytes,
    contextWindowEventRowCount: draft.contextWindowEventRowCount,
    decodedEventCount: draft.decodedEventCount,
    eventDataBytes: draft.eventDataBytes,
    eventRowCount: draft.eventRowCount,
    pageKind: options.page.kind,
    projectedRowCount: draft.projectedRowCount,
    responseJsonBytes: draft.responseJsonBytes,
    responseRowCount: draft.responseRowCount,
    returnedSegmentCount: draft.returnedSegmentCount,
    segmentLimit: options.page.segmentLimit,
    selectionStrategy: draft.selectionStrategy,
    stageTimings: draft.stageTimings,
    timelineViewMode: options.timelineViewMode,
  };
}

function buildThreadTimelineInternal(
  db: DbConnection,
  thread: Thread,
  options: BuildThreadTimelineInternalOptions,
): BuildThreadTimelineInternalResult {
  const profile = options.includeProfile
    ? createThreadTimelineBuildProfileDraft()
    : null;
  const includeNestedRows = options.includeNestedRows ?? false;
  const includeProviderUnhandledOperations = options.isDevelopment;
  const viewMode = options.timelineViewMode;
  const systemClientRequestVisibility = resolveSystemClientRequestVisibility({
    thread,
    timelineViewMode: viewMode,
  });
  const eventSelection = measureThreadTimelineStage(
    profile,
    "event-query",
    () =>
      selectTimelineEventRows(
        db,
        thread,
        options,
        systemClientRequestVisibility,
      ),
  );
  const rawEventRows = eventSelection.rows;
  if (profile) {
    profile.eventDataBytes = byteLengthOfStoredEventRows(rawEventRows);
    profile.eventRowCount = rawEventRows.length;
    profile.selectionStrategy = eventSelection.strategy;
  }
  const decodedRawEvents = measureThreadTimelineStage(
    profile,
    "event-json-decode",
    () => rawEventRows.map((row) => toThreadEventWithMeta(row)),
  );
  if (profile) {
    profile.decodedEventCount = decodedRawEvents.length;
  }
  const decodedEvents = measureThreadTimelineStage(
    profile,
    "summary-compaction",
    () => compactThreadTimelineSummaryEvents(decodedRawEvents),
  );
  if (profile) {
    profile.compactedEventCount = decodedEvents.length;
  }
  const contextWindowUsageRows = measureThreadTimelineStage(
    profile,
    "context-window-query",
    () =>
      listContextWindowUsageRows(db, {
        threadId: thread.id,
      }),
  );
  if (profile) {
    profile.contextWindowEventDataBytes = byteLengthOfStoredEventRows(
      contextWindowUsageRows,
    );
    profile.contextWindowEventRowCount = contextWindowUsageRows.length;
  }
  const commonProjectionOptions = {
    includeDebugRawEvents: false,
    includeProviderUnhandledOperations,
    systemClientRequestVisibility,
    threadStatus: thread.status,
  };
  const contextWindowEvents = measureThreadTimelineStage(
    profile,
    "context-window-json-decode",
    () => contextWindowUsageRows.map((row) => toThreadEventWithMeta(row)),
  );
  const timeline = measureThreadTimelineStage(
    profile,
    "thread-view-projection",
    () =>
      buildThreadTimelineFromEvents({
        contextWindowEvents,
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
      }),
  );
  if (profile) {
    profile.projectedRowCount = timeline.rows.length;
  }
  const paginatedTimeline = measureThreadTimelineStage(
    profile,
    "pagination-segmentation",
    () => paginateTimelineRows(timeline.rows, eventSelection.paginationPage),
  );
  if (profile) {
    profile.responseRowCount = paginatedTimeline.rows.length;
    profile.returnedSegmentCount = paginatedTimeline.returnedSegmentCount;
  }

  const response: ThreadTimelineResponse = {
    rows: paginatedTimeline.rows,
    activeThinking:
      options.page.kind === "latest" ? timeline.activeThinking : null,
    contextWindowUsage:
      options.page.kind === "latest"
        ? (timeline.contextWindowUsage ?? undefined)
        : undefined,
    timelinePage: {
      kind: eventSelection.responsePageKind,
      segmentLimit: paginatedTimeline.segmentLimit,
      returnedSegmentCount: paginatedTimeline.returnedSegmentCount,
      hasOlderRows: paginatedTimeline.hasOlderRows,
      olderCursor: paginatedTimeline.olderCursor,
    },
  };
  return {
    response,
    profile:
      profile === null
        ? null
        : completeThreadTimelineBuildProfile(profile, options, response),
  };
}

export function buildThreadTimeline(
  db: DbConnection,
  thread: Thread,
  options: BuildThreadTimelineOptions,
): ThreadTimelineResponse {
  return buildThreadTimelineInternal(db, thread, {
    ...options,
    includeProfile: false,
  }).response;
}

export function profileThreadTimeline(
  db: DbConnection,
  thread: Thread,
  options: BuildThreadTimelineOptions,
): ProfileThreadTimelineResult {
  const result = buildThreadTimelineInternal(db, thread, {
    ...options,
    includeProfile: true,
  });
  if (result.profile === null) {
    throw new Error("Timeline profile was not captured");
  }
  return {
    profile: result.profile,
    response: result.response,
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
