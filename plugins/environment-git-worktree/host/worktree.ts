import { experimental_killProcessesWithCwdUnder } from "@get-bb/plugin-sdk/host";
import fs from "node:fs/promises";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import {
  findWorktreeForBranch,
  getCurrentBranch,
  getGitCommonDir,
  hasRef,
  readDefaultBranch,
  readGitRepositoryState,
  runGit,
  WorkspaceError,
  type GitProcessOptions,
} from "bb-environment-provider-host/git";
import {
  ProcessLocalQueuedLockTimeoutError,
  runGitWithWorktreeMetadataLock,
  tryWithCheckoutMutationLock,
  withGitRefMutationLock,
  withWorktreeMetadataLock,
} from "bb-environment-provider-host/locks";
import { runSetupScript, runTeardownScript } from "./setup-script.js";
import {
  createProvisionCancelledError,
  emitCwd,
  emitGitOutput,
  emitOutput,
  emitStep,
  isProvisionAbortError,
  throwIfProvisionAborted,
  type ProgressCallback,
} from "bb-environment-provider-host/transcript";
import {
  copyWorktreeIncludeFiles,
  WORKTREE_INCLUDE_FILE_NAME,
  type CopyWorktreeIncludeFilesResult,
} from "./worktree-include.js";

export type BranchMode = "reset" | "reuse-existing";

interface CreateWorktreeArgs {
  sourcePath: string;
  targetPath: string;
  completionPath: string;
  ownWorktreesRoot: string;
  branchName: string;
  baseBranch: string | null;
  branchMode: BranchMode;
  timeoutMs: number;
  shellPath?: string | undefined;
  onProgress?: ProgressCallback | undefined;
  pruneEmptyParent?: boolean;
  signal?: AbortSignal | undefined;
}

interface RemoveWorktreeArgs {
  path: string;
  timeoutMs: number;
  force?: boolean;
  pruneEmptyParent?: boolean;
  shellPath?: string | undefined;
  onProgress?: ProgressCallback | undefined;
  signal?: AbortSignal | undefined;
}

const REMOTE_BASE_FETCH_TIMEOUT_MS = 60_000;
const REMOTE_REF_LOCK_RETRY_INTERVAL_MS = 200;
const REMOTE_REF_LOCK_RETRY_TIMEOUT_MS = 2_000;
const WORKTREE_INCLUDE_TRANSCRIPT_PATH_LIMIT = 20;

type ConcurrentRemoteRefUpdateErrorKind = "stale-value" | "lock-file-exists";

function classifyConcurrentRemoteRefUpdateError(
  error: unknown,
  remoteRef: string,
): ConcurrentRemoteRefUpdateErrorKind | null {
  if (
    !(error instanceof WorkspaceError) ||
    error.code !== "git_command_failed"
  ) {
    return null;
  }

  if (
    error.message.endsWith(
      `error: fetching ref ${remoteRef} failed: reference already exists`,
    )
  ) {
    return "lock-file-exists";
  }

  const lockFailurePrefix = `cannot lock ref '${remoteRef}': `;
  const lockFailureDetail = error.message.split(lockFailurePrefix)[1];
  if (lockFailureDetail === undefined) {
    return null;
  }

  if (
    /^is at [0-9a-f]+ but expected [0-9a-f]+(?:\n|$)/u.test(lockFailureDetail)
  ) {
    return "stale-value";
  }
  if (
    /^Unable to create '.+\.lock': File exists\.(?:\n|$)/u.test(
      lockFailureDetail,
    )
  ) {
    return "lock-file-exists";
  }
  return null;
}

async function ensureExistingWorkspaceMatches(
  targetPath: string,
  branchName: string,
  shellPath: string | undefined,
  signal: AbortSignal | undefined,
): Promise<boolean> {
  try {
    await fs.access(targetPath);
  } catch {
    return false;
  }

  const options: GitProcessOptions =
    shellPath !== undefined ? { shellPath } : {};
  try {
    const currentBranch = await getCurrentBranch(targetPath, options);
    throwIfProvisionAborted(signal);
    return currentBranch === branchName;
  } catch (error) {
    if (signal?.aborted) throw error;
    return false;
  }
}

