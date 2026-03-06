import { spawn, spawnSync } from "node:child_process";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  rmSync,
  statSync,
  watch,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import type {
  ThreadGitDiffCommitSummary,
  ThreadWorkStatus,
} from "@beanbag/agent-core";
import type { IEnvironment } from "@beanbag/environment";

type CacheEntry = {
  checkedAt: number;
  fingerprint: string;
  defaultBranch?: string;
  mergeBaseBranch?: string;
  status: ThreadWorkStatus;
};

type WorkspaceWatchEntry = {
  signature: string;
  watchers: Array<ReturnType<typeof watch>>;
};

const CACHE_TTL_MS = 1_500;
const MAX_DIFF_RESPONSE_CHARS = 220_000;
const COMMIT_SUMMARY_FIELD_SEPARATOR = "\u001f";
const GIT_COMMAND_TIMEOUT_MS = 20_000;
let activeGitRunner: IEnvironment | undefined;

export interface GitCheckoutSnapshot {
  branch?: string;
  head: string;
  detached: boolean;
}

export interface GitDiffResult {
  diff: string;
  truncated: boolean;
}

export interface WorktreeCommitResult {
  ok: true;
  commitCreated: boolean;
  message: string;
  workStatus: ThreadWorkStatus;
  commitSha?: string;
}

function runGitAtPath(cwd: string, args: string[]): { ok: boolean; stdout: string; stderr: string; code: number | null } {
  if (activeGitRunner) {
    const result = activeGitRunner.run("git", args, { cwd });
    return {
      ok: result.exitCode === 0,
      stdout: result.stdout,
      stderr: result.stderr,
      code: result.exitCode,
    };
  }
  const result = spawnSync("git", args, {
    cwd,
    encoding: "utf-8",
    stdio: "pipe",
    timeout: GIT_COMMAND_TIMEOUT_MS,
  });
  const timeoutMessage = `git ${args.join(" ")} timed out after ${GIT_COMMAND_TIMEOUT_MS}ms`;
  const stderr =
    typeof result.error?.message === "string" && result.error.message.length > 0
      ? result.error.message
      : result.signal === "SIGTERM" || result.signal === "SIGKILL"
        ? timeoutMessage
        : result.stderr?.trimEnd() ?? "";
  return {
    ok: result.status === 0,
    stdout: result.stdout?.trimEnd() ?? "",
    stderr,
    code: result.status,
  };
}

function runGitRawAtPath(cwd: string, args: string[]): { ok: boolean; stdout: string; stderr: string; code: number | null } {
  if (activeGitRunner) {
    const result = activeGitRunner.run("git", args, {
      cwd,
      rawOutput: true,
    });
    return {
      ok: result.exitCode === 0,
      stdout: result.stdout,
      stderr: result.stderr,
      code: result.exitCode,
    };
  }
  const result = spawnSync("git", args, {
    cwd,
    encoding: "utf-8",
    stdio: "pipe",
    timeout: GIT_COMMAND_TIMEOUT_MS,
  });
  const timeoutMessage = `git ${args.join(" ")} timed out after ${GIT_COMMAND_TIMEOUT_MS}ms`;
  const stderr =
    typeof result.error?.message === "string" && result.error.message.length > 0
      ? result.error.message
      : result.signal === "SIGTERM" || result.signal === "SIGKILL"
        ? timeoutMessage
        : result.stderr?.trimEnd() ?? "";
  return {
    ok: result.status === 0,
    stdout: result.stdout ?? "",
    stderr,
    code: result.status,
  };
}

function withGitRunner<T>(environment: IEnvironment | undefined, fn: () => T): T {
  const previousRunner = activeGitRunner;
  activeGitRunner = environment;
  try {
    return fn();
  } finally {
    activeGitRunner = previousRunner;
  }
}

