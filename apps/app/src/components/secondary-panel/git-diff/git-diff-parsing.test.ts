import { describe, expect, it } from "vitest";
import {
  doesGitDiffFileMatchPath,
  formatGitDiffFileLabel,
  getGitDiffParseKey,
  getOpenableGitDiffPath,
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
  });

  it("builds a stable parse key from diff edges", () => {
    expect(getGitDiffParseKey("abc")).toBe("3:abc:abc");
  });
});
