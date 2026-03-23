import fs from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { DbConnection } from "./connection.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

type SqliteClient = {
  exec: (sql: string) => unknown;
};

function getSqliteClient(db: DbConnection): SqliteClient {
  const sqlite = (db as { $client?: SqliteClient }).$client;
  if (!sqlite) {
    throw new Error("Expected a better-sqlite3 client on DbConnection");
  }
  return sqlite;
}

export function migrate(db: DbConnection): void {
  const migrationsFile = resolve(__dirname, "..", "drizzle", "0000_rebuild.sql");
  const sql = fs.readFileSync(migrationsFile, "utf8");
  getSqliteClient(db).exec(sql);
}