function runGitAtPathAsync(
  cwd: string,
  args: string[],
): Promise<{ ok: boolean; stdout: string; stderr: string; code: number | null }> {
  if (activeGitRunner) {
    const result = activeGitRunner.run("git", args, { cwd });
    return Promise.resolve({
      ok: result.exitCode === 0,
      stdout: result.stdout,
      stderr: result.stderr,
      code: result.exitCode,
    });
  }
  return new Promise((resolve) => {
    const child = spawn("git", args, {
      cwd,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    const timeout = setTimeout(() => {
      timedOut = true;
      child.kill("SIGKILL");
    }, GIT_COMMAND_TIMEOUT_MS);

    child.stdout.setEncoding("utf-8");
    child.stderr.setEncoding("utf-8");
    child.stdout.on("data", (chunk: string) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk: string) => {
      stderr += chunk;
    });

    child.on("error", (error) => {
      clearTimeout(timeout);
      resolve({
        ok: false,
        stdout: stdout.trimEnd(),
        stderr: error.message,
        code: null,
      });
    });
    child.on("close", (code) => {
      clearTimeout(timeout);
      resolve({
        ok: !timedOut && code === 0,
        stdout: stdout.trimEnd(),
        stderr: timedOut
          ? `git ${args.join(" ")} timed out after ${GIT_COMMAND_TIMEOUT_MS}ms`
          : stderr.trimEnd(),
        code,
      });
    });
  });
}

function runGitRawAtPathAsync(
  cwd: string,
  args: string[],
): Promise<{ ok: boolean; stdout: string; stderr: string; code: number | null }> {
  if (activeGitRunner) {
    const result = activeGitRunner.run("git", args, {
      cwd,
      rawOutput: true,
    });
    return Promise.resolve({
      ok: result.exitCode === 0,
      stdout: result.stdout,
      stderr: result.stderr,
      code: result.exitCode,
    });
  }
  return new Promise((resolve) => {
    const child = spawn("git", args, {
      cwd,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    const timeout = setTimeout(() => {
      timedOut = true;
      child.kill("SIGKILL");
    }, GIT_COMMAND_TIMEOUT_MS);

    child.stdout.setEncoding("utf-8");
    child.stderr.setEncoding("utf-8");
    child.stdout.on("data", (chunk: string) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk: string) => {
      stderr += chunk;
    });

    child.on("error", (error) => {
      clearTimeout(timeout);
      resolve({
        ok: false,
        stdout,
        stderr: error.message,
        code: null,
      });
    });
    child.on("close", (code) => {
      clearTimeout(timeout);
      resolve({
        ok: !timedOut && code === 0,
        stdout,
        stderr: timedOut
          ? `git ${args.join(" ")} timed out after ${GIT_COMMAND_TIMEOUT_MS}ms`
          : stderr.trimEnd(),
        code,
      });
    });
  });
}

function parseShortstat(value: string): { files: number; insertions: number; deletions: number } {
  if (!value) {
    return { files: 0, insertions: 0, deletions: 0 };
  }

  const filesMatch = value.match(/(\d+) files? changed/);
  const insertionsMatch = value.match(/(\d+) insertions?\(\+\)/);
  const deletionsMatch = value.match(/(\d+) deletions?\(-\)/);

  return {
    files: filesMatch ? Number.parseInt(filesMatch[1], 10) : 0,
    insertions: insertionsMatch ? Number.parseInt(insertionsMatch[1], 10) : 0,
    deletions: deletionsMatch ? Number.parseInt(deletionsMatch[1], 10) : 0,
  };
}

type DiffCounts = {
  changedFiles: number;
  insertions: number;
  deletions: number;
};

function countUntrackedFiles(statusLines: readonly string[]): number {
  return statusLines.reduce((count, line) => (
    line.startsWith("?? ") ? count + 1 : count
  ), 0);
}

function resolveMergeBaseDiffCounts(args: {
  workspaceRoot: string;
  mergeBaseDiffRef: string | undefined;
  statusLines: readonly string[];
  fallback: DiffCounts;
}): DiffCounts {
  if (!args.mergeBaseDiffRef) {
    return args.fallback;
  }

  const shortstatResult = runGitAtPath(args.workspaceRoot, [
    "diff",
    "--shortstat",
    args.mergeBaseDiffRef,
  ]);
  if (!shortstatResult.ok) {
    return args.fallback;
  }

  const parsed = parseShortstat(shortstatResult.stdout);
  const untrackedFiles = countUntrackedFiles(args.statusLines);
  return {
    changedFiles: parsed.files + untrackedFiles,
    insertions: parsed.insertions,
    deletions: parsed.deletions,
  };
}

async function resolveMergeBaseDiffCountsAsync(args: {
  workspaceRoot: string;
  mergeBaseDiffRef: string | undefined;
  statusLines: readonly string[];
  fallback: DiffCounts;
}): Promise<DiffCounts> {
  if (!args.mergeBaseDiffRef) {
    return args.fallback;
  }

  const shortstatResult = await runGitAtPathAsync(args.workspaceRoot, [
    "diff",
    "--shortstat",
    args.mergeBaseDiffRef,
  ]);
  if (!shortstatResult.ok) {
    return args.fallback;
  }

  const parsed = parseShortstat(shortstatResult.stdout);
  const untrackedFiles = countUntrackedFiles(args.statusLines);
  return {
    changedFiles: parsed.files + untrackedFiles,
    insertions: parsed.insertions,
    deletions: parsed.deletions,
  };
}

function resolveMergeBaseDiffRef(
  workspaceRoot: string,
  baseRef: string | undefined,
): string | undefined {
  if (!baseRef) {
    return undefined;
  }

  const mergeBaseResult = runGitAtPath(workspaceRoot, ["merge-base", baseRef, "HEAD"]);
  if (!mergeBaseResult.ok || !mergeBaseResult.stdout) {
    return undefined;
  }

  return mergeBaseResult.stdout;
}

async function resolveMergeBaseDiffRefAsync(
  workspaceRoot: string,
  baseRef: string | undefined,
): Promise<string | undefined> {
  if (!baseRef) {
    return undefined;
  }

  const mergeBaseResult = await runGitAtPathAsync(workspaceRoot, ["merge-base", baseRef, "HEAD"]);
  if (!mergeBaseResult.ok || !mergeBaseResult.stdout) {
    return undefined;
  }

  return mergeBaseResult.stdout;
}

function parseAheadBehind(value: string): { behind: number; ahead: number } {
  const [behindRaw, aheadRaw] = value.split("\t");
  const behind = Number.parseInt(behindRaw ?? "0", 10);
  const ahead = Number.parseInt(aheadRaw ?? "0", 10);
  return {
    behind: Number.isFinite(behind) ? behind : 0,
    ahead: Number.isFinite(ahead) ? ahead : 0,
  };
}

function countUnmergedAheadCommits(
  workspaceRoot: string,
  baseRef: string,
  aheadCount: number,
): number {
  if (aheadCount <= 0) {
    return 0;
  }

  const cherryResult = runGitAtPath(workspaceRoot, ["cherry", baseRef, "HEAD"]);
  if (!cherryResult.ok) {
    return aheadCount;
  }

  const lines = cherryResult.stdout
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0);

  if (lines.length === 0) {
    return 0;
  }

  let unmergedCount = 0;
  for (const line of lines) {
    if (line.startsWith("+")) {
      unmergedCount += 1;
      continue;
    }
    if (line.startsWith("-")) {
      continue;
    }

    // Unknown output format from git (open_external); fall back to graph-based ahead count.
    return aheadCount;
  }

  return unmergedCount;
}

async function countUnmergedAheadCommitsAsync(
  workspaceRoot: string,
  baseRef: string,
  aheadCount: number,
): Promise<number> {
  if (aheadCount <= 0) {
    return 0;
  }

  const cherryResult = await runGitAtPathAsync(workspaceRoot, ["cherry", baseRef, "HEAD"]);
  if (!cherryResult.ok) {
    return aheadCount;
  }

  const lines = cherryResult.stdout
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0);

  if (lines.length === 0) {
    return 0;
  }

  let unmergedCount = 0;
  for (const line of lines) {
    if (line.startsWith("+")) {
      unmergedCount += 1;
      continue;
    }
    if (line.startsWith("-")) {
      continue;
    }

    // Unknown output format from git (open_external); fall back to graph-based ahead count.
    return aheadCount;
  }

  return unmergedCount;
}

const COMMITTED_CONTENT_DIFF_CHUNK_SIZE = 120;

function hasCommittedContentDeltaByPaths(args: {
  workspaceRoot: string;
  baseRef: string;
  paths: readonly string[];
}): boolean | undefined {
  for (let index = 0; index < args.paths.length; index += COMMITTED_CONTENT_DIFF_CHUNK_SIZE) {
    const chunk = args.paths.slice(index, index + COMMITTED_CONTENT_DIFF_CHUNK_SIZE);
    const diffResult = runGitAtPath(args.workspaceRoot, [
      "diff",
      "--quiet",
      `${args.baseRef}..HEAD`,
      "--",
      ...chunk,
    ]);
    if (diffResult.code === 1) {
      return true;
    }
    if (diffResult.code !== 0) {
      return undefined;
    }
  }
  return false;
}

async function hasCommittedContentDeltaByPathsAsync(args: {
  workspaceRoot: string;
  baseRef: string;
  paths: readonly string[];
}): Promise<boolean | undefined> {
  for (let index = 0; index < args.paths.length; index += COMMITTED_CONTENT_DIFF_CHUNK_SIZE) {
    const chunk = args.paths.slice(index, index + COMMITTED_CONTENT_DIFF_CHUNK_SIZE);
    const diffResult = await runGitAtPathAsync(args.workspaceRoot, [
      "diff",
      "--quiet",
      `${args.baseRef}..HEAD`,
      "--",
      ...chunk,
    ]);
    if (diffResult.code === 1) {
      return true;
    }
    if (diffResult.code !== 0) {
      return undefined;
    }
  }
  return false;
}

