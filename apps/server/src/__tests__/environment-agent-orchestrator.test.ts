import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Thread, ThreadEventDataForType } from "@bb/core";
import type * as environmentAgent from "@bb/environment-daemon";
import type { EnvironmentService } from "../environment-service.js";
import {
  EnvironmentAgentSessionUnavailableError,
  type EnvironmentAgentCommandDispatcher,
} from "../environment-agent-command-dispatcher.js";
import {
  ThreadRepository,
  EventRepository,
  ProjectRepository,
  EnvironmentRepository,
} from "@bb/db";
import type { WSManager } from "../ws.js";
import type { IEnvironment } from "@bb/environment";
import { providerTimeoutError } from "../domain-errors.js";
import { Orchestrator } from "../orchestrator.js";
import {
  createTestDb,
  createTestRepos,
  createTestProject,
  createTestThread,
  createMockLlmCompletionService,
  createTestRuntimeEnv,
} from "./test-factories.js";

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
    async getCheckoutSnapshot() {
      return {
        branch: "bb/thread-1",
        head: "abc123",
        detached: false,
      };
    },
    getWorkspaceRootUnsafe() {
      return args.rootPath;
    },
    async getWorkspaceStatus() {
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

function createEventData<TType extends keyof import("@bb/core").ThreadEventDataByType>(
  data: ThreadEventDataForType<TType>,
): ThreadEventDataForType<TType> {
  return data;
}

function createTestEnvironment(
  environmentRepo: EnvironmentRepository,
  projectId: string,
): { id: string } {
  return environmentRepo.create({
    projectId,
    descriptor: { type: "path", path: "/test" },
    managed: false,
  });
}

describe("Orchestrator environment-agent delivery and replay", () => {
  let threadRepo: ThreadRepository;
  let eventRepo: EventRepository;
  let projectRepo: ProjectRepository;
  let environmentRepo: EnvironmentRepository;
  let ws: WSManager;
  let manager: Orchestrator;
  let sessionService: {
    getThreadStatus: ReturnType<typeof vi.fn>;
    retireActiveSessionForThread: ReturnType<typeof vi.fn>;
  };

  // Shared test data created in beforeEach
  let projectId: string;
  let projectRootPath: string;

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
    const testDb = createTestDb();
    const repos = createTestRepos(testDb.db);
    threadRepo = repos.threadRepo;
    eventRepo = repos.eventRepo;
    projectRepo = repos.projectRepo;
    environmentRepo = repos.environmentRepo;

    ws = {
      broadcast: vi.fn(),
      handleConnection: vi.fn(),
      close: vi.fn(),
    } as unknown as WSManager;

    const project = createTestProject(projectRepo, { rootPath: "/project/root" });
    projectId = project.id;
    projectRootPath = project.rootPath;

    sessionService = {
      getThreadStatus: vi.fn(),
      retireActiveSessionForThread: vi.fn(),
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
    const thread = createTestThread(threadRepo, projectId);

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
          threadId: thread.id,
          commandCursor: 1,
          commandType: "workspace.status",
          payload: { type: "workspace.status", threadId: thread.id },
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
      thread,
      projectRootPath,
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
            threadId: thread.id,
          },
        });
        return ack.state;
      },
    });

    expect(result).toBe("accepted");
  });

  it("re-ensures environment-agent access before resuming a persisted provider thread", async () => {
    const env = createTestEnvironment(environmentRepo, projectId);
    const thread = createTestThread(threadRepo, projectId, {
      status: "idle",
      environmentId: env.id,
    });

    // Insert an event with providerThreadId so getLatestProviderThreadId returns it
    eventRepo.create({
      threadId: thread.id,
      seq: 1,
      type: "system/provisioning/completed",
      data: createEventData<"system/provisioning/completed">({
        providerThreadId: "provider-thread-1",
        transcript: [],
      }),
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
        threadId: thread.id,
        sessionId: "sess-1",
        commandCursor: 1,
        commandType: "thread.resume",
        payload: {
          type: "thread.resume",
          threadId: thread.id,
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
        BB_ENV_DAEMON_BASE_URL: undefined,
        BB_ENV_DAEMON_AUTH_TOKEN: undefined,
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
      scopeKey: `thread:${thread.id}`,
      ownerThreadId: thread.id,
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
            threadId: thread.id,
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
    )._ensureProviderSession(thread.id);

    expect(providerThreadId).toBe("provider-thread-1");
    expect(environmentService.suspendEnvironmentRuntimeAndWait).not.toHaveBeenCalled();

    // Retrieve the latest thread from the DB (status may have been updated)
    const latestThread = threadRepo.getById(thread.id)!;
    expect(environmentService.ensureThreadEnvironmentRuntime).toHaveBeenCalledWith(
      latestThread,
      projectRootPath,
      "resume-existing-provider-session",
    );
    expect(dispatcher.awaitActiveSession).toHaveBeenCalledWith({
      threadId: thread.id,
      timeoutMs: 1_000,
    });
    expect(resumeThreadCommand).toHaveBeenCalled();
  });

  it("retries a provider resume after session loss through the daemon ensure path", async () => {
    const env = createTestEnvironment(environmentRepo, projectId);
    const thread = createTestThread(threadRepo, projectId, {
      status: "idle",
      environmentId: env.id,
    });

    // Insert an event with providerThreadId so getLatestProviderThreadId returns it
    eventRepo.create({
      threadId: thread.id,
      seq: 1,
      type: "system/provisioning/completed",
      data: createEventData<"system/provisioning/completed">({
        providerThreadId: "provider-thread-1",
        transcript: [],
      }),
    });

    const dispatcher = {
      hasActiveSession: vi.fn(() => false),
      awaitActiveSession: vi.fn().mockResolvedValue({ id: "sess-1" }),
      enqueueForActiveSession: vi
        .fn()
        .mockRejectedValueOnce(
          new EnvironmentAgentSessionUnavailableError(thread.id),
        )
        .mockResolvedValueOnce({
          id: "cmd-resume",
          threadId: thread.id,
          sessionId: "sess-1",
          commandCursor: 1,
          commandType: "thread.resume",
          payload: {
            type: "thread.resume",
            threadId: thread.id,
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
        BB_ENV_DAEMON_BASE_URL: undefined,
        BB_ENV_DAEMON_AUTH_TOKEN: undefined,
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
      scopeKey: `thread:${thread.id}`,
      ownerThreadId: thread.id,
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
            threadId: thread.id,
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
    )._ensureProviderSession(thread.id);

    expect(providerThreadId).toBe("provider-thread-1");
    expect(environmentService.ensureThreadEnvironmentRuntime).toHaveBeenCalledTimes(2);
    expect(dispatcher.awaitActiveSession).toHaveBeenCalledTimes(2);
    expect(resumeThreadCommand).toHaveBeenCalledTimes(1);
  });

  it("recycles the runtime when env-daemon access cannot find a fresh session", async () => {
    const env = createTestEnvironment(environmentRepo, projectId);
    const thread = createTestThread(threadRepo, projectId, {
      status: "idle",
      environmentId: env.id,
    });

    const dispatcher = {
      awaitActiveSession: vi
        .fn()
        .mockRejectedValueOnce(
          new EnvironmentAgentSessionUnavailableError(thread.id),
        )
        .mockResolvedValueOnce({ id: "sess-2" }),
    } as unknown as EnvironmentAgentCommandDispatcher;

    const localManager = new Orchestrator(
      threadRepo,
      eventRepo,
      projectRepo,
      ws,
      createMockLlmCompletionService(),
      undefined,
      createTestRuntimeEnv({
        BB_ENV_DAEMON_BASE_URL: undefined,
        BB_ENV_DAEMON_AUTH_TOKEN: undefined,
      }),
      undefined,
      undefined,
      undefined,
      undefined,
      dispatcher,
      sessionService as never,
    );

    const environmentService = (
      localManager as unknown as {
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
      scopeKey: `thread:${thread.id}`,
      ownerThreadId: thread.id,
      environment: runtimeEnvironment,
      agentConnectionTarget: runtimeEnvironment.getAgentConnectionTarget(),
    };
    environmentService.ensureThreadEnvironmentRuntime = vi.fn(async () => ({
      runtime: activeRuntime,
    }));
    environmentService.suspendEnvironmentRuntimeAndWait = vi.fn(async () => undefined);

    const access = await (
      localManager as unknown as {
        _ensureEnvironmentAgentAccess: (threadId: string) => Promise<{
          thread: Thread;
          projectRootPath: string;
          target: { baseUrl: string; transport: "http" };
        }>;
      }
    )._ensureEnvironmentAgentAccess(thread.id);

    expect(access.projectRootPath).toBe(projectRootPath);
    expect(environmentService.ensureThreadEnvironmentRuntime).toHaveBeenCalledTimes(2);
    expect(environmentService.suspendEnvironmentRuntimeAndWait).toHaveBeenCalledWith(
      thread.id,
    );
    expect(dispatcher.awaitActiveSession).toHaveBeenCalledTimes(2);
  });

  it("revalidates persisted provider thread ids when hot daemon state disagrees", async () => {
    const env = createTestEnvironment(environmentRepo, projectId);
    const thread = createTestThread(threadRepo, projectId, {
      status: "idle",
      environmentId: env.id,
    });

    // Insert an event with providerThreadId so getLatestProviderThreadId returns it
    eventRepo.create({
      threadId: thread.id,
      seq: 1,
      type: "system/provisioning/completed",
      data: createEventData<"system/provisioning/completed">({
        providerThreadId: "provider-thread-1",
        transcript: [],
      }),
    });

    const dispatcher = {
      hasActiveSession: vi.fn(() => true),
      awaitActiveSession: vi.fn().mockResolvedValue({ id: "sess-1" }),
      enqueueForActiveSession: vi.fn(async () => ({
        id: "cmd-resume",
        threadId: thread.id,
        sessionId: "sess-1",
        commandCursor: 1,
        commandType: "thread.resume",
        payload: {
          type: "thread.resume",
          threadId: thread.id,
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
        BB_ENV_DAEMON_BASE_URL: undefined,
        BB_ENV_DAEMON_AUTH_TOKEN: undefined,
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
        scopeKey: `thread:${thread.id}`,
        ownerThreadId: thread.id,
        environment: runtimeEnvironment,
        agentConnectionTarget: runtimeEnvironment.getAgentConnectionTarget(),
      },
    }));

    (
      validateManager as unknown as {
        providerThreadIdByThreadId: Map<string, string>;
      }
    ).providerThreadIdByThreadId.set(thread.id, "provider-thread-stale");

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
            threadId: thread.id,
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
    )._ensureProviderSession(thread.id);

    expect(providerThreadId).toBe("provider-thread-1");
    expect(dispatcher.awaitActiveSession).toHaveBeenCalledTimes(1);
    expect(resumeThreadCommand).toHaveBeenCalledTimes(1);
    expect(
      (
        validateManager as unknown as {
          providerThreadIdByThreadId: Map<string, string>;
        }
      ).providerThreadIdByThreadId.get(thread.id),
    ).toBe("provider-thread-1");
  });

  it("retries one timed out provider resume before succeeding", async () => {
    const env = createTestEnvironment(environmentRepo, projectId);
    const thread = createTestThread(threadRepo, projectId, {
      status: "idle",
      environmentId: env.id,
    });

    // Insert an event with providerThreadId so getLatestProviderThreadId returns it
    eventRepo.create({
      threadId: thread.id,
      seq: 1,
      type: "system/provisioning/completed",
      data: createEventData<"system/provisioning/completed">({
        providerThreadId: "provider-thread-1",
        transcript: [],
      }),
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
        BB_ENV_DAEMON_BASE_URL: undefined,
        BB_ENV_DAEMON_AUTH_TOKEN: undefined,
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
        scopeKey: `thread:${thread.id}`,
        ownerThreadId: thread.id,
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
    )._ensureProviderSession(thread.id);

    expect(providerThreadId).toBe("provider-thread-1");
    expect(resumeThreadCommand).toHaveBeenCalledTimes(2);
    expect(environmentService.ensureThreadEnvironmentRuntime).toHaveBeenCalledTimes(2);
  });

  it("reprovisions after a second timed out provider resume", async () => {
    const env = createTestEnvironment(environmentRepo, projectId);
    const thread = createTestThread(threadRepo, projectId, {
      status: "idle",
      environmentId: env.id,
    });

    // Insert an event with providerThreadId so getLatestProviderThreadId returns it
    eventRepo.create({
      threadId: thread.id,
      seq: 1,
      type: "system/provisioning/completed",
      data: createEventData<"system/provisioning/completed">({
        providerThreadId: "provider-thread-1",
        transcript: [],
      }),
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
        BB_ENV_DAEMON_BASE_URL: undefined,
        BB_ENV_DAEMON_AUTH_TOKEN: undefined,
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
        scopeKey: `thread:${thread.id}`,
        ownerThreadId: thread.id,
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
    )._ensureProviderSession(thread.id);

    expect(providerThreadId).toBe("provider-thread-2");
    expect(resumeThreadCommand).toHaveBeenCalledTimes(2);
    expect(provisionThread).toHaveBeenCalledWith(
      thread.id,
      expect.objectContaining({
        projectId,
        environmentId: env.id,
      }),
      expect.objectContaining({
        rootPathHint: projectRootPath,
        reason: "resume-missing-provider-thread",
      }),
    );
  });

  it("reads environment-agent status from the session service", async () => {
    const thread = createTestThread(threadRepo, projectId);

    sessionService.getThreadStatus.mockReturnValue({
      protocolVersion: 1,
      threadId: thread.id,
      latestSequence: 3,
      connectedToDaemon: true,
      pendingEventCount: 0,
      pendingCommandCount: 1,
      deliveryState: "healthy",
      retryAttemptCount: 0,
    });

    await expect(manager.getEnvironmentAgentStatus(thread.id)).resolves.toMatchObject({
      latestSequence: 3,
      pendingCommandCount: 1,
    });
    expect(sessionService.getThreadStatus).toHaveBeenCalledWith(thread.id);
  });

  it("recovers persisted provider thread ids from provisioning-completed events", () => {
    const env = createTestEnvironment(environmentRepo, projectId);
    const thread = createTestThread(threadRepo, projectId, {
      status: "idle",
      environmentId: env.id,
    });

    // Insert a provisioning-completed event with providerThreadId in the data.
    // With real repos, getLatestProviderThreadId will find this via the indexed
    // lookup (isThreadIdentity), but the end result is the same: the method
    // returns the correct provider thread ID.
    eventRepo.create({
      threadId: thread.id,
      seq: 1,
      type: "system/provisioning/completed",
      data: createEventData<"system/provisioning/completed">({
        attachedEnvironmentId: env.id,
        providerThreadId: "provider-thread-1",
        transcript: [{ key: "environment", text: "environment: Direct" }],
      }),
    });

    const providerThreadId = (
      manager as unknown as {
        _resolvePersistedProviderThreadId: (threadId: string) => string | undefined;
      }
    )._resolvePersistedProviderThreadId(thread.id);

    expect(providerThreadId).toBe("provider-thread-1");
  });
});
