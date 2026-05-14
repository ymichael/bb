import { describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import { createConnection } from "../../src/connection.js";
import { migrate } from "../../src/migrate.js";
import { noopNotifier } from "../../src/notifier.js";
import type { DbNotifier } from "../../src/notifier.js";
import {
  pruneCompletedCommandPayloads,
  sweepDestroyingEnvironments,
  sweepExpiredCommands,
  sweepExpiredLeases,
  sweepManagedEnvironments,
} from "../../src/data/sweeps.js";
import { upsertHost } from "../../src/data/hosts.js";
import { createProject } from "../../src/data/projects.js";
import {
  createThread,
  archiveThread,
  markThreadDeleted,
  markThreadStopRequested,
} from "../../src/data/threads.js";
import {
  createEnvironment,
  recordEnvironmentCleanupRequest,
} from "../../src/data/environments.js";
import { openSession } from "../../src/data/sessions.js";
import {
  queueCommand,
  fetchCommands,
  reportCommandResult,
} from "../../src/data/commands.js";
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
  const { project } = createProject(db, noopNotifier, {
    name: "test-project",
    source: { type: "local_path", hostId: host.id, path: "/tmp/test" },
  });
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
      notifyHost: vi.fn(),
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
    expect(JSON.parse(updated?.resultPayload ?? "")).toEqual({
      errorCode: "command_expired",
      errorMessage: "Command expired after retry",
    });

    // Thread should be errored
    const updatedThread = db
      .select()
      .from(threads)
      .where(eq(threads.id, thread.id))
      .get();
    expect(updatedThread?.status).toBe("error");

    expect(spy.notifyThread).toHaveBeenCalledWith(
      thread.id,
      ["status-changed"],
      {
        projectId: project.id,
      },
    );
  });

  it("uses 20-minute TTL for environment.provision commands", () => {
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

    // 21 minutes ago (past provision TTL)
    db.update(hostDaemonCommands)
      .set({ fetchedAt: Date.now() - 21 * 60_000 })
      .where(eq(hostDaemonCommands.id, cmd.id))
      .run();

    const result2 = sweepExpiredCommands(db, noopNotifier);
    expect(result2.requeued).toBe(1); // Now expired and re-queued
  });

  it("does not transition deleted or stop-pending threads to error when commands expire", () => {
    const { db, host, project } = setup();
    const deletedThread = createThread(db, noopNotifier, {
      projectId: project.id,
      providerId: "codex",
      status: "idle",
    });
    const stopPendingThread = createThread(db, noopNotifier, {
      projectId: project.id,
      providerId: "codex",
      status: "active",
    });
    markThreadDeleted(db, noopNotifier, { threadId: deletedThread.id });
    markThreadStopRequested(db, noopNotifier, {
      threadId: stopPendingThread.id,
      requestedAt: 123,
    });

    const deletedCommand = queueCommand(db, noopNotifier, {
      hostId: host.id,
      type: "workspace.status",
      payload: JSON.stringify({ threadId: deletedThread.id }),
    });
    const stopPendingCommand = queueCommand(db, noopNotifier, {
      hostId: host.id,
      type: "workspace.status",
      payload: JSON.stringify({ threadId: stopPendingThread.id }),
    });

    fetchCommands(db, noopNotifier, { hostId: host.id });
    db.update(hostDaemonCommands)
      .set({ fetchedAt: Date.now() - 70_000, retryCount: 1 })
      .where(eq(hostDaemonCommands.id, deletedCommand.id))
      .run();
    db.update(hostDaemonCommands)
      .set({ fetchedAt: Date.now() - 70_000, retryCount: 1 })
      .where(eq(hostDaemonCommands.id, stopPendingCommand.id))
      .run();

    const result = sweepExpiredCommands(db, noopNotifier);
    expect(result.errored).toBe(2);

    expect(
      db.select().from(threads).where(eq(threads.id, deletedThread.id)).get()
        ?.status,
    ).toBe("idle");
    expect(
      db
        .select()
        .from(threads)
        .where(eq(threads.id, stopPendingThread.id))
        .get()?.status,
    ).toBe("active");
  });
});