function resolveCommittedUnmergedChanges(args: {
  workspaceRoot: string;
  baseRef: string | undefined;
  mergeBaseDiffRef: string | undefined;
  aheadCount: number;
}): boolean {
  if (!args.baseRef || !args.mergeBaseDiffRef) {
    return args.aheadCount > 0;
  }

  const changedPathsResult = runGitRawAtPath(args.workspaceRoot, [
    "diff",
    "--name-only",
    "--find-renames",
    "-z",
    `${args.mergeBaseDiffRef}..HEAD`,
  ]);
  if (!changedPathsResult.ok) {
    return args.aheadCount > 0;
  }

  const changedPaths = parseNulSeparatedList(changedPathsResult.stdout);
  if (changedPaths.length === 0) {
    return false;
  }

  const hasContentDelta = hasCommittedContentDeltaByPaths({
    workspaceRoot: args.workspaceRoot,
    baseRef: args.baseRef,
    paths: changedPaths,
  });
  if (hasContentDelta === undefined) {
    return args.aheadCount > 0;
  }
  return hasContentDelta;
}

async function resolveCommittedUnmergedChangesAsync(args: {
  workspaceRoot: string;
  baseRef: string | undefined;
  mergeBaseDiffRef: string | undefined;
  aheadCount: number;
}): Promise<boolean> {
  if (!args.baseRef || !args.mergeBaseDiffRef) {
    return args.aheadCount > 0;
  }

  const changedPathsResult = await runGitRawAtPathAsync(args.workspaceRoot, [
    "diff",
    "--name-only",
    "--find-renames",
    "-z",
    `${args.mergeBaseDiffRef}..HEAD`,
  ]);
  if (!changedPathsResult.ok) {
    return args.aheadCount > 0;
  }

  const changedPaths = parseNulSeparatedList(changedPathsResult.stdout);
  if (changedPaths.length === 0) {
    return false;
  }

  const hasContentDelta = await hasCommittedContentDeltaByPathsAsync({
    workspaceRoot: args.workspaceRoot,
    baseRef: args.baseRef,
    paths: changedPaths,
  });
  if (hasContentDelta === undefined) {
    return args.aheadCount > 0;
  }
  return hasContentDelta;
}

function parsePorcelainLine(line: string): { status: string; path: string } | undefined {
  if (line.length < 3) return undefined;
  const rawStatus = line.slice(0, 2);
  const indexStatus = rawStatus[0] ?? " ";
  const worktreeStatus = rawStatus[1] ?? " ";
  const status = (() => {
    if (indexStatus === "?" && worktreeStatus === "?") {
      return "A?";
    }
    if (indexStatus === " " && worktreeStatus !== " ") {
      return `${worktreeStatus}?`;
    }
    if (indexStatus !== " " && worktreeStatus === " ") {
      return indexStatus;
    }
    // Git porcelain status codes are open_external; preserve unknown combinations intentionally.
    return `${indexStatus}${worktreeStatus}`;
  })();
  const rawPath = line.slice(2).trimStart();
  if (rawPath.length === 0) return undefined;
  const path = rawPath.includes(" -> ")
    ? rawPath.slice(rawPath.lastIndexOf(" -> ") + 4)
    : rawPath;
  return { status, path };
}

function parseNameStatusLine(line: string): { status: string; path: string } | undefined {
  const segments = line.split("\t");
  if (segments.length < 2) return undefined;
  const rawStatus = segments[0]?.trim() ?? "";
  if (!rawStatus) return undefined;
  const isRenameOrCopy = rawStatus.startsWith("R") || rawStatus.startsWith("C");
  const path = (isRenameOrCopy ? segments[2] : segments[1])?.trim();
  if (!path) return undefined;
  // Git name-status values are open_external; preserve unknown status values intentionally.
  return { status: rawStatus, path };
}

function resolveMergeBaseFileChanges(args: {
  workspaceRoot: string;
  mergeBaseDiffRef: string | undefined;
  workspaceFiles: ReadonlyArray<{ status: string; path: string }>;
}): Array<{ status: string; path: string }> {
  const fallback = args.workspaceFiles.slice(0, 60);
  if (!args.mergeBaseDiffRef) {
    return fallback;
  }

  const diffResult = runGitAtPath(args.workspaceRoot, [
    "diff",
    "--name-status",
    "--find-renames",
    args.mergeBaseDiffRef,
  ]);
  if (!diffResult.ok) {
    return fallback;
  }

  const workspaceStatusByPath = new Map(
    args.workspaceFiles.map((item) => [item.path, item.status]),
  );
  const mergeBaseFiles = diffResult.stdout
    .split("\n")
    .map((line) => parseNameStatusLine(line.trimEnd()))
    .filter((item): item is { status: string; path: string } => Boolean(item))
    .map((item) => ({
      ...item,
      status: workspaceStatusByPath.get(item.path) ?? item.status,
    }));

  const knownPaths = new Set(mergeBaseFiles.map((item) => item.path));
  for (const workspaceFile of args.workspaceFiles) {
    if (knownPaths.has(workspaceFile.path)) {
      continue;
    }
    mergeBaseFiles.push(workspaceFile);
    knownPaths.add(workspaceFile.path);
  }

  return mergeBaseFiles.slice(0, 60);
}

async function resolveMergeBaseFileChangesAsync(args: {
  workspaceRoot: string;
  mergeBaseDiffRef: string | undefined;
  workspaceFiles: ReadonlyArray<{ status: string; path: string }>;
}): Promise<Array<{ status: string; path: string }>> {
  const fallback = args.workspaceFiles.slice(0, 60);
  if (!args.mergeBaseDiffRef) {
    return fallback;
  }

  const diffResult = await runGitAtPathAsync(args.workspaceRoot, [
    "diff",
    "--name-status",
    "--find-renames",
    args.mergeBaseDiffRef,
  ]);
  if (!diffResult.ok) {
    return fallback;
  }

  const workspaceStatusByPath = new Map(
    args.workspaceFiles.map((item) => [item.path, item.status]),
  );
  const mergeBaseFiles = diffResult.stdout
    .split("\n")
    .map((line) => parseNameStatusLine(line.trimEnd()))
    .filter((item): item is { status: string; path: string } => Boolean(item))
    .map((item) => ({
      ...item,
      status: workspaceStatusByPath.get(item.path) ?? item.status,
    }));

  const knownPaths = new Set(mergeBaseFiles.map((item) => item.path));
  for (const workspaceFile of args.workspaceFiles) {
    if (knownPaths.has(workspaceFile.path)) {
      continue;
    }
    mergeBaseFiles.push(workspaceFile);
    knownPaths.add(workspaceFile.path);
  }

  return mergeBaseFiles.slice(0, 60);
}

function safeMtime(path: string): number {
  try {
    return statSync(path).mtimeMs;
  } catch {
    return 0;
  }
}

