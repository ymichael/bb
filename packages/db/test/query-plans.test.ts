import { describe, expect, it } from "vitest";
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
  createPendingInteraction,
  getPendingInteractionByProviderRequest,
} from "../src/data/pending-interactions.js";
import {
  appendDaemonEventsInTransaction,
  hasParentedEventCrossingSequence,
  insertEvents,
  listActiveBackgroundTaskCountsByThreadIds,
  listLatestThreadStateEventRowsByThreadIds,
  listLatestOpenBackgroundTaskStateRowsForThread,
  listStoredConversationOutlineEventRows,
  listStoredEventRows,
  listStoredEventRowsByParentToolCallIds,
  listTodoSnapshotEventRowsForThread,
  pruneContextWindowUsageEventsBeforeSequence,
  pruneResolvedItemDeltas,
} from "../src/data/events.js";
import {
  COMPLETED_EVENT_OUTPUT_TRUNCATION_THRESHOLD_CHARS,
  pruneClosedSessions,
  pruneDestroyedEnvironments,
  truncateCompletedEventItemOutputs,
} from "../src/data/sweeps.js";
import { getDatabaseMaintenanceActivity } from "../src/data/maintenance.js";
import { openSession } from "../src/data/sessions.js";
import {
  listDueScheduledQueuedThreadMessages,
  listQueuedThreadMessagesByWaitHolder,
} from "../src/data/queued-thread-messages.js";
import { upsertHost } from "../src/data/hosts.js";
import { createProject } from "../src/data/projects.js";
import { createEnvironment } from "../src/data/environments.js";
import {
  createThread,
  listRunningThreads,
  listThreadsWithPendingInteractionState,
} from "../src/data/threads.js";

type SqliteParameter = string | number | bigint | Buffer | null;
type LoggedSqlPredicate = (fields: SlowDbQueryLogFields) => boolean;
type CloseSessionAtParameters = ["closed", number, number, string];

interface CloseSessionAtArgs {
  closedAt: number;
  db: DbConnection;
  sessionId: string;
}

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
  project: IdentifiedRow;
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

  info: SlowDbQueryLogger["info"] = (fields, message) => {
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
  return { db, host, logger, project, thread };
}

