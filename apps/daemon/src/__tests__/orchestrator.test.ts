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
  buildCommitFailureFollowUpInstruction,
  buildSquashMergeCommitFailureFollowUpInstruction,
  buildSquashMergeConflictFollowUpInstruction,
  type SystemEnvironmentInfo,
  type Thread,
  type ThreadEvent,
  type ThreadWorkStatus,
} from "@beanbag/agent-core";
import {
  EnvironmentRegistry,
  EnvironmentSquashMergeCommitFailureError,
  type CreateEnvironmentContext,
  type IEnvironment,
} from "@beanbag/environment";
import {
  ENVIRONMENT_AGENT_PROTOCOL_VERSION,
  type EnvironmentAgentClient,
  type EnvironmentAgentCommandAck,
  type EnvironmentAgentEventEnvelope,
} from "@beanbag/environment-agent";
import type {
  ThreadRepository,
  EventRepository,
  ProjectRepository,
} from "@beanbag/db";
import * as gitProject from "../git-project.js";
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
  cleanup?: () => Promise<void> | void;
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
    suspend() {
      return args.cleanup?.();
    },
    destroy() {
      return args.cleanup?.();
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
const createHttpEnvironmentAgentClient = vi.fn();

vi.mock("@beanbag/environment-agent", async (importOriginal) => {
  return importOriginal<typeof import("@beanbag/environment-agent")>();
});

const DEFAULT_BASE_INSTRUCTIONS =
  "You are a coding agent working on a project thread. Follow the instructions carefully and write clean, working code.";

async function waitForProviderSessionStart(
  fakeChild: Pick<FakeChildProcess, "_stdinData">,
): Promise<void> {
  await vi.waitFor(() => {
    expect(
      fakeChild._stdinData.some(
        (entry) => parseRpcMessage(entry).method === "thread/start",
      ),
    ).toBe(true);
  });
}

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
  _cleanupEnvironmentRuntime: (
    threadId: string,
    opts?: { destroyWorkspace?: boolean },
  ) => void;
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
    activeTurnIdByThreadId: Map<string, string>;
    providerThreadIdByThreadId: Map<string, string>;
    agentServer: {
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
  const liveClients = new Map<string, {
    __fakeChild?: unknown;
    close?: (reason?: Error) => void;
  }>();
  const orchestratorActiveTurnIds = rawManager.activeTurnIdByThreadId;
  const orchestratorProviderThreadIds = rawManager.providerThreadIdByThreadId;

  const ensureLiveClient = (threadId: string) => {
    let client = liveClients.get(threadId);
    if (!client) {
      const child: any = {
        stdin: {
          write: vi.fn(),
        },
      };
      client = {
        __fakeChild: child,
        close: vi.fn(),
      };
      liveClients.set(threadId, client);
    }
    return client;
  };

  const processes = new Map<string, unknown>() as Map<string, unknown>;
  processes.get = (threadId: string) => liveClients.get(threadId)?.__fakeChild;
  processes.set = (threadId: string, child: unknown) => {
    let environmentAgentChild = child as FakeChildProcess;
    if (
      !environmentAgentChild ||
      !environmentAgentChild.stdout ||
      !environmentAgentChild.stderr
    ) {
      const compatibleChild = createFakeChildProcess();
      const partialChild = child as {
        stdin?: Writable | null;
        kill?: FakeChildProcess["kill"];
        pid?: number;
        exitCode?: number | null;
      };
      if (partialChild.stdin) {
        const originalStdin = compatibleChild.stdin;
        compatibleChild.stdin = new Writable({
          write(chunk, encoding, callback) {
            partialChild.stdin?.write(chunk, encoding, () => {
              originalStdin.write(chunk, encoding, callback);
            });
          },
        });
      }
      if (partialChild.kill) {
        compatibleChild.kill = partialChild.kill;
      }
      if (partialChild.pid !== undefined) {
        compatibleChild.pid = partialChild.pid;
      }
      if (partialChild.exitCode !== undefined) {
        compatibleChild.exitCode = partialChild.exitCode;
      }
      environmentAgentChild = compatibleChild;
    }
    (spawnMock as unknown as ReturnType<typeof vi.fn>).mockReturnValue(
      environmentAgentChild,
    );
    liveClients.set(threadId, {
      __fakeChild: environmentAgentChild,
      close: vi.fn(),
    });
    return processes;
  };
  processes.has = (threadId: string) => liveClients.has(threadId);
  processes.delete = (threadId: string) => liveClients.delete(threadId);
  processes.clear = () => liveClients.clear();

  const providerThreadIds = new Map<string, string>() as Map<string, string>;
  providerThreadIds.get = (threadId: string) => orchestratorProviderThreadIds.get(threadId);
  providerThreadIds.set = (threadId: string, providerThreadId: string) => {
    ensureLiveClient(threadId);
    orchestratorProviderThreadIds.set(threadId, providerThreadId);
    return providerThreadIds;
  };
  providerThreadIds.has = (threadId: string) => orchestratorProviderThreadIds.has(threadId);
  providerThreadIds.delete = (threadId: string) => orchestratorProviderThreadIds.delete(threadId);
  providerThreadIds.clear = () => orchestratorProviderThreadIds.clear();

  const activeTurnIds = new Map<string, string>() as Map<string, string>;
  activeTurnIds.get = (threadId: string) => orchestratorActiveTurnIds.get(threadId);
  activeTurnIds.set = (threadId: string, activeTurnId: string) => {
    orchestratorActiveTurnIds.set(threadId, activeTurnId);
    return activeTurnIds;
  };
  activeTurnIds.has = (threadId: string) => orchestratorActiveTurnIds.has(threadId);
  activeTurnIds.delete = (threadId: string) => orchestratorActiveTurnIds.delete(threadId);
  activeTurnIds.clear = () => orchestratorActiveTurnIds.clear();
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
    listManagedArtifactRetentionRecords: vi.fn(() => []),
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
    deleteByThreadId: vi.fn(),
  } as unknown as EventRepository;

  const projectRepo = {
    create: vi.fn(),
    getById: vi.fn(),
    list: vi.fn(),
    update: vi.fn(
      (projectId: string, data: Parameters<ProjectRepository["update"]>[1]) => {
        const existing = projectRepo.getById(projectId);
        return existing ? { ...existing, ...data } : undefined;
      },
    ),
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
    vi
      .spyOn(gitProject, "detectProjectDefaultBranchAsync")
      .mockImplementation(async (repoRoot: string) => (
        gitProject.detectProjectDefaultBranch(repoRoot) ?? "main"
      ));
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

      await manager.getWorkStatusAsync("thread-1");

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
      const archivedIdsWithEnvironmentRecord = initialThreads
        .filter((thread) => thread.archivedAt !== undefined && thread.environmentRecord)
        .map((thread) => thread.id);
      const nonArchivedActiveIdsWithEnvironmentRecord = initialThreads
        .filter(
          (thread) =>
            thread.archivedAt === undefined &&
            thread.status === "active" &&
            thread.environmentRecord,
        )
        .map((thread) => thread.id);
      const bootThreadRepo = {
        create: vi.fn(),
        getById: vi.fn((threadId: string) => threadState.get(threadId)),
        list: vi.fn(() => Array.from(threadState.values())),
        listManagedArtifactRetentionRecords: vi.fn((args: { archivedLogCutoff: number }) =>
          Array.from(threadState.values())
            .filter(
              (thread) =>
                typeof thread.environmentId === "string" &&
                thread.environmentId.trim().length > 0 &&
                (
                  thread.archivedAt === undefined ||
                  thread.archivedAt >= args.archivedLogCutoff
                ),
            )
            .map((thread) => ({
              id: thread.id,
              projectId: thread.projectId,
              environmentId: thread.environmentId,
              archivedAt: thread.archivedAt,
            }))
        ),
        listArchivedIdsWithEnvironmentRecord: vi.fn(() => archivedIdsWithEnvironmentRecord),
        listNonArchivedActiveIdsWithEnvironmentRecord: vi.fn(
          () => nonArchivedActiveIdsWithEnvironmentRecord,
        ),
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
        update: vi.fn(
          (projectId: string, data: Parameters<ProjectRepository["update"]>[1]) => {
            const existing = bootProjectRepo.getById(projectId);
            return existing ? { ...existing, ...data } : undefined;
          },
        ),
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

    it("finalizes archived environments through targeted archived queries", async () => {
      const {
        bootManager,
        bootThreadRepo,
      } = createBootManager([
        makeThread({
          id: "boot-archived-with-environment",
          status: "idle",
          archivedAt: 123,
          environmentRecord: {
            kind: "worktree",
            state: {
              workspaceRoot: "/tmp/worktree",
              branchName: "bb/thread-1",
            },
          },
        }),
        makeThread({
          id: "boot-archived-no-environment",
          status: "idle",
          archivedAt: 123,
        }),
      ]);
      const cleanupEnvironmentRuntimeSpy = vi
        .spyOn(asOrchestratorHarness(bootManager), "_cleanupEnvironmentRuntime")
        .mockImplementation(() => undefined);

      await bootManager.reconcileActiveThreadsOnBoot();

      expect(bootThreadRepo.listArchivedIdsWithEnvironmentRecord).toHaveBeenCalledTimes(1);
      expect(cleanupEnvironmentRuntimeSpy).toHaveBeenCalledTimes(1);
      expect(cleanupEnvironmentRuntimeSpy).toHaveBeenCalledWith(
        "boot-archived-with-environment",
        { destroyWorkspace: true },
      );
    });

    it("does not rehydrate persisted non-archived environments during boot", async () => {
      const {
        bootManager,
        bootProjectRepo,
        bootThreadRepo,
      } = createBootManager([
        makeThread({
          id: "boot-active-with-environment",
          projectId: "proj-1",
          status: "active",
          environmentRecord: {
            kind: "worktree",
            state: {
              workspaceRoot: "/tmp/worktree",
              branchName: "bb/thread-1",
            },
          },
        }),
        makeThread({
          id: "boot-idle-without-environment",
          projectId: "proj-1",
          status: "idle",
        }),
      ]);
      asOrchestratorHarness(bootManager).environmentRuntimes.set(
        "boot-active-with-environment",
        {
          environment: makeRuntimeEnvironment({
            rootPath: "/tmp/project",
            overrides: {
              getAgentConnectionTarget() {
                return {
                  transport: "http" as const,
                  baseUrl: "http://127.0.0.1:4312",
                };
              },
            },
          }),
          agentConnectionTarget: {
            transport: "http" as const,
            baseUrl: "http://127.0.0.1:4312",
          },
          stopWatchingWorkspaceStatus: vi.fn(),
        },
      );
      (bootProjectRepo.getById as ReturnType<typeof vi.fn>).mockReturnValue({
        id: "proj-1",
        name: "Project",
        rootPath: "/tmp/project",
        createdAt: 1,
        updatedAt: 1,
      });

      await bootManager.reconcileActiveThreadsOnBoot();

      expect(createHttpEnvironmentAgentClient).not.toHaveBeenCalled();
    });

    it("does not use the broad thread listing path during boot", async () => {
      const {
        bootManager,
        bootProjectRepo,
        bootThreadRepo,
      } = createBootManager([
        makeThread({ id: "boot-active", status: "active" }),
      ]);

      await bootManager.reconcileActiveThreadsOnBoot();

      expect(bootProjectRepo.list).not.toHaveBeenCalled();
      expect(bootThreadRepo.list).not.toHaveBeenCalled();
    });
  });

  describe("managed artifact reconciliation", () => {
    it("uses targeted metadata queries instead of listing all threads", async () => {
      (
        threadRepo.listManagedArtifactRetentionRecords as ReturnType<typeof vi.fn>
      ).mockReturnValue([
        {
          id: "boot-active-worktree",
          projectId: "proj-1",
          environmentId: "worktree",
        },
      ]);
      const homeDir = mkdtempSync(join(tmpdir(), "beanbag-managed-artifacts-home-"));
      const originalHome = process.env.HOME;
      process.env.HOME = homeDir;
      (projectRepo.list as ReturnType<typeof vi.fn>).mockReturnValue([]);

      try {
        await manager.reconcileManagedArtifacts();
      } finally {
        process.env.HOME = originalHome;
        rmSync(homeDir, { recursive: true, force: true });
      }

      expect(threadRepo.listManagedArtifactRetentionRecords).toHaveBeenCalledTimes(1);
      expect(threadRepo.list).not.toHaveBeenCalled();
    });
  });

  describe("spawn()", () => {
    let fakeChild: ReturnType<typeof createFakeChildProcess>;

    beforeEach(() => {
      fakeChild = createFakeChildProcess();
      (spawnMock as ReturnType<typeof vi.fn>).mockReturnValue(fakeChild);
      (eventRepo.getLatestSeq as ReturnType<typeof vi.fn>).mockReturnValue(0);
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
                branchName: "bb/thread-1",
                headSha: "abc123",
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
                branchName: "bb/thread-1",
                headSha: "abc123",
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



    it("registers the process and marks thread as active", async () => {
      const project = { id: "proj-1", name: "Test", rootPath: "/test", createdAt: 1000, updatedAt: 1000 };
      (projectRepo.getById as ReturnType<typeof vi.fn>).mockReturnValue(project);

      const createdThread = makeThread({ id: "t-new", status: "idle" });
      (threadRepo.create as ReturnType<typeof vi.fn>).mockReturnValue(createdThread);
      (threadRepo.getById as ReturnType<typeof vi.fn>).mockReturnValue(
        makeThread({ id: "t-new", status: "active" }),
      );
      (threadRepo.list as ReturnType<typeof vi.fn>).mockReturnValue([
        makeThread({ id: "t-new", status: "active" }),
      ]);

      await manager.spawn({
        projectId: "proj-1",
        input: [{ type: "text", text: "Start work" }],
      });
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

      await manager.spawn({
        projectId: "proj-1",
        input: [{ type: "text", text: "Start work" }],
      });
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

      await manager.spawn({
        projectId: "proj-1",
        input: [{ type: "text", text: "Start work" }],
      });

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

      const systemTellSpy = vi.spyOn(manager, "systemTell").mockResolvedValue();

      await manager.spawn({ projectId: "proj-1", parentThreadId: "parent-1" });

      fakeChild._pushStdout(
        JSON.stringify({
          method: "turn/completed",
          params: { turnId: "turn-child-1" },
        }),
      );
      await new Promise((r) => setTimeout(r, 50));

      expect(systemTellSpy).not.toHaveBeenCalled();
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

      const systemTellSpy = vi.spyOn(manager, "systemTell").mockResolvedValue();

      await manager.spawn({ projectId: "proj-1", parentThreadId: "parent-1" });

      fakeChild._pushStdout(
        JSON.stringify({
          method: "turn/started",
          params: { turnId: "turn-child-1" },
        }),
      );
      await new Promise((r) => setTimeout(r, 50));

      expect(systemTellSpy).not.toHaveBeenCalled();
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










    it("throws for empty tell payload object", async () => {
      await expect(manager.tell("thread-1", { input: [] })).rejects.toThrow(
        "Tell payload input must be non-empty",
      );
    });






  });

  describe("stop()", () => {
    it("updates status to idle and broadcasts when no active process", () => {
      (threadRepo.getById as ReturnType<typeof vi.fn>).mockReturnValue(
        makeThread({
          id: "thread-1",
          status: "active",
        }),
      );

      manager.stop("thread-1");

      expect(eventRepo.create).toHaveBeenCalledWith(
        expect.objectContaining({
          threadId: "thread-1",
          type: "system/thread/interrupted",
          data: {
            reason: "user",
          },
        }),
      );
      expect(threadRepo.update).toHaveBeenCalledWith("thread-1", {
        status: "idle",
      });
      expect(ws.broadcast).toHaveBeenCalledWith("thread", "thread-1", [
        "status-changed",
        "work-status-changed",
      ]);
    });

    it("does not append interruption events for threads that are already idle", () => {
      (threadRepo.getById as ReturnType<typeof vi.fn>).mockReturnValue(
        makeThread({
          id: "thread-1",
          status: "idle",
        }),
      );

      manager.stop("thread-1");

      expect(eventRepo.create).not.toHaveBeenCalledWith(
        expect.objectContaining({
          type: "system/thread/interrupted",
        }),
      );
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

    it("suspends managed environments when threads become idle", async () => {
      vi.useFakeTimers();
      try {
        const thread = makeThread({
          id: "thread-1",
          status: "active",
          environmentId: "worktree",
          environmentRecord: {
            kind: "worktree",
            state: {},
          },
        });
        (threadRepo.getById as ReturnType<typeof vi.fn>).mockImplementation(
          (threadId: string) => (threadId === "thread-1" ? thread : undefined),
        );
        (threadRepo.update as ReturnType<typeof vi.fn>).mockImplementation(
          (_threadId: string, updates: Partial<Thread>) => {
            Object.assign(thread, updates);
            return thread;
          },
        );

        const cleanup = vi.fn();
        const stopWatchingWorkspaceStatus = vi.fn();
        asOrchestratorHarness(manager).environmentRuntimes.set("thread-1", {
          environment: makeRuntimeEnvironment({
            rootPath: "/tmp/worktree",
            cleanup,
          }),
          agentConnectionTarget: {
            transport: "http",
            baseUrl: "http://127.0.0.1:4312",
          },
          stopWatchingWorkspaceStatus,
        });

        (manager as unknown as {
          _setThreadStatus: (threadId: string, status: Thread["status"]) => boolean;
        })._setThreadStatus("thread-1", "idle");

        await vi.runAllTimersAsync();

        expect(cleanup).toHaveBeenCalledTimes(1);
        expect(stopWatchingWorkspaceStatus).toHaveBeenCalledTimes(1);
        expect(asOrchestratorHarness(manager).environmentRuntimes.has("thread-1")).toBe(false);
      } finally {
        vi.useRealTimers();
      }
    });

    it("keeps managed environments alive when threads become idle with queued follow-up messages", async () => {
      vi.useFakeTimers();
      try {
        const thread = makeThread({
          id: "thread-1",
          status: "active",
          environmentId: "worktree",
          queuedMessages: [{
            id: "msg-1",
            input: [{ type: "text", text: "keep going" }],
            reasoningLevel: "medium",
            sandboxMode: "danger-full-access",
            createdAt: 1,
          }],
          environmentRecord: {
            kind: "worktree",
            state: {},
          },
        });
        (threadRepo.getById as ReturnType<typeof vi.fn>).mockImplementation(
          (threadId: string) => (threadId === "thread-1" ? thread : undefined),
        );
        (threadRepo.update as ReturnType<typeof vi.fn>).mockImplementation(
          (_threadId: string, updates: Partial<Thread>) => {
            Object.assign(thread, updates);
            return thread;
          },
        );

        const cleanup = vi.fn();
        const stopWatchingWorkspaceStatus = vi.fn();
        asOrchestratorHarness(manager).environmentRuntimes.set("thread-1", {
          environment: makeRuntimeEnvironment({
            rootPath: "/tmp/worktree",
            cleanup,
          }),
          agentConnectionTarget: {
            transport: "http",
            baseUrl: "http://127.0.0.1:4312",
          },
          stopWatchingWorkspaceStatus,
        });

        (manager as unknown as {
          _setThreadStatus: (threadId: string, status: Thread["status"]) => boolean;
        })._setThreadStatus("thread-1", "idle");

        await vi.runAllTimersAsync();

        expect(cleanup).not.toHaveBeenCalled();
        expect(stopWatchingWorkspaceStatus).not.toHaveBeenCalled();
        expect(asOrchestratorHarness(manager).environmentRuntimes.has("thread-1")).toBe(true);
      } finally {
        vi.useRealTimers();
      }
    });

    it("keeps managed environments alive when threads become idle with queued operations", async () => {
      vi.useFakeTimers();
      try {
        const thread = makeThread({
          id: "thread-1",
          status: "active",
          environmentId: "worktree",
          environmentRecord: {
            kind: "worktree",
            state: {},
          },
        });
        (threadRepo.getById as ReturnType<typeof vi.fn>).mockImplementation(
          (threadId: string) => (threadId === "thread-1" ? thread : undefined),
        );
        (threadRepo.update as ReturnType<typeof vi.fn>).mockImplementation(
          (_threadId: string, updates: Partial<Thread>) => {
            Object.assign(thread, updates);
            return thread;
          },
        );

        const cleanup = vi.fn();
        const stopWatchingWorkspaceStatus = vi.fn();
        asOrchestratorHarness(manager).environmentRuntimes.set("thread-1", {
          environment: makeRuntimeEnvironment({
            rootPath: "/tmp/worktree",
            cleanup,
          }),
          agentConnectionTarget: {
            transport: "http",
            baseUrl: "http://127.0.0.1:4312",
          },
          stopWatchingWorkspaceStatus,
        });
        (asOrchestratorHarness(manager) as unknown as {
          queuedOperationsByThreadId: Map<string, Array<{
            operationId: string;
            request: { operation: "commit"; options?: undefined };
            requestedAt: number;
            demotedPrimaryCheckout: boolean;
          }>>;
        }).queuedOperationsByThreadId.set("thread-1", [{
          operationId: "op-1",
          request: { operation: "commit" },
          requestedAt: 1,
          demotedPrimaryCheckout: false,
        }]);

        (manager as unknown as {
          _setThreadStatus: (threadId: string, status: Thread["status"]) => boolean;
        })._setThreadStatus("thread-1", "idle");

        await vi.runAllTimersAsync();

        expect(cleanup).not.toHaveBeenCalled();
        expect(stopWatchingWorkspaceStatus).not.toHaveBeenCalled();
        expect(asOrchestratorHarness(manager).environmentRuntimes.has("thread-1")).toBe(true);
      } finally {
        vi.useRealTimers();
      }
    });
  });

  describe("archive()", () => {
    it("marks a thread archived and broadcasts when no active process", async () => {
      (threadRepo.getById as ReturnType<typeof vi.fn>).mockReturnValue(
        makeThread({ id: "thread-1", status: "idle" }),
      );

      await manager.archive("thread-1");

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


    it("destroys workspace environment on archive", async () => {
      const cleanup = vi.fn();
      (threadRepo.getById as ReturnType<typeof vi.fn>).mockReturnValue(
        makeThread({ id: "thread-1", status: "idle" }),
      );
      asOrchestratorHarness(manager).environmentRuntimes.set("thread-1", {
        environment: makeRuntimeEnvironment({
          rootPath: "/tmp/worktree",
          cleanup,
        }),
      });

      await manager.archive("thread-1");

      expect(cleanup).toHaveBeenCalledTimes(1);
    });

    it("archives worktree threads even when no runtime is active", async () => {
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
                data: {
                  environmentId: "worktree",
                  environmentDisplayName: "Git Worktree Workspace",
                },
              })
            : undefined,
      );
      await manager.archive("thread-1");

      expect(threadRepo.update).toHaveBeenCalledWith("thread-1", {
        status: "idle",
        archivedAt: expect.any(Number),
      });
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
          cleanup,
        }),
      });

      const archivePromise = manager.archive("thread-1");

      expect(resolveCleanup).toBeTypeOf("function");
      expect(ws.broadcast).not.toHaveBeenCalledWith("thread", "thread-1", [
        "status-changed",
        "work-status-changed",
        "archived-changed",
      ]);

      resolveCleanup?.();
      await archivePromise;

      expect(ws.broadcast).toHaveBeenCalledWith("thread", "thread-1", [
        "status-changed",
        "work-status-changed",
        "archived-changed",
      ]);
      expect(ws.broadcast).toHaveBeenCalledWith("thread", "thread-1", [
        "work-status-changed",
      ]);
      expect((ws.broadcast as ReturnType<typeof vi.fn>).mock.calls.at(-2)).toEqual([
        "thread",
        "thread-1",
        ["work-status-changed"],
      ]);
      expect((ws.broadcast as ReturnType<typeof vi.fn>).mock.calls.at(-1)).toEqual([
        "thread",
        "thread-1",
        ["status-changed", "work-status-changed", "archived-changed"],
      ]);
    });

    it("preserves thread runtime state when environment cleanup fails", async () => {
      const cleanup = vi.fn(() => {
        throw new Error("cleanup failed");
      });
      const thread = makeThread({
        id: "thread-1",
        status: "active",
        projectId: "proj-1",
        environmentId: "worktree",
      });
      (threadRepo.getById as ReturnType<typeof vi.fn>).mockReturnValue(thread);

      const harness = asOrchestratorHarness(manager);
      harness.environmentRuntimes.set("thread-1", {
        environment: makeRuntimeEnvironment({
          rootPath: "/tmp/worktree",
          cleanup,
        }),
      });
      harness.providerThreadIds.set("thread-1", "provider-thread-1");
      harness.primaryPromotionByProjectId.set("proj-1", {
        projectId: "proj-1",
        threadId: "thread-1",
      });
      (manager as unknown as {
        queuedOperationsByThreadId: Map<string, unknown[]>;
      }).queuedOperationsByThreadId.set("thread-1", [{ operation: "commit" }]);

      await expect(manager.archive("thread-1")).rejects.toThrow("cleanup failed");

      expect(harness.environmentRuntimes.has("thread-1")).toBe(true);
      expect(harness.providerThreadIds.get("thread-1")).toBe("provider-thread-1");
      expect(harness.primaryPromotionByProjectId.get("proj-1")).toEqual({
        projectId: "proj-1",
        threadId: "thread-1",
      });
      expect(
        (manager as unknown as {
          queuedOperationsByThreadId: Map<string, unknown[]>;
        }).queuedOperationsByThreadId.has("thread-1"),
      ).toBe(true);
      expect(threadRepo.update).not.toHaveBeenCalledWith("thread-1", {
        status: "idle",
        archivedAt: expect.any(Number),
      });
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

    it("caches provider model listings briefly", async () => {
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

  describe("getHydratedByIdAsync()", () => {
    it("delegates to threadRepo", async () => {
      const thread = makeThread({ status: "idle" });
      (threadRepo.getById as ReturnType<typeof vi.fn>).mockReturnValue(thread);

      await expect(manager.getHydratedByIdAsync("thread-1")).resolves.toBe(thread);
      expect(threadRepo.getById).toHaveBeenCalledWith("thread-1");
      expect(ws.broadcast).not.toHaveBeenCalled();
    });

    it("returns undefined for nonexistent thread", async () => {
      (threadRepo.getById as ReturnType<typeof vi.fn>).mockReturnValue(
        undefined,
      );

      await expect(manager.getHydratedByIdAsync("nonexistent")).resolves.toBeUndefined();
    });

    it("includes prompt-derived title fallback when persisted title is missing", async () => {
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

      const result = await manager.getHydratedByIdAsync("thread-1");
      const resultSecondRead = await manager.getHydratedByIdAsync("thread-1");

      expect(result?.title).toBeUndefined();
      expect(result?.titleFallback).toBe("Investigate flaky test reruns");
      expect(resultSecondRead?.titleFallback).toBe("Investigate flaky test reruns");
      expect(eventRepo.getLatestByType).toHaveBeenCalledTimes(1);
    });

    it("returns persisted active status even when lifecycle events suggest completion", async () => {
      const runningThread = makeThread({ status: "active" });
      (threadRepo.getById as ReturnType<typeof vi.fn>).mockReturnValue(runningThread);
      (eventRepo.listByThread as ReturnType<typeof vi.fn>).mockReturnValue([
        makeEvent({ seq: 1, type: "turn/started", data: {} }),
        makeEvent({ seq: 2, type: "turn/completed", data: {} }),
      ]);
      const result = await manager.getHydratedByIdAsync("thread-1");

      expect(threadRepo.update).not.toHaveBeenCalled();
      expect(ws.broadcast).not.toHaveBeenCalled();
      expect(result?.status).toBe("active");
    });

    it("reconciles idle thread to idle when latest turn is started but no process exists", async () => {
      const idleThread = makeThread({ status: "idle" });
      (threadRepo.getById as ReturnType<typeof vi.fn>).mockReturnValue(idleThread);
      (eventRepo.listByThread as ReturnType<typeof vi.fn>).mockReturnValue([
        makeEvent({ seq: 1, type: "turn/completed", data: {} }),
        makeEvent({ seq: 2, type: "turn/started", data: {} }),
      ]);
      const result = await manager.getHydratedByIdAsync("thread-1");

      expect(threadRepo.update).not.toHaveBeenCalled();
      expect(ws.broadcast).not.toHaveBeenCalled();
      expect(result?.status).toBe("idle");
    });


    it("hydrates thread state through async workspace status when sync status is unavailable", async () => {
      const thread = makeThread({
        id: "thread-1",
        projectId: "proj-1",
        status: "idle",
        environmentId: "worktree",
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
        environment: makeRuntimeEnvironment({
          kind: "worktree",
          rootPath: "/tmp/worktrees/proj-1/thread-1",
          overrides: {
            getWorkspaceStatus() {
              throw new Error(
                "Synchronous workspace status is unsupported; use getWorkspaceStatusAsync",
              );
            },
            async getWorkspaceStatusAsync() {
              return makeWorkspaceStatus({
                state: "committed_unmerged",
                hasCommittedUnmergedChanges: true,
                aheadCount: 1,
                currentBranch: "bb/thread-1",
              });
            },
            supportsSquashMergeIntoDefaultBranch() {
              return true;
            },
          },
        }),
      });

      const result = await manager.getHydratedByIdAsync("thread-1");

      expect(result).toMatchObject({
        id: "thread-1",
        status: "idle",
      });
      expect(result?.workStatus).toMatchObject({
        state: "committed_unmerged",
        hasCommittedUnmergedChanges: true,
      });
      expect(
        result?.builtInActions?.find((action: { id: string }) => action.id === "squash_merge")
          ?.available,
      ).toBe(false);
    });
  });

  describe("getWorkStatusAsync()", () => {
    it("keeps worktree status unknown until provisioning completes", async () => {
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

      const result = await managerWithCustomEnvironment.getWorkStatusAsync("thread-1");

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
      const resolvedResult = await managerWithCustomEnvironment.getWorkStatusAsync("thread-1");
      expect(resolvedResult).toStrictEqual(mockedStatus);
    });

    it("returns deleted while workspace cleanup is in progress", async () => {
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
                data: {
                  environmentId: "worktree",
                  environmentDisplayName: "Git Worktree Workspace",
                },
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
          suspend: () =>
            new Promise<void>((resolve) => {
              resolveCleanup = resolve;
            }),
          destroy: () =>
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

      const archivePromise = manager.archive("thread-1");
      const result = await manager.getWorkStatusAsync("thread-1");

      expect(result).toMatchObject({
        state: "deleted",
        changedFiles: 0,
        workspaceChangedFiles: 0,
        hasUncommittedChanges: false,
      });

      resolveCleanup?.();
      await archivePromise;
    });
  });

  describe("deleteThread()", () => {
    it("destroys managed artifacts before deleting thread rows", async () => {
      const cleanup = vi.fn();
      const thread = makeThread({
        id: "thread-1",
        status: "idle",
        projectId: "proj-1",
        environmentId: "worktree",
      });
      (threadRepo.getById as ReturnType<typeof vi.fn>).mockReturnValue(thread);
      asOrchestratorHarness(manager).environmentRuntimes.set("thread-1", {
        environment: makeRuntimeEnvironment({
          rootPath: "/tmp/worktree",
          cleanup,
        }),
      });

      await manager.deleteThread("thread-1");

      expect(cleanup).toHaveBeenCalledTimes(1);
      expect(eventRepo.deleteByThreadId).toHaveBeenCalledWith("thread-1");
      expect(threadRepo.delete).toHaveBeenCalledWith("thread-1");
      expect(ws.broadcast).toHaveBeenCalledWith("thread", "thread-1", [
        "thread-deleted",
      ]);
    });

    it("preserves thread state when managed cleanup fails before deletion", async () => {
      const cleanup = vi.fn(() => {
        throw new Error("cleanup failed");
      });
      const thread = makeThread({
        id: "thread-1",
        status: "active",
        projectId: "proj-1",
        environmentId: "worktree",
      });
      (threadRepo.getById as ReturnType<typeof vi.fn>).mockReturnValue(thread);

      const harness = asOrchestratorHarness(manager);
      harness.environmentRuntimes.set("thread-1", {
        environment: makeRuntimeEnvironment({
          rootPath: "/tmp/worktree",
          cleanup,
        }),
      });
      harness.providerThreadIds.set("thread-1", "provider-thread-1");

      await expect(manager.deleteThread("thread-1")).rejects.toThrow("cleanup failed");

      expect(harness.environmentRuntimes.has("thread-1")).toBe(true);
      expect(harness.providerThreadIds.get("thread-1")).toBe("provider-thread-1");
      expect(eventRepo.deleteByThreadId).not.toHaveBeenCalled();
      expect(threadRepo.delete).not.toHaveBeenCalled();
      expect(ws.broadcast).not.toHaveBeenCalledWith("thread", "thread-1", [
        "thread-deleted",
      ]);
    });
  });

  describe("getGitDiffAsync()", () => {
    it("returns combined diffs when only async workspace status is available", async () => {
      const thread = makeThread({
        id: "thread-1",
        projectId: "proj-1",
        status: "idle",
        environmentId: "worktree",
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
        environment: makeRuntimeEnvironment({
          kind: "worktree",
          rootPath: "/tmp/worktrees/proj-1/thread-1",
          overrides: {
            getWorkspaceStatus() {
              throw new Error(
                "Synchronous workspace status is unsupported; use getWorkspaceStatusAsync",
              );
            },
            async getWorkspaceStatusAsync() {
              return makeWorkspaceStatus({
                hasCommittedUnmergedChanges: false,
                hasUncommittedChanges: false,
                aheadCount: 1,
                baseRef: "main",
              });
            },
            async listWorkspaceCommitsSinceRefAsync() {
              return [
                {
                  sha: "abc123",
                  shortSha: "abc123",
                  subject: "squashed commit",
                },
              ];
            },
            async getWorkspaceDiffAsync() {
              return { diff: "", truncated: false };
            },
          },
        }),
      });

      await expect(manager.getGitDiffAsync("thread-1")).resolves.toMatchObject({
        mode: "worktree_commits",
        selection: { type: "combined" },
      });
    });

    it("returns merge-base diffs for direct workspaces on non-default branches", async () => {
      const thread = makeThread({
        id: "thread-1",
        projectId: "proj-1",
        status: "idle",
        environmentId: "local",
      });
      const getWorkspaceDiffAsync = vi.fn().mockResolvedValue({
        diff: "diff --git a/file b/file",
        truncated: false,
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
        environment: makeRuntimeEnvironment({
          kind: "local",
          rootPath: "/tmp/proj-1",
          overrides: {
            getWorkspaceStatus() {
              throw new Error(
                "Synchronous workspace status is unsupported; use getWorkspaceStatusAsync",
              );
            },
            async getWorkspaceStatusAsync() {
              return makeWorkspaceStatus({
                state: "committed_unmerged",
                hasCommittedUnmergedChanges: true,
                hasUncommittedChanges: false,
                aheadCount: 1,
                baseRef: "origin/main",
                mergeBaseBranch: "main",
              });
            },
            async listWorkspaceCommitsSinceRefAsync() {
              return [
                {
                  sha: "abc123",
                  shortSha: "abc123",
                  subject: "feature commit",
                },
              ];
            },
            getWorkspaceDiffAsync,
          },
        }),
      });

      await expect(manager.getGitDiffAsync("thread-1")).resolves.toMatchObject({
        mode: "worktree_commits",
        selection: { type: "combined" },
        commits: [
          {
            sha: "abc123",
            shortSha: "abc123",
            subject: "feature commit",
          },
        ],
        diff: "diff --git a/file b/file",
        truncated: false,
        mergeBaseBranch: "main",
        mergeBaseRef: "origin/main",
      });
      expect(getWorkspaceDiffAsync).toHaveBeenCalledWith({
        type: "combined",
        baseRef: "origin/main",
      });
    });

    it("suppresses combined diffs for squash-resolved clean worktrees", async () => {
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
              baseRef: "origin/main",
              mergeBaseBranch: "main",
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

      const result = await manager.getGitDiffAsync("thread-1");

      expect(result).toMatchObject({
        mode: "worktree_commits",
        selection: { type: "combined" },
        diff: "",
        truncated: false,
      });
      expect(getWorkspaceDiff).not.toHaveBeenCalled();
    });

    it("still returns commit diffs for explicit commit selection", async () => {
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

      const result = await manager.getGitDiffAsync("thread-1", {
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

  });

  describe("primary checkout status reconciliation", () => {

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

    it("keeps promote action available when another thread is currently promoted", async () => {
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

      const hydrated = await manager.getHydratedByIdAsync("thread-2");
      const promoteAction = hydrated?.builtInActions?.find((action: { id: string }) => action.id === "promote");

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
    it("returns false when thread is not persisted as active", () => {
      expect(manager.isActive("thread-1")).toBe(false);
    });

    it("returns true when thread is persisted as active", () => {
      (threadRepo.getById as ReturnType<typeof vi.fn>).mockReturnValue(
        makeThread({ id: "thread-1", status: "active" }),
      );

      expect(manager.isActive("thread-1")).toBe(true);
    });
  });

  describe("getActiveCount()", () => {
    it("returns 0 when no threads are persisted as active", () => {
      expect(manager.getActiveCount()).toBe(0);
    });

    it("returns active count from persisted DB status", () => {
      (threadRepo.list as ReturnType<typeof vi.fn>).mockReturnValue([
        makeThread({ id: "t-1", status: "active" }),
        makeThread({ id: "t-2", status: "active" }),
      ]);

      expect(manager.getActiveCount()).toBe(2);
      expect(threadRepo.list).toHaveBeenCalledWith({ status: "active" });
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
            data: {
              environmentId: "worktree",
              environmentDisplayName: "Git Worktree Workspace",
            },
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

      it("accepts squash operations for async-only environments", async () => {
        const projectRoot = "/tmp/proj-1";
        const thread = makeThread({
          id: "thread-1",
          projectId: "proj-1",
          status: "idle",
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
          environment: makeRuntimeEnvironment({
            kind: "worktree",
            rootPath: "/tmp/worktrees/proj-1/thread-1",
            overrides: {
              getWorkspaceStatus() {
                throw new Error("Synchronous workspace status is unsupported; use getWorkspaceStatusAsync");
              },
              async getWorkspaceStatusAsync() {
                return makeWorkspaceStatus({
                  state: "committed_unmerged",
                  hasCommittedUnmergedChanges: true,
                  aheadCount: 1,
                  currentBranch: "bb/thread-1",
                  defaultBranch: "main",
                });
              },
              supportsSquashMergeIntoDefaultBranch() {
                return true;
              },
            },
          }),
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
        });

        expect(result).toMatchObject({
          ok: true,
          operation: "squash_merge",
          status: "accepted",
          executionStatus: "running",
          queued: false,
        });
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

      it("queues follow-up side effects after commit failures are recorded", async () => {
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
              async commitWorkspace() {
                throw new Error("Commit message is required");
              },
            },
          }),
        });
        const scheduleFollowUpSpy = vi
          .spyOn(asOrchestratorHarness(manager), "_scheduleQueuedFollowUpDispatch")
          .mockImplementation(() => {});

        await (asOrchestratorHarness(manager) as any)._runQueuedThreadOperation(thread, {
          operationId: "op-1",
          requestedAt: 1000,
          demotedPrimaryCheckout: false,
          request: {
            operation: "commit",
            options: {
              message: "feat: add tests",
            },
          },
        });

        expect(threadRepo.enqueueQueuedMessage).toHaveBeenCalledWith(
          "thread-1",
          expect.objectContaining({
            input: [
              {
                type: "text",
                text: buildCommitFailureFollowUpInstruction(
                  {
                    operation: "commit",
                    options: {
                      message: "feat: add tests",
                    },
                  },
                  {
                    errorMessage: "Commit message is required",
                  },
                ),
              },
            ],
          }),
        );
        expect(scheduleFollowUpSpy).toHaveBeenCalledWith("thread-1");
        expect(ws.broadcast).toHaveBeenCalledWith("thread", "thread-1", ["queue-changed"]);
        expect(eventRepo.create).toHaveBeenCalledWith(
          expect.objectContaining({
            type: "system/thread_operation",
            data: expect.objectContaining({
              operation: "commit",
              status: "failed",
              operationId: "op-1",
              message: "Commit message is required",
            }),
          }),
        );
      });

      it("returns deferred follow-up actions when squash merge hits conflicts", async () => {
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
        const result = await (asOrchestratorHarness(manager) as any)._runWorktreeSquashMergeOperation("thread-1", {
          mergeBaseBranch: "main",
          squashMessage: "feat: ship thread changes",
        });

        expect(result).toEqual({
          message: "Squash merge has conflicts against main.",
          postActions: [
            {
              type: "enqueue_squash_merge_conflict_follow_up",
              request: {
                operation: "squash_merge",
                options: {
                  mergeBaseBranch: "main",
                  squashMessage: "feat: ship thread changes",
                },
              },
              conflictFiles: ["src/conflicted.ts", "README.md"],
            },
          ],
        });
        expect(threadRepo.enqueueQueuedMessage).not.toHaveBeenCalled();
        expect(ws.broadcast).not.toHaveBeenCalledWith("thread", "thread-1", ["queue-changed"]);
      });

      it("queues follow-up side effects after squash merge operation terminal status is recorded", async () => {
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

        await (asOrchestratorHarness(manager) as any)._runQueuedThreadOperation(thread, {
          operationId: "op-1",
          requestedAt: 1000,
          demotedPrimaryCheckout: false,
          request: {
            operation: "squash_merge",
            options: {
              mergeBaseBranch: "main",
              squashMessage: "feat: ship thread changes",
            },
          },
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
        const firstEventsBroadcastOrder = (
          ws.broadcast as ReturnType<typeof vi.fn>
        ).mock.calls.find(([scope, id, changes]) =>
          scope === "thread" &&
          id === "thread-1" &&
          Array.isArray(changes) &&
          changes.includes("events-appended"),
        )
          ? (ws.broadcast as ReturnType<typeof vi.fn>).mock.invocationCallOrder[
              (ws.broadcast as ReturnType<typeof vi.fn>).mock.calls.findIndex(
                ([scope, id, changes]) =>
                  scope === "thread" &&
                  id === "thread-1" &&
                  Array.isArray(changes) &&
                  changes.includes("events-appended"),
              )
            ]
          : Number.POSITIVE_INFINITY;
        const queueChangedBroadcastOrder = (
          ws.broadcast as ReturnType<typeof vi.fn>
        ).mock.calls.find(([scope, id, changes]) =>
          scope === "thread" &&
          id === "thread-1" &&
          Array.isArray(changes) &&
          changes.includes("queue-changed"),
        )
          ? (ws.broadcast as ReturnType<typeof vi.fn>).mock.invocationCallOrder[
              (ws.broadcast as ReturnType<typeof vi.fn>).mock.calls.findIndex(
                ([scope, id, changes]) =>
                  scope === "thread" &&
                  id === "thread-1" &&
                  Array.isArray(changes) &&
                  changes.includes("queue-changed"),
              )
            ]
          : Number.POSITIVE_INFINITY;
        expect(firstEventsBroadcastOrder).toBeLessThan(queueChangedBroadcastOrder);
        expect(eventRepo.create).toHaveBeenCalledWith(
          expect.objectContaining({
            type: "system/thread_operation",
            data: expect.objectContaining({
              operation: "squash_merge",
              status: "completed",
              operationId: "op-1",
            }),
          }),
        );
        expect(
          (eventRepo.create as ReturnType<typeof vi.fn>).mock.invocationCallOrder[
            (eventRepo.create as ReturnType<typeof vi.fn>).mock.calls.findIndex(
              ([event]) =>
                event.type === "system/thread_operation" &&
                event.data?.status === "completed" &&
                event.data?.operationId === "op-1",
            )
          ] ?? Number.POSITIVE_INFINITY,
        ).toBeLessThan(
          (threadRepo.enqueueQueuedMessage as ReturnType<typeof vi.fn>).mock.invocationCallOrder[0] ??
            Number.POSITIVE_INFINITY,
        );
      });

      it("queues follow-up side effects after squash merge commit-step failures are recorded", async () => {
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
                throw new EnvironmentSquashMergeCommitFailureError(
                  "squash_commit",
                  "nothing to commit, working tree clean",
                );
              },
            },
          }),
        });
        const scheduleFollowUpSpy = vi
          .spyOn(asOrchestratorHarness(manager), "_scheduleQueuedFollowUpDispatch")
          .mockImplementation(() => {});

        await (asOrchestratorHarness(manager) as any)._runQueuedThreadOperation(thread, {
          operationId: "op-1",
          requestedAt: 1000,
          demotedPrimaryCheckout: false,
          request: {
            operation: "squash_merge",
            options: {
              mergeBaseBranch: "main",
            },
          },
        });

        expect(threadRepo.enqueueQueuedMessage).toHaveBeenCalledWith(
          "thread-1",
          expect.objectContaining({
            input: [
              {
                type: "text",
                text: buildSquashMergeCommitFailureFollowUpInstruction(
                  {
                    operation: "squash_merge",
                    options: {
                      mergeBaseBranch: "main",
                    },
                  },
                  {
                    stage: "squash_commit",
                    errorMessage: "nothing to commit, working tree clean",
                  },
                ),
              },
            ],
          }),
        );
        expect(scheduleFollowUpSpy).toHaveBeenCalledWith("thread-1");
        expect(ws.broadcast).toHaveBeenCalledWith("thread", "thread-1", ["queue-changed"]);
        expect(eventRepo.create).toHaveBeenCalledWith(
          expect.objectContaining({
            type: "system/thread_operation",
            data: expect.objectContaining({
              operation: "squash_merge",
              status: "failed",
              operationId: "op-1",
              message: "nothing to commit, working tree clean",
            }),
          }),
        );
        expect(
          (eventRepo.create as ReturnType<typeof vi.fn>).mock.invocationCallOrder[
            (eventRepo.create as ReturnType<typeof vi.fn>).mock.calls.findIndex(
              ([event]) =>
                event.type === "system/thread_operation" &&
                event.data?.status === "failed" &&
                event.data?.operationId === "op-1",
            )
          ] ?? Number.POSITIVE_INFINITY,
        ).toBeLessThan(
          (threadRepo.enqueueQueuedMessage as ReturnType<typeof vi.fn>).mock.invocationCallOrder[0] ??
            Number.POSITIVE_INFINITY,
        );
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
                  commitSha: "def4567890",
                  commitSubject: "feat: squash merged thread work",
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
              commitSha: "def4567890",
              commitSubject: "feat: squash merged thread work",
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


    it("preserves managed environments during daemon shutdown mode", () => {
      const dispose = vi.fn();
      const stopWatchingWorkspaceStatus = vi.fn();
      asOrchestratorHarness(manager).environmentRuntimes.set("thread-1", {
        environment: makeRuntimeEnvironment({
          rootPath: "/test",
          cleanup: dispose,
        }),
        agentConnectionTarget: {
          transport: "http",
          baseUrl: "http://127.0.0.1:4312",
        },
        stopWatchingWorkspaceStatus,
      });

      manager.stopAll({ preserveEnvironments: true });

      expect(stopWatchingWorkspaceStatus).toHaveBeenCalledTimes(1);
      expect(dispose).not.toHaveBeenCalled();
    });

    it("does not mark active managed sessions idle during daemon shutdown mode", async () => {
      const project = {
        id: "proj-1",
        name: "Test",
        rootPath: "/my/project",
        createdAt: 1000,
        updatedAt: 1000,
      };
      (projectRepo.getById as ReturnType<typeof vi.fn>).mockReturnValue(project);

      const createdThread = makeThread({ id: "thread-1", status: "idle" });
      const activeThread = makeThread({ id: "thread-1", status: "active" });
      (threadRepo.create as ReturnType<typeof vi.fn>).mockReturnValue(createdThread);
      (threadRepo.getById as ReturnType<typeof vi.fn>).mockImplementation((threadId: string) =>
        threadId === "thread-1" ? activeThread : undefined,
      );
      asOrchestratorHarness(manager).environmentRuntimes.set("thread-1", {
        environment: makeRuntimeEnvironment({
          rootPath: "/my/project",
        }),
        startedAt: Date.now(),
        projectId: "proj-1",
      });

      const fakeChild = createFakeChildProcess();
      (spawnMock as ReturnType<typeof vi.fn>).mockReturnValue(fakeChild);

      await manager.spawn({ projectId: "proj-1" });
      await vi.waitFor(() => {
        expect(
          manager.isActive("thread-1"),
        ).toBe(true);
      });

      (threadRepo.update as ReturnType<typeof vi.fn>).mockClear();

      manager.stopAll({ preserveEnvironments: true });

      expect(threadRepo.update).not.toHaveBeenCalledWith("thread-1", { status: "idle" });
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
        expect(messageRows[1].message.title).toBe("Environment setup failed");
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