function resolveGitDirectory(workspaceRoot: string): string | undefined {
  const dotGitPath = join(workspaceRoot, ".git");
  try {
    const dotGitStat = lstatSync(dotGitPath);
    if (dotGitStat.isDirectory()) {
      return dotGitPath;
    }
    if (!dotGitStat.isFile()) {
      return undefined;
    }

    const gitFileContents = readFileSync(dotGitPath, "utf-8");
    const firstLine = gitFileContents.split("\n")[0]?.trim() ?? "";
    if (!firstLine.toLowerCase().startsWith("gitdir:")) {
      return undefined;
    }
    const relativeGitDir = firstLine.slice("gitdir:".length).trim();
    if (relativeGitDir.length === 0) {
      return undefined;
    }
    return resolve(workspaceRoot, relativeGitDir);
  } catch {
    return undefined;
  }
}

function resolveGitMetadataPaths(workspaceRoot: string): {
  dotGitPath: string;
  gitDirPath: string | undefined;
  headPath: string;
  indexPath: string;
  packedRefsPath: string;
  refsHeadsPath: string;
  refsRemotesOriginPath: string;
} {
  const dotGitPath = join(workspaceRoot, ".git");
  const gitDirPath = resolveGitDirectory(workspaceRoot);
  const metadataRoot = gitDirPath ?? dotGitPath;
  return {
    dotGitPath,
    gitDirPath,
    headPath: join(metadataRoot, "HEAD"),
    indexPath: join(metadataRoot, "index"),
    packedRefsPath: join(metadataRoot, "packed-refs"),
    refsHeadsPath: join(metadataRoot, "refs", "heads"),
    refsRemotesOriginPath: join(metadataRoot, "refs", "remotes", "origin"),
  };
}

function createFingerprint(workspaceRoot: string): string {
  const metadata = resolveGitMetadataPaths(workspaceRoot);
  return [
    safeMtime(metadata.dotGitPath),
    metadata.gitDirPath ? safeMtime(metadata.gitDirPath) : 0,
    safeMtime(metadata.headPath),
    safeMtime(metadata.indexPath),
    safeMtime(metadata.packedRefsPath),
    safeMtime(metadata.refsHeadsPath),
    safeMtime(metadata.refsRemotesOriginPath),
  ].join(":");
}

function toState(args: {
  hasUncommittedChanges: boolean;
  hasCommittedUnmergedChanges: boolean;
}): ThreadWorkStatus["state"] {
  if (args.hasUncommittedChanges && args.hasCommittedUnmergedChanges) {
    return "dirty_and_committed_unmerged";
  }
  if (args.hasUncommittedChanges) {
    return "dirty_uncommitted";
  }
  if (args.hasCommittedUnmergedChanges) {
    return "committed_unmerged";
  }
  return "clean";
}

function resolveDefaultBranch(projectRoot: string): string | undefined {
  const remoteHead = runGitAtPath(projectRoot, ["symbolic-ref", "--quiet", "refs/remotes/origin/HEAD"]);
  if (remoteHead.ok && remoteHead.stdout.startsWith("refs/remotes/origin/")) {
    return remoteHead.stdout.slice("refs/remotes/origin/".length);
  }

  const hasMain = runGitAtPath(projectRoot, ["show-ref", "--verify", "--quiet", "refs/heads/main"]);
  if (hasMain.ok) return "main";

  const hasMaster = runGitAtPath(projectRoot, ["show-ref", "--verify", "--quiet", "refs/heads/master"]);
  if (hasMaster.ok) return "master";

  return undefined;
}

async function resolveDefaultBranchAsync(
  projectRoot: string,
): Promise<string | undefined> {
  const remoteHead = await runGitAtPathAsync(projectRoot, [
    "symbolic-ref",
    "--quiet",
    "refs/remotes/origin/HEAD",
  ]);
  if (remoteHead.ok && remoteHead.stdout.startsWith("refs/remotes/origin/")) {
    return remoteHead.stdout.slice("refs/remotes/origin/".length);
  }

  const hasMain = await runGitAtPathAsync(projectRoot, [
    "show-ref",
    "--verify",
    "--quiet",
    "refs/heads/main",
  ]);
  if (hasMain.ok) return "main";

  const hasMaster = await runGitAtPathAsync(projectRoot, [
    "show-ref",
    "--verify",
    "--quiet",
    "refs/heads/master",
  ]);
  if (hasMaster.ok) return "master";

  return undefined;
}

function resolveBaseRef(workspaceRoot: string, branch: string | undefined): string | undefined {
  if (!branch) return undefined;

  const localRef = `refs/heads/${branch}`;
  if (runGitAtPath(workspaceRoot, ["show-ref", "--verify", "--quiet", localRef]).ok) {
    return branch;
  }

  const remoteRef = `refs/remotes/origin/${branch}`;
  if (runGitAtPath(workspaceRoot, ["show-ref", "--verify", "--quiet", remoteRef]).ok) {
    return `origin/${branch}`;
  }

  return undefined;
}

async function resolveBaseRefAsync(
  workspaceRoot: string,
  branch: string | undefined,
): Promise<string | undefined> {
  if (!branch) return undefined;

  const localRef = `refs/heads/${branch}`;
  if (
    (
      await runGitAtPathAsync(workspaceRoot, [
        "show-ref",
        "--verify",
        "--quiet",
        localRef,
      ])
    ).ok
  ) {
    return branch;
  }

  const remoteRef = `refs/remotes/origin/${branch}`;
  if (
    (
      await runGitAtPathAsync(workspaceRoot, [
        "show-ref",
        "--verify",
        "--quiet",
        remoteRef,
      ])
    ).ok
  ) {
    return `origin/${branch}`;
  }

  return undefined;
}

function listMergeBaseBranches(projectRoot: string, defaultBranch: string | undefined): string[] {
  const localBranches = runGitAtPath(projectRoot, [
    "for-each-ref",
    "--format=%(refname:short)",
    "refs/heads",
  ]);
  if (!localBranches.ok) {
    return defaultBranch ? [defaultBranch] : [];
  }

  const branches = Array.from(
    new Set(
      localBranches.stdout
        .split("\n")
        .map((line) => line.trim())
        .filter((line) => line.length > 0),
    ),
  ).sort((a, b) => a.localeCompare(b));

  if (!defaultBranch) {
    return branches;
  }

  if (!branches.includes(defaultBranch)) {
    return [defaultBranch, ...branches];
  }

  return [defaultBranch, ...branches.filter((branch) => branch !== defaultBranch)];
}

