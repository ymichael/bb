import { and, desc, eq, gt, gte, lte, notInArray, sql } from "drizzle-orm";
import { events } from "@bb/db";
import {
  buildThreadEventRow,
  parseStoredThreadEvent,
} from "@bb/domain";
import type {
  ThreadEvent,
  ThreadEventItemType,
  ThreadEventRow,
  ThreadEventType,
} from "@bb/domain";
import type { DbConnection } from "@bb/db";
import { ApiError } from "../errors.js";

export interface StoredEventRow {
  createdAt: number;
  data: string;
  id: string;
  itemId: string | null;
  itemKind: ThreadEventItemType | null;
  providerThreadId: string | null;
  sequence: number;
  threadId: string;
  turnId: string | null;
  type: ThreadEventType;
}

export const storedEventRowFields = {
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

interface StoredEventPayloadRow {
  data: string;
  sequence: number;
  threadId: string;
  type: ThreadEventType;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function toRecord(value: unknown): Record<string, unknown> | null {
  return isRecord(value) ? value : null;
}

function parseStoredEventPayload(row: StoredEventPayloadRow): Record<string, unknown> {
  let data: unknown;
  try {
    data = JSON.parse(row.data);
  } catch {
    throw new ApiError(
      500,
      "internal_error",
      `Stored ${row.type} event #${row.sequence} for thread ${row.threadId} is not valid JSON`,
    );
  }

  const record = toRecord(data);
  if (!record) {
    throw new ApiError(
      500,
      "internal_error",
      `Stored ${row.type} event #${row.sequence} for thread ${row.threadId} is malformed`,
    );
  }

  return record;
}

export function parseStoredEvent(row: StoredEventRow): ThreadEvent {
  return parseStoredThreadEvent({
    type: row.type,
    data: parseStoredEventPayload(row),
    threadId: row.threadId,
    providerThreadId: row.providerThreadId,
    turnId: row.turnId,
  });
}

export function parseStoredEventRow(row: StoredEventRow): ThreadEventRow {
  return buildThreadEventRow({
    id: row.id,
    threadId: row.threadId,
    seq: row.sequence,
    createdAt: row.createdAt,
    event: parseStoredEvent(row),
  });
}

export function listThreadEventRows(
  db: DbConnection,
  args: {
    afterSeq?: number;
    limit?: number;
    threadId: string;
  },
): ThreadEventRow[] {
  const rows = db
    .select(storedEventRowFields)
    .from(events)
    .where(
      args.afterSeq === undefined
        ? eq(events.threadId, args.threadId)
        : and(eq(events.threadId, args.threadId), gt(events.sequence, args.afterSeq)),
    )
    .orderBy(events.sequence)
    .limit(args.limit ?? Number.MAX_SAFE_INTEGER)
    .all();

  return rows.map((row) => parseStoredEventRow(row));
}

export function listStoredEventRowsInRange(
  db: DbConnection,
  args: {
    seqEnd: number;
    seqStart: number;
    threadId: string;
  },
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
  args: {
    excludedTypes?: readonly ThreadEventType[];
    threadId: string;
  },
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

export function listTokenUsageRowsForContextWindowUsage(
  db: DbConnection,
  args: {
    threadId: string;
  },
): StoredEventRow[] {
  const latestRow = db
    .select(storedEventRowFields)
    .from(events)
    .where(
      and(
        eq(events.threadId, args.threadId),
        eq(events.type, "thread/tokenUsage/updated"),
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
        eq(events.type, "thread/tokenUsage/updated"),
        sql`json_extract(${events.data}, '$.tokenUsage.modelContextWindow') IS NOT NULL`,
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

export function findThreadEvent(
  db: DbConnection,
  args: { threadId: string; type: ThreadEventType; afterSeq?: number },
): ThreadEventRow | null {
  const row = db
    .select(storedEventRowFields)
    .from(events)
    .where(
      args.afterSeq !== undefined
        ? and(eq(events.threadId, args.threadId), eq(events.type, args.type), gt(events.sequence, args.afterSeq))
        : and(eq(events.threadId, args.threadId), eq(events.type, args.type)),
    )
    .orderBy(events.sequence)
    .limit(1)
    .get();
  return row ? parseStoredEventRow(row) : null;
}

export function getLastThreadOutput(
  db: DbConnection,
  threadId: string,
): string | null {
  // Filter at the DB level so tool calls, file changes, etc. don't crowd out
  // the actual text output. item_kind lets us match only agentMessage items.
  const row = db
    .select(storedEventRowFields)
    .from(events)
    .where(
      sql`${events.threadId} = ${threadId} AND (
        ${events.type} = 'system/manager/user_message'
        OR (${events.type} = 'item/completed' AND ${events.itemKind} = 'agentMessage')
      )`,
    )
    .orderBy(desc(events.sequence))
    .limit(1)
    .get();

  if (!row) return null;

  const eventRow = parseStoredEventRow(row);

  if (eventRow.type === "system/manager/user_message") {
    return eventRow.data.text.length > 0 ? eventRow.data.text : null;
  }

  if (
    eventRow.type === "item/completed" &&
    eventRow.data.item.type === "agentMessage" &&
    eventRow.data.item.text.length > 0
  ) {
    return eventRow.data.item.text;
  }

  return null;
}
