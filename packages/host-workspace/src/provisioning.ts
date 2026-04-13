import fs from "node:fs/promises";
import path from "node:path";
import {
  DEFAULT_ENV_SETUP_SCRIPT_NAME,
  type ProvisioningTranscriptEntry,
} from "@bb/domain";
import { spawnPortableOutputProcess } from "@bb/process-utils";
import { Workspace } from "./workspace.js";
import { pathExists, runGit, WorkspaceError, type GitCommandResult } from "./git.js";

type ProgressCallback = (entry: ProvisioningTranscriptEntry) => void;
type EmitStepArgs = {
  onProgress: ProgressCallback | undefined;
  key: string;
  text: string;
  status: "started" | "completed" | "failed";
  startedAt?: number;
  metadata?: ProvisioningTranscriptEntry["metadata"];
};

export interface CreateWorkspaceArgs {
  /** Local repo path for worktrees, or a clone URL for managed clones */
  sourcePath: string;
  targetPath: string;
  branchName: string;
  /** Setup script timeout in ms. Controlled by the server. */
  timeoutMs: number;
  onProgress?: ProgressCallback;
}

export interface RunSetupScriptArgs {
  workspacePath: string;
  timeoutMs: number;
  onProgress?: ProgressCallback;
}

export interface RemoveWorktreeArgs {
  path: string;
  force?: boolean;
}

const GITHUB_HOSTNAME = "github.com";
const GITHUB_TOKEN_ENV_KEY = "GITHUB_TOKEN";
// Git credential helpers are shell snippets. This one keeps the token in-memory and
// only answers `get` requests for HTTPS clones against GitHub.
const GITHUB_TOKEN_CREDENTIAL_HELPER =
  '!f() { if test "$1" = get; then echo username=x-access-token; echo password=$GITHUB_TOKEN; fi; }; f';

interface SetupScriptCommand {
  command: string;
  args: string[];
  text: string;
}

interface BuildSetupScriptCommandArgs {
  platform: NodeJS.Platform;
  scriptPath: string;
}

function buildGitHubCloneEnv(sourcePath: string): NodeJS.ProcessEnv | undefined {
  const githubToken = process.env[GITHUB_TOKEN_ENV_KEY]?.trim();
  if (!githubToken) {
    return undefined;
  }

  let sourceUrl: URL;
  try {
    sourceUrl = new URL(sourcePath);
  } catch {
    return undefined;
  }

  if (sourceUrl.protocol !== "https:" || sourceUrl.hostname !== GITHUB_HOSTNAME) {
    return undefined;
  }

  return {
    GIT_CONFIG_COUNT: "1",
    GIT_CONFIG_KEY_0: "credential.helper",
    GIT_CONFIG_VALUE_0: GITHUB_TOKEN_CREDENTIAL_HELPER,
    GIT_TERMINAL_PROMPT: "0",
  };
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
  emitStep({ onProgress: args.onProgress, key: `workspace-${args.keySuffix}`, text: `Using workspace: ${args.cwd}`, status: "completed" });
}

function emitGitOutput(
  onProgress: ProgressCallback | undefined,
  key: string,
  result: GitCommandResult,
): void {
  const combined = (result.stdout + result.stderr).trim();
  if (!combined) {
    return;
  }
  let index = 0;
  for (const line of combined.split(/\r?\n/u).filter(Boolean)) {
    index += 1;
    emitOutput(onProgress, `${key}-output-${index}`, line);
  }
}

async function ensureExistingWorkspaceMatches(
  targetPath: string,
  branchName: string,
): Promise<boolean> {
  if (!(await pathExists(targetPath))) {
    return false;
  }

  const workspace = new Workspace(targetPath);
  if (!(await workspace.isGitRepo)) {
    throw new WorkspaceError("path_exists", `Target path exists but is not a git repo: ${targetPath}`);
  }

  if ((await workspace.currentBranch) !== branchName) {
    throw new WorkspaceError(
      "path_exists",
      `Target path exists on the wrong branch: ${targetPath}`,
    );
  }

  return true;
}

async function ensureWorkspaceParentDirectory(targetPath: string): Promise<void> {
  await fs.mkdir(path.dirname(targetPath), { recursive: true });
}

async function resolveSetupScriptPath(workspacePath: string): Promise<string | null> {
  const scriptPath = path.join(workspacePath, DEFAULT_ENV_SETUP_SCRIPT_NAME);
  return (await pathExists(scriptPath)) ? scriptPath : null;
}

