import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { execFileSync } from "node:child_process";
import { Writable } from "node:stream";
import type { ChildProcess } from "node:child_process";
import {
  accessSync,
  chmodSync,
  constants,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import {
  buildSquashMergeConflictFollowUpInstruction,
  type SystemEnvironmentInfo,
  type Thread,
  type ThreadEvent,
  type ThreadWorkStatus,
} from "@beanbag/agent-core";
import {
  EnvironmentRegistry,
  type CreateEnvironmentContext,
  type IEnvironment,
} from "@beanbag/environment";
import {
  ENVIRONMENT_AGENT_PROTOCOL_VERSION,
  type EnvironmentAgentClient,
  type EnvironmentAgentEventEnvelope,
} from "@beanbag/environment-agent";
import type {
  ThreadRepository,
  EventRepository,
  ProjectRepository,
} from "@beanbag/db";
import {
  createCodexProviderAdapter,
  type LlmCompletionService,
} from "@beanbag/agent-server";
import { Orchestrator } from "../orchestrator.js";
import type { EnvironmentService } from "../environment-service.js";
import { WSManager } from "../ws.js";
import {
  CODEX_THREAD_ID,
  createFakeChildProcess,
  createFakeEnvironmentAgentClient,
  findRpcMessageByMethod,
  parseRpcMessage,
  respondToEnvironmentAgentControlMessage,
  type FakeChildProcess,
} from "./helpers/environment-agent-test-harness.js";

function makeWorkspaceStatus(
  overrides: Partial<ThreadWorkStatus> = {},
): ThreadWorkStatus {
  return {
    state: "clean",
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
    ...overrides,
  };
}

function git(repoRoot: string, ...args: string[]): string {
  return execFileSync("git", args, {
    cwd: repoRoot,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
}

function createTestEnvironmentRegistry(args: {
  kind?: string;
  displayName?: string;
  rootPath: string;
  onCreate?: (context: CreateEnvironmentContext) => void;
}): EnvironmentRegistry {
  const kind = args.kind ?? "worktree";
  const info: SystemEnvironmentInfo = {
    id: kind,
    displayName: args.displayName ?? "Git Worktree Workspace",
    description: "",
    capabilities: {
      host_filesystem: true,
      isolated_workspace: kind === "worktree",
      promote_primary_checkout: kind === "worktree",
      demote_primary_checkout: kind === "worktree",
      squash_merge: kind === "worktree",
    },
  };

  return new EnvironmentRegistry().register({
    kind,
    info,
    create(context: CreateEnvironmentContext): IEnvironment {
      args.onCreate?.(context);
      return makeRuntimeEnvironment({
        kind,
        rootPath: args.rootPath,
        overrides: {
          info,
          serialize() {
            return { rootPath: args.rootPath };
          },
          buildAgentInstructions() {
            return kind === "worktree"
              ? "[Beanbag worktree environment]"
              : undefined;
          },
          promoteToActiveWorkspace() {
            throw new Error("not implemented in test environment");
          },
          demoteFromActiveWorkspace() {
            throw new Error("not implemented in test environment");
          },
          async squashMergeIntoDefaultBranch() {
            throw new Error("not implemented in test environment");
          },
        },
      });
    },
    restore(_state: unknown, context: CreateEnvironmentContext): IEnvironment {
      return this.create(context);
    },
    isState(_value: unknown): _value is unknown {
      return true;
    },
  });
}

function makeRuntimeEnvironment(args: {
  kind?: string;
  rootPath: string;
  dispose?: () => Promise<void> | void;
  overrides?: Partial<IEnvironment>;
}): IEnvironment {
  const kind = args.kind ?? "worktree";
  const {
    buildAgentInstructions: overrideBuildAgentInstructions,
    ...overrides
  } = args.overrides ?? {};
  const info: SystemEnvironmentInfo = {
    id: kind,
    displayName: kind === "worktree" ? "Git Worktree Workspace" : "Direct Workspace",
    description: "",
    capabilities: {
      host_filesystem: true,
      isolated_workspace: kind === "worktree",
      promote_primary_checkout: kind === "worktree",
      demote_primary_checkout: kind === "worktree",
      squash_merge: kind === "worktree",
    },
  };

  return {
    kind,
    info,
    serialize() {
      return {};
    },
    dispose() {
      return args.dispose?.();
    },
    exists() {
      return true;
    },
    supportsHostFilesystemAccess() {
      return true;
    },
    isIsolatedWorkspace() {
      return kind === "worktree";
    },
    getAgentConnectionTarget() {
      return {
        transport: "http" as const,
        baseUrl: "http://127.0.0.1:4312",
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
      return makeWorkspaceStatus();
    },
    watchWorkspaceStatus() {
      return () => {};
    },
    async commitWorkspace() {
      return {
        ok: true,
        commitCreated: false,
        message: "Working directory is clean",
        workStatus: makeWorkspaceStatus(),
      };
    },
    listWorkspaceCommitsSinceRef() {
      return [];
    },
    getWorkspaceDiff() {
      return { diff: "", truncated: false };
    },
    spawn(command: string, commandArgs: string[], options?: { stdio?: unknown; env?: Record<string, string | undefined>; cwd?: string }) {
      return (spawnMock as unknown as (...args: unknown[]) => FakeChildProcess)(
        command,
        commandArgs,
        options,
      ) as unknown as ChildProcess;
    },
    shouldRunSetupScript() {
      return false;
    },
    supportsPromoteToActiveWorkspace() {
      return kind === "worktree";
    },
    supportsDemoteFromActiveWorkspace() {
      return kind === "worktree";
    },
    supportsSquashMergeIntoDefaultBranch() {
      return kind === "worktree";
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
    ...overrides,
    buildAgentInstructions: overrideBuildAgentInstructions ?? (() => undefined),
  };
}

// Mock child_process.spawn while preserving other exports.
vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:child_process")>();
  return {
    ...actual,
    spawn: vi.fn(),
  };
});

import { spawn as spawnMock } from "node:child_process";

vi.mock("@beanbag/environment-agent", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@beanbag/environment-agent")>();
  return {
    ...actual,
    createHttpEnvironmentAgentClient: vi.fn(async () => {
      const child =
        ((spawnMock as unknown as { (): FakeChildProcess | undefined })() as
          | FakeChildProcess
          | undefined) ??
        createFakeChildProcess();
      return createFakeEnvironmentAgentClient(child);
    }),
  };
});

const DEFAULT_BASE_INSTRUCTIONS =
  "You are a coding agent working on a project thread. Follow the instructions carefully and write clean, working code.";

interface OrchestratorTestHarness {
  processes: Map<string, unknown>;
  providerThreadIds: Map<string, string>;
  activeTurnIds: Map<string, string>;
  environmentRuntimes: Map<string, unknown>;
  provider: {
    listModels: (...args: unknown[]) => unknown;
  };
  primaryPromotionByProjectId: Map<string, unknown>;
  primaryPromotionValidatedAtByProjectId: Map<string, number>;
  primaryCheckoutTransitionsInFlight: Set<string>;
  _scheduleProvisioning: (
    threadId: string,
    req: unknown,
    opts?: { rootPathHint?: string; reason?: string },
  ) => void;
  _cleanupThreadRuntime: (threadId: string) => void;
  _ensurePrimaryPromotionStateIsCurrent: (
    projectId: string,
    opts?: { force?: boolean },
  ) => void;
  _scheduleQueuedFollowUpDispatch: (threadId: string) => void;
  _scheduleQueuedOperationDispatch: (threadId: string) => void;
  _handleProcessExit: (
    threadId: string,
    code: number | null,
    signal: string | null,
  ) => void;
}

function asOrchestratorHarness(manager: Orchestrator): OrchestratorTestHarness {
  const rawManager = manager as unknown as {
    agentServer: {
      sessions: Map<string, {
        agentClient?: { __fakeChild?: unknown };
        runtime: {
          send?: (msg: object) => void;
          close?: (error?: Error) => void;
        };
        providerThreadId?: string;
        activeTurnId?: string;
      }>;
      opts: {
        provider: {
          listModels: (...args: unknown[]) => unknown;
        };
      };
    };
    environmentService: {
      environmentRuntimes: Map<string, unknown>;
    };
  } & OrchestratorTestHarness;
  const sessions = rawManager.agentServer.sessions;

  const ensureSession = (threadId: string) => {
    let session = sessions.get(threadId);
    if (!session) {
      const child: any = {
        stdin: {
          write: vi.fn(),
        },
      };
      session = {
        agentClient: {
          __fakeChild: child,
        },
        runtime: {
          send(msg: object) {
            child.stdin?.write?.(`${JSON.stringify(msg)}\n`);
          },
          close: vi.fn(),
        },
      };
      sessions.set(threadId, session);
    }
    return session;
  };

  const processes = new Map<string, unknown>() as Map<string, unknown>;
  processes.get = (threadId: string) => sessions.get(threadId)?.agentClient?.__fakeChild;
  processes.set = (threadId: string, child: unknown) => {
    const runtime = {
      send(msg: object) {
        const writable = (child as any)?.stdin;
        writable?.write?.(`${JSON.stringify(msg)}\n`);
      },
      close: vi.fn(),
    };
    sessions.set(threadId, {
      agentClient: {
        __fakeChild: child,
      },
      runtime,
      providerThreadId: sessions.get(threadId)?.providerThreadId,
      activeTurnId: sessions.get(threadId)?.activeTurnId,
    });
    return processes;
  };
  processes.has = (threadId: string) => sessions.has(threadId);
  processes.delete = (threadId: string) => sessions.delete(threadId);
  processes.clear = () => sessions.clear();

  const providerThreadIds = new Map<string, string>() as Map<string, string>;
  providerThreadIds.get = (threadId: string) => sessions.get(threadId)?.providerThreadId;
  providerThreadIds.set = (threadId: string, providerThreadId: string) => {
    ensureSession(threadId).providerThreadId = providerThreadId;
    return providerThreadIds;
  };
  providerThreadIds.has = (threadId: string) => Boolean(sessions.get(threadId)?.providerThreadId);
  providerThreadIds.delete = (threadId: string) => {
    const session = sessions.get(threadId);
    if (!session) return false;
    delete session.providerThreadId;
    return true;
  };
  providerThreadIds.clear = () => {
    for (const session of sessions.values()) {
      delete session.providerThreadId;
    }
  };

  const activeTurnIds = new Map<string, string>() as Map<string, string>;
  activeTurnIds.get = (threadId: string) => sessions.get(threadId)?.activeTurnId;
  activeTurnIds.set = (threadId: string, activeTurnId: string) => {
    ensureSession(threadId).activeTurnId = activeTurnId;
    return activeTurnIds;
  };
  activeTurnIds.has = (threadId: string) => Boolean(sessions.get(threadId)?.activeTurnId);
  activeTurnIds.delete = (threadId: string) => {
    const session = sessions.get(threadId);
    if (!session) return false;
    delete session.activeTurnId;
    return true;
  };
  activeTurnIds.clear = () => {
    for (const session of sessions.values()) {
      delete session.activeTurnId;
    }
  };
  Object.assign(rawManager, {
    processes,
    providerThreadIds,
    activeTurnIds,
    environmentRuntimes: rawManager.environmentService.environmentRuntimes,
    provider: rawManager.agentServer.opts.provider,
  });
  return rawManager as OrchestratorTestHarness;
}

function makeThread(overrides: Partial<Thread> = {}): Thread {
  return {
    id: "thread-1",
    projectId: "proj-1",
    status: "active",
    createdAt: 1000,
    updatedAt: 1000,
    ...overrides,
  };
}

type ThreadEventOverrides = Partial<Omit<ThreadEvent, "type" | "data">> & {
  type?: string;
  data?: unknown;
};

function makeEvent(overrides: ThreadEventOverrides = {}): ThreadEvent {
  return {
    id: "evt-1",
    threadId: "thread-1",
    seq: 1,
    type: "item/completed",
    data: {},
    createdAt: 1000,
    ...overrides,
  } as ThreadEvent;
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

function createMockLlmCompletionService(
  overrides?: Partial<LlmCompletionService>,
): LlmCompletionService {
  return {
    displayName: "Mock LLM",
    generateThreadTitle: vi.fn().mockResolvedValue(undefined),
    generateCommitMessage: vi.fn().mockResolvedValue(undefined),
    ...overrides,
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

describe("Orchestrator", () => {
  let threadRepo: ReturnType<typeof createMocks>["threadRepo"];
  let eventRepo: ReturnType<typeof createMocks>["eventRepo"];
  let projectRepo: ReturnType<typeof createMocks>["projectRepo"];
  let ws: ReturnType<typeof createMocks>["ws"];
  let llmCompletionService: LlmCompletionService;
  let manager: Orchestrator;

  beforeEach(() => {
    vi.clearAllMocks();
    const mocks = createMocks();
    threadRepo = mocks.threadRepo;
    eventRepo = mocks.eventRepo;
    projectRepo = mocks.projectRepo;
    ws = mocks.ws;
    llmCompletionService = createMockLlmCompletionService();
    manager = new Orchestrator(
      threadRepo,
      eventRepo,
      projectRepo,
      ws,
      llmCompletionService,
      undefined,
      createTestRuntimeEnv(),
    );
  });

  afterEach(async () => {
    await new Promise<void>((resolve) => setImmediate(resolve));
    await new Promise<void>((resolve) => setImmediate(resolve));
  });

  describe("environment services", () => {
    it("injects llm completion into environment creation context", async () => {
      const generateCommitMessage = llmCompletionService.generateCommitMessage as ReturnType<
        typeof vi.fn
      >;
      generateCommitMessage.mockResolvedValue("feat: support commit generation");
      let capturedContext: CreateEnvironmentContext | undefined;
      const customEnvironmentRegistry = createTestEnvironmentRegistry({
        rootPath: "/tmp/worktrees/proj-1/thread-1",
        onCreate(context) {
          capturedContext = context;
        },
      });
      manager = new Orchestrator(
        threadRepo,
        eventRepo,
        projectRepo,
        ws,
        llmCompletionService,
        createCodexProviderAdapter(),
        createTestRuntimeEnv(),
        customEnvironmentRegistry,
      );
      (threadRepo.getById as ReturnType<typeof vi.fn>).mockReturnValue(
        makeThread({
          id: "thread-1",
          projectId: "proj-1",
          status: "idle",
          environmentId: "worktree",
          environmentRecord: {
            kind: "worktree",
            state: {
              workspaceRoot: "/tmp/worktrees/proj-1/thread-1",
              branchName: "bb/thread-1",
            },
          },
        }),
      );
      (projectRepo.getById as ReturnType<typeof vi.fn>).mockReturnValue({
        id: "proj-1",
        name: "Project",
        rootPath: "/tmp/proj-1",
        createdAt: 1000,
        updatedAt: 1000,
      });

      manager.getWorkStatus("thread-1");

      expect(capturedContext?.services?.llmCompletion).toBeTypeOf("function");
      await expect(
        capturedContext?.services?.llmCompletion?.({
          cwd: "/tmp/workspace",
          includeUnstaged: true,
        }),
      ).resolves.toBe("feat: support commit generation");
      expect(generateCommitMessage).toHaveBeenCalledWith({
        cwd: "/tmp/workspace",
        includeUnstaged: true,
      });
    });
  });

  describe("boot status healing", () => {
    function createBootManager(initialThreads: Thread[]) {
      const threadState = new Map(
        initialThreads.map((thread) => [thread.id, { ...thread }]),
      );
      const bootThreadRepo = {
        create: vi.fn(),
        getById: vi.fn((threadId: string) => threadState.get(threadId)),
        list: vi.fn(() => Array.from(threadState.values())),
        update: vi.fn((threadId: string, updates: Partial<Thread>) => {
          const existing = threadState.get(threadId);
          if (!existing) return undefined;
          const next = {
            ...existing,
            ...updates,
          } as Thread;
          threadState.set(threadId, next);
          return next;
        }),
        markRead: vi.fn(),
        delete: vi.fn(),
      } as unknown as ThreadRepository;

      const bootEventRepo = {
        create: vi.fn(),
        updateData: vi.fn(),
        listByThread: vi.fn(),
        getLatestSeq: vi.fn(),
        getLatestExecutionOptions: vi.fn(),
      } as unknown as EventRepository;

      const bootProjectRepo = {
        create: vi.fn(),
        getById: vi.fn(),
        list: vi.fn(),
        delete: vi.fn(),
      } as unknown as ProjectRepository;

      const bootWs = {
        broadcast: vi.fn(),
        handleConnection: vi.fn(),
        close: vi.fn(),
      } as unknown as WSManager;

      const bootManager = new Orchestrator(
        bootThreadRepo,
        bootEventRepo,
        bootProjectRepo,
        bootWs,
        createMockLlmCompletionService(),
      );

      return {
        bootManager,
        bootThreadRepo,
        bootEventRepo,
        bootProjectRepo,
        bootWs,
        threadState,
      };
    }

    it("resets persisted active threads to idle when they cannot be resumed", async () => {
      const {
        bootManager,
        bootThreadRepo,
        bootWs,
      } = createBootManager([
        makeThread({ id: "boot-active", status: "active" }),
      ]);

      await bootManager.reconcileActiveThreadsOnBoot();

      expect(bootThreadRepo.update).toHaveBeenCalledWith(
        "boot-active",
        {
          status: "idle",
        },
        {
          touchUpdatedAt: false,
        },
      );
      expect(bootWs.broadcast).toHaveBeenCalledWith("thread", "boot-active", [
        "status-changed",
        "work-status-changed",
      ]);
    });

    it("resumes active threads on boot when provider state is still available", async () => {
      const {
        bootManager,
        bootEventRepo,
        bootProjectRepo,
        bootThreadRepo,
        threadState,
      } = createBootManager([
        makeThread({ id: "boot-active", status: "active" }),
      ]);

      (bootProjectRepo.getById as ReturnType<typeof vi.fn>).mockReturnValue({
        id: "proj-1",
        name: "Test",
        rootPath: "/test",
        createdAt: 1000,
        updatedAt: 1000,
      });
      (bootEventRepo.getLatestProviderThreadId as unknown as ReturnType<typeof vi.fn>) = vi
        .fn()
        .mockReturnValue("persisted-thread-1");
      (bootEventRepo.getLatestTurnLifecycle as unknown as ReturnType<typeof vi.fn>) = vi
        .fn()
        .mockReturnValue({
          normType: "turn/started",
          turnId: "turn-1",
        });

      const resumeChild = createFakeChildProcess({ autoRespond: false });
      resumeChild.stdin = new Writable({
        write(chunk: Buffer, _encoding: string, callback: () => void) {
          const data = chunk.toString();
          resumeChild._stdinData.push(data);
          try {
            const msg = JSON.parse(data.trim());
            if (respondToEnvironmentAgentControlMessage(resumeChild, msg)) {
              callback();
              return;
            }
            if (msg.method === "thread/resume" && msg.id) {
              process.nextTick(() => {
                resumeChild.stdout!.push(
                  JSON.stringify({
                    id: msg.id,
                    result: {
                      thread: { id: "persisted-thread-1" },
                      model: "test-model",
                    },
                  }) + "\n",
                );
              });
            }
          } catch {}
          callback();
        },
      });

      vi.spyOn(
        bootManager as unknown as {
          _spawnProcess: (
            threadId: string,
            projectRootPath: string,
            environmentKind: string,
            reason: string,
          ) => Promise<{
            environment: IEnvironment;
            agentConnectionTarget: {
              transport: "http";
              baseUrl: string;
            };
            connectSession: () => {
              transport: "http";
              client: EnvironmentAgentClient;
            };
          }>;
        },
        "_spawnProcess",
      ).mockResolvedValue({
        environment: makeRuntimeEnvironment({ rootPath: "/test" }),
        agentConnectionTarget: {
          transport: "http",
          baseUrl: "http://127.0.0.1:4312",
        },
        connectSession: () => ({
          transport: "http",
          client: createFakeEnvironmentAgentClient(resumeChild),
        }),
      });
      const retrySpy = vi
        .spyOn(
          (bootManager as unknown as {
            agentServer: { retryEnvironmentAgentDelivery: (threadId: string) => Promise<unknown> };
          }).agentServer,
          "retryEnvironmentAgentDelivery",
        )
        .mockResolvedValue({
          protocolVersion: ENVIRONMENT_AGENT_PROTOCOL_VERSION,
          latestSequence: 0,
          connectedToDaemon: true,
          pendingEventCount: 0,
          pendingCommandCount: 0,
        });

      await bootManager.reconcileActiveThreadsOnBoot();

      expect(threadState.get("boot-active")?.status).toBe("active");
      expect(bootThreadRepo.update).not.toHaveBeenCalledWith(
        "boot-active",
        { status: "idle" },
        { touchUpdatedAt: false },
      );
      expect(resumeChild._stdinData.some((line) => {
        try {
          return JSON.parse(line.trim()).method === "thread/resume";
        } catch {
          return false;
        }
      })).toBe(true);
      expect(retrySpy).toHaveBeenCalledWith("boot-active");
    });

    it("attempts boot resume even when no lifecycle event was persisted yet", async () => {
      const {
        bootManager,
        bootEventRepo,
        bootProjectRepo,
      } = createBootManager([
        makeThread({ id: "boot-active", status: "active" }),
      ]);

      (bootProjectRepo.getById as ReturnType<typeof vi.fn>).mockReturnValue({
        id: "proj-1",
        name: "Test",
        rootPath: "/test",
        createdAt: 1000,
        updatedAt: 1000,
      });
      (bootEventRepo.getLatestProviderThreadId as unknown as ReturnType<typeof vi.fn>) = vi
        .fn()
        .mockReturnValue("persisted-thread-1");
      (bootEventRepo.getLatestTurnLifecycle as unknown as ReturnType<typeof vi.fn>) = vi
        .fn()
        .mockReturnValue(undefined);

      const resumeChild = createFakeChildProcess({ autoRespond: false });
      resumeChild.stdin = new Writable({
        write(chunk: Buffer, _encoding: string, callback: () => void) {
          const data = chunk.toString();
          resumeChild._stdinData.push(data);
          try {
            const msg = JSON.parse(data.trim());
            if (respondToEnvironmentAgentControlMessage(resumeChild, msg)) {
              callback();
              return;
            }
            if (msg.method === "thread/resume" && msg.id) {
              process.nextTick(() => {
                resumeChild.stdout!.push(
                  JSON.stringify({
                    id: msg.id,
                    result: {
                      thread: { id: "persisted-thread-1" },
                      model: "test-model",
                    },
                  }) + "\n",
                );
              });
            }
          } catch {}
          callback();
        },
      });

      vi.spyOn(
        bootManager as unknown as {
          _spawnProcess: (
            threadId: string,
            projectRootPath: string,
            environmentKind: string,
            reason: string,
          ) => Promise<{
            environment: IEnvironment;
            agentConnectionTarget: {
              transport: "http";
              baseUrl: string;
            };
            connectSession: () => {
              transport: "http";
              client: EnvironmentAgentClient;
            };
          }>;
        },
        "_spawnProcess",
      ).mockResolvedValue({
        environment: makeRuntimeEnvironment({ rootPath: "/test" }),
        agentConnectionTarget: {
          transport: "http",
          baseUrl: "http://127.0.0.1:4312",
        },
        connectSession: () => ({
          transport: "http",
          client: createFakeEnvironmentAgentClient(resumeChild),
        }),
      });

      await bootManager.reconcileActiveThreadsOnBoot();

      expect(resumeChild._stdinData.some((line) => {
        try {
          return JSON.parse(line.trim()).method === "thread/resume";
        } catch {
          return false;
        }
      })).toBe(true);
    });

    it("applies the restart policy matrix across persisted thread statuses", async () => {
      const {
        bootManager,
        bootThreadRepo,
      } = createBootManager([
        makeThread({ id: "boot-created", status: "created" }),
        makeThread({ id: "boot-provisioning", status: "provisioning" }),
        makeThread({ id: "boot-active", status: "active" }),
        makeThread({ id: "boot-idle", status: "idle" }),
        makeThread({ id: "boot-provisioning-failed", status: "provisioning_failed" }),
        makeThread({
          id: "boot-archived-active",
          status: "active",
          archivedAt: 123,
        }),
        makeThread({
          id: "boot-archived-idle",
          status: "idle",
          archivedAt: 123,
        }),
      ]);

      const scheduleProvisioningSpy = vi
        .spyOn(asOrchestratorHarness(bootManager), "_scheduleProvisioning")
        .mockImplementation(() => {});
      const cleanupRuntimeSpy = vi
        .spyOn(asOrchestratorHarness(bootManager), "_cleanupThreadRuntime")
        .mockImplementation(() => {});

      await bootManager.reconcileActiveThreadsOnBoot();

      expect(scheduleProvisioningSpy).toHaveBeenCalledWith(
        "boot-created",
        {
          projectId: "proj-1",
          environmentId: undefined,
        },
        {
          reason: "boot-created-thread",
        },
      );
      expect(cleanupRuntimeSpy).toHaveBeenCalledWith("boot-provisioning");
      expect(bootThreadRepo.update).toHaveBeenCalledWith(
        "boot-provisioning",
        { status: "provisioning_failed" },
        { touchUpdatedAt: false },
      );
      expect(bootThreadRepo.update).toHaveBeenCalledWith(
        "boot-active",
        { status: "idle" },
        { touchUpdatedAt: false },
      );
      expect(bootThreadRepo.update).toHaveBeenCalledWith(
        "boot-archived-active",
        { status: "idle" },
        { touchUpdatedAt: false },
      );

      const updatedIds = (bootThreadRepo.update as ReturnType<typeof vi.fn>).mock.calls
        .map((call) => call[0] as string);
      expect(updatedIds).not.toContain("boot-idle");
      expect(updatedIds).not.toContain("boot-provisioning-failed");
      expect(updatedIds).not.toContain("boot-archived-idle");
    });
  });

  describe("spawn()", () => {
    let fakeChild: ReturnType<typeof createFakeChildProcess>;

    beforeEach(() => {
      fakeChild = createFakeChildProcess();
      (spawnMock as ReturnType<typeof vi.fn>).mockReturnValue(fakeChild);
      (eventRepo.getLatestSeq as ReturnType<typeof vi.fn>).mockReturnValue(0);
    });

    it("ensures the provider runtime through the environment agent", async () => {
      const project = { id: "proj-1", name: "Test", rootPath: "/my/project", createdAt: 1000, updatedAt: 1000 };
      (projectRepo.getById as ReturnType<typeof vi.fn>).mockReturnValue(project);

      const createdThread = makeThread({ id: "t-new", status: "idle" });
      (threadRepo.create as ReturnType<typeof vi.fn>).mockReturnValue(createdThread);
      (threadRepo.getById as ReturnType<typeof vi.fn>).mockReturnValue(
        makeThread({ id: "t-new", status: "active" }),
      );

      await manager.spawn({ projectId: "proj-1" });
      await vi.waitFor(() => {
        expect(spawnMock).toHaveBeenCalled();
      });

      const session = (manager as unknown as {
        agentServer: {
          sessions: Map<string, { agentClient: { __ensureSpecs: Array<unknown> } }>;
        };
      }).agentServer.sessions.get("t-new");

      expect(session?.agentClient.__ensureSpecs).toEqual([
        {
          command: "codex",
          args: ["app-server"],
        },
      ]);
    });

    it("creates a thread record in the DB", async () => {
      const project = { id: "proj-1", name: "Test", rootPath: "/test", createdAt: 1000, updatedAt: 1000 };
      (projectRepo.getById as ReturnType<typeof vi.fn>).mockReturnValue(project);

      const createdThread = makeThread({ id: "t-new", status: "idle" });
      (threadRepo.create as ReturnType<typeof vi.fn>).mockReturnValue(createdThread);
      (threadRepo.getById as ReturnType<typeof vi.fn>).mockReturnValue(
        makeThread({ id: "t-new", status: "active" }),
      );

      await manager.spawn({ projectId: "proj-1" });

      expect(threadRepo.create).toHaveBeenCalledWith({
        projectId: "proj-1",
        environmentId: "local",
      });
    });

    it("passes provider launch wrapper args through provider ensure", async () => {
      const wrappedEnvironment = makeRuntimeEnvironment({
        kind: "worktree",
        rootPath: "/wrapped/project",
        overrides: {
          getAgentConnectionTarget() {
            return {
              transport: "http",
              baseUrl: "http://127.0.0.1:4312",
              providerLaunch: {
                command: "docker",
                args: ["exec", "-i", "bb-thread-container"],
              },
            };
          },
        },
      });
      const environmentRegistry = new EnvironmentRegistry().register({
        kind: "worktree",
        info: wrappedEnvironment.info,
        create(): IEnvironment {
          return wrappedEnvironment;
        },
        restore(): IEnvironment {
          return wrappedEnvironment;
        },
        isState(_value: unknown): _value is unknown {
          return true;
        },
      });
      const managerWithWrapper = new Orchestrator(
        threadRepo,
        eventRepo,
        projectRepo,
        ws,
        llmCompletionService,
        createCodexProviderAdapter(),
        createTestRuntimeEnv(),
        environmentRegistry,
      );

      const project = { id: "proj-1", name: "Test", rootPath: "/wrapped/project", createdAt: 1000, updatedAt: 1000 };
      (projectRepo.getById as ReturnType<typeof vi.fn>).mockReturnValue(project);

      const createdThread = makeThread({ id: "t-new", status: "idle", environmentId: "worktree" });
      (threadRepo.create as ReturnType<typeof vi.fn>).mockReturnValue(createdThread);
      (threadRepo.getById as ReturnType<typeof vi.fn>).mockReturnValue(
        makeThread({ id: "t-new", status: "active", environmentId: "worktree" }),
      );

      await managerWithWrapper.spawn({ projectId: "proj-1", environmentId: "worktree" });
      await vi.waitFor(() => {
        expect(spawnMock).toHaveBeenCalled();
      });

      const session = (managerWithWrapper as unknown as {
        agentServer: {
          sessions: Map<string, { agentClient: { __ensureSpecs: Array<unknown> } }>;
        };
      }).agentServer.sessions.get("t-new");

      expect(session?.agentClient.__ensureSpecs).toEqual([
        {
          command: "codex",
          args: ["app-server"],
          launchCommand: "docker",
          launchArgs: ["exec", "-i", "bb-thread-container"],
        },
      ]);
    });

    it("returns before provisioning work starts", async () => {
      const onCreate = vi.fn();
      const customEnvironmentRegistry = createTestEnvironmentRegistry({
        rootPath: "/tmp/thread-worktree",
        onCreate,
      });
      const managerWithCustomEnvironment = new Orchestrator(
        threadRepo,
        eventRepo,
        projectRepo,
        ws,
        llmCompletionService,
        createCodexProviderAdapter(),
        createTestRuntimeEnv(),
        customEnvironmentRegistry,
      );

      const project = { id: "proj-1", name: "Test", rootPath: "/test", createdAt: 1000, updatedAt: 1000 };
      (projectRepo.getById as ReturnType<typeof vi.fn>).mockReturnValue(project);

      const createdThread = makeThread({
        id: "t-new",
        status: "idle",
        environmentId: "worktree",
      });
      (threadRepo.create as ReturnType<typeof vi.fn>).mockReturnValue(createdThread);
      (threadRepo.getById as ReturnType<typeof vi.fn>).mockReturnValue(
        makeThread({ id: "t-new", status: "active", environmentId: "worktree" }),
      );

      const result = await managerWithCustomEnvironment.spawn({
        projectId: "proj-1",
        environmentId: "worktree",
      });

      expect(result.id).toBe("t-new");
      expect(onCreate).not.toHaveBeenCalled();
      await vi.waitFor(() => {
        expect(onCreate).toHaveBeenCalledTimes(1);
      });
    });

    it("emits env-setup started before optional setup finishes", async () => {
      const tempRoot = mkdtempSync(join(tmpdir(), "beanbag-orchestrator-env-setup-"));
      const workspaceRoot = join(tempRoot, "workspace");
      let workspaceExists = false;

      let resolveSetup:
        | ((result: { exitCode: number; stdout: string; stderr: string }) => void)
        | undefined;
      const setupResult = new Promise<{ exitCode: number; stdout: string; stderr: string }>(
        (resolve) => {
          resolveSetup = resolve;
        },
      );
      const info: SystemEnvironmentInfo = {
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
      };
      const customEnvironmentRegistry = new EnvironmentRegistry().register({
        kind: "worktree",
        info,
        create(): IEnvironment {
          return makeRuntimeEnvironment({
            kind: "worktree",
            rootPath: workspaceRoot,
            overrides: {
              info,
              async prepare() {
                mkdirSync(workspaceRoot, { recursive: true });
                writeFileSync(
                  join(workspaceRoot, ".bb-env-setup.sh"),
                  "#!/usr/bin/env sh\nsleep 0\n",
                  "utf8",
                );
                workspaceExists = true;
              },
              exists() {
                return workspaceExists;
              },
              shouldRunSetupScript() {
                return true;
              },
              runAsync: vi.fn().mockImplementation(async () => setupResult),
              run: vi.fn().mockReturnValue({
                exitCode: 0,
                stdout: "",
                stderr: "",
              }),
            },
          });
        },
        restore(_state: unknown): IEnvironment {
          return this.create({
            projectId: "proj-1",
            threadId: "t-new",
            projectRootPath: "/test",
            runtimeEnv: {},
          });
        },
        isState(_value: unknown): _value is unknown {
          return true;
        },
      });
      const managerWithCustomEnvironment = new Orchestrator(
        threadRepo,
        eventRepo,
        projectRepo,
        ws,
        llmCompletionService,
        createCodexProviderAdapter(),
        createTestRuntimeEnv(),
        customEnvironmentRegistry,
      );

      const project = {
        id: "proj-1",
        name: "Test",
        rootPath: "/test",
        createdAt: 1000,
        updatedAt: 1000,
      };
      (projectRepo.getById as ReturnType<typeof vi.fn>).mockReturnValue(project);
      (threadRepo.create as ReturnType<typeof vi.fn>).mockReturnValue(
        makeThread({
          id: "t-new",
          status: "created",
          environmentId: "worktree",
        }),
      );
      (threadRepo.getById as ReturnType<typeof vi.fn>).mockImplementation((id: string) =>
        id === "t-new"
          ? makeThread({
              id: "t-new",
              projectId: "proj-1",
              status: "provisioning",
              environmentId: "worktree",
            })
          : undefined,
      );
      (eventRepo.create as ReturnType<typeof vi.fn>).mockImplementation((event) =>
        makeEvent({
          threadId: event.threadId,
          seq: event.seq,
          type: event.type as string,
          data: event.data,
        }),
      );

      try {
        await managerWithCustomEnvironment.spawn({
          projectId: "proj-1",
          environmentId: "worktree",
        });

        await vi.waitFor(() => {
          expect(eventRepo.create).toHaveBeenCalledWith(
            expect.objectContaining({
              threadId: "t-new",
              type: "system/provisioning/env_setup",
              data: expect.objectContaining({
                status: "started",
                reason: "thread-created",
              }),
            }),
          );
        });

        expect(eventRepo.create).not.toHaveBeenCalledWith(
          expect.objectContaining({
            threadId: "t-new",
            type: "system/provisioning/env_setup",
            data: expect.objectContaining({
              status: "completed",
            }),
          }),
        );

        resolveSetup?.({
          exitCode: 0,
          stdout: "",
          stderr: "",
        });

        await vi.waitFor(() => {
          expect(eventRepo.create).toHaveBeenCalledWith(
            expect.objectContaining({
              threadId: "t-new",
              type: "system/provisioning/env_setup",
              data: expect.objectContaining({
                status: "completed",
                reason: "thread-created",
              }),
            }),
          );
        });
      } finally {
        rmSync(tempRoot, { recursive: true, force: true });
      }
    });

    it("streams env-setup output while the setup script is still running", async () => {
      const tempRoot = mkdtempSync(join(tmpdir(), "beanbag-orchestrator-env-stream-"));
      const workspaceRoot = join(tempRoot, "workspace");
      let workspaceExists = false;

      let resolveSetup:
        | ((result: { exitCode: number; stdout: string; stderr: string }) => void)
        | undefined;
      const setupResult = new Promise<{ exitCode: number; stdout: string; stderr: string }>(
        (resolve) => {
          resolveSetup = resolve;
        },
      );
      const info: SystemEnvironmentInfo = {
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
      };
      const customEnvironmentRegistry = new EnvironmentRegistry().register({
        kind: "worktree",
        info,
        create(): IEnvironment {
          return makeRuntimeEnvironment({
            kind: "worktree",
            rootPath: workspaceRoot,
            overrides: {
              info,
              async prepare() {
                mkdirSync(workspaceRoot, { recursive: true });
                writeFileSync(
                  join(workspaceRoot, ".bb-env-setup.sh"),
                  "#!/usr/bin/env sh\nsleep 0\n",
                  "utf8",
                );
                workspaceExists = true;
              },
              exists() {
                return workspaceExists;
              },
              shouldRunSetupScript() {
                return true;
              },
              runAsync: vi.fn().mockImplementation(
                async (
                  _command: string,
                  _args: string[],
                  options?: {
                    onStdoutLine?: (line: string) => void;
                    onStderrLine?: (line: string) => void;
                  },
                ) => {
                  options?.onStdoutLine?.("+ pnpm install");
                  options?.onStderrLine?.("warning: cache miss");
                  return setupResult;
                },
              ),
              run: vi.fn().mockReturnValue({
                exitCode: 0,
                stdout: "",
                stderr: "",
              }),
            },
          });
        },
        restore(_state: unknown): IEnvironment {
          return this.create({
            projectId: "proj-1",
            threadId: "t-new",
            projectRootPath: "/test",
            runtimeEnv: {},
          });
        },
        isState(_value: unknown): _value is unknown {
          return true;
        },
      });
      const managerWithCustomEnvironment = new Orchestrator(
        threadRepo,
        eventRepo,
        projectRepo,
        ws,
        llmCompletionService,
        createCodexProviderAdapter(),
        createTestRuntimeEnv(),
        customEnvironmentRegistry,
      );

      const project = {
        id: "proj-1",
        name: "Test",
        rootPath: "/test",
        createdAt: 1000,
        updatedAt: 1000,
      };
      (projectRepo.getById as ReturnType<typeof vi.fn>).mockReturnValue(project);
      (threadRepo.create as ReturnType<typeof vi.fn>).mockReturnValue(
        makeThread({
          id: "t-new",
          status: "created",
          environmentId: "worktree",
        }),
      );
      (threadRepo.getById as ReturnType<typeof vi.fn>).mockImplementation((id: string) =>
        id === "t-new"
          ? makeThread({
              id: "t-new",
              projectId: "proj-1",
              status: "provisioning",
              environmentId: "worktree",
            })
          : undefined,
      );
      (eventRepo.create as ReturnType<typeof vi.fn>).mockImplementation((event) =>
        makeEvent({
          threadId: event.threadId,
          seq: event.seq,
          type: event.type as string,
          data: event.data,
        }),
      );

      try {
        await managerWithCustomEnvironment.spawn({
          projectId: "proj-1",
          environmentId: "worktree",
        });

        await vi.waitFor(() => {
          expect(eventRepo.create).toHaveBeenCalledWith(
            expect.objectContaining({
              threadId: "t-new",
              type: "system/provisioning/env_setup",
              data: expect.objectContaining({
                status: "running",
                detail: "+ pnpm install",
              }),
            }),
          );
        });

        expect(eventRepo.create).toHaveBeenCalledWith(
          expect.objectContaining({
            threadId: "t-new",
            type: "system/provisioning/env_setup",
            data: expect.objectContaining({
              status: "running",
              detail: "warning: cache miss",
            }),
          }),
        );

        resolveSetup?.({
          exitCode: 0,
          stdout: "+ pnpm install\n",
          stderr: "warning: cache miss\n",
        });

        await vi.waitFor(() => {
          expect(eventRepo.create).toHaveBeenCalledWith(
            expect.objectContaining({
              threadId: "t-new",
              type: "system/provisioning/env_setup",
              data: expect.objectContaining({
                status: "completed",
              }),
            }),
          );
        });
      } finally {
        rmSync(tempRoot, { recursive: true, force: true });
      }
    });

    it("prepends bb path to PATH and injects it into thread/start config", async () => {
      const tmpRoot = mkdtempSync(join(tmpdir(), "beanbag-orchestrator-"));
      const firstBin = join(tmpRoot, "first-bin");
      const bbBin = join(tmpRoot, "bb-bin");
      mkdirSync(firstBin, { recursive: true });
      mkdirSync(bbBin, { recursive: true });
      const bbPath = join(bbBin, "bb");
      writeFileSync(bbPath, "#!/bin/sh\nexit 0\n", "utf-8");
      chmodSync(bbPath, 0o755);

      const pathValue = [firstBin, bbBin].join(delimiter);
      const runtimeEnv = { ...createTestRuntimeEnv(), PATH: pathValue };

      try {
        const localManager = new Orchestrator(
          threadRepo,
          eventRepo,
          projectRepo,
          ws,
          llmCompletionService,
          createCodexProviderAdapter(),
          runtimeEnv,
        );

        const project = { id: "proj-1", name: "Test", rootPath: "/test", createdAt: 1000, updatedAt: 1000 };
        (projectRepo.getById as ReturnType<typeof vi.fn>).mockReturnValue(project);

        const createdThread = makeThread({ id: "t-new", status: "idle" });
        (threadRepo.create as ReturnType<typeof vi.fn>).mockReturnValue(createdThread);
        (threadRepo.getById as ReturnType<typeof vi.fn>).mockReturnValue(
          makeThread({ id: "t-new", status: "active" }),
        );

        await localManager.spawn({ projectId: "proj-1" });
        await vi.waitFor(() => {
          expect(fakeChild._stdinData.length).toBeGreaterThanOrEqual(2);
        });

        const expectedPath = [bbBin, firstBin].join(delimiter);
        const startMsg = JSON.parse(fakeChild._stdinData[1].trim());
        expect(startMsg.params.config["shell_environment_policy.set.PATH"]).toBe(expectedPath);
      } finally {
        rmSync(tmpRoot, { recursive: true, force: true });
      }
    });

    it("creates a bb shim and injects it into PATH when bb is not on PATH", async () => {
      const tmpRoot = mkdtempSync(join(tmpdir(), "beanbag-orchestrator-"));
      const firstBin = join(tmpRoot, "first-bin");
      const secondBin = join(tmpRoot, "second-bin");
      mkdirSync(firstBin, { recursive: true });
      mkdirSync(secondBin, { recursive: true });

      const pathValue = [firstBin, secondBin].join(delimiter);
      const runtimeEnv = { ...createTestRuntimeEnv(), PATH: pathValue };

      try {
        const localManager = new Orchestrator(
          threadRepo,
          eventRepo,
          projectRepo,
          ws,
          llmCompletionService,
          createCodexProviderAdapter(),
          runtimeEnv,
        );

        const project = { id: "proj-1", name: "Test", rootPath: "/test", createdAt: 1000, updatedAt: 1000 };
        (projectRepo.getById as ReturnType<typeof vi.fn>).mockReturnValue(project);

        const createdThread = makeThread({ id: "t-new", status: "idle" });
        (threadRepo.create as ReturnType<typeof vi.fn>).mockReturnValue(createdThread);
        (threadRepo.getById as ReturnType<typeof vi.fn>).mockReturnValue(
          makeThread({ id: "t-new", status: "active" }),
        );

        await localManager.spawn({ projectId: "proj-1" });
        await vi.waitFor(() => {
          expect(fakeChild._stdinData.length).toBeGreaterThanOrEqual(2);
        });

        const startMsg = JSON.parse(fakeChild._stdinData[1].trim());
        const injectedPath =
          startMsg.params.config["shell_environment_policy.set.PATH"];
        expect(typeof injectedPath).toBe("string");
        expect(injectedPath).toBeTruthy();

        const firstEntry = injectedPath!.split(delimiter)[0];
        const shimPath = join(firstEntry, "bb");
        expect(existsSync(shimPath)).toBe(true);
        expect(() => accessSync(shimPath, constants.X_OK)).not.toThrow();

        const shimScript = readFileSync(shimPath, "utf-8");
        const hasNodeRunner = shimScript.includes(`"${process.execPath}"`);
        const hasTsxRunner = shimScript.includes("/tsx\"");
        expect(hasNodeRunner || hasTsxRunner).toBe(true);
        expect(shimScript).toContain('"$@"');

        expect(injectedPath).toBe(startMsg.params.config["shell_environment_policy.set.PATH"]);
      } finally {
        rmSync(tmpRoot, { recursive: true, force: true });
      }
    });

    it("registers the process and marks thread as active", async () => {
      const project = { id: "proj-1", name: "Test", rootPath: "/test", createdAt: 1000, updatedAt: 1000 };
      (projectRepo.getById as ReturnType<typeof vi.fn>).mockReturnValue(project);

      const createdThread = makeThread({ id: "t-new", status: "idle" });
      (threadRepo.create as ReturnType<typeof vi.fn>).mockReturnValue(createdThread);
      (threadRepo.getById as ReturnType<typeof vi.fn>).mockReturnValue(
        makeThread({ id: "t-new", status: "active" }),
      );

      await manager.spawn({ projectId: "proj-1" });
      await vi.waitFor(() => {
        expect(manager.isActive("t-new")).toBe(true);
      });
      expect(manager.getActiveCount()).toBe(1);
    });

    it("updates thread status through provisioning and broadcasts", async () => {
      const project = { id: "proj-1", name: "Test", rootPath: "/test", createdAt: 1000, updatedAt: 1000 };
      (projectRepo.getById as ReturnType<typeof vi.fn>).mockReturnValue(project);

      const createdThread = makeThread({ id: "t-new", status: "idle" });
      (threadRepo.create as ReturnType<typeof vi.fn>).mockReturnValue(createdThread);
      (threadRepo.getById as ReturnType<typeof vi.fn>).mockReturnValue(
        makeThread({ id: "t-new", status: "active" }),
      );

      await manager.spawn({ projectId: "proj-1" });
      await vi.waitFor(() => {
        expect(threadRepo.update).toHaveBeenCalledWith("t-new", { status: "provisioning" });
      });
      expect(ws.broadcast).toHaveBeenCalledWith("thread", "t-new", [
        "status-changed",
        "work-status-changed",
      ]);
    });

    it("records the provisioning reason when spawning a thread", async () => {
      const project = { id: "proj-1", name: "Test", rootPath: "/test", createdAt: 1000, updatedAt: 1000 };
      (projectRepo.getById as ReturnType<typeof vi.fn>).mockReturnValue(project);

      const createdThread = makeThread({ id: "t-new", status: "idle" });
      (threadRepo.create as ReturnType<typeof vi.fn>).mockReturnValue(createdThread);
      (threadRepo.getById as ReturnType<typeof vi.fn>).mockReturnValue(
        makeThread({ id: "t-new", status: "active" }),
      );

      await manager.spawn({ projectId: "proj-1" });

      await vi.waitFor(() => {
        expect(eventRepo.create).toHaveBeenCalledWith(
          expect.objectContaining({
            threadId: "t-new",
            type: "system/provisioning/started",
            data: expect.objectContaining({
              reason: "thread-created",
            }),
          }),
        );
      });
    });

    it("sends initialize and thread/start JSON-RPC to the child process stdin", async () => {
      const project = { id: "proj-1", name: "Test", rootPath: "/test", createdAt: 1000, updatedAt: 1000 };
      (projectRepo.getById as ReturnType<typeof vi.fn>).mockReturnValue(project);

      const createdThread = makeThread({ id: "t-new", status: "idle" });
      (threadRepo.create as ReturnType<typeof vi.fn>).mockReturnValue(createdThread);
      (threadRepo.getById as ReturnType<typeof vi.fn>).mockReturnValue(
        makeThread({ id: "t-new", status: "active" }),
      );

      await manager.spawn({ projectId: "proj-1" });

      // Should have written initialize + thread/start to stdin
      await vi.waitFor(() => {
        expect(fakeChild._stdinData.length).toBeGreaterThanOrEqual(2);
      });

      // First message: initialize
      const initMsg = JSON.parse(fakeChild._stdinData[0].trim());
      expect(initMsg.jsonrpc).toBe("2.0");
      expect(initMsg.method).toBe("initialize");
      expect(initMsg.params.clientInfo.name).toBe("beanbag");
      expect(initMsg.params.capabilities?.optOutNotificationMethods).toEqual(
        expect.arrayContaining([
          "codex/event/item_started",
          "codex/event/item_completed",
        ]),
      );
      expect(initMsg.id).toBe(1);

      // Second message: thread/start
      const startMsg = JSON.parse(fakeChild._stdinData[1].trim());
      expect(startMsg.jsonrpc).toBe("2.0");
      expect(startMsg.method).toBe("thread/start");
      expect(startMsg.params.approvalPolicy).toBe("never");
      expect(startMsg.params.sandbox).toBe("danger-full-access");
      expect(startMsg.params.baseInstructions).toContain("coding agent");
      expect(startMsg.params.config["shell_environment_policy.set.BB_PROJECT_ID"]).toBe("proj-1");
      expect(startMsg.params.config["shell_environment_policy.set.BB_THREAD_ID"]).toBe("t-new");
      expect(startMsg.id).toBe(2);
    });

    it("sends turn/start when input is provided", async () => {
      const project = { id: "proj-1", name: "Test", rootPath: "/test", createdAt: 1000, updatedAt: 1000 };
      (projectRepo.getById as ReturnType<typeof vi.fn>).mockReturnValue(project);

      const createdThread = makeThread({ id: "t-new", status: "idle" });
      (threadRepo.create as ReturnType<typeof vi.fn>).mockReturnValue(createdThread);
      (threadRepo.getById as ReturnType<typeof vi.fn>).mockReturnValue(
        makeThread({ id: "t-new", status: "active" }),
      );

      await manager.spawn({
        projectId: "proj-1",
        input: [{ type: "text", text: "Fix the login bug" }],
      });

      await vi.waitFor(() => {
        const hasTurnStart = fakeChild._stdinData
          .map((entry) => parseRpcMessage(entry))
          .some((entry) => entry.method === "turn/start");
        expect(hasTurnStart).toBe(true);
      });

      const turnMsg = findRpcMessageByMethod(fakeChild._stdinData, "turn/start");
      expect(turnMsg.jsonrpc).toBe("2.0");
      expect(turnMsg.method).toBe("turn/start");
      expect(turnMsg.params.threadId).toBe(CODEX_THREAD_ID);
      expect(turnMsg.params.input).toEqual([{ type: "text", text: "Fix the login bug" }]);
      expect(turnMsg.params.approvalPolicy).toBe("never");
      expect(turnMsg.params.sandboxPolicy).toEqual({ type: "dangerFullAccess" });
      expect(turnMsg.id).toBe(3);
    });

    it("maps developerInstructions onto thread/start baseInstructions", async () => {
      const project = { id: "proj-1", name: "Test", rootPath: "/test", createdAt: 1000, updatedAt: 1000 };
      (projectRepo.getById as ReturnType<typeof vi.fn>).mockReturnValue(project);

      const createdThread = makeThread({ id: "t-new", status: "idle" });
      (threadRepo.create as ReturnType<typeof vi.fn>).mockReturnValue(createdThread);
      (threadRepo.getById as ReturnType<typeof vi.fn>).mockReturnValue(
        makeThread({ id: "t-new", status: "active" }),
      );

      await manager.spawn({
        projectId: "proj-1",
        developerInstructions: "[bb system] test developer instructions",
      });

      await vi.waitFor(() => {
        const hasStart = fakeChild._stdinData
          .map((entry) => parseRpcMessage(entry))
          .some((entry) => entry.method === "thread/start");
        expect(hasStart).toBe(true);
      });
      const startMsg = findRpcMessageByMethod(fakeChild._stdinData, "thread/start");
      expect(startMsg.params.baseInstructions).toBe(
        [
          DEFAULT_BASE_INSTRUCTIONS,
          "[bb system] test developer instructions",
        ].join("\n\n"),
      );
      expect(startMsg.params.developerInstructions).toBeUndefined();
      expect(eventRepo.create).toHaveBeenCalledWith(
        expect.objectContaining({
          type: "client/thread/start",
          data: expect.objectContaining({
            request: expect.objectContaining({
              params: expect.objectContaining({
                baseInstructions: [
                  DEFAULT_BASE_INSTRUCTIONS,
                  "[bb system] test developer instructions",
                ].join("\n\n"),
              }),
            }),
          }),
        }),
      );
    });

    it("adds worktree-specific developer instructions", async () => {
      const customEnvironmentRegistry = createTestEnvironmentRegistry({
        rootPath: "/tmp/thread-worktree",
      });
      const managerWithCustomEnvironment = new Orchestrator(
        threadRepo,
        eventRepo,
        projectRepo,
        ws,
        llmCompletionService,
        createCodexProviderAdapter(),
        createTestRuntimeEnv(),
        customEnvironmentRegistry,
      );

      const project = {
        id: "proj-1",
        name: "Test",
        rootPath: "/test",
        createdAt: 1000,
        updatedAt: 1000,
        projectInstructions: "[project instructions] keep CI green",
      };
      (projectRepo.getById as ReturnType<typeof vi.fn>).mockReturnValue(project);

      const createdThread = makeThread({
        id: "t-new",
        status: "idle",
        environmentId: "worktree",
      });
      (threadRepo.create as ReturnType<typeof vi.fn>).mockReturnValue(createdThread);
      (threadRepo.getById as ReturnType<typeof vi.fn>).mockReturnValue(
        makeThread({ id: "t-new", status: "active", environmentId: "worktree" }),
      );

      await managerWithCustomEnvironment.spawn({
        projectId: "proj-1",
        environmentId: "worktree",
        developerInstructions: "[request instructions] add tests",
      });

      await vi.waitFor(() => {
        const hasStart = fakeChild._stdinData
          .map((entry) => parseRpcMessage(entry))
          .some((entry) => entry.method === "thread/start");
        expect(hasStart).toBe(true);
      });
      const startMsg = findRpcMessageByMethod(fakeChild._stdinData, "thread/start");
      expect(startMsg.params.baseInstructions).toContain(
        "[project instructions] keep CI green",
      );
      expect(startMsg.params.baseInstructions).toContain(
        "[request instructions] add tests",
      );
      expect(startMsg.params.baseInstructions).toContain(
        "[Beanbag worktree environment]",
      );
    });

    it("does not auto-generate spawn titles from input", async () => {
      const project = { id: "proj-1", name: "Test", rootPath: "/test", createdAt: 1000, updatedAt: 1000 };
      (projectRepo.getById as ReturnType<typeof vi.fn>).mockReturnValue(project);

      const createdThread = makeThread({ id: "t-new", status: "idle" });
      (threadRepo.create as ReturnType<typeof vi.fn>).mockReturnValue(createdThread);
      (threadRepo.getById as ReturnType<typeof vi.fn>).mockReturnValue(
        makeThread({ id: "t-new", status: "active" }),
      );

      await manager.spawn({
        projectId: "proj-1",
        input: [{ type: "text", text: "Fix flaky login redirect" }],
      });

      expect(threadRepo.create).toHaveBeenCalledWith({
        projectId: "proj-1",
        environmentId: "local",
      });
    });

    it("returns prompt-derived title fallback when spawned without an explicit title", async () => {
      const project = { id: "proj-1", name: "Test", rootPath: "/test", createdAt: 1000, updatedAt: 1000 };
      (projectRepo.getById as ReturnType<typeof vi.fn>).mockReturnValue(project);

      const createdThread = makeThread({ id: "t-new", status: "idle" });
      (threadRepo.create as ReturnType<typeof vi.fn>).mockReturnValue(createdThread);

      const result = await manager.spawn({
        projectId: "proj-1",
        input: [{ type: "text", text: "Fix flaky login redirect" }],
      });

      expect(result.title).toBeUndefined();
      expect(result.titleFallback).toBe("Fix flaky login redirect");
    });

    it("auto-generates and persists thread names when daemon title generation is enabled", async () => {
      const titleGenerator = vi
        .fn()
        .mockResolvedValue("Generated Login Fix Title");
      const titleLlmCompletionService = createMockLlmCompletionService({
        generateThreadTitle: titleGenerator,
      });
      const titleManager = new Orchestrator(
        threadRepo,
        eventRepo,
        projectRepo,
        ws,
        titleLlmCompletionService,
        createCodexProviderAdapter(),
        createTestRuntimeEnv(),
        undefined,
        undefined,
        undefined,
        undefined,
      );

      const project = { id: "proj-1", name: "Test", rootPath: "/test", createdAt: 1000, updatedAt: 1000 };
      (projectRepo.getById as ReturnType<typeof vi.fn>).mockReturnValue(project);

      const createdThread = makeThread({ id: "t-new", status: "idle" });
      let persistedThread = makeThread({
        id: "t-new",
        status: "active",
      });
      (threadRepo.create as ReturnType<typeof vi.fn>).mockReturnValue(createdThread);
      (threadRepo.getById as ReturnType<typeof vi.fn>).mockImplementation(
        () => persistedThread,
      );
      (threadRepo.update as ReturnType<typeof vi.fn>).mockImplementation(
        (_threadId: string, updates: { status?: Thread["status"]; title?: string }) => {
          persistedThread = {
            ...persistedThread,
            ...(updates.status !== undefined ? { status: updates.status } : {}),
            ...(updates.title !== undefined ? { title: updates.title } : {}),
          };
          return persistedThread;
        },
      );

      await titleManager.spawn({
        projectId: "proj-1",
        input: [{ type: "text", text: "Fix the login bug" }],
      });

      await vi.waitFor(() => {
        expect(titleGenerator).toHaveBeenCalledTimes(1);
      });
      expect(titleGenerator).toHaveBeenCalledWith({
        input: [{ type: "text", text: "Fix the login bug" }],
        cwd: "/test",
      });

      const renameMsgRaw = fakeChild._stdinData
        .map((entry) => JSON.parse(entry.trim()))
        .find((entry) => entry.method === "thread/name/set");
      expect(renameMsgRaw).toBeDefined();
      expect(renameMsgRaw.params).toEqual({
        threadId: CODEX_THREAD_ID,
        name: "Generated Login Fix Title",
      });
      expect(persistedThread.title).toBe("Generated Login Fix Title");
    });

    it("sends explicit spawn titles to provider after thread startup", async () => {
      const project = { id: "proj-1", name: "Test", rootPath: "/test", createdAt: 1000, updatedAt: 1000 };
      (projectRepo.getById as ReturnType<typeof vi.fn>).mockReturnValue(project);

      const createdThread = makeThread({
        id: "t-new",
        status: "idle",
        title: "Pinned custom title",
      });
      (threadRepo.create as ReturnType<typeof vi.fn>).mockReturnValue(createdThread);
      (threadRepo.getById as ReturnType<typeof vi.fn>).mockImplementation(
        () => makeThread({
          id: "t-new",
          status: "active",
          title: "Pinned custom title",
        }),
      );

      await manager.spawn({
        projectId: "proj-1",
        title: "Pinned custom title",
      });

      await vi.waitFor(() => {
        const hasRename = fakeChild._stdinData
          .map((entry) => JSON.parse(entry.trim()))
          .some((entry) => entry.method === "thread/name/set");
        expect(hasRename).toBe(true);
      });

      const renameMsgRaw = fakeChild._stdinData
        .map((entry) => JSON.parse(entry.trim()))
        .find((entry) => entry.method === "thread/name/set");
      expect(renameMsgRaw).toBeDefined();
      expect(renameMsgRaw.params).toEqual({
        threadId: CODEX_THREAD_ID,
        name: "Pinned custom title",
      });
    });

    it("sends turn/start when multimodal input is provided", async () => {
      const project = { id: "proj-1", name: "Test", rootPath: "/test", createdAt: 1000, updatedAt: 1000 };
      (projectRepo.getById as ReturnType<typeof vi.fn>).mockReturnValue(project);

      const createdThread = makeThread({ id: "t-new", status: "idle" });
      (threadRepo.create as ReturnType<typeof vi.fn>).mockReturnValue(createdThread);
      (threadRepo.getById as ReturnType<typeof vi.fn>).mockReturnValue(
        makeThread({ id: "t-new", status: "active" }),
      );

      await manager.spawn({
        projectId: "proj-1",
        input: [
          { type: "text", text: "Please review these references." },
          { type: "image", url: "https://example.com/diagram.png" },
          { type: "localImage", path: "/tmp/local-diagram.png" },
        ],
      });

      await vi.waitFor(() => {
        expect(fakeChild._stdinData.length).toBe(3);
      });
      const turnMsg = JSON.parse(fakeChild._stdinData[2].trim());
      expect(turnMsg.method).toBe("turn/start");
      expect(turnMsg.params.threadId).toBe(CODEX_THREAD_ID);
      expect(turnMsg.params.input).toEqual([
        { type: "text", text: "Please review these references." },
        { type: "image", url: "https://example.com/diagram.png" },
        { type: "localImage", path: "/tmp/local-diagram.png" },
      ]);
      expect(turnMsg.params.sandboxPolicy).toEqual({ type: "dangerFullAccess" });
    });

    it("maps local file attachments to text annotations for provider compatibility", async () => {
      const project = { id: "proj-1", name: "Test", rootPath: "/test", createdAt: 1000, updatedAt: 1000 };
      (projectRepo.getById as ReturnType<typeof vi.fn>).mockReturnValue(project);

      const createdThread = makeThread({ id: "t-new", status: "idle" });
      (threadRepo.create as ReturnType<typeof vi.fn>).mockReturnValue(createdThread);
      (threadRepo.getById as ReturnType<typeof vi.fn>).mockReturnValue(
        makeThread({ id: "t-new", status: "active" }),
      );

      await manager.spawn({
        projectId: "proj-1",
        input: [
          { type: "text", text: "Please use the attached spec." },
          {
            type: "localFile",
            path: "/tmp/spec.md",
            name: "spec.md",
            sizeBytes: 42,
            mimeType: "text/markdown",
          },
        ],
      });

      await vi.waitFor(() => {
        expect(fakeChild._stdinData.length).toBe(3);
      });
      const turnMsg = JSON.parse(fakeChild._stdinData[2].trim());
      expect(turnMsg.method).toBe("turn/start");
      expect(turnMsg.params.threadId).toBe(CODEX_THREAD_ID);
      expect(turnMsg.params.input).toEqual([
        { type: "text", text: "Please use the attached spec." },
        { type: "text", text: "Attached local file: /tmp/spec.md" },
      ]);
    });

    it("includes model and reasoning config when input options are provided", async () => {
      const project = { id: "proj-1", name: "Test", rootPath: "/test", createdAt: 1000, updatedAt: 1000 };
      (projectRepo.getById as ReturnType<typeof vi.fn>).mockReturnValue(project);

      const createdThread = makeThread({ id: "t-new", status: "idle" });
      (threadRepo.create as ReturnType<typeof vi.fn>).mockReturnValue(createdThread);
      (threadRepo.getById as ReturnType<typeof vi.fn>).mockReturnValue(
        makeThread({ id: "t-new", status: "active" }),
      );

      await manager.spawn({
        projectId: "proj-1",
        input: [{ type: "text", text: "Fix the login bug" }],
        model: "gpt-5-codex",
        reasoningLevel: "high",
      });

      await vi.waitFor(() => {
        expect(fakeChild._stdinData.length).toBe(3);
      });

      const startMsg = JSON.parse(fakeChild._stdinData[1].trim());
      expect(startMsg.params.model).toBe("gpt-5-codex");
      expect(startMsg.params.config).toMatchObject({
        model_reasoning_effort: "high",
        "shell_environment_policy.set.BB_PROJECT_ID": "proj-1",
        "shell_environment_policy.set.BB_THREAD_ID": "t-new",
      });
      expect(startMsg.params.sandbox).toBe("danger-full-access");

      const turnMsg = JSON.parse(fakeChild._stdinData[2].trim());
      expect(turnMsg.params.model).toBe("gpt-5-codex");
      expect(turnMsg.params.config).toEqual({
        model_reasoning_effort: "high",
      });
      expect(turnMsg.params.sandboxPolicy).toEqual({ type: "dangerFullAccess" });
    });

    it("does NOT send turn/start when no input is provided", async () => {
      const project = { id: "proj-1", name: "Test", rootPath: "/test", createdAt: 1000, updatedAt: 1000 };
      (projectRepo.getById as ReturnType<typeof vi.fn>).mockReturnValue(project);

      const createdThread = makeThread({ id: "t-new", status: "idle" });
      (threadRepo.create as ReturnType<typeof vi.fn>).mockReturnValue(createdThread);
      (threadRepo.getById as ReturnType<typeof vi.fn>).mockReturnValue(
        makeThread({ id: "t-new", status: "active" }),
      );

      await manager.spawn({ projectId: "proj-1" });

      // Only initialize + thread/start, no turn/start
      await vi.waitFor(() => {
        const hasStart = fakeChild._stdinData
          .map((entry) => JSON.parse(entry.trim()) as { method?: string })
          .some((entry) => entry.method === "thread/start");
        expect(hasStart).toBe(true);
      });
      const hasTurnStart = fakeChild._stdinData
        .map((entry) => JSON.parse(entry.trim()) as { method?: string })
        .some((entry) => entry.method === "turn/start");
      expect(hasTurnStart).toBe(false);
    });

    it("persists initial input on outbound client/thread/start events", async () => {
      const project = { id: "proj-1", name: "Test", rootPath: "/test", createdAt: 1000, updatedAt: 1000 };
      (projectRepo.getById as ReturnType<typeof vi.fn>).mockReturnValue(project);

      const createdThread = makeThread({ id: "t-new", status: "idle" });
      (threadRepo.create as ReturnType<typeof vi.fn>).mockReturnValue(createdThread);
      (threadRepo.getById as ReturnType<typeof vi.fn>).mockReturnValue(
        makeThread({ id: "t-new", status: "active" }),
      );

      const input = [{ type: "text", text: "Fix provisioning status UI" }] as const;
      await manager.spawn({ projectId: "proj-1", input: [...input] });

      await vi.waitFor(() => {
        expect(eventRepo.create).toHaveBeenCalledWith(
          expect.objectContaining({
            type: "client/thread/start",
            data: expect.objectContaining({
              input,
            }),
          }),
        );
      });
    });

    it("throws if project not found", async () => {
      (projectRepo.getById as ReturnType<typeof vi.fn>).mockReturnValue(undefined);

      await expect(
        manager.spawn({ projectId: "bad-proj" }),
      ).rejects.toThrow("Project bad-proj not found");

      expect(spawnMock).not.toHaveBeenCalled();
    });

    it("returns the created thread record immediately after spawn", async () => {
      const project = { id: "proj-1", name: "Test", rootPath: "/test", createdAt: 1000, updatedAt: 1000 };
      (projectRepo.getById as ReturnType<typeof vi.fn>).mockReturnValue(project);

      const createdThread = makeThread({ id: "t-new", status: "idle" });
      (threadRepo.create as ReturnType<typeof vi.fn>).mockReturnValue(createdThread);

      const updatedThread = makeThread({ id: "t-new", status: "active" });
      (threadRepo.getById as ReturnType<typeof vi.fn>).mockReturnValue(updatedThread);

      const result = await manager.spawn({ projectId: "proj-1" });

      expect(result).toBe(createdThread);
      expect(result.status).toBe("idle");
    });

    it("marks thread provisioning_failed if spawn setup errors", async () => {
      const project = { id: "proj-1", name: "Test", rootPath: "/test", createdAt: 1000, updatedAt: 1000 };
      (projectRepo.getById as ReturnType<typeof vi.fn>).mockReturnValue(project);

      const createdThread = makeThread({ id: "t-new", status: "idle" });
      (threadRepo.create as ReturnType<typeof vi.fn>).mockReturnValue(createdThread);

      // Make spawn throw
      (spawnMock as ReturnType<typeof vi.fn>).mockImplementation(() => {
        throw new Error("ENOENT: codex not found");
      });

      const result = await manager.spawn({ projectId: "proj-1" });
      expect(result).toBe(createdThread);
      await vi.waitFor(() => {
        expect(threadRepo.update).toHaveBeenCalledWith("t-new", { status: "provisioning_failed" });
      });

      expect(ws.broadcast).toHaveBeenCalledWith("thread", "t-new", [
        "status-changed",
        "work-status-changed",
      ]);
    });

    it("records client/thread/start first and preserves input when spawn setup fails", async () => {
      const project = { id: "proj-1", name: "Test", rootPath: "/test", createdAt: 1000, updatedAt: 1000 };
      (projectRepo.getById as ReturnType<typeof vi.fn>).mockReturnValue(project);

      const createdThread = makeThread({ id: "t-input-fail", status: "idle" });
      (threadRepo.create as ReturnType<typeof vi.fn>).mockReturnValue(createdThread);
      const input = [{ type: "text", text: "Fix the provisioning crash" }] as const;

      (spawnMock as ReturnType<typeof vi.fn>).mockImplementation(() => {
        throw new Error("ENOENT: codex not found");
      });

      const result = await manager.spawn({ projectId: "proj-1", input: [...input] });
      expect(result).toMatchObject({
        id: "t-input-fail",
        status: "idle",
        titleFallback: "Fix the provisioning crash",
      });

      await vi.waitFor(() => {
        expect(threadRepo.update).toHaveBeenCalledWith("t-input-fail", {
          status: "provisioning_failed",
        });
      });
      expect(eventRepo.create).toHaveBeenCalledWith(
        expect.objectContaining({
          type: "client/thread/start",
          data: expect.objectContaining({
            input,
          }),
        }),
      );
      const persistedEventTypes = (eventRepo.create as ReturnType<typeof vi.fn>).mock.calls
        .map((call) => (call[0] as { type?: string }).type)
        .filter((value): value is string => typeof value === "string");
      expect(persistedEventTypes[0]).toBe("client/thread/start");
    });

    it("marks thread provisioning_failed when codex returns RPC error to thread/start", async () => {
      const project = { id: "proj-1", name: "Test", rootPath: "/test", createdAt: 1000, updatedAt: 1000 };
      (projectRepo.getById as ReturnType<typeof vi.fn>).mockReturnValue(project);

      const createdThread = makeThread({ id: "t-err", status: "idle" });
      (threadRepo.create as ReturnType<typeof vi.fn>).mockReturnValue(createdThread);

      // Use a non-auto-responding child, manually return an error
      const errorChild = createFakeChildProcess({ autoRespond: false });
      (spawnMock as ReturnType<typeof vi.fn>).mockReturnValue(errorChild);

      // After the thread/start write, push an error response
      errorChild.stdin = new Writable({
        write(chunk: Buffer, _encoding: string, callback: () => void) {
          const data = chunk.toString();
          errorChild._stdinData.push(data);
          try {
            const msg = JSON.parse(data.trim());
            if (respondToEnvironmentAgentControlMessage(errorChild, msg)) {
              callback();
              return;
            }
            if (msg.method === "thread/start" && msg.id) {
              process.nextTick(() => {
                errorChild.stdout!.push(
                  JSON.stringify({
                    id: msg.id,
                    error: { code: -32600, message: "Invalid params" },
                  }) + "\n",
                );
              });
            }
          } catch {}
          callback();
        },
      });

      await manager.spawn({ projectId: "proj-1" });
      await vi.waitFor(() => {
        expect(threadRepo.update).toHaveBeenCalledWith("t-err", { status: "provisioning_failed" });
      });
    });

    it("marks thread provisioning_failed when thread/start times out", async () => {
      vi.useFakeTimers();
      try {
        const project = { id: "proj-1", name: "Test", rootPath: "/test", createdAt: 1000, updatedAt: 1000 };
        (projectRepo.getById as ReturnType<typeof vi.fn>).mockReturnValue(project);

        const createdThread = makeThread({ id: "t-timeout", status: "idle" });
        (threadRepo.create as ReturnType<typeof vi.fn>).mockReturnValue(createdThread);

        // Use non-auto-responding child — thread/start will never get a response
        const silentChild = createFakeChildProcess({ autoRespond: false });
        (spawnMock as ReturnType<typeof vi.fn>).mockReturnValue(silentChild);

        await manager.spawn({ projectId: "proj-1" });

        // Advance past the 10s timeout
        await vi.advanceTimersByTimeAsync(10_001);
        await vi.waitFor(() => {
          expect(threadRepo.update).toHaveBeenCalledWith("t-timeout", {
            status: "provisioning_failed",
          });
        });
      } finally {
        vi.useRealTimers();
      }
    });

    it("logs JSON-RPC errors from codex in event streaming", async () => {
      const project = { id: "proj-1", name: "Test", rootPath: "/test", createdAt: 1000, updatedAt: 1000 };
      (projectRepo.getById as ReturnType<typeof vi.fn>).mockReturnValue(project);

      const createdThread = makeThread({ id: "t-new", status: "idle" });
      (threadRepo.create as ReturnType<typeof vi.fn>).mockReturnValue(createdThread);
      (threadRepo.getById as ReturnType<typeof vi.fn>).mockReturnValue(
        makeThread({ id: "t-new", status: "active" }),
      );

      const consoleSpy = vi.spyOn(console, "error").mockImplementation(() => {});

      await manager.spawn({ projectId: "proj-1" });

      // Push a JSON-RPC error response on stdout (as if codex rejected a request)
      fakeChild._pushStdout(
        JSON.stringify({
          id: 99,
          error: { code: -32600, message: "Bad request" },
        }),
      );

      await new Promise((r) => setTimeout(r, 50));

      expect(consoleSpy).toHaveBeenCalledWith(
        expect.stringContaining("RPC error"),
        expect.stringContaining("Bad request"),
      );

      consoleSpy.mockRestore();
    });

    it("summarizes refresh-token reuse stderr as a single warning", async () => {
      const project = { id: "proj-1", name: "Test", rootPath: "/test", createdAt: 1000, updatedAt: 1000 };
      (projectRepo.getById as ReturnType<typeof vi.fn>).mockReturnValue(project);

      const createdThread = makeThread({ id: "t-auth", status: "idle" });
      (threadRepo.create as ReturnType<typeof vi.fn>).mockReturnValue(createdThread);
      (threadRepo.getById as ReturnType<typeof vi.fn>).mockReturnValue(
        makeThread({ id: "t-auth", status: "active" }),
      );

      const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
      const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

      await manager.spawn({ projectId: "proj-1" });

      fakeChild._pushStderr(
        "2026-02-12T04:44:47.619501Z ERROR codex_core::auth: Failed to refresh token: 401 Unauthorized: {",
      );
      fakeChild._pushStderr('  "error": {');
      fakeChild._pushStderr(
        '    "message": "Your refresh token has already been used to generate a new access token. Please try signing in again.",',
      );
      fakeChild._pushStderr('    "type": "invalid_request_error",');
      fakeChild._pushStderr('    "code": "refresh_token_reused"');
      fakeChild._pushStderr("  }");
      fakeChild._pushStderr("}");
      fakeChild._pushStderr(
        "2026-02-12T04:44:47.619583Z ERROR codex_core::auth: Failed to refresh token: Your access token could not be refreshed because your refresh token was already used. Please log out and sign in again.",
      );

      await new Promise((r) => setTimeout(r, 50));

      expect(warnSpy).toHaveBeenCalledTimes(1);
      expect(warnSpy).toHaveBeenCalledWith(
        expect.stringContaining("provider auth refresh conflict"),
      );
      const sawRefreshTokenStderr = errorSpy.mock.calls.some((call) =>
        call.some(
          (arg) => typeof arg === "string" && arg.includes("refresh token"),
        ),
      );
      expect(sawRefreshTokenStderr).toBe(false);

      warnSpy.mockRestore();
      errorSpy.mockRestore();
    });

    it("keeps logging unrelated stderr lines as errors", async () => {
      const project = { id: "proj-1", name: "Test", rootPath: "/test", createdAt: 1000, updatedAt: 1000 };
      (projectRepo.getById as ReturnType<typeof vi.fn>).mockReturnValue(project);

      const createdThread = makeThread({ id: "t-stderr", status: "idle" });
      (threadRepo.create as ReturnType<typeof vi.fn>).mockReturnValue(createdThread);
      (threadRepo.getById as ReturnType<typeof vi.fn>).mockReturnValue(
        makeThread({ id: "t-stderr", status: "active" }),
      );

      const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

      await manager.spawn({ projectId: "proj-1" });

      fakeChild._pushStderr("panic: synthetic stderr failure");
      await new Promise((r) => setTimeout(r, 50));

      expect(errorSpy).toHaveBeenCalledWith(
        "[thread t-stderr] stderr: panic: synthetic stderr failure",
      );

      errorSpy.mockRestore();
    });

    it("streams stdout JSON-RPC notifications as events", async () => {
      const project = { id: "proj-1", name: "Test", rootPath: "/test", createdAt: 1000, updatedAt: 1000 };
      (projectRepo.getById as ReturnType<typeof vi.fn>).mockReturnValue(project);

      const createdThread = makeThread({ id: "t-new", status: "idle" });
      (threadRepo.create as ReturnType<typeof vi.fn>).mockReturnValue(createdThread);
      (threadRepo.getById as ReturnType<typeof vi.fn>).mockReturnValue(
        makeThread({ id: "t-new", status: "active" }),
      );

      await manager.spawn({ projectId: "proj-1" });

      // Simulate codex sending JSON-RPC notifications on stdout
      fakeChild._pushStdout(
        JSON.stringify({ method: "item/started", params: { itemId: "i1" } }),
      );
      fakeChild._pushStdout(
        JSON.stringify({ method: "item/completed", params: { content: "done" } }),
      );

      // Give the readline interface time to process
      await new Promise((r) => setTimeout(r, 50));

      const createdEvents = (eventRepo.create as ReturnType<typeof vi.fn>).mock.calls
        .map(([event]) => event);
      const startedEvent = createdEvents.find((event) => event.type === "item/started");
      const completedEvent = createdEvents.find((event) => event.type === "item/completed");

      expect(startedEvent).toEqual({
        threadId: "t-new",
        seq: expect.any(Number),
        type: "item/started",
        data: expect.objectContaining({
          __bb_provider_event: expect.objectContaining({
            providerId: "codex",
            method: "item/started",
          }),
          payload: { itemId: "i1" },
        }),
      });
      expect(completedEvent).toEqual({
        threadId: "t-new",
        seq: expect.any(Number),
        type: "item/completed",
        data: expect.objectContaining({
          __bb_provider_event: expect.objectContaining({
            providerId: "codex",
            method: "item/completed",
          }),
          payload: { content: "done" },
        }),
      });
    });

    it("suppresses duplicate legacy codex item lifecycle notifications", async () => {
      const project = { id: "proj-1", name: "Test", rootPath: "/test", createdAt: 1000, updatedAt: 1000 };
      (projectRepo.getById as ReturnType<typeof vi.fn>).mockReturnValue(project);

      const createdThread = makeThread({ id: "t-new", status: "idle" });
      (threadRepo.create as ReturnType<typeof vi.fn>).mockReturnValue(createdThread);
      (threadRepo.getById as ReturnType<typeof vi.fn>).mockReturnValue(
        makeThread({ id: "t-new", status: "active" }),
      );

      await manager.spawn({ projectId: "proj-1" });
      await vi.waitFor(() => {
        expect(threadRepo.update).toHaveBeenCalledWith("t-new", { status: "idle" });
      });
      (ws.broadcast as ReturnType<typeof vi.fn>).mockClear();

      fakeChild._pushStdout(
        JSON.stringify({
          method: "codex/event/item_completed",
          params: {
            id: "turn-1",
            msg: {
              type: "item_completed",
              turn_id: "turn-1",
              item: {
                type: "AgentMessage",
                id: "msg-1",
                content: [{ type: "Text", text: "duplicate legacy item event" }],
              },
            },
          },
        }),
      );
      fakeChild._pushStdout(
        JSON.stringify({
          method: "item/completed",
          params: {
            turnId: "turn-1",
            item: {
              type: "agentMessage",
              id: "msg-1",
              text: "canonical item event",
            },
          },
        }),
      );

      await new Promise((r) => setTimeout(r, 50));

      const createdEvents = (eventRepo.create as ReturnType<typeof vi.fn>).mock.calls
        .map(([event]) => event);
      const canonicalCompletedEvent = createdEvents.find(
        (event) => event.type === "item/completed",
      );
      expect(canonicalCompletedEvent).toEqual({
        threadId: "t-new",
        seq: expect.any(Number),
        type: "item/completed",
        data: expect.objectContaining({
          __bb_provider_event: expect.objectContaining({
            providerId: "codex",
            method: "item/completed",
          }),
          payload: {
            turnId: "turn-1",
            item: {
              type: "agentMessage",
              id: "msg-1",
              text: "canonical item event",
            },
          },
        }),
      });
      expect(eventRepo.create).not.toHaveBeenCalledWith(
        expect.objectContaining({
          type: "codex/event/item_completed",
        }),
      );
      expect(ws.broadcast).toHaveBeenCalledTimes(1);
      expect(ws.broadcast).toHaveBeenCalledWith("thread", "t-new", ["events-appended"]);
    });

    it("does not broadcast thread changes for high-frequency delta notifications", async () => {
      const project = { id: "proj-1", name: "Test", rootPath: "/test", createdAt: 1000, updatedAt: 1000 };
      (projectRepo.getById as ReturnType<typeof vi.fn>).mockReturnValue(project);

      const createdThread = makeThread({ id: "t-new", status: "idle" });
      (threadRepo.create as ReturnType<typeof vi.fn>).mockReturnValue(createdThread);
      (threadRepo.getById as ReturnType<typeof vi.fn>).mockReturnValue(
        makeThread({ id: "t-new", status: "active" }),
      );

      await manager.spawn({ projectId: "proj-1" });
      await vi.waitFor(() => {
        expect(threadRepo.update).toHaveBeenCalledWith("t-new", { status: "idle" });
      });
      (ws.broadcast as ReturnType<typeof vi.fn>).mockClear();

      fakeChild._pushStdout(
        JSON.stringify({ method: "item/agentMessage/delta", params: { delta: "hel" } }),
      );

      await new Promise((r) => setTimeout(r, 50));

      const createdEvents = (eventRepo.create as ReturnType<typeof vi.fn>).mock.calls
        .map(([event]) => event);
      const deltaEvent = createdEvents.find(
        (event) => event.type === "item/agentMessage/delta",
      );
      expect(deltaEvent).toEqual({
        threadId: "t-new",
        seq: expect.any(Number),
        type: "item/agentMessage/delta",
        data: expect.objectContaining({
          __bb_provider_event: expect.objectContaining({
            providerId: "codex",
            method: "item/agentMessage/delta",
          }),
          payload: { delta: "hel" },
        }),
      });
      expect(ws.broadcast).not.toHaveBeenCalled();
    });

    it("broadcasts thread changes for item completion notifications", async () => {
      const project = { id: "proj-1", name: "Test", rootPath: "/test", createdAt: 1000, updatedAt: 1000 };
      (projectRepo.getById as ReturnType<typeof vi.fn>).mockReturnValue(project);

      const createdThread = makeThread({ id: "t-new", status: "idle" });
      (threadRepo.create as ReturnType<typeof vi.fn>).mockReturnValue(createdThread);
      (threadRepo.getById as ReturnType<typeof vi.fn>).mockReturnValue(
        makeThread({ id: "t-new", status: "active" }),
      );

      await manager.spawn({ projectId: "proj-1" });
      (ws.broadcast as ReturnType<typeof vi.fn>).mockClear();

      fakeChild._pushStdout(
        JSON.stringify({ method: "item/completed", params: { item: { type: "agentMessage", text: "done" } } }),
      );

      await new Promise((r) => setTimeout(r, 50));

      expect(ws.broadcast).toHaveBeenCalledWith("thread", "t-new", ["events-appended"]);
    });

    it("marks thread idle when turn/completed is received", async () => {
      const project = { id: "proj-1", name: "Test", rootPath: "/test", createdAt: 1000, updatedAt: 1000 };
      (projectRepo.getById as ReturnType<typeof vi.fn>).mockReturnValue(project);

      const createdThread = makeThread({ id: "t-new", status: "idle" });
      (threadRepo.create as ReturnType<typeof vi.fn>).mockReturnValue(createdThread);
      (threadRepo.getById as ReturnType<typeof vi.fn>).mockReturnValue(
        makeThread({ id: "t-new", status: "active" }),
      );

      await manager.spawn({ projectId: "proj-1" });
      (threadRepo.update as ReturnType<typeof vi.fn>).mockClear();

      fakeChild._pushStdout(JSON.stringify({ method: "turn/completed", params: {} }));

      await new Promise((r) => setTimeout(r, 50));

      expect(threadRepo.update).toHaveBeenCalledWith("t-new", { status: "idle" });
    });

    it("marks thread active when turn/started is received", async () => {
      const project = { id: "proj-1", name: "Test", rootPath: "/test", createdAt: 1000, updatedAt: 1000 };
      (projectRepo.getById as ReturnType<typeof vi.fn>).mockReturnValue(project);

      const createdThread = makeThread({ id: "t-new", status: "idle" });
      (threadRepo.create as ReturnType<typeof vi.fn>).mockReturnValue(createdThread);
      (threadRepo.getById as ReturnType<typeof vi.fn>).mockReturnValue(
        makeThread({ id: "t-new", status: "idle" }),
      );

      await manager.spawn({ projectId: "proj-1" });
      (threadRepo.update as ReturnType<typeof vi.fn>).mockClear();

      fakeChild._pushStdout(JSON.stringify({ method: "turn/started", params: {} }));

      await new Promise((r) => setTimeout(r, 50));

      expect(threadRepo.update).toHaveBeenCalledWith("t-new", { status: "active" });
    });

    it("tracks active turn IDs from turn lifecycle events", async () => {
      const project = { id: "proj-1", name: "Test", rootPath: "/test", createdAt: 1000, updatedAt: 1000 };
      (projectRepo.getById as ReturnType<typeof vi.fn>).mockReturnValue(project);

      const createdThread = makeThread({ id: "t-new", status: "idle" });
      (threadRepo.create as ReturnType<typeof vi.fn>).mockReturnValue(createdThread);
      (threadRepo.getById as ReturnType<typeof vi.fn>).mockReturnValue(
        makeThread({ id: "t-new", status: "active" }),
      );

      await manager.spawn({ projectId: "proj-1" });

      fakeChild._pushStdout(
        JSON.stringify({ method: "turn/started", params: { turnId: "turn-77" } }),
      );
      await new Promise((r) => setTimeout(r, 50));

      expect(asOrchestratorHarness(manager).activeTurnIds.get("t-new")).toBe("turn-77");

      fakeChild._pushStdout(
        JSON.stringify({ method: "turn/completed", params: { turnId: "turn-77" } }),
      );
      await new Promise((r) => setTimeout(r, 50));

      expect(asOrchestratorHarness(manager).activeTurnIds.has("t-new")).toBe(false);
    });

    it("notifies parent thread when a child turn completes", async () => {
      const project = { id: "proj-1", name: "Test", rootPath: "/test", createdAt: 1000, updatedAt: 1000 };
      const childThread = makeThread({
        id: "t-child",
        status: "active",
        parentThreadId: "parent-1",
      });
      const parentThread = makeThread({
        id: "parent-1",
        status: "idle",
      });
      (projectRepo.getById as ReturnType<typeof vi.fn>).mockReturnValue(project);
      (threadRepo.create as ReturnType<typeof vi.fn>).mockReturnValue(childThread);
      (threadRepo.getById as ReturnType<typeof vi.fn>).mockImplementation(
        (id: string) => {
          if (id === "t-child") return childThread;
          if (id === "parent-1") return parentThread;
          return undefined;
        },
      );

      const parentStdinData: string[] = [];
      const parentProcess = {
        kill: vi.fn(),
        stdin: new Writable({
          write(chunk: Buffer, _enc: string, cb: () => void) {
            parentStdinData.push(chunk.toString());
            cb();
          },
        }),
        stdout: null,
        stderr: null,
      };
      asOrchestratorHarness(manager).processes.set("parent-1", parentProcess);
      asOrchestratorHarness(manager).providerThreadIds.set("parent-1", "codex-parent-thread");

      await manager.spawn({ projectId: "proj-1", parentThreadId: "parent-1" });

      fakeChild._pushStdout(
        JSON.stringify({
          method: "turn/completed",
          params: { turnId: "turn-child-1" },
        }),
      );
      await new Promise((r) => setTimeout(r, 50));

      expect(parentStdinData.length).toBe(1);
      const notifyMsg = JSON.parse(parentStdinData[0].trim());
      expect(notifyMsg.method).toBe("turn/start");
      expect(notifyMsg.params.threadId).toBe("codex-parent-thread");
      expect(notifyMsg.params.input).toEqual([
        {
          type: "text",
          text: expect.stringContaining("[bb system] Thread"),
        },
      ]);
      expect(notifyMsg.params.input[0].text).toContain("t-child");
    });

    it("dedupes parent notifications when duplicate completion events share the same turnId", async () => {
      const project = { id: "proj-1", name: "Test", rootPath: "/test", createdAt: 1000, updatedAt: 1000 };
      const childThread = makeThread({
        id: "t-child",
        status: "active",
        parentThreadId: "parent-1",
      });
      const parentThread = makeThread({
        id: "parent-1",
        status: "idle",
      });
      (projectRepo.getById as ReturnType<typeof vi.fn>).mockReturnValue(project);
      (threadRepo.create as ReturnType<typeof vi.fn>).mockReturnValue(childThread);
      (threadRepo.getById as ReturnType<typeof vi.fn>).mockImplementation(
        (id: string) => {
          if (id === "t-child") return childThread;
          if (id === "parent-1") return parentThread;
          return undefined;
        },
      );

      const parentStdinData: string[] = [];
      const parentProcess = {
        kill: vi.fn(),
        stdin: new Writable({
          write(chunk: Buffer, _enc: string, cb: () => void) {
            parentStdinData.push(chunk.toString());
            cb();
          },
        }),
        stdout: null,
        stderr: null,
      };
      asOrchestratorHarness(manager).processes.set("parent-1", parentProcess);
      asOrchestratorHarness(manager).providerThreadIds.set("parent-1", "codex-parent-thread");

      await manager.spawn({ projectId: "proj-1", parentThreadId: "parent-1" });

      fakeChild._pushStdout(
        JSON.stringify({
          method: "turn/completed",
          params: { turnId: "turn-child-1" },
        }),
      );
      fakeChild._pushStdout(
        JSON.stringify({
          method: "turn/end",
          params: { turnId: "turn-child-1" },
        }),
      );
      await new Promise((r) => setTimeout(r, 50));

      expect(parentStdinData.length).toBe(1);
    });

    it("dedupes no-turn-id completion events within the same lifecycle epoch", async () => {
      const project = {
        id: "proj-1",
        name: "Test",
        rootPath: "/test",
        createdAt: 1000,
        updatedAt: 1000,
      };
      const childThread = makeThread({
        id: "t-child",
        status: "active",
        parentThreadId: "parent-1",
      });
      const parentThread = makeThread({
        id: "parent-1",
        status: "idle",
      });
      (projectRepo.getById as ReturnType<typeof vi.fn>).mockReturnValue(project);
      (threadRepo.create as ReturnType<typeof vi.fn>).mockReturnValue(childThread);
      (threadRepo.getById as ReturnType<typeof vi.fn>).mockImplementation(
        (id: string) => {
          if (id === "t-child") return childThread;
          if (id === "parent-1") return parentThread;
          return undefined;
        },
      );

      const parentStdinData: string[] = [];
      const parentProcess = {
        kill: vi.fn(),
        stdin: new Writable({
          write(chunk: Buffer, _enc: string, cb: () => void) {
            parentStdinData.push(chunk.toString());
            cb();
          },
        }),
        stdout: null,
        stderr: null,
      };
      asOrchestratorHarness(manager).processes.set("parent-1", parentProcess);
      asOrchestratorHarness(manager).providerThreadIds.set("parent-1", "codex-parent-thread");

      await manager.spawn({ projectId: "proj-1", parentThreadId: "parent-1" });

      fakeChild._pushStdout(
        JSON.stringify({
          method: "turn/started",
          params: {},
        }),
      );
      fakeChild._pushStdout(
        JSON.stringify({
          method: "turn/completed",
          params: {},
        }),
      );
      fakeChild._pushStdout(
        JSON.stringify({
          method: "turn/end",
          params: {},
        }),
      );
      fakeChild._pushStdout(
        JSON.stringify({
          method: "turn/started",
          params: {},
        }),
      );
      fakeChild._pushStdout(
        JSON.stringify({
          method: "turn/completed",
          params: {},
        }),
      );
      await new Promise((r) => setTimeout(r, 50));

      expect(parentStdinData.length).toBe(2);
    });

    it("does not notify parent thread when parent project differs from child project", async () => {
      const project = {
        id: "proj-1",
        name: "Test",
        rootPath: "/test",
        createdAt: 1000,
        updatedAt: 1000,
      };
      const childThread = makeThread({
        id: "t-child",
        status: "active",
        projectId: "proj-1",
        parentThreadId: "parent-1",
      });
      const parentThread = makeThread({
        id: "parent-1",
        status: "idle",
        projectId: "proj-2",
      });
      (projectRepo.getById as ReturnType<typeof vi.fn>).mockReturnValue(project);
      (threadRepo.create as ReturnType<typeof vi.fn>).mockReturnValue(childThread);
      (threadRepo.getById as ReturnType<typeof vi.fn>).mockImplementation(
        (id: string) => {
          if (id === "t-child") return childThread;
          if (id === "parent-1") return parentThread;
          return undefined;
        },
      );

      const parentStdinData: string[] = [];
      const parentProcess = {
        kill: vi.fn(),
        stdin: new Writable({
          write(chunk: Buffer, _enc: string, cb: () => void) {
            parentStdinData.push(chunk.toString());
            cb();
          },
        }),
        stdout: null,
        stderr: null,
      };
      asOrchestratorHarness(manager).processes.set("parent-1", parentProcess);
      asOrchestratorHarness(manager).providerThreadIds.set("parent-1", "codex-parent-thread");

      await manager.spawn({ projectId: "proj-1", parentThreadId: "parent-1" });

      fakeChild._pushStdout(
        JSON.stringify({
          method: "turn/completed",
          params: { turnId: "turn-child-1" },
        }),
      );
      await new Promise((r) => setTimeout(r, 50));

      expect(parentStdinData.length).toBe(0);
    });

    it("does not notify parent thread for non-completion lifecycle events", async () => {
      const project = { id: "proj-1", name: "Test", rootPath: "/test", createdAt: 1000, updatedAt: 1000 };
      const childThread = makeThread({
        id: "t-child",
        status: "active",
        parentThreadId: "parent-1",
      });
      const parentThread = makeThread({
        id: "parent-1",
        status: "idle",
      });
      (projectRepo.getById as ReturnType<typeof vi.fn>).mockReturnValue(project);
      (threadRepo.create as ReturnType<typeof vi.fn>).mockReturnValue(childThread);
      (threadRepo.getById as ReturnType<typeof vi.fn>).mockImplementation(
        (id: string) => {
          if (id === "t-child") return childThread;
          if (id === "parent-1") return parentThread;
          return undefined;
        },
      );

      const parentStdinData: string[] = [];
      const parentProcess = {
        kill: vi.fn(),
        stdin: new Writable({
          write(chunk: Buffer, _enc: string, cb: () => void) {
            parentStdinData.push(chunk.toString());
            cb();
          },
        }),
        stdout: null,
        stderr: null,
      };
      asOrchestratorHarness(manager).processes.set("parent-1", parentProcess);
      asOrchestratorHarness(manager).providerThreadIds.set("parent-1", "codex-parent-thread");

      await manager.spawn({ projectId: "proj-1", parentThreadId: "parent-1" });

      fakeChild._pushStdout(
        JSON.stringify({
          method: "turn/started",
          params: { turnId: "turn-child-1" },
        }),
      );
      await new Promise((r) => setTimeout(r, 50));

      expect(parentStdinData.length).toBe(0);
    });

    it("sets title from thread/started preview when thread title is missing", async () => {
      const project = { id: "proj-1", name: "Test", rootPath: "/test", createdAt: 1000, updatedAt: 1000 };
      (projectRepo.getById as ReturnType<typeof vi.fn>).mockReturnValue(project);

      const createdThread = makeThread({ id: "t-new", status: "idle" });
      const persistedThread = makeThread({ id: "t-new", status: "active" });
      (threadRepo.create as ReturnType<typeof vi.fn>).mockReturnValue(createdThread);
      (threadRepo.getById as ReturnType<typeof vi.fn>).mockImplementation(() => persistedThread);
      (threadRepo.update as ReturnType<typeof vi.fn>).mockImplementation(
        (_threadId: string, updates: { status?: Thread["status"]; title?: string }) => {
          if (updates.status !== undefined) persistedThread.status = updates.status;
          if (updates.title !== undefined) persistedThread.title = updates.title;
          return persistedThread;
        },
      );

      await manager.spawn({ projectId: "proj-1" });
      (threadRepo.update as ReturnType<typeof vi.fn>).mockClear();

      fakeChild._pushStdout(
        JSON.stringify({
          method: "thread/started",
          params: {
            thread: {
              id: CODEX_THREAD_ID,
              preview: "Draft migration checklist",
            },
          },
        }),
      );

      await new Promise((r) => setTimeout(r, 50));

      expect(threadRepo.update).toHaveBeenCalledWith("t-new", {
        title: "Draft migration checklist",
      });
    });

    it("sets title from thread/name/updated when title is not locked", async () => {
      const project = { id: "proj-1", name: "Test", rootPath: "/test", createdAt: 1000, updatedAt: 1000 };
      (projectRepo.getById as ReturnType<typeof vi.fn>).mockReturnValue(project);

      const createdThread = makeThread({ id: "t-new", status: "idle" });
      const persistedThread = makeThread({ id: "t-new", status: "active" });
      (threadRepo.create as ReturnType<typeof vi.fn>).mockReturnValue(createdThread);
      (threadRepo.getById as ReturnType<typeof vi.fn>).mockImplementation(() => persistedThread);
      (threadRepo.update as ReturnType<typeof vi.fn>).mockImplementation(
        (_threadId: string, updates: { status?: Thread["status"]; title?: string }) => {
          if (updates.status !== undefined) persistedThread.status = updates.status;
          if (updates.title !== undefined) persistedThread.title = updates.title;
          return persistedThread;
        },
      );

      await manager.spawn({ projectId: "proj-1" });
      (threadRepo.update as ReturnType<typeof vi.fn>).mockClear();

      fakeChild._pushStdout(
        JSON.stringify({
          method: "thread/name/updated",
          params: {
            threadId: CODEX_THREAD_ID,
            threadName: "Server-assigned title",
          },
        }),
      );

      await new Promise((r) => setTimeout(r, 50));

      expect(threadRepo.update).toHaveBeenCalledWith("t-new", {
        title: "Server-assigned title",
      });
      expect(eventRepo.create).toHaveBeenCalledWith(
        expect.objectContaining({
          threadId: "t-new",
          type: "system/thread-title/updated",
          data: expect.objectContaining({
            title: "Server-assigned title",
            source: "provider",
            providerMethod: "thread/name/updated",
          }),
        }),
      );
    });

    it("does not overwrite explicit spawn title from thread/name/updated", async () => {
      const project = { id: "proj-1", name: "Test", rootPath: "/test", createdAt: 1000, updatedAt: 1000 };
      (projectRepo.getById as ReturnType<typeof vi.fn>).mockReturnValue(project);

      const createdThread = makeThread({
        id: "t-new",
        status: "idle",
        title: "Pinned custom title",
      });
      const persistedThread = makeThread({
        id: "t-new",
        status: "active",
        title: "Pinned custom title",
      });
      (threadRepo.create as ReturnType<typeof vi.fn>).mockReturnValue(createdThread);
      (threadRepo.getById as ReturnType<typeof vi.fn>).mockImplementation(() => persistedThread);
      (threadRepo.update as ReturnType<typeof vi.fn>).mockImplementation(
        (_threadId: string, updates: { status?: Thread["status"]; title?: string }) => {
          if (updates.status !== undefined) persistedThread.status = updates.status;
          if (updates.title !== undefined) persistedThread.title = updates.title;
          return persistedThread;
        },
      );

      await manager.spawn({
        projectId: "proj-1",
        title: "Pinned custom title",
      });
      (threadRepo.update as ReturnType<typeof vi.fn>).mockClear();

      fakeChild._pushStdout(
        JSON.stringify({
          method: "thread/name/updated",
          params: {
            threadId: CODEX_THREAD_ID,
            threadName: "Server-assigned title",
          },
        }),
      );

      await new Promise((r) => setTimeout(r, 50));

      expect(threadRepo.update).not.toHaveBeenCalledWith("t-new", {
        title: "Server-assigned title",
      });
    });

    it("does not rename when thread already has an explicit spawn title", async () => {
      const project = { id: "proj-1", name: "Test", rootPath: "/test", createdAt: 1000, updatedAt: 1000 };
      (projectRepo.getById as ReturnType<typeof vi.fn>).mockReturnValue(project);

      const createdThread = makeThread({
        id: "t-new",
        status: "idle",
        title: "Fix flaky login redirect",
      });
      const persistedThread = makeThread({
        id: "t-new",
        status: "active",
        title: "Fix flaky login redirect",
      });
      (threadRepo.create as ReturnType<typeof vi.fn>).mockReturnValue(createdThread);
      (threadRepo.getById as ReturnType<typeof vi.fn>).mockImplementation(() => persistedThread);
      (threadRepo.update as ReturnType<typeof vi.fn>).mockImplementation(
        (_threadId: string, updates: { status?: Thread["status"]; title?: string }) => {
          if (updates.status !== undefined) persistedThread.status = updates.status;
          if (updates.title !== undefined) persistedThread.title = updates.title;
          return persistedThread;
        },
      );

      await manager.spawn({
        projectId: "proj-1",
        title: "Fix flaky login redirect",
        input: [{ type: "text", text: "Fix flaky login redirect" }],
      });
      (threadRepo.update as ReturnType<typeof vi.fn>).mockClear();

      fakeChild._pushStdout(
        JSON.stringify({
          method: "thread/name/updated",
          params: {
            threadId: CODEX_THREAD_ID,
            threadName: "Server refined title",
          },
        }),
      );

      await new Promise((r) => setTimeout(r, 50));

      expect(threadRepo.update).not.toHaveBeenCalledWith("t-new", {
        title: "Server refined title",
      });
      expect(persistedThread.title).toBe("Fix flaky login redirect");
    });

    it("only applies provider thread/name/updated once when a title is missing", async () => {
      const project = { id: "proj-1", name: "Test", rootPath: "/test", createdAt: 1000, updatedAt: 1000 };
      (projectRepo.getById as ReturnType<typeof vi.fn>).mockReturnValue(project);

      const createdThread = makeThread({ id: "t-new", status: "idle" });
      const persistedThread = makeThread({ id: "t-new", status: "active" });
      (threadRepo.create as ReturnType<typeof vi.fn>).mockReturnValue(createdThread);
      (threadRepo.getById as ReturnType<typeof vi.fn>).mockImplementation(() => persistedThread);
      (threadRepo.update as ReturnType<typeof vi.fn>).mockImplementation(
        (_threadId: string, updates: { status?: Thread["status"]; title?: string }) => {
          if (updates.status !== undefined) persistedThread.status = updates.status;
          if (updates.title !== undefined) persistedThread.title = updates.title;
          return persistedThread;
        },
      );

      await manager.spawn({ projectId: "proj-1" });
      (threadRepo.update as ReturnType<typeof vi.fn>).mockClear();

      fakeChild._pushStdout(
        JSON.stringify({
          method: "thread/name/updated",
          params: {
            threadId: CODEX_THREAD_ID,
            threadName: "First server title",
          },
        }),
      );
      await new Promise((r) => setTimeout(r, 20));

      fakeChild._pushStdout(
        JSON.stringify({
          method: "thread/name/updated",
          params: {
            threadId: CODEX_THREAD_ID,
            threadName: "Second server title",
          },
        }),
      );
      await new Promise((r) => setTimeout(r, 20));

      expect(threadRepo.update).toHaveBeenCalledWith("t-new", {
        title: "First server title",
      });
      expect(threadRepo.update).not.toHaveBeenCalledWith("t-new", {
        title: "Second server title",
      });
      expect(persistedThread.title).toBe("First server title");
    });

    it("ignores blank lines on stdout", async () => {
      const project = { id: "proj-1", name: "Test", rootPath: "/test", createdAt: 1000, updatedAt: 1000 };
      (projectRepo.getById as ReturnType<typeof vi.fn>).mockReturnValue(project);

      const createdThread = makeThread({ id: "t-new", status: "idle" });
      (threadRepo.create as ReturnType<typeof vi.fn>).mockReturnValue(createdThread);
      (threadRepo.getById as ReturnType<typeof vi.fn>).mockReturnValue(
        makeThread({ id: "t-new", status: "active" }),
      );

      await manager.spawn({ projectId: "proj-1" });

      // Push blank/whitespace lines
      fakeChild._pushStdout("");
      fakeChild._pushStdout("   ");
      // Push one valid message
      fakeChild._pushStdout(JSON.stringify({ method: "turn/start", params: {} }));

      await new Promise((r) => setTimeout(r, 50));

      // Provisioning started/completed + outbound thread/start + valid notification
      expect(eventRepo.create).toHaveBeenCalledTimes(4);
    });

    it("ignores non-JSON stdout output", async () => {
      const project = { id: "proj-1", name: "Test", rootPath: "/test", createdAt: 1000, updatedAt: 1000 };
      (projectRepo.getById as ReturnType<typeof vi.fn>).mockReturnValue(project);

      const createdThread = makeThread({ id: "t-new", status: "idle" });
      (threadRepo.create as ReturnType<typeof vi.fn>).mockReturnValue(createdThread);
      (threadRepo.getById as ReturnType<typeof vi.fn>).mockReturnValue(
        makeThread({ id: "t-new", status: "active" }),
      );

      await manager.spawn({ projectId: "proj-1" });

      // Push debug output that isn't JSON
      fakeChild._pushStdout("DEBUG: some internal message");
      fakeChild._pushStdout("Error: something happened");

      await new Promise((r) => setTimeout(r, 50));

      expect(eventRepo.create).toHaveBeenCalledTimes(3);
      expect(eventRepo.create).toHaveBeenCalledWith(
        expect.objectContaining({
          threadId: "t-new",
          type: "client/thread/start",
        }),
      );
    });

    it("ignores JSON without method field (non-notification)", async () => {
      const project = { id: "proj-1", name: "Test", rootPath: "/test", createdAt: 1000, updatedAt: 1000 };
      (projectRepo.getById as ReturnType<typeof vi.fn>).mockReturnValue(project);

      const createdThread = makeThread({ id: "t-new", status: "idle" });
      (threadRepo.create as ReturnType<typeof vi.fn>).mockReturnValue(createdThread);
      (threadRepo.getById as ReturnType<typeof vi.fn>).mockReturnValue(
        makeThread({ id: "t-new", status: "active" }),
      );

      await manager.spawn({ projectId: "proj-1" });

      // Push JSON-RPC responses (have result but no method)
      fakeChild._pushStdout(JSON.stringify({ jsonrpc: "2.0", id: 1, result: {} }));

      await new Promise((r) => setTimeout(r, 50));

      expect(eventRepo.create).toHaveBeenCalledTimes(3);
      expect(eventRepo.create).toHaveBeenCalledWith(
        expect.objectContaining({
          threadId: "t-new",
          type: "client/thread/start",
        }),
      );
    });

    it("uses empty object as data when notification has no params", async () => {
      const project = { id: "proj-1", name: "Test", rootPath: "/test", createdAt: 1000, updatedAt: 1000 };
      (projectRepo.getById as ReturnType<typeof vi.fn>).mockReturnValue(project);

      const createdThread = makeThread({ id: "t-new", status: "idle" });
      (threadRepo.create as ReturnType<typeof vi.fn>).mockReturnValue(createdThread);
      (threadRepo.getById as ReturnType<typeof vi.fn>).mockReturnValue(
        makeThread({ id: "t-new", status: "active" }),
      );

      await manager.spawn({ projectId: "proj-1" });

      fakeChild._pushStdout(JSON.stringify({ method: "turn/end" }));

      await new Promise((r) => setTimeout(r, 50));

      const createdEvents = (eventRepo.create as ReturnType<typeof vi.fn>).mock.calls
        .map(([event]) => event);
      const turnEndEvent = createdEvents.find((event) => event.type === "turn/end");
      expect(turnEndEvent).toEqual({
        threadId: "t-new",
        seq: expect.any(Number),
        type: "turn/end",
        data: expect.objectContaining({
          __bb_provider_event: expect.objectContaining({
            providerId: "codex",
            method: "turn/end",
          }),
          payload: {},
        }),
      });
    });

    it("handles process exit events correctly", async () => {
      const project = { id: "proj-1", name: "Test", rootPath: "/test", createdAt: 1000, updatedAt: 1000 };
      (projectRepo.getById as ReturnType<typeof vi.fn>).mockReturnValue(project);

      const createdThread = makeThread({ id: "t-new", status: "idle" });
      (threadRepo.create as ReturnType<typeof vi.fn>).mockReturnValue(createdThread);
      (threadRepo.getById as ReturnType<typeof vi.fn>).mockReturnValue(
        makeThread({ id: "t-new", status: "active" }),
      );

      await manager.spawn({ projectId: "proj-1" });
      await vi.waitFor(() => {
        expect(manager.isActive("t-new")).toBe(true);
      });

      // Simulate process exiting with code 0
      fakeChild._emitExit(0, null);

      expect(manager.isActive("t-new")).toBe(false);
      expect(threadRepo.update).toHaveBeenCalledWith("t-new", { status: "idle" });
    });

    it("handles process error events", async () => {
      const project = { id: "proj-1", name: "Test", rootPath: "/test", createdAt: 1000, updatedAt: 1000 };
      (projectRepo.getById as ReturnType<typeof vi.fn>).mockReturnValue(project);

      const createdThread = makeThread({ id: "t-new", status: "idle" });
      (threadRepo.create as ReturnType<typeof vi.fn>).mockReturnValue(createdThread);
      (threadRepo.getById as ReturnType<typeof vi.fn>).mockReturnValue(
        makeThread({ id: "t-new", status: "active" }),
      );

      // Suppress console.error for this test
      const consoleSpy = vi.spyOn(console, "error").mockImplementation(() => {});

      await manager.spawn({ projectId: "proj-1" });
      await vi.waitFor(() => {
        expect(manager.isActive("t-new")).toBe(true);
      });

      // Simulate process error
      fakeChild.emit("error", new Error("Process crashed"));

      expect(manager.isActive("t-new")).toBe(false);
      // Error handler calls _handleProcessExit(id, 1, null) which should set idle
      expect(threadRepo.update).toHaveBeenCalledWith("t-new", { status: "idle" });

      consoleSpy.mockRestore();
    });

    it("increments RPC IDs across multiple spawns", async () => {
      const project = { id: "proj-1", name: "Test", rootPath: "/test", createdAt: 1000, updatedAt: 1000 };
      (projectRepo.getById as ReturnType<typeof vi.fn>).mockReturnValue(project);

      // First spawn with input: initialize(1) + thread/start(2) + turn/start(3)
      const thread1 = makeThread({ id: "t-1", status: "idle" });
      (threadRepo.create as ReturnType<typeof vi.fn>).mockReturnValueOnce(thread1);
      (threadRepo.getById as ReturnType<typeof vi.fn>).mockReturnValue(
        makeThread({ id: "t-1", status: "active" }),
      );

      const child1 = createFakeChildProcess();
      (spawnMock as ReturnType<typeof vi.fn>).mockReturnValueOnce(child1);

      await manager.spawn({
        projectId: "proj-1",
        input: [{ type: "text", text: "First" }],
      });
      await vi.waitFor(() => {
        const hasTurnStart = child1._stdinData
          .map((entry) => JSON.parse(entry.trim()) as { method?: string })
          .some((entry) => entry.method === "turn/start");
        expect(hasTurnStart).toBe(true);
      });

      // initialize gets id=1, thread/start gets id=2, turn/start gets id=3
      const initMsg = JSON.parse(child1._stdinData[0].trim());
      const startMsg = JSON.parse(child1._stdinData[1].trim());
      const turnMsg = JSON.parse(child1._stdinData[2].trim());
      expect(initMsg.id).toBe(1);
      expect(startMsg.id).toBe(2);
      expect(turnMsg.id).toBe(3);

      // Second spawn: initialize(4) + thread/start(5)
      const thread2 = makeThread({ id: "t-2", status: "idle" });
      (threadRepo.create as ReturnType<typeof vi.fn>).mockReturnValueOnce(thread2);

      const child2 = createFakeChildProcess();
      (spawnMock as ReturnType<typeof vi.fn>).mockReturnValueOnce(child2);

      await manager.spawn({ projectId: "proj-1" });
      await vi.waitFor(() => {
        expect(child2._stdinData.length).toBeGreaterThanOrEqual(2);
      });

      // initialize gets id=4, thread/start gets id=5
      const initMsg2 = JSON.parse(child2._stdinData[0].trim());
      const startMsg2 = JSON.parse(child2._stdinData[1].trim());
      expect(initMsg2.id).toBe(4);
      expect(startMsg2.id).toBe(5);
    });
  });

  describe("tell()", () => {
    it("throws if thread not found", async () => {
      (threadRepo.getById as ReturnType<typeof vi.fn>).mockReturnValue(
        undefined,
      );

      await expect(
        manager.tell("nonexistent", { input: [{ type: "text", text: "hello" }] }),
      ).rejects.toThrow(
        "Thread nonexistent not found",
      );
    });

    it("reprovisions and accepts tell when thread is provisioning_failed", async () => {
      const input = [{ type: "text" as const, text: "Retry after fixing project path" }];
      (threadRepo.getById as ReturnType<typeof vi.fn>).mockReturnValue(
        makeThread({ status: "provisioning_failed" }),
      );
      const scheduleProvisioningSpy = vi
        .spyOn(asOrchestratorHarness(manager), "_scheduleProvisioning")
        .mockImplementation(() => {});

      await expect(manager.tell("thread-1", { input })).resolves.toBeUndefined();

      expect(scheduleProvisioningSpy).toHaveBeenCalledWith(
        "thread-1",
        expect.objectContaining({
          projectId: "proj-1",
          input,
        }),
        { reason: "tell-after-provisioning-failure" },
      );
    });

    it("falls back to reprovision when thread/resume fails with missing rollout", async () => {
      const input = [{ type: "text" as const, text: "Retry after resume miss" }];
      (threadRepo.getById as ReturnType<typeof vi.fn>).mockReturnValue(
        makeThread({ status: "idle" }),
      );
      (projectRepo.getById as ReturnType<typeof vi.fn>).mockReturnValue({
        id: "proj-1",
        name: "Test",
        rootPath: "/test",
        createdAt: 1000,
        updatedAt: 1000,
      });
      (eventRepo).getLatestProviderThreadId = vi
        .fn()
        .mockReturnValue("stale-rollout-1");

      const resumeChild = createFakeChildProcess({ autoRespond: false });
      resumeChild.stdin = new Writable({
        write(chunk: Buffer, _encoding: string, callback: () => void) {
          const data = chunk.toString();
          resumeChild._stdinData.push(data);
          try {
            const msg = JSON.parse(data.trim());
            if (respondToEnvironmentAgentControlMessage(resumeChild, msg)) {
              callback();
              return;
            }
            if (msg.method === "thread/resume" && msg.id) {
              process.nextTick(() => {
                resumeChild.stdout!.push(
                  JSON.stringify({
                    id: msg.id,
                    error: {
                      code: -32602,
                      message: "no rollout found for thread id stale-rollout-1",
                    },
                  }) + "\n",
                );
              });
            }
          } catch {}
          callback();
        },
      });

      const reprovisionChild = createFakeChildProcess();
      (spawnMock as ReturnType<typeof vi.fn>)
        .mockReturnValueOnce(resumeChild)
        .mockReturnValueOnce(reprovisionChild);

      await expect(manager.tell("thread-1", { input })).resolves.toBeUndefined();

      const resumeMethods = resumeChild._stdinData.map((line) => {
        try {
          return JSON.parse(line.trim()).method as string;
        } catch {
          return "";
        }
      });
      expect(resumeMethods).toContain("thread/resume");

      const reprovisionMethods = reprovisionChild._stdinData.map((line) => {
        try {
          return JSON.parse(line.trim()).method as string;
        } catch {
          return "";
        }
      });
      expect(reprovisionMethods).toContain("thread/start");
      expect(reprovisionMethods).toContain("turn/start");
      expect(eventRepo.create).toHaveBeenCalledWith(
        expect.objectContaining({
          threadId: "thread-1",
          type: "system/provisioning/started",
          data: expect.objectContaining({
            reason: "resume-missing-provider-thread",
          }),
        }),
      );
    });

    it("steers into the active turn after replaying buffered resume events", async () => {
      const input = [{ type: "text" as const, text: "Continue the in-flight turn" }];
      const thread = makeThread({
        id: "thread-1",
        projectId: "proj-1",
        status: "idle",
        environmentAgentCursor: 0,
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
      (projectRepo.getById as ReturnType<typeof vi.fn>).mockReturnValue({
        id: "proj-1",
        name: "Test",
        rootPath: "/test",
        createdAt: 1000,
        updatedAt: 1000,
      });
      (eventRepo).getLatestProviderThreadId = vi
        .fn()
        .mockReturnValue("persisted-thread-1");

      const resumeChild = createFakeChildProcess({ autoRespond: false });
      resumeChild.stdin = new Writable({
        write(chunk: Buffer, _encoding: string, callback: () => void) {
          const data = chunk.toString();
          resumeChild._stdinData.push(data);
          try {
            const msg = JSON.parse(data.trim());
            if (respondToEnvironmentAgentControlMessage(resumeChild, msg)) {
              callback();
              return;
            }
            if (msg.method === "thread/resume" && msg.id) {
              process.nextTick(() => {
                resumeChild.stdout!.push(
                  JSON.stringify({
                    id: msg.id,
                    result: {
                      thread: { id: "persisted-thread-1" },
                      model: "test-model",
                    },
                  }) + "\n",
                );
              });
            }
          } catch {}
          callback();
        },
      });

      (spawnMock as ReturnType<typeof vi.fn>).mockReturnValueOnce(resumeChild);

      const replaySpy = vi
        .spyOn(
          (manager as unknown as { agentServer: { replayEnvironmentAgentEvents: (args: unknown) => Promise<unknown> } }).agentServer,
          "replayEnvironmentAgentEvents",
        )
        .mockResolvedValue({
          fromSequenceExclusive: 0,
          toSequenceInclusive: 3,
          hasMore: false,
          events: [
            {
              protocolVersion: ENVIRONMENT_AGENT_PROTOCOL_VERSION,
              sequence: 3,
              emittedAt: 1_003,
              threadId: "thread-1",
              event: {
                type: "provider.event",
                threadId: "thread-1",
                method: "turn/started",
                payload: { turnId: "turn-buffered" },
              },
            },
          ],
        });

      await expect(manager.tell("thread-1", { input })).resolves.toBeUndefined();

      expect(replaySpy).toHaveBeenCalledWith({
        threadId: "thread-1",
        afterSequence: 0,
      });
      const sentMethods = resumeChild._stdinData.map((line) => {
        try {
          return JSON.parse(line.trim()).method as string;
        } catch {
          return "";
        }
      });
      expect(sentMethods).toContain("thread/resume");
      expect(sentMethods).toContain("turn/steer");
      expect(sentMethods).not.toContain("turn/start");
      expect(thread.environmentAgentCursor).toBe(3);
    });

    it("records provisioning completion when resumed threads need fresh env setup", async () => {
      const workspaceRoot = mkdtempSync(join(tmpdir(), "beanbag-resume-env-setup-"));
      writeFileSync(join(workspaceRoot, ".bb-env-setup.sh"), "#!/bin/sh\nexit 0\n", "utf8");
      try {
        const info: SystemEnvironmentInfo = {
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
        };
        const customEnvironmentRegistry = new EnvironmentRegistry().register({
          kind: "worktree",
          info,
          create(): IEnvironment {
            return makeRuntimeEnvironment({
              kind: "worktree",
              rootPath: workspaceRoot,
              overrides: {
                info,
                exists() {
                  return false;
                },
                shouldRunSetupScript() {
                  return true;
                },
                runAsync: vi.fn().mockResolvedValue({
                  exitCode: 0,
                  stdout: "",
                  stderr: "",
                }),
                run: vi.fn().mockReturnValue({
                  exitCode: 0,
                  stdout: "",
                  stderr: "",
                }),
              },
            });
          },
          restore(_state: unknown): IEnvironment {
            return this.create({
              projectId: "proj-1",
              threadId: "thread-1",
              projectRootPath: "/test",
              runtimeEnv: {},
            });
          },
          isState(_value: unknown): _value is unknown {
            return true;
          },
        });
        manager = new Orchestrator(
          threadRepo,
          eventRepo,
          projectRepo,
          ws,
          llmCompletionService,
          createCodexProviderAdapter(),
          createTestRuntimeEnv(),
          customEnvironmentRegistry,
        );
        const input = [{ type: "text" as const, text: "Resume and continue" }];
        (threadRepo.getById as ReturnType<typeof vi.fn>).mockReturnValue(
          makeThread({
            id: "thread-1",
            projectId: "proj-1",
            status: "idle",
            environmentId: "worktree",
            environmentRecord: {
              kind: "worktree",
              state: {
                workspaceRoot,
                branchName: "bb/thread-1",
              },
            },
          }),
        );
        (projectRepo.getById as ReturnType<typeof vi.fn>).mockReturnValue({
          id: "proj-1",
          name: "Test",
          rootPath: "/test",
          createdAt: 1000,
          updatedAt: 1000,
        });
        (eventRepo).getLatestProviderThreadId = vi.fn().mockReturnValue("persisted-thread-1");
        (eventRepo.getLatestSeq as ReturnType<typeof vi.fn>).mockReturnValue(0);
        (eventRepo.create as ReturnType<typeof vi.fn>).mockImplementation((event) =>
          makeEvent({
            threadId: event.threadId,
            seq: event.seq,
            type: event.type as string,
            data: event.data,
          }),
        );

        const resumeChild = createFakeChildProcess({ autoRespond: false });
        resumeChild.stdin = new Writable({
          write(chunk: Buffer, _encoding: string, callback: () => void) {
            const data = chunk.toString();
            try {
              const msg = JSON.parse(data.trim());
              if (msg.environmentAgentMessage === true && msg.requestId) {
                if (msg.type === "replay") {
                  process.nextTick(() => {
                    resumeChild.stdout!.push(
                      JSON.stringify({
                        environmentAgentMessage: true,
                        requestId: msg.requestId,
                        type: "replay.response",
                        payload: {
                          protocolVersion: 1,
                          fromSequenceExclusive: msg.payload?.afterSequence ?? 0,
                          toSequenceInclusive: msg.payload?.afterSequence ?? 0,
                          events: [],
                          hasMore: false,
                        },
                      }) + "\n",
                    );
                  });
                } else if (respondToEnvironmentAgentControlMessage(resumeChild, msg)) {
                  callback();
                  return;
                }
                callback();
                return;
              }

              resumeChild._stdinData.push(data);
              if (msg.method === "thread/resume" && msg.id) {
                process.nextTick(() => {
                  resumeChild.stdout!.push(
                    JSON.stringify({
                      id: msg.id,
                      result: {
                        thread: { id: "persisted-thread-1" },
                        model: "test-model",
                      },
                    }) + "\n",
                  );
                });
              }
            } catch {
              resumeChild._stdinData.push(data);
            }
            callback();
          },
        });
        (spawnMock as ReturnType<typeof vi.fn>).mockReturnValue(resumeChild);

        await expect(manager.tell("thread-1", { input })).resolves.toBeUndefined();

        expect(eventRepo.create).toHaveBeenCalledWith(
          expect.objectContaining({
            threadId: "thread-1",
            type: "system/provisioning/completed",
            data: expect.objectContaining({
              environmentId: "worktree",
            }),
          }),
        );
      } finally {
        rmSync(workspaceRoot, { recursive: true, force: true });
      }
    });

    it("throws if thread has no active process", async () => {
      (threadRepo.getById as ReturnType<typeof vi.fn>).mockReturnValue(
        makeThread(),
      );
      // processes map is empty by default, so no active process

      await expect(
        manager.tell("thread-1", { input: [{ type: "text", text: "hello" }] }),
      ).rejects.toThrow(
        "Thread thread-1 has no codex session",
      );
    });

    it("throws if thread has no codex session", async () => {
      (threadRepo.getById as ReturnType<typeof vi.fn>).mockReturnValue(
        makeThread(),
      );

      // Register a process but no codex thread ID
      const fakeProcess = { kill: vi.fn(), stdin: null, stdout: null, stderr: null };
      asOrchestratorHarness(manager).processes.set("thread-1", fakeProcess);

      await expect(
        manager.tell("thread-1", { input: [{ type: "text", text: "hello" }] }),
      ).rejects.toThrow(
        "Thread thread-1 has no codex session",
      );
    });

    it("sends turn/start JSON-RPC when thread has an active process and codex session", async () => {
      (threadRepo.getById as ReturnType<typeof vi.fn>).mockReturnValue(
        makeThread(),
      );

      // Manually register a fake process and codex thread ID
      const fakeStdinData: string[] = [];
      const fakeProcess = {
        kill: vi.fn(),
        stdin: new Writable({
          write(chunk: Buffer, _enc: string, cb: () => void) {
            fakeStdinData.push(chunk.toString());
            cb();
          },
        }),
        stdout: null,
        stderr: null,
      };
      asOrchestratorHarness(manager).processes.set("thread-1", fakeProcess);
      asOrchestratorHarness(manager).providerThreadIds.set("thread-1", "codex-tid-123");

      await manager.tell("thread-1", { input: [{ type: "text", text: "Do more work" }] });

      expect(fakeStdinData.length).toBe(1);
      const msg = JSON.parse(fakeStdinData[0].trim());
      expect(msg.jsonrpc).toBe("2.0");
      expect(msg.method).toBe("turn/start");
      expect(msg.params.threadId).toBe("codex-tid-123");
      expect(msg.params.input).toEqual([{ type: "text", text: "Do more work" }]);
      expect(msg.params.sandboxPolicy).toEqual({ type: "dangerFullAccess" });
    });

    it("sends turn/steer JSON-RPC when mode=steer and an active turn exists", async () => {
      (threadRepo.getById as ReturnType<typeof vi.fn>).mockReturnValue(
        makeThread(),
      );

      const fakeStdinData: string[] = [];
      const fakeProcess = {
        kill: vi.fn(),
        stdin: new Writable({
          write(chunk: Buffer, _enc: string, cb: () => void) {
            fakeStdinData.push(chunk.toString());
            cb();
          },
        }),
        stdout: null,
        stderr: null,
      };
      asOrchestratorHarness(manager).processes.set("thread-1", fakeProcess);
      asOrchestratorHarness(manager).providerThreadIds.set("thread-1", "codex-tid-123");
      asOrchestratorHarness(manager).activeTurnIds.set("thread-1", "turn-123");

      await manager.tell("thread-1", {
        input: [{ type: "text", text: "Keep going" }],
        mode: "steer",
      });

      expect(fakeStdinData.length).toBe(1);
      const msg = JSON.parse(fakeStdinData[0].trim());
      expect(msg.method).toBe("turn/steer");
      expect(msg.params).toEqual({
        threadId: "codex-tid-123",
        expectedTurnId: "turn-123",
        input: [{ type: "text", text: "Keep going" }],
      });
    });

    it("auto mode uses turn/steer when an active turn is known", async () => {
      (threadRepo.getById as ReturnType<typeof vi.fn>).mockReturnValue(
        makeThread(),
      );

      const fakeStdinData: string[] = [];
      const fakeProcess = {
        kill: vi.fn(),
        stdin: new Writable({
          write(chunk: Buffer, _enc: string, cb: () => void) {
            fakeStdinData.push(chunk.toString());
            cb();
          },
        }),
        stdout: null,
        stderr: null,
      };
      asOrchestratorHarness(manager).processes.set("thread-1", fakeProcess);
      asOrchestratorHarness(manager).providerThreadIds.set("thread-1", "codex-tid-123");
      asOrchestratorHarness(manager).activeTurnIds.set("thread-1", "turn-123");

      await manager.tell("thread-1", {
        input: [{ type: "text", text: "Keep going" }],
      });

      expect(fakeStdinData.length).toBe(1);
      const msg = JSON.parse(fakeStdinData[0].trim());
      expect(msg.method).toBe("turn/steer");
    });

    it("auto mode falls back to turn/start when persisted thread status is idle", async () => {
      (threadRepo.getById as ReturnType<typeof vi.fn>).mockReturnValue(
        makeThread({ status: "idle" }),
      );
      (eventRepo).getLatestTurnLifecycle = vi.fn(() => ({
        turnId: "turn-stale",
        normType: "turn/started",
      }));

      const fakeStdinData: string[] = [];
      const fakeProcess = {
        kill: vi.fn(),
        stdin: new Writable({
          write(chunk: Buffer, _enc: string, cb: () => void) {
            fakeStdinData.push(chunk.toString());
            cb();
          },
        }),
        stdout: null,
        stderr: null,
      };
      asOrchestratorHarness(manager).processes.set("thread-1", fakeProcess);
      asOrchestratorHarness(manager).providerThreadIds.set("thread-1", "codex-tid-123");

      await manager.tell("thread-1", {
        input: [{ type: "text", text: "Keep going" }],
      });

      expect(fakeStdinData.length).toBe(1);
      const msg = JSON.parse(fakeStdinData[0].trim());
      expect(msg.method).toBe("turn/start");
    });

    it("auto mode falls back to turn/start when sandbox override is provided", async () => {
      (threadRepo.getById as ReturnType<typeof vi.fn>).mockReturnValue(
        makeThread(),
      );

      const fakeStdinData: string[] = [];
      const fakeProcess = {
        kill: vi.fn(),
        stdin: new Writable({
          write(chunk: Buffer, _enc: string, cb: () => void) {
            fakeStdinData.push(chunk.toString());
            cb();
          },
        }),
        stdout: null,
        stderr: null,
      };
      asOrchestratorHarness(manager).processes.set("thread-1", fakeProcess);
      asOrchestratorHarness(manager).providerThreadIds.set("thread-1", "codex-tid-123");
      asOrchestratorHarness(manager).activeTurnIds.set("thread-1", "turn-123");

      await manager.tell(
        "thread-1",
        {
          input: [{ type: "text", text: "Keep going" }],
        },
        {
          sandboxMode: "read-only",
        },
      );

      expect(fakeStdinData.length).toBe(1);
      const msg = JSON.parse(fakeStdinData[0].trim());
      expect(msg.method).toBe("turn/start");
      expect(msg.params.sandboxPolicy).toEqual({ type: "readOnly" });
    });

    it("throws when mode=steer but no active turn exists", async () => {
      (threadRepo.getById as ReturnType<typeof vi.fn>).mockReturnValue(
        makeThread(),
      );

      const fakeProcess = {
        kill: vi.fn(),
        stdin: new Writable({
          write(_chunk: Buffer, _enc: string, cb: () => void) {
            cb();
          },
        }),
        stdout: null,
        stderr: null,
      };
      asOrchestratorHarness(manager).processes.set("thread-1", fakeProcess);
      asOrchestratorHarness(manager).providerThreadIds.set("thread-1", "codex-tid-123");

      await expect(
        manager.tell("thread-1", {
          input: [{ type: "text", text: "Keep going" }],
          mode: "steer",
        }),
      ).rejects.toThrow("Thread thread-1 has no active turn to steer");
    });

    it("throws when mode=steer is used with model/reasoning overrides", async () => {
      (threadRepo.getById as ReturnType<typeof vi.fn>).mockReturnValue(
        makeThread(),
      );

      const fakeProcess = {
        kill: vi.fn(),
        stdin: new Writable({
          write(_chunk: Buffer, _enc: string, cb: () => void) {
            cb();
          },
        }),
        stdout: null,
        stderr: null,
      };
      asOrchestratorHarness(manager).processes.set("thread-1", fakeProcess);
      asOrchestratorHarness(manager).providerThreadIds.set("thread-1", "codex-tid-123");
      asOrchestratorHarness(manager).activeTurnIds.set("thread-1", "turn-123");

      await expect(
        manager.tell(
          "thread-1",
          {
            input: [{ type: "text", text: "Keep going" }],
            mode: "steer",
          },
          {
            model: "gpt-5-codex",
          },
        ),
      ).rejects.toThrow(
        "Tell mode 'steer' does not support model, speed, or reasoning overrides",
      );
    });

    it("sends turn/start with multimodal input payload", async () => {
      (threadRepo.getById as ReturnType<typeof vi.fn>).mockReturnValue(
        makeThread(),
      );

      const fakeStdinData: string[] = [];
      const fakeProcess = {
        kill: vi.fn(),
        stdin: new Writable({
          write(chunk: Buffer, _enc: string, cb: () => void) {
            fakeStdinData.push(chunk.toString());
            cb();
          },
        }),
        stdout: null,
        stderr: null,
      };
      asOrchestratorHarness(manager).processes.set("thread-1", fakeProcess);
      asOrchestratorHarness(manager).providerThreadIds.set("thread-1", "codex-tid-123");

      await manager.tell("thread-1", {
        input: [
          { type: "text", text: "Analyze these images." },
          { type: "image", url: "https://example.com/mock.png" },
          { type: "localImage", path: "/tmp/mock.png" },
        ],
      });

      expect(fakeStdinData.length).toBe(1);
      const msg = JSON.parse(fakeStdinData[0].trim());
      expect(msg.params.input).toEqual([
        { type: "text", text: "Analyze these images." },
        { type: "image", url: "https://example.com/mock.png" },
        { type: "localImage", path: "/tmp/mock.png" },
      ]);
      expect(msg.params.sandboxPolicy).toEqual({ type: "dangerFullAccess" });
    });

    it("throws for empty tell payload object", async () => {
      await expect(manager.tell("thread-1", { input: [] })).rejects.toThrow(
        "Tell payload input must be non-empty",
      );
    });

    it("marks an idle thread as active before turn/start", async () => {
      (threadRepo.getById as ReturnType<typeof vi.fn>).mockReturnValue(
        makeThread({ status: "idle" }),
      );

      const fakeStdinData: string[] = [];
      const fakeProcess = {
        kill: vi.fn(),
        stdin: new Writable({
          write(chunk: Buffer, _enc: string, cb: () => void) {
            fakeStdinData.push(chunk.toString());
            cb();
          },
        }),
        stdout: null,
        stderr: null,
      };
      asOrchestratorHarness(manager).processes.set("thread-1", fakeProcess);
      asOrchestratorHarness(manager).providerThreadIds.set("thread-1", "codex-tid-123");

      await manager.tell("thread-1", { input: [{ type: "text", text: "Continue" }] });

      expect(fakeStdinData.length).toBe(1);
      expect(threadRepo.update).toHaveBeenCalledWith("thread-1", { status: "active" });
      expect(ws.broadcast).toHaveBeenCalledWith("thread", "thread-1", ["status-changed", "work-status-changed"]);
    });

    it("does not derive thread titles from tell input", async () => {
      (threadRepo.getById as ReturnType<typeof vi.fn>).mockReturnValue(
        makeThread({ status: "idle" }),
      );

      const fakeStdinData: string[] = [];
      const fakeProcess = {
        kill: vi.fn(),
        stdin: new Writable({
          write(chunk: Buffer, _enc: string, cb: () => void) {
            fakeStdinData.push(chunk.toString());
            cb();
          },
        }),
        stdout: null,
        stderr: null,
      };
      asOrchestratorHarness(manager).processes.set("thread-1", fakeProcess);
      asOrchestratorHarness(manager).providerThreadIds.set("thread-1", "codex-tid-123");

      await manager.tell("thread-1", {
        input: [{ type: "text", text: "New candidate title text" }],
      });

      expect(threadRepo.update).not.toHaveBeenCalledWith(
        "thread-1",
        expect.objectContaining({
          title: expect.any(String),
        }),
      );
      expect(threadRepo.update).toHaveBeenCalledWith("thread-1", {
        status: "active",
      });
      expect(fakeStdinData.length).toBe(1);
    });

    it("includes model and reasoning config when tell() options are provided", async () => {
      (threadRepo.getById as ReturnType<typeof vi.fn>).mockReturnValue(
        makeThread(),
      );

      const fakeStdinData: string[] = [];
      const fakeProcess = {
        kill: vi.fn(),
        stdin: new Writable({
          write(chunk: Buffer, _enc: string, cb: () => void) {
            fakeStdinData.push(chunk.toString());
            cb();
          },
        }),
        stdout: null,
        stderr: null,
      };
      asOrchestratorHarness(manager).processes.set("thread-1", fakeProcess);
      asOrchestratorHarness(manager).providerThreadIds.set("thread-1", "codex-tid-123");

      await manager.tell(
        "thread-1",
        { input: [{ type: "text", text: "Do more work" }] },
        {
        model: "gpt-5-codex",
        reasoningLevel: "medium",
        },
      );

      expect(fakeStdinData.length).toBe(1);
      const msg = JSON.parse(fakeStdinData[0].trim());
      expect(msg.params.model).toBe("gpt-5-codex");
      expect(msg.params.config).toEqual({
        model_reasoning_effort: "medium",
      });
      expect(msg.params.sandboxPolicy).toEqual({ type: "dangerFullAccess" });
    });

    it("persists outbound tell events with initiator=user metadata", async () => {
      (threadRepo.getById as ReturnType<typeof vi.fn>).mockReturnValue(
        makeThread(),
      );

      const fakeStdinData: string[] = [];
      const fakeProcess = {
        kill: vi.fn(),
        stdin: new Writable({
          write(chunk: Buffer, _enc: string, cb: () => void) {
            fakeStdinData.push(chunk.toString());
            cb();
          },
        }),
        stdout: null,
        stderr: null,
      };
      asOrchestratorHarness(manager).processes.set("thread-1", fakeProcess);
      asOrchestratorHarness(manager).providerThreadIds.set("thread-1", "codex-tid-123");
      (eventRepo.create as ReturnType<typeof vi.fn>).mockClear();

      await manager.tell(
        "thread-1",
        { input: [{ type: "text", text: "Continue" }] },
        undefined,
        { initiator: "user" },
      );

      expect(fakeStdinData.length).toBe(1);
      expect(eventRepo.create).toHaveBeenCalledWith(
        expect.objectContaining({
          threadId: "thread-1",
          type: "client/turn/start",
          data: expect.objectContaining({
            direction: "outbound",
            source: "tell",
            initiator: "user",
          }),
        }),
      );
    });

    it("persists outbound systemTell events with initiator=system metadata", async () => {
      (threadRepo.getById as ReturnType<typeof vi.fn>).mockReturnValue(
        makeThread(),
      );

      const fakeStdinData: string[] = [];
      const fakeProcess = {
        kill: vi.fn(),
        stdin: new Writable({
          write(chunk: Buffer, _enc: string, cb: () => void) {
            fakeStdinData.push(chunk.toString());
            cb();
          },
        }),
        stdout: null,
        stderr: null,
      };
      asOrchestratorHarness(manager).processes.set("thread-1", fakeProcess);
      asOrchestratorHarness(manager).providerThreadIds.set("thread-1", "codex-tid-123");
      (eventRepo.create as ReturnType<typeof vi.fn>).mockClear();

      await manager.systemTell("thread-1", {
        input: [{ type: "text", text: "Internal notification" }],
      });

      expect(fakeStdinData.length).toBe(1);
      expect(eventRepo.create).toHaveBeenCalledWith(
        expect.objectContaining({
          threadId: "thread-1",
          type: "client/turn/start",
          data: expect.objectContaining({
            direction: "outbound",
            source: "tell",
            initiator: "system",
          }),
        }),
      );
    });

  });

  describe("stop()", () => {
    it("updates status to idle and broadcasts when no active process", () => {
      manager.stop("thread-1");

      expect(threadRepo.update).toHaveBeenCalledWith("thread-1", {
        status: "idle",
      });
      expect(ws.broadcast).toHaveBeenCalledWith("thread", "thread-1", [
        "status-changed",
        "work-status-changed",
      ]);
    });

    it("kills the process with SIGTERM when an active process exists", () => {
      const fakeProcess = { stdin: null, stdout: null };
      asOrchestratorHarness(manager).processes.set("thread-1", fakeProcess);

      manager.stop("thread-1");

      expect(threadRepo.update).toHaveBeenCalledWith("thread-1", {
        status: "idle",
      });
    });

    it("does not destroy workspace environment on stop", () => {
      const cleanup = vi.fn();
      asOrchestratorHarness(manager).environmentRuntimes.set("thread-1", {
        adapter: {
          info: {
            id: "worktree",
            displayName: "Git Worktree Workspace",
            description: "",
          },
          prepare: vi.fn(),
        },
        session: { cwd: "/tmp/worktree", cleanup },
      });

      manager.stop("thread-1");

      expect(cleanup).not.toHaveBeenCalled();
    });
  });

  describe("archive()", () => {
    it("marks a thread archived and broadcasts when no active process", () => {
      (threadRepo.getById as ReturnType<typeof vi.fn>).mockReturnValue(
        makeThread({ id: "thread-1", status: "idle" }),
      );

      manager.archive("thread-1");

      expect(threadRepo.update).toHaveBeenCalledWith("thread-1", {
        status: "idle",
        archivedAt: expect.any(Number),
      });
      expect(ws.broadcast).toHaveBeenCalledWith("thread", "thread-1", [
        "status-changed",
        "work-status-changed",
        "archived-changed",
      ]);
    });

    it("kills running process and clears runtime state when archiving", () => {
      const fakeProcess = { stdin: null, stdout: null };
      (threadRepo.getById as ReturnType<typeof vi.fn>).mockReturnValue(
        makeThread({ id: "thread-1", status: "active" }),
      );
      asOrchestratorHarness(manager).processes.set("thread-1", fakeProcess);
      asOrchestratorHarness(manager).providerThreadIds.set("thread-1", "provider-thread-1");
      asOrchestratorHarness(manager).activeTurnIds.set("thread-1", "turn-1");

      manager.archive("thread-1");

      expect(asOrchestratorHarness(manager).processes.has("thread-1")).toBe(false);
      expect(asOrchestratorHarness(manager).providerThreadIds.has("thread-1")).toBe(false);
      expect(asOrchestratorHarness(manager).activeTurnIds.has("thread-1")).toBe(false);
      expect(threadRepo.update).toHaveBeenCalledWith("thread-1", {
        status: "idle",
        archivedAt: expect.any(Number),
      });
    });

    it("destroys workspace environment on archive", () => {
      const cleanup = vi.fn();
      (threadRepo.getById as ReturnType<typeof vi.fn>).mockReturnValue(
        makeThread({ id: "thread-1", status: "idle" }),
      );
      asOrchestratorHarness(manager).environmentRuntimes.set("thread-1", {
        environment: makeRuntimeEnvironment({
          rootPath: "/tmp/worktree",
          dispose: cleanup,
        }),
      });

      manager.archive("thread-1");

      expect(cleanup).toHaveBeenCalledTimes(1);
    });

    it("does not attempt legacy worktree cleanup when archive has no environment record", () => {
      const projectRoot = "/tmp/proj-1";
      const workspaceRoot = "/tmp/worktrees/proj-1/thread-1";
      (threadRepo.getById as ReturnType<typeof vi.fn>).mockReturnValue(
        makeThread({
          id: "thread-1",
          status: "idle",
          environmentId: "worktree",
        }),
      );
      (projectRepo.getById as ReturnType<typeof vi.fn>).mockReturnValue({
        id: "proj-1",
        name: "Project",
        rootPath: projectRoot,
        createdAt: 1000,
        updatedAt: 1000,
      });
      (eventRepo.getLatestByType as ReturnType<typeof vi.fn>).mockImplementation(
        (_threadId: string, type: string) =>
          type === "system/provisioning/completed"
            ? makeEvent({
                type: "system/provisioning/completed",
                data: {},
              })
            : undefined,
      );
      manager.archive("thread-1");
    });

    it("rebroadcasts work status after async workspace cleanup settles", async () => {
      let resolveCleanup: (() => void) | undefined;
      const cleanup = vi.fn(
        () =>
          new Promise<void>((resolve) => {
            resolveCleanup = resolve;
          }),
      );
      (threadRepo.getById as ReturnType<typeof vi.fn>).mockReturnValue(
        makeThread({ id: "thread-1", status: "idle", environmentId: "worktree" }),
      );
      asOrchestratorHarness(manager).environmentRuntimes.set("thread-1", {
        environment: makeRuntimeEnvironment({
          rootPath: "/tmp/worktree",
          dispose: cleanup,
        }),
      });

      manager.archive("thread-1");

      expect(resolveCleanup).toBeTypeOf("function");
      expect(ws.broadcast).toHaveBeenCalledWith("thread", "thread-1", [
        "status-changed",
        "work-status-changed",
        "archived-changed",
      ]);

      resolveCleanup?.();
      await new Promise<void>((resolve) => setImmediate(resolve));

      expect(ws.broadcast).toHaveBeenCalledWith("thread", "thread-1", [
        "work-status-changed",
      ]);
      expect((ws.broadcast as ReturnType<typeof vi.fn>).mock.calls.at(-1)).toEqual([
        "thread",
        "thread-1",
        ["work-status-changed"],
      ]);
    });
  });

  describe("unarchive()", () => {
    it("clears archived timestamp and broadcasts", () => {
      (threadRepo.getById as ReturnType<typeof vi.fn>).mockReturnValue(
        makeThread({ id: "thread-1", status: "idle", archivedAt: 1234 }),
      );

      manager.unarchive("thread-1");

      expect(threadRepo.update).toHaveBeenCalledWith("thread-1", {
        archivedAt: null,
      }, {
        touchUpdatedAt: false,
      });
      expect(ws.broadcast).toHaveBeenCalledWith("thread", "thread-1", [
        "archived-changed",
      ]);
    });

    it("does nothing when thread is not archived", () => {
      (threadRepo.getById as ReturnType<typeof vi.fn>).mockReturnValue(
        makeThread({ id: "thread-1", status: "idle", archivedAt: undefined }),
      );

      manager.unarchive("thread-1");

      expect(threadRepo.update).not.toHaveBeenCalled();
      expect(ws.broadcast).not.toHaveBeenCalled();
    });
  });

  describe("tell() archived threads", () => {
    it("rejects tells for archived threads", async () => {
      (threadRepo.getById as ReturnType<typeof vi.fn>).mockReturnValue(
        makeThread({ id: "thread-1", status: "idle", archivedAt: 1234 }),
      );

      await expect(
        manager.tell("thread-1", {
          input: [{ type: "text", text: "hello" }],
        }),
      ).rejects.toThrow("Thread thread-1 is archived");
    });
  });

  describe("getEvents()", () => {
    it("returns raw persisted events", () => {
      const events = [
        makeEvent({ seq: 1, type: "turn/started", data: { turnId: "turn-1" } }),
        makeEvent({ seq: 2, id: "evt-2", type: "turn/completed", data: { turnId: "turn-1" } }),
      ];
      (eventRepo.listByThread as ReturnType<typeof vi.fn>).mockReturnValue(
        events,
      );

      const result = manager.getEvents("thread-1", 0);

      expect(result).toEqual(events);
      expect(eventRepo.listByThread).toHaveBeenCalledWith(
        "thread-1",
        0,
        undefined,
      );
    });

    it("passes undefined afterSeq when not provided", () => {
      (eventRepo.listByThread as ReturnType<typeof vi.fn>).mockReturnValue([]);

      manager.getEvents("thread-1");

      expect(eventRepo.listByThread).toHaveBeenCalledWith(
        "thread-1",
        undefined,
        undefined,
      );
    });
  });

  describe("listModels()", () => {
    it("delegates to the provider adapter", async () => {
      const models = [
        {
          id: "model-a",
          model: "model-a",
          displayName: "Model A",
          description: "",
          supportedReasoningEfforts: [
            { reasoningEffort: "low", description: "Low effort" },
          ],
          defaultReasoningEffort: "low",
          isDefault: true,
        },
      ];

      const providerListModels = vi.fn().mockResolvedValue(models);
      asOrchestratorHarness(manager).provider.listModels = providerListModels;

      await expect(manager.listModels()).resolves.toEqual(models);
      expect(providerListModels).toHaveBeenCalledTimes(1);
    });
  });

  describe("getOutput()", () => {
    it("extracts text from last item/completed agentMessage event", () => {
      const events = [
        makeEvent({ seq: 1, type: "turn/started", data: {} }),
        makeEvent({
          seq: 2,
          type: "item/completed",
          data: { item: { type: "agentMessage", text: "Final output" } },
        }),
      ];
      (eventRepo.listByThread as ReturnType<typeof vi.fn>).mockReturnValue(
        events,
      );

      expect(manager.getOutput("thread-1")).toBe("Final output");
    });

    it("ignores item/completed events that are not agentMessage type", () => {
      const events = [
        makeEvent({
          seq: 1,
          type: "item/completed",
          data: { item: { type: "toolCall", name: "bash" } },
        }),
      ];
      (eventRepo.listByThread as ReturnType<typeof vi.fn>).mockReturnValue(
        events,
      );

      expect(manager.getOutput("thread-1")).toBeUndefined();
    });

    it("returns undefined if no item/completed events", () => {
      const events = [
        makeEvent({ seq: 1, type: "turn/started", data: {} }),
        makeEvent({ seq: 2, type: "turn/completed", data: {} }),
      ];
      (eventRepo.listByThread as ReturnType<typeof vi.fn>).mockReturnValue(
        events,
      );

      expect(manager.getOutput("thread-1")).toBeUndefined();
    });

    it("returns undefined for empty events list", () => {
      (eventRepo.listByThread as ReturnType<typeof vi.fn>).mockReturnValue([]);

      expect(manager.getOutput("thread-1")).toBeUndefined();
    });

    it("returns undefined when item has no text field", () => {
      const events = [
        makeEvent({
          seq: 1,
          type: "item/completed",
          data: { item: { type: "agentMessage" } },
        }),
      ];
      (eventRepo.listByThread as ReturnType<typeof vi.fn>).mockReturnValue(
        events,
      );

      expect(manager.getOutput("thread-1")).toBeUndefined();
    });

    it("returns undefined when item.text is not a string", () => {
      const events = [
        makeEvent({
          seq: 1,
          type: "item/completed",
          data: { item: { type: "agentMessage", text: 42 } },
        }),
      ];
      (eventRepo.listByThread as ReturnType<typeof vi.fn>).mockReturnValue(
        events,
      );

      expect(manager.getOutput("thread-1")).toBeUndefined();
    });

    it("returns text from the LAST agentMessage item/completed event when multiple exist", () => {
      const events = [
        makeEvent({
          seq: 1,
          type: "item/completed",
          data: { item: { type: "agentMessage", text: "First output" } },
        }),
        makeEvent({ seq: 2, type: "turn/started", data: {} }),
        makeEvent({
          seq: 3,
          type: "item/completed",
          data: { item: { type: "agentMessage", text: "Latest output" } },
        }),
      ];
      (eventRepo.listByThread as ReturnType<typeof vi.fn>).mockReturnValue(
        events,
      );

      expect(manager.getOutput("thread-1")).toBe("Latest output");
    });
  });

  describe("getById()", () => {
    it("delegates to threadRepo", () => {
      const thread = makeThread({ status: "idle" });
      (threadRepo.getById as ReturnType<typeof vi.fn>).mockReturnValue(thread);

      expect(manager.getById("thread-1")).toBe(thread);
      expect(threadRepo.getById).toHaveBeenCalledWith("thread-1");
      expect(ws.broadcast).not.toHaveBeenCalled();
    });

    it("returns undefined for nonexistent thread", () => {
      (threadRepo.getById as ReturnType<typeof vi.fn>).mockReturnValue(
        undefined,
      );

      expect(manager.getById("nonexistent")).toBeUndefined();
    });

    it("includes prompt-derived title fallback when persisted title is missing", () => {
      const untitledThread = makeThread({ status: "idle", title: undefined });
      (threadRepo.getById as ReturnType<typeof vi.fn>).mockReturnValue(untitledThread);
      (eventRepo.getLatestByType as ReturnType<typeof vi.fn>).mockReturnValue(
        makeEvent({
          type: "client/thread/start",
          data: {
            input: [{ type: "text", text: "Investigate flaky test reruns" }],
          },
        }),
      );

      const result = manager.getById("thread-1");
      const resultSecondRead = manager.getById("thread-1");

      expect(result?.title).toBeUndefined();
      expect(result?.titleFallback).toBe("Investigate flaky test reruns");
      expect(resultSecondRead?.titleFallback).toBe("Investigate flaky test reruns");
      expect(eventRepo.getLatestByType).toHaveBeenCalledTimes(1);
    });

    it("returns persisted active status even when lifecycle events suggest completion", () => {
      const runningThread = makeThread({ status: "active" });
      (threadRepo.getById as ReturnType<typeof vi.fn>).mockReturnValue(runningThread);
      (eventRepo.listByThread as ReturnType<typeof vi.fn>).mockReturnValue([
        makeEvent({ seq: 1, type: "turn/started", data: {} }),
        makeEvent({ seq: 2, type: "turn/completed", data: {} }),
      ]);
      const result = manager.getById("thread-1");

      expect(threadRepo.update).not.toHaveBeenCalled();
      expect(ws.broadcast).not.toHaveBeenCalled();
      expect(result?.status).toBe("active");
    });

    it("reconciles idle thread to idle when latest turn is started but no process exists", () => {
      const idleThread = makeThread({ status: "idle" });
      (threadRepo.getById as ReturnType<typeof vi.fn>).mockReturnValue(idleThread);
      (eventRepo.listByThread as ReturnType<typeof vi.fn>).mockReturnValue([
        makeEvent({ seq: 1, type: "turn/completed", data: {} }),
        makeEvent({ seq: 2, type: "turn/started", data: {} }),
      ]);
      const result = manager.getById("thread-1");

      expect(threadRepo.update).not.toHaveBeenCalled();
      expect(ws.broadcast).not.toHaveBeenCalled();
      expect(result?.status).toBe("idle");
    });

    it("returns persisted idle status even when process exists and lifecycle events started", () => {
      const idleThread = makeThread({ status: "idle" });
      (threadRepo.getById as ReturnType<typeof vi.fn>).mockReturnValue(idleThread);
      (eventRepo.listByThread as ReturnType<typeof vi.fn>).mockReturnValue([
        makeEvent({ seq: 1, type: "turn/completed", data: {} }),
        makeEvent({ seq: 2, type: "turn/started", data: {} }),
      ]);
      asOrchestratorHarness(manager).processes.set("thread-1", { kill: vi.fn(), stdin: null, stdout: null });

      const result = manager.getById("thread-1");

      expect(threadRepo.update).not.toHaveBeenCalled();
      expect(ws.broadcast).not.toHaveBeenCalled();
      expect(result?.status).toBe("idle");
    });
  });

  describe("getWorkStatus()", () => {
    it("keeps worktree status unknown until provisioning completes", () => {
      const projectRoot = "/tmp/proj-1";
      const envSetupWorkspaceRoot = "/tmp/worktrees/proj-1/thread-1";
      const customEnvironmentRegistry = createTestEnvironmentRegistry({
        rootPath: envSetupWorkspaceRoot,
      });
      const managerWithCustomEnvironment = new Orchestrator(
        threadRepo,
        eventRepo,
        projectRepo,
        ws,
        llmCompletionService,
        createCodexProviderAdapter(),
        createTestRuntimeEnv(),
        customEnvironmentRegistry,
      );
      const thread = makeThread({
        id: "thread-1",
        projectId: "proj-1",
        status: "provisioning_failed",
        environmentId: "worktree",
        title: "Provisioning failure repro",
      });
      const mockedStatus = makeWorkspaceStatus();
      (threadRepo.getById as ReturnType<typeof vi.fn>).mockReturnValue(thread);
      (projectRepo.getById as ReturnType<typeof vi.fn>).mockReturnValue({
        id: "proj-1",
        name: "Project",
        rootPath: projectRoot,
        createdAt: 1000,
        updatedAt: 1000,
      });
      (eventRepo.getLatestByType as ReturnType<typeof vi.fn>).mockReturnValue(undefined);

      const result = managerWithCustomEnvironment.getWorkStatus("thread-1");

      expect(result).toBeUndefined();

      (threadRepo.getById as ReturnType<typeof vi.fn>).mockReturnValue({
        ...thread,
        environmentRecord: {
          kind: "worktree",
          state: {
            workspaceRoot: envSetupWorkspaceRoot,
            branchName: "bb/thread-1",
          },
        },
      });
      const resolvedResult = managerWithCustomEnvironment.getWorkStatus("thread-1");
      expect(resolvedResult).toStrictEqual(mockedStatus);
    });

    it("returns deleted while workspace cleanup is in progress", () => {
      let resolveCleanup: (() => void) | undefined;
      const projectRoot = "/tmp/proj-1";
      const workspaceRoot = "/tmp/worktrees/proj-1/thread-1";
      mkdirSync(workspaceRoot, { recursive: true });
      const thread = makeThread({
        id: "thread-1",
        projectId: "proj-1",
        status: "idle",
        environmentId: "worktree",
        environmentRecord: {
          kind: "worktree",
          state: {
            workspaceRoot,
            branchName: "bb/thread-1",
          },
        },
      });
      (threadRepo.getById as ReturnType<typeof vi.fn>).mockReturnValue(thread);
      (projectRepo.getById as ReturnType<typeof vi.fn>).mockReturnValue({
        id: "proj-1",
        name: "Project",
        rootPath: projectRoot,
        createdAt: 1000,
        updatedAt: 1000,
      });
      (eventRepo.getLatestByType as ReturnType<typeof vi.fn>).mockImplementation(
        (_threadId: string, type: string) =>
          type === "system/provisioning/completed"
            ? makeEvent({
                type: "system/provisioning/completed",
                data: {},
              })
            : undefined,
      );
      asOrchestratorHarness(manager).environmentRuntimes.set("thread-1", {
        environment: {
          kind: "worktree",
          info: {
            id: "worktree",
            displayName: "Git Worktree Workspace",
            description: "",
          },
          serialize() {
            return {
              workspaceRoot,
              branchName: "bb/thread-1",
            };
          },
          dispose: () =>
            new Promise<void>((resolve) => {
              resolveCleanup = resolve;
            }),
          exists() {
            return true;
          },
          supportsHostFilesystemAccess() {
            return true;
          },
          isIsolatedWorkspace() {
            return true;
          },
          getCheckoutSnapshot() {
            return {
              branch: "bb/thread-1",
              head: "abc123",
              detached: false,
            };
          },
          getWorkspaceRootUnsafe() {
            return workspaceRoot;
          },
          getWorkspaceStatus() {
            return makeWorkspaceStatus();
          },
          watchWorkspaceStatus() {
            return () => {};
          },
          async commitWorkspace() {
            return {
              ok: true,
              commitCreated: false,
              message: "Working directory is clean",
              workStatus: makeWorkspaceStatus(),
            };
          },
          listWorkspaceCommitsSinceRef() {
            return [];
          },
          getWorkspaceDiff() {
            return { diff: "", truncated: false };
          },
          shouldRunSetupScript() {
            return false;
          },
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
        },
      });

      manager.archive("thread-1");
      const result = manager.getWorkStatus("thread-1");

      expect(result).toMatchObject({
        state: "deleted",
        changedFiles: 0,
        workspaceChangedFiles: 0,
        hasUncommittedChanges: false,
      });

      resolveCleanup?.();
    });
  });

  describe("getGitDiff()", () => {
    it("suppresses combined diffs for squash-resolved clean worktrees", () => {
      const thread = makeThread({
        id: "thread-1",
        projectId: "proj-1",
        status: "idle",
        environmentId: "worktree",
      });
      const getWorkspaceDiff = vi.fn().mockReturnValue({
        diff: "diff --git a/file b/file",
        truncated: false,
      });
      const environment = makeRuntimeEnvironment({
        rootPath: "/tmp/worktrees/proj-1/thread-1",
        overrides: {
          getWorkspaceStatus() {
            return makeWorkspaceStatus({
              state: "clean",
              changedFiles: 2,
              insertions: 10,
              deletions: 3,
              hasCommittedUnmergedChanges: false,
              hasUncommittedChanges: false,
              aheadCount: 1,
            });
          },
          listWorkspaceCommitsSinceRef() {
            return [
              {
                sha: "abc123",
                shortSha: "abc123",
                subject: "squashed commit",
              },
            ];
          },
          getWorkspaceDiff,
        },
      });

      (threadRepo.getById as ReturnType<typeof vi.fn>).mockReturnValue(thread);
      (projectRepo.getById as ReturnType<typeof vi.fn>).mockReturnValue({
        id: "proj-1",
        name: "Project",
        rootPath: "/tmp/proj-1",
        createdAt: 1000,
        updatedAt: 1000,
      });
      asOrchestratorHarness(manager).environmentRuntimes.set("thread-1", {
        environment,
      });

      const result = manager.getGitDiff("thread-1");

      expect(result).toMatchObject({
        mode: "worktree_commits",
        selection: { type: "combined" },
        diff: "",
        truncated: false,
      });
      expect(getWorkspaceDiff).not.toHaveBeenCalled();
    });

    it("still returns commit diffs for explicit commit selection", () => {
      const thread = makeThread({
        id: "thread-1",
        projectId: "proj-1",
        status: "idle",
        environmentId: "worktree",
      });
      const getWorkspaceDiff = vi.fn().mockReturnValue({
        diff: "diff --git a/file b/file",
        truncated: false,
      });
      const environment = makeRuntimeEnvironment({
        rootPath: "/tmp/worktrees/proj-1/thread-1",
        overrides: {
          getWorkspaceStatus() {
            return makeWorkspaceStatus({
              hasCommittedUnmergedChanges: false,
              hasUncommittedChanges: false,
              aheadCount: 1,
              baseRef: "main",
            });
          },
          listWorkspaceCommitsSinceRef() {
            return [
              {
                sha: "abc123",
                shortSha: "abc123",
                subject: "squashed commit",
              },
            ];
          },
          getWorkspaceDiff,
        },
      });

      (threadRepo.getById as ReturnType<typeof vi.fn>).mockReturnValue(thread);
      (projectRepo.getById as ReturnType<typeof vi.fn>).mockReturnValue({
        id: "proj-1",
        name: "Project",
        rootPath: "/tmp/proj-1",
        createdAt: 1000,
        updatedAt: 1000,
      });
      asOrchestratorHarness(manager).environmentRuntimes.set("thread-1", {
        environment,
      });

      const result = manager.getGitDiff("thread-1", {
        type: "commit",
        sha: "abc123",
      });

      expect(result.diff).toBe("diff --git a/file b/file");
      expect(getWorkspaceDiff).toHaveBeenCalledWith({
        type: "commit",
        commitSha: "abc123",
      });
    });
  });

  describe("list()", () => {
    it("delegates to threadRepo with filters", () => {
      const threads = [makeThread({ status: "idle" })];
      (threadRepo.list as ReturnType<typeof vi.fn>).mockReturnValue(threads);

      const filters = { projectId: "proj-1" };
      const result = manager.list(filters);

      expect(result).toStrictEqual(threads);
      expect(threadRepo.list).toHaveBeenCalledWith(filters);
      expect(ws.broadcast).not.toHaveBeenCalled();
    });

    it("includes prompt-derived title fallback for untitled threads", () => {
      const threads = [makeThread({ id: "thread-1", status: "idle", title: undefined })];
      (threadRepo.list as ReturnType<typeof vi.fn>).mockReturnValue(threads);
      (eventRepo.getLatestByType as ReturnType<typeof vi.fn>).mockImplementation(
        (_threadId: string, type: string) =>
          type === "client/thread/start"
            ? makeEvent({
                type: "client/thread/start",
                data: {
                  input: [{ type: "text", text: "Stabilize flaky auth redirect tests" }],
                },
              })
            : undefined,
      );

      const result = manager.list();
      const secondResult = manager.list();

      expect(result[0]?.title).toBeUndefined();
      expect(result[0]?.titleFallback).toBe("Stabilize flaky auth redirect tests");
      expect(secondResult[0]?.titleFallback).toBe("Stabilize flaky auth redirect tests");
      expect(eventRepo.getLatestByType).toHaveBeenCalledTimes(1);
    });

    it("returns persisted active list status even when lifecycle events suggest completion", () => {
      (threadRepo.list as ReturnType<typeof vi.fn>).mockReturnValue([
        makeThread({ id: "thread-1", status: "active" }),
      ]);
      (eventRepo.listByThread as ReturnType<typeof vi.fn>).mockReturnValue([
        makeEvent({ seq: 1, type: "turn/completed", data: {} }),
      ]);
      const result = manager.list();

      expect(threadRepo.update).not.toHaveBeenCalled();
      expect(ws.broadcast).not.toHaveBeenCalled();
      expect(result[0]?.status).toBe("active");
    });

    it("reconciles idle threads to idle when latest turn is started but no process exists", () => {
      (threadRepo.list as ReturnType<typeof vi.fn>).mockReturnValue([
        makeThread({ id: "thread-1", status: "idle" }),
      ]);
      (eventRepo.listByThread as ReturnType<typeof vi.fn>).mockReturnValue([
        makeEvent({ seq: 1, type: "turn/completed", data: {} }),
        makeEvent({ seq: 2, type: "turn/started", data: {} }),
      ]);
      const result = manager.list();

      expect(threadRepo.update).not.toHaveBeenCalled();
      expect(ws.broadcast).not.toHaveBeenCalled();
      expect(result[0]?.status).toBe("idle");
    });

    it("returns persisted idle list status even when process exists and lifecycle events started", () => {
      (threadRepo.list as ReturnType<typeof vi.fn>).mockReturnValue([
        makeThread({ id: "thread-1", status: "idle" }),
      ]);
      (eventRepo.listByThread as ReturnType<typeof vi.fn>).mockReturnValue([
        makeEvent({ seq: 1, type: "turn/completed", data: {} }),
        makeEvent({ seq: 2, type: "turn/started", data: {} }),
      ]);
      asOrchestratorHarness(manager).processes.set("thread-1", { kill: vi.fn(), stdin: null, stdout: null });

      const result = manager.list();

      expect(threadRepo.update).not.toHaveBeenCalled();
      expect(ws.broadcast).not.toHaveBeenCalled();
      expect(result[0]?.status).toBe("idle");
    });
  });

  describe("primary checkout status reconciliation", () => {
    it("demotes stale primary-checkout state when the project checkout changes externally", () => {
      const thread = makeThread({
        id: "thread-1",
        projectId: "proj-1",
        status: "idle",
        title: "Primary thread",
        environmentId: "worktree",
      });
      (threadRepo.getById as ReturnType<typeof vi.fn>).mockReturnValue(thread);
      const projectRoot = mkdtempSync(join(tmpdir(), "beanbag-orchestrator-"));
      git(projectRoot, "init");
      git(projectRoot, "config", "user.name", "Beanbag Test");
      git(projectRoot, "config", "user.email", "beanbag-test@example.com");
      git(projectRoot, "checkout", "-b", "main");
      writeFileSync(join(projectRoot, "README.md"), "hello\n", "utf8");
      git(projectRoot, "add", "README.md");
      git(projectRoot, "commit", "-m", "initial");
      (projectRepo.getById as ReturnType<typeof vi.fn>).mockReturnValue({
        id: "proj-1",
        name: "Test",
        rootPath: projectRoot,
        createdAt: 1000,
        updatedAt: 1000,
      });
      (eventRepo.getLatestSeq as ReturnType<typeof vi.fn>).mockReturnValue(0);
      (eventRepo.create as ReturnType<typeof vi.fn>).mockReturnValue(
        makeEvent({ seq: 1, type: "system/primary_checkout/updated" }),
      );

      asOrchestratorHarness(manager).primaryPromotionByProjectId.set("proj-1", {
        projectId: "proj-1",
        threadId: "thread-1",
        promotedAt: 1000,
        promotedCheckout: {
          branch: "feature/thread-1",
          head: "abc123",
          detached: false,
        },
        reconstructed: false,
      });
      asOrchestratorHarness(manager).primaryPromotionValidatedAtByProjectId.set("proj-1", 0);

      const result = manager.getById("thread-1");

      expect(result?.primaryCheckout).toBeUndefined();
      expect(asOrchestratorHarness(manager).primaryPromotionByProjectId.get("proj-1")).toBeUndefined();
      expect(eventRepo.create).toHaveBeenCalledWith(
        expect.objectContaining({
          threadId: "thread-1",
          type: "system/primary_checkout/updated",
          data: expect.objectContaining({
            action: "demote",
            status: "completed",
            projectId: "proj-1",
          }),
        }),
      );
      expect(ws.broadcast).toHaveBeenCalledWith("thread", "thread-1", [
        "events-appended",
      ]);
      expect(ws.broadcast).toHaveBeenCalledWith("thread", "thread-1", [
        "status-changed",
        "work-status-changed",
      ]);
    });

    it("validates active primary-checkout status only once per project within a list response", () => {
      (threadRepo.list as ReturnType<typeof vi.fn>).mockReturnValue([
        makeThread({
          id: "thread-1",
          projectId: "proj-1",
          status: "idle",
          title: "Promoted",
          environmentId: "worktree",
        }),
        makeThread({
          id: "thread-2",
          projectId: "proj-1",
          status: "idle",
          title: "Other",
          environmentId: "worktree",
        }),
      ]);
      const projectRoot = mkdtempSync(join(tmpdir(), "beanbag-orchestrator-"));
      git(projectRoot, "init");
      git(projectRoot, "config", "user.name", "Beanbag Test");
      git(projectRoot, "config", "user.email", "beanbag-test@example.com");
      git(projectRoot, "checkout", "-b", "feature/thread-1");
      writeFileSync(join(projectRoot, "README.md"), "hello\n", "utf8");
      git(projectRoot, "add", "README.md");
      git(projectRoot, "commit", "-m", "initial");
      const head = git(projectRoot, "rev-parse", "HEAD");
      (projectRepo.getById as ReturnType<typeof vi.fn>).mockReturnValue({
        id: "proj-1",
        name: "Test",
        rootPath: projectRoot,
        createdAt: 1000,
        updatedAt: 1000,
      });

      asOrchestratorHarness(manager).primaryPromotionByProjectId.set("proj-1", {
        projectId: "proj-1",
        threadId: "thread-1",
        promotedAt: 1000,
        promotedCheckout: {
          branch: "feature/thread-1",
          head,
          detached: false,
        },
        reconstructed: false,
      });
      asOrchestratorHarness(manager).primaryPromotionValidatedAtByProjectId.set("proj-1", 0);

      const result = manager.list({ projectId: "proj-1" });

      expect(result[0]?.primaryCheckout?.isActive).toBe(true);
      expect(result[1]?.primaryCheckout).toBeUndefined();
      expect(ws.broadcast).not.toHaveBeenCalled();
    });

    it("forces freshness validation before promote thread operations", async () => {
      const workspaceRoot = "/tmp/worktrees/proj-1/thread-1";
      const thread = makeThread({
        id: "thread-1",
        projectId: "proj-1",
        status: "idle",
        environmentId: "worktree",
      });
      (threadRepo.getById as ReturnType<typeof vi.fn>).mockReturnValue(thread);
      (projectRepo.getById as ReturnType<typeof vi.fn>).mockReturnValue({
        id: "proj-1",
        name: "Test",
        rootPath: "/tmp/proj-1",
        createdAt: 1000,
        updatedAt: 1000,
      });
      asOrchestratorHarness(manager).environmentRuntimes.set("thread-1", {
        environment: {
          kind: "worktree",
          info: {
            id: "worktree",
            displayName: "Git Worktree Workspace",
            description: "",
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
          getCheckoutSnapshot() {
            return {
              branch: "bb/thread-1",
              head: "abc123",
              detached: false,
            };
          },
          getWorkspaceRootUnsafe() {
            return workspaceRoot;
          },
          getWorkspaceStatus() {
            return makeWorkspaceStatus();
          },
          watchWorkspaceStatus() {
            return () => {};
          },
          async commitWorkspace() {
            return {
              ok: true,
              commitCreated: false,
              message: "Working directory is clean",
              workStatus: makeWorkspaceStatus(),
            };
          },
          listWorkspaceCommitsSinceRef() {
            return [];
          },
          getWorkspaceDiff() {
            return { diff: "", truncated: false };
          },
          shouldRunSetupScript() {
            return false;
          },
          supportsPromoteToActiveWorkspace() {
            return true;
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
        },
      });
      (eventRepo.getLatestSeq as ReturnType<typeof vi.fn>).mockReturnValue(0);
      (eventRepo.create as ReturnType<typeof vi.fn>).mockImplementation((event) =>
        makeEvent({
          threadId: event.threadId,
          seq: event.seq,
          type: event.type as string,
          data: event.data,
        })
      );

      asOrchestratorHarness(manager).primaryPromotionByProjectId.set("proj-1", {
        projectId: "proj-1",
        threadId: "thread-1",
        promotedAt: 1000,
        promotedCheckout: {
          head: "abc123",
          detached: false,
        },
        reconstructed: false,
      });

      const ensurePrimaryStatusSpy = vi
        .spyOn(asOrchestratorHarness(manager), "_ensurePrimaryPromotionStateIsCurrent")
        .mockImplementation(() => {});

      const result = await manager.promoteThread("thread-1");

      expect(ensurePrimaryStatusSpy).toHaveBeenCalledWith("proj-1", { force: true });
      expect(result).toMatchObject({
        ok: true,
        promoted: false,
      });
    });

    it("forces freshness validation before demote primary-checkout operations", async () => {
      const thread = makeThread({
        id: "thread-1",
        projectId: "proj-1",
        status: "idle",
        environmentId: "worktree",
      });
      (threadRepo.getById as ReturnType<typeof vi.fn>).mockReturnValue(thread);
      (projectRepo.getById as ReturnType<typeof vi.fn>).mockReturnValue({
        id: "proj-1",
        name: "Test",
        rootPath: "/tmp/proj-1",
        createdAt: 1000,
        updatedAt: 1000,
      });
      (eventRepo.getLatestSeq as ReturnType<typeof vi.fn>).mockReturnValue(0);
      (eventRepo.create as ReturnType<typeof vi.fn>).mockImplementation((event) =>
        makeEvent({
          threadId: event.threadId,
          seq: event.seq,
          type: event.type as string,
          data: event.data,
        })
      );

      const ensurePrimaryStatusSpy = vi
        .spyOn(asOrchestratorHarness(manager), "_ensurePrimaryPromotionStateIsCurrent")
        .mockImplementation(() => {});

      const result = await manager.demotePrimaryCheckout("thread-1");

      expect(ensurePrimaryStatusSpy).toHaveBeenCalledWith("proj-1", { force: true });
      expect(result).toMatchObject({
        ok: true,
        demoted: false,
      });
    });

    it("switches primary checkout when promoting a different thread", async () => {
      const activeThread = makeThread({
        id: "thread-1",
        projectId: "proj-1",
        status: "idle",
        environmentId: "worktree",
      });
      const targetThread = makeThread({
        id: "thread-2",
        projectId: "proj-1",
        status: "idle",
        environmentId: "worktree",
      });
      (threadRepo.getById as ReturnType<typeof vi.fn>).mockImplementation((id: string) => {
        if (id === "thread-1") return activeThread;
        if (id === "thread-2") return targetThread;
        return undefined;
      });
      (projectRepo.getById as ReturnType<typeof vi.fn>).mockReturnValue({
        id: "proj-1",
        name: "Test",
        rootPath: "/tmp/proj-1",
        createdAt: 1000,
        updatedAt: 1000,
      });
      (eventRepo.getLatestSeq as ReturnType<typeof vi.fn>).mockReturnValue(0);
      (eventRepo.create as ReturnType<typeof vi.fn>).mockImplementation((event) =>
        makeEvent({
          threadId: event.threadId,
          seq: event.seq,
          type: event.type as string,
          data: event.data,
        })
      );
      asOrchestratorHarness(manager).environmentRuntimes.set("thread-2", {
        environment: makeRuntimeEnvironment({
          rootPath: "/tmp/worktrees/proj-1/thread-2",
        }),
      });
      asOrchestratorHarness(manager).primaryPromotionByProjectId.set("proj-1", {
        projectId: "proj-1",
        threadId: "thread-1",
        promotedAt: 1000,
        previousCheckout: {
          branch: "main",
          head: "aaa111",
          detached: false,
        },
        promotedCheckout: {
          branch: "bb/thread-1",
          head: "bbb222",
          detached: false,
        },
        reconstructed: false,
      });

      const environmentService = (
        manager as unknown as {
          environmentService: Pick<
            EnvironmentService,
            "demotePrimaryCheckout" | "promoteThreadEnvironment"
          >;
        }
      ).environmentService;
      const demoteSpy = vi
        .spyOn(environmentService, "demotePrimaryCheckout")
        .mockResolvedValue({
          demoted: true,
          status: { projectId: "proj-1" },
          snapshot: {
            branch: "main",
            head: "aaa111",
            detached: false,
          },
          activeThreadId: "thread-1",
        });
      const promoteSpy = vi
        .spyOn(environmentService, "promoteThreadEnvironment")
        .mockResolvedValue({
          promoted: true,
          status: {
            projectId: "proj-1",
            activeThreadId: "thread-2",
            promotedAt: 1001,
          },
          state: {
            projectId: "proj-1",
            threadId: "thread-2",
            promotedAt: 1001,
            previousCheckout: {
              branch: "main",
              head: "aaa111",
              detached: false,
            },
            promotedCheckout: {
              branch: "bb/thread-2",
              head: "ccc333",
              detached: false,
            },
            reconstructed: false,
          },
        });

      const result = await manager.promoteThread("thread-2");

      expect(demoteSpy).toHaveBeenCalledWith(
        expect.objectContaining({
          thread: activeThread,
        }),
      );
      expect(promoteSpy).toHaveBeenCalledWith(
        expect.objectContaining({
          thread: targetThread,
        }),
      );
      expect(demoteSpy.mock.invocationCallOrder[0]).toBeLessThan(
        promoteSpy.mock.invocationCallOrder[0] ?? Number.POSITIVE_INFINITY,
      );
      expect(result).toMatchObject({
        ok: true,
        promoted: true,
        primaryStatus: {
          projectId: "proj-1",
          activeThreadId: "thread-2",
        },
      });
      expect(eventRepo.create).toHaveBeenCalledWith(
        expect.objectContaining({
          threadId: "thread-1",
          type: "system/primary_checkout/updated",
          data: expect.objectContaining({
            action: "demote",
            status: "started",
            projectId: "proj-1",
          }),
        }),
      );
      expect(eventRepo.create).toHaveBeenCalledWith(
        expect.objectContaining({
          threadId: "thread-1",
          type: "system/primary_checkout/updated",
          data: expect.objectContaining({
            action: "demote",
            status: "completed",
            projectId: "proj-1",
          }),
        }),
      );
      expect(eventRepo.create).toHaveBeenCalledWith(
        expect.objectContaining({
          threadId: "thread-2",
          type: "system/primary_checkout/updated",
          data: expect.objectContaining({
            action: "promote",
            status: "completed",
            projectId: "proj-1",
          }),
        }),
      );
    });

    it("keeps promote action available when another thread is currently promoted", () => {
      const targetThread = makeThread({
        id: "thread-2",
        projectId: "proj-1",
        status: "idle",
        environmentId: "worktree",
      });
      (threadRepo.getById as ReturnType<typeof vi.fn>).mockReturnValue(targetThread);
      (projectRepo.getById as ReturnType<typeof vi.fn>).mockReturnValue({
        id: "proj-1",
        name: "Test",
        rootPath: "/tmp/proj-1",
        createdAt: 1000,
        updatedAt: 1000,
      });
      asOrchestratorHarness(manager).environmentRuntimes.set("thread-2", {
        environment: makeRuntimeEnvironment({
          rootPath: "/tmp/worktrees/proj-1/thread-2",
        }),
      });
      asOrchestratorHarness(manager).primaryPromotionByProjectId.set("proj-1", {
        projectId: "proj-1",
        threadId: "thread-1",
        promotedAt: 1000,
        promotedCheckout: {
          head: "abc123",
          detached: false,
        },
        reconstructed: false,
      });

      const hydrated = manager.getById("thread-2");
      const promoteAction = hydrated?.builtInActions?.find((action) => action.id === "promote");

      expect(promoteAction).toMatchObject({
        id: "promote",
        available: true,
      });
      expect(promoteAction?.disabledReason).toBeUndefined();
    });

    it("rejects promote when another primary-checkout transition is already in flight", async () => {
      const workspaceRoot = "/tmp/worktrees/proj-1/thread-1";
      const thread = makeThread({
        id: "thread-1",
        projectId: "proj-1",
        status: "idle",
        environmentId: "worktree",
      });
      (threadRepo.getById as ReturnType<typeof vi.fn>).mockReturnValue(thread);
      (projectRepo.getById as ReturnType<typeof vi.fn>).mockReturnValue({
        id: "proj-1",
        name: "Test",
        rootPath: "/tmp/proj-1",
        createdAt: 1000,
        updatedAt: 1000,
      });
      asOrchestratorHarness(manager).environmentRuntimes.set("thread-1", {
        environment: {
          kind: "worktree",
          info: {
            id: "worktree",
            displayName: "Git Worktree Workspace",
            description: "",
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
          getCheckoutSnapshot() {
            return {
              branch: "bb/thread-1",
              head: "abc123",
              detached: false,
            };
          },
          getWorkspaceRootUnsafe() {
            return workspaceRoot;
          },
          getWorkspaceStatus() {
            return makeWorkspaceStatus();
          },
          watchWorkspaceStatus() {
            return () => {};
          },
          async commitWorkspace() {
            return {
              ok: true,
              commitCreated: false,
              message: "Working directory is clean",
              workStatus: makeWorkspaceStatus(),
            };
          },
          listWorkspaceCommitsSinceRef() {
            return [];
          },
          getWorkspaceDiff() {
            return { diff: "", truncated: false };
          },
          shouldRunSetupScript() {
            return false;
          },
          supportsPromoteToActiveWorkspace() {
            return true;
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
        },
      });
      asOrchestratorHarness(manager).primaryCheckoutTransitionsInFlight.add("proj-1");

      await expect(manager.promoteThread("thread-1")).rejects.toThrow(
        "Another primary-checkout promotion/demotion operation is already in progress for this project",
      );
    });

    it("rejects demote when another primary-checkout transition is already in flight", async () => {
      const thread = makeThread({
        id: "thread-1",
        projectId: "proj-1",
        status: "idle",
        environmentId: "worktree",
      });
      (threadRepo.getById as ReturnType<typeof vi.fn>).mockReturnValue(thread);
      (projectRepo.getById as ReturnType<typeof vi.fn>).mockReturnValue({
        id: "proj-1",
        name: "Test",
        rootPath: "/tmp/proj-1",
        createdAt: 1000,
        updatedAt: 1000,
      });
      asOrchestratorHarness(manager).primaryCheckoutTransitionsInFlight.add("proj-1");

      await expect(manager.demotePrimaryCheckout("thread-1")).rejects.toThrow(
        "Another primary-checkout promotion/demotion operation is already in progress for this project",
      );
    });

  });

  describe("isActive()", () => {
    it("returns false when no process registered", () => {
      expect(manager.isActive("thread-1")).toBe(false);
    });
  });

  describe("getActiveCount()", () => {
    it("returns 0 when no processes are active", () => {
      expect(manager.getActiveCount()).toBe(0);
    });
  });

  describe("getRunningCount()", () => {
    it("returns active count from persisted DB status", () => {
      (threadRepo.list as ReturnType<typeof vi.fn>).mockReturnValue([
        makeThread({ id: "t-1", status: "active" }),
        makeThread({ id: "t-2", status: "active" }),
      ]);
      asOrchestratorHarness(manager).processes.set("t-1", { kill: vi.fn(), stdin: null, stdout: null });
      asOrchestratorHarness(manager).processes.set("t-2", { kill: vi.fn(), stdin: null, stdout: null });

      expect(manager.getRunningCount()).toBe(2);
      expect(threadRepo.list).toHaveBeenCalledWith({ status: "active" });
    });

    it("treats stale persisted active rows as active until explicitly updated", () => {
      (threadRepo.list as ReturnType<typeof vi.fn>).mockReturnValue([
        makeThread({ id: "t-1", status: "active" }),
      ]);
      (eventRepo.listByThread as ReturnType<typeof vi.fn>).mockReturnValue([
        makeEvent({ seq: 1, threadId: "t-1", type: "turn/started", data: {} }),
      ]);

      expect(manager.getRunningCount()).toBe(1);
    });
  });

  describe("worktree operation broadcasts", () => {
    beforeEach(() => {
      (eventRepo.getLatestByType as ReturnType<typeof vi.fn>).mockImplementation(
        (_threadId: string, type: string) => {
          if (type !== "system/provisioning/completed") return undefined;
          return makeEvent({
            type: "system/provisioning/completed",
            data: {},
          });
        },
      );
    });

    describe("requestThreadOperation()", () => {
      it("accepts commit operations and schedules deterministic execution for idle threads", async () => {
        const thread = makeThread({
          id: "thread-1",
          status: "idle",
          environmentId: "worktree",
        });
        (threadRepo.getById as ReturnType<typeof vi.fn>).mockReturnValue(thread);
        (eventRepo.getLatestSeq as ReturnType<typeof vi.fn>).mockReturnValue(0);
        (eventRepo.create as ReturnType<typeof vi.fn>).mockImplementation((event) =>
          makeEvent({
            threadId: event.threadId,
            seq: event.seq,
            type: event.type as string,
            data: event.data,
          })
        );
        const scheduleDispatchSpy = vi
          .spyOn(asOrchestratorHarness(manager), "_scheduleQueuedOperationDispatch")
          .mockImplementation(() => {});

        const result = await manager.requestThreadOperation("thread-1", {
          operation: "commit",
          options: {
            includeUnstaged: true,
            message: "feat: test commit",
          },
        });

        expect(result).toMatchObject({
          ok: true,
          operation: "commit",
          status: "accepted",
          executionStatus: "running",
          queued: false,
          demotedPrimaryCheckout: false,
        });
        expect(scheduleDispatchSpy).toHaveBeenCalledWith("thread-1");
        expect(eventRepo.create).toHaveBeenCalledWith(
          expect.objectContaining({
            type: "system/thread_operation",
            data: expect.objectContaining({
              operation: "commit",
              status: "requested",
            }),
          }),
        );
      });

      it("queues squash operations when a thread is active", async () => {
        const projectRoot = "/tmp/proj-1";
        const thread = makeThread({
          id: "thread-1",
          projectId: "proj-1",
          status: "active",
          environmentId: "worktree",
          queuedMessages: [],
        });
        (threadRepo.getById as ReturnType<typeof vi.fn>).mockReturnValue(thread);
        (projectRepo.getById as ReturnType<typeof vi.fn>).mockReturnValue({
          id: "proj-1",
          name: "Project",
          rootPath: projectRoot,
          createdAt: 1000,
          updatedAt: 1000,
        });
        asOrchestratorHarness(manager).environmentRuntimes.set("thread-1", {
          environment: {
            kind: "worktree",
            info: {
              id: "worktree",
              displayName: "Git Worktree Workspace",
              description: "",
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
            getCheckoutSnapshot() {
              return {
                branch: "bb/thread-1",
                head: "abc123",
                detached: false,
              };
            },
            getWorkspaceRootUnsafe() {
              return "/tmp/worktrees/proj-1/thread-1";
            },
            getWorkspaceStatus() {
              return makeWorkspaceStatus();
            },
            watchWorkspaceStatus() {
              return () => {};
            },
            async commitWorkspace() {
              return {
                ok: true,
                commitCreated: false,
                message: "Working directory is clean",
                workStatus: makeWorkspaceStatus(),
              };
            },
            listWorkspaceCommitsSinceRef() {
              return [];
            },
            getWorkspaceDiff() {
              return { diff: "", truncated: false };
            },
            shouldRunSetupScript() {
              return false;
            },
            supportsPromoteToActiveWorkspace() {
              return false;
            },
            supportsDemoteFromActiveWorkspace() {
              return false;
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
          },
        });
        (eventRepo.getLatestSeq as ReturnType<typeof vi.fn>).mockReturnValue(0);
        (eventRepo.create as ReturnType<typeof vi.fn>).mockImplementation((event) =>
          makeEvent({
            threadId: event.threadId,
            seq: event.seq,
            type: event.type as string,
            data: event.data,
          })
        );
        vi
          .spyOn(asOrchestratorHarness(manager), "_scheduleQueuedOperationDispatch")
          .mockImplementation(() => {});

        const result = await manager.requestThreadOperation("thread-1", {
          operation: "squash_merge",
          options: {
            commitIfNeeded: true,
          },
        });

        expect(result).toMatchObject({
          ok: true,
          operation: "squash_merge",
          status: "accepted",
          executionStatus: "queued",
          queued: true,
          demotedPrimaryCheckout: false,
        });
        expect(eventRepo.create).toHaveBeenCalledWith(
          expect.objectContaining({
            type: "system/thread_operation",
            data: expect.objectContaining({
              operation: "squash_merge",
              status: "queued",
            }),
          }),
        );
      });

      it("demotes primary checkout before accepting operations", async () => {
        const thread = makeThread({
          id: "thread-1",
          status: "idle",
          environmentId: "worktree",
        });
        (threadRepo.getById as ReturnType<typeof vi.fn>).mockReturnValue(thread);
        (eventRepo.getLatestSeq as ReturnType<typeof vi.fn>).mockReturnValue(0);
        (eventRepo.create as ReturnType<typeof vi.fn>).mockImplementation((event) =>
          makeEvent({
            threadId: event.threadId,
            seq: event.seq,
            type: event.type as string,
            data: event.data,
          })
        );
        asOrchestratorHarness(manager).primaryPromotionByProjectId.set("proj-1", {
          projectId: "proj-1",
          threadId: "thread-1",
          promotedAt: 1000,
          promotedCheckout: {
            head: "abc123",
            detached: false,
          },
          reconstructed: false,
        });

        const demoteSpy = vi
          .spyOn(manager, "demotePrimaryCheckout")
          .mockResolvedValue({
            ok: true,
            demoted: true,
            message: "Primary checkout demoted",
            primaryStatus: { projectId: "proj-1" },
          });
        const scheduleDispatchSpy = vi
          .spyOn(asOrchestratorHarness(manager), "_scheduleQueuedOperationDispatch")
          .mockImplementation(() => {});

        const result = await manager.requestThreadOperation("thread-1", {
          operation: "commit",
          options: {},
        });

        expect(demoteSpy).toHaveBeenCalledWith("thread-1");
        expect(scheduleDispatchSpy).toHaveBeenCalled();
        expect(demoteSpy.mock.invocationCallOrder[0]).toBeLessThan(
          scheduleDispatchSpy.mock.invocationCallOrder[0] ?? Number.POSITIVE_INFINITY,
        );
        expect(result.demotedPrimaryCheckout).toBe(true);
      });

      it("records failed thread-operation events when preflight demotion fails", async () => {
        const thread = makeThread({
          id: "thread-1",
          status: "idle",
          environmentId: "worktree",
        });
        (threadRepo.getById as ReturnType<typeof vi.fn>).mockReturnValue(thread);
        (eventRepo.getLatestSeq as ReturnType<typeof vi.fn>).mockReturnValue(0);
        (eventRepo.create as ReturnType<typeof vi.fn>).mockImplementation((event) =>
          makeEvent({
            threadId: event.threadId,
            seq: event.seq,
            type: event.type as string,
            data: event.data,
          })
        );
        asOrchestratorHarness(manager).primaryPromotionByProjectId.set("proj-1", {
          projectId: "proj-1",
          threadId: "thread-1",
          promotedAt: 1000,
          promotedCheckout: {
            head: "abc123",
            detached: false,
          },
          reconstructed: false,
        });
        vi.spyOn(manager, "demotePrimaryCheckout").mockRejectedValue(new Error("demotion failed"));

        await expect(
          manager.requestThreadOperation("thread-1", {
            operation: "commit",
            options: {},
          }),
        ).rejects.toThrow("demotion failed");

        expect(eventRepo.create).toHaveBeenCalledWith(
          expect.objectContaining({
            type: "system/thread_operation",
            data: expect.objectContaining({
              operation: "commit",
              status: "failed",
              message: "demotion failed",
            }),
          }),
        );
      });

      it("queues a follow-up thread message when squash merge hits conflicts", async () => {
        const thread = makeThread({
          id: "thread-1",
          projectId: "proj-1",
          status: "idle",
          environmentId: "worktree",
        });
        (threadRepo.getById as ReturnType<typeof vi.fn>).mockReturnValue(thread);
        (projectRepo.getById as ReturnType<typeof vi.fn>).mockReturnValue({
          id: "proj-1",
          name: "Test",
          rootPath: "/tmp/proj-1",
          createdAt: 1000,
          updatedAt: 1000,
        });
        (eventRepo.getLatestSeq as ReturnType<typeof vi.fn>).mockReturnValue(0);
        (eventRepo.create as ReturnType<typeof vi.fn>).mockImplementation((event) =>
          makeEvent({
            threadId: event.threadId,
            seq: event.seq,
            type: event.type as string,
            data: event.data,
          })
        );
        (threadRepo.enqueueQueuedMessage as ReturnType<typeof vi.fn>).mockReturnValue({
          id: "queued-1",
          input: [],
          reasoningLevel: "medium",
          sandboxMode: "danger-full-access",
          createdAt: 1000,
        });
        (threadRepo.deleteQueuedMessage as ReturnType<typeof vi.fn>).mockReturnValue(false);
        asOrchestratorHarness(manager).environmentRuntimes.set("thread-1", {
          threadId: "thread-1",
          projectId: "proj-1",
          rootPath: "/tmp/proj-1",
          workspaceRoot: "/tmp/worktrees/proj-1/thread-1",
          branchName: "bb/thread-1",
          environment: makeRuntimeEnvironment({
            rootPath: "/tmp/worktrees/proj-1/thread-1",
            overrides: {
              supportsSquashMergeIntoDefaultBranch() {
                return true;
              },
              async squashMergeIntoDefaultBranch() {
                return {
                  merged: false,
                  message: "Squash merge has conflicts against main.",
                  conflictFiles: ["src/conflicted.ts", "README.md"],
                };
              },
            },
          }),
        });
        const scheduleFollowUpSpy = vi
          .spyOn(asOrchestratorHarness(manager), "_scheduleQueuedFollowUpDispatch")
          .mockImplementation(() => {});

        await (asOrchestratorHarness(manager) as any)._runWorktreeSquashMergeOperation("thread-1", {
          mergeBaseBranch: "main",
          squashMessage: "feat: ship thread changes",
        });

        expect(threadRepo.enqueueQueuedMessage).toHaveBeenCalledWith(
          "thread-1",
          expect.objectContaining({
            input: [
              {
                type: "text",
                text: buildSquashMergeConflictFollowUpInstruction(
                  {
                    operation: "squash_merge",
                    options: {
                      mergeBaseBranch: "main",
                      squashMessage: "feat: ship thread changes",
                    },
                  },
                  { conflictFiles: ["src/conflicted.ts", "README.md"] },
                ),
              },
            ],
          }),
        );
        expect(scheduleFollowUpSpy).toHaveBeenCalledWith("thread-1");
        expect(ws.broadcast).toHaveBeenCalledWith("thread", "thread-1", ["queue-changed"]);
      });

      it("emits a commit event when squash merge creates a prep commit", async () => {
        const thread = makeThread({
          id: "thread-1",
          projectId: "proj-1",
          status: "idle",
          environmentId: "worktree",
        });
        (threadRepo.getById as ReturnType<typeof vi.fn>).mockReturnValue(thread);
        (projectRepo.getById as ReturnType<typeof vi.fn>).mockReturnValue({
          id: "proj-1",
          name: "Test",
          rootPath: "/tmp/proj-1",
          createdAt: 1000,
          updatedAt: 1000,
        });
        (eventRepo.getLatestSeq as ReturnType<typeof vi.fn>).mockReturnValue(0);
        (eventRepo.create as ReturnType<typeof vi.fn>).mockImplementation((event) =>
          makeEvent({
            threadId: event.threadId,
            seq: event.seq,
            type: event.type as string,
            data: event.data,
          })
        );
        asOrchestratorHarness(manager).environmentRuntimes.set("thread-1", {
          threadId: "thread-1",
          projectId: "proj-1",
          rootPath: "/tmp/proj-1",
          workspaceRoot: "/tmp/worktrees/proj-1/thread-1",
          branchName: "bb/thread-1",
          environment: makeRuntimeEnvironment({
            rootPath: "/tmp/worktrees/proj-1/thread-1",
            overrides: {
              supportsSquashMergeIntoDefaultBranch() {
                return true;
              },
              async squashMergeIntoDefaultBranch() {
                return {
                  merged: true,
                  message: "Squash-merged into main",
                  committed: true,
                  prepCommit: {
                    message: "Committed changes",
                    commitSha: "abc123",
                    includeUnstaged: true,
                  },
                };
              },
            },
          }),
        });

        await (asOrchestratorHarness(manager) as any)._runWorktreeSquashMergeOperation("thread-1", {
          mergeBaseBranch: "main",
        });

        expect(eventRepo.create).toHaveBeenCalledWith(
          expect.objectContaining({
            type: "system/worktree/commit",
            data: expect.objectContaining({
              status: "committed",
              message: "Committed changes",
              commitSha: "abc123",
              includeUnstaged: true,
            }),
          }),
        );
        expect(eventRepo.create).toHaveBeenCalledWith(
          expect.objectContaining({
            type: "system/worktree/squash_merge",
            data: expect.objectContaining({
              status: "merged",
              message: "Squash-merged into main",
            }),
          }),
        );
      });
    });

  });

  describe("stopAll()", () => {
    it("clears all processes and is safe to call when empty", () => {
      // Should not throw when no processes
      manager.stopAll();
      expect(manager.getActiveCount()).toBe(0);
    });

    it("kills all active processes and marks them idle", () => {
      const proc1 = { stdin: null, stdout: null };
      const proc2 = { stdin: null, stdout: null };
      asOrchestratorHarness(manager).processes.set("thread-1", proc1);
      asOrchestratorHarness(manager).processes.set("thread-2", proc2);

      expect(manager.getActiveCount()).toBe(2);

      manager.stopAll();

      expect(threadRepo.update).toHaveBeenCalledWith(
        "thread-1",
        { status: "idle" },
        { touchUpdatedAt: false },
      );
      expect(threadRepo.update).toHaveBeenCalledWith(
        "thread-2",
        { status: "idle" },
        { touchUpdatedAt: false },
      );
      expect(manager.getActiveCount()).toBe(0);
    });
  });

  describe("_handleProcessExit()", () => {
    // Access private method for testing
    it("sets idle on exit code 0", () => {
      const thread = makeThread({ status: "active" });
      (threadRepo.getById as ReturnType<typeof vi.fn>).mockReturnValue(thread);

      // Call private method via bracket notation
      asOrchestratorHarness(manager)._handleProcessExit("thread-1", 0, null);

      expect(threadRepo.update).toHaveBeenCalledWith("thread-1", {
        status: "idle",
      });
      expect(ws.broadcast).toHaveBeenCalledWith("thread", "thread-1", [
        "status-changed",
        "work-status-changed",
      ]);
    });

    it("sets idle on SIGTERM signal", () => {
      const thread = makeThread({ status: "active" });
      (threadRepo.getById as ReturnType<typeof vi.fn>).mockReturnValue(thread);

      asOrchestratorHarness(manager)._handleProcessExit("thread-1", null, "SIGTERM");

      expect(threadRepo.update).toHaveBeenCalledWith("thread-1", {
        status: "idle",
      });
    });

    it("sets idle on non-zero exit code", () => {
      const thread = makeThread({ status: "active" });
      (threadRepo.getById as ReturnType<typeof vi.fn>).mockReturnValue(thread);

      asOrchestratorHarness(manager)._handleProcessExit("thread-1", 1, null);

      expect(threadRepo.update).toHaveBeenCalledWith("thread-1", {
        status: "idle",
      });
      expect(ws.broadcast).toHaveBeenCalledWith("thread", "thread-1", [
        "status-changed",
        "work-status-changed",
      ]);
    });

    it("does not update status on exit code 0 when thread is already idle", () => {
      const thread = makeThread({ status: "idle" });
      (threadRepo.getById as ReturnType<typeof vi.fn>).mockReturnValue(thread);

      asOrchestratorHarness(manager)._handleProcessExit("thread-1", 0, null);

      expect(threadRepo.update).not.toHaveBeenCalled();
    });

    it("does not update status on non-zero exit when thread is already idle", () => {
      const thread = makeThread({ status: "idle" });
      (threadRepo.getById as ReturnType<typeof vi.fn>).mockReturnValue(thread);

      asOrchestratorHarness(manager)._handleProcessExit("thread-1", 1, null);

      expect(threadRepo.update).not.toHaveBeenCalled();
    });

    it("does not update status if thread is already idle", () => {
      const thread = makeThread({ status: "idle" });
      (threadRepo.getById as ReturnType<typeof vi.fn>).mockReturnValue(thread);

      asOrchestratorHarness(manager)._handleProcessExit("thread-1", 0, null);

      expect(threadRepo.update).not.toHaveBeenCalled();
      expect(ws.broadcast).not.toHaveBeenCalled();
    });

    it("does nothing if thread not found in DB", () => {
      (threadRepo.getById as ReturnType<typeof vi.fn>).mockReturnValue(
        undefined,
      );

      asOrchestratorHarness(manager)._handleProcessExit("thread-1", 0, null);

      expect(threadRepo.update).not.toHaveBeenCalled();
      // Should not broadcast
      expect(ws.broadcast).not.toHaveBeenCalled();
    });

    it("removes process from the internal map", () => {
      // Manually add a fake process to the internal map
      const fakeProcess = { kill: vi.fn(), stdin: null, stdout: null };
      asOrchestratorHarness(manager).processes.set("thread-1", fakeProcess);
      expect(manager.isActive("thread-1")).toBe(true);

      const thread = makeThread({ status: "active" });
      (threadRepo.getById as ReturnType<typeof vi.fn>).mockReturnValue(thread);

      asOrchestratorHarness(manager)._handleProcessExit("thread-1", 0, null);

      expect(manager.isActive("thread-1")).toBe(false);
    });
  });

  describe("getTimeline()", () => {
    it("projects start-first provisioning failure into user, provisioning, and error rows", () => {
      (threadRepo.getById as ReturnType<typeof vi.fn>).mockReturnValue(
        makeThread({ status: "provisioning_failed" }),
      );
      (eventRepo.getLatestSeq as ReturnType<typeof vi.fn>).mockReturnValue(5);
      (eventRepo.listByThread as ReturnType<typeof vi.fn>).mockReturnValue([
        makeEvent({
          seq: 1,
          type: "client/thread/start",
          data: {
            direction: "outbound",
            source: "spawn",
            initiator: "agent",
            input: [{ type: "text", text: "Fix env setup script regression" }],
            request: {
              method: "thread/start",
              params: {},
            },
            execution: {},
          },
        }),
        makeEvent({
          seq: 2,
          type: "system/provisioning/started",
          data: {
            environmentId: "worktree",
            environmentDisplayName: "Git Worktree Workspace",
          },
        }),
        makeEvent({
          seq: 3,
          type: "system/provisioning/env_setup",
          data: {
            status: "started",
            scriptPath: ".bb-env-setup.sh",
            timeoutMs: 600000,
          },
        }),
        makeEvent({
          seq: 4,
          type: "system/provisioning/env_setup",
          data: {
            status: "failed",
            scriptPath: ".bb-env-setup.sh",
            timeoutMs: 600000,
            durationMs: 1593,
            detail: "pnpm build failed",
          },
        }),
        makeEvent({
          seq: 5,
          type: "system/error",
          data: {
            code: "thread_provisioning_failed",
            message: "Thread provisioning failed for project proj-1",
            detail: "pnpm build failed",
          },
        }),
      ]);

      const timeline = manager.getTimeline("thread-1");
      const messageRows = timeline.rows.filter(
        (row): row is Extract<(typeof timeline.rows)[number], { kind: "message" }> =>
          row.kind === "message",
      );

      expect(messageRows).toHaveLength(3);
      expect(messageRows[0]?.message.kind).toBe("user");
      if (messageRows[0]?.message.kind === "user") {
        expect(messageRows[0].message.text).toContain("Fix env setup script regression");
      }

      expect(messageRows[1]?.message.kind).toBe("operation");
      if (messageRows[1]?.message.kind === "operation") {
        expect(messageRows[1].message.opType).toBe("provisioning");
        expect(messageRows[1].message.title).toContain("Provisioning");
      }

      expect(messageRows[2]?.message.kind).toBe("error");
      if (messageRows[2]?.message.kind === "error") {
        expect(messageRows[2].message.message).toContain("Thread provisioning failed");
        expect(messageRows[2].message.message).toContain("pnpm build failed");
      }
    });

    it("includes provider thread/name/updated rows in the projected timeline", () => {
      (threadRepo.getById as ReturnType<typeof vi.fn>).mockReturnValue(
        makeThread({ status: "idle" }),
      );
      (eventRepo.getLatestSeq as ReturnType<typeof vi.fn>).mockReturnValue(1);
      (eventRepo.listByThread as ReturnType<typeof vi.fn>).mockReturnValue([
        makeEvent({
          seq: 1,
          type: "thread/name/updated",
          data: {
            threadId: "provider-thread-1",
            threadName: "Renamed by agent",
          },
        }),
      ]);

      const timeline = manager.getTimeline("thread-1");
      const rows = timeline.rows.filter(
        (row): row is Extract<(typeof timeline.rows)[number], { kind: "message" }> =>
          row.kind === "message",
      );

      expect(rows).toHaveLength(1);
      expect(rows[0]?.message.kind).toBe("operation");
      if (rows[0]?.message.kind !== "operation") return;
      expect(rows[0].message.opType).toBe("thread-title-updated");
      expect(rows[0].message.detail).toBe("Renamed by agent");

      const ignoredTypes = (eventRepo.listByThread as ReturnType<typeof vi.fn>).mock
        .calls[0]?.[3] as readonly string[] | undefined;
      expect(ignoredTypes).toBeDefined();
      expect(ignoredTypes).not.toContain("thread/name/updated");
    });

    it("includes compaction rows in the projected timeline", () => {
      (threadRepo.getById as ReturnType<typeof vi.fn>).mockReturnValue(
        makeThread({ status: "idle" }),
      );
      (eventRepo.getLatestSeq as ReturnType<typeof vi.fn>).mockReturnValue(1);
      (eventRepo.listByThread as ReturnType<typeof vi.fn>).mockReturnValue([
        makeEvent({
          seq: 1,
          type: "thread/compacted",
          data: {
            threadId: "provider-thread-1",
            turnId: "turn-1",
          },
        }),
      ]);

      const timeline = manager.getTimeline("thread-1");
      const rows = timeline.rows.filter(
        (row): row is Extract<(typeof timeline.rows)[number], { kind: "message" }> =>
          row.kind === "message",
      );

      expect(rows).toHaveLength(1);
      expect(rows[0]?.message.kind).toBe("operation");
      if (rows[0]?.message.kind !== "operation") return;
      expect(rows[0].message.opType).toBe("compaction");
      expect(rows[0].message.title).toBe("Context compacted");
    });
  });
});
