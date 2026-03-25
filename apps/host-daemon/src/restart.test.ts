import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { acquireDaemonLock } from "./lock.js";
import { restartHostDaemon } from "./restart.js";

const tempDirs: string[] = [];

async function makeTempDir(prefix: string): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

afterEach(async () => {
  await Promise.all(
    tempDirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })),
  );
});

describe("restartHostDaemon", () => {
  it("spawns a detached replacement, releases the lock, and exits", async () => {
    const steps: string[] = [];
    const unref = vi.fn(() => {
      steps.push("unref");
    });
    const spawnProcess = vi.fn(() => {
      steps.push("spawn");
      return { unref };
    });
    const releaseLock = vi.fn(async () => {
      steps.push("release");
    });
    const exit = vi.fn(() => {
      steps.push("exit");
    });

    await restartHostDaemon({
      argv: ["/bin/node", "/tmp/daemon.js", "--watch"],
      cwd: "/tmp",
      env: { TEST_ENV: "1" },
      spawnProcess: spawnProcess as never,
      releaseLock,
      exit,
    });

    expect(spawnProcess).toHaveBeenCalledWith("/bin/node", ["/tmp/daemon.js", "--watch"], {
      cwd: "/tmp",
      detached: true,
      env: { TEST_ENV: "1" },
      stdio: "ignore",
    });
    expect(unref).toHaveBeenCalledTimes(1);
    expect(releaseLock).toHaveBeenCalledTimes(1);
    expect(exit).toHaveBeenCalledWith(0);
    expect(steps).toEqual(["release", "spawn", "unref", "exit"]);
  });

  it("releases the daemon lock before a replacement process acquires it", async () => {
    const dataDir = await makeTempDir("bb-host-daemon-restart-");
    const releaseLock = await acquireDaemonLock(dataDir);
    const spawnProcess = vi.fn(() => ({ unref: vi.fn() }));

    await restartHostDaemon({
      argv: ["/bin/node", "/tmp/daemon.js"],
      spawnProcess: spawnProcess as never,
      releaseLock,
      exit: () => undefined,
    });

    const replacementReleaseLock = await acquireDaemonLock(dataDir);
    await replacementReleaseLock();
  });
});
