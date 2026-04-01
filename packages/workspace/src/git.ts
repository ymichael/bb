import { execFile, type ExecFileException } from "node:child_process";
import {
  existsSync,
  lstatSync,
  readFileSync,
  watch,
  type FSWatcher,
} from "node:fs";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const DEFAULT_BUFFER_BYTES = 16 * 1024 * 1024;
const WORKSPACE_STATUS_WATCH_DEBOUNCE_MS = 75;
const WORKSPACE_STATUS_WATCH_FALLBACK_POLL_INTERVAL_MS = 250;

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
}

export interface GitCommandResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

export type WorkspaceStatusChangeCallback = () => void;

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

interface ReadWorkspaceFileFingerprintEntryArgs {
  cwd: string;
  entry: PorcelainEntry;
}

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
    throw new WorkspaceError("git_command_failed", `git ${args.join(" ")} failed${detail}`, {
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

  throw new WorkspaceError("not_git_repo", `Path is not a git repository: ${cwd}`);
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

export function parsePorcelainEntries(statusOutput: string): PorcelainEntry[] {
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

async function resolveGitDirectory(cwd: string): Promise<string | undefined> {
  const dotGitPath = path.join(cwd, ".git");
  try {
    const dotGitStat = await fs.lstat(dotGitPath);
    if (dotGitStat.isDirectory()) {
      return dotGitPath;
    }
    if (!dotGitStat.isFile()) {
      return undefined;
    }
    const dotGitContents = await fs.readFile(dotGitPath, "utf8");
    const firstLine = dotGitContents.split("\n")[0]?.trim() ?? "";
    if (!firstLine.startsWith("gitdir:")) {
      return undefined;
    }
    const relativeGitDir = firstLine.slice("gitdir:".length).trim();
    if (relativeGitDir.length === 0) {
      return undefined;
    }
    return path.resolve(cwd, relativeGitDir);
  } catch {
    return undefined;
  }
}

function resolveGitDirectorySync(cwd: string): string | undefined {
  const dotGitPath = path.join(cwd, ".git");
  try {
    const dotGitStat = lstatSync(dotGitPath);
    if (dotGitStat.isDirectory()) {
      return dotGitPath;
    }
    if (!dotGitStat.isFile()) {
      return undefined;
    }
    const dotGitContents = readFileSync(dotGitPath, "utf8");
    const firstLine = dotGitContents.split("\n")[0]?.trim() ?? "";
    if (!firstLine.startsWith("gitdir:")) {
      return undefined;
    }
    const relativeGitDir = firstLine.slice("gitdir:".length).trim();
    if (relativeGitDir.length === 0) {
      return undefined;
    }
    return path.resolve(cwd, relativeGitDir);
  } catch {
    return undefined;
  }
}

function resolveGitMetadataWatchPathsSync(cwd: string): string[] {
  const dotGitPath = path.join(cwd, ".git");
  const gitDirPath = resolveGitDirectorySync(cwd);
  const metadataRoot = gitDirPath ?? dotGitPath;
  return [
    dotGitPath,
    metadataRoot,
    path.join(metadataRoot, "HEAD"),
    path.join(metadataRoot, "index"),
    path.join(metadataRoot, "packed-refs"),
    path.join(metadataRoot, "refs", "heads"),
    path.join(metadataRoot, "refs", "remotes", "origin"),
  ];
}

async function resolveGitMetadataFingerprintPaths(
  cwd: string,
): Promise<string[]> {
  const gitDirPath = await resolveGitDirectory(cwd);
  const metadataRoot = gitDirPath ?? path.join(cwd, ".git");
  return [
    // Exclude index/root mtimes here: running git status can refresh those
    // without any user-visible workspace change, which would cause false positives.
    path.join(metadataRoot, "HEAD"),
    path.join(metadataRoot, "packed-refs"),
    path.join(metadataRoot, "refs", "heads"),
    path.join(metadataRoot, "refs", "remotes", "origin"),
  ];
}

async function readMetadataFingerprintEntry(targetPath: string): Promise<string> {
  try {
    const stat = await fs.stat(targetPath);
    const statEntry = [
      targetPath,
      stat.isDirectory() ? "dir" : stat.isFile() ? "file" : "other",
      String(stat.size),
      String(stat.mtimeMs),
    ].join(":");
    if (path.basename(targetPath) === "HEAD" && stat.isFile()) {
      const headContents = await fs.readFile(targetPath, "utf8");
      return `${statEntry}:${headContents.trim()}`;
    }
    return statEntry;
  } catch {
    return `${targetPath}:missing`;
  }
}

async function readWorkspaceFileFingerprintEntry(
  args: ReadWorkspaceFileFingerprintEntryArgs,
): Promise<string> {
  try {
    const stat = await fs.lstat(path.join(args.cwd, args.entry.path));
    const fileKind = stat.isDirectory()
      ? "dir"
      : stat.isFile()
        ? "file"
        : stat.isSymbolicLink()
          ? "symlink"
          : "other";
    return [
      args.entry.path,
      fileKind,
      String(stat.size),
      String(stat.mtimeMs),
      String(stat.ctimeMs),
    ].join(":");
  } catch {
    return `${args.entry.path}:missing`;
  }
}

async function createWorkspaceStatusWatchFingerprint(cwd: string): Promise<string> {
  await ensureGitRepo(cwd);
  const [statusOutput, metadataPaths] = await Promise.all([
    runGit(
      ["status", "--porcelain=v1", "--branch", "--untracked-files=all"],
      { cwd },
    ),
    resolveGitMetadataFingerprintPaths(cwd),
  ]);
  const statusEntries = parsePorcelainEntries(statusOutput.stdout);
  const metadataEntries = await Promise.all(
    metadataPaths.map((metadataPath) => readMetadataFingerprintEntry(metadataPath)),
  );
  const dirtyFileEntries = await Promise.all(
    statusEntries.map((entry) => readWorkspaceFileFingerprintEntry({ cwd, entry })),
  );
  return JSON.stringify({
    dirtyFileEntries,
    metadataEntries,
    status: statusOutput.stdout,
  });
}

function shouldIgnoreWorkspaceWatchFilename(
  filename: string | Buffer | null | undefined,
): boolean {
  if (!filename) {
    return false;
  }
  const normalizedPath = path.normalize(filename.toString());
  return (
    normalizedPath === ".git" ||
    normalizedPath.startsWith(`.git${path.sep}`)
  );
}

export function watchWorkspaceStatus(
  cwd: string,
  onChange: WorkspaceStatusChangeCallback,
): () => void {
  let disposed = false;
  let debounceTimer: ReturnType<typeof setTimeout> | null = null;
  let fallbackPollTimer: ReturnType<typeof setInterval> | null = null;
  let lastFingerprint = "";
  let baselineLoaded = false;
  let checkInFlight = false;
  let recheckRequested = false;
  const watchers: FSWatcher[] = [];

  const runChecks = async () => {
    if (checkInFlight) {
      recheckRequested = true;
      return;
    }
    checkInFlight = true;
    try {
      do {
        recheckRequested = false;
        try {
          const nextFingerprint = await createWorkspaceStatusWatchFingerprint(cwd);
          if (disposed) {
            return;
          }
          if (!baselineLoaded) {
            lastFingerprint = nextFingerprint;
            baselineLoaded = true;
            continue;
          }
          if (nextFingerprint === lastFingerprint) {
            continue;
          }
          lastFingerprint = nextFingerprint;
          onChange();
        } catch {
          // Ignore watch checks for missing/non-git paths; query refetch remains the fallback.
        }
      } while (recheckRequested && !disposed);
    } finally {
      checkInFlight = false;
    }
  };

  const scheduleCheck = () => {
    if (disposed) {
      return;
    }
    if (debounceTimer !== null) {
      clearTimeout(debounceTimer);
    }
    debounceTimer = setTimeout(() => {
      debounceTimer = null;
      void runChecks();
    }, WORKSPACE_STATUS_WATCH_DEBOUNCE_MS);
  };

  const startFallbackPolling = () => {
    if (disposed || fallbackPollTimer !== null) {
      return;
    }
    fallbackPollTimer = setInterval(() => {
      if (disposed) {
        return;
      }
      void runChecks();
    }, WORKSPACE_STATUS_WATCH_FALLBACK_POLL_INTERVAL_MS);
  };

  void runChecks();
  try {
    const workspaceWatcher = watch(
      cwd,
      {
        persistent: false,
        recursive: true,
      },
      (_eventType, filename) => {
        if (shouldIgnoreWorkspaceWatchFilename(filename)) {
          return;
        }
        scheduleCheck();
      },
    );
    workspaceWatcher.on("error", () => {
      startFallbackPolling();
      scheduleCheck();
    });
    watchers.push(workspaceWatcher);
  } catch {
    startFallbackPolling();
  }
  try {
    const metadataPaths = resolveGitMetadataWatchPathsSync(cwd);
    for (const metadataPath of metadataPaths) {
      if (!existsSync(metadataPath)) {
        continue;
      }
      try {
        const watcher = watch(metadataPath, { persistent: false }, scheduleCheck);
        watcher.on("error", scheduleCheck);
        watchers.push(watcher);
      } catch {
        // Ignore unsupported watch targets; other targets and mutation-triggered hints remain.
      }
    }
  } catch {
    // Ignore initial watch setup failures; explicit command-triggered refresh remains.
  }

  return () => {
    disposed = true;
    if (debounceTimer !== null) {
      clearTimeout(debounceTimer);
      debounceTimer = null;
    }
    if (fallbackPollTimer !== null) {
      clearInterval(fallbackPollTimer);
      fallbackPollTimer = null;
    }
    for (const watcher of watchers) {
      try {
        watcher.close();
      } catch {
        // Ignore close failures during teardown.
      }
    }
  };
}
