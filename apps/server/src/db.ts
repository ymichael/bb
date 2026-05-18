import { createConnection, migrate } from "@bb/db";
import type {
  DbConnection,
  MigrationWarningLogger,
  SlowDbQueryLogger,
} from "@bb/db";

export type InitDbLogger = MigrationWarningLogger & SlowDbQueryLogger;

export interface InitDbOptions {
  logger?: InitDbLogger;
}

export function initDb(
  databaseUrl: string,
  options: InitDbOptions = {},
): DbConnection {
  const db = createConnection(databaseUrl, {
    slowQueryLogger: options.logger,
  });
  migrate(db, { logger: options.logger });
  return db;
}
