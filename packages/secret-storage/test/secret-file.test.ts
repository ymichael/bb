import { mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { readOrCreateSecretFile } from "../src/index.js";

const tempDirs: string[] = [];

async function makeTempDir(): Promise<string> {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "bb-secret-file-"));
  tempDirs.push(tempDir);
  return tempDir;
}

afterEach(async () => {
  await Promise.all(
    tempDirs.splice(0).map((tempDir) =>
      rm(tempDir, { force: true, recursive: true })
    ),
  );
});

describe("secret file", () => {
  it("reuses the same secret across repeated reads", async () => {
    const dataDir = await makeTempDir();

    const first = await readOrCreateSecretFile({
      bytes: 32,
      dataDir,
      fileName: "secret",
    });
    const second = await readOrCreateSecretFile({
      bytes: 32,
      dataDir,
      fileName: "secret",
    });

    expect(second).toBe(first);
    expect((await stat(path.join(dataDir, "secret"))).mode & 0o777).toBe(0o600);
  });

  it("returns the same secret to concurrent creators", async () => {
    const dataDir = await makeTempDir();

    const results = await Promise.all(
      Array.from({ length: 8 }, () =>
        readOrCreateSecretFile({
          bytes: 32,
          dataDir,
          fileName: "secret",
        })
      ),
    );

    expect(new Set(results).size).toBe(1);
  });

  it("throws when an existing secret file is empty", async () => {
    const dataDir = await makeTempDir();
    await writeFile(path.join(dataDir, "secret"), "\n", "utf8");

    await expect(
      readOrCreateSecretFile({
        bytes: 32,
        dataDir,
        fileName: "secret",
      }),
    ).rejects.toThrow("Failed to initialize secret");
  });
});
