import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  readCommandCursor,
  writeCommandCursor,
} from "./command-cursor.js";

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

describe("command cursor", () => {
  it("writes the cursor and reads it back", async () => {
    const dataDir = await makeTempDir("bb-host-daemon-cursor-");

    await writeCommandCursor(dataDir, 42);

    await expect(readCommandCursor(dataDir)).resolves.toBe(42);
  });

  it("returns 0 when the cursor file does not exist", async () => {
    const dataDir = await makeTempDir("bb-host-daemon-cursor-missing-");

    await expect(readCommandCursor(dataDir)).resolves.toBe(0);
  });

  it("writes atomically by writing to a temp file before renaming", async () => {
    const operations: string[] = [];
    const mkdir = vi.fn(async () => undefined);
    const writeFile = vi.fn(async (filePath: string, data: string) => {
      operations.push(`write:${filePath}:${data.trim()}`);
    });
    const rename = vi.fn(async (from: string, to: string) => {
      operations.push(`rename:${from}:${to}`);
    });

    await writeCommandCursor("/tmp/bb-cursor", 9, {
      mkdir: mkdir as typeof fs.mkdir,
      writeFile: writeFile as typeof fs.writeFile,
      rename: rename as typeof fs.rename,
      randomSuffix: () => "fixed",
    });

    expect(operations).toEqual([
      "write:/tmp/bb-cursor/command-cursor.tmp-fixed:9",
      "rename:/tmp/bb-cursor/command-cursor.tmp-fixed:/tmp/bb-cursor/command-cursor",
    ]);
  });
});
