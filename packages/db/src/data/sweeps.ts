import {
  eq,
  and,
  isNotNull,
  sql,
  lt,
  ne,
  inArray,
  or,
} from "drizzle-orm";
import type { ThreadEventItemType } from "@bb/domain";
import type { DbConnection } from "../connection.js";
import type { DbNotifier } from "../notifier.js";
import {
  hostDaemonCommands,
  hostDaemonSessions,
  environments,
  maintenanceScanCursors,
} from "../schema.js";
import { transitionThreadsToError } from "./threads.js";

/** Standard command TTL: 60 seconds */
const STANDARD_COMMAND_TTL_MS = 60_000;

/** Provision command TTL: 20 minutes */
const PROVISION_COMMAND_TTL_MS = 20 * 60_000;

const EXPIRED_COMMAND_ERROR_CODE = "command_expired";
const EXPIRED_COMMAND_ERROR_MESSAGE = "Command expired after retry";

/** Destroyed environments are hard-deleted after 7 days. */
const DESTROYING_ENVIRONMENT_TTL_MS = 7 * 24 * 60 * 60_000;

/** Completed daemon commands keep result payloads briefly for result retries. */
export const COMPLETED_COMMAND_PAYLOAD_RETENTION_MS = 24 * 60 * 60_000;

/** Completed daemon command rows are retained briefly for debugging/history. */
export const COMPLETED_COMMAND_ROW_RETENTION_MS = 7 * 24 * 60 * 60_000;

/** Closed daemon session rows are retained briefly for debugging/history. */
export const CLOSED_SESSION_ROW_RETENTION_MS = 7 * 24 * 60 * 60_000;

/** Completed item output remains inspectable, but old large blobs are bounded. */
export const COMPLETED_EVENT_OUTPUT_RETENTION_MS = 7 * 24 * 60 * 60_000;

export const COMPLETED_EVENT_OUTPUT_TRUNCATION_THRESHOLD_CHARS = 32 * 1024;
export const COMPLETED_EVENT_OUTPUT_RETAINED_HEAD_CHARS = 2 * 1024;
export const COMPLETED_EVENT_OUTPUT_RETAINED_TAIL_CHARS = 2 * 1024;
export const COMPLETED_EVENT_OUTPUT_TRUNCATION_CURSOR_VERSION = 1;
export const DEFAULT_COMPLETED_COMMAND_PRUNE_BATCH_SIZE = 1_000;
export const DEFAULT_CLOSED_SESSION_PRUNE_BATCH_SIZE = 1_000;
export const DEFAULT_COMPLETED_EVENT_OUTPUT_TRUNCATION_BATCH_SIZE = 250;

const COMPLETED_EVENT_OUTPUT_TRUNCATION_MARKER =
  "\n\n[... output truncated by retention policy; showing beginning and end ...]\n\n";
const COMPLETED_EVENT_OUTPUT_TRUNCATION_CURSOR_POLICY =
  "completed_event_output_truncation";

type CompletedCommandState = "success" | "error";
type CompletedCommandDeleteParameters = [
  CompletedCommandState,
  CompletedCommandState,
  number,
  number,
];
type ClosedSessionState = "closed";
type ClosedSessionDeleteParameters = [ClosedSessionState, number, number];
type CompletedEventOutputItemKind = Extract<
  ThreadEventItemType,
  "commandExecution" | "toolCall" | "webSearch" | "webFetch"
>;
type CompletedEventOutputPath = "aggregatedOutput" | "result" | "resultText";
type CompletedEventOutputScanParameters = [
  "item/completed",
  CompletedEventOutputItemKind,
  number,
  number,
  string,
  number,
];
type SqliteParameter = string | number | bigint | Buffer | null;

interface CompletedEventOutputPathTarget {
  itemKind: CompletedEventOutputItemKind;
  outputPath: CompletedEventOutputPath;
}