describe("pruneCompletedCommandPayloads", () => {
  it("clears terminal command blobs before the retention cutoff", () => {
    const { db, host } = setup();
    const now = Date.now();
    const staleCompletedAt = now - 10_000;
    const freshCompletedAt = now;
    const completedBefore = now - 5_000;

    const staleSuccess = queueCommand(db, noopNotifier, {
      hostId: host.id,
      type: "workspace.status",
      payload: JSON.stringify({ stale: "success" }),
    });
    const staleError = queueCommand(db, noopNotifier, {
      hostId: host.id,
      type: "workspace.diff",
      payload: JSON.stringify({ stale: "error" }),
    });
    const freshSuccess = queueCommand(db, noopNotifier, {
      hostId: host.id,
      type: "host.list_files",
      payload: JSON.stringify({ fresh: true }),
    });
    const fetchedCommand = queueCommand(db, noopNotifier, {
      hostId: host.id,
      type: "host.read_file",
      payload: JSON.stringify({ fetched: true }),
    });

    reportCommandResult(db, noopNotifier, {
      commandId: staleSuccess.id,
      state: "success",
      completedAt: staleCompletedAt,
      resultPayload: JSON.stringify({ ok: true }),
    });
    reportCommandResult(db, noopNotifier, {
      commandId: staleError.id,
      state: "error",
      completedAt: staleCompletedAt,
      resultPayload: JSON.stringify({
        errorCode: "failed",
        errorMessage: "failed",
      }),
    });
    reportCommandResult(db, noopNotifier, {
      commandId: freshSuccess.id,
      state: "success",
      completedAt: freshCompletedAt,
      resultPayload: JSON.stringify({ ok: true }),
    });
    fetchCommands(db, noopNotifier, { hostId: host.id });
    const pendingCommand = queueCommand(db, noopNotifier, {
      hostId: host.id,
      type: "provider.list",
      payload: JSON.stringify({ pending: true }),
    });

    const result = pruneCompletedCommandPayloads(db, { completedBefore });

    expect(result).toEqual({ pruned: 2 });
    expect(
      db
        .select()
        .from(hostDaemonCommands)
        .where(eq(hostDaemonCommands.id, staleSuccess.id))
        .get(),
    ).toMatchObject({
      completedAt: staleCompletedAt,
      cursor: staleSuccess.cursor,
      payload: "{}",
      resultPayload: null,
      state: "success",
    });
    expect(
      db
        .select()
        .from(hostDaemonCommands)
        .where(eq(hostDaemonCommands.id, staleError.id))
        .get(),
    ).toMatchObject({
      completedAt: staleCompletedAt,
      cursor: staleError.cursor,
      payload: "{}",
      resultPayload: null,
      state: "error",
    });
    expect(
      db
        .select()
        .from(hostDaemonCommands)
        .where(eq(hostDaemonCommands.id, freshSuccess.id))
        .get(),
    ).toMatchObject({
      payload: JSON.stringify({ fresh: true }),
      resultPayload: JSON.stringify({ ok: true }),
      state: "success",
    });
    expect(
      db
        .select()
        .from(hostDaemonCommands)
        .where(eq(hostDaemonCommands.id, fetchedCommand.id))
        .get(),
    ).toMatchObject({
      payload: JSON.stringify({ fetched: true }),
      resultPayload: null,
      state: "fetched",
    });
    expect(
      db
        .select()
        .from(hostDaemonCommands)
        .where(eq(hostDaemonCommands.id, pendingCommand.id))
        .get(),
    ).toMatchObject({
      payload: JSON.stringify({ pending: true }),
      resultPayload: null,
      state: "pending",
    });
  });

  it("does not count already-pruned terminal commands on later sweeps", () => {
    const { db, host } = setup();
    const completedAt = Date.now() - 10_000;
    const completedBefore = Date.now();
    const command = queueCommand(db, noopNotifier, {
      hostId: host.id,
      type: "workspace.status",
      payload: JSON.stringify({ prunable: true }),
    });

    reportCommandResult(db, noopNotifier, {
      commandId: command.id,
      state: "success",
      completedAt,
      resultPayload: JSON.stringify({ ok: true }),
    });

    expect(pruneCompletedCommandPayloads(db, { completedBefore })).toEqual({
      pruned: 1,
    });
    expect(pruneCompletedCommandPayloads(db, { completedBefore })).toEqual({
      pruned: 0,
    });
  });
});

