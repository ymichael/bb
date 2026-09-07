import { setTimeout as sleep } from "node:timers/promises";
import path from "node:path";
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

const GIT_REF_FS_LOCK_DIR_NAME = "bb-ref-mutation.lock";
const GIT_REF_FS_LOCK_STALE_MS = 10 * 60_000;
const GIT_REF_FS_LOCK_POLL_MS = 100;
const GIT_REF_FS_LOCK_DEFAULT_TIMEOUT_MS = 5 * 60_000;

async function acquireGitRefFsLock(
  commonDir: string,
  options: { signal?: AbortSignal; timeoutMs?: number },
): Promise<() => Promise<void>> {
  const lockPath = path.join(commonDir, GIT_REF_FS_LOCK_DIR_NAME);
  const deadline =
    Date.now() + (options.timeoutMs ?? GIT_REF_FS_LOCK_DEFAULT_TIMEOUT_MS);
  for (;;) {
    options.signal?.throwIfAborted();
    try {
      await fs.mkdir(lockPath);
      await fs.writeFile(path.join(lockPath, "owner"), `${process.pid}\n`);
      return async () => {
        await fs.rm(lockPath, { recursive: true, force: true });
      };
    } catch (error) {
      if (
        !(error instanceof Error && "code" in error && error.code === "EEXIST")
      ) {
        throw error;
      }
    }
    const held = await fs.stat(lockPath).catch(() => null);
    if (held !== null && Date.now() - held.mtimeMs > GIT_REF_FS_LOCK_STALE_MS) {
      await fs.rm(lockPath, { recursive: true, force: true });
      continue;
    }
    if (Date.now() >= deadline) {
      throw new Error(
        `Timed out waiting for the git ref lock held at ${lockPath}`,
      );
    }
    await sleep(GIT_REF_FS_LOCK_POLL_MS, undefined, {
      ...(options.signal === undefined ? {} : { signal: options.signal }),
    });
  }
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
    work: async () => {
      const release = await acquireGitRefFsLock(commonDir, options);
      try {
        return await work();
      } finally {
        await release();
      }
    },
  });
}
