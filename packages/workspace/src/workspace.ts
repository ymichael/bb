import type {
  ThreadGitDiffResponse,
  ThreadGitDiffSelection,
  ThreadGitDiffMode,
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
  parseBranchStatus,
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
  mergeBaseBranch?: string;
  selection?: ThreadGitDiffSelection;
  maxBytes?: number;
}

export type DiffResult = ThreadGitDiffResponse;

export interface CommitOptions {
  message: string;
  includeUnstaged?: boolean;
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
  remoteName?: string;
}

export interface CheckpointResult {
  commitSha: string;
  branchName: string;
  remoteName: string;
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
  commits: DiffResult["commits"];
  diff: string;
  mode: ThreadGitDiffMode;
  selection: ThreadGitDiffSelection;
  truncated: boolean;
};

function countWorktrees(porcelainOutput: string): number {
  return porcelainOutput
    .split("\n")
    .filter((line) => line.startsWith("worktree "))
    .length;
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

  async getStatus(): Promise<WorkspaceStatus> {
    await ensureGitRepo(this.path);

    const [statusOutput, diffOutput, currentBranch, defaultBranch, branches] =
      await Promise.all([
        runGit(
          ["status", "--porcelain=v1", "--branch", "--untracked-files=all"],
          { cwd: this.path },
        ),
        runGit(["diff", "--numstat", "HEAD", "--"], { cwd: this.path }),
        this.currentBranch,
        readDefaultBranch(this.path),
        listBranches(this.path),
      ]);

    const branchInfo = parseBranchStatus(statusOutput.stdout.split("\n")[0]);
    const entries = parsePorcelainEntries(statusOutput.stdout);
    const workingTreeSummary = summarizeNumstat(diffOutput.stdout);
    const hasUntracked = entries.some((entry) => entry.status === "??");
    const hasDeleted = entries.some(
      (entry) => entry.indexStatus === "D" || entry.worktreeStatus === "D",
    );
    const hasDirtyEntries = entries.length > 0;
    const hasCommittedChanges = branchInfo.aheadCount > 0;
    const mergeBaseRef = defaultBranch
      ? await readMergeBaseRef(this.path, defaultBranch)
      : undefined;

    const state = (() => {
      if (!hasDirtyEntries && !hasCommittedChanges) {
        return "clean";
      }
      if (hasDeleted && !hasCommittedChanges) {
        return "deleted";
      }
      if (hasDirtyEntries && hasCommittedChanges) {
        return "dirty_and_committed_unmerged";
      }
      if (hasDirtyEntries) {
        return hasUntracked ? "untracked" : "dirty_uncommitted";
      }
      return "committed_unmerged";
    })();

    return {
      state,
      changedFiles: entries.length,
      insertions: workingTreeSummary.insertions,
      deletions: workingTreeSummary.deletions,
      workspaceChangedFiles: entries.length,
      workspaceInsertions: workingTreeSummary.insertions,
      workspaceDeletions: workingTreeSummary.deletions,
      hasUncommittedChanges: hasDirtyEntries,
      hasCommittedUnmergedChanges: hasCommittedChanges,
      aheadCount: branchInfo.aheadCount,
      behindCount: branchInfo.behindCount,
      currentBranch,
      defaultBranch,
      mergeBaseBranch: defaultBranch,
      mergeBaseBranches: branches.filter((branch) => branch !== currentBranch),
      baseRef: mergeBaseRef ?? defaultBranch,
      files: entries.map((entry) => ({
        path: entry.path,
        status: entry.status,
      })),
    };
  }

  async getDiff(options: DiffOptions = {}): Promise<DiffResult> {
    await ensureGitRepo(this.path);

    const currentBranch = await this.currentBranch;
    const mergeBaseBranch =
      options.mergeBaseBranch ?? await readDefaultBranch(this.path);
    const mergeBaseRef = mergeBaseBranch
      ? await readMergeBaseRef(this.path, mergeBaseBranch)
      : undefined;
    const selection = options.selection ?? { type: "combined" as const };
    const diffSummary = await this.buildDiffSummary({
      mergeBaseRef,
      selection,
      maxBytes: options.maxBytes,
    });

    return {
      mode: diffSummary.mode,
      currentBranch,
      mergeBaseBranch,
      mergeBaseRef,
      commits: diffSummary.commits,
      selection: diffSummary.selection,
      diff: diffSummary.diff,
      truncated: diffSummary.truncated,
    };
  }

  async getBranches(): Promise<string[]> {
    return listBranches(this.path);
  }

  async commit(options: CommitOptions): Promise<CommitResult> {
    await ensureGitRepo(this.path);

    if (options.includeUnstaged !== false) {
      await runGit(["add", "-A"], { cwd: this.path });
    }

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
      throw new WorkspaceError("Cannot checkpoint a detached workspace");
    }

    let commitSha: string;
    if (await hasUncommittedChanges(this.path)) {
      commitSha = (
        await this.commit({
          message: options.commitMessage,
          includeUnstaged: true,
        })
      ).commitSha;
    } else {
      commitSha = await revParse(this.path, "HEAD");
    }

    const remoteName = options.remoteName ?? "origin";
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
      throw new WorkspaceError("Cannot squash merge from a detached workspace");
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
          `Target branch does not exist: ${options.targetBranch}`,
        );
      }

      await runGit(["merge", "--squash", sourceBranch], { cwd: tempDir });
      await runGit(["commit", "-m", options.commitMessage], { cwd: tempDir });
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
        throw new WorkspaceError("Temporary worktree cleanup failed");
      }
    }
  }

  private async buildDiffSummary(args: {
    mergeBaseRef?: string;
    selection: ThreadGitDiffSelection;
    maxBytes?: number;
  }): Promise<DiffSummary> {
    const hasWorkingTreeChanges = await hasUncommittedChanges(this.path);

    const commits = args.mergeBaseRef
      ? await this.readCommitSummaries(`${args.mergeBaseRef}..HEAD`)
      : [];
    const mode: ThreadGitDiffMode = hasWorkingTreeChanges
      ? "local_uncommitted"
      : "worktree_commits";

    let diff = "";
    if (args.selection.type === "commit") {
      diff = (
        await runGit(["show", "--format=", "--no-ext-diff", args.selection.sha], {
          cwd: this.path,
        })
      ).stdout;
    } else if (mode === "local_uncommitted") {
      diff = (
        await runGit(["diff", "--no-ext-diff", "--binary", "HEAD", "--"], {
          cwd: this.path,
        })
      ).stdout;
    } else if (args.mergeBaseRef) {
      diff = (
        await runGit(
          ["diff", "--no-ext-diff", "--binary", `${args.mergeBaseRef}..HEAD`],
          { cwd: this.path },
        )
      ).stdout;
    }

    const truncated =
      typeof args.maxBytes === "number" && diff.length > args.maxBytes;
    if (truncated) {
      diff = diff.slice(0, args.maxBytes);
    }

    return {
      commits,
      diff,
      mode,
      selection: args.selection,
      truncated,
    };
  }

  private async readCommitSummaries(range: string): Promise<DiffResult["commits"]> {
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
          ...(authorName ? { authorName } : {}),
          ...(authoredAt ? { authoredAt: Number.parseInt(authoredAt, 10) * 1000 } : {}),
        };
      });
  }
}
