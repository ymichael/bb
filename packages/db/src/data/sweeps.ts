import { eq, and, sql, lt, ne, inArray, or } from "drizzle-orm";
import type { DbConnection } from "../connection.js";
import type { DbNotifier } from "../notifier.js";
import {
  hostDaemonCommands,
  hostDaemonSessions,
  threads,
  environments,
} from "../schema.js";
import { getThread, transitionThreadStatus } from "./threads.js";

/** Standard command TTL: 60 seconds */
const STANDARD_COMMAND_TTL_MS = 60_000;

/** Provision command TTL: 5 minutes */
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
  let requeued = 0;
  let errored = 0;

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
      // Re-queue: set back to pending with retryCount=1
      db.update(hostDaemonCommands)
        .set({
          state: "pending",
          fetchedAt: null,
          retryCount: 1,
        })
        .where(eq(hostDaemonCommands.id, cmd.id))
        .run();
      requeued++;
    } else {
      // Error the command
      db.update(hostDaemonCommands)
        .set({
          state: "error",
          completedAt: currentTime,
          resultPayload: JSON.stringify({
            error: "Command expired after retry",
          }),
        })
        .where(eq(hostDaemonCommands.id, cmd.id))
        .run();
      errored++;

      // Try to extract threadId from payload and error the thread
      try {
        const payload = JSON.parse(cmd.payload);
        if (payload.threadId) {
          const thread = getThread(db, payload.threadId);
          if (!thread || thread.deletedAt !== null || thread.stopRequestedAt !== null) {
            continue;
          }
          try {
            transitionThreadStatus(db, notifier, payload.threadId, "error");
          } catch {
            // Invalid transition (e.g., thread already in error or in created state) — skip
          }
        }
      } catch {
        // payload may not contain threadId, that's fine
      }
    }
  }

  return { requeued, errored };
}

/**
 * Sweep expired leases: sessions past lease timeout.
 * - Close the session (status="closed", closeReason="expired")
 * - Error all active/idle threads on that host
 *
 * Returns { sessionsClosed: number; threadsErrored: number }
 */
export function sweepExpiredLeases(
  db: DbConnection,
  notifier: DbNotifier,
  now?: number,
) {
  const currentTime = now ?? Date.now();
  let sessionsClosed = 0;
  let threadsErrored = 0;

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

  for (const session of expiredSessions) {
    // Close the session
    db.update(hostDaemonSessions)
      .set({
        status: "closed",
        closedAt: currentTime,
        closeReason: "expired",
        updatedAt: currentTime,
      })
      .where(eq(hostDaemonSessions.id, session.id))
      .run();
    sessionsClosed++;

    notifier.notifyHost(["host-disconnected"]);

    // Find all active/idle/provisioning threads on environments belonging to this host
    const activeThreads = db
      .select({ id: threads.id })
      .from(threads)
      .innerJoin(environments, eq(threads.environmentId, environments.id))
      .where(
        and(
          eq(environments.hostId, session.hostId),
          inArray(threads.status, ["active", "idle", "provisioning"]),
          sql`${threads.deletedAt} IS NULL`,
          sql`${threads.stopRequestedAt} IS NULL`,
        ),
      )
      .all();

    for (const thread of activeThreads) {
      try {
        transitionThreadStatus(db, notifier, thread.id, "error");
        threadsErrored++;
      } catch {
        // Invalid transition — skip
      }
    }
  }

  return { sessionsClosed, threadsErrored };
}

/**
 * Sweep managed environments with zero non-archived threads.
 * Returns the list of environment records that are candidates for cleanup.
 * The caller decides what to do (e.g., queue destroy commands).
 */
export function sweepManagedEnvironments(db: DbConnection) {
  // Single query: managed environments NOT destroying, with zero non-archived threads
  const rows = db
    .select()
    .from(environments)
    .where(
      and(
        eq(environments.managed, true),
        ne(environments.status, "destroying"),
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
