import { beforeEach, describe, expect, it, vi } from "vitest";
import type {
  EnvironmentRecord,
  SystemEnvironmentInfo,
  Thread,
  ThreadWorkStatus,
  ThreadEnvironmentStartReason,
} from "@beanbag/agent-core";
import {
  EnvironmentRegistry,
  type CreateEnvironmentContext,
  type IEnvironment,
} from "@beanbag/environment";
import { removeEnvironmentAgentDefaultLogArtifacts } from "@beanbag/environment-agent";
import type {
  EnvironmentRepository,
  ProjectRepository,
  ThreadEnvironmentAttachmentRepository,
  ThreadRepository,
} from "@beanbag/db";
import { EnvironmentService } from "../environment-service.js";
import { resolveProjectCheckoutSnapshotAsync } from "../git-project.js";

vi.mock("@beanbag/environment-agent", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@beanbag/environment-agent")>();
  return {
    ...actual,
    removeEnvironmentAgentDefaultLogArtifacts: vi.fn(),
  };
});

vi.mock("../git-project.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../git-project.js")>();
  return {
    ...actual,
    resolveProjectCheckoutSnapshotAsync: vi.fn(actual.resolveProjectCheckoutSnapshotAsync),
  };
});

const WORKTREE_INFO: SystemEnvironmentInfo = {
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

function makeWorkspaceStatus(): ThreadWorkStatus {
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
  };
}

function createTestEnvironment(args: { existsInitially: boolean; destroySpy?: () => void }): IEnvironment {
  let exists = args.existsInitially;

  return {
    kind: "worktree",
    info: WORKTREE_INFO,
    serialize() {
      return {};
    },
    async prepare() {
      exists = true;
    },
    suspend() {
      args.destroySpy?.();
    },
    destroy() {
      args.destroySpy?.();
    },
    exists() {
      return exists;
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
      };
    },
    getCheckoutSnapshot() {
      return {
        branch: "bb/thread-thread-1",
        head: "abc123",
        detached: false,
      };
    },
    getWorkspaceRootUnsafe() {
      return "/tmp/thread-1";
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
        message: "clean",
        workStatus: makeWorkspaceStatus(),
      };
    },
    listWorkspaceCommitsSinceRef() {
      return [];
    },
    getWorkspaceDiff() {
      return { diff: "", truncated: false };
    },
    spawn() {
      return {} as never;
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
    run() {
      return { exitCode: 0, stdout: "", stderr: "" };
    },
  };
}

