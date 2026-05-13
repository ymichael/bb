import type { ProvisioningTranscriptEntry, WorkspaceStatus } from "@bb/domain";
import type {
  CommitOptions,
  CommitResult,
  DiffOptions,
  DiffResult,
  FetchOptions,
  StatusOptions,
  SquashMergeOptions,
  SquashMergeResult,
} from "./workspace.js";
import { Workspace } from "./workspace.js";
import {
  withCheckoutMutationAdmission,
  withCheckoutMutationLock,
} from "./checkout-mutation-lock.js";
import {
  createWorktree,
  createClone,
  removeWorktree,
  removeDirectory,
} from "./provisioning.js";
import { detectGitRepo, pathExists, runGit, WorkspaceError } from "./git.js";
import { resolveAdditionalWorkspaceWriteRoots } from "./workspace-write-roots.js";

// ---------------------------------------------------------------------------
// Options (discriminated union on workspaceProvisionType from @bb/domain)
// ---------------------------------------------------------------------------

type ProvisionProgressCallback = (entry: ProvisioningTranscriptEntry) => void;

interface ProvisionBase {
  /** Progress callback for provisioning steps/output */
  onProgress?: ProvisionProgressCallback;
}

export interface UnmanagedCheckoutOpts {
  /**
   * `existing` runs `git switch <name>` (no-op if HEAD is already there).
   * `new` runs `git switch -C <name>` so the branch is created or reset.
   */
  kind: "existing" | "new";
  name: string;
}

export interface UnmanagedWorkspaceOpts extends ProvisionBase {
  workspaceProvisionType: "unmanaged";
  /** Path to validate. Must exist. */
  path: string;
  /** Pre-provision checkout. When set, the daemon switches branches before opening the workspace. */
  checkout?: UnmanagedCheckoutOpts;
}

export interface ManagedWorkspaceBaseOpts extends ProvisionBase {
  /** Source repo path */
  sourcePath: string;
  /** Target path for worktree/clone creation */
  targetPath: string;
  /** Name of the new branch to create on the workspace. */
  branchName: string;
  /**
   * Branch on the source repo that the new branch should be based on. Pass
   * `null` to use the source's default branch.
   */
  baseBranch: string | null;
  /** Setup script timeout in ms. Controlled by the server. */
  timeoutMs: number;
}

export interface ManagedWorktreeOpts extends ManagedWorkspaceBaseOpts {
  workspaceProvisionType: "managed-worktree";
}

export interface ManagedCloneOpts extends ManagedWorkspaceBaseOpts {
  workspaceProvisionType: "managed-clone";
}

export interface ReconnectManagedWorktreeOpts extends ProvisionBase {
  workspaceProvisionType: "reconnect-managed-worktree";
  /** Existing worktree path to reconnect */
  path: string;
}

export interface ReconnectManagedCloneOpts extends ProvisionBase {
  workspaceProvisionType: "reconnect-managed-clone";
  /** Existing clone path to reconnect */
  path: string;
}

export type ProvisionWorkspaceArgs =
  | UnmanagedWorkspaceOpts
  | ManagedWorktreeOpts
  | ManagedCloneOpts
  | ReconnectManagedWorktreeOpts
  | ReconnectManagedCloneOpts;

// ---------------------------------------------------------------------------
// HostWorkspace interface
// ---------------------------------------------------------------------------

export interface HostWorkspace {
  /** Absolute path to the workspace directory */
  readonly path: string;
  /** Whether the system manages this workspace's lifecycle */
  readonly managed: boolean;
  /** Whether this is a git repository */
  readonly isGitRepo: boolean;
  /** Whether this is a git worktree (vs. a standalone repo) */
  readonly isWorktree: boolean;

  // Git queries
  getCurrentBranch(): Promise<string | null>;
  getHeadSha(): Promise<string | null>;
  getLocalStateFingerprint(): Promise<string>;
  getSharedGitRefsFingerprint(): Promise<string>;
  getAdditionalWorkspaceWriteRoots(): Promise<string[]>;
  getStatus(options?: StatusOptions): Promise<WorkspaceStatus>;
  getDiff(options?: DiffOptions): Promise<DiffResult>;
  listBranches(): Promise<string[]>;
  listFiles(): Promise<string[]>;

  // Git mutations
  commit(options: CommitOptions): Promise<CommitResult>;
  reset(): Promise<void>;
  fetch(options?: FetchOptions): Promise<void>;
  squashMerge(options: SquashMergeOptions): Promise<SquashMergeResult>;

  // Lifecycle
  destroy(): Promise<void>;
}

// ---------------------------------------------------------------------------
// Detect whether a path is a git worktree
// ---------------------------------------------------------------------------

async function detectWorktree(cwd: string): Promise<boolean> {
  const gitDirResult = await runGit(["rev-parse", "--git-dir"], {
    cwd,
    allowFailure: true,
  });
  if (gitDirResult.exitCode !== 0) return false;

  const gitDir = gitDirResult.stdout.trim();
  // Worktrees have a .git file (not directory) pointing to
  // <common-dir>/worktrees/<name>. The git-dir will contain "/worktrees/".
  return gitDir.includes("/worktrees/");
}

