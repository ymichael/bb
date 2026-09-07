import { randomUUID } from "node:crypto";
import type Database from "better-sqlite3";
import type { ResolvedWorkflowExecutionSelection } from "./cache.js";
import type { JsonValue, WorkflowAgentOptions } from "./types.js";

export type Db = Database.Database;
type WorkflowRunStatus =
  | "queued"
  | "running"
  | "succeeded"
  | "failed"
  | "cancelled";
type WorkflowCallStatus =
  | "queued"
  | "running"
  | "succeeded"
  | "failed"
  | "cancelled";

export interface WorkflowRunRow {
  id: string;
  projectId: string;
  originThreadId: string;
  environmentId: string;
  originProvider: string;
  originModel: string;
  originReasoningLevel: string;
  originPermissionMode: string;
  name: string;
  source: string;
  sourceHash: string;
  argsJson: string;
  settingsJson: string;
  status: WorkflowRunStatus;
  resumedFromRunId: string | null;
  resultJson: string | null;
  error: string | null;
  phase: string | null;
  replaySafetyVersion: number;
  replayBarrierIndex: number | null;
  notificationSent: boolean;
  notificationOutcome: "pending" | "delivered" | "abandoned";
  notificationAttemptCount: number;
  notificationNextAttemptAt: number | null;
  notificationError: string | null;
  createdAt: number;
  startedAt: number | null;
  finishedAt: number | null;
}

export interface WorkflowCallRow {
  id: string;
  runId: string;
  callIndex: number;
  cacheKey: string;
  prompt: string;
  optionsJson: string;
  resolvedProvider: string;
  resolvedModel: string;
  resolvedReasoningLevel: string;
  resolvedPermissionMode: string;
  status: WorkflowCallStatus;
  childThreadId: string | null;
  repairAttempts: number;
  providerRetryAttempts: number;
  resultJson: string | null;
  error: string | null;
  replayedFromCallId: string | null;
  replaySource: "same-run" | "resumed-run" | null;
  createdAt: number;
  startedAt: number | null;
  lastActivityAt: number | null;
  finishedAt: number | null;
}

export interface WorkflowCallCounts {
  total: number;
  queued: number;
  running: number;
  succeeded: number;
  failed: number;
  cancelled: number;
}

type StoreStructuredResultOutcome =
  | "accepted"
  | "idempotent"
  | "conflict"
  | "inactive";

interface RawRunRow extends Omit<WorkflowRunRow, "notificationSent"> {
  notificationSent: 0 | 1;
}

function runRow(value: unknown): WorkflowRunRow {
  const row = value as RawRunRow;
  return { ...row, notificationSent: row.notificationSent === 1 };
}

function optionalRun(value: unknown): WorkflowRunRow | null {
  return value === undefined ? null : runRow(value);
}

function callRow(value: unknown): WorkflowCallRow {
  return value as WorkflowCallRow;
}

function optionalCall(value: unknown): WorkflowCallRow | null {
  return value === undefined ? null : callRow(value);
}

const RUN_SELECT = `
  SELECT id, project_id AS projectId, origin_thread_id AS originThreadId,
    environment_id AS environmentId, origin_provider AS originProvider,
    origin_model AS originModel, origin_reasoning_level AS originReasoningLevel,
    origin_permission_mode AS originPermissionMode,
    name, source, source_hash AS sourceHash, args_json AS argsJson,
    settings_json AS settingsJson, status,
    resumed_from_run_id AS resumedFromRunId, result_json AS resultJson, error,
    phase, replay_safety_version AS replaySafetyVersion,
    replay_barrier_index AS replayBarrierIndex,
    notification_sent AS notificationSent,
    notification_outcome AS notificationOutcome,
    notification_attempt_count AS notificationAttemptCount,
    notification_next_attempt_at AS notificationNextAttemptAt,
    notification_error AS notificationError, created_at AS createdAt,
    started_at AS startedAt, finished_at AS finishedAt
  FROM workflow_runs`;

