import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  __testOnly__getManagedHostEnvironmentDaemonRecord,
  disposeManagedHostEnvironmentDaemon,
  ensureManagedHostEnvironmentDaemon,
  resolveManagedHostEnvironmentDaemonLaunchCommand,
} from "../host-environment-daemon.js";

const tempDirs: string[] = [];
const originalBbRoot = process.env.BB_ROOT;

function makeTempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "bb-host-env-daemon-"));
  tempDirs.push(dir);
  return dir;
}

function createDeferred() {
  let resolvePromise: (() => void) | undefined;
  const promise = new Promise<void>((resolve) => {
    resolvePromise = resolve;
  });
  return {
    promise,
    resolve() {
      resolvePromise?.();
    },
  };
}

afterEach(() => {
  process.env.BB_ROOT = originalBbRoot;
  vi.restoreAllMocks();
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe("host environment-daemon helper", () => {
  it("launches the standalone environment-daemon artifact directly", () => {
    const artifactEntry = fileURLToPath(
      new URL("../../../environment-daemon/dist/environment-daemon.bundle.mjs", import.meta.url),
    );
    mkdirSync(dirname(artifactEntry), { recursive: true });
    if (!existsSync(artifactEntry)) {
      writeFileSync(artifactEntry, "console.log('agent')\n", "utf8");
    }

    expect(resolveManagedHostEnvironmentDaemonLaunchCommand()).toEqual({
      command: process.execPath,
      args: [artifactEntry],
    });
  });

  it("coalesces concurrent managed agent startup for the same thread", async () => {
    const bbRoot = makeTempDir();
    process.env.BB_ROOT = bbRoot;
    const projectId = `project-${Date.now()}`;
    const workspaceRoot = makeTempDir();

    const waitGate = createDeferred();
    const spawnProcess = vi.fn(() => ({
      pid: 4321,
      unref: vi.fn(),
    })) as unknown as typeof import("node:child_process").spawn;

    const ensureArgs = {
      workspaceRootPath: workspaceRoot,
      projectId,
      environmentId: "worktree",
      runtimeEnv: { BB_ROOT: bbRoot },
    };
    const deps = {
      allocatePort: async () => 4123,
      generateAuthToken: () => "auth-token",
      resolveLaunchCommand: () => ({
        command: process.execPath,
        args: ["agent.mjs"],
      }),
      spawnProcess,
      waitForAgent: async () => {
        await waitGate.promise;
      },
    };

    const first = ensureManagedHostEnvironmentDaemon(ensureArgs, deps);
    const second = ensureManagedHostEnvironmentDaemon(ensureArgs, deps);

    await Promise.resolve();
    await Promise.resolve();

    expect(spawnProcess).toHaveBeenCalledTimes(1);

    waitGate.resolve();
    await Promise.all([first, second]);

    expect(__testOnly__getManagedHostEnvironmentDaemonRecord({
      projectId,
      environmentId: "worktree",
      workspaceRootPath: workspaceRoot,
    })).toMatchObject({
      pid: 4321,
      port: 4123,
      authToken: "auth-token",
      projectId,
      environmentId: "worktree",
      workspaceRoot,
    });
  });

  it("adopts a healthy reconnect target instead of spawning a duplicate agent", async () => {
    const bbRoot = makeTempDir();
    process.env.BB_ROOT = bbRoot;
    const projectId = `project-${Date.now()}`;
    const workspaceRoot = makeTempDir();
    const spawnProcess = vi.fn();

    const target = await ensureManagedHostEnvironmentDaemon(
      {
        workspaceRootPath: workspaceRoot,
        projectId,
        environmentId: "local",
        runtimeEnv: { BB_ROOT: bbRoot },
        reconnectTarget: {
          baseUrl: "http://127.0.0.1:4310",
          authToken: "reconnect-token",
        },
      },
      {
        spawnProcess: spawnProcess as unknown as typeof import("node:child_process").spawn,
        pingAgent: async () => true,
        waitForAgent: async () => {
          throw new Error("should not launch a new agent");
        },
      },
    );

    expect(spawnProcess).not.toHaveBeenCalled();
    expect(target).toMatchObject({
      baseUrl: "http://127.0.0.1:4310",
      headers: {
        authorization: "Bearer reconnect-token",
      },
    });
    expect(__testOnly__getManagedHostEnvironmentDaemonRecord({
      projectId,
      environmentId: "local",
      workspaceRootPath: workspaceRoot,
    })).toMatchObject({
      baseUrl: "http://127.0.0.1:4310",
      authToken: "reconnect-token",
      pid: undefined,
    });
  });

  it("reuses an existing healthy managed agent instead of replacing it", async () => {
    const bbRoot = makeTempDir();
    process.env.BB_ROOT = bbRoot;
    const projectId = `project-${Date.now()}`;
    const workspaceRoot = makeTempDir();

    const first = await ensureManagedHostEnvironmentDaemon(
      {
        workspaceRootPath: workspaceRoot,
        projectId,
        environmentId: "local",
        runtimeEnv: { BB_ROOT: bbRoot },
      },
      {
        allocatePort: async () => 4311,
        generateAuthToken: () => "auth-token",
        resolveLaunchCommand: () => ({
          command: process.execPath,
          args: ["agent.mjs"],
        }),
        spawnProcess: vi.fn(() => ({
          pid: 4321,
          unref: vi.fn(),
        })) as unknown as typeof import("node:child_process").spawn,
        waitForAgent: async () => {},
        isProcessAlive: () => true,
        killProcess: vi.fn(),
      },
    );

    const killProcess = vi.fn();
    const second = await ensureManagedHostEnvironmentDaemon(
      {
        workspaceRootPath: workspaceRoot,
        projectId,
        environmentId: "local",
        runtimeEnv: { BB_ROOT: bbRoot },
      },
      {
        spawnProcess: vi.fn() as unknown as typeof import("node:child_process").spawn,
        waitForAgent: async () => {
          throw new Error("should not relaunch");
        },
        isProcessAlive: () => true,
        killProcess,
      },
    );

    expect(second).toEqual(first);
    expect(killProcess).not.toHaveBeenCalled();
  });

  it("forwards BB_THREAD_ID to the managed environment-daemon process", async () => {
    const bbRoot = makeTempDir();
    process.env.BB_ROOT = bbRoot;
    const projectId = `project-${Date.now()}`;
    const workspaceRoot = makeTempDir();
    const spawnProcess = vi.fn(() => ({
      pid: 4321,
      unref: vi.fn(),
    })) as unknown as typeof import("node:child_process").spawn;

    await ensureManagedHostEnvironmentDaemon(
      {
        workspaceRootPath: workspaceRoot,
        projectId,
        environmentId: "local",
        runtimeEnv: {
          BB_ROOT: bbRoot,
          BB_THREAD_ID: "thread-123",
        },
      },
      {
        allocatePort: async () => 4312,
        generateAuthToken: () => "auth-token",
        resolveLaunchCommand: () => ({
          command: process.execPath,
          args: ["agent.mjs"],
        }),
        spawnProcess,
        waitForAgent: async () => {},
        isProcessAlive: () => true,
        killProcess: vi.fn(),
      },
    );

    expect(spawnProcess).toHaveBeenCalledWith(
      process.execPath,
      expect.any(Array),
      expect.objectContaining({
        env: expect.objectContaining({
          BB_THREAD_ID: "thread-123",
        }),
      }),
    );
  });

  it("reuses the same managed agent across threads on one environment", async () => {
    const bbRoot = makeTempDir();
    process.env.BB_ROOT = bbRoot;
    const projectId = `project-${Date.now()}`;
    const workspaceRoot = makeTempDir();
    const spawnProcess = vi.fn(() => ({
      pid: 4321,
      unref: vi.fn(),
    })) as unknown as typeof import("node:child_process").spawn;

    const first = await ensureManagedHostEnvironmentDaemon(
      {
        workspaceRootPath: workspaceRoot,
        projectId,
        environmentId: "env-1",
        runtimeEnv: { BB_ROOT: bbRoot },
      },
      {
        allocatePort: async () => 4312,
        generateAuthToken: () => "auth-token",
        resolveLaunchCommand: () => ({
          command: process.execPath,
          args: ["agent.mjs"],
        }),
        spawnProcess,
        waitForAgent: async () => {},
        isProcessAlive: () => true,
      },
    );

    const second = await ensureManagedHostEnvironmentDaemon(
      {
        workspaceRootPath: workspaceRoot,
        projectId,
        environmentId: "env-1",
        runtimeEnv: { BB_ROOT: bbRoot },
      },
      {
        spawnProcess,
        waitForAgent: async () => {
          throw new Error("should not relaunch");
        },
        isProcessAlive: () => true,
      },
    );

    expect(second).toEqual(first);
    expect(spawnProcess).toHaveBeenCalledTimes(1);
  });

  it("removes the managed agent record and escalates to SIGKILL when SIGTERM does not exit promptly", async () => {
    const bbRoot = makeTempDir();
    process.env.BB_ROOT = bbRoot;
    const projectId = `project-${Date.now()}`;
    const workspaceRoot = makeTempDir();
    const runtimeEnv = { BB_ROOT: bbRoot };

    await ensureManagedHostEnvironmentDaemon(
      {
        workspaceRootPath: workspaceRoot,
        projectId,
        environmentId: "local",
        runtimeEnv,
      },
      {
        allocatePort: async () => 4123,
        generateAuthToken: () => "auth-token",
        resolveLaunchCommand: () => ({
          command: process.execPath,
          args: ["agent.mjs"],
        }),
        spawnProcess: vi.fn(() => ({
          pid: 4321,
          unref: vi.fn(),
        })) as unknown as typeof import("node:child_process").spawn,
        waitForAgent: async () => {},
      },
    );

    const killProcess = vi.fn((_pid: number, _signal?: string | number) => true);
    let now = 0;
    vi.spyOn(Date, "now").mockImplementation(() => now);
    const isProcessAlive = vi.fn<(pid: number) => boolean>(
      () => killProcess.mock.calls.length < 2,
    );

    await disposeManagedHostEnvironmentDaemon(
      {
        projectId,
        environmentId: "local",
        workspaceRootPath: workspaceRoot,
        runtimeEnv,
      },
      {
        isProcessAlive,
        killProcess,
        sleepMs: async (ms: number) => {
          now += ms;
        },
      },
    );

    expect(killProcess).toHaveBeenNthCalledWith(1, 4321, "SIGTERM");
    expect(killProcess).toHaveBeenNthCalledWith(2, 4321, "SIGKILL");
    expect(__testOnly__getManagedHostEnvironmentDaemonRecord({
      projectId,
      environmentId: "local",
      workspaceRootPath: workspaceRoot,
    })).toBeUndefined();
  });

  it("keeps an adopted managed agent record when shutdown fails but the agent is still reachable", async () => {
    const bbRoot = makeTempDir();
    process.env.BB_ROOT = bbRoot;
    const projectId = `project-${Date.now()}`;
    const workspaceRoot = makeTempDir();
    const runtimeEnv = { BB_ROOT: bbRoot };

    await ensureManagedHostEnvironmentDaemon(
      {
        workspaceRootPath: workspaceRoot,
        projectId,
        environmentId: "local",
        runtimeEnv,
        reconnectTarget: {
          baseUrl: "http://127.0.0.1:4310",
          authToken: "reconnect-token",
        },
      },
      {
        pingAgent: async () => true,
        waitForAgent: async () => {
          throw new Error("should not launch a new agent");
        },
      },
    );

    const requestShutdown = vi.fn(async () => {
      throw new Error("shutdown failed");
    });

    await disposeManagedHostEnvironmentDaemon(
      {
        projectId,
        environmentId: "local",
        workspaceRootPath: workspaceRoot,
        runtimeEnv,
      },
      {
        requestShutdown,
        pingAgent: async () => true,
      },
    );

    expect(requestShutdown).toHaveBeenCalledWith(
      "http://127.0.0.1:4310",
      "reconnect-token",
    );
    expect(__testOnly__getManagedHostEnvironmentDaemonRecord({
      projectId,
      environmentId: "local",
      workspaceRootPath: workspaceRoot,
    })).toMatchObject({
      baseUrl: "http://127.0.0.1:4310",
      authToken: "reconnect-token",
      pid: undefined,
    });
  });
});
