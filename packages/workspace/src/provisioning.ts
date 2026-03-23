import fs from "node:fs/promises";
import path from "node:path";
import { spawn } from "node:child_process";
import type { ProvisioningTranscriptEntry } from "@bb/domain";
import { Workspace } from "./workspace.js";
import { pathExists, runGit, WorkspaceError } from "./git.js";

type ProgressCallback = (entry: ProvisioningTranscriptEntry) => void;

export interface CreateWorkspaceArgs {
  sourcePath: string;
  targetPath: string;
  branchName: string;
  onProgress?: ProgressCallback;
}

export interface RunSetupScriptArgs {
  workspacePath: string;
  scriptName?: string;
  timeoutMs?: number;
  onProgress?: ProgressCallback;
}

export interface RemoveWorktreeArgs {
  path: string;
  force?: boolean;
}

function emitProgress(
  onProgress: ProgressCallback | undefined,
  entry: ProvisioningTranscriptEntry,
): void {
  onProgress?.(entry);
}

function emitStep(
  onProgress: ProgressCallback | undefined,
  key: string,
  text: string,
  status: "started" | "completed" | "failed",
): void {
  emitProgress(onProgress, {
    type: "step",
    key,
    text,
    status,
    startedAt: Date.now(),
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

async function ensureExistingWorkspaceMatches(
  targetPath: string,
  branchName: string,
): Promise<boolean> {
  if (!(await pathExists(targetPath))) {
    return false;
  }

  const workspace = new Workspace(targetPath);
  if (!(await workspace.isGitRepo)) {
    throw new WorkspaceError(`Target path exists but is not a git repo: ${targetPath}`);
  }

  if ((await workspace.currentBranch) !== branchName) {
    throw new WorkspaceError(
      `Target path exists on the wrong branch: ${targetPath}`,
    );
  }

  return true;
}

export async function createWorktree(args: CreateWorkspaceArgs): Promise<{ path: string }> {
  if (await ensureExistingWorkspaceMatches(args.targetPath, args.branchName)) {
    return { path: args.targetPath };
  }

  emitStep(args.onProgress, "worktree", "Creating git worktree", "started");
  try {
    await runGit(
      ["worktree", "add", "-B", args.branchName, args.targetPath],
      { cwd: args.sourcePath },
    );
    await runSetupScript({
      workspacePath: args.targetPath,
      onProgress: args.onProgress,
    });
    emitStep(args.onProgress, "worktree", "Created git worktree", "completed");
    return { path: args.targetPath };
  } catch (error) {
    emitStep(args.onProgress, "worktree", "Failed to create git worktree", "failed");
    await removeWorktree({ path: args.targetPath, force: true });
    throw error;
  }
}

export async function createClone(args: CreateWorkspaceArgs): Promise<{ path: string }> {
  if (await ensureExistingWorkspaceMatches(args.targetPath, args.branchName)) {
    return { path: args.targetPath };
  }

  emitStep(args.onProgress, "clone", "Cloning repository", "started");
  try {
    await runGit(["clone", args.sourcePath, args.targetPath], {
      cwd: path.dirname(args.targetPath),
    });
    await runGit(["checkout", "-B", args.branchName], { cwd: args.targetPath });
    await runSetupScript({
      workspacePath: args.targetPath,
      onProgress: args.onProgress,
    });
    emitStep(args.onProgress, "clone", "Cloned repository", "completed");
    return { path: args.targetPath };
  } catch (error) {
    emitStep(args.onProgress, "clone", "Failed to clone repository", "failed");
    await removeDirectory({ path: args.targetPath });
    throw error;
  }
}

export async function runSetupScript(
  args: RunSetupScriptArgs,
): Promise<{ ran: boolean; exitCode?: number; output?: string }> {
  const scriptName = args.scriptName ?? ".bb-env-setup.sh";
  const scriptPath = path.join(args.workspacePath, scriptName);
  if (!(await pathExists(scriptPath))) {
    return { ran: false };
  }

  emitStep(args.onProgress, "setup", `Running ${scriptName}`, "started");

  const timeoutMs = args.timeoutMs ?? 5 * 60 * 1000;
  const child = spawn("/bin/sh", [scriptPath], {
    cwd: args.workspacePath,
    stdio: ["ignore", "pipe", "pipe"],
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
    if (timedOut) {
      emitStep(args.onProgress, "setup", `${scriptName} timed out`, "failed");
      throw new WorkspaceError(
        `Setup script timed out after ${timeoutMs}ms: ${scriptPath}`,
      );
    }

    if (result.signal) {
      emitStep(args.onProgress, "setup", `${scriptName} interrupted`, "failed");
      throw new WorkspaceError(
        `Setup script exited via signal ${result.signal}: ${scriptPath}`,
      );
    }

    if ((result.exitCode ?? 0) !== 0) {
      emitStep(args.onProgress, "setup", `${scriptName} failed`, "failed");
      throw new WorkspaceError(
        `Setup script failed with exit code ${result.exitCode}: ${scriptPath}`,
      );
    }

    emitStep(args.onProgress, "setup", `Finished ${scriptName}`, "completed");
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
