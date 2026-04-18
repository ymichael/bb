import path from "node:path";
import {
  getGitCommonDir,
  runGit,
  type GitCommandResult,
  type RunGitOptions,
} from "./git.js";
import {
  withProcessLocalQueuedLocks,
  type ProcessLocalQueuedLockWork,
} from "./process-local-queued-lock.js";

type WorktreeMetadataLockWork<T> = ProcessLocalQueuedLockWork<T>;
type GitCommandArgs = string[];

export async function withWorktreeMetadataLock<T>(
  commonDir: string,
  work: WorktreeMetadataLockWork<T>,
): Promise<T> {
  const resolvedCommonDir = path.resolve(commonDir);
  return withProcessLocalQueuedLocks({
    locks: [{ key: resolvedCommonDir }],
    work,
  });
}

export async function runGitWithWorktreeMetadataLock(
  args: GitCommandArgs,
  options: RunGitOptions,
): Promise<GitCommandResult> {
  const commonDir = await getGitCommonDir(options.cwd);
  return withWorktreeMetadataLock(commonDir, () => runGit(args, options));
}
