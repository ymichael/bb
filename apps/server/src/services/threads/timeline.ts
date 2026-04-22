import {
  buildTimelineRows,
  extractActiveThinking,
  extractThreadContextWindowUsage,
  flattenViewMessagesDeep,
  TIMELINE_NOISE_EVENT_TYPES,
  toViewMessages,
  toViewProjection,
  type ThreadEventWithMeta,
} from "@bb/core-ui";
import type {
  Thread,
  TimelineRow,
  ViewMessage,
  ViewProjection,
} from "@bb/domain";
import {
  createBufferedTextInstanceKey,
  resolveBufferedTextIdentity,
} from "@bb/domain";
import type {
  ThreadTimelineResponse,
  TimelineTurnSummaryDetailsResponse,
} from "@bb/server-contract";
import {
  listContextWindowUsageRows,
  listRecentStoredEventRows,
  listStoredEventRows,
  listStoredEventRowsInRange,
} from "@bb/db";
import type { DbConnection, StoredEventRow } from "@bb/db";
import { parseStoredEvent, parseStoredEventRow } from "./thread-data.js";

const MIN_AGENT_MESSAGE_DELTAS_FOR_SUMMARY_COMPACTION = 1000;
const TURN_SUMMARY_DETAILS_LOOKAHEAD_BATCH_SIZE = 25;
const TURN_SUMMARY_DETAILS_MAX_LOOKAHEAD_ROWS = 100;

interface TimelineSourceSeqRange {
  sourceSeqEnd: number;
  sourceSeqStart: number;
}

type TimelineMessageRow = Extract<TimelineRow, { kind: "message" }>;

interface BuildThreadTimelineOptions {
  showAllManagerEvents?: boolean;
  includeNestedRows?: boolean;
}

interface BuildTimelineTurnSummaryDetailsOptions extends TimelineSourceSeqRange {
  showAllManagerEvents?: boolean;
}

type TimelineTurnSummaryDetailsResolution =
  | {
      kind: "matched";
      rows: TimelineRow[];
    }
  | {
      kind: "missing-match";
    }
  | {
      kind: "ungrouped";
      rows: TimelineRow[];
    };

/**
 * For manager threads in the default (non-debug) view, only show user messages,
 * message_user output, and lifecycle operations (provisioning, compaction).
 * Everything else (assistant text, delegations, other tool calls, etc.) is
 * internal manager machinery.
 */
function isManagerConversationMessage(message: ViewMessage): boolean {
  if (message.kind === "user") return true;
  if (message.kind === "operation") return true;
  if (
    message.kind === "assistant-text" &&
    message.isManagerUserMessage === true
  ) {
    return true;
  }
  return false;
}

function toTimelineMessageRow(message: ViewMessage): TimelineMessageRow {
  return {
    kind: "message",
    id: message.id,
    message,
  };
}

function buildManagerConversationRows(
  messages: ViewMessage[],
): TimelineMessageRow[] {
  const visibleMessages = flattenViewMessagesDeep(messages).filter(
    isManagerConversationMessage,
  );
  return visibleMessages.map((message) => toTimelineMessageRow(message));
}

type TimelineTurnSummaryRow = Extract<TimelineRow, { kind: "turn-summary" }>;

function findMatchingTurnSummaryRow(
  rows: TimelineRow[],
  options: TimelineSourceSeqRange,
): TimelineTurnSummaryRow | null {
  return (
    rows.find(
      (row): row is TimelineTurnSummaryRow =>
        row.kind === "turn-summary" &&
        row.sourceSeqStart === options.sourceSeqStart &&
        row.sourceSeqEnd === options.sourceSeqEnd,
    ) ?? null
  );
}

function hasTurnSummaryRows(rows: TimelineRow[]): boolean {
  return rows.some((row) => row.kind === "turn-summary");
}

