import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  __testOnly__getManagedHostEnvironmentAgentRecord,
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
});