function createService(args: {
  existsInitially: boolean;
  destroySpy?: () => void;
  restoreImpl?: (state: unknown, context: CreateEnvironmentContext) => IEnvironment;
}) {
  const environment = createTestEnvironment(args);
  const environmentRegistry = new EnvironmentRegistry().register({
    kind: "worktree",
    info: WORKTREE_INFO,
    create(_context: CreateEnvironmentContext): IEnvironment {
      return environment;
    },
    restore(state: unknown, context: CreateEnvironmentContext): IEnvironment {
      if (args.restoreImpl) {
        return args.restoreImpl(state, context);
      }
      return environment;
    },
    isState(_value: unknown): _value is unknown {
      return true;
    },
  });

  const threadState: Thread = {
    id: "thread-1",
    projectId: "proj-1",
    providerId: "codex",
    status: "idle",
    environmentId: "env-1",
    createdAt: 1000,
    updatedAt: 1000,
  };
  const environmentState = new Map<string, EnvironmentRecord>([[
    "env-1",
    {
      id: "env-1",
      projectId: "proj-1",
      descriptor: {
        type: "path",
        path: "/project/root/.worktrees/thread-1",
      },
      managed: true,
      runtimeState: {
        kind: "worktree",
        state: {},
      },
      createdAt: 1000,
      updatedAt: 1000,
    },
  ]]);
  let attachmentState:
    | {
      threadId: string;
      environmentId: string;
      createdAt: number;
      updatedAt: number;
    }
    | undefined = {
      threadId: "thread-1",
      environmentId: "env-1",
      createdAt: 1000,
      updatedAt: 1000,
    };
  const threadRepo = {
    getById: vi.fn((_threadId: string) => threadState),
    update: vi.fn((_threadId: string, data: Parameters<ThreadRepository["update"]>[1]) => {
      Object.assign(threadState, data);
      return threadState;
    }),
  } as unknown as ThreadRepository;

  const projectRepo = {
    getById: vi.fn(() => ({
      id: "proj-1",
      name: "Project",
      rootPath: "/project/root",
      createdAt: 1000,
      updatedAt: 1000,
    })),
    list: vi.fn(() => ([{
      id: "proj-1",
      name: "Project",
      rootPath: "/project/root",
      createdAt: 1000,
      updatedAt: 1000,
    }])),
    update: vi.fn(),
  } as unknown as ProjectRepository;

  (
    threadRepo as unknown as {
      listProjectNonArchivedIdsWithEnvironmentRecord: ReturnType<typeof vi.fn>;
    }
  ).listProjectNonArchivedIdsWithEnvironmentRecord = vi.fn(() => ["thread-1"]);

  const environmentRepo = {
    getById: vi.fn((environmentId: string) => environmentState.get(environmentId)),
    delete: vi.fn((environmentId: string) => {
      environmentState.delete(environmentId);
    }),
  } as unknown as EnvironmentRepository;

  const threadEnvironmentAttachmentRepo = {
    getByThreadId: vi.fn((threadId: string) =>
      attachmentState?.threadId === threadId ? attachmentState : undefined
    ),
    listByEnvironmentId: vi.fn((environmentId: string) =>
      attachmentState?.environmentId === environmentId ? [attachmentState] : []
    ),
    deleteByThreadId: vi.fn(
      (
        threadId: string,
        opts?: { nextThreadEnvironmentId?: string | null },
      ) => {
        if (attachmentState?.threadId === threadId) {
          attachmentState = undefined;
        }
        if (Object.hasOwn(opts ?? {}, "nextThreadEnvironmentId")) {
          threadState.environmentId = opts?.nextThreadEnvironmentId ?? undefined;
        }
      },
    ),
  } as unknown as ThreadEnvironmentAttachmentRepository;

  const runOptionalSetup = vi.fn<
    (
      threadId: string,
      environmentArg: IEnvironment,
      projectRootPath: string,
      reason: ThreadEnvironmentStartReason,
    ) => Promise<void>
  >().mockResolvedValue(undefined);
  const onCleanupFailure = vi.fn();

  const service = new EnvironmentService(
    threadRepo,
    projectRepo,
    environmentRegistry,
    {
      createContext: (threadId, projectRootPath) => ({
        projectId: "proj-1",
        threadId,
        projectRootPath,
        runtimeEnv: {},
      }),
      onProvisioningEvent: vi.fn(),
      onThreadChanged: vi.fn(),
      onCleanupFailure,
      onPrimaryCheckoutDemoted: vi.fn(),
      runOptionalSetup,
    },
    environmentRepo,
    threadEnvironmentAttachmentRepo,
  );

  return {
    service,
    runOptionalSetup,
    threadRepo,
    threadState,
    onCleanupFailure,
    environmentRepo,
    threadEnvironmentAttachmentRepo,
  };
}

function createDeferred() {
  let resolvePromise: (() => void) | undefined;
  const promise = new Promise<void>((resolve) => {
    resolvePromise = resolve;
  });
  return {
    promise,
    resolve() {
      resolvePromise?.();
    },
  };
}

