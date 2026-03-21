import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  toRecord,
  type Thread,
} from "@bb/core";
import type { DbConnection } from "@bb/db";
import {
  createConnection,
  migrate,
  EnvironmentDaemonCommandRepository,
  EnvironmentDaemonCursorRepository,
  EnvironmentRepository,
  EnvironmentDaemonSessionRepository,
  EventRepository,
  ProjectRepository,
  ThreadEnvironmentAttachmentRepository,
  ThreadRepository,
} from "@bb/db";
import {
  createEnvironmentDaemonSessionCapabilities,
  EnvironmentDaemonSessionEventBatchPayload,
  EnvironmentDaemonSessionOpenPayload,
  resolveEnvironmentIdForEnvironmentDaemonChannel,
} from "@bb/environment-daemon";
import { createCodexProviderAdapter, type LlmCompletionService } from "@bb/provider-adapters";
import type { IEnvironment } from "@bb/environment";
import type { WSManager } from "../ws.js";
import { Orchestrator } from "../orchestrator.js";
import { EnvironmentDaemonCommandDispatcher } from "../environment-daemon-command-dispatcher.js";
import { EnvironmentDaemonEventApplier } from "../environment-daemon-event-applier.js";
import { EnvironmentDaemonSessionManager } from "../environment-daemon-session-manager.js";
import { EnvironmentDaemonSessionService } from "../environment-daemon-session-service.js";

interface SqliteClient {
  close(): void;
}

function sqliteClient(db: DbConnection): SqliteClient {
  return (db as unknown as { $client: SqliteClient }).$client;
}

const TEST_LEASE_NOW = 20_000;

function createMockLlmCompletionService(): LlmCompletionService {
  return {
    displayName: "Mock LLM",
    generateThreadTitle: vi.fn().mockResolvedValue(undefined),
    generateCommitMessage: vi.fn().mockResolvedValue(undefined),
  };
}

function makeOpenPayload(threadId: string): EnvironmentDaemonSessionOpenPayload {
  return {
    environmentDaemonId: `agent:${threadId}`,
    environmentDaemonInstanceId: `instance:${threadId}`,
    supportedProtocolVersions: [1],
    capabilities: createEnvironmentDaemonSessionCapabilities({}),
    channels: [
      {
        channelId: threadId,
        generation: 1,
      },
    ],
  };
}

function makeEventBatch(
  threadId: string,
  events: EnvironmentDaemonSessionEventBatchPayload["batches"][number]["events"],
): EnvironmentDaemonSessionEventBatchPayload {
  return {
    batches: [
      {
        channelId: threadId,
        generation: 1,
        events,
      },
    ],
  };
}

function makeRuntimeEnvironment(rootPath: string): IEnvironment {
  return {
    kind: "local",
    info: {
      id: "local",
      displayName: "Local Workspace",
      description: "",
      capabilities: {
        host_filesystem: true,
        isolated_workspace: false,
        promote_primary_checkout: false,
        demote_primary_checkout: false,
        squash_merge: false,
      },
    },
    serialize() {
      return {};
    },
    suspend() {},
    destroy() {},
    exists() {
      return true;
    },
    supportsHostFilesystemAccess() {
      return true;
    },
    isIsolatedWorkspace() {
      return false;
    },
    getAgentConnectionTarget() {
      return {
        transport: "http" as const,
        baseUrl: "http://127.0.0.1:4312",
        headers: {
          authorization: "Bearer test-token",
        },
      };
    },
    async getCheckoutSnapshot() {
      return {
        branch: "bb/thread-test",
        head: "abc123",
        detached: false,
      };
    },
    getWorkspaceRootUnsafe() {
      return rootPath;
    },
    async getWorkspaceStatus() {
      return {
        state: "clean" as const,
        currentBranch: "bb/thread-test",
        changedFiles: 0,
        insertions: 0,
        deletions: 0,
        workspaceChangedFiles: 0,
        workspaceInsertions: 0,
        workspaceDeletions: 0,
        hasUncommittedChanges: false,
        hasCommittedUnmergedChanges: false,
        aheadCount: 0,
        behindCount: 0,
        files: [],
      };
    },
    watchWorkspaceStatus() {
      return () => {};
    },
    async commitWorkspace() {
      return {
        ok: true,
        commitCreated: false,
        message: "Working directory is clean",
        workStatus: await this.getWorkspaceStatus(),
      };
    },
    async listWorkspaceCommitsSinceRef() {
      return [];
    },
    async getWorkspaceDiff() {
      return { diff: "", truncated: false };
    },
    spawn: vi.fn(),
    supportsPromoteToActiveWorkspace() {
      return false;
    },
    supportsDemoteFromActiveWorkspace() {
      return false;
    },
    supportsSquashMergeIntoDefaultBranch() {
      return false;
    },
    promoteToActiveWorkspace() {
      throw new Error("not implemented");
    },
    demoteFromActiveWorkspace() {
      throw new Error("not implemented");
    },
    async squashMergeIntoDefaultBranch() {
      throw new Error("not implemented");
    },
    run: vi.fn(),
    buildAgentInstructions() {
      return undefined;
    },
  };
}

