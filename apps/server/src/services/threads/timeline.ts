import {
  buildTimelineRows,
  extractThreadContextWindowUsage,
  flattenProjectionMessagesDeep,
  TIMELINE_NOISE_EVENT_TYPES,
  toViewProjectionEntries,
  toViewProjection,
  type ThreadEventWithMeta,
} from "@bb/thread-view";
import type {
  Thread,
  ViewMessage,
  ViewProjection,
  ViewTimelineEntry,
} from "@bb/domain";
import {
  createBufferedTextInstanceKey,
  resolveBufferedTextIdentity,
} from "@bb/domain";
import type {
  ThreadTimelineResponse,
  TimelineRow,
  TimelineTurnSummaryDetailsResponse,
} from "@bb/server-contract";
import {
  listContextWindowUsageRows,
  listRecentStoredEventRows,
  listStoredEventRowsInRange,
  listStoredTurnInputAcceptedRowsByClientRequestSequences,
} from "@bb/db";
import type { DbConnection, StoredEventRow } from "@bb/db";
import { parseStoredEvent, parseStoredEventRow } from "./thread-data.js";

const MIN_AGENT_MESSAGE_DELTAS_FOR_SUMMARY_COMPACTION = 1000;

interface TimelineSourceSeqRange {
  sourceSeqEnd: number;
  sourceSeqStart: number;
}

interface BuildThreadTimelineOptions {
  isDevelopment: boolean;
  showAllManagerEvents?: boolean;
  includeNestedRows?: boolean;
}

interface BuildTimelineTurnSummaryDetailsOptions extends TimelineSourceSeqRange {
  isDevelopment: boolean;
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

function buildManagerConversationRows(
  projection: ViewProjection,
): TimelineRow[] {
  const entries: ViewTimelineEntry[] = flattenProjectionMessagesDeep(projection)
    .filter(isManagerConversationMessage)
    .map((message) => ({ kind: "message", message }));
  return buildTimelineRows({
    entries,
    state: projection.state,
  });
}

type TimelineTurnRow = Extract<TimelineRow, { kind: "turn" }>;

function findMatchingTurnSummaryRow(
  rows: TimelineRow[],
  options: TimelineSourceSeqRange,
): TimelineTurnRow | null {
  return (
    rows.find(
      (row): row is TimelineTurnRow =>
        row.kind === "turn" &&
        row.sourceSeqStart === options.sourceSeqStart &&
        row.sourceSeqEnd === options.sourceSeqEnd,
    ) ?? null
  );
}

function hasTurnSummaryRows(rows: TimelineRow[]): boolean {
  return rows.some((row) => row.kind === "turn");
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
      rows: matchingTurnSummary.children ?? [],
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
  const includeProviderUnhandledOperations =
    options.isDevelopment || options.showAllManagerEvents === true;
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
  const contextWindowUsageRows = listContextWindowUsageRows(db, {
    threadId: thread.id,
  });

  if (isDefaultManagerView) {
    const projection = toViewProjectionEntries(decodedEvents, {
      includeInternalSystemMessages: options.showAllManagerEvents,
      includeProviderUnhandledOperations,
      threadStatus: thread.status,
      threadType: thread.type,
      turnMessageDetail: "full",
    });
    return {
      rows: buildManagerConversationRows(projection),
      activeThinking: null,
      contextWindowUsage:
        extractThreadContextWindowUsage(
          contextWindowUsageRows.map((row) => parseStoredEventRow(row)),
        ) ?? undefined,
    };
  }

  const projection = toViewProjection(decodedEvents, {
    includeInternalSystemMessages: options.showAllManagerEvents,
    includeProviderUnhandledOperations,
    threadStatus: thread.status,
    threadType: thread.type,
    turnMessageDetail: includeNestedRows ? "full" : "summary",
  });
  const rows = buildTimelineRows(projection, {
    includeNestedRows,
  });

  return {
    rows,
    activeThinking: projection.state.activeThinking,
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
  const includeProviderUnhandledOperations =
    options.isDevelopment || options.showAllManagerEvents === true;
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
  const projection = toViewProjectionEntries(
    [...exactEventRows, ...acceptedInputRows].map((row) =>
      toThreadEventWithMeta(row),
    ),
    {
      includeInternalSystemMessages: options.showAllManagerEvents,
      includeProviderUnhandledOperations,
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

  throw new Error(
    `Timeline turn summary details could not match range ${options.sourceSeqStart}-${options.sourceSeqEnd}`,
  );
}