// ---------------------------------------------------------------------------
// ProvisionedHostWorkspace - wraps Workspace + lifecycle cleanup
// ---------------------------------------------------------------------------

class ProvisionedHostWorkspace implements HostWorkspace {
  readonly path: string;
  readonly managed: boolean;
  readonly isGitRepo: boolean;
  readonly isWorktree: boolean;

  private readonly ws: Workspace;
  private readonly destroyFn: () => Promise<void>;

  constructor(opts: {
    path: string;
    managed: boolean;
    isGitRepo: boolean;
    isWorktree: boolean;
    destroyFn: () => Promise<void>;
  }) {
    this.path = opts.path;
    this.managed = opts.managed;
    this.isGitRepo = opts.isGitRepo;
    this.isWorktree = opts.isWorktree;
    this.ws = new Workspace(opts.path);
    this.destroyFn = opts.destroyFn;
  }

  async getCurrentBranch(): Promise<string | null> {
    return (await this.ws.currentBranch) ?? null;
  }

  getHeadSha(): Promise<string | null> {
    return this.ws.getHeadSha();
  }

  getLocalStateFingerprint(): Promise<string> {
    return this.ws.getLocalStateFingerprint();
  }

  getSharedGitRefsFingerprint(): Promise<string> {
    return this.ws.getSharedGitRefsFingerprint();
  }

  getAdditionalWorkspaceWriteRoots(): Promise<string[]> {
    if (!this.isGitRepo || !this.isWorktree) {
      return Promise.resolve([]);
    }
    return resolveAdditionalWorkspaceWriteRoots(this.path);
  }

  getStatus(options?: StatusOptions): Promise<WorkspaceStatus> {
    return this.ws.getStatus(options);
  }

  getDiff(options?: DiffOptions): Promise<DiffResult> {
    return this.ws.getDiff(options);
  }

  listBranches(): Promise<string[]> {
    return this.ws.getBranches();
  }

  listFiles(): Promise<string[]> {
    return this.ws.listFiles();
  }

  commit(options: CommitOptions): Promise<CommitResult> {
    return this.ws.commit(options);
  }

  reset(): Promise<void> {
    return this.ws.reset();
  }

  fetch(options?: FetchOptions): Promise<void> {
    return this.ws.fetch(options);
  }

  squashMerge(options: SquashMergeOptions): Promise<SquashMergeResult> {
    return this.ws.squashMergeInto(options);
  }

  destroy(): Promise<void> {
    return this.destroyFn();
  }
}

// ---------------------------------------------------------------------------
// provisionWorkspace
// ---------------------------------------------------------------------------

export interface OpenWorkspaceArgs {
  path: string;
}

export async function openWorkspace(
  args: OpenWorkspaceArgs,
): Promise<HostWorkspace> {
  return provisionWorkspace({
    workspaceProvisionType: "unmanaged",
    path: args.path,
  });
}

export async function provisionWorkspace(
  opts: ProvisionWorkspaceArgs,
): Promise<HostWorkspace> {
  switch (opts.workspaceProvisionType) {
    case "unmanaged":
      return provisionUnmanaged(opts);
    case "managed-worktree":
      return provisionWorktree(opts);
    case "managed-clone":
      return provisionClone(opts);
    case "reconnect-managed-worktree":
      return reconnectManagedWorktree(opts);
    case "reconnect-managed-clone":
      return reconnectManagedClone(opts);
  }
}

interface ApplyUnmanagedCheckoutArgs {
  cwd: string;
  checkout: UnmanagedCheckoutOpts;
  onProgress: ProvisionProgressCallback | undefined;
}