const CALL_SELECT = `
  SELECT id, run_id AS runId, call_index AS callIndex, cache_key AS cacheKey,
    prompt, options_json AS optionsJson,
    resolved_provider AS resolvedProvider, resolved_model AS resolvedModel,
    resolved_reasoning_level AS resolvedReasoningLevel,
    resolved_permission_mode AS resolvedPermissionMode, status,
    child_thread_id AS childThreadId, repair_attempts AS repairAttempts,
    provider_retry_attempts AS providerRetryAttempts,
    result_json AS resultJson, error,
    replayed_from_call_id AS replayedFromCallId, replay_source AS replaySource,
    created_at AS createdAt, last_activity_at AS lastActivityAt,
    started_at AS startedAt, finished_at AS finishedAt
  FROM workflow_calls`;

export const migrations = [
  `CREATE TABLE IF NOT EXISTS workflow_runs (
     id TEXT PRIMARY KEY,
     project_id TEXT NOT NULL,
     origin_thread_id TEXT NOT NULL,
     environment_id TEXT NOT NULL,
     origin_provider TEXT NOT NULL,
     origin_model TEXT NOT NULL,
     origin_reasoning_level TEXT NOT NULL,
     origin_permission_mode TEXT NOT NULL,
     name TEXT NOT NULL,
     source TEXT NOT NULL,
     source_hash TEXT NOT NULL,
     args_json TEXT NOT NULL,
     status TEXT NOT NULL,
     resumed_from_run_id TEXT REFERENCES workflow_runs(id),
     result_json TEXT,
     error TEXT,
     phase TEXT,
     notification_sent INTEGER NOT NULL DEFAULT 0,
     created_at INTEGER NOT NULL,
     started_at INTEGER,
     finished_at INTEGER
   );
   CREATE INDEX IF NOT EXISTS workflow_runs_project_created_idx
     ON workflow_runs(project_id, created_at DESC);
   CREATE INDEX IF NOT EXISTS workflow_runs_status_created_idx
     ON workflow_runs(status, created_at);
   CREATE TABLE IF NOT EXISTS workflow_calls (
     id TEXT PRIMARY KEY,
     run_id TEXT NOT NULL REFERENCES workflow_runs(id) ON DELETE CASCADE,
     call_index INTEGER NOT NULL,
     cache_key TEXT NOT NULL,
     prompt TEXT NOT NULL,
     options_json TEXT NOT NULL,
     resolved_provider TEXT NOT NULL,
     resolved_model TEXT NOT NULL,
     resolved_reasoning_level TEXT NOT NULL,
     resolved_permission_mode TEXT NOT NULL,
     status TEXT NOT NULL,
     child_thread_id TEXT UNIQUE,
     repair_attempts INTEGER NOT NULL DEFAULT 0,
     result_json TEXT,
     error TEXT,
     replayed_from_call_id TEXT REFERENCES workflow_calls(id),
     replay_source TEXT,
     created_at INTEGER NOT NULL,
     started_at INTEGER,
     finished_at INTEGER,
     UNIQUE(run_id, call_index)
   );
   CREATE INDEX IF NOT EXISTS workflow_calls_run_idx
     ON workflow_calls(run_id, call_index);
   CREATE INDEX IF NOT EXISTS workflow_calls_child_idx
     ON workflow_calls(child_thread_id);`,
  `ALTER TABLE workflow_runs ADD COLUMN settings_json TEXT NOT NULL
     DEFAULT '{"maxActiveRuns":4,"maxConcurrentAgents":8,"maxAgentCalls":100,"totalRunTimeoutMs":86400000,"retentionDays":30,"maxNotificationBytes":16384}';
   ALTER TABLE workflow_calls ADD COLUMN last_activity_at INTEGER;
   CREATE INDEX IF NOT EXISTS workflow_calls_running_activity_idx
     ON workflow_calls(status, last_activity_at);
   CREATE INDEX IF NOT EXISTS workflow_runs_terminal_retention_idx
     ON workflow_runs(status, notification_sent, finished_at);`,
  `ALTER TABLE workflow_runs ADD COLUMN notification_attempt_count INTEGER NOT NULL DEFAULT 0;
   ALTER TABLE workflow_runs ADD COLUMN notification_next_attempt_at INTEGER;
   ALTER TABLE workflow_runs ADD COLUMN notification_error TEXT;
   CREATE INDEX IF NOT EXISTS workflow_runs_notification_retry_idx
     ON workflow_runs(notification_sent, notification_next_attempt_at, finished_at);`,
  `ALTER TABLE workflow_runs ADD COLUMN notification_outcome TEXT NOT NULL DEFAULT 'pending';
   UPDATE workflow_runs SET notification_outcome = 'delivered'
     WHERE notification_sent = 1 AND notification_error IS NULL;
   UPDATE workflow_runs SET notification_outcome = 'abandoned'
     WHERE notification_sent = 1 AND notification_error IS NOT NULL;`,
  `ALTER TABLE workflow_runs ADD COLUMN replay_safety_version INTEGER NOT NULL DEFAULT 0;
   ALTER TABLE workflow_runs ADD COLUMN replay_barrier_index INTEGER;`,
  `CREATE INDEX IF NOT EXISTS workflow_runs_origin_created_idx
     ON workflow_runs(origin_thread_id, created_at DESC);`,
  `UPDATE workflow_runs SET replay_barrier_index = NULL
     WHERE replay_safety_version = 1;`,
  `ALTER TABLE workflow_calls ADD COLUMN provider_retry_attempts INTEGER NOT NULL DEFAULT 0;`,
];

