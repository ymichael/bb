import { and, count, eq, inArray, isNotNull, isNull } from "drizzle-orm";
import type { DbConnection } from "../connection.js";
import {
  environments,
  pendingInteractions,
  projects,
  threads,
} from "../schema.js";

export const DATABASE_COMPACTION_MIN_RECLAIMABLE_BYTES = 128 * 1024 * 1024;
export const DATABASE_COMPACTION_MIN_RECLAIMABLE_RATIO = 0.15;

export const DATABASE_INCREMENTAL_VACUUM_MIN_FREELIST_PAGES = 1_024;
export const DATABASE_INCREMENTAL_VACUUM_MAX_PAGES = 20_000;
export const DATABASE_MAINTENANCE_BUSY_TIMEOUT_MS = 100;

const ACTIVE_THREAD_STATUSES = ["active", "starting"] as const;
const ACTIVE_PENDING_INTERACTION_STATUSES = ["pending", "resolving"] as const;

interface CountRow {
  value: number;
}

interface PageCountRow {
  page_count: number;
}

interface PageSizeRow {
  page_size: number;
}

interface FreelistCountRow {
  freelist_count: number;
}

interface BusyTimeoutRow {
  timeout: number;
}

interface DbstatUnusedRow {
  unusedBytes: number;
}

interface ForeignKeysRow {
  foreign_keys: number;
}

interface SqliteTableNameRow {
  name: string;
}

export interface DatabaseMaintenanceActivity {
  activeCommandCount: number;
  activeEnvironmentProvisioningCount: number;
  activePendingInteractionCount: number;
  activeProjectDeletionCount: number;
  activeThreadCount: number;
  activeThreadProvisioningCount: number;
}

export interface DatabaseCompactionStats {
  databaseBytes: number;
  freelistBytes: number;
  freelistCount: number;
  pageCount: number;
  pageSize: number;
  reclaimableBytes: number;
  unusedBytes: number;
}

export interface DatabaseCompactionDecisionArgs {
  minReclaimableBytes: number;
  minReclaimableRatio: number;
  stats: DatabaseCompactionStats;
}

export interface DatabaseFreelistStats {
  databaseBytes: number;
  freelistBytes: number;
  freelistCount: number;
  pageCount: number;
  pageSize: number;
}

export interface DatabaseIncrementalVacuumDecisionArgs {
  minFreelistPages: number;
  stats: DatabaseFreelistStats;
}

export interface CompactDatabaseResult {
  after: DatabaseCompactionStats;
  before: DatabaseCompactionStats;
}

export interface IncrementalVacuumResult {
  after: DatabaseFreelistStats;
  before: DatabaseFreelistStats;
}

export interface RunIncrementalVacuumArgs {
  maxPages: number;
}

export interface DropDeferredLegacyTablesResult {
  droppedTables: string[];
}

interface RunWithMaintenanceBusyTimeoutArgs<TValue> {
  db: DbConnection;
  work: () => TValue;
}

const DEFERRED_LEGACY_TABLE_NAMES = [
  "client_turn_requests",
  "environment_operations",
  "host_daemon_command_attempts",
  "host_daemon_commands",
  "project_operations",
  "thread_operations",
] as const;
const DEFERRED_LEGACY_TABLE_NAME_SET = new Set<string>(
  DEFERRED_LEGACY_TABLE_NAMES,
);
const DEFERRED_LEGACY_TABLE_NAME_LIST_SQL = DEFERRED_LEGACY_TABLE_NAMES.map(
  quoteSqlString,
).join(", ");

function quoteSqlString(value: string): string {
  return `'${value.replaceAll("'", "''")}'`;
}

function quoteSqlIdentifier(identifier: string): string {
  return `"${identifier.replaceAll('"', '""')}"`;
}

function countValue(row: CountRow | undefined): number {
  return row?.value ?? 0;
}

function readPageCount(db: DbConnection): number {
  return (
    db.$client.prepare<[], PageCountRow>("PRAGMA page_count").get()
      ?.page_count ?? 0
  );
}

