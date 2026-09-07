import type {
  RawDiffFileStat,
  ThreadGitDiffResponse,
  WorkspaceCommitSummary,
  WorkspaceDiffTarget,
  WorkspaceFileStatus,
  WorkspaceFileStatusKind,
  WorkspaceStatus,
} from "@bb/domain";
import os from "node:os";
import path from "node:path";
import {
  getPullRequestForCurrentBranch,
  runPullRequestActionForCurrentBranch,
  type GitHostCliOptions,
  type GitHostPullRequestAction,
  type GitHostPullRequestLookup,
} from "./git-host.js";
import {
  createTempDir,
  detectGitRepo,
  ensureGitRepo,
  getCheckoutRef,
  getCurrentBranch,
  parseNameStatusEntries,
  parseNameStatusSourceEntries,
  parseNumstatEntriesZ,
  parsePorcelainEntries,
  pathExists,
  readDefaultBranch,
  readMergeBaseRef,
  parsePatchId,
  revParse,
  runGit,
  runGitWithNullRecordLimit,
  type GitCommandResult,
  type GitProcessOptions,
  type GitNullRecordFormat,
  type GitNullRecordLimitResult,
  type NameStatusSourceEntry,
  type NumstatEntry,
  type RunGitOptions,
  runShellPipeline,
  summarizeNumstat,
  WorkspaceError,
} from "./git.js";
import fs from "node:fs/promises";
import {
  withCheckoutMutationLock,
  withCheckoutMutationLocks,
} from "./checkout-mutation-lock.js";

export interface DiffOptions {
  target?: WorkspaceDiffTarget;
  maxDiffBytes?: number;
  maxFileListBytes?: number;
  maxUntrackedFiles?: number;
}

export interface StatusOptions {
  mergeBaseBranch?: string;
  maxUntrackedLineStatFiles?: number;
  maxUntrackedLineStatBytes?: number;
}

export type DiffResult = ThreadGitDiffResponse;

export interface CommitOptions {
  message: string;
  noVerify: boolean;
}

export interface CommitResult {
  commitSha: string;
  commitSubject: string;
}

export type PullRequestActionOptions = GitHostPullRequestAction;

type DiffSummary = {
  diff: string;
  files: string;
  shortstat: string;
  truncated: boolean;
  mergeBaseRef: string | null;
};

export interface DiffFilesArgs {
  target: WorkspaceDiffTarget;
  maxFiles: number;
}

export interface DiffFilesResult {
  files: RawDiffFileStat[];
  shortstat: string;
  mergeBaseRef: string | null;
  truncated: boolean;
}

export interface DiffPatchArgs {
  target: WorkspaceDiffTarget;
  paths: string[];
  maxBytesPerFile: number;
}

export interface DiffPatchEntry {
  path: string;
  patch: string;
  truncated: boolean;
}

type DiffArtifactsResult = {
  artifacts: [string, string, string];
  mergeBaseRef: string | null;
  truncated: boolean;
};

type DiffArtifactsWithTruncation = {
  artifacts: [string, string, string];
  truncated: boolean;
};

type DiffArtifacts = {
  diff: string;
  files: string;
  numstat: string;
};

type DiffOutputLimits = {
  maxDiffBytes?: number;
  maxFileListBytes?: number;
};

type DiffPathSubset = {
  paths?: string[];
};

type ReadWorkspaceDiffArtifactsArgs = DiffOutputLimits &
  DiffPathSubset & {
    target: WorkspaceDiffTarget;
    maxUntrackedFiles?: number;
  };

type AppendUntrackedDiffArtifactsArgs = DiffArtifacts &
  DiffOutputLimits &
  DiffPathSubset & {
    maxUntrackedFiles?: number;
  };

type ReadUntrackedDiffArtifactsArgs = DiffOutputLimits & {
  relativePaths: string[];
};

type TruncatedOutput = {
  value: string;
  truncated: boolean;
};

type ReadDiffArtifactsArgs = {
  diffArgs: string[];
  filesArgs: string[];
  numstatArgs: string[];
  maxUntrackedFiles?: number;
} & DiffOutputLimits &
  DiffPathSubset;

type DiffStatArtifacts = {
  nameStatus: string;
  numstat: string;
  shortstat: string;
  mergeBaseRef: string | null;
  untrackedPaths: string[];
};

type BoundedDiffStatArtifacts = {
  trackedEntries: NameStatusSourceEntry[];
  numstat: string;
  mergeBaseRef: string | null;
  untrackedPaths: string[];
  truncated: boolean;
};

type UntrackedStatusNumstatEnrichment = {
  entries: NumstatEntry[];
  complete: boolean;
};

type ReadTrackedPatchByPathArgs = {
  target: WorkspaceDiffTarget;
  paths: string[];
  maxBytesPerFile: number;
};

type ResolvedTrackedDiffRange = {
  baseArgs: string[];
  rangeArgs: string[];
  usesUncommittedHead: boolean;
  mergeBaseRef: string | null;
};

type WorkspaceMutationTargets = Workspace[];
type WorkspaceMutationWork<T> = () => Promise<T>;

interface ListWorkspaceFilesRecursivelyArgs {
  dir: string;
  root: string;
}

const WORKSPACE_STATUS_GIT_TIMEOUT_MS = 15_000;
const WORKSPACE_STATUS_UNTRACKED_ENRICHMENT_TIMEOUT_MS = 10_000;
const TEMPORARY_UNTRACKED_INDEX_ADD_ATTEMPTS = 3;
const DIFF_NUMSTAT_BASE_BUFFER_BYTES = 64 * 1024;
const DIFF_NUMSTAT_PER_FILE_BUFFER_BYTES = 16 * 1024;

function resolveWorkspaceFileStatusKind(args: {
  indexStatus: string;
  status: string;
  worktreeStatus: string;
}): WorkspaceFileStatusKind {
  if (args.status === "??") {
    return "??";
  }
  if (
    args.indexStatus === "U" ||
    args.worktreeStatus === "U" ||
    args.status.includes("U")
  ) {
    return "U";
  }
  if (
    args.indexStatus === "R" ||
    args.worktreeStatus === "R" ||
    args.status.includes("R")
  ) {
    return "R";
  }
  if (
    args.indexStatus === "C" ||
    args.worktreeStatus === "C" ||
    args.status.includes("C")
  ) {
    return "C";
  }
  if (
    args.indexStatus === "A" ||
    args.worktreeStatus === "A" ||
    args.status.includes("A")
  ) {
    return "A";
  }
  if (
    args.indexStatus === "D" ||
    args.worktreeStatus === "D" ||
    args.status.includes("D")
  ) {
    return "D";
  }
  return "M";
}

function mapNameStatusLetter(letter: string): WorkspaceFileStatusKind {
  switch (letter) {
    case "A":
    case "D":
    case "R":
    case "C":
    case "U":
    case "M":
      return letter;
    case "T":
      return "M";
    default:
      return "?";
  }
}

function resolveWorkspaceState(args: {
  hasCommittedChanges: boolean;
  hasTrackedChanges: boolean;
  hasUntracked: boolean;
}): WorkspaceStatus["workingTree"]["state"] {
  if (
    !args.hasTrackedChanges &&
    !args.hasUntracked &&
    !args.hasCommittedChanges
  ) {
    return "clean";
  }
  if (
    (args.hasTrackedChanges || args.hasUntracked) &&
    args.hasCommittedChanges
  ) {
    return "dirty_and_committed_unmerged";
  }
  if (args.hasUntracked && !args.hasTrackedChanges) {
    return "untracked";
  }
  if (args.hasTrackedChanges) {
    return "dirty_uncommitted";
  }
  return "committed_unmerged";
}

function parseNullSeparatedLines(output: string): string[] {
  return output.split("\0").filter((value) => value.length > 0);
}

function parseNonEmptyLines(output: string): string[] {
  return output
    .split("\n")
    .map((value) => value.trim())
    .filter((value) => value.length > 0);
}

function isMissingHeadRevisionError(stderr: string): boolean {
  return (
    stderr.includes("ambiguous argument 'HEAD'") ||
    stderr.includes("bad revision 'HEAD'") ||
    stderr.includes("unknown revision or path not in the working tree") ||
    stderr.includes("Needed a single revision")
  );
}

async function listWorkspaceFilesRecursively(
  args: ListWorkspaceFilesRecursivelyArgs,
): Promise<string[]> {
  const entries = await fs.readdir(args.dir, { withFileTypes: true });
  const results: string[] = [];
  for (const entry of entries) {
    if (entry.name.startsWith(".")) {
      continue;
    }
    if (entry.name === "node_modules") {
      continue;
    }
    const fullPath = path.join(args.dir, entry.name);
    if (entry.isDirectory()) {
      const childResults = await listWorkspaceFilesRecursively({
        dir: fullPath,
        root: args.root,
      });
      for (const childResult of childResults) results.push(childResult);
      continue;
    }
    results.push(path.relative(args.root, fullPath));
  }
  return results;
}

