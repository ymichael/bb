import {
  buildManagerTimelineRowsFromEvents,
  buildTimelineRowsFromEvents,
  extractThreadContextWindowUsage,
  TIMELINE_NOISE_EVENT_TYPES,
  resolveTimelineTurnSummaryDetailsFromEvents,
  type ThreadEventWithMeta,
} from "@bb/thread-view";
import type { Thread } from "@bb/domain";
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
    const timeline = buildManagerTimelineRowsFromEvents({
      events: decodedEvents,
      options: {
        includeInternalSystemMessages: options.showAllManagerEvents,
        includeProviderUnhandledOperations,
        threadStatus: thread.status,
        threadType: thread.type,
        turnMessageDetail: "full",
      },
    });
    return {
      rows: timeline.rows,
      activeThinking: timeline.activeThinking,
      contextWindowUsage:
        extractThreadContextWindowUsage(
          contextWindowUsageRows.map((row) => parseStoredEventRow(row)),
        ) ?? undefined,
    };
  }

  const timeline = buildTimelineRowsFromEvents({
    events: decodedEvents,
    options: {
      includeInternalSystemMessages: options.showAllManagerEvents,
      includeNestedRows,
      includeProviderUnhandledOperations,
      threadStatus: thread.status,
      threadType: thread.type,
      turnMessageDetail: includeNestedRows ? "full" : "summary",
    },
  });

  return {
    rows: timeline.rows,
    activeThinking: timeline.activeThinking,
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
  const resolution = resolveTimelineTurnSummaryDetailsFromEvents({
    events: [...exactEventRows, ...acceptedInputRows].map((row) =>
      toThreadEventWithMeta(row),
    ),
    options: {
      includeInternalSystemMessages: options.showAllManagerEvents,
      includeProviderUnhandledOperations,
      sourceSeqEnd: options.sourceSeqEnd,
      sourceSeqStart: options.sourceSeqStart,
      threadStatus: thread.status,
      threadType: thread.type,
      turnMessageDetail: "full",
    },
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
