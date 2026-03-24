import { eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import {
  createConnection,
  createDraftId,
  createEnvironmentId,
  createEventId,
  createHostDaemonCommandId,
  createHostDaemonSessionId,
  createHostId,
  createProjectId,
  createProjectSourceId,
  createThreadId,
  environments,
  events,
  hostDaemonCommands,
  hostDaemonCursors,
  hostDaemonSessions,
  hosts,
  migrate,
  projectSources,
  projects,
  queuedThreadMessages,
  threads,
} from "../src/index.js";

function closeConnection(db: ReturnType<typeof createConnection>): void {
  (db as { $client?: { close?: () => void } }).$client?.close?.();
}

describe("db rebuild schema", () => {
  it("migrates the fresh schema into an in-memory database", () => {
    const db = createConnection(":memory:");

    expect(() => migrate(db)).not.toThrow();

    closeConnection(db);
  });

  it("enforces foreign keys across the rebuilt tables", () => {
    const db = createConnection(":memory:");
    migrate(db);

    const now = Date.now();
    const hostId = createHostId();
    const projectId = createProjectId();
    const sourceId = createProjectSourceId();
    const environmentId = createEnvironmentId();
    const threadId = createThreadId();
    const sessionId = createHostDaemonSessionId();
    const commandId = createHostDaemonCommandId();
    const eventId = createEventId();

    db.insert(hosts).values({
      id: hostId,
      name: "Local host",
      type: "persistent",
      lastSeenAt: now,
      createdAt: now,
      updatedAt: now,
    }).run();
    db.insert(projects).values({
      id: projectId,
      name: "Rebuild",
      createdAt: now,
      updatedAt: now,
    }).run();
    db.insert(projectSources).values({
      id: sourceId,
      projectId,
      type: "local_path",
      hostId,
      path: "/tmp/rebuild",
      createdAt: now,
      updatedAt: now,
    }).run();
    db.insert(environments).values({
      id: environmentId,
      projectId,
      hostId,
      path: null,
      managed: true,
      isGitRepo: true,
      branchName: "bb/env-1",
      provisionerId: null,
      provisionerState: null,
      status: "ready",
      createdAt: now,
      updatedAt: now,
    }).run();
    db.insert(threads).values({
      id: threadId,
      projectId,
      environmentId,
      providerId: "codex",
      type: "standard",
      status: "idle",
      createdAt: now,
      updatedAt: now,
    }).run();
    db.insert(hostDaemonSessions).values({
      id: sessionId,
      hostId,
      instanceId: "instance-1",
      hostName: "Local host",
      hostType: "persistent",
      protocolVersion: 1,
      heartbeatIntervalMs: 10_000,
      leaseTimeoutMs: 30_000,
      status: "connected",
      leaseExpiresAt: now + 60_000,
      createdAt: now,
      updatedAt: now,
    }).run();
    db.insert(hostDaemonCommands).values({
      id: commandId,
      sessionId,
      cursor: 1,
      type: "workspace.status",
      payload: "{}",
      state: "queued",
      createdAt: now,
    }).run();
    db.insert(hostDaemonCursors).values({
      hostId,
      cursor: 1,
      updatedAt: now,
    }).run();
    db.insert(queuedThreadMessages).values({
      id: createDraftId(),
      threadId,
      content: "[]",
      mode: "auto",
      reasoningLevel: "medium",
      sandboxMode: "danger-full-access",
      createdAt: now,
      updatedAt: now,
    }).run();
    db.insert(events).values({
      id: eventId,
      threadId,
      environmentId,
      turnId: "turn_1",
      providerThreadId: "provider-thread-1",
      sequence: 1,
      type: "system/error",
      data: "{\"message\":\"boom\"}",
      createdAt: now,
    }).run();

    const insertedThread = db.select().from(threads).get();
    expect(insertedThread?.environmentId).toBe(environmentId);
    expect(db.select().from(events).get()).toMatchObject({
      turnId: "turn_1",
      providerThreadId: "provider-thread-1",
    });
    expect(db.select().from(hostDaemonCommands).get()).toMatchObject({
      sessionId,
      type: "workspace.status",
    });

    closeConnection(db);
  });

  it("cascades host deletion to host-scoped project sources", () => {
    const db = createConnection(":memory:");
    migrate(db);

    const now = Date.now();
    const hostId = createHostId();
    const projectId = createProjectId();
    const sourceId = createProjectSourceId();

    db.insert(hosts).values({
      id: hostId,
      name: "Local host",
      type: "persistent",
      lastSeenAt: now,
      createdAt: now,
      updatedAt: now,
    }).run();
    db.insert(projects).values({
      id: projectId,
      name: "Rebuild",
      createdAt: now,
      updatedAt: now,
    }).run();
    db.insert(projectSources).values({
      id: sourceId,
      projectId,
      type: "local_path",
      hostId,
      path: "/tmp/rebuild",
      createdAt: now,
      updatedAt: now,
    }).run();

    db.delete(hosts).where(eq(hosts.id, hostId)).run();

    expect(db.select().from(projectSources).all()).toHaveLength(0);

    closeConnection(db);
  });

  it("cascades project deletion to environments and threads", () => {
    const db = createConnection(":memory:");
    migrate(db);

    const now = Date.now();
    const hostId = createHostId();
    const projectId = createProjectId();
    const environmentId = createEnvironmentId();
    const threadId = createThreadId();

    db.insert(hosts).values({
      id: hostId,
      name: "Local host",
      type: "persistent",
      lastSeenAt: now,
      createdAt: now,
      updatedAt: now,
    }).run();
    db.insert(projects).values({
      id: projectId,
      name: "Rebuild",
      createdAt: now,
      updatedAt: now,
    }).run();
    db.insert(environments).values({
      id: environmentId,
      projectId,
      hostId,
      path: "/tmp/rebuild/.bb/env",
      managed: true,
      isGitRepo: true,
      provisionerId: null,
      provisionerState: null,
      status: "ready",
      createdAt: now,
      updatedAt: now,
    }).run();
    db.insert(threads).values({
      id: threadId,
      projectId,
      environmentId,
      providerId: "codex",
      type: "standard",
      status: "idle",
      createdAt: now,
      updatedAt: now,
    }).run();

    db.delete(projects).where(eq(projects.id, projectId)).run();

    expect(db.select().from(environments).all()).toHaveLength(0);
    expect(db.select().from(threads).all()).toHaveLength(0);

    closeConnection(db);
  });

  it("cascades host deletion to host-scoped records", () => {
    const db = createConnection(":memory:");
    migrate(db);

    const now = Date.now();
    const hostId = createHostId();
    const projectId = createProjectId();
    const environmentId = createEnvironmentId();
    const sessionId = createHostDaemonSessionId();
    const commandId = createHostDaemonCommandId();

    db.insert(hosts).values({
      id: hostId,
      name: "Local host",
      type: "persistent",
      lastSeenAt: now,
      createdAt: now,
      updatedAt: now,
    }).run();
    db.insert(projects).values({
      id: projectId,
      name: "Rebuild",
      createdAt: now,
      updatedAt: now,
    }).run();
    db.insert(environments).values({
      id: environmentId,
      projectId,
      hostId,
      path: "/tmp/rebuild/.bb/env",
      managed: true,
      isGitRepo: true,
      provisionerId: "worktree",
      provisionerState: "{}",
      branchName: "bb/env-1",
      status: "ready",
      createdAt: now,
      updatedAt: now,
    }).run();
    db.insert(hostDaemonSessions).values({
      id: sessionId,
      hostId,
      instanceId: "instance-1",
      hostName: "Local host",
      hostType: "persistent",
      protocolVersion: 1,
      heartbeatIntervalMs: 10_000,
      leaseTimeoutMs: 30_000,
      status: "connected",
      leaseExpiresAt: now + 60_000,
      createdAt: now,
      updatedAt: now,
    }).run();
    db.insert(hostDaemonCommands).values({
      id: commandId,
      sessionId,
      cursor: 1,
      type: "workspace.status",
      payload: "{}",
      state: "queued",
      createdAt: now,
    }).run();
    db.insert(hostDaemonCursors).values({
      hostId,
      cursor: 1,
      updatedAt: now,
    }).run();

    db.delete(hosts).where(eq(hosts.id, hostId)).run();

    expect(db.select().from(environments).all()).toHaveLength(0);
    expect(db.select().from(hostDaemonSessions).all()).toHaveLength(0);
    expect(db.select().from(hostDaemonCommands).all()).toHaveLength(0);
    expect(db.select().from(hostDaemonCursors).all()).toHaveLength(0);

    closeConnection(db);
  });

  it("cascades session deletion to host-daemon commands", () => {
    const db = createConnection(":memory:");
    migrate(db);

    const now = Date.now();
    const hostId = createHostId();
    const sessionId = createHostDaemonSessionId();
    const commandId = createHostDaemonCommandId();

    db.insert(hosts).values({
      id: hostId,
      name: "Local host",
      type: "persistent",
      lastSeenAt: now,
      createdAt: now,
      updatedAt: now,
    }).run();
    db.insert(hostDaemonSessions).values({
      id: sessionId,
      hostId,
      instanceId: "instance-1",
      hostName: "Local host",
      hostType: "persistent",
      protocolVersion: 1,
      heartbeatIntervalMs: 10_000,
      leaseTimeoutMs: 30_000,
      status: "connected",
      leaseExpiresAt: now + 60_000,
      createdAt: now,
      updatedAt: now,
    }).run();
    db.insert(hostDaemonCommands).values({
      id: commandId,
      sessionId,
      cursor: 1,
      type: "workspace.status",
      payload: "{}",
      state: "queued",
      createdAt: now,
    }).run();

    db.delete(hostDaemonSessions).where(eq(hostDaemonSessions.id, sessionId)).run();

    expect(db.select().from(hostDaemonCommands).all()).toHaveLength(0);

    closeConnection(db);
  });

  it("sets nullable environment references to null when an environment is deleted", () => {
    const db = createConnection(":memory:");
    migrate(db);

    const now = Date.now();
    const hostId = createHostId();
    const projectId = createProjectId();
    const environmentId = createEnvironmentId();
    const threadId = createThreadId();

    db.insert(hosts).values({
      id: hostId,
      name: "Local host",
      type: "persistent",
      lastSeenAt: now,
      createdAt: now,
      updatedAt: now,
    }).run();
    db.insert(projects).values({
      id: projectId,
      name: "Rebuild",
      createdAt: now,
      updatedAt: now,
    }).run();
    db.insert(environments).values({
      id: environmentId,
      projectId,
      hostId,
      path: "/tmp/rebuild/.bb/env",
      managed: true,
      isGitRepo: true,
      provisionerId: "worktree",
      provisionerState: "{}",
      branchName: "bb/env-1",
      status: "ready",
      createdAt: now,
      updatedAt: now,
    }).run();
    db.insert(threads).values({
      id: threadId,
      projectId,
      environmentId,
      providerId: "codex",
      type: "standard",
      status: "idle",
      createdAt: now,
      updatedAt: now,
    }).run();
    db.insert(events).values({
      id: createEventId(),
      threadId,
      environmentId,
      sequence: 1,
      type: "system/error",
      data: "{}",
      createdAt: now,
    }).run();

    db.delete(environments).where(eq(environments.id, environmentId)).run();

    expect(db.select().from(threads).get()?.environmentId).toBeNull();
    expect(db.select().from(events).get()?.environmentId).toBeNull();

    closeConnection(db);
  });

  it("cascades thread deletion to events and queued drafts", () => {
    const db = createConnection(":memory:");
    migrate(db);

    const now = Date.now();
    const projectId = createProjectId();
    const threadId = createThreadId();

    db.insert(projects).values({
      id: projectId,
      name: "Rebuild",
      createdAt: now,
      updatedAt: now,
    }).run();
    db.insert(threads).values({
      id: threadId,
      projectId,
      providerId: "codex",
      type: "standard",
      status: "idle",
      createdAt: now,
      updatedAt: now,
    }).run();
    db.insert(queuedThreadMessages).values({
      id: createDraftId(),
      threadId,
      content: "[]",
      mode: "auto",
      reasoningLevel: "medium",
      sandboxMode: "danger-full-access",
      createdAt: now,
      updatedAt: now,
    }).run();
    db.insert(events).values({
      id: createEventId(),
      threadId,
      sequence: 1,
      type: "system/error",
      data: "{}",
      createdAt: now,
    }).run();

    db.delete(threads).where(eq(threads.id, threadId)).run();

    expect(db.select().from(queuedThreadMessages).all()).toHaveLength(0);
    expect(db.select().from(events).all()).toHaveLength(0);

    closeConnection(db);
  });

  it("rejects duplicate event sequence numbers within a thread", () => {
    const db = createConnection(":memory:");
    migrate(db);

    const now = Date.now();
    const projectId = createProjectId();
    const threadId = createThreadId();

    db.insert(projects).values({
      id: projectId,
      name: "Rebuild",
      createdAt: now,
      updatedAt: now,
    }).run();
    db.insert(threads).values({
      id: threadId,
      projectId,
      providerId: "codex",
      type: "standard",
      status: "idle",
      createdAt: now,
      updatedAt: now,
    }).run();
    db.insert(events).values({
      id: createEventId(),
      threadId,
      sequence: 1,
      type: "system/error",
      data: "{}",
      createdAt: now,
    }).run();

    expect(() =>
      db.insert(events).values({
        id: createEventId(),
        threadId,
        sequence: 1,
        type: "system/error",
        data: "{}",
        createdAt: now + 1,
      }).run(),
    ).toThrow();

    closeConnection(db);
  });

  it("generates prefixed ids for rebuild entities", () => {
    expect(createHostId()).toMatch(/^host_/u);
    expect(createProjectId()).toMatch(/^proj_/u);
    expect(createProjectSourceId()).toMatch(/^src_/u);
    expect(createEnvironmentId()).toMatch(/^env_/u);
    expect(createThreadId()).toMatch(/^thr_/u);
    expect(createEventId()).toMatch(/^evt_/u);
    expect(createDraftId()).toMatch(/^draft_/u);
    expect(createHostDaemonSessionId()).toMatch(/^hses_/u);
    expect(createHostDaemonCommandId()).toMatch(/^hcmd_/u);
  });
});
