import { and, desc, eq, gt } from "drizzle-orm";
import type { HostType } from "@bb/domain";
import type { DbConnection, DbTransaction } from "../connection.js";
import type { DbNotifier } from "../notifier.js";
import { hostDaemonSessions } from "../schema.js";
import { createHostDaemonSessionId } from "../ids.js";

type SessionReadConnection = DbConnection | DbTransaction;

export interface GetActiveSessionByIdArgs {
  sessionId: string;
}

export interface GetCurrentSessionArgs {
  hostId: string;
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

  // Close any existing active sessions for this host
  const existingSessions = db
    .select()
    .from(hostDaemonSessions)
    .where(
      and(
        eq(hostDaemonSessions.hostId, input.hostId),
        eq(hostDaemonSessions.status, "active"),
      ),
    )
    .all();

  for (const session of existingSessions) {
    db.update(hostDaemonSessions)
      .set({
        status: "closed",
        closedAt: now,
        closeReason: "replaced",
        updatedAt: now,
      })
      .where(eq(hostDaemonSessions.id, session.id))
      .run();
  }

  const leaseExpiresAt = now + input.leaseTimeoutMs;

  const row = db.insert(hostDaemonSessions)
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
  const updated = db.update(hostDaemonSessions)
    .set({
      status: "closed",
      closedAt: now,
      closeReason,
      updatedAt: now,
    })
    .where(eq(hostDaemonSessions.id, sessionId))
    .returning()
    .get();

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
): string | null {
  const row = db
    .select({ hostId: hostDaemonSessions.hostId })
    .from(hostDaemonSessions)
    .where(
      and(
        eq(hostDaemonSessions.status, "active"),
        gt(hostDaemonSessions.leaseExpiresAt, Date.now()),
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
  return db.update(hostDaemonSessions)
    .set({
      lastHeartbeatAt: now,
      leaseExpiresAt,
      updatedAt: now,
    })
    .where(eq(hostDaemonSessions.id, sessionId))
    .returning()
    .get() ?? null;
}
