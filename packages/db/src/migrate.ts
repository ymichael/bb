import { migrate as drizzleMigrate } from "drizzle-orm/better-sqlite3/migrator";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { DbConnection } from "./connection.js";
import {
  threadEventScopeMigrationPreflight,
  type MigrationPreflight,
} from "./migrations/0040_thread_event_scope_preflight.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const migrationPreflights = [
  threadEventScopeMigrationPreflight,
] satisfies MigrationPreflight[];

function runMigrationPreflights(sqlite: DbConnection["$client"]): void {
  for (const preflight of migrationPreflights) {
    preflight.run(sqlite);
  }
}

export function migrate(db: DbConnection): void {
  const migrationsFolder = resolve(__dirname, "..", "drizzle");
  const sqlite = db.$client;

  sqlite.pragma("foreign_keys = OFF");
  try {
    runMigrationPreflights(sqlite);
    drizzleMigrate(db, { migrationsFolder });
  } finally {
    sqlite.pragma("foreign_keys = ON");
  }

  const violations = sqlite.pragma("foreign_key_check");
  if (Array.isArray(violations) && violations.length > 0) {
    console.error(
      `foreign_key_check found ${violations.length} violation(s) after migration`,
      violations.slice(0, 10),
    );
  }
}
