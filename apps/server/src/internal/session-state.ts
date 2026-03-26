import { and, eq, gt } from "drizzle-orm";
import { hostDaemonSessions } from "@bb/db";
import type { DbConnection } from "@bb/db";
import { ApiError } from "../errors.js";

export function getSessionById(db: DbConnection, sessionId: string) {
  return (
    db
      .select()
      .from(hostDaemonSessions)
      .where(eq(hostDaemonSessions.id, sessionId))
      .get() ?? null
  );
}

export function requireActiveSession(db: DbConnection, sessionId: string) {
  const session =
    db
      .select()
      .from(hostDaemonSessions)
      .where(
        and(
          eq(hostDaemonSessions.id, sessionId),
          eq(hostDaemonSessions.status, "active"),
          gt(hostDaemonSessions.leaseExpiresAt, Date.now()),
        ),
      )
      .get() ?? null;

  if (!session) {
    throw new ApiError(401, "inactive_session", "Session is not active");
  }

  return session;
}
