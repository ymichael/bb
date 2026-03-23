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
      path: "/tmp/rebuild/.bb/env",
      managed: true,
      isGitRepo: true,
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
    db.insert(hostDaemonSessions).values({
      id: sessionId,
      hostId,
      instanceId: "instance-1",
      protocolVersion: 1,
      status: "connected",
      leaseExpiresAt: now + 60_000,
      createdAt: now,
      updatedAt: now,
    }).run();
    db.insert(hostDaemonCommands).values({
      id: commandId,
      hostId,
      sessionId,
      environmentId,
      threadId,
      cursor: 1,
      commandType: "workspace.status",
      payload: "{}",
      state: "queued",
      createdAt: now,
      updatedAt: now,
    }).run();
    db.insert(hostDaemonCursors).values({
      hostId,
      cursor: 1,
      updatedAt: now,
    }).run();
    db.insert(queuedThreadMessages).values({
      id: createDraftId(),
      threadId,
      input: "[]",
      createdAt: now,
    }).run();
    db.insert(events).values({
      id: eventId,
      threadId,
      environmentId,
      seq: 1,
      type: "system/error",
      data: "{\"message\":\"boom\"}",
      createdAt: now,
    }).run();

    const insertedThread = db.select().from(threads).get();
    expect(insertedThread?.environmentId).toBe(environmentId);

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
      seq: 1,
      type: "system/error",
      data: "{}",
      createdAt: now,
    }).run();

    expect(() =>
      db.insert(events).values({
        id: createEventId(),
        threadId,
        seq: 1,
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
