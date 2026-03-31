import { eq, sql, max, inArray } from "drizzle-orm";
import type { ThreadEventType } from "@bb/domain";
import type { DbConnection } from "../connection.js";
import type { DbNotifier } from "../notifier.js";
import { events } from "../schema.js";
import { createEventId } from "../ids.js";

export interface InsertEventInput {
  threadId: string;
  environmentId?: string | null;
  turnId?: string | null;
  providerThreadId?: string | null;
  sequence: number;
  type: ThreadEventType;
  createdAt?: number;
  data: string;
}

/**
 * Insert events with dedup on (threadId, sequence).
 * Uses INSERT OR IGNORE to skip duplicates.
 * Returns the count of actually inserted events.
 */
export function insertEvents(
  db: DbConnection,
  notifier: DbNotifier,
  eventInputs: InsertEventInput[],
): number {
  if (eventInputs.length === 0) return 0;

  let insertedCount = 0;

  // Track which threads get new events for notification
  const threadIds = new Set<string>();

  for (const input of eventInputs) {
    const id = createEventId();
    const createdAt = input.createdAt ?? Date.now();
    const result = db.run(
      sql`INSERT OR IGNORE INTO events (id, thread_id, environment_id, turn_id, provider_thread_id, sequence, type, data, created_at)
          VALUES (${id}, ${input.threadId}, ${input.environmentId ?? null}, ${input.turnId ?? null}, ${input.providerThreadId ?? null}, ${input.sequence}, ${input.type}, ${input.data}, ${createdAt})`,
    );
    if (result.changes > 0) {
      insertedCount++;
      threadIds.add(input.threadId);
    }
  }

  for (const threadId of threadIds) {
    notifier.notifyThread(threadId, ["events-appended"]);
  }

  return insertedCount;
}

/**
 * Get high-water marks (max sequence) per thread.
 * Returns Record<threadId, maxSequence>.
 */
export function getHighWaterMarks(
  db: DbConnection,
  threadIds?: string[],
): Record<string, number> {
  const result: Record<string, number> = {};

  if (threadIds && threadIds.length > 0) {
    const rows = db
      .select({
        threadId: events.threadId,
        maxSeq: max(events.sequence),
      })
      .from(events)
      .where(inArray(events.threadId, threadIds))
      .groupBy(events.threadId)
      .all();
    for (const row of rows) {
      if (row.maxSeq != null) {
        result[row.threadId] = row.maxSeq;
      }
    }
  } else {
    const rows = db
      .select({
        threadId: events.threadId,
        maxSeq: max(events.sequence),
      })
      .from(events)
      .groupBy(events.threadId)
      .all();
    for (const row of rows) {
      if (row.maxSeq != null) {
        result[row.threadId] = row.maxSeq;
      }
    }
  }

  return result;
}

export interface ListEventsOptions {
  threadId: string;
  afterSequence?: number;
  limit?: number;
}

export function listEvents(db: DbConnection, options: ListEventsOptions) {
  const { threadId, afterSequence, limit } = options;

  if (afterSequence != null) {
    const q = db
      .select()
      .from(events)
      .where(
        sql`${events.threadId} = ${threadId} AND ${events.sequence} > ${afterSequence}`,
      )
      .orderBy(events.sequence);
    if (limit) return q.limit(limit).all();
    return q.all();
  }

  const q = db
    .select()
    .from(events)
    .where(eq(events.threadId, threadId))
    .orderBy(events.sequence);
  if (limit) return q.limit(limit).all();
  return q.all();
}
