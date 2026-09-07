import fs from "node:fs/promises";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import {
  DEFAULT_ENV_SETUP_SCRIPT_NAME,
  DEFAULT_ENV_TEARDOWN_SCRIPT_NAME,
  WORKTREE_INCLUDE_FILE_NAME,
  createTerminalOutputLineReader,
  readTerminalOutputLines,
  type ProvisioningTranscriptEntry,
} from "@bb/domain";
import {
  killProcessGroup,
  sanitizeInheritedChildProcessEnv,
  spawnPortableOutputProcess,
  supportsProcessGroups,
} from "@bb/process-utils";
import { Workspace } from "./workspace.js";
import { tryWithCheckoutMutationLock } from "./checkout-mutation-lock.js";
import {
  getGitCommonDir,
  pathExists,
  readDefaultBranch,
  readGitRepositoryState,
  runGit,
  WorkspaceError,
  type GitCommandResult,
} from "./git.js";
import { withGitRefMutationLock } from "./git-ref-mutation-lock.js";
import { ProcessLocalQueuedLockTimeoutError } from "./process-local-queued-lock.js";
import {
  runGitWithWorktreeMetadataLock,
  withWorktreeMetadataLock,
} from "./worktree-metadata-lock.js";
import {
  copyWorktreeIncludeFiles,
  type CopyWorktreeIncludeFilesResult,
} from "./worktree-include.js";

type ProgressCallback = (entry: ProvisioningTranscriptEntry) => void;
type EmitStepArgs = {
  onProgress: ProgressCallback | undefined;
  key: string;
  text: string;
  status: "started" | "completed" | "failed";
  startedAt?: number;
  metadata?: ProvisioningTranscriptEntry["metadata"];
};

interface CreateWorkspaceArgs {
  sourcePath: string;
  targetPath: string;
  branchName: string;
  baseBranch: string | null;
  timeoutMs: number;
  shellPath?: string;
  onProgress?: ProgressCallback;
  pruneEmptyParent?: boolean;
  signal?: AbortSignal;
}

interface RunSetupScriptArgs {
  workspacePath: string;
  timeoutMs: number;
  shellPath?: string;
  onProgress?: ProgressCallback;
  signal?: AbortSignal;
}

interface RunTeardownScriptArgs {
  workspacePath: string;
  timeoutMs: number;
  /** Resolved user-shell PATH. Falls back to the daemon process PATH. */
  shellPath?: string;
  onProgress?: ProgressCallback;
}

interface RemoveWorktreeArgs {
  path: string;
  /** Teardown script timeout in ms. Controlled by the server. */
  timeoutMs: number;
  force?: boolean;
  pruneEmptyParent?: boolean;
  shellPath?: string;
  onProgress?: ProgressCallback;
}

interface LifecycleScriptCommand {
  command: string;
  args: string[];
  text: string;
}

interface BuildLifecycleScriptCommandArgs {
  platform: NodeJS.Platform;
  scriptPath: string;
}

interface RunLifecycleScriptArgs extends RunSetupScriptArgs {
  kind: "setup" | "teardown";
  scriptName: string;
}

const SETUP_SCRIPT_ABORT_KILL_GRACE_MS = 2_000;
const REMOTE_BASE_FETCH_TIMEOUT_MS = 60_000;
const REMOTE_REF_LOCK_RETRY_INTERVAL_MS = 200;
const REMOTE_REF_LOCK_RETRY_TIMEOUT_MS = 2_000;

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

function emitProgress(
  onProgress: ProgressCallback | undefined,
  entry: ProvisioningTranscriptEntry,
): void {
  onProgress?.(entry);
}

function emitStep(args: EmitStepArgs): void {
  emitProgress(args.onProgress, {
    type: "step",
    key: args.key,
    text: args.text,
    status: args.status,
    startedAt: args.startedAt ?? Date.now(),
    metadata: args.metadata,
  });
}

function emitOutput(
  onProgress: ProgressCallback | undefined,
  key: string,
  text: string,
): void {
  emitProgress(onProgress, {
    type: "output",
    key,
    text,
    startedAt: Date.now(),
  });
}

function emitCwd(args: {
  onProgress: ProgressCallback | undefined;
  keySuffix: string;
  cwd: string;
}): void {
  emitStep({
    onProgress: args.onProgress,
    key: `workspace-${args.keySuffix}`,
    text: `Using workspace: ${args.cwd}`,
    status: "completed",
  });
}