async function listMergeBaseBranchesAsync(
  projectRoot: string,
  defaultBranch: string | undefined,
): Promise<string[]> {
  const localBranches = await runGitAtPathAsync(projectRoot, [
    "for-each-ref",
    "--format=%(refname:short)",
    "refs/heads",
  ]);
  if (!localBranches.ok) {
    return defaultBranch ? [defaultBranch] : [];
  }

  const branches = Array.from(
    new Set(
      localBranches.stdout
        .split("\n")
        .map((line) => line.trim())
        .filter((line) => line.length > 0),
    ),
  ).sort((a, b) => a.localeCompare(b));

  if (!defaultBranch) {
    return branches;
  }

  if (!branches.includes(defaultBranch)) {
    return [defaultBranch, ...branches];
  }

  return [defaultBranch, ...branches.filter((branch) => branch !== defaultBranch)];
}

function resolveMergeBaseSelection(args: {
  workspaceRoot: string;
  defaultBranch: string | undefined;
  requestedMergeBaseBranch: string | undefined;
}): { mergeBaseBranch?: string; baseRef?: string } {
  const candidates = [
    args.requestedMergeBaseBranch,
    args.defaultBranch,
  ];
  const seen = new Set<string>();

  for (const candidate of candidates) {
    if (!candidate || seen.has(candidate)) {
      continue;
    }
    seen.add(candidate);
    const baseRef = resolveBaseRef(args.workspaceRoot, candidate);
    if (baseRef) {
      return { mergeBaseBranch: candidate, baseRef };
    }
  }

  return {};
}

async function resolveMergeBaseSelectionAsync(args: {
  workspaceRoot: string;
  defaultBranch: string | undefined;
  requestedMergeBaseBranch: string | undefined;
}): Promise<{ mergeBaseBranch?: string; baseRef?: string }> {
  const candidates = [
    args.requestedMergeBaseBranch,
    args.defaultBranch,
  ];
  const seen = new Set<string>();

  for (const candidate of candidates) {
    if (!candidate || seen.has(candidate)) {
      continue;
    }
    seen.add(candidate);
    const baseRef = await resolveBaseRefAsync(args.workspaceRoot, candidate);
    if (baseRef) {
      return { mergeBaseBranch: candidate, baseRef };
    }
  }

  return {};
}

function hasLocalWorkingChanges(repoRoot: string): boolean {
  const status = runGitAtPath(repoRoot, ["status", "--porcelain"]);
  if (!status.ok) {
    return false;
  }
  return status.stdout.trim().length > 0;
}

function hasLocalBranch(repoRoot: string, branch: string): boolean {
  return runGitAtPath(
    repoRoot,
    ["show-ref", "--verify", "--quiet", `refs/heads/${branch}`],
  ).ok;
}

function resolveCheckoutSnapshot(repoRoot: string): GitCheckoutSnapshot {
  const headResult = runGitAtPath(repoRoot, ["rev-parse", "HEAD"]);
  if (!headResult.ok || !headResult.stdout) {
    throw new Error("Failed to resolve HEAD");
  }

  const branchResult = runGitAtPath(repoRoot, ["symbolic-ref", "--quiet", "--short", "HEAD"]);
  if (branchResult.ok && branchResult.stdout) {
    return {
      branch: branchResult.stdout,
      head: headResult.stdout,
      detached: false,
    };
  }

  return {
    head: headResult.stdout,
    detached: true,
  };
}

function checkoutSnapshot(repoRoot: string, snapshot: GitCheckoutSnapshot): void {
  const branch = snapshot.branch?.trim();
  if (branch && hasLocalBranch(repoRoot, branch)) {
    const branchCheckout = runGitAtPath(
      repoRoot,
      ["checkout", "--ignore-other-worktrees", branch],
    );
    if (branchCheckout.ok) return;
  }

  const detachedCheckout = runGitAtPath(repoRoot, ["checkout", "--detach", snapshot.head]);
  if (!detachedCheckout.ok) {
    throw new Error(detachedCheckout.stderr || "Failed to checkout detached HEAD");
  }
}

function parseNulSeparatedList(value: string): string[] {
  return value
    .split("\u0000")
    .filter((entry) => entry.length > 0);
}

function trimDiffForResponse(diff: string): GitDiffResult {
  if (diff.length <= MAX_DIFF_RESPONSE_CHARS) {
    return { diff, truncated: false };
  }
  return {
    diff: `${diff.slice(0, MAX_DIFF_RESPONSE_CHARS)}\n\n... diff truncated ...\n`,
    truncated: true,
  };
}

function parseCommitSummaries(raw: string): ThreadGitDiffCommitSummary[] {
  if (!raw) return [];
  return raw
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .map((line) => {
      const [sha, shortSha, authoredAtRaw, authorName, ...subjectParts] =
        line.split(COMMIT_SUMMARY_FIELD_SEPARATOR);
      if (!sha || !shortSha) return null;
      const subject = subjectParts.join(COMMIT_SUMMARY_FIELD_SEPARATOR).trim();
      const authoredAt = Number.parseInt(authoredAtRaw ?? "", 10);
      return {
        sha,
        shortSha,
        subject: subject.length > 0 ? subject : "(no subject)",
        ...(authorName ? { authorName } : {}),
        ...(Number.isFinite(authoredAt) ? { authoredAt } : {}),
      } satisfies ThreadGitDiffCommitSummary;
    })
    .filter((entry): entry is ThreadGitDiffCommitSummary => entry !== null);
}

function cleanStatus(workspaceRoot: string): ThreadWorkStatus {
  return {
    state: "clean",
    changedFiles: 0,
    insertions: 0,
    deletions: 0,
    workspaceChangedFiles: 0,
    workspaceInsertions: 0,
    workspaceDeletions: 0,
    hasUncommittedChanges: false,
    hasCommittedUnmergedChanges: false,
    aheadCount: 0,
    behindCount: 0,
    workspaceRoot,
  };
}

function untrackedStatus(workspaceRoot: string): ThreadWorkStatus {
  return {
    ...cleanStatus(workspaceRoot),
    state: "untracked",
  };
}

function deletedStatus(workspaceRoot: string): ThreadWorkStatus {
  return {
    ...cleanStatus(workspaceRoot),
    state: "deleted",
  };
}

export class ThreadGitStatusService {
  private cache = new Map<string, CacheEntry>();
  private defaultBranchCache = new Map<string, string | undefined>();
  private workspaceWatchers = new Map<string, WorkspaceWatchEntry>();

  invalidate(workspaceRoot: string): void {
    this.cache.delete(workspaceRoot);
  }

  private _stopWatchingWorkspace(workspaceRoot: string): void {
    const watchEntry = this.workspaceWatchers.get(workspaceRoot);
    if (!watchEntry) {
      return;
    }
    this.workspaceWatchers.delete(workspaceRoot);
    for (const watcher of watchEntry.watchers) {
      try {
        watcher.close();
      } catch {
        // Ignore watcher close failures; cache invalidation already happened.
      }
    }
  }