function formatShortstat(args: {
  changedFiles: number;
  deletions: number;
  insertions: number;
}): string {
  if (args.changedFiles === 0) {
    return "";
  }

  const parts = [
    `${args.changedFiles} file${args.changedFiles === 1 ? "" : "s"} changed`,
  ];
  if (args.insertions > 0) {
    parts.push(
      `${args.insertions} insertion${args.insertions === 1 ? "" : "s"}(+)`,
    );
  }
  if (args.deletions > 0) {
    parts.push(
      `${args.deletions} deletion${args.deletions === 1 ? "" : "s"}(-)`,
    );
  }

  return `${parts.join(", ")}\n`;
}

function truncateToMaxBytes(value: string, maxBytes: number): string {
  const buffer = Buffer.from(value, "utf8");
  if (buffer.byteLength <= maxBytes) {
    return value;
  }
  let cut = maxBytes;
  while (cut > 0 && (buffer[cut] & 0xc0) === 0x80) {
    cut -= 1;
  }
  return buffer.subarray(0, cut).toString("utf8");
}

function truncateOutputToMaxBytes(
  value: string,
  maxBytes: number | undefined,
): TruncatedOutput {
  if (
    typeof maxBytes !== "number" ||
    Buffer.byteLength(value, "utf8") <= maxBytes
  ) {
    return { value, truncated: false };
  }
  return { value: truncateToMaxBytes(value, maxBytes), truncated: true };
}

function withDiffPathspec(
  args: string[],
  paths: string[] | undefined,
): string[] {
  if (paths === undefined) {
    return args;
  }
  const withoutSeparator =
    args[args.length - 1] === "--" ? args.slice(0, -1) : args;
  return [...withoutSeparator, "--", ...paths];
}

const COMBINED_PAGE_PER_FILE_HEADROOM_BYTES = 4 * 1024;
const COMBINED_PAGE_BASE_HEADROOM_BYTES = 64 * 1024;

function combinedPageBufferBudget(
  fileCount: number,
  maxBytesPerFile: number,
): number {
  return (
    COMBINED_PAGE_BASE_HEADROOM_BYTES +
    fileCount * (maxBytesPerFile + COMBINED_PAGE_PER_FILE_HEADROOM_BYTES)
  );
}

function buildDiffOutputGitOptions(
  cwd: string,
  maxBytes: number | undefined,
): RunGitOptions {
  if (typeof maxBytes !== "number") {
    return { cwd };
  }
  return {
    cwd,
    maxBufferBytes: maxBytes + 1,
    allowTruncatedStdout: true,
  };
}

async function readHeadNumstat(
  workspacePath: string,
  timeoutMs?: number,
  options: GitProcessOptions = {},
): Promise<string> {
  const runUncommittedDiff = createUncommittedDiffRunner(
    workspacePath,
    options,
  );
  const result = await runUncommittedDiff(
    (baseRef) => ["diff", "--numstat", "-z", baseRef, "--"],
    { cwd: workspacePath, timeoutMs, ...options },
  );
  return result.stdout;
}

async function readEmptyTreeSha(
  workspacePath: string,
  options: Pick<RunGitOptions, "shellPath" | "timeoutMs"> = {},
): Promise<string> {
  const emptyTree = await runGit(["hash-object", "-t", "tree", os.devNull], {
    cwd: workspacePath,
    ...options,
  });
  const emptyTreeSha = emptyTree.stdout.trim();
  if (emptyTreeSha.length === 0) {
    throw new WorkspaceError(
      "git_command_failed",
      "git hash-object returned no empty tree SHA",
    );
  }
  return emptyTreeSha;
}

type UncommittedDiffRunner = (
  buildArgs: (baseRef: string) => string[],
  options: RunGitOptions,
) => Promise<GitCommandResult>;

function createUncommittedDiffRunner(
  workspacePath: string,
  gitProcessOptions: GitProcessOptions = {},
): UncommittedDiffRunner {
  let emptyTreeShaPromise: Promise<string> | null = null;

  return async (buildArgs, options) => {
    if (emptyTreeShaPromise !== null) {
      return runGit(buildArgs(await emptyTreeShaPromise), {
        ...options,
        ...gitProcessOptions,
      });
    }

    const headArgs = buildArgs("HEAD");
    const headResult = await runGit(headArgs, {
      ...options,
      ...gitProcessOptions,
      allowFailure: true,
      timeoutMs: options.timeoutMs,
    });
    if (headResult.exitCode === 0) {
      return headResult;
    }
    if (!isMissingHeadRevisionError(headResult.stderr)) {
      const detail = headResult.stderr.trim();
      throw new WorkspaceError(
        "git_command_failed",
        `git ${headArgs.join(" ")} failed${detail ? `: ${detail}` : ""}`,
      );
    }

    emptyTreeShaPromise ??= readEmptyTreeSha(workspacePath, {
      timeoutMs: options.timeoutMs,
      ...gitProcessOptions,
    });
    return runGit(buildArgs(await emptyTreeShaPromise), {
      ...options,
      ...gitProcessOptions,
    });
  };
}

export class Workspace {
  readonly path: string;
  private readonly gitProcessOptions: GitProcessOptions;

  constructor(path: string, gitProcessOptions: GitProcessOptions = {}) {
    this.path = path;
    this.gitProcessOptions = { ...gitProcessOptions };
  }

  static withMutations<T>(
    workspaces: WorkspaceMutationTargets,
    work: WorkspaceMutationWork<T>,
  ): Promise<T> {
    return withCheckoutMutationLocks(
      workspaces.map((workspace) => workspace.path),
      work,
      undefined,
      workspaces[0]?.gitProcessOptions,
    );
  }

  withMutation<T>(work: WorkspaceMutationWork<T>): Promise<T> {
    return withCheckoutMutationLock(
      this.path,
      work,
      undefined,
      this.gitProcessOptions,
    );
  }

  private runGit(
    args: string[],
    options: RunGitOptions,
  ): Promise<GitCommandResult> {
    return runGit(args, { ...options, ...this.gitProcessOptions });
  }

  private runGitWithNullRecordLimit(
    args: string[],
    options: RunGitOptions,
    recordFormat: GitNullRecordFormat,
    maxRecords: number,
  ): Promise<GitNullRecordLimitResult> {
    return runGitWithNullRecordLimit(
      args,
      { ...options, ...this.gitProcessOptions },
      recordFormat,
      maxRecords,
    );
  }

  private runShellPipeline(
    script: string,
    positionalArgs: string[],
    options: Parameters<typeof runShellPipeline>[2],
  ): Promise<GitCommandResult> {
    return runShellPipeline(script, positionalArgs, {
      ...options,
      ...this.gitProcessOptions,
    });
  }

  get exists(): Promise<boolean> {
    return pathExists(this.path);
  }

  get isGitRepo(): Promise<boolean> {
    return detectGitRepo(this.path, this.gitProcessOptions);
  }

  get currentBranch(): Promise<string | undefined> {
    return getCurrentBranch(this.path, this.gitProcessOptions);
  }

  async getPullRequest(
    options: GitHostCliOptions = {},
  ): Promise<GitHostPullRequestLookup> {
    if (!(await this.exists)) {
      return {
        outcome: "unavailable",
        message: `Workspace path no longer exists: ${this.path}`,
      };
    }
    const branch = await getCurrentBranch(this.path, this.gitProcessOptions);
    if (!branch) {
      return { outcome: "none" };
    }
    return getPullRequestForCurrentBranch({
      cwd: this.path,
      localBranch: branch,
      ...this.gitProcessOptions,
      ...options,
    });
  }

  async runPullRequestAction(
    action: PullRequestActionOptions,
    options: GitHostCliOptions = {},
  ): Promise<void> {
    const branch = await getCurrentBranch(this.path, this.gitProcessOptions);
    if (!branch) {
      throw new WorkspaceError(
        "invalid_request",
        "Cannot update pull request from a detached workspace",
      );
    }
    return runPullRequestActionForCurrentBranch({
      cwd: this.path,
      localBranch: branch,
      action,
      ...this.gitProcessOptions,
      ...options,
    });
  }

