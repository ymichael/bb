import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { DbConnection } from "@bb/db";
import {
  createConnection,
  EnvironmentRepository,
  migrate,
  EnvironmentAgentCommandRepository,
  EnvironmentAgentCursorRepository,
  EnvironmentAgentSessionRepository,
  ProjectRepository,
  ThreadEnvironmentAttachmentRepository,
  ThreadRepository,
} from "@bb/db";
import type {
  EnvironmentAgentEventEnvelope,
  EnvironmentAgentSessionEventBatchChannel,
} from "@bb/environment-daemon";
import { createEnvironmentAgentSessionCapabilities } from "@bb/environment-daemon";
import {
  EnvironmentAgentCommandDispatcher,
  EnvironmentAgentSessionUnavailableError,
} from "../environment-agent-command-dispatcher.js";
import { EnvironmentAgentEventApplier } from "../environment-agent-event-applier.js";

interface SqliteClient {
  close(): void;
}

function sqliteClient(db: DbConnection): SqliteClient {
  return (db as unknown as { $client: SqliteClient }).$client;
}

const TEST_LEASE_NOW = 20_000;

describe("environment-agent delivery modules", () => {
  let db: DbConnection;
  let sqlite: SqliteClient;
  let projects: ProjectRepository;
  let environments: EnvironmentRepository;
  let threads: ThreadRepository;
  let attachments: ThreadEnvironmentAttachmentRepository;
  let sessions: EnvironmentAgentSessionRepository;
  let cursors: EnvironmentAgentCursorRepository;
  let commands: EnvironmentAgentCommandRepository;

  beforeEach(() => {
    db = createConnection(":memory:");
    migrate(db);
    sqlite = sqliteClient(db);
    projects = new ProjectRepository(db);
    environments = new EnvironmentRepository(db);
    threads = new ThreadRepository(db);
    attachments = new ThreadEnvironmentAttachmentRepository(db);
    sessions = new EnvironmentAgentSessionRepository(db);
    cursors = new EnvironmentAgentCursorRepository(db);
    commands = new EnvironmentAgentCommandRepository(db);
  });

  afterEach(() => {
    sqlite.close();
  });

  function createProject() {
    return projects.create({
      name: "daemon-delivery-modules-project",
      rootPath: "/tmp/daemon-delivery-modules-project",
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
        path: `/tmp/daemon-delivery-modules-project/.worktrees/${threadId}`,
      },
      managed: true,
    });
    attachments.attachThread({ threadId, environmentId: environment.id });
    return environment.id;
  }

  function createActiveSession(threadId: string, id: string = "sess-1"): string {
    return sessions.create({
      id,
      threadId,
      agentId: "agent-1",
      agentInstanceId: `${id}-instance`,
      protocolVersion: 1,
      selectedCapabilities: createEnvironmentAgentSessionCapabilities({}),
      leaseExpiresAt: 30_000,
      now: 1_000,
    }).id;
  }

  function makeEventBatch(
    threadId: string,
    args: { generation: number; sequences: number[] },
  ): EnvironmentAgentSessionEventBatchChannel {
    return {
      channelId: threadId,
      generation: args.generation,
      events: args.sequences.map((sequence) => ({
        sequence,
        eventId: `evt-${sequence}`,
        emittedAt: 1_000 + sequence,
        event: {
          type: "provider.stderr",
          threadId,
          line: `stderr ${sequence}`,
        },
      })),
    };
  }

  it("applies contiguous event batches and persists the acknowledged cursor", async () => {
    const threadId = createThreadId();
    const ingested: EnvironmentAgentEventEnvelope[][] = [];
    const applier = new EnvironmentAgentEventApplier(cursors, {
      ingestReplayedEnvironmentAgentEvents: vi.fn(async ({ events }) => {
        ingested.push(events);
      }),
    });

    const result = await applier.applyChannelBatch({
      threadId,
      batch: makeEventBatch(threadId, {
        generation: 1,
        sequences: [1, 2, 3],
      }),
      now: 5_000,
    });

    expect(result).toEqual({
      acknowledgedCursor: { generation: 1, sequence: 3 },
      appliedCount: 3,
      duplicateCount: 0,
    });
    expect(ingested).toEqual([
      [
        expect.objectContaining({ sequence: 1 }),
        expect.objectContaining({ sequence: 2 }),
        expect.objectContaining({ sequence: 3 }),
      ],
    ]);
    expect(cursors.getByThreadId(threadId)).toMatchObject({
      generation: 1,
      sequence: 3,
      updatedAt: 5_000,
    });
  });

  it("ignores duplicate events, rejects gaps, and leaves the stored cursor unchanged", async () => {
    const threadId = createThreadId();
    cursors.upsert(threadId, { generation: 1, sequence: 2 }, 2_000);
    const ingester = {
      ingestReplayedEnvironmentAgentEvents: vi.fn(async () => undefined),
    };
    const applier = new EnvironmentAgentEventApplier(cursors, ingester);

    const result = await applier.applyChannelBatch({
      threadId,
      batch: makeEventBatch(threadId, {
        generation: 1,
        sequences: [1, 2, 4],
      }),
      now: 6_000,
    });

    expect(result).toEqual({
      acknowledgedCursor: { generation: 1, sequence: 2 },
      appliedCount: 0,
      duplicateCount: 2,
      blockedReason: "gap",
      blockedAt: { generation: 1, sequence: 4 },
    });
    expect(ingester.ingestReplayedEnvironmentAgentEvents).not.toHaveBeenCalled();
    expect(cursors.getByThreadId(threadId)).toMatchObject({
      generation: 1,
      sequence: 2,
      updatedAt: 2_000,
    });
  });

  it("does not advance the stored cursor when ingestion fails", async () => {
    const threadId = createThreadId();
    cursors.upsert(threadId, { generation: 1, sequence: 1 }, 2_000);
    const applier = new EnvironmentAgentEventApplier(cursors, {
      ingestReplayedEnvironmentAgentEvents: vi.fn(async () => {
        throw new Error("ingest failed");
      }),
    });

    await expect(
      applier.applyChannelBatch({
        threadId,
        batch: makeEventBatch(threadId, {
          generation: 1,
          sequences: [2],
        }),
        now: 6_000,
      }),
    ).rejects.toThrow("ingest failed");
    expect(cursors.getByThreadId(threadId)).toMatchObject({
      generation: 1,
      sequence: 1,
      updatedAt: 2_000,
    });
  });

  it("rejects batches delivered for the wrong channel id", async () => {
    const threadId = createThreadId();
    const applier = new EnvironmentAgentEventApplier(cursors, {
      ingestReplayedEnvironmentAgentEvents: vi.fn(async () => undefined),
    });

    await expect(
      applier.applyChannelBatch({
        threadId,
        batch: {
          ...makeEventBatch(threadId, { generation: 1, sequences: [1] }),
          channelId: "other-thread",
        },
      }),
    ).resolves.toEqual({
      acknowledgedCursor: undefined,
      appliedCount: 0,
      duplicateCount: 0,
      blockedReason: "invalid_channel",
    });
  });

  it("lists deliverable commands and records delivery acknowledgements", () => {
    const threadId = createThreadId();
    const sessionId = createActiveSession(threadId, "sess-deliver");
    const dispatcher = new EnvironmentAgentCommandDispatcher(sessions, commands, {
      clock: () => TEST_LEASE_NOW,
    });

    commands.enqueue({
      id: "cmd-1",
      threadId,
      sessionId,
      commandType: "thread.start",
      payload: {
        request: { projectId: "project-1", input: [{ type: "text", text: "hello" }] },
        context: { projectId: "project-1", threadId, path: `/tmp/${threadId}` },
      },
      now: 2_000,
    });
    commands.enqueue({
      id: "cmd-2",
      threadId,
      sessionId,
      commandType: "workspace.status",
      payload: {},
      now: 3_000,
    });

    expect(
      dispatcher.listDeliverableCommandRecords({ sessionId }).map((command) => command.id),
    ).toEqual(["cmd-1", "cmd-2"]);

    const acknowledged = dispatcher.recordDeliveryAck({
      sessionId,
      now: 4_000,
      payload: {
        commands: [
          { commandId: "cmd-1", channelId: threadId, state: "received" },
          { commandId: "cmd-2", channelId: threadId, state: "duplicate" },
          { commandId: "cmd-2", channelId: "other-thread", state: "received" },
        ],
      },
    });

    expect(acknowledged.commands.map((command) => command.id)).toEqual([
      "cmd-1",
      "cmd-2",
    ]);
    expect(commands.getById("cmd-1")).toMatchObject({ state: "received" });
    expect(commands.getById("cmd-2")).toMatchObject({ state: "received" });
  });

  it("reuses active sessions across threads attached to the same environment", async () => {
    const project = createProject();
    const firstThreadId = createThreadId(project.id);
    const secondThreadId = createThreadId(project.id);
    const environmentId = attachThreadToEnvironment(firstThreadId);
    attachments.attachThread({ threadId: secondThreadId, environmentId });
    const sessionId = sessions.create({
      id: "sess-shared",
      threadId: firstThreadId,
      environmentId,
      agentId: "agent-shared",
      agentInstanceId: "sess-shared-instance",
      protocolVersion: 1,
      selectedCapabilities: createEnvironmentAgentSessionCapabilities({}),
      leaseExpiresAt: 30_000,
      now: 1_000,
    }).id;
    const dispatcher = new EnvironmentAgentCommandDispatcher(sessions, commands, {
      clock: () => TEST_LEASE_NOW,
      resolveEnvironmentId: (threadId) =>
        attachments.getByThreadId(threadId)?.environmentId,
    });

    const active = await dispatcher.awaitActiveSession({
      threadId: secondThreadId,
      timeoutMs: 20,
      pollIntervalMs: 1,
    });

    expect(active).toMatchObject({
      id: sessionId,
      threadId: firstThreadId,
      environmentId,
    });
  });

  it("waits for active sessions and terminal command states", async () => {
    const threadId = createThreadId();
    const dispatcher = new EnvironmentAgentCommandDispatcher(sessions, commands, {
      clock: () => TEST_LEASE_NOW,
    });

    setTimeout(() => {
      sessions.create({
        id: "sess-await",
        threadId,
        agentId: "agent-1",
        agentInstanceId: "instance-await",
        protocolVersion: 1,
        selectedCapabilities: createEnvironmentAgentSessionCapabilities({}),
        leaseExpiresAt: 30_000,
        now: 1_000,
      });
    }, 10);

    await expect(
      dispatcher.awaitActiveSession({
        threadId,
        timeoutMs: 500,
        pollIntervalMs: 10,
      }),
    ).resolves.toMatchObject({ id: "sess-await" });

    setTimeout(() => {
      commands.markCompleted({
        commandId: "cmd-await",
        result: { ok: true },
        now: 2_000,
      });
    }, 10);
    commands.enqueue({
      id: "cmd-await",
      threadId,
      sessionId: "sess-await",
      commandType: "workspace.status",
      payload: { type: "workspace.status", threadId },
      now: 1_500,
    });

    await expect(
      dispatcher.waitForTerminalState({
        commandId: "cmd-await",
        timeoutMs: 500,
        pollIntervalMs: 10,
      }),
    ).resolves.toMatchObject({
      id: "cmd-await",
      state: "completed",
      result: { ok: true },
    });
  });

  it("does not treat elapsed leases as active sessions for command recovery", async () => {
    const threadId = createThreadId();
    const dispatcher = new EnvironmentAgentCommandDispatcher(sessions, commands, {
      clock: () => TEST_LEASE_NOW,
    });
    const now = TEST_LEASE_NOW;

    sessions.create({
      id: "sess-expired",
      threadId,
      agentId: "agent-1",
      agentInstanceId: "instance-expired",
      protocolVersion: 1,
      selectedCapabilities: createEnvironmentAgentSessionCapabilities({}),
      leaseExpiresAt: now - 1_000,
      now: now - 2_000,
    });
    commands.enqueue({
      id: "cmd-expired",
      threadId,
      sessionId: "sess-expired",
      commandType: "workspace.status",
      payload: { type: "workspace.status", threadId },
      now,
    });

    expect(dispatcher.hasActiveSession(threadId)).toBe(false);
    await expect(
      dispatcher.waitForTerminalState({
        commandId: "cmd-expired",
        timeoutMs: 50,
        pollIntervalMs: 10,
      }),
    ).rejects.toBeInstanceOf(EnvironmentAgentSessionUnavailableError);
  });

  it("does not treat replace-required sessions as active for command recovery", async () => {
    const threadId = createThreadId();
    const dispatcher = new EnvironmentAgentCommandDispatcher(sessions, commands, {
      clock: () => TEST_LEASE_NOW,
    });

    sessions.create({
      id: "sess-incompatible",
      threadId,
      agentId: "agent-1",
      agentInstanceId: "instance-incompatible",
      protocolVersion: 1,
      selectedCapabilities: {
        commands: ["thread.start"],
        features: [],
      },
      leaseExpiresAt: TEST_LEASE_NOW + 10_000,
      now: TEST_LEASE_NOW - 1_000,
    });

    expect(dispatcher.hasActiveSession(threadId)).toBe(false);
    await expect(
      dispatcher.awaitActiveSession({
        threadId,
        timeoutMs: 20,
        pollIntervalMs: 5,
      }),
    ).rejects.toBeInstanceOf(EnvironmentAgentSessionUnavailableError);
  });

  it("records command lifecycle results only for the matching active session", () => {
    const threadId = createThreadId();
    const sessionId = createActiveSession(threadId, "sess-results");
    const dispatcher = new EnvironmentAgentCommandDispatcher(sessions, commands, {
      clock: () => TEST_LEASE_NOW,
    });

    commands.enqueue({
      id: "cmd-start",
      threadId,
      sessionId,
      commandType: "thread.start",
      payload: {
        request: { projectId: "project-1", input: [{ type: "text", text: "hello" }] },
        context: { projectId: "project-1", threadId, path: `/tmp/${threadId}` },
      },
      now: 2_000,
    });
    commands.enqueue({
      id: "cmd-fail",
      threadId,
      sessionId,
      commandType: "workspace.diff",
      payload: {},
      now: 3_000,
    });

    expect(
      dispatcher.recordCommandResult({
        sessionId,
        now: 4_000,
        payload: {
          commandId: "cmd-start",
          channelId: threadId,
          state: "started",
        },
      }),
    ).toMatchObject({
      id: "cmd-start",
      state: "started",
    });

    expect(
      dispatcher.recordCommandResult({
        sessionId,
        now: 5_000,
        payload: {
          commandId: "cmd-start",
          channelId: threadId,
          state: "completed",
          result: { providerThreadId: "provider-1" },
        },
      }),
    ).toMatchObject({
      id: "cmd-start",
      state: "completed",
      result: { providerThreadId: "provider-1" },
    });

    expect(
      dispatcher.recordCommandResult({
        sessionId,
        now: 6_000,
        payload: {
          commandId: "cmd-fail",
          channelId: threadId,
          state: "failed",
          errorCode: "provider_error",
          errorMessage: "runtime down",
        },
      }),
    ).toMatchObject({
      id: "cmd-fail",
      state: "failed",
      errorCode: "provider_error",
      errorMessage: "runtime down",
    });

    expect(
      dispatcher.recordCommandResult({
        sessionId,
        now: 7_000,
        payload: {
          commandId: "cmd-start",
          channelId: "other-thread",
          state: "completed",
        },
      }),
    ).toBeUndefined();
  });

  it("fails all pending commands bound to an invalidated session", () => {
    const threadId = createThreadId();
    const sessionId = createActiveSession(threadId, "sess-invalidated");
    const dispatcher = new EnvironmentAgentCommandDispatcher(sessions, commands, {
      clock: () => TEST_LEASE_NOW,
    });

    commands.enqueue({
      id: "cmd-received",
      threadId,
      sessionId,
      commandType: "workspace.status",
      payload: { type: "workspace.status", threadId },
      now: 2_000,
    });
    commands.markReceived("cmd-received", 2_100);

    commands.enqueue({
      id: "cmd-started",
      threadId,
      sessionId,
      commandType: "thread.resume",
      payload: { type: "thread.resume", threadId, providerThreadId: "provider-1" },
      now: 2_200,
    });
    commands.markStarted("cmd-started", 2_300);

    const result = dispatcher.invalidateCommandsForSession({
      id: sessionId,
      threadId,
      status: "replaced",
      closeReason: "newer_session",
    }, 2_400);

    expect(result.failedCommands).toEqual([
      expect.objectContaining({
        id: "cmd-received",
        state: "failed",
        errorCode: "provider_unavailable",
      }),
      expect.objectContaining({
        id: "cmd-started",
        state: "failed",
        errorCode: "provider_unavailable",
      }),
    ]);
    expect(commands.getById("cmd-received")).toMatchObject({
      sessionId,
      state: "failed",
    });
    expect(commands.getById("cmd-started")).toMatchObject({
      sessionId,
      state: "failed",
      errorMessage:
        `Environment-agent session ${sessionId} closed (newer_session) while command execution was in progress`,
    });
  });
});
