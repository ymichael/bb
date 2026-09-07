import { spawn } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { experimental_createHostEntryHarness } from "@get-bb/plugin-sdk/testing/host";
import { afterEach, describe, expect, it } from "vitest";
import { createPersonalWorkspaceHostEntry } from "./host.js";

const temporaryRoots: string[] = [];

async function createDataDir(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "bb-personal-workspace-plugin-"));
  temporaryRoots.push(root);
  return join(root, "plugin-data");
}

function isPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function createHarness(dataDir: string) {
  return experimental_createHostEntryHarness(
    createPersonalWorkspaceHostEntry(),
    {
      experimental_paths: { dataDir, tempDir: join(dataDir, "tmp") },
    },
  );
}

afterEach(async () => {
  await Promise.all(
    temporaryRoots
      .splice(0)
      .map((root) => rm(root, { recursive: true, force: true })),
  );
});

describe("personal workspace host entry", () => {
  it("kills processes still running inside a workspace before removing it", async () => {
    const dataDir = await createDataDir();
    const harness = createHarness(dataDir);
    const created = await harness.experimental_call("createWorkspace", {
      pathKey: "thr_busy",
    });
    const child = spawn("sleep", ["300"], {
      cwd: created.path,
      detached: true,
      stdio: "ignore",
    });
    child.unref();

    try {
      const removed = await harness.experimental_call("removeWorkspace", {
        pathKey: "thr_busy",
        path: created.path,
      });

      expect(removed).toEqual({ removed: true });
      expect(existsSync(created.path)).toBe(false);
      expect(isPidAlive(child.pid ?? 0)).toBe(false);
    } finally {
      child.kill("SIGKILL");
    }
  });

  it("creates a thread's workspace under the plugin data dir and removes it with its contents", async () => {
    const dataDir = await createDataDir();
    const harness = createHarness(dataDir);

    const created = await harness.experimental_call("createWorkspace", {
      pathKey: "thr_a",
    });
    expect(created.path).toBe(join(dataDir, "workspaces", "thr_a"));
    expect(existsSync(created.path)).toBe(true);
    await writeFile(join(created.path, "notes.md"), "hello\n");

    expect(
      await harness.experimental_call("createWorkspace", { pathKey: "thr_a" }),
    ).toEqual(created);
    expect(existsSync(join(created.path, "notes.md"))).toBe(true);

    expect(
      await harness.experimental_call("removeWorkspace", {
        pathKey: "thr_a",
        path: created.path,
      }),
    ).toEqual({ removed: true });
    expect(existsSync(created.path)).toBe(false);
    expect(
      await harness.experimental_call("removeWorkspace", {
        pathKey: "thr_a",
        path: created.path,
      }),
    ).toEqual({ removed: false });
  });

  it("removes a workspace core made, so a migrated environment can retire", async () => {
    const dataDir = await createDataDir();
    const harness = createHarness(dataDir);
    const legacyPath = join(
      dataDir,
      "..",
      "personal-workspaces",
      "env_migrated",
    );
    await mkdir(legacyPath, { recursive: true });
    await writeFile(join(legacyPath, "notes.md"), "hello\n");

    expect(
      await harness.experimental_call("removeWorkspace", {
        pathKey: "env_migrated",
        path: legacyPath,
      }),
    ).toEqual({ removed: true });
    expect(existsSync(legacyPath)).toBe(false);
  });

  it("finds an interrupted workspace from its path key when the path is unknown", async () => {
    const dataDir = await createDataDir();
    const harness = createHarness(dataDir);
    const created = await harness.experimental_call("createWorkspace", {
      pathKey: "thr_interrupted",
    });

    expect(
      await harness.experimental_call("removeWorkspace", {
        pathKey: "thr_interrupted",
        path: null,
      }),
    ).toEqual({ removed: true });
    expect(existsSync(created.path)).toBe(false);
  });

  it("refuses a path outside the personal workspace roots", async () => {
    const dataDir = await createDataDir();
    const harness = createHarness(dataDir);
    const outside = join(dataDir, "..", "checkouts", "bb");

    await expect(
      harness.experimental_call("removeWorkspace", {
        pathKey: "outside",
        path: outside,
      }),
    ).rejects.toThrow(/outside the personal workspace roots/);
    await expect(
      harness.experimental_call("createWorkspace", { pathKey: "../escape" }),
    ).rejects.toThrow(/single path segment/);
  });
});
