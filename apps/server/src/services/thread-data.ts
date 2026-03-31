import { and, desc, eq, gt, gte, lte, notInArray, sql } from "drizzle-orm";
import { events } from "@bb/db";
import {
  buildThreadEventRow,
  parseStoredThreadEvent,
  providerEventSchema,
  systemManagerUserMessageEventDataSchema,
} from "@bb/domain";
import type { ThreadEventItemType, ThreadEventRow, ThreadEventType } from "@bb/domain";
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

interface StoredEventPayloadRow {
  data: string;
  sequence: number;
  threadId: string;
  type: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && Array.isArray(value) === false;
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

  if (!isRecord(data)) {
    throw new ApiError(
      500,
      "internal_error",
      `Stored ${row.type} event #${row.sequence} for thread ${row.threadId} is malformed`,
    );
  }

  return data;
}

export function decodeEventRow(row: StoredEventRow): ThreadEventRow {
  return buildThreadEventRow({
    id: row.id,
    threadId: row.threadId,
    seq: row.sequence,
    createdAt: row.createdAt,
    event: parseStoredThreadEvent({
      type: row.type,
      data: parseStoredEventPayload(row),
      threadId: row.threadId,
      providerThreadId: row.providerThreadId,
      turnId: row.turnId,
    }),
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

  return rows.map((row) => decodeEventRow(row));
}

export function listThreadEventRowsInRange(
  db: DbConnection,
  args: {
    seqEnd: number;
    seqStart: number;
    threadId: string;
  },
): ThreadEventRow[] {
  const rows = db
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

  return rows.map((row) => decodeEventRow(row));
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

export function listRecentThreadEventRows(
  db: DbConnection,
  args: {
    threadId: string;
  },
): ThreadEventRow[] {
  return listRecentStoredEventRows(db, args).map((row) => decodeEventRow(row));
}

export function getLatestStoredEventRowByType(
  db: DbConnection,
  args: {
    threadId: string;
    type: ThreadEventType;
  },
): StoredEventRow | null {
  const rows = db
    .select(storedEventRowFields)
    .from(events)
    .where(and(eq(events.threadId, args.threadId), eq(events.type, args.type)))
    .orderBy(desc(events.sequence))
    .limit(1)
    .get();

  return rows ?? null;
}

export function listStoredEventRowsByType(
  db: DbConnection,
  args: {
    threadId: string;
    type: ThreadEventType;
  },
): StoredEventRow[] {
  return db
    .select(storedEventRowFields)
    .from(events)
    .where(and(eq(events.threadId, args.threadId), eq(events.type, args.type)))
    .orderBy(events.sequence)
    .all();
}

export function findThreadEvent(
  db: DbConnection,
  args: { threadId: string; type: ThreadEventType; afterSeq?: number },
): ThreadEventRow | null {
  const row = db
    .select()
    .from(events)
    .where(
      args.afterSeq !== undefined
        ? and(eq(events.threadId, args.threadId), eq(events.type, args.type), gt(events.sequence, args.afterSeq))
        : and(eq(events.threadId, args.threadId), eq(events.type, args.type)),
    )
    .orderBy(events.sequence)
    .limit(1)
    .get();
  return row ? decodeEventRow(row) : null;
}

export function getLastThreadOutput(
  db: DbConnection,
  threadId: string,
): string | null {
  // Filter at the DB level so tool calls, file changes, etc. don't crowd out
  // the actual text output. item_kind lets us match only agentMessage items.
  const row = db
    .select()
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

  const data = parseStoredEventPayload(row);

  if (row.type === "system/manager/user_message") {
    const parsed = systemManagerUserMessageEventDataSchema.safeParse(data);
    if (!parsed.success) {
      throw new ApiError(
        500,
        "internal_error",
        `Stored ${row.type} event #${row.sequence} for thread ${row.threadId} is malformed`,
      );
    }
    return parsed.data.text.length > 0 ? parsed.data.text : null;
  }

  // item/completed — DB already filtered to agentMessage, just extract the text
  if (!row.providerThreadId || !row.turnId) {
    throw new ApiError(
      500,
      "internal_error",
      `Stored ${row.type} event #${row.sequence} for thread ${row.threadId} is missing provider context`,
    );
  }
  const parsed = providerEventSchema.safeParse({
    ...data,
    type: row.type,
    threadId: row.threadId,
    providerThreadId: row.providerThreadId,
    turnId: row.turnId,
  });
  if (!parsed.success) {
    throw new ApiError(
      500,
      "internal_error",
      `Stored ${row.type} event #${row.sequence} for thread ${row.threadId} is malformed`,
    );
  }
  if (parsed.data.type === "item/completed" && parsed.data.item.type === "agentMessage" && parsed.data.item.text.length > 0) {
    return parsed.data.item.text;
  }

  return null;
}