async function realpathOrResolved(target: string): Promise<string> {
  try {
    return await fs.realpath(target);
  } catch {
    return path.resolve(target);
  }
}

async function isPathInside(root: string, target: string): Promise<boolean> {
  const relative = path.relative(
    await realpathOrResolved(root),
    await realpathOrResolved(target),
  );
  return (
    relative !== "" && !relative.startsWith("..") && !path.isAbsolute(relative)
  );
}

async function removeAbandonedAttemptWorktree(args: {
  sourcePath: string;
  ownWorktreesRoot: string;
  branchName: string;
  timeoutMs: number;
  shellPath: string | undefined;
  onProgress: ProgressCallback | undefined;
  signal: AbortSignal | undefined;
}): Promise<void> {
  const holder = await findWorktreeForBranch(args.sourcePath, args.branchName, {
    ...(args.shellPath !== undefined ? { shellPath: args.shellPath } : {}),
  });
  if (holder === null || !(await isPathInside(args.ownWorktreesRoot, holder))) {
    return;
  }
  throwIfProvisionAborted(args.signal);
  const status = await runGit(["status", "--porcelain"], {
    cwd: holder,
    ...(args.shellPath !== undefined ? { shellPath: args.shellPath } : {}),
    ...(args.signal !== undefined ? { signal: args.signal } : {}),
  });
  if (status.stdout.trim() !== "") {
    throw new WorkspaceError(
      "abandoned_worktree_dirty",
      `Branch ${args.branchName} is still checked out at ${holder} by an earlier attempt, and that worktree has uncommitted changes, so it was left alone. Remove it to retry.`,
    );
  }
  const startedAt = Date.now();
  emitStep({
    onProgress: args.onProgress,
    key: "abandoned-worktree-started",
    text: "Removing the worktree an earlier attempt left behind",
    status: "started",
    startedAt,
  });
  await removeWorktree({
    path: holder,
    timeoutMs: args.timeoutMs,
    force: true,
    pruneEmptyParent: true,
    ...(args.signal !== undefined ? { signal: args.signal } : {}),
    ...(args.shellPath !== undefined ? { shellPath: args.shellPath } : {}),
  });
  emitStep({
    onProgress: args.onProgress,
    key: "abandoned-worktree-completed",
    text: "Removed the worktree an earlier attempt left behind",
    status: "completed",
    startedAt,
    metadata: { durationMs: Date.now() - startedAt },
  });
}

async function ensureWorkspaceParentDirectory(
  targetPath: string,
): Promise<void> {
  await fs.mkdir(path.dirname(targetPath), { recursive: true });
}

async function waitForProvisionRetry(
  delayMs: number,
  signal: AbortSignal | undefined,
): Promise<void> {
  try {
    await delay(
      delayMs,
      undefined,
      signal !== undefined ? { signal } : undefined,
    );
  } catch (error) {
    if (signal?.aborted) {
      throw createProvisionCancelledError(error);
    }
    throw error;
  }
}

async function resolveRemoteBaseBranch(
  sourcePath: string,
  baseBranch: string,
  shellPath: string | undefined,
  signal: AbortSignal | undefined,
): Promise<{ remote: string; branch: string } | null> {
  if (!baseBranch.includes("/")) {
    return null;
  }

  const remotes = (
    await runGit(["remote"], {
      cwd: sourcePath,
      ...(signal !== undefined ? { signal } : {}),
      ...(shellPath !== undefined ? { shellPath } : {}),
    })
  ).stdout
    .split("\n")
    .map((remote) => remote.trim())
    .filter(Boolean);
  const matchingRemotes = remotes
    .filter(
      (remote) =>
        baseBranch.startsWith(`${remote}/`) &&
        baseBranch.length > remote.length + 1,
    )
    .sort((left, right) => right.length - left.length);
  const remote = matchingRemotes[0];
  if (!remote) {
    return null;
  }

  return {
    remote,
    branch: baseBranch.slice(remote.length + 1),
  };
}

