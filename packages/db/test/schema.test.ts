import { eq } from "drizzle-orm";
import { describe, expect, it, vi } from "vitest";
import {
  automations,
  createConnection,
  createAutomationId,
  createDraftId,
  createEnvironmentId,
  createEnvironmentProvisioningId,
  createEventId,
  createHostDaemonCommandId,
  createHostDaemonSessionId,
  createHostId,
  createManagerThreadNudgeId,
  createProjectId,
  createProjectSourceId,
  createThreadId,
  environments,
  events,
  hostDaemonCommands,
  hostDaemonSessions,
  hosts,
  managerThreadNudges,
  migrate,
  projectSources,
  projects,
  queuedThreadMessages,
  threads,
} from "../src/index.js";

function closeConnection(db: ReturnType<typeof createConnection>): void {
  db.$client.close();
}

describe("db rebuild schema", () => {
  it("migrates the fresh schema into an in-memory database", () => {
    const db = createConnection(":memory:");

    expect(() => migrate(db)).not.toThrow();

    closeConnection(db);
  });

  it("fails migration when turn-only legacy rows are missing turn_id", () => {
    const db = createConnection(":memory:");
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    db.$client.exec(`
      CREATE TABLE events (
        id text PRIMARY KEY NOT NULL,
        thread_id text NOT NULL,
        environment_id text,
        turn_id text,
        provider_thread_id text,
        sequence integer NOT NULL,
        type text NOT NULL,
        item_id text,
        item_kind text,
        data text DEFAULT '{}' NOT NULL,
        created_at integer NOT NULL
      );
      INSERT INTO events (
        id,
        thread_id,
        environment_id,
        turn_id,
        provider_thread_id,
        sequence,
        type,
        item_id,
        item_kind,
        data,
        created_at
      )
      VALUES (
        'evt_ambiguous_turn_scope',
        'thread-1',
        NULL,
        NULL,
        'provider-thread-1',
        7,
        'item/completed',
        NULL,
        NULL,
        '{}',
        1
      );
    `);

    try {
      expect(() => migrate(db)).toThrow(
        /Cannot backfill thread event scope for 1 turn-only event row/,
      );
      expect(errorSpy).toHaveBeenCalledWith(
        "Cannot migrate thread events to explicit scope because turn-only events are missing turn_id.",
        [
          {
            id: "evt_ambiguous_turn_scope",
            sequence: 7,
            thread_id: "thread-1",
            type: "item/completed",
          },
        ],
      );
    } finally {
      errorSpy.mockRestore();
      closeConnection(db);
    }
  });

  it("enforces foreign keys across the rebuilt tables", () => {
    const db = createConnection(":memory:");
    migrate(db);

    const now = Date.now();
    const hostId = createHostId();
    const projectId = createProjectId();
    const sourceId = createProjectSourceId();
    const environmentId = createEnvironmentId();
    const automationId = createAutomationId();
    const threadId = createThreadId();
    const nudgeId = createManagerThreadNudgeId();
    const sessionId = createHostDaemonSessionId();
    const commandId = createHostDaemonCommandId();
    const eventId = createEventId();

    db.insert(hosts)
      .values({
        id: hostId,
        name: "Local host",
        type: "persistent",
        lastSeenAt: now,
        createdAt: now,
        updatedAt: now,
      })
      .run();
    db.insert(projects)
      .values({
        id: projectId,
        name: "Rebuild",
        createdAt: now,
        updatedAt: now,
      })
      .run();
    db.insert(projectSources)
      .values({
        id: sourceId,
        projectId,
        type: "local_path",
        hostId,
        path: "/tmp/rebuild",
        createdAt: now,
        updatedAt: now,
      })
      .run();
    db.insert(environments)
      .values({
        id: environmentId,
        projectId,
        hostId,
        path: null,
        managed: true,
        isGitRepo: true,
        branchName: "bb/env-1",
        workspaceProvisionType: "managed-worktree",
        status: "ready",
        createdAt: now,
        updatedAt: now,
      })
      .run();
    db.insert(automations)
      .values({
        id: automationId,
        projectId,
        name: "Daily sync",
        enabled: true,
        triggerType: "schedule",
        triggerConfig:
          '{"triggerType":"schedule","cron":"0 8 * * 1-5","timezone":"UTC"}',
        action:
          '{"actionType":"scheduled-thread","threadRequest":{"providerId":"codex","model":"gpt-5","input":[{"type":"text","text":"Run daily sync"}],"environment":{"type":"host","hostId":"host_1","workspace":{"type":"managed-clone"}}}}',
        autoArchive: false,
        nextRunAt: now + 60_000,
        runCount: 0,
        createdAt: now,
        updatedAt: now,
      })
      .run();
    db.insert(threads)
      .values({
        id: threadId,
        projectId,
        environmentId,
        automationId,
        providerId: "codex",
        type: "standard",
        status: "idle",
        latestAttentionAt: now,
        createdAt: now,
        updatedAt: now,
      })
      .run();
    db.insert(managerThreadNudges)
      .values({
        id: nudgeId,
        projectId,
        threadId,
        name: "check-async",
        cron: "0 * * * *",
        timezone: "UTC",
        enabled: true,
        nextFireAt: now + 30_000,
        createdAt: now,
        updatedAt: now,
      })
      .run();
    db.insert(hostDaemonSessions)
      .values({
        id: sessionId,
        hostId,
        instanceId: "instance-1",
        hostName: "Local host",
        hostType: "persistent",
        dataDir: "/tmp/test-data",
        protocolVersion: 1,
        heartbeatIntervalMs: 10_000,
        leaseTimeoutMs: 30_000,
        status: "connected",
        leaseExpiresAt: now + 60_000,
        createdAt: now,
        updatedAt: now,
      })
      .run();
    db.insert(hostDaemonCommands)
      .values({
        id: commandId,
        hostId,
        sessionId,
        cursor: 1,
        type: "workspace.status",
        payload: "{}",
        state: "queued",
        createdAt: now,
      })
      .run();
    db.insert(queuedThreadMessages)
      .values({
        id: createDraftId(),
        threadId,
        content: "[]",
        model: "gpt-5",
        reasoningLevel: "medium",
        permissionMode: "full",
        serviceTier: "default",
        createdAt: now,
        updatedAt: now,
      })
      .run();
    db.insert(events)
      .values({
        id: eventId,
        threadId,
        environmentId,
        scopeKind: "turn",
        turnId: "turn_1",
        providerThreadId: "provider-thread-1",
        sequence: 1,
        type: "system/error",
        data: '{"message":"boom"}',
        createdAt: now,
      })
      .run();

    const insertedThread = db.select().from(threads).get();
    expect(insertedThread?.environmentId).toBe(environmentId);
    expect(insertedThread?.automationId).toBe(automationId);
    expect(db.select().from(events).get()).toMatchObject({
      scopeKind: "turn",
      turnId: "turn_1",
      providerThreadId: "provider-thread-1",
    });
    expect(db.select().from(automations).get()).toMatchObject({
      triggerType: "schedule",
      autoArchive: false,
    });
    expect(db.select().from(managerThreadNudges).get()).toMatchObject({
      name: "check-async",
      timezone: "UTC",
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

    db.insert(hosts)
      .values({
        id: hostId,
        name: "Local host",
        type: "persistent",
        lastSeenAt: now,
        createdAt: now,
        updatedAt: now,
      })
      .run();
    db.insert(projects)
      .values({
        id: projectId,
        name: "Rebuild",
        createdAt: now,
        updatedAt: now,
      })
      .run();
    db.insert(projectSources)
      .values({
        id: sourceId,
        projectId,
        type: "local_path",
        hostId,
        path: "/tmp/rebuild",
        createdAt: now,
        updatedAt: now,
      })
      .run();

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

    db.insert(hosts)
      .values({
        id: hostId,
        name: "Local host",
        type: "persistent",
        lastSeenAt: now,
        createdAt: now,
        updatedAt: now,
      })
      .run();
    db.insert(projects)
      .values({
        id: projectId,
        name: "Rebuild",
        createdAt: now,
        updatedAt: now,
      })
      .run();
    db.insert(environments)
      .values({
        id: environmentId,
        projectId,
        hostId,
        path: "/tmp/rebuild/.bb/env",
        managed: true,
        isGitRepo: true,
        workspaceProvisionType: "managed-worktree",
        status: "ready",
        createdAt: now,
        updatedAt: now,
      })
      .run();
    db.insert(threads)
      .values({
        id: threadId,
        projectId,
        environmentId,
        providerId: "codex",
        type: "standard",
        status: "idle",
        latestAttentionAt: now,
        createdAt: now,
        updatedAt: now,
      })
      .run();

    db.delete(projects).where(eq(projects.id, projectId)).run();

    expect(db.select().from(environments).all()).toHaveLength(0);
    expect(db.select().from(threads).all()).toHaveLength(0);

    closeConnection(db);
  });

  it("sets thread automation ids to null when an automation is deleted", () => {
    const db = createConnection(":memory:");
    migrate(db);

    const now = Date.now();
    const hostId = createHostId();
    const projectId = createProjectId();
    const automationId = createAutomationId();
    const threadId = createThreadId();

    db.insert(hosts)
      .values({
        id: hostId,
        name: "Local host",
        type: "persistent",
        lastSeenAt: now,
        createdAt: now,
        updatedAt: now,
      })
      .run();
    db.insert(projects)
      .values({
        id: projectId,
        name: "Rebuild",
        createdAt: now,
        updatedAt: now,
      })
      .run();
    db.insert(automations)
      .values({
        id: automationId,
        projectId,
        name: "Daily sync",
        enabled: true,
        triggerType: "schedule",
        triggerConfig:
          '{"triggerType":"schedule","cron":"0 8 * * 1-5","timezone":"UTC"}',
        action:
          '{"actionType":"scheduled-thread","threadRequest":{"providerId":"codex","model":"gpt-5","input":[{"type":"text","text":"Run daily sync"}],"environment":{"type":"host","hostId":"host_1","workspace":{"type":"managed-clone"}}}}',
        autoArchive: false,
        nextRunAt: now + 60_000,
        runCount: 0,
        createdAt: now,
        updatedAt: now,
      })
      .run();
    db.insert(threads)
      .values({
        id: threadId,
        projectId,
        automationId,
        providerId: "codex",
        type: "standard",
        status: "idle",
        latestAttentionAt: now,
        createdAt: now,
        updatedAt: now,
      })
      .run();

    db.delete(automations).where(eq(automations.id, automationId)).run();

    expect(
      db.select().from(threads).where(eq(threads.id, threadId)).get()
        ?.automationId,
    ).toBeNull();

    closeConnection(db);
  });

  it("cascades thread deletion to manager thread nudges", () => {
    const db = createConnection(":memory:");
    migrate(db);

    const now = Date.now();
    const hostId = createHostId();
    const projectId = createProjectId();
    const threadId = createThreadId();
    const nudgeId = createManagerThreadNudgeId();

    db.insert(hosts)
      .values({
        id: hostId,
        name: "Local host",
        type: "persistent",
        lastSeenAt: now,
        createdAt: now,
        updatedAt: now,
      })
      .run();
    db.insert(projects)
      .values({
        id: projectId,
        name: "Rebuild",
        createdAt: now,
        updatedAt: now,
      })
      .run();
    db.insert(threads)
      .values({
        id: threadId,
        projectId,
        providerId: "codex",
        type: "manager",
        status: "idle",
        latestAttentionAt: now,
        createdAt: now,
        updatedAt: now,
      })
      .run();
    db.insert(managerThreadNudges)
      .values({
        id: nudgeId,
        projectId,
        threadId,
        name: "morning-check",
        cron: "0 9 * * *",
        timezone: "UTC",
        enabled: true,
        nextFireAt: now + 60_000,
        createdAt: now,
        updatedAt: now,
      })
      .run();

    db.delete(threads).where(eq(threads.id, threadId)).run();

    expect(db.select().from(managerThreadNudges).all()).toHaveLength(0);

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

    db.insert(hosts)
      .values({
        id: hostId,
        name: "Local host",
        type: "persistent",
        lastSeenAt: now,
        createdAt: now,
        updatedAt: now,
      })
      .run();
    db.insert(projects)
      .values({
        id: projectId,
        name: "Rebuild",
        createdAt: now,
        updatedAt: now,
      })
      .run();
    db.insert(environments)
      .values({
        id: environmentId,
        projectId,
        hostId,
        path: "/tmp/rebuild/.bb/env",
        managed: true,
        isGitRepo: true,
        workspaceProvisionType: "managed-worktree",
        branchName: "bb/env-1",
        status: "ready",
        createdAt: now,
        updatedAt: now,
      })
      .run();
    db.insert(hostDaemonSessions)
      .values({
        id: sessionId,
        hostId,
        instanceId: "instance-1",
        hostName: "Local host",
        hostType: "persistent",
        dataDir: "/tmp/test-data",
        protocolVersion: 1,
        heartbeatIntervalMs: 10_000,
        leaseTimeoutMs: 30_000,
        status: "connected",
        leaseExpiresAt: now + 60_000,
        createdAt: now,
        updatedAt: now,
      })
      .run();
    db.insert(hostDaemonCommands)
      .values({
        id: commandId,
        hostId,
        sessionId,
        cursor: 1,
        type: "workspace.status",
        payload: "{}",
        state: "queued",
        createdAt: now,
      })
      .run();

    // Commands reference host without cascade, so delete commands first.
    db.delete(hostDaemonCommands).run();
    db.delete(hosts).where(eq(hosts.id, hostId)).run();

    expect(db.select().from(environments).all()).toHaveLength(0);
    expect(db.select().from(hostDaemonSessions).all()).toHaveLength(0);
    expect(db.select().from(hostDaemonCommands).all()).toHaveLength(0);

    closeConnection(db);
  });

  it("nullifies session reference on host-daemon commands when session is deleted", () => {
    const db = createConnection(":memory:");
    migrate(db);

    const now = Date.now();
    const hostId = createHostId();
    const sessionId = createHostDaemonSessionId();
    const commandId = createHostDaemonCommandId();

    db.insert(hosts)
      .values({
        id: hostId,
        name: "Local host",
        type: "persistent",
        lastSeenAt: now,
        createdAt: now,
        updatedAt: now,
      })
      .run();
    db.insert(hostDaemonSessions)
      .values({
        id: sessionId,
        hostId,
        instanceId: "instance-1",
        hostName: "Local host",
        hostType: "persistent",
        dataDir: "/tmp/test-data",
        protocolVersion: 1,
        heartbeatIntervalMs: 10_000,
        leaseTimeoutMs: 30_000,
        status: "connected",
        leaseExpiresAt: now + 60_000,
        createdAt: now,
        updatedAt: now,
      })
      .run();
    db.insert(hostDaemonCommands)
      .values({
        id: commandId,
        hostId,
        sessionId,
        cursor: 1,
        type: "workspace.status",
        payload: "{}",
        state: "queued",
        createdAt: now,
      })
      .run();

    db.delete(hostDaemonSessions)
      .where(eq(hostDaemonSessions.id, sessionId))
      .run();

    const commands = db.select().from(hostDaemonCommands).all();
    expect(commands).toHaveLength(1);
    expect(commands[0]?.sessionId).toBeNull();

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

    db.insert(hosts)
      .values({
        id: hostId,
        name: "Local host",
        type: "persistent",
        lastSeenAt: now,
        createdAt: now,
        updatedAt: now,
      })
      .run();
    db.insert(projects)
      .values({
        id: projectId,
        name: "Rebuild",
        createdAt: now,
        updatedAt: now,
      })
      .run();
    db.insert(environments)
      .values({
        id: environmentId,
        projectId,
        hostId,
        path: "/tmp/rebuild/.bb/env",
        managed: true,
        isGitRepo: true,
        workspaceProvisionType: "managed-worktree",
        branchName: "bb/env-1",
        status: "ready",
        createdAt: now,
        updatedAt: now,
      })
      .run();
    db.insert(threads)
      .values({
        id: threadId,
        projectId,
        environmentId,
        providerId: "codex",
        type: "standard",
        status: "idle",
        latestAttentionAt: now,
        createdAt: now,
        updatedAt: now,
      })
      .run();
    db.insert(events)
      .values({
        id: createEventId(),
        threadId,
        scopeKind: "thread",
        environmentId,
        sequence: 1,
        type: "system/error",
        data: "{}",
        createdAt: now,
      })
      .run();

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

    db.insert(projects)
      .values({
        id: projectId,
        name: "Rebuild",
        createdAt: now,
        updatedAt: now,
      })
      .run();
    db.insert(threads)
      .values({
        id: threadId,
        projectId,
        providerId: "codex",
        type: "standard",
        status: "idle",
        latestAttentionAt: now,
        createdAt: now,
        updatedAt: now,
      })
      .run();
    db.insert(queuedThreadMessages)
      .values({
        id: createDraftId(),
        threadId,
        content: "[]",
        model: "gpt-5",
        reasoningLevel: "medium",
        permissionMode: "full",
        serviceTier: "default",
        createdAt: now,
        updatedAt: now,
      })
      .run();
    db.insert(events)
      .values({
        id: createEventId(),
        threadId,
        scopeKind: "thread",
        sequence: 1,
        type: "system/error",
        data: "{}",
        createdAt: now,
      })
      .run();

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

    db.insert(projects)
      .values({
        id: projectId,
        name: "Rebuild",
        createdAt: now,
        updatedAt: now,
      })
      .run();
    db.insert(threads)
      .values({
        id: threadId,
        projectId,
        providerId: "codex",
        type: "standard",
        status: "idle",
        latestAttentionAt: now,
        createdAt: now,
        updatedAt: now,
      })
      .run();
    db.insert(events)
      .values({
        id: createEventId(),
        threadId,
        scopeKind: "thread",
        sequence: 1,
        type: "system/error",
        data: "{}",
        createdAt: now,
      })
      .run();

    expect(() =>
      db
        .insert(events)
        .values({
          id: createEventId(),
          threadId,
          scopeKind: "thread",
          sequence: 1,
          type: "system/error",
          data: "{}",
          createdAt: now + 1,
        })
        .run(),
    ).toThrow();

    closeConnection(db);
  });

  it("generates prefixed ids for rebuild entities", () => {
    expect(createHostId()).toMatch(/^host_/u);
    expect(createProjectId()).toMatch(/^proj_/u);
    expect(createProjectSourceId()).toMatch(/^src_/u);
    expect(createEnvironmentId()).toMatch(/^env_/u);
    expect(createEnvironmentProvisioningId()).toMatch(/^epv_/u);
    expect(createThreadId()).toMatch(/^thr_/u);
    expect(createAutomationId()).toMatch(/^auto_/u);
    expect(createManagerThreadNudgeId()).toMatch(/^mnge_/u);
    expect(createEventId()).toMatch(/^evt_/u);
    expect(createDraftId()).toMatch(/^draft_/u);
    expect(createHostDaemonSessionId()).toMatch(/^hses_/u);
    expect(createHostDaemonCommandId()).toMatch(/^hcmd_/u);
  });

  it("requires a non-null data_dir on host_daemon_sessions", () => {
    const db = createConnection(":memory:");
    migrate(db);
    const hostId = createHostId();
    const now = Date.now();
    db.insert(hosts)
      .values({
        id: hostId,
        name: "host",
        type: "persistent",
        lastSeenAt: now,
        createdAt: now,
        updatedAt: now,
      })
      .run();
    expect(() =>
      db
        .insert(hostDaemonSessions)
        .values({
          id: createHostDaemonSessionId(),
          hostId,
          instanceId: "instance",
          hostName: "host",
          hostType: "persistent",
          // data_dir intentionally omitted — column is NOT NULL.
          protocolVersion: 1,
          heartbeatIntervalMs: 1_000,
          leaseTimeoutMs: 10_000,
          status: "active",
          leaseExpiresAt: now + 10_000,
          createdAt: now,
          updatedAt: now,
        } as never)
        .run(),
    ).toThrow(/NOT NULL constraint failed: host_daemon_sessions\.data_dir/);
    closeConnection(db);
  });
});