function emitGitOutput(
  onProgress: ProgressCallback | undefined,
  key: string,
  result: GitCommandResult,
): void {
  const lines = readTerminalOutputLines(result.stdout + result.stderr);
  if (lines.length === 0) {
    return;
  }
  let index = 0;
  for (const line of lines) {
    index += 1;
    emitOutput(onProgress, `${key}-output-${index}`, line);
  }
}

async function ensureExistingWorkspaceMatches(
  targetPath: string,
  branchName: string,
  shellPath: string | undefined,
): Promise<boolean> {
  if (!(await pathExists(targetPath))) {
    return false;
  }

  const workspace = new Workspace(targetPath, {
    ...(shellPath !== undefined ? { shellPath } : {}),
  });
  if (!(await workspace.isGitRepo)) {
    throw new WorkspaceError(
      "path_exists",
      `Target path exists but is not a git repo: ${targetPath}`,
    );
  }

  if ((await workspace.currentBranch) !== branchName) {
    throw new WorkspaceError(
      "path_exists",
      `Target path exists on the wrong branch: ${targetPath}`,
    );
  }

  return true;
}

async function ensureWorkspaceParentDirectory(
  targetPath: string,
): Promise<void> {
  await fs.mkdir(path.dirname(targetPath), { recursive: true });
}

async function resolveLifecycleScriptPath(
  workspacePath: string,
  scriptName: string,
): Promise<string | null> {
  const scriptPath = path.join(workspacePath, scriptName);
  return (await pathExists(scriptPath)) ? scriptPath : null;
}

export function buildSetupScriptCommand(
  args: BuildLifecycleScriptCommandArgs,
): LifecycleScriptCommand {
  if (args.platform === "win32") {
    throw new WorkspaceError(
      "setup_script_failed",
      `POSIX shell setup scripts are not supported on Windows: ${DEFAULT_ENV_SETUP_SCRIPT_NAME}`,
    );
  }

  return {
    command: "env",
    args: ["bash", args.scriptPath],
    text: `env bash ${DEFAULT_ENV_SETUP_SCRIPT_NAME}`,
  };
}

function buildTeardownScriptCommand(args: BuildLifecycleScriptCommandArgs) {
  if (args.platform === "win32") {
    throw new WorkspaceError(
      "setup_script_failed",
      `POSIX shell teardown scripts are not supported on Windows: ${DEFAULT_ENV_TEARDOWN_SCRIPT_NAME}`,
    );
  }

  return {
    command: "env",
    args: ["bash", args.scriptPath],
    text: `env bash ${DEFAULT_ENV_TEARDOWN_SCRIPT_NAME}`,
  };
}

function createProvisionCancelledError(cause?: unknown): WorkspaceError {
  return new WorkspaceError(
    "provision_cancelled",
    "Workspace provisioning was cancelled",
    { cause },
  );
}

export function throwIfProvisionAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) {
    throw createProvisionCancelledError(signal.reason);
  }
}

function isProvisionAbortError(error: unknown): boolean {
  return (
    error instanceof WorkspaceError && error.code === "provision_cancelled"
  );
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
      signal,
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
      metadata: {
        durationMs: Date.now() - startedAt,
      },
    });
  } catch (error) {
    emitStep({
      onProgress: args.onProgress,
      key: "git-fetch-failed",
      text: `Failed to fetch ${args.baseBranch}`,
      status: "failed",
      startedAt,
      metadata: {
        durationMs: Date.now() - startedAt,
      },
    });
    throw error;
  }
}

export async function createWorktree(
  args: CreateWorkspaceArgs,
): Promise<{ path: string }> {
  throwIfProvisionAborted(args.signal);
  if (
    await ensureExistingWorkspaceMatches(
      args.targetPath,
      args.branchName,
      args.shellPath,
    )
  ) {
    return { path: args.targetPath };
  }

  throwIfProvisionAborted(args.signal);
  switch (
    await readGitRepositoryState(args.sourcePath, {
      ...(args.shellPath !== undefined ? { shellPath: args.shellPath } : {}),
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
  await ensureWorkspaceParentDirectory(args.targetPath);

  throwIfProvisionAborted(args.signal);
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

  const gitArgs = [
    "worktree",
    "add",
    "-B",
    args.branchName,
    args.targetPath,
    baseBranch,
  ];
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
      signal: args.signal,
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
      shellPath: args.shellPath,
      onProgress: args.onProgress,
      signal: args.signal,
    });
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
    await removeWorktree({
      path: args.targetPath,
      timeoutMs: args.timeoutMs,
      force: true,
      pruneEmptyParent: args.pruneEmptyParent,
      shellPath: args.shellPath,
    });
    throw error;
  }
}

