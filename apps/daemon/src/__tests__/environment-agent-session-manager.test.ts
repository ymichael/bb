import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { DbConnection } from "@beanbag/db";
import {
  createConnection,
  migrate,
  EnvironmentAgentSessionRepository,
  ProjectRepository,
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
  let threads: ThreadRepository;
  let sessions: EnvironmentAgentSessionRepository;
  let manager: EnvironmentAgentSessionManager;

  beforeEach(() => {
    db = createConnection(":memory:");
    migrate(db);
    sqlite = sqliteClient(db);
    projects = new ProjectRepository(db);
    threads = new ThreadRepository(db);
    sessions = new EnvironmentAgentSessionRepository(db);
    manager = new EnvironmentAgentSessionManager(sessions);
  });

  afterEach(() => {
    sqlite.close();
  });

  function createThreadId(): string {
    const project = projects.create({
      name: "daemon-session-manager-project",
      rootPath: "/tmp/daemon-session-manager-project",
    });
    return threads.create({ projectId: project.id }).id;
  }

  it("opens sessions with computed liveness deadlines and replaces active sessions", () => {
    const threadId = createThreadId();

    const first = manager.openSession({
      threadId,
      agentId: "agent-1",
      agentInstanceId: "instance-1",
      protocolVersion: 1,
      leaseTtlMs: 30_000,
      now: 1_000,
    });
    expect(first.active).toMatchObject({
      threadId,
      status: "active",
      leaseExpiresAt: 31_000,
    });

    const second = manager.openSession({
      threadId,
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
    const opened = manager.openSession({
      threadId,
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
    const overdue = manager.openSession({
      threadId,
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
});