function readPageSize(db: DbConnection): number {
  return (
    db.$client.prepare<[], PageSizeRow>("PRAGMA page_size").get()?.page_size ??
    0
  );
}

function readFreelistCount(db: DbConnection): number {
  return (
    db.$client
      .prepare<[], FreelistCountRow>("PRAGMA freelist_count")
      .get()?.freelist_count ?? 0
  );
}

function readBusyTimeoutMs(db: DbConnection): number {
  return (
    db.$client.prepare<[], BusyTimeoutRow>("PRAGMA busy_timeout").get()
      ?.timeout ?? 0
  );
}

function readForeignKeysEnabled(db: DbConnection): boolean {
  return (
    db.$client.prepare<[], ForeignKeysRow>("PRAGMA foreign_keys").get()
      ?.foreign_keys === 1
  );
}

function readDbstatUnusedBytes(db: DbConnection): number {
  try {
    return (
      db.$client
        .prepare<[], DbstatUnusedRow>(
          "SELECT COALESCE(SUM(unused), 0) AS unusedBytes FROM dbstat WHERE name NOT LIKE 'sqlite_%'",
        )
        .get()?.unusedBytes ?? 0
    );
  } catch {
    return 0;
  }
}

function runWithMaintenanceBusyTimeout<TValue>(
  args: RunWithMaintenanceBusyTimeoutArgs<TValue>,
): TValue {
  const originalBusyTimeoutMs = readBusyTimeoutMs(args.db);
  args.db.$client.exec(
    `PRAGMA busy_timeout = ${DATABASE_MAINTENANCE_BUSY_TIMEOUT_MS}`,
  );
  try {
    return args.work();
  } finally {
    args.db.$client.exec(`PRAGMA busy_timeout = ${originalBusyTimeoutMs}`);
  }
}

export function getDatabaseMaintenanceActivity(
  db: DbConnection,
): DatabaseMaintenanceActivity {
  const activeCommandCount = 0;
  const activeThreadCount = countValue(
    db
      .select({ value: count() })
      .from(threads)
      .where(
        and(
          inArray(threads.status, [...ACTIVE_THREAD_STATUSES]),
          isNull(threads.deletedAt),
        ),
      )
      .get(),
  );
  const activeProjectDeletionCount = countValue(
    db
      .select({ value: count() })
      .from(projects)
      .where(isNotNull(projects.deletedAt))
      .get(),
  );
  const activeEnvironmentProvisioningCount = countValue(
    db
      .select({ value: count() })
      .from(environments)
      .where(eq(environments.status, "provisioning"))
      .get(),
  );
  const activeThreadProvisioningCount = countValue(
    db
      .select({ value: count() })
      .from(threads)
      .where(eq(threads.status, "starting"))
      .get(),
  );
  const activePendingInteractionCount = countValue(
    db
      .select({ value: count() })
      .from(pendingInteractions)
      .where(
        inArray(pendingInteractions.status, [
          ...ACTIVE_PENDING_INTERACTION_STATUSES,
        ]),
      )
      .get(),
  );

  return {
    activeCommandCount,
    activeEnvironmentProvisioningCount,
    activePendingInteractionCount,
    activeProjectDeletionCount,
    activeThreadCount,
    activeThreadProvisioningCount,
  };
}

export function isDatabaseMaintenanceIdle(
  activity: DatabaseMaintenanceActivity,
): boolean {
  return (
    activity.activeCommandCount === 0 &&
    activity.activeEnvironmentProvisioningCount === 0 &&
    activity.activePendingInteractionCount === 0 &&
    activity.activeProjectDeletionCount === 0 &&
    activity.activeThreadCount === 0 &&
    activity.activeThreadProvisioningCount === 0
  );
}

export function listDeferredLegacyTables(db: DbConnection): string[] {
  return db.$client
    .prepare<[], SqliteTableNameRow>(
      `
        SELECT name
        FROM sqlite_master
        WHERE type = 'table'
          AND name IN (${DEFERRED_LEGACY_TABLE_NAME_LIST_SQL})
        ORDER BY name
      `,
    )
    .all()
    .map((row) => row.name)
    .filter((name) => DEFERRED_LEGACY_TABLE_NAME_SET.has(name));
}