const WORKTREE_INCLUDE_TRANSCRIPT_PATH_LIMIT = 20;

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
      `Copied ${result.copied.length} file(s): ${summarizePaths(
        result.copied,
      )}`,
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

async function runLifecycleScript(
  args: RunLifecycleScriptArgs,
): Promise<{ ran: boolean; exitCode?: number; output?: string }> {
  if (args.kind === "setup") {
    throwIfProvisionAborted(args.signal);
  }
  const scriptPath = await resolveLifecycleScriptPath(
    args.workspacePath,
    args.scriptName,
  );
  if (!scriptPath) {
    return { ran: false };
  }

  if (args.kind === "setup") {
    throwIfProvisionAborted(args.signal);
  }
  const command =
    args.kind === "setup"
      ? buildSetupScriptCommand({ platform: process.platform, scriptPath })
      : buildTeardownScriptCommand({ platform: process.platform, scriptPath });
  const startedAt = Date.now();
  emitStep({
    onProgress: args.onProgress,
    key: `${args.kind}-started`,
    text: `Running ${args.scriptName}`,
    status: "started",
    startedAt,
  });

  const { timeoutMs } = args;
  const env = sanitizeInheritedChildProcessEnv({
    env: process.env,
    ...(args.shellPath !== undefined ? { shellPath: args.shellPath } : {}),
  });
  const child = spawnPortableOutputProcess({
    command: command.command,
    args: command.args,
    cwd: args.workspacePath,
    detached: supportsProcessGroups(),
    env,
  });

  const outputChunks: string[] = [];
  const outputLineReader = createTerminalOutputLineReader();
  let outputIndex = 0;
  let abortKillTimeout: ReturnType<typeof setTimeout> | undefined;
  let abortRequested = false;
  let timedOut = false;

  const emitScriptOutputLines = (lines: string[]): void => {
    for (const line of lines) {
      outputIndex += 1;
      emitOutput(args.onProgress, `${args.kind}-output-${outputIndex}`, line);
    }
  };

  const handleChunk = (chunk: Buffer) => {
    const text = chunk.toString("utf8");
    outputChunks.push(text);
    emitScriptOutputLines(outputLineReader.push(text));
  };

  child.stdout.on("data", handleChunk);
  child.stderr.on("data", handleChunk);

  const timeout = setTimeout(() => {
    timedOut = true;
    killProcessGroup({
      child,
      signal: "SIGKILL",
    });
  }, timeoutMs);
  const abortLifecycleScript = () => {
    if (abortRequested) {
      return;
    }
    abortRequested = true;
    killProcessGroup({
      child,
      signal: "SIGTERM",
    });
    abortKillTimeout = setTimeout(() => {
      killProcessGroup({
        child,
        signal: "SIGKILL",
      });
    }, SETUP_SCRIPT_ABORT_KILL_GRACE_MS);
  };
  if (args.kind === "setup") {
    args.signal?.addEventListener("abort", abortLifecycleScript, {
      once: true,
    });
    if (args.signal?.aborted) {
      abortLifecycleScript();
    }
  }

  try {
    const result = await new Promise<{
      exitCode: number | null;
      signal: NodeJS.Signals | null;
    }>((resolve, reject) => {
      child.on("error", reject);
      child.on("close", (exitCode, signal) => resolve({ exitCode, signal }));
    });

    const output = outputChunks.join("");
    emitScriptOutputLines(outputLineReader.flush());
    const durationMs = Date.now() - startedAt;
    if (args.kind === "setup" && (abortRequested || args.signal?.aborted)) {
      emitStep({
        onProgress: args.onProgress,
        key: `${args.kind}-cancelled`,
        text: `${args.scriptName} cancelled`,
        status: "failed",
        startedAt,
        metadata: { durationMs },
      });
      throw createProvisionCancelledError(args.signal?.reason);
    }

    if (timedOut) {
      emitStep({
        onProgress: args.onProgress,
        key: `${args.kind}-failed`,
        text: `${args.scriptName} failed`,
        status: "failed",
        startedAt,
        metadata: { durationMs },
      });
      throw new WorkspaceError(
        "setup_script_failed",
        `${args.kind === "setup" ? "Setup" : "Teardown"} script timed out after ${timeoutMs}ms: ${scriptPath}`,
      );
    }

    if (result.signal) {
      emitStep({
        onProgress: args.onProgress,
        key: `${args.kind}-failed`,
        text: `${args.scriptName} failed`,
        status: "failed",
        startedAt,
        metadata: { durationMs },
      });
      throw new WorkspaceError(
        "setup_script_failed",
        `${args.kind === "setup" ? "Setup" : "Teardown"} script exited via signal ${result.signal}: ${scriptPath}`,
      );
    }

    if ((result.exitCode ?? 0) !== 0) {
      emitStep({
        onProgress: args.onProgress,
        key: `${args.kind}-failed`,
        text: `${args.scriptName} failed`,
        status: "failed",
        startedAt,
        metadata: { durationMs },
      });
      throw new WorkspaceError(
        "setup_script_failed",
        `${args.kind === "setup" ? "Setup" : "Teardown"} script failed with exit code ${result.exitCode}: ${scriptPath}`,
      );
    }

    emitStep({
      onProgress: args.onProgress,
      key: `${args.kind}-completed`,
      text: `${args.scriptName} finished`,
      status: "completed",
      startedAt,
      metadata: { durationMs },
    });
    return { ran: true, exitCode: result.exitCode ?? 0, output };
  } finally {
    clearTimeout(timeout);
    if (abortKillTimeout) {
      clearTimeout(abortKillTimeout);
    }
    if (args.kind === "setup") {
      args.signal?.removeEventListener("abort", abortLifecycleScript);
    }
  }
}