export function createRun(
  db: Db,
  input: Omit<
    WorkflowRunRow,
    | "id"
    | "status"
    | "resultJson"
    | "error"
    | "phase"
    | "replaySafetyVersion"
    | "replayBarrierIndex"
    | "notificationSent"
    | "notificationOutcome"
    | "notificationAttemptCount"
    | "notificationNextAttemptAt"
    | "notificationError"
    | "createdAt"
    | "startedAt"
    | "finishedAt"
  >,
): WorkflowRunRow {
  const id = `wfr_${randomUUID()}`;
  const now = Date.now();
  db.prepare(
    `INSERT INTO workflow_runs (
       id, project_id, origin_thread_id, environment_id, origin_provider,
       origin_model, origin_reasoning_level, origin_permission_mode,
       name, source, source_hash,
       args_json, settings_json, status, resumed_from_run_id,
       replay_safety_version, created_at
     ) VALUES (
       @id, @projectId, @originThreadId, @environmentId, @originProvider,
       @originModel, @originReasoningLevel, @originPermissionMode,
       @name, @source, @sourceHash,
       @argsJson, @settingsJson, 'queued', @resumedFromRunId, 1, @now
     )`,
  ).run({ id, now, ...input });
  return getRunRequired(db, id);
}

export function getRun(db: Db, id: string): WorkflowRunRow | null {
  return optionalRun(db.prepare(`${RUN_SELECT} WHERE id = ?`).get(id));
}

export function getRunRequired(db: Db, id: string): WorkflowRunRow {
  const row = getRun(db, id);
  if (row === null) throw new Error(`Unknown workflow run ${id}`);
  return row;
}

export function getLatestRunForOriginThread(
  db: Db,
  originThreadId: string,
): WorkflowRunRow | null {
  return optionalRun(
    db
      .prepare(
        `${RUN_SELECT} WHERE origin_thread_id = ? ORDER BY created_at DESC, workflow_runs.rowid DESC LIMIT 1`,
      )
      .get(originThreadId),
  );
}

export function listActiveRunsForOriginThread(
  db: Db,
  originThreadId: string,
): WorkflowRunRow[] {
  return db
    .prepare(
      `${RUN_SELECT} WHERE origin_thread_id = ? AND status IN ('queued', 'running')
       ORDER BY created_at DESC, workflow_runs.rowid DESC`,
    )
    .all(originThreadId)
    .map(runRow);
}

