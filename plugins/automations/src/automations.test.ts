import {
  access,
  mkdtemp,
  mkdir,
  readFile,
  readdir,
  rm,
  writeFile,
} from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import Database from "better-sqlite3";
import type { PluginCliRegistration } from "@get-bb/plugin-sdk";
import { describe, expect, it } from "vitest";
import {
  claimAutomationScheduledRun,
  closeAutomationRun,
  createAutomation,
  createManualRun,
  decodeAutomationRow,
  getAutomation,
  getRunningAutomationRun,
  listAutomationsForProject,
  listDueAutomations,
  listAutomationRuns,
  migrations,
  setAutomationEnabled,
  setAutomationRunThread,
  AUTOMATION_RETRY_BASE_MS,
  type Db,
} from "./data.js";
import { ingestLegacyImport } from "./legacy-import.js";
import {
  computeInitialNextRunAt,
  computeNextScheduledTime,
  validateOnceDefinition,
} from "./schedule-helpers.js";
import {
  bbBinaryCandidates,
  executeStoredScript,
  isWakeAgentSuppressed,
  mapScriptResultToRun,
  scriptPathEnv,
} from "./script-runner.js";
import { reconcileRunningAutomationRuns } from "./run.js";
import { sweepDueAutomations } from "./sweep.js";
import { createAutomationService } from "./service.js";
import { registerAutomationCli } from "./cli.js";
import { automationScriptDir } from "./script-files.js";

function createTestDb(): Db {
  const db = new Database(":memory:");
  for (const migration of migrations) db.exec(migration);
  return db;
}

function createScheduledAutomation(
  db: Db,
  nextRunAt: number,
  id = "auto_test",
) {
  return createAutomation(db, {
    id,
    projectId: "proj_test",
    name: "Test",
    enabled: true,
    trigger: {
      triggerType: "schedule",
      cron: "* * * * *",
      timezone: "UTC",
    },
    runMode: "agent",
    execution: {
      mode: "agent",
      prompt: "do it",
      providerId: "codex",
      model: "gpt-5",
      reasoningLevel: "medium",
      permissionMode: "accept-edits",
      environment: { type: "project-default" },
    },
    origin: "human",
    createdByThreadId: null,
    nextRunAt,
  });
}

function createOnceAutomation(db: Db, nextRunAt: number, id = "auto_once") {
  return createAutomation(db, {
    id,
    projectId: "proj_test",
    name: "Once",
    enabled: true,
    trigger: {
      triggerType: "once",
      runAt: nextRunAt,
    },
    runMode: "agent",
    execution: {
      mode: "agent",
      prompt: "do it once",
      providerId: "codex",
      model: "gpt-5",
      reasoningLevel: "medium",
      permissionMode: "accept-edits",
      environment: { type: "project-default" },
    },
    origin: "human",
    createdByThreadId: null,
    nextRunAt,
  });
}

function oneShotTrigger() {
  return { triggerType: "once" as const, runAt: Date.now() + 60_000 };
}

function legacyAutomationRow(
  overrides: {
    execution?: string;
    runMode?: "agent" | "script";
    targetThreadId?: string | null;
    triggerType?: "schedule" | "once";
  } = {},
) {
  return {
    id: "auto_legacy",
    projectId: "proj_test",
    targetThreadId: null,
    name: "Legacy",
    enabled: true,
    triggerType: "schedule" as const,
    triggerConfig: JSON.stringify({
      triggerType: "schedule",
      cron: "* * * * *",
      timezone: "UTC",
    }),
    runMode: "agent" as const,
    execution: JSON.stringify({
      mode: "agent",
      prompt: "legacy",
      providerId: "codex",
      model: "gpt-5",
      permissionMode: "readonly",
    }),
    environment: JSON.stringify({ type: "project-default" }),
    autoArchive: false,
    origin: "human" as const,
    createdByThreadId: null,
    nextRunAt: 1000,
    lastRunAt: null,
    runCount: 1,
    lastRunStatus: "succeeded" as const,
    lastRunThreadId: "thr_legacy",
    lastError: null,
    createdAt: 1,
    updatedAt: 2,
    ...overrides,
  };
}

function createAutomationServiceBb() {
  return {
    sdk: {
      projects: {
        get: async ({ projectId }: { projectId: string }) => ({
          id: projectId,
          kind: "standard" as const,
          name: "Test Project",
          gitRemoteUrl: null,
          createdAt: 1,
          updatedAt: 1,
          sources: [],
        }),
        list: async () => [],
      },
      providers: {
        list: async () =>
          [
            {
              id: "codex",
              capabilities: {
                permissionModes: ["accept-edits", "auto", "full"],
              },
            },
          ] as never,
      },
      threads: {
        get: async () => {
          throw new Error("not expected");
        },
        send: async () => {
          throw new Error("not expected");
        },
        spawn: async () => {
          throw new Error("not expected");
        },
      },
    },
    realtime: { publish: () => undefined },
    log: {
      debug: () => undefined,
      error: () => undefined,
      info: () => undefined,
      warn: () => undefined,
    },
  };
}

describe("data migrations", () => {
  it("migrates stored agent automations to current permission modes", () => {
    const db = createTestDb();
    const insert = db.prepare(
      `INSERT INTO automations (
         id, project_id, name, enabled, trigger_type, trigger_config,
         run_mode, execution, origin, created_at, updated_at
       ) VALUES (?, 'proj_test', ?, 1, 'schedule', ?, 'agent', ?, 'human', 1, 1)`,
    );
    const trigger = JSON.stringify({
      triggerType: "schedule",
      cron: "* * * * *",
      timezone: "UTC",
    });
    for (const mode of ["workspace-write", "readonly"]) {
      insert.run(
        `auto_${mode}`,
        mode,
        trigger,
        JSON.stringify({
          mode: "agent",
          prompt: "legacy",
          providerId: "codex",
          model: "gpt-5",
          permissionMode: mode,
          environment: { type: "project-default" },
        }),
      );
    }

    db.exec(migrations[1] ?? "");

    const modes = db
      .prepare<[], { permissionMode: string }>(
        `SELECT json_extract(execution, '$.permissionMode') AS permissionMode
         FROM automations ORDER BY id`,
      )
      .all()
      .map((row) => row.permissionMode);
    expect(modes).toEqual(["accept-edits", "accept-edits"]);
  });

  it("settles older duplicate running rows so single-flight can be introduced on history", () => {
    const db = new Database(":memory:");
    db.exec(migrations[0] ?? "");
    db.prepare(
      `INSERT INTO automations (
         id, project_id, name, trigger_type, trigger_config, run_mode,
         execution, origin, created_at, updated_at
       ) VALUES (
         'auto_once', 'proj_test', 'Once', 'once', '{}', 'agent', '{}',
         'human', 1, 1
       )`,
    ).run();
    const insertRun = db.prepare(
      `INSERT INTO automation_runs (
         id, automation_id, run_mode, status, trigger, scheduled_for, started_at
       ) VALUES (?, 'auto_once', 'agent', 'running', 'manual', 1000, ?)`,
    );
    insertRun.run("run_first", 1000);
    insertRun.run("run_second", 1001);
    insertRun.run("run_third", 1001);

    db.transaction(() => {
      db.exec(migrations[1] ?? "");
      db.exec(migrations[2] ?? "");
    })();

    const rows = db
      .prepare(
        `SELECT id, status, skip_reason AS skipReason, finished_at AS finishedAt
           FROM automation_runs ORDER BY id`,
      )
      .all() as Array<{
      id: string;
      status: string;
      skipReason: string | null;
      finishedAt: number | null;
    }>;
    expect(rows.map((row) => [row.id, row.status])).toEqual([
      ["run_first", "skipped"],
      ["run_second", "skipped"],
      ["run_third", "running"],
    ]);
    expect(rows[0]!.skipReason).toMatch(/single-flight/);
    expect(rows[0]!.finishedAt).not.toBeNull();
    expect(() => insertRun.run("run_fourth", 2000)).toThrow(/UNIQUE/);
  });
});

