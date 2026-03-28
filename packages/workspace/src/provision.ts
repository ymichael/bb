import type {
  ProvisioningTranscriptEntry,
  WorkspaceStatus,
} from "@bb/domain";
import type {
  CheckpointOptions,
  CheckpointResult,
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
import { promoteWorkspace, demoteWorkspace } from "./promote.js";
import {
  createWorktree,
  createClone,
  removeWorktree,
  removeDirectory,
} from "./provisioning.js";
import { detectGitRepo, pathExists, runGit, WorkspaceError } from "./git.js";

// ---------------------------------------------------------------------------
// Options (discriminated union on workspaceProvisionType from @bb/domain)
// ---------------------------------------------------------------------------

type ProgressCallback = (entry: ProvisioningTranscriptEntry) => void;

interface ProvisionBase {
  /** Progress callback for provisioning steps/output */
  onProgress?: ProgressCallback;
}

export interface UnmanagedWorkspaceOpts extends ProvisionBase {
  workspaceProvisionType: "unmanaged";
  /** Path to validate. Must exist. */
  path: string;
}

export interface ManagedWorktreeOpts extends ProvisionBase {
  workspaceProvisionType: "managed-worktree";
  /** Source repo path (the primary checkout) */
  sourcePath: string;
  /** Where to create the worktree */
  targetPath: string;
  /** Branch name for the worktree */
  branchName: string;
  /** Setup script filename (default: .bb-env-setup.sh) */
  scriptName?: string;
  /** Setup script timeout in ms (default: 5 min) */
  timeoutMs?: number;
}

export interface ManagedCloneOpts extends ProvisionBase {
  workspaceProvisionType: "managed-clone";
  /** Source repo path to clone from */
  sourcePath: string;
  /** Where to create the clone */
  targetPath: string;
  /** Branch name to create after cloning */
  branchName: string;
  /** Setup script filename (default: .bb-env-setup.sh) */
  scriptName?: string;
  /** Setup script timeout in ms (default: 5 min) */
  timeoutMs?: number;
}

export type ProvisionWorkspaceOpts =
  | UnmanagedWorkspaceOpts
  | ManagedWorktreeOpts
  | ManagedCloneOpts;

// ---------------------------------------------------------------------------
// IWorkspace interface
// ---------------------------------------------------------------------------

export interface IWorkspace {
  /** Absolute path to the workspace directory */
  readonly path: string;
  /** Whether the system manages this workspace's lifecycle */
  readonly managed: boolean;
  /** Whether this is a git repository */
  readonly isGitRepo: boolean;
  /** Whether this is a git worktree (vs. a standalone repo) */
  readonly isWorktree: boolean;

  // Git queries
  currentBranch(): Promise<string | null>;
  getStatus(options?: StatusOptions): Promise<WorkspaceStatus>;
  getDiff(options?: DiffOptions): Promise<DiffResult>;
  getBranches(): Promise<string[]>;

  // Git mutations
  commit(options: CommitOptions): Promise<CommitResult>;
  reset(): Promise<void>;
  fetch(options?: FetchOptions): Promise<void>;
  checkpoint(options: CheckpointOptions): Promise<CheckpointResult>;
  squashMergeInto(options: SquashMergeOptions): Promise<SquashMergeResult>;

  // Promote/demote
  promote(primary: IWorkspace, options?: { remote?: string }): Promise<void>;
  demote(args: {
    primary: IWorkspace;
    defaultBranch: string;
    envBranch?: string;
  }): Promise<void>;

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
// WorkspaceImpl — wraps Workspace + promote/demote + destroy
// ---------------------------------------------------------------------------

class WorkspaceImpl implements IWorkspace {
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

  async currentBranch(): Promise<string | null> {
    return (await this.ws.currentBranch) ?? null;
  }

  getStatus(): Promise<WorkspaceStatus> {
    return this.ws.getStatus();
  }

  getDiff(options?: DiffOptions): Promise<DiffResult> {
    return this.ws.getDiff(options);
  }

  getBranches(): Promise<string[]> {
    return this.ws.getBranches();
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

  checkpoint(options: CheckpointOptions): Promise<CheckpointResult> {
    return this.ws.checkpoint(options);
  }

  squashMergeInto(options: SquashMergeOptions): Promise<SquashMergeResult> {
    return this.ws.squashMergeInto(options);
  }

  async promote(
    primary: IWorkspace,
    options?: { remote?: string },
  ): Promise<void> {
    const primaryWs = new Workspace(primary.path);
    await promoteWorkspace(this.ws, primaryWs, options);
  }

  async demote(args: {
    primary: IWorkspace;
    defaultBranch: string;
    envBranch?: string;
  }): Promise<void> {
    const primaryWs = new Workspace(args.primary.path);
    const branch = args.envBranch ?? await this.ws.currentBranch;
    if (!branch) {
      throw new WorkspaceError(
        "Cannot demote: workspace has no branch (detached HEAD)",
      );
    }
    await demoteWorkspace({ source: this.ws, primary: primaryWs, defaultBranch: args.defaultBranch, envBranch: branch });
  }

  destroy(): Promise<void> {
    return this.destroyFn();
  }
}

// ---------------------------------------------------------------------------
// provisionWorkspace
// ---------------------------------------------------------------------------

export async function provisionWorkspace(
  opts: ProvisionWorkspaceOpts,
): Promise<IWorkspace> {
  switch (opts.workspaceProvisionType) {
    case "unmanaged":
      return provisionUnmanaged(opts);
    case "managed-worktree":
      return provisionWorktree(opts);
    case "managed-clone":
      return provisionClone(opts);
  }
}

async function provisionUnmanaged(
  opts: UnmanagedWorkspaceOpts,
): Promise<IWorkspace> {
  if (!(await pathExists(opts.path))) {
    throw new WorkspaceError(
      `Unmanaged workspace path does not exist: ${opts.path}`,
    );
  }

  const isGitRepo = await detectGitRepo(opts.path);
  const isWorktree = isGitRepo ? await detectWorktree(opts.path) : false;

  return new WorkspaceImpl({
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
): Promise<IWorkspace> {
  const { path: wsPath } = await createWorktree({
    sourcePath: opts.sourcePath,
    targetPath: opts.targetPath,
    branchName: opts.branchName,
    scriptName: opts.scriptName,
    timeoutMs: opts.timeoutMs,
    onProgress: opts.onProgress,
  });

  return new WorkspaceImpl({
    path: wsPath,
    managed: true,
    isGitRepo: true,
    isWorktree: true,
    destroyFn: () => removeWorktree({ path: wsPath, force: true }),
  });
}

async function provisionClone(
  opts: ManagedCloneOpts,
): Promise<IWorkspace> {
  const { path: wsPath } = await createClone({
    sourcePath: opts.sourcePath,
    targetPath: opts.targetPath,
    branchName: opts.branchName,
    scriptName: opts.scriptName,
    timeoutMs: opts.timeoutMs,
    onProgress: opts.onProgress,
  });

  return new WorkspaceImpl({
    path: wsPath,
    managed: true,
    isGitRepo: true,
    isWorktree: false,
    destroyFn: () => removeDirectory({ path: wsPath }),
  });
}
