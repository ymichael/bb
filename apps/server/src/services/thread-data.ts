import { and, desc, eq, gt, gte, lte, notInArray, sql } from "drizzle-orm";
import { events } from "@bb/db";
import {
  providerEventSchema,
  systemManagerUserMessageEventDataSchema,
} from "@bb/domain";
import type { ThreadEventRow, ThreadEventType } from "@bb/domain";
import type { DbConnection } from "@bb/db";
import { ApiError } from "../errors.js";

export interface StoredEventRow {
  createdAt: number;
  data: string;
  id: string;
  sequence: number;
  threadId: string;
  type: ThreadEventType;
}

const storedEventRowFields = {
  createdAt: events.createdAt,
  data: events.data,
  id: events.id,
  sequence: events.sequence,
  threadId: events.threadId,
  type: events.type,
};

export function decodeEventRow(row: StoredEventRow): ThreadEventRow {
  return {
    id: row.id,
    threadId: row.threadId,
    seq: row.sequence,
    type: row.type,
    data: JSON.parse(row.data) as Record<string, unknown>,
    createdAt: row.createdAt,
  };
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

export function findThreadEvent(
  db: DbConnection,
  args: { threadId: string; type: string; afterSeq?: number },
): ThreadEventRow | null {
  // ThreadEventType is a union of string literals with no runtime values array,
  // so we cannot validate at compile time. Cast for drizzle's typed column —
  // a non-matching string simply returns no rows, which is correct behavior.
  const eventType = args.type as ThreadEventType;
  const row = db
    .select()
    .from(events)
    .where(
      args.afterSeq !== undefined
        ? and(eq(events.threadId, args.threadId), eq(events.type, eventType), gt(events.sequence, args.afterSeq))
        : and(eq(events.threadId, args.threadId), eq(events.type, eventType)),
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
  // the actual text output. json_extract lets us match only agentMessage items.
  const row = db
    .select()
    .from(events)
    .where(
      sql`${events.threadId} = ${threadId} AND (
        ${events.type} = 'system/manager/user_message'
        OR (${events.type} = 'item/completed' AND json_extract(${events.data}, '$.item.type') = 'agentMessage')
      )`,
    )
    .orderBy(desc(events.sequence))
    .limit(1)
    .get();

  if (!row) return null;

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
  if (!data || typeof data !== "object" || Array.isArray(data)) {
    throw new ApiError(
      500,
      "internal_error",
      `Stored ${row.type} event #${row.sequence} for thread ${row.threadId} is malformed`,
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