function resolveTimelineTurnSummaryDetailsRows(
  projection: ViewProjection,
  options: TimelineSourceSeqRange,
): TimelineTurnSummaryDetailsResolution {
  const nestedRows = buildTimelineRows(projection, {
    includeNestedRows: true,
  });
  const matchingTurnSummary = findMatchingTurnSummaryRow(nestedRows, options);
  if (matchingTurnSummary) {
    return {
      kind: "matched",
      rows: matchingTurnSummary.rows ?? [],
    };
  }

  if (hasTurnSummaryRows(nestedRows)) {
    return {
      kind: "missing-match",
    };
  }

  return {
    kind: "ungrouped",
    rows: nestedRows,
  };
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

function compactSummaryThreadEvents(
  events: ThreadEventWithMeta[],
): ThreadEventWithMeta[] {
  let agentMessageDeltaCount = 0;
  const completedAssistantKeys = new Set<string>();
  for (const eventWithMeta of events) {
    const { event } = eventWithMeta;
    if (event.type === "item/agentMessage/delta") {
      agentMessageDeltaCount += 1;
      continue;
    }
    if (event.type === "item/completed" && event.item.type === "agentMessage") {
      const identity = resolveBufferedTextIdentity({
        decoded: event,
        kind: "assistant",
      });
      if (identity) {
        completedAssistantKeys.add(createBufferedTextInstanceKey(identity));
      }
    }
  }

  if (
    agentMessageDeltaCount < MIN_AGENT_MESSAGE_DELTAS_FOR_SUMMARY_COMPACTION ||
    completedAssistantKeys.size === 0
  ) {
    return events;
  }

  const retainedCompletedDeltaKeys = new Set<string>();
  const compactedEvents: ThreadEventWithMeta[] = [];

  for (const eventWithMeta of events) {
    const { event } = eventWithMeta;
    if (event.type !== "item/agentMessage/delta") {
      compactedEvents.push(eventWithMeta);
      continue;
    }

    const identity = resolveBufferedTextIdentity({
      decoded: event,
      kind: "assistant",
    });
    if (!identity) {
      compactedEvents.push(eventWithMeta);
      continue;
    }

    const assistantKey = createBufferedTextInstanceKey(identity);
    if (!completedAssistantKeys.has(assistantKey)) {
      compactedEvents.push(eventWithMeta);
      continue;
    }
    if (retainedCompletedDeltaKeys.has(assistantKey)) {
      continue;
    }
    retainedCompletedDeltaKeys.add(assistantKey);
    compactedEvents.push(eventWithMeta);
  }

  return compactedEvents;
}

export function compactSummaryStoredEventRows(
  rows: readonly StoredEventRow[],
): readonly StoredEventRow[] {
  const events = rows.map((row) => toThreadEventWithMeta(row));
  const compactedEvents = compactSummaryThreadEvents(events);
  if (compactedEvents === events) {
    return rows;
  }

  const retainedEventIds = new Set(
    compactedEvents.map((eventWithMeta) => eventWithMeta.meta.id),
  );
  return rows.filter((row) => retainedEventIds.has(row.id));
}

export function buildThreadTimeline(
  db: DbConnection,
  thread: Thread,
  options: BuildThreadTimelineOptions,
): ThreadTimelineResponse {
  const includeNestedRows = options.includeNestedRows ?? false;
  const rawEventRows = listRecentStoredEventRows(db, {
    threadId: thread.id,
    ...(options.showAllManagerEvents === true
      ? {}
      : { excludedTypes: TIMELINE_NOISE_EVENT_TYPES }),
  });
  const decodedRawEvents = rawEventRows.map((row) =>
    toThreadEventWithMeta(row),
  );
  const decodedEvents = compactSummaryThreadEvents(decodedRawEvents);
  const isDefaultManagerView =
    thread.type === "manager" && !options.showAllManagerEvents;
  const activeThinking = extractActiveThinking(
    toViewMessages(decodedEvents, {
      includeInternalSystemMessages: options.showAllManagerEvents,
      threadStatus: thread.status,
      threadType: thread.type,
    }),
  );
  const rows = isDefaultManagerView
    ? buildManagerConversationRows(
        toViewMessages(decodedEvents, {
          includeInternalSystemMessages: options.showAllManagerEvents,
          threadStatus: thread.status,
          threadType: thread.type,
        }),
      )
    : buildTimelineRows(
        toViewProjection(decodedEvents, {
          includeInternalSystemMessages: options.showAllManagerEvents,
          threadStatus: thread.status,
          threadType: thread.type,
          turnMessageDetail: "summary",
        }),
        {
          includeNestedRows,
        },
      );
  const contextWindowUsageRows = listContextWindowUsageRows(db, {
    threadId: thread.id,
  });

  return {
    rows,
    activeThinking,
    contextWindowUsage:
      extractThreadContextWindowUsage(
        contextWindowUsageRows.map((row) => parseStoredEventRow(row)),
      ) ?? undefined,
  };
}

export function buildTimelineTurnSummaryDetails(
  db: DbConnection,
  thread: Thread,
  options: BuildTimelineTurnSummaryDetailsOptions,
): TimelineTurnSummaryDetailsResponse {
  const exactEventRows = listStoredEventRowsInRange(db, {
    threadId: thread.id,
    seqStart: options.sourceSeqStart,
    seqEnd: options.sourceSeqEnd,
  });
  const lookaheadEventRows: StoredEventRow[] = [];
  let afterSequence = options.sourceSeqEnd;

  for (;;) {
    const projection = toViewProjection(
      [...exactEventRows, ...lookaheadEventRows].map((row) =>
        toThreadEventWithMeta(row),
      ),
      {
        includeInternalSystemMessages: options.showAllManagerEvents,
        threadStatus: thread.status,
        threadType: thread.type,
        turnMessageDetail: "full",
      },
    );
    const resolution = resolveTimelineTurnSummaryDetailsRows(projection, {
      sourceSeqStart: options.sourceSeqStart,
      sourceSeqEnd: options.sourceSeqEnd,
    });

    if (resolution.kind !== "missing-match") {
      return {
        rows: resolution.rows,
      };
    }

    const remainingLookaheadRows =
      TURN_SUMMARY_DETAILS_MAX_LOOKAHEAD_ROWS - lookaheadEventRows.length;
    if (remainingLookaheadRows <= 0) {
      break;
    }

    // A client/turn/requested event can only be assigned to its turn after a
    // later turn/input/accepted event is decoded. Fetch post-range rows in
    // batches so unrelated stored events between those two do not break
    // turn-summary expansion.
    const nextLookaheadRows = listStoredEventRows(db, {
      threadId: thread.id,
      afterSequence,
      limit: Math.min(
        TURN_SUMMARY_DETAILS_LOOKAHEAD_BATCH_SIZE,
        remainingLookaheadRows,
      ),
    });
    if (nextLookaheadRows.length === 0) {
      break;
    }

    lookaheadEventRows.push(...nextLookaheadRows);
    afterSequence = nextLookaheadRows[nextLookaheadRows.length - 1]!.sequence;
  }

  throw new Error(
    `Timeline turn summary details could not match range ${options.sourceSeqStart}-${options.sourceSeqEnd}`,
  );
}
