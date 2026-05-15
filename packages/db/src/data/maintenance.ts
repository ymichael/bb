import { and, count, inArray, isNull } from "drizzle-orm";
import { activeLifecycleOperationStates } from "@bb/domain";
import type { DbConnection } from "../connection.js";
import {
  environmentOperations,
  hostDaemonCommands,
  hostOperations,
  pendingInteractions,
  projectOperations,
  threadOperations,
  threads,
} from "../schema.js";

export const DATABASE_COMPACTION_MIN_RECLAIMABLE_BYTES = 128 * 1024 * 1024;
export const DATABASE_COMPACTION_MIN_RECLAIMABLE_RATIO = 0.15;

const ACTIVE_COMMAND_STATES = ["pending", "fetched"] as const;
const ACTIVE_THREAD_STATUSES = ["active", "provisioning"] as const;
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

interface DbstatUnusedRow {
  unusedBytes: number;
}

export interface DatabaseMaintenanceActivity {
  activeCommandCount: number;
  activeEnvironmentOperationCount: number;
  activeHostOperationCount: number;
  activePendingInteractionCount: number;
  activeProjectOperationCount: number;
  activeThreadCount: number;
  activeThreadOperationCount: number;
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

export interface CompactDatabaseResult {
  after: DatabaseCompactionStats;
  before: DatabaseCompactionStats;
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

export function getDatabaseMaintenanceActivity(
  db: DbConnection,
): DatabaseMaintenanceActivity {
  const activeCommandCount = countValue(
    db
      .select({ value: count() })
      .from(hostDaemonCommands)
      .where(inArray(hostDaemonCommands.state, [...ACTIVE_COMMAND_STATES]))
      .get(),
  );
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
  const activeProjectOperationCount = countValue(
    db
      .select({ value: count() })
      .from(projectOperations)
      .where(
        inArray(projectOperations.state, [...activeLifecycleOperationStates]),
      )
      .get(),
  );
  const activeEnvironmentOperationCount = countValue(
    db
      .select({ value: count() })
      .from(environmentOperations)
      .where(
        inArray(
          environmentOperations.state,
          [...activeLifecycleOperationStates],
        ),
      )
      .get(),
  );
  const activeHostOperationCount = countValue(
    db
      .select({ value: count() })
      .from(hostOperations)
      .where(inArray(hostOperations.state, [...activeLifecycleOperationStates]))
      .get(),
  );
  const activeThreadOperationCount = countValue(
    db
      .select({ value: count() })
      .from(threadOperations)
      .where(
        inArray(threadOperations.state, [...activeLifecycleOperationStates]),
      )
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
    activeEnvironmentOperationCount,
    activeHostOperationCount,
    activePendingInteractionCount,
    activeProjectOperationCount,
    activeThreadCount,
    activeThreadOperationCount,
  };
}

export function isDatabaseMaintenanceIdle(
  activity: DatabaseMaintenanceActivity,
): boolean {
  return (
    activity.activeCommandCount === 0 &&
    activity.activeEnvironmentOperationCount === 0 &&
    activity.activeHostOperationCount === 0 &&
    activity.activePendingInteractionCount === 0 &&
    activity.activeProjectOperationCount === 0 &&
    activity.activeThreadCount === 0 &&
    activity.activeThreadOperationCount === 0
  );
}

export function getDatabaseCompactionStats(
  db: DbConnection,
): DatabaseCompactionStats {
  const pageCount = readPageCount(db);
  const pageSize = readPageSize(db);
  const freelistCount = readFreelistCount(db);
  const databaseBytes = pageCount * pageSize;
  const freelistBytes = freelistCount * pageSize;
  const unusedBytes = readDbstatUnusedBytes(db);

  return {
    databaseBytes,
    freelistBytes,
    freelistCount,
    pageCount,
    pageSize,
    reclaimableBytes: freelistBytes + unusedBytes,
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

export function compactDatabase(db: DbConnection): CompactDatabaseResult {
  const before = getDatabaseCompactionStats(db);

  db.$client.exec("PRAGMA wal_checkpoint(TRUNCATE)");
  db.$client.exec("VACUUM");
  db.$client.exec("PRAGMA wal_checkpoint(TRUNCATE)");

  return {
    after: getDatabaseCompactionStats(db),
    before,
  };
}
