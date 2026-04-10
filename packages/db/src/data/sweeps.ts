import { eq, and, isNull, sql, lt, ne, inArray, or } from "drizzle-orm";
import type { DbConnection } from "../connection.js";
import type { DbNotifier } from "../notifier.js";
import {
  hosts,
  hostDaemonCommands,
  hostDaemonSessions,
  threads,
  environments,
} from "../schema.js";
import { listEphemeralHostsPendingCleanup } from "./hosts.js";
import { transitionThreadsToError } from "./threads.js";

/** Standard command TTL: 60 seconds */
const STANDARD_COMMAND_TTL_MS = 60_000;

/** Provision command TTL: 20 minutes */
const PROVISION_COMMAND_TTL_MS = 20 * 60_000;

/** Destroyed environments are hard-deleted after 7 days. */
const DESTROYING_ENVIRONMENT_TTL_MS = 7 * 24 * 60 * 60_000;

/**
 * Sweep expired commands (fetched but not completed past TTL).
 *
 * - retryCount 0: re-queue (set state="pending", fetchedAt=null, retryCount=1)
 * - retryCount >= 1: error the command and transition the associated thread to error
 *
 * Returns { requeued: number; errored: number }
 */
export function sweepExpiredCommands(
  db: DbConnection,
  notifier: DbNotifier,
  now?: number,
) {
  const currentTime = now ?? Date.now();
  const requeuedCommandIds: string[] = [];
  const threadsToError = new Set<string>();
  const erroredCommandIds: string[] = [];

  // Find fetched commands that have exceeded their type-specific TTL
  const fetchedCommands = db
    .select()
    .from(hostDaemonCommands)
    .where(
      and(
        eq(hostDaemonCommands.state, "fetched"),
        sql`${hostDaemonCommands.fetchedAt} IS NOT NULL`,
        sql`(${currentTime} - ${hostDaemonCommands.fetchedAt}) >= CASE
          WHEN ${hostDaemonCommands.type} = 'environment.provision' THEN ${PROVISION_COMMAND_TTL_MS}
          ELSE ${STANDARD_COMMAND_TTL_MS}
        END`,
      ),
    )
    .all();

  for (const cmd of fetchedCommands) {
    if (cmd.retryCount === 0) {
      requeuedCommandIds.push(cmd.id);
      continue;
    }

    erroredCommandIds.push(cmd.id);

    // Try to extract threadId from payload and error the thread
    try {
      const payload = JSON.parse(cmd.payload);
      if (typeof payload.threadId === "string") {
        threadsToError.add(payload.threadId);
      }
    } catch {
      // payload may not contain threadId, that's fine
    }
  }

  if (requeuedCommandIds.length > 0) {
    db.update(hostDaemonCommands)
      .set({
        state: "pending",
        fetchedAt: null,
        retryCount: 1,
      })
      .where(inArray(hostDaemonCommands.id, requeuedCommandIds))
      .run();
  }

  if (erroredCommandIds.length > 0) {
    db.update(hostDaemonCommands)
      .set({
        state: "error",
        completedAt: currentTime,
        resultPayload: JSON.stringify({
          error: "Command expired after retry",
        }),
      })
      .where(inArray(hostDaemonCommands.id, erroredCommandIds))
      .run();

    transitionThreadsToError(db, notifier, {
      now: currentTime,
      threadIds: [...threadsToError],
    });
  }

  return {
    requeued: requeuedCommandIds.length,
    errored: erroredCommandIds.length,
    erroredCommandIds,
  };
}

/**
 * Sweep expired leases: sessions past lease timeout.
 * - Close the session (status="closed", closeReason="expired")
 * - Error all active/provisioning threads on that host
 *
 * Returns { sessionsClosed: number; threadsErrored: number }
 */
