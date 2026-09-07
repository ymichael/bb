import { mkdir, realpath, rm } from "node:fs/promises";
import path from "node:path";
import type { ProvisioningTranscriptEntry, WorkspaceStatus } from "@bb/domain";
import type {
  CommitOptions,
  CommitResult,
  DiffOptions,
  DiffResult,
  DiffFilesArgs,
  DiffFilesResult,
  DiffPatchArgs,
  DiffPatchEntry,
  PullRequestActionOptions,
  StatusOptions,
} from "./workspace.js";
import { Workspace } from "./workspace.js";
import type {
  GitHostCliOptions,
  GitHostPullRequestLookup,
} from "./git-host.js";
import {
  withCheckoutMutationAdmission,
  withCheckoutMutationLock,
} from "./checkout-mutation-lock.js";
import {
  createWorktree,
  removeWorktree,
  throwIfProvisionAborted,
} from "./provisioning.js";
import {
  detectGitRepo,
  getAbsoluteGitDir,
  getCheckoutRef,
  getGitCommonDir,
  getWorkspaceGitOperation,
  hasUncommittedChanges,
  listBranches,
  pathExists,
  readDefaultBranch,
  runGit,
  WorkspaceError,
  type GitProcessOptions,
} from "./git.js";
import { resolveAdditionalWorkspaceWriteRoots } from "./workspace-write-roots.js";

type ProvisionProgressCallback = (entry: ProvisioningTranscriptEntry) => void;

export interface DestroyWorkspaceArgs {
  /** Teardown script timeout in ms. Controlled by the server. */
  timeoutMs: number;
  onProgress?: ProvisionProgressCallback;
}

interface ProvisionBase {
  onProgress?: ProvisionProgressCallback;
  shellPath?: string;
  signal?: AbortSignal;
}

type UnmanagedCheckoutOpts =
  | {
      kind: "existing";
      name: string;
    }
  | {
      kind: "new";
      name: string;
      baseBranch: string;
    };

interface UnmanagedWorkspaceOpts extends ProvisionBase {
  workspaceProvisionType: "unmanaged";
  path: string;
  checkout?: UnmanagedCheckoutOpts;
}

interface ManagedWorkspaceBaseOpts extends ProvisionBase {
  sourcePath: string;
  targetPath: string;
  branchName: string;
  baseBranch: string | null;
  timeoutMs: number;
}

interface ManagedWorktreeOpts extends ManagedWorkspaceBaseOpts {
  workspaceProvisionType: "managed-worktree";
}

interface ReconnectManagedWorktreeOpts extends ProvisionBase {
  workspaceProvisionType: "reconnect-managed-worktree";
  path: string;
}

interface PersonalWorkspaceOpts extends ProvisionBase {
  workspaceProvisionType: "personal";
  environmentId: string;
  personalWorkspaceRoot: string;
  targetPath: string;
}

export type ProvisionWorkspaceArgs =
  | UnmanagedWorkspaceOpts
  | ManagedWorktreeOpts
  | PersonalWorkspaceOpts
  | ReconnectManagedWorktreeOpts;

interface ValidatePersonalWorkspaceTargetPathArgs {
  environmentId: string;
  personalWorkspaceRoot: string;
  targetPath: string;
}

const WORKSPACE_BRANCH_GIT_TIMEOUT_MS = 15_000;

export interface HostWorkspace {
  readonly path: string;
  readonly managed: boolean;
  readonly isGitRepo: boolean;
  readonly isWorktree: boolean;

  getDefaultBranch(): Promise<string | null>;
  getCurrentBranch(): Promise<string | null>;
  getHeadSha(): Promise<string | null>;
  getLocalStateFingerprint(): Promise<string>;
  getSharedGitRefsFingerprint(): Promise<string>;
  getAdditionalWorkspaceWriteRoots(): Promise<string[]>;
  getStatus(options?: StatusOptions): Promise<WorkspaceStatus>;
  getDiff(options?: DiffOptions): Promise<DiffResult>;
  diffFiles(args: DiffFilesArgs): Promise<DiffFilesResult>;
  diffPatch(args: DiffPatchArgs): Promise<DiffPatchEntry[]>;
  getPullRequest(
    options?: GitHostCliOptions,
  ): Promise<GitHostPullRequestLookup>;
  runPullRequestAction(
    action: PullRequestActionOptions,
    options?: GitHostCliOptions,
  ): Promise<void>;
  listFiles(): Promise<string[]>;

