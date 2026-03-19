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
  type ThreadEventDataForType,
  type ThreadEventType,
  type ThreadWorkStatus,
} from "@bb/core";
import {
  EnvironmentRegistry,
  EnvironmentSquashMergeCommitFailureError,
  type CreateEnvironmentContext,
  type IEnvironment,
} from "@bb/environment";
import {
  ENVIRONMENT_AGENT_PROTOCOL_VERSION,
  type EnvironmentAgentClient,
  type EnvironmentAgentCommandAck,
  type EnvironmentAgentEventEnvelope,
} from "@bb/environment-daemon";
import {
  createConnection,
  migrate,
  ThreadRepository,
  EventRepository,
  ProjectRepository,
  EnvironmentRepository,
  ThreadEnvironmentAttachmentRepository,
} from "@bb/db";
import type { DbConnection } from "@bb/db";
import * as gitProject from "../git-project.js";
import {
  createCodexProviderAdapter,
  createPiProviderAdapter,
  type LlmCompletionService,
} from "@bb/provider-adapters";
import { Orchestrator } from "../orchestrator.js";
import { ProviderSessionController } from "../provider-session-controller.js";
import type { EnvironmentService } from "../environment-service.js";
import type { EnvironmentAgentSessionService } from "../environment-agent-session-service.js";
import { WSManager } from "../ws.js";
import {
  CODEX_THREAD_ID,
  createFakeChildProcess,
  createFakeEnvironmentAgentClient,
  findRpcMessageByMethod,
  parseRpcMessage,
  type FakeChildProcess,
} from "./helpers/environment-agent-test-harness.js";
import {
  createTestDb,
  createTestRepos,
  createTestProject,
  createTestThread,
  createMockLlmCompletionService,
  createTestRuntimeEnv,
} from "./test-factories.js";

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

function createEventData<TType extends ThreadEventType>(
  data: ThreadEventDataForType<TType>,
): ThreadEventDataForType<TType> {
  return data;
}

function createItemCompletedData(args: {
  threadId: string;
  turnId: string;
  item: ThreadEventDataForType<"item/completed">["item"];
}): ThreadEventDataForType<"item/completed"> {
  return {
    threadId: args.threadId,
    turnId: args.turnId,
    item: args.item,
  };
}

function createTurnStartedData(
  threadId: string,
  turnId = "turn-1",
): ThreadEventDataForType<"turn/started"> {
  return {
    threadId,
    turn: {
      id: turnId,
      items: [],
      status: "inProgress",
      error: null,
    },
  };
}

function createTurnCompletedData(
  threadId: string,
  turnId = "turn-1",
): ThreadEventDataForType<"turn/completed"> {
  return {
    threadId,
    turn: {
      id: turnId,
      items: [],
      status: "completed",
      error: null,
    },
  };
}

function createAgentMessageItem(
  text: string,
  id = "assistant-1",
): ThreadEventDataForType<"item/completed">["item"] {
  return {
    type: "agentMessage",
    id,
    text,
  };
}

