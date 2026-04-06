import { and, eq, gt } from "drizzle-orm";
import { hostDaemonSessions } from "@bb/db";
import type { DbConnection } from "@bb/db";
import { ApiError } from "../errors.js";

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

export function requireAuthorizedActiveSession(
  db: DbConnection,
  args: { hostId: string; sessionId: string },
) {
  const session = requireActiveSession(db, args.sessionId);
  if (session.hostId !== args.hostId) {
    throw new ApiError(
      403,
      "invalid_request",
      "Session does not belong to the authenticated host",
    );
  }

  return session;
}