describe("startup reconciliation", () => {
  function reconcileBb(threads: {
    get: (args: { threadId: string }) => Promise<unknown>;
  }) {
    const published: unknown[] = [];
    return {
      bb: {
        sdk: {
          threads: {
            get: threads.get,
            send: async () => {
              throw new Error("not expected");
            },
            spawn: async () => {
              throw new Error("not expected");
            },
          },
        },
        realtime: {
          publish: (...args: unknown[]) => void published.push(args),
        },
        log: {
          debug: () => undefined,
          error: () => undefined,
          info: () => undefined,
          warn: () => undefined,
        },
      },
      published,
    };
  }

  function thread(
    threadId: string,
    status: "idle" | "active" | "starting" | "stopping" | "error",
    extra: { deletedAt?: number | null; archivedAt?: number | null } = {},
  ) {
    return {
      id: threadId,
      status,
      deletedAt: extra.deletedAt ?? null,
      archivedAt: extra.archivedAt ?? null,
    };
  }

  it("settles ghost script runs and threadless agent runs as interrupted", async () => {
    const db = createTestDb();
    const script = createScheduledAutomation(db, 0, "auto_script");
    const agent = createScheduledAutomation(db, 0, "auto_agent");
    const scriptRun = createManualRun(db, {
      automationId: script.id,
      runMode: "script",
      now: 1000,
    }).run;
    const agentRun = createManualRun(db, {
      automationId: agent.id,
      runMode: "agent",
      now: 1000,
    }).run;
    const { bb, published } = reconcileBb({
      get: async () => {
        throw new Error("no thread should be asked about");
      },
    });
    await reconcileRunningAutomationRuns(bb, db);
    for (const run of [scriptRun, agentRun]) {
      const settled = listAutomationRuns(db, {
        automationId: run.automationId,
        limit: 10,
      })[0]!;
      expect(settled.status).toBe("skipped");
      expect(settled.skipReason).toMatch(/interrupted/);
      expect(settled.finishedAt).not.toBeNull();
      expect(getRunningAutomationRun(db, run.automationId)).toBeNull();
    }
    expect(published.length).toBeGreaterThan(0);
  });

  it("settles agent runs by their thread's state and leaves live threads alone", async () => {
    const db = createTestDb();
    const cases = [
      {
        id: "auto_idle",
        thread: thread("thr_idle", "idle"),
        status: "succeeded",
      },
      {
        id: "auto_error",
        thread: thread("thr_error", "error"),
        status: "failed",
      },
      {
        id: "auto_active",
        thread: thread("thr_active", "active"),
        status: "running",
      },
      {
        id: "auto_starting",
        thread: thread("thr_starting", "starting"),
        status: "running",
      },
      {
        id: "auto_archived",
        thread: thread("thr_archived", "idle", { archivedAt: 5 }),
        status: "skipped",
      },
      { id: "auto_gone", thread: null, status: "skipped" },
      { id: "auto_unreachable", thread: "boom", status: "running" },
    ] as const;
    const threads = new Map<string, unknown>();
    for (const testCase of cases) {
      const automation = createScheduledAutomation(db, 0, testCase.id);
      const run = createManualRun(db, {
        automationId: automation.id,
        runMode: "agent",
        now: 1000,
      }).run;
      const threadId = `thr_${testCase.id.slice("auto_".length)}`;
      setAutomationRunThread(db, { runId: run.id, threadId });
      threads.set(threadId, testCase.thread);
    }
    const { bb } = reconcileBb({
      get: async ({ threadId }) => {
        const value = threads.get(threadId);
        if (value === null) {
          throw Object.assign(new Error("not found"), { status: 404 });
        }
        if (value === "boom") throw new Error("connection refused");
        return value;
      },
    });
    await reconcileRunningAutomationRuns(bb, db);
    for (const testCase of cases) {
      const run = listAutomationRuns(db, {
        automationId: testCase.id,
        limit: 10,
      })[0]!;
      expect([testCase.id, run.status]).toEqual([testCase.id, testCase.status]);
    }
    expect(getAutomation(db, "auto_error")!.consecutiveFailures).toBe(1);
    expect(getAutomation(db, "auto_gone")!.consecutiveFailures).toBe(0);
  });
});

describe("schedule helpers", () => {
  it("computes cron next runs with timezone", () => {
    const next = computeNextScheduledTime({
      cron: "30 9 * * *",
      timezone: "America/New_York",
      now: Date.parse("2026-01-01T13:00:00.000Z"),
    });
    expect(new Date(next).toISOString()).toBe("2026-01-01T14:30:00.000Z");
  });

  it("validates and computes once triggers", () => {
    const now = Date.parse("2026-01-01T00:00:00.000Z");
    expect(() => validateOnceDefinition({ runAt: now, now })).toThrow(
      "One-shot run time must be in the future",
    );
    expect(
      computeInitialNextRunAt({
        trigger: { triggerType: "once", runAt: now + 1_000 },
        enabled: true,
        now,
      }),
    ).toBe(now + 1_000);
    expect(
      computeInitialNextRunAt({
        trigger: { triggerType: "once", runAt: now + 1_000 },
        enabled: false,
        now,
      }),
    ).toBeNull();
  });
});

