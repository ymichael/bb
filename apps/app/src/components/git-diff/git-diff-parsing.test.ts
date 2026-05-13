import { describe, expect, it } from "vitest";
import {
  buildParsedGitDiffFileEntries,
  doesGitDiffFileMatchPath,
  formatGitDiffFileLabel,
  getGitDiffFileChangeKind,
  getGitDiffParseKey,
  getOpenableGitDiffPath,
  getParsedGitDiffFileKey,
  parseGitDiffFiles,
  splitGitDiffIntoPatchChunks,
  summarizeGitDiff,
} from "./git-diff-parsing";

const SAMPLE_DIFF = [
  "diff --git a/src/old.ts b/src/new.ts",
  "index 1111111..2222222 100644",
  "--- a/src/old.ts",
  "+++ b/src/new.ts",
  "@@ -1 +1 @@",
  "-old",
  "+new",
  "",
].join("\n");

const NEW_FILE_DIFF = [
  "diff --git a/src/new-file.ts b/src/new-file.ts",
  "new file mode 100644",
  "index 0000000..1111111",
  "--- /dev/null",
  "+++ b/src/new-file.ts",
  "@@ -0,0 +1 @@",
  "+export const value = 1;",
  "",
].join("\n");

const DELETED_FILE_DIFF = [
  "diff --git a/src/deleted-file.ts b/src/deleted-file.ts",
  "deleted file mode 100644",
  "index 1111111..0000000",
  "--- a/src/deleted-file.ts",
  "+++ /dev/null",
  "@@ -1 +0,0 @@",
  "-export const value = 1;",
  "",
].join("\n");

const RENAME_ONLY_DIFF = [
  "diff --git a/src/old-name.ts b/src/new-name.ts",
  "similarity index 100%",
  "rename from src/old-name.ts",
  "rename to src/new-name.ts",
  "",
].join("\n");

describe("threadDetailGitDiff", () => {
  it("splits multi-file diffs into patch chunks", () => {
    const diff = [
      SAMPLE_DIFF.trimEnd(),
      "diff --git a/src/second.ts b/src/second.ts",
      "index 3333333..4444444 100644",
      "--- a/src/second.ts",
      "+++ b/src/second.ts",
      "@@ -1 +1 @@",
      "-before",
      "+after",
      "",
    ].join("\n");

    expect(splitGitDiffIntoPatchChunks(diff)).toHaveLength(2);
  });

  it("matches git diff files against normalized paths", () => {
    const [file] = parseGitDiffFiles(SAMPLE_DIFF);
    expect(file).toBeDefined();
    if (!file) return;

    expect(doesGitDiffFileMatchPath(file, "src/new.ts")).toBe(true);
    expect(getOpenableGitDiffPath(file)).toBe("src/new.ts");
    expect(formatGitDiffFileLabel(file)).toBe("src/new.ts");
  });

  it("falls back to raw diff counting before parsed files are available", () => {
    expect(summarizeGitDiff([], SAMPLE_DIFF)).toEqual({
      filesCount: 1,
      insertions: 1,
      deletions: 1,
    });
  });

  it("parses new-file diffs so untracked files can render in the secondary panel diff view", () => {
    const [file] = parseGitDiffFiles(NEW_FILE_DIFF);
    expect(file).toBeDefined();
    if (!file) return;

    expect(formatGitDiffFileLabel(file)).toBe("src/new-file.ts");
    expect(getOpenableGitDiffPath(file)).toBe("src/new-file.ts");
    expect(getGitDiffFileChangeKind(file)).toBe("added");
  });

  it("derives deleted and renamed file kinds from parsed git metadata", () => {
    const [deletedFile] = parseGitDiffFiles(DELETED_FILE_DIFF);
    const [renamedFile] = parseGitDiffFiles(RENAME_ONLY_DIFF);

    expect(deletedFile).toBeDefined();
    expect(renamedFile).toBeDefined();
    if (!deletedFile || !renamedFile) return;

    expect(getGitDiffFileChangeKind(deletedFile)).toBe("deleted");
    expect(getGitDiffFileChangeKind(renamedFile)).toBe("renamed");
    expect(formatGitDiffFileLabel(renamedFile)).toBe(
      "src/old-name.ts -> src/new-name.ts",
    );
  });

  it("builds stable file entry keys without depending on file order", () => {
    const files = parseGitDiffFiles(
      [SAMPLE_DIFF.trimEnd(), NEW_FILE_DIFF.trimEnd()].join("\n"),
    );
    const entries = buildParsedGitDiffFileEntries(files);

    expect(entries.map((entry) => entry.key)).toEqual(
      files.map((file) => getParsedGitDiffFileKey(file)),
    );
  });

  it("changes the parse key when diff edges change", () => {
    const middle = "middle\n".repeat(40);
    const base = `first\n${middle}last`;
    const changedPrefix = `changed\n${middle}last`;
    const changedSuffix = `first\n${middle}changed`;

    expect(getGitDiffParseKey(base)).not.toBe(
      getGitDiffParseKey(changedPrefix),
    );
    expect(getGitDiffParseKey(base)).not.toBe(
      getGitDiffParseKey(changedSuffix),
    );
  });
});
