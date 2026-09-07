import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  attachCallThread,
  cancelRun,
  countCallsForRun,
  createRun,
  deleteTerminalRuns,
  getCall,
  getRunRequired,
  incrementRepairAttempts,
  listCallsForRunPage,
  listExpiredTerminalRuns,
  migrations,
  queueCallProviderRetry,
  recoverInterruptedRuns,
  settleCall,
  settleRun,
  startCall,
  storeStructuredResult,
} from "./data.js";

describe("workflow durable data", () => {
  let db: Database.Database;

  beforeEach(() => {
    db = new Database(":memory:");
    db.pragma("foreign_keys = ON");
    db.exec(migrations.join("\n"));
  });

  afterEach(() => db.close());

  function sweepExpired(now: number, limit: number): number {
    return deleteTerminalRuns(
      db,
      listExpiredTerminalRuns(db, now, limit).runIds,
    );
  }

  function newRun() {
    return createRun(db, {
      projectId: "project-1",
      originThreadId: "thread-1",
      environmentId: "environment-1",
      originProvider: "codex",
      originModel: "gpt-test",
      originReasoningLevel: "medium",
      originPermissionMode: "full",
      name: "test-workflow",
      source: "return null",
      sourceHash: "hash",
      argsJson: "null",
      settingsJson:
        '{"maxActiveRuns":4,"maxConcurrentAgents":8,"maxAgentCalls":100,"totalRunTimeoutMs":86400000,"retentionDays":30,"maxNotificationBytes":16384}',
      resumedFromRunId: null,
    });
  }

  function markRunning(runId: string): void {
    db.prepare(`UPDATE workflow_runs SET status = 'running' WHERE id = ?`).run(
      runId,
    );
  }

  const resolvedSelection = {
    providerId: "codex",
    model: "gpt-test",
    reasoningLevel: "medium",
    permissionMode: "full",
  } as const;

  it("records replay safety without a concurrency barrier", () => {
    const run = newRun();
    expect(getRunRequired(db, run.id)).toMatchObject({
      replaySafetyVersion: 1,
      replayBarrierIndex: null,
    });

    markRunning(run.id);
    expect(recoverInterruptedRuns(db)).toEqual([]);
    expect(getRunRequired(db, run.id)).toMatchObject({
      status: "queued",
      replaySafetyVersion: 1,
      replayBarrierIndex: null,
    });

    db.prepare(
      `UPDATE workflow_runs SET replay_safety_version = 0,
       replay_barrier_index = NULL WHERE id = ?`,
    ).run(run.id);
    expect(getRunRequired(db, run.id)).toMatchObject({
      replaySafetyVersion: 0,
      replayBarrierIndex: null,
    });
  });

  it("stores successful calls for deterministic replay", () => {
    const run = newRun();
    markRunning(run.id);
    const call = startCall(db, {
      runId: run.id,
      callIndex: 0,
      cacheKey: "cache",
      prompt: "inspect",
      options: {
        selection: null,
        outputSchema: null,
        title: null,
        phase: null,
      },
      selection: resolvedSelection,
      replay: null,
    });
    settleCall(db, {
      id: call.id,
      status: "succeeded",
      result: { answer: 42 },
      error: null,
    });

    expect(getCall(db, run.id, 0)).toMatchObject({
      cacheKey: "cache",
      optionsJson:
        '{"selection":null,"outputSchema":null,"title":null,"phase":null}',
      resolvedProvider: "codex",
      resolvedModel: "gpt-test",
      resolvedReasoningLevel: "medium",
      resolvedPermissionMode: "full",
      status: "succeeded",
      resultJson: '{"answer":42}',
      replaySource: null,
    });
  });

  it("persists provider retry attempts across worker replacements", () => {
    const run = newRun();
    markRunning(run.id);
    const call = startCall(db, {
      runId: run.id,
      callIndex: 0,
      cacheKey: "retry",
      prompt: "inspect",
      options: {
        selection: null,
        outputSchema: null,
        title: null,
        phase: null,
      },
      selection: resolvedSelection,
      replay: null,
    });
    expect(attachCallThread(db, call.id, "child-1")).toBe(true);
    settleCall(db, {
      id: call.id,
      status: "failed",
      result: null,
      error: "provider overloaded",
    });

    expect(
      queueCallProviderRetry(db, call.id, "provider overloaded"),
    ).toMatchObject({
      status: "queued",
      childThreadId: null,
      providerRetryAttempts: 1,
      error: "provider overloaded",
    });
    expect(attachCallThread(db, call.id, "child-2")).toBe(true);
    expect(getCall(db, run.id, 0)).toMatchObject({
      status: "running",
      childThreadId: "child-2",
      providerRetryAttempts: 1,
      error: null,
    });
  });

  it("pages calls by stable index and counts statuses without loading history", () => {
    const run = newRun();
    markRunning(run.id);
    const calls = [0, 1, 2].map((callIndex) =>
      startCall(db, {
        runId: run.id,
        callIndex,
        cacheKey: `cache-${callIndex}`,
        prompt: `inspect ${callIndex}`,
        options: {
          selection: null,
          outputSchema: null,
          title: null,
          phase: null,
        },
        selection: resolvedSelection,
        replay: null,
      }),
    );
    settleCall(db, {
      id: calls[0]!.id,
      status: "succeeded",
      result: "done",
      error: null,
    });
    settleCall(db, {
      id: calls[1]!.id,
      status: "failed",
      result: null,
      error: "failed",
    });
    expect(attachCallThread(db, calls[2]!.id, "child-2")).toBe(true);

    expect(
      listCallsForRunPage(db, {
        runId: run.id,
        afterCallIndex: -1,
        limit: 2,
      }).map((call) => call.callIndex),
    ).toEqual([0, 1]);
    expect(
      listCallsForRunPage(db, {
        runId: run.id,
        afterCallIndex: 1,
        limit: 2,
      }).map((call) => call.callIndex),
    ).toEqual([2]);
    expect(countCallsForRun(db, run.id)).toEqual({
      total: 3,
      queued: 0,
      running: 1,
      succeeded: 1,
      failed: 1,
      cancelled: 0,
    });
  });

  it("requeues interrupted runs and records orphan workers", () => {
    const run = newRun();
    markRunning(run.id);
    const call = startCall(db, {
      runId: run.id,
      callIndex: 0,
      cacheKey: "cache",
      prompt: "inspect",
      options: {
        selection: null,
        outputSchema: null,
        title: null,
        phase: null,
      },
      selection: resolvedSelection,
      replay: null,
    });
    db.prepare(
      `UPDATE workflow_calls SET status = 'running', child_thread_id = 'child-1' WHERE id = ?`,
    ).run(call.id);

    expect(recoverInterruptedRuns(db)).toEqual(["child-1"]);
    expect(getRunRequired(db, run.id).status).toBe("queued");
    expect(getCall(db, run.id, 0)).toMatchObject({
      status: "cancelled",
      error: "Plugin restarted",
    });
  });

  it("persists JSON null but requires it to rerun instead of replaying", () => {
    const first = newRun();
    markRunning(first.id);
    const original = startCall(db, {
      runId: first.id,
      callIndex: 0,
      cacheKey: "null-cache",
      prompt: "return null",
      options: {
        selection: null,
        outputSchema: null,
        title: null,
        phase: null,
      },
      selection: resolvedSelection,
      replay: null,
    });
    settleCall(db, {
      id: original.id,
      status: "succeeded",
      result: null,
      error: null,
    });
    expect(getCall(db, first.id, 0)?.resultJson).toBe("null");
    const second = createRun(db, {
      projectId: "project-1",
      originThreadId: "thread-1",
      environmentId: "environment-1",
      originProvider: "codex",
      originModel: "gpt-test",
      originReasoningLevel: "medium",
      originPermissionMode: "full",
      name: "test-workflow",
      source: "return null",
      sourceHash: "hash-2",
      argsJson: "null",
      settingsJson:
        '{"maxActiveRuns":4,"maxConcurrentAgents":8,"maxAgentCalls":100,"totalRunTimeoutMs":86400000,"retentionDays":30,"maxNotificationBytes":16384}',
      resumedFromRunId: first.id,
    });
    markRunning(second.id);
    startCall(db, {
      runId: second.id,
      callIndex: 0,
      cacheKey: "null-cache",
      prompt: "return null",
      options: {
        selection: null,
        outputSchema: null,
        title: null,
        phase: null,
      },
      selection: resolvedSelection,
      replay: null,
    });

    expect(getCall(db, second.id, 0)).toMatchObject({
      status: "queued",
      resultJson: null,
      replayedFromCallId: null,
    });
  });

  it("atomically preserves the first structured value", () => {
    const run = newRun();
    markRunning(run.id);
    const call = startCall(db, {
      runId: run.id,
      callIndex: 0,
      cacheKey: "structured",
      prompt: "answer",
      options: {
        selection: null,
        outputSchema: { type: "object" },
        title: null,
        phase: null,
      },
      selection: resolvedSelection,
      replay: null,
    });
    expect(attachCallThread(db, call.id, "child-structured")).toBe(true);

    expect(storeStructuredResult(db, call.id, { a: 1, b: 2 })).toBe("accepted");
    expect(storeStructuredResult(db, call.id, { b: 2, a: 1 })).toBe(
      "idempotent",
    );
    expect(storeStructuredResult(db, call.id, { a: 2, b: 1 })).toBe("conflict");
    expect(getCall(db, run.id, 0)?.resultJson).toBe('{"a":1,"b":2}');

    settleCall(db, {
      id: call.id,
      status: "succeeded",
      result: { a: 99 },
      error: null,
    });
    expect(storeStructuredResult(db, call.id, { b: 2, a: 1 })).toBe(
      "idempotent",
    );
    expect(storeStructuredResult(db, call.id, { a: 99 })).toBe("conflict");
  });

  it("uses one guarded repair counter and preserves accepted results on restart", () => {
    const run = newRun();
    markRunning(run.id);
    const call = startCall(db, {
      runId: run.id,
      callIndex: 0,
      cacheKey: "repair",
      prompt: "answer",
      options: {
        selection: null,
        outputSchema: { type: "number" },
        title: null,
        phase: null,
      },
      selection: resolvedSelection,
      replay: null,
    });
    attachCallThread(db, call.id, "child-repair");

    expect(incrementRepairAttempts(db, call.id)).toBe(1);
    expect(incrementRepairAttempts(db, call.id)).toBe(2);
    expect(storeStructuredResult(db, call.id, null)).toBe("accepted");
    expect(incrementRepairAttempts(db, call.id)).toBeNull();

    expect(recoverInterruptedRuns(db)).toEqual(["child-repair"]);
    expect(getRunRequired(db, run.id).status).toBe("queued");
    expect(getCall(db, run.id, 0)).toMatchObject({
      status: "succeeded",
      repairAttempts: 2,
      resultJson: "null",
      error: null,
    });
  });

  it("persists a successful run result of JSON null and keeps terminal transitions idempotent", () => {
    const run = newRun();
    expect(cancelRun(db, run.id)).toBe(true);
    expect(cancelRun(db, run.id)).toBe(false);
    expect(
      settleRun(db, {
        id: run.id,
        status: "succeeded",
        result: "too late",
        error: null,
      }),
    ).toEqual([]);
    expect(getRunRequired(db, run.id)).toMatchObject({
      status: "cancelled",
      resultJson: null,
    });

    const successful = newRun();
    markRunning(successful.id);
    settleRun(db, {
      id: successful.id,
      status: "succeeded",
      result: null,
      error: null,
    });
    expect(getRunRequired(db, successful.id)).toMatchObject({
      status: "succeeded",
      resultJson: "null",
    });
  });

  it("atomically cancels outstanding calls when a parent settles", () => {
    const run = newRun();
    markRunning(run.id);
    const call = startCall(db, {
      runId: run.id,
      callIndex: 0,
      cacheKey: "fire-and-forget",
      prompt: "slow",
      options: {
        selection: null,
        outputSchema: null,
        title: null,
        phase: null,
      },
      selection: resolvedSelection,
      replay: null,
    });
    db.prepare(
      `UPDATE workflow_calls SET status = 'running', child_thread_id = 'orphan' WHERE id = ?`,
    ).run(call.id);

    expect(
      settleRun(db, {
        id: run.id,
        status: "succeeded",
        result: "done",
        error: null,
      }),
    ).toMatchObject([{ id: call.id, childThreadId: "orphan" }]);
    expect(getRunRequired(db, run.id).status).toBe("succeeded");
    expect(getCall(db, run.id, 0)).toMatchObject({
      status: "cancelled",
      error: "Parent workflow finished before this call",
    });
  });

  it("allows call creation and attachment only while the parent is running", () => {
    const statuses = [
      "queued",
      "running",
      "succeeded",
      "failed",
      "cancelled",
    ] as const;

    for (const status of statuses) {
      const creationRun = newRun();
      db.prepare(`UPDATE workflow_runs SET status = ? WHERE id = ?`).run(
        status,
        creationRun.id,
      );
      const create = () =>
        startCall(db, {
          runId: creationRun.id,
          callIndex: 0,
          cacheKey: `creation-${status}`,
          prompt: "state matrix",
          options: {
            selection: null,
            outputSchema: null,
            title: null,
            phase: null,
          },
          selection: resolvedSelection,
          replay: null,
        });
      if (status === "running") {
        expect(create).not.toThrow();
        expect(getCall(db, creationRun.id, 0)).toMatchObject({
          status: "queued",
        });
      } else {
        expect(create).toThrow("is not running");
        expect(getCall(db, creationRun.id, 0)).toBeNull();
      }

      const attachmentRun = newRun();
      markRunning(attachmentRun.id);
      const call = startCall(db, {
        runId: attachmentRun.id,
        callIndex: 0,
        cacheKey: `attachment-${status}`,
        prompt: "state matrix",
        options: {
          selection: null,
          outputSchema: null,
          title: null,
          phase: null,
        },
        selection: resolvedSelection,
        replay: null,
      });
      db.prepare(`UPDATE workflow_runs SET status = ? WHERE id = ?`).run(
        status,
        attachmentRun.id,
      );
      expect(attachCallThread(db, call.id, `matrix-child-${status}`)).toBe(
        status === "running",
      );
      expect(getCall(db, attachmentRun.id, 0)).toMatchObject({
        status: status === "running" ? "running" : "queued",
        childThreadId: status === "running" ? `matrix-child-${status}` : null,
      });
    }
  });

  it("retains active resume ancestry while deleting unrelated expired runs", () => {
    const parent = newRun();
    db.prepare(
      `UPDATE workflow_runs SET status = 'succeeded', notification_sent = 1,
       finished_at = ?, settings_json = json_set(settings_json, '$.retentionDays', 1)
       WHERE id = ?`,
    ).run(Date.now() - 3 * 86_400_000, parent.id);
    const retainedChild = createRun(db, {
      projectId: "project-1",
      originThreadId: "thread-1",
      environmentId: "environment-1",
      originProvider: "codex",
      originModel: "gpt-test",
      originReasoningLevel: "medium",
      originPermissionMode: "full",
      name: "retained-child",
      source: "return null",
      sourceHash: "child-hash",
      argsJson: "null",
      settingsJson:
        '{"maxActiveRuns":4,"maxConcurrentAgents":8,"maxAgentCalls":100,"totalRunTimeoutMs":86400000,"retentionDays":1,"maxNotificationBytes":16384}',
      resumedFromRunId: parent.id,
    });
    const expired = newRun();
    db.prepare(
      `UPDATE workflow_runs SET status = 'failed', notification_sent = 1,
       finished_at = ?, settings_json = json_set(settings_json, '$.retentionDays', 1)
       WHERE id = ?`,
    ).run(Date.now() - 3 * 86_400_000, expired.id);

    expect(sweepExpired(Date.now(), 100)).toBe(1);
    expect(getRunRequired(db, parent.id).id).toBe(parent.id);
    expect(getRunRequired(db, parent.id).replayBarrierIndex).toBeNull();
    expect(getRunRequired(db, retainedChild.id).status).toBe("queued");
    expect(() => getRunRequired(db, expired.id)).toThrow(
      "Unknown workflow run",
    );
  });

  it("deletes an entirely expired resume chain in one bounded sweep", () => {
    const parent = newRun();
    const child = createRun(db, {
      projectId: "project-1",
      originThreadId: "thread-1",
      environmentId: "environment-1",
      originProvider: "codex",
      originModel: "gpt-test",
      originReasoningLevel: "medium",
      originPermissionMode: "full",
      name: "expired-child",
      source: "return null",
      sourceHash: "expired-child-hash",
      argsJson: "null",
      settingsJson:
        '{"maxActiveRuns":4,"maxConcurrentAgents":8,"maxAgentCalls":100,"totalRunTimeoutMs":86400000,"retentionDays":1,"maxNotificationBytes":16384}',
      resumedFromRunId: parent.id,
    });
    db.prepare(
      `UPDATE workflow_runs SET status = 'succeeded', notification_sent = 1,
       finished_at = ?, settings_json = json_set(settings_json, '$.retentionDays', 1)
       WHERE id IN (?, ?)`,
    ).run(Date.now() - 3 * 86_400_000, parent.id, child.id);

    expect(sweepExpired(Date.now(), 100)).toBe(2);
    expect(() => getRunRequired(db, parent.id)).toThrow("Unknown workflow run");
    expect(() => getRunRequired(db, child.id)).toThrow("Unknown workflow run");
  });
});
