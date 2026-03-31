import type {
  ThreadGitDiffResponse,
  WorkspaceCommitSummary,
  WorkspaceDiffTarget,
  WorkspaceFileStatusKind,
  WorkspaceStatus,
} from "@bb/domain";
import {
  createTempDir,
  detectGitRepo,
  ensureGitRepo,
  getCurrentBranch,
  hasRef,
  hasUncommittedChanges,
  listBranches,
  parsePorcelainEntries,
  pathExists,
  readDefaultBranch,
  readMergeBaseRef,
  revParse,
  runGit,
  summarizeNumstat,
  WorkspaceError,
} from "./git.js";
import fs from "node:fs/promises";

export interface DiffOptions {
  target?: WorkspaceDiffTarget;
  maxBytes?: number;
}

export interface StatusOptions {
  mergeBaseBranch?: string;
}

export type DiffResult = ThreadGitDiffResponse;

export interface CommitOptions {
  message: string;
}

export interface CommitResult {
  commitSha: string;
  commitSubject: string;
}

export interface FetchOptions {
  remote?: string;
  branch?: string;
}

export interface CheckpointOptions {
  commitMessage: string;
}

export interface CheckpointResult {
  commitSha: string;
  branchName: string;
  remoteName: string;
}

export interface SquashMergeOptions {
  targetBranch: string;
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

const SQUASH_MERGE_PREP_COMMIT_MESSAGE = "bb squash merge prep";
const SQUASH_MERGE_COMMIT_MESSAGE = "bb squash merge";

function countWorktrees(porcelainOutput: string): number {
  return porcelainOutput
    .split("\n")
    .filter((line) => line.startsWith("worktree "))
    .length;
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

function resolveWorkspaceState(args: {
  hasCommittedChanges: boolean;
  hasDeleted: boolean;
  hasDirtyEntries: boolean;
  hasUntracked: boolean;
}): WorkspaceStatus["workingTree"]["state"] {
  if (!args.hasDirtyEntries && !args.hasCommittedChanges) {
    return "clean";
  }
  if (args.hasDeleted && !args.hasCommittedChanges) {
    return "deleted";
  }
  if (args.hasDirtyEntries && args.hasCommittedChanges) {
    return "dirty_and_committed_unmerged";
  }
  if (args.hasDirtyEntries) {
    return args.hasUntracked ? "untracked" : "dirty_uncommitted";
  }
  return "committed_unmerged";
}

function parseNullSeparatedLines(output: string): string[] {
  return output
    .split("\0")
    .filter((value) => value.length > 0);
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
      runGit(["diff", "--numstat", "HEAD", "--"], { cwd: this.path }),
      this.currentBranch,
      readDefaultBranch(this.path),
    ]);