export function listRuns(
  db: Db,
  args: { projectId: string; limit: number },
): WorkflowRunRow[] {
  return db
    .prepare(
      `${RUN_SELECT} WHERE project_id = ? ORDER BY created_at DESC LIMIT ?`,
    )
    .all(args.projectId, args.limit)
    .map(runRow);
}

export function claimQueuedRun(
  db: Db,
  maxActiveRuns: number,
): WorkflowRunRow | null {
  return db.transaction(() => {
    const active = db
      .prepare(
        `SELECT COUNT(*) AS count FROM workflow_runs WHERE status = 'running'`,
      )
      .get() as { count: number };
    if (active.count >= maxActiveRuns) return null;
    const row = optionalRun(
      db
        .prepare(
          `${RUN_SELECT} WHERE status = 'queued' ORDER BY created_at LIMIT 1`,
        )
        .get(),
    );
    if (row === null) return null;
    const changed = db
      .prepare(
        `UPDATE workflow_runs SET status = 'running', started_at = COALESCE(started_at, ?)
         WHERE id = ? AND status = 'queued'`,
      )
      .run(Date.now(), row.id).changes;
    return changed === 1 ? getRunRequired(db, row.id) : null;
  })();
}

export function settleRun(
  db: Db,
  args: {
    id: string;
    status: Extract<WorkflowRunStatus, "succeeded" | "failed" | "cancelled">;
    result: JsonValue | null;
    error: string | null;
  },
): WorkflowCallRow[] {
  return db.transaction(() => {
    const outstanding = db
      .prepare(
        `${CALL_SELECT} WHERE run_id = ? AND status IN ('queued', 'running')`,
      )
      .all(args.id)
      .map(callRow);
    const now = Date.now();
    const changed = db
      .prepare(
        `UPDATE workflow_runs SET status = @status, result_json = @resultJson,
         error = @error, finished_at = @now
         WHERE id = @id AND status IN ('queued', 'running')`,
      )
      .run({
        id: args.id,
        status: args.status,
        resultJson:
          args.status === "succeeded" ? JSON.stringify(args.result) : null,
        error: args.error,
        now,
      }).changes;
    if (changed === 0) return [];
    db.prepare(
      `UPDATE workflow_calls SET status = 'cancelled',
       error = 'Parent workflow finished before this call', finished_at = ?
       WHERE run_id = ? AND status IN ('queued', 'running')`,
    ).run(now, args.id);
    return outstanding;
  })();
}

export function updateRunPhase(db: Db, id: string, phase: string): void {
  db.prepare(
    `UPDATE workflow_runs SET phase = ? WHERE id = ? AND status = 'running'`,
  ).run(phase, id);
}

export function markNotificationSent(db: Db, id: string): void {
  db.prepare(
    `UPDATE workflow_runs SET notification_sent = 1,
     notification_outcome = 'delivered', notification_next_attempt_at = NULL,
     notification_error = NULL
     WHERE id = ?`,
  ).run(id);
}

export function settleNotificationUndeliverable(
  db: Db,
  id: string,
  error: string,
): void {
  db.prepare(
    `UPDATE workflow_runs SET notification_sent = 1,
     notification_outcome = 'abandoned', notification_next_attempt_at = NULL,
     notification_error = ?
     WHERE id = ?`,
  ).run(error, id);
}

export function recordNotificationFailure(
  db: Db,
  args: { id: string; error: string; nextAttemptAt: number },
): void {
  db.prepare(
    `UPDATE workflow_runs SET
       notification_next_attempt_at = @nextAttemptAt,
       notification_error = @error
     WHERE id = @id AND notification_sent = 0`,
  ).run(args);
}

export function beginNotificationAttempt(db: Db, id: string): boolean {
  return (
    db
      .prepare(
        `UPDATE workflow_runs SET
           notification_attempt_count = notification_attempt_count + 1,
           notification_next_attempt_at = NULL
         WHERE id = ? AND notification_sent = 0`,
      )
      .run(id).changes === 1
  );
}

