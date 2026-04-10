import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  replaceManagedRuntimeFiles,
  resolveRuntimeMaterialEnv,
} from "../src/index.js";

const tempDirs: string[] = [];

async function makeTempDir(prefix: string): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(
    tempDirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })),
  );
});

describe("runtime material files", () => {
  it("writes managed files and deletes removed files", async () => {
    const rootDir = await makeTempDir("bb-runtime-material-files-");
    vi.spyOn(os, "homedir").mockReturnValue(rootDir);
    const previousPath = path.join(rootDir, ".claude", "credentials.json");
    const nextPath = path.join(rootDir, ".codex", "auth.json");
    await fs.mkdir(path.dirname(previousPath), { recursive: true });
    await fs.writeFile(previousPath, "{\"old\":true}\n", "utf8");

    await replaceManagedRuntimeFiles({
      previousState: {
        files: [
          {
            managedBy: "bb-runtime-material",
            path: "~/.claude/credentials.json",
          },
        ],
        version: "previous",
      },
      nextSnapshot: {
        env: {},
        files: [
          {
            contents: "{\"new\":true}\n",
            managedBy: "bb-runtime-material",
            mode: 0o600,
            path: "~/.codex/auth.json",
          },
        ],
        version: "next",
      },
    });

    await expect(fs.readFile(nextPath, "utf8")).resolves.toBe("{\"new\":true}\n");
    const stats = await fs.stat(nextPath);
    expect(stats.mode & 0o777).toBe(0o600);
    await expect(fs.access(previousPath)).rejects.toMatchObject({
      code: "ENOENT",
    });
  });

  it("rejects managed file paths that escape the home directory", async () => {
    const rootDir = await makeTempDir("bb-runtime-material-files-");
    vi.spyOn(os, "homedir").mockReturnValue(rootDir);

    await expect(
      replaceManagedRuntimeFiles({
        previousState: null,
        nextSnapshot: {
          env: {},
          files: [
            {
              contents: "leak\n",
              managedBy: "bb-runtime-material",
              mode: 0o600,
              path: "~/./.ssh/authorized_keys",
            },
            {
              contents: "leak\n",
              managedBy: "bb-runtime-material",
              mode: 0o600,
              path: "~/../../etc/passwd",
            },
          ],
          version: "next",
        },
      }),
    ).rejects.toThrow("escapes the home directory");
  });

  it("expands home-relative env paths", () => {
    vi.spyOn(os, "homedir").mockReturnValue("/tmp/runtime-home");

    expect(
      resolveRuntimeMaterialEnv({
        PI_CODING_AGENT_DIR: "~/.pi/agent",
        OPENAI_API_KEY: "test-openai-key",
      }),
    ).toEqual({
      PI_CODING_AGENT_DIR: "/tmp/runtime-home/.pi/agent",
      OPENAI_API_KEY: "test-openai-key",
    });
  });
});
