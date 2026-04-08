import fs from "node:fs/promises";
import path from "node:path";
import {
  DEFAULT_ENV_SETUP_SCRIPT_NAME,
  LEGACY_POSIX_ENV_SETUP_SCRIPT_NAME,
  type ProvisioningTranscriptEntry,
} from "@bb/domain";
import { spawnPortableProcess } from "@bb/process-utils";
import { Workspace } from "./workspace.js";
import { pathExists, runGit, WorkspaceError, type GitCommandResult } from "./git.js";

type ProgressCallback = (entry: ProvisioningTranscriptEntry) => void;

export interface CreateWorkspaceArgs {
  /** Local repo path for worktrees, or a clone URL for managed clones */
  sourcePath: string;
  targetPath: string;
  branchName: string;
  /** Setup script filename. Controlled by the server. */
  scriptName: string;
  /** Setup script timeout in ms. Controlled by the server. */
  timeoutMs: number;
  onProgress?: ProgressCallback;
}

export interface RunSetupScriptArgs {
  workspacePath: string;
  scriptName: string;
  timeoutMs: number;
  onProgress?: ProgressCallback;
}

export interface RemoveWorktreeArgs {
  path: string;
  force?: boolean;
}

const GITHUB_HOSTNAME = "github.com";
const GITHUB_TOKEN_ENV_KEY = "GITHUB_TOKEN";
const SETUP_SCRIPT_NODE_TRANSFORM_FLAG = "--experimental-transform-types";
const SETUP_SCRIPT_NODE_EXTENSIONS = new Set([
  ".cjs",
  ".cts",
  ".js",
  ".mjs",
  ".mts",
  ".ts",
]);

interface ResolvedSetupScript {
  scriptName: string;
  scriptPath: string;
}

interface SetupScriptCommand {
  command: string;
  args: string[];
  text: string;
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
    GIT_CONFIG_VALUE_0:
      '!f() { if test "$1" = get; then echo username=x-access-token; echo password=$GITHUB_TOKEN; fi; }; f',
    GIT_TERMINAL_PROMPT: "0",
  };
}

function emitProgress(
  onProgress: ProgressCallback | undefined,
  entry: ProvisioningTranscriptEntry,
): void {
  onProgress?.(entry);
}

