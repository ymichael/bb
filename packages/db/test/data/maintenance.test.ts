import { describe, expect, it } from "vitest";
import { createConnection } from "../../src/connection.js";
import { migrate } from "../../src/migrate.js";
import { noopNotifier } from "../../src/notifier.js";
import {
  getDatabaseMaintenanceActivity,
  isDatabaseMaintenanceIdle,
  shouldCompactDatabase,
} from "../../src/data/maintenance.js";
import { queueCommand, reportCommandResult } from "../../src/data/commands.js";
import { upsertHost } from "../../src/data/hosts.js";
import { createProject } from "../../src/data/projects.js";
import { createThread, markThreadDeleted } from "../../src/data/threads.js";

function setup() {
  const db = createConnection(":memory:");
  migrate(db);
  const host = upsertHost(db, noopNotifier, {
    name: "maintenance-host",
    type: "persistent",
  });
  const { project } = createProject(db, noopNotifier, {
    name: "maintenance-project",
    source: { type: "local_path", hostId: host.id, path: "/tmp/project" },
  });
  return { db, host, project };
}

describe("database maintenance", () => {
  it("detects active work that should block compaction", () => {
    const { db, host, project } = setup();
    const idleActivity = getDatabaseMaintenanceActivity(db);
    expect(isDatabaseMaintenanceIdle(idleActivity)).toBe(true);

    const command = queueCommand(db, noopNotifier, {
      hostId: host.id,
      type: "workspace.status",
      payload: "{}",
    });
    const commandActivity = getDatabaseMaintenanceActivity(db);
    expect(commandActivity.activeCommandCount).toBe(1);
    expect(isDatabaseMaintenanceIdle(commandActivity)).toBe(false);

    reportCommandResult(db, noopNotifier, {
      commandId: command.id,
      state: "success",
      completedAt: Date.now(),
      resultPayload: null,
    });
    const activeThread = createThread(db, noopNotifier, {
      projectId: project.id,
      providerId: "codex",
      status: "active",
    });
    const threadActivity = getDatabaseMaintenanceActivity(db);
    expect(threadActivity.activeThreadCount).toBe(1);
    expect(isDatabaseMaintenanceIdle(threadActivity)).toBe(false);

    markThreadDeleted(db, noopNotifier, { threadId: activeThread.id });
    expect(isDatabaseMaintenanceIdle(getDatabaseMaintenanceActivity(db))).toBe(
      true,
    );
  });

  it("requires both reclaimable bytes and ratio before compacting", () => {
    expect(
      shouldCompactDatabase({
        minReclaimableBytes: 100,
        minReclaimableRatio: 0.2,
        stats: {
          databaseBytes: 1_000,
          freelistBytes: 0,
          freelistCount: 0,
          pageCount: 10,
          pageSize: 100,
          reclaimableBytes: 250,
          unusedBytes: 250,
        },
      }),
    ).toBe(true);
    expect(
      shouldCompactDatabase({
        minReclaimableBytes: 300,
        minReclaimableRatio: 0.2,
        stats: {
          databaseBytes: 1_000,
          freelistBytes: 0,
          freelistCount: 0,
          pageCount: 10,
          pageSize: 100,
          reclaimableBytes: 250,
          unusedBytes: 250,
        },
      }),
    ).toBe(false);
    expect(
      shouldCompactDatabase({
        minReclaimableBytes: 100,
        minReclaimableRatio: 0.3,
        stats: {
          databaseBytes: 1_000,
          freelistBytes: 0,
          freelistCount: 0,
          pageCount: 10,
          pageSize: 100,
          reclaimableBytes: 250,
          unusedBytes: 250,
        },
      }),
    ).toBe(false);
  });
});