describe("automation data access", () => {
  it("CAS claims a scheduled run only once", () => {
    const db = createTestDb();
    createScheduledAutomation(db, 1000);
    const first = claimAutomationScheduledRun(db, {
      automationId: "auto_test",
      expectedNextRunAt: 1000,
      newNextRunAt: 2000,
      now: 1000,
    });
    const second = claimAutomationScheduledRun(db, {
      automationId: "auto_test",
      expectedNextRunAt: 1000,
      newNextRunAt: 2000,
      now: 1000,
    });
    expect(first.advanced).toBe(true);
    expect(second.advanced).toBe(false);
    expect(
      listAutomationRuns(db, { automationId: "auto_test", limit: 10 }),
    ).toHaveLength(1);
  });

  it("backs off a scheduled automation after dispatch failure", () => {
    const db = createTestDb();
    const automation = createScheduledAutomation(db, 1000);
    const claim = claimAutomationScheduledRun(db, {
      automationId: automation.id,
      expectedNextRunAt: 1000,
      newNextRunAt: 2000,
      now: 1000,
    });
    if (!claim.advanced) throw new Error("claim failed");
    closeAutomationRun(db, {
      runId: claim.run.id,
      status: "failed",
      error: "dispatch failed",
      now: 1001,
    });
    const restored = getAutomation(db, automation.id);
    expect(restored?.nextRunAt).toBe(1001 + AUTOMATION_RETRY_BASE_MS);
    expect(restored?.runCount).toBe(1);
    expect(restored?.consecutiveFailures).toBe(1);
    expect(restored?.lastRunStatus).toBe("failed");
  });

  it("settles a running automation exactly once", () => {
    const db = createTestDb();
    const automation = createScheduledAutomation(db, 1000);
    const claim = claimAutomationScheduledRun(db, {
      automationId: automation.id,
      expectedNextRunAt: 1000,
      newNextRunAt: 2000,
      now: 1000,
    });
    if (!claim.advanced) throw new Error("claim failed");

    const first = closeAutomationRun(db, {
      runId: claim.run.id,
      status: "failed",
      error: "first failure",
      now: 1001,
    });
    const duplicate = closeAutomationRun(db, {
      runId: claim.run.id,
      status: "failed",
      error: "duplicate failure",
      now: 1002,
    });

    expect(first?.run.status).toBe("failed");
    expect(duplicate).toBeNull();
    expect(getAutomation(db, automation.id)?.consecutiveFailures).toBe(1);
    expect(getAutomation(db, automation.id)?.nextRunAt).toBe(
      1001 + AUTOMATION_RETRY_BASE_MS,
    );
    expect(first?.run.error).toBe("first failure");
  });

  it("does not re-enable a manually paused automation after failure", () => {
    const db = createTestDb();
    const automation = createScheduledAutomation(db, 1000);
    const claim = claimAutomationScheduledRun(db, {
      automationId: automation.id,
      expectedNextRunAt: 1000,
      newNextRunAt: 2000,
      now: 1000,
    });
    if (!claim.advanced) throw new Error("claim failed");
    setAutomationEnabled(db, {
      projectId: automation.projectId,
      automationId: automation.id,
      enabled: false,
      nextRunAt: null,
    });

    closeAutomationRun(db, {
      runId: claim.run.id,
      status: "failed",
      error: "failed after pause",
      now: 1001,
    });

    expect(getAutomation(db, automation.id)?.enabled).toBe(false);
    expect(getAutomation(db, automation.id)?.nextRunAt).toBeNull();
  });

  it("auto-pauses after three consecutive scheduled failures", () => {
    const db = createTestDb();
    const automation = createScheduledAutomation(db, 1000);
    let expectedNextRunAt = 1000;

    for (let failure = 1; failure <= 3; failure += 1) {
      const advancedNextRunAt = expectedNextRunAt + 60_000;
      const claim = claimAutomationScheduledRun(db, {
        automationId: automation.id,
        expectedNextRunAt,
        newNextRunAt: advancedNextRunAt,
        now: expectedNextRunAt,
      });
      if (!claim.advanced) throw new Error(`claim ${failure} failed`);
      const failedAt = expectedNextRunAt + 1;
      closeAutomationRun(db, {
        runId: claim.run.id,
        status: "failed",
        error: `dispatch failed ${failure}`,
        now: failedAt,
      });
      const current = getAutomation(db, automation.id);
      expect(current?.consecutiveFailures).toBe(failure);
      if (failure < 3) {
        expectedNextRunAt =
          failedAt + AUTOMATION_RETRY_BASE_MS * 2 ** (failure - 1);
        expect(current?.enabled).toBe(true);
        expect(current?.nextRunAt).toBe(expectedNextRunAt);
      } else {
        expect(current?.enabled).toBe(false);
        expect(current?.nextRunAt).toBeNull();
        expect(current?.lastError).toContain(
          "paused after 3 consecutive failures",
        );
      }
    }
  });

  it("applies the same backoff and pause policy to settled script failures", () => {
    const db = createTestDb();
    const automation = createScheduledAutomation(db, 1000);
    let expectedNextRunAt = 1000;

    for (let failure = 1; failure <= 3; failure += 1) {
      const claim = claimAutomationScheduledRun(db, {
        automationId: automation.id,
        expectedNextRunAt,
        newNextRunAt: expectedNextRunAt + 60_000,
        now: expectedNextRunAt,
      });
      if (!claim.advanced) throw new Error(`claim ${failure} failed`);
      const failedAt = expectedNextRunAt + 1;
      closeAutomationRun(db, {
        runId: claim.run.id,
        status: "failed",
        error: `script failed ${failure}`,
        now: failedAt,
      });
      const current = getAutomation(db, automation.id);
      expect(current?.consecutiveFailures).toBe(failure);
      if (failure < 3) {
        expectedNextRunAt =
          failedAt + AUTOMATION_RETRY_BASE_MS * 2 ** (failure - 1);
        expect(current?.nextRunAt).toBe(expectedNextRunAt);
      } else {
        expect(current?.enabled).toBe(false);
        expect(current?.nextRunAt).toBeNull();
      }
    }
  });

  it("enforces one running execution per automation", () => {
    const db = createTestDb();
    const automation = createScheduledAutomation(db, 1000);
    const first = claimAutomationScheduledRun(db, {
      automationId: automation.id,
      expectedNextRunAt: 1000,
      newNextRunAt: 2000,
      now: 1000,
    });
    if (!first.advanced) throw new Error("first claim failed");

    const overlapping = claimAutomationScheduledRun(db, {
      automationId: automation.id,
      expectedNextRunAt: 2000,
      newNextRunAt: 3000,
      now: 2000,
    });
    const manual = createManualRun(db, {
      automationId: automation.id,
      runMode: "agent",
      now: 2000,
    });

    expect(overlapping.advanced).toBe(false);
    expect(manual.deduped).toBe(true);
    expect(manual.run.id).toBe(first.run.id);
    expect(getRunningAutomationRun(db, automation.id)?.id).toBe(first.run.id);
  });

  it("enforces single-flight at the database boundary", () => {
    const db = createTestDb();
    const automation = createScheduledAutomation(db, 1000);
    createManualRun(db, {
      automationId: automation.id,
      runMode: "agent",
      now: 1000,
    });

    expect(() =>
      db
        .prepare(
          `INSERT INTO automation_runs (
             id, automation_id, run_mode, status, trigger,
             scheduled_for, started_at
           ) VALUES (
             'run_overlap', ?, 'agent', 'running', 'manual', 1001, 1001
           )`,
        )
        .run(automation.id),
    ).toThrow();
  });

  it("resets consecutive failures after a successful run", () => {
    const db = createTestDb();
    const automation = createScheduledAutomation(db, 1000);
    const first = claimAutomationScheduledRun(db, {
      automationId: automation.id,
      expectedNextRunAt: 1000,
      newNextRunAt: 2000,
      now: 1000,
    });
    if (!first.advanced) throw new Error("first claim failed");
    closeAutomationRun(db, {
      runId: first.run.id,
      status: "failed",
      error: "dispatch failed",
      now: 1001,
    });
    const retryAt = getAutomation(db, automation.id)?.nextRunAt;
    if (retryAt === null || retryAt === undefined) {
      throw new Error("retry was not scheduled");
    }
    const retry = claimAutomationScheduledRun(db, {
      automationId: automation.id,
      expectedNextRunAt: retryAt,
      newNextRunAt: retryAt + 60_000,
      now: retryAt,
    });
    if (!retry.advanced) throw new Error("retry claim failed");
    closeAutomationRun(db, {
      runId: retry.run.id,
      status: "succeeded",
      now: retryAt + 1,
    });

    expect(getAutomation(db, automation.id)?.consecutiveFailures).toBe(0);
  });

  it("resets consecutive failures when a scheduled tick is skipped", () => {
    const db = createTestDb();
    const automation = createScheduledAutomation(db, 1000);
    const failed = claimAutomationScheduledRun(db, {
      automationId: automation.id,
      expectedNextRunAt: 1000,
      newNextRunAt: 2000,
      now: 1000,
    });
    if (!failed.advanced) throw new Error("claim failed");
    closeAutomationRun(db, {
      runId: failed.run.id,
      status: "failed",
      error: "transient failure",
      now: 1001,
    });
    const retryAt = getAutomation(db, automation.id)?.nextRunAt;
    if (retryAt === null || retryAt === undefined) {
      throw new Error("retry was not scheduled");
    }

    const skipped = claimAutomationScheduledRun(db, {
      automationId: automation.id,
      expectedNextRunAt: retryAt,
      newNextRunAt: retryAt + 60_000,
      skipReason: "nothing to do",
      now: retryAt,
    });

    expect(skipped.advanced).toBe(true);
    expect(skipped.advanced && skipped.run.status).toBe("skipped");
    expect(getAutomation(db, automation.id)?.consecutiveFailures).toBe(0);
    expect(getAutomation(db, automation.id)?.lastError).toBeNull();
  });

  it("does not re-arm one-shot automations after dispatch failure", () => {
    const db = createTestDb();
    const automation = createOnceAutomation(db, 1000);
    const claim = claimAutomationScheduledRun(db, {
      automationId: automation.id,
      expectedNextRunAt: 1000,
      newNextRunAt: null,
      now: 1000,
    });
    if (!claim.advanced) throw new Error("claim failed");
    closeAutomationRun(db, {
      runId: claim.run.id,
      status: "failed",
      error: "dispatch failed",
      now: 1001,
    });
    const restored = getAutomation(db, automation.id);
    expect(restored?.enabled).toBe(false);
    expect(restored?.nextRunAt).toBeNull();
    expect(restored?.runCount).toBe(1);
    expect(restored?.consecutiveFailures).toBe(1);
    expect(restored?.lastRunStatus).toBe("failed");
  });

  it("does not claim due agent automations when no host is connected", async () => {
    const db = createTestDb();
    const automation = createScheduledAutomation(db, 1000);
    const bb = {
      sdk: {
        hosts: {
          list: async () => [
            {
              id: "host_test",
              name: "host",
              type: "persistent",
              status: "disconnected",
              lastSeenAt: null,
              createdAt: 1,
              updatedAt: 1,
            },
          ],
        },
        threads: {
          get: async () => {
            throw new Error("not expected");
          },
          send: async () => {
            throw new Error("not expected");
          },
          spawn: async () => {
            throw new Error("not expected");
          },
        },
      },
      realtime: { publish: () => undefined },
      log: {
        debug: () => undefined,
        error: () => undefined,
        info: () => undefined,
        warn: () => undefined,
      },
    };

    await sweepDueAutomations(bb, db, {
      pluginDataDir: "/tmp",
      serverUrl: "http://127.0.0.1:38886",
      now: 1000,
    });

    expect(getAutomation(db, automation.id)?.runCount).toBe(0);
    expect(
      listAutomationRuns(db, { automationId: automation.id, limit: 10 }),
    ).toHaveLength(0);
  });

  it("does not repeatedly select degraded agent executions for sweeping", () => {
    const db = createTestDb();
    const emptyPrompt = createScheduledAutomation(db, 1000, "auto_empty");
    const invalidJson = createScheduledAutomation(db, 1000, "auto_invalid");
    const healthy = createScheduledAutomation(db, 1000, "auto_healthy");
    db.prepare("UPDATE automations SET execution = ? WHERE id = ?").run(
      JSON.stringify({
        mode: "agent",
        prompt: "",
        providerId: "codex",
        model: "gpt-5",
        reasoningLevel: "medium",
        permissionMode: "accept-edits",
        environment: { type: "project-default" },
      }),
      emptyPrompt.id,
    );
    db.prepare("UPDATE automations SET execution = ? WHERE id = ?").run(
      "not json",
      invalidJson.id,
    );

    expect(
      listDueAutomations(db, { now: 1000, limit: 100 }).map(
        (automation) => automation.id,
      ),
    ).toEqual([healthy.id]);
    expect(getAutomation(db, emptyPrompt.id)).toMatchObject({
      enabled: true,
      nextRunAt: 1000,
    });
    expect(getAutomation(db, invalidJson.id)).toMatchObject({
      enabled: true,
      nextRunAt: 1000,
    });
  });

  it("finds healthy due work after a full batch of malformed rows", () => {
    const db = createTestDb();
    const updateExecution = db.prepare(
      "UPDATE automations SET execution = ?, created_at = 1 WHERE id = ?",
    );
    for (let index = 0; index < 100; index += 1) {
      const id = `auto_invalid_${index.toString().padStart(3, "0")}`;
      createScheduledAutomation(db, 1000, id);
      updateExecution.run(
        JSON.stringify({ mode: "agent", prompt: "incomplete" }),
        id,
      );
    }
    const healthy = createScheduledAutomation(db, 1000, "auto_healthy");
    db.prepare("UPDATE automations SET created_at = 2 WHERE id = ?").run(
      healthy.id,
    );

    expect(
      listDueAutomations(db, { now: 1000, limit: 100 }).map(
        (automation) => automation.id,
      ),
    ).toEqual([healthy.id]);
  });

  it("rejects denormalized fields that disagree with stored JSON", () => {
    const mismatches = [
      "UPDATE automations SET trigger_type = 'once' WHERE id = ?",
      "UPDATE automations SET run_mode = 'script' WHERE id = ?",
      "UPDATE automations SET target_thread_id = 'thr_other' WHERE id = ?",
    ];

    for (const mismatch of mismatches) {
      const db = createTestDb();
      const automation = createScheduledAutomation(db, 1000);
      db.prepare(mismatch).run(automation.id);
      const row = getAutomation(db, automation.id);
      expect(row).not.toBeNull();
      if (row === null) throw new Error("Expected stored automation");

      expect(decodeAutomationRow(row).automation).toEqual({
        id: automation.id,
        projectId: automation.projectId,
        name: automation.name,
        problem: "invalid-stored-data",
      });
    }
  });

  it("dedupes manual runs by idempotency key", () => {
    const db = createTestDb();
    createScheduledAutomation(db, 1000);
    const first = createManualRun(db, {
      automationId: "auto_test",
      runMode: "agent",
      idempotencyKey: "same",
      now: 2000,
    });
    const second = createManualRun(db, {
      automationId: "auto_test",
      runMode: "agent",
      idempotencyKey: "same",
      now: 3000,
    });
    expect(first.deduped).toBe(false);
    expect(second.deduped).toBe(true);
    expect(second.run.id).toBe(first.run.id);
  });

  it("records skipped script close state", () => {
    const db = createTestDb();
    createScheduledAutomation(db, 1000);
    const run = createManualRun(db, {
      automationId: "auto_test",
      runMode: "script",
      now: 1000,
    }).run;
    closeAutomationRun(db, {
      runId: run.id,
      status: "skipped",
      skipReason: "empty output",
      exitCode: 0,
      now: 1001,
    });
    const [closed] = listAutomationRuns(db, {
      automationId: "auto_test",
      limit: 1,
    });
    expect(closed?.status).toBe("skipped");
    expect(closed?.skipReason).toBe("empty output");
  });
});

