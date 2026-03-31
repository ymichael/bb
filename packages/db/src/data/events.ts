import { and, eq, inArray, lte, max, sql } from "drizzle-orm";
import type { ThreadEventItemType, ThreadEventType } from "@bb/domain";
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
  itemId: string | null;
  itemKind: ThreadEventItemType | null;
  createdAt?: number;
  data: string;
}

export interface InsertEventsResult {
  insertedCount: number;
  insertedInputIndexes: number[];
}

/**
 * Insert events with dedup on (threadId, sequence).
 * Uses INSERT OR IGNORE to skip duplicates.
 * Returns the count and input indexes of actually inserted events.
 */
export function insertEvents(
  db: DbConnection,
  notifier: DbNotifier,
  eventInputs: InsertEventInput[],
): InsertEventsResult {
  if (eventInputs.length === 0) {
    return {
      insertedCount: 0,
      insertedInputIndexes: [],
    };
  }

  let insertedCount = 0;
  const insertedInputIndexes: number[] = [];

  // Track which threads get new events for notification
  const threadIds = new Set<string>();

  for (const [index, input] of eventInputs.entries()) {
    const id = createEventId();
    const createdAt = input.createdAt ?? Date.now();
    const result = db.run(
      sql`INSERT OR IGNORE INTO events (id, thread_id, environment_id, turn_id, provider_thread_id, sequence, type, item_id, item_kind, data, created_at)
          VALUES (${id}, ${input.threadId}, ${input.environmentId ?? null}, ${input.turnId ?? null}, ${input.providerThreadId ?? null}, ${input.sequence}, ${input.type}, ${input.itemId}, ${input.itemKind}, ${input.data}, ${createdAt})`,
    );
    if (result.changes > 0) {
      insertedCount++;
      insertedInputIndexes.push(index);
      threadIds.add(input.threadId);
    }
  }

  for (const threadId of threadIds) {
    notifier.notifyThread(threadId, ["events-appended"]);
  }

  return {
    insertedCount,
    insertedInputIndexes,
  };
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

export interface GetLatestThreadSequenceArgs {
  threadId: string;
}

export interface PruneThreadEventsBeforeSequenceArgs {
  sequenceCutoff: number;
  threadId: string;
  types: readonly ThreadEventType[];
}

export interface PruneResolvedAgentMessageDeltasArgs {
  threadId: string;
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

export function getLatestThreadSequence(
  db: DbConnection,
  args: GetLatestThreadSequenceArgs,
): number {
  const row = db
    .select({
      maxSequence: max(events.sequence),
    })
    .from(events)
    .where(eq(events.threadId, args.threadId))
    .get();

  return row?.maxSequence ?? 0;
}

export function pruneThreadEventsBeforeSequence(
  db: DbConnection,
  args: PruneThreadEventsBeforeSequenceArgs,
): number {
  if (args.sequenceCutoff <= 0 || args.types.length === 0) {
    return 0;
  }

  const result = db
    .delete(events)
    .where(
      and(
        eq(events.threadId, args.threadId),
        lte(events.sequence, args.sequenceCutoff),
        inArray(events.type, [...args.types]),
      ),
    )
    .run();

  return result.changes;
}

export function pruneResolvedAgentMessageDeltas(
  db: DbConnection,
  args: PruneResolvedAgentMessageDeltasArgs,
): number {
  const result = db.run(
    sql`DELETE FROM events
        WHERE ${events.threadId} = ${args.threadId}
          AND ${events.type} = 'item/agentMessage/delta'
          AND ${events.itemId} IS NOT NULL
          AND EXISTS (
            SELECT 1
            FROM events completed
            WHERE completed.thread_id = ${events.threadId}
              AND completed.type = 'item/completed'
              AND completed.item_kind = 'agentMessage'
              AND completed.item_id = ${events.itemId}
          )
          AND EXISTS (
            SELECT 1
            FROM events earlier_delta
            WHERE earlier_delta.thread_id = ${events.threadId}
              AND earlier_delta.type = 'item/agentMessage/delta'
              AND earlier_delta.item_id = ${events.itemId}
              AND earlier_delta.sequence < ${events.sequence}
          )`,
  );

  return result.changes;
}
