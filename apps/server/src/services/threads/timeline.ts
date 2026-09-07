import {
  buildThreadTimelineFromEvents,
  THREAD_TIMELINE_EXCLUDED_EVENT_TYPES,
  buildThreadTimelineTurnDetailsFromEvents,
  compactThreadTimelineSummaryEvents,
  type AcceptedClientRequestContext,
  type ThreadEventWithMeta,
} from "@bb/thread-view";
import { LEGACY_CODEX_GOAL_EXTENSION_KIND } from "@bb/domain";
import type {
  ClientTurnRequestId,
  ProviderComposerCommand,
  Thread,
  ThreadEventItemType,
} from "@bb/domain";
import type {
  ThreadConversationOutlineItem,
  ThreadConversationOutlineResponse,
  TimelineConversationAttachments,
  ThreadConversationOutlineAttachmentSummary,
  TimelineRow,
  TimelineSystemRow,
  ThreadTimelineResponse,
  TimelineTurnSummaryDetailsResponse,
} from "@bb/server-contract";
import { threadConversationOutlineItemSchema } from "@bb/server-contract";
import {
  findStoredTimelineWindowByteBudgetFloor,
  findTimelineWindowBudgetFloorSequence,
  getStoredEventRowsByParentToolCallIdsDataBytes,
  getEnvironment,
  getLatestCompletedThreadContextClearSequence,
  getThreadConversationOutlineRecord,
  findUnfinishedTurnCoveringSequence,
  hasParentedEventCrossingSequence,
  getTimelineSegmentAnchorAtSequence,
  listContextWindowUsageRows,
  listRecentStoredEventRows,
  listStoredConversationOutlineEventRows,
  listStoredClientTurnRequestIdsInRange,
  listStoredEventRowsByParentToolCallIds,
  isTimelineCursorSequencePresent,
  listItemEventSpansByItems,
  listStoredBufferedTextDeltaRowsByItems,
  listStoredItemLifecycleRowsByItems,
  listLatestBackgroundTaskStateRowsByItemIds,
  listLatestThreadStateEventRowsByThreadIds,
  listLatestOpenBackgroundTaskStateRowsForThread,
  listStoredTimelineWindowEventRows,
  listTodoSnapshotEventRowsForThread,
  listStoredDelegatingItemRowsByItemIds,
  listStoredTurnCompletedRowsByTurnIds,
  listStoredTurnInputAcceptedRowsByClientRequestIds,
  listStoredTurnRejectedRowsByClientRequestIds,
  listStoredTurnStartedRowsByTurnIdsUpToSequence,
  listTimelineSegmentAnchorsDescending,
  scopedItemRefKey,
  upsertThreadConversationOutlineRecord,
} from "@bb/db";
import type {
  DbConnection,
  InlineOutputCharLimit,
  ScopedItemRef,
  StandardTimelineSegmentAnchorRow,
  StoredEventRow,
} from "@bb/db";
import { ApiError } from "../../errors.js";
import { roundDurationMs } from "../lib/duration.js";
import { runEventLoopWorkSync } from "../system/event-loop-work.js";
import { parseStoredEvent } from "./thread-data.js";
import {
  paginateTimelineRows,
  readSequenceCursor,
  type ThreadTimelinePageKind,
  type ThreadTimelinePageRequest,
  type TimelineSequenceWindowStart,
} from "./timeline-pagination.js";
import { DEFAULT_MAX_INLINE_OUTPUT_CHARS } from "./timeline-output-truncation.js";

interface TimelineTurnSummarySelection {
  sourceSeqEnd: number;
  sourceSeqStart: number;
  turnId: string;
}

function resolveThreadWorkspaceRoot(
  db: DbConnection,
  thread: Thread,
): string | null {
  if (thread.environmentId === null) {
    return null;
  }
  return getEnvironment(db, thread.environmentId)?.path ?? null;
}

interface PartitionAcceptedInputRowsByRequestedTurnArgs {
  acceptedInputRows: readonly StoredEventRow[];
  turnId: string;
}

interface PartitionAcceptedInputRowsByRequestedTurnResult {
  acceptedClientRequestIdsForOtherTurns: ReadonlySet<ClientTurnRequestId>;
  requestedTurnRows: StoredEventRow[];
}

interface FilterExactEventRowsForRequestedTurnArgs {
  acceptedClientRequestIdsForOtherTurns: ReadonlySet<ClientTurnRequestId>;
  exactEventRows: readonly StoredEventRow[];
  turnId: string;
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
  eventBudget: number;
  includeProviderUnhandledOperations: boolean;
  includeNestedRows?: boolean;
  maxInlineOutputChars: InlineOutputCharLimit;
  maxSeq: number;
  page: ThreadTimelinePageRequest;
  summaryOnly?: boolean;
  providerDisplayName?: string;
  planCommand?: ProviderComposerCommand | null;
}

interface BuildTimelineTurnSummaryDetailsOptions extends TimelineTurnSummarySelection {
  includeProviderUnhandledOperations: boolean;
  providerDisplayName?: string;
}

export const THREAD_TIMELINE_DEFAULT_SEGMENT_LIMIT = 20;

export const THREAD_TIMELINE_SEGMENT_LIMIT_MAX = 100;

export const THREAD_TIMELINE_EVENT_DATA_BYTE_LIMIT = 4 * 1024 * 1024;

type ThreadTimelineBuildProfileStage =
  | "event-query"
  | "accepted-client-request-context-query"
  | "event-json-decode"
  | "summary-compaction"
  | "context-window-query"
  | "context-window-json-decode"
  | "thread-view-projection"
  | "pagination-segmentation";

type ThreadTimelineEventSelectionStrategy = "full" | "standard-window";

interface ThreadTimelineBuildProfileStageTiming {
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
  responseRowCount: number;
  returnedSegmentCount: number;
  segmentLimit: number;
  selectionStrategy: ThreadTimelineEventSelectionStrategy;
  stageTimings: ThreadTimelineBuildProfileStageTiming[];
  totalDurationMs: number;
}

interface BuildThreadTimelineInternalResult {
  profile: ThreadTimelineBuildProfile | null;
  response: ThreadTimelineResponse;
}

interface ThreadTimelineBuildProfileAccumulator {
  compactedEventCount: number;
  contextWindowEventDataBytes: number;
  contextWindowEventRowCount: number;
  decodedEventCount: number;
  eventDataBytes: number;
  eventRowCount: number;
  projectedRowCount: number;
  responseRowCount: number;
  returnedSegmentCount: number;
  selectionStrategy: ThreadTimelineEventSelectionStrategy;
  stageTimings: ThreadTimelineBuildProfileStageTiming[];
}

interface BuildThreadTimelineInternalOptions extends BuildThreadTimelineOptions {
  includeProfile: boolean;
}

interface TimelineEventRowSelection {
  byteWindowSequenceEnd: number | null;
  byteWindowSequenceStart: number | null;
  contextOnlyToolCallIds: Set<string>;
  sequenceWindowStart: TimelineSequenceWindowStart | null;
  knownHasOlderSegments: boolean | null;
  paginationPage: ThreadTimelinePageRequest;
  responsePageKind: ThreadTimelinePageKind;
  oversizedEventPlaceholder: TimelineSystemRow | null;
  rows: StoredEventRow[];
  strategy: ThreadTimelineEventSelectionStrategy;
}

interface TimelineWindowRowsArgs {
  rows: readonly StoredEventRow[];
  threadId: string;
}

interface TimelineWindowParentedRowsArgs extends TimelineWindowRowsArgs {
  maxInlineOutputChars: InlineOutputCharLimit;
  outOfBoundsChildDataByteLimit?: number;
  sequenceBounds: {
    beforeSequence: number | undefined;
    sequenceStart: number;
  } | null;
}

interface TimelineWindowParentedRowsResult {
  contextOnlyToolCallIds: Set<string>;
  rows: StoredEventRow[];
}