function createClientStartData(args: {
  input: Array<{ type: "text"; text: string }>;
  source?: "spawn" | "tell";
  initiator?: "agent" | "system" | "user";
  method?: "thread/start" | "turn/start";
}): ThreadEventDataForType<"client/thread/start"> {
  return {
    direction: "outbound",
    source: args.source ?? "spawn",
    initiator: args.initiator ?? "agent",
    input: args.input,
    request: {
      method: args.method ?? "thread/start",
      params: {},
    },
    execution: {},
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
  const requestedKind = args.kind ?? "worktree";
  const runtimeKind = requestedKind === "worktree" ? "local" : requestedKind;
  const info: SystemEnvironmentInfo = {
    id: requestedKind,
    displayName: args.displayName ?? "Git Worktree Workspace",
    description: "",
    capabilities: {
      host_filesystem: true,
      isolated_workspace: requestedKind === "worktree",
      promote_primary_checkout: requestedKind === "worktree",
      demote_primary_checkout: requestedKind === "worktree",
      squash_merge: requestedKind === "worktree",
    },
  };

  return new EnvironmentRegistry().register({
    kind: runtimeKind,
    info,
    create(context: CreateEnvironmentContext): IEnvironment {
      args.onCreate?.(context);
      return makeRuntimeEnvironment({
        kind: runtimeKind,
        rootPath: args.rootPath,
        overrides: {
          info,
          serialize() {
            return { rootPath: args.rootPath };
          },
          buildAgentInstructions() {
            return requestedKind === "worktree"
              ? "[BB worktree environment]"
              : undefined;
          },
          isIsolatedWorkspace() {
            return requestedKind === "worktree";
          },
          supportsPromoteToActiveWorkspace() {
            return requestedKind === "worktree";
          },
          supportsDemoteFromActiveWorkspace() {
            return requestedKind === "worktree";
          },
          supportsSquashMergeIntoDefaultBranch() {
            return requestedKind === "worktree";
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
    async listWorkspaceCommitsSinceRef() {
      return [];
    },
    async getWorkspaceDiff() {
      return { diff: "", truncated: false };
    },
    spawn(command: string, commandArgs: string[], options?: { stdio?: unknown; env?: Record<string, string | undefined>; cwd?: string }) {
      return (spawnMock as unknown as (...args: unknown[]) => FakeChildProcess)(
        command,
        commandArgs,
        options,
      ) as unknown as ChildProcess;
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
    async promoteToActiveWorkspace() {
      throw new Error("not implemented");
    },
    async demoteFromActiveWorkspace() {
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

vi.mock("@bb/environment-daemon", async (importOriginal) => {
  return importOriginal<typeof import("@bb/environment-daemon")>();
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
  _detachEnvironmentRuntime: (threadId: string) => void;
  _destroyEnvironmentRuntime: (threadId: string) => void;
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
    agentServerByProviderId: Map<string, {
      opts: {
        provider: {
          listModels: (...args: unknown[]) => unknown;
        };
      };
    }>;
    providerAdapterByProviderId: Map<string, {
      listModels: (...args: unknown[]) => unknown;
    }>;
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
  const rawEnvironmentRuntimes = rawManager.environmentService.environmentRuntimes;
  const normalizeEnvironmentRuntimeKey = (key: string) =>
    key.includes(":") ? key : `thread:${key}`;
  const environmentRuntimes = new Map<string, unknown>() as Map<string, unknown>;
  environmentRuntimes.get = (key: string) =>
    rawEnvironmentRuntimes.get(normalizeEnvironmentRuntimeKey(key));
  environmentRuntimes.set = (key: string, value: unknown) => {
    const normalizedKey = normalizeEnvironmentRuntimeKey(key);
    const normalizedValue =
      value && typeof value === "object"
        ? {
          ...(value as Record<string, unknown>),
          scopeKey: (value as { scopeKey?: string }).scopeKey ?? normalizedKey,
          ownerThreadId:
            (value as { ownerThreadId?: string }).ownerThreadId ??
            (normalizedKey.startsWith("thread:") ? normalizedKey.slice("thread:".length) : key),
        }
        : value;
    rawEnvironmentRuntimes.set(normalizedKey, normalizedValue);
    return environmentRuntimes;
  };
  environmentRuntimes.has = (key: string) =>
    rawEnvironmentRuntimes.has(normalizeEnvironmentRuntimeKey(key));
  environmentRuntimes.delete = (key: string) =>
    rawEnvironmentRuntimes.delete(normalizeEnvironmentRuntimeKey(key));
  environmentRuntimes.clear = () => rawEnvironmentRuntimes.clear();
  Object.assign(rawManager, {
    processes,
    providerThreadIds,
    activeTurnIds,
    environmentRuntimes,
    provider:
      Array.from(rawManager.providerAdapterByProviderId.values())[0] ??
      Array.from(rawManager.agentServerByProviderId.values())[0]?.opts.provider,
  });
  return rawManager as OrchestratorTestHarness;
}



describe("Orchestrator", () => {
  let threadRepo: ThreadRepository;
  let eventRepo: EventRepository;
  let projectRepo: ProjectRepository;
  let ws: WSManager;
  let llmCompletionService: LlmCompletionService;
  let manager: Orchestrator;

  beforeEach(() => {
    vi
      .spyOn(gitProject, "detectProjectDefaultBranchAsync")
      .mockImplementation(async (repoRoot: string) => (
        gitProject.detectProjectDefaultBranch(repoRoot) ?? "main"
      ));
    vi.clearAllMocks();
    ws = {
      broadcast: vi.fn(),
      handleConnection: vi.fn(),
      close: vi.fn(),
    } as unknown as WSManager;
    llmCompletionService = createMockLlmCompletionService();
  });

  afterEach(async () => {
    await new Promise<void>((resolve) => setImmediate(resolve));
    await new Promise<void>((resolve) => setImmediate(resolve));
  });

  describe("environment services", () => {
    let testDb: ReturnType<typeof createTestDb>;
    let project: ReturnType<typeof createTestProject>;
    let environmentRepo: ReturnType<typeof createTestRepos>["environmentRepo"];
    let attachmentRepo: ReturnType<typeof createTestRepos>["attachmentRepo"];

    beforeEach(() => {
      testDb = createTestDb();
      const repos = createTestRepos(testDb.db);
      threadRepo = repos.threadRepo;
      eventRepo = repos.eventRepo;
      projectRepo = repos.projectRepo;
      environmentRepo = repos.environmentRepo;
      attachmentRepo = repos.attachmentRepo;
      project = createTestProject(projectRepo, { rootPath: "/test" });
      manager = new Orchestrator(
        threadRepo, eventRepo, projectRepo, ws, llmCompletionService,
        undefined, createTestRuntimeEnv(),
      );
    });

    it("routes shared environment provider events to the matching attached thread", () => {
      const env = environmentRepo.create({
        projectId: project.id,
        descriptor: { type: "path", path: "/tmp/env" },
        managed: true,
      });
      const ownerThread = createTestThread(threadRepo, project.id, {
        status: "idle",
        environmentId: env.id,
      });
      const siblingThread = createTestThread(threadRepo, project.id, {
        status: "idle",
        environmentId: env.id,
      });
      attachmentRepo.attachThread({ threadId: ownerThread.id, environmentId: env.id });
      attachmentRepo.attachThread({ threadId: siblingThread.id, environmentId: env.id });

      manager = new Orchestrator(
        threadRepo,
        eventRepo,
        projectRepo,
        ws,
        llmCompletionService,
        undefined,
        createTestRuntimeEnv(),
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        attachmentRepo as never,
      );

      (
        manager as unknown as {
          providerThreadIdByThreadId: Map<string, string>;
        }
      ).providerThreadIdByThreadId.set(ownerThread.id, "provider-thread-owner");
      (
        manager as unknown as {
          providerThreadIdByThreadId: Map<string, string>;
        }
      ).providerThreadIdByThreadId.set(siblingThread.id, "provider-thread-sibling");

      (
        manager as unknown as {
          _handleAgentServerNotification: (threadId: string, event: unknown) => void;
        }
      )._handleAgentServerNotification(ownerThread.id, {
        method: "item/completed",
        normalizedMethod: "item/completed",
        eventType: "item/completed",
        eventData: {
          __bb_provider_event: {
            schema: "bb/provider-event-envelope",
            version: 1,
            providerId: "codex",
            method: "item/completed",
            observedAt: 1_234,
          },
          payload: {
            threadId: "provider-thread-sibling",
            item: { type: "agentMessage", text: "hello" },
          },
        },
        shouldPersist: true,
        shouldBroadcast: false,
      });

      const events = eventRepo.listByThread(siblingThread.id);
      expect(events).toContainEqual(
        expect.objectContaining({
          threadId: siblingThread.id,
          type: "item/completed",
        }),
      );
    });

    it("does not cross-route shared environment events when providers reuse the same provider thread id", () => {
      const env = environmentRepo.create({
        projectId: project.id,
        descriptor: { type: "path", path: "/tmp/env" },
        managed: true,
      });
      const codexThread = createTestThread(threadRepo, project.id, {
        status: "idle",
        environmentId: env.id,
        providerId: "codex",
      });
      const claudeThread = createTestThread(threadRepo, project.id, {
        status: "idle",
        environmentId: env.id,
        providerId: "claude-code",
      });
      attachmentRepo.attachThread({ threadId: codexThread.id, environmentId: env.id });
      attachmentRepo.attachThread({ threadId: claudeThread.id, environmentId: env.id });

      manager = new Orchestrator(
        threadRepo,
        eventRepo,
        projectRepo,
        ws,
        llmCompletionService,
        undefined,
        createTestRuntimeEnv(),
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        attachmentRepo as never,
      );

      (
        manager as unknown as {
          providerThreadIdByThreadId: Map<string, string>;
        }
      ).providerThreadIdByThreadId.set(codexThread.id, "shared-provider-thread");
      (
        manager as unknown as {
          providerThreadIdByThreadId: Map<string, string>;
        }
      ).providerThreadIdByThreadId.set(claudeThread.id, "shared-provider-thread");

      (
        manager as unknown as {
          _handleAgentServerNotification: (threadId: string, event: unknown) => void;
        }
      )._handleAgentServerNotification(codexThread.id, {
        method: "item/completed",
        normalizedMethod: "item/completed",
        eventType: "item/completed",
        eventData: {
          __bb_provider_event: {
            schema: "bb/provider-event-envelope",
            version: 1,
            providerId: "claude-code",
            method: "item/completed",
            observedAt: 1_234,
          },
          payload: {
            threadId: "shared-provider-thread",
            item: { type: "agentMessage", text: "hello from claude" },
          },
        },
        shouldPersist: true,
        shouldBroadcast: false,
      });

      expect(eventRepo.listByThread(codexThread.id)).not.toContainEqual(
        expect.objectContaining({
          threadId: codexThread.id,
          type: "item/completed",
        }),
      );
      expect(eventRepo.listByThread(claudeThread.id)).toContainEqual(
        expect.objectContaining({
          threadId: claudeThread.id,
          type: "item/completed",
        }),
      );
    });

    it("ignores active session invalidation during newer-session handoff", () => {
      const thread = createTestThread(threadRepo, project.id, { status: "active" });
      const updateSpy = vi.spyOn(threadRepo, "update");
      const createSpy = vi.spyOn(eventRepo, "create");

      manager.handleEnvironmentAgentSessionInvalidated(thread.id, "newer_session");

      expect(updateSpy).not.toHaveBeenCalled();
      expect(createSpy).not.toHaveBeenCalled();
      expect(ws.broadcast).not.toHaveBeenCalled();
    });

    it("ignores active session invalidation during migration-driven replacement", () => {
      const thread = createTestThread(threadRepo, project.id, { status: "active" });
      const updateSpy = vi.spyOn(threadRepo, "update");
      const createSpy = vi.spyOn(eventRepo, "create");

      manager.handleEnvironmentAgentSessionInvalidated(thread.id, "migration");

      expect(updateSpy).not.toHaveBeenCalled();
      expect(createSpy).not.toHaveBeenCalled();
      expect(ws.broadcast).not.toHaveBeenCalled();
    });

    it("injects llm completion into environment creation context", async () => {
      const generateCommitMessage = llmCompletionService.generateCommitMessage as ReturnType<
        typeof vi.fn
      >;
      generateCommitMessage.mockResolvedValue("feat: support commit generation");
      const thread = createTestThread(threadRepo, project.id, { status: "idle" });
      const capturedContext = (
        manager as unknown as {
          _createEnvironmentContext: (
            threadId: string,
            projectRootPath: string,
          ) => CreateEnvironmentContext;
        }
      )._createEnvironmentContext(thread.id, "/tmp/proj-1");

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

    it("does not reconnect to an expired shared environment-agent session target", () => {
      const env = environmentRepo.create({
        projectId: project.id,
        descriptor: { type: "path", path: "/tmp/env" },
        managed: true,
      });
      const thread = createTestThread(threadRepo, project.id, {
        status: "idle",
        environmentId: env.id,
      });
      attachmentRepo.attachThread({ threadId: thread.id, environmentId: env.id });

      const sessionRepo = {
        getActiveByEnvironmentId: vi.fn(() => undefined),
        getActiveByThreadId: vi.fn(() => undefined),
        getLatestByEnvironmentId: vi.fn(() => ({
          id: "session-1",
          threadId: "thread-1",
          environmentId: env.id,
          agentId: "environment-agent:thread-1",
          agentInstanceId: "instance-1",
          protocolVersion: 1,
          controlBaseUrl: "http://127.0.0.1:4315",
          controlAuthToken: "token-1",
          status: "expired",
          leaseExpiresAt: Date.now() - 1,
          closeReason: "lease_expired",
          createdAt: 1,
          updatedAt: 2,
        })),
        getLatestByThreadId: vi.fn(() => undefined),
      };

      manager = new Orchestrator(
        threadRepo,
        eventRepo,
        projectRepo,
        ws,
        llmCompletionService,
        undefined,
        createTestRuntimeEnv(),
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        sessionRepo as never,
        undefined,
        attachmentRepo as never,
      );

      const context = (
        manager as unknown as {
          _createEnvironmentContext: (
            threadId: string,
            projectRootPath: string,
          ) => {
            managedEnvironmentAgentReconnectTarget?: {
              baseUrl: string;
              authToken?: string;
            };
          };
        }
      )._createEnvironmentContext(thread.id, "/tmp/proj-1");

      expect(context.managedEnvironmentAgentReconnectTarget).toBeUndefined();
      expect(sessionRepo.getActiveByEnvironmentId).toHaveBeenCalledWith(env.id);
      expect(sessionRepo.getLatestByEnvironmentId).not.toHaveBeenCalled();
    });
  });

  describe("boot status healing", () => {
    function createBootManager(
      threadDescs: Array<{
        status: Thread["status"];
        environmentId?: string;
        archivedAt?: number;
      }>,
      opts?: {
        sessionService?: Pick<
          EnvironmentAgentSessionService,
          "retireActiveSessionForEnvironment"
        >;
      },
    ) {
      const { db, sqlite } = createTestDb();
      const repos = createTestRepos(db);
      const bootWs = {
        broadcast: vi.fn(),
        handleConnection: vi.fn(),
        close: vi.fn(),
      } as unknown as WSManager;

      const project = createTestProject(repos.projectRepo, { rootPath: "/tmp/test-project" });
      const threads = threadDescs.map((desc) => {
        let environmentId = desc.environmentId;
        if (environmentId) {
          const env = repos.environmentRepo.create({
            projectId: project.id,
            descriptor: { type: "path", path: "/tmp/env" },
            managed: true,
          });
          environmentId = env.id;
        }
        const thread = createTestThread(repos.threadRepo, project.id, {
          status: desc.status,
          environmentId,
          archivedAt: desc.archivedAt,
        });
        if (environmentId) {
          repos.attachmentRepo.attachThread({ threadId: thread.id, environmentId });
        }
        return thread;
      });

      const bootManager = new Orchestrator(
        repos.threadRepo,
        repos.eventRepo,
        repos.projectRepo,
        bootWs,
        createMockLlmCompletionService(),
        undefined,
        process.env,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        opts?.sessionService as EnvironmentAgentSessionService | undefined,
        undefined,
        undefined,
        repos.attachmentRepo,
      );

      return {
        bootManager,
        bootThreadRepo: repos.threadRepo,
        bootEventRepo: repos.eventRepo,
        bootProjectRepo: repos.projectRepo,
        bootWs,
        threads,
        project,
        sqlite,
      };
    }

    it("finalizes archived environments through targeted archived queries", async () => {
      const {
        bootManager,
        threads,
      } = createBootManager([
        {
          status: "idle",
          archivedAt: 123,
          environmentId: "env-worktree-1",
        },
        {
          status: "idle",
          archivedAt: 123,
        },
      ]);
      const archivedWithEnv = threads[0]!;
      const destroyEnvironmentRuntimeSpy = vi
        .spyOn(asOrchestratorHarness(bootManager), "_destroyEnvironmentRuntime")
        .mockImplementation(() => undefined);

      await bootManager.cleanupArchivedEnvironmentsOnBoot();

      expect(destroyEnvironmentRuntimeSpy).toHaveBeenCalledTimes(1);
      expect(destroyEnvironmentRuntimeSpy).toHaveBeenCalledWith(
        archivedWithEnv.id,
      );
    });

    it("does not rehydrate persisted non-archived environments during boot", async () => {
      const {
        bootManager,
        threads,
      } = createBootManager([
        {
          status: "active",
          environmentId: "env-worktree-1",
        },
        {
          status: "idle",
        },
      ]);
      const activeWithEnv = threads[0]!;
      asOrchestratorHarness(bootManager).environmentRuntimes.set(
        activeWithEnv.id,
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

      await bootManager.cleanupArchivedEnvironmentsOnBoot();

      expect(createHttpEnvironmentAgentClient).not.toHaveBeenCalled();
    });

    it("does not use the broad thread listing path during boot", async () => {
      const {
        bootManager,
        bootProjectRepo,
        bootThreadRepo,
      } = createBootManager([
        { status: "active" },
      ]);
      const listProjectSpy = vi.spyOn(bootProjectRepo, "list");
      const listThreadSpy = vi.spyOn(bootThreadRepo, "list");

      await bootManager.cleanupArchivedEnvironmentsOnBoot();

      expect(listProjectSpy).not.toHaveBeenCalled();
      expect(listThreadSpy).not.toHaveBeenCalled();
    });

    it("fails stranded provisioning threads during boot", async () => {
      const {
        bootManager,
        bootThreadRepo,
        bootEventRepo,
        threads,
      } = createBootManager([
        { status: "provisioning" },
      ]);
      const provisioningThread = threads[0]!;
      const listSpy = vi.spyOn(bootThreadRepo, "list");

      await bootManager.failInterruptedProvisioningOnBoot();

      const updated = bootThreadRepo.getById(provisioningThread.id);
      expect(updated?.status).toBe("provisioning_failed");

      const events = bootEventRepo.listByThread(provisioningThread.id);
      expect(events).toContainEqual(
        expect.objectContaining({
          threadId: provisioningThread.id,
          type: "system/error",
          data: expect.objectContaining({
            code: "provider_unavailable",
          }),
        }),
      );
      expect(listSpy).not.toHaveBeenCalled();
    });

    it("fails stranded provisioned threads during boot and retires their sessions", async () => {
      const sessionService = {
        retireActiveSessionForEnvironment: vi.fn(),
      };
      const {
        bootManager,
        bootThreadRepo,
        bootEventRepo,
        threads,
      } = createBootManager(
        [
          {
            status: "provisioned",
            environmentId: "env-local-1",
          },
        ],
        {
          sessionService,
        },
      );
      const provisionedThread = threads[0]!;

      await bootManager.failInterruptedProvisioningOnBoot();

      const updated = bootThreadRepo.getById(provisionedThread.id);
      expect(updated?.status).toBe("provisioning_failed");
      expect(sessionService.retireActiveSessionForEnvironment).toHaveBeenCalledWith({
        environmentId: provisionedThread.environmentId,
        reason: "migration",
      });

      const events = bootEventRepo.listByThread(provisionedThread.id);
      expect(events).toContainEqual(
        expect.objectContaining({
          threadId: provisionedThread.id,
          type: "system/error",
          data: expect.objectContaining({
            code: "provider_unavailable",
          }),
        }),
      );
    });
  });

  describe("managed artifact reconciliation", () => {
    let testDb: ReturnType<typeof createTestDb>;
    let project: ReturnType<typeof createTestProject>;

    beforeEach(() => {
      testDb = createTestDb();
      const repos = createTestRepos(testDb.db);
      threadRepo = repos.threadRepo;
      eventRepo = repos.eventRepo;
      projectRepo = repos.projectRepo;
      project = createTestProject(projectRepo, { rootPath: "/test" });
      manager = new Orchestrator(
        threadRepo, eventRepo, projectRepo, ws, llmCompletionService,
        undefined, createTestRuntimeEnv(),
      );
    });

    it("uses targeted metadata queries instead of listing all threads", async () => {
      const envRepo = new EnvironmentRepository(testDb.db);
      const env = envRepo.create({
        projectId: project.id,
        descriptor: { type: "path", path: "/tmp/env" },
        managed: true,
      });
      createTestThread(threadRepo, project.id, {
        status: "idle",
        environmentId: env.id,
      });
      const homeDir = mkdtempSync(join(tmpdir(), "bb-managed-artifacts-home-"));
      const originalHome = process.env.HOME;
      process.env.HOME = homeDir;

      const listRetentionSpy = vi.spyOn(threadRepo, "listManagedArtifactRetentionRecords");
      const listThreadSpy = vi.spyOn(threadRepo, "list");

      try {
        await manager.reconcileManagedArtifacts();
      } finally {
        process.env.HOME = originalHome;
        rmSync(homeDir, { recursive: true, force: true });
      }

      expect(listRetentionSpy).toHaveBeenCalledTimes(1);
      expect(listThreadSpy).not.toHaveBeenCalled();
    });
  });

  describe("spawn()", () => {
    let fakeChild: ReturnType<typeof createFakeChildProcess>;
    let testDb: ReturnType<typeof createTestDb>;

    beforeEach(() => {
      testDb = createTestDb();
      const repos = createTestRepos(testDb.db);
      threadRepo = repos.threadRepo;
      eventRepo = repos.eventRepo;
      projectRepo = repos.projectRepo;
      manager = new Orchestrator(
        threadRepo,
        eventRepo,
        projectRepo,
        ws,
        llmCompletionService,
        undefined,
        createTestRuntimeEnv(),
      );
      fakeChild = createFakeChildProcess();
      (spawnMock as ReturnType<typeof vi.fn>).mockReturnValue(fakeChild);
    });



    it("creates a thread record in the DB", async () => {
      const project = createTestProject(projectRepo, { rootPath: "/test" });

      const result = await manager.spawn({ projectId: project.id });

      const thread = threadRepo.getById(result.id);
      expect(thread).toBeDefined();
      expect(thread?.projectId).toBe(project.id);
      expect(thread?.providerId).toBe("codex");
      expect(thread?.type).toBe("standard");
    });

    it("assigns the configured provider id to spawned threads", async () => {
      const piManager = new Orchestrator(
        threadRepo,
        eventRepo,
        projectRepo,
        ws,
        llmCompletionService,
        createPiProviderAdapter(),
        createTestRuntimeEnv(),
      );
      const project = createTestProject(projectRepo, { rootPath: "/test" });

      const result = await piManager.spawn({ projectId: project.id });

      const thread = threadRepo.getById(result.id);
      expect(thread).toBeDefined();
      expect(thread?.providerId).toBe("pi");
    });

    it("preserves the provider id from an injected provider controller", async () => {
      const piManager = new Orchestrator(
        threadRepo,
        eventRepo,
        projectRepo,
        ws,
        llmCompletionService,
        new ProviderSessionController({
          provider: createPiProviderAdapter(),
        }),
        createTestRuntimeEnv(),
      );
      const project = createTestProject(projectRepo, { rootPath: "/test" });

      const result = await piManager.spawn({ projectId: project.id });

      const thread = threadRepo.getById(result.id);
      expect(thread).toBeDefined();
      expect(thread?.providerId).toBe("pi");
      await expect(piManager.getProviderInfo()).resolves.toMatchObject({ id: "pi" });
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

      const project = createTestProject(projectRepo, { rootPath: "/test" });

      const result = await managerWithCustomEnvironment.spawn({
        projectId: project.id,
        environmentCreationArgs: { kind: "worktree" },
      });

      expect(result.id).toBeDefined();
      expect(onCreate).not.toHaveBeenCalled();
      await vi.waitFor(() => {
        expect(onCreate).toHaveBeenCalledTimes(1);
      });
    });

    it("emits env-setup started before optional setup finishes", async () => {
      const tempRoot = mkdtempSync(join(tmpdir(), "bb-orchestrator-env-setup-"));
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
        kind: "local",
        info,
        create(): IEnvironment {
          return makeRuntimeEnvironment({
            kind: "local",
            rootPath: workspaceRoot,
            overrides: {
              info,
              isIsolatedWorkspace() {
                return true;
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
              run: vi.fn().mockImplementation(async () => setupResult),
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

      const project = createTestProject(projectRepo, { rootPath: "/test" });

      try {
        const result = await managerWithCustomEnvironment.spawn({
          projectId: project.id,
          environmentCreationArgs: { kind: "worktree" },
        });
        const threadId = result.id;

        await vi.waitFor(() => {
          const events = eventRepo.listByThread(threadId);
          expect(events).toContainEqual(
            expect.objectContaining({
              threadId,
              type: "system/provisioning/env_setup",
              data: expect.objectContaining({
                reason: "thread-created",
                setup: expect.objectContaining({
                  status: "started",
                }),
                transcript: expect.arrayContaining([
                  expect.objectContaining({
                    key: "branch",
                    text: "on branch bb/thread-1 (abc123)",
                  }),
                ]),
              }),
            }),
          );
        });

        const eventsBeforeResolve = eventRepo.listByThread(threadId);
        const completedEvents = eventsBeforeResolve.filter(
          (e) => e.type === "system/provisioning/env_setup" &&
            (((e.data as Record<string, unknown>)?.setup as Record<string, unknown> | undefined)
              ?.status === "completed"),
        );
        expect(completedEvents).toHaveLength(0);

        resolveSetup?.({
          exitCode: 0,
          stdout: "",
          stderr: "",
        });

        await vi.waitFor(() => {
          const events = eventRepo.listByThread(threadId);
          expect(events).toContainEqual(
            expect.objectContaining({
              threadId,
              type: "system/provisioning/env_setup",
              data: expect.objectContaining({
                reason: "thread-created",
                setup: expect.objectContaining({
                  status: "completed",
                }),
                transcript: expect.arrayContaining([
                  expect.objectContaining({
                    key: "branch",
                    text: "on branch bb/thread-1 (abc123)",
                  }),
                ]),
              }),
            }),
          );
        });
      } finally {
        rmSync(tempRoot, { recursive: true, force: true });
      }
    });

    it("streams env-setup output while the setup script is still running", async () => {
      const tempRoot = mkdtempSync(join(tmpdir(), "bb-orchestrator-env-stream-"));
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
        kind: "local",
        info,
        create(): IEnvironment {
          return makeRuntimeEnvironment({
            kind: "local",
            rootPath: workspaceRoot,
            overrides: {
              info,
              isIsolatedWorkspace() {
                return true;
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
              run: vi.fn().mockImplementation(
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

      const project = createTestProject(projectRepo, { rootPath: "/test" });

      try {
        const result = await managerWithCustomEnvironment.spawn({
          projectId: project.id,
          environmentCreationArgs: { kind: "worktree" },
        });
        const threadId = result.id;

        await vi.waitFor(() => {
          const events = eventRepo.listByThread(threadId);
          expect(events).toContainEqual(
            expect.objectContaining({
              threadId,
              type: "system/provisioning/env_setup",
              data: expect.objectContaining({
                setup: expect.objectContaining({
                  status: "running",
                  output: "+ pnpm install",
                }),
              }),
            }),
          );
        });

        const events = eventRepo.listByThread(threadId);
        expect(events).toContainEqual(
          expect.objectContaining({
            threadId,
            type: "system/provisioning/env_setup",
            data: expect.objectContaining({
              setup: expect.objectContaining({
                status: "running",
                output: "warning: cache miss",
              }),
            }),
          }),
        );

        resolveSetup?.({
          exitCode: 0,
          stdout: "+ pnpm install\n",
          stderr: "warning: cache miss\n",
        });

        await vi.waitFor(() => {
          const allEvents = eventRepo.listByThread(threadId);
          expect(allEvents).toContainEqual(
            expect.objectContaining({
              threadId,
              type: "system/provisioning/env_setup",
              data: expect.objectContaining({
                setup: expect.objectContaining({
                  status: "completed",
                }),
              }),
            }),
          );
        });
      } finally {
        rmSync(tempRoot, { recursive: true, force: true });
      }
    });



    it("registers the process and starts provisioning after spawn", async () => {
      const project = createTestProject(projectRepo, { rootPath: "/test" });

      const result = await manager.spawn({
        projectId: project.id,
        input: [{ type: "text", text: "Start work" }],
      });

      // Thread should exist in DB
      const thread = threadRepo.getById(result.id);
      expect(thread).toBeDefined();
      expect(thread?.projectId).toBe(project.id);

      // Provisioning should start asynchronously
      await vi.waitFor(() => {
        const t = threadRepo.getById(result.id);
        expect(t?.status).not.toBe("created");
      });
    });

    it("updates thread status through provisioning and broadcasts", async () => {
      const project = createTestProject(projectRepo, { rootPath: "/test" });

      const result = await manager.spawn({
        projectId: project.id,
        input: [{ type: "text", text: "Start work" }],
      });
      await vi.waitFor(() => {
        const thread = threadRepo.getById(result.id);
        expect(thread?.status).toMatch(/provisioning|active/);
      });
      expect(ws.broadcast).toHaveBeenCalledWith("thread", result.id, [
        "status-changed",
        "work-status-changed",
        "events-appended",
      ]);
    });

    it("records the provisioning reason when spawning a thread", async () => {
      const project = createTestProject(projectRepo, { rootPath: "/test" });

      const result = await manager.spawn({
        projectId: project.id,
        input: [{ type: "text", text: "Start work" }],
      });

      await vi.waitFor(() => {
        const events = eventRepo.listByThread(result.id);
        expect(events).toContainEqual(
          expect.objectContaining({
            threadId: result.id,
            type: "system/provisioning/started",
            data: expect.objectContaining({
              reason: "thread-created",
            }),
          }),
        );
      });
    });

    it("does not auto-generate spawn titles from input", async () => {
      const project = createTestProject(projectRepo, { rootPath: "/test" });

      const result = await manager.spawn({
        projectId: project.id,
        input: [{ type: "text", text: "Fix flaky login redirect" }],
      });

      const thread = threadRepo.getById(result.id);
      expect(thread).toBeDefined();
      expect(thread?.projectId).toBe(project.id);
      expect(thread?.providerId).toBe("codex");
      expect(thread?.type).toBe("standard");
      expect(thread?.title).toBeUndefined();
    });

    it("defaults manager-managed spawned threads to the worktree environment", async () => {
      const project = createTestProject(projectRepo, { rootPath: "/test" });
      const managerThread = createTestThread(threadRepo, project.id, {
        type: "manager",
      });

      const result = await manager.spawn({
        projectId: project.id,
        parentThreadId: managerThread.id,
      });

      const thread = threadRepo.getById(result.id);
      expect(thread).toBeDefined();
      expect(thread?.projectId).toBe(project.id);
      expect(thread?.providerId).toBe("codex");
      expect(thread?.parentThreadId).toBe(managerThread.id);
      expect(thread?.type).toBe("standard");
    });

    it("returns prompt-derived title fallback when spawned without an explicit title", async () => {
      const project = createTestProject(projectRepo, { rootPath: "/test" });

      const result = await manager.spawn({
        projectId: project.id,
        input: [{ type: "text", text: "Fix flaky login redirect" }],
      });

      expect(result.title).toBeUndefined();
      expect(result.titleFallback).toBe("Fix flaky login redirect");
    });







    it("persists initial input on outbound client/thread/start events", async () => {
      const project = createTestProject(projectRepo, { rootPath: "/test" });

      const input = [{ type: "text", text: "Fix provisioning status UI" }] as const;
      const result = await manager.spawn({ projectId: project.id, input: [...input] });

      await vi.waitFor(() => {
        const events = eventRepo.listByThread(result.id);
        expect(events).toContainEqual(
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
      await expect(
        manager.spawn({ projectId: "bad-proj" }),
      ).rejects.toThrow("Project bad-proj not found");

      expect(spawnMock).not.toHaveBeenCalled();
    });

    it("returns the created thread record immediately after spawn", async () => {
      const project = createTestProject(projectRepo, { rootPath: "/test" });

      const result = await manager.spawn({ projectId: project.id });

      expect(result.id).toBeDefined();
      expect(result.projectId).toBe(project.id);
    });

    it("marks thread provisioning_failed if spawn setup errors", async () => {
      const project = createTestProject(projectRepo, { rootPath: "/test" });

      // Make spawn throw
      (spawnMock as ReturnType<typeof vi.fn>).mockImplementation(() => {
        throw new Error("ENOENT: codex not found");
      });

      const result = await manager.spawn({ projectId: project.id });
      await vi.waitFor(() => {
        const thread = threadRepo.getById(result.id);
        expect(thread?.status).toBe("provisioning_failed");
      });

      expect(ws.broadcast).toHaveBeenCalledWith("thread", result.id, [
        "status-changed",
        "work-status-changed",
      ]);
    });

    it("records client/thread/start first and preserves input when spawn setup fails", async () => {
      const project = createTestProject(projectRepo, { rootPath: "/test" });
      const input = [{ type: "text", text: "Fix the provisioning crash" }] as const;

      (spawnMock as ReturnType<typeof vi.fn>).mockImplementation(() => {
        throw new Error("ENOENT: codex not found");
      });

      const result = await manager.spawn({ projectId: project.id, input: [...input] });
      expect(result.titleFallback).toBe("Fix the provisioning crash");

      await vi.waitFor(() => {
        const thread = threadRepo.getById(result.id);
        expect(thread?.status).toBe("provisioning_failed");
      });

      const events = eventRepo.listByThread(result.id);
      expect(events).toContainEqual(
        expect.objectContaining({
          type: "client/thread/start",
          data: expect.objectContaining({
            input,
          }),
        }),
      );
      // client/thread/start should be the first event
      expect(events[0]?.type).toBe("client/thread/start");
    });

    it("rejects parent thread from a different project on spawn", async () => {
      const project = createTestProject(projectRepo, { rootPath: "/test" });
      const project2 = createTestProject(projectRepo, { rootPath: "/test2", name: "project-2" });
      const parentThread = createTestThread(threadRepo, project2.id, {
        type: "manager",
        status: "idle",
      });

      await expect(
        manager.spawn({ projectId: project.id, parentThreadId: parentThread.id }),
      ).rejects.toThrow("Parent thread must belong to the same project");
    });

    it("does not notify parent thread for non-completion lifecycle events", async () => {
      const project = createTestProject(projectRepo, { rootPath: "/test" });
      const parentThread = createTestThread(threadRepo, project.id, {
        type: "manager",
        status: "idle",
      });

      const systemTellSpy = vi.spyOn(manager, "systemTell").mockResolvedValue();

      await manager.spawn({ projectId: project.id, parentThreadId: parentThread.id });

      fakeChild._pushStdout(
        JSON.stringify({
          method: "turn/started",
          params: { turnId: "turn-child-1" },
        }),
      );
      await new Promise((r) => setTimeout(r, 50));

      expect(systemTellSpy).not.toHaveBeenCalled();
    });

    it("rejects non-manager parent threads on spawn", async () => {
      const project = createTestProject(projectRepo, { rootPath: "/test" });
      const parentThread = createTestThread(threadRepo, project.id, {
        type: "standard",
        status: "idle",
      });

      await expect(
        manager.spawn({ projectId: project.id, parentThreadId: parentThread.id }),
      ).rejects.toThrow("Parent thread must be a manager thread");
    });

    it("rejects manager threads with a parent thread", async () => {
      const project = createTestProject(projectRepo, { rootPath: "/test" });

      await expect(
        manager.spawn({
          projectId: project.id,
          type: "manager",
          parentThreadId: "parent-1",
        }),
      ).rejects.toThrow("Manager threads cannot be managed by a parent thread");
    });



    it("does not overwrite explicit spawn title from thread/name/updated", async () => {
      const project = createTestProject(projectRepo, { rootPath: "/test" });

      const result = await manager.spawn({
        projectId: project.id,
        title: "Pinned custom title",
      });

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

      const thread = threadRepo.getById(result.id);
      expect(thread?.title).toBe("Pinned custom title");
    });

    it("does not rename when thread already has an explicit spawn title", async () => {
      const project = createTestProject(projectRepo, { rootPath: "/test" });

      const result = await manager.spawn({
        projectId: project.id,
        title: "Fix flaky login redirect",
        input: [{ type: "text", text: "Fix flaky login redirect" }],
      });

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

      const thread = threadRepo.getById(result.id);
      expect(thread?.title).toBe("Fix flaky login redirect");
    });








  });

  describe("updateThread()", () => {
    let testDb: ReturnType<typeof createTestDb>;
    let project: ReturnType<typeof createTestProject>;

    beforeEach(() => {
      testDb = createTestDb();
      const repos = createTestRepos(testDb.db);
      threadRepo = repos.threadRepo;
      eventRepo = repos.eventRepo;
      projectRepo = repos.projectRepo;
      project = createTestProject(projectRepo, { rootPath: "/test" });
      manager = new Orchestrator(
        threadRepo, eventRepo, projectRepo, ws, llmCompletionService,
        undefined, createTestRuntimeEnv(),
      );
    });

    it("persists a merge-base branch override on the thread", () => {
      const thread = createTestThread(threadRepo, project.id, { status: "idle" });

      const result = manager.updateThread(thread.id, {
        mergeBaseBranch: "release/1.0",
      });

      const persisted = threadRepo.getById(thread.id);
      expect(persisted?.mergeBaseBranch).toBe("release/1.0");
      expect(ws.broadcast).toHaveBeenCalledWith("thread", thread.id, [
        "work-status-changed",
      ]);
      expect(result.mergeBaseBranch).toBe("release/1.0");
    });

    it("clears the merge-base branch override when null is provided", () => {
      const thread = createTestThread(threadRepo, project.id, { status: "idle" });
      threadRepo.update(thread.id, { mergeBaseBranch: "release/1.0" });

      const result = manager.updateThread(thread.id, {
        mergeBaseBranch: null,
      });

      const persisted = threadRepo.getById(thread.id);
      expect(persisted?.mergeBaseBranch).toBeUndefined();
      expect(result.mergeBaseBranch).toBeUndefined();
    });

    it("updates parentThreadId when assigning a managed parent", () => {
      const thread = createTestThread(threadRepo, project.id, { type: "standard", status: "idle" });
      const parentThread = createTestThread(threadRepo, project.id, { type: "manager", status: "idle" });
      vi.spyOn(manager, "systemTell").mockResolvedValue();

      const result = manager.updateThread(thread.id, {
        parentThreadId: parentThread.id,
      });

      const persisted = threadRepo.getById(thread.id);
      expect(persisted?.parentThreadId).toBe(parentThread.id);
      expect(result.parentThreadId).toBe(parentThread.id);
    });

    it("notifies the new manager when a thread is assigned", () => {
      const thread = createTestThread(threadRepo, project.id, {
        type: "standard", status: "idle", title: "Implement feature",
      });
      const parentThread = createTestThread(threadRepo, project.id, { type: "manager", status: "idle" });
      const systemTellSpy = vi.spyOn(manager, "systemTell").mockResolvedValue();

      manager.updateThread(thread.id, {
        parentThreadId: parentThread.id,
      });

      expect(systemTellSpy).toHaveBeenCalledWith(parentThread.id, {
        input: [
          {
            type: "text",
            text: expect.stringContaining("is now assigned to you for management"),
          },
        ],
      });
    });

    it("notifies the prior manager when a thread is taken back", () => {
      const parentThread = createTestThread(threadRepo, project.id, { type: "manager", status: "idle" });
      const thread = createTestThread(threadRepo, project.id, {
        type: "standard", status: "idle", title: "Implement feature",
        parentThreadId: parentThread.id,
      });
      const systemTellSpy = vi.spyOn(manager, "systemTell").mockResolvedValue();

      manager.updateThread(thread.id, {
        parentThreadId: null,
      });

      expect(systemTellSpy).toHaveBeenCalledWith(parentThread.id, {
        input: [
          {
            type: "text",
            text: expect.stringContaining("is no longer assigned to you"),
          },
        ],
      });
    });

    it("rejects assigning a non-manager parent on update", () => {
      const thread = createTestThread(threadRepo, project.id, { type: "standard", status: "idle" });
      const parentThread = createTestThread(threadRepo, project.id, { type: "standard", status: "idle" });

      expect(() =>
        manager.updateThread(thread.id, { parentThreadId: parentThread.id }),
      ).toThrow("Parent thread must be a manager thread");
    });

    it("rejects assigning an archived manager parent on update", () => {
      const thread = createTestThread(threadRepo, project.id, { type: "standard", status: "idle" });
      const parentThread = createTestThread(threadRepo, project.id, {
        type: "manager", status: "idle", archivedAt: 123,
      });

      expect(() =>
        manager.updateThread(thread.id, { parentThreadId: parentThread.id }),
      ).toThrow("Parent thread cannot be archived");
    });

    it("rejects assigning a parent to a manager thread", () => {
      const managerThread = createTestThread(threadRepo, project.id, { type: "manager", status: "idle" });

      expect(() =>
        manager.updateThread(managerThread.id, { parentThreadId: "thread-parent-1" }),
      ).toThrow("Manager threads cannot be managed by a parent thread");
    });
  });

  describe("messageUser()", () => {
    let testDb: ReturnType<typeof createTestDb>;
    let project: ReturnType<typeof createTestProject>;

    beforeEach(() => {
      testDb = createTestDb();
      const repos = createTestRepos(testDb.db);
      threadRepo = repos.threadRepo;
      eventRepo = repos.eventRepo;
      projectRepo = repos.projectRepo;
      project = createTestProject(projectRepo, { rootPath: "/test" });
      manager = new Orchestrator(
        threadRepo, eventRepo, projectRepo, ws, llmCompletionService,
        undefined, createTestRuntimeEnv(),
      );
    });

    it("appends a manager user message event", async () => {
      const managerThread = createTestThread(threadRepo, project.id, { type: "manager", status: "idle" });

      await manager.messageUser(managerThread.id, {
        text: "  Hello from the manager.  ",
        toolCallId: "call-1",
        turnId: "turn-1",
      });

      const events = eventRepo.listByThread(managerThread.id);
      expect(events).toContainEqual(expect.objectContaining({
        threadId: managerThread.id,
        type: "system/manager/user_message",
        data: {
          text: "Hello from the manager.",
          toolCallId: "call-1",
          turnId: "turn-1",
        },
      }));
      expect(ws.broadcast).toHaveBeenCalledWith("thread", managerThread.id, [
        "events-appended",
      ]);
    });

    it("rejects non-manager threads", async () => {
      const thread = createTestThread(threadRepo, project.id, { type: "standard", status: "idle" });

      await expect(
        manager.messageUser(thread.id, { text: "Hello" }),
      ).rejects.toThrow("Only manager threads can publish user messages");
    });
  });

  describe("tell()", () => {
    let testDb: ReturnType<typeof createTestDb>;
    let project: ReturnType<typeof createTestProject>;

    beforeEach(() => {
      testDb = createTestDb();
      const repos = createTestRepos(testDb.db);
      threadRepo = repos.threadRepo;
      eventRepo = repos.eventRepo;
      projectRepo = repos.projectRepo;
      project = createTestProject(projectRepo, { rootPath: "/test" });
      manager = new Orchestrator(
        threadRepo, eventRepo, projectRepo, ws, llmCompletionService,
        undefined, createTestRuntimeEnv(),
      );
    });

    it("throws if thread not found", async () => {
      await expect(
        manager.tell("nonexistent", { input: [{ type: "text", text: "hello" }] }),
      ).rejects.toThrow(
        "Thread nonexistent not found",
      );
    });

    it("reprovisions and accepts tell when thread is provisioning_failed", async () => {
      const input = [{ type: "text" as const, text: "Retry after fixing project path" }];
      const thread = createTestThread(threadRepo, project.id, { status: "provisioning_failed" });
      const scheduleProvisioningSpy = vi
        .spyOn(asOrchestratorHarness(manager), "_scheduleProvisioning")
        .mockImplementation(() => {});

      await expect(manager.tell(thread.id, { input })).resolves.toBeUndefined();

      expect(scheduleProvisioningSpy).toHaveBeenCalledWith(
        thread.id,
        expect.objectContaining({
          projectId: project.id,
          input,
        }),
        { reason: "tell-after-provisioning-failure" },
      );
    });

    it("acknowledges follow-ups at client turn requested before provider start completes", async () => {
      const thread = createTestThread(threadRepo, project.id, { status: "idle" });

      let resolveEnsureProviderSession: ((value: string) => void) | undefined;
      const ensureProviderSessionPromise = new Promise<string>((resolve) => {
        resolveEnsureProviderSession = resolve;
      });
      vi
        .spyOn(
          manager as unknown as {
            _ensureProviderSession: (threadId: string) => Promise<string>;
          },
          "_ensureProviderSession",
        )
        .mockReturnValue(ensureProviderSessionPromise);
      vi
        .spyOn(
          manager as unknown as {
            _sendTurnCommandWithStaleProviderRetry: (args: unknown) => Promise<string>;
          },
          "_sendTurnCommandWithStaleProviderRetry",
        )
        .mockResolvedValue("provider-thread-1");

      let settled = false;
      const tellPromise = manager
        .tell(thread.id, {
          input: [{ type: "text", text: "hello" }],
        })
        .finally(() => {
          settled = true;
        });

      await Promise.resolve();

      const threadAfterTell = threadRepo.getById(thread.id);
      expect(threadAfterTell?.status).toBe("active");
      const events = eventRepo.listByThread(thread.id);
      expect(events).toContainEqual(
        expect.objectContaining({
          threadId: thread.id,
          type: "client/turn/requested",
        }),
      );
      expect(ws.broadcast).toHaveBeenCalledWith("thread", thread.id, [
        "status-changed",
        "work-status-changed",
        "events-appended",
      ]);
      // client/turn/start should not yet be created (provider not started)
      expect(events).not.toContainEqual(
        expect.objectContaining({
          threadId: thread.id,
          type: "client/turn/start",
        }),
      );
      expect(settled).toBe(false);

      resolveEnsureProviderSession?.("provider-thread-1");
      await expect(tellPromise).resolves.toBeUndefined();

      const allEvents = eventRepo.listByThread(thread.id);
      expect(allEvents).toContainEqual(
        expect.objectContaining({
          threadId: thread.id,
          type: "client/turn/start",
        }),
      );
    });





    it("accepts the follow-up and records an error when no session can be resumed", async () => {
      const thread = createTestThread(threadRepo, project.id, { status: "active" });
      await expect(
        manager.tell(thread.id, { input: [{ type: "text", text: "hello" }] }),
      ).resolves.toBeUndefined();

      await Promise.resolve();

      const events = eventRepo.listByThread(thread.id);
      expect(events).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            threadId: thread.id,
            type: "client/turn/requested",
          }),
          expect.objectContaining({
            threadId: thread.id,
            type: "system/error",
          }),
        ]),
      );
      expect(ws.broadcast).toHaveBeenCalledWith("thread", thread.id, [
        "events-appended",
      ]);
    });

    it("throws for empty tell payload object", async () => {
      await expect(manager.tell("thread-1", { input: [] })).rejects.toThrow(
        "Tell payload input must be non-empty",
      );
    });

    it("serializes concurrent tell calls for the same thread", async () => {
      const thread = createTestThread(threadRepo, project.id, { status: "idle" });

      const callOrder: string[] = [];
      let resolveFirst: (() => void) | undefined;
      const firstBlocked = new Promise<void>((resolve) => {
        resolveFirst = resolve;
      });

      vi.spyOn(
        manager as unknown as {
          _ensureProviderSession: (threadId: string) => Promise<string>;
        },
        "_ensureProviderSession",
      ).mockImplementation(async () => {
        callOrder.push("ensureSession");
        if (callOrder.filter((c) => c === "ensureSession").length === 1) {
          await firstBlocked;
        }
        return "provider-thread-1";
      });
      vi.spyOn(
        manager as unknown as {
          _sendTurnCommandWithStaleProviderRetry: (args: unknown) => Promise<string>;
        },
        "_sendTurnCommandWithStaleProviderRetry",
      ).mockResolvedValue("provider-thread-1");

      const tell1 = manager.tell(thread.id, {
        input: [{ type: "text", text: "first" }],
      });
      const tell2 = manager.tell(thread.id, {
        input: [{ type: "text", text: "second" }],
      });

      // Give microtasks a chance to settle
      await new Promise((r) => setImmediate(r));

      // If calls are serialized, only the first should have reached
      // _ensureProviderSession so far
      expect(callOrder.filter((c) => c === "ensureSession").length).toBe(1);

      // Unblock the first call
      resolveFirst!();
      await tell1;
      await tell2;

      // Both should have completed, but sequentially
      expect(callOrder.filter((c) => c === "ensureSession").length).toBe(2);
    });






  });

  describe("stop()", () => {
    let testDb: ReturnType<typeof createTestDb>;
    let project: ReturnType<typeof createTestProject>;
    let environmentRepo: InstanceType<typeof EnvironmentRepository>;

    beforeEach(() => {
      testDb = createTestDb();
      const repos = createTestRepos(testDb.db);
      threadRepo = repos.threadRepo;
      eventRepo = repos.eventRepo;
      projectRepo = repos.projectRepo;
      environmentRepo = repos.environmentRepo;
      project = createTestProject(projectRepo, { rootPath: "/test" });
      manager = new Orchestrator(
        threadRepo, eventRepo, projectRepo, ws, llmCompletionService,
        undefined, createTestRuntimeEnv(),
      );
    });

    it("updates status to idle and broadcasts when no active process", () => {
      const thread = createTestThread(threadRepo, project.id, { status: "active" });

      manager.stop(thread.id);

      const events = eventRepo.listByThread(thread.id);
      expect(events).toContainEqual(
        expect.objectContaining({
          threadId: thread.id,
          type: "system/thread/interrupted",
          data: {
            reason: "user",
          },
        }),
      );
      const updated = threadRepo.getById(thread.id);
      expect(updated?.status).toBe("idle");
      expect(ws.broadcast).toHaveBeenCalledWith("thread", thread.id, [
        "status-changed",
        "work-status-changed",
      ]);
    });

    it("does not append interruption events for threads that are already idle", () => {
      const thread = createTestThread(threadRepo, project.id, { status: "idle" });

      manager.stop(thread.id);

      const events = eventRepo.listByThread(thread.id);
      const interruptionEvents = events.filter(
        (e) => e.type === "system/thread/interrupted",
      );
      expect(interruptionEvents).toHaveLength(0);
    });


    it("suspends managed environments on stop without destroying the workspace", () => {
      const suspendEnvironmentRuntime = vi.spyOn(
        (asOrchestratorHarness(manager) as unknown as {
          environmentService: {
            suspendEnvironmentRuntime: (threadId: string) => void;
            destroyEnvironmentRuntime: (threadId: string) => void;
          };
        }).environmentService,
        "suspendEnvironmentRuntime",
      );
      const destroyEnvironmentRuntime = vi.spyOn(
        (asOrchestratorHarness(manager) as unknown as {
          environmentService: {
            suspendEnvironmentRuntime: (threadId: string) => void;
            destroyEnvironmentRuntime: (threadId: string) => void;
          };
        }).environmentService,
        "destroyEnvironmentRuntime",
      );
      const stopWatchingWorkspaceStatus = vi.fn();
      asOrchestratorHarness(manager).environmentRuntimes.set("thread-1", {
        environment: makeRuntimeEnvironment({
          rootPath: "/tmp/worktree",
          cleanup: vi.fn(),
        }),
        agentConnectionTarget: {
          transport: "http",
          baseUrl: "http://127.0.0.1:4312",
        },
        stopWatchingWorkspaceStatus,
      });

      manager.stop("thread-1");

      expect(suspendEnvironmentRuntime).toHaveBeenCalledWith("thread-1");
      expect(destroyEnvironmentRuntime).not.toHaveBeenCalled();
      expect(stopWatchingWorkspaceStatus).toHaveBeenCalledTimes(1);
    });

    it("suspends managed environments when threads become idle", async () => {
      const env = environmentRepo.create({
        projectId: project.id,
        descriptor: { type: "path", path: "/tmp/env" },
        managed: true,
      });
      const thread = createTestThread(threadRepo, project.id, {
        status: "active",
        environmentId: env.id,
      });
      vi.spyOn(
        manager as unknown as {
          _scheduleQueuedFollowUpDispatch: (threadId: string) => void;
        },
        "_scheduleQueuedFollowUpDispatch",
      ).mockImplementation(() => {});

      const cleanup = vi.fn();
      const stopWatchingWorkspaceStatus = vi.fn();
      asOrchestratorHarness(manager).environmentRuntimes.set(`thread:${thread.id}`, {
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
      })._setThreadStatus(thread.id, "idle");

      expect(cleanup).toHaveBeenCalledTimes(1);
      expect(stopWatchingWorkspaceStatus).toHaveBeenCalledTimes(1);
      expect(asOrchestratorHarness(manager).environmentRuntimes.has(`thread:${thread.id}`)).toBe(false);
    });

    it("keeps managed environments alive when threads become idle with queued follow-up messages", async () => {
      const env = environmentRepo.create({
        projectId: project.id,
        descriptor: { type: "path", path: "/tmp/env" },
        managed: true,
      });
      const thread = createTestThread(threadRepo, project.id, {
        status: "active",
        environmentId: env.id,
      });
      // Enqueue a follow-up message
      threadRepo.enqueueQueuedMessage(thread.id, {
        input: [{ type: "text", text: "keep going" }],
        reasoningLevel: "medium",
        sandboxMode: "danger-full-access",
      });
      vi.spyOn(
        manager as unknown as {
          _scheduleQueuedFollowUpDispatch: (threadId: string) => void;
        },
        "_scheduleQueuedFollowUpDispatch",
      ).mockImplementation(() => {});

      const cleanup = vi.fn();
      const stopWatchingWorkspaceStatus = vi.fn();
      asOrchestratorHarness(manager).environmentRuntimes.set(`thread:${thread.id}`, {
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
      })._setThreadStatus(thread.id, "idle");

      expect(cleanup).not.toHaveBeenCalled();
      expect(stopWatchingWorkspaceStatus).not.toHaveBeenCalled();
      expect(asOrchestratorHarness(manager).environmentRuntimes.has(`thread:${thread.id}`)).toBe(true);
    });

  });

  describe("archive()", () => {
    let testDb: ReturnType<typeof createTestDb>;
    let project: ReturnType<typeof createTestProject>;

    beforeEach(() => {
      testDb = createTestDb();
      const repos = createTestRepos(testDb.db);
      threadRepo = repos.threadRepo;
      eventRepo = repos.eventRepo;
      projectRepo = repos.projectRepo;
      project = createTestProject(projectRepo, { rootPath: "/test" });
      manager = new Orchestrator(
        threadRepo, eventRepo, projectRepo, ws, llmCompletionService,
        undefined, createTestRuntimeEnv(),
      );
    });

    it("marks a thread archived and broadcasts when no active process", async () => {
      const thread = createTestThread(threadRepo, project.id, { status: "idle" });

      await manager.archive(thread.id);

      const updated = threadRepo.getById(thread.id);
      expect(updated?.status).toBe("idle");
      expect(updated?.archivedAt).toBeTypeOf("number");
      expect(ws.broadcast).toHaveBeenCalledWith("thread", thread.id, [
        "status-changed",
        "work-status-changed",
        "archived-changed",
      ]);
    });


    it("destroys workspace environment on archive", async () => {
      const cleanup = vi.fn();
      const thread = createTestThread(threadRepo, project.id, { status: "idle" });
      asOrchestratorHarness(manager).environmentRuntimes.set(`thread:${thread.id}`, {
        environment: makeRuntimeEnvironment({
          rootPath: "/tmp/worktree",
          cleanup,
        }),
      });

      await manager.archive(thread.id);

      expect(cleanup).toHaveBeenCalledTimes(1);
    });

    it("archives worktree threads even when no runtime is active", async () => {
      const environmentRepo = new EnvironmentRepository(testDb.db);
      const env = environmentRepo.create({
        projectId: project.id,
        descriptor: { type: "path", path: "/tmp/env" },
        managed: true,
      });
      const thread = createTestThread(threadRepo, project.id, {
        status: "idle",
        environmentId: env.id,
      });
      eventRepo.create({
        threadId: thread.id,
        seq: 1,
        type: "system/provisioning/completed",
        data: {
          transcript: [{ key: "environment", text: "environment: Worktree" }],
        },
      });

      await manager.archive(thread.id);

      const updated = threadRepo.getById(thread.id);
      expect(updated?.status).toBe("idle");
      expect(updated?.archivedAt).toBeTypeOf("number");
    });

    it("preserves attached environment state on archive so unarchive can reprovision", async () => {
      const environmentRepo = new EnvironmentRepository(testDb.db);
      const attachmentRepo = new ThreadEnvironmentAttachmentRepository(testDb.db);
      const env = environmentRepo.create({
        projectId: project.id,
        descriptor: { type: "path", path: "/tmp/env" },
        managed: true,
      });
      const thread = createTestThread(threadRepo, project.id, {
        status: "idle",
        environmentId: env.id,
      });
      attachmentRepo.attachThread({ threadId: thread.id, environmentId: env.id });
      manager = new Orchestrator(
        threadRepo,
        eventRepo,
        projectRepo,
        ws,
        llmCompletionService,
        undefined,
        createTestRuntimeEnv(),
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        environmentRepo as never,
        attachmentRepo as never,
      );

      await manager.archive(thread.id);

      expect(attachmentRepo.getByThreadId(thread.id)?.environmentId).toBe(env.id);
      expect(environmentRepo.getById(env.id)).toBeTruthy();
    });

    it("rebroadcasts work status after async workspace cleanup settles", async () => {
      let resolveCleanup: (() => void) | undefined;
      const cleanup = vi.fn(
        () =>
          new Promise<void>((resolve) => {
            resolveCleanup = resolve;
          }),
      );
      const environmentRepo = new EnvironmentRepository(testDb.db);
      const env = environmentRepo.create({
        projectId: project.id,
        descriptor: { type: "path", path: "/tmp/env" },
        managed: true,
      });
      const thread = createTestThread(threadRepo, project.id, {
        status: "idle",
        environmentId: env.id,
      });
      asOrchestratorHarness(manager).environmentRuntimes.set(`thread:${thread.id}`, {
        environment: makeRuntimeEnvironment({
          rootPath: "/tmp/worktree",
          cleanup,
        }),
      });

      const archivePromise = manager.archive(thread.id);

      expect(resolveCleanup).toBeTypeOf("function");
      expect((ws.broadcast as ReturnType<typeof vi.fn>).mock.calls.at(0)).toEqual([
        "thread",
        thread.id,
        ["status-changed", "work-status-changed", "archived-changed"],
      ]);
      expect(ws.broadcast).not.toHaveBeenCalledWith("thread", thread.id, [
        "work-status-changed",
      ]);

      resolveCleanup?.();
      await archivePromise;

      expect(ws.broadcast).toHaveBeenCalledWith("thread", thread.id, [
        "work-status-changed",
      ]);
      expect((ws.broadcast as ReturnType<typeof vi.fn>).mock.calls.at(-1)).toEqual([
        "thread",
        thread.id,
        ["work-status-changed"],
      ]);
    });

    it("reports cleanup failures without rejecting archive", async () => {
      const cleanup = vi.fn(() => {
        throw new Error("cleanup failed");
      });
      const thread = createTestThread(threadRepo, project.id, {
        status: "active",
      });

      const harness = asOrchestratorHarness(manager);
      harness.environmentRuntimes.set(`thread:${thread.id}`, {
        environment: makeRuntimeEnvironment({
          rootPath: "/tmp/worktree",
          cleanup,
        }),
      });
      harness.providerThreadIds.set(thread.id, "provider-thread-1");
      harness.primaryPromotionByProjectId.set(project.id, {
        projectId: project.id,
        environmentId: thread.environmentId ?? thread.id,
        threadId: thread.id,
      });

      await expect(manager.archive(thread.id)).resolves.toBeUndefined();

      expect(harness.environmentRuntimes.has(`thread:${thread.id}`)).toBe(false);
      expect(harness.providerThreadIds.has(thread.id)).toBe(false);
      expect(harness.primaryPromotionByProjectId.has(project.id)).toBe(false);
      const updated = threadRepo.getById(thread.id);
      expect(updated?.status).toBe("idle");
      expect(updated?.archivedAt).toBeTypeOf("number");
    });
  });

  describe("unarchive()", () => {
    let testDb: ReturnType<typeof createTestDb>;
    let project: ReturnType<typeof createTestProject>;

    beforeEach(() => {
      testDb = createTestDb();
      const repos = createTestRepos(testDb.db);
      threadRepo = repos.threadRepo;
      eventRepo = repos.eventRepo;
      projectRepo = repos.projectRepo;
      project = createTestProject(projectRepo, { rootPath: "/test" });
      manager = new Orchestrator(
        threadRepo, eventRepo, projectRepo, ws, llmCompletionService,
        undefined, createTestRuntimeEnv(),
      );
    });

    it("clears archived timestamp and broadcasts", () => {
      const thread = createTestThread(threadRepo, project.id, { status: "idle", archivedAt: 1234 });

      manager.unarchive(thread.id);

      const updated = threadRepo.getById(thread.id);
      expect(updated?.archivedAt).toBeUndefined();
      expect(ws.broadcast).toHaveBeenCalledWith("thread", thread.id, [
        "archived-changed",
      ]);
    });

    it("does nothing when thread is not archived", () => {
      const thread = createTestThread(threadRepo, project.id, { status: "idle" });

      manager.unarchive(thread.id);

      expect(ws.broadcast).not.toHaveBeenCalled();
    });
  });

  describe("tell() archived threads", () => {
    let testDb: ReturnType<typeof createTestDb>;
    let project: ReturnType<typeof createTestProject>;

    beforeEach(() => {
      testDb = createTestDb();
      const repos = createTestRepos(testDb.db);
      threadRepo = repos.threadRepo;
      eventRepo = repos.eventRepo;
      projectRepo = repos.projectRepo;
      project = createTestProject(projectRepo, { rootPath: "/test" });
      manager = new Orchestrator(
        threadRepo, eventRepo, projectRepo, ws, llmCompletionService,
        undefined, createTestRuntimeEnv(),
      );
    });

    it("rejects tells for archived threads", async () => {
      const thread = createTestThread(threadRepo, project.id, { status: "idle", archivedAt: 1234 });

      await expect(
        manager.tell(thread.id, {
          input: [{ type: "text", text: "hello" }],
        }),
      ).rejects.toThrow(`Thread ${thread.id} is archived`);
    });
  });

  describe("getEvents()", () => {
    let testDb: ReturnType<typeof createTestDb>;
    let project: ReturnType<typeof createTestProject>;

    beforeEach(() => {
      testDb = createTestDb();
      const repos = createTestRepos(testDb.db);
      threadRepo = repos.threadRepo;
      eventRepo = repos.eventRepo;
      projectRepo = repos.projectRepo;
      project = createTestProject(projectRepo, { rootPath: "/test" });
      manager = new Orchestrator(
        threadRepo, eventRepo, projectRepo, ws, llmCompletionService,
        undefined, createTestRuntimeEnv(),
      );
    });

    it("returns raw persisted events", () => {
      const thread = createTestThread(threadRepo, project.id, { status: "idle" });
      eventRepo.create({ threadId: thread.id, seq: 1, type: "turn/started", data: createTurnStartedData(thread.id, "turn-1") });
      eventRepo.create({ threadId: thread.id, seq: 2, type: "turn/completed", data: createTurnCompletedData(thread.id, "turn-1") });

      const result = manager.getEvents(thread.id, 0);

      expect(result).toHaveLength(2);
      expect(result[0]).toMatchObject({ threadId: thread.id, seq: 1, type: "turn/started" });
      expect(result[1]).toMatchObject({ threadId: thread.id, seq: 2, type: "turn/completed" });
    });

    it("returns all events when afterSeq is not provided", () => {
      const thread = createTestThread(threadRepo, project.id, { status: "idle" });

      const result = manager.getEvents(thread.id);

      expect(result).toHaveLength(0);
    });
  });

  describe("listModels()", () => {
    let testDb: ReturnType<typeof createTestDb>;
    let project: ReturnType<typeof createTestProject>;

    beforeEach(() => {
      testDb = createTestDb();
      const repos = createTestRepos(testDb.db);
      threadRepo = repos.threadRepo;
      eventRepo = repos.eventRepo;
      projectRepo = repos.projectRepo;
      project = createTestProject(projectRepo, { rootPath: "/test" });
      manager = new Orchestrator(
        threadRepo, eventRepo, projectRepo, ws, llmCompletionService,
        undefined, createTestRuntimeEnv(),
      );
    });

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
    let testDb: ReturnType<typeof createTestDb>;
    let project: ReturnType<typeof createTestProject>;

    beforeEach(() => {
      testDb = createTestDb();
      const repos = createTestRepos(testDb.db);
      threadRepo = repos.threadRepo;
      eventRepo = repos.eventRepo;
      projectRepo = repos.projectRepo;
      project = createTestProject(projectRepo, { rootPath: "/test" });
      manager = new Orchestrator(
        threadRepo, eventRepo, projectRepo, ws, llmCompletionService,
        undefined, createTestRuntimeEnv(),
      );
    });

    it("extracts text from last item/completed agentMessage event", () => {
      const thread = createTestThread(threadRepo, project.id, { status: "idle" });
      eventRepo.create({ threadId: thread.id, seq: 1, type: "turn/started", data: createTurnStartedData(thread.id) });
      eventRepo.create({ threadId: thread.id, seq: 2, type: "item/completed", data: createItemCompletedData({ threadId: thread.id, turnId: "turn-1", item: createAgentMessageItem("Final output") }) });

      expect(manager.getOutput(thread.id)).toBe("Final output");
    });

    it("ignores item/completed events that are not agentMessage type", () => {
      const thread = createTestThread(threadRepo, project.id, { status: "idle" });
      eventRepo.create({ threadId: thread.id, seq: 1, type: "item/completed", data: createItemCompletedData({ threadId: thread.id, turnId: "turn-1", item: { type: "plan", id: "plan-1", text: "Run bash" } }) });

      expect(manager.getOutput(thread.id)).toBeUndefined();
    });

    it("returns undefined if no item/completed events", () => {
      const thread = createTestThread(threadRepo, project.id, { status: "idle" });
      eventRepo.create({ threadId: thread.id, seq: 1, type: "turn/started", data: createTurnStartedData(thread.id) });
      eventRepo.create({ threadId: thread.id, seq: 2, type: "turn/completed", data: createTurnCompletedData(thread.id) });

      expect(manager.getOutput(thread.id)).toBeUndefined();
    });

    it("returns undefined for empty events list", () => {
      const thread = createTestThread(threadRepo, project.id, { status: "idle" });

      expect(manager.getOutput(thread.id)).toBeUndefined();
    });

    it("returns undefined when item has no text field", () => {
      const thread = createTestThread(threadRepo, project.id, { status: "idle" });
      eventRepo.create({
        threadId: thread.id,
        seq: 1,
        type: "item/completed",
        // Intentionally malformed persisted payload for defensive parsing coverage.
        data: {
          threadId: thread.id,
          turnId: "turn-1",
          item: { type: "agentMessage" },
        } as unknown as ThreadEventDataForType<"item/completed">,
      });

      expect(manager.getOutput(thread.id)).toBeUndefined();
    });

    it("returns undefined when item.text is not a string", () => {
      const thread = createTestThread(threadRepo, project.id, { status: "idle" });
      eventRepo.create({
        threadId: thread.id,
        seq: 1,
        type: "item/completed",
        // Intentionally malformed persisted payload for defensive parsing coverage.
        data: {
          threadId: thread.id,
          turnId: "turn-1",
          item: { type: "agentMessage", id: "assistant-1", text: 42 },
        } as unknown as ThreadEventDataForType<"item/completed">,
      });

      expect(manager.getOutput(thread.id)).toBeUndefined();
    });

    it("returns text from the LAST agentMessage item/completed event when multiple exist", () => {
      const thread = createTestThread(threadRepo, project.id, { status: "idle" });
      eventRepo.create({ threadId: thread.id, seq: 1, type: "item/completed", data: createItemCompletedData({ threadId: thread.id, turnId: "turn-1", item: createAgentMessageItem("First output", "assistant-1") }) });
      eventRepo.create({ threadId: thread.id, seq: 2, type: "turn/started", data: createTurnStartedData(thread.id) });
      eventRepo.create({ threadId: thread.id, seq: 3, type: "item/completed", data: createItemCompletedData({ threadId: thread.id, turnId: "turn-1", item: createAgentMessageItem("Latest output", "assistant-2") }) });

      expect(manager.getOutput(thread.id)).toBe("Latest output");
    });
  });

  describe("getHydratedByIdAsync()", () => {
    let testDb: ReturnType<typeof createTestDb>;
    let project: ReturnType<typeof createTestProject>;

    beforeEach(() => {
      testDb = createTestDb();
      const repos = createTestRepos(testDb.db);
      threadRepo = repos.threadRepo;
      eventRepo = repos.eventRepo;
      projectRepo = repos.projectRepo;
      project = createTestProject(projectRepo, { rootPath: "/test" });
      manager = new Orchestrator(
        threadRepo, eventRepo, projectRepo, ws, llmCompletionService,
        undefined, createTestRuntimeEnv(),
      );
    });

    it("delegates to threadRepo", async () => {
      const thread = createTestThread(threadRepo, project.id, { status: "idle" });

      const result = await manager.getHydratedByIdAsync(thread.id);
      expect(result?.id).toBe(thread.id);
      expect(ws.broadcast).not.toHaveBeenCalled();
    });

    it("returns undefined for nonexistent thread", async () => {
      await expect(manager.getHydratedByIdAsync("nonexistent")).resolves.toBeUndefined();
    });

    it("includes prompt-derived title fallback when persisted title is missing", async () => {
      const thread = createTestThread(threadRepo, project.id, { status: "idle" });
      eventRepo.create({ threadId: thread.id, seq: 1, type: "client/thread/start", data: createClientStartData({ input: [{ type: "text", text: "Investigate flaky test reruns" }] }) });

      const result = await manager.getHydratedByIdAsync(thread.id);
      const resultSecondRead = await manager.getHydratedByIdAsync(thread.id);

      expect(result?.title).toBeUndefined();
      expect(result?.titleFallback).toBe("Investigate flaky test reruns");
      expect(resultSecondRead?.titleFallback).toBe("Investigate flaky test reruns");
    });

    it("returns persisted active status even when lifecycle events suggest completion", async () => {
      const thread = createTestThread(threadRepo, project.id, { status: "active" });
      eventRepo.create({ threadId: thread.id, seq: 1, type: "turn/started", data: createTurnStartedData(thread.id) });
      eventRepo.create({ threadId: thread.id, seq: 2, type: "turn/completed", data: createTurnCompletedData(thread.id) });

      const result = await manager.getHydratedByIdAsync(thread.id);

      expect(ws.broadcast).not.toHaveBeenCalled();
      expect(result?.status).toBe("active");
    });

    it("reconciles idle thread to idle when latest turn is started but no process exists", async () => {
      const thread = createTestThread(threadRepo, project.id, { status: "idle" });
      eventRepo.create({ threadId: thread.id, seq: 1, type: "turn/completed", data: createTurnCompletedData(thread.id) });
      eventRepo.create({ threadId: thread.id, seq: 2, type: "turn/started", data: createTurnStartedData(thread.id) });

      const result = await manager.getHydratedByIdAsync(thread.id);

      expect(ws.broadcast).not.toHaveBeenCalled();
      expect(result?.status).toBe("idle");
    });


    it("hydrates thread state through async workspace status when sync status is unavailable", async () => {
      const environmentRepo = new EnvironmentRepository(testDb.db);
      const env = environmentRepo.create({
        projectId: project.id,
        descriptor: { type: "path", path: "/tmp/env" },
        managed: true,
      });
      const thread = createTestThread(threadRepo, project.id, { status: "idle", environmentId: env.id });
      asOrchestratorHarness(manager).environmentRuntimes.set(`thread:${thread.id}`, {
        environment: makeRuntimeEnvironment({
          kind: "worktree",
          rootPath: "/tmp/worktrees/proj-1/thread-1",
          overrides: {
            async getWorkspaceStatus() {
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

      const result = await manager.getHydratedByIdAsync(thread.id);

      expect(result).toMatchObject({
        id: thread.id,
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
    let testDb: ReturnType<typeof createTestDb>;
    let project: ReturnType<typeof createTestProject>;

    beforeEach(() => {
      testDb = createTestDb();
      const repos = createTestRepos(testDb.db);
      threadRepo = repos.threadRepo;
      eventRepo = repos.eventRepo;
      projectRepo = repos.projectRepo;
      project = createTestProject(projectRepo, { rootPath: "/test" });
      manager = new Orchestrator(
        threadRepo, eventRepo, projectRepo, ws, llmCompletionService,
        undefined, createTestRuntimeEnv(),
      );
    });

    it("keeps worktree status unknown until provisioning completes", async () => {
      const envSetupWorkspaceRoot = "/tmp/worktrees/proj-1/thread-1";
      const customEnvironmentRegistry = createTestEnvironmentRegistry({
        rootPath: envSetupWorkspaceRoot,
      });
      const environmentRepo = new EnvironmentRepository(testDb.db);
      const env = environmentRepo.create({
        projectId: project.id,
        descriptor: { type: "path", path: "/tmp/env" },
        managed: true,
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
      const thread = createTestThread(threadRepo, project.id, {
        status: "provisioning_failed",
        title: "Provisioning failure repro",
        environmentId: env.id,
      });
      const mockedStatus = makeWorkspaceStatus();

      const result = await managerWithCustomEnvironment.getWorkStatusAsync(thread.id);

      expect(result).toBeUndefined();

      asOrchestratorHarness(managerWithCustomEnvironment).environmentRuntimes.set(`thread:${thread.id}`, {
        environment: makeRuntimeEnvironment({
          kind: "worktree",
          rootPath: envSetupWorkspaceRoot,
          overrides: {
            async getWorkspaceStatus() {
              return mockedStatus;
            },
          },
        }),
      });
      const resolvedResult = await managerWithCustomEnvironment.getWorkStatusAsync(thread.id);
      expect(resolvedResult).toStrictEqual(mockedStatus);
    });

    it("returns undefined while workspace cleanup removes the runtime", async () => {
      let resolveCleanup: (() => void) | undefined;
      const workspaceRoot = "/tmp/worktrees/proj-1/thread-1";
      mkdirSync(workspaceRoot, { recursive: true });
      const environmentRepo = new EnvironmentRepository(testDb.db);
      const env = environmentRepo.create({
        projectId: project.id,
        descriptor: { type: "path", path: "/tmp/env" },
        managed: true,
      });
      const thread = createTestThread(threadRepo, project.id, {
        status: "idle",
        environmentId: env.id,
      });
      eventRepo.create({ threadId: thread.id, seq: 1, type: "system/provisioning/completed", data: createEventData<"system/provisioning/completed">({ transcript: [{ key: "environment", text: "environment: Worktree" }] }) });
      asOrchestratorHarness(manager).environmentRuntimes.set(`thread:${thread.id}`, {
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

      const archivePromise = manager.archive(thread.id);
      const result = await manager.getWorkStatusAsync(thread.id);

      expect(result).toBeUndefined();

      resolveCleanup?.();
      await archivePromise;
    });

    it("uses the stored thread merge-base branch when no request override is provided", async () => {
      const getWorkspaceStatus = vi.fn(async (args?: { mergeBaseBranch?: string }) =>
        makeWorkspaceStatus({
          mergeBaseBranch: args?.mergeBaseBranch,
        })
      );
      const environmentRepo = new EnvironmentRepository(testDb.db);
      const env = environmentRepo.create({
        projectId: project.id,
        descriptor: { type: "path", path: "/tmp/env" },
        managed: true,
      });
      const thread = createTestThread(threadRepo, project.id, {
        status: "idle",
        environmentId: env.id,
      });
      threadRepo.update(thread.id, { mergeBaseBranch: "release/1.0" } as Partial<Thread>);
      asOrchestratorHarness(manager).environmentRuntimes.set(`thread:${thread.id}`, {
        environment: makeRuntimeEnvironment({
          kind: "worktree",
          rootPath: "/tmp/worktrees/proj-1/thread-1",
          overrides: {
            getWorkspaceStatus,
          },
        }),
      });

      const result = await manager.getWorkStatusAsync(thread.id);

      expect(getWorkspaceStatus).toHaveBeenCalledWith(
        expect.objectContaining({
          mergeBaseBranch: "release/1.0",
        }),
      );
      expect(result?.mergeBaseBranch).toBe("release/1.0");
    });
  });

  describe("deleteThread()", () => {
    let testDb: ReturnType<typeof createTestDb>;
    let project: ReturnType<typeof createTestProject>;

    beforeEach(() => {
      testDb = createTestDb();
      const repos = createTestRepos(testDb.db);
      threadRepo = repos.threadRepo;
      eventRepo = repos.eventRepo;
      projectRepo = repos.projectRepo;
      project = createTestProject(projectRepo, { rootPath: "/test" });
      manager = new Orchestrator(
        threadRepo, eventRepo, projectRepo, ws, llmCompletionService,
        undefined, createTestRuntimeEnv(),
      );
    });

    it("destroys managed artifacts before deleting thread rows", async () => {
      const cleanup = vi.fn();
      const thread = createTestThread(threadRepo, project.id, { status: "idle" });
      // Add an event so we can verify it gets deleted
      eventRepo.create({ threadId: thread.id, seq: 1, type: "turn/started", data: createTurnStartedData(thread.id) });
      asOrchestratorHarness(manager).environmentRuntimes.set(`thread:${thread.id}`, {
        environment: makeRuntimeEnvironment({
          rootPath: "/tmp/worktree",
          cleanup,
        }),
      });

      await manager.deleteThread(thread.id);

      expect(cleanup).toHaveBeenCalledTimes(1);
      expect(eventRepo.listByThread(thread.id)).toHaveLength(0);
      expect(threadRepo.getById(thread.id)).toBeUndefined();
      expect(ws.broadcast).toHaveBeenCalledWith("thread", thread.id, [
        "thread-deleted",
      ]);
    });

    it("preserves thread state when managed cleanup fails before deletion", async () => {
      const cleanup = vi.fn(() => {
        throw new Error("cleanup failed");
      });
      const thread = createTestThread(threadRepo, project.id, { status: "active" });
      // Add an event so we can verify it gets deleted
      eventRepo.create({ threadId: thread.id, seq: 1, type: "turn/started", data: createTurnStartedData(thread.id) });

      const harness = asOrchestratorHarness(manager);
      harness.environmentRuntimes.set(`thread:${thread.id}`, {
        environment: makeRuntimeEnvironment({
          rootPath: "/tmp/worktree",
          cleanup,
        }),
      });
      harness.providerThreadIds.set(thread.id, "provider-thread-1");

      await expect(manager.deleteThread(thread.id)).resolves.toBeUndefined();

      expect(harness.environmentRuntimes.has(`thread:${thread.id}`)).toBe(false);
      expect(harness.providerThreadIds.has(thread.id)).toBe(false);
      expect(eventRepo.listByThread(thread.id)).toHaveLength(0);
      expect(threadRepo.getById(thread.id)).toBeUndefined();
      expect(ws.broadcast).toHaveBeenCalledWith("thread", thread.id, [
        "thread-deleted",
      ]);
    });
  });

  describe("getGitDiffAsync()", () => {
    let testDb: ReturnType<typeof createTestDb>;
    let project: ReturnType<typeof createTestProject>;

    beforeEach(() => {
      testDb = createTestDb();
      const repos = createTestRepos(testDb.db);
      threadRepo = repos.threadRepo;
      eventRepo = repos.eventRepo;
      projectRepo = repos.projectRepo;
      project = createTestProject(projectRepo, { rootPath: "/tmp/proj-1" });
      manager = new Orchestrator(
        threadRepo, eventRepo, projectRepo, ws, llmCompletionService,
        undefined, createTestRuntimeEnv(),
      );
    });

    it("returns combined diffs when only async workspace status is available", async () => {
      const envRepo = new EnvironmentRepository(testDb.db);
      const env = envRepo.create({ projectId: project.id, descriptor: { type: "path", path: "/tmp/env" }, managed: true });
      const thread = createTestThread(threadRepo, project.id, { status: "idle", environmentId: env.id });
      asOrchestratorHarness(manager).environmentRuntimes.set(thread.id, {
        environment: makeRuntimeEnvironment({
          kind: "worktree",
          rootPath: "/tmp/worktrees/proj-1/thread-1",
          overrides: {
            async getWorkspaceStatus() {
              return makeWorkspaceStatus({
                hasCommittedUnmergedChanges: false,
                hasUncommittedChanges: false,
                aheadCount: 1,
                baseRef: "main",
              });
            },
            async listWorkspaceCommitsSinceRef() {
              return [
                {
                  sha: "abc123",
                  shortSha: "abc123",
                  subject: "squashed commit",
                },
              ];
            },
            async getWorkspaceDiff() {
              return { diff: "", truncated: false };
            },
          },
        }),
      });

      await expect(manager.getGitDiffAsync(thread.id)).resolves.toMatchObject({
        mode: "worktree_commits",
        selection: { type: "combined" },
      });
    });

    it("returns merge-base diffs for direct workspaces on non-default branches", async () => {
      const envRepo = new EnvironmentRepository(testDb.db);
      const env = envRepo.create({ projectId: project.id, descriptor: { type: "path", path: "/tmp/env" }, managed: true });
      const thread = createTestThread(threadRepo, project.id, { status: "idle", environmentId: env.id });
      const getWorkspaceDiff = vi.fn().mockResolvedValue({
        diff: "diff --git a/file b/file",
        truncated: false,
      });
      asOrchestratorHarness(manager).environmentRuntimes.set(thread.id, {
        environment: makeRuntimeEnvironment({
          kind: "local",
          rootPath: "/tmp/proj-1",
          overrides: {
            async getWorkspaceStatus() {
              return makeWorkspaceStatus({
                state: "committed_unmerged",
                hasCommittedUnmergedChanges: true,
                hasUncommittedChanges: false,
                aheadCount: 1,
                baseRef: "origin/main",
                mergeBaseBranch: "main",
              });
            },
            async listWorkspaceCommitsSinceRef() {
              return [
                {
                  sha: "abc123",
                  shortSha: "abc123",
                  subject: "feature commit",
                },
              ];
            },
            getWorkspaceDiff,
          },
        }),
      });

      await expect(manager.getGitDiffAsync(thread.id)).resolves.toMatchObject({
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
      expect(getWorkspaceDiff).toHaveBeenCalledWith({
        type: "combined",
        baseRef: "origin/main",
      });
    });

    it("suppresses combined diffs for squash-resolved clean worktrees", async () => {
      const envRepo = new EnvironmentRepository(testDb.db);
      const env = envRepo.create({ projectId: project.id, descriptor: { type: "path", path: "/tmp/env" }, managed: true });
      const thread = createTestThread(threadRepo, project.id, { status: "idle", environmentId: env.id });
      const getWorkspaceDiff = vi.fn().mockResolvedValue({
        diff: "diff --git a/file b/file",
        truncated: false,
      });
      const environment = makeRuntimeEnvironment({
        rootPath: "/tmp/worktrees/proj-1/thread-1",
        overrides: {
          async getWorkspaceStatus() {
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
          async listWorkspaceCommitsSinceRef() {
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

      asOrchestratorHarness(manager).environmentRuntimes.set(thread.id, {
        environment,
      });

      const result = await manager.getGitDiffAsync(thread.id);

      expect(result).toMatchObject({
        mode: "worktree_commits",
        selection: { type: "combined" },
        diff: "",
        truncated: false,
      });
      expect(getWorkspaceDiff).not.toHaveBeenCalled();
    });

    it("still returns commit diffs for explicit commit selection", async () => {
      const envRepo = new EnvironmentRepository(testDb.db);
      const env = envRepo.create({ projectId: project.id, descriptor: { type: "path", path: "/tmp/env" }, managed: true });
      const thread = createTestThread(threadRepo, project.id, { status: "idle", environmentId: env.id });
      const getWorkspaceDiff = vi.fn().mockResolvedValue({
        diff: "diff --git a/file b/file",
        truncated: false,
      });
      const environment = makeRuntimeEnvironment({
        rootPath: "/tmp/worktrees/proj-1/thread-1",
        overrides: {
          async getWorkspaceStatus() {
            return makeWorkspaceStatus({
              hasCommittedUnmergedChanges: false,
              hasUncommittedChanges: false,
              aheadCount: 1,
              baseRef: "main",
            });
          },
          async listWorkspaceCommitsSinceRef() {
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

      asOrchestratorHarness(manager).environmentRuntimes.set(thread.id, {
        environment,
      });

      const result = await manager.getGitDiffAsync(thread.id, {
        type: "commit",
        sha: "abc123",
      });

      expect(result.diff).toBe("diff --git a/file b/file");
      expect(getWorkspaceDiff).toHaveBeenCalledWith({
        type: "commit",
        commitSha: "abc123",
      });
    });

    it("prefers an explicit merge-base branch over the stored thread override", async () => {
      const getWorkspaceStatus = vi.fn(async (args?: { mergeBaseBranch?: string }) =>
        makeWorkspaceStatus({
          hasCommittedUnmergedChanges: true,
          hasUncommittedChanges: false,
          aheadCount: 1,
          baseRef: "origin/release/2.0",
          mergeBaseBranch: args?.mergeBaseBranch,
        })
      );
      const envRepo = new EnvironmentRepository(testDb.db);
      const env = envRepo.create({ projectId: project.id, descriptor: { type: "path", path: "/tmp/env" }, managed: true });
      const thread = createTestThread(threadRepo, project.id, { status: "idle", environmentId: env.id });
      threadRepo.update(thread.id, { mergeBaseBranch: "release/1.0" } as Partial<Thread>);
      asOrchestratorHarness(manager).environmentRuntimes.set(thread.id, {
        environment: makeRuntimeEnvironment({
          rootPath: "/tmp/worktrees/proj-1/thread-1",
          overrides: {
            getWorkspaceStatus,
            async listWorkspaceCommitsSinceRef() {
              return [];
            },
            async getWorkspaceDiff() {
              return { diff: "", truncated: false };
            },
          },
        }),
      });

      await manager.getGitDiffAsync(thread.id, { type: "combined" }, "release/2.0");

      expect(getWorkspaceStatus).toHaveBeenCalledWith(
        expect.objectContaining({
          mergeBaseBranch: "release/2.0",
        }),
      );
    });
  });

  describe("list()", () => {
    let testDb: ReturnType<typeof createTestDb>;
    let project: ReturnType<typeof createTestProject>;

    beforeEach(() => {
      testDb = createTestDb();
      const repos = createTestRepos(testDb.db);
      threadRepo = repos.threadRepo;
      eventRepo = repos.eventRepo;
      projectRepo = repos.projectRepo;
      project = createTestProject(projectRepo, { rootPath: "/test" });
      manager = new Orchestrator(
        threadRepo, eventRepo, projectRepo, ws, llmCompletionService,
        undefined, createTestRuntimeEnv(),
      );
    });

    it("delegates to threadRepo with filters", () => {
      const thread = createTestThread(threadRepo, project.id, { status: "idle" });

      const result = manager.list({ projectId: project.id });

      expect(result).toHaveLength(1);
      expect(result[0]?.id).toBe(thread.id);
      expect(ws.broadcast).not.toHaveBeenCalled();
    });

    it("includes prompt-derived title fallback for untitled threads", () => {
      const thread = createTestThread(threadRepo, project.id, { status: "idle" });
      eventRepo.create({ threadId: thread.id, seq: 1, type: "client/thread/start", data: createClientStartData({ input: [{ type: "text", text: "Stabilize flaky auth redirect tests" }] }) });

      const result = manager.list();
      const secondResult = manager.list();

      expect(result[0]?.title).toBeUndefined();
      expect(result[0]?.titleFallback).toBe("Stabilize flaky auth redirect tests");
      expect(secondResult[0]?.titleFallback).toBe("Stabilize flaky auth redirect tests");
    });

    it("returns persisted active list status even when lifecycle events suggest completion", () => {
      const thread = createTestThread(threadRepo, project.id, { status: "active" });
      eventRepo.create({ threadId: thread.id, seq: 1, type: "turn/completed", data: createTurnCompletedData(thread.id) });

      const result = manager.list();

      expect(ws.broadcast).not.toHaveBeenCalled();
      expect(result[0]?.status).toBe("active");
    });

    it("reconciles idle threads to idle when latest turn is started but no process exists", () => {
      const thread = createTestThread(threadRepo, project.id, { status: "idle" });
      eventRepo.create({ threadId: thread.id, seq: 1, type: "turn/completed", data: createTurnCompletedData(thread.id) });
      eventRepo.create({ threadId: thread.id, seq: 2, type: "turn/started", data: createTurnStartedData(thread.id) });

      const result = manager.list();

      expect(ws.broadcast).not.toHaveBeenCalled();
      expect(result[0]?.status).toBe("idle");
    });

  });

  describe("primary checkout status reconciliation", () => {
    let testDb: ReturnType<typeof createTestDb>;
    let project: ReturnType<typeof createTestProject>;
    let environmentRepo: ReturnType<typeof createTestRepos>["environmentRepo"];
    let attachmentRepo: ReturnType<typeof createTestRepos>["attachmentRepo"];

    beforeEach(() => {
      testDb = createTestDb();
      const repos = createTestRepos(testDb.db);
      threadRepo = repos.threadRepo;
      eventRepo = repos.eventRepo;
      projectRepo = repos.projectRepo;
      environmentRepo = repos.environmentRepo;
      attachmentRepo = repos.attachmentRepo;
      project = createTestProject(projectRepo, { rootPath: "/tmp/proj-1" });
      manager = new Orchestrator(
        threadRepo,
        eventRepo,
        projectRepo,
        ws,
        llmCompletionService,
        undefined,
        createTestRuntimeEnv(),
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        environmentRepo as never,
        attachmentRepo as never,
      );
    });

    it("validates active primary-checkout status only once per project within a list response", () => {
      const envRepo = new EnvironmentRepository(testDb.db);
      const env = envRepo.create({ projectId: project.id, descriptor: { type: "path", path: "/tmp/env" }, managed: true });
      const thread1 = createTestThread(threadRepo, project.id, { status: "idle", title: "Promoted", environmentId: env.id });
      createTestThread(threadRepo, project.id, { status: "idle", title: "Other", environmentId: env.id });

      const projectRoot = mkdtempSync(join(tmpdir(), "bb-orchestrator-"));
      git(projectRoot, "init");
      git(projectRoot, "config", "user.name", "BB Test");
      git(projectRoot, "config", "user.email", "bb-test@example.com");
      git(projectRoot, "checkout", "-b", "feature/thread-1");
      writeFileSync(join(projectRoot, "README.md"), "hello\n", "utf8");
      git(projectRoot, "add", "README.md");
      git(projectRoot, "commit", "-m", "initial");
      const head = git(projectRoot, "rev-parse", "HEAD");
      projectRepo.update(project.id, { rootPath: projectRoot });

      asOrchestratorHarness(manager).primaryPromotionByProjectId.set(project.id, {
        projectId: project.id,
        environmentId: env.id,
        threadId: thread1.id,
        promotedAt: 1000,
        promotedCheckout: {
          branch: "feature/thread-1",
          head,
          detached: false,
        },
        reconstructed: false,
      });
      asOrchestratorHarness(manager).primaryPromotionValidatedAtByProjectId.set(project.id, 0);

      const result = manager.list({ projectId: project.id });

      expect(result[0]?.primaryCheckout?.isActive).toBe(true);
      expect(result[1]?.primaryCheckout?.isActive).toBe(true);
      expect(ws.broadcast).not.toHaveBeenCalled();
    });

    it("forces freshness validation before promote thread operations", async () => {
      const workspaceRoot = "/tmp/worktrees/proj-1/thread-1";
      const envRepo = new EnvironmentRepository(testDb.db);
      const env = envRepo.create({ projectId: project.id, descriptor: { type: "path", path: "/tmp/env" }, managed: true });
      const thread = createTestThread(threadRepo, project.id, { status: "idle", environmentId: env.id });
      asOrchestratorHarness(manager).environmentRuntimes.set(thread.id, {
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

      asOrchestratorHarness(manager).primaryPromotionByProjectId.set(project.id, {
        projectId: project.id,
        environmentId: env.id,
        threadId: thread.id,
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

      const result = await manager.promoteThreadEnvironmentToPrimaryCheckout(thread.id);

      expect(ensurePrimaryStatusSpy).toHaveBeenCalledWith(project.id, { force: true });
      expect(result).toMatchObject({
        ok: true,
        promoted: false,
      });
    });

    it("forces freshness validation before demote primary-checkout operations", async () => {
      const envRepo = new EnvironmentRepository(testDb.db);
      const env = envRepo.create({ projectId: project.id, descriptor: { type: "path", path: "/tmp/env" }, managed: true });
      const thread = createTestThread(threadRepo, project.id, { status: "idle", environmentId: env.id });

      const ensurePrimaryStatusSpy = vi
        .spyOn(asOrchestratorHarness(manager), "_ensurePrimaryPromotionStateIsCurrent")
        .mockImplementation(() => {});

      const result = await manager.demoteThreadEnvironmentFromPrimaryCheckout(thread.id);

      expect(ensurePrimaryStatusSpy).toHaveBeenCalledWith(project.id, { force: true });
      expect(result).toMatchObject({
        ok: true,
        demoted: false,
      });
    });

    it("refreshes promoted checkout snapshots after commit operations on the promoted environment", async () => {
      const env = environmentRepo.create({
        projectId: project.id,
        descriptor: { type: "path", path: "/tmp/env" },
        managed: true,
      });
      const thread = createTestThread(threadRepo, project.id, { status: "idle", environmentId: env.id });
      const getCheckoutSnapshot = vi
        .fn()
        .mockResolvedValueOnce({
          branch: "bb/thread-1",
          head: "next-head",
          detached: false,
        });
      asOrchestratorHarness(manager).environmentRuntimes.set(thread.id, {
        environment: makeRuntimeEnvironment({
          kind: "worktree",
          rootPath: "/tmp/worktrees/proj-1/thread-1",
          overrides: {
            getCheckoutSnapshot,
            async commitWorkspace() {
              return {
                ok: true,
                commitCreated: true,
                message: "Created commit",
                commitSha: "next-head",
                commitSubject: "Create commit",
                includeUnstaged: false,
                workStatus: makeWorkspaceStatus(),
              };
            },
          },
        }),
      });
      asOrchestratorHarness(manager).primaryPromotionByProjectId.set(project.id, {
        projectId: project.id,
        environmentId: env.id,
        threadId: thread.id,
        promotedAt: 1000,
        previousCheckout: {
          branch: "main",
          head: "base-head",
          detached: false,
        },
        promotedCheckout: {
          branch: "bb/thread-1",
          head: "old-head",
          detached: false,
        },
        reconstructed: false,
      });

      const result = await manager.requestEnvironmentOperation(env.id, {
        operation: "commit",
        initiatingThreadId: thread.id,
      });

      expect(result).toMatchObject({
        ok: true,
        operation: "commit",
        commitSha: "next-head",
      });
      expect(
        asOrchestratorHarness(manager).primaryPromotionByProjectId.get(project.id),
      ).toMatchObject({
        promotedCheckout: {
          branch: "bb/thread-1",
          head: "next-head",
          detached: false,
        },
      });
      expect(getCheckoutSnapshot).toHaveBeenCalledTimes(1);
    });

    it("treats promoting a sibling thread on the same environment as a no-op", async () => {
      const env = environmentRepo.create({
        projectId: project.id,
        descriptor: { type: "path", path: "/tmp/env" },
        managed: true,
        properties: {
          provisioningSystemKind: "worktree",
          location: "localhost",
          workspaceKind: "worktree",
        },
      });
      const activeThread = createTestThread(threadRepo, project.id, { status: "idle", environmentId: env.id });
      const targetThread = createTestThread(threadRepo, project.id, { status: "idle", environmentId: env.id });
      attachmentRepo.attachThread({ threadId: activeThread.id, environmentId: env.id });
      attachmentRepo.attachThread({ threadId: targetThread.id, environmentId: env.id });

      const runtimeEntry = {
        environment: makeRuntimeEnvironment({
          rootPath: "/tmp/worktrees/proj-1/thread-2",
        }),
      };
      asOrchestratorHarness(manager).environmentRuntimes.set(env.id, runtimeEntry);
      asOrchestratorHarness(manager).environmentRuntimes.set(`thread:${targetThread.id}`, runtimeEntry);
      asOrchestratorHarness(manager).primaryPromotionByProjectId.set(project.id, {
        projectId: project.id,
        environmentId: env.id,
        threadId: activeThread.id,
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
            "demoteThreadEnvironment" | "promoteThreadEnvironment" | "restoreThreadEnvironment"
          >;
        }
      ).environmentService;
      vi
        .spyOn(environmentService, "restoreThreadEnvironment")
        .mockReturnValue(
          makeRuntimeEnvironment({
            rootPath: "/tmp/worktrees/proj-1/thread-2",
          }),
        );
      const demoteSpy = vi
        .spyOn(environmentService, "demoteThreadEnvironment")
        .mockResolvedValue({
          demoted: true,
          status: { projectId: project.id },
          snapshot: {
            branch: "main",
            head: "aaa111",
            detached: false,
          },
          activeThreadId: activeThread.id,
        });
      const promoteSpy = vi
        .spyOn(environmentService, "promoteThreadEnvironment")
        .mockResolvedValue({
          promoted: false,
          status: {
            projectId: project.id,
            activeEnvironmentId: env.id,
            activeThreadId: activeThread.id,
            promotedAt: 1001,
          },
          state: {
            projectId: project.id,
            environmentId: env.id,
            threadId: activeThread.id,
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

      const result = await manager.promoteThreadEnvironmentToPrimaryCheckout(targetThread.id);

      expect(promoteSpy).not.toHaveBeenCalled();
      expect(demoteSpy).not.toHaveBeenCalled();
      expect(result).toMatchObject({
        ok: true,
        promoted: false,
        primaryStatus: {
          projectId: project.id,
          activeEnvironmentId: env.id,
          activeThreadId: activeThread.id,
        },
      });
      const allEvents = eventRepo.listByThread(activeThread.id);
      expect(allEvents).not.toContainEqual(
        expect.objectContaining({
          threadId: activeThread.id,
          type: "system/operation",
          data: expect.objectContaining({
            operation: "primary_checkout",
            metadata: expect.objectContaining({
              action: "demote",
            }),
          }),
        }),
      );
      const targetEvents = eventRepo.listByThread(targetThread.id);
      expect(targetEvents).not.toContainEqual(
        expect.objectContaining({
          threadId: targetThread.id,
          type: "system/operation",
        }),
      );
    });

    it("treats sibling threads on the promoted environment as already active", async () => {
      const env = environmentRepo.create({
        projectId: project.id,
        descriptor: { type: "path", path: "/tmp/env" },
        managed: true,
        properties: {
          provisioningSystemKind: "worktree",
          location: "localhost",
          workspaceKind: "worktree",
        },
      });
      const otherThread = createTestThread(threadRepo, project.id, { status: "idle", environmentId: env.id });
      const targetThread = createTestThread(threadRepo, project.id, { status: "idle", environmentId: env.id });
      attachmentRepo.attachThread({ threadId: otherThread.id, environmentId: env.id });
      attachmentRepo.attachThread({ threadId: targetThread.id, environmentId: env.id });
      const environmentService = (
        manager as unknown as {
          environmentService: Pick<EnvironmentService, "restoreThreadEnvironment">;
        }
      ).environmentService;
      vi
        .spyOn(environmentService, "restoreThreadEnvironment")
        .mockReturnValue(
          makeRuntimeEnvironment({
            rootPath: "/tmp/worktrees/proj-1/thread-2",
          }),
        );
      asOrchestratorHarness(manager).primaryPromotionByProjectId.set(project.id, {
        projectId: project.id,
        environmentId: env.id,
        threadId: otherThread.id,
        promotedAt: 1000,
        promotedCheckout: {
          head: "abc123",
          detached: false,
        },
        reconstructed: false,
      });

      const hydrated = await manager.getHydratedByIdAsync(targetThread.id);
      const promoteAction = hydrated?.builtInActions?.find((action: { id: string }) => action.id === "promote");
      const demoteAction = hydrated?.builtInActions?.find((action: { id: string }) => action.id === "demote");

      expect(promoteAction).toMatchObject({
        id: "promote",
        available: false,
      });
      expect(promoteAction?.disabledReason).toBe("Primary checkout is already promoted to this thread");
      expect(demoteAction).toMatchObject({
        id: "demote",
        available: true,
      });
    });

    it("rejects promote when another primary-checkout transition is already in flight", async () => {
      const workspaceRoot = "/tmp/worktrees/proj-1/thread-1";
      const envRepo = new EnvironmentRepository(testDb.db);
      const env = envRepo.create({ projectId: project.id, descriptor: { type: "path", path: "/tmp/env" }, managed: true });
      const thread = createTestThread(threadRepo, project.id, { status: "idle", environmentId: env.id });
      asOrchestratorHarness(manager).environmentRuntimes.set(thread.id, {
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
      asOrchestratorHarness(manager).primaryCheckoutTransitionsInFlight.add(project.id);

      await expect(manager.promoteThreadEnvironmentToPrimaryCheckout(thread.id)).rejects.toThrow(
        "Another primary-checkout promotion/demotion operation is already in progress for this project",
      );
    });

    it("rejects demote when another primary-checkout transition is already in flight", async () => {
      const envRepo = new EnvironmentRepository(testDb.db);
      const env = envRepo.create({ projectId: project.id, descriptor: { type: "path", path: "/tmp/env" }, managed: true });
      const thread = createTestThread(threadRepo, project.id, { status: "idle", environmentId: env.id });
      asOrchestratorHarness(manager).primaryCheckoutTransitionsInFlight.add(project.id);

      await expect(manager.demoteThreadEnvironmentFromPrimaryCheckout(thread.id)).rejects.toThrow(
        "Another primary-checkout promotion/demotion operation is already in progress for this project",
      );
    });

    it("rejects commit when another project git mutation is already in flight", async () => {
      const env = environmentRepo.create({
        projectId: project.id,
        descriptor: { type: "path", path: "/tmp/env" },
        managed: true,
      });
      const thread = createTestThread(threadRepo, project.id, { status: "idle", environmentId: env.id });
      asOrchestratorHarness(manager).primaryCheckoutTransitionsInFlight.add(project.id);

      await expect(
        manager.requestEnvironmentOperation(env.id, {
          operation: "commit",
          initiatingThreadId: thread.id,
        }),
      ).rejects.toThrow(
        "Another environment git operation is already in progress for this project",
      );
    });

    it("rejects squash merge when another project git mutation is already in flight", async () => {
      const env = environmentRepo.create({
        projectId: project.id,
        descriptor: { type: "path", path: "/tmp/env" },
        managed: true,
      });
      const thread = createTestThread(threadRepo, project.id, { status: "idle", environmentId: env.id });
      asOrchestratorHarness(manager).primaryCheckoutTransitionsInFlight.add(project.id);

      await expect(
        manager.requestEnvironmentOperation(env.id, {
          operation: "squash_merge",
          initiatingThreadId: thread.id,
        }),
      ).rejects.toThrow(
        "Another environment git operation is already in progress for this project",
      );
    });

  });

  describe("isActive()", () => {
    let testDb: ReturnType<typeof createTestDb>;
    let project: ReturnType<typeof createTestProject>;

    beforeEach(() => {
      testDb = createTestDb();
      const repos = createTestRepos(testDb.db);
      threadRepo = repos.threadRepo;
      eventRepo = repos.eventRepo;
      projectRepo = repos.projectRepo;
      project = createTestProject(projectRepo, { rootPath: "/test" });
      manager = new Orchestrator(
        threadRepo, eventRepo, projectRepo, ws, llmCompletionService,
        undefined, createTestRuntimeEnv(),
      );
    });

    it("returns false when thread is not persisted as active", () => {
      expect(manager.isActive("thread-1")).toBe(false);
    });

    it("returns true when thread is persisted as active", () => {
      const thread = createTestThread(threadRepo, project.id, { status: "active" });

      expect(manager.isActive(thread.id)).toBe(true);
    });
  });

  describe("getActiveCount()", () => {
    let testDb: ReturnType<typeof createTestDb>;
    let project: ReturnType<typeof createTestProject>;

    beforeEach(() => {
      testDb = createTestDb();
      const repos = createTestRepos(testDb.db);
      threadRepo = repos.threadRepo;
      eventRepo = repos.eventRepo;
      projectRepo = repos.projectRepo;
      project = createTestProject(projectRepo, { rootPath: "/test" });
      manager = new Orchestrator(
        threadRepo, eventRepo, projectRepo, ws, llmCompletionService,
        undefined, createTestRuntimeEnv(),
      );
    });

    it("returns 0 when no threads are persisted as active", () => {
      expect(manager.getActiveCount()).toBe(0);
    });

    it("returns active count from persisted DB status", () => {
      createTestThread(threadRepo, project.id, { status: "active" });
      createTestThread(threadRepo, project.id, { status: "active" });

      expect(manager.getActiveCount()).toBe(2);
    });
  });

  describe("getRunningCount()", () => {
    let testDb: ReturnType<typeof createTestDb>;
    let project: ReturnType<typeof createTestProject>;

    beforeEach(() => {
      testDb = createTestDb();
      const repos = createTestRepos(testDb.db);
      threadRepo = repos.threadRepo;
      eventRepo = repos.eventRepo;
      projectRepo = repos.projectRepo;
      project = createTestProject(projectRepo, { rootPath: "/test" });
      manager = new Orchestrator(
        threadRepo, eventRepo, projectRepo, ws, llmCompletionService,
        undefined, createTestRuntimeEnv(),
      );
    });

    it("returns active count from persisted DB status", () => {
      const t1 = createTestThread(threadRepo, project.id, { status: "active" });
      const t2 = createTestThread(threadRepo, project.id, { status: "active" });
      asOrchestratorHarness(manager).processes.set(t1.id, { kill: vi.fn(), stdin: null, stdout: null });
      asOrchestratorHarness(manager).processes.set(t2.id, { kill: vi.fn(), stdin: null, stdout: null });

      expect(manager.getRunningCount()).toBe(2);
    });

    it("treats stale persisted active rows as active until explicitly updated", () => {
      const t1 = createTestThread(threadRepo, project.id, { status: "active" });
      eventRepo.create({ threadId: t1.id, seq: 1, type: "turn/started", data: createTurnStartedData(t1.id) });

      expect(manager.getRunningCount()).toBe(1);
    });
  });

  describe("detachAll()", () => {
    let testDb: ReturnType<typeof createTestDb>;
    let project: ReturnType<typeof createTestProject>;

    beforeEach(() => {
      testDb = createTestDb();
      const repos = createTestRepos(testDb.db);
      threadRepo = repos.threadRepo;
      eventRepo = repos.eventRepo;
      projectRepo = repos.projectRepo;
      project = createTestProject(projectRepo, { rootPath: "/test" });
      manager = new Orchestrator(
        threadRepo, eventRepo, projectRepo, ws, llmCompletionService,
        undefined, createTestRuntimeEnv(),
      );
    });

    it("clears all processes and is safe to call when empty", () => {
      // Should not throw when no processes
      manager.detachAll();
      expect(manager.getActiveCount()).toBe(0);
    });


    it("preserves managed environments during server shutdown", () => {
      const dispose = vi.fn();
      const stopWatchingWorkspaceStatus = vi.fn();
      const thread = createTestThread(threadRepo, project.id, { status: "idle" });
      asOrchestratorHarness(manager).environmentRuntimes.set(thread.id, {
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

      manager.detachAll();

      expect(stopWatchingWorkspaceStatus).toHaveBeenCalledTimes(1);
      expect(dispose).not.toHaveBeenCalled();
    });

    it("does not mark active managed sessions idle during server shutdown", async () => {
      const thread = createTestThread(threadRepo, project.id, { status: "active" });
      asOrchestratorHarness(manager).environmentRuntimes.set(thread.id, {
        environment: makeRuntimeEnvironment({
          rootPath: "/test",
        }),
        startedAt: Date.now(),
        projectId: project.id,
      });

      const fakeChild = createFakeChildProcess();
      (spawnMock as ReturnType<typeof vi.fn>).mockReturnValue(fakeChild);

      // Simulate that thread is active with a process
      asOrchestratorHarness(manager).processes.set(thread.id, fakeChild);
      asOrchestratorHarness(manager).providerThreadIds.set(thread.id, "provider-thread-1");

      expect(manager.isActive(thread.id)).toBe(true);

      // Track whether threadRepo.update is called with idle status
      const updateSpy = vi.spyOn(threadRepo, "update");

      manager.detachAll();

      // Should not have been called to set status to idle
      const idleCalls = updateSpy.mock.calls.filter(
        (call) => call[0] === thread.id && (call[1] as Record<string, unknown>)?.status === "idle",
      );
      expect(idleCalls).toHaveLength(0);
    });
  });

  describe("getTimeline()", () => {
    let testDb: ReturnType<typeof createTestDb>;
    let project: ReturnType<typeof createTestProject>;

    beforeEach(() => {
      testDb = createTestDb();
      const repos = createTestRepos(testDb.db);
      threadRepo = repos.threadRepo;
      eventRepo = repos.eventRepo;
      projectRepo = repos.projectRepo;
      project = createTestProject(projectRepo, { rootPath: "/test" });
      manager = new Orchestrator(
        threadRepo, eventRepo, projectRepo, ws, llmCompletionService,
        undefined, createTestRuntimeEnv(),
      );
    });

    it("projects start-first provisioning failure into user, provisioning, and error rows", () => {
      const thread = createTestThread(threadRepo, project.id, { status: "provisioning_failed" });
      eventRepo.create({ threadId: thread.id, seq: 1, type: "client/thread/start", data: createEventData<"client/thread/start">({ direction: "outbound", source: "spawn", initiator: "agent", input: [{ type: "text", text: "Fix env setup script regression" }], request: { method: "thread/start", params: {} }, execution: {} }) });
      eventRepo.create({ threadId: thread.id, seq: 2, type: "system/provisioning/started", data: createEventData<"system/provisioning/started">({ transcript: [{ key: "environment", text: "environment: Worktree" }] }) });
      eventRepo.create({ threadId: thread.id, seq: 3, type: "system/provisioning/env_setup", data: createEventData<"system/provisioning/env_setup">({ setup: { status: "started", scriptPath: ".bb-env-setup.sh", timeoutMs: 600000 }, transcript: [{ key: "setup", text: "running .bb-env-setup.sh", startedAt: 3 }] }) });
      eventRepo.create({ threadId: thread.id, seq: 4, type: "system/provisioning/env_setup", data: createEventData<"system/provisioning/env_setup">({ setup: { status: "failed", scriptPath: ".bb-env-setup.sh", timeoutMs: 600000, durationMs: 1593, output: "pnpm build failed" }, transcript: [{ key: "setup", text: "setup script failed: .bb-env-setup.sh in 1.6s" }] }) });
      eventRepo.create({ threadId: thread.id, seq: 5, type: "system/error", data: createEventData<"system/error">({ code: "thread_provisioning_failed", message: "Thread provisioning failed for project proj-1", detail: "pnpm build failed" }) });

      const timeline = manager.getTimeline(thread.id);
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
      const thread = createTestThread(threadRepo, project.id, { status: "idle" });
      eventRepo.create({ threadId: thread.id, seq: 1, type: "thread/name/updated", data: createEventData<"thread/name/updated">({ threadId: "provider-thread-1", threadName: "Renamed by agent" }) });
      const listSpy = vi.spyOn(eventRepo, "listByThread");

      const timeline = manager.getTimeline(thread.id);
      const rows = timeline.rows.filter(
        (row): row is Extract<(typeof timeline.rows)[number], { kind: "message" }> =>
          row.kind === "message",
      );

      expect(rows).toHaveLength(1);
      expect(rows[0]?.message.kind).toBe("operation");
      if (rows[0]?.message.kind !== "operation") return;
      expect(rows[0].message.opType).toBe("thread-title-updated");
      expect(rows[0].message.detail).toBe("Renamed by agent");

      const ignoredTypes = listSpy.mock.calls[0]?.[3] as readonly string[] | undefined;
      expect(ignoredTypes).toBeDefined();
      expect(ignoredTypes).not.toContain("thread/name/updated");
    });

    it("includes compaction rows in the projected timeline", () => {
      const thread = createTestThread(threadRepo, project.id, { status: "idle" });
      eventRepo.create({ threadId: thread.id, seq: 1, type: "thread/compacted", data: createEventData<"thread/compacted">({ threadId: "provider-thread-1", turnId: "turn-1" }) });

      const timeline = manager.getTimeline(thread.id);
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

    it("shows only published manager messages for manager threads", () => {
      const thread = createTestThread(threadRepo, project.id, { type: "manager", status: "idle" });
      eventRepo.create({ threadId: thread.id, seq: 1, type: "client/turn/start", data: createEventData<"client/turn/start">({ direction: "outbound", source: "tell", initiator: "system", input: [{ type: "text", text: "[bb system] Welcome!" }], request: { method: "turn/start", params: {} }, execution: {} }) });
      eventRepo.create({ threadId: thread.id, seq: 2, type: "item/completed", data: createEventData<"item/completed">({ threadId: thread.id, turnId: "turn-1", item: { type: "agentMessage", id: "assistant-1", text: "internal manager chatter" } }) });
      eventRepo.create({ threadId: thread.id, seq: 3, type: "system/manager/user_message", data: createEventData<"system/manager/user_message">({ text: "Visible manager update", turnId: "turn-1" }) });

      const timeline = manager.getTimeline(thread.id);
      const messageRows = timeline.rows.filter(
        (row): row is Extract<(typeof timeline.rows)[number], { kind: "message" }> =>
          row.kind === "message",
      );

      expect(messageRows).toHaveLength(1);
      expect(messageRows[0]?.message.kind).toBe("assistant-text");
      if (messageRows[0]?.message.kind === "assistant-text") {
        expect(messageRows[0].message.text).toBe("Visible manager update");
      }
    });

    it("shows the regular projected timeline for manager threads in debug view", () => {
      const thread = createTestThread(threadRepo, project.id, { type: "manager", status: "idle" });
      eventRepo.create({ threadId: thread.id, seq: 1, type: "client/turn/start", data: createEventData<"client/turn/start">({ direction: "outbound", source: "tell", initiator: "system", input: [{ type: "text", text: "[bb system] Welcome!" }], request: { method: "turn/start", params: {} }, execution: {} }) });
      eventRepo.create({ threadId: thread.id, seq: 2, type: "item/completed", data: createEventData<"item/completed">({ threadId: thread.id, turnId: "turn-1", item: { type: "agentMessage", id: "assistant-1", text: "internal manager chatter" } }) });
      eventRepo.create({ threadId: thread.id, seq: 3, type: "system/manager/user_message", data: createEventData<"system/manager/user_message">({ text: "Visible manager update", turnId: "turn-1" }) });

      const timeline = manager.getTimeline(thread.id, undefined, false, true);
      const messageRows = timeline.rows.filter(
        (row): row is Extract<(typeof timeline.rows)[number], { kind: "message" }> =>
          row.kind === "message",
      );

      expect(messageRows).toHaveLength(3);
      expect(messageRows[0]?.message.kind).toBe("user");
      if (messageRows[0]?.message.kind === "user") {
        expect(messageRows[0].message.text).toBe("[bb system] Welcome!");
      }
      expect(messageRows[1]?.message.kind).toBe("assistant-text");
      if (messageRows[1]?.message.kind === "assistant-text") {
        expect(messageRows[1].message.text).toBe("internal manager chatter");
      }
      expect(messageRows[2]?.message.kind).toBe("assistant-text");
      if (messageRows[2]?.message.kind === "assistant-text") {
        expect(messageRows[2].message.text).toBe("Visible manager update");
      }
    });
  });
});
