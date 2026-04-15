import { and, desc, eq, gt, gte, inArray, isNotNull, lte, max, notInArray, sql } from "drizzle-orm";
import type {
  StoredThreadEventDataForType,
  ThreadEventItemType,
  ThreadEventType,
} from "@bb/domain";
import type { DbConnection, DbTransaction } from "../connection.js";
import type { DbNotifier } from "../notifier.js";
import { events } from "../schema.js";
import { createEventId } from "../ids.js";
import { deriveStoredEventItemFieldsFromSource } from "../stored-event-item-fields.js";

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

export type AppendStoredThreadEventArgs<TType extends ThreadEventType = ThreadEventType> = {
  [TEventType in TType]: {
    data: StoredThreadEventDataForType<TEventType>;
    environmentId?: string | null;
    providerThreadId?: string | null;
    threadId: string;
    turnId?: string | null;
    type: TEventType;
  };
}[TType];

export interface StoredTurnRequestEventRow {
  data: string;
  sequence: number;
  threadId: string;
  type: ThreadEventType;
}

export interface CompletedStoredTurnRow {
  threadId: string;
  turnId: string;
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

export function appendStoredThreadEventInTransaction<TType extends ThreadEventType>(
  db: DbTransaction,
  args: AppendStoredThreadEventArgs<TType>,
): number;
export function appendStoredThreadEventInTransaction(
  db: DbTransaction,
  args: AppendStoredThreadEventArgs,
): number {
  const now = Date.now();
  const maxRow = db
    .select({ maxSeq: max(events.sequence) })
    .from(events)
    .where(eq(events.threadId, args.threadId))
    .get();
  const sequence = (maxRow?.maxSeq ?? 0) + 1;
  const itemFields = deriveStoredEventItemFieldsFromSource({
    type: args.type,
    item: "item" in args.data ? args.data.item : undefined,
    itemId: "itemId" in args.data ? args.data.itemId : undefined,
  });

  db.run(
    sql`INSERT INTO events
      (id, thread_id, environment_id, turn_id, provider_thread_id, sequence, type, item_id, item_kind, data, created_at)
      VALUES (
        ${createEventId()},
        ${args.threadId},
        ${args.environmentId ?? null},
        ${args.turnId ?? null},
        ${args.providerThreadId ?? null},
        ${sequence},
        ${args.type},
        ${itemFields.itemId},
        ${itemFields.itemKind},
        ${JSON.stringify(args.data)},
        ${now}
      )`,
  );

  return sequence;
}

export function appendStoredThreadEvent<TType extends ThreadEventType>(
  db: DbConnection,
  notifier: DbNotifier,
  args: AppendStoredThreadEventArgs<TType>,
): number;
export function appendStoredThreadEvent(
  db: DbConnection,
  notifier: DbNotifier,
  args: AppendStoredThreadEventArgs,
): number {
  const sequence = db.transaction(
    (tx) => appendStoredThreadEventInTransaction(tx, args),
    { behavior: "immediate" },
  );
  notifier.notifyThread(args.threadId, ["events-appended"]);
  return sequence;
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

const storedEventRowFields = {
  createdAt: events.createdAt,
  data: events.data,
  id: events.id,
  itemId: events.itemId,
  itemKind: events.itemKind,
  providerThreadId: events.providerThreadId,
  sequence: events.sequence,
  threadId: events.threadId,
  turnId: events.turnId,
  type: events.type,
};

export type StoredEventRow = Pick<
  typeof events.$inferSelect,
  keyof typeof storedEventRowFields
>;

export interface ListStoredEventRowsArgs {
  afterSequence?: number;
  limit?: number;
  threadId: string;
}

export interface FindStoredEventRowArgs {
  afterSequence?: number;
  threadId: string;
  type: ThreadEventType;
}

export interface ListStoredEventRowsInRangeArgs {
  seqEnd: number;
  seqStart: number;
  threadId: string;
}

export interface ListRecentStoredEventRowsArgs {
  excludedTypes?: readonly ThreadEventType[];
  threadId: string;
}

export interface ListContextWindowUsageRowsArgs {
  threadId: string;
}

export interface GetLatestThreadOutputEventRowArgs {
  threadId: string;
}

export interface GetLatestThreadSequenceArgs {
  threadId: string;
}

export interface PruneThreadEventsBeforeSequenceArgs {
  sequenceCutoff: number;
  threadId: string;
  types: readonly ThreadEventType[];
}

export interface PruneContextWindowUsageEventsBeforeSequenceArgs {
  sequenceCutoff: number;
  threadId: string;
}

export interface PruneTokenUsageEventsBeforeSequenceArgs {
  sequenceCutoff: number;
  threadId: string;
}

export interface PruneResolvedItemDeltasArgs {
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

export function listStoredEventRows(
  db: DbConnection,
  args: ListStoredEventRowsArgs,
): StoredEventRow[] {
  return db
    .select(storedEventRowFields)
    .from(events)
    .where(
      args.afterSequence === undefined
        ? eq(events.threadId, args.threadId)
        : and(eq(events.threadId, args.threadId), gt(events.sequence, args.afterSequence)),
    )
    .orderBy(events.sequence)
    .limit(args.limit ?? Number.MAX_SAFE_INTEGER)
    .all();
}

export function findStoredEventRow(
  db: DbConnection,
  args: FindStoredEventRowArgs,
): StoredEventRow | null {
  return db
    .select(storedEventRowFields)
    .from(events)
    .where(
      args.afterSequence !== undefined
        ? and(
            eq(events.threadId, args.threadId),
            eq(events.type, args.type),
            gt(events.sequence, args.afterSequence),
          )
        : and(eq(events.threadId, args.threadId), eq(events.type, args.type)),
    )
    .orderBy(events.sequence)
    .limit(1)
    .get() ?? null;
}

export function listStoredEventRowsInRange(
  db: DbConnection,
  args: ListStoredEventRowsInRangeArgs,
): StoredEventRow[] {
  return db
    .select(storedEventRowFields)
    .from(events)
    .where(
      and(
        eq(events.threadId, args.threadId),
        gte(events.sequence, args.seqStart),
        lte(events.sequence, args.seqEnd),
      ),
    )
    .orderBy(events.sequence)
    .all();
}

export function listRecentStoredEventRows(
  db: DbConnection,
  args: ListRecentStoredEventRowsArgs,
): StoredEventRow[] {
  const condition =
    args.excludedTypes && args.excludedTypes.length > 0
      ? and(
          eq(events.threadId, args.threadId),
          notInArray(events.type, [...args.excludedTypes]),
        )
      : eq(events.threadId, args.threadId);

  return db
    .select(storedEventRowFields)
    .from(events)
    .where(condition)
    .orderBy(events.sequence)
    .all();
}

function listLatestRowsForContextWindowUsage(
  db: DbConnection,
  args: {
    contextWindowJsonPath: string;
    eventType: "thread/contextWindowUsage/updated" | "thread/tokenUsage/updated";
    threadId: string;
  },
): StoredEventRow[] {
  const latestRow = db
    .select(storedEventRowFields)
    .from(events)
    .where(
      and(
        eq(events.threadId, args.threadId),
        eq(events.type, args.eventType),
      ),
    )
    .orderBy(desc(events.sequence))
    .limit(1)
    .get();

  if (!latestRow) {
    return [];
  }

  const latestContextRow = db
    .select(storedEventRowFields)
    .from(events)
    .where(
      and(
        eq(events.threadId, args.threadId),
        eq(events.type, args.eventType),
        sql`json_extract(${events.data}, ${args.contextWindowJsonPath}) IS NOT NULL`,
      ),
    )
    .orderBy(desc(events.sequence))
    .limit(1)
    .get();

  if (!latestContextRow || latestContextRow.id === latestRow.id) {
    return [latestRow];
  }

  return [latestContextRow, latestRow];
}

export function listContextWindowUsageRows(
  db: DbConnection,
  args: ListContextWindowUsageRowsArgs,
): StoredEventRow[] {
  return listLatestRowsForContextWindowUsage(db, {
    threadId: args.threadId,
    eventType: "thread/contextWindowUsage/updated",
    contextWindowJsonPath: "$.contextWindowUsage.modelContextWindow",
  });
}

export function getLatestThreadOutputEventRow(
  db: DbConnection,
  args: GetLatestThreadOutputEventRowArgs,
): StoredEventRow | null {
  return db
    .select(storedEventRowFields)
    .from(events)
    .where(
      sql`${events.threadId} = ${args.threadId} AND (
        (
          ${events.type} = 'system/manager/user_message'
          AND COALESCE(json_extract(${events.data}, '$.text'), '') <> ''
        )
        OR (
          ${events.type} = 'item/completed'
          AND ${events.itemKind} = 'agentMessage'
          AND COALESCE(json_extract(${events.data}, '$.item.text'), '') <> ''
        )
      )`,
    )
    .orderBy(desc(events.sequence))
    .limit(1)
    .get() ?? null;
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

export function getLastStoredTurnId(
  db: DbConnection,
  threadId: string,
): string | null {
  const row = db
    .select({ turnId: events.turnId })
    .from(events)
    .where(
      sql`${events.threadId} = ${threadId} AND ${events.turnId} IS NOT NULL`,
    )
    .orderBy(sql`${events.sequence} DESC`)
    .limit(1)
    .get();
  return row?.turnId ?? null;
}

export function getActiveStoredTurnId(
  db: DbConnection,
  threadId: string,
): string | null {
  const latestStarted = db
    .select({ turnId: events.turnId })
    .from(events)
    .where(
      and(
        eq(events.threadId, threadId),
        eq(events.type, "turn/started"),
        isNotNull(events.turnId),
      ),
    )
    .orderBy(desc(events.sequence))
    .limit(1)
    .get();

  if (!latestStarted?.turnId) {
    return null;
  }

  const completed = db
    .select({ sequence: events.sequence })
    .from(events)
    .where(
      and(
        eq(events.threadId, threadId),
        eq(events.turnId, latestStarted.turnId),
        eq(events.type, "turn/completed"),
      ),
    )
    .limit(1)
    .get();

  return completed ? null : latestStarted.turnId;
}

export function getLastStoredProviderThreadId(
  db: DbConnection,
  threadId: string,
): string | null {
  const row = db
    .select({ providerThreadId: events.providerThreadId })
    .from(events)
    .where(
      sql`${events.threadId} = ${threadId}
        AND ${events.providerThreadId} IS NOT NULL`,
    )
    .orderBy(sql`${events.sequence} DESC`)
    .limit(1)
    .get();
  return row?.providerThreadId ?? null;
}

export function getLastStoredTurnRequestEvent(
  db: DbConnection,
  threadId: string,
): StoredTurnRequestEventRow | null {
  return db
    .select({
      data: events.data,
      sequence: events.sequence,
      threadId: events.threadId,
      type: events.type,
    })
    .from(events)
    .where(
      sql`${events.threadId} = ${threadId}
        AND ${events.type} IN ('client/thread/start', 'client/turn/requested', 'client/turn/start')`,
    )
    .orderBy(sql`${events.sequence} DESC`)
    .limit(1)
    .get() ?? null;
}

export function listCompletedTurnsByThreadIds(
  db: DbConnection,
  threadIds: readonly string[],
): CompletedStoredTurnRow[] {
  if (threadIds.length === 0) {
    return [];
  }

  return db
    .select({
      threadId: events.threadId,
      turnId: events.turnId,
    })
    .from(events)
    .where(
      and(
        inArray(events.threadId, [...threadIds]),
        eq(events.type, "turn/completed"),
        isNotNull(events.turnId),
      ),
    )
    .all()
    .flatMap((row) => (
      row.turnId === null
        ? []
        : [{
            threadId: row.threadId,
            turnId: row.turnId,
          }]
    ));
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

function pruneLatestRowsForContextWindowUsageBeforeSequence(
  db: DbConnection,
  args: {
    contextWindowJsonPath: string;
    eventType: "thread/contextWindowUsage/updated" | "thread/tokenUsage/updated";
    sequenceCutoff: number;
    threadId: string;
  },
): number {
  if (args.sequenceCutoff <= 0) {
    return 0;
  }

  // The timeline needs the latest totals row plus the latest older row that
  // still carries a non-null modelContextWindow.
  const result = db.run(
    sql`DELETE FROM events
        WHERE ${events.threadId} = ${args.threadId}
          AND ${events.type} = ${args.eventType}
          AND ${events.sequence} <= ${args.sequenceCutoff}
          AND ${events.id} NOT IN (
            SELECT latest.id
            FROM events latest
            WHERE latest.thread_id = ${args.threadId}
              AND latest.type = ${args.eventType}
            ORDER BY latest.sequence DESC
            LIMIT 1
          )
          AND ${events.id} NOT IN (
            SELECT latest_context.id
            FROM events latest_context
            WHERE latest_context.thread_id = ${args.threadId}
              AND latest_context.type = ${args.eventType}
              AND json_extract(latest_context.data, ${args.contextWindowJsonPath}) IS NOT NULL
            ORDER BY latest_context.sequence DESC
            LIMIT 1
          )`,
  );

  return result.changes;
}

export function pruneContextWindowUsageEventsBeforeSequence(
  db: DbConnection,
  args: PruneContextWindowUsageEventsBeforeSequenceArgs,
): number {
  return pruneLatestRowsForContextWindowUsageBeforeSequence(db, {
    threadId: args.threadId,
    sequenceCutoff: args.sequenceCutoff,
    eventType: "thread/contextWindowUsage/updated",
    contextWindowJsonPath: "$.contextWindowUsage.modelContextWindow",
  });
}

export function pruneTokenUsageEventsBeforeSequence(
  db: DbConnection,
  args: PruneTokenUsageEventsBeforeSequenceArgs,
): number {
  return pruneLatestRowsForContextWindowUsageBeforeSequence(db, {
    threadId: args.threadId,
    sequenceCutoff: args.sequenceCutoff,
    eventType: "thread/tokenUsage/updated",
    contextWindowJsonPath: "$.tokenUsage.modelContextWindow",
  });
}

export function pruneResolvedItemDeltas(
  db: DbConnection,
  args: PruneResolvedItemDeltasArgs,
): number {
  const result = db.run(
    sql`DELETE FROM events
        WHERE ${events.threadId} = ${args.threadId}
          AND ${events.type} IN (
            'item/agentMessage/delta',
            'item/reasoning/summaryTextDelta',
            'item/reasoning/textDelta'
          )
          AND ${events.itemId} IS NOT NULL
          AND EXISTS (
            SELECT 1
            FROM events completed
            WHERE completed.thread_id = ${events.threadId}
              AND completed.type = 'item/completed'
              AND completed.item_kind = CASE
                WHEN ${events.type} = 'item/agentMessage/delta' THEN 'agentMessage'
                ELSE 'reasoning'
              END
              AND completed.item_id = ${events.itemId}
          )
          AND EXISTS (
            SELECT 1
            FROM events earlier_delta
            WHERE earlier_delta.thread_id = ${events.threadId}
              AND earlier_delta.type = ${events.type}
              AND earlier_delta.item_id = ${events.itemId}
              AND earlier_delta.sequence < ${events.sequence}
          )`,
  );

  return result.changes;
}
