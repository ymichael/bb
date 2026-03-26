import { and, desc, eq, gt, gte, inArray, lte } from "drizzle-orm";
import { events } from "@bb/db";
import type { ThreadEventRow } from "@bb/domain";
import type { DbConnection } from "@bb/db";

interface StoredEventRow {
  createdAt: number;
  data: string;
  id: string;
  sequence: number;
  threadId: string;
  type: string;
}

function decodeEventRow(row: StoredEventRow): ThreadEventRow {
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
    .select()
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
    .select()
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

export function listRecentThreadEventRows(
  db: DbConnection,
  args: {
    limit?: number;
    threadId: string;
  },
): ThreadEventRow[] {
  const rows = db
    .select()
    .from(events)
    .where(eq(events.threadId, args.threadId))
    .orderBy(desc(events.sequence))
    .limit(args.limit ?? Number.MAX_SAFE_INTEGER)
    .all()
    .reverse();

  return rows.map((row) => decodeEventRow(row));
}

export function getLastThreadOutput(
  db: DbConnection,
  threadId: string,
): string | null {
  const rows = db
    .select()
    .from(events)
    .where(
      and(
        eq(events.threadId, threadId),
        inArray(events.type, ["item/completed", "system/manager/user_message"]),
      ),
    )
    .orderBy(desc(events.sequence))
    .limit(20)
    .all();

  for (const row of rows) {
    const parsed = JSON.parse(row.data) as Record<string, unknown>;
    if (
      row.type === "system/manager/user_message" &&
      typeof parsed.text === "string" &&
      parsed.text.length > 0
    ) {
      return parsed.text;
    }

    const item =
      "item" in parsed && parsed.item && typeof parsed.item === "object"
        ? parsed.item
        : null;
    if (!item) {
      continue;
    }

    const type =
      "type" in item && typeof item.type === "string" ? item.type : null;
    const text =
      "text" in item && typeof item.text === "string" ? item.text : null;
    if (type === "agentMessage" && text && text.length > 0) {
      return text;
    }
  }

  return null;
}
