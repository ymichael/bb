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
  debug(fields: SlowDbQueryLogFields, message: string): void;
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
const MAX_LOGGED_SQL_LENGTH = 1_000;
const SQL_TRUNCATION_SUFFIX = "...";
// Keep ORM-generated quoted identifiers intact. SQLite accepts double-quoted
// strings in some legacy cases, but broad redaction would erase table/column
// names from Drizzle SQL and make the slow-query log much less useful.
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
      args.config.logger.debug(
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

  // Drizzle and our data helpers all prepare statements through this client.
  // Wrapping here instruments both ORM and raw prepared-statement call paths.
  Object.defineProperty(sqlite, "prepare", {
    configurable: true,
    value: prepare,
    writable: true,
  });
}

export function createConnection(
  dbPath: string = "bb.db",
  options: CreateConnectionOptions = {},
) {
  const sqlite = new Database(dbPath);

  // Enable WAL mode for better concurrent read performance
  sqlite.pragma("journal_mode = WAL");
  // Enable foreign keys
  sqlite.pragma("foreign_keys = ON");
  instrumentSqliteClient(sqlite, options);

  const db = drizzle({ client: sqlite, schema });

  return db;
}
