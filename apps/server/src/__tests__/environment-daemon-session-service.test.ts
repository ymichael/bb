import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { DbConnection } from "@bb/db";
import {
  createConnection,
  migrate,
  EnvironmentDaemonCommandRepository,
  EnvironmentDaemonCursorRepository,
  EnvironmentRepository,
  type EnvironmentDaemonSessionRecord,
  EnvironmentDaemonSessionRepository,
  ProjectRepository,
  ThreadEnvironmentAttachmentRepository,
  ThreadRepository,
} from "@bb/db";
import { vi } from "vitest";
import { createEnvironmentDaemonSessionCapabilities } from "@bb/environment-daemon";
import { EnvironmentDaemonCommandDispatcher } from "../environment-daemon-command-dispatcher.js";
import { EnvironmentDaemonEventApplier } from "../environment-daemon-event-applier.js";
import { EnvironmentDaemonSessionManager } from "../environment-daemon-session-manager.js";
import { EnvironmentDaemonSessionService } from "../environment-daemon-session-service.js";
import { isDomainError } from "../domain-errors.js";

interface SqliteClient {
  close(): void;
}

function sqliteClient(db: DbConnection): SqliteClient {
  return (db as unknown as { $client: SqliteClient }).$client;
}

const TEST_LEASE_NOW = 20_000;

