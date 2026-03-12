import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { DbConnection } from "@beanbag/db";
import {
  createConnection,
  migrate,
  EnvironmentAgentCommandRepository,
  EnvironmentAgentCursorRepository,
  type EnvironmentAgentSessionRecord,
  EnvironmentAgentSessionRepository,
  ProjectRepository,
  ThreadRepository,
} from "@beanbag/db";
import { vi } from "vitest";
import { EnvironmentAgentCommandDispatcher } from "../environment-agent-command-dispatcher.js";
import { EnvironmentAgentEventApplier } from "../environment-agent-event-applier.js";
import { EnvironmentAgentSessionManager } from "../environment-agent-session-manager.js";
import { EnvironmentAgentSessionService } from "../environment-agent-session-service.js";
import { isDomainError } from "../domain-errors.js";

interface SqliteClient {
  close(): void;
}

function sqliteClient(db: DbConnection): SqliteClient {
  return (db as unknown as { $client: SqliteClient }).$client;
}

const TEST_LEASE_NOW = 20_000;

describe("EnvironmentAgentSessionService", () => {
  let db: DbConnection;
  let sqlite: SqliteClient;
  let projects: ProjectRepository;
  let threads: ThreadRepository;
  let sessions: EnvironmentAgentSessionRepository;
  let cursors: EnvironmentAgentCursorRepository;
  let commands: EnvironmentAgentCommandRepository;
  let service: EnvironmentAgentSessionService;
  let onSessionInvalidated: (session: EnvironmentAgentSessionRecord) => void;

  beforeEach(() => {
    db = createConnection(":memory:");
    migrate(db);
    sqlite = sqliteClient(db);
    projects = new ProjectRepository(db);
    threads = new ThreadRepository(db);
    sessions = new EnvironmentAgentSessionRepository(db);
    cursors = new EnvironmentAgentCursorRepository(db);
    commands = new EnvironmentAgentCommandRepository(db);
    onSessionInvalidated = vi.fn<(session: EnvironmentAgentSessionRecord) => void>();
    service = new EnvironmentAgentSessionService(
      new EnvironmentAgentSessionManager(sessions),
      cursors,
      {
        leaseTtlMs: 45_000,
        heartbeatIntervalMs: 15_000,
        clock: () => TEST_LEASE_NOW,
        commandDispatcher: new EnvironmentAgentCommandDispatcher(sessions, commands, {
          clock: () => TEST_LEASE_NOW,
        }),
        eventApplier: new EnvironmentAgentEventApplier(cursors, {
          ingestReplayedEnvironmentAgentEvents: vi.fn(async () => undefined),
        }),
        onSessionInvalidated,
      },
    );
  });

  afterEach(() => {
    sqlite.close();
  });

  function createThreadId(): string {
    const project = projects.create({
      name: "daemon-session-service-project",
      rootPath: "/tmp/daemon-session-service-project",
    });
    return threads.create({ projectId: project.id }).id;
  }

  it("negotiates a session and returns a welcome payload from the daemon cursor", () => {
    const threadId = createThreadId();
    cursors.upsert(threadId, { generation: 3, sequence: 9 }, 1_000);

    const opened = service.openSession({
      threadId,
      now: 2_000,
      payload: {
        agentId: "agent-1",
        agentInstanceId: "instance-1",
        supportedProtocolVersions: [1],
        channels: [
          {
            channelId: threadId,
            generation: 7,
            lastDaemonAcked: {
              generation: 7,
              sequence: 5,
            },
          },
        ],
      },
    });

    expect(opened.session).toMatchObject({
      threadId,
      agentId: "agent-1",
      agentInstanceId: "instance-1",
      leaseExpiresAt: 47_000,
    });
    expect(opened.welcome).toMatchObject({
      protocol: "beanbag.env-agent.v1",
      type: "session_welcome",
      sessionId: opened.session.id,
      sentAt: 2_000,
      payload: {
        leaseTtlMs: 45_000,
        heartbeatIntervalMs: 15_000,
        protocolVersion: 1,
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

  it("falls back to the agent bootstrap generation when the daemon has no cursor yet", () => {
    const threadId = createThreadId();

    const opened = service.openSession({
      threadId,
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

  it("resets a stale daemon cursor when a fresh agent opens without lastDaemonAcked", async () => {
    const threadId = createThreadId();
    cursors.upsert(threadId, { generation: 3, sequence: 9 }, 1_000);

    const opened = service.openSession({
      threadId,
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
      threadId,
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
    const threadId = createThreadId();
    const first = service.openSession({
      threadId,
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
      threadId,
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
        threadId,
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
    ).toThrow("No compatible environment-agent session protocol version");

    expect(() =>
      service.openSession({
        threadId,
        payload: {
          agentId: "agent-1",
          agentInstanceId: "instance-4",
          supportedProtocolVersions: [1],
          channels: [
            {
              channelId: "other-thread",
              generation: 1,
            },
          ],
        },
      }),
    ).toThrow(
      `Missing environment-agent channel bootstrap for thread ${threadId}`,
    );
  });

  it("fails pending queued commands when a newer session replaces them", () => {
    const threadId = createThreadId();
    const first = service.openSession({
      threadId,
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
      threadId,
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
    const threadId = createThreadId();
    const first = service.openSession({
      threadId,
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
      threadId,
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
        `Environment-agent session ${first.session.id} closed (newer_session) while command execution was in progress`,
    });
  });

  it("applies event batches and resets the agent cursor when the daemon detects a gap", async () => {
    const threadId = createThreadId();
    const opened = service.openSession({
      threadId,
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
      threadId,
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
      threadId,
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
    const threadId = createThreadId();
    const opened = service.openSession({
      threadId,
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
        threadId,
        closeReason: "lease_expired",
      }),
    );
  });

  it("fails started commands when a lease expires", () => {
    const threadId = createThreadId();
    const opened = service.openSession({
      threadId,
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
        `Environment-agent session ${opened.session.id} closed (lease_expired) while command execution was in progress`,
    });
  });

  it("closes active sessions explicitly", () => {
    const threadId = createThreadId();
    const opened = service.openSession({
      threadId,
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
        threadId,
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
        threadId,
        closeReason: "agent_shutdown",
      }),
    );
  });

  it("retires the active session without triggering invalidation callbacks", () => {
    const threadId = createThreadId();
    const opened = service.openSession({
      threadId,
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

    const retired = service.retireActiveSessionForThread({
      threadId,
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
    const threadId = createThreadId();
    const first = service.openSession({
      threadId,
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
      threadId,
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
        threadId,
        closeReason: "newer_session",
      }),
    );
  });

  it("records command acknowledgements and command results for the active session", () => {
    const threadId = createThreadId();
    const opened = service.openSession({
      threadId,
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
      threadId,
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
      threadId,
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
    const threadId = createThreadId();
    const opened = service.openSession({
      threadId,
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
        threadId,
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
      threadId,
      lastHeartbeatAt: 2_000,
      leaseExpiresAt: 47_000,
      status: "active",
    });

    const otherThreadId = createThreadId();
    expect(() =>
      service.recordHeartbeat({
        threadId: otherThreadId,
        sessionId: opened.session.id,
        now: 3_000,
        payload: {
          agentObservedAt: 3_000,
          outboxDepth: 0,
          channels: [{ channelId: otherThreadId }],
        },
      }),
    ).toThrow(
      `Environment-agent session ${opened.session.id} does not belong to thread ${otherThreadId}`,
    );
  });

  it("treats heartbeats for expired sessions as inactive-session domain errors", () => {
    const threadId = createThreadId();
    const opened = service.openSession({
      threadId,
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
        threadId,
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
      message: `Environment-agent session ${opened.session.id} is not active`,
    });
  });

  it("treats elapsed leases as inactive before the lease sweeper runs", () => {
    const now = TEST_LEASE_NOW;
    const threadId = createThreadId();
    const opened = service.openSession({
      threadId,
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
        threadId,
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
      message: `Environment-agent session ${opened.session.id} is not active`,
    });
    expect(sessions.getById(opened.session.id)).toMatchObject({
      status: "active",
      leaseExpiresAt: now - 5_000,
    });
  });

  it("lists deliverable commands as a command_batch protocol message", () => {
    const threadId = createThreadId();
    const opened = service.openSession({
      threadId,
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
        params: { prompt: "hello" },
      },
      now: 2_000,
    });

    expect(
      service.listCommands({
        threadId,
        sessionId: opened.session.id,
        now: 3_000,
      }),
    ).toMatchObject({
      protocol: "beanbag.env-agent.v1",
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
              params: { prompt: "hello" },
            },
          },
        ],
      },
    });
  });

  it("waits for commands before returning from long-poll", async () => {
    vi.useFakeTimers();
    try {
      const threadId = createThreadId();
      const opened = service.openSession({
        threadId,
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
        threadId,
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
            params: { prompt: "hello" },
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
      const threadId = createThreadId();
      const opened = service.openSession({
        threadId,
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
        threadId,
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
});