describe("automation service", () => {
  it("validates project availability before creating an automation", async () => {
    const db = createTestDb();
    const bb = {
      sdk: {
        projects: {
          get: async () => {
            throw new Error("Project not found");
          },
          list: async () => [],
        },
        providers: {
          list: async () => [],
        },
        threadSections: {
          list: async () => [],
        },
        threads: {
          get: async () => {
            throw new Error("not expected");
          },
          send: async () => {
            throw new Error("not expected");
          },
          spawn: async () => {
            throw new Error("not expected");
          },
        },
      },
      realtime: { publish: () => undefined },
      log: {
        debug: () => undefined,
        error: () => undefined,
        info: () => undefined,
        warn: () => undefined,
      },
    };
    const service = createAutomationService({
      bb,
      db,
      pluginDataDir: "/tmp",
      serverUrl: "http://127.0.0.1:38886",
    });

    await expect(
      service.create({
        projectId: "proj_missing",
        name: "Missing project",
        enabled: true,
        trigger: { triggerType: "once", runAt: Date.now() + 60_000 },
        execution: {
          mode: "agent",
          prompt: "hello",
          providerId: "codex",
          model: "gpt-5",
          reasoningLevel: "medium",
          permissionMode: "accept-edits",
          environment: { type: "project-default" },
        },
        origin: "human",
      }),
    ).rejects.toThrow("Project proj_missing is not available");
    expect(listAutomationsForProject(db, "proj_missing")).toHaveLength(0);
  });

  it("removes a stored script directory after switching to agent execution", async () => {
    const db = createTestDb();
    const pluginDataDir = await mkdtemp(join(tmpdir(), "bb-auto-service-"));
    const automation = createAutomation(db, {
      id: "auto_script_to_agent",
      projectId: "proj_test",
      name: "Script to agent",
      enabled: true,
      trigger: oneShotTrigger(),
      runMode: "script",
      execution: {
        mode: "script",
        scriptFile: "old.sh",
        timeoutMs: 120_000,
      },
      origin: "human",
      createdByThreadId: null,
      nextRunAt: Date.now() + 60_000,
    });
    const scriptDir = automationScriptDir(pluginDataDir, automation.id);
    await mkdir(scriptDir, { recursive: true });
    await writeFile(join(scriptDir, "old.sh"), "echo old\n");
    const service = createAutomationService({
      bb: createAutomationServiceBb(),
      db,
      pluginDataDir,
      serverUrl: "http://127.0.0.1:38886",
    });

    try {
      await service.update({
        projectId: "proj_test",
        automationId: automation.id,
        execution: {
          mode: "agent",
          prompt: "do it",
          providerId: "codex",
          model: "gpt-5",
          reasoningLevel: "medium",
          permissionMode: "accept-edits",
          environment: { type: "project-default" },
        },
      });

      await expect(access(scriptDir)).rejects.toThrow();
    } finally {
      await rm(pluginDataDir, { recursive: true, force: true });
    }
  });

  it("removes only a superseded stored script file after a filename change", async () => {
    const db = createTestDb();
    const pluginDataDir = await mkdtemp(join(tmpdir(), "bb-auto-service-"));
    const automation = createAutomation(db, {
      id: "auto_script_rename",
      projectId: "proj_test",
      name: "Script rename",
      enabled: true,
      trigger: oneShotTrigger(),
      runMode: "script",
      execution: {
        mode: "script",
        scriptFile: "old.sh",
        timeoutMs: 120_000,
      },
      origin: "human",
      createdByThreadId: null,
      nextRunAt: Date.now() + 60_000,
    });
    const scriptDir = automationScriptDir(pluginDataDir, automation.id);
    await mkdir(scriptDir, { recursive: true });
    await writeFile(join(scriptDir, "old.sh"), "echo old\n");
    await writeFile(join(scriptDir, "keep.txt"), "keep\n");
    const service = createAutomationService({
      bb: createAutomationServiceBb(),
      db,
      pluginDataDir,
      serverUrl: "http://127.0.0.1:38886",
    });

    try {
      await service.update({
        projectId: "proj_test",
        automationId: automation.id,
        execution: {
          mode: "script",
          script: "echo new\n",
          scriptFile: "new.sh",
          timeoutMs: 120_000,
        },
      });

      await expect(access(join(scriptDir, "old.sh"))).rejects.toThrow();
      await expect(readFile(join(scriptDir, "new.sh"), "utf8")).resolves.toBe(
        "echo new\n",
      );
      await expect(readFile(join(scriptDir, "keep.txt"), "utf8")).resolves.toBe(
        "keep\n",
      );
    } finally {
      await rm(pluginDataDir, { recursive: true, force: true });
    }
  });

  it("removes a newly staged filename when the database update fails", async () => {
    const db = createTestDb();
    const pluginDataDir = await mkdtemp(join(tmpdir(), "bb-auto-service-"));
    const automation = createAutomation(db, {
      id: "auto_script_rollback",
      projectId: "proj_test",
      name: "Script rollback",
      enabled: true,
      trigger: oneShotTrigger(),
      runMode: "script",
      execution: {
        mode: "script",
        scriptFile: "old.sh",
        timeoutMs: 120_000,
      },
      origin: "human",
      createdByThreadId: null,
      nextRunAt: Date.now() + 60_000,
    });
    const scriptDir = automationScriptDir(pluginDataDir, automation.id);
    await mkdir(scriptDir, { recursive: true });
    await writeFile(join(scriptDir, "old.sh"), "echo old\n");
    db.exec(`CREATE TRIGGER reject_automation_update
      BEFORE UPDATE ON automations
      BEGIN
        SELECT RAISE(ABORT, 'update rejected');
      END`);
    const service = createAutomationService({
      bb: createAutomationServiceBb(),
      db,
      pluginDataDir,
      serverUrl: "http://127.0.0.1:38886",
    });

    try {
      await expect(
        service.update({
          projectId: "proj_test",
          automationId: automation.id,
          execution: {
            mode: "script",
            script: "echo new\n",
            scriptFile: "new.sh",
            timeoutMs: 120_000,
          },
        }),
      ).rejects.toThrow("update rejected");
      await expect(readFile(join(scriptDir, "old.sh"), "utf8")).resolves.toBe(
        "echo old\n",
      );
      await expect(access(join(scriptDir, "new.sh"))).rejects.toThrow();
    } finally {
      await rm(pluginDataDir, { recursive: true, force: true });
    }
  });

  it("does not overwrite the active filename when the database update fails", async () => {
    const db = createTestDb();
    const pluginDataDir = await mkdtemp(join(tmpdir(), "bb-auto-service-"));
    const automation = createAutomation(db, {
      id: "auto_script_same_name_rollback",
      projectId: "proj_test",
      name: "Script same-name rollback",
      enabled: true,
      trigger: oneShotTrigger(),
      runMode: "script",
      execution: {
        mode: "script",
        scriptFile: "old.sh",
        timeoutMs: 120_000,
      },
      origin: "human",
      createdByThreadId: null,
      nextRunAt: Date.now() + 60_000,
    });
    const scriptDir = automationScriptDir(pluginDataDir, automation.id);
    await mkdir(scriptDir, { recursive: true });
    await writeFile(join(scriptDir, "old.sh"), "echo old\n");
    db.exec(`CREATE TRIGGER reject_automation_update
      BEFORE UPDATE ON automations
      BEGIN
        SELECT RAISE(ABORT, 'update rejected');
      END`);
    const service = createAutomationService({
      bb: createAutomationServiceBb(),
      db,
      pluginDataDir,
      serverUrl: "http://127.0.0.1:38886",
    });

    try {
      await expect(
        service.update({
          projectId: "proj_test",
          automationId: automation.id,
          execution: {
            mode: "script",
            script: "echo replacement\n",
            scriptFile: "old.sh",
            timeoutMs: 120_000,
          },
        }),
      ).rejects.toThrow("update rejected");
      await expect(readFile(join(scriptDir, "old.sh"), "utf8")).resolves.toBe(
        "echo old\n",
      );
      await expect(readdir(scriptDir)).resolves.toEqual(["old.sh"]);
    } finally {
      await rm(pluginDataDir, { recursive: true, force: true });
    }
  });
});