describe("sweepExpiredLeases", () => {
  it("closes expired sessions without erroring active threads", () => {
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
      status: "active",
    });

    const session = openSession(db, noopNotifier, {
      hostId: host.id,
      instanceId: "inst-1",
      hostName: "test-host",
      hostType: "persistent",
      dataDir: "/tmp/test-host-data",
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
      notifyHost: vi.fn(),
      notifySystem: vi.fn(),
    };

    const result = sweepExpiredLeases(db, spy);
    expect(result.sessionsClosed).toBe(1);
    expect(result.expiredHostIds).toEqual([host.id]);
    expect(result.expiredSessionIds).toEqual([session.id]);

    // Session should be closed
    const updatedSession = db
      .select()
      .from(hostDaemonSessions)
      .where(eq(hostDaemonSessions.id, session.id))
      .get();
    expect(updatedSession?.status).toBe("closed");
    expect(updatedSession?.closeReason).toBe("expired");

    const updatedThread = db
      .select()
      .from(threads)
      .where(eq(threads.id, thread.id))
      .get();
    expect(updatedThread?.status).toBe("active");

    expect(spy.notifyHost).toHaveBeenCalledWith(host.id, ["host-disconnected"]);
    expect(spy.notifyThread).not.toHaveBeenCalled();
  });

  it("does not error idle threads on lease expiry", () => {
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
      dataDir: "/tmp/test-host-data",
      protocolVersion: 1,
      heartbeatIntervalMs: 10_000,
      leaseTimeoutMs: 30_000,
    });

    db.update(hostDaemonSessions)
      .set({ leaseExpiresAt: Date.now() - 1000 })
      .where(eq(hostDaemonSessions.id, session.id))
      .run();

    const result = sweepExpiredLeases(db, noopNotifier);
    expect(result.sessionsClosed).toBe(1);
    expect(result.expiredHostIds).toEqual([host.id]);
    expect(result.expiredSessionIds).toEqual([session.id]);

    const updatedThread = db
      .select()
      .from(threads)
      .where(eq(threads.id, thread.id))
      .get();
    expect(updatedThread?.status).toBe("idle");
  });
});

describe("sweepManagedEnvironments", () => {
  it("returns managed environments with cleanup requested and zero non-archived threads", () => {
    const { db, host, project } = setup();

    const env = createEnvironment(db, noopNotifier, {
      projectId: project.id,
      hostId: host.id,
      path: "/tmp/env",
      managed: true,
      workspaceProvisionType: "managed-worktree",
      status: "ready",
    });

    recordEnvironmentCleanupRequest(db, noopNotifier, env.id, {
      cleanupMode: "force",
      requestedAt: 123,
    });

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

    recordEnvironmentCleanupRequest(db, noopNotifier, env.id, {
      cleanupMode: "force",
      requestedAt: 123,
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

    recordEnvironmentCleanupRequest(db, noopNotifier, env.id, {
      cleanupMode: "safe",
      requestedAt: 123,
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

  it("treats soft-deleted threads as non-live when selecting cleanup candidates", () => {
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

    recordEnvironmentCleanupRequest(db, noopNotifier, env.id, {
      cleanupMode: "force",
      requestedAt: 123,
    });

    markThreadDeleted(db, noopNotifier, { threadId: thread.id });

    const candidates = sweepManagedEnvironments(db);
    expect(candidates).toHaveLength(1);
    expect(candidates[0]!.id).toBe(env.id);
  });

  it("does not return unmanaged environments", () => {
    const { db, host, project } = setup();

    const env = createEnvironment(db, noopNotifier, {
      projectId: project.id,
      hostId: host.id,
      path: "/tmp/env",
      managed: false,
      workspaceProvisionType: "unmanaged",
      status: "ready",
    });

    recordEnvironmentCleanupRequest(db, noopNotifier, env.id, {
      cleanupMode: "force",
      requestedAt: 123,
    });

    const candidates = sweepManagedEnvironments(db);
    expect(candidates).toHaveLength(0);
  });

  it("returns destroying environments with cleanup requested so sweeps can resume destroy queueing", () => {
    const { db, host, project } = setup();

    const env = createEnvironment(db, noopNotifier, {
      projectId: project.id,
      hostId: host.id,
      path: "/tmp/env",
      managed: true,
      cleanupMode: "force",
      cleanupRequestedAt: 123,
      workspaceProvisionType: "managed-worktree",
      status: "destroying",
    });

    const candidates = sweepManagedEnvironments(db);
    expect(candidates).toHaveLength(1);
    expect(candidates[0]!.id).toBe(env.id);
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
      notifyHost: vi.fn(),
      notifyCommand: vi.fn(),
      notifyProject: vi.fn(),
      notifySystem: vi.fn(),
    };

    const result = sweepDestroyingEnvironments(db, spy, now);
    expect(result.deleted).toBe(1);
    expect(
      db
        .select()
        .from(environments)
        .all()
        .map((row) => row.id),
    ).toEqual([freshEnvironment.id]);
    expect(spy.notifyEnvironment).toHaveBeenCalledWith(staleEnvironment.id, [
      "environment-deleted",
    ]);
  });
});
