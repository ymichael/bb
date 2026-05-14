import { createConnection, migrate } from "@bb/db";
import type { DbConnection, SlowDbQueryLogger } from "@bb/db";

export interface InitDbOptions {
  logger?: SlowDbQueryLogger;
}

export function initDb(
  databaseUrl: string,
  options: InitDbOptions = {},
): DbConnection {
  const db = createConnection(databaseUrl, {
    slowQueryLogger: options.logger,
  });
  migrate(db);
  return db;
}