describe("automation CLI --script-file", () => {
  type FileReadCall = { hostId: string | undefined; path: string };

  async function setup() {
    const db = createTestDb();
    const pluginDataDir = await mkdtemp(join(tmpdir(), "bb-1649-data-"));
    const srcDir = await mkdtemp(join(tmpdir(), "bb-1649-src-"));
    const reads: FileReadCall[] = [];
    const serviceBb = createAutomationServiceBb();
    const service = createAutomationService({
      bb: serviceBb,
      db,
      pluginDataDir,
      serverUrl: "http://127.0.0.1:1",
    });
    const sdk = {
      ...serviceBb.sdk,
      hosts: {
        list: async () => [
          { id: "host_server", name: "server" },
          { id: "host_laptop", name: "Laptop" },
        ],
      },
      threads: {
        ...serviceBb.sdk.threads,
        get: async ({ threadId }: { threadId: string }) =>
          threadId === "thr_env"
            ? { id: threadId, environment: { hostId: "host_laptop" } }
            : { id: threadId, environment: null },
      },
      files: {
        read: async ({ hostId, path }: { hostId?: string; path: string }) => {
          reads.push({ hostId, path });
          const content = await readFile(path, "utf8");
          return {
            path,
            content,
            contentEncoding: "utf8" as const,
            sizeBytes: Buffer.byteLength(content),
            sha256: "",
          };
        },
      },
    };
    let cli: PluginCliRegistration | undefined;
    registerAutomationCli({
      bb: {
        sdk: sdk as never,
        cli: {
          register: (registration) => {
            cli = registration;
          },
        },
      },
      service,
    });
    if (!cli) throw new Error("automation CLI was not registered");
    return {
      cli,
      db,
      pluginDataDir,
      srcDir,
      reads,
      async cleanup() {
        await rm(pluginDataDir, { recursive: true, force: true });
        await rm(srcDir, { recursive: true, force: true });
      },
    };
  }

  function idFrom(stdout: string | undefined): string {
    const id = /Automation created: (\S+)/.exec(stdout ?? "")?.[1];
    if (!id) throw new Error(`no id in: ${stdout}`);
    return id;
  }

  it("resolves the source against ctx.cwd and reports the stored snapshot copy", async () => {
    const t = await setup();
    const sourcePath = join(t.srcDir, "hello.sh");
    await writeFile(sourcePath, '#!/bin/sh\necho "VERSION 1"\n');
    try {
      const created = await t.cli.run(
        [
          "create",
          "--project",
          "proj_test",
          "--name",
          "issue-1649",
          "--in",
          "30m",
          "--script-file",
          "./hello.sh",
        ],
        { cwd: t.srcDir },
      );
      expect(created.exitCode).toBe(0);
      const automationId = idFrom(created.stdout);
      expect(t.reads).toEqual([{ hostId: undefined, path: sourcePath }]);
      const storedPath = join(
        automationScriptDir(t.pluginDataDir, automationId),
        "hello.sh",
      );
      expect(created.stdout).toContain(`Script:    ${storedPath}`);
      expect(created.stdout).toContain(`Copied ${sourcePath}`);
      expect(created.stdout).toContain(`to ${storedPath}`);
      expect(created.stdout).toContain(
        `bb automation update ${automationId} --project proj_test --script-file ${sourcePath} --interpreter bash --timeout 120000`,
      );

      const shown = await t.cli.run(
        ["show", automationId, "--project", "proj_test"],
        {},
      );
      expect(shown.stdout).toContain(`Script:    ${storedPath}`);
      const shownJson = await t.cli.run(
        ["show", automationId, "--project", "proj_test", "--json"],
        {},
      );
      expect(JSON.parse(shownJson.stdout ?? "").execution).toEqual({
        mode: "script",
        script: '#!/bin/sh\necho "VERSION 1"\n',
        interpreter: "bash",
        timeoutMs: 120_000,
        storedScriptPath: storedPath,
      });
      const listed = await t.cli.run(
        ["list", "--project", "proj_test", "--json"],
        {},
      );
      expect(
        JSON.parse(listed.stdout ?? "")[0].execution.storedScriptPath,
      ).toBe(storedPath);
      const paused = await t.cli.run(
        ["pause", automationId, "--project", "proj_test", "--json"],
        {},
      );
      expect(JSON.parse(paused.stdout ?? "").execution.storedScriptPath).toBe(
        storedPath,
      );

      await writeFile(sourcePath, '#!/bin/sh\necho "VERSION 2"\n');
      await expect(readFile(storedPath, "utf8")).resolves.toContain(
        "VERSION 1",
      );
      const updated = await t.cli.run(
        [
          "update",
          automationId,
          "--project",
          "proj_test",
          "--script-file",
          "hello.sh",
        ],
        { cwd: t.srcDir },
      );
      expect(updated.exitCode).toBe(0);
      expect(updated.stdout).toContain(`Copied ${sourcePath}`);
      const updatedJson = await t.cli.run(
        ["show", automationId, "--project", "proj_test", "--json"],
        {},
      );
      const refreshedPath: unknown = JSON.parse(updatedJson.stdout ?? "")
        .execution.storedScriptPath;
      if (typeof refreshedPath !== "string") {
        throw new Error("missing storedScriptPath after update");
      }
      expect(
        refreshedPath.startsWith(
          automationScriptDir(t.pluginDataDir, automationId),
        ),
      ).toBe(true);
      expect(updated.stdout).toContain(`to ${refreshedPath}`);
      await expect(readFile(refreshedPath, "utf8")).resolves.toContain(
        "VERSION 2",
      );
    } finally {
      await t.cleanup();
    }
  });

  it("reads the file on the thread's environment host or the --host override", async () => {
    const t = await setup();
    const sourcePath = join(t.srcDir, "hello.sh");
    await writeFile(sourcePath, "echo hi\n");
    try {
      const inThread = await t.cli.run(
        [
          "create",
          "--project",
          "proj_test",
          "--name",
          "thread-host",
          "--in",
          "30m",
          "--script-file",
          sourcePath,
        ],
        { cwd: "/nonexistent", threadId: "thr_env" },
      );
      expect(inThread.exitCode).toBe(0);
      expect(t.reads.at(-1)).toEqual({
        hostId: "host_laptop",
        path: sourcePath,
      });
      expect(inThread.stdout).toContain(
        `Copied ${sourcePath} (host host_laptop)`,
      );
      expect(inThread.stdout).toContain(
        `--script-file ${sourcePath} --host host_laptop --interpreter bash`,
      );

      const byName = await t.cli.run(
        [
          "create",
          "--project",
          "proj_test",
          "--name",
          "named-host",
          "--in",
          "30m",
          "--script-file",
          sourcePath,
          "--host",
          "laptop",
        ],
        {},
      );
      expect(byName.exitCode).toBe(0);
      expect(t.reads.at(-1)).toEqual({
        hostId: "host_laptop",
        path: sourcePath,
      });

      const noEnv = await t.cli.run(
        [
          "create",
          "--project",
          "proj_test",
          "--name",
          "no-env",
          "--in",
          "30m",
          "--script-file",
          sourcePath,
        ],
        { threadId: "thr_bare" },
      );
      expect(noEnv.exitCode).toBe(1);
      expect(noEnv.stderr).toContain("pass --host <name-or-id>");

      const hostOnly = await t.cli.run(
        [
          "create",
          "--project",
          "proj_test",
          "--name",
          "host-only",
          "--in",
          "30m",
          "--script",
          "echo hi",
          "--host",
          "laptop",
        ],
        {},
      );
      expect(hostOnly.exitCode).toBe(1);
      expect(hostOnly.stderr).toContain("--host requires --script-file");
    } finally {
      await t.cleanup();
    }
  });

  it("prints a refresh command that keeps script settings and quotes the path", async () => {
    const t = await setup();
    const sourcePath = join(t.srcDir, "my check $(id).py");
    await writeFile(sourcePath, "print('hi')\n");
    try {
      const created = await t.cli.run(
        [
          "create",
          "--project",
          "proj_test",
          "--name",
          "quoted",
          "--in",
          "30m",
          "--script-file",
          sourcePath,
          "--interpreter",
          "python3",
          "--timeout",
          "5000",
          "--env-json",
          '{"CHANNEL":"qa","MSG":"it\'s"}',
        ],
        {},
      );
      expect(created.exitCode).toBe(0);
      const automationId = idFrom(created.stdout);
      expect(created.stdout).toContain(
        `bb automation update ${automationId} --project proj_test --script-file '${sourcePath}' --interpreter python3 --timeout 5000 --env-json '{"CHANNEL":"qa","MSG":"it'\\''s"}'`,
      );
    } finally {
      await t.cleanup();
    }
  });
});

