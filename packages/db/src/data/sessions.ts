import { and, desc, eq, inArray, sql } from "drizzle-orm";
import type { HostType } from "@bb/domain";
import type { DbConnection, DbTransaction } from "../connection.js";
import type { DbNotifier } from "../notifier.js";
import { hostDaemonSessions } from "../schema.js";
import { createHostDaemonSessionId } from "../ids.js";
import { markHostSeen } from "./hosts.js";

type SessionReadConnection = DbConnection | DbTransaction;
export type HostDaemonSessionRow = typeof hostDaemonSessions.$inferSelect;

export interface GetSessionByIdArgs {
  sessionId: string;
}

export interface GetLatestSessionForHostArgs {
  hostId: string;
}

export interface ListLatestSessionsForHostsArgs {
  hostIds: readonly string[];
}

export interface OpenSessionInput {
  hostId: string;
  instanceId: string;
  hostName: string;
  hostType: HostType;
  dataDir: string;
  protocolVersion: number;
  heartbeatIntervalMs: number;
  leaseTimeoutMs: number;
}

export function openSession(
  db: DbConnection,
  input: OpenSessionInput,
) {
  const now = Date.now();
  const id = createHostDaemonSessionId();

  db.update(hostDaemonSessions)
    .set({
      status: "closed",
      closedAt: now,
      closeReason: "replaced",
      updatedAt: now,
    })
    .where(
      and(
        eq(hostDaemonSessions.hostId, input.hostId),
        eq(hostDaemonSessions.status, "active"),
      ),
    )
    .run();

  const leaseExpiresAt = now + input.leaseTimeoutMs;

  const row = db
    .insert(hostDaemonSessions)
    .values({
      id,
      hostId: input.hostId,
      instanceId: input.instanceId,
      hostName: input.hostName,
      hostType: input.hostType,
      dataDir: input.dataDir,
      protocolVersion: input.protocolVersion,
      heartbeatIntervalMs: input.heartbeatIntervalMs,
      leaseTimeoutMs: input.leaseTimeoutMs,
      status: "active",
      leaseExpiresAt,
      createdAt: now,
      updatedAt: now,
    })
    .returning()
    .get();

  markHostSeen(db, input.hostId, now);


  return row;
}

export function closeSession(
  db: DbConnection,
  notifier: DbNotifier,
  sessionId: string,
  closeReason: string,
) {
  const existing = db
    .select()
    .from(hostDaemonSessions)
    .where(eq(hostDaemonSessions.id, sessionId))
    .get();
  if (!existing) {
    return null;
  }
  if (existing.status !== "active") {
    return existing;
  }

  const now = Date.now();
  const updated = db
    .update(hostDaemonSessions)
    .set({
      status: "closed",
      closedAt: now,
      closeReason,
      updatedAt: now,
    })
    .where(eq(hostDaemonSessions.id, sessionId))
    .returning()
    .get();

  markHostSeen(db, existing.hostId, now);

  notifier.notifyHost(existing.hostId, ["host-disconnected"]);

  return updated ?? null;
}

export function getLatestSessionForHost(
  db: SessionReadConnection,
  args: GetLatestSessionForHostArgs,
): HostDaemonSessionRow | null {
  return (
    db
      .select()
      .from(hostDaemonSessions)
      .where(eq(hostDaemonSessions.hostId, args.hostId))
      .orderBy(
        desc(hostDaemonSessions.updatedAt),
        desc(hostDaemonSessions.createdAt),
        desc(
          sql<number>`CASE WHEN ${hostDaemonSessions.status} = 'active' THEN 1 ELSE 0 END`,
        ),
        desc(hostDaemonSessions.id),
      )
      .limit(1)
      .get() ?? null
  );
}

export function listLatestSessionsForHosts(
  db: SessionReadConnection,
  args: ListLatestSessionsForHostsArgs,
): HostDaemonSessionRow[] {
  const hostIds = [...new Set(args.hostIds)];
  if (hostIds.length === 0) {
    return [];
  }

  return db
    .select()
    .from(hostDaemonSessions)
    .where(
      and(
        inArray(hostDaemonSessions.hostId, hostIds),
        sql`${hostDaemonSessions.id} = (
          SELECT latest.id
          FROM host_daemon_sessions AS latest
          WHERE latest.host_id = ${hostDaemonSessions.hostId}
          ORDER BY
            latest.updated_at DESC,
            latest.created_at DESC,
            CASE WHEN latest.status = 'active' THEN 1 ELSE 0 END DESC,
            latest.id DESC
          LIMIT 1
        )`,
      ),
    )
    .all();
}

export function getSessionById(
  db: SessionReadConnection,
  args: GetSessionByIdArgs,
) {
  return (
    db
      .select()
      .from(hostDaemonSessions)
      .where(eq(hostDaemonSessions.id, args.sessionId))
      .get() ?? null
  );
}

export function heartbeatSession(
  db: DbConnection,
  sessionId: string,
  leaseExpiresAt: number,
) {
  const now = Date.now();
  const updated =
    db
      .update(hostDaemonSessions)
      .set({
        leaseExpiresAt,
        updatedAt: now,
      })
      .where(eq(hostDaemonSessions.id, sessionId))
      .returning()
      .get() ?? null;
  if (updated) {
    markHostSeen(db, updated.hostId, now);
  }
  return updated;
}
