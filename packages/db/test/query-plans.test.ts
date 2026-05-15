import { describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { threadScope, turnScope } from "@bb/domain";
import {
  createConnection,
  type DbConnection,
  type SlowDbQueryLogger,
  type SlowDbQueryLogFields,
} from "../src/connection.js";
import { migrate } from "../src/migrate.js";
import { noopNotifier } from "../src/notifier.js";
import {
  fetchCommands,
  hasPendingHostCommandForThread,
} from "../src/data/commands.js";
import {
  insertEvents,
  pruneContextWindowUsageEventsBeforeSequence,
} from "../src/data/events.js";
import {
  pruneCompletedCommandPayloads,
  sweepExpiredCommands,
} from "../src/data/sweeps.js";
import { upsertHost } from "../src/data/hosts.js";
import { createProject } from "../src/data/projects.js";
import { createThread } from "../src/data/threads.js";
import { hostDaemonCommands } from "../src/schema.js";
import { queueCommand, reportCommandResult } from "../src/data/commands.js";

type SqliteParameter = string | number | bigint | Buffer | null;
type LoggedSqlPredicate = (fields: SlowDbQueryLogFields) => boolean;

interface LoggedDebug {
  fields: SlowDbQueryLogFields;
  message: string;
}

interface QueryPlanRow {
  detail: string;
  id: number;
  notused: number;
  parent: number;
}

interface IndexNameRow {
  name: string;
}

interface IdentifiedRow {
  id: string;
}

interface TestDb {
  db: DbConnection;
  host: IdentifiedRow;
  logger: CapturingSlowQueryLogger;
  thread: IdentifiedRow;
}

interface FindOnlyDebugLogArgs {
  logger: CapturingSlowQueryLogger;
  predicate: LoggedSqlPredicate;
}

interface QueryPlanDetailsArgs {
  db: DbConnection;
  params: readonly SqliteParameter[];
  sql: string;
}

interface AssertEmittedQueryPlanUsesIndexArgs {
  db: DbConnection;
  debugLog: LoggedDebug;
  indexName: string;
  params: readonly SqliteParameter[];
}

class CapturingSlowQueryLogger implements SlowDbQueryLogger {
  readonly debugLogs: LoggedDebug[] = [];

  debug: SlowDbQueryLogger["debug"] = (fields, message) => {
    this.debugLogs.push({ fields, message });
  };

  clear(): void {
    this.debugLogs.length = 0;
  }
}

function setup(): TestDb {
  const logger = new CapturingSlowQueryLogger();
  const db = createConnection(":memory:", {
    slowQueryLogger: logger,
    slowQueryThresholdMs: 0,
  });
  migrate(db);
  const host = upsertHost(db, noopNotifier, {
    name: "query-plan-host",
    type: "persistent",
  });
  const { project } = createProject(db, noopNotifier, {
    name: "query-plan-project",
    source: { type: "local_path", hostId: host.id, path: "/tmp/query-plan" },
  });
  const thread = createThread(db, noopNotifier, {
    projectId: project.id,
    providerId: "codex",
  });
  logger.clear();
  return { db, host, logger, thread };
}

function findOnlyDebugLog(args: FindOnlyDebugLogArgs): LoggedDebug {
  const matches = args.logger.debugLogs.filter((debugLog) =>
    args.predicate(debugLog.fields),
  );
  expect(matches.map((debugLog) => debugLog.fields.sql)).toHaveLength(1);
  const debugLog = matches[0];
  if (!debugLog) {
    throw new Error("Expected one matching SQL debug log");
  }
  return debugLog;
}

function queryPlanDetails(args: QueryPlanDetailsArgs): string {
  const planRows = args.db.$client
    .prepare<SqliteParameter[], QueryPlanRow>(
      `EXPLAIN QUERY PLAN ${args.sql}`,
    )
    .all(...args.params);
  return planRows.map((row) => row.detail).join("\n");
}

function assertEmittedQueryPlanUsesIndex(
  args: AssertEmittedQueryPlanUsesIndexArgs,
): void {
  expect(args.debugLog.fields.bindingArgumentCount).toBe(args.params.length);
  expect(
    queryPlanDetails({
      db: args.db,
      params: args.params,
      sql: args.debugLog.fields.sql,
    }),
  ).toContain(`USING INDEX ${args.indexName}`);
}

describe("slow query index plans", () => {
  it("uses the payload pruning partial index for emitted completed-command pruning SQL", () => {
    const { db, host, logger } = setup();
    const now = Date.now();
    const completedBefore = now - 5_000;
    const command = queueCommand(db, noopNotifier, {
      hostId: host.id,
      payload: JSON.stringify({ stale: true }),
      type: "workspace.status",
    });
    reportCommandResult(db, noopNotifier, {
      commandId: command.id,
      completedAt: now - 10_000,
      resultPayload: JSON.stringify({ ok: true }),
      state: "success",
    });
    logger.clear();

    pruneCompletedCommandPayloads(db, { completedBefore });

    const debugLog = findOnlyDebugLog({
      logger,
      predicate: (fields) =>
        fields.operation === "run" &&
        fields.sql.startsWith('update "host_daemon_commands" set "payload"'),
    });
    assertEmittedQueryPlanUsesIndex({
      db,
      debugLog,
      indexName: "host_daemon_commands_payload_prune_idx",
      params: ["{}", null, "success", "error", completedBefore, "{}"],
    });

    db.$client.close();
  });

  it("uses the fetched-at index for emitted expired-command sweep SQL", () => {
    const { db, host, logger } = setup();
    const now = Date.now();
    const command = queueCommand(db, noopNotifier, {
      hostId: host.id,
      payload: JSON.stringify({ threadId: "thr_expired_query_plan" }),
      type: "workspace.status",
    });
    fetchCommands(db, noopNotifier, { hostId: host.id });
    db.update(hostDaemonCommands)
      .set({ fetchedAt: now - 70_000 })
      .where(eq(hostDaemonCommands.id, command.id))
      .run();
    logger.clear();

    sweepExpiredCommands(db, noopNotifier, now);

    const debugLog = findOnlyDebugLog({
      logger,
      predicate: (fields) =>
        fields.operation === "all" &&
        fields.sql.includes('"host_daemon_commands"."fetched_at" IS NOT NULL'),
    });
    assertEmittedQueryPlanUsesIndex({
      db,
      debugLog,
      indexName: "host_daemon_commands_state_fetched_at_idx",
      params: ["fetched", now, 20 * 60_000, 60_000],
    });

    db.$client.close();
  });

  it("uses the host/state/cursor index for emitted command fetch SQL", () => {
    const { db, host, logger } = setup();
    queueCommand(db, noopNotifier, {
      hostId: host.id,
      payload: "{}",
      type: "workspace.status",
    });
    logger.clear();

    fetchCommands(db, noopNotifier, { hostId: host.id });

    const debugLog = findOnlyDebugLog({
      logger,
      predicate: (fields) =>
        fields.operation === "all" &&
        fields.sql.includes('from "host_daemon_commands"') &&
        fields.sql.includes('order by "host_daemon_commands"."cursor"'),
    });
    assertEmittedQueryPlanUsesIndex({
      db,
      debugLog,
      indexName: "host_daemon_commands_host_state_cursor_idx",
      params: [host.id, "pending", 100],
    });

    db.$client.close();
  });

  it("uses the replacement host/state/cursor index for host/state command lookups", () => {
    const { db, host, logger } = setup();
    queueCommand(db, noopNotifier, {
      hostId: host.id,
      payload: JSON.stringify({ threadId: "thr_target" }),
      type: "turn.submit",
    });
    logger.clear();

    expect(
      hasPendingHostCommandForThread(db, {
        hostId: host.id,
        threadId: "thr_target",
        type: "turn.submit",
      }),
    ).toBe(true);

    const debugLog = findOnlyDebugLog({
      logger,
      predicate: (fields) =>
        fields.operation === "get" &&
        fields.sql.includes('select "id" from "host_daemon_commands"') &&
        fields.sql.includes('"host_daemon_commands"."type" = ?'),
    });
    assertEmittedQueryPlanUsesIndex({
      db,
      debugLog,
      indexName: "host_daemon_commands_host_state_cursor_idx",
      params: [host.id, "turn.submit", "pending", "fetched", "thr_target"],
    });

    db.$client.close();
  });

  it("uses the thread/type/sequence index for emitted context-window prune SQL", () => {
    const { db, logger, thread } = setup();
    const sequenceCutoff = 3;
    insertEvents(db, noopNotifier, [
      {
        data: JSON.stringify({
          contextWindowUsage: {
            modelContextWindow: 200_000,
            usedTokens: 10,
          },
        }),
        itemId: null,
        itemKind: null,
        scope: turnScope("turn_query_plan"),
        sequence: 1,
        threadId: thread.id,
        type: "thread/contextWindowUsage/updated",
      },
      {
        data: JSON.stringify({
          contextWindowUsage: {
            modelContextWindow: null,
            usedTokens: 20,
          },
        }),
        itemId: null,
        itemKind: null,
        scope: turnScope("turn_query_plan"),
        sequence: 2,
        threadId: thread.id,
        type: "thread/contextWindowUsage/updated",
      },
      {
        data: "{}",
        itemId: null,
        itemKind: null,
        scope: threadScope(),
        sequence: 3,
        threadId: thread.id,
        type: "system/error",
      },
    ]);
    logger.clear();

    pruneContextWindowUsageEventsBeforeSequence(db, {
      sequenceCutoff,
      threadId: thread.id,
    });

    const debugLog = findOnlyDebugLog({
      logger,
      predicate: (fields) =>
        fields.operation === "run" &&
        fields.sql.startsWith("DELETE FROM events") &&
        fields.sql.includes("latest_context"),
    });
    assertEmittedQueryPlanUsesIndex({
      db,
      debugLog,
      indexName: "events_thread_type_sequence_idx",
      params: [
        thread.id,
        "thread/contextWindowUsage/updated",
        sequenceCutoff,
        thread.id,
        "thread/contextWindowUsage/updated",
        thread.id,
        "thread/contextWindowUsage/updated",
        "$.contextWindowUsage.modelContextWindow",
      ],
    });

    db.$client.close();
  });

  it("drops the redundant host/state prefix index after creating its replacement", () => {
    const { db } = setup();
    const indexRows = db.$client
      .prepare<[], IndexNameRow>(
        "SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = 'host_daemon_commands'",
      )
      .all();
    const indexNames = indexRows.map((row) => row.name);

    expect(indexNames).toContain("host_daemon_commands_host_state_cursor_idx");
    expect(indexNames).not.toContain("host_daemon_commands_host_state_idx");

    db.$client.close();
  });
});
