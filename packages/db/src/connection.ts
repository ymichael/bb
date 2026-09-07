import Database from "better-sqlite3";
import { performance } from "node:perf_hooks";
import { drizzle } from "drizzle-orm/better-sqlite3";
import * as schema from "./schema.js";

export interface SlowDbQueryLogFields {
  bindingArgumentCount: number;
  durationMs: number;
  operation: SlowDbQueryOperation;
  sql: string;
  thresholdMs: number;
}

export interface SlowDbQueryLogger {
  info(fields: SlowDbQueryLogFields, message: string): void;
}

export interface CreateConnectionOptions {
  slowQueryLogger?: SlowDbQueryLogger;
  slowQueryThresholdMs?: number;
}

export type DbConnection = ReturnType<typeof createConnection>;
export type DbTransaction = Parameters<
  Parameters<DbConnection["transaction"]>[0]
>[0];
export type DbQueryConnection = DbConnection | DbTransaction;
export type SlowDbQueryOperation = "all" | "get" | "run";

interface SlowDbQueryConfig {
  logger: SlowDbQueryLogger;
  thresholdMs: number;
}

interface TimedStatementOperationArgs<TValue> {
  bindingArgumentCount: number;
  config: SlowDbQueryConfig;
  operation: SlowDbQueryOperation;
  source: string;
  work: () => TValue;
}

const DEFAULT_SLOW_DB_QUERY_LOG_THRESHOLD_MS = 100;
export const SQLITE_CACHE_SIZE_KIB = 262_144;
export const SQLITE_MMAP_SIZE_BYTES = 1_073_741_824;
export const SQLITE_BUSY_TIMEOUT_MS = 5_000;
const MAX_LOGGED_SQL_LENGTH = 1_000;
const SQL_TRUNCATION_SUFFIX = "...";
const SQL_STRING_LITERAL_PATTERN = /'(?:''|[^'])*'/gu;
const SQL_WHITESPACE_PATTERN = /\s+/gu;

function roundDurationMs(durationMs: number): number {
  return Math.round(durationMs * 10) / 10;
}

function formatSqlForLog(source: string): string {
  const redacted = source.replace(SQL_STRING_LITERAL_PATTERN, "'?'");
  const normalized = redacted.replace(SQL_WHITESPACE_PATTERN, " ").trim();
  if (normalized.length <= MAX_LOGGED_SQL_LENGTH) {
    return normalized;
  }
  return `${normalized.slice(
    0,
    MAX_LOGGED_SQL_LENGTH - SQL_TRUNCATION_SUFFIX.length,
  )}${SQL_TRUNCATION_SUFFIX}`;
}

function runTimedStatementOperation<TValue>(
  args: TimedStatementOperationArgs<TValue>,
): TValue {
  const startedAt = performance.now();
  try {
    return args.work();
  } finally {
    const durationMs = performance.now() - startedAt;
    if (durationMs >= args.config.thresholdMs) {
      args.config.logger.info(
        {
          bindingArgumentCount: args.bindingArgumentCount,
          durationMs: roundDurationMs(durationMs),
          operation: args.operation,
          sql: formatSqlForLog(args.source),
          thresholdMs: args.config.thresholdMs,
        },
        "Slow DB query",
      );
    }
  }
}

function instrumentStatement(
  statement: Database.Statement,
  source: string,
  config: SlowDbQueryConfig,
): Database.Statement {
  const originalAll = statement.all.bind(statement);
  const originalGet = statement.get.bind(statement);
  const originalRun = statement.run.bind(statement);

  statement.all = (...params) =>
    runTimedStatementOperation({
      bindingArgumentCount: params.length,
      config,
      operation: "all",
      source,
      work: () => originalAll(...params),
    });
  statement.get = (...params) =>
    runTimedStatementOperation({
      bindingArgumentCount: params.length,
      config,
      operation: "get",
      source,
      work: () => originalGet(...params),
    });
  statement.run = (...params) =>
    runTimedStatementOperation({
      bindingArgumentCount: params.length,
      config,
      operation: "run",
      source,
      work: () => originalRun(...params),
    });

  return statement;
}

function instrumentSqliteClient(
  sqlite: Database.Database,
  options: CreateConnectionOptions,
): void {
  if (!options.slowQueryLogger) {
    return;
  }

  const config: SlowDbQueryConfig = {
    logger: options.slowQueryLogger,
    thresholdMs:
      options.slowQueryThresholdMs ?? DEFAULT_SLOW_DB_QUERY_LOG_THRESHOLD_MS,
  };
  const originalPrepare: Database.Database["prepare"] =
    sqlite.prepare.bind(sqlite);

  function prepare(source: string): Database.Statement {
    return instrumentStatement(originalPrepare(source), source, config);
  }

  Object.defineProperty(sqlite, "prepare", {
    configurable: true,
    value: prepare,
    writable: true,
  });
}

export function createConnection(
  source: string | Buffer = "bb.db",
  options: CreateConnectionOptions = {},
) {
  const sqlite = new Database(source);

  sqlite.pragma("auto_vacuum = INCREMENTAL");
  sqlite.pragma("journal_mode = WAL");
  sqlite.pragma("foreign_keys = ON");
  sqlite.pragma("synchronous = NORMAL");
  sqlite.pragma(`cache_size = -${SQLITE_CACHE_SIZE_KIB}`);
  sqlite.pragma(`mmap_size = ${SQLITE_MMAP_SIZE_BYTES}`);
  sqlite.pragma(`busy_timeout = ${SQLITE_BUSY_TIMEOUT_MS}`);
  instrumentSqliteClient(sqlite, options);

  const db = drizzle({ client: sqlite, schema });

  return db;
}