export function runSetupScript(
  args: RunSetupScriptArgs,
): Promise<{ ran: boolean; exitCode?: number; output?: string }> {
  return runLifecycleScript({
    ...args,
    kind: "setup",
    scriptName: DEFAULT_ENV_SETUP_SCRIPT_NAME,
  });
}

export async function runTeardownScript(
  args: RunTeardownScriptArgs,
): Promise<{ ran: boolean; exitCode?: number; output?: string }> {
  const startedAt = Date.now();
  let failureReported = false;
  const onProgress: ProgressCallback = (entry) => {
    if (entry.type === "step" && entry.key === "teardown-failed") {
      failureReported = true;
    }
    args.onProgress?.(entry);
  };
  try {
    return await runLifecycleScript({
      ...args,
      onProgress,
      kind: "teardown",
      scriptName: DEFAULT_ENV_TEARDOWN_SCRIPT_NAME,
    });
  } catch (error) {
    if (!failureReported) {
      emitStep({
        onProgress: args.onProgress,
        key: "teardown-failed",
        text: `${DEFAULT_ENV_TEARDOWN_SCRIPT_NAME} failed`,
        status: "failed",
        startedAt,
        metadata: { durationMs: Date.now() - startedAt },
      });
    }
    emitOutput(
      args.onProgress,
      "teardown-error",
      error instanceof Error ? error.message : String(error),
    );
    return { ran: true };
  }
}

export async function removeWorktree(args: RemoveWorktreeArgs): Promise<void> {
  const force = args.force !== false;
  const workspacePath = path.resolve(args.path);
  const parentPath = path.dirname(workspacePath);
  if (!(await pathExists(workspacePath))) {
    if (args.pruneEmptyParent) {
      await removeDirectoryIfEmpty(parentPath);
    }
    return;
  }

  await runTeardownScript({
    workspacePath,
    timeoutMs: args.timeoutMs,
    ...(args.shellPath !== undefined ? { shellPath: args.shellPath } : {}),
    ...(args.onProgress !== undefined ? { onProgress: args.onProgress } : {}),
  });

  const commonDirResult = await runGit(["rev-parse", "--git-common-dir"], {
    cwd: workspacePath,
    ...(args.shellPath !== undefined ? { shellPath: args.shellPath } : {}),
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
              allowFailure: true,
            },
          ),
        ),
      undefined,
      args.shellPath === undefined ? {} : { shellPath: args.shellPath },
    );
  }

  await fs.rm(workspacePath, { recursive: true, force: true });
  if (args.pruneEmptyParent) {
    await removeDirectoryIfEmpty(parentPath);
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
