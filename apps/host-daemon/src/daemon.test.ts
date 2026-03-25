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
    error: vi.fn(),
  };
}

function createSignalSource() {
  const listeners = new Map<NodeJS.Signals, Set<() => void>>();
  return {
    signalSource: {
      on(event: NodeJS.Signals, listener: () => void) {
        const existing = listeners.get(event) ?? new Set<() => void>();
        existing.add(listener);
        listeners.set(event, existing);
      },
      off(event: NodeJS.Signals, listener: () => void) {
        listeners.get(event)?.delete(listener);
      },
    },
    emit(event: NodeJS.Signals) {
      for (const listener of listeners.get(event) ?? []) {
        listener();
      }
    },
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

  it("routes SIGUSR2 through the restart lifecycle", async () => {
    const signalSource = createSignalSource();
    const logger = createLogger();
    const flushEventBuffer = vi.fn(async () => undefined);
    const shutdownRuntimes = vi.fn(async () => undefined);
    const restart = vi.fn(async () => undefined);
    const releaseLock = vi.fn(async () => undefined);

    const daemon = createDaemon({
      identity: {
        hostId: "host-1",
        hostName: "test-host",
        instanceId: "instance-1",
      },
      logger,
      flushEventBuffer,
      shutdownRuntimes,
      restart,
      releaseLock,
      signalSource: signalSource.signalSource,
    });

    await daemon.start();
    signalSource.emit("SIGUSR2");
    await daemon.waitUntilStopped();

    expect(flushEventBuffer).toHaveBeenCalledTimes(1);
    expect(shutdownRuntimes).toHaveBeenCalledTimes(1);
    expect(restart).toHaveBeenCalledTimes(1);
    expect(releaseLock).not.toHaveBeenCalled();
  });
});