export function buildSetupScriptCommand(
  args: BuildSetupScriptCommandArgs,
): SetupScriptCommand {
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

export async function createWorktree(args: CreateWorkspaceArgs): Promise<{ path: string }> {
  if (await ensureExistingWorkspaceMatches(args.targetPath, args.branchName)) {
    return { path: args.targetPath };
  }

  await ensureWorkspaceParentDirectory(args.targetPath);

  const gitArgs = ["worktree", "add", "-B", args.branchName, args.targetPath];
  const commandText = `git ${gitArgs.join(" ")}`;

  const worktreeStartedAt = Date.now();
  emitStep({ onProgress: args.onProgress, key: "git-worktree-started", text: "Creating worktree", status: "started", startedAt: worktreeStartedAt });
  emitOutput(args.onProgress, "git-worktree-command", commandText);
  let worktreeCreated = false;
  try {
    const result = await runGit(gitArgs, { cwd: args.sourcePath });
    emitGitOutput(args.onProgress, "git-worktree", result);
    emitStep({ onProgress: args.onProgress, key: "git-worktree-completed", text: "Created worktree", status: "completed", startedAt: worktreeStartedAt, metadata: { durationMs: Date.now() - worktreeStartedAt } });
    worktreeCreated = true;
    emitCwd({ onProgress: args.onProgress, keySuffix: "target", cwd: args.targetPath });
    await runSetupScript({
      workspacePath: args.targetPath,
      timeoutMs: args.timeoutMs,
      onProgress: args.onProgress,
    });
    return { path: args.targetPath };
  } catch (error) {
    if (!worktreeCreated) {
      emitStep({ onProgress: args.onProgress, key: "git-worktree-failed", text: "Worktree setup failed", status: "failed", startedAt: worktreeStartedAt, metadata: { durationMs: Date.now() - worktreeStartedAt } });
    }
    await removeWorktree({ path: args.targetPath, force: true });
    throw error;
  }
}

export async function createClone(args: CreateWorkspaceArgs): Promise<{ path: string }> {
  if (await ensureExistingWorkspaceMatches(args.targetPath, args.branchName)) {
    return { path: args.targetPath };
  }

  await ensureWorkspaceParentDirectory(args.targetPath);

  const cloneArgs = ["clone", args.sourcePath, args.targetPath];
  const cloneText = `git ${cloneArgs.join(" ")}`;
  const checkoutArgs = ["checkout", "-B", args.branchName];
  const checkoutText = `git ${checkoutArgs.join(" ")}`;
  const cloneEnv = buildGitHubCloneEnv(args.sourcePath);

  const cloneStartedAt = Date.now();
  emitStep({ onProgress: args.onProgress, key: "git-clone-started", text: "Cloning repository", status: "started", startedAt: cloneStartedAt });
  emitOutput(args.onProgress, "git-clone-command", cloneText);
  let cloneCompleted = false;
  let checkoutCompleted = false;
  let checkoutStartedAt: number | null = null;
  try {
    const cloneResult = await runGit(cloneArgs, {
      cwd: path.dirname(args.targetPath),
      ...(cloneEnv ? { env: cloneEnv } : {}),
    });
    emitGitOutput(args.onProgress, "git-clone", cloneResult);
    emitStep({ onProgress: args.onProgress, key: "git-clone-completed", text: "Cloned repository", status: "completed", startedAt: cloneStartedAt, metadata: { durationMs: Date.now() - cloneStartedAt } });
    cloneCompleted = true;

    emitCwd({ onProgress: args.onProgress, keySuffix: "target", cwd: args.targetPath });
    checkoutStartedAt = Date.now();
    emitStep({ onProgress: args.onProgress, key: "git-checkout-started", text: "Checking out branch", status: "started", startedAt: checkoutStartedAt });
    emitOutput(args.onProgress, "git-checkout-command", checkoutText);
    const checkoutResult = await runGit(checkoutArgs, { cwd: args.targetPath });
    emitGitOutput(args.onProgress, "git-checkout", checkoutResult);
    emitStep({ onProgress: args.onProgress, key: "git-checkout-completed", text: "Checked out branch", status: "completed", startedAt: checkoutStartedAt, metadata: { durationMs: Date.now() - checkoutStartedAt } });
    checkoutCompleted = true;

    await runSetupScript({
      workspacePath: args.targetPath,
      timeoutMs: args.timeoutMs,
      onProgress: args.onProgress,
    });
    return { path: args.targetPath };
  } catch (error) {
    if (!cloneCompleted) {
      emitStep({ onProgress: args.onProgress, key: "git-clone-failed", text: "Clone failed", status: "failed", startedAt: cloneStartedAt, metadata: { durationMs: Date.now() - cloneStartedAt } });
    } else if (!checkoutCompleted) {
      const failedAt = checkoutStartedAt ?? Date.now();
      emitStep({ onProgress: args.onProgress, key: "git-checkout-failed", text: "Checkout failed", status: "failed", startedAt: failedAt, metadata: { durationMs: Date.now() - failedAt } });
    }
    await removeDirectory({ path: args.targetPath });
    throw error;
  }
}

export async function runSetupScript(
  args: RunSetupScriptArgs,
): Promise<{ ran: boolean; exitCode?: number; output?: string }> {
  const scriptPath = await resolveSetupScriptPath(args.workspacePath);
  if (!scriptPath) {
    return { ran: false };
  }

  const command = buildSetupScriptCommand({
    platform: process.platform,
    scriptPath,
  });
  const commandText = command.text;
  const startedAt = Date.now();
  emitStep({ onProgress: args.onProgress, key: "setup-started", text: "Running .bb-env-setup.sh", status: "started", startedAt });
  emitOutput(args.onProgress, "setup-command", commandText);

  const { timeoutMs } = args;
  const child = spawnPortableOutputProcess({
    command: command.command,
    args: command.args,
    cwd: args.workspacePath,
  });

  const outputChunks: string[] = [];
  let outputIndex = 0;
  let timedOut = false;

  const handleChunk = (chunk: Buffer) => {
    const text = chunk.toString("utf8");
    outputChunks.push(text);
    for (const line of text.split(/\r?\n/u).filter(Boolean)) {
      outputIndex += 1;
      emitOutput(args.onProgress, `setup-output-${outputIndex}`, line);
    }
  };

  child.stdout.on("data", handleChunk);
  child.stderr.on("data", handleChunk);

  const timeout = setTimeout(() => {
    timedOut = true;
    child.kill("SIGKILL");
  }, timeoutMs);

  try {
    const result = await new Promise<{
      exitCode: number | null;
      signal: NodeJS.Signals | null;
    }>((resolve, reject) => {
      child.on("error", reject);
      child.on("close", (exitCode, signal) => resolve({ exitCode, signal }));
    });

    const output = outputChunks.join("");
    const durationMs = Date.now() - startedAt;
    if (timedOut) {
      emitStep({ onProgress: args.onProgress, key: "setup-failed", text: ".bb-env-setup.sh failed", status: "failed", startedAt, metadata: { durationMs } });
      throw new WorkspaceError(
        "setup_script_failed",
        `Setup script timed out after ${timeoutMs}ms: ${scriptPath}`,
      );
    }

    if (result.signal) {
      emitStep({ onProgress: args.onProgress, key: "setup-failed", text: ".bb-env-setup.sh failed", status: "failed", startedAt, metadata: { durationMs } });
      throw new WorkspaceError(
        "setup_script_failed",
        `Setup script exited via signal ${result.signal}: ${scriptPath}`,
      );
    }

    if ((result.exitCode ?? 0) !== 0) {
      emitStep({ onProgress: args.onProgress, key: "setup-failed", text: ".bb-env-setup.sh failed", status: "failed", startedAt, metadata: { durationMs } });
      throw new WorkspaceError(
        "setup_script_failed",
        `Setup script failed with exit code ${result.exitCode}: ${scriptPath}`,
      );
    }

    emitStep({ onProgress: args.onProgress, key: "setup-completed", text: ".bb-env-setup.sh finished", status: "completed", startedAt, metadata: { durationMs } });
    return { ran: true, exitCode: result.exitCode ?? 0, output };
  } finally {
    clearTimeout(timeout);
  }
}

export async function removeWorktree(args: RemoveWorktreeArgs): Promise<void> {
  if (!(await pathExists(args.path))) {
    return;
  }

  const force = args.force !== false;
  const workspacePath = path.resolve(args.path);
  const commonDirResult = await runGit(
    ["rev-parse", "--git-common-dir"],
    { cwd: workspacePath, allowFailure: true },
  );

  if (commonDirResult.exitCode === 0) {
    const commonDir = path.resolve(workspacePath, commonDirResult.stdout.trim());
    await runGit(
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
        allowFailure: true,
      },
    );
  }

  await fs.rm(workspacePath, { recursive: true, force: true });
}

export async function removeDirectory(args: { path: string }): Promise<void> {
  await fs.rm(args.path, { recursive: true, force: true });
}
