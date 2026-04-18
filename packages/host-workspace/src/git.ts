import { execFile, type ExecFileException } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const DEFAULT_BUFFER_BYTES = 16 * 1024 * 1024;

export class WorkspaceError extends Error {
  readonly code: string;
  constructor(code: string, message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.code = code;
    this.name = "WorkspaceError";
  }
}

export interface RunGitOptions {
  cwd: string;
  timeoutMs?: number;
  allowFailure?: boolean;
  env?: NodeJS.ProcessEnv;
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

export interface PorcelainEntry {
  path: string;
  status: string;
  indexStatus: string;
  worktreeStatus: string;
}

interface ParsedPorcelainPathToken {
  nextIndex: number;
  value: string;
}

const GIT_QUOTED_PATH_ESCAPE_BYTES = new Map<string, number>([
  ['"', 34],
  ["\\", 92],
  ["a", 7],
  ["b", 8],
  ["f", 12],
  ["n", 10],
  ["r", 13],
  ["t", 9],
  ["v", 11],
]);

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
      ...(options.env ? { env: { ...process.env, ...options.env } } : {}),
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
    throw new WorkspaceError(
      "git_command_failed",
      `git ${args.join(" ")} failed${detail}`,
      {
        cause: error,
      },
    );
  }
}

export async function getAbsoluteGitDir(cwd: string): Promise<string> {
  const result = await runGit(["rev-parse", "--absolute-git-dir"], { cwd });
  const gitDir = result.stdout.trim();
  if (!gitDir) {
    throw new WorkspaceError(
      "git_command_failed",
      `git rev-parse --absolute-git-dir returned no path for ${cwd}`,
    );
  }
  return path.resolve(gitDir);
}

export async function getGitCommonDir(cwd: string): Promise<string> {
  const result = await runGit(["rev-parse", "--git-common-dir"], { cwd });
  const commonDir = result.stdout.trim();
  if (!commonDir) {
    throw new WorkspaceError(
      "git_command_failed",
      `git rev-parse --git-common-dir returned no path for ${cwd}`,
    );
  }
  return path.resolve(cwd, commonDir);
}

/**
 * Run a POSIX shell pipeline and capture stdout. Arguments are passed as
 * positional shell parameters (`$1`, `$2`, ...) so interpolation doesn't
 * evaluate them — `mergeBaseBranch = "; rm -rf /"` is treated as the literal
 * value of `$2`, not as additional shell tokens.
 *
 * Use this for building short git pipelines (e.g. `git diff | git patch-id`)
 * where Node-side buffer-and-resend would otherwise be required. All
 * supported platforms (macOS, Linux, WSL2) ship POSIX `sh`.
 */
export async function runShellPipeline(
  script: string,
  positionalArgs: string[],
  options: { cwd: string; allowFailure?: boolean },
): Promise<GitCommandResult> {
  try {
    const result = await execFileAsync(
      "sh",
      ["-c", script, "sh", ...positionalArgs],
      {
        cwd: options.cwd,
        encoding: "utf8",
        maxBuffer: DEFAULT_BUFFER_BYTES,
      },
    );
    return { stdout: result.stdout, stderr: result.stderr, exitCode: 0 };
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
    throw new WorkspaceError(
      "shell_pipeline_failed",
      `shell pipeline failed${detail}`,
      { cause: error },
    );
  }
}

/**
 * Parse the patch-id SHA from a single line of `git patch-id` output. The
 * output format is `<patch-id> <commit-sha>` with one line per input commit.
 */
export function parsePatchId(line: string | undefined): string | undefined {
  const trimmed = line?.trim();
  if (!trimmed) {
    return undefined;
  }
  const [patchId] = trimmed.split(/\s+/);
  return patchId || undefined;
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
  const result = await runGit(["rev-parse", "--is-inside-work-tree"], {
    cwd,
    allowFailure: true,
  });
  return result.exitCode === 0 && trimOutput(result.stdout) === "true";
}

export async function ensureGitRepo(cwd: string): Promise<void> {
  if (await detectGitRepo(cwd)) {
    return;
  }

  throw new WorkspaceError(
    "not_git_repo",
    `Path is not a git repository: ${cwd}`,
  );
}

