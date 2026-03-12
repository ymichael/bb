import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  __testOnly__resolveManagedHostEnvironmentAgentStateFilePath,
  disposeManagedHostEnvironmentAgent,
  ensureManagedHostEnvironmentAgent,
  resolveManagedHostEnvironmentAgentLaunchCommand,
  resolveManagedHostEnvironmentAgentTarget,
} from "../host-environment-agent.js";

const tempDirs: string[] = [];
const cleanupPaths: string[] = [];
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
  for (const path of cleanupPaths.splice(0)) {
    rmSync(path, { recursive: true, force: true });
  }
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe("resolveManagedHostEnvironmentAgentTarget", () => {
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

  it("returns an http target when a managed agent record exists", () => {
    vi.spyOn(process, "kill").mockImplementation((_pid: number, _signal?: string | number) => {
      return true;
    });

    const beanbagRoot = makeTempDir();
    process.env.BEANBAG_ROOT = beanbagRoot;
    const projectId = `project-${Date.now()}`;
    const workspaceRoot = makeTempDir();
    const stateDir = join(beanbagRoot, "environment-agents", projectId);
    cleanupPaths.push(stateDir);
    mkdirSync(stateDir, { recursive: true });
    writeFileSync(
      __testOnly__resolveManagedHostEnvironmentAgentStateFilePath({
        projectId,
        threadId: "thread-1",
        environmentId: "worktree",
        workspaceRootPath: workspaceRoot,
      }),
      JSON.stringify({
        version: 1,
        pid: 4321,
        port: 4123,
        baseUrl: "http://127.0.0.1:4123",
        authToken: "auth-token",
        threadId: "thread-1",
        projectId: "project-1",
        environmentId: "worktree",
        workspaceRoot,
      }),
      "utf8",
    );

    expect(
      resolveManagedHostEnvironmentAgentTarget({
        projectId,
        threadId: "thread-1",
        environmentId: "worktree",
        workspaceRootPath: workspaceRoot,
        runtimeEnv: { BEANBAG_ROOT: beanbagRoot },
      }),
    ).toEqual({
      transport: "http",
      baseUrl: "http://127.0.0.1:4123",
      headers: {
        authorization: "Bearer auth-token",
      },
    });
  });

  it("finds a managed agent record when only runtimeEnv overrides the beanbag root", () => {
    vi.spyOn(process, "kill").mockImplementation((_pid: number, _signal?: string | number) => {
      return true;
    });

    const beanbagRoot = makeTempDir();
    const projectId = `project-${Date.now()}`;
    const workspaceRoot = makeTempDir();
    const runtimeEnv = { BEANBAG_ROOT: beanbagRoot };
    const stateDir = join(beanbagRoot, "environment-agents", projectId);
    cleanupPaths.push(stateDir);
    mkdirSync(stateDir, { recursive: true });
    writeFileSync(
      __testOnly__resolveManagedHostEnvironmentAgentStateFilePath({
        projectId,
        threadId: "thread-1",
        environmentId: "worktree",
        workspaceRootPath: workspaceRoot,
        runtimeEnv,
      }),
      JSON.stringify({
        version: 1,
        pid: 4321,
        port: 4123,
        baseUrl: "http://127.0.0.1:4123",
        authToken: "auth-token",
        threadId: "thread-1",
        projectId,
        environmentId: "worktree",
        workspaceRoot,
      }),
      "utf8",
    );

    expect(
      resolveManagedHostEnvironmentAgentTarget({
        projectId,
        threadId: "thread-1",
        environmentId: "worktree",
        workspaceRootPath: workspaceRoot,
        runtimeEnv,
      }),
    ).toEqual({
      transport: "http",
      baseUrl: "http://127.0.0.1:4123",
      headers: {
        authorization: "Bearer auth-token",
      },
    });
  });

  it("coalesces concurrent managed agent startup for the same thread", async () => {
    const beanbagRoot = makeTempDir();
    process.env.BEANBAG_ROOT = beanbagRoot;
    const projectId = `project-${Date.now()}`;
    const workspaceRoot = makeTempDir();
    const statePath = __testOnly__resolveManagedHostEnvironmentAgentStateFilePath({
      projectId,
      threadId: "thread-1",
      environmentId: "worktree",
      workspaceRootPath: workspaceRoot,
    });
    cleanupPaths.push(join(beanbagRoot, "environment-agents", projectId));

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

    expect(JSON.parse(readFileSync(statePath, "utf8"))).toMatchObject({
      pid: 4321,
      port: 4123,
      authToken: "auth-token",
      threadId: "thread-1",
      projectId,
      environmentId: "worktree",
      workspaceRoot,
    });
  });

  it("removes the managed agent record and escalates to SIGKILL when SIGTERM does not exit promptly", async () => {
    const beanbagRoot = makeTempDir();
    const projectId = `project-${Date.now()}`;
    const workspaceRoot = makeTempDir();
    const runtimeEnv = { BEANBAG_ROOT: beanbagRoot };
    const statePath = __testOnly__resolveManagedHostEnvironmentAgentStateFilePath({
      projectId,
      threadId: "thread-1",
      environmentId: "local",
      workspaceRootPath: workspaceRoot,
      runtimeEnv,
    });
    cleanupPaths.push(join(beanbagRoot, "environment-agents", projectId));
    mkdirSync(dirname(statePath), { recursive: true });
    writeFileSync(
      statePath,
      JSON.stringify({
        version: 1,
        pid: 4321,
        port: 4123,
        baseUrl: "http://127.0.0.1:4123",
        authToken: "auth-token",
        threadId: "thread-1",
        projectId,
        environmentId: "local",
        workspaceRoot,
      }),
      "utf8",
    );

    const killProcess = vi.fn((_pid: number, _signal?: string | number) => true);
    let now = 0;
    vi.spyOn(Date, "now").mockImplementation(() => now);
    const isProcessAlive = vi.fn<(pid: number) => boolean>(() => killProcess.mock.calls.length < 2);

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
    expect(existsSync(statePath)).toBe(false);
  });
});