describe("bb CLI injection for script runs", () => {
  it("prefers the env pointers over PATH and macOS install locations", () => {
    expect(
      bbBinaryCandidates({
        BB_CLI: "/daemon/bundle/bb",
        BB_CLI_DIR: "/other/dir",
      })[0],
    ).toBe("/daemon/bundle/bb");
    expect(bbBinaryCandidates({ BB_CLI_DIR: "/daemon/bundle" })[0]).toBe(
      "/daemon/bundle/bb",
    );
  });

  it("expands PATH itself so every candidate is absolute", () => {
    expect(bbBinaryCandidates({ PATH: "/usr/bin:/opt/tools" })).toEqual([
      "/usr/bin/bb",
      "/opt/tools/bb",
      "/opt/homebrew/bin/bb",
      "/usr/local/bin/bb",
    ]);
    expect(
      bbBinaryCandidates({ PATH: "/usr/bin" }).every((c) => c.startsWith("/")),
    ).toBe(true);
  });

  it("drops entries that would resolve against the wrong directory", () => {
    expect(bbBinaryCandidates({ PATH: "/usr/bin::/bin" })).toEqual([
      "/usr/bin/bb",
      "/bin/bb",
      "/opt/homebrew/bin/bb",
      "/usr/local/bin/bb",
    ]);
    expect(
      bbBinaryCandidates({ BB_CLI: "  ", BB_CLI_DIR: "", PATH: "" }),
    ).toEqual(["/opt/homebrew/bin/bb", "/usr/local/bin/bb"]);
    expect(
      bbBinaryCandidates({ BB_CLI: "./bb", BB_CLI_DIR: "rel/dir", PATH: "" }),
    ).toEqual(["/opt/homebrew/bin/bb", "/usr/local/bin/bb"]);
  });

  it("prepends bb's directory to PATH only when it is absolute", () => {
    expect(scriptPathEnv("/daemon/bundle/bb", "/usr/bin:/bin")).toBe(
      "/daemon/bundle:/usr/bin:/bin",
    );
    expect(scriptPathEnv("bb", "/usr/bin:/bin")).toBe("/usr/bin:/bin");
    expect(scriptPathEnv(null, "/usr/bin:/bin")).toBe("/usr/bin:/bin");
    expect(scriptPathEnv("/daemon/bundle/bb", undefined)).toBe(
      "/daemon/bundle",
    );
  });
});