export function recoverInterruptedRuns(db: Db): string[] {
  return db.transaction(() => {
    const childRows = db
      .prepare(
        `SELECT calls.child_thread_id AS childThreadId
         FROM workflow_calls calls
         JOIN workflow_runs runs ON runs.id = calls.run_id
         WHERE runs.status = 'running' AND calls.status = 'running'
           AND calls.child_thread_id IS NOT NULL`,
      )
      .all() as Array<{ childThreadId: string }>;
    const now = Date.now();
    db.prepare(
      `UPDATE workflow_calls SET status = 'succeeded', error = NULL, finished_at = ?
       WHERE status = 'running' AND result_json IS NOT NULL AND run_id IN (
         SELECT id FROM workflow_runs WHERE status = 'running'
       )`,
    ).run(now);
    db.prepare(
      `UPDATE workflow_calls SET status = 'cancelled', error = 'Plugin restarted', finished_at = ?
       WHERE status IN ('queued', 'running') AND run_id IN (
         SELECT id FROM workflow_runs WHERE status = 'running'
       )`,
    ).run(now);
    db.prepare(
      `UPDATE workflow_runs SET status = 'queued', error = NULL, finished_at = NULL
       WHERE status = 'running'`,
    ).run();
    return childRows.map((row) => row.childThreadId);
  })();
}

export function getCall(
  db: Db,
  runId: string,
  callIndex: number,
): WorkflowCallRow | null {
  return optionalCall(
    db
      .prepare(`${CALL_SELECT} WHERE run_id = ? AND call_index = ?`)
      .get(runId, callIndex),
  );
}

export function getCallByChildThread(
  db: Db,
  threadId: string,
): WorkflowCallRow | null {
  return optionalCall(
    db.prepare(`${CALL_SELECT} WHERE child_thread_id = ?`).get(threadId),
  );
}

export function listCallsForRun(db: Db, runId: string): WorkflowCallRow[] {
  return db
    .prepare(`${CALL_SELECT} WHERE run_id = ? ORDER BY call_index`)
    .all(runId)
    .map(callRow);
}

export function listCallsForRunPage(
  db: Db,
  args: { runId: string; afterCallIndex: number; limit: number },
): WorkflowCallRow[] {
  return db
    .prepare(
      `${CALL_SELECT} WHERE run_id = ? AND call_index > ?
       ORDER BY call_index LIMIT ?`,
    )
    .all(args.runId, args.afterCallIndex, args.limit)
    .map(callRow);
}

export function countCallsForRun(db: Db, runId: string): WorkflowCallCounts {
  const row = db
    .prepare(
      `SELECT COUNT(*) AS total,
       COALESCE(SUM(status = 'queued'), 0) AS queued,
       COALESCE(SUM(status = 'running'), 0) AS running,
       COALESCE(SUM(status = 'succeeded'), 0) AS succeeded,
       COALESCE(SUM(status = 'failed'), 0) AS failed,
       COALESCE(SUM(status = 'cancelled'), 0) AS cancelled
       FROM workflow_calls WHERE run_id = ?`,
    )
    .get(runId) as WorkflowCallCounts;
  return row;
}

export function listRunningCalls(db: Db, limit: number): WorkflowCallRow[] {
  return db
    .prepare(
      `${CALL_SELECT} WHERE status = 'running' AND child_thread_id IS NOT NULL
       ORDER BY COALESCE(last_activity_at, started_at), id LIMIT ?`,
    )
    .all(limit)
    .map(callRow);
}

export function listTimedOutRuns(
  db: Db,
  now: number,
  limit: number,
): WorkflowRunRow[] {
  return db
    .prepare(
      `${RUN_SELECT} WHERE status = 'running' AND started_at IS NOT NULL
       AND started_at + json_extract(settings_json, '$.totalRunTimeoutMs') <= ?
       ORDER BY started_at, id LIMIT ?`,
    )
    .all(now, limit)
    .map(runRow);
}

