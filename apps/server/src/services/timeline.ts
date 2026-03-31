import {
  buildTimelineRows,
  decodeRow,
  extractThreadContextWindowUsage,
  toViewMessages,
} from "@bb/core-ui";
import type { Thread } from "@bb/domain";
import type {
  ThreadTimelineResponse,
  TimelineToolDetailsResponse,
} from "@bb/server-contract";
import type { DbConnection } from "@bb/db";
import {
  decodeEventRow,
  type StoredEventRow,
  getLatestStoredEventRowByType,
  listRecentStoredEventRows,
  listThreadEventRowsInRange,
} from "./thread-data.js";

const TIMELINE_EXCLUDED_EVENT_TYPES = [
  "thread/started",
  "thread/identity",
  "thread/tokenUsage/updated",
] as const;
const MIN_AGENT_MESSAGE_DELTAS_FOR_SUMMARY_COMPACTION = 1000;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && Array.isArray(value) === false;
}

function parseStoredEventData(data: string): Record<string, unknown> | null {
  try {
    const parsed: unknown = JSON.parse(data);
    return isRecord(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function getCompletedAgentMessageItemId(row: StoredEventRow): string | null {
  if (row.type !== "item/completed") {
    return null;
  }

  const parsed = parseStoredEventData(row.data);
  if (!parsed) {
    return null;
  }
  const item = parsed.item;
  if (!isRecord(item)) {
    return null;
  }
  return item.type === "agentMessage" && typeof item.id === "string"
    ? item.id
    : null;
}

function getAgentMessageDeltaItemId(row: StoredEventRow): string | null {
  if (row.type !== "item/agentMessage/delta") {
    return null;
  }

  const parsed = parseStoredEventData(row.data);
  return parsed && typeof parsed.itemId === "string" ? parsed.itemId : null;
}

export function compactSummaryStoredEventRows(
  rows: readonly StoredEventRow[],
): StoredEventRow[] {
  let agentMessageDeltaCount = 0;
  for (const row of rows) {
    if (row.type === "item/agentMessage/delta") {
      agentMessageDeltaCount += 1;
    }
  }

  if (agentMessageDeltaCount < MIN_AGENT_MESSAGE_DELTAS_FOR_SUMMARY_COMPACTION) {
    return [...rows];
  }

  const completedAgentMessageItemIds = new Set<string>();
  for (const row of rows) {
    const itemId = getCompletedAgentMessageItemId(row);
    if (itemId) {
      completedAgentMessageItemIds.add(itemId);
    }
  }

  if (completedAgentMessageItemIds.size === 0) {
    return [...rows];
  }

  const retainedCompletedDeltaItemIds = new Set<string>();
  const compactedRows: StoredEventRow[] = [];

  for (const row of rows) {
    const itemId = getAgentMessageDeltaItemId(row);
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
    includeManagerDebugView?: boolean;
    includeToolGroupMessages?: boolean;
  },
): ThreadTimelineResponse {
  const rawEventRows = listRecentStoredEventRows(db, {
    threadId: thread.id,
    ...(options.includeManagerDebugView === true
      ? {}
      : { excludedTypes: TIMELINE_EXCLUDED_EVENT_TYPES }),
  });
  const eventRows = compactSummaryStoredEventRows(rawEventRows);
  const messages = toViewMessages(eventRows.map((row) => decodeRow(decodeEventRow(row))), {
    includeDebugRawEvents: options.includeManagerDebugView,
    includeInternalSystemMessages: options.includeManagerDebugView,
    threadStatus: thread.status,
    threadType: thread.type,
  });
  const latestTokenUsageRow = getLatestStoredEventRowByType(db, {
    threadId: thread.id,
    type: "thread/tokenUsage/updated",
  });

  return {
    rows: buildTimelineRows(messages, {
      includeToolGroupMessages: options.includeToolGroupMessages ?? false,
    }),
    contextWindowUsage: latestTokenUsageRow
      ? extractThreadContextWindowUsage([decodeEventRow(latestTokenUsageRow)]) ?? undefined
      : undefined,
  };
}

export function buildTimelineToolDetails(
  db: DbConnection,
  thread: Thread,
  options: {
    includeManagerDebugView?: boolean;
    sourceSeqEnd: number;
    sourceSeqStart: number;
  },
): TimelineToolDetailsResponse {
  const eventRows = listThreadEventRowsInRange(db, {
    threadId: thread.id,
    seqStart: options.sourceSeqStart,
    seqEnd: options.sourceSeqEnd,
  });

  return {
    messages: toViewMessages(eventRows.map((row) => decodeRow(row)), {
      includeDebugRawEvents: options.includeManagerDebugView,
      includeInternalSystemMessages: options.includeManagerDebugView,
      threadStatus: thread.status,
      threadType: thread.type,
    }),
  };
}
