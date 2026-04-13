import {
  buildTimelineRows,
  extractThreadContextWindowUsage,
  TIMELINE_NOISE_EVENT_TYPES,
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

function filterManagerConversationRows(rows: TimelineRow[]): TimelineRow[] {
  return rows.filter(
    (row): row is Extract<TimelineRow, { kind: "message" }> =>
      row.kind === "message" && isManagerConversationMessage(row.message),
  );
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
  const projection = toViewProjection(
    eventRows.map((row) => toThreadEventWithMeta(row)),
    {
      includeInternalSystemMessages: options.showAllManagerEvents,
      threadStatus: thread.status,
      threadType: thread.type,
      turnMessageDetail: "summary",
    },
  );
  const allRows = buildTimelineRows(projection, {
    includeToolGroupMessages: options.includeToolGroupMessages ?? false,
  });
  const rows =
    thread.type === "manager" && !options.showAllManagerEvents
      ? filterManagerConversationRows(allRows)
      : allRows;
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
  const matchingToolGroup = findMatchingToolGroupRow(rows, {
    sourceSeqStart: options.sourceSeqStart,
    sourceSeqEnd: options.sourceSeqEnd,
  });

  return {
    messages: matchingToolGroup?.messages ?? flattenProjectionMessages(projection),
  };
}