describe("environment-daemon session orchestrator roundtrip", () => {
  let db: DbConnection;
  let sqlite: SqliteClient;
  let projects: ProjectRepository;
  let threads: ThreadRepository;
  let events: EventRepository;
  let environments: EnvironmentRepository;
  let attachments: ThreadEnvironmentAttachmentRepository;
  let sessions: EnvironmentDaemonSessionRepository;
  let cursors: EnvironmentDaemonCursorRepository;
  let commands: EnvironmentDaemonCommandRepository;
  let sessionService: EnvironmentDaemonSessionService;
  let orchestrator: Orchestrator;
  let ws: WSManager;

  beforeEach(() => {
    db = createConnection(":memory:");
    migrate(db);
    sqlite = sqliteClient(db);
    projects = new ProjectRepository(db);
    threads = new ThreadRepository(db);
    events = new EventRepository(db);
    environments = new EnvironmentRepository(db);
    attachments = new ThreadEnvironmentAttachmentRepository(db);
    sessions = new EnvironmentDaemonSessionRepository(db);
    cursors = new EnvironmentDaemonCursorRepository(db);
    commands = new EnvironmentDaemonCommandRepository(db);
    ws = {
      broadcast: vi.fn(),
      handleConnection: vi.fn(),
      close: vi.fn(),
    } as unknown as WSManager;

    const resolveEnvironmentId = (channelId: string) =>
      resolveEnvironmentIdForEnvironmentDaemonChannel(channelId) ??
      attachments.getByThreadId(channelId)?.environmentId ??
      threads.getById(channelId)?.environmentId;

    const sessionManager = new EnvironmentDaemonSessionManager(sessions);
    const commandDispatcher = new EnvironmentDaemonCommandDispatcher(sessions, commands, {
      clock: () => TEST_LEASE_NOW,
      resolveEnvironmentId,
    });
    let threadManager!: Orchestrator;
    const eventApplier = new EnvironmentDaemonEventApplier(cursors, {
      ingestReplayedEnvironmentDaemonEvents: ({ threadId, events: envelopes }) =>
        threadManager.ingestReplayedEnvironmentDaemonEvents({
          threadId,
          events: envelopes,
        }),
    });
    sessionService = new EnvironmentDaemonSessionService(sessionManager, cursors, {
      clock: () => TEST_LEASE_NOW,
      commandDispatcher,
      eventApplier,
      onSessionInvalidated: (session) => {
        threadManager.handleEnvironmentDaemonSessionInvalidated(
          session.environmentId,
          session.closeReason,
        );
      },
      listAttachedThreadIds: (environmentId) =>
        attachments
          .listByEnvironmentId(environmentId)
          .map((attachment) => attachment.threadId),
    });
    threadManager = new Orchestrator(
      threads,
      events,
      projects,
      ws,
      createMockLlmCompletionService(),
      createCodexProviderAdapter(),
      {
        ...process.env,
        BB_ENV_DAEMON_BASE_URL: "http://127.0.0.1:4312",
        BB_ENV_DAEMON_AUTH_TOKEN: "test-token",
      },
      undefined,
      undefined,
      undefined,
      undefined,
      commandDispatcher,
      sessionService,
      undefined,
      environments,
      attachments,
    );
    orchestrator = threadManager;
    (orchestrator as unknown as {
      _scheduleQueuedOperationDispatch: (threadId: string) => void;
      _scheduleQueuedFollowUpDispatch: (threadId: string) => void;
    })._scheduleQueuedOperationDispatch = () => undefined;
    (orchestrator as unknown as {
      _scheduleQueuedOperationDispatch: (threadId: string) => void;
      _scheduleQueuedFollowUpDispatch: (threadId: string) => void;
    })._scheduleQueuedFollowUpDispatch = () => undefined;
  });

  afterEach(async () => {
    await vi.waitFor(() => {
      expect(
        (orchestrator as unknown as { provisioningTasks: Map<string, Promise<void>> }).provisioningTasks.size,
      ).toBe(0);
    });
    orchestrator.detachAll();
    await new Promise((resolve) => setImmediate(resolve));
    sqlite.close();
  });

  function createProject() {
    return projects.create({
      name: "session-orchestrator-project",
      rootPath: "/tmp/session-orchestrator-project",
    });
  }

  function createThread(
    status: "created" | "idle" | "active" = "idle",
    opts?: {
      projectId?: string;
      providerId?: "codex" | "claude-code" | "pi";
      environmentId?: string;
    },
  ): string {
    const projectId = opts?.projectId ?? createProject().id;
    const environmentId =
      opts?.environmentId ??
      environments.create({ projectId, managed: false }).id;
    const thread = threads.create({
      projectId,
      ...(opts?.providerId ? { providerId: opts.providerId } : {}),
      environmentId,
    });
    attachments.attachThread({ threadId: thread.id, environmentId });
    threads.update(thread.id, {
      status,
    });
    return thread.id;
  }

  function resolveEnvironmentId(threadId: string): string {
    return (
      attachments.getByThreadId(threadId)?.environmentId ??
      threads.getById(threadId)?.environmentId ??
      threadId
    );
  }

  function openSession(threadId: string, channelIds: string[] = [threadId]): string {
    return sessionService.openSession({
      environmentId: resolveEnvironmentId(threadId),
      payload: {
        ...makeOpenPayload(threadId),
        channels: channelIds.map((channelId) => ({
          channelId,
          generation: 1,
        })),
      },
      now: 1_000,
    }).session.id;
  }

  function createSharedEnvironment(projectId: string, pathSuffix: string): string {
    return environments.create({
      projectId,
      descriptor: {
        type: "path",
        path: `/tmp/${pathSuffix}`,
      },
      managed: true,
    }).id;
  }

  function installRuntime(threadId: string, rootPath = "/tmp/session-orchestrator-project"): void {
    (orchestrator as unknown as {
      _setEnvironmentRuntime: (threadId: string, environment: IEnvironment) => void;
    })._setEnvironmentRuntime(threadId, makeRuntimeEnvironment(rootPath));
  }

  function installSpawnRuntime(rootPath = "/tmp/session-orchestrator-project"): void {
    (orchestrator as unknown as {
      _spawnProcess: (threadId: string, projectRootPath: string, environmentKind: string, reason: string) => Promise<{
        environment: IEnvironment;
        agentConnectionTarget: ReturnType<IEnvironment["getAgentConnectionTarget"]>;
      }>;
    })._spawnProcess = async () => {
      const environment = makeRuntimeEnvironment(rootPath);
      return {
        environment,
        agentConnectionTarget: environment.getAgentConnectionTarget(),
      };
    };
  }

  function completeCommand(args: {
    threadId: string;
    sessionId: string;
    afterCursor?: number;
    result?: unknown;
    state?: "completed" | "failed";
    errorCode?: string;
    errorMessage?: string;
  }): { commandId: string; commandCursor: number; command: Record<string, unknown> } {
    const batch = sessionService.listCommands({
      environmentId: resolveEnvironmentId(args.threadId),
      sessionId: args.sessionId,
      afterCursor: args.afterCursor ?? 0,
      limit: 10,
      now: 2_000,
    });
    expect(batch.payload.commands).toHaveLength(1);
    const commandEnvelope = batch.payload.commands[0]!;

    sessionService.recordCommandAck({
      environmentId: resolveEnvironmentId(args.threadId),
      sessionId: args.sessionId,
      payload: {
        commands: [
          {
            commandId: commandEnvelope.commandId,
            channelId: args.threadId,
            state: "received",
          },
        ],
      },
      now: 2_100,
    });

    const state = args.state ?? "completed";
    sessionService.recordCommandResult({
      environmentId: resolveEnvironmentId(args.threadId),
      sessionId: args.sessionId,
      payload:
        state === "completed"
          ? {
              channelId: args.threadId,
              commandId: commandEnvelope.commandId,
              state,
              ...(args.result !== undefined ? { result: args.result } : {}),
            }
          : {
              channelId: args.threadId,
              commandId: commandEnvelope.commandId,
              state,
              ...(args.errorCode !== undefined ? { errorCode: args.errorCode } : {}),
              ...(args.errorMessage !== undefined ? { errorMessage: args.errorMessage } : {}),
            },
      now: 2_200,
    });

    return {
      commandId: commandEnvelope.commandId,
      commandCursor: commandEnvelope.commandCursor,
      command: commandEnvelope.command as Record<string, unknown>,
    };
  }

  async function applyProviderEvent(args: {
    threadId: string;
    sessionId: string;
    sequence: number;
    method: string;
    text?: string;
  }): Promise<void> {
    const turnId = `turn-${args.threadId}-${args.sequence}`;
    const isTurnStarted = args.method === "turn/started";
    const isTurnCompleted = args.method === "turn/completed" || args.method === "turn/end";
    const isItemCompleted = args.method === "item/completed";
    const isThreadStarted = args.method === "thread/started";
    const translatedEvents: Array<Record<string, unknown>> = [];
    if (isTurnStarted) {
      translatedEvents.push({
        type: "turn/started",
        threadId: args.threadId,
        turnId,
        turn: { id: turnId, items: [], status: "inProgress", error: null },
      });
    } else if (isTurnCompleted) {
      translatedEvents.push({
        type: "turn/completed",
        threadId: args.threadId,
        turnId,
        turn: { id: turnId, items: [], status: "completed", error: null },
      });
    } else if (isItemCompleted) {
      translatedEvents.push({
        type: "item/completed",
        threadId: args.threadId,
        turnId,
        item: { type: "agentMessage", id: `assistant-${args.sequence}`, text: args.text ?? `response-${args.sequence}` },
      });
    } else if (isThreadStarted) {
      translatedEvents.push({
        type: "thread/started",
        threadId: args.threadId,
      });
    } else {
      translatedEvents.push({
        type: args.method,
        threadId: args.threadId,
      });
    }
    await sessionService.applyEventBatch({
      environmentId: resolveEnvironmentId(args.threadId),
      sessionId: args.sessionId,
      payload: makeEventBatch(args.threadId, [
        {
          sequence: args.sequence,
          eventId: `evt-${args.sequence}`,
          emittedAt: 2_000 + args.sequence,
          event: {
            type: "provider.event",
            threadId: args.threadId,
            method: args.method,
            providerId: "codex",
            normalizedMethod: args.method,
            shouldPersist: true,
            shouldBroadcast: true,
            translatedEvents: translatedEvents as never,
            ...(isTurnStarted ? { nextStatus: "active" as const, turnState: "active" as const, turnId } : {}),
            ...(isTurnCompleted ? { nextStatus: "idle" as const, turnState: "idle" as const, turnId } : {}),
          },
        },
      ]),
      now: 2_500 + args.sequence,
    });
  }

  async function completeNextCommand(args: {
    sessionThreadId: string;
    sessionId: string;
    afterCursor?: number;
    channelId?: string;
    commandType?: string;
    result?: unknown;
    state?: "completed" | "failed";
    errorCode?: string;
    errorMessage?: string;
  }): Promise<{
    channelId: string;
    commandId: string;
    commandCursor: number;
    command: Record<string, unknown>;
  }> {
    let commandEnvelope:
      | (ReturnType<typeof sessionService.listCommands>["payload"]["commands"][number])
      | undefined;

    await vi.waitFor(() => {
      const batch = sessionService.listCommands({
        environmentId: resolveEnvironmentId(args.sessionThreadId),
        sessionId: args.sessionId,
        afterCursor: args.afterCursor ?? 0,
        limit: 20,
        now: 2_000,
      });
      commandEnvelope = batch.payload.commands.find((candidate) => {
        if (args.channelId && candidate.channelId !== args.channelId) {
          return false;
        }
        if (args.commandType && candidate.command.type !== args.commandType) {
          return false;
        }
        return true;
      });
      expect(commandEnvelope).toBeDefined();
    });

    const envelope = commandEnvelope!;
    sessionService.recordCommandAck({
      environmentId: resolveEnvironmentId(args.sessionThreadId),
      sessionId: args.sessionId,
      payload: {
        commands: [
          {
            commandId: envelope.commandId,
            channelId: envelope.channelId,
            state: "received",
          },
        ],
      },
      now: 2_100,
    });

    const state = args.state ?? "completed";
    sessionService.recordCommandResult({
      environmentId: resolveEnvironmentId(args.sessionThreadId),
      sessionId: args.sessionId,
      payload:
        state === "completed"
          ? {
              channelId: envelope.channelId,
              commandId: envelope.commandId,
              state,
              ...(args.result !== undefined ? { result: args.result } : {}),
            }
          : {
              channelId: envelope.channelId,
              commandId: envelope.commandId,
              state,
              ...(args.errorCode !== undefined ? { errorCode: args.errorCode } : {}),
              ...(args.errorMessage !== undefined ? { errorMessage: args.errorMessage } : {}),
            },
      now: 2_200,
    });

    return {
      channelId: envelope.channelId,
      commandId: envelope.commandId,
      commandCursor: envelope.commandCursor,
      command: envelope.command as Record<string, unknown>,
    };
  }

  function latestAgentMessageText(threadId: string): string | undefined {
    for (const event of [...events.listByThread(threadId)].reverse()) {
      if (event.type !== "item/completed") {
        continue;
      }
      const data = toRecord(event.data);
      const item = toRecord(data?.item);
      if (item?.type !== "agentMessage") {
        continue;
      }
      if (typeof item.text === "string" && item.text) {
        return item.text;
      }
    }
    return undefined;
  }

  it("applies session event batches into orchestrator thread state", async () => {
    const threadId = createThread("idle");
    const sessionId = openSession(threadId);

    const ackStarted = await sessionService.applyEventBatch({
      environmentId: resolveEnvironmentId(threadId),
      sessionId,
      payload: makeEventBatch(threadId, [
        {
          sequence: 1,
          eventId: "evt-1",
          emittedAt: 2_000,
          event: {
            type: "provider.event",
            threadId,
            method: "turn/started",
            providerId: "codex",
            normalizedMethod: "turn/started",
            shouldPersist: true,
            shouldBroadcast: true,
            nextStatus: "active" as const,
            turnState: "active" as const,
            turnId: "turn-1",
            translatedEvents: [
              { type: "turn/started", threadId, turnId: "turn-1", turn: { id: "turn-1", items: [], status: "inProgress", error: null } },
            ] as never,
          },
        },
      ]),
      now: 2_100,
    });

    expect(ackStarted.type).toBe("event_ack");
    expect(threads.getById(threadId)?.status).toBe("active");
    expect(events.listByThread(threadId).map((event) => event.type)).toContain("turn/started");

    await sessionService.applyEventBatch({
      environmentId: resolveEnvironmentId(threadId),
      sessionId,
      payload: makeEventBatch(threadId, [
        {
          sequence: 2,
          eventId: "evt-2",
          emittedAt: 2_200,
          event: {
            type: "provider.event",
            threadId,
            method: "turn/completed",
            providerId: "codex",
            normalizedMethod: "turn/completed",
            shouldPersist: true,
            shouldBroadcast: true,
            nextStatus: "idle" as const,
            turnState: "idle" as const,
            turnId: "turn-1",
            translatedEvents: [
              { type: "turn/completed", threadId, turnId: "turn-1", turn: { id: "turn-1", items: [], status: "completed", error: null } },
            ] as never,
          },
        },
      ]),
      now: 2_300,
    });

    expect(threads.getById(threadId)?.status).toBe("idle");
    expect(cursors.getByThreadId(threadId)).toMatchObject({
      generation: 1,
      sequence: 2,
    });
  });

  it("drives deterministic shared-session multi-provider interleaving without crossing thread state", async () => {
    vi.stubEnv("ANTHROPIC_API_KEY", "test-key");
    const project = createProject();
    const environmentId = createSharedEnvironment(project.id, "session-orchestrator-shared-env");
    const codexThreadId = createThread("idle", {
      projectId: project.id,
      providerId: "codex",
      environmentId,
    });
    const claudeThreadId = createThread("idle", {
      projectId: project.id,
      providerId: "claude-code",
      environmentId,
    });
    attachments.attachThread({ threadId: codexThreadId, environmentId });
    attachments.attachThread({ threadId: claudeThreadId, environmentId });
    installRuntime(codexThreadId, "/tmp/session-orchestrator-shared-env");
    installRuntime(claudeThreadId, "/tmp/session-orchestrator-shared-env");

    const sessionId = openSession(codexThreadId, [codexThreadId, claudeThreadId]);

    events.create({
      threadId: codexThreadId,
      seq: 1,
      type: "thread/started",
      data: {},
    });
    events.create({
      threadId: codexThreadId,
      seq: 2,
      type: "thread/identity",
      data: { providerThreadId: "shared-provider-thread" },
    });
    events.create({
      threadId: claudeThreadId,
      seq: 1,
      type: "thread/started",
      data: {},
    });
    events.create({
      threadId: claudeThreadId,
      seq: 2,
      type: "thread/identity",
      data: { providerThreadId: "shared-provider-thread" },
    });

    const sequenceByThreadId = new Map<string, number>([
      [codexThreadId, 0],
      [claudeThreadId, 0],
    ]);

    async function emitTurnLifecycle(
      threadId: string,
      providerText: string,
      turnId: string,
    ): Promise<void> {
      const nextSequence = (sequenceByThreadId.get(threadId) ?? 0) + 1;
      sequenceByThreadId.set(threadId, nextSequence);
      await applyProviderEvent({
        threadId,
        sessionId,
        sequence: nextSequence,
        method: "turn/started",
      });

      const itemSequence = nextSequence + 1;
      sequenceByThreadId.set(threadId, itemSequence);
      await applyProviderEvent({
        threadId,
        sessionId,
        sequence: itemSequence,
        method: "item/completed",
        text: providerText,
      });

      const completedSequence = itemSequence + 1;
      sequenceByThreadId.set(threadId, completedSequence);
      await applyProviderEvent({
        threadId,
        sessionId,
        sequence: completedSequence,
        method: "turn/completed",
      });
    }

    async function driveFollowUp(args: {
      threadId: string;
      providerId: "codex" | "claude-code";
      input: string;
      output: string;
      turnId: string;
    }): Promise<void> {
      const tellPromise = orchestrator.tell(args.threadId, {
        input: [{ type: "text", text: args.input }],
      });

      const ensureForResume = await completeNextCommand({
        sessionThreadId: codexThreadId,
        sessionId,
        channelId: args.threadId,
        commandType: "provider.ensure",
        result: { running: true, launched: true, pid: 123 },
      });
      expect(ensureForResume.command).toMatchObject({
        type: "provider.ensure",
        providerId: args.providerId,
        context: expect.objectContaining({ threadId: args.threadId }),
      });

      const resumeResult = args.providerId === "claude-code"
        ? { providerThreadId: "shared-provider-thread" }
        : { threadId: "shared-provider-thread" };
      const resume = await completeNextCommand({
        sessionThreadId: codexThreadId,
        sessionId,
        afterCursor: ensureForResume.commandCursor,
        channelId: args.threadId,
        commandType: "thread.resume",
        result: resumeResult,
      });
      expect(resume.command).toMatchObject({
        type: "thread.resume",
        threadId: args.threadId,
        providerThreadId: "shared-provider-thread",
      });

      const ensureForTurn = await completeNextCommand({
        sessionThreadId: codexThreadId,
        sessionId,
        afterCursor: resume.commandCursor,
        channelId: args.threadId,
        commandType: "provider.ensure",
        result: { running: true, launched: true, pid: 123 },
      });
      expect(ensureForTurn.command).toMatchObject({
        type: "provider.ensure",
        providerId: args.providerId,
        context: expect.objectContaining({ threadId: args.threadId }),
      });

      const turnRun = await completeNextCommand({
        sessionThreadId: codexThreadId,
        sessionId,
        afterCursor: ensureForTurn.commandCursor,
        channelId: args.threadId,
        commandType: "turn.run",
        result: { ok: true },
      });
      expect(turnRun.command).toMatchObject({
        type: "turn.run",
        threadId: args.threadId,
        providerThreadId: "shared-provider-thread",
      });

      await emitTurnLifecycle(args.threadId, args.output, args.turnId);
      await tellPromise;
      expect(threads.getById(args.threadId)?.status).toBe("idle");
      expect(latestAgentMessageText(args.threadId)).toBe(args.output);
      expect(events.listByThread(args.threadId).map((event) => event.type)).not.toContain(
        "system/error",
      );
    }

    await driveFollowUp({
      threadId: codexThreadId,
      providerId: "codex",
      input: "A-1",
      output: "A-FOLLOWUP-1",
      turnId: "codex-turn-1",
    });
    await driveFollowUp({
      threadId: claudeThreadId,
      providerId: "claude-code",
      input: "B-1",
      output: "B-FOLLOWUP-1",
      turnId: "claude-turn-1",
    });
    await driveFollowUp({
      threadId: codexThreadId,
      providerId: "codex",
      input: "A-2",
      output: "A-FOLLOWUP-2",
      turnId: "codex-turn-2",
    });
    await driveFollowUp({
      threadId: claudeThreadId,
      providerId: "claude-code",
      input: "B-2",
      output: "B-FOLLOWUP-2",
      turnId: "claude-turn-2",
    });

    orchestrator.stop(codexThreadId);
    expect(threads.getById(codexThreadId)?.status).toBe("idle");
    expect(sessions.getActiveByEnvironmentId(environmentId, TEST_LEASE_NOW)?.id).toBe(sessionId);

    await driveFollowUp({
      threadId: claudeThreadId,
      providerId: "claude-code",
      input: "B-3",
      output: "B-AFTER-STOP",
      turnId: "claude-turn-3",
    });
    await driveFollowUp({
      threadId: codexThreadId,
      providerId: "codex",
      input: "A-3",
      output: "A-RETURN",
      turnId: "codex-turn-3",
    });

    expect(latestAgentMessageText(codexThreadId)).toBe("A-RETURN");
    expect(latestAgentMessageText(claudeThreadId)).toBe("B-AFTER-STOP");
    expect(events.listByThread(codexThreadId).some((event) =>
      JSON.stringify(event.data).includes("B-AFTER-STOP"),
    )).toBe(false);
    expect(events.listByThread(claudeThreadId).some((event) =>
      JSON.stringify(event.data).includes("A-RETURN"),
    )).toBe(false);
  });

  it("reports session-backed status from cursors and queued commands", async () => {
    const threadId = createThread("idle");
    const sessionId = openSession(threadId);

    await sessionService.applyEventBatch({
      environmentId: resolveEnvironmentId(threadId),
      sessionId,
      payload: makeEventBatch(threadId, [
        {
          sequence: 1,
          eventId: "evt-1",
          emittedAt: 2_000,
          event: {
            type: "provider.event",
            threadId,
            method: "turn/started",
            providerId: "codex",
            normalizedMethod: "turn/started",
            shouldPersist: true,
            shouldBroadcast: true,
            nextStatus: "active" as const,
            turnState: "active" as const,
            turnId: "turn-1",
            translatedEvents: [
              { type: "turn/started", threadId, turnId: "turn-1", turn: { id: "turn-1", items: [], status: "inProgress", error: null } },
            ] as never,
          },
        },
      ]),
    });

    commands.enqueue({
      id: "cmd-1",
      threadId,
      sessionId,
      commandType: "workspace.status",
      payload: {
        type: "workspace.status",
        threadId,
      },
      now: 2_100,
    });

    await expect(orchestrator.getEnvironmentDaemonStatus(threadId)).resolves.toMatchObject({
      threadId,
      latestSequence: 1,
      lastAckedSequence: 1,
      pendingCommandCount: 1,
      connectedToServer: true,
      deliveryState: "healthy",
    });
  });

  it("queues rename commands for active sessions and resolves them through command results", async () => {
    const threadId = createThread("idle");
    const sessionId = openSession(threadId);
    events.create({
      threadId,
      seq: 1,
      type: "thread/started",
      data: {},
    });
    events.create({
      threadId,
      seq: 2,
      type: "thread/identity",
      data: { providerThreadId: "provider-thread-1" },
    });

    const updated = orchestrator.updateThread(threadId, { title: "Renamed Thread" });
    expect(updated.title).toBe("Renamed Thread");

    await vi.waitFor(() => {
      expect(commands.listPendingByThreadId(threadId)).toHaveLength(1);
    });

    const providerEnsure = completeCommand({
      threadId,
      sessionId,
      result: { running: true, launched: true, pid: 123 },
    });
    expect(providerEnsure.command).toMatchObject({
      type: "provider.ensure",
      providerId: "codex",
      context: expect.objectContaining({ threadId }),
    });

    await vi.waitFor(() => {
      expect(commands.listPendingByThreadId(threadId)).toHaveLength(1);
    });

    const completed = completeCommand({
      threadId,
      sessionId,
      afterCursor: providerEnsure.commandCursor,
      result: {},
    });

    expect(completed.command).toMatchObject({
      type: "thread.rename",
      providerThreadId: "provider-thread-1",
      title: "Renamed Thread",
    });

    await vi.waitFor(() => {
      expect(commands.getById(completed.commandId)).toMatchObject({
        state: "completed",
      });
    });
    await new Promise((resolve) => setImmediate(resolve));
  });

  it("drives spawn through session queued provider.ensure, thread.start, provider.ensure, and turn.run commands", async () => {
    installSpawnRuntime();
    const project = createProject();

    const thread = await orchestrator.spawn({
      projectId: project.id,
      input: [{ type: "text", text: "Implement the feature" }],
    });
    const threadId = thread.id;
    await vi.waitFor(() => {
      expect(attachments.getByThreadId(threadId)?.environmentId).toBeTruthy();
    });
    const sessionId = openSession(threadId);

    await vi.waitFor(() => {
      expect(commands.listPendingByThreadId(threadId)).toHaveLength(1);
    });

    const providerEnsure = completeCommand({
      threadId,
      sessionId,
      result: { running: true, launched: true, pid: 123 },
    });
    expect(providerEnsure.command).toMatchObject({
      type: "provider.ensure",
      providerId: "codex",
      context: expect.objectContaining({ threadId }),
    });

    await vi.waitFor(() => {
      expect(commands.listPendingByThreadId(threadId)).toHaveLength(1);
    });

    const threadStart = completeCommand({
      threadId,
      sessionId,
      afterCursor: providerEnsure.commandCursor,
      result: { threadId: "provider-thread-1" },
    });
    expect(threadStart.command).toMatchObject({
      type: "thread.start",
      threadId,
      projectId: project.id,
    });

    await vi.waitFor(() => {
      expect(commands.listPendingByThreadId(threadId)).toHaveLength(1);
    });

    const turnStart = completeCommand({
      threadId,
      sessionId,
      afterCursor: threadStart.commandCursor,
      result: { running: true, launched: true, pid: 123 },
    });
    expect(turnStart.command).toMatchObject({
      type: "provider.ensure",
      providerId: "codex",
      context: expect.objectContaining({ threadId }),
    });

    await vi.waitFor(() => {
      expect(commands.listPendingByThreadId(threadId)).toHaveLength(1);
    });

    const turnStartRpc = completeCommand({
      threadId,
      sessionId,
      afterCursor: turnStart.commandCursor,
      result: { ok: true },
    });
    expect(turnStartRpc.command).toMatchObject({
      type: "turn.run",
      threadId,
      providerThreadId: "provider-thread-1",
    });
    await vi.waitFor(() => {
      expect(events.listByThread(threadId).map((event) => event.type)).toContain(
        "client/turn/start",
      );
    });

    await applyProviderEvent({
      threadId,
      sessionId,
      sequence: 1,
      method: "thread/started",
    });
    await applyProviderEvent({
      threadId,
      sessionId,
      sequence: 2,
      method: "turn/started",
    });
    await applyProviderEvent({
      threadId,
      sessionId,
      sequence: 3,
      method: "turn/completed",
    });

    await vi.waitFor(() => {
      expect(threads.getById(threadId)?.status).toBe("idle");
    });

    expect(events.listByThread(threadId).map((event) => event.type)).toEqual(
      expect.arrayContaining([
        "client/thread/start",
        "client/turn/start",
        "thread/started",
        "turn/started",
        "turn/completed",
      ]),
    );
  });

  it("drives tell through session queued provider.ensure, thread.resume, provider.ensure, and turn.run commands", async () => {
    const threadId = createThread("idle");
    installRuntime(threadId);
    const sessionId = openSession(threadId);
    events.create({
      threadId,
      seq: 1,
      type: "thread/started",
      data: {},
    });
    events.create({
      threadId,
      seq: 2,
      type: "thread/identity",
      data: { providerThreadId: "provider-thread-1" },
    });

    const tellPromise = orchestrator.tell(threadId, {
      input: [{ type: "text", text: "Continue" }],
    });

    await vi.waitFor(() => {
      expect(commands.listPendingByThreadId(threadId)).toHaveLength(1);
    });

    const providerEnsureForResume = completeCommand({
      threadId,
      sessionId,
      result: { running: true, launched: true, pid: 123 },
    });
    expect(providerEnsureForResume.command).toMatchObject({
      type: "provider.ensure",
      providerId: "codex",
      context: expect.objectContaining({ threadId }),
    });

    await vi.waitFor(() => {
      expect(commands.listPendingByThreadId(threadId)).toHaveLength(1);
    });

    const resume = completeCommand({
      threadId,
      sessionId,
      afterCursor: providerEnsureForResume.commandCursor,
      result: { threadId: "provider-thread-1" },
    });
    expect(resume.command).toMatchObject({
      type: "thread.resume",
      threadId,
      providerThreadId: "provider-thread-1",
    });

    await vi.waitFor(() => {
      expect(commands.listPendingByThreadId(threadId)).toHaveLength(1);
    });

    const providerEnsureForTurn = completeCommand({
      threadId,
      sessionId,
      afterCursor: resume.commandCursor,
      result: { running: true, launched: true, pid: 123 },
    });
    expect(providerEnsureForTurn.command).toMatchObject({
      type: "provider.ensure",
      providerId: "codex",
      context: expect.objectContaining({ threadId }),
    });

    await vi.waitFor(() => {
      expect(commands.listPendingByThreadId(threadId)).toHaveLength(1);
    });

    const turnStart = completeCommand({
      threadId,
      sessionId,
      afterCursor: providerEnsureForTurn.commandCursor,
      result: { ok: true },
    });
    expect(turnStart.command).toMatchObject({
      type: "turn.run",
      threadId,
      providerThreadId: "provider-thread-1",
    });

    await applyProviderEvent({
      threadId,
      sessionId,
      sequence: 1,
      method: "turn/started",
    });
    await applyProviderEvent({
      threadId,
      sessionId,
      sequence: 2,
      method: "turn/completed",
    });

    await tellPromise;
    expect(threads.getById(threadId)?.status).toBe("idle");
    let eventTypes: string[] = [];
    await vi.waitFor(() => {
      eventTypes = events.listByThread(threadId).map((event) => event.type);
      expect(eventTypes).toEqual(
        expect.arrayContaining([
          "client/turn/requested",
          "client/turn/start",
          "turn/started",
          "turn/completed",
        ]),
      );
    });
    expect(eventTypes.indexOf("client/turn/requested")).toBeGreaterThanOrEqual(0);
    expect(eventTypes.indexOf("turn/started")).toBeGreaterThanOrEqual(0);
    expect(eventTypes.indexOf("client/turn/requested")).toBeLessThan(
      eventTypes.indexOf("turn/started"),
    );
  });

  it("accepts resumed tell events after a fresh agent session resets a stale server cursor", async () => {
    const threadId = createThread("idle");
    installRuntime(threadId);
    cursors.upsert(threadId, { generation: 1, sequence: 9 }, 900);
    const sessionId = openSession(threadId);
    events.create({
      threadId,
      seq: 1,
      type: "thread/started",
      data: {},
    });
    events.create({
      threadId,
      seq: 2,
      type: "thread/identity",
      data: { providerThreadId: "provider-thread-1" },
    });

    const tellPromise = orchestrator.tell(threadId, {
      input: [{ type: "text", text: "Continue after restart" }],
    });

    await vi.waitFor(() => {
      expect(commands.listPendingByThreadId(threadId)).toHaveLength(1);
    });

    const providerEnsureForResume = completeCommand({
      threadId,
      sessionId,
      result: { running: true, launched: true, pid: 123 },
    });
    expect(providerEnsureForResume.command).toMatchObject({
      type: "provider.ensure",
      providerId: "codex",
      context: expect.objectContaining({ threadId }),
    });

    await vi.waitFor(() => {
      expect(commands.listPendingByThreadId(threadId)).toHaveLength(1);
    });

    const resume = completeCommand({
      threadId,
      sessionId,
      afterCursor: providerEnsureForResume.commandCursor,
      result: { threadId: "provider-thread-1" },
    });
    expect(resume.command).toMatchObject({
      type: "thread.resume",
      threadId,
      providerThreadId: "provider-thread-1",
    });

    await vi.waitFor(() => {
      expect(commands.listPendingByThreadId(threadId)).toHaveLength(1);
    });

    const providerEnsureForTurn = completeCommand({
      threadId,
      sessionId,
      afterCursor: resume.commandCursor,
      result: { running: true, launched: true, pid: 123 },
    });
    expect(providerEnsureForTurn.command).toMatchObject({
      type: "provider.ensure",
      providerId: "codex",
      context: expect.objectContaining({ threadId }),
    });

    await vi.waitFor(() => {
      expect(commands.listPendingByThreadId(threadId)).toHaveLength(1);
    });

    const turnStart = completeCommand({
      threadId,
      sessionId,
      afterCursor: providerEnsureForTurn.commandCursor,
      result: { ok: true },
    });
    expect(turnStart.command).toMatchObject({
      type: "turn.run",
      threadId,
      providerThreadId: "provider-thread-1",
    });

    await applyProviderEvent({
      threadId,
      sessionId,
      sequence: 1,
      method: "turn/started",
    });
    await applyProviderEvent({
      threadId,
      sessionId,
      sequence: 2,
      method: "turn/completed",
    });

    await tellPromise;
    expect(threads.getById(threadId)?.status).toBe("idle");
    expect(cursors.getByThreadId(threadId)).toMatchObject({
      generation: 1,
      sequence: 2,
    });
    await vi.waitFor(() => {
      expect(events.listByThread(threadId).map((event) => event.type)).toEqual(
        expect.arrayContaining(["client/turn/start", "turn/started", "turn/completed"]),
      );
    });
  });

  it("revalidates the provider thread after an env-daemon session closes and reopens", async () => {
    const threadId = createThread("idle");
    installRuntime(threadId);
    const firstSessionId = openSession(threadId);
    events.create({
      threadId,
      seq: 1,
      type: "thread/started",
      data: {},
    });
    events.create({
      threadId,
      seq: 2,
      type: "thread/identity",
      data: { providerThreadId: "provider-thread-1" },
    });

    const firstTell = orchestrator.tell(threadId, {
      input: [{ type: "text", text: "First pass" }],
    });

    await vi.waitFor(() => {
      expect(commands.listPendingByThreadId(threadId)).toHaveLength(1);
    });
    const firstEnsureForResume = completeCommand({
      threadId,
      sessionId: firstSessionId,
      result: { running: true, launched: true, pid: 123 },
    });
    await vi.waitFor(() => {
      expect(commands.listPendingByThreadId(threadId)).toHaveLength(1);
    });
    const firstResume = completeCommand({
      threadId,
      sessionId: firstSessionId,
      afterCursor: firstEnsureForResume.commandCursor,
      result: { threadId: "provider-thread-1" },
    });
    await vi.waitFor(() => {
      expect(commands.listPendingByThreadId(threadId)).toHaveLength(1);
    });
    const firstEnsureForTurn = completeCommand({
      threadId,
      sessionId: firstSessionId,
      afterCursor: firstResume.commandCursor,
      result: { running: true, launched: true, pid: 123 },
    });
    await vi.waitFor(() => {
      expect(commands.listPendingByThreadId(threadId)).toHaveLength(1);
    });
    completeCommand({
      threadId,
      sessionId: firstSessionId,
      afterCursor: firstEnsureForTurn.commandCursor,
      result: { ok: true },
    });

    await applyProviderEvent({
      threadId,
      sessionId: firstSessionId,
      sequence: 1,
      method: "turn/started",
    });
    await applyProviderEvent({
      threadId,
      sessionId: firstSessionId,
      sequence: 2,
      method: "turn/completed",
    });
    await firstTell;

    sessionService.closeSession({
      environmentId: resolveEnvironmentId(threadId),
      sessionId: firstSessionId,
      reason: "daemon_shutdown",
      now: 3_000,
    });
    const secondSessionId = openSession(threadId);

    const secondTell = orchestrator.tell(threadId, {
      input: [{ type: "text", text: "After reconnect" }],
    });

    await vi.waitFor(() => {
      expect(commands.listPendingByThreadId(threadId)).toHaveLength(1);
    });
    const secondEnsureForResume = completeCommand({
      threadId,
      sessionId: secondSessionId,
      result: { running: true, launched: true, pid: 123 },
    });
    expect(secondEnsureForResume.command).toMatchObject({
      type: "provider.ensure",
    });

    await vi.waitFor(() => {
      expect(commands.listPendingByThreadId(threadId)).toHaveLength(1);
    });
    const secondResume = completeCommand({
      threadId,
      sessionId: secondSessionId,
      afterCursor: secondEnsureForResume.commandCursor,
      result: { threadId: "provider-thread-1" },
    });
    expect(secondResume.command).toMatchObject({
      type: "thread.resume",
      threadId,
      providerThreadId: "provider-thread-1",
    });

    await vi.waitFor(() => {
      expect(commands.listPendingByThreadId(threadId)).toHaveLength(1);
    });
    const secondEnsureForTurn = completeCommand({
      threadId,
      sessionId: secondSessionId,
      afterCursor: secondResume.commandCursor,
      result: { running: true, launched: true, pid: 123 },
    });
    await vi.waitFor(() => {
      expect(commands.listPendingByThreadId(threadId)).toHaveLength(1);
    });
    completeCommand({
      threadId,
      sessionId: secondSessionId,
      afterCursor: secondEnsureForTurn.commandCursor,
      result: { ok: true },
    });

    await applyProviderEvent({
      threadId,
      sessionId: secondSessionId,
      sequence: 1,
      method: "turn/started",
    });
    await applyProviderEvent({
      threadId,
      sessionId: secondSessionId,
      sequence: 2,
      method: "turn/completed",
    });
    await secondTell;
    expect(threads.getById(threadId)?.status).toBe("idle");
  });

  // TODO: fix notification routing for multiple same-provider threads in shared environments
  it.skip("drops late session-backed provider events after stop until the next outbound turn", async () => {
    const project = createProject();
    const environmentId = createSharedEnvironment(project.id, "stop-shared-env");
    const threadId = createThread("idle", { projectId: project.id, environmentId });
    const siblingThreadId = createThread("idle", { projectId: project.id, environmentId });
    installRuntime(threadId);
    installRuntime(siblingThreadId);
    const sessionId = openSession(threadId, [threadId, siblingThreadId]);
    events.create({
      threadId,
      seq: 1,
      type: "thread/started",
      data: {},
    });
    events.create({
      threadId,
      seq: 2,
      type: "thread/identity",
      data: { providerThreadId: "provider-thread-1" },
    });

    const tellPromise = orchestrator.tell(threadId, {
      input: [{ type: "text", text: "Start a turn and stop it" }],
    });

    await vi.waitFor(() => {
      expect(commands.listPendingByThreadId(threadId)).toHaveLength(1);
    });
    const providerEnsureForResume = completeCommand({
      threadId,
      sessionId,
      result: { running: true, launched: true, pid: 123 },
    });
    await vi.waitFor(() => {
      expect(commands.listPendingByThreadId(threadId)).toHaveLength(1);
    });
    const resume = completeCommand({
      threadId,
      sessionId,
      afterCursor: providerEnsureForResume.commandCursor,
      result: { threadId: "provider-thread-1" },
    });
    await vi.waitFor(() => {
      expect(commands.listPendingByThreadId(threadId)).toHaveLength(1);
    });
    const providerEnsureForTurn = completeCommand({
      threadId,
      sessionId,
      afterCursor: resume.commandCursor,
      result: { running: true, launched: true, pid: 123 },
    });
    await vi.waitFor(() => {
      expect(commands.listPendingByThreadId(threadId)).toHaveLength(1);
    });
    completeCommand({
      threadId,
      sessionId,
      afterCursor: providerEnsureForTurn.commandCursor,
      result: { ok: true },
    });
    await vi.waitFor(() => {
      expect(events.listByThread(threadId).map((event) => event.type)).toContain(
        "client/turn/start",
      );
    });

    await applyProviderEvent({
      threadId,
      sessionId,
      sequence: 1,
      method: "turn/started",
    });
    await vi.waitFor(() => {
      expect(threads.getById(threadId)?.status).toBe("active");
    });

    orchestrator.stop(threadId);
    expect(threads.getById(threadId)?.status).toBe("idle");

    await applyProviderEvent({
      threadId,
      sessionId,
      sequence: 2,
      method: "item/completed",
    });
    await applyProviderEvent({
      threadId,
      sessionId,
      sequence: 3,
      method: "turn/completed",
    });

    await tellPromise;

    expect(events.listByThread(threadId).some((event) =>
      JSON.stringify(event.data).includes("SHOULD-NOT-LAND"),
    )).toBe(false);
    expect(
      events.listByThread(threadId).filter((event) => event.type === "turn/completed"),
    ).toHaveLength(0);
    expect(latestAgentMessageText(threadId)).toBeUndefined();

    const recoveryTell = orchestrator.tell(threadId, {
      input: [{ type: "text", text: "Retry after stop" }],
    });

    await vi.waitFor(() => {
      expect(commands.listPendingByThreadId(threadId)).toHaveLength(1);
    });
    const recoveryEnsureForResume = completeCommand({
      threadId,
      sessionId,
      result: { running: true, launched: true, pid: 123 },
    });
    await vi.waitFor(() => {
      expect(commands.listPendingByThreadId(threadId)).toHaveLength(1);
    });
    const recoveryResume = completeCommand({
      threadId,
      sessionId,
      afterCursor: recoveryEnsureForResume.commandCursor,
      result: { threadId: "provider-thread-1" },
    });
    await vi.waitFor(() => {
      expect(commands.listPendingByThreadId(threadId)).toHaveLength(1);
    });
    const recoveryEnsureForTurn = completeCommand({
      threadId,
      sessionId,
      afterCursor: recoveryResume.commandCursor,
      result: { running: true, launched: true, pid: 123 },
    });
    await vi.waitFor(() => {
      expect(commands.listPendingByThreadId(threadId)).toHaveLength(1);
    });
    completeCommand({
      threadId,
      sessionId,
      afterCursor: recoveryEnsureForTurn.commandCursor,
      result: { ok: true },
    });

    await applyProviderEvent({
      threadId,
      sessionId,
      sequence: 4,
      method: "turn/started",
    });
    await applyProviderEvent({
      threadId,
      sessionId,
      sequence: 5,
      method: "item/completed",
    });
    await applyProviderEvent({
      threadId,
      sessionId,
      sequence: 6,
      method: "turn/completed",
    });
    await recoveryTell;

    expect(latestAgentMessageText(threadId)).toBe("AFTER-STOP-OK");
  });

  it("recovers a stale turn.run within the same tell and only persists the accepted turn", async () => {
    const threadId = createThread("idle");
    installRuntime(threadId);
    const sessionId = openSession(threadId);
    events.create({
      threadId,
      seq: 1,
      type: "thread/started",
      data: {},
    });
    events.create({
      threadId,
      seq: 2,
      type: "thread/identity",
      data: { providerThreadId: "provider-thread-1" },
    });

    const tellPromise = orchestrator.tell(threadId, {
      input: [{ type: "text", text: "Retry stale turn start" }],
    });

    await vi.waitFor(() => {
      expect(commands.listPendingByThreadId(threadId)).toHaveLength(1);
    });
    const providerEnsureForResume = completeCommand({
      threadId,
      sessionId,
      result: { running: true, launched: true, pid: 123 },
    });
    await vi.waitFor(() => {
      expect(commands.listPendingByThreadId(threadId)).toHaveLength(1);
    });
    const resume = completeCommand({
      threadId,
      sessionId,
      afterCursor: providerEnsureForResume.commandCursor,
      result: { threadId: "provider-thread-1" },
    });
    expect(resume.command).toMatchObject({
      type: "thread.resume",
      threadId,
      providerThreadId: "provider-thread-1",
      context: expect.objectContaining({
        projectId: expect.any(String),
        threadId,
        path: expect.any(String),
      }),
    });
    await vi.waitFor(() => {
      expect(commands.listPendingByThreadId(threadId)).toHaveLength(1);
    });
    const providerEnsureForTurn = completeCommand({
      threadId,
      sessionId,
      afterCursor: resume.commandCursor,
      result: { running: true, launched: true, pid: 123 },
    });
    await vi.waitFor(() => {
      expect(commands.listPendingByThreadId(threadId)).toHaveLength(1);
    });
    const failedTurnStart = completeCommand({
      threadId,
      sessionId,
      afterCursor: providerEnsureForTurn.commandCursor,
      state: "failed",
      errorCode: "provider_rpc_error",
      errorMessage: "thread not found: provider-thread-1",
    });
    expect(failedTurnStart.command).toMatchObject({
      type: "turn.run",
      threadId,
      providerThreadId: "provider-thread-1",
    });

    await vi.waitFor(() => {
      expect(commands.listPendingByThreadId(threadId)).toHaveLength(1);
    });
    const providerEnsureForRestart = completeCommand({
      threadId,
      sessionId,
      afterCursor: failedTurnStart.commandCursor,
      result: { running: true, launched: true, pid: 123 },
    });
    expect(providerEnsureForRestart.command).toMatchObject({
      type: "provider.ensure",
    });

    await vi.waitFor(() => {
      expect(commands.listPendingByThreadId(threadId)).toHaveLength(1);
    });
    const restartedThread = completeCommand({
      threadId,
      sessionId,
      afterCursor: providerEnsureForRestart.commandCursor,
      result: { threadId: "provider-thread-2" },
    });
    expect(restartedThread.command).toMatchObject({
      type: "thread.start",
      threadId,
    });

    await vi.waitFor(() => {
      expect(commands.listPendingByThreadId(threadId)).toHaveLength(1);
    });
    const providerEnsureForRetryTurn = completeCommand({
      threadId,
      sessionId,
      afterCursor: restartedThread.commandCursor,
      result: { running: true, launched: true, pid: 123 },
    });
    expect(providerEnsureForRetryTurn.command).toMatchObject({
      type: "provider.ensure",
    });

    await vi.waitFor(() => {
      expect(commands.listPendingByThreadId(threadId)).toHaveLength(1);
    });
    const retriedTurnStart = completeCommand({
      threadId,
      sessionId,
      afterCursor: providerEnsureForRetryTurn.commandCursor,
      result: { ok: true },
    });
    expect(retriedTurnStart.command).toMatchObject({
      type: "turn.run",
      threadId,
      providerThreadId: "provider-thread-2",
    });
    await applyProviderEvent({
      threadId,
      sessionId,
      sequence: 1,
      method: "turn/started",
    });
    await applyProviderEvent({
      threadId,
      sessionId,
      sequence: 2,
      method: "turn/completed",
    });
    await tellPromise;

    expect(threads.getById(threadId)?.status).toBe("idle");
    expect(events.listByThread(threadId).map((event) => event.type)).not.toContain(
      "system/error",
    );
    let clientTurnStarts: ReturnType<typeof events.listByThread> = [];
    await vi.waitFor(() => {
      clientTurnStarts = events.listByThread(threadId)
        .filter((event) => event.type === "client/turn/start");
      expect(clientTurnStarts).toHaveLength(1);
    });
    expect(clientTurnStarts[0]?.data).toMatchObject({
      input: [{ type: "text", text: "Retry stale turn start" }],
      request: {
        params: expect.objectContaining({
          threadId,
          providerThreadId: "provider-thread-2",
        }),
      },
    });
  });

  it("rejects steer without an active turn before appending client turn start events", async () => {
    const threadId = createThread("active");
    installRuntime(threadId);
    const sessionId = openSession(threadId);
    events.create({
      threadId,
      seq: 1,
      type: "thread/started",
      data: {},
    });
    events.create({
      threadId,
      seq: 2,
      type: "thread/identity",
      data: { providerThreadId: "provider-thread-1" },
    });

    await expect(
      orchestrator.tell(threadId, {
        input: [{ type: "text", text: "Please steer" }],
        mode: "steer",
      }),
    ).rejects.toThrow(`Thread ${threadId} has no active turn to steer`);

    expect(commands.listPendingByThreadId(threadId)).toHaveLength(0);
    expect(events.listByThread(threadId).map((event) => event.type)).not.toContain(
      "client/turn/start",
    );
    expect(sessionService.listCommands({
      environmentId: resolveEnvironmentId(threadId),
      sessionId,
      afterCursor: 0,
      limit: 10,
      now: 2_000,
    }).payload.commands).toHaveLength(0);
  });

  it("marks spawn threads provisioning_failed when the queued thread.start command fails", async () => {
    installSpawnRuntime();
    const project = createProject();

    const thread = await orchestrator.spawn({
      projectId: project.id,
      input: [{ type: "text", text: "Break immediately" }],
    });
    const threadId = thread.id;
    await vi.waitFor(() => {
      expect(attachments.getByThreadId(threadId)?.environmentId).toBeTruthy();
    });
    const sessionId = openSession(threadId);

    await vi.waitFor(() => {
      expect(commands.listPendingByThreadId(threadId)).toHaveLength(1);
    });

    const providerEnsure = completeCommand({
      threadId,
      sessionId,
      result: { running: true, launched: true, pid: 123 },
    });
    expect(providerEnsure.command).toMatchObject({
      type: "provider.ensure",
      providerId: "codex",
      context: expect.objectContaining({ threadId }),
    });

    await vi.waitFor(() => {
      expect(commands.listPendingByThreadId(threadId)).toHaveLength(1);
    });

    const failed = completeCommand({
      threadId,
      sessionId,
      afterCursor: providerEnsure.commandCursor,
      state: "failed",
      errorCode: "provider_rpc_error",
      errorMessage: "Invalid params",
    });
    expect(failed.command).toMatchObject({
      type: "thread.start",
      threadId,
    });

    await vi.waitFor(() => {
      expect(threads.getById(threadId)?.status).toBe("provisioning_failed");
    });
    const eventTypes = events.listByThread(threadId).map((event) => event.type);
    expect(eventTypes).toContain("system/error");
    expect(eventTypes).not.toContain("system/provisioning/completed");
  });
});
