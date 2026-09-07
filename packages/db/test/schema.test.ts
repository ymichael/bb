import { eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import {
  createConnection,
  createQueuedThreadMessageId,
  createEnvironmentId,
  createEventId,
  createHostDaemonSessionId,
  createHostId,
  createProjectId,
  createPromptHistoryEntryId,
  createProjectSourceId,
  createThreadId,
  environments,
  events,
  hostDaemonSessions,
  hosts,
  migrate,
  promptHistoryEntries,
  projectSources,
  projects,
  queuedThreadMessages,
  threadDynamicContextFileStates,
  threads,
} from "../src/index.js";

interface ColumnNameRow {
  name: string;
}

function closeConnection(db: ReturnType<typeof createConnection>): void {
  db.$client.close();
}

interface TableColumnRow {
  name: string;
}

describe("db rebuild schema", () => {
  it("migrates the fresh schema into an in-memory database", () => {
    const db = createConnection(":memory:");

    expect(() => migrate(db)).not.toThrow();

    closeConnection(db);
  });

  it("does not retain the derived host daemon heartbeat column", () => {
    const db = createConnection(":memory:");
    migrate(db);

    const columnNames = db.$client
      .prepare<[], TableColumnRow>(
        "SELECT name FROM pragma_table_info('host_daemon_sessions')",
      )
      .all()
      .map((column) => column.name);

    expect(columnNames).not.toContain("last_heartbeat_at");

    closeConnection(db);
  });

  it("creates pending interactions with the canonical thread-scoped columns", () => {
    const db = createConnection(":memory:");
    migrate(db);

    const columns = db.$client
      .prepare(
        'SELECT name, lower(type) AS type, "notnull" AS "notNull", pk AS "primaryKey" FROM pragma_table_info(\'pending_interactions\')',
      )
      .all();

    expect(columns).toHaveLength(17);
    expect(columns).toEqual(
      expect.arrayContaining([
        { name: "id", type: "text", notNull: 1, primaryKey: 1 },
        { name: "thread_id", type: "text", notNull: 1, primaryKey: 0 },
        { name: "origin_kind", type: "text", notNull: 1, primaryKey: 0 },
        { name: "turn_id", type: "text", notNull: 0, primaryKey: 0 },
        { name: "provider_id", type: "text", notNull: 0, primaryKey: 0 },
        { name: "provider_thread_id", type: "text", notNull: 0, primaryKey: 0 },
        {
          name: "provider_request_id",
          type: "text",
          notNull: 0,
          primaryKey: 0,
        },
        { name: "plugin_id", type: "text", notNull: 0, primaryKey: 0 },
        { name: "renderer_id", type: "text", notNull: 0, primaryKey: 0 },
        { name: "status", type: "text", notNull: 1, primaryKey: 0 },
        { name: "payload", type: "text", notNull: 1, primaryKey: 0 },
        { name: "resolution", type: "text", notNull: 0, primaryKey: 0 },
        { name: "status_reason", type: "text", notNull: 0, primaryKey: 0 },
        { name: "created_at", type: "integer", notNull: 1, primaryKey: 0 },
        { name: "expires_at", type: "integer", notNull: 0, primaryKey: 0 },
        { name: "resolved_at", type: "integer", notNull: 0, primaryKey: 0 },
        { name: "updated_at", type: "integer", notNull: 1, primaryKey: 0 },
      ]),
    );

    closeConnection(db);
  });

  it("does not persist terminal runtime-only columns", () => {
    const db = createConnection(":memory:");
    migrate(db);

    try {
      const columnNames = db.$client
        .prepare<[], ColumnNameRow>(
          `
            SELECT name
            FROM pragma_table_info('terminal_sessions')
            ORDER BY cid
          `,
        )
        .all()
        .map((row) => row.name);

      expect(columnNames).toEqual([
        "id",
        "thread_id",
        "environment_id",
        "host_id",
        "daemon_session_id",
        "title",
        "initial_cwd",
        "cols",
        "rows",
        "status",
        "exit_code",
        "close_reason",
        "created_at",
        "updated_at",
        "last_user_input_at",
      ]);
    } finally {
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
    const threadId = createThreadId();
    const sessionId = createHostDaemonSessionId();
    const eventId = createEventId();
    const promptHistoryEntryId = createPromptHistoryEntryId();

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
    db.insert(threads)
      .values({
        id: threadId,
        projectId,
        environmentId,
        providerId: "codex",
        status: "idle",
        latestAttentionAt: now,
        createdAt: now,
        updatedAt: now,
      })
      .run();
    db.insert(threadDynamicContextFileStates)
      .values({
        threadId,
        fileKey: "manager-preferences",
        contentStatus: "present",
        contentHash: "sha256:abc",
        shownAt: now,
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
    db.insert(queuedThreadMessages)
      .values({
        id: createQueuedThreadMessageId(),
        threadId,
        content: "[]",
        model: "gpt-5",
        reasoningLevel: "medium",
        permissionMode: "full",
        serviceTier: "default",
        sortKey: "V",
        createdAt: now,
        updatedAt: now,
      })
      .run();
    db.insert(promptHistoryEntries)
      .values({
        id: promptHistoryEntryId,
        projectId,
        threadId,
        scope: "project",
        requestSequence: 1,
        input: '[{"type":"text","text":"Start thread"}]',
        createdAt: now,
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
    expect(db.select().from(events).get()).toMatchObject({
      scopeKind: "turn",
      turnId: "turn_1",
      providerThreadId: "provider-thread-1",
    });
    expect(
      db.select().from(threadDynamicContextFileStates).get(),
    ).toMatchObject({
      fileKey: "manager-preferences",
      contentStatus: "present",
      contentHash: "sha256:abc",
    });
    expect(db.select().from(promptHistoryEntries).get()).toMatchObject({
      projectId,
      scope: "project",
      threadId,
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

  it("cascades thread deletion to thread-owned rows", () => {
    const db = createConnection(":memory:");
    migrate(db);

    const now = Date.now();
    const hostId = createHostId();
    const projectId = createProjectId();
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
    db.insert(threads)
      .values({
        id: threadId,
        projectId,
        providerId: "codex",
        status: "idle",
        latestAttentionAt: now,
        createdAt: now,
        updatedAt: now,
      })
      .run();
    db.insert(threadDynamicContextFileStates)
      .values({
        threadId,
        fileKey: "manager-preferences",
        contentStatus: "present",
        contentHash: "sha256:abc",
        shownAt: now,
        createdAt: now,
        updatedAt: now,
      })
      .run();

    db.delete(threads).where(eq(threads.id, threadId)).run();

    expect(db.select().from(threadDynamicContextFileStates).all()).toHaveLength(
      0,
    );

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
    db.delete(hosts).where(eq(hosts.id, hostId)).run();

    expect(db.select().from(environments).all()).toHaveLength(0);
    expect(db.select().from(hostDaemonSessions).all()).toHaveLength(0);

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

  it("cascades thread deletion to events, prompt history, and queued messages", () => {
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
        status: "idle",
        latestAttentionAt: now,
        createdAt: now,
        updatedAt: now,
      })
      .run();
    db.insert(queuedThreadMessages)
      .values({
        id: createQueuedThreadMessageId(),
        threadId,
        content: "[]",
        model: "gpt-5",
        reasoningLevel: "medium",
        permissionMode: "full",
        serviceTier: "default",
        sortKey: "V",
        createdAt: now,
        updatedAt: now,
      })
      .run();
    db.insert(promptHistoryEntries)
      .values({
        id: createPromptHistoryEntryId(),
        projectId,
        threadId,
        scope: "thread",
        requestSequence: 1,
        input: '[{"type":"text","text":"Follow up"}]',
        createdAt: now,
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
    expect(db.select().from(promptHistoryEntries).all()).toHaveLength(0);
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
    expect(createThreadId()).toMatch(/^thr_/u);
    expect(createEventId()).toMatch(/^evt_/u);
    expect(createPromptHistoryEntryId()).toMatch(/^phist_/u);
    expect(createQueuedThreadMessageId()).toMatch(/^qmsg_/u);
    expect(createHostDaemonSessionId()).toMatch(/^hses_/u);
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
