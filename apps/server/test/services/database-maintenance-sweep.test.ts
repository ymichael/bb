import Database from "better-sqlite3";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { performance } from "node:perf_hooks";
import { describe, expect, it } from "vitest";
import {
  createConnection,
  createProject,
  createThread,
  DATABASE_MAINTENANCE_BUSY_TIMEOUT_MS,
  type DbConnection,
  type SlowDbQueryLogFields,
  type SlowDbQueryLogger,
  getDatabaseAutoVacuumMode,
  getDatabaseFreelistStats,
  getDatabaseMaintenanceActivity,
  isDatabaseMaintenanceIdle,
  listDeferredLegacyTables,
  migrate,
  noopNotifier,
  upsertHost,
} from "@bb/db";
import type { ServerLogger } from "../../src/types.js";
import { runDatabaseMaintenanceSweep } from "../../src/services/system/periodic-sweeps.js";
import { testLogger } from "../helpers/test-app.js";

const ONE_HOUR_MS = 60 * 60_000;
const SWEEP_TIME_START_MS = Date.now() + 24 * ONE_HOUR_MS;
const FREELIST_ROW_COUNT = 1_200;
const SQLITE_BUSY_HEADROOM_MS = 1_000;
const TEST_DEFERRED_LEGACY_TABLE_NAMES = [
  "client_turn_requests",
  "environment_operations",
  "host_daemon_command_attempts",
  "host_daemon_commands",
  "project_operations",
  "thread_operations",
];

let sweepTimeMs = SWEEP_TIME_START_MS;

interface TempDatabasePath {
  dbPath: string;
  cleanup(): void;
}

class CapturingSlowQueryLogger implements SlowDbQueryLogger {
  debugLogs: SlowDbQueryLogFields[] = [];

  info(fields: SlowDbQueryLogFields): void {
    this.debugLogs.push(fields);
  }

  clear(): void {
    this.debugLogs = [];
  }
}

function createCapturingServerLogger() {
  const warnMessages: string[] = [];
  const logger: ServerLogger = {
    debug(): void {},
    error(): void {},
    info(): void {},
    warn(): void {
      warnMessages.push("warn");
    },
  };

  return { logger, warnMessages };
}

function nextSweepTime(): number {
  sweepTimeMs += 2 * ONE_HOUR_MS;
  return sweepTimeMs;
}

function createTempDatabasePath(): TempDatabasePath {
  const dir = mkdtempSync(join(tmpdir(), "bb-server-db-maintenance-"));
  return {
    cleanup(): void {
      rmSync(dir, { force: true, recursive: true });
    },
    dbPath: join(dir, "bb.db"),
  };
}

function createLegacyDatabaseFile(dbPath: string): void {
  const rawDb = new Database(dbPath);
  try {
    rawDb.exec("PRAGMA journal_mode = WAL");
    rawDb.exec(
      "CREATE TABLE legacy_seed (id INTEGER PRIMARY KEY, value TEXT NOT NULL)",
    );
    rawDb
      .prepare("INSERT INTO legacy_seed (id, value) VALUES (1, ?)")
      .run("legacy-data");
  } finally {
    rawDb.close();
  }
}

function quoteSqlIdentifier(identifier: string): string {
  return `"${identifier.replaceAll('"', '""')}"`;
}

function createDeferredLegacyTables(db: DbConnection): void {
  for (const tableName of TEST_DEFERRED_LEGACY_TABLE_NAMES) {
    db.$client
      .prepare(
        `CREATE TABLE ${quoteSqlIdentifier(tableName)} (id TEXT PRIMARY KEY)`,
      )
      .run();
  }
}

function markDatabaseBusy(db: DbConnection): void {
  const host = upsertHost(db, noopNotifier, {
    name: "maintenance-host",
    type: "persistent",
  });
  const { project } = createProject(db, noopNotifier, {
    name: "maintenance-project",
    source: { type: "local_path", hostId: host.id, path: "/tmp/project" },
  });
  createThread(db, noopNotifier, {
    projectId: project.id,
    providerId: "codex",
    status: "active",
  });
}

function buildFreelist(db: DbConnection): void {
  db.$client.exec(
    "CREATE TABLE scratch_blobs (id INTEGER PRIMARY KEY, blob TEXT)",
  );
  const insert = db.$client.prepare(
    "INSERT INTO scratch_blobs (blob) VALUES (?)",
  );
  const blob = "x".repeat(8 * 1024);
  const insertMany = db.$client.transaction((count: number) => {
    for (let index = 0; index < count; index += 1) {
      insert.run(blob);
    }
  });
  insertMany(FREELIST_ROW_COUNT);
  db.$client.exec("DELETE FROM scratch_blobs");
}

function setupBusyDatabaseWithFreelist() {
  const db = createConnection(":memory:");
  migrate(db);
  markDatabaseBusy(db);
  buildFreelist(db);

  return { db };
}

function setupBusyFileDatabaseWithFreelist(tempDatabase: TempDatabasePath) {
  const db = createConnection(tempDatabase.dbPath);
  migrate(db);
  markDatabaseBusy(db);
  buildFreelist(db);

  return { db };
}

