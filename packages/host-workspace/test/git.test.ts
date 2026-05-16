import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  parseBranchStatus,
  parseNameStatusEntries,
  parseNumstatEntriesZ,
  parsePorcelainEntries,
  readGitBlob,
  runGit,
  summarizeNumstat,
} from "../src/git.js";

const tempDirs: string[] = [];

async function initReadGitBlobRepo() {
  const repoPath = await fs.mkdtemp(
    path.join(os.tmpdir(), "bb-read-git-blob-"),
  );
  tempDirs.push(repoPath);
  await runGit(["init", "-b", "main"], { cwd: repoPath });
  await runGit(["config", "user.name", "BB Tests"], { cwd: repoPath });
  await runGit(["config", "user.email", "bb@example.com"], { cwd: repoPath });
  await fs.mkdir(path.join(repoPath, "docs"));
  await fs.writeFile(path.join(repoPath, "README.md"), "hello\n", "utf8");
  await fs.writeFile(path.join(repoPath, "docs", "index.md"), "docs\n", "utf8");
  await fs.writeFile(path.join(repoPath, "large.txt"), "0123456789\n", "utf8");
  await runGit(["add", "."], { cwd: repoPath });
  await runGit(["commit", "-m", "Initial commit"], { cwd: repoPath });
  return repoPath;
}

afterEach(async () => {
  await Promise.all(
    tempDirs
      .splice(0)
      .map((dir) => fs.rm(dir, { recursive: true, force: true })),
  );
});

describe("readGitBlob", () => {
  it("reads a blob at a git ref and reports the returned byte size", async () => {
    const repoPath = await initReadGitBlobRepo();

    const blob = await readGitBlob(repoPath, "HEAD", "README.md", 1024);

    expect(blob.contents?.toString("utf8")).toBe("hello\n");
    expect(blob.sizeBytes).toBe(Buffer.byteLength("hello\n"));
  });

  it("returns null contents for a missing blob path", async () => {
    const repoPath = await initReadGitBlobRepo();

    await expect(
      readGitBlob(repoPath, "HEAD", "missing.txt", 1024),
    ).resolves.toEqual({
      contents: null,
      sizeBytes: 0,
    });
  });

  it("returns null contents for a missing ref", async () => {
    const repoPath = await initReadGitBlobRepo();

    await expect(
      readGitBlob(repoPath, "missing-ref", "README.md", 1024),
    ).resolves.toEqual({
      contents: null,
      sizeBytes: 0,
    });
  });

  it("rejects non-blob git objects instead of treating them as missing", async () => {
    const repoPath = await initReadGitBlobRepo();

    await expect(readGitBlob(repoPath, "HEAD", "docs", 1024)).rejects
      .toMatchObject({
        code: "git_command_failed",
      });
  });

  it("allows blobs exactly at the byte cap", async () => {
    const repoPath = await initReadGitBlobRepo();

    const blob = await readGitBlob(repoPath, "HEAD", "large.txt", 11);

    expect(blob.contents?.toString("utf8")).toBe("0123456789\n");
    expect(blob.sizeBytes).toBe(11);
  });

  it("rejects oversized blobs during size preflight", async () => {
    const repoPath = await initReadGitBlobRepo();

    await expect(readGitBlob(repoPath, "HEAD", "large.txt", 4)).rejects
      .toMatchObject({
        code: "blob_too_large",
        message: "Blob size 11 bytes exceeds the 0 MB limit",
      });
  });
});

describe("parseBranchStatus", () => {
  it("parses branch names and ahead/behind counts", () => {
    expect(
      parseBranchStatus("## main...origin/main [ahead 2, behind 1]"),
    ).toEqual({
      branchName: "main",
      aheadCount: 2,
      behindCount: 1,
    });
  });

  it("returns zero counts for missing or non-header lines", () => {
    expect(parseBranchStatus(undefined)).toEqual({
      aheadCount: 0,
      behindCount: 0,
    });
    expect(parseBranchStatus(" M README.md")).toEqual({
      aheadCount: 0,
      behindCount: 0,
    });
  });
});

