import { describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import { createConnection } from "../../src/connection.js";
import { migrate } from "../../src/migrate.js";
import { noopNotifier } from "../../src/notifier.js";
import type { DbNotifier } from "../../src/notifier.js";
import {
  sweepDestroyingEnvironments,
  sweepExpiredCommands,
  sweepExpiredLeases,
  sweepManagedEnvironments,
} from "../../src/data/sweeps.js";
import { upsertHost } from "../../src/data/hosts.js";
import { createProject } from "../../src/data/projects.js";
import { createThread, archiveThread } from "../../src/data/threads.js";
import { createEnvironment } from "../../src/data/environments.js";
import { openSession } from "../../src/data/sessions.js";
import { queueCommand, fetchCommands } from "../../src/data/commands.js";
import {
  environments,
  hostDaemonCommands,
  hostDaemonSessions,
  threads,
} from "../../src/schema.js";

function setup() {
  const db = createConnection(":memory:");
  migrate(db);
  const host = upsertHost(db, noopNotifier, {
    name: "test-host",
    type: "persistent",
  });
  const project = createProject(db, noopNotifier, { name: "test-project" });
  return { db, host, project };
}

describe("sweepExpiredCommands", () => {
  it("re-queues commands with retryCount 0", () => {
    const { db, host } = setup();

    const cmd = queueCommand(db, noopNotifier, {
      hostId: host.id,
      type: "workspace.status",
      payload: JSON.stringify({ threadId: "thr_test" }),
    });

    // Fetch to mark as fetched
    fetchCommands(db, noopNotifier, { hostId: host.id });

    // Set fetchedAt to the past (more than 60s ago)
    db.update(hostDaemonCommands)
      .set({ fetchedAt: Date.now() - 70_000 })
      .where(eq(hostDaemonCommands.id, cmd.id))
      .run();

    const result = sweepExpiredCommands(db, noopNotifier);
    expect(result.requeued).toBe(1);
    expect(result.errored).toBe(0);

    // Verify command is back to pending with retryCount=1
    const updated = db
      .select()
      .from(hostDaemonCommands)
      .where(eq(hostDaemonCommands.id, cmd.id))
      .get();
    expect(updated?.state).toBe("pending");
    expect(updated?.retryCount).toBe(1);
    expect(updated?.fetchedAt).toBeNull();
  });

  it("errors commands with retryCount >= 1", () => {
    const { db, host, project } = setup();
    const thread = createThread(db, noopNotifier, {
      projectId: project.id,
      providerId: "codex",
      status: "idle",
    });

    const cmd = queueCommand(db, noopNotifier, {
      hostId: host.id,
      type: "workspace.status",
      payload: JSON.stringify({ threadId: thread.id }),
    });

    // Fetch, then manually set retryCount=1 and old fetchedAt
    fetchCommands(db, noopNotifier, { hostId: host.id });
    db.update(hostDaemonCommands)
      .set({ fetchedAt: Date.now() - 70_000, retryCount: 1 })
      .where(eq(hostDaemonCommands.id, cmd.id))
      .run();

    const spy: DbNotifier = {
      notifyThread: vi.fn(),
      notifyEnvironment: vi.fn(),
      notifyCommand: vi.fn(),
      notifyProject: vi.fn(),
      notifySystem: vi.fn(),
    };

    const result = sweepExpiredCommands(db, spy);
    expect(result.requeued).toBe(0);
    expect(result.errored).toBe(1);

    // Command should be errored
    const updated = db
      .select()
      .from(hostDaemonCommands)
      .where(eq(hostDaemonCommands.id, cmd.id))
      .get();
    expect(updated?.state).toBe("error");

    // Thread should be errored
    const updatedThread = db
      .select()
      .from(threads)
      .where(eq(threads.id, thread.id))
      .get();
    expect(updatedThread?.status).toBe("error");

    expect(spy.notifyThread).toHaveBeenCalledWith(thread.id, ["status-changed"]);
  });

  it("uses 5-minute TTL for environment.provision commands", () => {
    const { db, host } = setup();

    const cmd = queueCommand(db, noopNotifier, {
      hostId: host.id,
      type: "environment.provision",
      payload: "{}",
    });

    fetchCommands(db, noopNotifier, { hostId: host.id });

    // 70 seconds ago (past standard TTL but within provision TTL)
    db.update(hostDaemonCommands)
      .set({ fetchedAt: Date.now() - 70_000 })
      .where(eq(hostDaemonCommands.id, cmd.id))
      .run();

    const result1 = sweepExpiredCommands(db, noopNotifier);
    expect(result1.requeued).toBe(0); // Not expired yet

    // 6 minutes ago (past provision TTL)
    db.update(hostDaemonCommands)
      .set({ fetchedAt: Date.now() - 6 * 60_000 })
      .where(eq(hostDaemonCommands.id, cmd.id))
      .run();

    const result2 = sweepExpiredCommands(db, noopNotifier);
    expect(result2.requeued).toBe(1); // Now expired and re-queued
  });
});

describe("sweepExpiredLeases", () => {
  it("closes expired sessions and errors threads", () => {
    const { db, host, project } = setup();

    const env = createEnvironment(db, noopNotifier, {
      projectId: project.id,
      hostId: host.id,
      path: "/tmp/env",
      workspaceProvisionType: "unmanaged",
      status: "ready",
    });

    const thread = createThread(db, noopNotifier, {
      projectId: project.id,
      environmentId: env.id,
      providerId: "codex",
      status: "idle",
    });

    const session = openSession(db, noopNotifier, {
      hostId: host.id,
      instanceId: "inst-1",
      hostName: "test-host",
      hostType: "persistent",
      protocolVersion: 1,
      heartbeatIntervalMs: 10_000,
      leaseTimeoutMs: 30_000,
    });

    // Set lease to the past
    db.update(hostDaemonSessions)
      .set({ leaseExpiresAt: Date.now() - 1000 })
      .where(eq(hostDaemonSessions.id, session.id))
      .run();

    const spy: DbNotifier = {
      notifyThread: vi.fn(),
      notifyEnvironment: vi.fn(),
      notifyCommand: vi.fn(),
      notifyProject: vi.fn(),
      notifySystem: vi.fn(),
    };

    const result = sweepExpiredLeases(db, spy);
    expect(result.sessionsClosed).toBe(1);
    expect(result.threadsErrored).toBe(1);

    // Session should be closed
    const updatedSession = db
      .select()
      .from(hostDaemonSessions)
      .where(eq(hostDaemonSessions.id, session.id))
      .get();
    expect(updatedSession?.status).toBe("closed");
    expect(updatedSession?.closeReason).toBe("expired");

    // Thread should be errored
    const updatedThread = db
      .select()
      .from(threads)
      .where(eq(threads.id, thread.id))
      .get();
    expect(updatedThread?.status).toBe("error");

    expect(spy.notifySystem).toHaveBeenCalledWith(["host-disconnected"]);
    expect(spy.notifyThread).toHaveBeenCalledWith(thread.id, ["status-changed"]);
  });
});

describe("sweepManagedEnvironments", () => {
  it("returns managed environments with zero non-archived threads", () => {
    const { db, host, project } = setup();

    const env = createEnvironment(db, noopNotifier, {
      projectId: project.id,
      hostId: host.id,
      path: "/tmp/env",
      managed: true,
      workspaceProvisionType: "managed-worktree",
      status: "ready",
    });

    // No threads at all → should be a candidate
    const candidates1 = sweepManagedEnvironments(db);
    expect(candidates1).toHaveLength(1);
    expect(candidates1[0]!.id).toBe(env.id);
  });

  it("does not return environments with non-archived threads", () => {
    const { db, host, project } = setup();

    const env = createEnvironment(db, noopNotifier, {
      projectId: project.id,
      hostId: host.id,
      path: "/tmp/env",
      managed: true,
      workspaceProvisionType: "managed-worktree",
      status: "ready",
    });

    createThread(db, noopNotifier, {
      projectId: project.id,
      environmentId: env.id,
      providerId: "codex",
      status: "idle",
    });

    const candidates = sweepManagedEnvironments(db);
    expect(candidates).toHaveLength(0);
  });

  it("returns environment after all threads are archived", () => {
    const { db, host, project } = setup();

    const env = createEnvironment(db, noopNotifier, {
      projectId: project.id,
      hostId: host.id,
      path: "/tmp/env",
      managed: true,
      workspaceProvisionType: "managed-worktree",
      status: "ready",
    });

    const thread = createThread(db, noopNotifier, {
      projectId: project.id,
      environmentId: env.id,
      providerId: "codex",
      status: "idle",
    });

    // Not a candidate while thread is active
    expect(sweepManagedEnvironments(db)).toHaveLength(0);

    // Archive the thread
    archiveThread(db, noopNotifier, thread.id);

    // Now it's a candidate
    const candidates = sweepManagedEnvironments(db);
    expect(candidates).toHaveLength(1);
    expect(candidates[0]!.id).toBe(env.id);
  });

  it("does not return unmanaged environments", () => {
    const { db, host, project } = setup();

    createEnvironment(db, noopNotifier, {
      projectId: project.id,
      hostId: host.id,
      path: "/tmp/env",
      managed: false,
      workspaceProvisionType: "unmanaged",
      status: "ready",
    });

    const candidates = sweepManagedEnvironments(db);
    expect(candidates).toHaveLength(0);
  });

  it("does not return environments already being destroyed", () => {
    const { db, host, project } = setup();

    createEnvironment(db, noopNotifier, {
      projectId: project.id,
      hostId: host.id,
      path: "/tmp/env",
      managed: true,
      workspaceProvisionType: "managed-worktree",
      status: "destroying",
    });

    const candidates = sweepManagedEnvironments(db);
    expect(candidates).toHaveLength(0);
  });
});

describe("sweepDestroyingEnvironments", () => {
  it("hard-deletes stale destroying environments after the retention window", () => {
    const { db, host, project } = setup();
    const now = Date.now();

    const staleEnvironment = createEnvironment(db, noopNotifier, {
      projectId: project.id,
      hostId: host.id,
      path: "/tmp/stale-destroying",
      managed: true,
      workspaceProvisionType: "managed-worktree",
      status: "destroying",
    });
    const freshEnvironment = createEnvironment(db, noopNotifier, {
      projectId: project.id,
      hostId: host.id,
      path: "/tmp/fresh-destroying",
      managed: true,
      workspaceProvisionType: "managed-worktree",
      status: "destroying",
    });

    db.update(environments)
      .set({ updatedAt: now - 8 * 24 * 60 * 60_000 })
      .where(eq(environments.id, staleEnvironment.id))
      .run();

    const spy: DbNotifier = {
      notifyThread: vi.fn(),
      notifyEnvironment: vi.fn(),
      notifyCommand: vi.fn(),
      notifyProject: vi.fn(),
      notifySystem: vi.fn(),
    };

    const result = sweepDestroyingEnvironments(db, spy, now);
    expect(result.deleted).toBe(1);
    expect(
      db.select().from(environments).all().map((row) => row.id),
    ).toEqual([freshEnvironment.id]);
    expect(spy.notifySystem).toHaveBeenCalledWith(["environment-deleted"]);
  });
});