  private _ensureWorkspaceWatcher(workspaceRoot: string): void {
    const metadataPaths = resolveGitMetadataPaths(workspaceRoot);
    const watchTargets = Array.from(new Set([
      metadataPaths.dotGitPath,
      metadataPaths.headPath,
      metadataPaths.indexPath,
      metadataPaths.packedRefsPath,
      metadataPaths.refsHeadsPath,
      metadataPaths.refsRemotesOriginPath,
    ]));
    const signature = watchTargets.join("|");
    const existing = this.workspaceWatchers.get(workspaceRoot);
    if (existing?.signature === signature) {
      return;
    }

    this._stopWatchingWorkspace(workspaceRoot);
    const watchers: Array<ReturnType<typeof watch>> = [];
    for (const target of watchTargets) {
      if (!existsSync(target)) {
        continue;
      }
      try {
        const watcher = watch(target, { persistent: false }, () => {
          this.invalidate(workspaceRoot);
        });
        watcher.on("error", () => {
          this._stopWatchingWorkspace(workspaceRoot);
          this.invalidate(workspaceRoot);
        });
        watchers.push(watcher);
      } catch {
        // File watching can fail on some filesystems. TTL/fingerprint checks remain as fallback.
      }
    }

    if (watchers.length === 0) {
      return;
    }
    this.workspaceWatchers.set(workspaceRoot, {
      signature,
      watchers,
    });
  }

  detectDefaultBranch(projectRoot: string): string | undefined {
    if (this.defaultBranchCache.has(projectRoot)) {
      return this.defaultBranchCache.get(projectRoot);
    }

    const branch = resolveDefaultBranch(projectRoot);
    this.defaultBranchCache.set(projectRoot, branch);
    return branch;
  }

  async detectDefaultBranchAsync(projectRoot: string): Promise<string | undefined> {
    if (this.defaultBranchCache.has(projectRoot)) {
      return this.defaultBranchCache.get(projectRoot);
    }

    const branch = await resolveDefaultBranchAsync(projectRoot);
    this.defaultBranchCache.set(projectRoot, branch);
    return branch;
  }

  isCleanWorkspace(repoRoot: string): boolean {
    return !hasLocalWorkingChanges(repoRoot);
  }

  resolveCheckoutSnapshot(repoRoot: string): GitCheckoutSnapshot {
    return resolveCheckoutSnapshot(repoRoot);
  }

  checkoutSnapshot(repoRoot: string, snapshot: GitCheckoutSnapshot): void {
    checkoutSnapshot(repoRoot, snapshot);
  }

  resolveDefaultBranchCheckout(projectRoot: string): GitCheckoutSnapshot | undefined {
    const defaultBranch = this.detectDefaultBranch(projectRoot);
    if (!defaultBranch) return undefined;
    if (!hasLocalBranch(projectRoot, defaultBranch)) return undefined;
    const headResult = runGitAtPath(projectRoot, ["rev-parse", defaultBranch]);
    if (!headResult.ok || !headResult.stdout) return undefined;
    return {
      branch: defaultBranch,
      head: headResult.stdout,
      detached: false,
    };
  }

  discardLocalChanges(repoRoot: string): void {
    const reset = runGitAtPath(repoRoot, ["reset", "--hard"]);
    if (!reset.ok) {
      throw new Error(reset.stderr || "Failed to reset primary checkout");
    }
    const clean = runGitAtPath(repoRoot, ["clean", "-fd"]);
    if (!clean.ok) {
      throw new Error(clean.stderr || "Failed to clean primary checkout");
    }
  }

  removeWorktreeWorkspace(args: { projectRoot: string; workspaceRoot: string }): void {
    runGitAtPath(args.projectRoot, ["worktree", "remove", "--force", args.workspaceRoot]);
    rmSync(args.workspaceRoot, { recursive: true, force: true });
    this.invalidate(args.workspaceRoot);
  }

  getStatus(args: {
    workspaceRoot: string;
    projectRoot: string;
    defaultBranch?: string;
    mergeBaseBranch?: string;
    environment?: IEnvironment;
  }): ThreadWorkStatus {
    return withGitRunner(args.environment, () => {
      if (!existsSync(args.workspaceRoot)) {
        this._stopWatchingWorkspace(args.workspaceRoot);
        return deletedStatus(args.workspaceRoot);
      }

      const isGitRepo = runGitAtPath(args.workspaceRoot, ["rev-parse", "--is-inside-work-tree"]);
      if (!isGitRepo.ok || isGitRepo.stdout !== "true") {
        this._stopWatchingWorkspace(args.workspaceRoot);
        return untrackedStatus(args.workspaceRoot);
      }
      this._ensureWorkspaceWatcher(args.workspaceRoot);

      const requestedMergeBaseBranch = args.mergeBaseBranch?.trim() || undefined;
      const defaultBranch = args.defaultBranch ?? this.detectDefaultBranch(args.projectRoot);
      const fingerprint = createFingerprint(args.workspaceRoot);
      const cached = this.cache.get(args.workspaceRoot);
      const now = Date.now();
      if (
        cached &&
        cached.fingerprint === fingerprint &&
        cached.defaultBranch === defaultBranch &&
        cached.mergeBaseBranch === requestedMergeBaseBranch &&
        now - cached.checkedAt < CACHE_TTL_MS
      ) {
        return cached.status;
      }

      const statusResult = runGitAtPath(args.workspaceRoot, [
        "status",
        "--porcelain",
        "--untracked-files=all",
      ]);
      const statusLines = statusResult.ok
        ? statusResult.stdout.split("\n").map((line) => line.trimEnd()).filter((line) => line.length > 0)
        : [];
      const workspaceFiles = statusLines
        .map((line) => parsePorcelainLine(line))
        .filter((item): item is { status: string; path: string } => Boolean(item))
        .slice(0, 60);
      const workspaceChangedFiles = statusLines.length;

      const unstagedStat = parseShortstat(runGitAtPath(args.workspaceRoot, ["diff", "--shortstat"]).stdout);
      const stagedStat = parseShortstat(runGitAtPath(args.workspaceRoot, ["diff", "--cached", "--shortstat"]).stdout);

      const workspaceInsertions = unstagedStat.insertions + stagedStat.insertions;
      const workspaceDeletions = unstagedStat.deletions + stagedStat.deletions;

      const currentBranch = runGitAtPath(args.workspaceRoot, ["symbolic-ref", "--short", "HEAD"]);
      const mergeBaseBranches = listMergeBaseBranches(args.projectRoot, defaultBranch);
      const mergeBaseSelection = resolveMergeBaseSelection({
        workspaceRoot: args.workspaceRoot,
        defaultBranch,
        requestedMergeBaseBranch,
      });
      const mergeBaseBranch = mergeBaseSelection.mergeBaseBranch;
      const baseRef = mergeBaseSelection.baseRef;
      const mergeBaseDiffRef = resolveMergeBaseDiffRef(args.workspaceRoot, baseRef);
      const mergeBaseBranchOptions =
        mergeBaseBranch && !mergeBaseBranches.includes(mergeBaseBranch)
          ? [mergeBaseBranch, ...mergeBaseBranches]
          : mergeBaseBranches;
      const mergeBaseDiff = resolveMergeBaseDiffCounts({
        workspaceRoot: args.workspaceRoot,
        mergeBaseDiffRef,
        statusLines,
        fallback: {
          changedFiles: workspaceChangedFiles,
          insertions: workspaceInsertions,
          deletions: workspaceDeletions,
        },
      });
      const files = resolveMergeBaseFileChanges({
        workspaceRoot: args.workspaceRoot,
        mergeBaseDiffRef,
        workspaceFiles,
      });

      let aheadCount = 0;
      let behindCount = 0;
      if (baseRef) {
        const aheadBehind = runGitAtPath(args.workspaceRoot, ["rev-list", "--left-right", "--count", `${baseRef}...HEAD`]);
        if (aheadBehind.ok) {
          const parsed = parseAheadBehind(aheadBehind.stdout);
          aheadCount = countUnmergedAheadCommits(args.workspaceRoot, baseRef, parsed.ahead);
          behindCount = parsed.behind;
        }
      }

      const hasUncommittedChanges = workspaceChangedFiles > 0;
      const hasCommittedUnmergedChanges = resolveCommittedUnmergedChanges({
        workspaceRoot: args.workspaceRoot,
        baseRef,
        mergeBaseDiffRef,
        aheadCount,
      });
      const status: ThreadWorkStatus = {
        state: toState({ hasUncommittedChanges, hasCommittedUnmergedChanges }),
        changedFiles: mergeBaseDiff.changedFiles,
        insertions: mergeBaseDiff.insertions,
        deletions: mergeBaseDiff.deletions,
        workspaceChangedFiles,
        workspaceInsertions,
        workspaceDeletions,
        hasUncommittedChanges,
        hasCommittedUnmergedChanges,
        aheadCount,
        behindCount,
        ...(currentBranch.ok && currentBranch.stdout ? { currentBranch: currentBranch.stdout } : {}),
        ...(defaultBranch ? { defaultBranch } : {}),
        ...(mergeBaseBranch ? { mergeBaseBranch } : {}),
        ...(mergeBaseBranchOptions.length > 0 ? { mergeBaseBranches: mergeBaseBranchOptions } : {}),
        ...(baseRef ? { baseRef } : {}),
        ...(files.length > 0 ? { files } : {}),
        workspaceRoot: args.workspaceRoot,
      };

      this.cache.set(args.workspaceRoot, {
        checkedAt: now,
        fingerprint,
        defaultBranch,
        mergeBaseBranch: requestedMergeBaseBranch,
        status,
      });

      return status;
    });
  }