async function isProcessRunning(pid: number): Promise<boolean> {
  try {
    process.kill(pid, 0);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ESRCH") return false;
    throw error;
  }

  if (process.platform !== "linux") return true;
  try {
    const stat = await readFile(`/proc/${pid}/stat`, "utf8");
    const closingParen = stat.lastIndexOf(")");
    const state = stat.slice(closingParen + 2, closingParen + 3);
    return state !== "Z" && state !== "X";
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT" || code === "ESRCH") return false;
    throw error;
  }
}

describe("script process containment", () => {
  it("terminates descendant processes when a script times out", async () => {
    const pluginDataDir = await mkdtemp(
      join(tmpdir(), "bb-auto-process-group-"),
    );
    const scriptDir = automationScriptDir(pluginDataDir, "auto_timeout");
    await mkdir(scriptDir, { recursive: true });
    await writeFile(
      join(scriptDir, "script.sh"),
      "sleep 30 &\nchild_pid=$!\nprintf 'child_pid=%s\\n' \"$child_pid\"\nwait $child_pid\n",
    );

    try {
      const result = await executeStoredScript({
        pluginDataDir,
        automationId: "auto_timeout",
        runId: "run_timeout",
        projectId: "proj_test",
        scriptFile: "script.sh",
        interpreter: "bash",
        timeoutMs: 1_000,
        serverUrl: "http://127.0.0.1:38886",
      });
      const childPidMatch = result.output.match(/^child_pid=(\d+)$/mu);
      const childPid = Number.parseInt(childPidMatch?.[1] ?? "", 10);
      expect(result.timedOut).toBe(true);
      expect(Number.isSafeInteger(childPid)).toBe(true);

      let childRunning = true;
      for (let attempt = 0; attempt < 20; attempt += 1) {
        childRunning = await isProcessRunning(childPid);
        if (!childRunning) break;
        await new Promise((resolve) => setTimeout(resolve, 25));
      }
      expect(childRunning).toBe(false);
    } finally {
      await rm(pluginDataDir, { recursive: true, force: true });
    }
  });
});

