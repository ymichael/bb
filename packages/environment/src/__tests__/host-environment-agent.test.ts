import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  resolveManagedHostEnvironmentAgentLaunchCommand,
  resolveManagedHostEnvironmentAgentTarget,
} from "../host-environment-agent.js";

const tempDirs: string[] = [];
const cleanupPaths: string[] = [];

function makeTempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "bb-host-env-agent-"));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
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

    const projectId = `project-${Date.now()}`;
    const workspaceRoot = makeTempDir();
    const stateDir = join(homedir(), ".beanbag", "environment-agents", projectId);
    cleanupPaths.push(stateDir);
    mkdirSync(stateDir, { recursive: true });
    writeFileSync(
      join(stateDir, "worktree-thread-1.json"),
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
        runtimeEnv: {},
      }),
    ).toEqual({
      transport: "http",
      baseUrl: "http://127.0.0.1:4123",
      headers: {
        authorization: "Bearer auth-token",
      },
    });
  });
});
