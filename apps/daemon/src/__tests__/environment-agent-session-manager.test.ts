import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { DbConnection } from "@beanbag/db";
import {
  createConnection,
  EnvironmentRepository,
  migrate,
  EnvironmentAgentSessionRepository,
  ProjectRepository,
  ThreadEnvironmentAttachmentRepository,
  ThreadRepository,
} from "@beanbag/db";
import { EnvironmentAgentSessionManager } from "../environment-agent-session-manager.js";

interface SqliteClient {
  close(): void;
}

function sqliteClient(db: DbConnection): SqliteClient {
  return (db as unknown as { $client: SqliteClient }).$client;
}

describe("EnvironmentAgentSessionManager", () => {
  let db: DbConnection;
  let sqlite: SqliteClient;
  let projects: ProjectRepository;
  let environments: EnvironmentRepository;
  let threads: ThreadRepository;
  let attachments: ThreadEnvironmentAttachmentRepository;
  let sessions: EnvironmentAgentSessionRepository;
  let manager: EnvironmentAgentSessionManager;

  beforeEach(() => {
    db = createConnection(":memory:");
    migrate(db);
    sqlite = sqliteClient(db);
    projects = new ProjectRepository(db);
    environments = new EnvironmentRepository(db);
    threads = new ThreadRepository(db);
    attachments = new ThreadEnvironmentAttachmentRepository(db);
    sessions = new EnvironmentAgentSessionRepository(db);
    manager = new EnvironmentAgentSessionManager(sessions);
  });

  afterEach(() => {
    sqlite.close();
  });

  function createProject() {
    return projects.create({
      name: "daemon-session-manager-project",
      rootPath: "/tmp/daemon-session-manager-project",
    });
  }

  function createThreadId(projectId?: string): string {
    return threads.create({ projectId: projectId ?? createProject().id }).id;
  }

  function attachThreadToEnvironment(threadId: string): string {
    const thread = threads.getById(threadId);
    if (!thread) {
      throw new Error(`Missing thread ${threadId}`);
    }
    const environment = environments.create({
      projectId: thread.projectId,
      descriptor: {
        type: "path",
        path: `/tmp/daemon-session-manager-project/.worktrees/${threadId}`,
      },
      managed: true,
    });
    attachments.attachThread({ threadId, environmentId: environment.id });
    return environment.id;
  }

  it("opens sessions with computed liveness deadlines and replaces active sessions", () => {
    const threadId = createThreadId();
    const environmentId = attachThreadToEnvironment(threadId);

    const first = manager.openSession({
      threadId,
      environmentId,
      agentId: "agent-1",
      agentInstanceId: "instance-1",
      protocolVersion: 1,
      leaseTtlMs: 30_000,
      now: 1_000,
    });
    expect(first.active).toMatchObject({
      threadId,
      environmentId,
      status: "active",
      leaseExpiresAt: 31_000,
    });

    const second = manager.openSession({
      threadId,
      environmentId,
      agentId: "agent-1",
      agentInstanceId: "instance-2",
      protocolVersion: 1,
      leaseTtlMs: 45_000,
      now: 2_000,
    });
    expect(second.replaced).toMatchObject({
      id: first.active.id,
      status: "replaced",
      closeReason: "newer_session",
      closedAt: 2_000,
    });
    expect(second.active).toMatchObject({
      status: "active",
      leaseExpiresAt: 47_000,
    });
  });

  it("records heartbeats by extending the active liveness deadline", () => {
    const threadId = createThreadId();
    const environmentId = attachThreadToEnvironment(threadId);
    const opened = manager.openSession({
      threadId,
      environmentId,
      agentId: "agent-heartbeat",
      agentInstanceId: "instance-heartbeat",
      protocolVersion: 1,
      leaseTtlMs: 10_000,
      now: 1_000,
    });

    expect(
      manager.recordHeartbeat({
        sessionId: opened.active.id,
        leaseTtlMs: 20_000,
        now: 5_000,
      }),
    ).toMatchObject({
      id: opened.active.id,
      leaseExpiresAt: 25_000,
      lastHeartbeatAt: 5_000,
      updatedAt: 5_000,
    });
  });

  it("expires overdue sessions and closes sessions explicitly", () => {
    const threadId = createThreadId();
    const environmentId = attachThreadToEnvironment(threadId);
    const overdue = manager.openSession({
      threadId,
      environmentId,
      agentId: "agent-overdue",
      agentInstanceId: "instance-overdue",
      protocolVersion: 1,
      leaseTtlMs: 1_000,
      now: 1_000,
    });

    const expired = manager.expireLeases(2_001);
    expect(expired).toEqual([
      expect.objectContaining({
        id: overdue.active.id,
        status: "expired",
        closeReason: "lease_expired",
        closedAt: 2_001,
      }),
    ]);

    expect(
      manager.closeSession({
        sessionId: overdue.active.id,
        reason: "migration",
        now: 3_000,
      }),
    ).toMatchObject({
      id: overdue.active.id,
      status: "closed",
      closeReason: "migration",
      closedAt: 3_000,
    });
  });

  it("replaces the active shared session when a new env-daemon instance opens it", () => {
    const project = createProject();
    const firstThreadId = createThreadId(project.id);
    const secondThreadId = createThreadId(project.id);
    const environmentId = attachThreadToEnvironment(firstThreadId);
    attachments.attachThread({ threadId: secondThreadId, environmentId });

    const first = manager.openSession({
      threadId: firstThreadId,
      environmentId,
      agentId: "agent-shared",
      agentInstanceId: "instance-1",
      protocolVersion: 1,
      leaseTtlMs: 10_000,
      now: 1_000,
    });

    const second = manager.openSession({
      threadId: secondThreadId,
      environmentId,
      agentId: "agent-shared",
      agentInstanceId: "instance-2",
      protocolVersion: 1,
      leaseTtlMs: 10_000,
      now: 2_000,
    });

    expect(second.replaced).toMatchObject({
      id: first.active.id,
      status: "replaced",
      closeReason: "newer_session",
      threadId: firstThreadId,
    });
    expect(manager.getActiveSessionByEnvironmentId(environmentId, 2_500)).toMatchObject({
      id: second.active.id,
      threadId: secondThreadId,
      environmentId,
      status: "active",
    });
    expect(second.active).toMatchObject({
      threadId: secondThreadId,
      environmentId,
      status: "active",
    });
  });

  it("reuses the existing shared session when the same env-daemon instance reopens it", () => {
    const project = createProject();
    const firstThreadId = createThreadId(project.id);
    const secondThreadId = createThreadId(project.id);
    const environmentId = attachThreadToEnvironment(firstThreadId);
    attachments.attachThread({ threadId: secondThreadId, environmentId });

    const first = manager.openSession({
      threadId: firstThreadId,
      environmentId,
      agentId: "agent-shared",
      agentInstanceId: "instance-1",
      protocolVersion: 1,
      leaseTtlMs: 10_000,
      now: 1_000,
    });

    const second = manager.openSession({
      threadId: secondThreadId,
      environmentId,
      agentId: "agent-shared",
      agentInstanceId: "instance-1",
      protocolVersion: 1,
      leaseTtlMs: 10_000,
      now: 2_000,
    });

    expect(second.replaced).toBeUndefined();
    expect(second.active).toMatchObject({
      id: first.active.id,
      threadId: firstThreadId,
      environmentId,
      status: "active",
    });
  });
});