  async getStatus(options: StatusOptions = {}): Promise<WorkspaceStatus> {
    const maxUntrackedLineStatFiles = options.maxUntrackedLineStatFiles;
    const maxUntrackedLineStatBytes = options.maxUntrackedLineStatBytes;
    const hasLineStatFileBudget = maxUntrackedLineStatFiles !== undefined;
    const hasLineStatByteBudget = maxUntrackedLineStatBytes !== undefined;
    if (hasLineStatFileBudget !== hasLineStatByteBudget) {
      throw new WorkspaceError(
        "invalid_request",
        "Untracked line-stat file and byte budgets must be provided together",
      );
    }
    if (
      maxUntrackedLineStatFiles !== undefined &&
      maxUntrackedLineStatBytes !== undefined
    ) {
      assertPositiveInteger(
        maxUntrackedLineStatFiles,
        "maxUntrackedLineStatFiles",
      );
      assertPositiveInteger(
        maxUntrackedLineStatBytes,
        "maxUntrackedLineStatBytes",
      );
    }
    await ensureGitRepo(this.path, {
      timeoutMs: WORKSPACE_STATUS_GIT_TIMEOUT_MS,
      ...this.gitProcessOptions,
    });

    const mergeBaseBranch = options.mergeBaseBranch;
    const [statusOutput, diffOutput, checkout, defaultBranch, mergeBaseData] =
      await Promise.all([
        this.runGit(
          [
            "--no-optional-locks",
            "status",
            "--porcelain=v1",
            "--branch",
            "--untracked-files=all",
          ],
          { cwd: this.path, timeoutMs: WORKSPACE_STATUS_GIT_TIMEOUT_MS },
        ),
        readHeadNumstat(
          this.path,
          WORKSPACE_STATUS_GIT_TIMEOUT_MS,
          this.gitProcessOptions,
        ),
        getCheckoutRef(this.path, {
          timeoutMs: WORKSPACE_STATUS_GIT_TIMEOUT_MS,
          ...this.gitProcessOptions,
        }),
        readDefaultBranch(this.path, {
          timeoutMs: WORKSPACE_STATUS_GIT_TIMEOUT_MS,
          ...this.gitProcessOptions,
        }),
        mergeBaseBranch
          ? this.readMergeBaseStatus(
              mergeBaseBranch,
              WORKSPACE_STATUS_GIT_TIMEOUT_MS,
            )
          : null,
      ]);

    const entries = parsePorcelainEntries(statusOutput.stdout);
    const untrackedPaths = entries
      .filter((entry) => entry.status === "??")
      .map((entry) => entry.path);
    const trackedNumstatEntries = parseNumstatEntriesZ(diffOutput);
    const untrackedNumstatEnrichment =
      maxUntrackedLineStatFiles !== undefined &&
      maxUntrackedLineStatBytes !== undefined
        ? await this.readBoundedUntrackedStatusNumstat({
            paths: untrackedPaths,
            maxFiles: maxUntrackedLineStatFiles,
            maxBytes: maxUntrackedLineStatBytes,
          })
        : { entries: [], complete: false };
    const trackedNumstatByPath = new Map(
      trackedNumstatEntries.map((entry) => [entry.path, entry] as const),
    );
    const untrackedNumstatByPath = new Map(
      untrackedNumstatEnrichment.entries.map(
        (entry) => [entry.path, entry] as const,
      ),
    );
    let workingTreeInsertions = 0;
    let workingTreeDeletions = 0;
    for (const entry of [
      ...trackedNumstatEntries,
      ...untrackedNumstatEnrichment.entries,
    ]) {
      if (entry.insertions !== null) workingTreeInsertions += entry.insertions;
      if (entry.deletions !== null) workingTreeDeletions += entry.deletions;
    }
    const files: WorkspaceFileStatus[] = entries.map((entry) => {
      const numstat =
        entry.status === "??"
          ? untrackedNumstatByPath.get(entry.path)
          : trackedNumstatByPath.get(entry.path);
      return {
        path: entry.path,
        status: resolveWorkspaceFileStatusKind({
          indexStatus: entry.indexStatus,
          status: entry.status,
          worktreeStatus: entry.worktreeStatus,
        }),
        insertions: numstat?.insertions ?? null,
        deletions: numstat?.deletions ?? null,
      };
    });
    const hasUntracked = untrackedPaths.length > 0;
    const hasTrackedChanges = entries.some((entry) => entry.status !== "??");
    const hasDirtyEntries = entries.length > 0;
    const hasCommittedChanges =
      mergeBaseData?.hasCommittedUnmergedChanges ?? false;
    const state = resolveWorkspaceState({
      hasCommittedChanges,
      hasTrackedChanges,
      hasUntracked,
    });

    return {
      workingTree: {
        hasUncommittedChanges: hasDirtyEntries,
        state,
        insertions: workingTreeInsertions,
        deletions: workingTreeDeletions,
        lineStatsComplete: !hasUntracked || untrackedNumstatEnrichment.complete,
        files,
      },
      branch: {
        currentBranch:
          checkout.kind === "branch" || checkout.kind === "unborn"
            ? checkout.branchName
            : null,
        defaultBranch:
          defaultBranch ??
          (checkout.kind === "branch" || checkout.kind === "unborn"
            ? (checkout.branchName ?? "")
            : ""),
      },
      checkout,
      mergeBase: mergeBaseData,
    };
  }

  async getLocalStateFingerprint(): Promise<string> {
    await ensureGitRepo(this.path, {
      timeoutMs: WORKSPACE_STATUS_GIT_TIMEOUT_MS,
      ...this.gitProcessOptions,
    });
    const [headSha, status] = await Promise.all([
      this.getHeadSha(),
      this.runGit(
        [
          "--no-optional-locks",
          "status",
          "--porcelain=v1",
          "--branch",
          "--untracked-files=normal",
        ],
        { cwd: this.path, timeoutMs: WORKSPACE_STATUS_GIT_TIMEOUT_MS },
      ),
    ]);
    return JSON.stringify({
      headSha,
      porcelain: status.stdout,
    });
  }

  async getSharedGitRefsFingerprint(): Promise<string> {
    await ensureGitRepo(this.path, this.gitProcessOptions);

    const [refs, remoteHead] = await Promise.all([
      this.runGit(
        [
          "for-each-ref",
          "--format=%(refname)%00%(objectname)",
          "refs/heads",
          "refs/remotes",
        ],
        { cwd: this.path },
      ),
      this.runGit(["symbolic-ref", "--quiet", "refs/remotes/origin/HEAD"], {
        cwd: this.path,
        allowFailure: true,
      }),
    ]);

    return JSON.stringify({
      refs: parseNonEmptyLines(refs.stdout),
      remoteHead: remoteHead.exitCode === 0 ? remoteHead.stdout.trim() : "",
    });
  }

  async getDiff(options: DiffOptions = {}): Promise<DiffResult> {
    await ensureGitRepo(this.path, this.gitProcessOptions);

    const target = options.target ?? { type: "uncommitted" as const };
    return this.buildDiffSummary({
      maxDiffBytes: options.maxDiffBytes,
      maxFileListBytes: options.maxFileListBytes,
      maxUntrackedFiles: options.maxUntrackedFiles,
      target,
    });
  }

  async diffFiles(args: DiffFilesArgs): Promise<DiffFilesResult> {
    await ensureGitRepo(this.path, this.gitProcessOptions);
    assertPositiveInteger(args.maxFiles, "maxFiles");

    const stats = await this.readBoundedDiffStatArtifacts(
      args.target,
      args.maxFiles,
    );
    const numstatByPath = new Map(
      parseNumstatEntriesZ(stats.numstat).map(
        (entry) => [entry.path, entry] as const,
      ),
    );
    const trackedFiles: RawDiffFileStat[] = stats.trackedEntries.map(
      (entry) => {
        const numstat = numstatByPath.get(entry.path);
        const binary =
          numstat !== undefined &&
          numstat.insertions === null &&
          numstat.deletions === null;
        return {
          path: entry.path,
          previousPath: entry.previousPath,
          statusLetter: normalizeNameStatusLetter(entry.status),
          additions: binary ? 0 : (numstat?.insertions ?? 0),
          deletions: binary ? 0 : (numstat?.deletions ?? 0),
          binary,
          origin: "tracked",
        };
      },
    );
    const untrackedFiles = await this.readUntrackedDiffFileStats(
      stats.untrackedPaths,
    );
    const files = [...trackedFiles, ...untrackedFiles];
    const summary = files.reduce(
      (result, file) => ({
        changedFiles: result.changedFiles + 1,
        insertions: result.insertions + file.additions,
        deletions: result.deletions + file.deletions,
      }),
      { changedFiles: 0, insertions: 0, deletions: 0 },
    );

    return {
      files,
      shortstat: formatShortstat(summary),
      mergeBaseRef: stats.mergeBaseRef,
      truncated: stats.truncated,
    };
  }

  async diffPatch(args: DiffPatchArgs): Promise<DiffPatchEntry[]> {
    await ensureGitRepo(this.path, this.gitProcessOptions);

    const untrackedForTarget = this.targetIncludesUntracked(args.target)
      ? new Set(await this.listRequestedUntrackedPaths(args.paths))
      : new Set<string>();

    const untrackedPaths = args.paths.filter((p) => untrackedForTarget.has(p));
    const trackedPaths = args.paths.filter((p) => !untrackedForTarget.has(p));

    const trackedPatchByPath =
      trackedPaths.length > 0
        ? await this.readTrackedPatchByPathCombined({
            target: args.target,
            paths: trackedPaths,
            maxBytesPerFile: args.maxBytesPerFile,
          })
        : new Map<string, string>();

    const untrackedPatchByPath = await this.readUntrackedPatchByPathCombined({
      paths: untrackedPaths,
      maxBytesPerFile: args.maxBytesPerFile,
    });

    const seen = new Set<string>();
    const entries: DiffPatchEntry[] = [];
    for (const path of args.paths) {
      if (seen.has(path)) {
        continue;
      }
      seen.add(path);
      const rawPatch =
        trackedPatchByPath.get(path) ?? untrackedPatchByPath.get(path) ?? "";
      const { patch, truncated } = truncatePatchToMaxBytes(
        rawPatch,
        args.maxBytesPerFile,
      );
      entries.push({ path, patch, truncated });
    }
    return entries;
  }

