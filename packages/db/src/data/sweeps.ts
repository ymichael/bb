import {
  eq,
  and,
  sql,
  lt,
  asc,
} from "drizzle-orm";
import { type ThreadEventItemType } from "@bb/domain";
import type { DbConnection } from "../connection.js";
import type { DbNotifier } from "../notifier.js";
import { environments, maintenanceScanCursors } from "../schema.js";

export const DESTROYED_ENVIRONMENT_TTL_MS = 7 * 24 * 60 * 60_000;

export const CLOSED_SESSION_ROW_RETENTION_MS = 7 * 24 * 60 * 60_000;

export const COMPLETED_EVENT_OUTPUT_RETENTION_MS = 7 * 24 * 60 * 60_000;

export const COMPLETED_EVENT_OUTPUT_TRUNCATION_THRESHOLD_CHARS = 32 * 1024;
export const COMPLETED_EVENT_OUTPUT_RETAINED_HEAD_CHARS = 2 * 1024;
export const COMPLETED_EVENT_OUTPUT_RETAINED_TAIL_CHARS = 2 * 1024;
const COMPLETED_EVENT_OUTPUT_TRUNCATION_CURSOR_VERSION = 1;
export const DEFAULT_CLOSED_SESSION_PRUNE_BATCH_SIZE = 1_000;
export const DEFAULT_COMPLETED_EVENT_OUTPUT_TRUNCATION_BATCH_SIZE = 250;
export const DEFAULT_DESTROYED_ENVIRONMENT_EVENT_DETACH_BATCH_SIZE = 50;
export const DEFAULT_DESTROYED_ENVIRONMENT_PRUNE_BATCH_SIZE = 10;

const COMPLETED_EVENT_OUTPUT_TRUNCATION_MARKER =
  "\n\n[... output truncated by retention policy; showing beginning and end ...]\n\n";
const COMPLETED_EVENT_OUTPUT_TRUNCATION_CURSOR_POLICY =
  "completed_event_output_truncation";

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

export interface PruneClosedSessionsArgs {
  closedBefore: number;
  limit: number;
}

export interface PruneClosedSessionsResult {
  deleted: number;
}

export interface PruneDestroyedEnvironmentsArgs {
  updatedBefore: number;
  eventBatchSize: number;
  limit: number;
}

export interface PruneDestroyedEnvironmentsResult {
  deleted: number;
  detachedEvents: number;
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

export function pruneClosedSessions(
  db: DbConnection,
  args: PruneClosedSessionsArgs,
): PruneClosedSessionsResult {
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

export function sweepManagedEnvironments(db: DbConnection) {
  const rows = db
    .select()
    .from(environments)
    .where(
      and(
        eq(environments.managed, true),
        eq(environments.status, "retiring"),
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

export function pruneDestroyedEnvironments(
  db: DbConnection,
  notifier: DbNotifier,
  args: PruneDestroyedEnvironmentsArgs,
): PruneDestroyedEnvironmentsResult {
  if (args.limit <= 0 || args.eventBatchSize <= 0) {
    return { deleted: 0, detachedEvents: 0 };
  }

  const staleEnvironmentIds = db
    .select({ id: environments.id })
    .from(environments)
    .where(
      and(
        eq(environments.status, "destroyed"),
        lt(environments.updatedAt, args.updatedBefore),
      ),
    )
    .orderBy(asc(environments.updatedAt), asc(environments.id))
    .limit(args.limit)
    .all()
    .map((environment) => environment.id);

  let deleted = 0;
  let detachedEvents = 0;
  for (const environmentId of staleEnvironmentIds) {
    const result = db.transaction(
      (tx) => {
        const detached = tx.run(sql`
          UPDATE events
          SET environment_id = NULL
          WHERE rowid IN (
            SELECT rowid
            FROM events INDEXED BY events_environment_idx
            WHERE environment_id = ${environmentId}
            ORDER BY rowid
            LIMIT ${args.eventBatchSize}
          )
        `).changes;
        if (detached > 0) {
          return { deleted: 0, detachedEvents: detached };
        }
        const deleteResult = tx
          .delete(environments)
          .where(eq(environments.id, environmentId))
          .run();
        return { deleted: deleteResult.changes, detachedEvents: 0 };
      },
      { behavior: "immediate" },
    );
    detachedEvents += result.detachedEvents;
    if (result.deleted > 0) {
      notifier.notifyEnvironment(environmentId, ["environment-deleted"]);
      deleted += result.deleted;
    }
  }

  return { deleted, detachedEvents };
}