  commit(options: CommitOptions): Promise<CommitResult>;
  reset(): Promise<void>;

  destroy(args: DestroyWorkspaceArgs): Promise<void>;
}

async function detectWorktree(
  cwd: string,
  options: GitProcessOptions,
): Promise<boolean> {
  const gitDirResult = await runGit(["rev-parse", "--git-dir"], {
    cwd,
    ...options,
    allowFailure: true,
  });
  if (gitDirResult.exitCode !== 0) return false;

  const gitDir = gitDirResult.stdout.trim();
  return gitDir.includes("/worktrees/");
}

class ProvisionedHostWorkspace implements HostWorkspace {
  readonly path: string;
  readonly managed: boolean;
  readonly isGitRepo: boolean;
  readonly isWorktree: boolean;

  private readonly ws: Workspace;
  private readonly gitProcessOptions: GitProcessOptions;
  private readonly destroyFn: (args: DestroyWorkspaceArgs) => Promise<void>;

  constructor(opts: {
    path: string;
    managed: boolean;
    isGitRepo: boolean;
    isWorktree: boolean;
    shellPath?: string;
    destroyFn: (args: DestroyWorkspaceArgs) => Promise<void>;
  }) {
    this.path = opts.path;
    this.managed = opts.managed;
    this.isGitRepo = opts.isGitRepo;
    this.isWorktree = opts.isWorktree;
    this.gitProcessOptions = {
      ...(opts.shellPath !== undefined ? { shellPath: opts.shellPath } : {}),
    };
    this.ws = new Workspace(opts.path, this.gitProcessOptions);
    this.destroyFn = opts.destroyFn;
  }

  async getCurrentBranch(): Promise<string | null> {
    return (await this.ws.currentBranch) ?? null;
  }

  async getDefaultBranch(): Promise<string | null> {
    if (!this.isGitRepo) {
      return null;
    }
    return (
      (await readDefaultBranch(this.path, {
        timeoutMs: WORKSPACE_BRANCH_GIT_TIMEOUT_MS,
        ...this.gitProcessOptions,
      })) ?? null
    );
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
    return resolveAdditionalWorkspaceWriteRoots(
      this.path,
      this.gitProcessOptions,
    );
  }

  getStatus(options?: StatusOptions): Promise<WorkspaceStatus> {
    return this.ws.getStatus(options);
  }

  getDiff(options?: DiffOptions): Promise<DiffResult> {
    return this.ws.getDiff(options);
  }

  diffFiles(args: DiffFilesArgs): Promise<DiffFilesResult> {
    return this.ws.diffFiles(args);
  }

  diffPatch(args: DiffPatchArgs): Promise<DiffPatchEntry[]> {
    return this.ws.diffPatch(args);
  }

  getPullRequest(
    options?: GitHostCliOptions,
  ): Promise<GitHostPullRequestLookup> {
    return this.ws.getPullRequest(options);
  }

