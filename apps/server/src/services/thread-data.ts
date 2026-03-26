import { and, desc, eq, gt, gte, inArray, lte } from "drizzle-orm";
import { events } from "@bb/db";
import {
  providerEventSchema,
  systemManagerUserMessageEventDataSchema,
} from "@bb/domain";
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
    if (row.type === "system/manager/user_message") {
      const parsedMessage = systemManagerUserMessageEventDataSchema.safeParse(
        JSON.parse(row.data),
      );
      if (parsedMessage.success && parsedMessage.data.text.length > 0) {
        return parsedMessage.data.text;
      }
      continue;
    }

    if (!row.providerThreadId || !row.turnId) {
      continue;
    }
    const parsedEvent = providerEventSchema.safeParse({
      ...JSON.parse(row.data),
      type: row.type,
      threadId: row.threadId,
      providerThreadId: row.providerThreadId,
      turnId: row.turnId,
    });
    if (
      parsedEvent.success &&
      parsedEvent.data.type === "item/completed" &&
      parsedEvent.data.item.type === "agentMessage" &&
      parsedEvent.data.item.text.length > 0
    ) {
      return parsedEvent.data.item.text;
    }
  }

  return null;
}
