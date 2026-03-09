import { describe, expect, it, vi } from "vitest";
import type {
  SystemEnvironmentInfo,
  Thread,
  ThreadWorkStatus,
  ThreadEnvironmentStartReason,
} from "@beanbag/agent-core";
import type { AgentServerSessionConnection } from "@beanbag/agent-server";
import {
  EnvironmentRegistry,
  type CreateEnvironmentContext,
  type IEnvironment,
} from "@beanbag/environment";
import type { ProjectRepository, ThreadRepository } from "@beanbag/db";
import { EnvironmentService } from "../environment-service.js";
import { resolveProjectCheckoutSnapshot } from "../git-project.js";

vi.mock("../git-project.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../git-project.js")>();
  return {
    ...actual,
    resolveProjectCheckoutSnapshot: vi.fn(actual.resolveProjectCheckoutSnapshot),
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

function createTestEnvironment(args: { existsInitially: boolean; disposeSpy?: () => void }): IEnvironment {
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
    dispose() {
      args.disposeSpy?.();
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
    shouldRunSetupScript() {
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
  disposeSpy?: () => void;
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
    status: "idle",
    environmentRecord: {
      kind: "worktree",
      state: {},
    },
    environmentAgentCursor: 12,
    createdAt: 1000,
    updatedAt: 1000,
  };
  const threadRepo = {
    getById: vi.fn((_threadId: string) => threadState),
    update: vi.fn((_threadId: string, data: Record<string, unknown>) => {
      Object.assign(threadState as Record<string, unknown>, data);
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
  } as unknown as ProjectRepository;

  const runOptionalSetup = vi.fn<
    (
      threadId: string,
      environmentArg: IEnvironment,
      reason: ThreadEnvironmentStartReason,
    ) => Promise<void>
  >().mockResolvedValue(undefined);

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
      runOptionalSetup,
      spawnProviderProcess: vi.fn(
        (): AgentServerSessionConnection => ({
          transport: "http",
          client: {} as never,
        }),
      ),
    },
  );

  return { service, runOptionalSetup, threadRepo, threadState };
}

describe("EnvironmentService", () => {
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

  it("disposes restored environments during persisted cleanup even when no runtime is active", async () => {
    const disposeSpy = vi.fn();
    const { service, threadRepo, threadState } = createService({
      existsInitially: true,
      disposeSpy,
    });

    await service.cleanupPersistedEnvironment("thread-1");

    expect(disposeSpy).toHaveBeenCalledTimes(1);
    expect(threadRepo.update).toHaveBeenCalledWith(
      "thread-1",
      {
        environmentRecord: null,
        environmentAgentCursor: null,
      },
      { touchUpdatedAt: false },
    );
    expect(threadState.environmentRecord).toBeNull();
    expect(threadState.environmentAgentCursor).toBeNull();
  });

  it("clears stale persisted environment state when the archived workspace is already gone", async () => {
    const { service, threadRepo, threadState } = createService({
      existsInitially: true,
      restoreImpl: () => {
        throw new Error("Worktree workspace is unavailable: /tmp/missing-thread-1");
      },
    });

    await expect(service.cleanupPersistedEnvironment("thread-1")).resolves.toBeUndefined();

    expect(threadRepo.update).toHaveBeenCalledWith(
      "thread-1",
      {
        environmentRecord: null,
        environmentAgentCursor: null,
      },
      { touchUpdatedAt: false },
    );
    expect(threadState.environmentRecord).toBeNull();
    expect(threadState.environmentAgentCursor).toBeNull();
  });

  it("clears persisted environment state after destroying an active runtime", async () => {
    const disposeSpy = vi.fn();
    const { service, threadRepo, threadState } = createService({
      existsInitially: true,
      disposeSpy,
    });
    const runtimeEnvironment = createTestEnvironment({
      existsInitially: true,
      disposeSpy,
    });
    service.setEnvironmentRuntime("thread-1", runtimeEnvironment);

    service.cleanupEnvironmentRuntime("thread-1", { destroyWorkspace: true });
    await new Promise<void>((resolve) => setImmediate(resolve));

    expect(disposeSpy).toHaveBeenCalledTimes(1);
    expect(threadRepo.update).toHaveBeenCalledWith(
      "thread-1",
      {
        environmentRecord: null,
        environmentAgentCursor: null,
      },
      { touchUpdatedAt: false },
    );
    expect(threadState.environmentRecord).toBeNull();
    expect(threadState.environmentAgentCursor).toBeNull();
  });

  it("rebuilds primary promotion state through per-project environment candidates", () => {
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
      listProjectNonArchivedIdsWithEnvironmentRecord: vi.fn(() => ["thread-1"]),
      getById: vi.fn(() => ({
        id: "thread-1",
        projectId: "proj-1",
        status: "idle",
        environmentRecord: {
          kind: "worktree",
          state: {},
        },
        createdAt: 1000,
        updatedAt: 1000,
      })),
    } as unknown as ThreadRepository;
    const projectRepo = {
      list: vi.fn(() => [{
        id: "proj-1",
        name: "Project",
        rootPath: "/project/root",
        createdAt: 1000,
        updatedAt: 1000,
      }]),
      getById: vi.fn(() => ({
        id: "proj-1",
        name: "Project",
        rootPath: "/project/root",
        createdAt: 1000,
        updatedAt: 1000,
      })),
    } as unknown as ProjectRepository;
    vi.mocked(resolveProjectCheckoutSnapshot).mockReturnValue({
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
        spawnProviderProcess: vi.fn(
          (): AgentServerSessionConnection => ({
            transport: "http",
            client: {} as never,
          }),
        ),
      },
    );

    service.rebuildPrimaryPromotionStateFromGit();

    expect(
      (threadRepo as unknown as { listProjectNonArchivedIdsWithEnvironmentRecord: ReturnType<typeof vi.fn> })
        .listProjectNonArchivedIdsWithEnvironmentRecord,
    ).toHaveBeenCalledWith("proj-1");
    expect(
      (threadRepo as unknown as { list: ReturnType<typeof vi.fn> }).list,
    ).not.toHaveBeenCalled();
    expect(service.getPrimaryCheckoutStatus("proj-1")).toEqual({
      projectId: "proj-1",
      activeThreadId: "thread-1",
      promotedAt: expect.any(Number),
    });
  });

  it("lazily reconstructs primary promotion state on first project status lookup", () => {
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
      listProjectNonArchivedIdsWithEnvironmentRecord: vi.fn(() => ["thread-1"]),
      getById: vi.fn(() => ({
        id: "thread-1",
        projectId: "proj-1",
        status: "idle",
        environmentRecord: {
          kind: "worktree",
          state: {},
        },
        createdAt: 1000,
        updatedAt: 1000,
      })),
    } as unknown as ThreadRepository;
    const projectRepo = {
      list: vi.fn(() => [{
        id: "proj-1",
        name: "Project",
        rootPath: "/project/root",
        createdAt: 1000,
        updatedAt: 1000,
      }]),
      getById: vi.fn(() => ({
        id: "proj-1",
        name: "Project",
        rootPath: "/project/root",
        createdAt: 1000,
        updatedAt: 1000,
      })),
    } as unknown as ProjectRepository;
    vi.mocked(resolveProjectCheckoutSnapshot).mockReturnValue({
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
        spawnProviderProcess: vi.fn(
          (): AgentServerSessionConnection => ({
            transport: "http",
            client: {} as never,
          }),
        ),
      },
    );

    expect(
      (threadRepo as unknown as { listProjectNonArchivedIdsWithEnvironmentRecord: ReturnType<typeof vi.fn> })
        .listProjectNonArchivedIdsWithEnvironmentRecord,
    ).not.toHaveBeenCalled();

    service.ensurePrimaryPromotionStateIsCurrent("proj-1");

    expect(
      (threadRepo as unknown as { listProjectNonArchivedIdsWithEnvironmentRecord: ReturnType<typeof vi.fn> })
        .listProjectNonArchivedIdsWithEnvironmentRecord,
    ).toHaveBeenCalledWith("proj-1");
    expect(service.getPrimaryCheckoutStatus("proj-1")).toEqual({
      projectId: "proj-1",
      activeThreadId: "thread-1",
      promotedAt: expect.any(Number),
    });
  });
});
