import {
  buildTimelineRows,
  extractThreadContextWindowUsage,
  TIMELINE_NOISE_EVENT_TYPES,
  toViewMessages,
  type ThreadEventWithMeta,
} from "@bb/core-ui";
import type { Thread, ViewMessage } from "@bb/domain";
import type {
  ThreadTimelineResponse,
  TimelineToolDetailsResponse,
} from "@bb/server-contract";
import {
  listRecentStoredEventRows,
  listStoredEventRowsInRange,
  listTokenUsageRowsForContextWindowUsage,
} from "@bb/db";
import type { DbConnection, StoredEventRow } from "@bb/db";
import {
  parseStoredEvent,
  parseStoredEventRow,
} from "./thread-data.js";

const MIN_AGENT_MESSAGE_DELTAS_FOR_SUMMARY_COMPACTION = 1000;

/**
 * For manager threads in the default (non-debug) view, only show user messages,
 * message_user output, and lifecycle operations (provisioning, compaction).
 * Everything else (assistant text, delegations, other tool calls, etc.) is
 * internal manager machinery.
 */
function filterManagerConversationMessages(
  messages: ViewMessage[],
): ViewMessage[] {
  return messages.filter((message) => {
    if (message.kind === "user") return true;
    if (message.kind === "operation") return true;
    if (
      message.kind === "assistant-text" &&
      message.isManagerUserMessage === true
    ) {
      return true;
    }
    return false;
  });
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
  const allMessages = toViewMessages(
    eventRows.map((row) => toThreadEventWithMeta(row)),
    {
      includeInternalSystemMessages: options.showAllManagerEvents,
      threadStatus: thread.status,
      threadType: thread.type,
    },
  );
  const messages =
    thread.type === "manager" && !options.showAllManagerEvents
      ? filterManagerConversationMessages(allMessages)
      : allMessages;
  const tokenUsageRows = listTokenUsageRowsForContextWindowUsage(db, {
    threadId: thread.id,
  });

  return {
    rows: buildTimelineRows(messages, {
      includeToolGroupMessages: options.includeToolGroupMessages ?? false,
    }),
    contextWindowUsage:
      extractThreadContextWindowUsage(tokenUsageRows.map((row) => parseStoredEventRow(row))) ?? undefined,
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

  return {
    messages: toViewMessages(
      eventRows.map((row) => toThreadEventWithMeta(row)),
      {
        includeInternalSystemMessages: options.showAllManagerEvents,
        threadStatus: thread.status,
        threadType: thread.type,
      },
    ),
  };
}