    const entries = parsePorcelainEntries(statusOutput.stdout);
    const workingTreeSummary = summarizeNumstat(diffOutput.stdout);
    const hasUntracked = entries.some((entry) => entry.status === "??");
    const hasDeleted = entries.some(
      (entry) => entry.indexStatus === "D" || entry.worktreeStatus === "D",
    );
    const hasDirtyEntries = entries.length > 0;
    const mergeBaseData = mergeBaseBranch
      ? await this.readMergeBaseStatus(mergeBaseBranch)
      : null;
    const hasCommittedChanges = mergeBaseData?.hasCommittedUnmergedChanges ?? false;
    const state = resolveWorkspaceState({
      hasCommittedChanges,
      hasDeleted,
      hasDirtyEntries,
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

  async getDiff(options: DiffOptions = {}): Promise<DiffResult> {
    await ensureGitRepo(this.path);

    const target = options.target ?? { type: "uncommitted" as const };
    return this.buildDiffSummary({
      maxBytes: options.maxBytes,
      target,
    });
  }

  async getBranches(): Promise<string[]> {
    return listBranches(this.path);
  }

  async commit(options: CommitOptions): Promise<CommitResult> {
    await ensureGitRepo(this.path);

    await runGit(["add", "-A"], { cwd: this.path });
    await runGit(["commit", "-m", options.message], { cwd: this.path });
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

  async checkpoint(options: CheckpointOptions): Promise<CheckpointResult> {
    await ensureGitRepo(this.path);

    const branchName = await this.currentBranch;
    if (!branchName) {
      throw new WorkspaceError("detached_head", "Cannot checkpoint a detached workspace");
    }

    let commitSha: string;
    if (await hasUncommittedChanges(this.path)) {
      commitSha = (
        await this.commit({
          message: options.commitMessage,
        })
      ).commitSha;
    } else {
      commitSha = await revParse(this.path, "HEAD");
    }

    const remoteName = "origin";
    await runGit(["push", remoteName, branchName], { cwd: this.path });

    return {
      commitSha,
      branchName,
      remoteName,
    };
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

    if (await hasUncommittedChanges(this.path)) {
      await this.commit({ message: SQUASH_MERGE_PREP_COMMIT_MESSAGE });
    }

    await this.fetch({ remote: "origin", branch: options.targetBranch }).catch(
      () => undefined,
    );

    const tempDir = await createTempDir("bb-squash-");
    const worktreeCountBefore = await runGit(["worktree", "list", "--porcelain"], {
      cwd: this.path,
    });

    try {
      if (await hasRef(this.path, `refs/heads/${options.targetBranch}`)) {
        await runGit(["worktree", "add", tempDir, options.targetBranch], {
          cwd: this.path,
        });
      } else if (await hasRef(this.path, `refs/remotes/origin/${options.targetBranch}`)) {
        await runGit(
          [
            "worktree",
            "add",
            "-B",
            options.targetBranch,
            tempDir,
            `origin/${options.targetBranch}`,
          ],
          { cwd: this.path },
        );
      } else {
        throw new WorkspaceError(
          "branch_not_found",
          `Target branch does not exist: ${options.targetBranch}`,
        );
      }

      await runGit(["merge", "--squash", sourceBranch], { cwd: tempDir });
      await runGit(["commit", "-m", SQUASH_MERGE_COMMIT_MESSAGE], { cwd: tempDir });
      const commitSha = await revParse(tempDir, "HEAD");

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

  private async buildDiffSummary(args: {
    target: WorkspaceDiffTarget;
    maxBytes?: number;
  }): Promise<DiffSummary> {
    const [diff, shortstat, files] = await this.readDiffArtifacts(args.target);
    const truncated = typeof args.maxBytes === "number" && diff.length > args.maxBytes;
    if (truncated) {
      return {
        diff: diff.slice(0, args.maxBytes),
        files,
        shortstat,
        truncated,
      };
    }

    return {
      diff,
      files,
      shortstat,
      truncated,
    };
  }

  private async readCommitSummaries(range: string): Promise<WorkspaceCommitSummary[]> {
    const log = await runGit(
      ["log", "--reverse", "--format=%H%x1f%h%x1f%s%x1f%an%x1f%at", range],
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
    const [mergeBaseRef, aheadBehindCounts, commits] = await Promise.all([
      readMergeBaseRef(this.path, mergeBaseBranch),
      runGit(
        ["rev-list", "--left-right", "--count", `${mergeBaseBranch}...HEAD`],
        { cwd: this.path },
      ),
      this.readCommitSummaries(`${mergeBaseBranch}..HEAD`),
    ]);
    const [behindCount, aheadCount] = aheadBehindCounts.stdout
      .trim()
      .split(/\s+/)
      .map((value) => Number.parseInt(value, 10));
    const normalizedAheadCount = Number.isFinite(aheadCount) ? aheadCount : 0;
    const normalizedBehindCount = Number.isFinite(behindCount) ? behindCount : 0;

    return {
      mergeBaseBranch,
      baseRef: mergeBaseRef ?? null,
      aheadCount: normalizedAheadCount,
      behindCount: normalizedBehindCount,
      hasCommittedUnmergedChanges: normalizedAheadCount > 0,
      commits,
    };
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

  private async readDiffArtifactsIncludingUntracked(args: {
    diffArgs: string[];
    filesArgs: string[];
    numstatArgs: string[];
  }): Promise<[string, string, string]> {
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
      trackedDiff: trackedDiff.stdout,
      trackedFiles: trackedFiles.stdout,
      trackedNumstat: trackedNumstat.stdout,
    });
  }

  private async appendUntrackedDiffArtifacts(args: {
    trackedDiff: string;
    trackedFiles: string;
    trackedNumstat: string;
  }): Promise<[string, string, string]> {
    const untrackedFilesOutput = await runGit(
      ["ls-files", "--others", "--exclude-standard", "-z"],
      { cwd: this.path },
    );
    const untrackedPaths = parseNullSeparatedLines(untrackedFilesOutput.stdout);
    if (untrackedPaths.length === 0) {
      return [
        args.trackedDiff,
        formatShortstat(summarizeNumstat(args.trackedNumstat)),
        args.trackedFiles,
      ];
    }

    const untrackedArtifacts = await Promise.all(
      untrackedPaths.map(async (relativePath) => {
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
      }),
    );

    const combinedNumstat = [
      args.trackedNumstat.trimEnd(),
      ...untrackedArtifacts.map((artifact) => artifact.numstat.trimEnd()),
    ]
      .filter((value) => value.length > 0)
      .join("\n");
    const combinedDiff = [
      args.trackedDiff.trimEnd(),
      ...untrackedArtifacts.map((artifact) => artifact.diff.trimEnd()),
    ]
      .filter((value) => value.length > 0)
      .join("\n");
    const combinedFiles = [
      args.trackedFiles.trimEnd(),
      ...untrackedArtifacts.map((artifact) => artifact.files.trimEnd()),
    ]
      .filter((value) => value.length > 0)
      .join("\n");

    return [
      combinedDiff.length > 0 ? `${combinedDiff}\n` : "",
      formatShortstat(summarizeNumstat(combinedNumstat)),
      combinedFiles.length > 0 ? `${combinedFiles}\n` : "",
    ];
  }

  private async readUncommittedDiffArtifacts(): Promise<[string, string, string]> {
    return this.readDiffArtifactsIncludingUntracked({
      diffArgs: ["HEAD", "--"],
      filesArgs: ["HEAD", "--"],
      numstatArgs: ["HEAD", "--"],
    });
  }
}
