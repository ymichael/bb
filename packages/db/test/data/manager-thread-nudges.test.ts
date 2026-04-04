import { describe, expect, it } from "vitest";
import { createConnection } from "../../src/connection.js";
import { migrate } from "../../src/migrate.js";
import { noopNotifier } from "../../src/notifier.js";
import {
  advanceManagerThreadNudgeAfterFireInTransaction,
  createManagerThreadNudge,
  deleteManagerThreadNudge,
  deleteManagerThreadNudgesForThread,
  getManagerThreadNudge,
  listDueManagerThreadNudges,
  listManagerThreadNudgesByThread,
  updateManagerThreadNudge,
} from "../../src/data/manager-thread-nudges.js";
import { createProject } from "../../src/data/projects.js";
import { createThread } from "../../src/data/threads.js";
import { upsertHost } from "../../src/data/hosts.js";

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
  const thread = createThread(db, noopNotifier, {
    projectId: project.id,
    providerId: "codex",
    status: "idle",
    type: "manager",
  });
  return { db, project, thread };
}

describe("manager thread nudges", () => {
  it("creates, lists, and updates nudges", () => {
    const { db, project, thread } = setup();
    const now = Date.now();

    const nudge = createManagerThreadNudge(db, noopNotifier, {
      projectId: project.id,
      threadId: thread.id,
      name: "deploy-check",
      cron: "0 * * * *",
      timezone: "UTC",
      enabled: true,
      nextFireAt: now + 60_000,
    });

    expect(nudge.id).toMatch(/^mnge_/u);
    expect(getManagerThreadNudge(db, nudge.id)).toMatchObject({
      id: nudge.id,
      name: "deploy-check",
    });
    expect(listManagerThreadNudgesByThread(db, thread.id)).toHaveLength(1);

    const updated = updateManagerThreadNudge(db, noopNotifier, nudge.id, {
      cron: "0 */2 * * *",
      timezone: "America/Los_Angeles",
    });
    expect(updated).toMatchObject({
      cron: "0 */2 * * *",
      timezone: "America/Los_Angeles",
    });
  });

  it("lists due nudges and deletes them", () => {
    const { db, project, thread } = setup();
    const now = Date.now();
    const due = createManagerThreadNudge(db, noopNotifier, {
      projectId: project.id,
      threadId: thread.id,
      name: "now",
      cron: "0 * * * *",
      timezone: "UTC",
      enabled: true,
      nextFireAt: now - 1,
    });
    createManagerThreadNudge(db, noopNotifier, {
      projectId: project.id,
      threadId: thread.id,
      name: "later",
      cron: "0 * * * *",
      timezone: "UTC",
      enabled: true,
      nextFireAt: now + 60_000,
    });

    expect(listDueManagerThreadNudges(db, { now, limit: 1 }).map((nudge) => nudge.id)).toEqual([
      due.id,
    ]);
    expect(deleteManagerThreadNudge(db, noopNotifier, due.id)).toBe(true);
    expect(deleteManagerThreadNudge(db, noopNotifier, due.id)).toBe(false);
    expect(deleteManagerThreadNudgesForThread(db, noopNotifier, thread.id)).toBe(1);
  });

  it("does not advance a nudge after it is disabled", () => {
    const { db, project, thread } = setup();
    const now = Date.now();
    const nudge = createManagerThreadNudge(db, noopNotifier, {
      projectId: project.id,
      threadId: thread.id,
      name: "disabled-before-fire",
      cron: "0 * * * *",
      timezone: "UTC",
      enabled: true,
      nextFireAt: now - 1,
    });

    updateManagerThreadNudge(db, noopNotifier, nudge.id, { enabled: false });
    const advanced = db.transaction((tx) =>
      advanceManagerThreadNudgeAfterFireInTransaction(tx, {
        expectedNextFireAt: nudge.nextFireAt,
        nextFireAt: now + 60_000,
        nudgeId: nudge.id,
        now,
      }), { behavior: "immediate" });

    expect(advanced).toBe(false);
    expect(getManagerThreadNudge(db, nudge.id)).toMatchObject({
      enabled: false,
      lastFiredAt: null,
      nextFireAt: nudge.nextFireAt,
    });
  });
});
