import { execFile, spawn, type ExecFileException } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import type {
  DefaultBranchRelation,
  GitCheckoutRef,
  WorkspaceGitOperation,
} from "@bb/domain";
import { sanitizeInheritedChildProcessEnv } from "@bb/process-utils";

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

export interface GitProcessOptions {
  shellPath?: string;
}

export interface RunGitOptions extends GitProcessOptions {
  cwd: string;
  timeoutMs?: number;
  allowFailure?: boolean;
  env?: NodeJS.ProcessEnv;
  signal?: AbortSignal;
  maxBufferBytes?: number;
  allowTruncatedStdout?: boolean;
}

interface ResolveGitProcessEnvArgs {
  env: NodeJS.ProcessEnv | undefined;
  shellPath: string | undefined;
}

interface GitTimeoutOptions extends GitProcessOptions {
  timeoutMs?: number;
}

interface FetchRemoteBranchesResult {
  status: "fetched" | "failed" | "skipped";
}

interface DefaultBranchRefs {
  defaultBranch: string | undefined;
  defaultBranchRelation: DefaultBranchRelation | undefined;
  originDefaultBranch: string | undefined;
}

interface BranchRefsWithDefaults {
  branches: string[];
  defaultBranch: string | undefined;
  originDefaultBranch: string | undefined;
  remoteBranches: string[];
}

interface RunShellPipelineOptions extends GitTimeoutOptions {
  cwd: string;
  allowFailure?: boolean;
  signal?: AbortSignal;
}

export interface GitCommandResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

export type GitNullRecordFormat = "single" | "name-status" | "numstat";

export interface GitNullRecordLimitResult extends GitCommandResult {
  recordCount: number;
  recordLimitReached: boolean;
}

type ActiveWorkspaceGitOperationKind = Exclude<
  WorkspaceGitOperation["kind"],
  "none" | "unknown"
>;

interface PorcelainEntry {
  path: string;
  status: string;
  indexStatus: string;
  worktreeStatus: string;
}

interface WorkspaceGitOperationMarker {
  kind: ActiveWorkspaceGitOperationKind;
  markerNames: string[];
}

interface ParsedPorcelainPathToken {
  nextIndex: number;
  value: string;
}

const CONFLICT_PORCELAIN_STATUSES = new Set<string>([
  "DD",
  "AU",
  "UD",
  "UA",
  "DU",
  "AA",
  "UU",
]);

const WORKSPACE_GIT_OPERATION_MARKERS: WorkspaceGitOperationMarker[] = [
  { kind: "rebase", markerNames: ["rebase-merge", "rebase-apply"] },
  { kind: "merge", markerNames: ["MERGE_HEAD"] },
  { kind: "cherry-pick", markerNames: ["CHERRY_PICK_HEAD"] },
  { kind: "revert", markerNames: ["REVERT_HEAD"] },
];

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

function resolveGitProcessEnv(
  args: ResolveGitProcessEnvArgs,
): NodeJS.ProcessEnv {
  return {
    ...sanitizeInheritedChildProcessEnv({
      env: process.env,
      ...(args.shellPath !== undefined ? { shellPath: args.shellPath } : {}),
    }),
    ...args.env,
  };
}

function isMaxBufferExceededError(error: unknown): boolean {
  return (
    error instanceof Error &&
    "code" in error &&
    error.code === "ERR_CHILD_PROCESS_STDIO_MAXBUFFER"
  );
}

function isStdoutMaxBufferExceededError(error: unknown): boolean {
  return (
    isMaxBufferExceededError(error) &&
    error instanceof Error &&
    error.message.includes("stdout maxBuffer")
  );
}

function readCommandTimeoutMs(
  error: ExecFileException | undefined,
  timeoutMs: number | undefined,
): number | null {
  if (
    typeof timeoutMs === "number" &&
    error?.killed === true &&
    error.signal === "SIGTERM"
  ) {
    return timeoutMs;
  }
  return null;
}

function isMissingGitBlobTargetError(stderr: string): boolean {
  return (
    /^fatal: path '.+' does not exist in '.+'$/u.test(stderr) ||
    /^fatal: invalid object name '.+'\.$/u.test(stderr) ||
    /^fatal: Not a valid object name .+$/u.test(stderr)
  );
}

function createGitCommandTimedOutError(
  args: string[],
  timeoutMs: number,
  cause?: unknown,
): WorkspaceError {
  return new WorkspaceError(
    "git_command_timeout",
    `git ${args.join(" ")} timed out after ${timeoutMs}ms`,
    { cause },
  );
}

