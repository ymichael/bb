import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  createRotatingJsonLineFileWriter,
  removeRotatingJsonLineFileArtifacts,
} from "./rotating-file-logger.js";

const cleanupPaths: string[] = [];

afterEach(() => {
  for (const path of cleanupPaths.splice(0)) {
    rmSync(path, { recursive: true, force: true });
  }
});

describe("rotating file logger", () => {
  it("writes json lines to the configured file", () => {
    const dir = mkdtempSync(join(tmpdir(), "bb-rotating-logger-"));
    cleanupPaths.push(dir);
    const filePath = join(dir, "agent.log");
    const writer = createRotatingJsonLineFileWriter({
      filePath,
      maxBytes: 10_000,
      maxFiles: 3,
    });

    writer.write({ message: "first" });
    writer.write({ message: "second" });

    const lines = readFileSync(filePath, "utf8").trim().split("\n");
    expect(lines).toHaveLength(2);
    expect(lines.map((line) => JSON.parse(line))).toEqual([
      { message: "first" },
      { message: "second" },
    ]);
  });

  it("rotates files and caps the number of retained archives", () => {
    const dir = mkdtempSync(join(tmpdir(), "bb-rotating-logger-"));
    cleanupPaths.push(dir);
    const filePath = join(dir, "agent.log");
    const writer = createRotatingJsonLineFileWriter({
      filePath,
      maxBytes: 1,
      maxFiles: 3,
    });

    writer.write({ entry: 1 });
    writer.write({ entry: 2 });
    writer.write({ entry: 3 });
    writer.write({ entry: 4 });

    expect(JSON.parse(readFileSync(filePath, "utf8").trim())).toEqual({
      entry: 4,
    });
    expect(JSON.parse(readFileSync(`${filePath}.1`, "utf8").trim())).toEqual({
      entry: 3,
    });
    expect(JSON.parse(readFileSync(`${filePath}.2`, "utf8").trim())).toEqual({
      entry: 2,
    });
  });

  it("removes the active log file and retained archives", () => {
    const dir = mkdtempSync(join(tmpdir(), "bb-rotating-logger-"));
    cleanupPaths.push(dir);
    const filePath = join(dir, "agent.log");
    const writer = createRotatingJsonLineFileWriter({
      filePath,
      maxBytes: 1,
      maxFiles: 4,
    });

    writer.write({ entry: 1 });
    writer.write({ entry: 2 });
    writer.write({ entry: 3 });

    removeRotatingJsonLineFileArtifacts(filePath);

    expect(existsSync(filePath)).toBe(false);
    expect(existsSync(`${filePath}.1`)).toBe(false);
    expect(existsSync(`${filePath}.2`)).toBe(false);
  });
});