  runPullRequestAction(
    action: PullRequestActionOptions,
    options?: GitHostCliOptions,
  ): Promise<void> {
    return this.ws.runPullRequestAction(action, options);
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

  destroy(args: DestroyWorkspaceArgs): Promise<void> {
    return this.destroyFn(args);
  }
}

export async function provisionWorkspace(
  opts: ProvisionWorkspaceArgs,
): Promise<HostWorkspace> {
  switch (opts.workspaceProvisionType) {
    case "unmanaged":
      return provisionUnmanaged(opts);
    case "managed-worktree":
      return provisionWorktree(opts);
    case "personal":
      return provisionPersonalWorkspace(opts);
    case "reconnect-managed-worktree":
      return reconnectManagedWorktree(opts);
  }
}

function isRelativeChildPath(relativePath: string): boolean {
  return (
    relativePath.length > 0 &&
    relativePath !== "." &&
    !relativePath.startsWith(`..${path.sep}`) &&
    relativePath !== ".." &&
    !path.isAbsolute(relativePath)
  );
}

function isSamePathOrNestedUnder(
  candidatePath: string,
  rootPath: string,
): boolean {
  const relativePath = path.relative(rootPath, candidatePath);
  return relativePath === "" || isRelativeChildPath(relativePath);
}

async function hasContainedPersonalGitMetadata(
  targetPath: string,
  options: GitProcessOptions,
): Promise<boolean> {
  const [resolvedTargetPath, gitDir, commonGitDir] = await Promise.all([
    realpath(targetPath),
    getAbsoluteGitDir(targetPath, options),
    getGitCommonDir(targetPath, options),
  ]);
  const [resolvedGitDir, resolvedCommonGitDir] = await Promise.all([
    realpath(gitDir),
    realpath(commonGitDir),
  ]);
  return (
    isSamePathOrNestedUnder(resolvedGitDir, resolvedTargetPath) &&
    isSamePathOrNestedUnder(resolvedCommonGitDir, resolvedTargetPath)
  );
}

export function getPersonalWorkspaceRoot(dataDir: string): string {
  return path.resolve(dataDir, "personal-workspaces");
}

export function validatePersonalWorkspaceTargetPath(
  args: ValidatePersonalWorkspaceTargetPathArgs,
): string {
  if (
    path.basename(args.environmentId) !== args.environmentId ||
    args.environmentId === "." ||
    args.environmentId === ".."
  ) {
    throw new WorkspaceError(
      "invalid_personal_workspace_path",
      "Personal workspace environmentId must be a single path segment",
    );
  }

  const root = path.resolve(args.personalWorkspaceRoot);
  const expectedTargetPath = path.resolve(root, args.environmentId);
  const rootRelativeExpectedPath = path.relative(root, expectedTargetPath);
  if (!isRelativeChildPath(rootRelativeExpectedPath)) {
    throw new WorkspaceError(
      "invalid_personal_workspace_path",
      "Personal workspace target path must be under the personal workspace root",
    );
  }

  const targetPath = path.resolve(args.targetPath);
  if (targetPath !== expectedTargetPath) {
    throw new WorkspaceError(
      "invalid_personal_workspace_path",
      "Personal workspace target path must match the environment id",
    );
  }

  return targetPath;
}

interface ApplyUnmanagedCheckoutArgs {
  cwd: string;
  checkout: UnmanagedCheckoutOpts;
  onProgress: ProvisionProgressCallback | undefined;
  shellPath: string | undefined;
  signal: AbortSignal | undefined;
}

interface ValidateUnmanagedCheckoutArgs {
  cwd: string;
  checkout: UnmanagedCheckoutOpts;
  shellPath: string | undefined;
  signal: AbortSignal | undefined;
}

interface CheckoutCompletedTextArgs {
  checkout: UnmanagedCheckoutOpts;
  alreadyOnTarget: boolean;
}

type UnmanagedCheckoutPreflightResult =
  | { kind: "already-current" }
  | { kind: "ready" };

function formatOperationKind(kind: string): string {
  switch (kind) {
    case "cherry-pick":
      return "cherry-pick";
    default:
      return kind;
  }
}

function getCheckoutCompletedText(args: CheckoutCompletedTextArgs): string {
  const { checkout, alreadyOnTarget } = args;
  if (alreadyOnTarget) {
    return `Already on branch ${checkout.name}`;
  }
  if (checkout.kind === "new") {
    return `Created branch ${checkout.name}`;
  }
  return `Switched to branch ${checkout.name}`;
}

async function validateUnmanagedCheckout(
  args: ValidateUnmanagedCheckoutArgs,
): Promise<UnmanagedCheckoutPreflightResult> {
  const { cwd, checkout } = args;
  const gitProcessOptions =
    args.shellPath === undefined ? {} : { shellPath: args.shellPath };
  throwIfProvisionAborted(args.signal);
  const checkoutRef = await getCheckoutRef(cwd, gitProcessOptions);
  if (
    checkoutRef.kind === "branch" &&
    checkoutRef.branchName === checkout.name
  ) {
    return { kind: "already-current" };
  }
  if (
    checkoutRef.kind === "unborn" &&
    checkoutRef.branchName === checkout.name
  ) {
    return { kind: "already-current" };
  }

  switch (checkoutRef.kind) {
    case "branch":
      break;
    case "detached":
      throw new WorkspaceError(
        "checkout_detached",
        "Cannot checkout branch while the workspace is on a detached HEAD",
      );
    case "unborn":
      throw new WorkspaceError(
        "checkout_unborn",
        "Cannot checkout branch before the current branch has an initial commit",
      );
    case "unknown":
      throw new WorkspaceError(
        "checkout_unknown",
        `Cannot inspect current checkout: ${checkoutRef.reason}`,
      );
  }

  if (checkout.kind === "existing") {
    const branches = await listBranches(cwd, gitProcessOptions);
    if (!branches.includes(checkout.name)) {
      throw new WorkspaceError(
        "checkout_missing_branch",
        `Cannot checkout missing branch ${checkout.name}`,
      );
    }
  }

  const operation = await getWorkspaceGitOperation(cwd, gitProcessOptions);
  if (operation.kind !== "none" && operation.hasConflicts) {
    throw new WorkspaceError(
      "checkout_conflicts",
      `Cannot checkout branch while ${formatOperationKind(
        operation.kind,
      )} has unresolved conflicts`,
    );
  }
  if (operation.kind !== "none") {
    throw new WorkspaceError(
      "checkout_in_progress_operation",
      `Cannot checkout branch while ${formatOperationKind(
        operation.kind,
      )} is in progress`,
    );
  }

  if (await hasUncommittedChanges(cwd, gitProcessOptions)) {
    throw new WorkspaceError(
      "checkout_dirty",
      "Cannot checkout branch while the workspace has uncommitted changes",
    );
  }

  return { kind: "ready" };
}

async function applyUnmanagedCheckout(
  args: ApplyUnmanagedCheckoutArgs,
): Promise<void> {
  const { cwd, checkout, onProgress, signal } = args;
  const gitProcessOptions =
    args.shellPath === undefined ? {} : { shellPath: args.shellPath };
  throwIfProvisionAborted(signal);
  const switchArgs =
    checkout.kind === "new"
      ? ["switch", "-C", checkout.name, checkout.baseBranch]
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
  let alreadyOnTarget = false;
  try {
    await withCheckoutMutationAdmission(
      cwd,
      async () => {
        throwIfProvisionAborted(signal);
        if (!(await pathExists(cwd))) {
          throw new WorkspaceError(
            "path_not_found",
            `Unmanaged workspace path does not exist: ${cwd}`,
          );
        }
        if (!(await detectGitRepo(cwd, gitProcessOptions))) {
          throw new WorkspaceError(
            "not_git_repo",
            `Cannot checkout branch on non-git workspace: ${cwd}`,
          );
        }

        await withCheckoutMutationLock(
          cwd,
          async () => {
            throwIfProvisionAborted(signal);
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
            const preflightResult = await validateUnmanagedCheckout({
              cwd,
              checkout,
              shellPath: args.shellPath,
              signal,
            });
            if (preflightResult.kind === "already-current") {
              alreadyOnTarget = true;
              return;
            }
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
            await runGit(switchArgs, { cwd, signal, ...gitProcessOptions });
          },
          signal,
          gitProcessOptions,
        );
      },
      signal,
    );
    waitingCompleted = true;
    onProgress?.({
      type: "step",
      key: "git-checkout-completed",
      text: getCheckoutCompletedText({ checkout, alreadyOnTarget }),
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
  throwIfProvisionAborted(opts.signal);
  if (opts.checkout) {
    await applyUnmanagedCheckout({
      cwd: opts.path,
      checkout: opts.checkout,
      onProgress: opts.onProgress,
      shellPath: opts.shellPath,
      signal: opts.signal,
    });
    isGitRepo = true;
  } else {
    throwIfProvisionAborted(opts.signal);
    if (!(await pathExists(opts.path))) {
      throw new WorkspaceError(
        "path_not_found",
        `Unmanaged workspace path does not exist: ${opts.path}`,
      );
    }
    isGitRepo = await detectGitRepo(opts.path, {
      ...(opts.shellPath !== undefined ? { shellPath: opts.shellPath } : {}),
    });
  }
  const gitProcessOptions =
    opts.shellPath === undefined ? {} : { shellPath: opts.shellPath };
  const isWorktree = isGitRepo
    ? await detectWorktree(opts.path, gitProcessOptions)
    : false;

  return new ProvisionedHostWorkspace({
    path: opts.path,
    managed: false,
    isGitRepo,
    isWorktree,
    shellPath: opts.shellPath,
    destroyFn: async () => {},
  });
}

async function provisionWorktree(
  opts: ManagedWorktreeOpts,
): Promise<HostWorkspace> {
  throwIfProvisionAborted(opts.signal);
  const { path: wsPath } = await createWorktree({
    sourcePath: opts.sourcePath,
    targetPath: opts.targetPath,
    branchName: opts.branchName,
    baseBranch: opts.baseBranch,
    timeoutMs: opts.timeoutMs,
    shellPath: opts.shellPath,
    onProgress: opts.onProgress,
    pruneEmptyParent: true,
    signal: opts.signal,
  });

  return new ProvisionedHostWorkspace({
    path: wsPath,
    managed: true,
    isGitRepo: true,
    isWorktree: true,
    shellPath: opts.shellPath,
    destroyFn: (args) =>
      removeWorktree({
        path: wsPath,
        timeoutMs: args.timeoutMs,
        force: true,
        pruneEmptyParent: true,
        shellPath: opts.shellPath,
        ...(args.onProgress !== undefined
          ? { onProgress: args.onProgress }
          : {}),
      }),
  });
}

async function provisionPersonalWorkspace(
  opts: PersonalWorkspaceOpts,
): Promise<HostWorkspace> {
  throwIfProvisionAborted(opts.signal);
  const targetPath = validatePersonalWorkspaceTargetPath(opts);
  const targetExisted = await pathExists(targetPath);
  await mkdir(targetPath, { recursive: true });
  try {
    throwIfProvisionAborted(opts.signal);
  } catch (error) {
    if (!targetExisted) {
      await rm(targetPath, { recursive: true, force: true });
    }
    throw error;
  }

  const detectedGitRepo = targetExisted
    ? await detectGitRepo(targetPath, {
        ...(opts.shellPath !== undefined ? { shellPath: opts.shellPath } : {}),
      })
    : false;
  const isGitRepo = detectedGitRepo
    ? await hasContainedPersonalGitMetadata(targetPath, {
        ...(opts.shellPath !== undefined ? { shellPath: opts.shellPath } : {}),
      })
    : false;
  const isWorktree = isGitRepo
    ? await detectWorktree(targetPath, {
        ...(opts.shellPath !== undefined ? { shellPath: opts.shellPath } : {}),
      })
    : false;

  return new ProvisionedHostWorkspace({
    path: targetPath,
    managed: true,
    isGitRepo,
    isWorktree,
    shellPath: opts.shellPath,
    destroyFn: () => rm(targetPath, { recursive: true, force: true }),
  });
}

async function reconnectManaged(
  wsPath: string,
  destroyFn: (args: DestroyWorkspaceArgs) => Promise<void>,
  shellPath: string | undefined,
  signal: AbortSignal | undefined,
): Promise<HostWorkspace> {
  throwIfProvisionAborted(signal);
  if (!(await pathExists(wsPath))) {
    throw new WorkspaceError(
      "path_not_found",
      `Managed workspace path does not exist: ${wsPath}`,
    );
  }

  const gitProcessOptions = shellPath === undefined ? {} : { shellPath };
  const isGitRepo = await detectGitRepo(wsPath, gitProcessOptions);
  const isWorktree = isGitRepo
    ? await detectWorktree(wsPath, gitProcessOptions)
    : false;

  return new ProvisionedHostWorkspace({
    path: wsPath,
    managed: true,
    isGitRepo,
    isWorktree,
    shellPath,
    destroyFn,
  });
}

async function reconnectManagedWorktree(
  opts: ReconnectManagedWorktreeOpts,
): Promise<HostWorkspace> {
  return reconnectManaged(
    opts.path,
    (args) =>
      removeWorktree({
        path: opts.path,
        timeoutMs: args.timeoutMs,
        force: true,
        pruneEmptyParent: true,
        shellPath: opts.shellPath,
        ...(args.onProgress !== undefined
          ? { onProgress: args.onProgress }
          : {}),
      }),
    opts.shellPath,
    opts.signal,
  );
}
