import { describe, expect, it } from "vitest";
import {
  parseBranchStatus,
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

describe("summarizeNumstat", () => {
  it("totals changed files, insertions, and deletions", () => {
    expect(
      summarizeNumstat(["10\t4\tREADME.md", "-\t-\tbinary.dat", "2\t0\tsrc/app.ts"].join("\n")),
    ).toEqual({
      changedFiles: 3,
      insertions: 12,
      deletions: 4,
    });
  });
});
