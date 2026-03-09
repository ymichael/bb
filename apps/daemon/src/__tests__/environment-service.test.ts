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

function createTestEnvironment(args: { existsInitially: boolean }): IEnvironment {
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
    dispose() {},
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

function createService(args: { existsInitially: boolean }) {
  const environment = createTestEnvironment(args);
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

  const threadRepo = {
    getById: vi.fn((_threadId: string) =>
      ({
        id: "thread-1",
        projectId: "proj-1",
        status: "idle",
        createdAt: 1000,
        updatedAt: 1000,
      }) satisfies Thread),
  } as unknown as ThreadRepository;

  const projectRepo = {
    getById: vi.fn(),
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

  return { service, runOptionalSetup };
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
});
