import type { ChildProcess, SpawnOptions } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

interface SpawnInvocation {
  args: readonly string[];
  command: string;
  options: SpawnOptions;
}

interface SpawnMockState {
  children: ChildProcess[];
  invocations: SpawnInvocation[];
  tempDirs: string[];
}

function createSpawnMockState(): SpawnMockState {
  return {
    children: [],
    invocations: [],
    tempDirs: [],
  };
}

const spawnMockState = vi.hoisted(createSpawnMockState);

vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:child_process")>();

  return {
    ...actual,
    spawn(
      command: string,
      args: readonly string[],
      options?: SpawnOptions,
    ): ChildProcess {
      spawnMockState.invocations.push({
        args,
        command,
        options: options ?? {},
      });

      const child = actual.spawn(
        process.execPath,
        ["-e", "setTimeout(() => {}, 60_000)"],
        {
          stdio: "ignore",
        },
      );
      spawnMockState.children.push(child);
      return child;
    },
  };
});

import { spawnLoggedProcess } from "../src/shared.js";

afterEach(() => {
  for (const child of spawnMockState.children) {
    child.kill();
  }
  spawnMockState.children.length = 0;
  spawnMockState.invocations.length = 0;

  for (const tempDir of spawnMockState.tempDirs) {
    rmSync(tempDir, { force: true, recursive: true });
  }
  spawnMockState.tempDirs.length = 0;
});

describe("spawnLoggedProcess", () => {
  it("detaches standalone processes from the wrapper lifecycle", () => {
    const tempDir = mkdtempSync(path.join(tmpdir(), "spawn-logged-process-"));
    spawnMockState.tempDirs.push(tempDir);
    const logPath = path.join(tempDir, "process.log");

    const child = spawnLoggedProcess({
      args: ["apps/server/dist/index.js"],
      command: process.execPath,
      cwd: "/repo",
      env: {
        PATH: process.env.PATH ?? "",
      },
      logPath,
    });

    expect(child.pid).toBeGreaterThan(0);
    expect(spawnMockState.invocations).toHaveLength(1);
    expect(spawnMockState.invocations[0]?.command).toBe(process.execPath);
    expect(spawnMockState.invocations[0]?.args).toEqual([
      "apps/server/dist/index.js",
    ]);
    expect(spawnMockState.invocations[0]?.options.cwd).toBe("/repo");
    expect(spawnMockState.invocations[0]?.options.detached).toBe(true);
  });
});