describe("EnvironmentDaemonSessionService", () => {
  let db: DbConnection;
  let sqlite: SqliteClient;
  let projects: ProjectRepository;
  let threads: ThreadRepository;
  let environments: EnvironmentRepository;
  let sessions: EnvironmentDaemonSessionRepository;
  let cursors: EnvironmentDaemonCursorRepository;
  let commands: EnvironmentDaemonCommandRepository;
  let attachments: ThreadEnvironmentAttachmentRepository;
  let service: EnvironmentDaemonSessionService;
  let onSessionInvalidated: (session: EnvironmentDaemonSessionRecord) => void;

  beforeEach(() => {
    db = createConnection(":memory:");
    migrate(db);
    sqlite = sqliteClient(db);
    projects = new ProjectRepository(db);
    threads = new ThreadRepository(db);
    environments = new EnvironmentRepository(db);
    sessions = new EnvironmentDaemonSessionRepository(db);
    cursors = new EnvironmentDaemonCursorRepository(db);
    commands = new EnvironmentDaemonCommandRepository(db);
    attachments = new ThreadEnvironmentAttachmentRepository(db);
    onSessionInvalidated = vi.fn<(session: EnvironmentDaemonSessionRecord) => void>();
    service = new EnvironmentDaemonSessionService(
      new EnvironmentDaemonSessionManager(sessions),
      cursors,
      {
        leaseTtlMs: 45_000,
        heartbeatIntervalMs: 15_000,
        clock: () => TEST_LEASE_NOW,
        commandDispatcher: new EnvironmentDaemonCommandDispatcher(sessions, commands, {
          clock: () => TEST_LEASE_NOW,
          resolveEnvironmentId: (tid) => attachments.getByThreadId(tid)?.environmentId,
        }),
        eventApplier: new EnvironmentDaemonEventApplier(cursors, {
          ingestReplayedEnvironmentDaemonEvents: vi.fn(async () => undefined),
        }),
        listAttachedThreadIds: (eid) =>
          attachments.listByEnvironmentId(eid).map((a) => a.threadId),
        onSessionInvalidated,
      },
    );
  });

  afterEach(() => {
    sqlite.close();
  });

  function createTestIds(): { threadId: string; environmentId: string } {
    const project = projects.create({
      name: "server-session-service-project",
      rootPath: "/tmp/server-session-service-project",
    });
    const threadId = threads.create({ projectId: project.id }).id;
    const environmentId = environments.create({
      projectId: project.id,
      descriptor: { type: "path", path: `/tmp/server-session-service-project/.worktrees/${threadId}` },
      managed: true,
    }).id;
    attachments.attachThread({ threadId, environmentId });
    return { threadId, environmentId };
  }

  it("negotiates a session and returns a welcome payload from the server cursor", () => {
    const { threadId, environmentId } = createTestIds();
    cursors.upsert(threadId, { generation: 3, sequence: 9 }, 1_000);

    const opened = service.openSession({
      environmentId,
      now: 2_000,
      payload: {
        agentId: "agent-1",
        agentInstanceId: "instance-1",
        supportedProtocolVersions: [1],
        capabilities: createEnvironmentDaemonSessionCapabilities({
          worker: {
            name: "environment-daemon",
            version: "0.0.1",
            buildId: "build-1",
          },
          providers: [
            {
              providerId: "codex",
              adapterVersion: "0.0.1",
            },
          ],
        }),
        worker: {
          name: "environment-daemon",
          version: "0.0.1",
          buildId: "build-1",
        },
        providers: [
          {
            providerId: "codex",
            adapterVersion: "0.0.1",
          },
        ],
        channels: [
          {
            channelId: threadId,
            generation: 7,
            lastServerAcked: {
              generation: 7,
              sequence: 5,
            },
          },
        ],
      },
    });

    expect(opened.session).toMatchObject({
      environmentId,
      agentId: "agent-1",
      agentInstanceId: "instance-1",
      workerName: "environment-daemon",
      workerVersion: "0.0.1",
      workerBuildId: "build-1",
      providerMetadata: [
        {
          providerId: "codex",
          adapterVersion: "0.0.1",
        },
      ],
      selectedCapabilities: {
        commands: [
          "provider.ensure",
          "thread.start",
          "thread.resume",
          "thread.stop",
          "turn.run",
          "thread.rename",
          "provider.list_models",
          "provider.list_catalog",
          "workspace.status",
          "workspace.diff",
        ],
        features: ["worker_metadata", "provider_metadata"],
      },
      leaseExpiresAt: 47_000,
    });
    expect(opened.welcome).toMatchObject({
      protocol: "bb.env-daemon.v1",
      type: "session_welcome",
      sessionId: opened.session.id,
      sentAt: 2_000,
      payload: {
        leaseTtlMs: 45_000,
        heartbeatIntervalMs: 15_000,
        protocolVersion: 1,
        selectedCapabilities: {
          commands: [
            "provider.ensure",
            "thread.start",
            "thread.resume",
            "thread.stop",
            "turn.run",
            "thread.rename",
            "provider.list_models",
            "provider.list_catalog",
            "workspace.status",
            "workspace.diff",
          ],
          features: ["worker_metadata", "provider_metadata"],
        },
        channels: [
          {
            channelId: threadId,
            applyFrom: {
              generation: 3,
              sequenceExclusive: 9,
            },
          },
        ],
      },
    });
  });

  it("falls back to the agent bootstrap generation when the server has no cursor yet", () => {
    const { threadId, environmentId } = createTestIds();

    const opened = service.openSession({
      environmentId,
      now: 2_000,
      payload: {
        agentId: "agent-1",
        agentInstanceId: "instance-1",
        supportedProtocolVersions: [1],
        channels: [
          {
            channelId: threadId,
            generation: 5,
          },
        ],
      },
    });

    expect(opened.welcome.payload.channels).toEqual([
      {
        channelId: threadId,
        applyFrom: {
          generation: 5,
          sequenceExclusive: 0,
        },
      },
    ]);
  });

  it("rejects session bootstrap channels that are not attached to the environment", () => {
    const { environmentId } = createTestIds();
    const { threadId: detachedThreadId } = createTestIds();

    expect(() =>
      service.openSession({
        environmentId,
        now: 2_000,
        payload: {
          agentId: "agent-1",
          agentInstanceId: "instance-1",
          supportedProtocolVersions: [1],
          channels: [
            {
              channelId: detachedThreadId,
              generation: 1,
            },
          ],
        },
      }),
    ).toThrow(
      `Environment-daemon session open payload contains unattached channel ${detachedThreadId}`,
    );
  });

  it("rejects duplicate session bootstrap channels", () => {
    const { threadId, environmentId } = createTestIds();

    expect(() =>
      service.openSession({
        environmentId,
        now: 2_000,
        payload: {
          agentId: "agent-1",
          agentInstanceId: "instance-1",
          supportedProtocolVersions: [1],
          channels: [
            {
              channelId: threadId,
              generation: 1,
            },
            {
              channelId: threadId,
              generation: 2,
            },
          ],
        },
      }),
    ).toThrow("Environment-daemon session open payload contains duplicate channels");
  });

  it("accepts a session when the agent offers additional newer protocol versions", () => {
    const { threadId, environmentId } = createTestIds();

    const opened = service.openSession({
      environmentId,
      now: 2_000,
      payload: {
        agentId: "agent-1",
        agentInstanceId: "instance-1",
        supportedProtocolVersions: [3, 2, 1],
        channels: [
          {
            channelId: threadId,
            generation: 5,
          },
        ],
      },
    });

    expect(opened.session.protocolVersion).toBe(1);
    expect(opened.welcome.payload.protocolVersion).toBe(1);
  });

  it("rejects a session when there is no mutually supported protocol version", () => {
    const { threadId, environmentId } = createTestIds();

    expect(() =>
      service.openSession({
        environmentId,
        now: 2_000,
        payload: {
          agentId: "agent-1",
          agentInstanceId: "instance-1",
          supportedProtocolVersions: [3, 2],
          channels: [
            {
              channelId: threadId,
              generation: 5,
            },
          ],
        },
      }),
    ).toThrow("No compatible environment-daemon session protocol version");
  });

  it("lists only thread-owned history plus the active shared environment session", () => {
    const { threadId, environmentId } = createTestIds();
    const { threadId: siblingThreadId } = createTestIds();
    const projectId = threads.getById(threadId)?.projectId;
    if (!projectId) {
      throw new Error("Missing project for thread");
    }
    const sharedEnvironment = environments.create({
      projectId,
      descriptor: {
        type: "path",
        path: "/tmp/server-session-service-project/.worktrees/env-shared",
      },
      managed: true,
    });
    const sharedService = new EnvironmentDaemonSessionService(
      new EnvironmentDaemonSessionManager(sessions),
      cursors,
      {
        clock: () => TEST_LEASE_NOW,
        listAttachedThreadIds: (candidateEnvironmentId) =>
          candidateEnvironmentId === sharedEnvironment.id
            ? [threadId, siblingThreadId]
            : [],
      },
    );

    const ownedSession = sharedService.openSession({
      environmentId: sharedEnvironment.id,
      now: 1_000,
      payload: {
        agentId: "agent-1",
        agentInstanceId: "instance-1",
        supportedProtocolVersions: [1],
        channels: [{ channelId: threadId, generation: 1 }],
      },
    }).session;
    sharedService.closeSession({
      environmentId: sharedEnvironment.id,
      sessionId: ownedSession.id,
      reason: "agent_shutdown",
      now: 2_000,
    });

    const siblingSession = sharedService.openSession({
      environmentId: sharedEnvironment.id,
      now: 3_000,
      payload: {
        agentId: "agent-2",
        agentInstanceId: "instance-2",
        supportedProtocolVersions: [1],
        channels: [{ channelId: siblingThreadId, generation: 1 }],
      },
    }).session;

    expect(sharedService.listSessions(sharedEnvironment.id)).toMatchObject([
      { id: siblingSession.id, environmentId: sharedEnvironment.id, status: "active" },
      { id: ownedSession.id, environmentId: sharedEnvironment.id, status: "closed" },
    ]);
  });

  it("accepts heartbeats from sibling routes for a shared environment session", () => {
    const project = projects.create({
      name: "server-session-service-shared-project",
      rootPath: "/tmp/server-session-service-shared-project",
    });
    const firstThreadId = threads.create({ projectId: project.id }).id;
    const secondThreadId = threads.create({ projectId: project.id }).id;
    const environmentId = environments.create({
      projectId: project.id,
      descriptor: {
        type: "path",
        path: "/tmp/server-session-service-shared-project/.worktrees/shared",
      },
      managed: true,
    }).id;
    const attachmentsByThreadId = new Map([
      [firstThreadId, environmentId],
      [secondThreadId, environmentId],
    ]);
    const sharedService = new EnvironmentDaemonSessionService(
      new EnvironmentDaemonSessionManager(sessions),
      cursors,
      {
        listAttachedThreadIds: (candidateEnvironmentId) =>
          candidateEnvironmentId === environmentId
            ? [firstThreadId, secondThreadId]
            : [],
      },
    );

    const opened = sharedService.openSession({
      environmentId,
      payload: {
        agentId: "agent-shared",
        agentInstanceId: "instance-1",
        supportedProtocolVersions: [1],
        channels: [{ channelId: firstThreadId, generation: 1 }],
      },
      now: 1_000,
    });

    expect(
      sharedService.recordHeartbeat({
        environmentId,
        sessionId: opened.session.id,
        payload: {
          agentObservedAt: 2_000,
          outboxDepth: 0,
          channels: [],
        },
        now: 2_000,
      }),
    ).toMatchObject({
      id: opened.session.id,
      environmentId,
      status: "active",
      leaseExpiresAt: expect.any(Number),
    });
  });

  it("does not apply a single-channel afterCursor to shared environment sessions", () => {
    const { threadId, environmentId } = createTestIds();
    const { threadId: siblingThreadId } = createTestIds();
    const projectId = threads.getById(threadId)?.projectId;
    if (!projectId) {
      throw new Error("Missing project for thread");
    }
    const sharedEnvironment = environments.create({
      projectId,
      descriptor: {
        type: "path",
        path: "/tmp/server-session-service-project/.worktrees/env-shared",
      },
      managed: true,
    });
    const sharedService = new EnvironmentDaemonSessionService(
      new EnvironmentDaemonSessionManager(sessions),
      cursors,
      {
        clock: () => TEST_LEASE_NOW,
        commandDispatcher: new EnvironmentDaemonCommandDispatcher(sessions, commands, {
          clock: () => TEST_LEASE_NOW,
          resolveEnvironmentId: (candidateThreadId) =>
            candidateThreadId === threadId || candidateThreadId === siblingThreadId
              ? sharedEnvironment.id
              : undefined,
        }),
        listAttachedThreadIds: (candidateEnvironmentId) =>
          candidateEnvironmentId === sharedEnvironment.id
            ? [threadId, siblingThreadId]
            : [],
      },
    );

    const opened = sharedService.openSession({
      environmentId: sharedEnvironment.id,
      now: 1_000,
      payload: {
        agentId: "agent-1",
        agentInstanceId: "instance-1",
        supportedProtocolVersions: [1],
        channels: [{ channelId: threadId, generation: 1 }],
      },
    }).session;

    commands.enqueue({
      id: "cmd-thread-1",
      threadId,
      sessionId: opened.id,
      commandType: "provider.ensure",
      payload: { initialize: null, command: "codex", args: ["exec"] },
      now: 1_500,
    });
    commands.enqueue({
      id: "cmd-thread-2",
      threadId: siblingThreadId,
      sessionId: opened.id,
      commandType: "provider.ensure",
      payload: { initialize: null, command: "codex", args: ["exec"] },
      now: 1_600,
    });

    const listed = sharedService.listCommands({
      environmentId: sharedEnvironment.id,
      sessionId: opened.id,
      afterCursor: 99,
      limit: 50,
      now: 2_000,
    });

    expect(listed.payload.commands).toEqual([
      expect.objectContaining({
        channelId: threadId,
        commandId: "cmd-thread-1",
      }),
      expect.objectContaining({
        channelId: siblingThreadId,
        commandId: "cmd-thread-2",
      }),
    ]);
  });

  it("applies afterCursor for single-channel sessions", () => {
    const { threadId, environmentId } = createTestIds();
    const opened = service.openSession({
      environmentId,
      now: 1_000,
      payload: {
        agentId: "agent-1",
        agentInstanceId: "instance-1",
        supportedProtocolVersions: [1],
        channels: [{ channelId: threadId, generation: 1 }],
      },
    }).session;

    const first = commands.enqueue({
      id: "cmd-1",
      threadId,
      sessionId: opened.id,
      commandType: "provider.ensure",
      payload: { initialize: null, command: "codex", args: ["exec"] },
      now: 1_500,
    });
    const second = commands.enqueue({
      id: "cmd-2",
      threadId,
      sessionId: opened.id,
      commandType: "provider.ensure",
      payload: { initialize: null, command: "codex", args: ["exec"] },
      now: 1_600,
    });

    const listed = service.listCommands({
      environmentId,
      sessionId: opened.id,
      afterCursor: first.commandCursor,
      limit: 50,
      now: 2_000,
    });

    expect(listed.payload.commands).toEqual([
      expect.objectContaining({
        channelId: threadId,
        commandId: second.id,
        commandCursor: second.commandCursor,
      }),
    ]);
  });

  it("resets a stale server cursor when a fresh agent opens without lastServerAcked", async () => {
    const { threadId, environmentId } = createTestIds();
    cursors.upsert(threadId, { generation: 3, sequence: 9 }, 1_000);

    const opened = service.openSession({
      environmentId,
      now: 2_000,
      payload: {
        agentId: "agent-1",
        agentInstanceId: "instance-1",
        supportedProtocolVersions: [1],
        channels: [
          {
            channelId: threadId,
            generation: 1,
          },
        ],
      },
    });

    expect(opened.welcome.payload.channels).toEqual([
      {
        channelId: threadId,
        applyFrom: {
          generation: 1,
          sequenceExclusive: 0,
        },
      },
    ]);
    expect(cursors.getByThreadId(threadId)).toBeUndefined();

    const ack = await service.applyEventBatch({
      environmentId,
      sessionId: opened.session.id,
      now: 3_000,
      payload: {
        batches: [
          {
            channelId: threadId,
            generation: 1,
            events: [
              {
                sequence: 1,
                eventId: "evt-1",
                emittedAt: 2_500,
                event: {
                  type: "provider.stderr",
                  threadId,
                  line: "stderr 1",
                },
              },
            ],
          },
        ],
      },
    });

    expect(ack).toMatchObject({
      type: "event_ack",
      payload: {
        channels: [
          {
            channelId: threadId,
            ackedThrough: {
              generation: 1,
              sequence: 1,
            },
          },
        ],
      },
    });
    expect(cursors.getByThreadId(threadId)).toMatchObject({
      generation: 1,
      sequence: 1,
    });
  });

  it("replaces active sessions and rejects unsupported opens", () => {
    const { threadId, environmentId } = createTestIds();
    const first = service.openSession({
      environmentId,
      now: 1_000,
      payload: {
        agentId: "agent-1",
        agentInstanceId: "instance-1",
        supportedProtocolVersions: [1],
        channels: [
          {
            channelId: threadId,
            generation: 1,
          },
        ],
      },
    });

    const second = service.openSession({
      environmentId,
      now: 2_000,
      payload: {
        agentId: "agent-1",
        agentInstanceId: "instance-2",
        supportedProtocolVersions: [1],
        channels: [
          {
            channelId: threadId,
            generation: 1,
          },
        ],
      },
    });
    expect(second.replaced).toMatchObject({
      id: first.session.id,
      status: "replaced",
      closeReason: "newer_session",
    });

    expect(() =>
      service.openSession({
        environmentId,
        payload: {
          agentId: "agent-1",
          agentInstanceId: "instance-3",
          supportedProtocolVersions: [99],
          channels: [
            {
              channelId: threadId,
              generation: 1,
            },
          ],
        },
      }),
    ).toThrow("No compatible environment-daemon session protocol version");

  });

  it("fails pending queued commands when a newer session replaces them", () => {
    const { threadId, environmentId } = createTestIds();
    const first = service.openSession({
      environmentId,
      now: 1_000,
      payload: {
        agentId: "agent-1",
        agentInstanceId: "instance-1",
        supportedProtocolVersions: [1],
        channels: [
          {
            channelId: threadId,
            generation: 1,
          },
        ],
      },
    });

    commands.enqueue({
      id: "cmd-queued",
      threadId,
      sessionId: first.session.id,
      commandType: "workspace.status",
      payload: {
        type: "workspace.status",
        threadId,
      },
      now: 1_500,
    });

    const second = service.openSession({
      environmentId,
      now: 2_000,
      payload: {
        agentId: "agent-1",
        agentInstanceId: "instance-2",
        supportedProtocolVersions: [1],
        channels: [
          {
            channelId: threadId,
            generation: 1,
          },
        ],
      },
    });

    expect(second.replaced?.id).toBe(first.session.id);
    expect(commands.getById("cmd-queued")).toMatchObject({
      sessionId: first.session.id,
      state: "failed",
      errorCode: "provider_unavailable",
    });
  });

  it("fails received and started commands when a newer session replaces them", () => {
    const { threadId, environmentId } = createTestIds();
    const first = service.openSession({
      environmentId,
      now: 1_000,
      payload: {
        agentId: "agent-1",
        agentInstanceId: "instance-1",
        supportedProtocolVersions: [1],
        channels: [
          {
            channelId: threadId,
            generation: 1,
          },
        ],
      },
    });

    commands.enqueue({
      id: "cmd-received",
      threadId,
      sessionId: first.session.id,
      commandType: "workspace.status",
      payload: {
        type: "workspace.status",
        threadId,
      },
      now: 1_100,
    });
    commands.markReceived("cmd-received", 1_150);

    commands.enqueue({
      id: "cmd-started",
      threadId,
      sessionId: first.session.id,
      commandType: "thread.resume",
      payload: {
        type: "thread.resume",
        threadId,
        providerThreadId: "provider-thread-1",
      },
      now: 1_200,
    });
    commands.markStarted("cmd-started", 1_250);

    const second = service.openSession({
      environmentId,
      now: 2_000,
      payload: {
        agentId: "agent-1",
        agentInstanceId: "instance-2",
        supportedProtocolVersions: [1],
        channels: [
          {
            channelId: threadId,
            generation: 1,
          },
        ],
      },
    });

    expect(second.replaced?.id).toBe(first.session.id);
    expect(commands.getById("cmd-received")).toMatchObject({
      sessionId: first.session.id,
      state: "failed",
      errorCode: "provider_unavailable",
    });
    expect(commands.getById("cmd-started")).toMatchObject({
      sessionId: first.session.id,
      state: "failed",
      errorCode: "provider_unavailable",
      errorMessage:
        `Environment-daemon session ${first.session.id} closed (newer_session) while command execution was in progress`,
    });
  });

  it("handles provider requests through the configured handler", async () => {
    const { threadId, environmentId } = createTestIds();
    const serviceWithProviderRequests = new EnvironmentDaemonSessionService(
      new EnvironmentDaemonSessionManager(sessions),
      cursors,
      {
        leaseTtlMs: 45_000,
        heartbeatIntervalMs: 15_000,
        clock: () => TEST_LEASE_NOW,
        listAttachedThreadIds: (eid) =>
          attachments.listByEnvironmentId(eid).map((a) => a.threadId),
        providerRequestHandler: vi.fn(async ({ threadId: requestThreadId, request }) => ({
          result: {
            threadId: requestThreadId,
            requestId: request.requestId,
            echoedMethod: request.method,
          },
        })),
      },
    );
    const opened = serviceWithProviderRequests.openSession({
      environmentId,
      now: 1_000,
      payload: {
        agentId: "agent-1",
        agentInstanceId: "instance-1",
        supportedProtocolVersions: [1],
        channels: [
          {
            channelId: threadId,
            generation: 1,
          },
        ],
      },
    });

    const response = await serviceWithProviderRequests.handleProviderRequest({
      environmentId,
      sessionId: opened.session.id,
      now: 2_000,
      payload: {
        requestId: 61,
        method: "item/tool/call",
        params: { tool: "echo_test_tool" },
        channelId: threadId,
      },
    });

    expect(response).toMatchObject({
      type: "provider_response",
      sessionId: opened.session.id,
      payload: {
        requestId: 61,
        ok: true,
        result: {
          threadId,
          requestId: 61,
          echoedMethod: "item/tool/call",
        },
      },
    });
  });

  it("wraps thrown provider request errors into provider responses", async () => {
    const { threadId, environmentId } = createTestIds();
    const serviceWithProviderRequests = new EnvironmentDaemonSessionService(
      new EnvironmentDaemonSessionManager(sessions),
      cursors,
      {
        leaseTtlMs: 45_000,
        heartbeatIntervalMs: 15_000,
        clock: () => TEST_LEASE_NOW,
        listAttachedThreadIds: (eid) =>
          attachments.listByEnvironmentId(eid).map((a) => a.threadId),
        providerRequestHandler: vi.fn(async () => {
          throw new Error("tool host unavailable");
        }),
      },
    );
    const opened = serviceWithProviderRequests.openSession({
      environmentId,
      now: 1_000,
      payload: {
        agentId: "agent-1",
        agentInstanceId: "instance-1",
        supportedProtocolVersions: [1],
        channels: [
          {
            channelId: threadId,
            generation: 1,
          },
        ],
      },
    });

    const response = await serviceWithProviderRequests.handleProviderRequest({
      environmentId,
      sessionId: opened.session.id,
      now: 2_000,
      payload: {
        requestId: "req-1",
        method: "item/tool/call",
        channelId: threadId,
      },
    });

    expect(response).toMatchObject({
      type: "provider_response",
      sessionId: opened.session.id,
      payload: {
        requestId: "req-1",
        ok: false,
        errorMessage: "tool host unavailable",
      },
    });
  });

  it("returns typed tool-call responses from the provider request handler", async () => {
    const { threadId, environmentId } = createTestIds();
    const serviceWithProviderRequests = new EnvironmentDaemonSessionService(
      new EnvironmentDaemonSessionManager(sessions),
      cursors,
      {
        leaseTtlMs: 45_000,
        heartbeatIntervalMs: 15_000,
        clock: () => TEST_LEASE_NOW,
        listAttachedThreadIds: (eid) =>
          attachments.listByEnvironmentId(eid).map((a) => a.threadId),
        providerRequestHandler: vi.fn(async () => ({
          toolCallResponse: {
            contentItems: [{ type: "inputText", text: "ok" } as const],
            success: true,
          },
        })),
      },
    );
    const opened = serviceWithProviderRequests.openSession({
      environmentId,
      now: 1_000,
      payload: {
        agentId: "agent-1",
        agentInstanceId: "instance-1",
        supportedProtocolVersions: [1],
        channels: [{ channelId: threadId, generation: 1 }],
      },
    });

    const response = await serviceWithProviderRequests.handleProviderRequest({
      environmentId,
      sessionId: opened.session.id,
      now: 2_000,
      payload: {
        requestId: 62,
        method: "item/tool/call",
        channelId: threadId,
        toolCall: {
          requestId: 62,
          threadId,
          turnId: "turn-1",
          callId: "call-1",
          tool: "echo_test_tool",
          arguments: { message: "hi" },
        },
      },
    });

    expect(response).toMatchObject({
      type: "provider_response",
      sessionId: opened.session.id,
      payload: {
        requestId: 62,
        ok: true,
        toolCallResponse: {
          success: true,
          contentItems: [{ type: "inputText", text: "ok" }],
        },
      },
    });
  });

  it("applies event batches and resets the agent cursor when the server detects a gap", async () => {
    const { threadId, environmentId } = createTestIds();
    const opened = service.openSession({
      environmentId,
      now: 1_000,
      payload: {
        agentId: "agent-1",
        agentInstanceId: "instance-1",
        supportedProtocolVersions: [1],
        channels: [
          {
            channelId: threadId,
            generation: 2,
          },
        ],
      },
    });

    const ack = await service.applyEventBatch({
      environmentId,
      sessionId: opened.session.id,
      now: 2_000,
      payload: {
        batches: [
          {
            channelId: threadId,
            generation: 2,
            events: [
              {
                sequence: 0,
                eventId: "evt-0",
                emittedAt: 1_500,
                event: {
                  type: "provider.stderr",
                  threadId,
                  line: "stderr 0",
                },
              },
            ],
          },
        ],
      },
    });

    expect(ack).toMatchObject({
      type: "event_ack",
      sessionId: opened.session.id,
      payload: {
        channels: [
          {
            channelId: threadId,
            ackedThrough: {
              generation: 2,
              sequence: 0,
            },
          },
        ],
      },
    });

    const replayAck = await service.applyEventBatch({
      environmentId,
      sessionId: opened.session.id,
      now: 3_000,
      payload: {
        batches: [
          {
            channelId: threadId,
            generation: 2,
            events: [
              {
                sequence: 2,
                eventId: "evt-2",
                emittedAt: 2_500,
                event: {
                  type: "provider.stderr",
                  threadId,
                  line: "stderr 2",
                },
              },
            ],
          },
        ],
      },
    });

    expect(replayAck).toMatchObject({
      type: "event_ack",
      sessionId: opened.session.id,
      payload: {
        channels: [
          {
            channelId: threadId,
            ackedThrough: {
              generation: 2,
              sequence: 0,
            },
          },
        ],
      },
    });
  });

  it("expires overdue leases", () => {
    const { threadId, environmentId } = createTestIds();
    const opened = service.openSession({
      environmentId,
      now: 1_000,
      payload: {
        agentId: "agent-1",
        agentInstanceId: "instance-1",
        supportedProtocolVersions: [1],
        channels: [
          {
            channelId: threadId,
            generation: 1,
          },
        ],
      },
    });

    expect(service.expireLeases(60_000)).toEqual([
      expect.objectContaining({
        id: opened.session.id,
        status: "expired",
        closeReason: "lease_expired",
      }),
    ]);
    expect(onSessionInvalidated).toHaveBeenCalledWith(
      expect.objectContaining({
        id: opened.session.id,
        environmentId,
        closeReason: "lease_expired",
      }),
    );
  });

  it("fails started commands when a lease expires", () => {
    const { threadId, environmentId } = createTestIds();
    const opened = service.openSession({
      environmentId,
      now: 1_000,
      payload: {
        agentId: "agent-1",
        agentInstanceId: "instance-1",
        supportedProtocolVersions: [1],
        channels: [
          {
            channelId: threadId,
            generation: 1,
          },
        ],
      },
    });

    commands.enqueue({
      id: "cmd-started",
      threadId,
      sessionId: opened.session.id,
      commandType: "thread.resume",
      payload: {
        type: "thread.resume",
        threadId,
        providerThreadId: "provider-thread-1",
      },
      now: 1_100,
    });
    commands.markStarted("cmd-started", 1_150);

    service.expireLeases(60_000);

    expect(commands.getById("cmd-started")).toMatchObject({
      sessionId: opened.session.id,
      state: "failed",
      errorCode: "provider_unavailable",
      errorMessage:
        `Environment-daemon session ${opened.session.id} closed (lease_expired) while command execution was in progress`,
    });
  });

  it("closes active sessions explicitly", () => {
    const { threadId, environmentId } = createTestIds();
    const opened = service.openSession({
      environmentId,
      now: 1_000,
      payload: {
        agentId: "agent-1",
        agentInstanceId: "instance-1",
        supportedProtocolVersions: [1],
        channels: [
          {
            channelId: threadId,
            generation: 1,
          },
        ],
      },
    });

    expect(
      service.closeSession({
        environmentId,
        sessionId: opened.session.id,
        reason: "agent_shutdown",
        now: 2_000,
      }),
    ).toMatchObject({
      id: opened.session.id,
      status: "closed",
      closeReason: "agent_shutdown",
      closedAt: 2_000,
    });
    expect(onSessionInvalidated).toHaveBeenCalledWith(
      expect.objectContaining({
        id: opened.session.id,
        environmentId,
        closeReason: "agent_shutdown",
      }),
    );
  });

  it("retires the active session without triggering invalidation callbacks", () => {
    const { threadId, environmentId } = createTestIds();
    const opened = service.openSession({
      environmentId,
      now: 1_000,
      payload: {
        agentId: "agent-1",
        agentInstanceId: "instance-1",
        supportedProtocolVersions: [1],
        channels: [
          {
            channelId: threadId,
            generation: 1,
          },
        ],
      },
    });

    const retired = service.retireActiveSessionForEnvironment({
      environmentId,
      reason: "migration",
      now: 2_000,
    });

    expect(retired).toMatchObject({
      id: opened.session.id,
      status: "closed",
      closeReason: "migration",
      closedAt: 2_000,
    });
    expect(onSessionInvalidated).not.toHaveBeenCalled();
  });

  it("invalidates replaced sessions when a newer session opens", () => {
    const { threadId, environmentId } = createTestIds();
    const first = service.openSession({
      environmentId,
      now: 1_000,
      payload: {
        agentId: "agent-1",
        agentInstanceId: "instance-1",
        supportedProtocolVersions: [1],
        channels: [
          {
            channelId: threadId,
            generation: 1,
          },
        ],
      },
    });

    const second = service.openSession({
      environmentId,
      now: 2_000,
      payload: {
        agentId: "agent-1",
        agentInstanceId: "instance-2",
        supportedProtocolVersions: [1],
        channels: [
          {
            channelId: threadId,
            generation: 2,
          },
        ],
      },
    });

    expect(second.replaced).toMatchObject({
      id: first.session.id,
      status: "replaced",
      closeReason: "newer_session",
    });
    expect(onSessionInvalidated).toHaveBeenCalledWith(
      expect.objectContaining({
        id: first.session.id,
        environmentId,
        closeReason: "newer_session",
      }),
    );
  });

  it("records command acknowledgements and command results for the active session", () => {
    const { threadId, environmentId } = createTestIds();
    const opened = service.openSession({
      environmentId,
      now: 1_000,
      payload: {
        agentId: "agent-1",
        agentInstanceId: "instance-1",
        supportedProtocolVersions: [1],
        channels: [
          {
            channelId: threadId,
            generation: 1,
          },
        ],
      },
    });
    commands.enqueue({
      id: "cmd-1",
      threadId,
      sessionId: opened.session.id,
      commandType: "workspace.status",
      payload: { type: "workspace.status", threadId },
      now: 1_500,
    });

    service.recordCommandAck({
      environmentId,
      sessionId: opened.session.id,
      now: 2_000,
      payload: {
        commands: [
          {
            commandId: "cmd-1",
            channelId: threadId,
            state: "received",
          },
        ],
      },
    });
    expect(commands.getById("cmd-1")).toMatchObject({ state: "received" });

    service.recordCommandResult({
      environmentId,
      sessionId: opened.session.id,
      now: 3_000,
      payload: {
        commandId: "cmd-1",
        channelId: threadId,
        state: "completed",
        result: { ok: true },
      },
    });
    expect(commands.getById("cmd-1")).toMatchObject({
      state: "completed",
      result: { ok: true },
    });
  });

  it("extends active session leases on heartbeat and rejects mismatched sessions", () => {
    const { threadId, environmentId } = createTestIds();
    const opened = service.openSession({
      environmentId,
      now: 1_000,
      payload: {
        agentId: "agent-1",
        agentInstanceId: "instance-1",
        supportedProtocolVersions: [1],
        channels: [
          {
            channelId: threadId,
            generation: 1,
          },
        ],
      },
    });

    expect(
      service.recordHeartbeat({
        environmentId,
        sessionId: opened.session.id,
        now: 2_000,
        payload: {
          agentObservedAt: 2_000,
          outboxDepth: 0,
          channels: [{ channelId: threadId }],
        },
      }),
    ).toMatchObject({
      id: opened.session.id,
      environmentId,
      lastHeartbeatAt: 2_000,
      leaseExpiresAt: 47_000,
      status: "active",
    });

    const { environmentId: otherEnvironmentId } = createTestIds();
    expect(() =>
      service.recordHeartbeat({
        environmentId: otherEnvironmentId,
        sessionId: opened.session.id,
        now: 3_000,
        payload: {
          agentObservedAt: 3_000,
          outboxDepth: 0,
          channels: [{ channelId: otherEnvironmentId }],
        },
      }),
    ).toThrow(
      `Environment-daemon session ${opened.session.id} does not belong to environment ${otherEnvironmentId}`,
    );
  });

  it("treats heartbeats for expired sessions as inactive-session domain errors", () => {
    const { threadId, environmentId } = createTestIds();
    const opened = service.openSession({
      environmentId,
      now: 1_000,
      payload: {
        agentId: "agent-1",
        agentInstanceId: "instance-1",
        supportedProtocolVersions: [1],
        channels: [
          {
            channelId: threadId,
            generation: 1,
          },
        ],
      },
    });

    service.expireLeases(60_000);

    let captured: unknown;
    try {
      service.recordHeartbeat({
        environmentId,
        sessionId: opened.session.id,
        now: 61_000,
        payload: {
          agentObservedAt: 61_000,
          outboxDepth: 0,
          channels: [{ channelId: threadId }],
        },
      });
    } catch (error) {
      captured = error;
    }

    expect(isDomainError(captured)).toBe(true);
    expect(captured).toMatchObject({
      code: "inactive_session",
      message: `Environment-daemon session ${opened.session.id} is not active`,
    });
  });

  it("treats elapsed leases as inactive before the lease sweeper runs", () => {
    const now = TEST_LEASE_NOW;
    const { threadId, environmentId } = createTestIds();
    const opened = service.openSession({
      environmentId,
      now: now - 50_000,
      payload: {
        agentId: "agent-1",
        agentInstanceId: "instance-1",
        supportedProtocolVersions: [1],
        channels: [
          {
            channelId: threadId,
            generation: 1,
          },
        ],
      },
    });

    let captured: unknown;
    try {
      service.recordHeartbeat({
        environmentId,
        sessionId: opened.session.id,
        now,
        payload: {
          agentObservedAt: now,
          outboxDepth: 0,
          channels: [{ channelId: threadId }],
        },
      });
    } catch (error) {
      captured = error;
    }

    expect(isDomainError(captured)).toBe(true);
    expect(captured).toMatchObject({
      code: "inactive_session",
      message: `Environment-daemon session ${opened.session.id} is not active`,
    });
    expect(sessions.getById(opened.session.id)).toMatchObject({
      status: "active",
      leaseExpiresAt: now - 5_000,
    });
  });

  it("lists deliverable commands as a command_batch protocol message", () => {
    const { threadId, environmentId } = createTestIds();
    const opened = service.openSession({
      environmentId,
      now: 1_000,
      payload: {
        agentId: "agent-1",
        agentInstanceId: "instance-1",
        supportedProtocolVersions: [1],
        channels: [
          {
            channelId: threadId,
            generation: 1,
          },
        ],
      },
    });

    commands.enqueue({
      id: "cmd-1",
      threadId,
      sessionId: opened.session.id,
      commandType: "thread.start",
      payload: {
        threadId,
        projectId: "project-1",
        request: { projectId: "project-1", input: [{ type: "text", text: "hello" }] },
        context: { projectId: "project-1", threadId, path: `/tmp/${threadId}` },
      },
      now: 2_000,
    });

    expect(
      service.listCommands({
        environmentId,
        sessionId: opened.session.id,
        now: 3_000,
      }),
    ).toMatchObject({
      protocol: "bb.env-daemon.v1",
      type: "command_batch",
      sessionId: opened.session.id,
      sentAt: 3_000,
      payload: {
        commands: [
          {
            channelId: threadId,
            commandCursor: 1,
            commandId: "cmd-1",
            command: {
              type: "thread.start",
              threadId,
              projectId: "project-1",
              request: { projectId: "project-1", input: [{ type: "text", text: "hello" }] },
              context: { projectId: "project-1", threadId, path: `/tmp/${threadId}` },
            },
          },
        ],
      },
    });
  });

  it("waits for commands before returning from long-poll", async () => {
    vi.useFakeTimers();
    try {
      const { threadId, environmentId } = createTestIds();
      const opened = service.openSession({
        environmentId,
        now: 1_000,
        payload: {
          agentId: "agent-1",
          agentInstanceId: "instance-1",
          supportedProtocolVersions: [1],
          channels: [
            {
              channelId: threadId,
              generation: 1,
            },
          ],
        },
      });

      const waitPromise = service.waitForCommands({
        environmentId,
        sessionId: opened.session.id,
        waitMs: 100,
      });

      setTimeout(() => {
        commands.enqueue({
          id: "cmd-2",
          threadId,
          sessionId: opened.session.id,
          commandType: "thread.start",
          payload: {
            type: "thread.start",
            threadId,
            projectId: "project-1",
            request: { projectId: "project-1", input: [{ type: "text", text: "hello" }] },
            context: { projectId: "project-1", threadId, path: `/tmp/${threadId}` },
          },
        });
      }, 30);

      await vi.advanceTimersByTimeAsync(100);

      await expect(waitPromise).resolves.toMatchObject({
        sessionId: opened.session.id,
        payload: {
          commands: [
            expect.objectContaining({
              commandId: "cmd-2",
              commandCursor: 1,
            }),
          ],
        },
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it("returns an empty batch when the long-poll timeout expires", async () => {
    vi.useFakeTimers();
    try {
      const { threadId, environmentId } = createTestIds();
      const opened = service.openSession({
        environmentId,
        now: 1_000,
        payload: {
          agentId: "agent-1",
          agentInstanceId: "instance-1",
          supportedProtocolVersions: [1],
          channels: [
            {
              channelId: threadId,
              generation: 1,
            },
          ],
        },
      });

      const waitPromise = service.waitForCommands({
        environmentId,
        sessionId: opened.session.id,
        waitMs: 75,
      });

      await vi.advanceTimersByTimeAsync(75);

      await expect(waitPromise).resolves.toMatchObject({
        sessionId: opened.session.id,
        payload: {
          commands: [],
        },
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it("accepts event batches for sibling threads in a shared environment", async () => {
    const project = projects.create({
      name: "shared-event-batch-project",
      rootPath: "/tmp/shared-event-batch-project",
    });
    const ownerThreadId = threads.create({ projectId: project.id }).id;
    const siblingThreadId = threads.create({ projectId: project.id }).id;
    const environmentId = environments.create({
      projectId: project.id,
      descriptor: {
        type: "path",
        path: "/tmp/shared-event-batch-project/.worktrees/shared",
      },
      managed: true,
    }).id;

    const sharedService = new EnvironmentDaemonSessionService(
      new EnvironmentDaemonSessionManager(sessions),
      cursors,
      {
        clock: () => TEST_LEASE_NOW,
        listAttachedThreadIds: (eid) =>
          eid === environmentId ? [ownerThreadId, siblingThreadId] : [],
        eventApplier: new EnvironmentDaemonEventApplier(cursors, {
          ingestReplayedEnvironmentDaemonEvents: vi.fn(async () => undefined),
        }),
      },
    );

    const opened = sharedService.openSession({
      environmentId,
      payload: {
        agentId: "agent-shared",
        agentInstanceId: "instance-1",
        supportedProtocolVersions: [1],
        channels: [
          { channelId: ownerThreadId, generation: 1 },
          { channelId: siblingThreadId, generation: 1 },
        ],
      },
      now: 1_000,
    });

    // Env-daemon routes events for the sibling thread via the owner's route.
    // This must succeed — the sibling is attached to the same environment.
    const ack = await sharedService.applyEventBatch({
      environmentId,
      sessionId: opened.session.id,
      payload: {
        batches: [
          {
            channelId: siblingThreadId,
            generation: 1,
            events: [
              {
                sequence: 1,
                eventId: "evt-sibling-1",
                emittedAt: 2_000,
                event: {
                  type: "provider.event",
                  threadId: siblingThreadId,
                  method: "turn/started",
                  payload: { turnId: "turn-1" },
                },
              },
            ],
          },
        ],
      },
      now: 2_100,
    });
    expect(ack.type).toBe("event_ack");
  });

  it("rejects event batches for threads not attached to the shared environment", async () => {
    const project = projects.create({
      name: "shared-event-reject-project",
      rootPath: "/tmp/shared-event-reject-project",
    });
    const ownerThreadId = threads.create({ projectId: project.id }).id;
    const unattachedThreadId = threads.create({ projectId: project.id }).id;
    const environmentId = environments.create({
      projectId: project.id,
      descriptor: {
        type: "path",
        path: "/tmp/shared-event-reject-project/.worktrees/shared",
      },
      managed: true,
    }).id;

    const sharedService = new EnvironmentDaemonSessionService(
      new EnvironmentDaemonSessionManager(sessions),
      cursors,
      {
        clock: () => TEST_LEASE_NOW,
        listAttachedThreadIds: (eid) =>
          eid === environmentId ? [ownerThreadId] : [],
        eventApplier: new EnvironmentDaemonEventApplier(cursors, {
          ingestReplayedEnvironmentDaemonEvents: vi.fn(async () => undefined),
        }),
      },
    );

    const opened = sharedService.openSession({
      environmentId,
      payload: {
        agentId: "agent-owner",
        agentInstanceId: "instance-1",
        supportedProtocolVersions: [1],
        channels: [{ channelId: ownerThreadId, generation: 1 }],
      },
      now: 1_000,
    });

    // Events for an unattached thread should be rejected with a domain error (400),
    // not a plain Error (500).
    await expect(
      sharedService.applyEventBatch({
        environmentId,
        sessionId: opened.session.id,
        payload: {
          batches: [
            {
              channelId: unattachedThreadId,
              generation: 1,
              events: [
                {
                  sequence: 1,
                  eventId: "evt-unattached-1",
                  emittedAt: 2_000,
                  event: {
                    type: "provider.event",
                    threadId: unattachedThreadId,
                    method: "turn/started",
                    payload: { turnId: "turn-1" },
                  },
                },
              ],
            },
          ],
        },
        now: 2_100,
      }),
    ).rejects.toSatisfy((err: unknown) => isDomainError(err));
  });
});