export function startCall(
  db: Db,
  args: {
    runId: string;
    callIndex: number;
    cacheKey: string;
    prompt: string;
    options: WorkflowAgentOptions;
    selection: ResolvedWorkflowExecutionSelection;
    replay: { callId: string; result: Exclude<JsonValue, null> } | null;
  },
): WorkflowCallRow {
  return db.transaction(() => {
    const parent = getRun(db, args.runId);
    if (parent?.status !== "running") {
      throw new Error(`Workflow run ${args.runId} is not running`);
    }
    const existing = getCall(db, args.runId, args.callIndex);
    const now = Date.now();
    const id = existing?.id ?? `wfc_${randomUUID()}`;
    db.prepare(
      `INSERT INTO workflow_calls (
       id, run_id, call_index, cache_key, prompt, options_json,
       resolved_provider, resolved_model, resolved_reasoning_level,
       resolved_permission_mode, status, result_json, replayed_from_call_id,
       replay_source, created_at, started_at, finished_at
     ) VALUES (
       @id, @runId, @callIndex, @cacheKey, @prompt, @optionsJson,
       @resolvedProvider, @resolvedModel, @resolvedReasoningLevel,
       @resolvedPermissionMode, @status, @resultJson, @replayedFromCallId,
       @replaySource, @now, @now, @finishedAt
     ) ON CONFLICT(run_id, call_index) DO UPDATE SET
       cache_key = excluded.cache_key, prompt = excluded.prompt,
       options_json = excluded.options_json,
       resolved_provider = excluded.resolved_provider,
       resolved_model = excluded.resolved_model,
       resolved_reasoning_level = excluded.resolved_reasoning_level,
       resolved_permission_mode = excluded.resolved_permission_mode,
       status = excluded.status,
       child_thread_id = NULL, repair_attempts = 0,
       result_json = excluded.result_json, error = NULL,
       replayed_from_call_id = excluded.replayed_from_call_id,
       replay_source = excluded.replay_source,
       started_at = excluded.started_at, finished_at = excluded.finished_at`,
    ).run({
      id,
      runId: args.runId,
      callIndex: args.callIndex,
      cacheKey: args.cacheKey,
      prompt: args.prompt,
      optionsJson: JSON.stringify(args.options),
      resolvedProvider: args.selection.providerId,
      resolvedModel: args.selection.model,
      resolvedReasoningLevel: args.selection.reasoningLevel,
      resolvedPermissionMode: args.selection.permissionMode,
      status: args.replay === null ? "queued" : "succeeded",
      resultJson:
        args.replay === null ? null : JSON.stringify(args.replay.result),
      replayedFromCallId: args.replay?.callId ?? null,
      replaySource: args.replay === null ? null : "resumed-run",
      now,
      finishedAt: args.replay === null ? null : now,
    });
    return getCall(db, args.runId, args.callIndex)!;
  })();
}

export function markCallReplayedSameRun(db: Db, callId: string): void {
  db.prepare(
    `UPDATE workflow_calls SET replay_source = 'same-run'
     WHERE id = ? AND status = 'succeeded' AND result_json IS NOT NULL`,
  ).run(callId);
}

export function attachCallThread(
  db: Db,
  callId: string,
  threadId: string,
): boolean {
  return (
    db
      .prepare(
        `UPDATE workflow_calls SET status = 'running', child_thread_id = ?,
         error = NULL, started_at = ?, last_activity_at = ?
       WHERE id = ? AND status = 'queued'
         AND EXISTS (
           SELECT 1 FROM workflow_runs
           WHERE workflow_runs.id = workflow_calls.run_id
             AND workflow_runs.status = 'running'
         )`,
      )
      .run(threadId, Date.now(), Date.now(), callId).changes === 1
  );
}