interface CompletedEventOutputScanCursor {
  lastCreatedAt: number;
  lastEventId: string;
}

interface CompletedEventOutputScanRow {
  created_at: number;
  id: string;
}

interface TruncateCompletedEventItemOutputPathArgs
  extends CompletedEventOutputPathTarget,
    TruncateCompletedEventItemOutputsArgs {}

interface UpdateCompletedEventOutputScanRowsArgs
  extends CompletedEventOutputPathTarget {
  rows: CompletedEventOutputScanRow[];
  truncatedAt: number;
}

interface AdvanceCompletedEventOutputScanCursorArgs
  extends CompletedEventOutputPathTarget,
    CompletedEventOutputScanCursor {
  updatedAt: number;
}

export interface PruneCompletedCommandPayloadsArgs {
  completedBefore: number;
}

export interface PruneCompletedCommandPayloadsResult {
  pruned: number;
}

export interface PruneCompletedCommandsArgs {
  completedBefore: number;
  limit: number;
}

export interface PruneCompletedCommandsResult {
  deleted: number;
}

export interface PruneClosedSessionsArgs {
  closedBefore: number;
  limit: number;
}

export interface PruneClosedSessionsResult {
  deleted: number;
}

export interface TruncateCompletedEventItemOutputsArgs {
  createdBefore: number;
  limit: number;
  truncatedAt: number;
}

export interface TruncateCompletedEventItemOutputsResult {
  commandExecutionOutputs: number;
  toolCallResults: number;
  webFetchResultTexts: number;
  webSearchResultTexts: number;
}

export interface SweepExpiredLeasesResult {
  expiredHostIds: string[];
  expiredSessionIds: string[];
  sessionsClosed: number;
}

export function pruneCompletedCommandPayloads(
  db: DbConnection,
  args: PruneCompletedCommandPayloadsArgs,
): PruneCompletedCommandPayloadsResult {
  const result = db
    .update(hostDaemonCommands)
    .set({
      payload: "{}",
      resultPayload: null,
    })
    .where(
      and(
        inArray(hostDaemonCommands.state, ["success", "error"]),
        isNotNull(hostDaemonCommands.completedAt),
        lt(hostDaemonCommands.completedAt, args.completedBefore),
        or(
          ne(hostDaemonCommands.payload, "{}"),
          isNotNull(hostDaemonCommands.resultPayload),
        ),
      ),
    )
    .run();

  return { pruned: result.changes };
}

export function pruneCompletedCommands(
  db: DbConnection,
  args: PruneCompletedCommandsArgs,
): PruneCompletedCommandsResult {
  const result = db.$client
    .prepare<CompletedCommandDeleteParameters>(
      `
        DELETE FROM host_daemon_commands
        WHERE id IN (
          SELECT id
          FROM host_daemon_commands INDEXED BY host_daemon_commands_completed_prune_idx
          WHERE state IN (?, ?)
            AND completed_at IS NOT NULL
            AND completed_at < ?
          ORDER BY completed_at
          LIMIT ?
        )
      `,
    )
    .run("success", "error", args.completedBefore, args.limit);

  return { deleted: result.changes };
}

export function pruneClosedSessions(
  db: DbConnection,
  args: PruneClosedSessionsArgs,
): PruneClosedSessionsResult {
  // Keep the prune plan pinned to the retention index; this path runs
  // periodically and can otherwise regress into a scan plus temp sort.
  const result = db.$client
    .prepare<ClosedSessionDeleteParameters>(
      `
        DELETE FROM host_daemon_sessions
        WHERE id IN (
          SELECT id
          FROM host_daemon_sessions INDEXED BY host_daemon_sessions_closed_prune_idx
          WHERE status = ?
            AND closed_at IS NOT NULL
            AND closed_at < ?
          ORDER BY closed_at
          LIMIT ?
        )
      `,
    )
    .run("closed", args.closedBefore, args.limit);

  return { deleted: result.changes };
}

