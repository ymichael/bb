import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createDaemon } from "./daemon.js";
import { acquireDaemonLock } from "./lock.js";

const tempDirs: string[] = [];

async function makeTempDir(prefix: string): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

function createLogger() {
  return {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  };
}

afterEach(async () => {
  await Promise.all(
    tempDirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })),
  );
});

describe("daemon lifecycle", () => {
  it("prevents a second instance from acquiring the lock", async () => {
    const dataDir = await makeTempDir("bb-host-daemon-lock-");
    const releaseLock = await acquireDaemonLock(dataDir);

    await expect(acquireDaemonLock(dataDir)).rejects.toThrow();

    await releaseLock();
  });

  it("releases the lock during clean shutdown", async () => {
    const dataDir = await makeTempDir("bb-host-daemon-shutdown-");
    const logger = createLogger();
    const releaseLock = await acquireDaemonLock(dataDir);

    const daemon = createDaemon({
      identity: {
        hostId: "host-1",
        hostName: "test-host",
        instanceId: "instance-1",
      },
      logger,
      releaseLock,
    });

    await daemon.start();
    await daemon.shutdown("test");

    const reacquired = await acquireDaemonLock(dataDir);
    await reacquired();

    expect(logger.info).toHaveBeenCalled();
    expect(logger.error).not.toHaveBeenCalled();
  });
});