export function queueCallProviderRetry(
  db: Db,
  callId: string,
  error: string,
): WorkflowCallRow | null {
  const changed = db
    .prepare(
      `UPDATE workflow_calls SET status = 'queued', child_thread_id = NULL,
       provider_retry_attempts = provider_retry_attempts + 1,
       error = ?, started_at = NULL, last_activity_at = ?, finished_at = NULL
       WHERE id = ? AND status IN ('queued', 'failed') AND result_json IS NULL`,
    )
    .run(error, Date.now(), callId).changes;
  return changed === 0
    ? null
    : optionalCall(db.prepare(`${CALL_SELECT} WHERE id = ?`).get(callId));
}

export function storeStructuredResult(
  db: Db,
  callId: string,
  result: JsonValue,
): StoreStructuredResultOutcome {
  const resultJson = JSON.stringify(result);
  return db.transaction(() => {
    const changed = db
      .prepare(
        `UPDATE workflow_calls SET result_json = ?, last_activity_at = ?
         WHERE id = ? AND status = 'running' AND result_json IS NULL`,
      )
      .run(resultJson, Date.now(), callId).changes;
    if (changed === 1) return "accepted";

    const row = optionalCall(
      db.prepare(`${CALL_SELECT} WHERE id = ?`).get(callId),
    );
    if (row?.resultJson === null || row === null) return "inactive";
    try {
      return equalJsonValues(JSON.parse(row.resultJson), result)
        ? "idempotent"
        : "conflict";
    } catch {
      return "conflict";
    }
  })();
}

export function incrementRepairAttempts(db: Db, callId: string): number | null {
  const changed = db
    .prepare(
      `UPDATE workflow_calls SET repair_attempts = repair_attempts + 1,
       last_activity_at = ?
       WHERE id = ? AND status = 'running' AND result_json IS NULL`,
    )
    .run(Date.now(), callId).changes;
  if (changed === 0) return null;
  const row = optionalCall(
    db.prepare(`${CALL_SELECT} WHERE id = ?`).get(callId),
  );
  if (row === null) throw new Error(`Unknown workflow call ${callId}`);
  return row.repairAttempts;
}

export function settleCall(
  db: Db,
  args: {
    id: string;
    status: Extract<WorkflowCallStatus, "succeeded" | "failed" | "cancelled">;
    result: JsonValue | null;
    error: string | null;
  },
): void {
  db.prepare(
    `UPDATE workflow_calls SET status = @status,
       result_json = COALESCE(result_json, @resultJson), error = @error,
       finished_at = @now WHERE id = @id AND status IN ('queued', 'running')`,
  ).run({
    id: args.id,
    status: args.status,
    resultJson:
      args.status === "succeeded" ? JSON.stringify(args.result) : null,
    error: args.error,
    now: Date.now(),
  });
}

function equalJsonValues(left: JsonValue, right: JsonValue): boolean {
  if (left === right) return true;
  if (left === null || right === null || typeof left !== typeof right) {
    return false;
  }
  if (Array.isArray(left) || Array.isArray(right)) {
    return (
      Array.isArray(left) &&
      Array.isArray(right) &&
      left.length === right.length &&
      left.every((value, index) => equalJsonValues(value, right[index]!))
    );
  }
  if (typeof left !== "object" || typeof right !== "object") return false;
  const leftKeys = Object.keys(left).sort();
  const rightKeys = Object.keys(right).sort();
  return (
    leftKeys.length === rightKeys.length &&
    leftKeys.every(
      (key, index) =>
        key === rightKeys[index] && equalJsonValues(left[key]!, right[key]!),
    )
  );
}

export function cancelRun(db: Db, id: string): boolean {
  return db.transaction(() => {
    const now = Date.now();
    const changed = db
      .prepare(
        `UPDATE workflow_runs SET status = 'cancelled', error = 'Cancelled', finished_at = ?
         WHERE id = ? AND status IN ('queued', 'running')`,
      )
      .run(now, id).changes;
    db.prepare(
      `UPDATE workflow_calls SET status = 'cancelled', error = 'Cancelled', finished_at = ?
       WHERE run_id = ? AND status IN ('queued', 'running')`,
    ).run(now, id);
    return changed === 1;
  })();
}

