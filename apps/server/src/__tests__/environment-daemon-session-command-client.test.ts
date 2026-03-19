import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { DbConnection } from "@bb/db";
import {
  createConnection,
  migrate,
  EnvironmentDaemonCommandRepository,
  EnvironmentDaemonSessionRepository,
  EnvironmentRepository,
  ProjectRepository,
  ThreadEnvironmentAttachmentRepository,
  ThreadRepository,
} from "@bb/db";
import { createCodexProviderAdapter } from "@bb/provider-adapters";
import { createEnvironmentDaemonSessionCapabilities } from "@bb/environment-daemon";
import { EnvironmentDaemonCommandDispatcher } from "../environment-daemon-command-dispatcher.js";
import { EnvironmentDaemonSessionCommandClient } from "../environment-daemon-session-command-client.js";
import { ProviderSessionController } from "../provider-session-controller.js";

interface SqliteClient { close(): void; }
function sqliteClient(db: DbConnection): SqliteClient {
  return (db as unknown as { $client: SqliteClient }).$client;
}

const TEST_LEASE_NOW = 20_000;

describe("EnvironmentDaemonSessionCommandClient", () => {
  let db: DbConnection;
  let sqlite: SqliteClient;
  let projects: ProjectRepository;
  let envs: EnvironmentRepository;
  let threads: ThreadRepository;
  let envAttachments: ThreadEnvironmentAttachmentRepository;
  let sessions: EnvironmentDaemonSessionRepository;
  let commands: EnvironmentDaemonCommandRepository;
  let dispatcher: EnvironmentDaemonCommandDispatcher;

  beforeEach(() => {
    db = createConnection(":memory:");
    migrate(db);
    sqlite = sqliteClient(db);
    projects = new ProjectRepository(db);
    envs = new EnvironmentRepository(db);
    threads = new ThreadRepository(db);
    envAttachments = new ThreadEnvironmentAttachmentRepository(db);
    sessions = new EnvironmentDaemonSessionRepository(db);
    commands = new EnvironmentDaemonCommandRepository(db);
    dispatcher = new EnvironmentDaemonCommandDispatcher(sessions, commands, {
      clock: () => TEST_LEASE_NOW,
      resolveEnvironmentId: (threadId) => envAttachments.getByThreadId(threadId)?.environmentId,
    });
  });

  afterEach(() => {
    sqlite.close();
  });

  function createThreadId(): string {
    const project = projects.create({
      name: "session-command-client-project",
      rootPath: "/tmp/session-command-client-project",
    });
    return threads.create({ projectId: project.id }).id;
  }

  function createThreadRecord(): { projectId: string; threadId: string } {
    const project = projects.create({
      name: "session-command-client-project",
      rootPath: "/tmp/session-command-client-project",
    });
    const thread = threads.create({ projectId: project.id });
    return {
      projectId: project.id,
      threadId: thread.id,
    };
  }

  function ensureEnvironmentForThread(threadId: string): string {
    const existing = envAttachments.getByThreadId(threadId);
    if (existing) return existing.environmentId;
    const thread = threads.getById(threadId);
    if (!thread) throw new Error(`Missing thread ${threadId}`);
    const env = envs.create({ projectId: thread.projectId, managed: false });
    envAttachments.attachThread({ threadId, environmentId: env.id });
    return env.id;
  }

  function createSessionClient(args: {
    threadId: string;
    sessionId: string;
  }): EnvironmentDaemonSessionCommandClient {
    const environmentId = ensureEnvironmentForThread(args.threadId);
    sessions.create({
      id: args.sessionId,
      environmentId,
      agentId: "agent-1",
      agentInstanceId: `${args.sessionId}-instance`,
      protocolVersion: 1,
      selectedCapabilities: createEnvironmentDaemonSessionCapabilities({}),
      leaseExpiresAt: 30_000,
      now: 1_000,
    });
    return new EnvironmentDaemonSessionCommandClient({
      threadId: args.threadId,
      commandDispatcher: dispatcher,
      commandTimeoutMs: 1_000,
      pollIntervalMs: 10,
    });
  }

  async function completeNextQueuedCommand(args: {
    threadId: string;
    result: unknown;
  }) {
    await vi.waitFor(() => {
      expect(commands.listPendingByThreadId(args.threadId)).toHaveLength(1);
    });
    const queued = commands.listPendingByThreadId(args.threadId)[0];
    expect(queued).toBeDefined();
    commands.markStarted(queued!.id, 1_100);
    commands.markCompleted({
      commandId: queued!.id,
      result: args.result,
      now: 1_200,
    });
    return queued!;
  }

  it("enqueues commands onto the active session and waits for completion", async () => {
    const threadId = createThreadId();
    const environmentId = ensureEnvironmentForThread(threadId);
    const session = sessions.create({
      id: "sess-1",
      environmentId,
      agentId: "agent-1",
      agentInstanceId: "instance-1",
      protocolVersion: 1,
      selectedCapabilities: createEnvironmentDaemonSessionCapabilities({}),
      leaseExpiresAt: 30_000,
      now: 1_000,
    });
    const client = new EnvironmentDaemonSessionCommandClient({
      threadId,
      commandDispatcher: dispatcher,
      commandTimeoutMs: 1_000,
      pollIntervalMs: 10,
    });

    setTimeout(() => {
      const queued = commands.getById("cmd-1");
      if (!queued) return;
      commands.markStarted("cmd-1", 1_100);
      commands.markCompleted({
        commandId: "cmd-1",
        result: { providerThreadId: "provider-1" },
        now: 1_200,
      });
    }, 20);

    await expect(
      client.sendCommand({
        meta: {
          protocolVersion: 1,
          commandId: "cmd-1",
          idempotencyKey: "cmd-1",
          sentAt: 1_050,
        },
        command: {
          type: "thread.start",
          threadId,
          projectId: "project-1",
          request: { projectId: "project-1", input: [{ type: "text", text: "hello" }] },
          context: { projectId: "project-1", threadId, path: `/tmp/${threadId}` },
        },
      }),
    ).resolves.toMatchObject({
      state: "accepted",
      result: { providerThreadId: "provider-1" },
    });

    expect(commands.getById("cmd-1")).toMatchObject({
      sessionId: session.id,
      state: "completed",
    });
  });

  it("surfaces failed queued commands as rejected command acks", async () => {
    const threadId = createThreadId();
    const environmentId = ensureEnvironmentForThread(threadId);
    sessions.create({
      id: "sess-2",
      environmentId,
      agentId: "agent-1",
      agentInstanceId: "instance-2",
      protocolVersion: 1,
      selectedCapabilities: createEnvironmentDaemonSessionCapabilities({}),
      leaseExpiresAt: 30_000,
      now: 1_000,
    });
    const client = new EnvironmentDaemonSessionCommandClient({
      threadId,
      commandDispatcher: dispatcher,
      commandTimeoutMs: 1_000,
      pollIntervalMs: 10,
    });

    setTimeout(() => {
      commands.markFailed({
        commandId: "cmd-2",
        errorCode: "provider_unavailable",
        errorMessage: "provider down",
        now: 1_200,
      });
    }, 20);

    await expect(
      client.sendCommand({
        meta: {
          protocolVersion: 1,
          commandId: "cmd-2",
          idempotencyKey: "cmd-2",
          sentAt: 1_050,
        },
        command: {
          type: "workspace.status",
          threadId,
        },
      }),
    ).resolves.toMatchObject({
      state: "rejected",
      errorCode: "provider_unavailable",
      message: "provider down",
    });
  });

  it("surfaces a started command stranded on a replaced session", async () => {
    const threadId = createThreadId();
    const environmentId = ensureEnvironmentForThread(threadId);
    sessions.create({
      id: "sess-stale",
      environmentId,
      agentId: "agent-1",
      agentInstanceId: "instance-stale",
      protocolVersion: 1,
      selectedCapabilities: createEnvironmentDaemonSessionCapabilities({}),
      leaseExpiresAt: 30_000,
      now: 1_000,
    });
    const client = new EnvironmentDaemonSessionCommandClient({
      threadId,
      commandDispatcher: dispatcher,
      commandTimeoutMs: 120,
      pollIntervalMs: 10,
    });

    void vi.waitFor(() => {
      expect(commands.getById("cmd-started-stale")).toBeDefined();
    }).then(() => {
      commands.markStarted("cmd-started-stale", 1_150);
      sessions.markClosed({
        sessionId: "sess-stale",
        reason: "internal_error",
        now: 1_200,
      });
      setTimeout(() => {
        commands.markCompleted({
          commandId: "cmd-started-stale",
          result: { ok: true },
          now: 1_400,
        });
      }, 10);
    });

    await expect(
      client.sendCommand({
        meta: {
          protocolVersion: 1,
          commandId: "cmd-started-stale",
          idempotencyKey: "cmd-started-stale",
          sentAt: 1_050,
        },
        command: {
          type: "workspace.status",
          threadId,
        },
      }),
    ).resolves.toMatchObject({
      state: "accepted",
      result: { ok: true },
    });

    expect(commands.getById("cmd-started-stale")).toMatchObject({
      sessionId: "sess-stale",
      state: "completed",
    });
  });

  it("queues provider.ensure and returns the reported provider status", async () => {
    const threadId = createThreadId();
    const environmentId = ensureEnvironmentForThread(threadId);
    sessions.create({
      id: "sess-provider-1",
      environmentId,
      agentId: "agent-1",
      agentInstanceId: "instance-provider-1",
      protocolVersion: 1,
      selectedCapabilities: createEnvironmentDaemonSessionCapabilities({}),
      leaseExpiresAt: 30_000,
      now: 1_000,
    });
    const client = new EnvironmentDaemonSessionCommandClient({
      threadId,
      commandDispatcher: dispatcher,
      commandTimeoutMs: 1_000,
      pollIntervalMs: 10,
    });
    let queuedCommandId: string | undefined;

    setTimeout(() => {
      const [queued] = commands.listPendingByThreadId(threadId);
      if (!queued) return;
      queuedCommandId = queued.id;
      commands.markStarted(queued.id, 1_100);
      commands.markCompleted({
        commandId: queued.id,
        result: { running: true, launched: true, pid: 42 },
        now: 1_200,
      });
    }, 20);

    await expect(
      client.ensureProviderRunning({
        command: "codex",
        args: ["app-server"],
      }),
    ).resolves.toEqual({
      running: true,
      launched: true,
      pid: 42,
    });

    expect(queuedCommandId).toBeDefined();
    expect(commands.getById(queuedCommandId!)).toMatchObject({
      commandType: "provider.ensure",
      payload: {
        command: "codex",
        args: ["app-server"],
      },
      state: "completed",
    });
  });

  it("allows fresh agent-server instances to enqueue globally unique command IDs", async () => {
    const first = createThreadRecord();
    const firstClient = createSessionClient({
      threadId: first.threadId,
      sessionId: "sess-3",
    });
    const firstServer = new ProviderSessionController({
      provider: createCodexProviderAdapter(),
    });
    const firstEnsureCompletion = completeNextQueuedCommand({
      threadId: first.threadId,
      result: { running: true, launched: true, pid: 101 },
    });
    const firstStartCompletion = (async () => {
      await firstEnsureCompletion;
      return completeNextQueuedCommand({
        threadId: first.threadId,
        result: { threadId: "provider-thread-1" },
      });
    })();

    await expect(
      firstServer.startThreadCommand({
        client: firstClient,
        threadId: first.threadId,
        projectId: first.projectId,
        request: {
          projectId: first.projectId,
          input: [{ type: "text", text: "hello" }],
        },
        context: {
          projectId: first.projectId,
          threadId: first.threadId,
          path: process.env.PATH ?? "",
        },
      }),
    ).resolves.toEqual({ providerThreadId: "provider-thread-1" });

    await firstEnsureCompletion;
    const firstCommand = await firstStartCompletion;

    const second = createThreadRecord();
    const secondClient = createSessionClient({
      threadId: second.threadId,
      sessionId: "sess-4",
    });
    const secondServer = new ProviderSessionController({
      provider: createCodexProviderAdapter(),
    });
    const secondEnsureCompletion = completeNextQueuedCommand({
      threadId: second.threadId,
      result: { running: true, launched: true, pid: 202 },
    });
    const secondStartCompletion = (async () => {
      await secondEnsureCompletion;
      return completeNextQueuedCommand({
        threadId: second.threadId,
        result: { threadId: "provider-thread-2" },
      });
    })();

    await expect(
      secondServer.startThreadCommand({
        client: secondClient,
        threadId: second.threadId,
        projectId: second.projectId,
        request: {
          projectId: second.projectId,
          input: [{ type: "text", text: "hello again" }],
        },
        context: {
          projectId: second.projectId,
          threadId: second.threadId,
          path: process.env.PATH ?? "",
        },
      }),
    ).resolves.toEqual({ providerThreadId: "provider-thread-2" });

    await secondEnsureCompletion;
    const secondCommand = await secondStartCompletion;

    expect(firstCommand.id).not.toBe(secondCommand.id);
    expect(commands.getById(firstCommand.id)).toMatchObject({
      threadId: first.threadId,
      state: "completed",
    });
    expect(commands.getById(secondCommand.id)).toMatchObject({
      threadId: second.threadId,
      state: "completed",
    });
  });

  it("omits activeTurnId from auto turn.run commands when execution overrides require a new turn", async () => {
    const thread = createThreadRecord();
    const client = createSessionClient({
      threadId: thread.threadId,
      sessionId: "sess-turn-overrides",
    });
    const server = new ProviderSessionController({
      provider: createCodexProviderAdapter(),
    });
    const ensureCompletion = completeNextQueuedCommand({
      threadId: thread.threadId,
      result: { running: true, launched: true, pid: 303 },
    });
    const turnCompletion = (async () => {
      await ensureCompletion;
      return completeNextQueuedCommand({
        threadId: thread.threadId,
        result: { mode: "start", turnId: "turn-2" },
      });
    })();

    await expect(
      server.sendTurnCommand({
        client,
        threadId: thread.threadId,
        providerThreadId: "provider-thread-1",
        activeTurnId: "turn-1",
        input: [{ type: "text", text: "follow up" }],
        options: { model: "gpt-5.4" },
        context: {
          projectId: thread.projectId,
          threadId: thread.threadId,
          path: process.env.PATH ?? "",
        },
      }),
    ).resolves.toEqual({
      mode: "start",
      providerThreadId: "provider-thread-1",
    });

    await ensureCompletion;
    const queuedTurnCommand = await turnCompletion;

    expect(commands.getById(queuedTurnCommand.id)).toMatchObject({
      commandType: "turn.run",
      payload: {
        providerThreadId: "provider-thread-1",
        requestedMode: "auto",
        options: { model: "gpt-5.4" },
      },
      state: "completed",
    });
    expect(commands.getById(queuedTurnCommand.id)?.payload).not.toHaveProperty("activeTurnId");
  });
});
