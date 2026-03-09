import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Thread } from "@beanbag/agent-core";
import type { EnvironmentService } from "../environment-service.js";
import type {
  ThreadRepository,
  EventRepository,
  ProjectRepository,
} from "@beanbag/db";
import type { WSManager } from "../ws.js";
import type { LlmCompletionService } from "@beanbag/agent-server";
import {
  ENVIRONMENT_AGENT_PROTOCOL_VERSION,
  type EnvironmentAgentEventEnvelope,
} from "@beanbag/environment-agent";
import type { IEnvironment } from "@beanbag/environment";
import { Orchestrator } from "../orchestrator.js";

function makeThread(overrides: Partial<Thread> = {}): Thread {
  return {
    id: "thread-1",
    projectId: "proj-1",
    status: "active",
    createdAt: 1_000,
    updatedAt: 1_000,
    ...overrides,
  };
}

function createMocks() {
  const threadRepo = {
    create: vi.fn(),
    getById: vi.fn(),
    list: vi.fn(),
    update: vi.fn(),
    markRead: vi.fn(),
    delete: vi.fn(),
    enqueueQueuedMessage: vi.fn(),
    getQueuedMessage: vi.fn(),
    deleteQueuedMessage: vi.fn(),
  } as unknown as ThreadRepository;

  const eventRepo = {
    create: vi.fn(),
    updateData: vi.fn(),
    listByThread: vi.fn(),
    getLatestSeq: vi.fn(),
    getLatestByType: vi.fn(),
    getLatestExecutionOptions: vi.fn(),
  } as unknown as EventRepository;

  const projectRepo = {
    create: vi.fn(),
    getById: vi.fn(),
    list: vi.fn(),
    delete: vi.fn(),
  } as unknown as ProjectRepository;

  const ws = {
    broadcast: vi.fn(),
    handleConnection: vi.fn(),
    close: vi.fn(),
  } as unknown as WSManager;

  return { threadRepo, eventRepo, projectRepo, ws };
}

function createMockLlmCompletionService(): LlmCompletionService {
  return {
    displayName: "Mock LLM",
    generateThreadTitle: vi.fn().mockResolvedValue(undefined),
    generateCommitMessage: vi.fn().mockResolvedValue(undefined),
  };
}

function createTestRuntimeEnv(
  overrides: NodeJS.ProcessEnv = {},
): NodeJS.ProcessEnv {
  return {
    ...process.env,
    BEANBAG_ENVIRONMENT_AGENT_BASE_URL: "http://127.0.0.1:4312",
    BEANBAG_ENVIRONMENT_AGENT_AUTH_TOKEN: "test-token",
    ...overrides,
  };
}