describe("runDatabaseMaintenanceSweep", () => {
  it("drops deferred legacy tables on an idle maintenance pass", () => {
    const db = createConnection(":memory:");
    migrate(db);
    createDeferredLegacyTables(db);
    expect(listDeferredLegacyTables(db)).toEqual(
      [...TEST_DEFERRED_LEGACY_TABLE_NAMES].sort(),
    );

    runDatabaseMaintenanceSweep({ db, logger: testLogger }, nextSweepTime());

    expect(listDeferredLegacyTables(db)).toEqual([]);
  });

  it("skips deferred legacy table cleanup while app work is active", () => {
    const { db } = setupBusyDatabaseWithFreelist();
    createDeferredLegacyTables(db);

    runDatabaseMaintenanceSweep({ db, logger: testLogger }, nextSweepTime());

    expect(listDeferredLegacyTables(db)).toEqual(
      [...TEST_DEFERRED_LEGACY_TABLE_NAMES].sort(),
    );
  });

  it("reclaims freed pages incrementally even when the instance is not idle", () => {
    const { db } = setupBusyDatabaseWithFreelist();

    const before = getDatabaseFreelistStats(db);
    expect(before.freelistCount).toBeGreaterThan(0);
    expect(isDatabaseMaintenanceIdle(getDatabaseMaintenanceActivity(db))).toBe(
      false,
    );

    runDatabaseMaintenanceSweep({ db, logger: testLogger }, nextSweepTime());

    expect(getDatabaseFreelistStats(db).freelistCount).toBeLessThan(
      before.freelistCount,
    );
  });

  it("skips busy legacy databases before dbstat or full maintenance", () => {
    const tempDatabase = createTempDatabasePath();
    try {
      createLegacyDatabaseFile(tempDatabase.dbPath);
      const slowQueryLogger = new CapturingSlowQueryLogger();
      const db = createConnection(tempDatabase.dbPath, {
        slowQueryLogger,
        slowQueryThresholdMs: 0,
      });
      try {
        migrate(db);
        expect(getDatabaseAutoVacuumMode(db)).toBe("none");
        markDatabaseBusy(db);
        buildFreelist(db);
        const before = getDatabaseFreelistStats(db);
        slowQueryLogger.clear();

        runDatabaseMaintenanceSweep(
          { db, logger: testLogger },
          nextSweepTime(),
        );

        expect(getDatabaseAutoVacuumMode(db)).toBe("none");
        expect(getDatabaseFreelistStats(db).freelistCount).toBe(
          before.freelistCount,
        );
        expect(
          slowQueryLogger.debugLogs.some((log) => log.sql.includes("dbstat")),
        ).toBe(false);
      } finally {
        db.$client.close();
      }
    } finally {
      tempDatabase.cleanup();
    }
  });

  it("does not wait on a WAL reader during incremental maintenance", () => {
    const tempDatabase = createTempDatabasePath();
    try {
      const { db } = setupBusyFileDatabaseWithFreelist(tempDatabase);
      const readerDb = new Database(tempDatabase.dbPath, { readonly: true });
      let readerTransactionOpen = false;
      try {
        readerDb.exec("BEGIN");
        readerTransactionOpen = true;
        readerDb.prepare("SELECT COUNT(*) FROM scratch_blobs").get();
        const before = getDatabaseFreelistStats(db);
        const startedAt = performance.now();

        runDatabaseMaintenanceSweep(
          { db, logger: testLogger },
          nextSweepTime(),
        );

        const elapsedMs = performance.now() - startedAt;
        expect(elapsedMs).toBeLessThan(
          DATABASE_MAINTENANCE_BUSY_TIMEOUT_MS + SQLITE_BUSY_HEADROOM_MS,
        );
        expect(getDatabaseFreelistStats(db).freelistCount).toBeLessThan(
          before.freelistCount,
        );
      } finally {
        if (readerTransactionOpen) {
          readerDb.exec("ROLLBACK");
        }
        readerDb.close();
        db.$client.close();
      }
    } finally {
      tempDatabase.cleanup();
    }
  });

  it("returns quickly when a WAL writer blocks incremental maintenance", () => {
    const tempDatabase = createTempDatabasePath();
    try {
      const { db } = setupBusyFileDatabaseWithFreelist(tempDatabase);
      const writerDb = new Database(tempDatabase.dbPath);
      let writerTransactionOpen = false;
      try {
        writerDb.exec("BEGIN IMMEDIATE");
        writerTransactionOpen = true;
        const before = getDatabaseFreelistStats(db);
        const { logger, warnMessages } = createCapturingServerLogger();
        const startedAt = performance.now();

        runDatabaseMaintenanceSweep({ db, logger }, nextSweepTime());

        const elapsedMs = performance.now() - startedAt;
        expect(elapsedMs).toBeLessThan(
          DATABASE_MAINTENANCE_BUSY_TIMEOUT_MS + SQLITE_BUSY_HEADROOM_MS,
        );
        expect(warnMessages).toHaveLength(1);
        expect(getDatabaseFreelistStats(db).freelistCount).toBe(
          before.freelistCount,
        );
      } finally {
        if (writerTransactionOpen) {
          writerDb.exec("ROLLBACK");
        }
        writerDb.close();
        db.$client.close();
      }
    } finally {
      tempDatabase.cleanup();
    }
  });
});
