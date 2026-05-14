import { describe, expect, it } from "vitest";
import {
  parseBranchStatus,
  parseNameStatusEntries,
  parseNumstatEntriesZ,
  parsePorcelainEntries,
  summarizeNumstat,
} from "../src/git.js";

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
