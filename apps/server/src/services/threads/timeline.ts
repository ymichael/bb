import {
  buildThreadTimelineFromEvents,
  THREAD_TIMELINE_EXCLUDED_EVENT_TYPES,
  buildThreadTimelineTurnDetailsFromEvents,
  compactThreadTimelineSummaryEvents,
  type SystemClientRequestVisibility,
  type ThreadEventWithMeta,
} from "@bb/thread-view";
import type { Thread } from "@bb/domain";
import type {
  ManagerTimelineView,
  ThreadTimelineResponse,
  TimelineRow,
  TimelineTurnSummaryDetailsResponse,
} from "@bb/server-contract";
import {
  listContextWindowUsageRows,
  listRecentStoredEventRows,
  listStoredEventRowsInRange,
  listStoredTurnInputAcceptedRowsByClientRequestSequences,
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

interface BuildThreadTimelineOptions {
  isDevelopment: boolean;
  includeNestedRows?: boolean;
  timelineViewMode: ThreadTimelineServiceViewMode;
}

interface BuildTimelineTurnSummaryDetailsOptions
  extends TimelineTurnSummarySelection {
  isDevelopment: boolean;
  timelineViewMode: ThreadTimelineServiceViewMode;
}

export type ThreadTimelineServiceViewMode = "manager-conversation" | "standard";

export const THREAD_TIMELINE_OLDER_ROW_LIMIT = 100;

export interface ResolveThreadTimelineServiceViewModeArgs {
  managerTimelineView: ManagerTimelineView | undefined;
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

function capLatestTimelineRows(
  rows: readonly TimelineRow[],
): TimelineRow[] {
  const activeTailStartIndex = rows.findIndex(isActiveTopLevelTimelineRow);
  if (activeTailStartIndex === -1) {
    return rows.slice(-THREAD_TIMELINE_OLDER_ROW_LIMIT);
  }

  const olderRows = rows.slice(0, activeTailStartIndex);
  const activeTailRows = rows.slice(activeTailStartIndex);
  return [
    ...olderRows.slice(-THREAD_TIMELINE_OLDER_ROW_LIMIT),
    ...activeTailRows,
  ];
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

  return {
    rows: capLatestTimelineRows(timeline.rows),
    activeThinking: timeline.activeThinking,
    contextWindowUsage: timeline.contextWindowUsage ?? undefined,
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
  const clientRequestSequences = Array.from(
    new Set(
      exactEventRows.flatMap((row) =>
        row.type === "client/turn/requested" ? [row.sequence] : [],
      ),
    ),
  );
  const acceptedInputRows =
    listStoredTurnInputAcceptedRowsByClientRequestSequences(db, {
      threadId: thread.id,
      afterSequence: options.sourceSeqEnd,
      clientRequestSequences,
    });
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