export function dropDeferredLegacyTables(
  db: DbConnection,
): DropDeferredLegacyTablesResult {
  return runWithMaintenanceBusyTimeout({
    db,
    work: () => {
      const droppedTables = listDeferredLegacyTables(db);
      if (droppedTables.length === 0) {
        return { droppedTables };
      }

      const foreignKeysEnabled = readForeignKeysEnabled(db);
      db.$client.pragma("foreign_keys = OFF");
      try {
        for (const tableName of droppedTables) {
          db.$client.prepare(
            `DROP TABLE IF EXISTS ${quoteSqlIdentifier(tableName)}`,
          ).run();
        }
      } finally {
        db.$client.pragma(
          `foreign_keys = ${foreignKeysEnabled ? "ON" : "OFF"}`,
        );
      }

      return { droppedTables };
    },
  });
}

export function getDatabaseFreelistStats(
  db: DbConnection,
): DatabaseFreelistStats {
  const pageCount = readPageCount(db);
  const pageSize = readPageSize(db);
  const freelistCount = readFreelistCount(db);
  const databaseBytes = pageCount * pageSize;
  const freelistBytes = freelistCount * pageSize;

  return {
    databaseBytes,
    freelistBytes,
    freelistCount,
    pageCount,
    pageSize,
  };
}

export function getDatabaseCompactionStats(
  db: DbConnection,
): DatabaseCompactionStats {
  const freelistStats = getDatabaseFreelistStats(db);
  const unusedBytes = readDbstatUnusedBytes(db);

  return {
    ...freelistStats,
    reclaimableBytes: freelistStats.freelistBytes + unusedBytes,
    unusedBytes,
  };
}

export function shouldCompactDatabase(
  args: DatabaseCompactionDecisionArgs,
): boolean {
  if (args.stats.databaseBytes <= 0) {
    return false;
  }

  return (
    args.stats.reclaimableBytes >= args.minReclaimableBytes &&
    args.stats.reclaimableBytes / args.stats.databaseBytes >=
      args.minReclaimableRatio
  );
}

export function shouldRunIncrementalVacuum(
  args: DatabaseIncrementalVacuumDecisionArgs,
): boolean {
  return args.stats.freelistCount >= args.minFreelistPages;
}

export type DatabaseAutoVacuumMode = "none" | "full" | "incremental";

interface AutoVacuumModeRow {
  auto_vacuum: number;
}

export function getDatabaseAutoVacuumMode(
  db: DbConnection,
): DatabaseAutoVacuumMode {
  const mode =
    db.$client
      .prepare<[], AutoVacuumModeRow>("PRAGMA auto_vacuum")
      .get()?.auto_vacuum ?? 0;
  switch (mode) {
    case 1:
      return "full";
    case 2:
      return "incremental";
    default:
      return "none";
  }
}

export function compactDatabase(db: DbConnection): CompactDatabaseResult {
  return runWithMaintenanceBusyTimeout({
    db,
    work: () => {
      const before = getDatabaseCompactionStats(db);

      db.$client.exec("PRAGMA auto_vacuum = INCREMENTAL");
      db.$client.exec("PRAGMA wal_checkpoint(TRUNCATE)");
      db.$client.exec("VACUUM");
      db.$client.exec("PRAGMA wal_checkpoint(TRUNCATE)");

      return {
        after: getDatabaseCompactionStats(db),
        before,
      };
    },
  });
}

export function runIncrementalVacuum(
  db: DbConnection,
  args: RunIncrementalVacuumArgs,
): IncrementalVacuumResult {
  return runWithMaintenanceBusyTimeout({
    db,
    work: () => {
      const before = getDatabaseFreelistStats(db);

      db.$client.exec("PRAGMA wal_checkpoint(PASSIVE)");
      db.$client.exec(`PRAGMA incremental_vacuum(${args.maxPages})`);
      db.$client.exec("PRAGMA wal_checkpoint(PASSIVE)");

      return {
        after: getDatabaseFreelistStats(db),
        before,
      };
    },
  });
}