export function activeChildThreadsForRun(db: Db, runId: string): string[] {
  return (
    db
      .prepare(
        `SELECT child_thread_id AS childThreadId FROM workflow_calls
         WHERE run_id = ? AND status IN ('queued', 'running')
           AND child_thread_id IS NOT NULL`,
      )
      .all(runId) as Array<{ childThreadId: string }>
  ).map((row) => row.childThreadId);
}

export function listPendingNotificationRuns(
  db: Db,
  now = Date.now(),
  limit = 100,
): WorkflowRunRow[] {
  return db
    .prepare(
      `${RUN_SELECT} WHERE notification_sent = 0
       AND status IN ('succeeded', 'failed', 'cancelled')
       AND (notification_next_attempt_at IS NULL OR notification_next_attempt_at <= ?)
       ORDER BY finished_at, id LIMIT ?`,
    )
    .all(now, limit)
    .map(runRow);
}

const EXPIRED_TERMINAL_RUN_IDS_SQL = `WITH RECURSIVE retained(id, resumed_from_run_id) AS (
         SELECT id, resumed_from_run_id FROM workflow_runs
         WHERE status IN ('queued', 'running')
           OR finished_at + json_extract(settings_json, '$.retentionDays') * 86400000 > ?
         UNION
         SELECT parent.id, parent.resumed_from_run_id
         FROM workflow_runs parent
         JOIN retained child ON child.resumed_from_run_id = parent.id
       ), expired_candidates(id, resumed_from_run_id) AS (
         SELECT id, resumed_from_run_id FROM workflow_runs
         WHERE status IN ('succeeded', 'failed', 'cancelled')
           AND notification_sent = 1
           AND finished_at + json_extract(settings_json, '$.retentionDays') * 86400000 <= ?
           AND id NOT IN (SELECT id FROM retained)
       ), leaf_depth(id, resumed_from_run_id, depth) AS (
         SELECT candidate.id, candidate.resumed_from_run_id, 0
         FROM expired_candidates candidate
         WHERE NOT EXISTS (
           SELECT 1 FROM expired_candidates child
           WHERE child.resumed_from_run_id = candidate.id
         )
         UNION ALL
         SELECT parent.id, parent.resumed_from_run_id, child.depth + 1
         FROM expired_candidates parent
         JOIN leaf_depth child ON child.resumed_from_run_id = parent.id
       ), expired(id) AS (
         SELECT id FROM leaf_depth
         GROUP BY id
         ORDER BY MAX(depth), id
         LIMIT ?
       )
       SELECT id FROM expired`;

export interface ExpiredTerminalRuns {
  runIds: string[];
  childThreadIds: string[];
}

export function listExpiredTerminalRuns(
  db: Db,
  now: number,
  limit: number,
): ExpiredTerminalRuns {
  const runIds = (
    db.prepare(EXPIRED_TERMINAL_RUN_IDS_SQL).all(now, now, limit) as Array<{
      id: string;
    }>
  ).map((row) => row.id);
  if (runIds.length === 0) return { runIds: [], childThreadIds: [] };
  const placeholders = runIds.map(() => "?").join(", ");
  const childThreadIds = (
    db
      .prepare(
        `SELECT DISTINCT child_thread_id AS childThreadId FROM workflow_calls
         WHERE run_id IN (${placeholders}) AND child_thread_id IS NOT NULL`,
      )
      .all(...runIds) as Array<{ childThreadId: string }>
  ).map((row) => row.childThreadId);
  return { runIds, childThreadIds };
}

export function deleteTerminalRuns(db: Db, runIds: readonly string[]): number {
  if (runIds.length === 0) return 0;
  const placeholders = runIds.map(() => "?").join(", ");
  return db
    .prepare(`DELETE FROM workflow_runs WHERE id IN (${placeholders})`)
    .run(...runIds).changes;
}
