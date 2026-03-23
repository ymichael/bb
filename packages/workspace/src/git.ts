import { execFile, type ExecFileException } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const DEFAULT_BUFFER_BYTES = 16 * 1024 * 1024;

export class WorkspaceError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "WorkspaceError";
  }
}

export interface RunGitOptions {
  cwd: string;
  timeoutMs?: number;
  allowFailure?: boolean;
}

export interface GitCommandResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

type BranchStatus = {
  branchName?: string;
  aheadCount: number;
  behindCount: number;
};

function toExecError(error: unknown): ExecFileException | undefined {
  if (error instanceof Error) {
    return error as ExecFileException;
  }
  return undefined;
}

function trimOutput(value: string): string {
  return value.trim().replace(/\n+$/u, "");
}

function getExitCode(error: ExecFileException | undefined): number {
  if (typeof error?.code === "number") {
    return error.code;
  }
  return 1;
}

export async function runGit(
  args: string[],
  options: RunGitOptions,
): Promise<GitCommandResult> {
  try {
    const result = await execFileAsync("git", args, {
      cwd: options.cwd,
      encoding: "utf8",
      maxBuffer: DEFAULT_BUFFER_BYTES,
      timeout: options.timeoutMs,
    });
    return {
      stdout: result.stdout,
      stderr: result.stderr,
      exitCode: 0,
    };
  } catch (error) {
    const execError = toExecError(error);
    if (options.allowFailure) {
      return {
        stdout: execError?.stdout ?? "",
        stderr: execError?.stderr ?? "",
        exitCode: getExitCode(execError),
      };
    }

    const stderr = trimOutput(execError?.stderr ?? "");
    const detail = stderr ? `: ${stderr}` : "";
    throw new WorkspaceError(`git ${args.join(" ")} failed${detail}`, {
      cause: error,
    });
  }
}

export async function pathExists(targetPath: string): Promise<boolean> {
  try {
    await fs.access(targetPath);
    return true;
  } catch {
    return false;
  }
}

export async function detectGitRepo(cwd: string): Promise<boolean> {
  const result = await runGit(
    ["rev-parse", "--is-inside-work-tree"],
    { cwd, allowFailure: true },
  );
  return result.exitCode === 0 && trimOutput(result.stdout) === "true";
}

export async function ensureGitRepo(cwd: string): Promise<void> {
  if (await detectGitRepo(cwd)) {
    return;
  }

  throw new WorkspaceError(`Path is not a git repository: ${cwd}`);
}

export async function getCurrentBranch(cwd: string): Promise<string | undefined> {
  if (!(await detectGitRepo(cwd))) {
    return undefined;
  }

  const result = await runGit(
    ["symbolic-ref", "--quiet", "--short", "HEAD"],
    { cwd, allowFailure: true },
  );
  if (result.exitCode !== 0) {
    return undefined;
  }

  const branchName = trimOutput(result.stdout);
  return branchName || undefined;
}

export function parseBranchStatus(line: string | undefined): BranchStatus {
  const cleaned = line?.trim() ?? "";
  if (!cleaned.startsWith("##")) {
    return { aheadCount: 0, behindCount: 0 };
  }

  const branchMatch = cleaned.match(/^##\s+([^.\s]+)(?:\.\.\.[^\s]+)?/u);
  const aheadMatch = cleaned.match(/ahead (\d+)/u);
  const behindMatch = cleaned.match(/behind (\d+)/u);

  return {
    branchName: branchMatch?.[1],
    aheadCount: aheadMatch ? Number.parseInt(aheadMatch[1], 10) : 0,
    behindCount: behindMatch ? Number.parseInt(behindMatch[1], 10) : 0,
  };
}

export function parsePorcelainEntries(statusOutput: string): Array<{
  path: string;
  status: string;
  indexStatus: string;
  worktreeStatus: string;
}> {
  return statusOutput
    .split("\n")
    .filter((line) => line && !line.startsWith("##"))
    .map((line) => {
      const indexStatus = line[0] ?? " ";
      const worktreeStatus = line[1] ?? " ";
      const status = line.slice(0, 2).trim() || line.slice(0, 2);
      const rawPath = line.slice(3).trim();
      const renamedParts = rawPath.split(" -> ");

      return {
        path: renamedParts.at(-1) ?? rawPath,
        status,
        indexStatus,
        worktreeStatus,
      };
    });
}

export function summarizeNumstat(output: string): {
  changedFiles: number;
  insertions: number;
  deletions: number;
} {
  const lines = output.split("\n").filter(Boolean);

  return lines.reduce(
    (summary, line) => {
      const [insertionsText, deletionsText] = line.split("\t");
      const insertions = Number.parseInt(insertionsText ?? "", 10);
      const deletions = Number.parseInt(deletionsText ?? "", 10);

      return {
        changedFiles: summary.changedFiles + 1,
        insertions: summary.insertions + (Number.isFinite(insertions) ? insertions : 0),
        deletions: summary.deletions + (Number.isFinite(deletions) ? deletions : 0),
      };
    },
    { changedFiles: 0, insertions: 0, deletions: 0 },
  );
}

export async function readDefaultBranch(cwd: string): Promise<string | undefined> {
  await ensureGitRepo(cwd);

  const originHead = await runGit(
    ["symbolic-ref", "--quiet", "refs/remotes/origin/HEAD"],
    { cwd, allowFailure: true },
  );
  const remoteHead = trimOutput(originHead.stdout);
  if (remoteHead.startsWith("refs/remotes/origin/")) {
    return remoteHead.replace("refs/remotes/origin/", "");
  }

  const branches = await runGit(
    ["for-each-ref", "--format=%(refname:short)", "refs/heads"],
    { cwd },
  );
  const localBranches = branches.stdout
    .split("\n")
    .map((value) => value.trim())
    .filter(Boolean);

  if (localBranches.includes("main")) {
    return "main";
  }
  if (localBranches.includes("master")) {
    return "master";
  }

  return localBranches[0];
}

export async function hasRef(cwd: string, ref: string): Promise<boolean> {
  await ensureGitRepo(cwd);
  const result = await runGit(
    ["show-ref", "--verify", "--quiet", ref],
    { cwd, allowFailure: true },
  );
  return result.exitCode === 0;
}

export async function readMergeBaseRef(
  cwd: string,
  ref: string,
): Promise<string | undefined> {
  await ensureGitRepo(cwd);
  const result = await runGit(
    ["merge-base", ref, "HEAD"],
    { cwd, allowFailure: true },
  );
  if (result.exitCode !== 0) {
    return undefined;
  }

  const mergeBaseRef = trimOutput(result.stdout);
  return mergeBaseRef || undefined;
}

export async function revParse(cwd: string, ref: string): Promise<string> {
  await ensureGitRepo(cwd);
  const result = await runGit(["rev-parse", ref], { cwd });
  return trimOutput(result.stdout);
}

export async function listBranches(cwd: string): Promise<string[]> {
  await ensureGitRepo(cwd);
  const result = await runGit(
    ["for-each-ref", "--format=%(refname:short)", "refs/heads"],
    { cwd },
  );
  return result.stdout
    .split("\n")
    .map((branch) => branch.trim())
    .filter(Boolean);
}

export async function hasUncommittedChanges(cwd: string): Promise<boolean> {
  await ensureGitRepo(cwd);
  const status = await runGit(
    ["status", "--porcelain=v1", "--untracked-files=all"],
    { cwd },
  );
  return status.stdout.trim().length > 0;
}

export async function createTempDir(prefix: string): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), prefix));
}