  async getHeadSha(): Promise<string | null> {
    await ensureGitRepo(this.path, this.gitProcessOptions);

    const result = await this.runGit(["rev-parse", "HEAD"], {
      allowFailure: true,
      cwd: this.path,
    });
    if (result.exitCode === 0) {
      return result.stdout.trim() || null;
    }
    if (isMissingHeadRevisionError(result.stderr)) {
      return null;
    }
    throw new WorkspaceError(
      "git_command_failed",
      `git rev-parse HEAD failed: ${result.stderr.trim()}`,
    );
  }

  async listFiles(): Promise<string[]> {
    const gitResult = await this.runGit(
      ["ls-files", "--cached", "--others", "--exclude-standard"],
      { allowFailure: true, cwd: this.path },
    );
    if (gitResult.exitCode === 0) {
      return parseNonEmptyLines(gitResult.stdout).sort();
    }
    if (
      gitResult.exitCode === 128 ||
      gitResult.stderr.includes("not a git repository")
    ) {
      const filePaths = await listWorkspaceFilesRecursively({
        dir: this.path,
        root: this.path,
      });
      return filePaths.sort();
    }
    throw new WorkspaceError(
      "git_command_failed",
      `git ls-files failed (exit ${gitResult.exitCode}): ${gitResult.stderr.trim()}`,
    );
  }

  async commit(options: CommitOptions): Promise<CommitResult> {
    await ensureGitRepo(this.path, this.gitProcessOptions);

    return this.withMutation(async () => {
      await this.runGit(["add", "-A"], { cwd: this.path });
      const staged = await this.runGit(["diff", "--cached", "--quiet"], {
        cwd: this.path,
        allowFailure: true,
      });
      if (staged.exitCode === 0) {
        throw new WorkspaceError("no_changes", "No changes to commit");
      }
      const commitArgs = ["commit", "-m", options.message];
      if (options.noVerify) {
        commitArgs.push("--no-verify");
      }
      await this.runGit(commitArgs, { cwd: this.path });
      const commitSha = await revParse(
        this.path,
        "HEAD",
        this.gitProcessOptions,
      );
      const commitSubject = (
        await this.runGit(["log", "-1", "--pretty=%s"], { cwd: this.path })
      ).stdout.trim();

      return { commitSha, commitSubject };
    });
  }

  async reset(): Promise<void> {
    await ensureGitRepo(this.path, this.gitProcessOptions);
    await this.withMutation(async () => {
      await this.runGit(["reset", "--hard", "HEAD"], { cwd: this.path });
      await this.runGit(["clean", "-fd"], { cwd: this.path });
    });
  }

  private async buildDiffSummary(args: {
    target: WorkspaceDiffTarget;
    maxDiffBytes?: number;
    maxFileListBytes?: number;
    maxUntrackedFiles?: number;
  }): Promise<DiffSummary> {
    if (args.maxUntrackedFiles !== undefined) {
      assertPositiveInteger(args.maxUntrackedFiles, "maxUntrackedFiles");
    }
    const {
      artifacts: [rawDiff, shortstat, rawFiles],
      mergeBaseRef,
      truncated: artifactTruncated,
    } = await this.readDiffArtifacts({
      target: args.target,
      maxDiffBytes: args.maxDiffBytes,
      maxFileListBytes: args.maxFileListBytes,
      maxUntrackedFiles: args.maxUntrackedFiles,
    });

    const diffOutput = truncateOutputToMaxBytes(rawDiff, args.maxDiffBytes);
    const fileOutput = truncateOutputToMaxBytes(
      rawFiles,
      args.maxFileListBytes,
    );

    return {
      diff: diffOutput.value,
      files: fileOutput.value,
      shortstat,
      truncated:
        artifactTruncated || diffOutput.truncated || fileOutput.truncated,
      mergeBaseRef,
    };
  }

  private async readPatchUniqueCommitSummaries(
    mergeBaseBranch: string,
    timeoutMs?: number,
  ): Promise<WorkspaceCommitSummary[]> {
    const log = await this.runGit(
      [
        "log",
        "--cherry-pick",
        "--right-only",
        "--reverse",
        "--format=%H%x1f%h%x1f%s%x1f%an%x1f%at",
        `${mergeBaseBranch}...HEAD`,
      ],
      { cwd: this.path, allowFailure: true, timeoutMs },
    );

    return log.stdout
      .split("\n")
      .filter(Boolean)
      .map((line) => {
        const [sha, shortSha, subject, authorName, authoredAt] =
          line.split("\u001f");
        return {
          sha,
          shortSha,
          subject,
          authorName: authorName ?? "",
          authoredAt: Number.parseInt(authoredAt ?? "0", 10) * 1000,
        };
      });
  }

  private async readMergeBaseStatus(
    mergeBaseBranch: string,
    timeoutMs?: number,
  ): Promise<WorkspaceStatus["mergeBase"]> {
    const [mergeBaseRef, aheadBehindCounts, commits, nameStatus, numstat] =
      await Promise.all([
        readMergeBaseRef(this.path, mergeBaseBranch, {
          timeoutMs,
          ...this.gitProcessOptions,
        }),
        this.runGit(
          [
            "rev-list",
            "--cherry-pick",
            "--left-right",
            "--count",
            `${mergeBaseBranch}...HEAD`,
          ],
          { cwd: this.path, allowFailure: true, timeoutMs },
        ),
        this.readPatchUniqueCommitSummaries(mergeBaseBranch, timeoutMs),
        this.runGit(
          [
            "diff",
            "--no-ext-diff",
            "--name-status",
            "-z",
            `${mergeBaseBranch}...HEAD`,
          ],
          { cwd: this.path, allowFailure: true, timeoutMs },
        ),
        this.runGit(
          [
            "diff",
            "--no-ext-diff",
            "--numstat",
            "-z",
            `${mergeBaseBranch}...HEAD`,
          ],
          { cwd: this.path, allowFailure: true, timeoutMs },
        ),
      ]);
    if (aheadBehindCounts.exitCode !== 0) {
      if (isMissingHeadRevisionError(aheadBehindCounts.stderr)) {
        return {
          mergeBaseBranch,
          baseRef: null,
          aheadCount: 0,
          behindCount: 0,
          hasCommittedUnmergedChanges: false,
          commits: [],
          files: [],
          insertions: 0,
          deletions: 0,
          lineStatsComplete: true,
        };
      }
      const detail = aheadBehindCounts.stderr.trim();
      throw new WorkspaceError(
        "git_command_failed",
        `git rev-list ${mergeBaseBranch}...HEAD failed${detail ? `: ${detail}` : ""}`,
      );
    }
    const [behindCount, aheadCount] = aheadBehindCounts.stdout
      .trim()
      .split(/\s+/)
      .map((value) => Number.parseInt(value, 10));
    let normalizedAheadCount = Number.isFinite(aheadCount) ? aheadCount : 0;
    const normalizedBehindCount = Number.isFinite(behindCount)
      ? behindCount
      : 0;
    let effectiveCommits = commits;
    const numstatEntries =
      numstat.exitCode === 0 ? parseNumstatEntriesZ(numstat.stdout) : [];
    const numstatByPath = new Map(
      numstatEntries.map((entry) => [entry.path, entry] as const),
    );
    let effectiveFiles: WorkspaceFileStatus[] =
      nameStatus.exitCode === 0
        ? parseNameStatusEntries(nameStatus.stdout).map((entry) => {
            const numstat = numstatByPath.get(entry.path);
            return {
              path: entry.path,
              status: mapNameStatusLetter(entry.status),
              insertions: numstat?.insertions ?? null,
              deletions: numstat?.deletions ?? null,
            };
          })
        : [];
    let effectiveInsertions = 0;
    let effectiveDeletions = 0;
    let effectiveLineStatsComplete = numstat.exitCode === 0;
    for (const entry of numstatEntries) {
      if (entry.insertions !== null) effectiveInsertions += entry.insertions;
      if (entry.deletions !== null) effectiveDeletions += entry.deletions;
    }

    if (normalizedAheadCount > 0 && normalizedBehindCount > 0 && mergeBaseRef) {
      const squashMerged = await this.detectSquashMerge(
        mergeBaseRef,
        mergeBaseBranch,
        timeoutMs,
      );
      if (squashMerged) {
        normalizedAheadCount = 0;
        effectiveCommits = [];
      }
    }

    if (effectiveCommits.length === 0) {
      effectiveFiles = [];
      effectiveInsertions = 0;
      effectiveDeletions = 0;
      effectiveLineStatsComplete = true;
    }

    return {
      mergeBaseBranch,
      baseRef: mergeBaseRef ?? null,
      aheadCount: normalizedAheadCount,
      behindCount: normalizedBehindCount,
      hasCommittedUnmergedChanges: normalizedAheadCount > 0,
      commits: effectiveCommits,
      files: effectiveFiles,
      insertions: effectiveInsertions,
      deletions: effectiveDeletions,
      lineStatsComplete: effectiveLineStatsComplete,
    };
  }

