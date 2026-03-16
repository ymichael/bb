import { spawn } from "node:child_process";
import {
  existsSync,
  lstatSync,
  readdirSync,
  readFileSync,
  statSync,
  watch,
} from "node:fs";
import {
  mkdtemp as mkdtempAsync,
  rm as rmAsync,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type {
  EnvironmentCommitSummary,
  EnvironmentWorkFileChange,
  EnvironmentWorkStatus,
  EnvironmentWorkspaceCommitOptions,
  EnvironmentWorkspaceCommitResult,
  EnvironmentWorkspaceCommitsOptions,
  EnvironmentWorkspaceDiffOptions,
  EnvironmentWorkspaceDiffResult,
  EnvironmentWorkspaceStatusOptions,
  IEnvironment,
} from "./contracts.js";

const MAX_DIFF_RESPONSE_CHARS = 220_000;
const MAX_UNTRACKED_DIFF_FILES = 24;
const COMMIT_SUMMARY_FIELD_SEPARATOR = "\u001f";
const COMMITTED_DIFF_INDEX_DIR_PREFIX = "bb-committed-diff-check-";

type DiffCounts = {
  changedFiles: number;
  insertions: number;
  deletions: number;
};

type WorkspaceFile = {
  status: string;
  path: string;
};

type GitRunResult = {
  ok: boolean;
  stdout: string;
  stderr: string;
  code: number | null;
};

const WORKSPACE_STATUS_WATCH_DEBOUNCE_MS = 75;

function runGit(
  _environment: IEnvironment,
  _args: string[],
  _options?: { rawOutput?: boolean; okExitCodes?: readonly number[] },
): GitRunResult {
  throw new Error("Synchronous git execution is unsupported; use runGitAsync");
}

async function runGitAsync(
  environment: IEnvironment,
  args: string[],
  options?: { rawOutput?: boolean; okExitCodes?: readonly number[] },
): Promise<GitRunResult> {
  const result = await environment.run("git", args, {
    ...(options?.rawOutput ? { rawOutput: true } : {}),
  });
  const okExitCodes = options?.okExitCodes ?? [0];
  return {
    ok: result.exitCode !== null && okExitCodes.includes(result.exitCode),
    stdout: result.stdout,
    stderr: result.stderr,
    code: result.exitCode,
  };
}

async function listUnmergedPathsAsync(environment: IEnvironment): Promise<string[]> {
  const unmergedResult = await runGitAsync(environment, [
    "diff",
    "--name-only",
    "--diff-filter=U",
  ]);
  if (!unmergedResult.ok || !unmergedResult.stdout) {
    return [];
  }
  return unmergedResult.stdout
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
}

function formatUnmergedPathsMessage(paths: readonly string[]): string {
  return paths.length > 0
    ? `Commit has unresolved conflicts: ${paths.join(", ")}`
    : "Commit has unresolved conflicts";
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

function countUntrackedFiles(statusLines: readonly string[]): number {
  return statusLines.reduce((count, line) => (
    line.startsWith("?? ") ? count + 1 : count
  ), 0);
}

function resolveMergeBaseDiffRef(
  environment: IEnvironment,
  baseRef: string | undefined,
): string | undefined {
  if (!baseRef) return undefined;
  const mergeBaseResult = runGit(environment, ["merge-base", baseRef, "HEAD"]);
  if (!mergeBaseResult.ok || !mergeBaseResult.stdout) {
    return undefined;
  }
  return mergeBaseResult.stdout;
}

async function resolveMergeBaseDiffRefAsync(
  environment: IEnvironment,
  baseRef: string | undefined,
): Promise<string | undefined> {
  if (!baseRef) return undefined;
  const mergeBaseResult = await runGitAsync(environment, ["merge-base", baseRef, "HEAD"]);
  if (!mergeBaseResult.ok || !mergeBaseResult.stdout) {
    return undefined;
  }
  return mergeBaseResult.stdout;
}

function resolveMergeBaseDiffCounts(args: {
  environment: IEnvironment;
  mergeBaseDiffRef: string | undefined;
  statusLines: readonly string[];
  fallback: DiffCounts;
}): DiffCounts {
  if (!args.mergeBaseDiffRef) {
    return args.fallback;
  }

  const shortstatResult = runGit(args.environment, [
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
  environment: IEnvironment;
  mergeBaseDiffRef: string | undefined;
  statusLines: readonly string[];
  fallback: DiffCounts;
}): Promise<DiffCounts> {
  if (!args.mergeBaseDiffRef) {
    return args.fallback;
  }

  const shortstatResult = await runGitAsync(args.environment, [
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
  environment: IEnvironment,
  baseRef: string,
  aheadCount: number,
): number {
  if (aheadCount <= 0) {
    return 0;
  }

  const cherryResult = runGit(environment, ["cherry", baseRef, "HEAD"]);
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
    return aheadCount;
  }

  return unmergedCount;
}

async function countUnmergedAheadCommitsAsync(
  environment: IEnvironment,
  baseRef: string,
  aheadCount: number,
): Promise<number> {
  if (aheadCount <= 0) {
    return 0;
  }

  const cherryResult = await runGitAsync(environment, ["cherry", baseRef, "HEAD"]);
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
    return aheadCount;
  }

  return unmergedCount;
}

function baseRefContainsCommittedDiff(_args: {
  environment: IEnvironment;
  baseRef: string;
  diffPatch: string;
}): boolean | undefined {
  throw new Error(
    "Synchronous committed-diff checks are unsupported; use baseRefContainsCommittedDiffAsync",
  );
}

async function baseRefContainsCommittedDiffAsync(args: {
  environment: IEnvironment;
  baseRef: string;
  diffPatch: string;
}): Promise<boolean | undefined> {
  const workspaceRoot = args.environment.getWorkspaceRootUnsafe();
  const tempDir = await mkdtempAsync(join(tmpdir(), COMMITTED_DIFF_INDEX_DIR_PREFIX));
  const indexPath = join(tempDir, "index");
  const gitEnv = {
    ...process.env,
    GIT_INDEX_FILE: indexPath,
  };

  try {
    const readTreeStatus = await new Promise<number | null>((resolveStatus, reject) => {
      const child = spawn("git", ["read-tree", args.baseRef], {
        cwd: workspaceRoot,
        env: gitEnv,
        stdio: "ignore",
      });
      child.on("error", reject);
      child.on("close", resolveStatus);
    });
    if (readTreeStatus !== 0) {
      return undefined;
    }

    const reverseApplyStatus = await new Promise<number | null>((resolveStatus, reject) => {
      const child = spawn(
        "git",
        ["apply", "--cached", "--reverse", "--check", "--unidiff-zero", "-"],
        {
          cwd: workspaceRoot,
          env: gitEnv,
          stdio: ["pipe", "ignore", "ignore"],
        },
      );
      child.on("error", reject);
      child.stdin.write(args.diffPatch);
      child.stdin.end();
      child.on("close", resolveStatus);
    });
    if (reverseApplyStatus === 0) {
      return true;
    }
    if (reverseApplyStatus === 1) {
      return false;
    }
    return undefined;
  } finally {
    await rmAsync(tempDir, { recursive: true, force: true });
  }
}

function resolveCommittedUnmergedChanges(args: {
  environment: IEnvironment;
  baseRef: string | undefined;
  mergeBaseDiffRef: string | undefined;
  aheadCount: number;
}): boolean {
  if (args.aheadCount <= 0) {
    return false;
  }

  if (!args.baseRef || !args.mergeBaseDiffRef) {
    return true;
  }

  /**
   * Check whether the cumulative branch diff can be cleanly reverse-applied to the
   * current base tree. Using zero-context hunks keeps this tolerant of later edits
   * that build on top of already-squashed branch changes.
   */
  const committedDiffResult = runGit(args.environment, [
    "diff",
    "--binary",
    "--find-renames",
    "--unified=0",
    `${args.mergeBaseDiffRef}..HEAD`,
  ], { rawOutput: true });
  if (!committedDiffResult.ok) {
    return true;
  }
  if (committedDiffResult.stdout.length === 0) {
    return false;
  }

  const baseContainsDiff = baseRefContainsCommittedDiff({
    environment: args.environment,
    baseRef: args.baseRef,
    diffPatch: committedDiffResult.stdout,
  });
  if (baseContainsDiff === undefined) {
    return true;
  }
  return !baseContainsDiff;
}

async function resolveCommittedUnmergedChangesAsync(args: {
  environment: IEnvironment;
  baseRef: string | undefined;
  mergeBaseDiffRef: string | undefined;
  aheadCount: number;
}): Promise<boolean> {
  if (args.aheadCount <= 0) {
    return false;
  }

  if (!args.baseRef || !args.mergeBaseDiffRef) {
    return true;
  }

  const committedDiffResult = await runGitAsync(args.environment, [
    "diff",
    "--binary",
    "--find-renames",
    "--unified=0",
    `${args.mergeBaseDiffRef}..HEAD`,
  ], { rawOutput: true });
  if (!committedDiffResult.ok) {
    return true;
  }
  if (committedDiffResult.stdout.length === 0) {
    return false;
  }

  const baseContainsDiff = await baseRefContainsCommittedDiffAsync({
    environment: args.environment,
    baseRef: args.baseRef,
    diffPatch: committedDiffResult.stdout,
  });
  if (baseContainsDiff === undefined) {
    return true;
  }
  return !baseContainsDiff;
}

function parsePorcelainLine(line: string): WorkspaceFile | undefined {
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
    return `${indexStatus}${worktreeStatus}`;
  })();
  const rawPath = line.slice(2).trimStart();
  if (rawPath.length === 0) return undefined;
  const path = rawPath.includes(" -> ")
    ? rawPath.slice(rawPath.lastIndexOf(" -> ") + 4)
    : rawPath;
  return { status, path };
}

function parsePorcelainLines(stdout: string): WorkspaceFile[] {
  return stdout
    .split("\n")
    .map((line) => line.trimEnd())
    .filter((line) => line.length > 0)
    .map((line) => parsePorcelainLine(line))
    .filter((item): item is WorkspaceFile => Boolean(item));
}

function resolveWorkspaceStatusLines(
  environment: IEnvironment,
): WorkspaceFile[] {
  const fullStatusResult = runGit(environment, [
    "status",
    "--porcelain",
    "--untracked-files=all",
  ]);
  if (fullStatusResult.ok) {
    return parsePorcelainLines(fullStatusResult.stdout);
  }

  const fallbackStatusResult = runGit(environment, [
    "status",
    "--porcelain",
    "--untracked-files=normal",
  ]);
  if (fallbackStatusResult.ok) {
    return parsePorcelainLines(fallbackStatusResult.stdout);
  }

  return [];
}

async function resolveWorkspaceStatusLinesAsync(
  environment: IEnvironment,
): Promise<WorkspaceFile[]> {
  const fullStatusResult = await runGitAsync(environment, [
    "status",
    "--porcelain",
    "--untracked-files=all",
  ]);
  if (fullStatusResult.ok) {
    return parsePorcelainLines(fullStatusResult.stdout);
  }

  const fallbackStatusResult = await runGitAsync(environment, [
    "status",
    "--porcelain",
    "--untracked-files=normal",
  ]);
  if (fallbackStatusResult.ok) {
    return parsePorcelainLines(fallbackStatusResult.stdout);
  }

  return [];
}

function parseNameStatusLine(line: string): WorkspaceFile | undefined {
  const segments = line.split("\t");
  if (segments.length < 2) return undefined;
  const rawStatus = segments[0]?.trim() ?? "";
  if (!rawStatus) return undefined;
  const isRenameOrCopy = rawStatus.startsWith("R") || rawStatus.startsWith("C");
  const path = (isRenameOrCopy ? segments[2] : segments[1])?.trim();
  if (!path) return undefined;
  return { status: rawStatus, path };
}

function resolveMergeBaseFileChanges(args: {
  environment: IEnvironment;
  mergeBaseDiffRef: string | undefined;
  workspaceFiles: ReadonlyArray<WorkspaceFile>;
}): WorkspaceFile[] {
  const fallback = args.workspaceFiles.slice(0, 60);
  if (!args.mergeBaseDiffRef) {
    return fallback;
  }

  const diffResult = runGit(args.environment, [
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
    .filter((item): item is WorkspaceFile => Boolean(item))
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
  environment: IEnvironment;
  mergeBaseDiffRef: string | undefined;
  workspaceFiles: ReadonlyArray<WorkspaceFile>;
}): Promise<WorkspaceFile[]> {
  const fallback = args.workspaceFiles.slice(0, 60);
  if (!args.mergeBaseDiffRef) {
    return fallback;
  }

  const diffResult = await runGitAsync(args.environment, [
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
    .filter((item): item is WorkspaceFile => Boolean(item))
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

function serializeWorkspaceFiles(
  files: readonly EnvironmentWorkFileChange[] | undefined,
): string[] {
  if (!files) {
    return [];
  }
  return files.map((file) => `${file.status}\u0000${file.path}`);
}

function createEnvironmentWorkStatusFingerprint(status: EnvironmentWorkStatus): string {
  return JSON.stringify({
    state: status.state,
    changedFiles: status.changedFiles,
    insertions: status.insertions,
    deletions: status.deletions,
    workspaceChangedFiles: status.workspaceChangedFiles,
    workspaceInsertions: status.workspaceInsertions,
    workspaceDeletions: status.workspaceDeletions,
    hasUncommittedChanges: status.hasUncommittedChanges,
    hasCommittedUnmergedChanges: status.hasCommittedUnmergedChanges,
    aheadCount: status.aheadCount,
    behindCount: status.behindCount,
    currentBranch: status.currentBranch ?? null,
    defaultBranch: status.defaultBranch ?? null,
    mergeBaseBranch: status.mergeBaseBranch ?? null,
    mergeBaseBranches: status.mergeBaseBranches ?? [],
    baseRef: status.baseRef ?? null,
    files: serializeWorkspaceFiles(status.files),
  });
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

function resolveGitMetadataPaths(workspaceRoot: string): string[] {
  const dotGitPath = join(workspaceRoot, ".git");
  const gitDirPath = resolveGitDirectory(workspaceRoot);
  const metadataRoot = gitDirPath ?? dotGitPath;
  return [
    dotGitPath,
    join(metadataRoot, "HEAD"),
    join(metadataRoot, "index"),
    join(metadataRoot, "packed-refs"),
    join(metadataRoot, "refs", "heads"),
    join(metadataRoot, "refs", "remotes", "origin"),
    ...(gitDirPath ? [gitDirPath] : []),
  ];
}

function resolveDefaultBranch(environment: IEnvironment): string | undefined {
  const remoteHead = runGit(environment, ["symbolic-ref", "--quiet", "refs/remotes/origin/HEAD"]);
  if (remoteHead.ok && remoteHead.stdout.startsWith("refs/remotes/origin/")) {
    return remoteHead.stdout.slice("refs/remotes/origin/".length);
  }

  const hasMain = runGit(environment, ["show-ref", "--verify", "--quiet", "refs/heads/main"]);
  if (hasMain.ok) return "main";

  const hasMaster = runGit(environment, ["show-ref", "--verify", "--quiet", "refs/heads/master"]);
  if (hasMaster.ok) return "master";

  return undefined;
}

async function resolveDefaultBranchAsync(environment: IEnvironment): Promise<string | undefined> {
  const remoteHead = await runGitAsync(environment, [
    "symbolic-ref",
    "--quiet",
    "refs/remotes/origin/HEAD",
  ]);
  if (remoteHead.ok && remoteHead.stdout.startsWith("refs/remotes/origin/")) {
    return remoteHead.stdout.slice("refs/remotes/origin/".length);
  }

  const hasMain = await runGitAsync(environment, [
    "show-ref",
    "--verify",
    "--quiet",
    "refs/heads/main",
  ]);
  if (hasMain.ok) return "main";

  const hasMaster = await runGitAsync(environment, [
    "show-ref",
    "--verify",
    "--quiet",
    "refs/heads/master",
  ]);
  if (hasMaster.ok) return "master";

  return undefined;
}

function resolveBaseRef(environment: IEnvironment, branch: string | undefined): string | undefined {
  if (!branch) return undefined;

  const localRef = `refs/heads/${branch}`;
  if (runGit(environment, ["show-ref", "--verify", "--quiet", localRef]).ok) {
    return branch;
  }

  const remoteRef = `refs/remotes/origin/${branch}`;
  if (runGit(environment, ["show-ref", "--verify", "--quiet", remoteRef]).ok) {
    return `origin/${branch}`;
  }

  return undefined;
}

async function resolveBaseRefAsync(
  environment: IEnvironment,
  branch: string | undefined,
): Promise<string | undefined> {
  if (!branch) return undefined;

  const localRef = `refs/heads/${branch}`;
  if ((await runGitAsync(environment, ["show-ref", "--verify", "--quiet", localRef])).ok) {
    return branch;
  }

  const remoteRef = `refs/remotes/origin/${branch}`;
  if ((await runGitAsync(environment, ["show-ref", "--verify", "--quiet", remoteRef])).ok) {
    return `origin/${branch}`;
  }

  return undefined;
}

function listMergeBaseBranches(
  environment: IEnvironment,
  defaultBranch: string | undefined,
): string[] {
  const localBranches = runGit(environment, [
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
  environment: IEnvironment,
  defaultBranch: string | undefined,
): Promise<string[]> {
  const localBranches = await runGitAsync(environment, [
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

export async function listGitWorkspaceMergeBaseBranchesAsync(
  environment: IEnvironment,
  defaultBranch?: string,
): Promise<string[]> {
  return listMergeBaseBranchesAsync(environment, defaultBranch);
}

function resolveMergeBaseSelection(args: {
  environment: IEnvironment;
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
    const baseRef = resolveBaseRef(args.environment, candidate);
    if (baseRef) {
      return { mergeBaseBranch: candidate, baseRef };
    }
  }

  return {};
}

async function resolveMergeBaseSelectionAsync(args: {
  environment: IEnvironment;
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
    const baseRef = await resolveBaseRefAsync(args.environment, candidate);
    if (baseRef) {
      return { mergeBaseBranch: candidate, baseRef };
    }
  }

  return {};
}

function toState(args: {
  hasUncommittedChanges: boolean;
  hasCommittedUnmergedChanges: boolean;
}): EnvironmentWorkStatus["state"] {
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

function trimDiffForResponse(diff: string): EnvironmentWorkspaceDiffResult {
  if (diff.length <= MAX_DIFF_RESPONSE_CHARS) {
    return { diff, truncated: false };
  }
  return {
    diff: `${diff.slice(0, MAX_DIFF_RESPONSE_CHARS)}\n\n... diff truncated ...\n`,
    truncated: true,
  };
}

function appendDiffSection(existingDiff: string, nextDiff: string): string {
  if (nextDiff.length === 0) {
    return existingDiff;
  }
  if (existingDiff.length === 0) {
    return nextDiff;
  }
  return `${existingDiff}${existingDiff.endsWith("\n") ? "" : "\n"}${nextDiff}`;
}

function isUntrackedDirectory(
  environment: IEnvironment,
  relativePath: string,
): boolean {
  const absolutePath = resolve(environment.getWorkspaceRootUnsafe(), relativePath);
  try {
    return lstatSync(absolutePath).isDirectory();
  } catch {
    return false;
  }
}

function countFilesInDirectoryUpTo(directoryPath: string, maxFiles: number): number {
  if (maxFiles <= 0) {
    return 0;
  }

  const stack = [directoryPath];
  let fileCount = 0;

  while (stack.length > 0) {
    const currentPath = stack.pop();
    if (!currentPath) {
      continue;
    }

    try {
      const entries = readdirSync(currentPath, { withFileTypes: true });
      for (const entry of entries) {
        const entryPath = join(currentPath, entry.name);
        if (entry.isDirectory()) {
          stack.push(entryPath);
          continue;
        }

        fileCount += 1;
        if (fileCount > maxFiles) {
          return fileCount;
        }
      }
    } catch {
      return maxFiles + 1;
    }
  }

  return fileCount;
}

async function resolveExpandableUntrackedPathsAsync(
  environment: IEnvironment,
): Promise<string[]> {
  const untrackedEntries = Array.from(new Set(
    (await resolveWorkspaceStatusLinesAsync(environment))
      .filter((item) => item.status === "A?")
      .map((item) => item.path),
  ));
  if (untrackedEntries.length === 0) {
    return [];
  }

  const collectedPaths: string[] = [];
  for (const path of untrackedEntries) {
    if (collectedPaths.length >= MAX_UNTRACKED_DIFF_FILES) {
      break;
    }

    if (!isUntrackedDirectory(environment, path)) {
      collectedPaths.push(path);
      continue;
    }

    const remainingBudget = MAX_UNTRACKED_DIFF_FILES - collectedPaths.length;
    const absoluteDirectoryPath = resolve(environment.getWorkspaceRootUnsafe(), path);
    if (countFilesInDirectoryUpTo(absoluteDirectoryPath, remainingBudget) > remainingBudget) {
      continue;
    }

    const untrackedFilesResult = await runGitAsync(environment, [
      "ls-files",
      "--others",
      "--exclude-standard",
      "--",
      path,
    ]);
    if (!untrackedFilesResult.ok || untrackedFilesResult.stdout.length === 0) {
      continue;
    }

    const nestedPaths = untrackedFilesResult.stdout
      .split("\n")
      .map((entry) => entry.trim())
      .filter((entry) => entry.length > 0)
      .slice(0, remainingBudget);
    collectedPaths.push(...nestedPaths);
  }

  return collectedPaths;
}

async function appendUntrackedWorkspaceDiffsAsync(
  environment: IEnvironment,
  diff: string,
): Promise<string> {
  const untrackedPaths = await resolveExpandableUntrackedPathsAsync(environment);
  if (untrackedPaths.length === 0) {
    return diff;
  }

  let combinedDiff = diff;
  for (const path of untrackedPaths) {
    if (combinedDiff.length >= MAX_DIFF_RESPONSE_CHARS) {
      break;
    }
    const untrackedDiffResult = await runGitAsync(environment, [
      "diff",
      "--binary",
      "--no-index",
      "--",
      "/dev/null",
      path,
    ], {
      rawOutput: true,
      okExitCodes: [0, 1],
    });
    if (!untrackedDiffResult.ok || untrackedDiffResult.stdout.length === 0) {
      continue;
    }
    combinedDiff = appendDiffSection(combinedDiff, untrackedDiffResult.stdout);
  }

  return combinedDiff;
}

function normalizeResolvedCleanStatus(status: EnvironmentWorkStatus): EnvironmentWorkStatus {
  if (status.hasUncommittedChanges || status.hasCommittedUnmergedChanges) {
    return status;
  }

  return {
    ...status,
    state: "clean",
    changedFiles: 0,
    insertions: 0,
    deletions: 0,
    workspaceChangedFiles: 0,
    workspaceInsertions: 0,
    workspaceDeletions: 0,
    files: [],
  };
}

function parseCommitSummaries(raw: string): EnvironmentCommitSummary[] {
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
      } satisfies EnvironmentCommitSummary;
    })
    .filter((entry): entry is EnvironmentCommitSummary => entry !== null);
}

function cleanStatus(workspaceRoot: string): EnvironmentWorkStatus {
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
    files: [],
  };
}

function untrackedStatus(workspaceRoot: string): EnvironmentWorkStatus {
  return {
    ...cleanStatus(workspaceRoot),
    state: "untracked",
  };
}

function deletedStatus(workspaceRoot: string): EnvironmentWorkStatus {
  return {
    ...cleanStatus(workspaceRoot),
    state: "deleted",
  };
}

export function getGitWorkspaceStatus(
  _environment: IEnvironment,
  _args?: EnvironmentWorkspaceStatusOptions,
): EnvironmentWorkStatus {
  throw new Error("Synchronous workspace status is unsupported; use getGitWorkspaceStatusAsync");
}

export async function getGitWorkspaceStatusAsync(
  environment: IEnvironment,
  args?: EnvironmentWorkspaceStatusOptions,
): Promise<EnvironmentWorkStatus> {
  const workspaceRoot = environment.getWorkspaceRootUnsafe();
  const workspaceExists = environment.exists();
  if (!workspaceExists) {
    return deletedStatus(workspaceRoot);
  }

  const isGitRepo = await runGitAsync(environment, ["rev-parse", "--is-inside-work-tree"]);
  if (!isGitRepo.ok || isGitRepo.stdout !== "true") {
    return untrackedStatus(workspaceRoot);
  }

  const requestedMergeBaseBranch = args?.mergeBaseBranch?.trim() || undefined;
  const defaultBranch = args?.defaultBranch ?? await resolveDefaultBranchAsync(environment);

  const workspaceFiles = (await resolveWorkspaceStatusLinesAsync(environment)).slice(0, 60);
  const statusLines = workspaceFiles.map((item) =>
    item.status === "A?" ? `?? ${item.path}` : `${item.status.padEnd(2, " ")} ${item.path}`
  );
  const workspaceChangedFiles = workspaceFiles.length;

  const unstagedStat = parseShortstat(
    (await runGitAsync(environment, ["diff", "--shortstat"])).stdout,
  );
  const stagedStat = parseShortstat(
    (await runGitAsync(environment, ["diff", "--cached", "--shortstat"])).stdout,
  );
  const workspaceInsertions = unstagedStat.insertions + stagedStat.insertions;
  const workspaceDeletions = unstagedStat.deletions + stagedStat.deletions;

  const currentBranch = await runGitAsync(environment, ["symbolic-ref", "--short", "HEAD"]);
  const mergeBaseSelection = await resolveMergeBaseSelectionAsync({
    environment,
    defaultBranch,
    requestedMergeBaseBranch,
  });
  const mergeBaseBranch = mergeBaseSelection.mergeBaseBranch;
  const baseRef = mergeBaseSelection.baseRef;
  const mergeBaseDiffRef = await resolveMergeBaseDiffRefAsync(environment, baseRef);
  const mergeBaseDiff = await resolveMergeBaseDiffCountsAsync({
    environment,
    mergeBaseDiffRef,
    statusLines,
    fallback: {
      changedFiles: workspaceChangedFiles,
      insertions: workspaceInsertions,
      deletions: workspaceDeletions,
    },
  });
  const files = await resolveMergeBaseFileChangesAsync({
    environment,
    mergeBaseDiffRef,
    workspaceFiles,
  });

  let aheadCount = 0;
  let behindCount = 0;
  if (baseRef) {
    const aheadBehind = await runGitAsync(environment, [
      "rev-list",
      "--left-right",
      "--count",
      `${baseRef}...HEAD`,
    ]);
    if (aheadBehind.ok) {
      const parsed = parseAheadBehind(aheadBehind.stdout);
      aheadCount = await countUnmergedAheadCommitsAsync(environment, baseRef, parsed.ahead);
      behindCount = parsed.behind;
    }
  }

  const hasUncommittedChanges = workspaceChangedFiles > 0;
  const hasCommittedUnmergedChanges = await resolveCommittedUnmergedChangesAsync({
    environment,
    baseRef,
    mergeBaseDiffRef,
    aheadCount,
  });

  return normalizeResolvedCleanStatus({
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
    ...(baseRef ? { baseRef } : {}),
    files,
  });
}

export function watchGitWorkspaceStatus(
  environment: IEnvironment,
  onChange: () => void,
): () => void {
  if (!environment.supportsHostFilesystemAccess()) {
    return () => {};
  }

  const workspaceRoot = environment.getWorkspaceRootUnsafe();
  const watchTargets = Array.from(new Set(resolveGitMetadataPaths(workspaceRoot)));
  let lastFingerprint: string | null = null;
  let pendingCheckTimer: ReturnType<typeof setTimeout> | null = null;
  let pendingCheckPromise: Promise<void> | null = null;
  let disposed = false;

  const recomputeFingerprint = async () => {
    const nextFingerprint = createEnvironmentWorkStatusFingerprint(
      await getGitWorkspaceStatusAsync(environment),
    );
    if (disposed) {
      return;
    }
    if (lastFingerprint === null) {
      lastFingerprint = nextFingerprint;
      return;
    }
    if (nextFingerprint === lastFingerprint) {
      return;
    }
    lastFingerprint = nextFingerprint;
    onChange();
  };

  void recomputeFingerprint();

  const scheduleStatusCheck = () => {
    if (disposed) {
      return;
    }
    if (pendingCheckTimer !== null) {
      clearTimeout(pendingCheckTimer);
    }
    pendingCheckTimer = setTimeout(() => {
      pendingCheckTimer = null;
      if (pendingCheckPromise) {
        return;
      }
      pendingCheckPromise = recomputeFingerprint()
        .catch(() => {
          // Ignore transient git status failures while watching.
        })
        .finally(() => {
          pendingCheckPromise = null;
        });
    }, WORKSPACE_STATUS_WATCH_DEBOUNCE_MS);
  };
  const watchers = watchTargets.flatMap((target) => {
    if (!existsSync(target)) {
      return [];
    }
    try {
      const watcher = watch(target, { persistent: false }, scheduleStatusCheck);
      watcher.on("error", () => {
        scheduleStatusCheck();
      });
      return [watcher];
    } catch {
      return [];
    }
  });

  return () => {
    disposed = true;
    if (pendingCheckTimer !== null) {
      clearTimeout(pendingCheckTimer);
      pendingCheckTimer = null;
    }
    for (const watcher of watchers) {
      try {
        watcher.close();
      } catch {
        // Ignore close failures.
      }
    }
  };
}

export function listGitWorkspaceCommitsSinceRef(
  _environment: IEnvironment,
  _args: EnvironmentWorkspaceCommitsOptions,
): EnvironmentCommitSummary[] {
  throw new Error(
    "Synchronous workspace commit listing is unsupported; use listGitWorkspaceCommitsSinceRefAsync",
  );
}

export async function listGitWorkspaceCommitsSinceRefAsync(
  environment: IEnvironment,
  args: EnvironmentWorkspaceCommitsOptions,
): Promise<EnvironmentCommitSummary[]> {
  const baseRef = args.baseRef?.trim();
  if (!baseRef) return [];
  const logResult = await runGitAsync(environment, [
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
}

export function commitGitWorkspace(
  environment: IEnvironment,
  args: EnvironmentWorkspaceCommitOptions,
  generateCommitMessage?: (args: {
    cwd: string;
    includeUnstaged?: boolean;
  }) => Promise<string | undefined>,
  onResult?: (result: EnvironmentWorkspaceCommitResult) => void,
): Promise<EnvironmentWorkspaceCommitResult> {
  return (async () => {
    const before = await getGitWorkspaceStatusAsync(environment, {
      ...(args.defaultBranch ? { defaultBranch: args.defaultBranch } : {}),
    });
    if (!before.hasUncommittedChanges) {
      const result = {
        ok: true,
        commitCreated: false,
        message: "Working directory is clean",
        workStatus: before,
        ...(args.includeUnstaged !== undefined ? { includeUnstaged: args.includeUnstaged } : {}),
      } satisfies EnvironmentWorkspaceCommitResult;
      onResult?.(result);
      return result;
    }

    const includeUnstaged = args.includeUnstaged ?? true;
    if (includeUnstaged) {
      const addResult = await runGitAsync(environment, ["add", "-A"]);
      if (!addResult.ok) {
        throw new Error(addResult.stderr || "Failed to stage changes");
      }
    }

    const hasStagedChanges = await runGitAsync(environment, ["diff", "--cached", "--quiet"]);
    if (hasStagedChanges.ok) {
      const afterNoop = await getGitWorkspaceStatusAsync(environment, {
        ...(args.defaultBranch ? { defaultBranch: args.defaultBranch } : {}),
      });
      const result = {
        ok: true,
        commitCreated: false,
        message: "No staged changes to commit",
        workStatus: afterNoop,
        ...(args.includeUnstaged !== undefined ? { includeUnstaged: args.includeUnstaged } : {}),
      } satisfies EnvironmentWorkspaceCommitResult;
      onResult?.(result);
      return result;
    }

    const unmergedPathsBeforeMessage = await listUnmergedPathsAsync(environment);
    if (unmergedPathsBeforeMessage.length > 0) {
      throw new Error(formatUnmergedPathsMessage(unmergedPathsBeforeMessage));
    }

    let commitMessage = args.message?.trim();
    if (!commitMessage) {
      commitMessage = (await generateCommitMessage?.({
        cwd: environment.getWorkspaceRootUnsafe(),
        includeUnstaged: args.includeUnstaged,
      }))?.trim();
    }
    if (!commitMessage) {
      throw new Error("Commit message is required");
    }
    const unmergedPathsBeforeCommit = await listUnmergedPathsAsync(environment);
    if (unmergedPathsBeforeCommit.length > 0) {
      throw new Error(formatUnmergedPathsMessage(unmergedPathsBeforeCommit));
    }
    const commitResult = await runGitAsync(environment, ["commit", "-m", commitMessage]);
    if (!commitResult.ok) {
      throw new Error(commitResult.stderr || "Commit failed");
    }

    const after = await getGitWorkspaceStatusAsync(environment, {
      ...(args.defaultBranch ? { defaultBranch: args.defaultBranch } : {}),
    });
    const shaResult = await runGitAsync(environment, ["rev-parse", "HEAD"]);
    const subjectResult = await runGitAsync(environment, ["show", "-s", "--format=%s", "HEAD"]);

    const result = {
      ok: true,
      commitCreated: true,
      message: "Committed changes",
      workStatus: after,
      ...(shaResult.ok && shaResult.stdout ? { commitSha: shaResult.stdout } : {}),
      ...(subjectResult.ok && subjectResult.stdout
        ? { commitSubject: subjectResult.stdout }
        : {}),
      ...(args.includeUnstaged !== undefined ? { includeUnstaged: args.includeUnstaged } : {}),
    } satisfies EnvironmentWorkspaceCommitResult;
    onResult?.(result);
    return result;
  })();
}

export function getGitWorkspaceDiff(
  _environment: IEnvironment,
  _args: EnvironmentWorkspaceDiffOptions,
): EnvironmentWorkspaceDiffResult {
  throw new Error("Synchronous workspace diff is unsupported; use getGitWorkspaceDiffAsync");
}

export async function getGitWorkspaceDiffAsync(
  environment: IEnvironment,
  args: EnvironmentWorkspaceDiffOptions,
): Promise<EnvironmentWorkspaceDiffResult> {
  switch (args.type) {
    case "working_tree": {
      const diffResult = await runGitAsync(environment, ["diff", "--binary", "HEAD"], {
        rawOutput: true,
      });
      if (diffResult.ok) {
        return trimDiffForResponse(
          await appendUntrackedWorkspaceDiffsAsync(environment, diffResult.stdout),
        );
      }
      const fallbackDiffResult = await runGitAsync(environment, ["diff", "--binary"], {
        rawOutput: true,
      });
      if (!fallbackDiffResult.ok) {
        throw new Error(
          fallbackDiffResult.stderr || diffResult.stderr || "Failed to compute working tree diff",
        );
      }
      return trimDiffForResponse(
        await appendUntrackedWorkspaceDiffsAsync(environment, fallbackDiffResult.stdout),
      );
    }
    case "combined": {
      const baseRef = args.baseRef?.trim();
      if (!baseRef) {
        return { diff: "", truncated: false };
      }
      const mergeBaseDiffRef = await resolveMergeBaseDiffRefAsync(environment, baseRef);
      if (!mergeBaseDiffRef) {
        return { diff: "", truncated: false };
      }
      const diffResult = await runGitAsync(environment, ["diff", "--binary", mergeBaseDiffRef], {
        rawOutput: true,
      });
      if (!diffResult.ok) {
        throw new Error(diffResult.stderr || "Failed to compute worktree commit diff");
      }
      return trimDiffForResponse(
        await appendUntrackedWorkspaceDiffsAsync(environment, diffResult.stdout),
      );
    }
    case "commit": {
      const commitSha = args.commitSha.trim();
      if (commitSha.length === 0) {
        throw new Error("Commit SHA is required");
      }
      const showResult = await runGitAsync(environment, [
        "show",
        "--binary",
        "--format=",
        commitSha,
      ], { rawOutput: true });
      if (!showResult.ok) {
        throw new Error(showResult.stderr || "Failed to compute commit diff");
      }
      return trimDiffForResponse(showResult.stdout);
    }
    default: {
      const _exhaustive: never = args;
      return _exhaustive;
    }
  }
}