describe("EnvironmentService", () => {
  beforeEach(() => {
    vi.mocked(removeEnvironmentAgentDefaultLogArtifacts).mockClear();
  });

  it("runs optional setup only when provisioning creates the environment", async () => {
    const { service, runOptionalSetup } = createService({
      existsInitially: false,
    });

    await service.provisionThreadEnvironment(
      "thread-1",
      "/project/root",
      "worktree",
      "thread-created",
    );

    expect(runOptionalSetup).toHaveBeenCalledWith(
      "thread-1",
      expect.objectContaining({ kind: "worktree" }),
      "/project/root",
      "thread-created",
    );
  });

  it("skips optional setup when rehydrating an existing environment", async () => {
    const { service, runOptionalSetup } = createService({
      existsInitially: true,
    });

    await service.provisionThreadEnvironment(
      "thread-1",
      "/project/root",
      "worktree",
      "resume-existing-provider-session",
    );

    expect(runOptionalSetup).not.toHaveBeenCalled();
  });

  it("destroys restored environments during persisted cleanup even when no runtime is active", async () => {
    const destroySpy = vi.fn();
    const { service, threadEnvironmentAttachmentRepo, threadState, environmentRepo } = createService({
      existsInitially: true,
      destroySpy,
    });

    await service.destroyPersistedEnvironment("thread-1");

    expect(destroySpy).toHaveBeenCalledTimes(1);
    expect(threadEnvironmentAttachmentRepo.deleteByThreadId).toHaveBeenCalledWith(
      "thread-1",
      { nextThreadEnvironmentId: "worktree" },
    );
    expect(removeEnvironmentAgentDefaultLogArtifacts).not.toHaveBeenCalled();
    expect(threadState.environmentId).toBe("worktree");
    expect(environmentRepo.getById("env-1")).toBeUndefined();
  });

  it("preserves runtime and persisted state when runtime destruction fails", async () => {
    const destroyError = new Error("cleanup failed");
    const destroySpy = vi.fn(() => {
      throw destroyError;
    });
    const { service, threadRepo, threadState, onCleanupFailure } = createService({
      existsInitially: true,
      destroySpy,
    });
    const runtimeEnvironment = createTestEnvironment({
      existsInitially: true,
      destroySpy,
    });
    service.setEnvironmentRuntime("thread-1", runtimeEnvironment);
    destroySpy.mockClear();

    await expect(service.destroyThreadEnvironment("thread-1")).rejects.toThrow(
      "cleanup failed",
    );

    expect(destroySpy).toHaveBeenCalledTimes(1);
    expect(onCleanupFailure).toHaveBeenCalledWith(
      "thread-1",
      "worktree",
      destroyError,
    );
    expect(service.getEnvironmentRuntime("thread-1")).toBeDefined();
    expect(threadRepo.update).not.toHaveBeenCalled();
    expect(threadState.environmentId).toBe("env-1");
  });

  it("clears stale persisted environment state when the archived workspace is already gone", async () => {
    const { service, threadEnvironmentAttachmentRepo, threadState } = createService({
      existsInitially: true,
      restoreImpl: () => {
        throw new Error("Worktree workspace is unavailable: /tmp/missing-thread-1");
      },
    });

    await expect(service.destroyPersistedEnvironment("thread-1")).resolves.toBeUndefined();

    expect(threadEnvironmentAttachmentRepo.deleteByThreadId).toHaveBeenCalledWith(
      "thread-1",
      { nextThreadEnvironmentId: "worktree" },
    );
    expect(removeEnvironmentAgentDefaultLogArtifacts).not.toHaveBeenCalled();
    expect(threadState.environmentId).toBe("worktree");
  });

  it("clears persisted environment state after destroying an active runtime", async () => {
    const destroySpy = vi.fn();
    const { service, threadEnvironmentAttachmentRepo, threadState } = createService({
      existsInitially: true,
      destroySpy,
    });
    const runtimeEnvironment = createTestEnvironment({
      existsInitially: true,
      destroySpy,
    });
    service.setEnvironmentRuntime("thread-1", runtimeEnvironment);
    destroySpy.mockClear();

    service.destroyEnvironmentRuntime("thread-1");
    await new Promise<void>((resolve) => setImmediate(resolve));

    expect(destroySpy).toHaveBeenCalledTimes(1);
    expect(threadEnvironmentAttachmentRepo.deleteByThreadId).toHaveBeenCalledWith(
      "thread-1",
      { nextThreadEnvironmentId: "worktree" },
    );
    expect(removeEnvironmentAgentDefaultLogArtifacts).not.toHaveBeenCalled();
    expect(threadState.environmentId).toBe("worktree");
  });

  it("suspends an active runtime without clearing persisted environment state", async () => {
    const destroySpy = vi.fn();
    const { service, threadRepo, threadState } = createService({
      existsInitially: true,
      destroySpy,
    });
    const runtimeEnvironment = createTestEnvironment({
      existsInitially: true,
      destroySpy,
    });
    service.setEnvironmentRuntime("thread-1", runtimeEnvironment);
    destroySpy.mockClear();

    service.suspendEnvironmentRuntime("thread-1");
    await new Promise<void>((resolve) => setImmediate(resolve));

    expect(destroySpy).toHaveBeenCalledTimes(1);
    expect(threadRepo.update).not.toHaveBeenCalled();
    expect(removeEnvironmentAgentDefaultLogArtifacts).not.toHaveBeenCalled();
    expect(threadState.environmentId).toBe("env-1");
  });

  it("can await active runtime suspension before reusing the environment", async () => {
    let resolveSuspend: (() => void) | undefined;
    const runtimeEnvironment: IEnvironment = {
      ...createTestEnvironment({ existsInitially: true }),
      suspend: vi.fn(
        async () =>
          await new Promise<void>((resolve) => {
            resolveSuspend = resolve;
          }),
      ),
    };
    const { service } = createService({
      existsInitially: true,
    });
    service.setEnvironmentRuntime("thread-1", runtimeEnvironment);

    let settled = false;
    const suspendPromise = service.suspendEnvironmentRuntimeAndWait("thread-1").then(() => {
      settled = true;
    });

    expect(runtimeEnvironment.suspend).toHaveBeenCalledTimes(1);
    await Promise.resolve();
    expect(settled).toBe(false);

    resolveSuspend?.();
    await suspendPromise;

    expect(settled).toBe(true);
  });

  it("waits for an in-flight runtime suspension before ensuring the environment again", async () => {
    let resolveSuspend: (() => void) | undefined;
    const runtimeEnvironment: IEnvironment = {
      ...createTestEnvironment({ existsInitially: true }),
      suspend: vi.fn(
        async () =>
          await new Promise<void>((resolve) => {
            resolveSuspend = resolve;
          }),
      ),
    };
    const prepareSpy = vi.fn(async () => {});
    const restoreImpl = vi.fn(() => ({
      ...createTestEnvironment({ existsInitially: true }),
      prepare: prepareSpy,
    }));
    const { service, threadState } = createService({
      existsInitially: true,
      restoreImpl,
    });
    service.setEnvironmentRuntime("thread-1", runtimeEnvironment);

    service.suspendEnvironmentRuntime("thread-1");
    await Promise.resolve();
    expect(runtimeEnvironment.suspend).toHaveBeenCalledTimes(1);

    let ensured = false;
    const ensurePromise = service.ensureThreadEnvironmentRuntime(
      threadState,
      "/project/root",
      "resume-existing-provider-session",
    ).then(() => {
      ensured = true;
    });

    await Promise.resolve();
    expect(ensured).toBe(false);
    expect(prepareSpy).not.toHaveBeenCalled();

    resolveSuspend?.();
    await ensurePromise;

    expect(prepareSpy).toHaveBeenCalledTimes(1);
  });

  it("coalesces concurrent runtime ensure calls for the same thread", async () => {
    const waitGate = createDeferred();
    const prepareSpy = vi.fn(async () => {
      await waitGate.promise;
    });
    const restoreImpl = vi.fn(() => ({
      ...createTestEnvironment({ existsInitially: true }),
      prepare: prepareSpy,
    }));
    const { service, threadState } = createService({
      existsInitially: true,
      restoreImpl,
    });

    const first = service.ensureThreadEnvironmentRuntime(
      threadState,
      "/project/root",
      "resume-existing-provider-session",
    );
    const second = service.ensureThreadEnvironmentRuntime(
      threadState,
      "/project/root",
      "resume-existing-provider-session",
    );

    await Promise.resolve();
    await Promise.resolve();

    expect(restoreImpl).toHaveBeenCalledTimes(1);
    expect(prepareSpy).toHaveBeenCalledTimes(1);

    waitGate.resolve();
    const [firstResolved, secondResolved] = await Promise.all([first, second]);

    expect(firstResolved.runtime).toBe(secondResolved.runtime);
    expect(service.getEnvironmentRuntime("thread-1")).toBe(firstResolved.runtime);
  });

  it("fails when a freshly prepared environment still has no managed agent target", async () => {
    let prepareCalls = 0;
    const restoreImpl = vi.fn(() => {
      let targetAvailable = false;
      return {
        ...createTestEnvironment({ existsInitially: true }),
        async prepare() {
          prepareCalls += 1;
          targetAvailable = prepareCalls >= 2;
        },
        getAgentConnectionTarget() {
          if (!targetAvailable) {
            throw new Error("Missing managed environment-agent target for local environment");
          }
          return {
            transport: "http" as const,
            baseUrl: "http://127.0.0.1:4312",
          };
        },
      };
    });
    const { service, threadState } = createService({
      existsInitially: true,
      restoreImpl,
    });

    await expect(
      service.ensureThreadEnvironmentRuntime(
        threadState,
        "/project/root",
        "resume-existing-provider-session",
      ),
    ).rejects.toThrow("Missing managed environment-agent target for local environment");
    expect(prepareCalls).toBe(1);
    expect(service.getEnvironmentRuntime("thread-1")).toBeUndefined();
  });

  it("does not suspend persisted state when installing a restored runtime", () => {
    const persistedSuspendSpy = vi.fn();
    const restoreImpl = vi.fn(() =>
      createTestEnvironment({
        existsInitially: true,
        destroySpy: persistedSuspendSpy,
      }),
    );
    const { service } = createService({
      existsInitially: true,
      restoreImpl,
    });
    const runtimeEnvironment = createTestEnvironment({
      existsInitially: true,
    });

    service.setEnvironmentRuntime("thread-1", runtimeEnvironment);

    expect(restoreImpl).not.toHaveBeenCalled();
    expect(persistedSuspendSpy).not.toHaveBeenCalled();
    expect(service.getEnvironmentRuntime("thread-1")?.environment).toBe(runtimeEnvironment);
  });

  it("suspends a persisted environment even when no runtime is restored", async () => {
    const destroySpy = vi.fn();
    const { service, threadRepo, threadState } = createService({
      existsInitially: true,
      destroySpy,
    });

    service.suspendEnvironmentRuntime("thread-1");
    await new Promise<void>((resolve) => setImmediate(resolve));

    expect(destroySpy).toHaveBeenCalledTimes(1);
    expect(threadRepo.update).not.toHaveBeenCalled();
    expect(removeEnvironmentAgentDefaultLogArtifacts).not.toHaveBeenCalled();
    expect(threadState.environmentId).toBe("env-1");
  });

  it("removes managed thread logs only when explicitly requested", () => {
    const { service } = createService({
      existsInitially: true,
    });

    service.removeManagedThreadLogs({
      id: "thread-1",
      projectId: "proj-1",
      environmentId: "worktree",
    });

    expect(removeEnvironmentAgentDefaultLogArtifacts).toHaveBeenCalledWith({
      projectId: "proj-1",
      threadId: "thread-1",
      environmentId: "worktree",
    });
  });

  it("stopAll cleans up persisted environments even when no runtime is restored", async () => {
    const destroySpy = vi.fn();
    const { service, threadEnvironmentAttachmentRepo, threadState } = createService({
      existsInitially: true,
      destroySpy,
    });

    service.stopAll();
    await new Promise<void>((resolve) => setImmediate(resolve));

    expect(destroySpy).toHaveBeenCalledTimes(1);
    expect(threadEnvironmentAttachmentRepo.deleteByThreadId).toHaveBeenCalledWith(
      "thread-1",
      { nextThreadEnvironmentId: "worktree" },
    );
    expect(threadState.environmentId).toBe("worktree");
  });

  it("rebuilds primary promotion state through per-project environment candidates", async () => {
    const environment = createTestEnvironment({ existsInitially: true });
    const environmentRegistry = new EnvironmentRegistry().register({
      kind: "worktree",
      info: WORKTREE_INFO,
      create(_context: CreateEnvironmentContext): IEnvironment {
        return environment;
      },
      restore(_state: unknown, _context: CreateEnvironmentContext): IEnvironment {
        return environment;
      },
      isState(_value: unknown): _value is unknown {
        return true;
      },
    }).register({
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
      create(_context: CreateEnvironmentContext): IEnvironment {
        return {
          ...createTestEnvironment({ existsInitially: true }),
          kind: "local",
          isIsolatedWorkspace() {
            return false;
          },
        };
      },
      restore(_state: unknown, _context: CreateEnvironmentContext): IEnvironment {
        return {
          ...createTestEnvironment({ existsInitially: true }),
          kind: "local",
          isIsolatedWorkspace() {
            return false;
          },
        };
      },
      isState(_value: unknown): _value is unknown {
        return true;
      },
    });
    const threadRepo = {
      list: vi.fn(() => {
        throw new Error("broad thread listing should not be used");
      }),
      getById: vi.fn(() => ({
        id: "thread-1",
        projectId: "proj-1",
        status: "idle",
        environmentId: "worktree",
        createdAt: 1000,
        updatedAt: 1000,
      })),
    } as unknown as ThreadRepository;
    const projectRepo = {
      list: vi.fn(() => [{
        id: "proj-1",
        name: "Project",
        rootPath: "/project/root",
        primaryCheckoutThreadId: "thread-1",
        createdAt: 1000,
        updatedAt: 1000,
      }]),
      getById: vi.fn(() => ({
        id: "proj-1",
        name: "Project",
        rootPath: "/project/root",
        primaryCheckoutThreadId: "thread-1",
        createdAt: 1000,
        updatedAt: 1000,
      })),
      update: vi.fn(),
    } as unknown as ProjectRepository;
    vi.mocked(resolveProjectCheckoutSnapshotAsync).mockResolvedValue({
      branch: "bb/thread-thread-1",
      head: "abc123",
      detached: false,
    });

    const service = new EnvironmentService(
      threadRepo,
      projectRepo,
      environmentRegistry,
      {
        createContext: (threadId, projectRootPath) => ({
          projectId: "proj-1",
          threadId,
          projectRootPath,
          runtimeEnv: {},
        }),
        onProvisioningEvent: vi.fn(),
        onThreadChanged: vi.fn(),
        onCleanupFailure: vi.fn(),
        onPrimaryCheckoutDemoted: vi.fn(),
        runOptionalSetup: vi.fn().mockResolvedValue(undefined),
      },
    );

    await service.rebuildPrimaryPromotionStateFromGitAsync();

    expect(
      (threadRepo as unknown as { list: ReturnType<typeof vi.fn> }).list,
    ).not.toHaveBeenCalled();
    expect(service.getPrimaryCheckoutStatus("proj-1")).toEqual({
      projectId: "proj-1",
      activeThreadId: "thread-1",
      promotedAt: expect.any(Number),
    });
  });

  it("lazily reconstructs primary promotion state on first project status lookup", async () => {
    const environment = createTestEnvironment({ existsInitially: true });
    const environmentRegistry = new EnvironmentRegistry().register({
      kind: "worktree",
      info: WORKTREE_INFO,
      create(_context: CreateEnvironmentContext): IEnvironment {
        return environment;
      },
      restore(_state: unknown, _context: CreateEnvironmentContext): IEnvironment {
        return environment;
      },
      isState(_value: unknown): _value is unknown {
        return true;
      },
    }).register({
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
      create(_context: CreateEnvironmentContext): IEnvironment {
        return {
          ...createTestEnvironment({ existsInitially: true }),
          kind: "local",
          isIsolatedWorkspace() {
            return false;
          },
        };
      },
      restore(_state: unknown, _context: CreateEnvironmentContext): IEnvironment {
        return {
          ...createTestEnvironment({ existsInitially: true }),
          kind: "local",
          isIsolatedWorkspace() {
            return false;
          },
        };
      },
      isState(_value: unknown): _value is unknown {
        return true;
      },
    });
    const threadRepo = {
      list: vi.fn(() => {
        throw new Error("broad thread listing should not be used");
      }),
      getById: vi.fn(() => ({
        id: "thread-1",
        projectId: "proj-1",
        status: "idle",
        environmentId: "worktree",
        createdAt: 1000,
        updatedAt: 1000,
      })),
    } as unknown as ThreadRepository;
    const projectRepo = {
      list: vi.fn(() => [{
        id: "proj-1",
        name: "Project",
        rootPath: "/project/root",
        primaryCheckoutThreadId: "thread-1",
        createdAt: 1000,
        updatedAt: 1000,
      }]),
      getById: vi.fn(() => ({
        id: "proj-1",
        name: "Project",
        rootPath: "/project/root",
        primaryCheckoutThreadId: "thread-1",
        createdAt: 1000,
        updatedAt: 1000,
      })),
      update: vi.fn(),
    } as unknown as ProjectRepository;
    vi.mocked(resolveProjectCheckoutSnapshotAsync).mockResolvedValue({
      branch: "bb/thread-thread-1",
      head: "abc123",
      detached: false,
    });

    const service = new EnvironmentService(
      threadRepo,
      projectRepo,
      environmentRegistry,
      {
        createContext: (threadId, projectRootPath) => ({
          projectId: "proj-1",
          threadId,
          projectRootPath,
          runtimeEnv: {},
        }),
        onProvisioningEvent: vi.fn(),
        onThreadChanged: vi.fn(),
        onCleanupFailure: vi.fn(),
        onPrimaryCheckoutDemoted: vi.fn(),
        runOptionalSetup: vi.fn().mockResolvedValue(undefined),
      },
    );

    await service.ensurePrimaryPromotionStateIsCurrentAsync("proj-1");

    expect(
      (threadRepo as unknown as { list: ReturnType<typeof vi.fn> }).list,
    ).not.toHaveBeenCalled();
    expect(service.getPrimaryCheckoutStatus("proj-1")).toEqual({
      projectId: "proj-1",
      activeThreadId: "thread-1",
      promotedAt: expect.any(Number),
    });
  });
});