  private async detectSquashMerge(
    mergeBaseRef: string,
    mergeBaseBranch: string,
    timeoutMs?: number,
  ): Promise<boolean> {
    const branchPatchIdResult = await this.runShellPipeline(
      'git diff "$1".."$2" | git patch-id --stable',
      [mergeBaseRef, "HEAD"],
      { cwd: this.path, allowFailure: true, timeoutMs },
    );
    if (branchPatchIdResult.exitCode !== 0) {
      return false;
    }
    if (!branchPatchIdResult.stdout.trim()) {
      return true;
    }
    const branchPatchId = parsePatchId(
      branchPatchIdResult.stdout.split("\n")[0],
    );
    if (!branchPatchId) {
      return false;
    }

    const basePatchIdsResult = await this.runShellPipeline(
      'git log -p -n 1000 --format="commit %H" "$1".."$2" | git patch-id --stable',
      [mergeBaseRef, mergeBaseBranch],
      { cwd: this.path, allowFailure: true, timeoutMs },
    );
    if (basePatchIdsResult.exitCode !== 0) {
      return false;
    }
    return basePatchIdsResult.stdout
      .split("\n")
      .some((line) => parsePatchId(line) === branchPatchId);
  }

  private targetIncludesUntracked(target: WorkspaceDiffTarget): boolean {
    return target.type === "uncommitted" || target.type === "all";
  }

  private async readBoundedUntrackedStatusNumstat(args: {
    paths: string[];
    maxFiles: number;
    maxBytes: number;
  }): Promise<UntrackedStatusNumstatEnrichment> {
    if (args.paths.length === 0) {
      return { entries: [], complete: true };
    }
    if (args.paths.length > args.maxFiles) {
      return { entries: [], complete: false };
    }

    const controller = new AbortController();
    let timeout: ReturnType<typeof setTimeout> | undefined;
    const deadline = new Promise<UntrackedStatusNumstatEnrichment>(
      (resolve) => {
        timeout = setTimeout(() => {
          controller.abort();
          resolve({ entries: [], complete: false });
        }, WORKSPACE_STATUS_UNTRACKED_ENRICHMENT_TIMEOUT_MS);
      },
    );
    try {
      return await Promise.race([
        this.readUntrackedStatusNumstatWithinBudget(args, controller.signal),
        deadline,
      ]);
    } finally {
      if (timeout !== undefined) {
        clearTimeout(timeout);
      }
    }
  }

  private async readUntrackedStatusNumstatWithinBudget(
    args: { paths: string[]; maxBytes: number },
    signal: AbortSignal,
  ): Promise<UntrackedStatusNumstatEnrichment> {
    try {
      const candidates = await Promise.all(
        args.paths.map(async (relativePath) => {
          try {
            const stats = await fs.lstat(path.join(this.path, relativePath));
            return stats.isFile() || stats.isSymbolicLink()
              ? { path: relativePath, size: stats.size }
              : null;
          } catch (error) {
            if (
              error instanceof Error &&
              "code" in error &&
              error.code === "ENOENT"
            ) {
              return null;
            }
            throw error;
          }
        }),
      );
      const eligible = candidates.filter(
        (candidate): candidate is { path: string; size: number } =>
          candidate !== null,
      );
      let totalBytes = 0;
      for (const candidate of eligible) {
        totalBytes += candidate.size;
        if (totalBytes > args.maxBytes) {
          return { entries: [], complete: false };
        }
      }
      if (eligible.length === 0) {
        return { entries: [], complete: false };
      }

      return await this.withTemporaryUntrackedIndex(
        eligible.map((candidate) => candidate.path),
        async (env, indexedPaths) => {
          if (indexedPaths.length === 0) {
            return { entries: [], complete: false };
          }
          const result = await this.runGit(
            ["diff", "--no-ext-diff", "--numstat", "-z"],
            {
              cwd: this.path,
              env,
              signal,
              timeoutMs: WORKSPACE_STATUS_GIT_TIMEOUT_MS,
              maxBufferBytes:
                DIFF_NUMSTAT_BASE_BUFFER_BYTES +
                indexedPaths.length * DIFF_NUMSTAT_PER_FILE_BUFFER_BYTES,
            },
          );
          const parsed = parseNumstatEntriesZ(result.stdout);
          const parsedPaths = new Set(parsed.map((entry) => entry.path));
          return {
            entries: parsed,
            complete:
              eligible.length === args.paths.length &&
              indexedPaths.length === eligible.length &&
              indexedPaths.every((relativePath) =>
                parsedPaths.has(relativePath),
              ),
          };
        },
        { signal, timeoutMs: WORKSPACE_STATUS_GIT_TIMEOUT_MS },
      );
    } catch {
      return { entries: [], complete: false };
    }
  }

  private async readBoundedDiffStatArtifacts(
    target: WorkspaceDiffTarget,
    maxFiles: number,
  ): Promise<BoundedDiffStatArtifacts> {
    const range = await this.resolveTrackedDiffRange(target);
    if (range === null) {
      return {
        trackedEntries: [],
        numstat: "",
        mergeBaseRef: null,
        untrackedPaths: [],
        truncated: false,
      };
    }

    const overflowCount = maxFiles + 1;
    const [nameStatus, numstat] = await Promise.all([
      this.runTrackedDiffWithLimit({
        range,
        outputArgs: ["--name-status", "-M", "-z"],
        recordFormat: "name-status",
        maxRecords: overflowCount,
      }),
      this.runTrackedDiffWithLimit({
        range,
        outputArgs: ["--numstat", "-M", "-z"],
        recordFormat: "numstat",
        maxRecords: overflowCount,
      }),
    ]);
    const enumeratedTrackedEntries = parseNameStatusSourceEntries(
      nameStatus.stdout,
    );
    const trackedTruncated =
      nameStatus.recordLimitReached ||
      enumeratedTrackedEntries.length > maxFiles;
    const trackedEntries = enumeratedTrackedEntries.slice(0, maxFiles);

    const remainingFileSlots = maxFiles - trackedEntries.length;
    const enumeratedUntrackedPaths =
      !trackedTruncated && this.targetIncludesUntracked(target)
        ? await this.listUntrackedPathsLimited(remainingFileSlots + 1)
        : [];
    const untrackedTruncated =
      enumeratedUntrackedPaths.length > remainingFileSlots;
    const untrackedPaths = enumeratedUntrackedPaths.slice(
      0,
      remainingFileSlots,
    );
    return {
      trackedEntries,
      numstat: numstat.stdout,
      mergeBaseRef: range.mergeBaseRef,
      untrackedPaths,
      truncated: trackedTruncated || untrackedTruncated,
    };
  }

  private async runTrackedDiffWithLimit(args: {
    range: ResolvedTrackedDiffRange;
    outputArgs: string[];
    recordFormat: GitNullRecordFormat;
    maxRecords: number;
  }): Promise<GitNullRecordLimitResult> {
    const buildArgs = (rangeArgs: string[]): string[] => [
      ...args.range.baseArgs,
      ...args.outputArgs,
      ...rangeArgs,
    ];
    if (!args.range.usesUncommittedHead) {
      return this.runGitWithNullRecordLimit(
        buildArgs(args.range.rangeArgs),
        { cwd: this.path },
        args.recordFormat,
        args.maxRecords,
      );
    }

    const headArgs = buildArgs(["HEAD"]);
    const headResult = await this.runGitWithNullRecordLimit(
      headArgs,
      { cwd: this.path, allowFailure: true },
      args.recordFormat,
      args.maxRecords,
    );
    if (headResult.exitCode === 0) {
      return headResult;
    }
    if (!isMissingHeadRevisionError(headResult.stderr)) {
      const detail = headResult.stderr.trim();
      throw new WorkspaceError(
        "git_command_failed",
        `git ${headArgs.join(" ")} failed${detail ? `: ${detail}` : ""}`,
      );
    }

    const emptyTreeSha = await readEmptyTreeSha(
      this.path,
      this.gitProcessOptions,
    );
    return this.runGitWithNullRecordLimit(
      buildArgs([emptyTreeSha]),
      { cwd: this.path },
      args.recordFormat,
      args.maxRecords,
    );
  }