function createGitCommandCancelledError(
  args: string[],
  cause?: unknown,
): WorkspaceError {
  return new WorkspaceError(
    "provision_cancelled",
    `git ${args.join(" ")} was cancelled`,
    { cause },
  );
}

function createShellPipelineTimedOutError(
  timeoutMs: number,
  cause?: unknown,
): WorkspaceError {
  return new WorkspaceError(
    "shell_pipeline_timeout",
    `shell pipeline timed out after ${timeoutMs}ms`,
    { cause },
  );
}

function createShellPipelineCancelledError(cause?: unknown): WorkspaceError {
  return new WorkspaceError(
    "provision_cancelled",
    "Shell pipeline was cancelled",
    {
      cause,
    },
  );
}

function createGitCommandFailedError(
  args: string[],
  stderr: string,
  cause?: unknown,
): WorkspaceError {
  const detail = stderr ? `: ${stderr}` : "";
  return new WorkspaceError(
    "git_command_failed",
    `git ${args.join(" ")} failed${detail}`,
    { cause },
  );
}

export async function runGit(
  args: string[],
  options: RunGitOptions,
): Promise<GitCommandResult> {
  if (options.signal?.aborted) {
    throw createGitCommandCancelledError(args, options.signal.reason);
  }
  try {
    const result = await execFileAsync("git", args, {
      cwd: options.cwd,
      encoding: "utf8",
      env: resolveGitProcessEnv({
        env: options.env,
        shellPath: options.shellPath,
      }),
      maxBuffer: options.maxBufferBytes ?? DEFAULT_BUFFER_BYTES,
      signal: options.signal,
      timeout: options.timeoutMs,
    });
    return {
      stdout: result.stdout,
      stderr: result.stderr,
      exitCode: 0,
    };
  } catch (error) {
    if (options.signal?.aborted) {
      throw createGitCommandCancelledError(args, error);
    }
    const execError = toExecError(error);
    const timeoutMs = readCommandTimeoutMs(execError, options.timeoutMs);
    if (timeoutMs !== null) {
      throw createGitCommandTimedOutError(args, timeoutMs, error);
    }
    if (
      options.allowTruncatedStdout === true &&
      isStdoutMaxBufferExceededError(error)
    ) {
      return {
        stdout: execError?.stdout ?? "",
        stderr: execError?.stderr ?? "",
        exitCode: 0,
      };
    }
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

export async function runGitWithNullRecordLimit(
  args: string[],
  options: RunGitOptions,
  recordFormat: GitNullRecordFormat,
  maxRecords: number,
): Promise<GitNullRecordLimitResult> {
  if (!Number.isInteger(maxRecords) || maxRecords <= 0) {
    throw new WorkspaceError(
      "invalid_request",
      "maxRecords must be a positive integer",
    );
  }
  if (options.signal?.aborted) {
    throw createGitCommandCancelledError(args, options.signal.reason);
  }

  return new Promise((resolve, reject) => {
    const child = spawn("git", args, {
      cwd: options.cwd,
      env: resolveGitProcessEnv({
        env: options.env,
        shellPath: options.shellPath,
      }),
      stdio: ["ignore", "pipe", "pipe"],
    });
    const stdoutRecords: Buffer[] = [];
    const stderrChunks: Buffer[] = [];
    let pending = Buffer.alloc(0);
    let currentRecord: Buffer[] = [];
    let expectedTokens = recordFormat === "single" ? 1 : 0;
    let recordCount = 0;
    let recordLimitReached = false;
    let aborted = false;
    let timedOut = false;
    let spawnError: Error | undefined;
    let timeout: ReturnType<typeof setTimeout> | undefined;

    const stopChild = (): void => {
      child.stdout.pause();
      child.kill();
    };
    const onAbort = (): void => {
      if (recordLimitReached) return;
      aborted = true;
      stopChild();
    };

    options.signal?.addEventListener("abort", onAbort, { once: true });
    if (options.signal?.aborted) onAbort();
    if (options.timeoutMs !== undefined) {
      timeout = setTimeout(() => {
        if (recordLimitReached) return;
        timedOut = true;
        stopChild();
      }, options.timeoutMs);
    }

    child.stdout.on("data", (chunk: Buffer) => {
      if (recordLimitReached) return;
      const input =
        pending.length === 0 ? chunk : Buffer.concat([pending, chunk]);
      let tokenStart = 0;
      for (let index = 0; index < input.length; index += 1) {
        if (input[index] !== 0) continue;

        const token = Buffer.from(input.subarray(tokenStart, index));
        currentRecord.push(token);
        if (currentRecord.length === 1) {
          if (recordFormat === "name-status") {
            const statusLetter = token[0];
            expectedTokens = statusLetter === 82 || statusLetter === 67 ? 3 : 2;
          } else if (recordFormat === "numstat") {
            const firstTab = token.indexOf(9);
            const secondTab = token.indexOf(9, firstTab + 1);
            expectedTokens = secondTab === token.length - 1 ? 3 : 1;
          }
        }

        if (currentRecord.length === expectedTokens) {
          for (const recordToken of currentRecord) {
            stdoutRecords.push(recordToken, Buffer.from([0]));
          }
          currentRecord = [];
          expectedTokens = recordFormat === "single" ? 1 : 0;
          recordCount += 1;
          if (recordCount === maxRecords) {
            recordLimitReached = true;
            pending = Buffer.alloc(0);
            stopChild();
            return;
          }
        }
        tokenStart = index + 1;
      }
      pending = Buffer.from(input.subarray(tokenStart));
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderrChunks.push(chunk);
    });
    child.once("error", (error) => {
      spawnError = error;
    });
    child.once("close", (code) => {
      if (timeout !== undefined) clearTimeout(timeout);
      options.signal?.removeEventListener("abort", onAbort);

      const stdout = Buffer.concat(stdoutRecords).toString("utf8");
      const stderr = Buffer.concat(stderrChunks).toString("utf8");
      if (recordLimitReached) {
        resolve({
          stdout,
          stderr,
          exitCode: 0,
          recordCount,
          recordLimitReached: true,
        });
        return;
      }
      if (aborted || options.signal?.aborted) {
        reject(createGitCommandCancelledError(args, options.signal?.reason));
        return;
      }
      if (timedOut && options.timeoutMs !== undefined) {
        reject(createGitCommandTimedOutError(args, options.timeoutMs));
        return;
      }
      if (spawnError !== undefined) {
        reject(
          createGitCommandFailedError(args, trimOutput(stderr), spawnError),
        );
        return;
      }

      const exitCode = code ?? 1;
      if (exitCode === 0 || options.allowFailure === true) {
        resolve({
          stdout,
          stderr,
          exitCode,
          recordCount,
          recordLimitReached: false,
        });
        return;
      }
      reject(createGitCommandFailedError(args, trimOutput(stderr)));
    });
  });
}

export async function getAbsoluteGitDir(
  cwd: string,
  options: GitProcessOptions = {},
): Promise<string> {
  const result = await runGit(["rev-parse", "--absolute-git-dir"], {
    cwd,
    ...options,
  });
  const gitDir = result.stdout.trim();
  if (!gitDir) {
    throw new WorkspaceError(
      "git_command_failed",
      `git rev-parse --absolute-git-dir returned no path for ${cwd}`,
    );
  }
  return path.resolve(gitDir);
}

export async function getGitCommonDir(
  cwd: string,
  options: GitProcessOptions & { signal?: AbortSignal } = {},
): Promise<string> {
  const result = await runGit(["rev-parse", "--git-common-dir"], {
    cwd,
    ...options,
  });
  const commonDir = result.stdout.trim();
  if (!commonDir) {
    throw new WorkspaceError(
      "git_command_failed",
      `git rev-parse --git-common-dir returned no path for ${cwd}`,
    );
  }
  return path.resolve(cwd, commonDir);
}

export async function runShellPipeline(
  script: string,
  positionalArgs: string[],
  options: RunShellPipelineOptions,
): Promise<GitCommandResult> {
  if (options.signal?.aborted) {
    throw createShellPipelineCancelledError(options.signal.reason);
  }
  try {
    const result = await execFileAsync(
      "/bin/sh",
      ["-c", script, "sh", ...positionalArgs],
      {
        cwd: options.cwd,
        encoding: "utf8",
        env: resolveGitProcessEnv({
          env: undefined,
          shellPath: options.shellPath,
        }),
        maxBuffer: DEFAULT_BUFFER_BYTES,
        signal: options.signal,
        timeout: options.timeoutMs,
      },
    );
    return { stdout: result.stdout, stderr: result.stderr, exitCode: 0 };
  } catch (error) {
    if (options.signal?.aborted) {
      throw createShellPipelineCancelledError(error);
    }
    const execError = toExecError(error);
    const timeoutMs = readCommandTimeoutMs(execError, options.timeoutMs);
    if (timeoutMs !== null) {
      throw createShellPipelineTimedOutError(timeoutMs, error);
    }
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

async function findWorkspaceGitOperationMarker(
  gitDir: string,
): Promise<WorkspaceGitOperationMarker | undefined> {
  for (const marker of WORKSPACE_GIT_OPERATION_MARKERS) {
    for (const markerName of marker.markerNames) {
      if (await pathExists(path.join(gitDir, markerName))) {
        return marker;
      }
    }
  }
  return undefined;
}

export type GitRepoKind = "work-tree" | "bare" | "none";

export async function detectGitRepoKind(
  cwd: string,
  options: GitTimeoutOptions = {},
): Promise<GitRepoKind> {
  const result = await runGit(
    ["rev-parse", "--is-inside-work-tree", "--is-bare-repository"],
    { cwd, ...options, allowFailure: true },
  );
  if (result.exitCode !== 0) {
    return "none";
  }
  const [insideWorkTree, bare] = trimOutput(result.stdout).split("\n");
  if (insideWorkTree === "true") {
    return "work-tree";
  }
  if (bare === "true") {
    return "bare";
  }
  return "none";
}

export async function detectGitRepo(
  cwd: string,
  options: GitTimeoutOptions = {},
): Promise<boolean> {
  return (await detectGitRepoKind(cwd, options)) === "work-tree";
}

export async function detectGitSource(
  cwd: string,
  options: GitTimeoutOptions = {},
): Promise<boolean> {
  return (await detectGitRepoKind(cwd, options)) !== "none";
}

export async function ensureGitRepo(
  cwd: string,
  options: GitTimeoutOptions = {},
): Promise<void> {
  if (await detectGitSource(cwd, options)) {
    return;
  }

  throw new WorkspaceError(
    "not_git_repo",
    `Path is not a git repository: ${cwd}`,
  );
}

type GitRepositoryState = "not_git" | "no_commits" | "has_commits";

export async function readGitRepositoryState(
  cwd: string,
  options: GitTimeoutOptions = {},
): Promise<GitRepositoryState> {
  if (!(await detectGitSource(cwd, options))) {
    return "not_git";
  }
  const result = await runGit(["rev-list", "--all", "--max-count=1"], {
    cwd,
    ...options,
  });
  return trimOutput(result.stdout).length > 0 ? "has_commits" : "no_commits";
}

async function readHeadSha(
  cwd: string,
  options: GitTimeoutOptions = {},
): Promise<string | null> {
  const result = await runGit(["rev-parse", "--verify", "HEAD"], {
    cwd,
    ...options,
    allowFailure: true,
  });
  if (result.exitCode !== 0) {
    return null;
  }

  const sha = trimOutput(result.stdout);
  return sha || null;
}

export async function getCurrentBranch(
  cwd: string,
  options: GitTimeoutOptions = {},
): Promise<string | undefined> {
  if (!(await detectGitRepo(cwd, options))) {
    return undefined;
  }

  const result = await runGit(["symbolic-ref", "--quiet", "--short", "HEAD"], {
    cwd,
    ...options,
    allowFailure: true,
  });
  if (result.exitCode !== 0) {
    return undefined;
  }

  const branchName = trimOutput(result.stdout);
  return branchName || undefined;
}

export async function getCheckoutRef(
  cwd: string,
  options: GitTimeoutOptions = {},
): Promise<GitCheckoutRef> {
  if (!(await detectGitSource(cwd, options))) {
    return { kind: "unknown", reason: "Path is not a git repository" };
  }

  const [symbolicRef, headSha] = await Promise.all([
    runGit(["symbolic-ref", "--quiet", "--short", "HEAD"], {
      cwd,
      ...options,
      allowFailure: true,
    }),
    readHeadSha(cwd, options),
  ]);

  const branchName = trimOutput(symbolicRef.stdout);
  if (symbolicRef.exitCode === 0 && branchName) {
    if (headSha === null) {
      return { kind: "unborn", branchName };
    }
    return { kind: "branch", branchName, headSha };
  }

  if (headSha !== null) {
    return { kind: "detached", headSha };
  }

  return {
    kind: "unknown",
    reason: "HEAD is not symbolic and no commit is checked out",
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

function hasPorcelainConflict(entries: PorcelainEntry[]): boolean {
  return entries.some(
    (entry) =>
      entry.indexStatus === "U" ||
      entry.worktreeStatus === "U" ||
      CONFLICT_PORCELAIN_STATUSES.has(entry.status),
  );
}

function buildActiveWorkspaceGitOperation(
  kind: ActiveWorkspaceGitOperationKind,
  hasConflicts: boolean,
): WorkspaceGitOperation {
  switch (kind) {
    case "merge":
      return { kind: "merge", hasConflicts };
    case "rebase":
      return { kind: "rebase", hasConflicts };
    case "cherry-pick":
      return { kind: "cherry-pick", hasConflicts };
    case "revert":
      return { kind: "revert", hasConflicts };
  }
}

export async function getWorkspaceGitOperation(
  cwd: string,
  options: GitProcessOptions = {},
): Promise<WorkspaceGitOperation> {
  await ensureGitRepo(cwd, options);

  const [gitDir, status] = await Promise.all([
    getAbsoluteGitDir(cwd, options),
    runGit(
      [
        "--no-optional-locks",
        "status",
        "--porcelain=v1",
        "--untracked-files=all",
      ],
      { cwd, ...options },
    ),
  ]);
  const hasConflicts = hasPorcelainConflict(
    parsePorcelainEntries(status.stdout),
  );
  const marker = await findWorkspaceGitOperationMarker(gitDir);
  if (!marker) {
    return { kind: "none" };
  }
  return buildActiveWorkspaceGitOperation(marker.kind, hasConflicts);
}

interface NameStatusEntry {
  path: string;
  status: string;
}

export interface NameStatusSourceEntry extends NameStatusEntry {
  previousPath: string | null;
}

export function parseNameStatusSourceEntries(
  output: string,
): NameStatusSourceEntry[] {
  const tokens = output.split("\0");
  const entries: NameStatusSourceEntry[] = [];
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
      const oldPath = tokens[index + 1];
      const newPath = tokens[index + 2];
      if (newPath) {
        entries.push({
          path: newPath,
          status: statusLetter,
          previousPath: oldPath ?? null,
        });
      }
      index += 3;
    } else {
      const pathToken = tokens[index + 1];
      if (pathToken) {
        entries.push({
          path: pathToken,
          status: statusLetter,
          previousPath: null,
        });
      }
      index += 2;
    }
  }
  return entries;
}

export function parseNameStatusEntries(output: string): NameStatusEntry[] {
  return parseNameStatusSourceEntries(output).map(({ path, status }) => ({
    path,
    status,
  }));
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

export interface NumstatEntry {
  path: string;
  insertions: number | null;
  deletions: number | null;
}

export function parseNumstatEntriesZ(output: string): NumstatEntry[] {
  const entries: NumstatEntry[] = [];
  let cursor = 0;
  while (cursor < output.length) {
    const firstTab = output.indexOf("\t", cursor);
    if (firstTab < 0) break;
    const secondTab = output.indexOf("\t", firstTab + 1);
    if (secondTab < 0) break;
    const insertions = parseNumstatCount(output.slice(cursor, firstTab));
    const deletions = parseNumstatCount(output.slice(firstTab + 1, secondTab));

    let path: string;
    if (output[secondTab + 1] === "\0") {
      const oldEnd = output.indexOf("\0", secondTab + 2);
      if (oldEnd < 0) break;
      const newEnd = output.indexOf("\0", oldEnd + 1);
      if (newEnd < 0) break;
      path = output.slice(oldEnd + 1, newEnd);
      cursor = newEnd + 1;
    } else {
      const end = output.indexOf("\0", secondTab + 1);
      if (end < 0) break;
      path = output.slice(secondTab + 1, end);
      cursor = end + 1;
    }
    entries.push({ path, insertions, deletions });
  }
  return entries;
}

function parseNumstatCount(text: string): number | null {
  const value = Number.parseInt(text, 10);
  return Number.isFinite(value) ? value : null;
}

export async function readDefaultBranch(
  cwd: string,
  options: GitTimeoutOptions = {},
): Promise<string | undefined> {
  await ensureGitRepo(cwd, options);

  const originHead = await runGit(
    ["symbolic-ref", "--quiet", "refs/remotes/origin/HEAD"],
    { cwd, ...options, allowFailure: true },
  );
  const remoteHead = trimOutput(originHead.stdout);
  if (remoteHead.startsWith("refs/remotes/origin/")) {
    return remoteHead.replace("refs/remotes/origin/", "");
  }

  const branches = await runGit(
    ["for-each-ref", "--format=%(refname:short)", "refs/heads"],
    { cwd, ...options },
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

async function readLocalBranches(
  cwd: string,
  options: GitTimeoutOptions = {},
): Promise<string[]> {
  const branches = await runGit(
    ["for-each-ref", "--format=%(refname:short)", "refs/heads"],
    { cwd, ...options },
  );
  return branches.stdout
    .split("\n")
    .map((value) => value.trim())
    .filter(Boolean);
}

function resolvePreferredLocalDefaultBranch(
  localBranches: readonly string[],
  originDefaultBranchName: string | undefined,
): string | undefined {
  if (
    originDefaultBranchName &&
    localBranches.includes(originDefaultBranchName)
  ) {
    return originDefaultBranchName;
  }
  if (localBranches.includes("main")) {
    return "main";
  }
  if (localBranches.includes("master")) {
    return "master";
  }
  return localBranches[0];
}

function parseOriginHeadBranchName(output: string): string | undefined {
  const remoteHead = trimOutput(output);
  if (remoteHead.startsWith("refs/remotes/origin/")) {
    return remoteHead.replace("refs/remotes/origin/", "");
  }
  return undefined;
}

async function readOriginHeadBranchName(
  cwd: string,
  options: GitTimeoutOptions = {},
): Promise<string | undefined> {
  const originHead = await runGit(
    ["symbolic-ref", "--quiet", "refs/remotes/origin/HEAD"],
    { cwd, ...options, allowFailure: true },
  );
  return parseOriginHeadBranchName(originHead.stdout);
}

export async function hasRef(
  cwd: string,
  ref: string,
  options: GitTimeoutOptions = {},
): Promise<boolean> {
  await ensureGitRepo(cwd, options);
  const result = await runGit(["show-ref", "--verify", "--quiet", ref], {
    cwd,
    ...options,
    allowFailure: true,
  });
  return result.exitCode === 0;
}

async function readOriginDefaultBranch(
  cwd: string,
  localDefaultBranch: string | undefined,
  options: GitTimeoutOptions = {},
): Promise<string | undefined> {
  const originHeadBranch = await readOriginHeadBranchName(cwd, options);
  if (
    originHeadBranch &&
    (await hasRef(cwd, `refs/remotes/origin/${originHeadBranch}`, options))
  ) {
    return `origin/${originHeadBranch}`;
  }

  if (
    localDefaultBranch &&
    (await hasRef(cwd, `refs/remotes/origin/${localDefaultBranch}`, options))
  ) {
    return `origin/${localDefaultBranch}`;
  }

  return undefined;
}

async function revParseRef(
  cwd: string,
  ref: string,
  options: GitTimeoutOptions = {},
): Promise<string | undefined> {
  const result = await runGit(["rev-parse", "--verify", `${ref}^{commit}`], {
    cwd,
    ...options,
    allowFailure: true,
  });
  if (result.exitCode !== 0) {
    return undefined;
  }
  return trimOutput(result.stdout) || undefined;
}

async function isAncestorRef(
  cwd: string,
  ancestorRef: string,
  descendantRef: string,
  options: GitTimeoutOptions = {},
): Promise<boolean | undefined> {
  const result = await runGit(
    ["merge-base", "--is-ancestor", ancestorRef, descendantRef],
    { cwd, ...options, allowFailure: true },
  );
  if (result.exitCode === 0) {
    return true;
  }
  if (result.exitCode === 1) {
    return false;
  }
  return undefined;
}

async function readDefaultBranchRelation(
  cwd: string,
  localDefaultBranch: string | undefined,
  originDefaultBranch: string | undefined,
  options: GitTimeoutOptions = {},
): Promise<DefaultBranchRelation | undefined> {
  if (!localDefaultBranch || !originDefaultBranch) {
    return undefined;
  }

  const localRef = `refs/heads/${localDefaultBranch}`;
  const originRef = `refs/remotes/${originDefaultBranch}`;
  const [localSha, originSha] = await Promise.all([
    revParseRef(cwd, localRef, options),
    revParseRef(cwd, originRef, options),
  ]);
  if (!localSha || !originSha) {
    return "unknown";
  }
  if (localSha === originSha) {
    return "equal";
  }

  const localIsAncestor = await isAncestorRef(
    cwd,
    localRef,
    originRef,
    options,
  );
  if (localIsAncestor === true) {
    return "local-behind";
  }
  if (localIsAncestor === undefined) {
    return "unknown";
  }

  const originIsAncestor = await isAncestorRef(
    cwd,
    originRef,
    localRef,
    options,
  );
  if (originIsAncestor === true) {
    return "local-ahead";
  }
  if (originIsAncestor === undefined) {
    return "unknown";
  }

  return "diverged";
}

export async function readDefaultBranchRefs(
  cwd: string,
  options: GitTimeoutOptions = {},
): Promise<DefaultBranchRefs> {
  await ensureGitRepo(cwd, options);
  const originHeadBranch = await readOriginHeadBranchName(cwd, options);
  const localBranches = await readLocalBranches(cwd, options);
  const defaultBranch = resolvePreferredLocalDefaultBranch(
    localBranches,
    originHeadBranch,
  );
  const originDefaultBranch = await readOriginDefaultBranch(
    cwd,
    defaultBranch,
    options,
  );
  const defaultBranchRelation = await readDefaultBranchRelation(
    cwd,
    defaultBranch,
    originDefaultBranch,
    options,
  );

  return {
    defaultBranch,
    defaultBranchRelation,
    originDefaultBranch,
  };
}

export async function fetchRemoteBranches(
  cwd: string,
  options: GitTimeoutOptions = {},
): Promise<FetchRemoteBranchesResult> {
  await ensureGitRepo(cwd, options);

  const remotes = await runGit(["remote"], {
    cwd,
    ...options,
    allowFailure: true,
  });
  if (
    remotes.exitCode !== 0 ||
    remotes.stdout
      .split("\n")
      .map((remote) => remote.trim())
      .filter(Boolean).length === 0
  ) {
    return { status: "skipped" };
  }

  try {
    const result = await runGit(["fetch", "--all", "--prune", "--quiet"], {
      cwd,
      ...options,
      allowFailure: true,
    });
    return { status: result.exitCode === 0 ? "fetched" : "failed" };
  } catch (error) {
    if (
      error instanceof WorkspaceError &&
      error.code === "git_command_timeout"
    ) {
      return { status: "failed" };
    }
    throw error;
  }
}

export async function readMergeBaseRef(
  cwd: string,
  ref: string,
  options: GitTimeoutOptions = {},
): Promise<string | undefined> {
  await ensureGitRepo(cwd, options);
  const result = await runGit(["merge-base", ref, "HEAD"], {
    cwd,
    ...options,
    allowFailure: true,
  });
  if (result.exitCode !== 0) {
    return undefined;
  }

  const mergeBaseRef = trimOutput(result.stdout);
  return mergeBaseRef || undefined;
}

export async function revParse(
  cwd: string,
  ref: string,
  options: GitProcessOptions = {},
): Promise<string> {
  await ensureGitRepo(cwd, options);
  const result = await runGit(["rev-parse", ref], { cwd, ...options });
  return trimOutput(result.stdout);
}

interface ReadGitBlobResult {
  contents: Buffer | null;
  sizeBytes: number;
}

async function gitBlobSize(
  cwd: string,
  ref: string,
  relativePath: string,
  options: GitProcessOptions,
): Promise<number | undefined> {
  await ensureGitRepo(cwd, options);
  const target = `${ref}:${relativePath}`;
  const typeArgs = ["cat-file", "-t", target];
  const typeResult = await runGit(typeArgs, {
    cwd,
    ...options,
    allowFailure: true,
  });
  if (typeResult.exitCode !== 0) {
    const stderr = trimOutput(typeResult.stderr);
    if (isMissingGitBlobTargetError(stderr)) {
      return undefined;
    }
    throw createGitCommandFailedError(typeArgs, stderr);
  }

  const objectType = trimOutput(typeResult.stdout);
  if (objectType !== "blob") {
    throw new WorkspaceError(
      "git_command_failed",
      `git cat-file -t ${target} returned ${objectType || "unknown object type"}, expected blob`,
    );
  }

  const sizeArgs = ["cat-file", "-s", target];
  const sizeResult = await runGit(sizeArgs, {
    cwd,
    ...options,
    allowFailure: true,
  });
  if (sizeResult.exitCode !== 0) {
    const stderr = trimOutput(sizeResult.stderr);
    if (isMissingGitBlobTargetError(stderr)) {
      return undefined;
    }
    throw createGitCommandFailedError(sizeArgs, stderr);
  }

  const parsed = Number.parseInt(trimOutput(sizeResult.stdout), 10);
  if (!Number.isFinite(parsed) || parsed < 0) {
    throw new WorkspaceError(
      "git_command_failed",
      `git cat-file -s ${target} returned invalid size ${trimOutput(
        sizeResult.stdout,
      )}`,
    );
  }
  return parsed;
}

export async function readGitBlob(
  cwd: string,
  ref: string,
  relativePath: string,
  maxBytes: number,
  options: GitProcessOptions = {},
): Promise<ReadGitBlobResult> {
  const target = `${ref}:${relativePath}`;
  const size = await gitBlobSize(cwd, ref, relativePath, options);
  if (size === undefined) {
    return { contents: null, sizeBytes: 0 };
  }
  if (size > maxBytes) {
    throw new WorkspaceError(
      "blob_too_large",
      `Blob size ${size} bytes exceeds the ${Math.floor(maxBytes / (1024 * 1024))} MB limit`,
    );
  }

  try {
    const result = await execFileAsync("git", ["cat-file", "blob", target], {
      cwd,
      encoding: "buffer",
      env: resolveGitProcessEnv({
        env: undefined,
        shellPath: options.shellPath,
      }),
      maxBuffer: maxBytes,
    });
    const contents = Buffer.from(result.stdout);
    return { contents, sizeBytes: size };
  } catch (error) {
    if (isMaxBufferExceededError(error)) {
      throw new WorkspaceError(
        "blob_too_large",
        `Blob size exceeds the ${Math.floor(maxBytes / (1024 * 1024))} MB limit`,
        { cause: error },
      );
    }

    const execError = toExecError(error);
    const stderr = trimOutput(execError?.stderr?.toString() ?? "");
    throw createGitCommandFailedError(
      ["cat-file", "blob", target],
      stderr,
      error,
    );
  }
}

export async function listBranches(
  cwd: string,
  options: GitProcessOptions = {},
): Promise<string[]> {
  await ensureGitRepo(cwd, options);
  const result = await runGit(
    ["for-each-ref", "--format=%(refname:short)", "refs/heads"],
    { cwd, ...options },
  );
  return result.stdout
    .split("\n")
    .map((branch) => branch.trim())
    .filter(Boolean);
}

export async function listRemoteBranches(
  cwd: string,
  options: GitProcessOptions = {},
): Promise<string[]> {
  await ensureGitRepo(cwd, options);
  const result = await runGit(
    ["for-each-ref", "--format=%(refname:short)%09%(symref)", "refs/remotes"],
    { cwd, ...options },
  );
  return result.stdout
    .split("\n")
    .map((line) => {
      const [branch = "", symref = ""] = line.split("\t");
      return { branch: branch.trim(), symref: symref.trim() };
    })
    .filter((ref) => ref.branch.length > 0 && ref.symref.length === 0)
    .map((ref) => ref.branch);
}

export async function listBranchRefsWithDefaults(
  cwd: string,
  options: GitProcessOptions = {},
): Promise<BranchRefsWithDefaults> {
  const [branches, remoteBranches, originHeadBranch] = await Promise.all([
    listBranches(cwd, options),
    listRemoteBranches(cwd, options),
    readOriginHeadBranchName(cwd, options),
  ]);
  const defaultBranch = resolvePreferredLocalDefaultBranch(
    branches,
    originHeadBranch,
  );
  const originDefaultBranch = [
    originHeadBranch ? `origin/${originHeadBranch}` : undefined,
    defaultBranch ? `origin/${defaultBranch}` : undefined,
  ].find(
    (branch): branch is string =>
      branch !== undefined && remoteBranches.includes(branch),
  );

  return {
    branches,
    defaultBranch,
    originDefaultBranch,
    remoteBranches,
  };
}

export async function hasUncommittedChanges(
  cwd: string,
  options: GitProcessOptions = {},
): Promise<boolean> {
  await ensureGitRepo(cwd, options);
  const status = await runGit(
    [
      "--no-optional-locks",
      "status",
      "--porcelain=v1",
      "--untracked-files=all",
    ],
    { cwd, ...options },
  );
  return status.stdout.trim().length > 0;
}

export async function createTempDir(prefix: string): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), prefix));
}