describe("script wake gate", () => {
  it("suppresses only a trailing wakeAgent false object", () => {
    expect(isWakeAgentSuppressed('hello\n{"wakeAgent": false}\n')).toBe(true);
    expect(isWakeAgentSuppressed('{"wakeAgent": true}\n')).toBe(false);
    expect(isWakeAgentSuppressed("not json\n")).toBe(false);
  });

  it("maps silent successful scripts to skipped runs", () => {
    expect(
      mapScriptResultToRun({ exitCode: 0, output: "", timedOut: false }),
    ).toMatchObject({ status: "skipped", skipReason: "empty output" });
    expect(
      mapScriptResultToRun({
        exitCode: 0,
        output: 'nothing\n{"wakeAgent": false}',
        timedOut: false,
      }),
    ).toMatchObject({ status: "skipped", skipReason: "wakeAgent false" });
    expect(
      mapScriptResultToRun({ exitCode: 2, output: "bad", timedOut: false }),
    ).toMatchObject({ status: "failed", error: "Script exited with code 2" });
  });
});

describe("legacy import", () => {
  it("ingests legacy rows, moves environment into agent execution, and imports scripts once", async () => {
    const db = createTestDb();
    const pluginDataDir = await mkdtemp(join(tmpdir(), "bb-auto-plugin-"));
    await mkdir(join(pluginDataDir, "import"), { recursive: true });
    await writeFile(
      join(pluginDataDir, "import", "legacy-automations.json"),
      JSON.stringify({
        automations: [legacyAutomationRow()],
        runs: [
          {
            id: "arun_legacy",
            automationId: "auto_legacy",
            runMode: "agent",
            threadId: "thr_legacy",
            status: "succeeded",
            trigger: "schedule",
            skipReason: null,
            error: null,
            output: null,
            exitCode: null,
            idempotencyKey: null,
            scheduledFor: 1000,
            startedAt: 1000,
            finishedAt: 1001,
          },
        ],
        scripts: {
          auto_legacy: { fileName: "script.sh", content: "echo ok\n" },
        },
      }),
    );
    const kv = new Map<string, unknown>();
    const bb = {
      storage: {
        kv: {
          get: async <T>(key: string) => kv.get(key) as T | undefined,
          set: async (key: string, value: unknown) => {
            kv.set(key, value);
          },
        },
      },
      log: { info: () => undefined },
    };

    await ingestLegacyImport({ bb, db, pluginDataDir });
    await ingestLegacyImport({ bb, db, pluginDataDir });

    const imported = getAutomation(db, "auto_legacy");
    expect(imported).not.toBeNull();
    expect(JSON.parse(imported?.execution ?? "{}")).toMatchObject({
      mode: "agent",
      permissionMode: "accept-edits",
      environment: { type: "project-default" },
    });
    expect(
      listAutomationRuns(db, { automationId: "auto_legacy", limit: 10 }),
    ).toHaveLength(1);
    expect(kv.get("legacy-import-done")).toBe(true);
  });

  it("rejects legacy rows with inconsistent execution metadata", async () => {
    const cases = [
      {
        name: "run mode",
        row: legacyAutomationRow({ runMode: "script" }),
      },
      {
        name: "target thread",
        row: legacyAutomationRow({
          targetThreadId: "thr_row",
          execution: JSON.stringify({
            mode: "agent",
            prompt: "legacy",
            providerId: "codex",
            model: "gpt-5",
            permissionMode: "readonly",
            targetThreadId: "thr_execution",
          }),
        }),
      },
    ];

    for (const testCase of cases) {
      const db = createTestDb();
      const pluginDataDir = await mkdtemp(join(tmpdir(), "bb-auto-plugin-"));
      try {
        await mkdir(join(pluginDataDir, "import"), { recursive: true });
        await writeFile(
          join(pluginDataDir, "import", "legacy-automations.json"),
          JSON.stringify({
            automations: [testCase.row],
            runs: [],
            scripts: {},
          }),
        );
        const kv = new Map<string, unknown>();
        const bb = {
          storage: {
            kv: {
              get: async <T>(key: string) => kv.get(key) as T | undefined,
              set: async (key: string, value: unknown) => {
                kv.set(key, value);
              },
            },
          },
          log: { info: () => undefined },
        };

        await expect(
          ingestLegacyImport({ bb, db, pluginDataDir }),
          testCase.name,
        ).rejects.toThrow(/does not match/u);
      } finally {
        await rm(pluginDataDir, { recursive: true, force: true });
      }
    }
  });
});
