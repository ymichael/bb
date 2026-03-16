import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import * as schema from "./schema.js";

export type DbConnection = ReturnType<typeof createConnection>;

export function createConnection(dbPath: string = "bb.db") {
  const sqlite = new Database(dbPath);

  // Enable WAL mode for better concurrent read performance
  sqlite.pragma("journal_mode = WAL");
  // Enable foreign keys
  sqlite.pragma("foreign_keys = ON");

  const db = drizzle({ client: sqlite, schema });

  return db;
}
