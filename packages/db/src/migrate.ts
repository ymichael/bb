import { migrate as drizzleMigrate } from "drizzle-orm/better-sqlite3/migrator";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import type { DbConnection } from "./connection.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

type SqliteClient = {
  pragma: (sql: string) => Array<Record<string, unknown>> | unknown;
};

function getSqliteClient(db: DbConnection): SqliteClient | null {
  const sqlite = (db as { $client?: SqliteClient }).$client;
  return sqlite ?? null;
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
    drizzleMigrate(db, { migrationsFolder });
  } finally {
    sqlite?.pragma?.("foreign_keys = ON");
  }
}
