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
import { promoteWorkspace, demoteWorkspace } from "./promote.js";
import {
  createWorktree,
  createClone,
  removeWorktree,
  removeDirectory,
} from "./provisioning.js";
import {
  detectGitRepo,
  pathExists,
  runGit,
  WorkspaceError,
} from "./git.js";

// ---------------------------------------------------------------------------
// Options (discriminated union on workspaceProvisionType from @bb/domain)
// ---------------------------------------------------------------------------

type ProvisionProgressCallback = (entry: ProvisioningTranscriptEntry) => void;

interface ProvisionBase {
  /** Progress callback for provisioning steps/output */
  onProgress?: ProvisionProgressCallback;
}

export interface UnmanagedWorkspaceOpts extends ProvisionBase {
  workspaceProvisionType: "unmanaged";
  /** Path to validate. Must exist. */
  path: string;
}

export interface ManagedWorkspaceBaseOpts extends ProvisionBase {
  /** Source repo path */
  sourcePath: string;
  /** Target path for worktree/clone creation */
  targetPath: string;
  /** Branch name */
  branchName: string;
  /** Setup script filename. Controlled by the server. */
  scriptName: string;
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
  getStatus(options?: StatusOptions): Promise<WorkspaceStatus>;
  getDiff(options?: DiffOptions): Promise<DiffResult>;
  listBranches(): Promise<string[]>;
  listFiles(): Promise<string[]>;

  // Git mutations
  commit(options: CommitOptions): Promise<CommitResult>;
  reset(): Promise<void>;
  fetch(options?: FetchOptions): Promise<void>;
  squashMerge(options: SquashMergeOptions): Promise<SquashMergeResult>;

  // Promote/demote
  promote(primary: HostWorkspace): Promise<void>;
  demote(args: {
    primary: HostWorkspace;
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

  async promote(primary: HostWorkspace): Promise<void> {
    const primaryWs = new Workspace(primary.path);
    await promoteWorkspace(this.ws, primaryWs);
  }

  async demote(args: {
    primary: HostWorkspace;
    defaultBranch: string;
    envBranch?: string;
  }): Promise<void> {
    const primaryWs = new Workspace(args.primary.path);
    const branch = args.envBranch ?? await this.ws.currentBranch;
    if (!branch) {
      throw new WorkspaceError(
        "detached_head",
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

async function provisionUnmanaged(
  opts: UnmanagedWorkspaceOpts,
): Promise<HostWorkspace> {
  if (!(await pathExists(opts.path))) {
    throw new WorkspaceError(
      "path_not_found",
      `Unmanaged workspace path does not exist: ${opts.path}`,
    );
  }

  const isGitRepo = await detectGitRepo(opts.path);
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
    scriptName: opts.scriptName,
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

async function provisionClone(
  opts: ManagedCloneOpts,
): Promise<HostWorkspace> {
  const { path: wsPath } = await createClone({
    sourcePath: opts.sourcePath,
    targetPath: opts.targetPath,
    branchName: opts.branchName,
    scriptName: opts.scriptName,
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
  return reconnectManaged(opts.path, () => removeWorktree({ path: opts.path, force: true }));
}

async function reconnectManagedClone(
  opts: ReconnectManagedCloneOpts,
): Promise<HostWorkspace> {
  return reconnectManaged(opts.path, () => removeDirectory({ path: opts.path }));
}
