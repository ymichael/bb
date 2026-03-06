import { migrate as drizzleMigrate } from "drizzle-orm/better-sqlite3/migrator";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import type { DbConnection } from "./connection.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

type SqliteClient = {
  pragma: (sql: string) => Array<Record<string, unknown>> | unknown;
  prepare: (sql: string) => {
    all: (...params: unknown[]) => Array<Record<string, unknown>>;
    get: (...params: unknown[]) => Record<string, unknown> | undefined;
    run: (...params: unknown[]) => unknown;
  };
};

function getSqliteClient(db: DbConnection): SqliteClient | null {
  const sqlite = (db as { $client?: SqliteClient }).$client;
  return sqlite ?? null;
}

function hasTable(sqlite: SqliteClient, tableName: string): boolean {
  const row = sqlite
    .prepare(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name = ? LIMIT 1",
    )
    .get(tableName);
  return row !== undefined;
}

function getTableColumns(sqlite: SqliteClient, tableName: string): Set<string> {
  const rows = sqlite.prepare(`PRAGMA table_info("${tableName}")`).all();
  return new Set(
    rows
      .map((row) => row.name)
      .filter((name): name is string => typeof name === "string"),
  );
}

function getAppliedMigrationHashes(sqlite: SqliteClient): Set<string> {
  const rows = sqlite
    .prepare("SELECT hash FROM __drizzle_migrations")
    .all()
    .map((row) => row.hash)
    .filter((hash): hash is string => typeof hash === "string");
  return new Set(rows);
}

function getMigrationHash(migrationsFolder: string, fileName: string): string {
  const contents = readFileSync(resolve(migrationsFolder, fileName), "utf8");
  return createHash("sha256").update(contents).digest("hex");
}

function markMigrationApplied(
  sqlite: SqliteClient,
  hash: string,
  createdAt: number,
): void {
  sqlite
    .prepare(
      "INSERT INTO __drizzle_migrations (hash, created_at) VALUES (?, ?)",
    )
    .run(hash, createdAt);
}

function reconcileLegacyWorkflowMigrations(
  sqlite: SqliteClient,
  migrationsFolder: string,
): void {
  if (!hasTable(sqlite, "__drizzle_migrations") || !hasTable(sqlite, "threads")) {
    return;
  }

  const threadColumns = getTableColumns(sqlite, "threads");
  if (!threadColumns.has("workflow_id")) {
    return;
  }

  const appliedHashes = getAppliedMigrationHashes(sqlite);
  const workflowIdMigrationHash = getMigrationHash(
    migrationsFolder,
    "0019_thread_workflows.sql",
  );

  if (!appliedHashes.has(workflowIdMigrationHash)) {
    // Some local DBs already have workflow_id from an earlier branch state, but
    // the Drizzle journal never recorded 0019. Record it so startup can continue.
    markMigrationApplied(sqlite, workflowIdMigrationHash, 1772955000000);
    appliedHashes.add(workflowIdMigrationHash);
  }

  if (!threadColumns.has("workflow_state")) {
    return;
  }

  const workflowStateMigrationHash = getMigrationHash(
    migrationsFolder,
    "0020_thread_workflow_state.sql",
  );
  if (!appliedHashes.has(workflowStateMigrationHash)) {
    markMigrationApplied(sqlite, workflowStateMigrationHash, 1772955060000);
  }
}

/**
 * Run Drizzle migrations from the drizzle/ folder.
 * Resolves the migrations directory relative to this file so it works
 * from both src/ (via tsx) and dist/ (compiled).
 */
export function migrate(db: DbConnection): void {
  // From src/ or dist/, go up to packages/db/, then into drizzle/
  const migrationsFolder = resolve(__dirname, "..", "drizzle");
  const sqlite = getSqliteClient(db);

  // Drizzle runs SQLite migrations in a transaction; toggle FK checks before it
  // starts so table rebuild migrations can safely drop referenced tables.
  sqlite?.pragma?.("foreign_keys = OFF");
  try {
    if (sqlite) {
      reconcileLegacyWorkflowMigrations(sqlite, migrationsFolder);
    }
    drizzleMigrate(db, { migrationsFolder });
  } finally {
    sqlite?.pragma?.("foreign_keys = ON");
  }
}
