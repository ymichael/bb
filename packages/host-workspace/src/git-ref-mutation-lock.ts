import fs from "node:fs/promises";
import {
  withProcessLocalQueuedLocks,
  type ProcessLocalQueuedLockWork,
} from "./process-local-queued-lock.js";

type GitRefMutationLockWork<T> = ProcessLocalQueuedLockWork<T>;

interface GitRefMutationLockOptions {
  signal?: AbortSignal;
  timeoutMs?: number;
}

const gitRefMutationLockKeyPrefix = "git-ref-mutation:";

export async function withGitRefMutationLock<T>(
  commonDir: string,
  work: GitRefMutationLockWork<T>,
  options: GitRefMutationLockOptions = {},
): Promise<T> {
  const commonDirIdentity = await fs.stat(commonDir, { bigint: true });
  return withProcessLocalQueuedLocks({
    locks: [
      {
        key: `${gitRefMutationLockKeyPrefix}${commonDirIdentity.dev}:${commonDirIdentity.ino}`,
        ...(options.timeoutMs !== undefined
          ? { timeoutMs: options.timeoutMs }
          : {}),
      },
    ],
    signal: options.signal,
    work,
  });
}
