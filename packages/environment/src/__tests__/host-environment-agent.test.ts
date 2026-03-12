import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  __testOnly__getManagedHostEnvironmentAgentRecord,
  disposeManagedHostEnvironmentAgent,
  ensureManagedHostEnvironmentAgent,
  resolveManagedHostEnvironmentAgentLaunchCommand,
} from "../host-environment-agent.js";

const tempDirs: string[] = [];
const originalBeanbagRoot = process.env.BEANBAG_ROOT;

function makeTempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "bb-host-env-agent-"));
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
  process.env.BEANBAG_ROOT = originalBeanbagRoot;
  vi.restoreAllMocks();
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe("host environment-agent helper", () => {
  it("launches the standalone environment-agent artifact directly", () => {
    const artifactEntry = fileURLToPath(
      new URL("../../../environment-agent/dist/environment-agent.bundle.mjs", import.meta.url),
    );
    mkdirSync(dirname(artifactEntry), { recursive: true });
    if (!existsSync(artifactEntry)) {
      writeFileSync(artifactEntry, "console.log('agent')\n", "utf8");
    }

    expect(resolveManagedHostEnvironmentAgentLaunchCommand()).toEqual({
      command: process.execPath,
      args: [artifactEntry],
    });
  });

  it("coalesces concurrent managed agent startup for the same thread", async () => {
    const beanbagRoot = makeTempDir();
    process.env.BEANBAG_ROOT = beanbagRoot;
    const projectId = `project-${Date.now()}`;
    const workspaceRoot = makeTempDir();

    const waitGate = createDeferred();
    const spawnProcess = vi.fn(() => ({
      pid: 4321,
      unref: vi.fn(),
    })) as unknown as typeof import("node:child_process").spawn;

    const ensureArgs = {
      workspaceRootPath: workspaceRoot,
      threadId: "thread-1",
      projectId,
      environmentId: "worktree",
      runtimeEnv: { BEANBAG_ROOT: beanbagRoot },
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

    const first = ensureManagedHostEnvironmentAgent(ensureArgs, deps);
    const second = ensureManagedHostEnvironmentAgent(ensureArgs, deps);

    await Promise.resolve();
    await Promise.resolve();

    expect(spawnProcess).toHaveBeenCalledTimes(1);

    waitGate.resolve();
    await Promise.all([first, second]);

    expect(__testOnly__getManagedHostEnvironmentAgentRecord({
      projectId,
      threadId: "thread-1",
      environmentId: "worktree",
      workspaceRootPath: workspaceRoot,
    })).toMatchObject({
      pid: 4321,
      port: 4123,
      authToken: "auth-token",
      threadId: "thread-1",
      projectId,
      environmentId: "worktree",
      workspaceRoot,
    });
  });

  it("adopts a healthy reconnect target instead of spawning a duplicate agent", async () => {
    const beanbagRoot = makeTempDir();
    process.env.BEANBAG_ROOT = beanbagRoot;
    const projectId = `project-${Date.now()}`;
    const workspaceRoot = makeTempDir();
    const spawnProcess = vi.fn();

    const target = await ensureManagedHostEnvironmentAgent(
      {
        workspaceRootPath: workspaceRoot,
        threadId: "thread-1",
        projectId,
        environmentId: "local",
        runtimeEnv: { BEANBAG_ROOT: beanbagRoot },
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
    expect(__testOnly__getManagedHostEnvironmentAgentRecord({
      projectId,
      threadId: "thread-1",
      environmentId: "local",
      workspaceRootPath: workspaceRoot,
    })).toMatchObject({
      baseUrl: "http://127.0.0.1:4310",
      authToken: "reconnect-token",
      pid: undefined,
    });
  });

  it("reuses an existing healthy managed agent instead of replacing it", async () => {
    const beanbagRoot = makeTempDir();
    process.env.BEANBAG_ROOT = beanbagRoot;
    const projectId = `project-${Date.now()}`;
    const workspaceRoot = makeTempDir();

    const first = await ensureManagedHostEnvironmentAgent(
      {
        workspaceRootPath: workspaceRoot,
        threadId: "thread-1",
        projectId,
        environmentId: "local",
        runtimeEnv: { BEANBAG_ROOT: beanbagRoot },
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
    const second = await ensureManagedHostEnvironmentAgent(
      {
        workspaceRootPath: workspaceRoot,
        threadId: "thread-1",
        projectId,
        environmentId: "local",
        runtimeEnv: { BEANBAG_ROOT: beanbagRoot },
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

  it("removes the managed agent record and escalates to SIGKILL when SIGTERM does not exit promptly", async () => {
    const beanbagRoot = makeTempDir();
    process.env.BEANBAG_ROOT = beanbagRoot;
    const projectId = `project-${Date.now()}`;
    const workspaceRoot = makeTempDir();
    const runtimeEnv = { BEANBAG_ROOT: beanbagRoot };

    await ensureManagedHostEnvironmentAgent(
      {
        workspaceRootPath: workspaceRoot,
        threadId: "thread-1",
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

    await disposeManagedHostEnvironmentAgent(
      {
        projectId,
        threadId: "thread-1",
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
    expect(__testOnly__getManagedHostEnvironmentAgentRecord({
      projectId,
      threadId: "thread-1",
      environmentId: "local",
      workspaceRootPath: workspaceRoot,
    })).toBeUndefined();
  });
});
