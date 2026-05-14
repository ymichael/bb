import { and, desc, eq, gt, inArray, sql } from "drizzle-orm";
import type { HostType } from "@bb/domain";
import type { DbConnection, DbTransaction } from "../connection.js";
import type { DbNotifier } from "../notifier.js";
import { hostDaemonSessions } from "../schema.js";
import { createHostDaemonSessionId } from "../ids.js";
import { markHostSeen } from "./hosts.js";

type SessionReadConnection = DbConnection | DbTransaction;
export type HostDaemonSessionRow = typeof hostDaemonSessions.$inferSelect;

export interface GetActiveSessionByIdArgs {
  sessionId: string;
}

export interface GetCurrentSessionArgs {
  hostId: string;
}

export interface GetMostRecentlyUpdatedConnectedHostIdArgs {
  hostType?: HostType;
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

/**
 * Open a new session. If an active session exists for the same hostId,
 * close it first (status="closed", closeReason="replaced").
 */
export function openSession(
  db: DbConnection,
  notifier: DbNotifier,
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

  notifier.notifyHost(input.hostId, ["host-connected"]);

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

export function getActiveSession(db: SessionReadConnection, hostId: string) {
  return (
    db
      .select()
      .from(hostDaemonSessions)
      .where(
        and(
          eq(hostDaemonSessions.hostId, hostId),
          eq(hostDaemonSessions.status, "active"),
          gt(hostDaemonSessions.leaseExpiresAt, Date.now()),
        ),
      )
      .get() ?? null
  );
}

/**
 * Returns the most recently updated active session row for the host without
 * applying the lease-expiry filter.
 *
 * Use this only for reconciliation/diagnostic paths that need to distinguish
 * "no active session exists" from "the latest active session record exists but
 * its lease has already expired". For normal readiness checks, use
 * `getActiveSession(...)` instead.
 */
export function getCurrentSession(
  db: SessionReadConnection,
  args: GetCurrentSessionArgs,
) {
  return (
    db
      .select()
      .from(hostDaemonSessions)
      .where(
        and(
          eq(hostDaemonSessions.hostId, args.hostId),
          eq(hostDaemonSessions.status, "active"),
        ),
      )
      .orderBy(desc(hostDaemonSessions.updatedAt))
      .limit(1)
      .get() ?? null
  );
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
        sql`NOT EXISTS (
          SELECT 1
          FROM host_daemon_sessions AS latest
          WHERE latest.host_id = ${hostDaemonSessions.hostId}
            AND (
              latest.updated_at > ${hostDaemonSessions.updatedAt}
              OR (
                latest.updated_at = ${hostDaemonSessions.updatedAt}
                AND latest.created_at > ${hostDaemonSessions.createdAt}
              )
              OR (
                latest.updated_at = ${hostDaemonSessions.updatedAt}
                AND latest.created_at = ${hostDaemonSessions.createdAt}
                AND CASE WHEN latest.status = 'active' THEN 1 ELSE 0 END >
                  CASE WHEN ${hostDaemonSessions.status} = 'active' THEN 1 ELSE 0 END
              )
              OR (
                latest.updated_at = ${hostDaemonSessions.updatedAt}
                AND latest.created_at = ${hostDaemonSessions.createdAt}
                AND CASE WHEN latest.status = 'active' THEN 1 ELSE 0 END =
                  CASE WHEN ${hostDaemonSessions.status} = 'active' THEN 1 ELSE 0 END
                AND latest.id > ${hostDaemonSessions.id}
              )
            )
        )`,
      ),
    )
    .all();
}

export function getActiveSessionById(
  db: SessionReadConnection,
  args: GetActiveSessionByIdArgs,
) {
  return (
    db
      .select()
      .from(hostDaemonSessions)
      .where(
        and(
          eq(hostDaemonSessions.id, args.sessionId),
          eq(hostDaemonSessions.status, "active"),
          gt(hostDaemonSessions.leaseExpiresAt, Date.now()),
        ),
      )
      .get() ?? null
  );
}

export function listConnectedHostIds(db: SessionReadConnection): string[] {
  return db
    .select({ hostId: hostDaemonSessions.hostId })
    .from(hostDaemonSessions)
    .where(
      and(
        eq(hostDaemonSessions.status, "active"),
        gt(hostDaemonSessions.leaseExpiresAt, Date.now()),
      ),
    )
    .all()
    .map((row) => row.hostId);
}

export function getMostRecentlyUpdatedConnectedHostId(
  db: SessionReadConnection,
  args: GetMostRecentlyUpdatedConnectedHostIdArgs = {},
): string | null {
  const row = db
    .select({ hostId: hostDaemonSessions.hostId })
    .from(hostDaemonSessions)
    .where(
      and(
        eq(hostDaemonSessions.status, "active"),
        gt(hostDaemonSessions.leaseExpiresAt, Date.now()),
        args.hostType
          ? eq(hostDaemonSessions.hostType, args.hostType)
          : undefined,
      ),
    )
    .orderBy(desc(hostDaemonSessions.updatedAt))
    .limit(1)
    .get();

  return row?.hostId ?? null;
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
        lastHeartbeatAt: now,
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