export async function fetchRemoteBaseBranch(args: {
  sourcePath: string;
  baseBranch: string;
  fetchTimeoutMs: number;
  onProgress: ProgressCallback | undefined;
  shellPath: string | undefined;
  signal: AbortSignal | undefined;
}): Promise<void> {
  const remoteBase = await resolveRemoteBaseBranch(
    args.sourcePath,
    args.baseBranch,
    args.shellPath,
    args.signal,
  );
  if (!remoteBase) {
    return;
  }

  const startedAt = Date.now();
  emitStep({
    onProgress: args.onProgress,
    key: "git-fetch-started",
    text: `Fetching ${args.baseBranch}`,
    status: "started",
    startedAt,
  });

  const remoteRef = `refs/remotes/${remoteBase.remote}/${remoteBase.branch}`;
  const refspec = `+refs/heads/${remoteBase.branch}:${remoteRef}`;
  const gitProcessOptions = {
    ...(args.shellPath !== undefined ? { shellPath: args.shellPath } : {}),
    ...(args.signal !== undefined ? { signal: args.signal } : {}),
  };
  try {
    throwIfProvisionAborted(args.signal);
    const commonDir = await getGitCommonDir(args.sourcePath, gitProcessOptions);
    const fetchBaseBranch = async (): Promise<void> => {
      try {
        await withGitRefMutationLock(
          commonDir,
          () =>
            runGit(["fetch", "--quiet", remoteBase.remote, refspec], {
              cwd: args.sourcePath,
              ...gitProcessOptions,
              env: { GIT_TERMINAL_PROMPT: "0", LC_ALL: "C" },
              timeoutMs: args.fetchTimeoutMs,
            }),
          args.signal !== undefined ? { signal: args.signal } : {},
        );
      } catch (error) {
        if (args.signal?.aborted && !isProvisionAbortError(error)) {
          throw createProvisionCancelledError(error);
        }
        if (error instanceof ProcessLocalQueuedLockTimeoutError) {
          throw new WorkspaceError(
            "git_command_timeout",
            `Timed out waiting to fetch ${args.baseBranch} because another Git ref update is still running`,
            { cause: error },
          );
        }
        throw error;
      }
    };
    let staleValueRetried = false;
    let lockFileRetryDeadline: number | undefined;
    while (true) {
      try {
        await fetchBaseBranch();
        break;
      } catch (error) {
        const errorKind = classifyConcurrentRemoteRefUpdateError(
          error,
          remoteRef,
        );
        if (errorKind === null) {
          throw error;
        }
        if (errorKind === "stale-value") {
          if (staleValueRetried) {
            throw error;
          }
          staleValueRetried = true;
          throwIfProvisionAborted(args.signal);
          continue;
        }

        lockFileRetryDeadline ??= Date.now() + REMOTE_REF_LOCK_RETRY_TIMEOUT_MS;
        const remainingRetryMs = lockFileRetryDeadline - Date.now();
        if (remainingRetryMs <= 0) {
          throw error;
        }
        throwIfProvisionAborted(args.signal);
        await waitForProvisionRetry(
          Math.min(REMOTE_REF_LOCK_RETRY_INTERVAL_MS, remainingRetryMs),
          args.signal,
        );
      }
    }
    emitStep({
      onProgress: args.onProgress,
      key: "git-fetch-completed",
      text: `Fetched ${args.baseBranch}`,
      status: "completed",
      startedAt,
      metadata: { durationMs: Date.now() - startedAt },
    });
  } catch (error) {
    emitStep({
      onProgress: args.onProgress,
      key: "git-fetch-failed",
      text: `Failed to fetch ${args.baseBranch}`,
      status: "failed",
      startedAt,
      metadata: { durationMs: Date.now() - startedAt },
    });
    throw error;
  }
}

