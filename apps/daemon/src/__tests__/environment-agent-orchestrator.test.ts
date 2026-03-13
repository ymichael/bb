import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Thread } from "@beanbag/agent-core";
import type * as environmentAgent from "@beanbag/environment-agent";
import type { EnvironmentService } from "../environment-service.js";
import {
  EnvironmentAgentSessionUnavailableError,
  type EnvironmentAgentCommandDispatcher,
} from "../environment-agent-command-dispatcher.js";
import type {
  ThreadRepository,
  EventRepository,
  ProjectRepository,
} from "@beanbag/db";
import type { WSManager } from "../ws.js";
import type { LlmCompletionService } from "@beanbag/agent-server";
import type { IEnvironment } from "@beanbag/environment";
import { providerTimeoutError } from "../domain-errors.js";
import { Orchestrator } from "../orchestrator.js";

function makeThread(overrides: Partial<Thread> = {}): Thread {
  return {
    id: "thread-1",
    projectId: "proj-1",
    providerId: "codex",
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
    suspend() {},
    destroy() {},
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
  let sessionService: { getThreadStatus: ReturnType<typeof vi.fn> };

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
    sessionService = {
      getThreadStatus: vi.fn(),
    };
    manager = new Orchestrator(
      threadRepo,
      eventRepo,
      projectRepo,
      ws,
      createMockLlmCompletionService(),
      undefined,
      createTestRuntimeEnv(),
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      sessionService as never,
    );
  });

  it("uses the session command client for environment-agent commands", async () => {
    const sessionModeManager = new Orchestrator(
      threadRepo,
      eventRepo,
      projectRepo,
      ws,
      createMockLlmCompletionService(),
      undefined,
      createTestRuntimeEnv(),
      undefined,
      undefined,
      undefined,
      undefined,
      {
        awaitActiveSession: vi.fn().mockResolvedValue({ id: "sess-1" }),
        enqueueForActiveSession: vi.fn().mockResolvedValue({
          id: "cmd-1",
          threadId: "thread-1",
          commandCursor: 1,
          commandType: "workspace.status",
          payload: { type: "workspace.status", threadId: "thread-1" },
          state: "completed",
          result: { ok: true },
          createdAt: 1_000,
          updatedAt: 1_100,
        }),
      } as unknown as import("../environment-agent-command-dispatcher.js").EnvironmentAgentCommandDispatcher,
      sessionService as never,
    );

    const result = await (sessionModeManager as unknown as {
      _withEnvironmentAgentTarget: (args: {
        thread: Thread;
        projectRootPath: string;
        target: { baseUrl: string; transport: "http" };
        action: (input: {
          client: environmentAgent.EnvironmentAgentClient;
          thread: Thread;
          projectRootPath: string;
        }) => Promise<string>;
      }) => Promise<string>;
    })._withEnvironmentAgentTarget({
      thread: makeThread(),
      projectRootPath: "/test",
      target: {
        transport: "http",
        baseUrl: "http://127.0.0.1:4312",
      },
      action: async ({ client }) => {
        const ack = await client.sendCommand({
          meta: {
            protocolVersion: 1,
            commandId: "cmd-1",
            idempotencyKey: "cmd-1",
            sentAt: 1_050,
          },
          command: {
            type: "workspace.status",
            threadId: "thread-1",
          },
        });
        return ack.state;
      },
    });

    expect(result).toBe("accepted");
  });

  it("re-ensures environment-agent access before resuming a persisted provider thread", async () => {
    const thread = makeThread({
      status: "idle",
      environmentId: "worktree",
    });
    (threadRepo.getById as ReturnType<typeof vi.fn>).mockReturnValue(thread);
    (
      eventRepo as unknown as {
        getLatestProviderThreadId: ReturnType<typeof vi.fn>;
      }
    ).getLatestProviderThreadId = vi.fn().mockReturnValue("provider-thread-1");
    (projectRepo.getById as ReturnType<typeof vi.fn>).mockReturnValue({
      id: "proj-1",
      name: "Project",
      rootPath: "/test",
      createdAt: 1_000,
      updatedAt: 1_000,
    });

    let hasActiveSession = false;
    const dispatcher = {
      hasActiveSession: vi.fn(() => hasActiveSession),
      awaitActiveSession: vi.fn(async () => {
        if (!hasActiveSession) {
          throw new Error("missing active session");
        }
        return { id: "sess-1" };
      }),
      enqueueForActiveSession: vi.fn(async () => ({
        id: "cmd-resume",
        threadId: "thread-1",
        sessionId: "sess-1",
        commandCursor: 1,
        commandType: "thread.resume",
        payload: {
          type: "thread.resume",
          threadId: "thread-1",
          providerThreadId: "provider-thread-1",
        },
        state: "completed",
        result: { threadId: "provider-thread-1" },
        createdAt: 1_000,
        updatedAt: 1_100,
      })),
    } as unknown as EnvironmentAgentCommandDispatcher;

    const resumeManager = new Orchestrator(
      threadRepo,
      eventRepo,
      projectRepo,
      ws,
      createMockLlmCompletionService(),
      undefined,
      createTestRuntimeEnv({
        BEANBAG_ENVIRONMENT_AGENT_BASE_URL: undefined,
        BEANBAG_ENVIRONMENT_AGENT_AUTH_TOKEN: undefined,
      }),
      undefined,
      undefined,
      undefined,
      undefined,
      dispatcher,
      sessionService as never,
    );

    const environmentService = (
      resumeManager as unknown as {
        environmentService: Pick<
          EnvironmentService,
          | "getEnvironmentRuntime"
          | "suspendEnvironmentRuntimeAndWait"
          | "ensureThreadEnvironmentRuntime"
        >;
      }
    ).environmentService;

    const runtimeEnvironment = makeRuntimeEnvironment({
      rootPath: "/test",
      authorization: "Bearer test-token",
    });
    const activeRuntime = {
      ownerThreadId: "thread-1",
      environment: runtimeEnvironment,
      agentConnectionTarget: runtimeEnvironment.getAgentConnectionTarget(),
    };
    environmentService.getEnvironmentRuntime = vi.fn(() => activeRuntime);
    environmentService.suspendEnvironmentRuntimeAndWait = vi.fn(async () => undefined);
    environmentService.ensureThreadEnvironmentRuntime = vi.fn(async () => {
      hasActiveSession = true;
      return {
        runtime: activeRuntime,
      };
    });

    const resumeThreadCommand = vi.fn(
      async ({ client }: { client: environmentAgent.EnvironmentAgentClient }) => {
        const ack = await client.sendCommand({
          meta: {
            protocolVersion: 1,
            commandId: "cmd-resume",
            idempotencyKey: "cmd-resume",
            sentAt: 1_050,
          },
          command: {
            type: "thread.resume",
            threadId: "thread-1",
            providerThreadId: "provider-thread-1",
          } as never,
        });
        expect(ack).toMatchObject({
          state: "accepted",
          result: { threadId: "provider-thread-1" },
        });
        return { providerThreadId: "provider-thread-1" };
      },
    );

    (
      resumeManager as unknown as {
        agentServer: { resumeThreadCommand: typeof resumeThreadCommand };
      }
    ).agentServer.resumeThreadCommand = resumeThreadCommand;

    const providerThreadId = await (
      resumeManager as unknown as {
        _ensureProviderSession: (threadId: string) => Promise<string>;
      }
    )._ensureProviderSession("thread-1");

    expect(providerThreadId).toBe("provider-thread-1");
    expect(environmentService.suspendEnvironmentRuntimeAndWait).not.toHaveBeenCalled();
    expect(environmentService.ensureThreadEnvironmentRuntime).toHaveBeenCalledWith(
      thread,
      "/test",
      "resume-existing-provider-session",
    );
    expect(dispatcher.awaitActiveSession).toHaveBeenCalledWith({
      threadId: "thread-1",
      timeoutMs: 1_000,
    });
    expect(resumeThreadCommand).toHaveBeenCalled();
  });

  it("retries a provider resume after session loss through the daemon ensure path", async () => {
    const thread = makeThread({
      status: "idle",
      environmentId: "worktree",
    });
    (threadRepo.getById as ReturnType<typeof vi.fn>).mockReturnValue(thread);
    (
      eventRepo as unknown as {
        getLatestProviderThreadId: ReturnType<typeof vi.fn>;
      }
    ).getLatestProviderThreadId = vi.fn().mockReturnValue("provider-thread-1");
    (projectRepo.getById as ReturnType<typeof vi.fn>).mockReturnValue({
      id: "proj-1",
      name: "Project",
      rootPath: "/test",
      createdAt: 1_000,
      updatedAt: 1_000,
    });

    const dispatcher = {
      hasActiveSession: vi.fn(() => false),
      awaitActiveSession: vi.fn().mockResolvedValue({ id: "sess-1" }),
      enqueueForActiveSession: vi
        .fn()
        .mockRejectedValueOnce(
          new EnvironmentAgentSessionUnavailableError("thread-1"),
        )
        .mockResolvedValueOnce({
          id: "cmd-resume",
          threadId: "thread-1",
          sessionId: "sess-1",
          commandCursor: 1,
          commandType: "thread.resume",
          payload: {
            type: "thread.resume",
            threadId: "thread-1",
            providerThreadId: "provider-thread-1",
          },
          state: "completed",
          result: { threadId: "provider-thread-1" },
          createdAt: 1_000,
          updatedAt: 1_100,
        }),
    } as unknown as EnvironmentAgentCommandDispatcher;

    const retryManager = new Orchestrator(
      threadRepo,
      eventRepo,
      projectRepo,
      ws,
      createMockLlmCompletionService(),
      undefined,
      createTestRuntimeEnv({
        BEANBAG_ENVIRONMENT_AGENT_BASE_URL: undefined,
        BEANBAG_ENVIRONMENT_AGENT_AUTH_TOKEN: undefined,
      }),
      undefined,
      undefined,
      undefined,
      undefined,
      dispatcher,
      sessionService as never,
    );

    const environmentService = (
      retryManager as unknown as {
        environmentService: Pick<
          EnvironmentService,
          "ensureThreadEnvironmentRuntime"
        >;
      }
    ).environmentService;

    const runtimeEnvironment = makeRuntimeEnvironment({
      rootPath: "/test",
      authorization: "Bearer test-token",
    });
    const activeRuntime = {
      ownerThreadId: "thread-1",
      environment: runtimeEnvironment,
      agentConnectionTarget: runtimeEnvironment.getAgentConnectionTarget(),
    };
    environmentService.ensureThreadEnvironmentRuntime = vi.fn(async () => ({
      runtime: activeRuntime,
    }));

    const resumeThreadCommand = vi.fn(
      async ({ client }: { client: environmentAgent.EnvironmentAgentClient }) => {
        const ack = await client.sendCommand({
          meta: {
            protocolVersion: 1,
            commandId: "cmd-resume",
            idempotencyKey: "cmd-resume",
            sentAt: 1_050,
          },
          command: {
            type: "thread.resume",
            threadId: "thread-1",
            providerThreadId: "provider-thread-1",
          } as never,
        });
        expect(ack).toMatchObject({
          state: "accepted",
          result: { threadId: "provider-thread-1" },
        });
        return { providerThreadId: "provider-thread-1" };
      },
    );

    (
      retryManager as unknown as {
        agentServer: { resumeThreadCommand: typeof resumeThreadCommand };
      }
    ).agentServer.resumeThreadCommand = resumeThreadCommand;

    const providerThreadId = await (
      retryManager as unknown as {
        _ensureProviderSession: (threadId: string) => Promise<string>;
      }
    )._ensureProviderSession("thread-1");

    expect(providerThreadId).toBe("provider-thread-1");
    expect(environmentService.ensureThreadEnvironmentRuntime).toHaveBeenCalledTimes(2);
    expect(dispatcher.awaitActiveSession).toHaveBeenCalledTimes(2);
    expect(resumeThreadCommand).toHaveBeenCalledTimes(1);
  });

  it("recycles the runtime when env-daemon access cannot find a fresh session", async () => {
    const thread = makeThread({
      status: "idle",
      environmentId: "local",
    });
    (threadRepo.getById as ReturnType<typeof vi.fn>).mockReturnValue(thread);
    (projectRepo.getById as ReturnType<typeof vi.fn>).mockReturnValue({
      id: "proj-1",
      name: "Project",
      rootPath: "/test",
      createdAt: 1_000,
      updatedAt: 1_000,
    });

    const dispatcher = {
      awaitActiveSession: vi
        .fn()
        .mockRejectedValueOnce(
          new EnvironmentAgentSessionUnavailableError("thread-1"),
        )
        .mockResolvedValueOnce({ id: "sess-2" }),
    } as unknown as EnvironmentAgentCommandDispatcher;

    const manager = new Orchestrator(
      threadRepo,
      eventRepo,
      projectRepo,
      ws,
      createMockLlmCompletionService(),
      undefined,
      createTestRuntimeEnv({
        BEANBAG_ENVIRONMENT_AGENT_BASE_URL: undefined,
        BEANBAG_ENVIRONMENT_AGENT_AUTH_TOKEN: undefined,
      }),
      undefined,
      undefined,
      undefined,
      undefined,
      dispatcher,
      sessionService as never,
    );

    const environmentService = (
      manager as unknown as {
        environmentService: Pick<
          EnvironmentService,
          "ensureThreadEnvironmentRuntime" | "suspendEnvironmentRuntimeAndWait"
        >;
      }
    ).environmentService;

    const runtimeEnvironment = makeRuntimeEnvironment({
      rootPath: "/test",
      authorization: "Bearer test-token",
    });
    const activeRuntime = {
      ownerThreadId: "thread-1",
      environment: runtimeEnvironment,
      agentConnectionTarget: runtimeEnvironment.getAgentConnectionTarget(),
    };
    environmentService.ensureThreadEnvironmentRuntime = vi.fn(async () => ({
      runtime: activeRuntime,
    }));
    environmentService.suspendEnvironmentRuntimeAndWait = vi.fn(async () => undefined);

    const access = await (
      manager as unknown as {
        _ensureEnvironmentAgentAccess: (threadId: string) => Promise<{
          thread: Thread;
          projectRootPath: string;
          target: { baseUrl: string; transport: "http" };
        }>;
      }
    )._ensureEnvironmentAgentAccess("thread-1");

    expect(access.projectRootPath).toBe("/test");
    expect(environmentService.ensureThreadEnvironmentRuntime).toHaveBeenCalledTimes(2);
    expect(environmentService.suspendEnvironmentRuntimeAndWait).toHaveBeenCalledWith(
      "thread-1",
    );
    expect(dispatcher.awaitActiveSession).toHaveBeenCalledTimes(2);
  });

  it("revalidates persisted provider thread ids when hot daemon state disagrees", async () => {
    const thread = makeThread({
      status: "idle",
      environmentId: "worktree",
    });
    (threadRepo.getById as ReturnType<typeof vi.fn>).mockReturnValue(thread);
    (
      eventRepo as unknown as {
        getLatestProviderThreadId: ReturnType<typeof vi.fn>;
      }
    ).getLatestProviderThreadId = vi.fn().mockReturnValue("provider-thread-1");
    (projectRepo.getById as ReturnType<typeof vi.fn>).mockReturnValue({
      id: "proj-1",
      name: "Project",
      rootPath: "/test",
      createdAt: 1_000,
      updatedAt: 1_000,
    });

    const dispatcher = {
      hasActiveSession: vi.fn(() => true),
      awaitActiveSession: vi.fn().mockResolvedValue({ id: "sess-1" }),
      enqueueForActiveSession: vi.fn(async () => ({
        id: "cmd-resume",
        threadId: "thread-1",
        sessionId: "sess-1",
        commandCursor: 1,
        commandType: "thread.resume",
        payload: {
          type: "thread.resume",
          threadId: "thread-1",
          providerThreadId: "provider-thread-1",
        },
        state: "completed",
        result: { threadId: "provider-thread-1" },
        createdAt: 1_000,
        updatedAt: 1_100,
      })),
    } as unknown as EnvironmentAgentCommandDispatcher;

    const validateManager = new Orchestrator(
      threadRepo,
      eventRepo,
      projectRepo,
      ws,
      createMockLlmCompletionService(),
      undefined,
      createTestRuntimeEnv({
        BEANBAG_ENVIRONMENT_AGENT_BASE_URL: undefined,
        BEANBAG_ENVIRONMENT_AGENT_AUTH_TOKEN: undefined,
      }),
      undefined,
      undefined,
      undefined,
      undefined,
      dispatcher,
      sessionService as never,
    );

    const environmentService = (
      validateManager as unknown as {
        environmentService: Pick<
          EnvironmentService,
          "ensureThreadEnvironmentRuntime"
        >;
      }
    ).environmentService;

    const runtimeEnvironment = makeRuntimeEnvironment({
      rootPath: "/test",
      authorization: "Bearer test-token",
    });
    environmentService.ensureThreadEnvironmentRuntime = vi.fn(async () => ({
      runtime: {
        ownerThreadId: "thread-1",
        environment: runtimeEnvironment,
        agentConnectionTarget: runtimeEnvironment.getAgentConnectionTarget(),
      },
    }));

    (
      validateManager as unknown as {
        providerThreadIdByThreadId: Map<string, string>;
      }
    ).providerThreadIdByThreadId.set("thread-1", "provider-thread-stale");

    const resumeThreadCommand = vi.fn(
      async ({ client }: { client: environmentAgent.EnvironmentAgentClient }) => {
        const ack = await client.sendCommand({
          meta: {
            protocolVersion: 1,
            commandId: "cmd-resume",
            idempotencyKey: "cmd-resume",
            sentAt: 1_050,
          },
          command: {
            type: "thread.resume",
            threadId: "thread-1",
            providerThreadId: "provider-thread-1",
          } as never,
        });
        expect(ack).toMatchObject({
          state: "accepted",
          result: { threadId: "provider-thread-1" },
        });
        return { providerThreadId: "provider-thread-1" };
      },
    );

    (
      validateManager as unknown as {
        agentServer: { resumeThreadCommand: typeof resumeThreadCommand };
      }
    ).agentServer.resumeThreadCommand = resumeThreadCommand;

    const providerThreadId = await (
      validateManager as unknown as {
        _ensureProviderSession: (threadId: string) => Promise<string>;
      }
    )._ensureProviderSession("thread-1");

    expect(providerThreadId).toBe("provider-thread-1");
    expect(dispatcher.awaitActiveSession).toHaveBeenCalledTimes(1);
    expect(resumeThreadCommand).toHaveBeenCalledTimes(1);
    expect(
      (
        validateManager as unknown as {
          providerThreadIdByThreadId: Map<string, string>;
        }
      ).providerThreadIdByThreadId.get("thread-1"),
    ).toBe("provider-thread-1");
  });

  it("retries one timed out provider resume before succeeding", async () => {
    const thread = makeThread({
      status: "idle",
      environmentId: "worktree",
    });
    (threadRepo.getById as ReturnType<typeof vi.fn>).mockReturnValue(thread);
    (
      eventRepo as unknown as {
        getLatestProviderThreadId: ReturnType<typeof vi.fn>;
      }
    ).getLatestProviderThreadId = vi.fn().mockReturnValue("provider-thread-1");
    (projectRepo.getById as ReturnType<typeof vi.fn>).mockReturnValue({
      id: "proj-1",
      name: "Project",
      rootPath: "/test",
      createdAt: 1_000,
      updatedAt: 1_000,
    });

    const dispatcher = {
      hasActiveSession: vi.fn(() => true),
      awaitActiveSession: vi.fn().mockResolvedValue({ id: "sess-1" }),
      enqueueForActiveSession: vi.fn(),
    } as unknown as EnvironmentAgentCommandDispatcher;

    const retryManager = new Orchestrator(
      threadRepo,
      eventRepo,
      projectRepo,
      ws,
      createMockLlmCompletionService(),
      undefined,
      createTestRuntimeEnv({
        BEANBAG_ENVIRONMENT_AGENT_BASE_URL: undefined,
        BEANBAG_ENVIRONMENT_AGENT_AUTH_TOKEN: undefined,
      }),
      undefined,
      undefined,
      undefined,
      undefined,
      dispatcher,
      sessionService as never,
    );

    const environmentService = (
      retryManager as unknown as {
        environmentService: Pick<
          EnvironmentService,
          "ensureThreadEnvironmentRuntime"
        >;
      }
    ).environmentService;
    const runtimeEnvironment = makeRuntimeEnvironment({
      rootPath: "/test",
      authorization: "Bearer test-token",
    });
    environmentService.ensureThreadEnvironmentRuntime = vi.fn(async () => ({
      runtime: {
        ownerThreadId: "thread-1",
        environment: runtimeEnvironment,
        agentConnectionTarget: runtimeEnvironment.getAgentConnectionTarget(),
      },
    }));

    const resumeThreadCommand = vi
      .fn()
      .mockRejectedValueOnce(providerTimeoutError("Timed out waiting for provider response"))
      .mockResolvedValueOnce({ providerThreadId: "provider-thread-1" });
    (
      retryManager as unknown as {
        agentServer: { resumeThreadCommand: typeof resumeThreadCommand };
      }
    ).agentServer.resumeThreadCommand = resumeThreadCommand;

    const providerThreadId = await (
      retryManager as unknown as {
        _ensureProviderSession: (threadId: string) => Promise<string>;
      }
    )._ensureProviderSession("thread-1");

    expect(providerThreadId).toBe("provider-thread-1");
    expect(resumeThreadCommand).toHaveBeenCalledTimes(2);
    expect(environmentService.ensureThreadEnvironmentRuntime).toHaveBeenCalledTimes(2);
  });

  it("reprovisions after a second timed out provider resume", async () => {
    const thread = makeThread({
      status: "idle",
      environmentId: "worktree",
    });
    (threadRepo.getById as ReturnType<typeof vi.fn>).mockReturnValue(thread);
    (
      eventRepo as unknown as {
        getLatestProviderThreadId: ReturnType<typeof vi.fn>;
      }
    ).getLatestProviderThreadId = vi.fn().mockReturnValue("provider-thread-1");
    (projectRepo.getById as ReturnType<typeof vi.fn>).mockReturnValue({
      id: "proj-1",
      name: "Project",
      rootPath: "/test",
      createdAt: 1_000,
      updatedAt: 1_000,
    });

    const dispatcher = {
      hasActiveSession: vi.fn(() => true),
      awaitActiveSession: vi.fn().mockResolvedValue({ id: "sess-1" }),
      enqueueForActiveSession: vi.fn(),
    } as unknown as EnvironmentAgentCommandDispatcher;

    const retryManager = new Orchestrator(
      threadRepo,
      eventRepo,
      projectRepo,
      ws,
      createMockLlmCompletionService(),
      undefined,
      createTestRuntimeEnv({
        BEANBAG_ENVIRONMENT_AGENT_BASE_URL: undefined,
        BEANBAG_ENVIRONMENT_AGENT_AUTH_TOKEN: undefined,
      }),
      undefined,
      undefined,
      undefined,
      undefined,
      dispatcher,
      sessionService as never,
    );

    const environmentService = (
      retryManager as unknown as {
        environmentService: Pick<
          EnvironmentService,
          "ensureThreadEnvironmentRuntime"
        >;
      }
    ).environmentService;
    const runtimeEnvironment = makeRuntimeEnvironment({
      rootPath: "/test",
      authorization: "Bearer test-token",
    });
    environmentService.ensureThreadEnvironmentRuntime = vi.fn(async () => ({
      runtime: {
        ownerThreadId: "thread-1",
        environment: runtimeEnvironment,
        agentConnectionTarget: runtimeEnvironment.getAgentConnectionTarget(),
      },
    }));

    const resumeThreadCommand = vi
      .fn()
      .mockRejectedValue(providerTimeoutError("Timed out waiting for provider response"));
    (
      retryManager as unknown as {
        agentServer: { resumeThreadCommand: typeof resumeThreadCommand };
      }
    ).agentServer.resumeThreadCommand = resumeThreadCommand;

    const provisionThread = vi.fn(async (threadId: string) => {
      (
        retryManager as unknown as {
          providerThreadIdByThreadId: Map<string, string>;
        }
      ).providerThreadIdByThreadId.set(threadId, "provider-thread-2");
    });
    (
      retryManager as unknown as {
        _provisionThread: typeof provisionThread;
      }
    )._provisionThread = provisionThread;

    const providerThreadId = await (
      retryManager as unknown as {
        _ensureProviderSession: (threadId: string) => Promise<string>;
      }
    )._ensureProviderSession("thread-1");

    expect(providerThreadId).toBe("provider-thread-2");
    expect(resumeThreadCommand).toHaveBeenCalledTimes(2);
    expect(provisionThread).toHaveBeenCalledWith(
      "thread-1",
      expect.objectContaining({
        projectId: "proj-1",
        environmentId: "worktree",
      }),
      expect.objectContaining({
        rootPathHint: "/test",
        reason: "resume-missing-provider-thread",
      }),
    );
  });

  it("reads environment-agent status from the session service", async () => {
    const thread = makeThread();
    (threadRepo.getById as ReturnType<typeof vi.fn>).mockReturnValue(thread);
    sessionService.getThreadStatus.mockReturnValue({
      protocolVersion: 1,
      threadId: "thread-1",
      latestSequence: 3,
      connectedToDaemon: true,
      pendingEventCount: 0,
      pendingCommandCount: 1,
      deliveryState: "healthy",
      retryAttemptCount: 0,
    });

    await expect(manager.getEnvironmentAgentStatus("thread-1")).resolves.toMatchObject({
      latestSequence: 3,
      pendingCommandCount: 1,
    });
    expect(sessionService.getThreadStatus).toHaveBeenCalledWith("thread-1");
  });

  it("recovers persisted provider thread ids from provisioning-completed events", () => {
    const thread = makeThread({
      id: "thread-1",
      status: "idle",
      environmentId: "local",
    });
    (threadRepo.getById as ReturnType<typeof vi.fn>).mockReturnValue(thread);
    (
      eventRepo as unknown as {
        getLatestProviderThreadId: ReturnType<typeof vi.fn>;
        listByThread: ReturnType<typeof vi.fn>;
      }
    ).getLatestProviderThreadId = vi.fn().mockReturnValue(undefined);
    (
      eventRepo as unknown as {
        listByThread: ReturnType<typeof vi.fn>;
      }
    ).listByThread = vi.fn().mockReturnValue([
      {
        id: "evt-1",
        threadId: "thread-1",
        seq: 1,
        type: "system/provisioning/completed",
        data: {
          environmentId: "local",
          environmentDisplayName: "Direct Workspace",
          providerThreadId: "provider-thread-1",
        },
        createdAt: 1_000,
      },
    ]);

    const providerThreadId = (
      manager as unknown as {
        _resolvePersistedProviderThreadId: (threadId: string) => string | undefined;
      }
    )._resolvePersistedProviderThreadId("thread-1");

    expect(providerThreadId).toBe("provider-thread-1");
  });
});
