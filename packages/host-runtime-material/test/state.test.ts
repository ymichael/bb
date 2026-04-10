import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { HOST_RUNTIME_MATERIAL_FILE_NAME } from "@bb/host-daemon-contract";
import {
  readRuntimeMaterialState,
  writeRuntimeMaterialState,
} from "../src/index.js";

const tempDirs: string[] = [];

async function makeTempDir(prefix: string): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

afterEach(async () => {
  await Promise.all(
    tempDirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })),
  );
});

describe("runtime material state", () => {
  it("returns null when no persisted snapshot exists", async () => {
    const dataDir = await makeTempDir("bb-host-daemon-runtime-material-");

    await expect(readRuntimeMaterialState(dataDir)).resolves.toBeNull();
  });

  it("writes runtime material state metadata with secure permissions and reads it back", async () => {
    const dataDir = await makeTempDir("bb-host-daemon-runtime-material-");

    await writeRuntimeMaterialState(dataDir, {
      files: [
        {
          managedBy: "bb-runtime-material",
          path: "~/.codex/auth.json",
        },
      ],
      version: "runtime-version-1",
    });

    await expect(readRuntimeMaterialState(dataDir)).resolves.toEqual({
      files: [
        {
          managedBy: "bb-runtime-material",
          path: "~/.codex/auth.json",
        },
      ],
      version: "runtime-version-1",
    });

    const snapshotPath = path.join(dataDir, HOST_RUNTIME_MATERIAL_FILE_NAME);
    const stats = await fs.stat(snapshotPath);
    expect(stats.mode & 0o777).toBe(0o600);

    const dataDirStats = await fs.stat(dataDir);
    expect(dataDirStats.mode & 0o777).toBe(0o700);
  });
});
