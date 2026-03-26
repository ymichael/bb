import { createConnection, migrate } from "@bb/db";
import type { DbConnection } from "@bb/db";

export function initDb(databaseUrl: string): DbConnection {
  const db = createConnection(databaseUrl);
  migrate(db);
  return db;
}