  async getStatusAsync(args: {
    workspaceRoot: string;
    projectRoot: string;
    defaultBranch?: string;
    mergeBaseBranch?: string;
    environment?: IEnvironment;
  }): Promise<ThreadWorkStatus> {
    return withGitRunner(args.environment, async () => {
      if (!existsSync(args.workspaceRoot)) {
        this._stopWatchingWorkspace(args.workspaceRoot);
        return deletedStatus(args.workspaceRoot);
      }

      const isGitRepo = await runGitAtPathAsync(args.workspaceRoot, ["rev-parse", "--is-inside-work-tree"]);
      if (!isGitRepo.ok || isGitRepo.stdout !== "true") {
        this._stopWatchingWorkspace(args.workspaceRoot);
        return untrackedStatus(args.workspaceRoot);
      }
      this._ensureWorkspaceWatcher(args.workspaceRoot);

      const requestedMergeBaseBranch = args.mergeBaseBranch?.trim() || undefined;
      const defaultBranch = args.defaultBranch ?? await this.detectDefaultBranchAsync(args.projectRoot);
      const fingerprint = createFingerprint(args.workspaceRoot);
      const cached = this.cache.get(args.workspaceRoot);
      const now = Date.now();
      if (
        cached &&
        cached.fingerprint === fingerprint &&
        cached.defaultBranch === defaultBranch &&
        cached.mergeBaseBranch === requestedMergeBaseBranch &&
        now - cached.checkedAt < CACHE_TTL_MS
      ) {
        return cached.status;
      }

      const statusResult = await runGitAtPathAsync(args.workspaceRoot, [
        "status",
        "--porcelain",
        "--untracked-files=all",
      ]);
      const statusLines = statusResult.ok
        ? statusResult.stdout.split("\n").map((line) => line.trimEnd()).filter((line) => line.length > 0)
        : [];
      const workspaceFiles = statusLines
        .map((line) => parsePorcelainLine(line))
        .filter((item): item is { status: string; path: string } => Boolean(item))
        .slice(0, 60);
      const workspaceChangedFiles = statusLines.length;

      const unstagedShortstat = await runGitAtPathAsync(args.workspaceRoot, ["diff", "--shortstat"]);
      const stagedShortstat = await runGitAtPathAsync(args.workspaceRoot, ["diff", "--cached", "--shortstat"]);
      const unstagedStat = parseShortstat(unstagedShortstat.stdout);
      const stagedStat = parseShortstat(stagedShortstat.stdout);
      const workspaceInsertions = unstagedStat.insertions + stagedStat.insertions;
      const workspaceDeletions = unstagedStat.deletions + stagedStat.deletions;

      const currentBranch = await runGitAtPathAsync(args.workspaceRoot, ["symbolic-ref", "--short", "HEAD"]);
      const mergeBaseBranches = await listMergeBaseBranchesAsync(args.projectRoot, defaultBranch);
      const mergeBaseSelection = await resolveMergeBaseSelectionAsync({
        workspaceRoot: args.workspaceRoot,
        defaultBranch,
        requestedMergeBaseBranch,
      });
      const mergeBaseBranch = mergeBaseSelection.mergeBaseBranch;
      const baseRef = mergeBaseSelection.baseRef;
      const mergeBaseDiffRef = await resolveMergeBaseDiffRefAsync(args.workspaceRoot, baseRef);
      const mergeBaseBranchOptions =
        mergeBaseBranch && !mergeBaseBranches.includes(mergeBaseBranch)
          ? [mergeBaseBranch, ...mergeBaseBranches]
          : mergeBaseBranches;
      const mergeBaseDiff = await resolveMergeBaseDiffCountsAsync({
        workspaceRoot: args.workspaceRoot,
        mergeBaseDiffRef,
        statusLines,
        fallback: {
          changedFiles: workspaceChangedFiles,
          insertions: workspaceInsertions,
          deletions: workspaceDeletions,
        },
      });
      const files = await resolveMergeBaseFileChangesAsync({
        workspaceRoot: args.workspaceRoot,
        mergeBaseDiffRef,
        workspaceFiles,
      });

      let aheadCount = 0;
      let behindCount = 0;
      if (baseRef) {
        const aheadBehind = await runGitAtPathAsync(
          args.workspaceRoot,
          ["rev-list", "--left-right", "--count", `${baseRef}...HEAD`],
        );
        if (aheadBehind.ok) {
          const parsed = parseAheadBehind(aheadBehind.stdout);
          aheadCount = await countUnmergedAheadCommitsAsync(args.workspaceRoot, baseRef, parsed.ahead);
          behindCount = parsed.behind;
        }
      }

      const hasUncommittedChanges = workspaceChangedFiles > 0;
      const hasCommittedUnmergedChanges = await resolveCommittedUnmergedChangesAsync({
        workspaceRoot: args.workspaceRoot,
        baseRef,
        mergeBaseDiffRef,
        aheadCount,
      });
      const status: ThreadWorkStatus = {
        state: toState({ hasUncommittedChanges, hasCommittedUnmergedChanges }),
        changedFiles: mergeBaseDiff.changedFiles,
        insertions: mergeBaseDiff.insertions,
        deletions: mergeBaseDiff.deletions,
        workspaceChangedFiles,
        workspaceInsertions,
        workspaceDeletions,
        hasUncommittedChanges,
        hasCommittedUnmergedChanges,
        aheadCount,
        behindCount,
        ...(currentBranch.ok && currentBranch.stdout ? { currentBranch: currentBranch.stdout } : {}),
        ...(defaultBranch ? { defaultBranch } : {}),
        ...(mergeBaseBranch ? { mergeBaseBranch } : {}),
        ...(mergeBaseBranchOptions.length > 0 ? { mergeBaseBranches: mergeBaseBranchOptions } : {}),
        ...(baseRef ? { baseRef } : {}),
        ...(files.length > 0 ? { files } : {}),
        workspaceRoot: args.workspaceRoot,
      };

      this.cache.set(args.workspaceRoot, {
        checkedAt: now,
        fingerprint,
        defaultBranch,
        mergeBaseBranch: requestedMergeBaseBranch,
        status,
      });

      return status;
    });
  }