function closeSessionAt(args: CloseSessionAtArgs): void {
  args.db.$client
    .prepare<CloseSessionAtParameters>(
      `
        UPDATE host_daemon_sessions
        SET status = ?, closed_at = ?, updated_at = ?
        WHERE id = ?
      `,
    )
    .run("closed", args.closedAt, args.closedAt, args.sessionId);
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

interface CapturedStatement {
  params: SqliteParameter[];
  sql: string;
}

function captureStatements(
  db: DbConnection,
  run: () => void,
): CapturedStatement[] {
  const captured: CapturedStatement[] = [];
  const raw = db.$client;
  const originalPrepare = raw.prepare.bind(raw);
  Object.defineProperty(raw, "prepare", {
    configurable: true,
    writable: true,
    value: (source: string) => {
      const statement = originalPrepare(source);
      const originalAll = statement.all.bind(statement);
      const originalGet = statement.get.bind(statement);
      statement.all = (...params: unknown[]) => {
        captured.push({ params: params as SqliteParameter[], sql: source });
        return originalAll(...params);
      };
      statement.get = (...params: unknown[]) => {
        captured.push({ params: params as SqliteParameter[], sql: source });
        return originalGet(...params);
      };
      return statement;
    },
  });
  try {
    run();
  } finally {
    Object.defineProperty(raw, "prepare", {
      configurable: true,
      writable: true,
      value: originalPrepare,
    });
  }
  return captured;
}

function queryPlanDetails(args: QueryPlanDetailsArgs): string {
  const planRows = args.db.$client
    .prepare<SqliteParameter[], QueryPlanRow>(`EXPLAIN QUERY PLAN ${args.sql}`)
    .all(...args.params);
  return planRows.map((row) => row.detail).join("\n");
}

function assertEmittedQueryPlanUsesIndex(
  args: AssertEmittedQueryPlanUsesIndexArgs,
): void {
  expect(args.debugLog.fields.bindingArgumentCount).toBe(args.params.length);
  const details = queryPlanDetails({
    db: args.db,
    params: args.params,
    sql: args.debugLog.fields.sql,
  });
  expect(
    details.includes(`USING INDEX ${args.indexName}`) ||
      details.includes(`USING COVERING INDEX ${args.indexName}`),
  ).toBe(true);
}

describe("slow query index plans", () => {
  // Both queue indexes are PARTIAL. A partial index is only usable when the
  // query repeats its WHERE clause, so a refactor that drops one liveness
  // predicate from the query — or adds one to the index — silently degrades
  // the sweep to a full table scan. Nothing else would notice.
  it("finds due scheduled queued messages through the partial due index", () => {
    const { db } = setup();

    const captured = captureStatements(db, () => {
      expect(listDueScheduledQueuedThreadMessages(db, 1_000)).toEqual([]);
    });
    expect(captured).toHaveLength(1);
    const details = queryPlanDetails({
      db,
      params: captured[0]!.params,
      sql: captured[0]!.sql,
    });
    expect(details).toMatch(/USING INDEX queued_thread_messages_due_idx/u);
    expect(details).not.toMatch(/SCAN queued_thread_messages/u);

    db.$client.close();
  });

  it("finds a plugin's held queued messages through the partial holder index", () => {
    const { db } = setup();

    const captured = captureStatements(db, () => {
      expect(
        listQueuedThreadMessagesByWaitHolder(db, "plugin:limiter"),
      ).toEqual([]);
    });
    expect(captured).toHaveLength(1);
    const details = queryPlanDetails({
      db,
      params: captured[0]!.params,
      sql: captured[0]!.sql,
    });
    expect(details).toMatch(
      /USING INDEX queued_thread_messages_wait_holder_idx/u,
    );
    expect(details).not.toMatch(/SCAN queued_thread_messages/u);

    db.$client.close();
  });

  it("finds the occupying threads through the archived/status index", () => {
    // A dispatch gate calls this on every admission decision, so a plan that
    // degraded to a table scan would put one on every send in the server.
    const { db } = setup();

    const captured = captureStatements(db, () => {
      listRunningThreads(db);
    });
    expect(captured).toHaveLength(1);
    const details = queryPlanDetails({
      db,
      params: captured[0]!.params,
      sql: captured[0]!.sql,
    });
    expect(details).toMatch(/USING INDEX threads_archived_status_idx/u);
    expect(details).not.toMatch(/SCAN threads/u);

    db.$client.close();
  });

  it("uses the thread/type/sequence index for filtered event pages", () => {
    const { db, thread } = setup();

    const captured = captureStatements(db, () => {
      expect(
        listStoredEventRows(db, {
          beforeSequence: 100,
          limit: 25,
          order: "desc",
          threadId: thread.id,
          types: ["provider/error", "turn/completed"],
        }),
      ).toEqual([]);
    });
    expect(captured).toHaveLength(2);
    for (const query of captured) {
      const details = queryPlanDetails({
        db,
        params: query.params,
        sql: query.sql,
      });
      expect(details).toMatch(/USING INDEX events_thread_type_sequence_idx/u);
      expect(details).not.toMatch(/events_thread_sequence_idx/u);
    }

    db.$client.close();
  });

  it("loads daemon item lifecycle state through the targeted partial index", () => {
    const { db, logger, thread } = setup();
    const turnId = "turn-lifecycle-plan";
    const itemId = "item-lifecycle-plan";

    insertEvents(db, noopNotifier, [
      {
        threadId: thread.id,
        sequence: 1,
        type: "turn/started",
        scope: turnScope(turnId),
        itemId: null,
        itemKind: null,
        parentToolCallId: null,
        data: JSON.stringify({ providerThreadId: "provider-plan" }),
      },
      {
        threadId: thread.id,
        sequence: 2,
        type: "item/completed",
        scope: turnScope(turnId),
        itemId,
        itemKind: "agentMessage",
        parentToolCallId: null,
        data: JSON.stringify({
          providerThreadId: "provider-plan",
          item: { type: "agentMessage", id: itemId, text: "done" },
        }),
      },
    ]);

    db.transaction(
      (tx) =>
        appendDaemonEventsInTransaction(tx, [
          {
            threadId: thread.id,
            environmentId: null,
            type: "item/completed",
            scope: turnScope(turnId),
            itemId,
            itemKind: "agentMessage",
            parentToolCallId: null,
            providerThreadId: "provider-plan",
            data: JSON.stringify({
              providerThreadId: "provider-plan",
              item: { type: "agentMessage", id: itemId, text: "done" },
            }),
          },
        ]),
      { behavior: "immediate" },
    );

    const debugLog = findOnlyDebugLog({
      logger,
      predicate: (fields) =>
        fields.operation === "all" && fields.sql.includes("requested_item"),
    });
    expect(debugLog.fields.bindingArgumentCount).toBe(2);
    const lifecycleTypes =
      "IN ('item/started', 'item/completed', 'item/backgroundTask/completed')";
    const planSql = debugLog.fields.sql.replaceAll(
      "IN ( '?', '?', '?' )",
      lifecycleTypes,
    );
    const details = queryPlanDetails({
      db,
      params: [thread.id, itemId],
      sql: planSql,
    });
    expect(
      details.match(/events_item_lifecycle_thread_item_sequence_idx/gu),
    ).toHaveLength(2);

    db.$client.close();
  });

  it("resolves parent crossings through the covering delegating-item index", () => {
    const { db, thread } = setup();

    const captured = captureStatements(db, () => {
      expect(
        hasParentedEventCrossingSequence(db, {
          sequence: 2,
          threadId: thread.id,
        }),
      ).toBe(false);
    });
    const query = captured.find((entry) =>
      entry.sql.includes("parent_event.item_id"),
    );
    if (!query) {
      throw new Error("Expected the parent-crossing lookup SQL");
    }
    const details = queryPlanDetails({
      db,
      params: query.params,
      sql: query.sql,
    });
    expect(details).toMatch(
      /SEARCH parent_event .*USING COVERING INDEX events_delegating_item_lookup_idx/u,
    );

    db.$client.close();
  });

  it("loads parented timeline rows through the normalized parent index", () => {
    const { db, thread } = setup();

    const [query] = captureStatements(db, () => {
      expect(
        listStoredEventRowsByParentToolCallIds(db, {
          maxInlineOutputChars: null,
          parentToolCallIds: ["parent-tool-call"],
          threadId: thread.id,
        }),
      ).toEqual([]);
    });
    if (!query) {
      throw new Error("Expected the parented timeline row lookup SQL");
    }
    expect(
      queryPlanDetails({ db, params: query.params, sql: query.sql }),
    ).toMatch(
      /SEARCH events USING INDEX events_parent_tool_call_thread_parent_sequence_idx/u,
    );

    db.$client.close();
  });

  it("scans background-task history once without a completed-set join", () => {
    const { db, thread } = setup();

    const captured = captureStatements(db, () => {
      listActiveBackgroundTaskCountsByThreadIds(db, {
        threadIds: [thread.id],
      });
    });
    const query = captured.find((entry) =>
      entry.sql.includes("latest_background_task_state"),
    );
    if (!query) {
      throw new Error("Expected the active background-task count SQL");
    }
    expect(query.params).toHaveLength(15);
    const details = queryPlanDetails({
      db,
      params: query.params,
      sql: query.sql,
    });
    expect(
      details.match(/events_background_task_thread_type_item_sequence_idx/gu),
    ).toHaveLength(1);
    expect(details).not.toMatch(/CORRELATED|LEFT-JOIN|SCAN completed/u);

    db.$client.close();
  });

  it("uses selective indexes for conversation-outline events", () => {
    const { db, thread } = setup();

    const captured = captureStatements(db, () => {
      listStoredConversationOutlineEventRows(db, {
        sequenceStart: 0,
        threadId: thread.id,
      });
    });
    const outline = captured.filter((query) =>
      query.sql.includes('from "events"'),
    );
    expect(outline).toHaveLength(1);
    const [query] = outline;
    expect(query?.params).toEqual([
      thread.id,
      0,
      "client/turn/requested",
      "turn/input/accepted",
      "turn/started",
      "turn/completed",
      "system/manager/user_message",
      "system/thread/interrupted",
      "system/error",
      "provider/error",
      "item/agentMessage/delta",
      "item/plan/delta",
      thread.id,
      0,
      "item/completed",
      "agentMessage",
      "plan",
      thread.id,
      0,
      "item/started",
      "item/completed",
      "item/backgroundTask/progress",
      "item/backgroundTask/completed",
      "backgroundTask",
      "toolCall",
      "item/started",
    ]);
    const details = queryPlanDetails({
      db,
      params: query?.params ?? [],
      sql: query?.sql ?? "",
    });
    expect(
      details.match(/USING INDEX events_thread_type_sequence_idx/gu),
    ).toHaveLength(1);
    expect(
      details.match(/USING INDEX events_thread_type_item_kind_sequence_idx/gu),
    ).toHaveLength(2);
    expect(details).toMatch(
      /USING INDEX events_item_lifecycle_thread_item_sequence_idx/u,
    );
    expect(details).toMatch(
      /USING COVERING INDEX events_background_task_thread_type_item_sequence_idx/u,
    );
    expect(details).not.toMatch(/SCAN events/u);

    db.$client.close();
  });

  it("loads the newest plan snapshot through the kind-based plan-steps index", () => {
    const { db, thread } = setup();

    const captured = captureStatements(db, () => {
      expect(
        listTodoSnapshotEventRowsForThread(db, { threadId: thread.id }),
      ).toEqual([]);
    });
    const query = captured.find((entry) => entry.sql.includes("planSteps"));
    if (!query) {
      throw new Error("Expected the plan snapshot SQL");
    }
    expect(query.sql).not.toContain("json_extract");
    expect(query.sql).not.toContain("tool_name");
    expect(query.params).toEqual([thread.id, 1]);
    expect(
      queryPlanDetails({ db, params: query.params, sql: query.sql }),
    ).toContain("events_plan_steps_thread_sequence_idx");

    db.$client.close();
  });

  it("resolves open background-task state without per-row subqueries", () => {
    const { db, logger, thread } = setup();

    listLatestOpenBackgroundTaskStateRowsForThread(db, {
      threadId: thread.id,
    });

    const debugLog = findOnlyDebugLog({
      logger,
      predicate: (fields) =>
        fields.operation === "all" &&
        fields.sql.includes("completed_background_task_state"),
    });
    const params = [
      thread.id,
      thread.id,
      "backgroundTask",
      "item/started",
      "item/backgroundTask/progress",
      thread.id,
      "item/backgroundTask/completed",
    ];
    assertEmittedQueryPlanUsesIndex({
      db,
      debugLog,
      indexName: "events_background_task_thread_type_item_sequence_idx",
      params,
    });

    expect(
      queryPlanDetails({ db, params, sql: debugLog.fields.sql }),
    ).not.toMatch(/CORRELATED/);

    db.$client.close();
  });

  it("uses the closed-session prune index for emitted delete SQL", () => {
    const { db, host, logger } = setup();
    const now = Date.now();
    const staleSession = openSession(db, {
      hostId: host.id,
      instanceId: "closed-prune-query-plan",
      hostName: "query-plan-host",
      hostType: "persistent",
      dataDir: "/tmp/query-plan-host-data",
      protocolVersion: 1,
      heartbeatIntervalMs: 10_000,
      leaseTimeoutMs: 30_000,
    });
    const closedBefore = now - 5_000;
    closeSessionAt({
      closedAt: now - 10_000,
      db,
      sessionId: staleSession.id,
    });
    logger.clear();

    pruneClosedSessions(db, { closedBefore, limit: 100 });

    const debugLog = findOnlyDebugLog({
      logger,
      predicate: (fields) =>
        fields.operation === "run" &&
        fields.sql.startsWith("DELETE FROM host_daemon_sessions"),
    });
    assertEmittedQueryPlanUsesIndex({
      db,
      debugLog,
      indexName: "host_daemon_sessions_closed_prune_idx",
      params: ["closed", closedBefore, 100],
    });
    db.$client.close();
  });

  it("uses the environment index for bounded event detaches", () => {
    const { db, host, logger, project, thread } = setup();
    const now = Date.now();
    const environment = createEnvironment(db, noopNotifier, {
      hostId: host.id,
      managed: true,
      projectId: project.id,
      status: "destroyed",
      workspaceProvisionType: "managed-worktree",
    });
    insertEvents(db, noopNotifier, [
      {
        data: JSON.stringify({ text: "environment prune query plan" }),
        environmentId: environment.id,
        itemId: null,
        itemKind: null,
        parentToolCallId: null,
        scope: threadScope(),
        sequence: 1,
        threadId: thread.id,
        type: "system/manager/user_message",
      },
    ]);
    const updatedBefore = now - 5_000;
    db.$client
      .prepare("UPDATE environments SET updated_at = ? WHERE id = ?")
      .run(now - 10_000, environment.id);
    logger.clear();

    expect(
      pruneDestroyedEnvironments(db, noopNotifier, {
        eventBatchSize: 50,
        limit: 1,
        updatedBefore,
      }),
    ).toEqual({ deleted: 0, detachedEvents: 1 });

    const debugLog = findOnlyDebugLog({
      logger,
      predicate: (fields) =>
        fields.operation === "run" &&
        fields.sql.startsWith("UPDATE events SET environment_id = NULL"),
    });
    assertEmittedQueryPlanUsesIndex({
      db,
      debugLog,
      indexName: "events_environment_idx",
      params: [environment.id, 50],
    });
    expect(
      queryPlanDetails({
        db,
        params: [environment.id, 50],
        sql: debugLog.fields.sql,
      }),
    ).not.toContain("USE TEMP B-TREE");

    db.$client.close();
  });

  it("uses the provider request index for pending interaction lookups", () => {
    const { db, logger, thread } = setup();
    createPendingInteraction(db, {
      threadId: thread.id,
      turnId: "turn-provider-request-query-plan",
      providerId: "codex",
      providerThreadId: "provider-thread-query-plan",
      providerRequestId: "request-query-plan",
      payload: "{}",
    });
    logger.clear();

    expect(
      getPendingInteractionByProviderRequest(db, {
        providerId: "codex",
        providerThreadId: "provider-thread-query-plan",
        providerRequestId: "request-query-plan",
      }),
    ).toMatchObject({
      threadId: thread.id,
    });

    const debugLog = findOnlyDebugLog({
      logger,
      predicate: (fields) =>
        fields.operation === "get" &&
        fields.sql.includes('from "pending_interactions"') &&
        fields.sql.includes('"provider_request_id" = ?'),
    });
    assertEmittedQueryPlanUsesIndex({
      db,
      debugLog,
      indexName: "pending_interactions_provider_request_idx",
      params: [
        "provider",
        "codex",
        "provider-thread-query-plan",
        "request-query-plan",
      ],
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
        parentToolCallId: null,
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
        parentToolCallId: null,
        scope: turnScope("turn_query_plan"),
        sequence: 2,
        threadId: thread.id,
        type: "thread/contextWindowUsage/updated",
      },
      {
        data: "{}",
        itemId: null,
        itemKind: null,
        parentToolCallId: null,
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
        fields.sql.includes("DELETE FROM events") &&
        fields.sql.includes("root_usage"),
    });
    assertEmittedQueryPlanUsesIndex({
      db,
      debugLog,
      indexName: "events_thread_type_sequence_idx",
      params: [
        thread.id,
        "thread/contextWindowUsage/updated",
        thread.id,
        "thread/contextWindowUsage/updated",
        sequenceCutoff,
        "$.contextWindowUsage.modelContextWindow",
      ],
    });

    db.$client.close();
  });

  it("uses the active-thread maintenance index for emitted idle checks", () => {
    const { db, logger } = setup();
    logger.clear();

    getDatabaseMaintenanceActivity(db);

    const debugLog = findOnlyDebugLog({
      logger,
      predicate: (fields) =>
        fields.operation === "get" &&
        fields.sql.includes('from "threads"') &&
        fields.sql.includes('"threads"."deleted_at" is null'),
    });
    assertEmittedQueryPlanUsesIndex({
      db,
      debugLog,
      indexName: "threads_active_maintenance_idx",
      params: ["active", "provisioning"],
    });

    db.$client.close();
  });

  it("uses rowid lookups for thread search FTS segment hydration", () => {
    const { db } = setup();

    const details = queryPlanDetails({
      db,
      params: ['"queryplanneedle"*', 20],
      sql: `
        SELECT s.id
        FROM thread_search_segments_fts
        JOIN thread_search_segments AS s
          ON s.rowid = thread_search_segments_fts.rowid
        WHERE thread_search_segments_fts MATCH ?
        LIMIT ?
      `,
    });

    expect(details).toContain(
      "SCAN thread_search_segments_fts VIRTUAL TABLE INDEX",
    );
    expect(details).toContain("SEARCH s USING INTEGER PRIMARY KEY (rowid=?)");
    expect(details).not.toContain("SCAN s");

    db.$client.close();
  });

  it("uses the thread and sequence index for search segment suffix deletes", () => {
    const { db } = setup();

    const details = queryPlanDetails({
      db,
      params: ["thread-query-plan", 10, 20],
      sql: `
        DELETE FROM thread_search_segments
        WHERE thread_id = ?
          AND source_seq >= ?
          AND source_seq <= ?
      `,
    });

    expect(details).toMatch(
      /USING (?:COVERING )?INDEX thread_search_segments_thread_source_seq_idx/,
    );
    expect(details).not.toContain("SCAN thread_search_segments");

    db.$client.close();
  });

  it("uses the completed item truncation partial index for emitted cursor scans", () => {
    const { db, logger, thread } = setup();
    const createdBefore = Date.now();
    const commandOutput =
      "command-head-" +
      "a".repeat(COMPLETED_EVENT_OUTPUT_TRUNCATION_THRESHOLD_CHARS) +
      "-command-tail";
    insertEvents(db, noopNotifier, [
      {
        createdAt: createdBefore - 10_000,
        data: JSON.stringify({
          item: {
            aggregatedOutput: commandOutput,
            id: "cmd-truncation-query-plan",
            type: "commandExecution",
          },
        }),
        itemId: "cmd-truncation-query-plan",
        itemKind: "commandExecution",
        parentToolCallId: null,
        scope: turnScope("turn_truncation_query_plan"),
        sequence: 1,
        threadId: thread.id,
        type: "item/completed",
      },
    ]);
    logger.clear();

    truncateCompletedEventItemOutputs(db, {
      createdBefore,
      limit: 10,
      truncatedAt: createdBefore,
    });

    const scanDebugLogs = logger.debugLogs.filter(
      (debugLog) =>
        debugLog.fields.operation === "all" &&
        debugLog.fields.sql.startsWith("SELECT id, created_at FROM events") &&
        debugLog.fields.sql.includes("ORDER BY created_at, id") &&
        debugLog.fields.bindingArgumentCount === 6,
    );
    expect(scanDebugLogs.map((debugLog) => debugLog.fields.sql)).toHaveLength(
      4,
    );
    const debugLog = scanDebugLogs[0];
    if (!debugLog) {
      throw new Error("Expected completed item truncation scan SQL debug log");
    }
    assertEmittedQueryPlanUsesIndex({
      db,
      debugLog,
      indexName: "events_completed_item_truncation_idx",
      params: ["item/completed", "commandExecution", createdBefore, 0, "", 10],
    });

    db.$client.close();
  });

  it("uses materialized parent ids and the consolidated index for delta pruning", () => {
    const { db, logger, thread } = setup();
    const turnId = "turn_resolved_delta_query_plan";
    const itemId = "call_resolved_delta_query_plan";
    insertEvents(db, noopNotifier, [
      {
        data: JSON.stringify({ output: "first", parentToolCallId: "parent" }),
        itemId,
        itemKind: null,
        parentToolCallId: "parent",
        scope: turnScope(turnId),
        sequence: 1,
        threadId: thread.id,
        type: "item/commandExecution/outputDelta",
      },
      {
        data: JSON.stringify({ output: "second", parentToolCallId: "parent" }),
        itemId,
        itemKind: null,
        parentToolCallId: "parent",
        scope: turnScope(turnId),
        sequence: 2,
        threadId: thread.id,
        type: "item/commandExecution/outputDelta",
      },
      {
        data: JSON.stringify({
          item: {
            aggregatedOutput: "firstsecond",
            id: itemId,
            parentToolCallId: "parent",
            type: "commandExecution",
          },
        }),
        itemId,
        itemKind: "commandExecution",
        parentToolCallId: "parent",
        scope: turnScope(turnId),
        sequence: 3,
        threadId: thread.id,
        type: "item/completed",
      },
    ]);
    logger.clear();

    expect(pruneResolvedItemDeltas(db, { threadId: thread.id })).toBe(1);
    const pruneQuery = findOnlyDebugLog({
      logger,
      predicate: (fields) =>
        fields.operation === "run" &&
        fields.sql.startsWith("DELETE FROM events"),
    });
    expect(pruneQuery.fields.sql).toContain("parent_tool_call_id IS");
    expect(pruneQuery.fields.sql).not.toContain("json_extract");

    const completedLookupPlan = queryPlanDetails({
      db,
      params: [thread.id, turnId, itemId],
      sql: `
        SELECT 1
        FROM events AS completed
        WHERE completed.thread_id = ?
          AND completed.turn_id = ?
          AND completed.type = 'item/completed'
          AND completed.item_kind = 'commandExecution'
          AND completed.item_id = ?
          AND json_type(completed.data, '$.item.aggregatedOutput') IS NOT NULL
        LIMIT 1
      `,
    });
    const earlierDeltaLookupPlan = queryPlanDetails({
      db,
      params: [thread.id, turnId, itemId, 3],
      sql: `
        SELECT 1
        FROM events AS earlier_delta
        WHERE earlier_delta.thread_id = ?
          AND earlier_delta.turn_id = ?
          AND earlier_delta.type = 'item/commandExecution/outputDelta'
          AND earlier_delta.item_id = ?
          AND earlier_delta.sequence < ?
        LIMIT 1
      `,
    });

    expect(completedLookupPlan).toContain(
      "events_thread_turn_type_item_sequence_idx",
    );
    expect(earlierDeltaLookupPlan).toContain(
      "events_thread_turn_type_item_sequence_idx",
    );
    expect(completedLookupPlan).not.toContain(
      "events_thread_turn_type_item_kind_item_idx",
    );

    db.$client.close();
  });

  it("pins the latest-thread-state lookup to the partial index with no temp sort", () => {
    const { db, thread } = setup();
    insertEvents(db, noopNotifier, [
      {
        data: JSON.stringify({ goal: "guard the query plan" }),
        itemId: null,
        itemKind: null,
        parentToolCallId: null,
        scope: threadScope(),
        sequence: 1,
        threadId: thread.id,
        type: "thread/goal/updated",
      },
    ]);

    const captured = captureStatements(db, () => {
      expect(
        listLatestThreadStateEventRowsByThreadIds(db, {
          threadIds: [thread.id],
          kind: "provider-codex/goal",
        }),
      ).toHaveLength(1);
    });
    const statement = captured.find((entry) =>
      entry.sql.includes("latest_state"),
    );
    if (!statement) {
      throw new Error("Expected the latest-thread-state lookup SQL");
    }

    const details = queryPlanDetails({
      db,
      params: statement.params,
      sql: statement.sql,
    });
    expect(
      details.match(/events_thread_state_thread_sequence_idx/gu),
    ).toHaveLength(2);
    expect(details).not.toContain("USING INDEX events_thread_sequence_idx");
    expect(details).not.toContain("USE TEMP B-TREE");

    db.$client.close();
  });

  it("serves the thread-list pending probe from its covering index without a GROUP BY sort", () => {
    const { db } = setup();

    const captured = captureStatements(db, () => {
      listThreadsWithPendingInteractionState(db, { includeHidden: false });
    });
    const statement = captured.find(
      (entry) =>
        entry.sql.includes('from "threads"') &&
        entry.sql.includes("pending_interactions"),
    );
    if (!statement) {
      throw new Error("Expected the thread-list SQL");
    }

    const details = queryPlanDetails({
      db,
      params: statement.params,
      sql: statement.sql,
    });
    expect(details).toContain(
      "USING COVERING INDEX pending_interactions_thread_status_created_idx",
    );
    expect(details).not.toContain("USE TEMP B-TREE FOR GROUP BY");

    db.$client.close();
  });

  it("drops redundant events indexes after creating their consolidated replacement", () => {
    const { db } = setup();
    const indexRows = db.$client
      .prepare<[], IndexNameRow>(
        "SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = 'events'",
      )
      .all();
    const indexNames = indexRows.map((row) => row.name);

    expect(indexNames).toContain("events_thread_turn_type_item_sequence_idx");
    expect(indexNames).toContain("events_completed_item_truncation_idx");
    expect(indexNames).not.toContain("events_thread_turn_sequence_idx");
    expect(indexNames).not.toContain("events_thread_item_id_sequence_idx");
    expect(indexNames).not.toContain(
      "events_thread_turn_type_item_kind_item_idx",
    );

    db.$client.close();
  });
});