export async function getCurrentBranch(
  cwd: string,
): Promise<string | undefined> {
  if (!(await detectGitRepo(cwd))) {
    return undefined;
  }

  const result = await runGit(["symbolic-ref", "--quiet", "--short", "HEAD"], {
    cwd,
    allowFailure: true,
  });
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

function appendUtf8Bytes(bytes: number[], value: string): void {
  bytes.push(...Buffer.from(value, "utf8"));
}

function isOctalDigit(value: string | undefined): boolean {
  return value !== undefined && value >= "0" && value <= "7";
}

function readEscapedPorcelainPathBytes(
  bytes: number[],
  rawPath: string,
  startIndex: number,
): number {
  const escapeChar = rawPath[startIndex + 1];
  if (escapeChar === undefined) {
    return startIndex + 1;
  }
  if (isOctalDigit(escapeChar)) {
    let octalValue = escapeChar;
    let index = startIndex + 2;
    while (octalValue.length < 3 && isOctalDigit(rawPath[index])) {
      octalValue += rawPath[index] ?? "";
      index += 1;
    }
    bytes.push(Number.parseInt(octalValue, 8));
    return index;
  }
  const escapedByte = GIT_QUOTED_PATH_ESCAPE_BYTES.get(escapeChar);
  if (escapedByte !== undefined) {
    bytes.push(escapedByte);
  } else {
    appendUtf8Bytes(bytes, escapeChar);
  }
  return startIndex + 2;
}

function parseQuotedPorcelainPathToken(
  rawPath: string,
  startIndex: number,
): ParsedPorcelainPathToken {
  const bytes: number[] = [];
  let index = startIndex + 1;
  while (index < rawPath.length) {
    const currentChar = rawPath[index];
    if (currentChar === '"') {
      return {
        nextIndex: index + 1,
        value: Buffer.from(bytes).toString("utf8"),
      };
    }
    if (currentChar === "\\") {
      index = readEscapedPorcelainPathBytes(bytes, rawPath, index);
      continue;
    }
    const codePoint = rawPath.codePointAt(index);
    if (codePoint === undefined) {
      break;
    }
    const character = String.fromCodePoint(codePoint);
    appendUtf8Bytes(bytes, character);
    index += character.length;
  }
  return {
    nextIndex: rawPath.length,
    value: rawPath.slice(startIndex),
  };
}

function parseUnquotedPorcelainPathToken(
  rawPath: string,
  startIndex: number,
): ParsedPorcelainPathToken {
  const separatorIndex = rawPath.indexOf(" -> ", startIndex);
  const endIndex = separatorIndex === -1 ? rawPath.length : separatorIndex;
  return {
    nextIndex: endIndex,
    value: rawPath.slice(startIndex, endIndex),
  };
}

function parsePorcelainPathToken(
  rawPath: string,
  startIndex: number,
): ParsedPorcelainPathToken {
  if (rawPath[startIndex] === '"') {
    return parseQuotedPorcelainPathToken(rawPath, startIndex);
  }
  return parseUnquotedPorcelainPathToken(rawPath, startIndex);
}

function parsePorcelainPath(rawPath: string): string {
  const sourcePath = parsePorcelainPathToken(rawPath, 0);
  if (
    rawPath.slice(sourcePath.nextIndex, sourcePath.nextIndex + 4) !== " -> "
  ) {
    return sourcePath.value;
  }
  return parsePorcelainPathToken(rawPath, sourcePath.nextIndex + 4).value;
}

export function parsePorcelainEntries(statusOutput: string): PorcelainEntry[] {
  return statusOutput
    .split("\n")
    .filter((line) => line && !line.startsWith("##"))
    .map((line) => {
      const indexStatus = line[0] ?? " ";
      const worktreeStatus = line[1] ?? " ";
      const status = line.slice(0, 2).trim() || line.slice(0, 2);
      const rawPath = line.slice(3).trim();

      return {
        path: parsePorcelainPath(rawPath),
        status,
        indexStatus,
        worktreeStatus,
      };
    });
}

export interface NameStatusEntry {
  path: string;
  /** Raw status letter from `git diff --name-status` (M, A, D, R, C, T, U). */
  status: string;
}

/**
 * Parses the null-delimited output of `git diff --name-status -z`. Rename (R)
 * and copy (C) entries are followed by two paths (old then new); we keep only
 * the new path, which is what consumers want to highlight.
 */
export function parseNameStatusEntries(output: string): NameStatusEntry[] {
  const tokens = output.split("\0");
  const entries: NameStatusEntry[] = [];
  let index = 0;
  while (index < tokens.length) {
    const statusToken = tokens[index];
    if (!statusToken) {
      index += 1;
      continue;
    }
    const statusLetter = statusToken[0] ?? "";
    const isRenameOrCopy = statusLetter === "R" || statusLetter === "C";
    if (isRenameOrCopy) {
      const newPath = tokens[index + 2];
      if (newPath) {
        entries.push({ path: newPath, status: statusLetter });
      }
      index += 3;
    } else {
      const pathToken = tokens[index + 1];
      if (pathToken) {
        entries.push({ path: pathToken, status: statusLetter });
      }
      index += 2;
    }
  }
  return entries;
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
        insertions:
          summary.insertions + (Number.isFinite(insertions) ? insertions : 0),
        deletions:
          summary.deletions + (Number.isFinite(deletions) ? deletions : 0),
      };
    },
    { changedFiles: 0, insertions: 0, deletions: 0 },
  );
}

export async function readDefaultBranch(
  cwd: string,
): Promise<string | undefined> {
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
  const result = await runGit(["show-ref", "--verify", "--quiet", ref], {
    cwd,
    allowFailure: true,
  });
  return result.exitCode === 0;
}

export async function readMergeBaseRef(
  cwd: string,
  ref: string,
): Promise<string | undefined> {
  await ensureGitRepo(cwd);
  const result = await runGit(["merge-base", ref, "HEAD"], {
    cwd,
    allowFailure: true,
  });
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