function buildCompletedEventOutputCursorId(
  args: CompletedEventOutputPathTarget,
): string {
  return [
    COMPLETED_EVENT_OUTPUT_TRUNCATION_CURSOR_POLICY,
    `v${COMPLETED_EVENT_OUTPUT_TRUNCATION_CURSOR_VERSION}`,
    args.itemKind,
    args.outputPath,
  ].join(":");
}

function getCompletedEventOutputScanCursor(
  db: DbConnection,
  args: CompletedEventOutputPathTarget,
): CompletedEventOutputScanCursor {
  const row = db
    .select({
      lastCreatedAt: maintenanceScanCursors.lastCreatedAt,
      lastEventId: maintenanceScanCursors.lastEventId,
    })
    .from(maintenanceScanCursors)
    .where(
      eq(maintenanceScanCursors.id, buildCompletedEventOutputCursorId(args)),
    )
    .get();

  return row ?? { lastCreatedAt: 0, lastEventId: "" };
}

function listCompletedEventOutputScanRows(
  db: DbConnection,
  args: TruncateCompletedEventItemOutputPathArgs,
): CompletedEventOutputScanRow[] {
  if (args.limit <= 0) {
    return [];
  }

  const cursor = getCompletedEventOutputScanCursor(db, args);
  return db.$client
    .prepare<CompletedEventOutputScanParameters, CompletedEventOutputScanRow>(
      `
        SELECT id, created_at
        FROM events
        WHERE type = ?
          AND item_kind = ?
          AND created_at < ?
          AND (created_at, id) > (?, ?)
        ORDER BY created_at, id
        LIMIT ?
      `,
    )
    .all(
      "item/completed",
      args.itemKind,
      args.createdBefore,
      cursor.lastCreatedAt,
      cursor.lastEventId,
      args.limit,
    );
}

function updateCompletedEventOutputScanRows(
  db: DbConnection,
  args: UpdateCompletedEventOutputScanRowsArgs,
): number {
  if (args.rows.length === 0) {
    return 0;
  }

  const valuePath = `$.item.${args.outputPath}`;
  const truncationPath = `$.item.truncation.${args.outputPath}`;
  const rowPlaceholders = args.rows.map(() => "?").join(",");
  const parameters: SqliteParameter[] = [
    valuePath,
    valuePath,
    COMPLETED_EVENT_OUTPUT_RETAINED_HEAD_CHARS,
    COMPLETED_EVENT_OUTPUT_TRUNCATION_MARKER,
    valuePath,
    COMPLETED_EVENT_OUTPUT_RETAINED_TAIL_CHARS,
    `${truncationPath}.originalLength`,
    valuePath,
    `${truncationPath}.retainedHeadLength`,
    COMPLETED_EVENT_OUTPUT_RETAINED_HEAD_CHARS,
    `${truncationPath}.retainedTailLength`,
    COMPLETED_EVENT_OUTPUT_RETAINED_TAIL_CHARS,
    `${truncationPath}.truncatedAt`,
    args.truncatedAt,
    ...args.rows.map((row) => row.id),
    valuePath,
    truncationPath,
    valuePath,
    COMPLETED_EVENT_OUTPUT_TRUNCATION_THRESHOLD_CHARS,
  ];

  const result = db.$client
    .prepare<SqliteParameter[]>(
      `
        UPDATE events
        SET data = json_set(
          data,
          ?,
          substr(json_extract(data, ?), 1, ?)
            || ?
            || substr(json_extract(data, ?), -?),
          ?,
          length(json_extract(data, ?)),
          ?,
          ?,
          ?,
          ?,
          ?,
          ?
        )
        WHERE id IN (${rowPlaceholders})
          AND json_type(data, ?) = 'text'
          AND json_type(data, ?) IS NULL
          AND length(json_extract(data, ?)) > ?
      `,
    )
    .run(...parameters);

  return result.changes;
}