  commit(args: {
    workspaceRoot: string;
    projectRoot: string;
    defaultBranch?: string;
    message?: string;
    includeUnstaged?: boolean;
    environment?: IEnvironment;
  }): WorktreeCommitResult {
    return withGitRunner(args.environment, () => {
      const before = this.getStatus(args);
      if (!before.hasUncommittedChanges) {
        return {
          ok: true,
          commitCreated: false,
          message: "Working directory is clean",
          workStatus: before,
        };
      }

      const includeUnstaged = args.includeUnstaged ?? true;
      if (includeUnstaged) {
        const addResult = runGitAtPath(args.workspaceRoot, ["add", "-A"]);
        if (!addResult.ok) {
          throw new Error(addResult.stderr || "Failed to stage changes");
        }
      }

      const hasStagedChanges = runGitAtPath(args.workspaceRoot, ["diff", "--cached", "--quiet"]);
      if (hasStagedChanges.ok) {
        const afterNoop = this.getStatus(args);
        return {
          ok: true,
          commitCreated: false,
          message: "No staged changes to commit",
          workStatus: afterNoop,
        };
      }

      const commitMessage = args.message?.trim();
      if (!commitMessage) {
        throw new Error("Commit message is required");
      }
      const commitResult = runGitAtPath(args.workspaceRoot, ["commit", "-m", commitMessage]);
      if (!commitResult.ok) {
        throw new Error(commitResult.stderr || "Commit failed");
      }

      this.invalidate(args.workspaceRoot);
      const after = this.getStatus(args);
      const shaResult = runGitAtPath(args.workspaceRoot, ["rev-parse", "HEAD"]);

      return {
        ok: true,
        commitCreated: true,
        message: "Committed changes",
        workStatus: after,
        ...(shaResult.ok && shaResult.stdout ? { commitSha: shaResult.stdout } : {}),
      };
    });
  }

  getWorkingTreeDiff(workspaceRoot: string, environment?: IEnvironment): GitDiffResult {
    return withGitRunner(environment, () => {
      const diffResult = runGitRawAtPath(workspaceRoot, ["diff", "--binary", "HEAD"]);
      if (diffResult.ok) {
        return trimDiffForResponse(diffResult.stdout);
      }
      const fallbackDiffResult = runGitRawAtPath(workspaceRoot, ["diff", "--binary"]);
      if (!fallbackDiffResult.ok) {
        throw new Error(
          fallbackDiffResult.stderr || diffResult.stderr || "Failed to compute working tree diff",
        );
      }
      return trimDiffForResponse(fallbackDiffResult.stdout);
    });
  }

  listCommitsSinceRef(args: {
    workspaceRoot: string;
    baseRef?: string;
    environment?: IEnvironment;
  }): ThreadGitDiffCommitSummary[] {
    return withGitRunner(args.environment, () => {
      const baseRef = args.baseRef?.trim();
      if (!baseRef) return [];
      const logResult = runGitAtPath(args.workspaceRoot, [
        "log",
        "--reverse",
        "--max-count=120",
        `--format=%H${COMMIT_SUMMARY_FIELD_SEPARATOR}%h${COMMIT_SUMMARY_FIELD_SEPARATOR}%ct${COMMIT_SUMMARY_FIELD_SEPARATOR}%an${COMMIT_SUMMARY_FIELD_SEPARATOR}%s`,
        `${baseRef}..HEAD`,
      ]);
      if (!logResult.ok || !logResult.stdout) {
        return [];
      }
      return parseCommitSummaries(logResult.stdout);
    });
  }

  getCombinedDiffSinceRef(args: {
    workspaceRoot: string;
    baseRef?: string;
    environment?: IEnvironment;
  }): GitDiffResult {
    return withGitRunner(args.environment, () => {
      const baseRef = args.baseRef?.trim();
      if (!baseRef) {
        return { diff: "", truncated: false };
      }
      const mergeBaseDiffRef = resolveMergeBaseDiffRef(args.workspaceRoot, baseRef);
      if (!mergeBaseDiffRef) {
        return { diff: "", truncated: false };
      }
      const diffResult = runGitRawAtPath(args.workspaceRoot, ["diff", "--binary", mergeBaseDiffRef]);
      if (!diffResult.ok) {
        throw new Error(diffResult.stderr || "Failed to compute worktree commit diff");
      }
      return trimDiffForResponse(diffResult.stdout);
    });
  }

  getCommitDiff(args: {
    workspaceRoot: string;
    commitSha: string;
    environment?: IEnvironment;
  }): GitDiffResult {
    return withGitRunner(args.environment, () => {
      const commitSha = args.commitSha.trim();
      if (commitSha.length === 0) {
        throw new Error("Commit SHA is required");
      }
      const showResult = runGitRawAtPath(args.workspaceRoot, [
        "show",
        "--binary",
        "--format=",
        commitSha,
      ]);
      if (!showResult.ok) {
        throw new Error(showResult.stderr || "Failed to compute commit diff");
      }
      return trimDiffForResponse(showResult.stdout);
    });
  }
}