describe("parsePorcelainEntries", () => {
  it("parses ordinary entries and renamed targets", () => {
    expect(
      parsePorcelainEntries(
        [
          " M README.md",
          "R  old-name.ts -> new-name.ts",
          "D  removed.txt",
        ].join("\n"),
      ),
    ).toEqual([
      {
        path: "README.md",
        status: "M",
        indexStatus: " ",
        worktreeStatus: "M",
      },
      {
        path: "new-name.ts",
        status: "R",
        indexStatus: "R",
        worktreeStatus: " ",
      },
      {
        path: "removed.txt",
        status: "D",
        indexStatus: "D",
        worktreeStatus: " ",
      },
    ]);
  });

  it("decodes quoted git paths and octal escapes", () => {
    expect(
      parsePorcelainEntries(
        [
          '?? "a b.txt"',
          '?? "quote\\\\and\\\"slash.txt"',
          'R  "old\\040name.txt" -> "new\\040name.txt"',
        ].join("\n"),
      ),
    ).toEqual([
      {
        path: "a b.txt",
        status: "??",
        indexStatus: "?",
        worktreeStatus: "?",
      },
      {
        path: 'quote\\and"slash.txt',
        status: "??",
        indexStatus: "?",
        worktreeStatus: "?",
      },
      {
        path: "new name.txt",
        status: "R",
        indexStatus: "R",
        worktreeStatus: " ",
      },
    ]);
  });
});

describe("parseNameStatusEntries", () => {
  it("parses add, modify, and delete entries", () => {
    const output = [
      "A",
      "src/new.ts",
      "M",
      "src/existing.ts",
      "D",
      "src/old.ts",
      "",
    ].join("\0");
    expect(parseNameStatusEntries(output)).toEqual([
      { path: "src/new.ts", status: "A" },
      { path: "src/existing.ts", status: "M" },
      { path: "src/old.ts", status: "D" },
    ]);
  });

  it("takes the new path for rename and copy entries", () => {
    const output = [
      "R100",
      "src/old.ts",
      "src/new.ts",
      "C75",
      "src/base.ts",
      "src/copy.ts",
      "",
    ].join("\0");
    expect(parseNameStatusEntries(output)).toEqual([
      { path: "src/new.ts", status: "R" },
      { path: "src/copy.ts", status: "C" },
    ]);
  });

  it("preserves single-letter status with no similarity score", () => {
    const output = ["T", "src/link.ts", ""].join("\0");
    expect(parseNameStatusEntries(output)).toEqual([
      { path: "src/link.ts", status: "T" },
    ]);
  });

  it("interleaves regular and rename entries correctly", () => {
    const output = [
      "M",
      "src/a.ts",
      "R090",
      "src/b-old.ts",
      "src/b-new.ts",
      "A",
      "src/c.ts",
      "",
    ].join("\0");
    expect(parseNameStatusEntries(output)).toEqual([
      { path: "src/a.ts", status: "M" },
      { path: "src/b-new.ts", status: "R" },
      { path: "src/c.ts", status: "A" },
    ]);
  });

  it("returns empty array for empty input", () => {
    expect(parseNameStatusEntries("")).toEqual([]);
  });

  it("skips truncated trailing entries without throwing", () => {
    // A status token with no following path token.
    expect(parseNameStatusEntries("M\0")).toEqual([]);
    // A rename with only the old path, no new path.
    expect(parseNameStatusEntries("R100\0src/old.ts\0")).toEqual([]);
  });
});

describe("summarizeNumstat", () => {
  it("totals changed files, insertions, and deletions", () => {
    expect(
      summarizeNumstat(
        ["10\t4\tREADME.md", "-\t-\tbinary.dat", "2\t0\tsrc/app.ts"].join("\n"),
      ),
    ).toEqual({
      changedFiles: 3,
      insertions: 12,
      deletions: 4,
    });
  });
});

describe("parseNumstatEntriesZ", () => {
  it("parses normal and binary entries from NUL-delimited output", () => {
    const output =
      "10\t4\tREADME.md\0" + "-\t-\tbinary.dat\0" + "2\t0\tsrc/app.ts\0";
    expect(parseNumstatEntriesZ(output)).toEqual([
      { path: "README.md", insertions: 10, deletions: 4 },
      { path: "binary.dat", insertions: null, deletions: null },
      { path: "src/app.ts", insertions: 2, deletions: 0 },
    ]);
  });

  it("takes the new path for rename entries", () => {
    const output = "3\t1\t\0src/old.ts\0src/new.ts\0" + "5\t2\tsrc/app.ts\0";
    expect(parseNumstatEntriesZ(output)).toEqual([
      { path: "src/new.ts", insertions: 3, deletions: 1 },
      { path: "src/app.ts", insertions: 5, deletions: 2 },
    ]);
  });

  it("returns an empty array for empty input", () => {
    expect(parseNumstatEntriesZ("")).toEqual([]);
  });
});
