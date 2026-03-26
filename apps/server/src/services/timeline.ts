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
  listRecentThreadEventRows,
  listThreadEventRowsInRange,
} from "./thread-data.js";

export function buildThreadTimeline(
  db: DbConnection,
  thread: Thread,
  options: {
    includeManagerDebugView?: boolean;
    includeToolGroupMessages?: boolean;
    limit?: number;
  },
): ThreadTimelineResponse {
  const eventRows = listRecentThreadEventRows(db, {
    threadId: thread.id,
    limit: options.limit,
  });
  const messages = toViewMessages(eventRows.map((row) => decodeRow(row)), {
    includeDebugRawEvents: options.includeManagerDebugView,
    includeInternalSystemMessages: options.includeManagerDebugView,
    threadStatus: thread.status,
    threadType: thread.type,
  });

  return {
    rows: buildTimelineRows(messages, {
      includeToolGroupMessages: options.includeToolGroupMessages ?? false,
    }),
    contextWindowUsage: extractThreadContextWindowUsage(eventRows) ?? undefined,
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