  private async readDiffStatArtifacts(
    target: WorkspaceDiffTarget,
  ): Promise<DiffStatArtifacts> {
    const untrackedPaths = this.targetIncludesUntracked(target)
      ? await this.listUntrackedPaths()
      : [];

    switch (target.type) {
      case "uncommitted": {
        const stats = await this.runUncommittedDiffStatCommands();
        return { ...stats, mergeBaseRef: null, untrackedPaths };
      }
      case "branch_committed": {
        const mergeBaseRef = await readMergeBaseRef(
          this.path,
          target.mergeBaseBranch,
          this.gitProcessOptions,
        );
        if (!mergeBaseRef) {
          return {
            nameStatus: "",
            numstat: "",
            shortstat: "",
            mergeBaseRef: null,
            untrackedPaths: [],
          };
        }
        const stats = await this.runDiffStatCommands([`${mergeBaseRef}..HEAD`]);
        return { ...stats, mergeBaseRef, untrackedPaths: [] };
      }
      case "all": {
        const mergeBaseRef = await readMergeBaseRef(
          this.path,
          target.mergeBaseBranch,
          this.gitProcessOptions,
        );
        if (!mergeBaseRef) {
          return {
            nameStatus: "",
            numstat: "",
            shortstat: "",
            mergeBaseRef: null,
            untrackedPaths: [],
          };
        }
        const stats = await this.runDiffStatCommands([mergeBaseRef]);
        return { ...stats, mergeBaseRef, untrackedPaths };
      }
      case "commit": {
        const [nameStatus, numstat, shortstat] = await Promise.all([
          this.runGit(
            [
              "show",
              "--format=",
              "--no-ext-diff",
              "--name-status",
              "-M",
              "-z",
              target.sha,
            ],
            { cwd: this.path },
          ),
          this.runGit(
            [
              "show",
              "--format=",
              "--no-ext-diff",
              "--numstat",
              "-M",
              "-z",
              target.sha,
            ],
            { cwd: this.path },
          ),
          this.runGit(
            ["show", "--format=", "--no-ext-diff", "--shortstat", target.sha],
            {
              cwd: this.path,
            },
          ),
        ]);
        return {
          nameStatus: nameStatus.stdout,
          numstat: numstat.stdout,
          shortstat: shortstat.stdout,
          mergeBaseRef: null,
          untrackedPaths: [],
        };
      }
      default: {
        const _exhaustive: never = target;
        return _exhaustive;
      }
    }
  }

  private async runDiffStatCommands(
    rangeArgs: string[],
  ): Promise<{ nameStatus: string; numstat: string; shortstat: string }> {
    const [nameStatus, numstat, shortstat] = await Promise.all([
      this.runGit(
        ["diff", "--no-ext-diff", "--name-status", "-M", "-z", ...rangeArgs],
        { cwd: this.path },
      ),
      this.runGit(
        ["diff", "--no-ext-diff", "--numstat", "-M", "-z", ...rangeArgs],
        {
          cwd: this.path,
        },
      ),
      this.runGit(["diff", "--no-ext-diff", "--shortstat", ...rangeArgs], {
        cwd: this.path,
      }),
    ]);
    return {
      nameStatus: nameStatus.stdout,
      numstat: numstat.stdout,
      shortstat: shortstat.stdout,
    };
  }

  private async runUncommittedDiffStatCommands(): Promise<{
    nameStatus: string;
    numstat: string;
    shortstat: string;
  }> {
    const runUncommittedDiff = createUncommittedDiffRunner(
      this.path,
      this.gitProcessOptions,
    );
    const [nameStatus, numstat, shortstat] = await Promise.all([
      runUncommittedDiff(
        (baseRef) => [
          "diff",
          "--no-ext-diff",
          "--name-status",
          "-M",
          "-z",
          baseRef,
        ],
        { cwd: this.path },
      ),
      runUncommittedDiff(
        (baseRef) => [
          "diff",
          "--no-ext-diff",
          "--numstat",
          "-M",
          "-z",
          baseRef,
        ],
        { cwd: this.path },
      ),
      runUncommittedDiff(
        (baseRef) => ["diff", "--no-ext-diff", "--shortstat", baseRef],
        { cwd: this.path },
      ),
    ]);
    return {
      nameStatus: nameStatus.stdout,
      numstat: numstat.stdout,
      shortstat: shortstat.stdout,
    };
  }

  private async readUntrackedDiffFileStats(
    untrackedPaths: string[],
  ): Promise<RawDiffFileStat[]> {
    if (untrackedPaths.length === 0) {
      return [];
    }
    return this.withTemporaryUntrackedIndex(untrackedPaths, async (env) => {
      const numstat = await this.runGit(
        ["diff", "--no-ext-diff", "--numstat", "-z"],
        { cwd: this.path, env },
      );
      const numstatByPath = new Map(
        parseNumstatEntriesZ(numstat.stdout).map(
          (entry) => [entry.path, entry] as const,
        ),
      );
      return untrackedPaths.map((relativePath) => {
        const entry = numstatByPath.get(relativePath);
        const binary =
          entry !== undefined &&
          entry.insertions === null &&
          entry.deletions === null;
        return {
          ...toUntrackedDiffFilePlaceholder(relativePath),
          additions: binary ? 0 : (entry?.insertions ?? 0),
          deletions: binary ? 0 : (entry?.deletions ?? 0),
          binary,
        };
      });
    });
  }

  private async readUntrackedPatchByPathCombined(args: {
    paths: string[];
    maxBytesPerFile: number;
  }): Promise<Map<string, string>> {
    if (args.paths.length === 0) {
      return new Map();
    }
    return this.withTemporaryUntrackedIndex(
      args.paths,
      async (env, indexedPaths) => {
        const [nameStatus, patch] = await Promise.all([
          this.runGit(["diff", "--no-ext-diff", "--name-status", "-z"], {
            cwd: this.path,
            env,
          }),
          this.runGit(["diff", "--no-ext-diff", "--binary"], {
            ...buildDiffOutputGitOptions(
              this.path,
              combinedPageBufferBudget(
                indexedPaths.length,
                args.maxBytesPerFile,
              ),
            ),
            env,
          }),
        ]);
        const entries = parseNameStatusSourceEntries(nameStatus.stdout);
        const sections = splitPatchIntoSections(patch.stdout);
        if (entries.length === sections.length) {
          return new Map(
            entries.map(
              (entry, index) => [entry.path, sections[index]] as const,
            ),
          );
        }

        const patchByPath = new Map<string, string>();
        for (const relativePath of indexedPaths) {
          const result = await this.runGit(
            [
              "diff",
              "--no-ext-diff",
              "--binary",
              "--",
              `:(literal)${relativePath}`,
            ],
            {
              ...buildDiffOutputGitOptions(this.path, args.maxBytesPerFile),
              env,
            },
          );
          patchByPath.set(relativePath, result.stdout);
        }
        return patchByPath;
      },
    );
  }

  private async readTrackedPatchByPathCombined(
    args: ReadTrackedPatchByPathArgs,
  ): Promise<Map<string, string>> {
    const combined = await this.readCombinedTrackedDiff(args);
    if (combined === null) {
      return new Map();
    }

    const entries = parseNameStatusSourceEntries(combined.nameStatus);
    const sections = splitPatchIntoSections(combined.patch);

    if (sections.length !== entries.length) {
      return this.readTrackedPatchByPathPerFile(args);
    }

    const patchByPath = new Map<string, string>();
    for (let index = 0; index < entries.length; index += 1) {
      patchByPath.set(entries[index].path, sections[index]);
    }
    return patchByPath;
  }

  private async readTrackedPatchByPathPerFile(
    args: ReadTrackedPatchByPathArgs,
  ): Promise<Map<string, string>> {
    const stats = await this.readDiffStatArtifacts(args.target);
    const previousPathByPath = new Map(
      parseNameStatusSourceEntries(stats.nameStatus).map(
        (entry) => [entry.path, entry.previousPath] as const,
      ),
    );

    const entries = await Promise.all(
      args.paths.map(async (path) => {
        const previousPath = previousPathByPath.get(path);
        const pathspec =
          previousPath != null && previousPath !== path
            ? [previousPath, path]
            : [path];
        const {
          artifacts: [diff],
        } = await this.readDiffArtifacts({
          target: args.target,
          paths: pathspec,
          maxDiffBytes: args.maxBytesPerFile,
        });
        return [path, diff] as const;
      }),
    );

    return new Map(entries);
  }

  private async readCombinedTrackedDiff(
    args: ReadTrackedPatchByPathArgs,
  ): Promise<{ nameStatus: string; patch: string } | null> {
    const range = await this.resolveTrackedDiffRange(args.target);
    if (range === null) {
      return null;
    }

    const runUncommittedDiff = createUncommittedDiffRunner(
      this.path,
      this.gitProcessOptions,
    );
    const runRangeGit = (
      buildArgs: (rangeArgs: string[]) => string[],
      options: RunGitOptions,
    ): Promise<GitCommandResult> =>
      range.usesUncommittedHead
        ? runUncommittedDiff((baseRef) => buildArgs([baseRef]), options)
        : this.runGit(buildArgs(range.rangeArgs), options);

    const fullNameStatus = await runRangeGit(
      (rangeArgs) => [
        ...range.baseArgs,
        "--name-status",
        "-z",
        "-M",
        ...rangeArgs,
      ],
      { cwd: this.path },
    );
    const requested = new Set(args.paths);
    const renameSources = parseNameStatusSourceEntries(fullNameStatus.stdout)
      .filter((entry) => requested.has(entry.path))
      .map((entry) => entry.previousPath)
      .filter(
        (previousPath): previousPath is string =>
          previousPath !== null && !requested.has(previousPath),
      );
    const pagePathspec = [...args.paths, ...renameSources];

    const [nameStatus, patch] = await Promise.all([
      runRangeGit(
        (rangeArgs) =>
          withDiffPathspec(
            [...range.baseArgs, "--name-status", "-z", "-M", ...rangeArgs],
            pagePathspec,
          ),
        { cwd: this.path },
      ),
      runRangeGit(
        (rangeArgs) =>
          withDiffPathspec(
            [...range.baseArgs, "--binary", "-M", ...rangeArgs],
            pagePathspec,
          ),
        buildDiffOutputGitOptions(
          this.path,
          combinedPageBufferBudget(pagePathspec.length, args.maxBytesPerFile),
        ),
      ),
    ]);

    return { nameStatus: nameStatus.stdout, patch: patch.stdout };
  }

