import fsSync from "node:fs";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { acquireDaemonLock, DAEMON_LOCK_FILE_NAME } from "./lock.js";

async function waitFor(
  predicate: () => boolean,
  timeoutMs: number,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) {
      throw new Error("Timed out waiting for condition");
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

function createRecordingLogger() {
  const warnings: string[] = [];
  const errors: string[] = [];
  return {
    logger: {
      warn: (_fields: Record<string, unknown>, message: string) => {
        warnings.push(message);
      },
      error: (_fields: Record<string, unknown>, message: string) => {
        errors.push(message);
      },
    },
    warnings,
    errors,
  };
}

describe("acquireDaemonLock compromise handling", () => {
  let dataDir: string;

  beforeEach(async () => {
    dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "bb-daemon-lock-"));
  });

  afterEach(async () => {
    await fs.rm(dataDir, { recursive: true, force: true });
  });

  it("re-acquires a compromised lock instead of crashing the daemon", async () => {
    const { logger, warnings } = createRecordingLogger();
    const onLockLost = vi.fn();
    const release = await acquireDaemonLock(dataDir, {
      staleMs: 2_000,
      retryIntervalMs: 100,
      retries: 25,
      logger,
      onLockLost,
    });
    const lockDirPath = path.join(dataDir, `${DAEMON_LOCK_FILE_NAME}.lock`);

    await fs.rm(lockDirPath, { recursive: true, force: true });

    await waitFor(
      () => warnings.includes("Daemon lock re-acquired after compromise"),
      10_000,
    );
    expect(warnings).toContain(
      "Daemon lock compromised; re-acquiring without restarting the daemon",
    );
    expect(onLockLost).not.toHaveBeenCalled();
    await expect(fs.stat(lockDirPath)).resolves.toBeDefined();

    await release();
    await expect(fs.stat(lockDirPath)).rejects.toMatchObject({
      code: "ENOENT",
    });
  }, 20_000);

  it("re-acquires when the lock dir survives the compromise and must age past stale", async () => {
    const { logger, warnings } = createRecordingLogger();
    const onLockLost = vi.fn();
    const release = await acquireDaemonLock(dataDir, {
      staleMs: 2_000,
      retryIntervalMs: 100,
      retries: 25,
      logger,
      onLockLost,
    });
    const lockDirPath = path.join(dataDir, `${DAEMON_LOCK_FILE_NAME}.lock`);

    const foreignMtime = new Date(Date.now() + 500);
    fsSync.utimesSync(lockDirPath, foreignMtime, foreignMtime);

    await waitFor(
      () => warnings.includes("Daemon lock re-acquired after compromise"),
      15_000,
    );
    expect(onLockLost).not.toHaveBeenCalled();

    await release();
    await expect(fs.stat(lockDirPath)).rejects.toMatchObject({
      code: "ENOENT",
    });
  }, 30_000);

  it("yields the data dir when another live process holds the lock", async () => {
    const { logger } = createRecordingLogger();
    const lockLostErrors: unknown[] = [];
    const release = await acquireDaemonLock(dataDir, {
      staleMs: 2_000,
      retryIntervalMs: 100,
      retries: 3,
      logger,
      onLockLost: (error) => {
        lockLostErrors.push(error);
      },
    });
    const lockPath = path.join(dataDir, DAEMON_LOCK_FILE_NAME);
    const lockDirPath = `${lockPath}.lock`;

    await fs.rm(lockDirPath, { recursive: true, force: true });
    await fs.mkdir(lockDirPath);
    const keepContenderFresh = setInterval(() => {
      const now = new Date();
      try {
        fsSync.utimesSync(lockDirPath, now, now);
      } catch {}
    }, 200);

    try {
      await waitFor(() => lockLostErrors.length > 0, 15_000);
      expect(lockLostErrors[0]).toMatchObject({ code: "ELOCKED" });
    } finally {
      clearInterval(keepContenderFresh);
      await release().catch(() => undefined);
    }
  }, 30_000);
});