function summarizePaths(paths: readonly string[]): string {
  const shown = paths.slice(0, WORKTREE_INCLUDE_TRANSCRIPT_PATH_LIMIT);
  const hiddenCount = paths.length - shown.length;
  const suffix = hiddenCount > 0 ? `, and ${hiddenCount} more` : "";
  return `${shown.join(", ")}${suffix}`;
}

async function copyIncludedFiles(args: {
  sourcePath: string;
  targetPath: string;
  onProgress: ProgressCallback | undefined;
  shellPath: string | undefined;
  signal: AbortSignal | undefined;
}): Promise<void> {
  throwIfProvisionAborted(args.signal);
  const startedAt = Date.now();
  let result: CopyWorktreeIncludeFilesResult;
  try {
    result = await copyWorktreeIncludeFiles({
      sourcePath: args.sourcePath,
      targetPath: args.targetPath,
      shellPath: args.shellPath,
      signal: args.signal,
    });
  } catch (error) {
    if (isProvisionAbortError(error)) {
      throw error;
    }
    emitOutput(
      args.onProgress,
      "worktree-include",
      `Skipped ${WORKTREE_INCLUDE_FILE_NAME}: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
    return;
  }
  if (!result.ran) {
    return;
  }

  for (const skipped of result.skipped.slice(
    0,
    WORKTREE_INCLUDE_TRANSCRIPT_PATH_LIMIT,
  )) {
    emitOutput(args.onProgress, "worktree-include", `Skipped ${skipped}`);
  }
  const hiddenSkipCount =
    result.skipped.length - WORKTREE_INCLUDE_TRANSCRIPT_PATH_LIMIT;
  if (hiddenSkipCount > 0) {
    emitOutput(
      args.onProgress,
      "worktree-include",
      `Skipped ${hiddenSkipCount} more file(s)`,
    );
  }
  if (result.copied.length > 0) {
    emitOutput(
      args.onProgress,
      "worktree-include",
      `Copied ${result.copied.length} file(s): ${summarizePaths(result.copied)}`,
    );
  }
  emitStep({
    onProgress: args.onProgress,
    key: "worktree-include-completed",
    text: `Copied ${result.copied.length} file(s) from ${WORKTREE_INCLUDE_FILE_NAME}`,
    status: "completed",
    startedAt,
    metadata: { durationMs: Date.now() - startedAt },
  });
}

async function readCompletedBranch(
  completionPath: string,
): Promise<string | null> {
  try {
    return (await fs.readFile(completionPath, "utf8")).trim() || null;
  } catch {
    return null;
  }
}

async function finishWorktreeSetup(args: CreateWorktreeArgs): Promise<void> {
  emitCwd({
    onProgress: args.onProgress,
    keySuffix: "target",
    cwd: args.targetPath,
  });
  await copyIncludedFiles({
    sourcePath: args.sourcePath,
    targetPath: args.targetPath,
    onProgress: args.onProgress,
    shellPath: args.shellPath,
    signal: args.signal,
  });
  await runSetupScript({
    workspacePath: args.targetPath,
    timeoutMs: args.timeoutMs,
    ...(args.shellPath !== undefined ? { shellPath: args.shellPath } : {}),
    ...(args.onProgress !== undefined ? { onProgress: args.onProgress } : {}),
    ...(args.signal !== undefined ? { signal: args.signal } : {}),
  });
  await fs.writeFile(args.completionPath, `${args.branchName}\n`, "utf8");
}

async function removeCreateTarget(args: CreateWorktreeArgs): Promise<void> {
  await fs.rm(args.completionPath, { force: true });
  await removeWorktree({
    path: args.targetPath,
    timeoutMs: args.timeoutMs,
    force: true,
    ...(args.pruneEmptyParent !== undefined
      ? { pruneEmptyParent: args.pruneEmptyParent }
      : {}),
    ...(args.shellPath !== undefined ? { shellPath: args.shellPath } : {}),
    ...(args.signal !== undefined ? { signal: args.signal } : {}),
  });
}

export async function createWorktree(
  args: CreateWorktreeArgs,
): Promise<{ path: string }> {
  throwIfProvisionAborted(args.signal);
  const existingWorkspaceMatches = await ensureExistingWorkspaceMatches(
    args.targetPath,
    args.branchName,
    args.shellPath,
    args.signal,
  );
  if (existingWorkspaceMatches) {
    if ((await readCompletedBranch(args.completionPath)) === args.branchName) {
      return { path: args.targetPath };
    }
    try {
      await finishWorktreeSetup(args);
      return { path: args.targetPath };
    } catch (error) {
      await removeCreateTarget(args);
      throw error;
    }
  }

  await removeCreateTarget(args);

  throwIfProvisionAborted(args.signal);
  switch (
    await readGitRepositoryState(args.sourcePath, {
      ...(args.shellPath !== undefined ? { shellPath: args.shellPath } : {}),
      ...(args.signal !== undefined ? { signal: args.signal } : {}),
    })
  ) {
    case "not_git":
      throw new WorkspaceError(
        "not_git_repo",
        `Cannot create a worktree because the source is not a Git repository: ${args.sourcePath}. Initialize it and create at least one commit, then try again.`,
      );
    case "no_commits":
      throw new WorkspaceError(
        "unborn_head",
        `Cannot create a worktree because the repository has no commits: ${args.sourcePath}. Create an initial commit, then try again.`,
      );
    case "has_commits":
      break;
  }

  throwIfProvisionAborted(args.signal);
  await removeAbandonedAttemptWorktree({
    sourcePath: args.sourcePath,
    ownWorktreesRoot: args.ownWorktreesRoot,
    branchName: args.branchName,
    timeoutMs: args.timeoutMs,
    shellPath: args.shellPath,
    onProgress: args.onProgress,
    signal: args.signal,
  });

  throwIfProvisionAborted(args.signal);
  await ensureWorkspaceParentDirectory(args.targetPath);

  throwIfProvisionAborted(args.signal);
  const gitProcessOptions: GitProcessOptions =
    args.shellPath !== undefined ? { shellPath: args.shellPath } : {};
  const reuseExistingBranch =
    args.branchMode === "reuse-existing" &&
    (await hasRef(
      args.sourcePath,
      `refs/heads/${args.branchName}`,
      gitProcessOptions,
    ));

  let gitArgs: string[];
  if (reuseExistingBranch) {
    gitArgs = ["worktree", "add", args.targetPath, args.branchName];
  } else {
    const baseBranch =
      args.baseBranch ??
      (await readDefaultBranch(args.sourcePath, {
        ...(args.shellPath !== undefined ? { shellPath: args.shellPath } : {}),
      }));
    if (!baseBranch) {
      throw new WorkspaceError(
        "missing_default_branch",
        `Cannot resolve default branch for source: ${args.sourcePath}`,
      );
    }
    throwIfProvisionAborted(args.signal);
    await fetchRemoteBaseBranch({
      sourcePath: args.sourcePath,
      baseBranch,
      fetchTimeoutMs: REMOTE_BASE_FETCH_TIMEOUT_MS,
      onProgress: args.onProgress,
      shellPath: args.shellPath,
      signal: args.signal,
    });
    gitArgs = [
      "worktree",
      "add",
      "-B",
      args.branchName,
      args.targetPath,
      baseBranch,
    ];
  }

  const worktreeStartedAt = Date.now();
  emitStep({
    onProgress: args.onProgress,
    key: "git-worktree-started",
    text: "Creating worktree",
    status: "started",
    startedAt: worktreeStartedAt,
  });
  let worktreeCreated = false;
  try {
    const result = await runGitWithWorktreeMetadataLock(gitArgs, {
      cwd: args.sourcePath,
      ...(args.shellPath !== undefined ? { shellPath: args.shellPath } : {}),
      ...(args.signal !== undefined ? { signal: args.signal } : {}),
    });
    emitGitOutput(args.onProgress, "git-worktree", result);
    emitStep({
      onProgress: args.onProgress,
      key: "git-worktree-completed",
      text: "Created worktree",
      status: "completed",
      startedAt: worktreeStartedAt,
      metadata: { durationMs: Date.now() - worktreeStartedAt },
    });
    worktreeCreated = true;
    await finishWorktreeSetup(args);
    return { path: args.targetPath };
  } catch (error) {
    if (!worktreeCreated) {
      emitStep({
        onProgress: args.onProgress,
        key: "git-worktree-failed",
        text: "Worktree setup failed",
        status: "failed",
        startedAt: worktreeStartedAt,
        metadata: { durationMs: Date.now() - worktreeStartedAt },
      });
    }
    await removeCreateTarget(args);
    throw error;
  }
}

async function removeDirectoryIfEmpty(pathToRemove: string): Promise<void> {
  try {
    await fs.rmdir(pathToRemove);
  } catch (error) {
    if (
      error instanceof Error &&
      "code" in error &&
      typeof error.code === "string" &&
      ["ENOENT", "ENOTEMPTY", "EEXIST"].includes(error.code)
    ) {
      return;
    }

    throw error;
  }
}

export async function removeWorktree(args: RemoveWorktreeArgs): Promise<void> {
  throwIfProvisionAborted(args.signal);
  const force = args.force !== false;
  const workspacePath = path.resolve(args.path);
  const parentPath = path.dirname(workspacePath);
  try {
    await fs.access(workspacePath);
  } catch {
    if (args.pruneEmptyParent) {
      await removeDirectoryIfEmpty(parentPath);
    }
    return;
  }

  await experimental_killProcessesWithCwdUnder({ directory: workspacePath });
  throwIfProvisionAborted(args.signal);
  await runTeardownScript({
    workspacePath,
    timeoutMs: args.timeoutMs,
    ...(args.shellPath !== undefined ? { shellPath: args.shellPath } : {}),
    ...(args.onProgress !== undefined ? { onProgress: args.onProgress } : {}),
    ...(args.signal !== undefined ? { signal: args.signal } : {}),
  });

  const commonDirResult = await runGit(["rev-parse", "--git-common-dir"], {
    cwd: workspacePath,
    ...(args.shellPath !== undefined ? { shellPath: args.shellPath } : {}),
    ...(args.signal !== undefined ? { signal: args.signal } : {}),
    allowFailure: true,
  });

  if (commonDirResult.exitCode === 0) {
    const commonDir = path.resolve(
      workspacePath,
      commonDirResult.stdout.trim(),
    );
    await tryWithCheckoutMutationLock(
      workspacePath,
      () =>
        withWorktreeMetadataLock(commonDir, () =>
          runGit(
            [
              "--git-dir",
              commonDir,
              "worktree",
              "remove",
              workspacePath,
              ...(force ? ["--force"] : []),
            ],
            {
              cwd: path.dirname(workspacePath),
              ...(args.shellPath !== undefined
                ? { shellPath: args.shellPath }
                : {}),
              ...(args.signal !== undefined ? { signal: args.signal } : {}),
              allowFailure: true,
            },
          ),
        ),
      args.signal,
      {
        ...(args.shellPath !== undefined ? { shellPath: args.shellPath } : {}),
        ...(args.signal !== undefined ? { signal: args.signal } : {}),
      },
    );
  }

  throwIfProvisionAborted(args.signal);
  await fs.rm(workspacePath, { recursive: true, force: true });
  if (args.pruneEmptyParent) {
    await removeDirectoryIfEmpty(parentPath);
  }
}