  private async resolveTrackedDiffRange(
    target: WorkspaceDiffTarget,
  ): Promise<ResolvedTrackedDiffRange | null> {
    const diffBase = ["diff", "--no-ext-diff"];
    switch (target.type) {
      case "uncommitted":
        return {
          baseArgs: diffBase,
          rangeArgs: ["HEAD"],
          usesUncommittedHead: true,
          mergeBaseRef: null,
        };
      case "branch_committed":
      case "all": {
        const mergeBaseRef = await readMergeBaseRef(
          this.path,
          target.mergeBaseBranch,
          this.gitProcessOptions,
        );
        if (!mergeBaseRef) {
          return null;
        }
        const rangeArgs =
          target.type === "branch_committed"
            ? [`${mergeBaseRef}..HEAD`]
            : [mergeBaseRef];
        return {
          baseArgs: diffBase,
          rangeArgs,
          usesUncommittedHead: false,
          mergeBaseRef,
        };
      }
      case "commit":
        return {
          baseArgs: ["show", "--format=", "--no-ext-diff"],
          rangeArgs: [target.sha],
          usesUncommittedHead: false,
          mergeBaseRef: null,
        };
      default: {
        const _exhaustive: never = target;
        return _exhaustive;
      }
    }
  }

  private async readDiffArtifacts(
    args: ReadWorkspaceDiffArtifactsArgs,
  ): Promise<DiffArtifactsResult> {
    switch (args.target.type) {
      case "uncommitted": {
        const result = await this.readUncommittedDiffArtifacts({
          maxDiffBytes: args.maxDiffBytes,
          maxFileListBytes: args.maxFileListBytes,
          maxUntrackedFiles: args.maxUntrackedFiles,
          paths: args.paths,
        });
        return { ...result, mergeBaseRef: null };
      }
      case "branch_committed": {
        const mergeBaseRef = await readMergeBaseRef(
          this.path,
          args.target.mergeBaseBranch,
          this.gitProcessOptions,
        );
        if (!mergeBaseRef) {
          return {
            artifacts: ["", "", ""],
            mergeBaseRef: null,
            truncated: false,
          };
        }
        return {
          artifacts: await this.runDiffCommands(
            [`${mergeBaseRef}..HEAD`],
            [`${mergeBaseRef}..HEAD`],
            [`${mergeBaseRef}..HEAD`],
            {
              maxDiffBytes: args.maxDiffBytes,
              maxFileListBytes: args.maxFileListBytes,
              paths: args.paths,
            },
          ),
          mergeBaseRef,
          truncated: false,
        };
      }
      case "all": {
        const mergeBaseRef = await readMergeBaseRef(
          this.path,
          args.target.mergeBaseBranch,
          this.gitProcessOptions,
        );
        if (!mergeBaseRef) {
          return {
            artifacts: ["", "", ""],
            mergeBaseRef: null,
            truncated: false,
          };
        }
        {
          const result = await this.readDiffArtifactsIncludingUntracked({
            diffArgs: [mergeBaseRef],
            filesArgs: [mergeBaseRef],
            numstatArgs: [mergeBaseRef],
            maxDiffBytes: args.maxDiffBytes,
            maxFileListBytes: args.maxFileListBytes,
            maxUntrackedFiles: args.maxUntrackedFiles,
            paths: args.paths,
          });
          return { ...result, mergeBaseRef };
        }
      }
      case "commit": {
        const sha = args.target.sha;
        const [diff, shortstat, files] = await Promise.all([
          this.runGit(
            withDiffPathspec(
              ["show", "--format=", "--no-ext-diff", "--binary", sha],
              args.paths,
            ),
            buildDiffOutputGitOptions(this.path, args.maxDiffBytes),
          ),
          this.runGit(
            withDiffPathspec(
              ["show", "--format=", "--shortstat", sha],
              args.paths,
            ),
            { cwd: this.path },
          ),
          this.runGit(
            withDiffPathspec(
              ["show", "--format=", "--name-status", sha],
              args.paths,
            ),
            buildDiffOutputGitOptions(this.path, args.maxFileListBytes),
          ),
        ]);
        return {
          artifacts: [diff.stdout, shortstat.stdout, files.stdout],
          mergeBaseRef: null,
          truncated: false,
        };
      }
      default: {
        const _exhaustive: never = args.target;
        return _exhaustive;
      }
    }
  }

  private async runDiffCommands(
    diffArgs: string[],
    shortstatArgs: string[],
    filesArgs: string[],
    options: DiffOutputLimits & DiffPathSubset = {},
  ): Promise<[string, string, string]> {
    const [diff, shortstat, files] = await Promise.all([
      this.runGit(
        withDiffPathspec(
          ["diff", "--no-ext-diff", "--binary", ...diffArgs],
          options.paths,
        ),
        buildDiffOutputGitOptions(this.path, options.maxDiffBytes),
      ),
      this.runGit(
        withDiffPathspec(
          ["diff", "--no-ext-diff", "--shortstat", ...shortstatArgs],
          options.paths,
        ),
        { cwd: this.path },
      ),
      this.runGit(
        withDiffPathspec(
          ["diff", "--no-ext-diff", "--name-status", ...filesArgs],
          options.paths,
        ),
        buildDiffOutputGitOptions(this.path, options.maxFileListBytes),
      ),
    ]);

    return [diff.stdout, shortstat.stdout, files.stdout];
  }

  private async readDiffArtifactsIncludingUntracked(
    args: ReadDiffArtifactsArgs,
  ): Promise<DiffArtifactsWithTruncation> {
    const [trackedDiff, trackedNumstat, trackedFiles] = await Promise.all([
      this.runGit(
        withDiffPathspec(
          ["diff", "--no-ext-diff", "--binary", ...args.diffArgs],
          args.paths,
        ),
        buildDiffOutputGitOptions(this.path, args.maxDiffBytes),
      ),
      this.runGit(
        withDiffPathspec(
          ["diff", "--no-ext-diff", "--numstat", ...args.numstatArgs],
          args.paths,
        ),
        { cwd: this.path },
      ),
      this.runGit(
        withDiffPathspec(
          ["diff", "--no-ext-diff", "--name-status", ...args.filesArgs],
          args.paths,
        ),
        buildDiffOutputGitOptions(this.path, args.maxFileListBytes),
      ),
    ]);

    return this.appendUntrackedDiffArtifacts({
      diff: trackedDiff.stdout,
      files: trackedFiles.stdout,
      numstat: trackedNumstat.stdout,
      maxDiffBytes: args.maxDiffBytes,
      maxFileListBytes: args.maxFileListBytes,
      maxUntrackedFiles: args.maxUntrackedFiles,
      paths: args.paths,
    });
  }

  private async appendUntrackedDiffArtifacts(
    args: AppendUntrackedDiffArtifactsArgs,
  ): Promise<DiffArtifactsWithTruncation> {
    const untrackedPaths =
      args.paths !== undefined
        ? await this.listRequestedUntrackedPaths(args.paths)
        : args.maxUntrackedFiles !== undefined
          ? await this.listUntrackedPathsLimited(args.maxUntrackedFiles + 1)
          : await this.listUntrackedPaths();
    const requestedUntrackedPaths =
      args.paths === undefined
        ? untrackedPaths
        : untrackedPaths.filter((untrackedPath) =>
            args.paths?.includes(untrackedPath),
          );
    if (requestedUntrackedPaths.length === 0) {
      return {
        artifacts: [
          args.diff,
          formatShortstat(summarizeNumstat(args.numstat)),
          args.files,
        ],
        truncated: false,
      };
    }

    const selectedUntrackedPaths =
      args.maxUntrackedFiles === undefined
        ? requestedUntrackedPaths
        : requestedUntrackedPaths.slice(0, args.maxUntrackedFiles);
    const truncated =
      selectedUntrackedPaths.length < requestedUntrackedPaths.length;

    const untrackedArtifacts = await this.readUntrackedDiffArtifacts({
      relativePaths: selectedUntrackedPaths,
      maxDiffBytes: args.maxDiffBytes,
      maxFileListBytes: args.maxFileListBytes,
    });
    const combinedNumstat = joinDiffArtifactLines([
      args.numstat,
      untrackedArtifacts.numstat,
    ]);
    const combinedDiff = joinDiffArtifactOutput([
      args.diff,
      untrackedArtifacts.diff,
    ]);
    const combinedFiles = joinDiffArtifactOutput([
      args.files,
      untrackedArtifacts.files,
    ]);

    return {
      artifacts: [
        combinedDiff,
        formatShortstat(summarizeNumstat(combinedNumstat)),
        combinedFiles,
      ],
      truncated,
    };
  }

