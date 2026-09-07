import type { RawDiffFileStat } from "@bb/domain";
import type { DiffFileEntry } from "@bb/server-contract";
import { describe, expect, it } from "vitest";
import {
  DIFF_FILE_AUTO_LOAD_MAX_CHANGED_LINES,
  DIFF_FILE_TOO_LARGE_CHANGED_LINES,
  DIFF_FILES_INLINE_PATCH_MAX_FILES,
} from "../constants.js";
import {
  rawDiffFileStatToEntry,
  selectInitialPatchPaths,
} from "./diff-tiering.js";

function makeEntry(overrides: Partial<DiffFileEntry>): DiffFileEntry {
  return {
    path: "src/file.ts",
    previousPath: null,
    changeKind: "modified",
    additions: 1,
    deletions: 0,
    binary: false,
    origin: "tracked",
    loadMode: "auto",
    ...overrides,
  };
}

function makeStat(overrides: Partial<RawDiffFileStat>): RawDiffFileStat {
  return {
    path: "src/file.ts",
    previousPath: null,
    statusLetter: "M",
    additions: 0,
    deletions: 0,
    binary: false,
    origin: "tracked",
    ...overrides,
  };
}

describe("rawDiffFileStatToEntry", () => {
  it("carries identity fields through unchanged", () => {
    const entry = rawDiffFileStatToEntry(
      makeStat({
        path: "src/a.ts",
        additions: 3,
        deletions: 4,
        origin: "untracked",
      }),
    );
    expect(entry).toMatchObject<Partial<DiffFileEntry>>({
      path: "src/a.ts",
      additions: 3,
      deletions: 4,
      origin: "untracked",
      binary: false,
    });
  });

  it("maps a rename and preserves previousPath", () => {
    const entry = rawDiffFileStatToEntry(
      makeStat({
        statusLetter: "R",
        path: "src/new.ts",
        previousPath: "src/old.ts",
        additions: 1,
        deletions: 1,
      }),
    );
    expect(entry.changeKind).toBe("renamed");
    expect(entry.previousPath).toBe("src/old.ts");
    expect(entry.loadMode).toBe("auto");
  });

  it.each([
    { letter: "A", kind: "added" },
    { letter: "M", kind: "modified" },
    { letter: "D", kind: "deleted" },
    { letter: "C", kind: "copied" },
    { letter: "T", kind: "type_changed" },
  ] as const)("maps status letter $letter to $kind", ({ letter, kind }) => {
    const entry = rawDiffFileStatToEntry(makeStat({ statusLetter: letter }));
    expect(entry.changeKind).toBe(kind);
  });

  describe("loadMode tiering", () => {
    it.each([
      { additions: 0, deletions: 0, expected: "auto" },
      {
        additions: DIFF_FILE_AUTO_LOAD_MAX_CHANGED_LINES,
        deletions: 0,
        expected: "auto",
      },
      {
        additions: DIFF_FILE_AUTO_LOAD_MAX_CHANGED_LINES,
        deletions: 1,
        expected: "on_demand",
      },
      {
        additions: DIFF_FILE_TOO_LARGE_CHANGED_LINES,
        deletions: 0,
        expected: "on_demand",
      },
      {
        additions: DIFF_FILE_TOO_LARGE_CHANGED_LINES,
        deletions: 1,
        expected: "too_large",
      },
    ] as const)(
      "is $expected at additions=$additions deletions=$deletions",
      ({ additions, deletions, expected }) => {
        const entry = rawDiffFileStatToEntry(
          makeStat({ additions, deletions }),
        );
        expect(entry.loadMode).toBe(expected);
      },
    );

    it("forces on_demand for a binary file under the auto threshold", () => {
      const entry = rawDiffFileStatToEntry(
        makeStat({ binary: true, additions: 0, deletions: 0 }),
      );
      expect(entry.loadMode).toBe("on_demand");
    });

    it("keeps a binary file too_large when it exceeds the too-large threshold", () => {
      const entry = rawDiffFileStatToEntry(
        makeStat({
          binary: true,
          additions: DIFF_FILE_TOO_LARGE_CHANGED_LINES + 1,
          deletions: 0,
        }),
      );
      expect(entry.loadMode).toBe("too_large");
    });
  });
});

describe("selectInitialPatchPaths", () => {
  it("returns only the auto-tier paths for a small diff", () => {
    const paths = selectInitialPatchPaths([
      makeEntry({ path: "a.ts", loadMode: "auto" }),
      makeEntry({ path: "b.ts", loadMode: "on_demand" }),
      makeEntry({ path: "c.ts", loadMode: "auto" }),
      makeEntry({ path: "d.ts", loadMode: "too_large" }),
    ]);
    expect(paths).toEqual(["a.ts", "c.ts"]);
  });

  it("includes a diff at exactly the inline-patch file ceiling", () => {
    const files = Array.from(
      { length: DIFF_FILES_INLINE_PATCH_MAX_FILES },
      (_, i) => makeEntry({ path: `f${i}.ts`, loadMode: "auto" }),
    );
    expect(selectInitialPatchPaths(files)).toHaveLength(
      DIFF_FILES_INLINE_PATCH_MAX_FILES,
    );
  });

  it("ships nothing for a diff above the ceiling (cards auto-collapse)", () => {
    const files = Array.from(
      { length: DIFF_FILES_INLINE_PATCH_MAX_FILES + 1 },
      (_, i) => makeEntry({ path: `f${i}.ts`, loadMode: "auto" }),
    );
    expect(selectInitialPatchPaths(files)).toEqual([]);
  });

  it("returns an empty list for an all-on_demand/too_large small diff", () => {
    expect(
      selectInitialPatchPaths([
        makeEntry({ path: "big.ts", loadMode: "too_large" }),
        makeEntry({ path: "img.png", loadMode: "on_demand", binary: true }),
      ]),
    ).toEqual([]);
  });
});
