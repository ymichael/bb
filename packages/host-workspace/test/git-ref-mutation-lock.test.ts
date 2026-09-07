import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createDeferredPromise } from "@bb/test-helpers";
import { withGitRefMutationLock } from "../src/git-ref-mutation-lock.js";
import { ProcessLocalQueuedLockTimeoutError } from "../src/process-local-queued-lock.js";

const tempDirs: string[] = [];

async function makeTempDir(name: string): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), `bb-${name}-`));
  tempDirs.push(dir);
  return dir;
}

function waitForLockContention(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 100));
}

async function expectPathsShareLock(
  firstCommonDir: string,
  secondCommonDir: string,
): Promise<void> {
  const firstEntered = createDeferredPromise<void>();
  const releaseFirst = createDeferredPromise<void>();
  const first = withGitRefMutationLock(firstCommonDir, async () => {
    firstEntered.resolve();
    await releaseFirst.promise;
  });
  await firstEntered.promise;

  let secondEntered = false;
  const second = withGitRefMutationLock(secondCommonDir, async () => {
    secondEntered = true;
  });
  try {
    await waitForLockContention();
    expect(secondEntered).toBe(false);
  } finally {
    releaseFirst.resolve();
    await Promise.all([first, second]);
  }
  expect(secondEntered).toBe(true);
}

afterEach(async () => {
  await Promise.all(
    tempDirs
      .splice(0)
      .map((dir) => fs.rm(dir, { recursive: true, force: true })),
  );
});

describe("git ref mutation lock", () => {
  it("serializes mutations for the same resolved common directory", async () => {
    const commonDir = await makeTempDir("git-ref-lock");
    await expectPathsShareLock(commonDir, `${commonDir}${path.sep}.`);
  });

  it.runIf(process.platform !== "win32")(
    "serializes symbolic-link aliases of one common directory",
    async () => {
      const parentDir = await makeTempDir("git-ref-lock-symlink");
      const commonDir = path.join(parentDir, "common");
      const aliasDir = path.join(parentDir, "alias");
      await fs.mkdir(commonDir);
      await fs.symlink(commonDir, aliasDir, "dir");

      await expectPathsShareLock(commonDir, aliasDir);
    },
  );

  it.runIf(process.platform === "darwin")(
    "serializes macOS data-volume aliases of one common directory",
    async () => {
      const dataVolumePrefix = "/System/Volumes/Data";
      const commonDir = process.cwd();
      const aliasDir = commonDir.startsWith(dataVolumePrefix)
        ? commonDir.slice(dataVolumePrefix.length)
        : `${dataVolumePrefix}${commonDir}`;
      const [commonStats, aliasStats] = await Promise.all([
        fs.stat(commonDir, { bigint: true }),
        fs.stat(aliasDir, { bigint: true }),
      ]);
      expect(aliasStats.dev).toBe(commonStats.dev);
      expect(aliasStats.ino).toBe(commonStats.ino);

      await expectPathsShareLock(commonDir, aliasDir);
    },
  );

  it("allows callers to bound how long they wait for the lock", async () => {
    const commonDir = await makeTempDir("git-ref-lock-timeout");
    const firstEntered = createDeferredPromise<void>();
    const releaseFirst = createDeferredPromise<void>();
    const first = withGitRefMutationLock(commonDir, async () => {
      firstEntered.resolve();
      await releaseFirst.promise;
    });
    await firstEntered.promise;

    try {
      await expect(
        withGitRefMutationLock(commonDir, async () => undefined, {
          timeoutMs: 10,
        }),
      ).rejects.toBeInstanceOf(ProcessLocalQueuedLockTimeoutError);
    } finally {
      releaseFirst.resolve();
      await first;
    }
  });
});
