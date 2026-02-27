import { spawnSync } from "node:child_process";
import { existsSync, statSync } from "node:fs";
import { join } from "node:path";
import type { CommitThreadResponse, ThreadWorkStatus } from "@beanbag/agent-core";

type CacheEntry = {
  checkedAt: number;
  fingerprint: string;
  status: ThreadWorkStatus;
};

const CACHE_TTL_MS = 1_500;

function runGit(cwd: string, args: string[]): { ok: boolean; stdout: string; stderr: string; code: number | null } {
  const result = spawnSync("git", args, {
    cwd,
    encoding: "utf-8",
    stdio: "pipe",
  });
  return {
    ok: result.status === 0,
    stdout: result.stdout?.trim() ?? "",
    stderr: result.stderr?.trim() ?? "",
    code: result.status,
  };
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

function parseAheadBehind(value: string): { behind: number; ahead: number } {
  const [behindRaw, aheadRaw] = value.split("\t");
  const behind = Number.parseInt(behindRaw ?? "0", 10);
  const ahead = Number.parseInt(aheadRaw ?? "0", 10);
  return {
    behind: Number.isFinite(behind) ? behind : 0,
    ahead: Number.isFinite(ahead) ? ahead : 0,
  };
}

function parsePorcelainLine(line: string): { status: string; path: string } | undefined {
  if (line.length < 3) return undefined;
  const status = line.slice(0, 2).trim() || "??";
  const rawPath = line.slice(2).trimStart();
  if (rawPath.length === 0) return undefined;
  const path = rawPath.includes(" -> ")
    ? rawPath.slice(rawPath.lastIndexOf(" -> ") + 4)
    : rawPath;
  return { status, path };
}

function safeMtime(path: string): number {
  try {
    return statSync(path).mtimeMs;
  } catch {
    return 0;
  }
}

function createFingerprint(workspaceRoot: string): string {
  const gitPath = join(workspaceRoot, ".git");
  const indexPath = join(gitPath, "index");
  const headPath = join(gitPath, "HEAD");
  return `${safeMtime(gitPath)}:${safeMtime(indexPath)}:${safeMtime(headPath)}`;
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
  const remoteHead = runGit(projectRoot, ["symbolic-ref", "--quiet", "refs/remotes/origin/HEAD"]);
  if (remoteHead.ok && remoteHead.stdout.startsWith("refs/remotes/origin/")) {
    return remoteHead.stdout.slice("refs/remotes/origin/".length);
  }

  const hasMain = runGit(projectRoot, ["show-ref", "--verify", "--quiet", "refs/heads/main"]);
  if (hasMain.ok) return "main";

  const hasMaster = runGit(projectRoot, ["show-ref", "--verify", "--quiet", "refs/heads/master"]);
  if (hasMaster.ok) return "master";

  const head = runGit(projectRoot, ["symbolic-ref", "--short", "HEAD"]);
  if (head.ok && head.stdout.length > 0) {
    return head.stdout;
  }

  return undefined;
}

function resolveBaseRef(workspaceRoot: string, branch: string | undefined): string | undefined {
  if (!branch) return undefined;

  const localRef = `refs/heads/${branch}`;
  if (runGit(workspaceRoot, ["show-ref", "--verify", "--quiet", localRef]).ok) {
    return branch;
  }

  const remoteRef = `refs/remotes/origin/${branch}`;
  if (runGit(workspaceRoot, ["show-ref", "--verify", "--quiet", remoteRef]).ok) {
    return `origin/${branch}`;
  }

  return undefined;
}

function emptyStatus(workspaceRoot: string): ThreadWorkStatus {
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

export class ThreadGitStatusService {
  private cache = new Map<string, CacheEntry>();
  private defaultBranchCache = new Map<string, string | undefined>();

  invalidate(workspaceRoot: string): void {
    this.cache.delete(workspaceRoot);
  }

  detectDefaultBranch(projectRoot: string): string | undefined {
    if (this.defaultBranchCache.has(projectRoot)) {
      return this.defaultBranchCache.get(projectRoot);
    }

    const branch = resolveDefaultBranch(projectRoot);
    this.defaultBranchCache.set(projectRoot, branch);
    return branch;
  }

  getStatus(args: {
    workspaceRoot: string;
    projectRoot: string;
    defaultBranch?: string;
  }): ThreadWorkStatus {
    if (!existsSync(args.workspaceRoot)) {
      return emptyStatus(args.workspaceRoot);
    }

    const isGitRepo = runGit(args.workspaceRoot, ["rev-parse", "--is-inside-work-tree"]);
    if (!isGitRepo.ok || isGitRepo.stdout !== "true") {
      return emptyStatus(args.workspaceRoot);
    }

    const fingerprint = createFingerprint(args.workspaceRoot);
    const cached = this.cache.get(args.workspaceRoot);
    const now = Date.now();
    if (cached && cached.fingerprint === fingerprint && now - cached.checkedAt < CACHE_TTL_MS) {
      return cached.status;
    }

    const statusResult = runGit(args.workspaceRoot, ["status", "--porcelain"]);
    const statusLines = statusResult.ok
      ? statusResult.stdout.split("\n").map((line) => line.trimEnd()).filter((line) => line.length > 0)
      : [];
    const files = statusLines
      .map((line) => parsePorcelainLine(line))
      .filter((item): item is { status: string; path: string } => Boolean(item))
      .slice(0, 60);
    const changedFiles = statusLines.length;

    const unstagedStat = parseShortstat(runGit(args.workspaceRoot, ["diff", "--shortstat"]).stdout);
    const stagedStat = parseShortstat(runGit(args.workspaceRoot, ["diff", "--cached", "--shortstat"]).stdout);

    const insertions = unstagedStat.insertions + stagedStat.insertions;
    const deletions = unstagedStat.deletions + stagedStat.deletions;

    const currentBranch = runGit(args.workspaceRoot, ["symbolic-ref", "--short", "HEAD"]);
    const defaultBranch = args.defaultBranch ?? this.detectDefaultBranch(args.projectRoot);
    const baseRef = resolveBaseRef(args.workspaceRoot, defaultBranch);

    let aheadCount = 0;
    let behindCount = 0;
    if (baseRef) {
      const aheadBehind = runGit(args.workspaceRoot, ["rev-list", "--left-right", "--count", `${baseRef}...HEAD`]);
      if (aheadBehind.ok) {
        const parsed = parseAheadBehind(aheadBehind.stdout);
        aheadCount = parsed.ahead;
        behindCount = parsed.behind;
      }
    }

    const hasUncommittedChanges = changedFiles > 0;
    const hasCommittedUnmergedChanges = aheadCount > 0;
    const status: ThreadWorkStatus = {
      state: toState({ hasUncommittedChanges, hasCommittedUnmergedChanges }),
      changedFiles,
      insertions,
      deletions,
      workspaceChangedFiles: changedFiles,
      workspaceInsertions: insertions,
      workspaceDeletions: deletions,
      hasUncommittedChanges,
      hasCommittedUnmergedChanges,
      aheadCount,
      behindCount,
      ...(currentBranch.ok && currentBranch.stdout ? { currentBranch: currentBranch.stdout } : {}),
      ...(defaultBranch ? { defaultBranch } : {}),
      ...(baseRef ? { baseRef } : {}),
      ...(files.length > 0 ? { files } : {}),
      workspaceRoot: args.workspaceRoot,
    };

    this.cache.set(args.workspaceRoot, {
      checkedAt: now,
      fingerprint,
      status,
    });

    return status;
  }

  commit(args: {
    workspaceRoot: string;
    projectRoot: string;
    defaultBranch?: string;
    message?: string;
    includeUnstaged?: boolean;
  }): CommitThreadResponse {
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
      const addResult = runGit(args.workspaceRoot, ["add", "-A"]);
      if (!addResult.ok) {
        throw new Error(addResult.stderr || "Failed to stage changes");
      }
    }

    const hasStagedChanges = runGit(args.workspaceRoot, ["diff", "--cached", "--quiet"]);
    if (hasStagedChanges.ok) {
      const after = this.getStatus(args);
      return {
        ok: true,
        commitCreated: false,
        message: "No staged changes to commit",
        workStatus: after,
      };
    }

    const commitMessage = args.message?.trim() || `beanbag: thread auto-commit ${new Date().toISOString()}`;
    const commitResult = runGit(args.workspaceRoot, ["commit", "-m", commitMessage]);
    if (!commitResult.ok) {
      throw new Error(commitResult.stderr || "Commit failed");
    }

    this.invalidate(args.workspaceRoot);
    const after = this.getStatus(args);
    const shaResult = runGit(args.workspaceRoot, ["rev-parse", "HEAD"]);

    return {
      ok: true,
      commitCreated: true,
      message: "Committed changes",
      workStatus: after,
      ...(shaResult.ok && shaResult.stdout ? { commitSha: shaResult.stdout } : {}),
    };
  }

  mergeWorktreeIntoDefaultBranch(args: {
    workspaceRoot: string;
    projectRoot: string;
    defaultBranch?: string;
  }): { merged: boolean; message: string } {
    const defaultBranch = args.defaultBranch ?? this.detectDefaultBranch(args.projectRoot);
    if (!defaultBranch) {
      throw new Error("Could not determine default branch");
    }

    const workspaceStatus = this.getStatus({
      workspaceRoot: args.workspaceRoot,
      projectRoot: args.projectRoot,
      defaultBranch,
    });
    if (workspaceStatus.hasUncommittedChanges) {
      throw new Error("Workspace has uncommitted changes; commit first");
    }
    if (workspaceStatus.aheadCount <= 0) {
      return { merged: false, message: "No commits to merge" };
    }

    const projectDirty = runGit(args.projectRoot, ["diff", "--quiet"]);
    if (!projectDirty.ok) {
      throw new Error("Project root has local changes; clean working tree before merge");
    }

    const currentProjectBranch = runGit(args.projectRoot, ["symbolic-ref", "--short", "HEAD"]);
    const workspaceHead = runGit(args.workspaceRoot, ["rev-parse", "HEAD"]);
    if (!workspaceHead.ok || !workspaceHead.stdout) {
      throw new Error("Failed to resolve worktree HEAD");
    }

    const checkoutDefault = runGit(args.projectRoot, ["checkout", defaultBranch]);
    if (!checkoutDefault.ok) {
      throw new Error(checkoutDefault.stderr || `Failed to checkout ${defaultBranch}`);
    }

    const mergeResult = runGit(args.projectRoot, ["merge", "--ff-only", workspaceHead.stdout]);
    const restoreBranch = currentProjectBranch.ok && currentProjectBranch.stdout
      ? runGit(args.projectRoot, ["checkout", currentProjectBranch.stdout])
      : { ok: true };

    if (!restoreBranch.ok) {
      throw new Error("Merged but failed to restore original branch");
    }
    if (!mergeResult.ok) {
      throw new Error(mergeResult.stderr || "Merge failed");
    }

    return { merged: true, message: `Merged into ${defaultBranch}` };
  }
}
