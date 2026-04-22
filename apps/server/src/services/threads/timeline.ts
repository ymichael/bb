import {
  buildTimelineRows,
  extractActiveThinking,
  extractThreadContextWindowUsage,
  flattenProjectionMessages,
  flattenViewMessagesDeep,
  TIMELINE_NOISE_EVENT_TYPES,
  toViewMessages,
  toViewProjection,
  type ThreadEventWithMeta,
} from "@bb/core-ui";
import type {
  Thread,
  TimelineRow,
  TimelineToolGroupRow,
  ViewMessage,
  ViewProjection,
} from "@bb/domain";
import {
  createBufferedTextInstanceKey,
  resolveBufferedTextIdentity,
} from "@bb/domain";
import type {
  ThreadTimelineResponse,
  TimelineToolDetailsResponse,
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

interface TimelineSourceSeqRange {
  sourceSeqEnd: number;
  sourceSeqStart: number;
}

type TimelineMessageRow = Extract<TimelineRow, { kind: "message" }>;

interface BuildThreadTimelineOptions {
  showAllManagerEvents?: boolean;
  includeToolGroupMessages?: boolean;
}

interface BuildTimelineToolDetailsOptions extends TimelineSourceSeqRange {
  showAllManagerEvents?: boolean;
}

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

function findMatchingToolGroupRow(
  rows: TimelineRow[],
  options: TimelineSourceSeqRange,
): TimelineToolGroupRow | null {
  return (
    rows.find(
      (row): row is TimelineToolGroupRow =>
        row.kind === "tool-group" &&
        row.sourceSeqStart === options.sourceSeqStart &&
        row.sourceSeqEnd === options.sourceSeqEnd,
    ) ?? null
  );
}

function hasToolGroupRows(rows: TimelineRow[]): boolean {
  return rows.some((row) => row.kind === "tool-group");
}

function resolveTimelineToolDetailsMessages(
  rows: TimelineRow[],
  projection: ViewProjection,
  options: TimelineSourceSeqRange,
): ViewMessage[] {
  const matchingToolGroup = findMatchingToolGroupRow(rows, options);
  if (matchingToolGroup) {
    return matchingToolGroup.messages;
  }

  if (hasToolGroupRows(rows)) {
    throw new Error(
      `Timeline tool details could not match tool group range ${options.sourceSeqStart}-${options.sourceSeqEnd}`,
    );
  }

  return flattenProjectionMessages(projection);
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
          includeToolGroupMessages: options.includeToolGroupMessages ?? false,
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

export function buildTimelineToolDetails(
  db: DbConnection,
  thread: Thread,
  options: BuildTimelineToolDetailsOptions,
): TimelineToolDetailsResponse {
  const exactEventRows = listStoredEventRowsInRange(db, {
    threadId: thread.id,
    seqStart: options.sourceSeqStart,
    seqEnd: options.sourceSeqEnd,
  });

  const lookaheadEventRows = listStoredEventRows(db, {
    threadId: thread.id,
    afterSequence: options.sourceSeqEnd,
    limit: 1,
  });
  // A client/turn/requested event can only be assigned to its turn after the
  // immediately following turn/input/accepted event is decoded. Summary rows
  // are built from the full event stream, so include one lookahead row here to
  // reconstruct the same tool-group bounds for expansion.
  const eventRowsWithLookahead = [...exactEventRows, ...lookaheadEventRows];

  const projection = toViewProjection(
    eventRowsWithLookahead.map((row) => toThreadEventWithMeta(row)),
    {
      includeInternalSystemMessages: options.showAllManagerEvents,
      threadStatus: thread.status,
      threadType: thread.type,
      turnMessageDetail: "full",
    },
  );
  const rows = buildTimelineRows(projection, {
    includeToolGroupMessages: true,
  });

  const exactProjection = toViewProjection(
    exactEventRows.map((row) => toThreadEventWithMeta(row)),
    {
      includeInternalSystemMessages: options.showAllManagerEvents,
      threadStatus: thread.status,
      threadType: thread.type,
      turnMessageDetail: "full",
    },
  );

  return {
    messages: resolveTimelineToolDetailsMessages(rows, exactProjection, {
      sourceSeqStart: options.sourceSeqStart,
      sourceSeqEnd: options.sourceSeqEnd,
    }),
  };
}
