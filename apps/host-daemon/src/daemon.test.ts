import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createDaemon } from "./daemon.js";
import { acquireDaemonLock, DAEMON_LOCK_FILE_NAME } from "./lock.js";

const tempDirs: string[] = [];
type SignalListener = () => void;

class FakeSignalSource {
  private readonly listeners = new Map<NodeJS.Signals, Set<SignalListener>>();

  on(signal: NodeJS.Signals, listener: SignalListener): void {
    const listenersForSignal = this.listeners.get(signal) ?? new Set();
    listenersForSignal.add(listener);
    this.listeners.set(signal, listenersForSignal);
  }

  off(signal: NodeJS.Signals, listener: SignalListener): void {
    this.listeners.get(signal)?.delete(listener);
  }

  emit(signal: NodeJS.Signals): void {
    for (const listener of this.listeners.get(signal) ?? []) {
      listener();
    }
  }
}

async function makeTempDir(prefix: string): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

function createLogger() {
  return {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  };
}

afterEach(async () => {
  await Promise.all(
    tempDirs
      .splice(0)
      .map((dir) => fs.rm(dir, { recursive: true, force: true })),
  );
});

describe("daemon lifecycle", () => {
  it("prevents a second instance from acquiring the lock", async () => {
    const dataDir = await makeTempDir("bb-host-daemon-lock-");
    const releaseLock = await acquireDaemonLock(dataDir);

    await expect(acquireDaemonLock(dataDir, { retries: 0 })).rejects.toThrow();

    await releaseLock();
  });

  it("reclaims a stale lock left behind by a crashed instance", async () => {
    const dataDir = await makeTempDir("bb-host-daemon-stale-lock-");
    await fs.mkdir(dataDir, { recursive: true });

    const lockDirPath = path.join(dataDir, `${DAEMON_LOCK_FILE_NAME}.lock`);
    await fs.mkdir(lockDirPath, { recursive: true });
    const stalePast = new Date(Date.now() - 60_000);
    await fs.utimes(lockDirPath, stalePast, stalePast);

    const releaseLock = await acquireDaemonLock(dataDir, {
      staleMs: 5_000,
      retries: 0,
    });
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
    await daemon.shutdown("test", 0);

    const reacquired = await acquireDaemonLock(dataDir);
    await reacquired();

    expect(logger.info).toHaveBeenCalled();
    expect(logger.error).not.toHaveBeenCalled();
  });

  it("cleans up fully when startup fails so a service manager can restart it", async () => {
    const logger = createLogger();
    const startupFailure = new Error("server unavailable");
    const shutdownRuntimes = vi.fn(async () => undefined);
    const releaseLock = vi.fn(async () => undefined);
    const exitProcess = vi.fn();
    const daemon = createDaemon({
      identity: {
        hostId: "host-1",
        hostName: "test-host",
        instanceId: "instance-1",
      },
      logger,
      onStart: async () => {
        throw startupFailure;
      },
      releaseLock,
      shutdownRuntimes,
      exitProcess,
    });

    await expect(daemon.start()).rejects.toBe(startupFailure);
    await expect(daemon.waitUntilStopped()).resolves.toBeUndefined();

    expect(shutdownRuntimes).toHaveBeenCalledOnce();
    expect(releaseLock).toHaveBeenCalledOnce();
    expect(exitProcess).not.toHaveBeenCalled();
    expect(logger.info).toHaveBeenCalledWith(
      { mode: "shutdown", reason: "startup-failed" },
      "Shutting down host daemon",
    );
  });

  it("preserves the startup error when startup cleanup also fails", async () => {
    const logger = createLogger();
    const startupFailure = new Error("server unavailable");
    const cleanupFailure = new Error("cleanup failed");
    const daemon = createDaemon({
      identity: {
        hostId: "host-1",
        hostName: "test-host",
        instanceId: "instance-1",
      },
      logger,
      onStart: async () => {
        throw startupFailure;
      },
      releaseLock: async () => {
        throw cleanupFailure;
      },
    });

    await expect(daemon.start()).rejects.toBe(startupFailure);
    await expect(daemon.waitUntilStopped()).rejects.toBe(cleanupFailure);
  });

  it("rejects direct shutdown and waitUntilStopped when shutdown cleanup fails", async () => {
    const logger = createLogger();
    const shutdownFailure = new Error("release failed");
    const daemon = createDaemon({
      identity: {
        hostId: "host-1",
        hostName: "test-host",
        instanceId: "instance-1",
      },
      logger,
      releaseLock: async () => {
        throw shutdownFailure;
      },
    });

    await daemon.start();

    await expect(daemon.shutdown("test", 0)).rejects.toThrow("release failed");
    await expect(daemon.waitUntilStopped()).rejects.toThrow("release failed");
    expect(logger.error).toHaveBeenCalledWith(
      expect.objectContaining({
        err: shutdownFailure,
        step: "releaseLock",
      }),
      "Shutdown step failed",
    );
  });

  it("logs and exposes signal-triggered shutdown failure through waitUntilStopped", async () => {
    const logger = createLogger();
    const signalSource = new FakeSignalSource();
    const shutdownFailure = new Error("release failed");
    const daemon = createDaemon({
      identity: {
        hostId: "host-1",
        hostName: "test-host",
        instanceId: "instance-1",
      },
      logger,
      releaseLock: async () => {
        throw shutdownFailure;
      },
      signalSource,
    });

    await daemon.start();
    signalSource.emit("SIGTERM");
    await expect(daemon.waitUntilStopped()).rejects.toThrow("release failed");
    await vi.waitFor(() => {
      expect(logger.error).toHaveBeenCalledWith(
        expect.objectContaining({
          err: shutdownFailure,
          signal: "SIGTERM",
        }),
        "Signal-triggered host daemon shutdown failed",
      );
    });
  });

  it("forces the requested exit status when a shutdown step never finishes", async () => {
    const logger = createLogger();
    const exitProcess = vi.fn();
    const daemon = createDaemon({
      identity: {
        hostId: "host-1",
        hostName: "test-host",
        instanceId: "instance-1",
      },
      logger,
      releaseLock: () => new Promise<void>(() => undefined),
      exitProcess,
      shutdownExitGraceMs: 10,
    });

    await daemon.start();
    void daemon.shutdown("daemon-lock-lost", 1);

    await vi.waitFor(() => {
      expect(exitProcess).toHaveBeenCalledWith(1);
    });
    expect(logger.error).toHaveBeenCalledWith(
      expect.objectContaining({ reason: "daemon-lock-lost" }),
      "Host daemon shutdown did not end the process; forcing exit so the service manager can restart it.",
    );
  });

  it("exits the process immediately after clean shutdown", async () => {
    const logger = createLogger();
    const lifecycle: string[] = [];
    const exitProcess = vi.fn(() => lifecycle.push("exitProcess"));
    const daemon = createDaemon({
      identity: {
        hostId: "host-1",
        hostName: "test-host",
        instanceId: "instance-1",
      },
      logger,
      flushEvents: async () => {
        lifecycle.push("flushEvents");
      },
      shutdownRuntimes: async () => {
        lifecycle.push("shutdownRuntimes");
      },
      releaseLock: async () => {
        lifecycle.push("releaseLock");
      },
      exitProcess,
      shutdownExitGraceMs: 60_000,
    });

    await daemon.start();
    await daemon.shutdown("self-update", 0);

    expect(lifecycle).toEqual([
      "flushEvents",
      "shutdownRuntimes",
      "releaseLock",
      "exitProcess",
    ]);
    expect(exitProcess).toHaveBeenCalledWith(0);
  });

  it("escalates an active clean shutdown after daemon lock loss", async () => {
    const logger = createLogger();
    const exitProcess = vi.fn();
    let finishRelease: () => void = () => undefined;
    const releaseBlocked = new Promise<void>((resolve) => {
      finishRelease = resolve;
    });
    const releaseLock = vi.fn(async () => releaseBlocked);
    const daemon = createDaemon({
      identity: {
        hostId: "host-1",
        hostName: "test-host",
        instanceId: "instance-1",
      },
      logger,
      releaseLock,
      exitProcess,
      shutdownExitGraceMs: 60_000,
    });

    await daemon.start();
    const signalShutdown = daemon.shutdown("SIGTERM", 0);
    await vi.waitFor(() => {
      expect(releaseLock).toHaveBeenCalledOnce();
    });
    const lockLossShutdown = daemon.shutdown("daemon-lock-lost", 1);
    finishRelease();
    await Promise.all([signalShutdown, lockLossShutdown]);

    expect(exitProcess).toHaveBeenCalledOnce();
    expect(exitProcess).toHaveBeenCalledWith(1);
  });

  it("preserves the requested failure status after daemon lock loss", async () => {
    const logger = createLogger();
    const exitProcess = vi.fn();
    const daemon = createDaemon({
      identity: {
        hostId: "host-1",
        hostName: "test-host",
        instanceId: "instance-1",
      },
      logger,
      releaseLock: async () => undefined,
      exitProcess,
    });

    await daemon.start();
    await daemon.shutdown("daemon-lock-lost", 1);

    expect(exitProcess).toHaveBeenCalledWith(1);
  });

  it("exits promptly when a signal requests shutdown during startup", async () => {
    const logger = createLogger();
    const signalSource = new FakeSignalSource();
    const exitProcess = vi.fn();
    let resolveStartup: () => void = () => undefined;
    const startup = new Promise<void>((resolve) => {
      resolveStartup = resolve;
    });
    const daemon = createDaemon({
      identity: {
        hostId: "host-1",
        hostName: "test-host",
        instanceId: "instance-1",
      },
      logger,
      releaseLock: async () => undefined,
      onStart: async () => startup,
      signalSource,
      exitProcess,
      shutdownExitGraceMs: 60_000,
    });

    const startPromise = daemon.start();
    signalSource.emit("SIGTERM");
    await daemon.waitUntilStopped();

    expect(exitProcess).toHaveBeenCalledWith(0);
    expect(logger.info).not.toHaveBeenCalledWith(
      expect.anything(),
      "Host daemon started",
    );

    resolveStartup();
    await startPromise;
  });
});
