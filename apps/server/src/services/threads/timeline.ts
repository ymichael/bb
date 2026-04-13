import {
  buildTimelineRows,
  buildTimelineRowsFromMessagesForNestedDisplay,
  extractThreadContextWindowUsage,
  TIMELINE_NOISE_EVENT_TYPES,
  toViewProjection,
  toViewMessages,
  type ThreadEventWithMeta,
} from "@bb/core-ui";
import type {
  Thread,
  TimelineRow,
  TimelineToolGroupRow,
  ViewMessage,
  ViewProjection,
} from "@bb/domain";
import type {
  ThreadTimelineResponse,
  TimelineToolDetailsResponse,
} from "@bb/server-contract";
import {
  listContextWindowUsageRows,
  listRecentStoredEventRows,
  listStoredEventRowsInRange,
} from "@bb/db";
import type { DbConnection, StoredEventRow } from "@bb/db";
import {
  parseStoredEvent,
  parseStoredEventRow,
} from "./thread-data.js";

const MIN_AGENT_MESSAGE_DELTAS_FOR_SUMMARY_COMPACTION = 1000;

interface TimelineSourceSeqRange {
  sourceSeqEnd: number;
  sourceSeqStart: number;
}

type TimelineMessageRow = Extract<TimelineRow, { kind: "message" }>;

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

function flattenTimelineRowsToMessageRows(
  rows: TimelineRow[],
): TimelineMessageRow[] {
  const messageRows: TimelineMessageRow[] = [];
  for (const row of rows) {
    if (row.kind === "message") {
      messageRows.push(row);
      continue;
    }
    for (const message of row.messages) {
      messageRows.push(toTimelineMessageRow(message));
    }
  }
  return messageRows;
}

function buildManagerConversationRows(
  messages: ViewMessage[],
): TimelineMessageRow[] {
  const visibleMessages = messages.filter(isManagerConversationMessage);
  const rows = buildTimelineRowsFromMessagesForNestedDisplay(visibleMessages, {
    includeToolGroupMessages: true,
  });
  return flattenTimelineRowsToMessageRows(rows);
}

function flattenProjectionMessages(projection: ViewProjection): ViewMessage[] {
  const messages: ViewMessage[] = [];
  for (const entry of projection.entries) {
    if (entry.kind === "message") {
      messages.push(entry.message);
      continue;
    }
    if (entry.turn.messages) {
      messages.push(...entry.turn.messages);
      continue;
    }
    if (entry.turn.terminalMessage) {
      messages.push(entry.turn.terminalMessage);
    }
  }
  return messages;
}

function findMatchingToolGroupRow(
  rows: TimelineRow[],
  options: TimelineSourceSeqRange,
): TimelineToolGroupRow | null {
  return rows.find(
    (row): row is TimelineToolGroupRow =>
      row.kind === "tool-group" &&
      row.sourceSeqStart === options.sourceSeqStart &&
      row.sourceSeqEnd === options.sourceSeqEnd,
  ) ?? null;
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

export function compactSummaryStoredEventRows(
  rows: readonly StoredEventRow[],
): readonly StoredEventRow[] {
  let agentMessageDeltaCount = 0;
  const completedAgentMessageItemIds = new Set<string>();
  for (const row of rows) {
    if (row.type === "item/agentMessage/delta") {
      agentMessageDeltaCount += 1;
      continue;
    }
    if (
      row.type === "item/completed" &&
      row.itemKind === "agentMessage" &&
      row.itemId
    ) {
      completedAgentMessageItemIds.add(row.itemId);
    }
  }

  if (
    agentMessageDeltaCount < MIN_AGENT_MESSAGE_DELTAS_FOR_SUMMARY_COMPACTION ||
    completedAgentMessageItemIds.size === 0
  ) {
    return rows;
  }

  const retainedCompletedDeltaItemIds = new Set<string>();
  const compactedRows: StoredEventRow[] = [];

  for (const row of rows) {
    const itemId =
      row.type === "item/agentMessage/delta"
        ? row.itemId
        : null;
    if (!itemId || !completedAgentMessageItemIds.has(itemId)) {
      compactedRows.push(row);
      continue;
    }
    if (retainedCompletedDeltaItemIds.has(itemId)) {
      continue;
    }
    retainedCompletedDeltaItemIds.add(itemId);
    compactedRows.push(row);
  }

  return compactedRows;
}

export function buildThreadTimeline(
  db: DbConnection,
  thread: Thread,
  options: {
    showAllManagerEvents?: boolean;
    includeToolGroupMessages?: boolean;
  },
): ThreadTimelineResponse {
  const rawEventRows = listRecentStoredEventRows(db, {
    threadId: thread.id,
    ...(options.showAllManagerEvents === true
      ? {}
      : { excludedTypes: TIMELINE_NOISE_EVENT_TYPES }),
  });
  const eventRows = compactSummaryStoredEventRows(rawEventRows);
  const isDefaultManagerView =
    thread.type === "manager" && !options.showAllManagerEvents;
  const decodedEvents = eventRows.map((row) => toThreadEventWithMeta(row));
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
    contextWindowUsage:
      extractThreadContextWindowUsage(
        contextWindowUsageRows.map((row) => parseStoredEventRow(row)),
      ) ?? undefined,
  };
}

export function buildTimelineToolDetails(
  db: DbConnection,
  thread: Thread,
  options: {
    showAllManagerEvents?: boolean;
    sourceSeqEnd: number;
    sourceSeqStart: number;
  },
): TimelineToolDetailsResponse {
  const eventRows = listStoredEventRowsInRange(db, {
    threadId: thread.id,
    seqStart: options.sourceSeqStart,
    seqEnd: options.sourceSeqEnd,
  });

  const projection = toViewProjection(
    eventRows.map((row) => toThreadEventWithMeta(row)),
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

  return {
    messages: resolveTimelineToolDetailsMessages(
      rows,
      projection,
      {
        sourceSeqStart: options.sourceSeqStart,
        sourceSeqEnd: options.sourceSeqEnd,
      },
    ),
  };
}
