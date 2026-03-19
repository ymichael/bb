import { beforeEach, describe, expect, it, vi } from "vitest";
import type {
  EnvironmentRecord,
  SystemEnvironmentInfo,
  Thread,
  ThreadWorkStatus,
  ThreadEnvironmentStartReason,
} from "@bb/core";
import {
  EnvironmentRegistry,
  type CreateEnvironmentContext,
  type IEnvironment,
} from "@bb/environment";
import { removeEnvironmentDaemonDefaultLogArtifacts } from "@bb/environment-daemon";
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
import { createTestDb, createTestRepos, createTestProject, createTestThread } from "./test-factories.js";
import { EnvironmentService } from "../environment-service.js";
import { resolveProjectCheckoutSnapshotAsync } from "../git-project.js";

vi.mock("@bb/environment-daemon", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@bb/environment-daemon")>();
  return {
    ...actual,
    removeEnvironmentDaemonDefaultLogArtifacts: vi.fn(),
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

function createTestEnvironment(args: {
  existsInitially: boolean;
  destroySpy?: () => void;
  watchWorkspaceStatusImpl?: (callback: () => void) => () => void;
}): IEnvironment {
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
    async getCheckoutSnapshot() {
      return {
        branch: "bb/thread-thread-1",
        head: "abc123",
        detached: false,
      };
    },
    getWorkspaceRootUnsafe() {
      return "/tmp/thread-1";
    },
    async getWorkspaceStatus() {
      return makeWorkspaceStatus();
    },
    watchWorkspaceStatus(callback) {
      return args.watchWorkspaceStatusImpl?.(callback) ?? (() => {});
    },
    async commitWorkspace() {
      return {
        ok: true,
        commitCreated: false,
        message: "clean",
        workStatus: makeWorkspaceStatus(),
      };
    },
    async listWorkspaceCommitsSinceRef() {
      return [];
    },
    async getWorkspaceDiff() {
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
    async promoteToActiveWorkspace() {
      throw new Error("not implemented");
    },
    async demoteFromActiveWorkspace() {
      throw new Error("not implemented");
    },
    async squashMergeIntoDefaultBranch() {
      throw new Error("not implemented");
    },
    async run() {
      return { exitCode: 0, stdout: "", stderr: "" };
    },
  };
}

function createService(args: {
  existsInitially: boolean;
  destroySpy?: () => void;
  restoreImpl?: (state: unknown, context: CreateEnvironmentContext) => IEnvironment;
  managed?: boolean;
  siblingThreadIds?: string[];
  watchWorkspaceStatusImpl?: (callback: () => void) => () => void;
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

  const { db, sqlite } = createTestDb();
  const { threadRepo, projectRepo, environmentRepo, attachmentRepo } = createTestRepos(db);

  const project = createTestProject(projectRepo, { rootPath: "/project/root" });
  const projectId = project.id;

  const env = environmentRepo.create({
    projectId,
    descriptor: {
      type: "path",
      path: "/project/root/.worktrees/thread-1",
    },
    managed: args.managed ?? true,
    properties: {
      provisioningSystemKind: "worktree",
      location: "localhost",
      workspaceKind: "worktree",
    },
    runtimeState: {
      kind: "worktree",
      state: {},
    },
  });

  const thread = createTestThread(threadRepo, projectId, {
    status: "idle",
    environmentId: env.id,
  });

  attachmentRepo.attachThread({
    threadId: thread.id,
    environmentId: env.id,
  });

  // Create sibling threads and attach them to the same environment
  const siblingThreads: Thread[] = [];
  for (const _siblingId of args.siblingThreadIds ?? []) {
    const siblingThread = createTestThread(threadRepo, projectId, {
      status: "idle",
      environmentId: env.id,
    });
    attachmentRepo.attachThread({
      threadId: siblingThread.id,
      environmentId: env.id,
    });
    siblingThreads.push(siblingThread);
  }

  const runOptionalSetup = vi.fn<
    (
      threadId: string,
      environmentArg: IEnvironment,
      projectRootPath: string,
      reason: ThreadEnvironmentStartReason,
    ) => Promise<void>
  >().mockResolvedValue(undefined);
  const onCleanupFailure = vi.fn();
  const onThreadChanged = vi.fn();

  const service = new EnvironmentService(
    threadRepo,
    projectRepo,
    environmentRegistry,
    {
      createContext: (threadId, projectRootPath) => ({
        projectId,
        threadId,
        projectRootPath,
        runtimeEnv: {},
      }),
      onProvisioningEvent: vi.fn(),
      onThreadChanged,
      onCleanupFailure,
      onPrimaryCheckoutDemoted: vi.fn(),
      runOptionalSetup,
    },
    environmentRepo,
    attachmentRepo,
  );

  return {
    service,
    runOptionalSetup,
    threadRepo,
    projectRepo,
    environmentRepo,
    attachmentRepo,
    thread,
    env,
    project,
    projectId,
    siblingThreads,
    onCleanupFailure,
    onThreadChanged,
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
    vi.mocked(removeEnvironmentDaemonDefaultLogArtifacts).mockClear();
  });

  it("runs optional setup only when provisioning creates the environment", async () => {
    const { service, runOptionalSetup, thread } = createService({
      existsInitially: false,
    });

    await service.provisionThreadEnvironment(
      thread.id,
      "/project/root",
      "worktree",
      "thread-created",
    );

    expect(runOptionalSetup).toHaveBeenCalledWith(
      thread.id,
      expect.objectContaining({ kind: "worktree" }),
      "/project/root",
      "thread-created",
    );
  });

  it("skips optional setup when rehydrating an existing environment", async () => {
    const { service, runOptionalSetup, thread } = createService({
      existsInitially: true,
    });

    await service.provisionThreadEnvironment(
      thread.id,
      "/project/root",
      "worktree",
      "resume-existing-provider-session",
    );

    expect(runOptionalSetup).not.toHaveBeenCalled();
  });

  it("destroys restored environments during persisted cleanup even when no runtime is active", async () => {
    const destroySpy = vi.fn();
    const { service, attachmentRepo, thread, env, environmentRepo } = createService({
      existsInitially: true,
      destroySpy,
    });

    await service.destroyPersistedEnvironment(thread.id);

    expect(destroySpy).toHaveBeenCalledTimes(1);
    expect(attachmentRepo.getByThreadId(thread.id)).toBeUndefined();
    expect(removeEnvironmentDaemonDefaultLogArtifacts).not.toHaveBeenCalled();
    // With real DB, deleting the managed environment record cascades to set thread.environmentId = null
    expect(threadRepo_getEnvId(service, thread.id)).toBeUndefined();
    expect(environmentRepo.getById(env.id)).toBeUndefined();
  });

  it("preserves runtime and persisted state when runtime destruction fails", async () => {
    const destroyError = new Error("cleanup failed");
    const destroySpy = vi.fn(() => {
      throw destroyError;
    });
    const { service, threadRepo, thread, env, onCleanupFailure } = createService({
      existsInitially: true,
      destroySpy,
    });
    const runtimeEnvironment = createTestEnvironment({
      existsInitially: true,
      destroySpy,
    });
    service.setEnvironmentRuntime(thread.id, runtimeEnvironment);
    destroySpy.mockClear();

    const updateSpy = vi.spyOn(threadRepo, "update");

    await expect(service.destroyThreadEnvironment(thread.id)).rejects.toThrow(
      "cleanup failed",
    );

    expect(destroySpy).toHaveBeenCalledTimes(1);
    expect(onCleanupFailure).toHaveBeenCalledWith(
      thread.id,
      "worktree",
      destroyError,
    );
    expect(service.getEnvironmentRuntime(thread.id)).toBeDefined();
    expect(updateSpy).not.toHaveBeenCalled();
    expect(threadRepo.getById(thread.id)?.environmentId).toBe(env.id);
  });

  it("clears stale persisted environment state when the archived workspace is already gone", async () => {
    const { service, attachmentRepo, thread, env } = createService({
      existsInitially: true,
      restoreImpl: () => {
        throw new Error("Worktree workspace is unavailable: /tmp/missing-thread-1");
      },
    });

    await expect(service.destroyPersistedEnvironment(thread.id)).resolves.toBeUndefined();

    expect(attachmentRepo.getByThreadId(thread.id)).toBeUndefined();
    expect(removeEnvironmentDaemonDefaultLogArtifacts).not.toHaveBeenCalled();
    // With real DB, deleting the managed environment record cascades to set thread.environmentId = null
    expect(threadRepo_getEnvId(service, thread.id)).toBeUndefined();
  });

  it("clears persisted environment state after destroying an active runtime", async () => {
    const destroySpy = vi.fn();
    const { service, attachmentRepo, thread, env } = createService({
      existsInitially: true,
      destroySpy,
    });
    const runtimeEnvironment = createTestEnvironment({
      existsInitially: true,
      destroySpy,
    });
    service.setEnvironmentRuntime(thread.id, runtimeEnvironment);
    destroySpy.mockClear();

    service.destroyEnvironmentRuntime(thread.id);
    await new Promise<void>((resolve) => setImmediate(resolve));

    expect(destroySpy).toHaveBeenCalledTimes(1);
    expect(attachmentRepo.getByThreadId(thread.id)).toBeUndefined();
    expect(removeEnvironmentDaemonDefaultLogArtifacts).not.toHaveBeenCalled();
    // With real DB, deleting the managed environment record cascades to set thread.environmentId = null
    expect(threadRepo_getEnvId(service, thread.id)).toBeUndefined();
  });

  it("suspends an active runtime without clearing persisted environment state", async () => {
    const destroySpy = vi.fn();
    const { service, threadRepo, thread, env } = createService({
      existsInitially: true,
      destroySpy,
    });
    const runtimeEnvironment = createTestEnvironment({
      existsInitially: true,
      destroySpy,
    });
    service.setEnvironmentRuntime(thread.id, runtimeEnvironment);
    destroySpy.mockClear();

    const updateSpy = vi.spyOn(threadRepo, "update");

    service.suspendEnvironmentRuntime(thread.id);
    await new Promise<void>((resolve) => setImmediate(resolve));

    expect(destroySpy).toHaveBeenCalledTimes(1);
    expect(updateSpy).not.toHaveBeenCalled();
    expect(removeEnvironmentDaemonDefaultLogArtifacts).not.toHaveBeenCalled();
    expect(threadRepo.getById(thread.id)?.environmentId).toBe(env.id);
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
    const { service, thread } = createService({
      existsInitially: true,
    });
    service.setEnvironmentRuntime(thread.id, runtimeEnvironment);

    let settled = false;
    const suspendPromise = service.suspendEnvironmentRuntimeAndWait(thread.id).then(() => {
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
    const { service, thread, threadRepo } = createService({
      existsInitially: true,
      restoreImpl,
    });
    service.setEnvironmentRuntime(thread.id, runtimeEnvironment);

    service.suspendEnvironmentRuntime(thread.id);
    await Promise.resolve();
    expect(runtimeEnvironment.suspend).toHaveBeenCalledTimes(1);

    let ensured = false;
    const ensurePromise = service.ensureThreadEnvironmentRuntime(
      threadRepo.getById(thread.id)!,
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
    const { service, thread, threadRepo } = createService({
      existsInitially: true,
      restoreImpl,
    });

    const threadState = threadRepo.getById(thread.id)!;
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
    await Promise.resolve();

    expect(restoreImpl).toHaveBeenCalledTimes(1);
    expect(prepareSpy).toHaveBeenCalledTimes(1);

    waitGate.resolve();
    const [firstResolved, secondResolved] = await Promise.all([first, second]);

    expect(firstResolved.runtime).toBe(secondResolved.runtime);
    expect(service.getEnvironmentRuntime(thread.id)).toBe(firstResolved.runtime);
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
            throw new Error("Missing managed environment-daemon target for local environment");
          }
          return {
            transport: "http" as const,
            baseUrl: "http://127.0.0.1:4312",
          };
        },
      };
    });
    const { service, thread, threadRepo } = createService({
      existsInitially: true,
      restoreImpl,
    });

    await expect(
      service.ensureThreadEnvironmentRuntime(
        threadRepo.getById(thread.id)!,
        "/project/root",
        "resume-existing-provider-session",
      ),
    ).rejects.toThrow("Missing managed environment-daemon target for local environment");
    expect(prepareCalls).toBe(1);
    expect(service.getEnvironmentRuntime(thread.id)).toBeUndefined();
  });

  it("does not suspend persisted state when installing a restored runtime", () => {
    const persistedSuspendSpy = vi.fn();
    const restoreImpl = vi.fn(() =>
      createTestEnvironment({
        existsInitially: true,
        destroySpy: persistedSuspendSpy,
      }),
    );
    const { service, thread } = createService({
      existsInitially: true,
      restoreImpl,
    });
    const runtimeEnvironment = createTestEnvironment({
      existsInitially: true,
    });

    service.setEnvironmentRuntime(thread.id, runtimeEnvironment);

    expect(restoreImpl).not.toHaveBeenCalled();
    expect(persistedSuspendSpy).not.toHaveBeenCalled();
    expect(service.getEnvironmentRuntime(thread.id)?.environment).toBe(runtimeEnvironment);
  });

  it("suspends a persisted environment even when no runtime is restored", async () => {
    const destroySpy = vi.fn();
    const { service, threadRepo, thread, env } = createService({
      existsInitially: true,
      destroySpy,
    });

    const updateSpy = vi.spyOn(threadRepo, "update");

    service.suspendEnvironmentRuntime(thread.id);
    await new Promise<void>((resolve) => setImmediate(resolve));

    expect(destroySpy).toHaveBeenCalledTimes(1);
    expect(updateSpy).not.toHaveBeenCalled();
    expect(removeEnvironmentDaemonDefaultLogArtifacts).not.toHaveBeenCalled();
    expect(threadRepo.getById(thread.id)?.environmentId).toBe(env.id);
  });

  it("removes managed thread logs only when explicitly requested", () => {
    const { service, thread, projectId, env } = createService({
      existsInitially: true,
    });

    service.removeManagedThreadLogs({
      id: thread.id,
      projectId,
      environmentId: "worktree",
    });

    expect(removeEnvironmentDaemonDefaultLogArtifacts).toHaveBeenCalledWith({
      projectId,
      environmentId: env.id,
    });
  });

  it("does not remove logs from stale thread.environmentId when the attachment row is missing", () => {
    const { service, attachmentRepo, thread } = createService({
      existsInitially: true,
    });

    attachmentRepo.deleteByThreadId(thread.id);

    service.removeManagedThreadLogs({
      id: thread.id,
      projectId: thread.projectId,
      environmentId: thread.environmentId,
    });

    expect(removeEnvironmentDaemonDefaultLogArtifacts).not.toHaveBeenCalled();
  });

  it("does not treat thread.environmentId as attached when the attachment row is missing", () => {
    const { service, attachmentRepo, thread, env } = createService({
      existsInitially: true,
    });

    attachmentRepo.deleteByThreadId(thread.id);

    expect(service.getAttachedEnvironmentId(thread.id)).toBeUndefined();
    expect(service.isThreadAttachedToEnvironment(thread.id, env.id)).toBe(false);
    expect(service.getAttachedThreadIdsForEnvironment(env.id)).toHaveLength(0);
  });

  it("teardownAllForTestsOnly cleans up persisted environments even when no runtime is restored", async () => {
    const destroySpy = vi.fn();
    const { service, attachmentRepo, thread, env } = createService({
      existsInitially: true,
      destroySpy,
    });

    await service.teardownAllForTestsOnly();
    await new Promise<void>((resolve) => setImmediate(resolve));

    expect(destroySpy).toHaveBeenCalledTimes(1);
    expect(attachmentRepo.getByThreadId(thread.id)).toBeUndefined();
    // With real DB, deleting the managed environment record cascades to set thread.environmentId = null
    expect(threadRepo_getEnvId(service, thread.id)).toBeUndefined();
  });

  it("destroys the last unmanaged attached runtime while preserving the environment record", async () => {
    const destroySpy = vi.fn();
    const { service, attachmentRepo, thread, env, environmentRepo } = createService({
      existsInitially: true,
      destroySpy,
      managed: false,
    });
    const runtimeEnvironment = createTestEnvironment({
      existsInitially: true,
      destroySpy,
    });
    service.setEnvironmentRuntime(thread.id, runtimeEnvironment);
    destroySpy.mockClear();

    await service.destroyThreadEnvironment(thread.id);

    expect(destroySpy).toHaveBeenCalledTimes(1);
    expect(service.getEnvironmentRuntime(thread.id)).toBeUndefined();
    expect(attachmentRepo.getByThreadId(thread.id)).toBeUndefined();
    expect(threadRepo_getEnvId(service, thread.id)).toBe(env.id);
    expect(environmentRepo.getById(env.id)).toBeDefined();
  });

  it("can tear down a shared runtime after the original owner detaches", async () => {
    const destroySpy = vi.fn();
    const { service, attachmentRepo, thread } = createService({
      existsInitially: true,
      destroySpy,
      siblingThreadIds: ["thread-2"],
    });
    const runtimeEnvironment = createTestEnvironment({
      existsInitially: true,
      destroySpy,
    });
    service.setEnvironmentRuntime(thread.id, runtimeEnvironment);
    destroySpy.mockClear();

    attachmentRepo.deleteByThreadId(thread.id);

    await service.teardownAllForTestsOnly();

    expect(destroySpy).toHaveBeenCalledTimes(1);
    expect(attachmentRepo.listByEnvironmentId(thread.environmentId!)).toHaveLength(0);
  });

  it("can tear down a detached shared runtime when no attached threads remain", async () => {
    const destroySpy = vi.fn();
    const { service, attachmentRepo, thread, siblingThreads } = createService({
      existsInitially: true,
      destroySpy,
      siblingThreadIds: ["thread-2"],
    });
    const runtimeEnvironment = createTestEnvironment({
      existsInitially: true,
      destroySpy,
    });
    service.setEnvironmentRuntime(thread.id, runtimeEnvironment);
    destroySpy.mockClear();

    attachmentRepo.deleteByThreadId(thread.id);
    attachmentRepo.deleteByThreadId(siblingThreads[0]!.id);

    await service.teardownAllForTestsOnly();

    expect(destroySpy).toHaveBeenCalledTimes(1);
  });

  it("does not report stale thread.environmentId when removeManagedThreadLogs receives a detached thread", () => {
    const { service, attachmentRepo, thread, onCleanupFailure } = createService({
      existsInitially: true,
    });

    attachmentRepo.deleteByThreadId(thread.id);

    expect(() =>
      service.removeManagedThreadLogs({
        id: thread.id,
        projectId: thread.projectId,
        environmentId: thread.environmentId,
      })
    ).not.toThrow();

    expect(onCleanupFailure).not.toHaveBeenCalled();
  });

  it("clears persisted shared-environment attachments for all scoped threads during teardownAllForTestsOnly", async () => {
    const runtimeDestroySpy = vi.fn();
    const persistedDestroySpy = vi.fn();
    const runtimeEnvironment = createTestEnvironment({
      existsInitially: true,
      destroySpy: runtimeDestroySpy,
    });
    const persistedEnvironment = createTestEnvironment({
      existsInitially: true,
      destroySpy: persistedDestroySpy,
    });
    const environmentRegistry = new EnvironmentRegistry().register({
      kind: "worktree",
      info: WORKTREE_INFO,
      create(_context: CreateEnvironmentContext): IEnvironment {
        return runtimeEnvironment;
      },
      restore(_state: unknown, _context: CreateEnvironmentContext): IEnvironment {
        return persistedEnvironment;
      },
      isState(_value: unknown): _value is unknown {
        return true;
      },
    });

    const { db } = createTestDb();
    const { threadRepo, projectRepo, environmentRepo, attachmentRepo } = createTestRepos(db);

    const project = createTestProject(projectRepo, { rootPath: "/project/root" });
    const projectId = project.id;

    const env = environmentRepo.create({
      projectId,
      descriptor: {
        type: "path",
        path: "/project/root/.worktrees/thread-1",
      },
      managed: true,
      properties: {
        provisioningSystemKind: "worktree",
        location: "localhost",
        workspaceKind: "worktree",
      },
      runtimeState: {
        kind: "worktree",
        state: {},
      },
    });

    const thread1 = createTestThread(threadRepo, projectId, {
      status: "idle",
      environmentId: env.id,
    });
    const thread2 = createTestThread(threadRepo, projectId, {
      status: "idle",
      environmentId: env.id,
    });

    attachmentRepo.attachThread({ threadId: thread1.id, environmentId: env.id });
    attachmentRepo.attachThread({ threadId: thread2.id, environmentId: env.id });

    const service = new EnvironmentService(
      threadRepo,
      projectRepo,
      environmentRegistry,
      {
        createContext: (threadId, projectRootPath) => ({
          projectId,
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
      environmentRepo,
      attachmentRepo,
    );

    service.setEnvironmentRuntime(thread1.id, runtimeEnvironment);
    await service.teardownAllForTestsOnly();

    expect(runtimeDestroySpy).toHaveBeenCalledTimes(1);
    expect(attachmentRepo.getByThreadId(thread1.id)).toBeUndefined();
    expect(attachmentRepo.getByThreadId(thread2.id)).toBeUndefined();
    expect(attachmentRepo.listByEnvironmentId(env.id)).toHaveLength(0);
    expect(environmentRepo.getById(env.id)).toBeUndefined();
  });

  it("keeps shared workspace watcher fanout after the original owner detaches", async () => {
    let emitWorkspaceStatusChange: (() => void) | undefined;
    const { service, attachmentRepo, thread, siblingThreads, onThreadChanged } = createService({
      existsInitially: true,
      siblingThreadIds: ["thread-2"],
    });

    const siblingThread = siblingThreads[0]!;

    service.setEnvironmentRuntime(
      thread.id,
      createTestEnvironment({
        existsInitially: true,
        watchWorkspaceStatusImpl(callback) {
          emitWorkspaceStatusChange = callback;
          return () => {};
        },
      }),
    );
    attachmentRepo.deleteByThreadId(thread.id);

    emitWorkspaceStatusChange?.();

    expect(onThreadChanged).toHaveBeenCalledWith(siblingThread.id, ["work-status-changed"]);
    expect(onThreadChanged).not.toHaveBeenCalledWith(thread.id, ["work-status-changed"]);
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

    const { db } = createTestDb();
    const { threadRepo, projectRepo, environmentRepo, attachmentRepo } = createTestRepos(db);

    const project = createTestProject(projectRepo, { rootPath: "/project/root" });
    const projectId = project.id;

    const env = environmentRepo.create({
      projectId,
      descriptor: {
        type: "path",
        path: "/project/root/.worktrees/thread-1",
      },
      managed: true,
      properties: {
        provisioningSystemKind: "worktree",
        location: "localhost",
        workspaceKind: "worktree",
      },
      runtimeState: {
        kind: "worktree",
        state: {},
      },
    });

    const thread = createTestThread(threadRepo, projectId, {
      status: "idle",
      environmentId: env.id,
    });

    attachmentRepo.attachThread({ threadId: thread.id, environmentId: env.id });

    // Set primaryCheckoutThreadId to the real thread ID (must come after thread creation for FK)
    projectRepo.update(projectId, { primaryCheckoutThreadId: thread.id });

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
        createContext: (tid, projectRootPath) => ({
          projectId,
          threadId: tid,
          projectRootPath,
          runtimeEnv: {},
        }),
        onProvisioningEvent: vi.fn(),
        onThreadChanged: vi.fn(),
        onCleanupFailure: vi.fn(),
        onPrimaryCheckoutDemoted: vi.fn(),
        runOptionalSetup: vi.fn().mockResolvedValue(undefined),
      },
      environmentRepo,
      attachmentRepo,
    );

    await service.rebuildPrimaryPromotionStateFromGitAsync();

    expect(service.getPrimaryCheckoutStatus(projectId)).toEqual({
      projectId,
      activeEnvironmentId: env.id,
      activeThreadId: thread.id,
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

    const { db } = createTestDb();
    const { threadRepo, projectRepo, environmentRepo, attachmentRepo } = createTestRepos(db);

    const project = projectRepo.create({
      name: "Project",
      rootPath: "/project/root",
    });
    const projectId = project.id;

    const env = environmentRepo.create({
      projectId,
      descriptor: {
        type: "path",
        path: "/project/root/.worktrees/thread-1",
      },
      managed: true,
      properties: {
        provisioningSystemKind: "worktree",
        location: "localhost",
        workspaceKind: "worktree",
      },
      runtimeState: {
        kind: "worktree",
        state: {},
      },
    });

    const thread = createTestThread(threadRepo, projectId, {
      status: "idle",
      environmentId: env.id,
    });

    attachmentRepo.attachThread({ threadId: thread.id, environmentId: env.id });

    // Set primaryCheckoutThreadId to the real thread ID
    projectRepo.update(projectId, { primaryCheckoutThreadId: thread.id });

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
          projectId,
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
      environmentRepo,
      attachmentRepo,
    );

    await service.ensurePrimaryPromotionStateIsCurrentAsync(projectId);

    expect(service.getPrimaryCheckoutStatus(projectId)).toEqual({
      projectId,
      activeEnvironmentId: env.id,
      activeThreadId: thread.id,
      promotedAt: expect.any(Number),
    });
  });

  it("does not reconstruct primary promotion state from stale thread.environmentId without an attachment", async () => {
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
    });

    const { db } = createTestDb();
    const { threadRepo, projectRepo, environmentRepo, attachmentRepo } = createTestRepos(db);

    const project = projectRepo.create({
      name: "Project",
      rootPath: "/project/root",
    });
    const projectId = project.id;

    const env = environmentRepo.create({
      projectId,
      descriptor: {
        type: "path",
        path: "/project/root/.worktrees/thread-1",
      },
      managed: true,
      properties: {
        provisioningSystemKind: "worktree",
        location: "localhost",
        workspaceKind: "worktree",
      },
      runtimeState: {
        kind: "worktree",
        state: {},
      },
    });

    const thread = createTestThread(threadRepo, projectId, {
      status: "idle",
      environmentId: env.id,
    });

    projectRepo.update(projectId, { primaryCheckoutThreadId: thread.id });

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
        createContext: (tid, projectRootPath) => ({
          projectId,
          threadId: tid,
          projectRootPath,
          runtimeEnv: {},
        }),
        onProvisioningEvent: vi.fn(),
        onThreadChanged: vi.fn(),
        onCleanupFailure: vi.fn(),
        onPrimaryCheckoutDemoted: vi.fn(),
        runOptionalSetup: vi.fn().mockResolvedValue(undefined),
      },
      environmentRepo,
      attachmentRepo,
    );

    await service.ensurePrimaryPromotionStateIsCurrentAsync(projectId);

    expect(service.getPrimaryCheckoutStatus(projectId)).toEqual({ projectId });
    expect(service.getAttachedEnvironmentId(thread.id)).toBeUndefined();
    expect(threadRepo_getEnvId(service, thread.id)).toBe(env.id);
  });

  it("rejects promotion when attachment-backed environment identity is missing", async () => {
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
    });

    const { db } = createTestDb();
    const { threadRepo, projectRepo, environmentRepo, attachmentRepo } = createTestRepos(db);

    const project = projectRepo.create({
      name: "Project",
      rootPath: "/project/root",
    });
    const env = environmentRepo.create({
      projectId: project.id,
      descriptor: {
        type: "path",
        path: "/project/root/.worktrees/thread-1",
      },
      managed: true,
      properties: {
        provisioningSystemKind: "worktree",
        location: "localhost",
        workspaceKind: "worktree",
      },
      runtimeState: {
        kind: "worktree",
        state: {},
      },
    });

    const thread = createTestThread(threadRepo, project.id, {
      status: "idle",
      environmentId: env.id,
    });

    const service = new EnvironmentService(
      threadRepo,
      projectRepo,
      environmentRegistry,
      {
        createContext: (tid, projectRootPath) => ({
          projectId: project.id,
          threadId: tid,
          projectRootPath,
          runtimeEnv: {},
        }),
        onProvisioningEvent: vi.fn(),
        onThreadChanged: vi.fn(),
        onCleanupFailure: vi.fn(),
        onPrimaryCheckoutDemoted: vi.fn(),
        runOptionalSetup: vi.fn().mockResolvedValue(undefined),
      },
      environmentRepo,
      attachmentRepo,
    );

    await expect(
      service.promoteThreadEnvironment({
        thread,
      }),
    ).rejects.toThrow("Thread is not attached to an environment");
    expect(service.getPrimaryCheckoutStatus(project.id)).toEqual({ projectId: project.id });
  });
});

/**
 * Helper: the `destroyPersistedEnvironment` path clears the attachment but
 * intentionally does NOT clear `thread.environmentId` (the thread keeps its
 * environment reference). This helper reads the current thread from the repo
 * used by the service to verify environmentId is preserved. We access the
 * threadRepo via a closure in createService rather than reading a stale object.
 */
function threadRepo_getEnvId(service: EnvironmentService, threadId: string): string | undefined {
  // Access the threadRepo through the service's internal state - we need to
  // read the DB value. Use the service's public API to check via the repo.
  // Since we can't access private members, we'll use a workaround.
  return (service as any).threadRepo.getById(threadId)?.environmentId;
}