async function applyUnmanagedCheckout(
  args: ApplyUnmanagedCheckoutArgs,
): Promise<void> {
  const { cwd, checkout, onProgress } = args;
  // `switch -C` for new (create-or-reset) and `switch` for existing.
  const switchArgs =
    checkout.kind === "new"
      ? ["switch", "-C", checkout.name]
      : ["switch", checkout.name];
  const waitingStartedAt = Date.now();
  onProgress?.({
    type: "step",
    key: "git-checkout-waiting",
    text:
      checkout.kind === "new"
        ? `Waiting to create branch ${checkout.name}`
        : `Waiting to switch to branch ${checkout.name}`,
    status: "started",
    startedAt: waitingStartedAt,
  });
  let startedAt = waitingStartedAt;
  let waitingCompleted = false;
  try {
    await withCheckoutMutationAdmission(cwd, async () => {
      if (!(await pathExists(cwd))) {
        throw new WorkspaceError(
          "path_not_found",
          `Unmanaged workspace path does not exist: ${cwd}`,
        );
      }
      if (!(await detectGitRepo(cwd))) {
        throw new WorkspaceError(
          "not_git_repo",
          `Cannot checkout branch on non-git workspace: ${cwd}`,
        );
      }

      await withCheckoutMutationLock(cwd, async () => {
        const lockAcquiredAt = Date.now();
        onProgress?.({
          type: "step",
          key: "git-checkout-waiting",
          text:
            checkout.kind === "new"
              ? `Ready to create branch ${checkout.name}`
              : `Ready to switch to branch ${checkout.name}`,
          status: "completed",
          startedAt: waitingStartedAt,
          metadata: { durationMs: lockAcquiredAt - waitingStartedAt },
        });
        waitingCompleted = true;
        startedAt = lockAcquiredAt;
        onProgress?.({
          type: "step",
          key: "git-checkout-started",
          text:
            checkout.kind === "new"
              ? `Creating branch ${checkout.name}`
              : `Switching to branch ${checkout.name}`,
          status: "started",
          startedAt,
        });
        await runGit(switchArgs, { cwd });
      });
    });
    waitingCompleted = true;
    onProgress?.({
      type: "step",
      key: "git-checkout-completed",
      text:
        checkout.kind === "new"
          ? `Created branch ${checkout.name}`
          : `Switched to branch ${checkout.name}`,
      status: "completed",
      startedAt,
      metadata: { durationMs: Date.now() - startedAt },
    });
  } catch (error) {
    const failedAt = Date.now();
    if (!waitingCompleted) {
      onProgress?.({
        type: "step",
        key: "git-checkout-waiting",
        text:
          checkout.kind === "new"
            ? `Failed waiting to create branch ${checkout.name}`
            : `Failed waiting to switch to branch ${checkout.name}`,
        status: "failed",
        startedAt: waitingStartedAt,
        metadata: { durationMs: failedAt - waitingStartedAt },
      });
    }
    onProgress?.({
      type: "step",
      key: "git-checkout-failed",
      text:
        checkout.kind === "new"
          ? `Failed to create branch ${checkout.name}`
          : `Failed to switch to branch ${checkout.name}`,
      status: "failed",
      startedAt,
      metadata: { durationMs: failedAt - startedAt },
    });
    throw error;
  }
}

async function provisionUnmanaged(
  opts: UnmanagedWorkspaceOpts,
): Promise<HostWorkspace> {
  let isGitRepo: boolean;
  if (opts.checkout) {
    await applyUnmanagedCheckout({
      cwd: opts.path,
      checkout: opts.checkout,
      onProgress: opts.onProgress,
    });
    isGitRepo = true;
  } else {
    if (!(await pathExists(opts.path))) {
      throw new WorkspaceError(
        "path_not_found",
        `Unmanaged workspace path does not exist: ${opts.path}`,
      );
    }
    isGitRepo = await detectGitRepo(opts.path);
  }
  const isWorktree = isGitRepo ? await detectWorktree(opts.path) : false;

  return new ProvisionedHostWorkspace({
    path: opts.path,
    managed: false,
    isGitRepo,
    isWorktree,
    destroyFn: async () => {
      // no-op for unmanaged workspaces
    },
  });
}

async function provisionWorktree(
  opts: ManagedWorktreeOpts,
): Promise<HostWorkspace> {
  const { path: wsPath } = await createWorktree({
    sourcePath: opts.sourcePath,
    targetPath: opts.targetPath,
    branchName: opts.branchName,
    baseBranch: opts.baseBranch,
    timeoutMs: opts.timeoutMs,
    onProgress: opts.onProgress,
  });

  return new ProvisionedHostWorkspace({
    path: wsPath,
    managed: true,
    isGitRepo: true,
    isWorktree: true,
    destroyFn: () => removeWorktree({ path: wsPath, force: true }),
  });
}

async function provisionClone(opts: ManagedCloneOpts): Promise<HostWorkspace> {
  const { path: wsPath } = await createClone({
    sourcePath: opts.sourcePath,
    targetPath: opts.targetPath,
    branchName: opts.branchName,
    baseBranch: opts.baseBranch,
    timeoutMs: opts.timeoutMs,
    onProgress: opts.onProgress,
  });

  return new ProvisionedHostWorkspace({
    path: wsPath,
    managed: true,
    isGitRepo: true,
    isWorktree: false,
    destroyFn: () => removeDirectory({ path: wsPath }),
  });
}

async function reconnectManaged(
  wsPath: string,
  destroyFn: () => Promise<void>,
): Promise<HostWorkspace> {
  if (!(await pathExists(wsPath))) {
    throw new WorkspaceError(
      "path_not_found",
      `Managed workspace path does not exist: ${wsPath}`,
    );
  }

  const isGitRepo = await detectGitRepo(wsPath);
  const isWorktree = isGitRepo ? await detectWorktree(wsPath) : false;

  return new ProvisionedHostWorkspace({
    path: wsPath,
    managed: true,
    isGitRepo,
    isWorktree,
    destroyFn,
  });
}

async function reconnectManagedWorktree(
  opts: ReconnectManagedWorktreeOpts,
): Promise<HostWorkspace> {
  return reconnectManaged(opts.path, () =>
    removeWorktree({ path: opts.path, force: true }),
  );
}

async function reconnectManagedClone(
  opts: ReconnectManagedCloneOpts,
): Promise<HostWorkspace> {
  return reconnectManaged(opts.path, () =>
    removeDirectory({ path: opts.path }),
  );
}