export function sweepExpiredLeases(
  db: DbConnection,
  notifier: DbNotifier,
  now?: number,
) {
  const currentTime = now ?? Date.now();

  // Find active sessions past their lease
  const expiredSessions = db
    .select()
    .from(hostDaemonSessions)
    .where(
      and(
        eq(hostDaemonSessions.status, "active"),
        lt(hostDaemonSessions.leaseExpiresAt, currentTime),
      ),
    )
    .all();

  if (expiredSessions.length === 0) {
    return { sessionsClosed: 0, threadsErrored: 0 };
  }

  db.update(hostDaemonSessions)
    .set({
      status: "closed",
      closedAt: currentTime,
      closeReason: "expired",
      updatedAt: currentTime,
    })
    .where(inArray(hostDaemonSessions.id, expiredSessions.map((session) => session.id)))
    .run();

  for (const session of expiredSessions) {
    notifier.notifyHost(session.hostId, ["host-disconnected"]);
  }

  const expiredHostIds = [...new Set(expiredSessions.map((session) => session.hostId))];

  // Find active/provisioning threads on environments belonging to expired hosts.
  // Idle threads are excluded — they have no in-flight work to interrupt.
  const activeThreadIds = db
    .select({ id: threads.id })
    .from(threads)
    .innerJoin(environments, eq(threads.environmentId, environments.id))
    .where(
      and(
        inArray(environments.hostId, expiredHostIds),
        inArray(threads.status, ["active", "provisioning"]),
        isNull(threads.deletedAt),
        isNull(threads.stopRequestedAt),
      ),
    )
    .all()
    .map((thread) => thread.id);

  const erroredThreadIds = transitionThreadsToError(db, notifier, {
    now: currentTime,
    threadIds: activeThreadIds,
  });

  return {
    sessionsClosed: expiredSessions.length,
    threadsErrored: erroredThreadIds.length,
  };
}

/**
 * Sweep managed environments with recorded cleanup intent and zero
 * non-archived threads.
 * Returns the list of environment records that are candidates for cleanup.
 * The caller decides what to do (e.g., queue destroy commands).
 */
export function sweepManagedEnvironments(db: DbConnection) {
  const rows = db
    .select()
    .from(environments)
    .where(
      and(
        eq(environments.managed, true),
        sql`${environments.cleanupRequestedAt} IS NOT NULL`,
        ne(environments.status, "destroyed"),
        sql`NOT EXISTS (
          SELECT 1 FROM threads
          WHERE threads.environment_id = ${environments.id}
          AND threads.archived_at IS NULL
          AND threads.deleted_at IS NULL
        )`,
      ),
    )
    .all();

  return rows;
}

export function sweepEphemeralHostsPendingCleanup(db: DbConnection) {
  return listEphemeralHostsPendingCleanup(db);
}

export function sweepIdleEphemeralHostsEligibleForSuspend(
  db: DbConnection,
  args: {
    hostId?: string;
    inactiveBefore: number;
  },
) {
  return db
    .select()
    .from(hosts)
    .where(
      and(
        eq(hosts.type, "ephemeral"),
        isNull(hosts.destroyedAt),
        isNull(hosts.suspendedAt),
        sql`${hosts.externalId} IS NOT NULL`,
        sql`COALESCE(${hosts.lastActivityAt}, ${hosts.lastSeenAt}) <= ${args.inactiveBefore}`,
        args.hostId ? eq(hosts.id, args.hostId) : undefined,
        sql`EXISTS (
          SELECT 1 FROM ${hostDaemonSessions}
          WHERE ${hostDaemonSessions.hostId} = ${hosts.id}
          AND ${hostDaemonSessions.status} = 'active'
        )`,
        sql`NOT EXISTS (
          SELECT 1 FROM ${hostDaemonCommands}
          WHERE ${hostDaemonCommands.hostId} = ${hosts.id}
          AND ${hostDaemonCommands.state} IN ('pending', 'fetched')
        )`,
        sql`NOT EXISTS (
          SELECT 1 FROM ${threads}
          INNER JOIN ${environments}
            ON ${threads.environmentId} = ${environments.id}
          WHERE ${environments.hostId} = ${hosts.id}
          AND ${threads.deletedAt} IS NULL
          AND ${threads.status} IN ('active', 'provisioning')
        )`,
      ),
    )
    .all();
}

export function sweepDestroyingEnvironments(
  db: DbConnection,
  notifier: DbNotifier,
  now?: number,
) {
  const currentTime = now ?? Date.now();
  const staleEnvironmentIds = db
    .select({ id: environments.id })
    .from(environments)
    .where(
      and(
        or(
          eq(environments.status, "destroying"),
          eq(environments.status, "destroyed"),
        ),
        lt(environments.updatedAt, currentTime - DESTROYING_ENVIRONMENT_TTL_MS),
      ),
    )
    .all()
    .map((environment) => environment.id);

  if (staleEnvironmentIds.length === 0) {
    return { deleted: 0 };
  }

  db.delete(environments)
    .where(inArray(environments.id, staleEnvironmentIds))
    .run();
  for (const environmentId of staleEnvironmentIds) {
    notifier.notifyEnvironment(environmentId, ["environment-deleted"]);
  }

  return {
    deleted: staleEnvironmentIds.length,
  };
}