function makeRuntimeEnvironment(args: {
  rootPath: string;
  authorization?: string;
}): IEnvironment {
  return {
    kind: "worktree",
    info: {
      id: "worktree",
      displayName: "Git Worktree Workspace",
      description: "",
      capabilities: {
        host_filesystem: true,
        isolated_workspace: true,
        promote_primary_checkout: true,
        demote_primary_checkout: true,
        squash_merge: true,
      },
    },
    serialize() {
      return {};
    },
    dispose() {},
    exists() {
      return true;
    },
    supportsHostFilesystemAccess() {
      return true;
    },
    isIsolatedWorkspace() {
      return true;
    },
    getAgentConnectionTarget() {
      return {
        transport: "http" as const,
        baseUrl: "http://127.0.0.1:4312",
        ...(args.authorization
          ? { headers: { authorization: args.authorization } }
          : {}),
      };
    },
    getCheckoutSnapshot() {
      return {
        branch: "bb/thread-1",
        head: "abc123",
        detached: false,
      };
    },
    getWorkspaceRootUnsafe() {
      return args.rootPath;
    },
    getWorkspaceStatus() {
      return {
        state: "clean" as const,
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
        workStatus: this.getWorkspaceStatus(),
      };
    },
    listWorkspaceCommitsSinceRef() {
      return [];
    },
    getWorkspaceDiff() {
      return { diff: "", truncated: false };
    },
    spawn: vi.fn(),
    shouldRunSetupScript() {
      return false;
    },
    supportsPromoteToActiveWorkspace() {
      return true;
    },
    supportsDemoteFromActiveWorkspace() {
      return true;
    },
    supportsSquashMergeIntoDefaultBranch() {
      return true;
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

describe("Orchestrator environment-agent delivery and replay", () => {
  let threadRepo: ReturnType<typeof createMocks>["threadRepo"];
  let eventRepo: ReturnType<typeof createMocks>["eventRepo"];
  let projectRepo: ReturnType<typeof createMocks>["projectRepo"];
  let ws: ReturnType<typeof createMocks>["ws"];
  let manager: Orchestrator;

  function installAuthorizedEnvironmentRuntime(
    threadId: string,
    authorization: string,
  ): void {
    (
      manager as unknown as {
        environmentService: Pick<EnvironmentService, "setEnvironmentRuntime">;
      }
    ).environmentService.setEnvironmentRuntime(
      threadId,
      makeRuntimeEnvironment({
        rootPath: "/test",
        authorization,
      }),
    );
  }

  beforeEach(() => {
    vi.clearAllMocks();
    const mocks = createMocks();
    threadRepo = mocks.threadRepo;
    eventRepo = mocks.eventRepo;
    projectRepo = mocks.projectRepo;
    ws = mocks.ws;
    manager = new Orchestrator(
      threadRepo,
      eventRepo,
      projectRepo,
      ws,
      createMockLlmCompletionService(),
      undefined,
      createTestRuntimeEnv(),
    );
  });

  it("only ingests contiguous unseen environment-agent events and advances the cursor", async () => {
    const thread = makeThread({
      id: "thread-1",
      projectId: "proj-1",
      environmentAgentCursor: 1,
    } as Thread & { environmentAgentCursor: number }) as Thread & {
      environmentAgentCursor: number;
    };
    (threadRepo.getById as ReturnType<typeof vi.fn>).mockImplementation(
      (threadId: string) => (threadId === "thread-1" ? thread : undefined),
    );
    (threadRepo.update as ReturnType<typeof vi.fn>).mockImplementation(
      (_threadId: string, updates: Partial<Thread> & { environmentAgentCursor?: number }) => {
        Object.assign(thread, updates);
        return thread;
      },
    );
    installAuthorizedEnvironmentRuntime("thread-1", "Bearer test-token");

    const ingestSpy = vi
      .spyOn(
        (manager as unknown as { agentServer: { ingestReplayedEnvironmentAgentEvents: (args: unknown) => Promise<void> } }).agentServer,
        "ingestReplayedEnvironmentAgentEvents",
      )
      .mockResolvedValue(undefined);

    const events: EnvironmentAgentEventEnvelope[] = [
      {
        protocolVersion: ENVIRONMENT_AGENT_PROTOCOL_VERSION,
        sequence: 1,
        emittedAt: 1_000,
        threadId: "thread-1",
        event: { type: "environment.ready", threadId: "thread-1" },
      },
      {
        protocolVersion: ENVIRONMENT_AGENT_PROTOCOL_VERSION,
        sequence: 2,
        emittedAt: 1_001,
        threadId: "thread-1",
        event: {
          type: "provider.event",
          threadId: "thread-1",
          method: "turn/started",
          payload: { turnId: "turn-1" },
        },
      },
      {
        protocolVersion: ENVIRONMENT_AGENT_PROTOCOL_VERSION,
        sequence: 4,
        emittedAt: 1_003,
        threadId: "thread-1",
        event: {
          type: "provider.event",
          threadId: "thread-1",
          method: "turn/completed",
          payload: { turnId: "turn-1" },
        },
      },
    ];

    await expect(
      manager.ingestEnvironmentAgentEvents({
        threadId: "thread-1",
        authorizationHeader: "Bearer test-token",
        events,
      }),
    ).resolves.toMatchObject({
      protocolVersion: ENVIRONMENT_AGENT_PROTOCOL_VERSION,
      threadId: "thread-1",
      acknowledgedSequence: 2,
    });

    expect(ingestSpy).toHaveBeenCalledWith({
      threadId: "thread-1",
      events: [events[1]],
    });
    expect(thread.environmentAgentCursor).toBe(2);
  });

  it("treats duplicate or gapped delivery as idempotent and preserves the cursor", async () => {
    const thread = makeThread({
      id: "thread-1",
      projectId: "proj-1",
      environmentAgentCursor: 2,
    } as Thread & { environmentAgentCursor: number }) as Thread & {
      environmentAgentCursor: number;
    };
    (threadRepo.getById as ReturnType<typeof vi.fn>).mockImplementation(
      (threadId: string) => (threadId === "thread-1" ? thread : undefined),
    );
    installAuthorizedEnvironmentRuntime("thread-1", "Bearer test-token");

    const ingestSpy = vi
      .spyOn(
        (manager as unknown as { agentServer: { ingestReplayedEnvironmentAgentEvents: (args: unknown) => Promise<void> } }).agentServer,
        "ingestReplayedEnvironmentAgentEvents",
      )
      .mockResolvedValue(undefined);

    await expect(
      manager.ingestEnvironmentAgentEvents({
        threadId: "thread-1",
        authorizationHeader: "Bearer test-token",
        events: [
          {
            protocolVersion: ENVIRONMENT_AGENT_PROTOCOL_VERSION,
            sequence: 1,
            emittedAt: 1_000,
            threadId: "thread-1",
            event: { type: "environment.ready", threadId: "thread-1" },
          },
          {
            protocolVersion: ENVIRONMENT_AGENT_PROTOCOL_VERSION,
            sequence: 4,
            emittedAt: 1_003,
            threadId: "thread-1",
            event: {
              type: "provider.event",
              threadId: "thread-1",
              method: "turn/completed",
              payload: { turnId: "turn-1" },
            },
          },
        ],
      }),
    ).resolves.toMatchObject({
      protocolVersion: ENVIRONMENT_AGENT_PROTOCOL_VERSION,
      threadId: "thread-1",
      acknowledgedSequence: 2,
    });

    expect(ingestSpy).not.toHaveBeenCalled();
    expect(thread.environmentAgentCursor).toBe(2);
  });

  it("rejects unauthorized environment-agent delivery", async () => {
    const thread = makeThread({
      id: "thread-1",
      projectId: "proj-1",
      environmentAgentCursor: 0,
    } as Thread & { environmentAgentCursor: number }) as Thread & {
      environmentAgentCursor: number;
    };
    (threadRepo.getById as ReturnType<typeof vi.fn>).mockImplementation(
      (threadId: string) => (threadId === "thread-1" ? thread : undefined),
    );
    installAuthorizedEnvironmentRuntime("thread-1", "Bearer test-token");

    await expect(
      manager.ingestEnvironmentAgentEvents({
        threadId: "thread-1",
        authorizationHeader: "Bearer wrong-token",
        events: [
          {
            protocolVersion: ENVIRONMENT_AGENT_PROTOCOL_VERSION,
            sequence: 1,
            emittedAt: 1_000,
            threadId: "thread-1",
            event: { type: "environment.ready", threadId: "thread-1" },
          },
        ],
      }),
    ).rejects.toMatchObject({
      message: "Unauthorized environment-agent delivery",
    });
  });

  it("replays buffered events from the persisted cursor and advances it", async () => {
    const thread = makeThread({
      id: "thread-1",
      projectId: "proj-1",
      environmentAgentCursor: 4,
    } as Thread & { environmentAgentCursor: number }) as Thread & {
      environmentAgentCursor: number;
    };
    (threadRepo.getById as ReturnType<typeof vi.fn>).mockImplementation(
      (threadId: string) => (threadId === "thread-1" ? thread : undefined),
    );
    (threadRepo.update as ReturnType<typeof vi.fn>).mockImplementation(
      (_threadId: string, updates: Partial<Thread> & { environmentAgentCursor?: number }) => {
        Object.assign(thread, updates);
        return thread;
      },
    );

    const replaySpy = vi
      .spyOn(
        (manager as unknown as { agentServer: { replayEnvironmentAgentEvents: (args: unknown) => Promise<unknown> } }).agentServer,
        "replayEnvironmentAgentEvents",
      )
      .mockResolvedValue({
        fromSequenceExclusive: 4,
        toSequenceInclusive: 6,
        hasMore: false,
        events: [
          {
            protocolVersion: ENVIRONMENT_AGENT_PROTOCOL_VERSION,
            sequence: 5,
            emittedAt: 1_005,
            threadId: "thread-1",
            event: {
              type: "provider.event",
              threadId: "thread-1",
              method: "turn/started",
              payload: { turnId: "turn-1" },
            },
          },
          {
            protocolVersion: ENVIRONMENT_AGENT_PROTOCOL_VERSION,
            sequence: 6,
            emittedAt: 1_006,
            threadId: "thread-1",
            event: {
              type: "provider.event",
              threadId: "thread-1",
              method: "turn/completed",
              payload: { turnId: "turn-1" },
            },
          },
        ],
      });
    const ingestSpy = vi
      .spyOn(
        (manager as unknown as { agentServer: { ingestReplayedEnvironmentAgentEvents: (args: unknown) => Promise<void> } }).agentServer,
        "ingestReplayedEnvironmentAgentEvents",
      )
      .mockResolvedValue(undefined);

    await (
      manager as unknown as {
        _replayBufferedEnvironmentAgentEvents: (threadId: string) => Promise<void>;
      }
    )._replayBufferedEnvironmentAgentEvents("thread-1");

    expect(replaySpy).toHaveBeenCalledWith({
      threadId: "thread-1",
      afterSequence: 4,
    });
    expect(ingestSpy).toHaveBeenCalledWith({
      threadId: "thread-1",
      events: expect.arrayContaining([
        expect.objectContaining({ sequence: 5 }),
        expect.objectContaining({ sequence: 6 }),
      ]),
    });
    expect(thread.environmentAgentCursor).toBe(6);
  });

  it("prefers the in-memory replay cursor over the persisted cursor on subsequent recovery", async () => {
    const thread = makeThread({
      id: "thread-1",
      projectId: "proj-1",
      environmentAgentCursor: 2,
    } as Thread & { environmentAgentCursor: number }) as Thread & {
      environmentAgentCursor: number;
    };
    (threadRepo.getById as ReturnType<typeof vi.fn>).mockImplementation(
      (threadId: string) => (threadId === "thread-1" ? thread : undefined),
    );
    (threadRepo.update as ReturnType<typeof vi.fn>).mockImplementation(
      (_threadId: string, updates: Partial<Thread> & { environmentAgentCursor?: number }) => {
        Object.assign(thread, updates);
        return thread;
      },
    );

    const replaySpy = vi
      .spyOn(
        (manager as unknown as { agentServer: { replayEnvironmentAgentEvents: (args: unknown) => Promise<unknown> } }).agentServer,
        "replayEnvironmentAgentEvents",
      )
      .mockResolvedValue({
        fromSequenceExclusive: 5,
        toSequenceInclusive: 7,
        hasMore: false,
        events: [],
      });

    (
      manager as unknown as {
        environmentAgentReplayCursorByThreadId: Map<string, number>;
      }
    ).environmentAgentReplayCursorByThreadId.set("thread-1", 5);

    await (
      manager as unknown as {
        _replayBufferedEnvironmentAgentEvents: (threadId: string) => Promise<void>;
      }
    )._replayBufferedEnvironmentAgentEvents("thread-1");

    expect(replaySpy).toHaveBeenCalledWith({
      threadId: "thread-1",
      afterSequence: 5,
    });
    expect(thread.environmentAgentCursor).toBe(7);
  });

  it("swallows retry-delivery failures while nudging the environment agent", async () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const retrySpy = vi
      .spyOn(
        (manager as unknown as {
          agentServer: { retryEnvironmentAgentDelivery: (threadId: string) => Promise<unknown> };
        }).agentServer,
        "retryEnvironmentAgentDelivery",
      )
      .mockRejectedValue(new Error("transport down"));

    await (
      manager as unknown as {
        _nudgeEnvironmentAgentDelivery: (threadId: string) => Promise<void>;
      }
    )._nudgeEnvironmentAgentDelivery("thread-1");

    expect(retrySpy).toHaveBeenCalledWith("thread-1");
    expect(warnSpy).toHaveBeenCalledWith(
      "[thread thread-1] Failed to nudge environment-agent delivery: transport down",
    );
    warnSpy.mockRestore();
  });
});
