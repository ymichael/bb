import { eq } from "drizzle-orm";
import { events, hostDaemonSessions, type DbConnection } from "@bb/db";

export interface StoredTurnEventRow {
  sequence: number;
  turnId: string | null;
  type: string;
}

export function readStoredTurnEvents(
  db: DbConnection,
  threadId: string,
): StoredTurnEventRow[] {
  return db
    .select({
      sequence: events.sequence,
      turnId: events.turnId,
      type: events.type,
    })
    .from(events)
    .where(eq(events.threadId, threadId))
    .orderBy(events.sequence)
    .all();
}

export function readSessionRow(
  db: DbConnection,
  sessionId: string,
): typeof hostDaemonSessions.$inferSelect | null {
  return (
    db
      .select()
      .from(hostDaemonSessions)
      .where(eq(hostDaemonSessions.id, sessionId))
      .get() ?? null
  );
}
