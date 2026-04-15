import type {
  ThreadGitDiffResponse,
  WorkspaceCommitSummary,
  WorkspaceDiffTarget,
  WorkspaceFileStatus,
  WorkspaceFileStatusKind,
  WorkspaceStatus,
} from "@bb/domain";
import path from "node:path";
import {
  createTempDir,
  detectGitRepo,
  ensureGitRepo,
  getCurrentBranch,
  hasRef,
  hasUncommittedChanges,
  listBranches,
  parseNameStatusEntries,
  parsePorcelainEntries,
  pathExists,
  readDefaultBranch,
  readMergeBaseRef,
  parsePatchId,
  revParse,
  runGit,
  runShellPipeline,
  summarizeNumstat,
  WorkspaceError,
} from "./git.js";
import fs from "node:fs/promises";

export interface DiffOptions {
  target?: WorkspaceDiffTarget;
  maxDiffBytes?: number;
  maxFileListBytes?: number;
}

export interface StatusOptions {
  mergeBaseBranch?: string;
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

export interface FetchOptions {
  remote?: string;
  branch?: string;
}

export interface SquashMergeOptions {
  targetBranch: string;
  commitMessage: string;
}

export interface SquashMergeResult {
  merged: boolean;
  commitSha: string;
  targetBranch: string;
}

type DiffSummary = {
  diff: string;
  files: string;
  shortstat: string;
  truncated: boolean;
};

type DiffArtifacts = {
  diff: string;
  files: string;
  numstat: string;
};

type WorktreeEntry = {
  path: string;
  branchRef: string | null;
};

type SquashMergeTarget =
  | {
      kind: "local";
      baseRef: string;
      expectedSha: string;
    }
  | {
      kind: "remote";
      baseRef: string;
    };

type PublishSquashMergeCommitArgs = {
  targetBranch: string;
  target: SquashMergeTarget;
  commitSha: string;
};

type ReadDiffArtifactsArgs = {
  diffArgs: string[];
  filesArgs: string[];
  numstatArgs: string[];
};

interface ListWorkspaceFilesRecursivelyArgs {
  dir: string;
  root: string;
}

const UNTRACKED_DIFF_BATCH_SIZE = 10;

function countWorktrees(porcelainOutput: string): number {
  return parseWorktreeList(porcelainOutput).length;
}

function parseWorktreeList(porcelainOutput: string): WorktreeEntry[] {
  const entries: WorktreeEntry[] = [];
  let currentPath: string | null = null;
  let currentBranchRef: string | null = null;

  for (const line of porcelainOutput.split("\n")) {
    if (line === "") {
      if (currentPath !== null) {
        entries.push({ path: currentPath, branchRef: currentBranchRef });
      }
      currentPath = null;
      currentBranchRef = null;
      continue;
    }

    if (line.startsWith("worktree ")) {
      currentPath = line.slice("worktree ".length);
      continue;
    }

    if (line.startsWith("branch ")) {
      currentBranchRef = line.slice("branch ".length);
    }
  }

  if (currentPath !== null) {
    entries.push({ path: currentPath, branchRef: currentBranchRef });
  }

  return entries;
}

function resolveWorkspaceFileStatusKind(args: {
  indexStatus: string;
  status: string;
  worktreeStatus: string;
}): WorkspaceFileStatusKind {
  if (args.status === "??") {
    return "??";
  }
  if (args.indexStatus === "U" || args.worktreeStatus === "U" || args.status.includes("U")) {
    return "U";
  }
  if (args.indexStatus === "R" || args.worktreeStatus === "R" || args.status.includes("R")) {
    return "R";
  }
  if (args.indexStatus === "C" || args.worktreeStatus === "C" || args.status.includes("C")) {
    return "C";
  }
  if (args.indexStatus === "A" || args.worktreeStatus === "A" || args.status.includes("A")) {
    return "A";
  }
  if (args.indexStatus === "D" || args.worktreeStatus === "D" || args.status.includes("D")) {
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
    // Type change (e.g. file ↔ symlink). Render as a modification — the
    // WorkspaceFileStatusKind enum doesn't model type changes separately.
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
  if (!args.hasTrackedChanges && !args.hasUntracked && !args.hasCommittedChanges) {
    return "clean";
  }
  if ((args.hasTrackedChanges || args.hasUntracked) && args.hasCommittedChanges) {
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
  return output
    .split("\0")
    .filter((value) => value.length > 0);
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

function isNotGitRepositoryError(stderr: string): boolean {
  return stderr.includes("not a git repository");
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
      results.push(
        ...(await listWorkspaceFilesRecursively({
          dir: fullPath,
          root: args.root,
        })),
      );
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

async function readHeadNumstat(workspacePath: string): Promise<string> {
  const result = await runGit(["diff", "--numstat", "HEAD", "--"], {
    cwd: workspacePath,
    allowFailure: true,
  });
  if (result.exitCode === 0) {
    return result.stdout;
  }
  if (isMissingHeadRevisionError(result.stderr)) {
    return "";
  }
  const detail = result.stderr.trim();
  throw new WorkspaceError(
    "git_command_failed",
    `git diff --numstat HEAD -- failed${detail ? `: ${detail}` : ""}`,
  );
}

export class Workspace {
  readonly path: string;

  constructor(path: string) {
    this.path = path;
  }

  get exists(): Promise<boolean> {
    return pathExists(this.path);
  }

  get isGitRepo(): Promise<boolean> {
    return detectGitRepo(this.path);
  }

  get currentBranch(): Promise<string | undefined> {
    return getCurrentBranch(this.path);
  }

  async getStatus(options: StatusOptions = {}): Promise<WorkspaceStatus> {
    await ensureGitRepo(this.path);

    const mergeBaseBranch = options.mergeBaseBranch;
    const [statusOutput, diffOutput, currentBranch, defaultBranch] = await Promise.all([
      runGit(
        ["status", "--porcelain=v1", "--branch", "--untracked-files=all"],
        { cwd: this.path },
      ),
      readHeadNumstat(this.path),
      this.currentBranch,
      readDefaultBranch(this.path),
    ]);

    const entries = parsePorcelainEntries(statusOutput.stdout);
    const workingTreeSummary = summarizeNumstat(diffOutput);
    const hasUntracked = entries.some((entry) => entry.status === "??");
    const hasTrackedChanges = entries.some((entry) => entry.status !== "??");
    const hasDirtyEntries = entries.length > 0;
    const mergeBaseData = mergeBaseBranch
      ? await this.readMergeBaseStatus(mergeBaseBranch)
      : null;
    const hasCommittedChanges = mergeBaseData?.hasCommittedUnmergedChanges ?? false;
    const state = resolveWorkspaceState({
      hasCommittedChanges,
      hasTrackedChanges,
      hasUntracked,
    });

    return {
      workingTree: {
        hasUncommittedChanges: hasDirtyEntries,
        state,
        changedFiles: entries.length,
        insertions: workingTreeSummary.insertions,
        deletions: workingTreeSummary.deletions,
        files: entries.map((entry) => ({
          path: entry.path,
          status: resolveWorkspaceFileStatusKind({
            indexStatus: entry.indexStatus,
            status: entry.status,
            worktreeStatus: entry.worktreeStatus,
          }),
        })),
      },
      branch: {
        currentBranch: currentBranch ?? null,
        defaultBranch: defaultBranch ?? currentBranch ?? "",
      },
      mergeBase: mergeBaseData,
    };
  }

  async getLocalStateFingerprint(): Promise<string> {
    const [headSha, status] = await Promise.all([
      this.getHeadSha(),
      this.getStatus(),
    ]);
    return JSON.stringify({
      currentBranch: status.branch.currentBranch,
      headSha,
      workingTree: status.workingTree,
    });
  }

  async getSharedGitRefsFingerprint(): Promise<string> {
    await ensureGitRepo(this.path);

    const [refs, remoteHead] = await Promise.all([
      runGit(
        ["for-each-ref", "--format=%(refname)%00%(objectname)", "refs/heads", "refs/remotes"],
        { cwd: this.path },
      ),
      runGit(
        ["symbolic-ref", "--quiet", "refs/remotes/origin/HEAD"],
        { cwd: this.path, allowFailure: true },
      ),
    ]);

    return JSON.stringify({
      refs: parseNonEmptyLines(refs.stdout),
      remoteHead: remoteHead.exitCode === 0 ? remoteHead.stdout.trim() : "",
    });
  }

  async getDiff(options: DiffOptions = {}): Promise<DiffResult> {
    await ensureGitRepo(this.path);

    const target = options.target ?? { type: "uncommitted" as const };
    return this.buildDiffSummary({
      maxDiffBytes: options.maxDiffBytes,
      maxFileListBytes: options.maxFileListBytes,
      target,
    });
  }

  async getHeadSha(): Promise<string | null> {
    await ensureGitRepo(this.path);

    const result = await runGit(["rev-parse", "HEAD"], {
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

  async getBranches(): Promise<string[]> {
    return listBranches(this.path);
  }

  async listFiles(): Promise<string[]> {
    const gitResult = await runGit(
      ["ls-files", "--cached", "--others", "--exclude-standard"],
      { allowFailure: true, cwd: this.path },
    );
    if (gitResult.exitCode === 0) {
      return parseNonEmptyLines(gitResult.stdout).sort();
    }
    if (
      gitResult.exitCode === 128 ||
      isNotGitRepositoryError(gitResult.stderr)
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
    await ensureGitRepo(this.path);

    await runGit(["add", "-A"], { cwd: this.path });
    const commitArgs = ["commit", "-m", options.message];
    if (options.noVerify) {
      commitArgs.push("--no-verify");
    }
    await runGit(commitArgs, { cwd: this.path });
    const commitSha = await revParse(this.path, "HEAD");
    const commitSubject = (
      await runGit(["log", "-1", "--pretty=%s"], { cwd: this.path })
    ).stdout.trim();

    return { commitSha, commitSubject };
  }

  async reset(): Promise<void> {
    await ensureGitRepo(this.path);
    await runGit(["reset", "--hard", "HEAD"], { cwd: this.path });
    await runGit(["clean", "-fd"], { cwd: this.path });
  }

  async fetch(options: FetchOptions = {}): Promise<void> {
    await ensureGitRepo(this.path);

    const remote = options.remote ?? "origin";
    const args = ["fetch", remote];
    if (options.branch) {
      args.push(options.branch);
    }

    await runGit(args, { cwd: this.path });
  }

  async checkoutBranch(branchName: string): Promise<void> {
    await ensureGitRepo(this.path);

    if ((await this.currentBranch) === branchName) {
      return;
    }

    if (await hasRef(this.path, `refs/heads/${branchName}`)) {
      await runGit(["checkout", branchName], { cwd: this.path });
      return;
    }

    if (await hasRef(this.path, `refs/remotes/origin/${branchName}`)) {
      await runGit(["checkout", "-B", branchName, `origin/${branchName}`], {
        cwd: this.path,
      });
      await runGit(
        ["branch", "--set-upstream-to", `origin/${branchName}`, branchName],
        { cwd: this.path },
      );
      return;
    }

    await runGit(["checkout", "-B", branchName], { cwd: this.path });
  }

  async detachHead(): Promise<void> {
    await ensureGitRepo(this.path);

    if ((await this.currentBranch) === undefined) {
      return;
    }

    await runGit(["checkout", "--detach"], { cwd: this.path });
  }

  async stash(message = "bb-workspace-stash"): Promise<string | null> {
    await ensureGitRepo(this.path);

    if (!(await hasUncommittedChanges(this.path))) {
      return null;
    }

    await runGit(["stash", "push", "--include-untracked", "-m", message], {
      cwd: this.path,
    });
    const ref = await runGit(["stash", "list", "-1", "--format=%gd"], {
      cwd: this.path,
    });
    return ref.stdout.trim() || null;
  }

  async stashPop(ref?: string): Promise<void> {
    await ensureGitRepo(this.path);

    const args = ["stash", "pop"];
    if (ref) {
      args.push(ref);
    }
    await runGit(args, { cwd: this.path });
  }

  async squashMergeInto(options: SquashMergeOptions): Promise<SquashMergeResult> {
    await ensureGitRepo(this.path);

    const sourceBranch = await this.currentBranch;
    if (!sourceBranch) {
      throw new WorkspaceError("detached_head", "Cannot squash merge from a detached workspace");
    }

    const target = await this.resolveSquashMergeTarget(options.targetBranch);
    const tempDir = await createTempDir("bb-squash-");
    const worktreeCountBefore = await runGit(["worktree", "list", "--porcelain"], {
      cwd: this.path,
    });

    try {
      await runGit(["worktree", "add", "--detach", tempDir, target.baseRef], {
        cwd: this.path,
      });
      await runGit(["merge", "--squash", sourceBranch], { cwd: tempDir });
      await runGit(["commit", "--no-verify", "-m", options.commitMessage], { cwd: tempDir });
      const commitSha = await revParse(tempDir, "HEAD");
      await this.publishSquashMergeCommit({
        targetBranch: options.targetBranch,
        target,
        commitSha,
      });

      return {
        merged: true,
        commitSha,
        targetBranch: options.targetBranch,
      };
    } finally {
      await runGit(["worktree", "remove", tempDir, "--force"], {
        cwd: this.path,
        allowFailure: true,
      });
      await fs.rm(tempDir, { recursive: true, force: true });

      const worktreeCountAfter = await runGit(
        ["worktree", "list", "--porcelain"],
        { cwd: this.path },
      );
      if (
        countWorktrees(worktreeCountBefore.stdout) !==
        countWorktrees(worktreeCountAfter.stdout)
      ) {
        throw new WorkspaceError("worktree_cleanup_failed", "Temporary worktree cleanup failed");
      }
    }
  }

  private async resolveSquashMergeTarget(targetBranch: string): Promise<SquashMergeTarget> {
    const localRef = `refs/heads/${targetBranch}`;
    if (await hasRef(this.path, localRef)) {
      return {
        kind: "local",
        baseRef: localRef,
        expectedSha: await revParse(this.path, localRef),
      };
    }

    const remoteRef = `refs/remotes/origin/${targetBranch}`;
    if (await hasRef(this.path, remoteRef)) {
      return {
        kind: "remote",
        baseRef: remoteRef,
      };
    }

    throw new WorkspaceError(
      "branch_not_found",
      `Target branch does not exist: ${targetBranch}`,
    );
  }

  private async publishSquashMergeCommit(
    args: PublishSquashMergeCommitArgs,
  ): Promise<void> {
    const checkedOutTargetPath = await this.findWorktreePathForBranch(args.targetBranch);
    if (checkedOutTargetPath !== null) {
      if (await hasUncommittedChanges(checkedOutTargetPath)) {
        throw new WorkspaceError(
          "dirty_target_branch",
          `Cannot squash merge into ${args.targetBranch}: target branch is checked out at ${checkedOutTargetPath} with uncommitted changes`,
        );
      }

      await runGit(["merge", "--ff-only", args.commitSha], {
        cwd: checkedOutTargetPath,
      });
      return;
    }

    switch (args.target.kind) {
      case "local":
        await runGit(
          [
            "update-ref",
            `refs/heads/${args.targetBranch}`,
            args.commitSha,
            args.target.expectedSha,
          ],
          { cwd: this.path },
        );
        return;
      case "remote":
        await runGit(["branch", args.targetBranch, args.commitSha], {
          cwd: this.path,
        });
        return;
      default: {
        const _exhaustive: never = args.target;
        return _exhaustive;
      }
    }
  }

  private async findWorktreePathForBranch(branchName: string): Promise<string | null> {
    const entries = await this.listWorktrees();
    const branchRef = `refs/heads/${branchName}`;
    return entries.find((entry) => entry.branchRef === branchRef)?.path ?? null;
  }

  private async listWorktrees(): Promise<WorktreeEntry[]> {
    const result = await runGit(["worktree", "list", "--porcelain"], {
      cwd: this.path,
    });
    return parseWorktreeList(result.stdout);
  }

  private async buildDiffSummary(args: {
    target: WorkspaceDiffTarget;
    maxDiffBytes?: number;
    maxFileListBytes?: number;
  }): Promise<DiffSummary> {
    const [rawDiff, shortstat, rawFiles] = await this.readDiffArtifacts(args.target);

    const diffTruncated =
      typeof args.maxDiffBytes === "number" && rawDiff.length > args.maxDiffBytes;
    const fileTruncated =
      typeof args.maxFileListBytes === "number" && rawFiles.length > args.maxFileListBytes;
    const truncated = diffTruncated || fileTruncated;

    return {
      diff: diffTruncated ? rawDiff.slice(0, args.maxDiffBytes) : rawDiff,
      files: fileTruncated ? rawFiles.slice(0, args.maxFileListBytes) : rawFiles,
      shortstat,
      truncated,
    };
  }

  private async readPatchUniqueCommitSummaries(
    mergeBaseBranch: string,
  ): Promise<WorkspaceCommitSummary[]> {
    const log = await runGit(
      [
        "log",
        "--cherry-pick",
        "--right-only",
        "--reverse",
        "--format=%H%x1f%h%x1f%s%x1f%an%x1f%at",
        `${mergeBaseBranch}...HEAD`,
      ],
      { cwd: this.path, allowFailure: true },
    );

    return log.stdout
      .split("\n")
      .filter(Boolean)
      .map((line) => {
        const [sha, shortSha, subject, authorName, authoredAt] = line.split("\u001f");
        return {
          sha,
          shortSha,
          subject,
          authorName: authorName ?? "",
          authoredAt: Number.parseInt(authoredAt ?? "0", 10) * 1000,
        };
      });
  }

  private async readMergeBaseStatus(mergeBaseBranch: string): Promise<WorkspaceStatus["mergeBase"]> {
    const [mergeBaseRef, aheadBehindCounts, commits, nameStatus] = await Promise.all([
      readMergeBaseRef(this.path, mergeBaseBranch),
      runGit(
        [
          "rev-list",
          // Ignore patch-equivalent commits so squash-merged branches are not still ahead.
          "--cherry-pick",
          "--left-right",
          "--count",
          `${mergeBaseBranch}...HEAD`,
        ],
        { cwd: this.path },
      ),
      this.readPatchUniqueCommitSummaries(mergeBaseBranch),
      runGit(
        ["diff", "--no-ext-diff", "--name-status", "-z", `${mergeBaseBranch}...HEAD`],
        { cwd: this.path, allowFailure: true },
      ),
    ]);
    const [behindCount, aheadCount] = aheadBehindCounts.stdout
      .trim()
      .split(/\s+/)
      .map((value) => Number.parseInt(value, 10));
    let normalizedAheadCount = Number.isFinite(aheadCount) ? aheadCount : 0;
    const normalizedBehindCount = Number.isFinite(behindCount) ? behindCount : 0;
    let effectiveCommits = commits;
    let effectiveFiles: WorkspaceFileStatus[] = nameStatus.exitCode === 0
      ? parseNameStatusEntries(nameStatus.stdout).map((entry) => ({
          path: entry.path,
          status: mapNameStatusLetter(entry.status),
        }))
      : [];

    // `--cherry-pick` handles regular merges, rebase-merges, and cherry-picks,
    // but not squash merges. Only look for a squash when the branch still
    // appears ahead AND the base has advanced since the fork point — if the
    // base hasn't moved, no squash could exist there.
    if (normalizedAheadCount > 0 && normalizedBehindCount > 0 && mergeBaseRef) {
      const squashMerged = await this.detectSquashMerge(mergeBaseRef, mergeBaseBranch);
      if (squashMerged) {
        normalizedAheadCount = 0;
        effectiveCommits = [];
      }
    }

    // `commits` is cherry-pick-filtered (patch-equivalent commits that already
    // exist on the base are excluded), but `--name-status <base>...HEAD` is
    // not. If every branch commit has landed on the base via cherry-pick or
    // squash merge, there's nothing "committed unmerged" to surface — drop
    // the file list to match so the UI doesn't show files with no commits
    // behind them.
    if (effectiveCommits.length === 0) {
      effectiveFiles = [];
    }

    return {
      mergeBaseBranch,
      baseRef: mergeBaseRef ?? null,
      aheadCount: normalizedAheadCount,
      behindCount: normalizedBehindCount,
      hasCommittedUnmergedChanges: normalizedAheadCount > 0,
      commits: effectiveCommits,
      files: effectiveFiles,
    };
  }

  /**
   * Detect whether the branch has already landed on the base as a squash
   * merge. A squash collapses N branch commits into a single base commit with
   * a combined patch-id that none of the originals match, so `--cherry-pick`
   * can't see it. Compare the branch's cumulative patch-id against each
   * commit on the base since the merge-base; a match means the branch
   * landed. If the cumulative diff is empty (e.g. commits that cancel out),
   * treat the branch as merged — there's nothing left to land.
   *
   * The diff/log pipelines are offloaded to `sh -c` so git streams directly
   * into `git patch-id` without Node buffering the intermediate output; only
   * the tiny patch-id output (one line per commit) is captured.
   */
  private async detectSquashMerge(
    mergeBaseRef: string,
    mergeBaseBranch: string,
  ): Promise<boolean> {
    const branchPatchIdResult = await runShellPipeline(
      'git diff "$1".."$2" | git patch-id --stable',
      [mergeBaseRef, "HEAD"],
      { cwd: this.path, allowFailure: true },
    );
    if (branchPatchIdResult.exitCode !== 0) {
      return false;
    }
    if (!branchPatchIdResult.stdout.trim()) {
      // Empty cumulative diff — the branch contributes no net changes and is
      // effectively merged.
      return true;
    }
    const branchPatchId = parsePatchId(branchPatchIdResult.stdout.split("\n")[0]);
    if (!branchPatchId) {
      return false;
    }

    // Cap the base-side scan to keep `getStatus` bounded on long-divergent
    // branches. Squash merges we care about land within a reasonable window;
    // if the user opens a branch that's thousands of commits behind, we'll
    // miss detection and report the branch as ahead — the fallback is
    // pessimistic but correct.
    const basePatchIdsResult = await runShellPipeline(
      'git log -p -n 1000 --format="commit %H" "$1".."$2" | git patch-id --stable',
      [mergeBaseRef, mergeBaseBranch],
      { cwd: this.path, allowFailure: true },
    );
    if (basePatchIdsResult.exitCode !== 0) {
      return false;
    }
    return basePatchIdsResult.stdout
      .split("\n")
      .some((line) => parsePatchId(line) === branchPatchId);
  }

  private async readDiffArtifacts(target: WorkspaceDiffTarget): Promise<[string, string, string]> {
    switch (target.type) {
      case "uncommitted":
        return this.readUncommittedDiffArtifacts();
      case "branch_committed": {
        const mergeBaseRef = await readMergeBaseRef(this.path, target.mergeBaseBranch);
        if (!mergeBaseRef) {
          return ["", "", ""];
        }
        return this.runDiffCommands(
          [`${mergeBaseRef}..HEAD`],
          [`${mergeBaseRef}..HEAD`],
          [`${mergeBaseRef}..HEAD`],
        );
      }
      case "all": {
        const mergeBaseRef = await readMergeBaseRef(this.path, target.mergeBaseBranch);
        if (!mergeBaseRef) {
          return ["", "", ""];
        }
        return this.readDiffArtifactsIncludingUntracked({
          diffArgs: [mergeBaseRef],
          filesArgs: [mergeBaseRef],
          numstatArgs: [mergeBaseRef],
        });
      }
      case "commit": {
        const [diff, shortstat, files] = await Promise.all([
          runGit(["show", "--format=", "--no-ext-diff", "--binary", target.sha], {
            cwd: this.path,
          }),
          runGit(["show", "--format=", "--shortstat", target.sha], {
            cwd: this.path,
          }),
          runGit(["show", "--format=", "--name-status", target.sha], {
            cwd: this.path,
          }),
        ]);
        return [diff.stdout, shortstat.stdout, files.stdout];
      }
      default: {
        const _exhaustive: never = target;
        return _exhaustive;
      }
    }
  }

  private async runDiffCommands(
    diffArgs: string[],
    shortstatArgs: string[],
    filesArgs: string[],
  ): Promise<[string, string, string]> {
    const [diff, shortstat, files] = await Promise.all([
      runGit(["diff", "--no-ext-diff", "--binary", ...diffArgs], {
        cwd: this.path,
      }),
      runGit(["diff", "--no-ext-diff", "--shortstat", ...shortstatArgs], {
        cwd: this.path,
      }),
      runGit(["diff", "--no-ext-diff", "--name-status", ...filesArgs], {
        cwd: this.path,
      }),
    ]);

    return [diff.stdout, shortstat.stdout, files.stdout];
  }

  private async readDiffArtifactsIncludingUntracked(
    args: ReadDiffArtifactsArgs,
  ): Promise<[string, string, string]> {
    const [trackedDiff, trackedNumstat, trackedFiles] = await Promise.all([
      runGit(["diff", "--no-ext-diff", "--binary", ...args.diffArgs], {
        cwd: this.path,
      }),
      runGit(["diff", "--no-ext-diff", "--numstat", ...args.numstatArgs], {
        cwd: this.path,
      }),
      runGit(["diff", "--no-ext-diff", "--name-status", ...args.filesArgs], {
        cwd: this.path,
      }),
    ]);

    return this.appendUntrackedDiffArtifacts({
      diff: trackedDiff.stdout,
      files: trackedFiles.stdout,
      numstat: trackedNumstat.stdout,
    });
  }

  private async appendUntrackedDiffArtifacts(
    args: DiffArtifacts,
  ): Promise<[string, string, string]> {
    const untrackedFilesOutput = await runGit(
      ["ls-files", "--others", "--exclude-standard", "-z"],
      { cwd: this.path },
    );
    const untrackedPaths = parseNullSeparatedLines(untrackedFilesOutput.stdout);
    if (untrackedPaths.length === 0) {
      return [
        args.diff,
        formatShortstat(summarizeNumstat(args.numstat)),
        args.files,
      ];
    }

    const untrackedArtifacts = await this.readUntrackedDiffArtifacts(untrackedPaths);
    const combinedNumstat = joinDiffArtifactLines([
      args.numstat,
      ...untrackedArtifacts.map((artifact) => artifact.numstat),
    ]);
    const combinedDiff = joinDiffArtifactOutput([
      args.diff,
      ...untrackedArtifacts.map((artifact) => artifact.diff),
    ]);
    const combinedFiles = joinDiffArtifactOutput([
      args.files,
      ...untrackedArtifacts.map((artifact) => artifact.files),
    ]);

    return [
      combinedDiff,
      formatShortstat(summarizeNumstat(combinedNumstat)),
      combinedFiles,
    ];
  }

  private async readUntrackedDiffArtifacts(relativePaths: string[]): Promise<DiffArtifacts[]> {
    const artifacts: DiffArtifacts[] = [];

    for (
      let index = 0;
      index < relativePaths.length;
      index += UNTRACKED_DIFF_BATCH_SIZE
    ) {
      const batchPaths = relativePaths.slice(index, index + UNTRACKED_DIFF_BATCH_SIZE);
      artifacts.push(
        ...await Promise.all(
          batchPaths.map((relativePath) => this.readUntrackedDiffArtifact(relativePath)),
        ),
      );
    }

    return artifacts;
  }

  private async readUntrackedDiffArtifact(relativePath: string): Promise<DiffArtifacts> {
    const [diff, numstat, files] = await Promise.all([
      runGit(
        ["diff", "--no-index", "--no-ext-diff", "--binary", "--", "/dev/null", relativePath],
        { cwd: this.path, allowFailure: true },
      ),
      runGit(
        ["diff", "--no-index", "--numstat", "--", "/dev/null", relativePath],
        { cwd: this.path, allowFailure: true },
      ),
      runGit(
        ["diff", "--no-index", "--name-status", "--", "/dev/null", relativePath],
        { cwd: this.path, allowFailure: true },
      ),
    ]);

    return {
      diff: diff.stdout,
      files: files.stdout,
      numstat: numstat.stdout,
    };
  }

  private async readUncommittedDiffArtifacts(): Promise<[string, string, string]> {
    return this.readDiffArtifactsIncludingUntracked({
      diffArgs: ["HEAD", "--"],
      filesArgs: ["HEAD", "--"],
      numstatArgs: ["HEAD", "--"],
    });
  }
}

function joinDiffArtifactLines(parts: string[]): string {
  return parts
    .map((value) => value.trimEnd())
    .filter((value) => value.length > 0)
    .join("\n");
}

function joinDiffArtifactOutput(parts: string[]): string {
  const combined = joinDiffArtifactLines(parts);
  return combined.length > 0 ? `${combined}\n` : "";
}