interface SelectClientRequestContextRowsArgs {
  rows: readonly StoredEventRow[];
  threadId: string;
}

interface SelectedClientRequestContextRows {
  acceptedRows: StoredEventRow[];
  rejectedRows: StoredEventRow[];
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

function parseRejectedClientRequestId(
  row: StoredEventRow,
): ClientTurnRequestId {
  const event = parseStoredEvent(row);
  if (event.type !== "client/turn/rejected") {
    throw new Error(`Expected client/turn/rejected row ${row.id}`);
  }
  return event.requestId;
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

function tryReadSteerClientTurnRequestedRequestId(
  row: StoredEventRow,
): ClientTurnRequestId | null {
  if (row.type !== "client/turn/requested") {
    return null;
  }
  const event = parseStoredEvent(row);
  if (event.type !== "client/turn/requested") {
    return null;
  }

  switch (event.target.kind) {
    case "auto":
    case "steer":
      return event.target.expectedTurnId === null ? null : event.requestId;
    case "new-turn":
    case "thread-start":
      return null;
  }
}

function collectSteerClientRequestIdsNeedingContext(
  rows: readonly StoredEventRow[],
): ClientTurnRequestId[] {
  const terminalClientRequestIds = new Set<ClientTurnRequestId>();
  const clientRequestIds = new Set<ClientTurnRequestId>();
  for (const row of rows) {
    if (row.type === "turn/input/accepted") {
      const clientRequestId = parseAcceptedInputClientRequestId(row);
      terminalClientRequestIds.add(clientRequestId);
      clientRequestIds.delete(clientRequestId);
      continue;
    }
    if (row.type === "client/turn/rejected") {
      const clientRequestId = parseRejectedClientRequestId(row);
      terminalClientRequestIds.add(clientRequestId);
      clientRequestIds.delete(clientRequestId);
      continue;
    }
    const clientRequestId = tryReadSteerClientTurnRequestedRequestId(row);
    if (
      clientRequestId === null ||
      terminalClientRequestIds.has(clientRequestId)
    ) {
      continue;
    }
    clientRequestIds.add(clientRequestId);
  }
  return [...clientRequestIds];
}

function mergeStoredEventRowsById(
  rows: readonly StoredEventRow[],
): StoredEventRow[] {
  const rowsById = new Map<string, StoredEventRow>();
  for (const row of rows) {
    rowsById.set(row.id, row);
  }
  return [...rowsById.values()].sort(
    (left, right) => left.sequence - right.sequence,
  );
}

function getStoredEventParentToolCallId(
  row: StoredEventRow,
): string | undefined {
  return row.parentToolCallId !== null && row.parentToolCallId.length > 0
    ? row.parentToolCallId
    : undefined;
}

function isStoredDelegatingItemRow(row: StoredEventRow): boolean {
  return (
    (row.itemKind === "toolCall" || row.itemKind === "delegation") &&
    row.itemId !== null
  );
}

function collectStoredDelegatingItemIds(
  rows: readonly StoredEventRow[],
): string[] {
  const itemIds = new Set<string>();
  for (const row of rows) {
    if (!isStoredDelegatingItemRow(row) || row.itemId === null) {
      continue;
    }
    itemIds.add(row.itemId);
  }
  return [...itemIds];
}

function collectStoredParentToolCallIds(
  rows: readonly StoredEventRow[],
): string[] {
  const parentToolCallIds = new Set<string>();
  for (const row of rows) {
    const parentToolCallId = getStoredEventParentToolCallId(row);
    if (parentToolCallId) {
      parentToolCallIds.add(parentToolCallId);
    }
  }
  return [...parentToolCallIds];
}

function ensureTimelineWindowParentedRows(
  db: DbConnection,
  args: TimelineWindowParentedRowsArgs,
): TimelineWindowParentedRowsResult {
  let rows = [...args.rows];
  const rowIds = new Set(rows.map((row) => row.id));
  const visibleToolCallIds = new Set(collectStoredDelegatingItemIds(rows));
  const fetchedChildToolCallIds = new Set<string>();
  let outOfBoundsChildDataBytesRemaining = args.outOfBoundsChildDataByteLimit;

  while (true) {
    const toolCallIdsToFetch = [...visibleToolCallIds].filter(
      (toolCallId) => !fetchedChildToolCallIds.has(toolCallId),
    );
    if (toolCallIdsToFetch.length === 0) {
      break;
    }
    for (const toolCallId of toolCallIdsToFetch) {
      fetchedChildToolCallIds.add(toolCallId);
    }

    let childSequenceBounds = args.sequenceBounds;
    if (outOfBoundsChildDataBytesRemaining !== undefined) {
      const unboundedChildDataBytes =
        getStoredEventRowsByParentToolCallIdsDataBytes(db, {
          excludedTypes: THREAD_TIMELINE_EXCLUDED_EVENT_TYPES,
          maxInlineOutputChars: args.maxInlineOutputChars,
          parentToolCallIds: toolCallIdsToFetch,
          threadId: args.threadId,
        });
      if (unboundedChildDataBytes <= outOfBoundsChildDataBytesRemaining) {
        childSequenceBounds = null;
        outOfBoundsChildDataBytesRemaining -= unboundedChildDataBytes;
      }
    }
    const childRows = listStoredEventRowsByParentToolCallIds(db, {
      beforeSequence: childSequenceBounds?.beforeSequence,
      excludedTypes: THREAD_TIMELINE_EXCLUDED_EVENT_TYPES,
      maxInlineOutputChars: args.maxInlineOutputChars,
      parentToolCallIds: toolCallIdsToFetch,
      sequenceStart: childSequenceBounds?.sequenceStart,
      threadId: args.threadId,
    });
    const newChildRows = childRows.filter((row) => !rowIds.has(row.id));
    if (newChildRows.length === 0) {
      continue;
    }
    for (const row of newChildRows) {
      rowIds.add(row.id);
      if (isStoredDelegatingItemRow(row) && row.itemId !== null) {
        visibleToolCallIds.add(row.itemId);
      }
    }
    rows = mergeStoredEventRowsById([...rows, ...newChildRows]);
  }

  const contextOnlyToolCallIds = new Set<string>();
  const missingParentToolCallIds = collectStoredParentToolCallIds(rows).filter(
    (parentToolCallId) => !visibleToolCallIds.has(parentToolCallId),
  );
  const parentRows = listStoredDelegatingItemRowsByItemIds(db, {
    itemIds: missingParentToolCallIds,
    maxInlineOutputChars: args.maxInlineOutputChars,
    threadId: args.threadId,
  });
  const newParentRows = parentRows.filter((row) => !rowIds.has(row.id));
  for (const row of parentRows) {
    if (row.itemId !== null && !visibleToolCallIds.has(row.itemId)) {
      contextOnlyToolCallIds.add(row.itemId);
    }
  }

  return {
    contextOnlyToolCallIds,
    rows:
      newParentRows.length > 0
        ? mergeStoredEventRowsById([...newParentRows, ...rows])
        : rows,
  };
}

function minSequenceOfClientRequests(
  rows: readonly StoredEventRow[],
  clientRequestIds: ReadonlySet<ClientTurnRequestId>,
): number {
  let minSequence = Number.POSITIVE_INFINITY;
  for (const row of rows) {
    if (row.type !== "client/turn/requested") {
      continue;
    }
    const requestId = tryReadClientTurnRequestedRequestId(row);
    if (requestId !== null && clientRequestIds.has(requestId)) {
      minSequence = Math.min(minSequence, row.sequence);
    }
  }
  return Number.isFinite(minSequence) ? minSequence : 0;
}

function selectClientRequestContextRows(
  db: DbConnection,
  args: SelectClientRequestContextRowsArgs,
): SelectedClientRequestContextRows {
  const clientRequestIds = collectSteerClientRequestIdsNeedingContext(
    args.rows,
  );
  if (clientRequestIds.length === 0) {
    return { acceptedRows: [], rejectedRows: [] };
  }
  const afterSequence = minSequenceOfClientRequests(
    args.rows,
    new Set(clientRequestIds),
  );
  return {
    acceptedRows: listStoredTurnInputAcceptedRowsByClientRequestIds(db, {
      afterSequence,
      clientRequestIds,
      threadId: args.threadId,
    }),
    rejectedRows: listStoredTurnRejectedRowsByClientRequestIds(db, {
      afterSequence,
      clientRequestIds,
      threadId: args.threadId,
    }),
  };
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
    const clientRequestId = parseAcceptedInputClientRequestId(row);
    if (row.turnId === args.turnId) {
      requestedTurnRows.push(row);
      continue;
    }
    acceptedClientRequestIdsForOtherTurns.add(clientRequestId);
  }

  return {
    acceptedClientRequestIdsForOtherTurns,
    requestedTurnRows,
  };
}

const CROSS_TURN_TOOL_ITEM_KINDS: ReadonlySet<ThreadEventItemType> = new Set([
  "commandExecution",
  "toolCall",
  "webSearch",
  "webFetch",
  "imageView",
  "fileRead",
  "search",
  "planSteps",
  "delegation",
  "extension",
]);

function filterExactEventRowsForRequestedTurn(
  args: FilterExactEventRowsForRequestedTurnArgs,
): FilterExactEventRowsForRequestedTurnResult {
  const rows: StoredEventRow[] = [];
  let removedRows = false;
  const openToolCallIds = new Set<string>();
  for (const row of args.exactEventRows) {
    if (row.scopeKind === "turn" && row.turnId !== args.turnId) {
      const continuesOpenToolCall =
        row.itemId !== null &&
        row.type.startsWith("item/") &&
        openToolCallIds.has(row.itemId);
      if (!continuesOpenToolCall) {
        removedRows = true;
        continue;
      }
    } else if (
      row.type === "item/started" &&
      row.itemId !== null &&
      row.itemKind !== null &&
      CROSS_TURN_TOOL_ITEM_KINDS.has(row.itemKind)
    ) {
      openToolCallIds.add(row.itemId);
    }
    if (row.type === "item/completed" && row.itemId !== null) {
      openToolCallIds.delete(row.itemId);
    }

    const requestId = tryReadClientTurnRequestedRequestId(row);
    if (
      requestId !== null &&
      args.acceptedClientRequestIdsForOtherTurns.has(requestId)
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

function selectFullTimelineEventRows(
  db: DbConnection,
  thread: Thread,
  page: ThreadTimelinePageRequest,
  maxInlineOutputChars: InlineOutputCharLimit,
  sequenceStart: number,
): TimelineEventRowSelection {
  return {
    byteWindowSequenceEnd: null,
    byteWindowSequenceStart: null,
    contextOnlyToolCallIds: new Set(),
    sequenceWindowStart: null,
    knownHasOlderSegments: null,
    paginationPage: page,
    responsePageKind: page.kind,
    oversizedEventPlaceholder: null,
    rows: listRecentStoredEventRows(db, {
      threadId: thread.id,
      excludedTypes: THREAD_TIMELINE_EXCLUDED_EVENT_TYPES,
      maxInlineOutputChars,
      sequenceStart,
    }),
    strategy: "full",
  };
}

function collectTurnIdsMissingStartedRows(
  rows: readonly StoredEventRow[],
): string[] {
  const startedTurnIds = new Set<string>();
  const turnScopedIds = new Set<string>();

  for (const row of rows) {
    if (row.scopeKind !== "turn" || row.turnId === null) {
      continue;
    }

    if (row.type === "turn/started") {
      startedTurnIds.add(row.turnId);
      continue;
    }

    turnScopedIds.add(row.turnId);
  }

  return [...turnScopedIds].filter((turnId) => !startedTurnIds.has(turnId));
}

function maxStoredEventSequence(rows: readonly StoredEventRow[]): number {
  return rows.reduce(
    (maxSequence, row) => Math.max(maxSequence, row.sequence),
    0,
  );
}

function ensureTimelineWindowTurnStartedRows(
  db: DbConnection,
  args: TimelineWindowRowsArgs,
): StoredEventRow[] {
  const missingTurnIds = collectTurnIdsMissingStartedRows(args.rows);
  if (missingTurnIds.length === 0) {
    return [...args.rows];
  }

  const turnStartedRows = listStoredTurnStartedRowsByTurnIdsUpToSequence(db, {
    threadId: args.threadId,
    sequenceCutoff: maxStoredEventSequence(args.rows),
    turnIds: missingTurnIds,
  });
  if (turnStartedRows.length === 0) {
    return [...args.rows];
  }

  return mergeStoredEventRowsById([...turnStartedRows, ...args.rows]);
}

function ensureSequenceWindowTurnCompletedRows(
  db: DbConnection,
  args: TimelineWindowRowsArgs,
): StoredEventRow[] {
  const completedTurnIds = new Set<string>();
  const selectedTurnIds = new Set<string>();
  for (const row of args.rows) {
    if (row.scopeKind !== "turn" || row.turnId === null) {
      continue;
    }
    selectedTurnIds.add(row.turnId);
    if (row.type === "turn/completed") {
      completedTurnIds.add(row.turnId);
    }
  }
  const missingTurnIds = [...selectedTurnIds].filter(
    (turnId) => !completedTurnIds.has(turnId),
  );
  if (missingTurnIds.length === 0) {
    return [...args.rows];
  }

  const completedRows = listStoredTurnCompletedRowsByTurnIds(db, {
    threadId: args.threadId,
    turnIds: missingTurnIds,
  });
  return completedRows.length === 0
    ? [...args.rows]
    : mergeStoredEventRowsById([...args.rows, ...completedRows]);
}

function storedEventRowItemRef(row: StoredEventRow): ScopedItemRef {
  return {
    itemId: row.itemId ?? "",
    scopeKind: row.scopeKind,
    turnId: row.turnId,
  };
}

interface SequenceWindowItemRowsArgs extends TimelineWindowRowsArgs {
  beforeSequence: number | undefined;
  maxInlineOutputChars: InlineOutputCharLimit;
  sequenceStart: number;
}

function rowIdentifiesBufferedTextItem(row: StoredEventRow): boolean {
  if (row.type === "item/started") {
    return (
      row.itemKind === "agentMessage" ||
      row.itemKind === "plan" ||
      row.itemKind === "reasoning"
    );
  }
  return (
    row.type === "item/agentMessage/delta" ||
    row.type === "item/plan/delta" ||
    row.type === "item/reasoning/summaryTextDelta" ||
    row.type === "item/reasoning/textDelta"
  );
}

function ensureSequenceWindowWholeItemRows(
  db: DbConnection,
  args: SequenceWindowItemRowsArgs,
): StoredEventRow[] {
  const windowItems = new Map<string, ScopedItemRef>();
  for (const row of args.rows) {
    if (
      row.itemId !== null &&
      row.itemKind !== "backgroundTask" &&
      row.sequence >= args.sequenceStart
    ) {
      const ref = storedEventRowItemRef(row);
      windowItems.set(scopedItemRefKey(ref), ref);
    }
  }
  if (windowItems.size === 0) {
    return [...args.rows];
  }

  const spans = listItemEventSpansByItems(db, {
    items: [...windowItems.values()],
    threadId: args.threadId,
  });
  const itemKeysOwnedByNewerWindow = new Set<string>();
  const itemsStartingBeforeWindow = new Map<string, ScopedItemRef>();
  for (const span of spans) {
    const key = scopedItemRefKey(span);
    if (
      args.beforeSequence !== undefined &&
      span.maxSequence >= args.beforeSequence
    ) {
      itemKeysOwnedByNewerWindow.add(key);
      continue;
    }
    if (span.minSequence < args.sequenceStart) {
      itemsStartingBeforeWindow.set(key, {
        itemId: span.itemId,
        scopeKind: span.scopeKind,
        turnId: span.turnId,
      });
    }
  }

  const rows = args.rows.filter(
    (row) =>
      row.itemId === null ||
      !itemKeysOwnedByNewerWindow.has(
        scopedItemRefKey(storedEventRowItemRef(row)),
      ),
  );
  if (itemsStartingBeforeWindow.size === 0) {
    return rows;
  }

  const backfillRows = listStoredItemLifecycleRowsByItems(db, {
    items: [...itemsStartingBeforeWindow.values()],
    maxInlineOutputChars: args.maxInlineOutputChars,
    threadId: args.threadId,
  }).filter((row) => row.sequence < args.sequenceStart);

  const completedItemKeys = new Set<string>();
  for (const row of [...rows, ...backfillRows]) {
    if (row.type === "item/completed" && row.itemId !== null) {
      completedItemKeys.add(scopedItemRefKey(storedEventRowItemRef(row)));
    }
  }
  const bufferedTextItems = new Map<string, ScopedItemRef>();
  for (const row of [...backfillRows, ...rows]) {
    if (row.itemId === null || !rowIdentifiesBufferedTextItem(row)) {
      continue;
    }
    const ref = storedEventRowItemRef(row);
    const key = scopedItemRefKey(ref);
    if (!completedItemKeys.has(key) && itemsStartingBeforeWindow.has(key)) {
      bufferedTextItems.set(key, ref);
    }
  }
  const bufferedTextRows = listStoredBufferedTextDeltaRowsByItems(db, {
    beforeSequence: args.sequenceStart,
    items: [...bufferedTextItems.values()],
    threadId: args.threadId,
  });
  const prefixRows = [...backfillRows, ...bufferedTextRows];
  return prefixRows.length === 0
    ? rows
    : mergeStoredEventRowsById([...prefixRows, ...rows]);
}

function ensureTimelineWindowBackgroundTaskStateRows(
  db: DbConnection,
  args: TimelineWindowRowsArgs,
): StoredEventRow[] {
  const itemIds = new Set<string>();
  for (const row of args.rows) {
    if (row.itemKind === "backgroundTask" && row.itemId !== null) {
      itemIds.add(row.itemId);
    }
  }
  if (itemIds.size === 0) {
    return [...args.rows];
  }

  const stateRows = listLatestBackgroundTaskStateRowsByItemIds(db, {
    threadId: args.threadId,
    itemIds: [...itemIds],
  });
  if (stateRows.length === 0) {
    return [...args.rows];
  }

  return mergeStoredEventRowsById([...args.rows, ...stateRows]);
}

function ensureLatestTimelineOpenBackgroundTaskStateRows(
  db: DbConnection,
  args: TimelineWindowRowsArgs,
): StoredEventRow[] {
  const stateRows = listLatestOpenBackgroundTaskStateRowsForThread(db, {
    threadId: args.threadId,
  });
  if (stateRows.length === 0) {
    return [...args.rows];
  }

  return mergeStoredEventRowsById([...args.rows, ...stateRows]);
}

function ensureLatestTimelineHeadStateRows(
  db: DbConnection,
  args: TimelineWindowRowsArgs,
): StoredEventRow[] {
  const headStateRows = [
    ...listLatestThreadStateEventRowsByThreadIds(db, {
      threadIds: [args.threadId],
      kind: LEGACY_CODEX_GOAL_EXTENSION_KIND,
    }),
    ...listTodoSnapshotEventRowsForThread(db, { threadId: args.threadId }),
  ];
  if (headStateRows.length === 0) {
    return [...args.rows];
  }

  return mergeStoredEventRowsById([...args.rows, ...headStateRows]);
}

interface ResolveTimelineSegmentWindowArgs {
  eventBudget: number;
  page: ThreadTimelinePageRequest;
  sequenceStart: number;
  threadId: string;
}

interface ResolvedTimelineSegmentWindow {
  beforeSequence: number | undefined;
  byteWindowSequenceStart: number | null;
  requiresWholeItemClosure: boolean;
  effectiveSegmentLimit: number;
  hasAnchors: boolean;
  sequenceWindowStart: TimelineSequenceWindowStart | null;
  knownHasOlderSegments: boolean | null;
  oversizedEventPlaceholder: TimelineSystemRow | null;
  sequenceStart: number;
}

function applyTimelineWindowByteBudget(
  db: DbConnection,
  args: {
    maxInlineOutputChars: InlineOutputCharLimit;
    threadId: string;
    window: ResolvedTimelineSegmentWindow;
  },
): ResolvedTimelineSegmentWindow {
  const windowArgs = {
    beforeSequence: args.window.beforeSequence,
    excludedTypes: THREAD_TIMELINE_EXCLUDED_EVENT_TYPES,
    maxInlineOutputChars: args.maxInlineOutputChars,
    sequenceStart: args.window.sequenceStart,
    threadId: args.threadId,
  };
  const floor = findStoredTimelineWindowByteBudgetFloor(db, {
    ...windowArgs,
    maxDataBytes: THREAD_TIMELINE_EVENT_DATA_BYTE_LIMIT,
  });
  if (floor.kind === "single-event-too-large") {
    const hasOlderRows =
      floor.hasOlderRows || args.window.knownHasOlderSegments === true;
    return {
      ...args.window,
      byteWindowSequenceStart: floor.sequenceStart,
      knownHasOlderSegments: hasOlderRows,
      oversizedEventPlaceholder: {
        id: `${args.threadId}:oversized-event:${floor.sequenceStart}`,
        threadId: args.threadId,
        turnId: floor.turnId,
        sourceSeqStart: floor.sequenceStart,
        sourceSeqEnd: floor.sequenceStart,
        startedAt: floor.createdAt,
        createdAt: floor.createdAt,
        kind: "system",
        systemKind: "error",
        title: "Timeline event is too large to display",
        detail: `Event ${floor.sequenceStart} contains ${floor.eventDataBytes} bytes. BB omitted its content to keep this thread available.`,
        status: "error",
      },
      sequenceStart: floor.sequenceStart + 1,
      sequenceWindowStart: hasOlderRows
        ? {
            kind: "byte",
            sequenceStart: floor.sequenceStart,
            threadId: args.threadId,
          }
        : null,
    };
  }
  if (floor.kind === "fits") {
    return args.window;
  }

  return {
    ...args.window,
    byteWindowSequenceStart: floor.sequenceStart,
    requiresWholeItemClosure: true,
    sequenceWindowStart: {
      kind: "byte",
      sequenceStart: floor.sequenceStart,
      threadId: args.threadId,
    },
    knownHasOlderSegments: true,
    sequenceStart: floor.sequenceStart,
  };
}

interface ResolveTimelineWindowBoundsArgs {
  anchors: readonly StandardTimelineSegmentAnchorRow[];
  budgetFloorSequence: number | undefined;
  minimumSequenceStart: number;
  segmentLimit: number;
  threadId: string;
}

function countAffordableAnchors(
  anchors: readonly { sequence: number }[],
  budgetFloorSequence: number | undefined,
  segmentLimit: number,
): number {
  const maxSegments = Math.min(segmentLimit, anchors.length);
  if (budgetFloorSequence === undefined) {
    return maxSegments;
  }
  const affordable = anchors.filter(
    (anchor) => anchor.sequence >= budgetFloorSequence,
  ).length;
  return Math.min(maxSegments, affordable);
}

function resolveTimelineWindowBounds(
  db: DbConnection,
  args: ResolveTimelineWindowBoundsArgs,
): Pick<
  ResolvedTimelineSegmentWindow,
  | "effectiveSegmentLimit"
  | "knownHasOlderSegments"
  | "sequenceStart"
  | "sequenceWindowStart"
> {
  const {
    anchors,
    budgetFloorSequence,
    minimumSequenceStart,
    segmentLimit,
    threadId,
  } = args;
  const affordable = countAffordableAnchors(
    anchors,
    budgetFloorSequence,
    segmentLimit,
  );
  const unfinishedTurnId =
    affordable === 0 && budgetFloorSequence !== undefined
      ? findUnfinishedTurnCoveringSequence(db, {
          sequence: budgetFloorSequence,
          threadId,
        })
      : null;
  if (
    affordable === 0 &&
    budgetFloorSequence !== undefined &&
    unfinishedTurnId !== null &&
    !hasParentedEventCrossingSequence(db, {
      sequence: budgetFloorSequence,
      threadId,
    })
  ) {
    return {
      effectiveSegmentLimit: segmentLimit,
      knownHasOlderSegments: true,
      sequenceWindowStart: {
        kind: "event",
        sequenceStart: budgetFloorSequence,
        threadId,
      },
      sequenceStart: budgetFloorSequence,
    };
  }

  if (budgetFloorSequence === undefined && anchors.length <= segmentLimit) {
    return {
      effectiveSegmentLimit: segmentLimit,
      knownHasOlderSegments: null,
      sequenceWindowStart: null,
      sequenceStart: minimumSequenceStart,
    };
  }

  const segmentCount = Math.max(1, affordable);
  const sequenceStart =
    anchors[segmentCount - 1]?.sequence ?? minimumSequenceStart;
  const budgetHasOlderRows =
    budgetFloorSequence !== undefined &&
    (budgetFloorSequence < sequenceStart ||
      (budgetFloorSequence === sequenceStart &&
        findTimelineWindowBudgetFloorSequence(db, {
          beforeSequence: sequenceStart,
          eventBudget: 0,
          excludedTypes: THREAD_TIMELINE_EXCLUDED_EVENT_TYPES,
          sequenceStart: minimumSequenceStart,
          threadId,
        }) !== undefined));
  return {
    effectiveSegmentLimit: segmentCount,
    knownHasOlderSegments:
      sequenceStart === minimumSequenceStart
        ? false
        : anchors.length > segmentCount || budgetHasOlderRows,
    sequenceWindowStart: null,
    sequenceStart,
  };
}

function resolveTimelineSegmentWindow(
  db: DbConnection,
  args: ResolveTimelineSegmentWindowArgs,
): ResolvedTimelineSegmentWindow {
  const { eventBudget, page, sequenceStart, threadId } = args;
  const noAnchors: ResolvedTimelineSegmentWindow = {
    beforeSequence: undefined,
    byteWindowSequenceStart: null,
    requiresWholeItemClosure: false,
    effectiveSegmentLimit: page.segmentLimit,
    hasAnchors: false,
    sequenceWindowStart: null,
    knownHasOlderSegments: null,
    oversizedEventPlaceholder: null,
    sequenceStart,
  };

  if (page.kind === "older") {
    const cursor = page.beforeCursor;
    if (cursor.anchorSeq < sequenceStart) {
      throw new ApiError(
        400,
        "invalid_request",
        "Timeline pagination cursor is before the context boundary",
      );
    }
    const sequenceCursor = readSequenceCursor(cursor, threadId);
    if (sequenceCursor === null) {
      const cursorAnchor = getTimelineSegmentAnchorAtSequence(db, {
        sequence: cursor.anchorSeq,
        threadId,
      });
      if (!cursorAnchor || cursorAnchor.rowId !== cursor.anchorId) {
        const anyAnchor = listTimelineSegmentAnchorsDescending(db, {
          limit: 1,
          sequenceStart,
          threadId,
        });
        if (anyAnchor.length === 0) {
          return noAnchors;
        }
        if (
          !isTimelineCursorSequencePresent(db, {
            sequence: cursor.anchorSeq,
            threadId,
          })
        ) {
          throw new ApiError(
            400,
            "invalid_request",
            "Timeline pagination cursor is no longer available",
          );
        }
      }
    } else if (
      !isTimelineCursorSequencePresent(db, {
        sequence: sequenceCursor.sequenceStart,
        threadId,
      })
    ) {
      throw new ApiError(
        400,
        "invalid_request",
        "Timeline pagination cursor is no longer available",
      );
    }
    const precedingAnchors = listTimelineSegmentAnchorsDescending(db, {
      beforeSequence: cursor.anchorSeq,
      limit: page.segmentLimit + 1,
      sequenceStart,
      threadId,
    });
    const bounds = resolveTimelineWindowBounds(db, {
      anchors: precedingAnchors,
      budgetFloorSequence: findTimelineWindowBudgetFloorSequence(db, {
        beforeSequence: cursor.anchorSeq,
        eventBudget,
        excludedTypes: THREAD_TIMELINE_EXCLUDED_EVENT_TYPES,
        sequenceStart,
        threadId,
      }),
      minimumSequenceStart: sequenceStart,
      segmentLimit: page.segmentLimit,
      threadId,
    });
    return {
      beforeSequence: cursor.anchorSeq,
      byteWindowSequenceStart:
        sequenceCursor?.kind === "byte" ? bounds.sequenceStart : null,
      requiresWholeItemClosure:
        sequenceCursor !== null || bounds.sequenceWindowStart !== null,
      effectiveSegmentLimit: bounds.effectiveSegmentLimit,
      hasAnchors: true,
      sequenceWindowStart: bounds.sequenceWindowStart,
      knownHasOlderSegments: bounds.knownHasOlderSegments,
      oversizedEventPlaceholder: null,
      sequenceStart: bounds.sequenceStart,
    };
  }

  const newestAnchors = listTimelineSegmentAnchorsDescending(db, {
    limit: page.segmentLimit + 1,
    sequenceStart,
    threadId,
  });
  if (newestAnchors.length === 0) {
    return noAnchors;
  }
  const bounds = resolveTimelineWindowBounds(db, {
    anchors: newestAnchors,
    budgetFloorSequence: findTimelineWindowBudgetFloorSequence(db, {
      eventBudget,
      excludedTypes: THREAD_TIMELINE_EXCLUDED_EVENT_TYPES,
      sequenceStart,
      threadId,
    }),
    minimumSequenceStart: sequenceStart,
    segmentLimit: page.segmentLimit,
    threadId,
  });
  return {
    beforeSequence: undefined,
    byteWindowSequenceStart: null,
    requiresWholeItemClosure: bounds.sequenceWindowStart !== null,
    effectiveSegmentLimit: bounds.effectiveSegmentLimit,
    hasAnchors: true,
    sequenceWindowStart: bounds.sequenceWindowStart,
    knownHasOlderSegments: bounds.knownHasOlderSegments,
    oversizedEventPlaceholder: null,
    sequenceStart: bounds.sequenceStart,
  };
}

function selectStandardTimelineEventRows(
  db: DbConnection,
  thread: Thread,
  page: ThreadTimelinePageRequest,
  eventBudget: number,
  maxInlineOutputChars: InlineOutputCharLimit,
  epochSequenceStart: number,
): TimelineEventRowSelection {
  const window = applyTimelineWindowByteBudget(db, {
    maxInlineOutputChars,
    threadId: thread.id,
    window: resolveTimelineSegmentWindow(db, {
      eventBudget,
      page,
      sequenceStart: epochSequenceStart,
      threadId: thread.id,
    }),
  });
  if (
    !window.hasAnchors &&
    window.sequenceWindowStart === null &&
    window.byteWindowSequenceStart === null
  ) {
    return selectFullTimelineEventRows(
      db,
      thread,
      page,
      maxInlineOutputChars,
      epochSequenceStart,
    );
  }

  const beforeSequence = window.beforeSequence;
  const sequenceStart = window.sequenceStart;

  const windowArgs = {
    beforeSequence,
    excludedTypes: THREAD_TIMELINE_EXCLUDED_EVENT_TYPES,
    maxInlineOutputChars,
    sequenceStart,
    threadId: thread.id,
  };
  const windowRows = listStoredTimelineWindowEventRows(db, windowArgs);
  const wholeItemWindowRows = window.requiresWholeItemClosure
    ? ensureSequenceWindowWholeItemRows(db, {
        beforeSequence,
        maxInlineOutputChars,
        rows: windowRows,
        sequenceStart,
        threadId: thread.id,
      })
    : windowRows;
  const selectedRowsWithTurnStarts = ensureTimelineWindowTurnStartedRows(db, {
    threadId: thread.id,
    rows: wholeItemWindowRows,
  });
  const selectedRowsWithTurnLifecycle =
    window.byteWindowSequenceStart === null
      ? selectedRowsWithTurnStarts
      : ensureSequenceWindowTurnCompletedRows(db, {
          threadId: thread.id,
          rows: selectedRowsWithTurnStarts,
        });
  const selectedRowsWithInWindowTaskState =
    ensureTimelineWindowBackgroundTaskStateRows(db, {
      threadId: thread.id,
      rows: selectedRowsWithTurnLifecycle,
    });
  const selectedRows =
    page.kind === "latest"
      ? ensureLatestTimelineHeadStateRows(db, {
          threadId: thread.id,
          rows: ensureLatestTimelineOpenBackgroundTaskStateRows(db, {
            threadId: thread.id,
            rows: selectedRowsWithInWindowTaskState,
          }),
        })
      : selectedRowsWithInWindowTaskState;
  const selectedRowsWithParentedContext = ensureTimelineWindowParentedRows(db, {
    maxInlineOutputChars,
    sequenceBounds:
      window.byteWindowSequenceStart === null
        ? null
        : { beforeSequence, sequenceStart },
    threadId: thread.id,
    rows: selectedRows,
  });
  const selectedRowsWithParentedTurnStarts =
    ensureTimelineWindowTurnStartedRows(db, {
      threadId: thread.id,
      rows: selectedRowsWithParentedContext.rows,
    });
  const selectedRowsWithParentedTurnLifecycle =
    window.byteWindowSequenceStart === null
      ? selectedRowsWithParentedTurnStarts
      : ensureSequenceWindowTurnCompletedRows(db, {
          threadId: thread.id,
          rows: selectedRowsWithParentedTurnStarts,
        });

  return {
    byteWindowSequenceEnd:
      window.byteWindowSequenceStart === null
        ? null
        : (wholeItemWindowRows.at(-1)?.sequence ??
          window.byteWindowSequenceStart),
    byteWindowSequenceStart: window.byteWindowSequenceStart,
    contextOnlyToolCallIds:
      window.byteWindowSequenceStart === null
        ? selectedRowsWithParentedContext.contextOnlyToolCallIds
        : new Set(),
    sequenceWindowStart: window.sequenceWindowStart,
    knownHasOlderSegments: window.knownHasOlderSegments,
    paginationPage:
      page.kind === "older"
        ? { ...page, segmentLimit: window.effectiveSegmentLimit }
        : {
            kind: "latest",
            segmentLimit: window.effectiveSegmentLimit,
          },
    responsePageKind: page.kind,
    oversizedEventPlaceholder: window.oversizedEventPlaceholder,
    rows: selectedRowsWithParentedTurnLifecycle.filter(
      (row) => row.sequence >= epochSequenceStart,
    ),
    strategy:
      sequenceStart === 0 && beforeSequence === undefined
        ? "full"
        : "standard-window",
  };
}

function byteLengthOfStoredEventRows(rows: readonly StoredEventRow[]): number {
  let byteLength = 0;
  for (const row of rows) {
    byteLength += Buffer.byteLength(row.data, "utf8");
  }
  return byteLength;
}

function buildSequencePageTimelineRows(
  rows: readonly TimelineRow[],
  selection: TimelineEventRowSelection,
): TimelineRow[] {
  const rowsWithPlaceholder = selection.oversizedEventPlaceholder
    ? [...rows, selection.oversizedEventPlaceholder].sort(
        (left, right) => left.sourceSeqStart - right.sourceSeqStart,
      )
    : [...rows];
  if (selection.byteWindowSequenceStart === null) {
    return rowsWithPlaceholder;
  }

  const suffix =
    selection.responsePageKind === "latest"
      ? ""
      : `:sequence-page:${selection.byteWindowSequenceStart}`;
  return rowsWithPlaceholder.flatMap((row): TimelineRow[] => {
    if (
      row.kind !== "turn" ||
      selection.byteWindowSequenceEnd === null ||
      selection.byteWindowSequenceStart === null
    ) {
      return [{ ...row, id: `${row.id}${suffix}` }];
    }
    const sourceSeqStart = Math.max(
      row.sourceSeqStart,
      selection.byteWindowSequenceStart,
    );
    const sourceSeqEnd = Math.min(
      row.sourceSeqEnd,
      selection.byteWindowSequenceEnd,
    );
    if (sourceSeqStart > sourceSeqEnd) {
      return [];
    }
    return [
      {
        ...row,
        id: `${row.id}${suffix}`,
        sourceSeqEnd,
        sourceSeqStart,
      },
    ];
  });
}

function createThreadTimelineBuildProfileAccumulator(): ThreadTimelineBuildProfileAccumulator {
  return {
    compactedEventCount: 0,
    contextWindowEventDataBytes: 0,
    contextWindowEventRowCount: 0,
    decodedEventCount: 0,
    eventDataBytes: 0,
    eventRowCount: 0,
    projectedRowCount: 0,
    responseRowCount: 0,
    returnedSegmentCount: 0,
    selectionStrategy: "full",
    stageTimings: [],
  };
}

function measureThreadTimelineStage<TResult>(
  profile: ThreadTimelineBuildProfileAccumulator | null,
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
  accumulator: ThreadTimelineBuildProfileAccumulator,
  options: BuildThreadTimelineInternalOptions,
): ThreadTimelineBuildProfile {
  return {
    compactedEventCount: accumulator.compactedEventCount,
    contextWindowEventDataBytes: accumulator.contextWindowEventDataBytes,
    contextWindowEventRowCount: accumulator.contextWindowEventRowCount,
    decodedEventCount: accumulator.decodedEventCount,
    eventDataBytes: accumulator.eventDataBytes,
    eventRowCount: accumulator.eventRowCount,
    pageKind: options.page.kind,
    projectedRowCount: accumulator.projectedRowCount,
    responseRowCount: accumulator.responseRowCount,
    returnedSegmentCount: accumulator.returnedSegmentCount,
    segmentLimit: options.page.segmentLimit,
    selectionStrategy: accumulator.selectionStrategy,
    stageTimings: accumulator.stageTimings,
    totalDurationMs: roundDurationMs(
      accumulator.stageTimings.reduce(
        (total, timing) => total + timing.durationMs,
        0,
      ),
    ),
  };
}

function buildThreadTimelineInternal(
  db: DbConnection,
  thread: Thread,
  options: BuildThreadTimelineInternalOptions,
): BuildThreadTimelineInternalResult {
  const profile = options.includeProfile
    ? createThreadTimelineBuildProfileAccumulator()
    : null;
  const includeNestedRows = options.includeNestedRows ?? false;
  const includeProviderUnhandledOperations =
    options.includeProviderUnhandledOperations;
  const contextBoundarySeq = getLatestCompletedThreadContextClearSequence(db, {
    atOrBeforeSequence: options.maxSeq,
    threadId: thread.id,
  });
  const eventSelection = measureThreadTimelineStage(
    profile,
    "event-query",
    () =>
      selectStandardTimelineEventRows(
        db,
        thread,
        options.page,
        options.eventBudget,
        options.maxInlineOutputChars,
        contextBoundarySeq ?? 0,
      ),
  );
  const rawEventRows = eventSelection.rows;
  if (profile) {
    profile.eventDataBytes = byteLengthOfStoredEventRows(rawEventRows);
    profile.eventRowCount = rawEventRows.length;
    profile.selectionStrategy = eventSelection.strategy;
  }
  const acceptedClientRequestContextRows = measureThreadTimelineStage(
    profile,
    "accepted-client-request-context-query",
    () =>
      selectClientRequestContextRows(db, {
        rows: rawEventRows,
        threadId: thread.id,
      }),
  );
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
        sequenceStart: contextBoundarySeq ?? 0,
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
    includeProviderUnhandledOperations,
    isLatestPage: options.page.kind === "latest",
    providerDisplayName: options.providerDisplayName,
    planCommand: options.planCommand,
    threadStatus: thread.status,
    threadName: thread.title ?? thread.titleFallback ?? "",
    workspaceRoot: resolveThreadWorkspaceRoot(db, thread),
  };
  const contextWindowEvents = measureThreadTimelineStage(
    profile,
    "context-window-json-decode",
    () => contextWindowUsageRows.map((row) => toThreadEventWithMeta(row)),
  );
  const acceptedClientRequestContext: AcceptedClientRequestContext = {
    acceptedClientRequestEvents:
      acceptedClientRequestContextRows.acceptedRows.map((row) =>
        toThreadEventWithMeta(row),
      ),
    rejectedClientRequestEvents:
      acceptedClientRequestContextRows.rejectedRows.map((row) =>
        toThreadEventWithMeta(row),
      ),
  };
  const timeline = measureThreadTimelineStage(
    profile,
    "thread-view-projection",
    () =>
      buildThreadTimelineFromEvents({
        acceptedClientRequestContext,
        contextWindowEvents,
        events: decodedEvents,
        options: {
          ...commonProjectionOptions,
          contextOnlyToolCallIds: eventSelection.contextOnlyToolCallIds,
          includeNestedRows,
          providerId: thread.providerId,
          turnMessageDetail: includeNestedRows ? "full" : "summary",
        },
      }),
  );
  const projectedTimelineRows = buildSequencePageTimelineRows(
    timeline.rows,
    eventSelection,
  );
  if (profile) {
    profile.projectedRowCount = projectedTimelineRows.length;
  }
  const paginatedTimeline = measureThreadTimelineStage(
    profile,
    "pagination-segmentation",
    () =>
      paginateTimelineRows({
        contextBoundarySeq,
        sequenceWindowStart: eventSelection.sequenceWindowStart,
        knownHasOlderSegments: eventSelection.knownHasOlderSegments,
        page: eventSelection.paginationPage,
        rows: projectedTimelineRows,
      }),
  );
  if (profile) {
    profile.responseRowCount = paginatedTimeline.rows.length;
    profile.returnedSegmentCount = paginatedTimeline.returnedSegmentCount;
  }

  const response: ThreadTimelineResponse = {
    maxSeq: options.maxSeq,
    rows: options.summaryOnly ? [] : paginatedTimeline.rows,
    contextBoundarySeq,
    activePromptMode:
      options.page.kind === "latest" ? timeline.activePromptMode : null,
    activeThinking:
      options.page.kind === "latest" ? timeline.activeThinking : null,
    activeWorkflows:
      options.page.kind === "latest" ? timeline.activeWorkflows : [],
    activeBackgroundCommands:
      options.page.kind === "latest" ? timeline.activeBackgroundCommands : [],
    pendingTodos: timeline.pendingTodos,
    goal: timeline.goal,
    modelFallback:
      options.page.kind === "latest" ? timeline.modelFallback : null,
    contextWindowUsage:
      options.page.kind === "latest"
        ? (timeline.contextWindowUsage ?? undefined)
        : undefined,
    timelinePage: {
      kind: eventSelection.responsePageKind,
      segmentLimit: options.page.segmentLimit,
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
        : completeThreadTimelineBuildProfile(profile, options),
  };
}

export function buildThreadTimeline(
  db: DbConnection,
  thread: Thread,
  options: BuildThreadTimelineOptions,
): ThreadTimelineResponse {
  return runEventLoopWorkSync(
    `timeline-build ${thread.id}`,
    () =>
      buildThreadTimelineInternal(db, thread, {
        ...options,
        includeProfile: false,
      }).response,
  );
}

export function buildThreadTimelineWithProfile(
  db: DbConnection,
  thread: Thread,
  options: BuildThreadTimelineOptions,
): { profile: ThreadTimelineBuildProfile; response: ThreadTimelineResponse } {
  return runEventLoopWorkSync(`timeline-build ${thread.id}`, () => {
    const result = buildThreadTimelineInternal(db, thread, {
      ...options,
      includeProfile: true,
    });
    if (result.profile === null) {
      throw new Error("Profiled timeline build returned no profile");
    }
    return { profile: result.profile, response: result.response };
  });
}

interface BuildThreadConversationOutlineOptions {
  maxSeq: number;
  providerDisplayName?: string;
}

interface LoadThreadConversationOutlineOptions extends BuildThreadConversationOutlineOptions {
  outlineSequence: number;
}

const CONVERSATION_OUTLINE_PREVIEW_MAX_LENGTH = 200;
const CONVERSATION_OUTLINE_PROJECTION_VERSION = 1;
const conversationOutlineItemsSchema =
  threadConversationOutlineItemSchema.array();

function toConversationOutlinePreview(text: string): string {
  const normalized = text.replace(/\s+/g, " ").trim();
  if (normalized.length <= CONVERSATION_OUTLINE_PREVIEW_MAX_LENGTH) {
    return normalized;
  }
  return normalized.slice(0, CONVERSATION_OUTLINE_PREVIEW_MAX_LENGTH).trimEnd();
}

function toConversationOutlineAttachmentSummary(
  attachments: TimelineConversationAttachments | null,
): ThreadConversationOutlineAttachmentSummary | null {
  if (!attachments) {
    return null;
  }
  const imageCount = attachments.webImages + attachments.localImages;
  const fileCount = attachments.localFiles;
  if (imageCount === 0 && fileCount === 0) {
    return null;
  }
  return { imageCount, fileCount };
}

export function buildThreadConversationOutline(
  db: DbConnection,
  thread: Thread,
  options: BuildThreadConversationOutlineOptions,
): ThreadConversationOutlineResponse {
  return runEventLoopWorkSync(`conversation-outline ${thread.id}`, () => {
    const contextBoundarySeq = getLatestCompletedThreadContextClearSequence(
      db,
      {
        atOrBeforeSequence: options.maxSeq,
        threadId: thread.id,
      },
    );
    const rawEventRows = listStoredConversationOutlineEventRows(db, {
      sequenceStart: contextBoundarySeq ?? 0,
      threadId: thread.id,
    });
    const decodedRawEvents = rawEventRows.map((row) =>
      toThreadEventWithMeta(row),
    );
    const decodedEvents = compactThreadTimelineSummaryEvents(decodedRawEvents);
    const clientRequestContextRows = selectClientRequestContextRows(db, {
      rows: rawEventRows,
      threadId: thread.id,
    });
    const acceptedClientRequestContext: AcceptedClientRequestContext = {
      acceptedClientRequestEvents: clientRequestContextRows.acceptedRows.map(
        (row) => toThreadEventWithMeta(row),
      ),
      rejectedClientRequestEvents: clientRequestContextRows.rejectedRows.map(
        (row) => toThreadEventWithMeta(row),
      ),
    };
    const timeline = buildThreadTimelineFromEvents({
      acceptedClientRequestContext,
      contextWindowEvents: [],
      events: decodedEvents,
      options: {
        includeNestedRows: false,
        includeProviderUnhandledOperations: false,
        isLatestPage: true,
        providerDisplayName: options.providerDisplayName,
        providerId: thread.providerId,
        threadName: thread.title ?? thread.titleFallback ?? "",
        threadStatus: thread.status,
        turnMessageDetail: "summary",
        workspaceRoot: resolveThreadWorkspaceRoot(db, thread),
      },
    });
    const items: ThreadConversationOutlineItem[] = [];
    for (const row of timeline.rows) {
      if (row.kind !== "conversation") {
        continue;
      }
      items.push({
        id: row.id,
        role: row.role,
        preview: toConversationOutlinePreview(row.text),
        attachmentSummary: toConversationOutlineAttachmentSummary(
          row.attachments,
        ),
      });
    }
    return { items, maxSeq: options.maxSeq };
  });
}

export function buildThreadConversationOutlineProjectionKey(
  thread: Thread,
  outlineSequence: number,
  providerDisplayName: string | undefined,
): string {
  return JSON.stringify([
    CONVERSATION_OUTLINE_PROJECTION_VERSION,
    outlineSequence,
    thread.providerId,
    providerDisplayName ?? null,
    thread.status,
    thread.title,
    thread.titleFallback,
  ]);
}

function parseThreadConversationOutlineItems(
  itemsJson: string,
): ThreadConversationOutlineItem[] | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(itemsJson);
  } catch {
    return null;
  }
  const result = conversationOutlineItemsSchema.safeParse(parsed);
  return result.success ? result.data : null;
}

function shouldMaterializeThreadConversationOutline(thread: Thread): boolean {
  return thread.status === "idle" || thread.status === "error";
}

export function loadThreadConversationOutline(
  db: DbConnection,
  thread: Thread,
  options: LoadThreadConversationOutlineOptions,
): ThreadConversationOutlineResponse {
  const projectionKey = buildThreadConversationOutlineProjectionKey(
    thread,
    options.outlineSequence,
    options.providerDisplayName,
  );
  const stored = getThreadConversationOutlineRecord(db, thread.id);
  if (stored?.projectionKey === projectionKey) {
    const items = parseThreadConversationOutlineItems(stored.itemsJson);
    if (items !== null) {
      return { items, maxSeq: options.maxSeq };
    }
  }

  const response = buildThreadConversationOutline(db, thread, options);
  if (shouldMaterializeThreadConversationOutline(thread)) {
    upsertThreadConversationOutlineRecord(db, {
      itemsJson: JSON.stringify(response.items),
      projectionKey,
      threadId: thread.id,
    });
  }
  return response;
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

  const includeProviderUnhandledOperations =
    options.includeProviderUnhandledOperations;
  const detailsWindow = {
    beforeSequence: options.sourceSeqEnd + 1,
    excludedTypes: THREAD_TIMELINE_EXCLUDED_EVENT_TYPES,
    sequenceStart: options.sourceSeqStart,
    threadId: thread.id,
  };
  const fullDetailsFloor = findStoredTimelineWindowByteBudgetFloor(db, {
    ...detailsWindow,
    maxDataBytes: THREAD_TIMELINE_EVENT_DATA_BYTE_LIMIT,
    maxInlineOutputChars: null,
  });
  let detailsInlineOutputLimit: InlineOutputCharLimit = null;
  if (fullDetailsFloor.kind !== "fits") {
    detailsInlineOutputLimit = DEFAULT_MAX_INLINE_OUTPUT_CHARS;
    const cappedDetailsFloor = findStoredTimelineWindowByteBudgetFloor(db, {
      ...detailsWindow,
      maxDataBytes: THREAD_TIMELINE_EVENT_DATA_BYTE_LIMIT,
      maxInlineOutputChars: detailsInlineOutputLimit,
    });
    if (cappedDetailsFloor.kind !== "fits") {
      throw new ApiError(
        413,
        "timeline_window_too_large",
        "Timeline turn details exceed the safe response limit",
      );
    }
  }
  const exactEventRows = listStoredTimelineWindowEventRows(db, {
    ...detailsWindow,
    maxInlineOutputChars: detailsInlineOutputLimit,
  });
  const clientRequestIds = listStoredClientTurnRequestIdsInRange(db, {
    threadId: thread.id,
    seqStart: options.sourceSeqStart,
    seqEnd: options.sourceSeqEnd,
  });
  const exactAcceptedInputRows = exactEventRows.filter(
    (row) => row.type === "turn/input/accepted",
  );
  const futureAcceptedInputRows =
    listStoredTurnInputAcceptedRowsByClientRequestIds(db, {
      threadId: thread.id,
      afterSequence: options.sourceSeqEnd,
      clientRequestIds,
    });
  const acceptedInputRowsByTurn = partitionAcceptedInputRowsByRequestedTurn({
    acceptedInputRows: [...exactAcceptedInputRows, ...futureAcceptedInputRows],
    turnId: options.turnId,
  });
  const exactEventRowsForRequestedTurn = filterExactEventRowsForRequestedTurn({
    acceptedClientRequestIdsForOtherTurns:
      acceptedInputRowsByTurn.acceptedClientRequestIdsForOtherTurns,
    exactEventRows,
    turnId: options.turnId,
  });
  const eventRows = mergeStoredEventRowsById([
    ...exactEventRowsForRequestedTurn.rows,
    ...acceptedInputRowsByTurn.requestedTurnRows,
  ]);

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
  const requestedTurnStartedRows = hasCurrentStartedRow
    ? []
    : listStoredTurnStartedRowsByTurnIdsUpToSequence(db, {
        threadId: thread.id,
        sequenceCutoff: contextSequenceCutoff,
        turnIds: [options.turnId],
      });
  if (!hasCurrentStartedRow && requestedTurnStartedRows.length === 0) {
    throw new ApiError(
      400,
      "invalid_request",
      `Timeline turn summary details range ${options.sourceSeqStart}-${options.sourceSeqEnd} cannot resolve turn/started for ${options.turnId}`,
    );
  }
  const sourceRange = resolveTurnSummaryDetailsSourceRange({
    exactEventRows: exactEventRowsForRequestedTurn.rows,
    fallbackRange: {
      sourceSeqEnd: options.sourceSeqEnd,
      sourceSeqStart: options.sourceSeqStart,
      turnId: options.turnId,
    },
    useExactEventRowBounds: exactEventRowsForRequestedTurn.removedRows,
  });
  const wholeItemEventRows = ensureSequenceWindowWholeItemRows(db, {
    beforeSequence: detailsWindow.beforeSequence,
    maxInlineOutputChars: detailsInlineOutputLimit,
    rows: mergeStoredEventRowsById([...requestedTurnStartedRows, ...eventRows]),
    sequenceStart: detailsWindow.sequenceStart,
    threadId: thread.id,
  });
  const detailsEventDataBytes = byteLengthOfStoredEventRows(wholeItemEventRows);
  const eventRowsWithParentedChildren = ensureTimelineWindowParentedRows(db, {
    maxInlineOutputChars: detailsInlineOutputLimit,
    outOfBoundsChildDataByteLimit:
      THREAD_TIMELINE_EVENT_DATA_BYTE_LIMIT - detailsEventDataBytes,
    sequenceBounds: {
      beforeSequence: detailsWindow.beforeSequence,
      sequenceStart: detailsWindow.sequenceStart,
    },
    threadId: thread.id,
    rows: wholeItemEventRows,
  }).rows;
  const eventRowsWithTurnStarts = ensureTimelineWindowTurnStartedRows(db, {
    threadId: thread.id,
    rows: eventRowsWithParentedChildren,
  });
  const eventRowsWithBackgroundTaskState =
    ensureTimelineWindowBackgroundTaskStateRows(db, {
      threadId: thread.id,
      rows: eventRowsWithTurnStarts,
    });
  const projectionSourceSeqStart = eventRowsWithTurnStarts.reduce(
    (sourceSeqStart, row) =>
      row.type === "turn/started" && row.turnId === options.turnId
        ? Math.min(sourceSeqStart, row.sequence)
        : sourceSeqStart,
    sourceRange.sourceSeqStart,
  );
  const children = buildThreadTimelineTurnDetailsFromEvents({
    events: eventRowsWithBackgroundTaskState.map((row) =>
      toThreadEventWithMeta(row),
    ),
    options: {
      includeProviderUnhandledOperations,
      sourceSeqEnd: sourceRange.sourceSeqEnd,
      sourceSeqStart: projectionSourceSeqStart,
      providerDisplayName: options.providerDisplayName,
      threadStatus: thread.status,
      threadName: thread.title ?? thread.titleFallback ?? "",
      workspaceRoot: resolveThreadWorkspaceRoot(db, thread),
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