function emitStep(args: {
  onProgress: ProgressCallback | undefined;
  key: string;
  text: string;
  status: "started" | "completed" | "failed";
  metadata?: Record<string, unknown>;
}): void {
  emitProgress(args.onProgress, {
    type: "step",
    key: args.key,
    text: args.text,
    status: args.status,
    startedAt: Date.now(),
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
  emitStep({ onProgress: args.onProgress, key: `cwd-${args.keySuffix}`, text: `cwd: ${args.cwd}`, status: "completed" });
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

async function resolveSetupScript(
  args: RunSetupScriptArgs,
): Promise<ResolvedSetupScript | null> {
  const requestedScriptPath = path.join(args.workspacePath, args.scriptName);
  if (await pathExists(requestedScriptPath)) {
    return {
      scriptName: args.scriptName,
      scriptPath: requestedScriptPath,
    };
  }

  if (
    args.scriptName === DEFAULT_ENV_SETUP_SCRIPT_NAME
    && process.platform !== "win32"
  ) {
    const legacyScriptPath = path.join(
      args.workspacePath,
      LEGACY_POSIX_ENV_SETUP_SCRIPT_NAME,
    );
    if (await pathExists(legacyScriptPath)) {
      return {
        scriptName: LEGACY_POSIX_ENV_SETUP_SCRIPT_NAME,
        scriptPath: legacyScriptPath,
      };
    }
  }

  return null;
}

function buildSetupScriptCommand(
  script: ResolvedSetupScript,
): SetupScriptCommand {
  const extension = path.extname(script.scriptName).toLowerCase();

  if (SETUP_SCRIPT_NODE_EXTENSIONS.has(extension)) {
    return {
      command: process.execPath,
      args: [SETUP_SCRIPT_NODE_TRANSFORM_FLAG, script.scriptPath],
      text: `node ${SETUP_SCRIPT_NODE_TRANSFORM_FLAG} ${script.scriptName}`,
    };
  }

  if (extension === ".sh") {
    return {
      command: "/bin/bash",
      args: [script.scriptPath],
      text: `/bin/bash ${script.scriptName}`,
    };
  }

  throw new WorkspaceError(
    "setup_script_failed",
    `Unsupported setup script type: ${script.scriptName}`,
  );
}

export async function createWorktree(args: CreateWorkspaceArgs): Promise<{ path: string }> {
  if (await ensureExistingWorkspaceMatches(args.targetPath, args.branchName)) {
    return { path: args.targetPath };
  }

  await ensureWorkspaceParentDirectory(args.targetPath);

  const gitArgs = ["worktree", "add", "-B", args.branchName, args.targetPath];
  const commandText = `git ${gitArgs.join(" ")}`;

  emitCwd({ onProgress: args.onProgress, keySuffix: "source", cwd: args.sourcePath });
  emitStep({ onProgress: args.onProgress, key: "git-worktree", text: commandText, status: "started" });
  const worktreeStartedAt = Date.now();
  let worktreeCreated = false;
  try {
    const result = await runGit(gitArgs, { cwd: args.sourcePath });
    emitGitOutput(args.onProgress, "git-worktree", result);
    emitStep({ onProgress: args.onProgress, key: "git-worktree", text: commandText, status: "completed", metadata: { durationMs: Date.now() - worktreeStartedAt } });
    worktreeCreated = true;
    emitCwd({ onProgress: args.onProgress, keySuffix: "target", cwd: args.targetPath });
    await runSetupScript({
      workspacePath: args.targetPath,
      scriptName: args.scriptName,
      timeoutMs: args.timeoutMs,
      onProgress: args.onProgress,
    });
    return { path: args.targetPath };
  } catch (error) {
    if (!worktreeCreated) {
      emitStep({ onProgress: args.onProgress, key: "git-worktree", text: commandText, status: "failed", metadata: { durationMs: Date.now() - worktreeStartedAt } });
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

  emitCwd({ onProgress: args.onProgress, keySuffix: "source", cwd: path.dirname(args.targetPath) });
  emitStep({ onProgress: args.onProgress, key: "git-clone", text: cloneText, status: "started" });
  const cloneStartedAt = Date.now();
  let cloneCompleted = false;
  let checkoutCompleted = false;
  try {
    const cloneResult = await runGit(cloneArgs, {
      cwd: path.dirname(args.targetPath),
      ...(cloneEnv ? { env: cloneEnv } : {}),
    });
    emitGitOutput(args.onProgress, "git-clone", cloneResult);
    emitStep({ onProgress: args.onProgress, key: "git-clone", text: cloneText, status: "completed", metadata: { durationMs: Date.now() - cloneStartedAt } });
    cloneCompleted = true;

    emitCwd({ onProgress: args.onProgress, keySuffix: "target", cwd: args.targetPath });
    emitStep({ onProgress: args.onProgress, key: "git-checkout", text: checkoutText, status: "started" });
    const checkoutStartedAt = Date.now();
    const checkoutResult = await runGit(checkoutArgs, { cwd: args.targetPath });
    emitGitOutput(args.onProgress, "git-checkout", checkoutResult);
    emitStep({ onProgress: args.onProgress, key: "git-checkout", text: checkoutText, status: "completed", metadata: { durationMs: Date.now() - checkoutStartedAt } });
    checkoutCompleted = true;

    await runSetupScript({
      workspacePath: args.targetPath,
      scriptName: args.scriptName,
      timeoutMs: args.timeoutMs,
      onProgress: args.onProgress,
    });
    return { path: args.targetPath };
  } catch (error) {
    if (!cloneCompleted) {
      emitStep({ onProgress: args.onProgress, key: "git-clone", text: cloneText, status: "failed", metadata: { durationMs: Date.now() - cloneStartedAt } });
    } else if (!checkoutCompleted) {
      emitStep({ onProgress: args.onProgress, key: "git-checkout", text: checkoutText, status: "failed" });
    }
    await removeDirectory({ path: args.targetPath });
    throw error;
  }
}

export async function runSetupScript(
  args: RunSetupScriptArgs,
): Promise<{ ran: boolean; exitCode?: number; output?: string }> {
  const resolvedScript = await resolveSetupScript(args);
  if (!resolvedScript) {
    return { ran: false };
  }

  const command = buildSetupScriptCommand(resolvedScript);
  const commandText = command.text;
  emitStep({ onProgress: args.onProgress, key: "setup", text: commandText, status: "started" });
  const startedAt = Date.now();

  const { timeoutMs } = args;
  const child = spawnPortableProcess({
    command: command.command,
    args: command.args,
    cwd: args.workspacePath,
    stdio: ["ignore", "pipe", "pipe"],
  });
  if (!child.stdout || !child.stderr) {
    throw new WorkspaceError(
      "setup_script_failed",
      `Setup script failed to attach stdio: ${resolvedScript.scriptPath}`,
    );
  }

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
      emitStep({ onProgress: args.onProgress, key: "setup", text: commandText, status: "failed", metadata: { durationMs } });
      throw new WorkspaceError(
        "setup_script_failed",
        `Setup script timed out after ${timeoutMs}ms: ${resolvedScript.scriptPath}`,
      );
    }

    if (result.signal) {
      emitStep({ onProgress: args.onProgress, key: "setup", text: commandText, status: "failed", metadata: { durationMs } });
      throw new WorkspaceError(
        "setup_script_failed",
        `Setup script exited via signal ${result.signal}: ${resolvedScript.scriptPath}`,
      );
    }

    if ((result.exitCode ?? 0) !== 0) {
      emitStep({ onProgress: args.onProgress, key: "setup", text: commandText, status: "failed", metadata: { durationMs } });
      throw new WorkspaceError(
        "setup_script_failed",
        `Setup script failed with exit code ${result.exitCode}: ${resolvedScript.scriptPath}`,
      );
    }

    emitStep({ onProgress: args.onProgress, key: "setup", text: commandText, status: "completed", metadata: { durationMs } });
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
