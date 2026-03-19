import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { DbConnection } from "../src/connection.js";
import { createConnection } from "../src/connection.js";
import {
  EnvironmentDaemonCommandRepository,
  EnvironmentDaemonCursorRepository,
  EnvironmentDaemonSessionRepository,
  EnvironmentRepository,
  ProjectRepository,
  ThreadRepository,
} from "../src/index.js";
import { migrate } from "../src/migrate.js";

interface SqliteClient {
  exec(sql: string): unknown;
  close(): void;
}

function sqliteClient(db: DbConnection): SqliteClient {
  return (db as unknown as { $client: SqliteClient }).$client;
}

describe("environment-daemon repositories", () => {
  let db: DbConnection;
  let sqlite: SqliteClient;
  let projects: ProjectRepository;
  let envs: EnvironmentRepository;
  let threads: ThreadRepository;
  let sessions: EnvironmentDaemonSessionRepository;
  let cursors: EnvironmentDaemonCursorRepository;
  let commands: EnvironmentDaemonCommandRepository;

  beforeEach(() => {
    db = createConnection(":memory:");
    migrate(db);
    sqlite = sqliteClient(db);
    projects = new ProjectRepository(db);
    envs = new EnvironmentRepository(db);
    threads = new ThreadRepository(db);
    sessions = new EnvironmentDaemonSessionRepository(db);
    cursors = new EnvironmentDaemonCursorRepository(db);
    commands = new EnvironmentDaemonCommandRepository(db);
  });

  afterEach(() => {
    sqlite.close();
  });

  function createThreadAndEnvironmentId(): { threadId: string; environmentId: string } {
    const project = projects.create({
      name: "session-test-project",
      rootPath: "/tmp/session-test-project",
    });
    const environment = envs.create({ projectId: project.id, managed: false });
    const threadId = threads.create({ projectId: project.id }).id;
    return { threadId, environmentId: environment.id };
  }

  it("creates, replaces, and heartbeats environment-daemon sessions", () => {
    const { threadId, environmentId } = createThreadAndEnvironmentId();
    const created = sessions.create({
      id: "sess-1",
      environmentId,
      agentId: "agent-1",
      agentInstanceId: "instance-1",
      protocolVersion: 1,
      workerName: "environment-daemon",
      workerVersion: "0.0.1",
      workerBuildId: "build-1",
      providerMetadata: [{ providerId: "codex", adapterVersion: "0.0.1" }],
      selectedCapabilities: {
        commands: ["thread.start", "turn.start"],
        features: ["worker_metadata", "provider_metadata"],
      },
      controlBaseUrl: "http://127.0.0.1:4310",
      controlAuthToken: "token-1",
      leaseExpiresAt: 5_000,
      now: 1_000,
    });

    expect(sessions.getActiveByEnvironmentId(environmentId, 1_000)).toMatchObject({
      id: "sess-1",
      status: "active",
      workerName: "environment-daemon",
      workerVersion: "0.0.1",
      workerBuildId: "build-1",
      providerMetadata: [{ providerId: "codex", adapterVersion: "0.0.1" }],
      selectedCapabilities: {
        commands: ["thread.start", "turn.start"],
        features: ["worker_metadata", "provider_metadata"],
      },
      controlBaseUrl: "http://127.0.0.1:4310",
      controlAuthToken: "token-1",
    });

    const touched = sessions.touchHeartbeat({
      sessionId: created.id,
      leaseExpiresAt: 10_000,
      heartbeatAt: 2_000,
    });
    expect(touched).toMatchObject({
      id: "sess-1",
      leaseExpiresAt: 10_000,
      lastHeartbeatAt: 2_000,
    });

    const replaced = sessions.replaceActiveForEnvironment({
      environmentId,
      now: 3_000,
      nextSession: {
        id: "sess-2",
        environmentId,
        agentId: "agent-1",
        agentInstanceId: "instance-2",
        protocolVersion: 1,
        workerName: "environment-daemon",
        workerVersion: "0.0.2",
        providerMetadata: [{ providerId: "pi", adapterVersion: "0.0.2" }],
        selectedCapabilities: {
          commands: ["thread.resume", "turn.start"],
          features: ["worker_metadata", "provider_metadata"],
        },
        controlBaseUrl: "http://127.0.0.1:4311",
        controlAuthToken: "token-2",
        leaseExpiresAt: 15_000,
      },
    });

    expect(replaced.replaced).toMatchObject({
      id: "sess-1",
      status: "replaced",
      closeReason: "newer_session",
      closedAt: 3_000,
    });
    expect(replaced.active).toMatchObject({
      id: "sess-2",
      status: "active",
      workerName: "environment-daemon",
      workerVersion: "0.0.2",
      providerMetadata: [{ providerId: "pi", adapterVersion: "0.0.2" }],
      selectedCapabilities: {
        commands: ["thread.resume", "turn.start"],
        features: ["worker_metadata", "provider_metadata"],
      },
      controlBaseUrl: "http://127.0.0.1:4311",
      controlAuthToken: "token-2",
    });
    expect(sessions.getActiveByEnvironmentId(environmentId, 3_000)).toMatchObject({
      id: "sess-2",
      status: "active",
    });
  });

  it("refreshes active session metadata without replacing the session row", () => {
    const { environmentId } = createThreadAndEnvironmentId();
    sessions.create({
      id: "sess-refresh",
      environmentId,
      agentId: "agent-refresh",
      agentInstanceId: "instance-refresh",
      protocolVersion: 1,
      providerMetadata: [{ providerId: "codex", adapterVersion: "0.0.1" }],
      selectedCapabilities: { commands: ["turn.run"], features: ["provider_metadata"] },
      leaseExpiresAt: 5_000,
      now: 1_000,
    });

    const refreshed = sessions.refreshActiveSession({
      sessionId: "sess-refresh",
      leaseExpiresAt: 12_000,
      updatedAt: 2_000,
      providerMetadata: [
        { providerId: "codex", adapterVersion: "0.0.1" },
        { providerId: "pi", adapterVersion: "0.0.1" },
      ],
      selectedCapabilities: {
        commands: ["turn.run", "provider.ensure"],
        features: ["provider_metadata", "worker_metadata"],
      },
      controlBaseUrl: "http://127.0.0.1:4312",
    });

    expect(refreshed).toMatchObject({
      id: "sess-refresh",
      status: "active",
      leaseExpiresAt: 12_000,
      providerMetadata: [
        { providerId: "codex", adapterVersion: "0.0.1" },
        { providerId: "pi", adapterVersion: "0.0.1" },
      ],
      selectedCapabilities: {
        commands: ["turn.run", "provider.ensure"],
        features: ["provider_metadata", "worker_metadata"],
      },
      controlBaseUrl: "http://127.0.0.1:4312",
    });
    expect(sessions.listByEnvironmentId(environmentId)).toHaveLength(1);
  });

  it("expires and closes sessions idempotently", () => {
    const { environmentId } = createThreadAndEnvironmentId();
    const created = sessions.create({
      id: "sess-expire",
      environmentId,
      agentId: "agent-expire",
      agentInstanceId: "instance-expire",
      protocolVersion: 1,
      selectedCapabilities: { commands: [], features: [] },
      leaseExpiresAt: 5_000,
      now: 1_000,
    });

    const expired = sessions.markExpired(created.id, 6_000);
    expect(expired).toMatchObject({
      id: created.id,
      status: "expired",
      closeReason: "lease_expired",
      closedAt: 6_000,
    });

    const closed = sessions.markClosed({
      sessionId: created.id,
      reason: "server_shutdown",
      now: 7_000,
    });
    expect(closed).toMatchObject({
      id: created.id,
      status: "closed",
      closeReason: "server_shutdown",
      closedAt: 7_000,
    });
  });

  it("closes all active sessions for server restart recovery", () => {
    const { environmentId: firstEnvId } = createThreadAndEnvironmentId();
    const { environmentId: secondEnvId } = createThreadAndEnvironmentId();
    sessions.create({
      id: "sess-active-1",
      environmentId: firstEnvId,
      agentId: "agent-1",
      agentInstanceId: "instance-1",
      protocolVersion: 1,
      selectedCapabilities: { commands: [], features: [] },
      leaseExpiresAt: 10_000,
      now: 1_000,
    });
    sessions.create({
      id: "sess-active-2",
      environmentId: secondEnvId,
      agentId: "agent-2",
      agentInstanceId: "instance-2",
      protocolVersion: 1,
      selectedCapabilities: { commands: [], features: [] },
      leaseExpiresAt: 10_000,
      now: 1_000,
    });

    const closedCount = sessions.closeAllActive({
      reason: "server_shutdown",
      now: 2_000,
    });

    expect(closedCount).toBe(2);
    expect(sessions.getById("sess-active-1")).toMatchObject({
      status: "closed",
      closeReason: "server_shutdown",
      closedAt: 2_000,
    });
    expect(sessions.getById("sess-active-2")).toMatchObject({
      status: "closed",
      closeReason: "server_shutdown",
      closedAt: 2_000,
    });
  });

  it("throws for invalid persisted session transport/status values", () => {
    const { environmentId } = createThreadAndEnvironmentId();
    sessions.create({
      id: "sess-invalid",
      environmentId,
      agentId: "agent-invalid",
      agentInstanceId: "instance-invalid",
      protocolVersion: 1,
      selectedCapabilities: { commands: [], features: [] },
      leaseExpiresAt: 5_000,
      now: 1_000,
    });

    sqlite.exec("UPDATE environment_daemon_sessions SET status='broken' WHERE id='sess-invalid'");

    expect(() => sessions.getById("sess-invalid")).toThrow(
      "Invalid persisted environment-daemon session status: broken",
    );
  });

  it("upserts and advances environment-daemon cursors only when contiguous", () => {
    const { threadId } = createThreadAndEnvironmentId();

    const initial = cursors.upsert(
      threadId,
      { generation: 1, sequence: 0 },
      1_000,
    );
    expect(initial).toMatchObject({
      threadId,
      generation: 1,
      sequence: 0,
      updatedAt: 1_000,
    });

    const advanced = cursors.advanceIfNext({
      threadId,
      expectedCurrent: { generation: 1, sequence: 0 },
      next: { generation: 1, sequence: 1 },
      now: 2_000,
    });
    expect(advanced).toEqual({
      advanced: true,
      cursor: expect.objectContaining({
        generation: 1,
        sequence: 1,
        updatedAt: 2_000,
      }),
    });

    const gapped = cursors.advanceIfNext({
      threadId,
      expectedCurrent: { generation: 1, sequence: 1 },
      next: { generation: 1, sequence: 3 },
      now: 3_000,
    });
    expect(gapped.advanced).toBe(false);
    expect(gapped.cursor).toMatchObject({ generation: 1, sequence: 1 });

    const nextGeneration = cursors.advanceIfNext({
      threadId,
      expectedCurrent: { generation: 1, sequence: 1 },
      next: { generation: 2, sequence: 1 },
      now: 4_000,
    });
    expect(nextGeneration).toEqual({
      advanced: true,
      cursor: expect.objectContaining({
        generation: 2,
        sequence: 1,
        updatedAt: 4_000,
      }),
    });
  });

  it("reports a missing stored cursor when expectedCurrent does not match", () => {
    const { threadId } = createThreadAndEnvironmentId();

    expect(
      cursors.advanceIfNext({
        threadId,
        expectedCurrent: { generation: 1, sequence: 0 },
        next: { generation: 1, sequence: 1 },
        now: 1_000,
      }),
    ).toEqual({
      advanced: false,
    });
    expect(cursors.getByThreadId(threadId)).toBeUndefined();
  });

  it("enqueues commands with monotonic per-thread cursors and tracks deliverable state", () => {
    const { threadId, environmentId } = createThreadAndEnvironmentId();
    sessions.create({
      id: "sess-cmd",
      environmentId,
      agentId: "agent-cmd",
      agentInstanceId: "instance-cmd",
      protocolVersion: 1,
      leaseExpiresAt: 5_000,
      now: 1_000,
    });

    const first = commands.enqueue({
      id: "cmd-1",
      threadId,
      commandType: "thread.start",
      payload: { hello: "world" },
      sessionId: "sess-cmd",
      now: 2_000,
    });
    const second = commands.enqueue({
      id: "cmd-2",
      threadId,
      commandType: "turn.start",
      payload: { input: [{ type: "text", text: "hi" }] },
      sessionId: "sess-cmd",
      now: 3_000,
    });

    expect(first.commandCursor).toBe(1);
    expect(second.commandCursor).toBe(2);
    expect(commands.getNextCursorForThread(threadId)).toBe(3);
    expect(commands.listDeliverableBySessionId("sess-cmd").map((command) => command.id)).toEqual([
      "cmd-1",
      "cmd-2",
    ]);

    expect(commands.markSent("cmd-1", 4_000)).toMatchObject({
      id: "cmd-1",
      state: "sent",
      updatedAt: 4_000,
    });
    expect(commands.markReceived("cmd-1", 5_000)).toMatchObject({
      id: "cmd-1",
      state: "received",
      updatedAt: 5_000,
    });

    expect(commands.listDeliverableBySessionId("sess-cmd").map((command) => command.id)).toEqual([
      "cmd-2",
    ]);
    expect(commands.listPendingByThreadId(threadId).map((command) => command.id)).toEqual([
      "cmd-1",
      "cmd-2",
    ]);
  });

  it("keeps received commands bound to their original session", () => {
    const { threadId, environmentId } = createThreadAndEnvironmentId();
    sessions.create({
      id: "sess-old",
      environmentId,
      agentId: "agent-cmd",
      agentInstanceId: "instance-old",
      protocolVersion: 1,
      leaseExpiresAt: 5_000,
      now: 1_000,
    });

    commands.enqueue({
      id: "cmd-received",
      threadId,
      commandType: "workspace.status",
      payload: { type: "workspace.status", threadId },
      sessionId: "sess-old",
      now: 2_000,
    });
    commands.markReceived("cmd-received", 3_000);
    sessions.create({
      id: "sess-new",
      environmentId,
      agentId: "agent-cmd",
      agentInstanceId: "instance-new",
      protocolVersion: 1,
      leaseExpiresAt: 6_000,
      now: 3_500,
    });

    expect(commands.getById("cmd-received")).toMatchObject({
      sessionId: "sess-old",
      state: "received",
      updatedAt: 3_000,
    });
    expect(commands.listDeliverableBySessionId("sess-new")).toEqual([]);
  });

  it("treats stale command transitions idempotently and rejects conflicting terminal transitions", () => {
    const { threadId } = createThreadAndEnvironmentId();
    const command = commands.enqueue({
      id: "cmd-term",
      threadId,
      commandType: "workspace.status",
      payload: {},
      now: 1_000,
    });

    expect(commands.markStarted(command.id, 2_000)).toMatchObject({
      id: command.id,
      state: "started",
      updatedAt: 2_000,
    });
    expect(
      commands.markCompleted({
        commandId: command.id,
        result: { state: "clean" },
        now: 3_000,
      }),
    ).toMatchObject({
      id: command.id,
      state: "completed",
      result: { state: "clean" },
      updatedAt: 3_000,
    });

    expect(commands.markReceived(command.id, 4_000)).toMatchObject({
      id: command.id,
      state: "completed",
      result: { state: "clean" },
      updatedAt: 3_000,
    });

    expect(() =>
      commands.markFailed({
        commandId: command.id,
        errorCode: "boom",
        errorMessage: "Should not override completed",
        now: 5_000,
      }),
    ).toThrow("Invalid environment-daemon command transition: completed -> failed");
  });

  it("throws for invalid persisted command state values", () => {
    const { threadId } = createThreadAndEnvironmentId();
    commands.enqueue({
      id: "cmd-invalid",
      threadId,
      commandType: "thread.start",
      payload: {},
      now: 1_000,
    });

    sqlite.exec(
      "UPDATE environment_daemon_commands SET state='bogus' WHERE id='cmd-invalid'",
    );

    expect(() => commands.getById("cmd-invalid")).toThrow(
      "Invalid persisted environment-daemon command state: bogus",
    );
  });
});