  private async readUntrackedDiffArtifacts(
    args: ReadUntrackedDiffArtifactsArgs,
  ): Promise<DiffArtifacts> {
    if (args.relativePaths.length === 0) {
      return { diff: "", files: "", numstat: "" };
    }
    return this.withTemporaryUntrackedIndex(args.relativePaths, async (env) => {
      const [diff, numstat, files] = await Promise.all([
        this.runGit(["diff", "--no-ext-diff", "--binary"], {
          ...buildDiffOutputGitOptions(this.path, args.maxDiffBytes),
          env,
        }),
        this.runGit(["diff", "--no-ext-diff", "--numstat"], {
          cwd: this.path,
          env,
        }),
        this.runGit(["diff", "--no-ext-diff", "--name-status"], {
          ...buildDiffOutputGitOptions(this.path, args.maxFileListBytes),
          env,
        }),
      ]);
      return {
        diff: diff.stdout,
        files: files.stdout,
        numstat: numstat.stdout,
      };
    });
  }

  private async readUncommittedDiffArtifacts(
    args: DiffOutputLimits & DiffPathSubset & { maxUntrackedFiles?: number },
  ): Promise<DiffArtifactsWithTruncation> {
    const runUncommittedDiff = createUncommittedDiffRunner(
      this.path,
      this.gitProcessOptions,
    );
    const [trackedDiff, trackedNumstat, trackedFiles] = await Promise.all([
      runUncommittedDiff(
        (baseRef) =>
          withDiffPathspec(
            ["diff", "--no-ext-diff", "--binary", baseRef],
            args.paths,
          ),
        buildDiffOutputGitOptions(this.path, args.maxDiffBytes),
      ),
      runUncommittedDiff(
        (baseRef) =>
          withDiffPathspec(
            ["diff", "--no-ext-diff", "--numstat", baseRef],
            args.paths,
          ),
        { cwd: this.path },
      ),
      runUncommittedDiff(
        (baseRef) =>
          withDiffPathspec(
            ["diff", "--no-ext-diff", "--name-status", baseRef],
            args.paths,
          ),
        buildDiffOutputGitOptions(this.path, args.maxFileListBytes),
      ),
    ]);

    return this.appendUntrackedDiffArtifacts({
      diff: trackedDiff.stdout,
      files: trackedFiles.stdout,
      numstat: trackedNumstat.stdout,
      maxDiffBytes: args.maxDiffBytes,
      maxFileListBytes: args.maxFileListBytes,
      maxUntrackedFiles: args.maxUntrackedFiles,
      paths: args.paths,
    });
  }

  private async withTemporaryUntrackedIndex<T>(
    relativePaths: readonly string[],
    work: (
      env: NodeJS.ProcessEnv,
      indexedPaths: readonly string[],
    ) => Promise<T>,
    options: { signal?: AbortSignal; timeoutMs?: number } = {},
  ): Promise<T> {
    const tempDir = await createTempDir("bb-untracked-index-");
    const indexPath = path.join(tempDir, "index");
    const pathspecPath = path.join(tempDir, "pathspec");
    const env = { GIT_INDEX_FILE: indexPath };
    try {
      let candidates = [...relativePaths];
      for (
        let attempt = 0;
        attempt < TEMPORARY_UNTRACKED_INDEX_ADD_ATTEMPTS;
        attempt += 1
      ) {
        candidates = await this.filterExistingUntrackedPaths(candidates);
        await this.runGit(["read-tree", "--empty"], {
          cwd: this.path,
          env,
          signal: options.signal,
          timeoutMs: options.timeoutMs,
        });
        if (candidates.length === 0) {
          return await work(env, []);
        }
        await fs.writeFile(
          pathspecPath,
          candidates.map((value) => `:(literal)${value}\0`).join(""),
        );
        const add = await this.runGit(
          [
            "add",
            "--sparse",
            "--intent-to-add",
            `--pathspec-from-file=${pathspecPath}`,
            "--pathspec-file-nul",
          ],
          {
            cwd: this.path,
            env,
            allowFailure: true,
            signal: options.signal,
            timeoutMs: options.timeoutMs,
          },
        );
        if (add.exitCode === 0) {
          return await work(env, candidates);
        }
        const refreshedCandidates =
          await this.filterExistingUntrackedPaths(candidates);
        if (refreshedCandidates.length === candidates.length) {
          const detail = add.stderr.trim();
          throw new WorkspaceError(
            "git_command_failed",
            `git add --intent-to-add failed${detail ? `: ${detail}` : ""}`,
          );
        }
        candidates = refreshedCandidates;
      }

      await this.runGit(["read-tree", "--empty"], {
        cwd: this.path,
        env,
        signal: options.signal,
        timeoutMs: options.timeoutMs,
      });
      return await work(env, []);
    } finally {
      await fs.rm(tempDir, { recursive: true, force: true });
    }
  }

  private async filterExistingUntrackedPaths(
    relativePaths: readonly string[],
  ): Promise<string[]> {
    const existing = await Promise.all(
      relativePaths.map(async (relativePath) => {
        try {
          const stats = await fs.lstat(path.join(this.path, relativePath));
          return stats.isFile() || stats.isSymbolicLink() ? relativePath : null;
        } catch (error) {
          if (
            error instanceof Error &&
            "code" in error &&
            error.code === "ENOENT"
          ) {
            return null;
          }
          throw error;
        }
      }),
    );
    return existing.filter((value): value is string => value !== null);
  }

  private async listUntrackedPaths(): Promise<string[]> {
    const untrackedFilesOutput = await this.runGit(
      ["ls-files", "--others", "--exclude-standard", "-z"],
      { cwd: this.path },
    );
    return parseNullSeparatedLines(untrackedFilesOutput.stdout);
  }

  private async listRequestedUntrackedPaths(
    relativePaths: readonly string[],
  ): Promise<string[]> {
    if (relativePaths.length === 0) {
      return [];
    }
    const untrackedFilesOutput = await this.runGit(
      [
        "ls-files",
        "--others",
        "--exclude-standard",
        "-z",
        "--",
        ...relativePaths.map((relativePath) => `:(literal)${relativePath}`),
      ],
      { cwd: this.path },
    );
    return parseNullSeparatedLines(untrackedFilesOutput.stdout);
  }

  private async listUntrackedPathsLimited(maxPaths: number): Promise<string[]> {
    const untrackedFilesOutput = await this.runGitWithNullRecordLimit(
      ["ls-files", "--others", "--exclude-standard", "-z"],
      { cwd: this.path },
      "single",
      maxPaths,
    );
    return parseNullSeparatedLines(untrackedFilesOutput.stdout);
  }
}

function joinDiffArtifactLines(parts: string[]): string {
  return parts
    .map((value) => value.trimEnd())
    .filter((value) => value.length > 0)
    .join("\n");
}

function assertPositiveInteger(value: number, field: string): void {
  if (!Number.isInteger(value) || value <= 0) {
    throw new WorkspaceError(
      "invalid_request",
      `${field} must be a positive integer`,
    );
  }
}

function toUntrackedDiffFilePlaceholder(path: string): RawDiffFileStat {
  return {
    path,
    previousPath: null,
    statusLetter: "A",
    additions: 0,
    deletions: 0,
    binary: false,
    origin: "untracked",
  };
}

function joinDiffArtifactOutput(parts: string[]): string {
  const combined = joinDiffArtifactLines(parts);
  return combined.length > 0 ? `${combined}\n` : "";
}

const DIFF_SECTION_HEADER = "diff --git ";

function splitPatchIntoSections(combinedPatch: string): string[] {
  if (combinedPatch.length === 0) {
    return [];
  }
  const lines = combinedPatch.split("\n");
  const sections: string[][] = [];
  let current: string[] | null = null;
  for (const line of lines) {
    if (line.startsWith(DIFF_SECTION_HEADER)) {
      if (current !== null) {
        sections.push(current);
      }
      current = [line];
      continue;
    }
    if (current !== null) {
      current.push(line);
    }
  }
  if (current !== null) {
    sections.push(current);
  }
  return sections.map((sectionLines) => formatPatchSection(sectionLines));
}

function formatPatchSection(lines: string[]): string {
  let end = lines.length;
  while (end > 0 && lines[end - 1] === "") {
    end -= 1;
  }
  if (end === 0) {
    return "";
  }
  const body = lines.slice(0, end);
  const isBinary = body.some((line) => line === "GIT binary patch");
  return `${body.join("\n")}\n${isBinary ? "\n" : ""}`;
}

const NAME_STATUS_LETTERS = new Set(["A", "M", "D", "R", "C", "T"]);

function normalizeNameStatusLetter(
  status: string,
): RawDiffFileStat["statusLetter"] {
  const letter = status[0] ?? "";
  if (NAME_STATUS_LETTERS.has(letter)) {
    return letter as RawDiffFileStat["statusLetter"];
  }
  return "M";
}

function truncatePatchToMaxBytes(
  patch: string,
  maxBytes: number,
): { patch: string; truncated: boolean } {
  if (maxBytes <= 0) {
    return { patch, truncated: false };
  }
  if (Buffer.byteLength(patch, "utf8") <= maxBytes) {
    return { patch, truncated: false };
  }
  return { patch: truncateToMaxBytes(patch, maxBytes), truncated: true };
}
