import { eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { createConnection } from "../../src/connection.js";
import { migrate } from "../../src/migrate.js";
import { noopNotifier } from "../../src/notifier.js";
import {
  advanceAutomationAfterRunInTransaction,
  claimAutomationScheduledRun,
  createAutomation,
  deleteAutomation,
  getAutomation,
  hasOpenAutomationThread,
  listAutomations,
  listDueAutomations,
  restoreAutomationAfterFailedRun,
  updateAutomation,
} from "../../src/data/automations.js";
import { createProject } from "../../src/data/projects.js";
import { openSession } from "../../src/data/sessions.js";
import { createThread } from "../../src/data/threads.js";
import { upsertHost } from "../../src/data/hosts.js";
import { threads } from "../../src/schema.js";

function setup() {
  const db = createConnection(":memory:");
  migrate(db);
  const host = upsertHost(db, noopNotifier, {
    name: "test-host",
    type: "persistent",
  });
  const { project } = createProject(db, noopNotifier, {
    name: "test-project",
    source: { type: "local_path", hostId: host.id, path: "/tmp/test" },
  });
  return { db, host, project };
}

function createScheduleAutomation(args: {
  db: ReturnType<typeof createConnection>;
  hostId: string;
  projectId: string;
  now: number;
}) {
  return createAutomation(args.db, noopNotifier, {
    projectId: args.projectId,
    name: "Daily sync",
    enabled: true,
    triggerType: "schedule",
    triggerConfig: "{\"triggerType\":\"schedule\",\"cron\":\"0 8 * * 1-5\",\"timezone\":\"UTC\"}",
    action: JSON.stringify({
      actionType: "scheduled-thread",
      threadRequest: {
        providerId: "codex",
        model: "gpt-5",
        input: [{ type: "text", text: "Run daily sync" }],
        environment: {
          type: "host",
          hostId: args.hostId,
          workspace: { type: "managed-clone" },
        },
      },
    }),
    autoArchive: false,
    nextRunAt: args.now + 60_000,
  });
}

describe("automations", () => {
  it("creates and retrieves automations", () => {
    const { db, host, project } = setup();
    const now = Date.now();

    const automation = createScheduleAutomation({
      db,
      hostId: host.id,
      projectId: project.id,
      now,
    });

    expect(automation.id).toMatch(/^auto_/u);
    expect(getAutomation(db, automation.id)).toMatchObject({
      id: automation.id,
      projectId: project.id,
      autoArchive: false,
    });
  });

  it("lists due automations and updates them", () => {
    const { db, host, project } = setup();
    const now = Date.now();
    const dueAutomation = createScheduleAutomation({
      db,
      hostId: host.id,
      projectId: project.id,
      now: now - 120_000,
    });
    createScheduleAutomation({
      db,
      hostId: host.id,
      projectId: project.id,
      now,
    });

    const due = listDueAutomations(db, { now, limit: 1 });
    expect(due.map((automation) => automation.id)).toEqual([dueAutomation.id]);

    const updated = updateAutomation(db, noopNotifier, dueAutomation.id, {
      name: "Updated sync",
      autoArchive: true,
      runCount: 3,
    });
    expect(updated).toMatchObject({
      name: "Updated sync",
      autoArchive: true,
      runCount: 3,
    });

    expect(listAutomations(db, project.id)).toHaveLength(2);
  });

  it("tracks open automation threads and clears them when archived or deleted", () => {
    const { db, host, project } = setup();
    const now = Date.now();
    const automation = createScheduleAutomation({
      db,
      hostId: host.id,
      projectId: project.id,
      now,
    });

    const thread = createThread(db, noopNotifier, {
      projectId: project.id,
      providerId: "codex",
      status: "created",
      automationId: automation.id,
    });

    expect(hasOpenAutomationThread(db, automation.id)).toBe(true);

    db.update(threads)
      .set({ archivedAt: now, updatedAt: now })
      .where(eq(threads.id, thread.id))
      .run();
    expect(hasOpenAutomationThread(db, automation.id)).toBe(false);

    db.update(threads)
      .set({ archivedAt: null, deletedAt: now, updatedAt: now })
      .where(eq(threads.id, thread.id))
      .run();
    expect(hasOpenAutomationThread(db, automation.id)).toBe(false);
  });

  it("uses optimistic locking for schedule advancement and can restore a failed run", () => {
    const { db, host, project } = setup();
    const now = Date.now();
    const automation = createScheduleAutomation({
      db,
      hostId: host.id,
      projectId: project.id,
      now: now - 120_000,
    });

    const firstAdvanced = db.transaction((tx) =>
      advanceAutomationAfterRunInTransaction(tx, {
        automationId: automation.id,
        expectedNextRunAt: automation.nextRunAt,
        nextRunAt: now + 60_000,
        now,
      }), { behavior: "immediate" });
    expect(firstAdvanced).toBe(true);

    const secondAdvanced = db.transaction((tx) =>
      advanceAutomationAfterRunInTransaction(tx, {
        automationId: automation.id,
        expectedNextRunAt: automation.nextRunAt,
        nextRunAt: now + 120_000,
        now: now + 1,
      }), { behavior: "immediate" });
    expect(secondAdvanced).toBe(false);

    const restored = restoreAutomationAfterFailedRun(db, noopNotifier, {
      automationId: automation.id,
      expectedAdvancedNextRunAt: now + 60_000,
      expectedRunCount: 1,
      projectId: project.id,
      restoredLastRunAt: automation.lastRunAt,
      restoredNextRunAt: automation.nextRunAt,
      restoredRunCount: automation.runCount,
      now: now + 2,
    });
    expect(restored).toBe(true);
    expect(getAutomation(db, automation.id)).toMatchObject({
      lastRunAt: automation.lastRunAt,
      nextRunAt: automation.nextRunAt,
      runCount: automation.runCount,
    });
  });

  it("allows a new run after the prior automation thread is archived", () => {
    const { db, host, project } = setup();
    const now = Date.now();
    const automation = createScheduleAutomation({
      db,
      hostId: host.id,
      projectId: project.id,
      now,
    });
    const thread = createThread(db, noopNotifier, {
      projectId: project.id,
      providerId: "codex",
      status: "error",
      automationId: automation.id,
    });

    expect(hasOpenAutomationThread(db, automation.id)).toBe(false);

    db.update(threads)
      .set({ status: "idle", updatedAt: now })
      .where(eq(threads.id, thread.id))
      .run();
    expect(hasOpenAutomationThread(db, automation.id)).toBe(true);

    db.update(threads)
      .set({ archivedAt: now, updatedAt: now })
      .where(eq(threads.id, thread.id))
      .run();
    expect(hasOpenAutomationThread(db, automation.id)).toBe(false);
  });

  it("claims scheduled runs once and skips creating a new thread when one is already open", () => {
    const { db, host, project } = setup();
    const now = Date.now();
    const automation = createScheduleAutomation({
      db,
      hostId: host.id,
      projectId: project.id,
      now: now - 120_000,
    });
    openSession(db, noopNotifier, {
      hostId: host.id,
      instanceId: "inst-automation-claim",
      hostName: "test-host",
      hostType: "persistent",
      dataDir: "/tmp/test-host",
      protocolVersion: 1,
      heartbeatIntervalMs: 1_000,
      leaseTimeoutMs: 60_000,
    });
    createThread(db, noopNotifier, {
      projectId: project.id,
      providerId: "codex",
      status: "created",
      automationId: automation.id,
    });

    const claimed = claimAutomationScheduledRun(db, noopNotifier, {
      automationId: automation.id,
      expectedNextRunAt: automation.nextRunAt,
      hostId: host.id,
      nextRunAt: now + 60_000,
    });

    expect(claimed).toEqual({
      advanced: true,
      reason: "open-thread",
      shouldCreateThread: false,
    });
    expect(getAutomation(db, automation.id)).toMatchObject({
      nextRunAt: now + 60_000,
      runCount: 1,
    });

    const staleClaim = claimAutomationScheduledRun(db, noopNotifier, {
      automationId: automation.id,
      expectedNextRunAt: automation.nextRunAt,
      hostId: host.id,
      nextRunAt: now + 120_000,
    });
    expect(staleClaim).toEqual({
      advanced: false,
      reason: "lost-race",
      shouldCreateThread: false,
    });
  });

  it("claims scheduled runs as disconnected when the host has no active session", () => {
    const { db, host, project } = setup();
    const now = Date.now();
    const automation = createScheduleAutomation({
      db,
      hostId: host.id,
      projectId: project.id,
      now: now - 120_000,
    });

    const claimed = claimAutomationScheduledRun(db, noopNotifier, {
      automationId: automation.id,
      expectedNextRunAt: automation.nextRunAt,
      hostId: host.id,
      nextRunAt: now + 60_000,
    });

    expect(claimed).toEqual({
      advanced: true,
      reason: "host-disconnected",
      shouldCreateThread: false,
    });
  });

  it("deletes automations", () => {
    const { db, host, project } = setup();
    const now = Date.now();
    const automation = createScheduleAutomation({
      db,
      hostId: host.id,
      projectId: project.id,
      now,
    });

    expect(deleteAutomation(db, noopNotifier, automation.id)).toBe(true);
    expect(getAutomation(db, automation.id)).toBeNull();
    expect(deleteAutomation(db, noopNotifier, automation.id)).toBe(false);
  });
});