function advanceCompletedEventOutputScanCursor(
  db: DbConnection,
  args: AdvanceCompletedEventOutputScanCursorArgs,
): void {
  db.insert(maintenanceScanCursors)
    .values({
      id: buildCompletedEventOutputCursorId(args),
      policy: COMPLETED_EVENT_OUTPUT_TRUNCATION_CURSOR_POLICY,
      version: COMPLETED_EVENT_OUTPUT_TRUNCATION_CURSOR_VERSION,
      itemKind: args.itemKind,
      outputPath: args.outputPath,
      lastCreatedAt: args.lastCreatedAt,
      lastEventId: args.lastEventId,
      updatedAt: args.updatedAt,
    })
    .onConflictDoUpdate({
      target: maintenanceScanCursors.id,
      set: {
        lastCreatedAt: args.lastCreatedAt,
        lastEventId: args.lastEventId,
        updatedAt: args.updatedAt,
      },
    })
    .run();
}

function truncateCompletedEventItemOutputPath(
  db: DbConnection,
  args: TruncateCompletedEventItemOutputPathArgs,
): number {
  const rows = listCompletedEventOutputScanRows(db, args);
  const truncated = updateCompletedEventOutputScanRows(db, {
    itemKind: args.itemKind,
    outputPath: args.outputPath,
    rows,
    truncatedAt: args.truncatedAt,
  });
  const lastRow = rows.at(-1);
  if (lastRow) {
    advanceCompletedEventOutputScanCursor(db, {
      itemKind: args.itemKind,
      outputPath: args.outputPath,
      lastCreatedAt: lastRow.created_at,
      lastEventId: lastRow.id,
      updatedAt: args.truncatedAt,
    });
  }
  return truncated;
}

export function truncateCompletedEventItemOutputs(
  db: DbConnection,
  args: TruncateCompletedEventItemOutputsArgs,
): TruncateCompletedEventItemOutputsResult {
  return {
    commandExecutionOutputs: truncateCompletedEventItemOutputPath(db, {
      ...args,
      itemKind: "commandExecution",
      outputPath: "aggregatedOutput",
    }),
    toolCallResults: truncateCompletedEventItemOutputPath(db, {
      ...args,
      itemKind: "toolCall",
      outputPath: "result",
    }),
    webFetchResultTexts: truncateCompletedEventItemOutputPath(db, {
      ...args,
      itemKind: "webFetch",
      outputPath: "resultText",
    }),
    webSearchResultTexts: truncateCompletedEventItemOutputPath(db, {
      ...args,
      itemKind: "webSearch",
      outputPath: "resultText",
    }),
  };
}

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
          errorCode: EXPIRED_COMMAND_ERROR_CODE,
          errorMessage: EXPIRED_COMMAND_ERROR_MESSAGE,
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
 * - Notify host availability changed
 *
 * Returns the closed sessions and hosts so the server can notify runtime
 * display state and close any still-registered sockets.
 */
export function sweepExpiredLeases(
  db: DbConnection,
  notifier: DbNotifier,
  now?: number,
): SweepExpiredLeasesResult {
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
    return {
      expiredHostIds: [],
      expiredSessionIds: [],
      sessionsClosed: 0,
    };
  }

  db.update(hostDaemonSessions)
    .set({
      status: "closed",
      closedAt: currentTime,
      closeReason: "expired",
      updatedAt: currentTime,
    })
    .where(
      inArray(
        hostDaemonSessions.id,
        expiredSessions.map((session) => session.id),
      ),
    )
    .run();

  for (const session of expiredSessions) {
    notifier.notifyHost(session.hostId, ["host-disconnected"]);
  }

  const expiredHostIds = [
    ...new Set(expiredSessions.map((session) => session.hostId)),
  ];

  return {
    expiredHostIds,
    expiredSessionIds: expiredSessions.map((session) => session.id),
    sessionsClosed: expiredSessions.length,
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
