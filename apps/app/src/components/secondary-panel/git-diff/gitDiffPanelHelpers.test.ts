import type { WorkspaceCommitSummary } from "@bb/domain";
import { describe, expect, it } from "vitest";
import {
  buildGitDiffParsePlan,
  buildGitDiffSelectionOptions,
  buildGitDiffTarget,
  GIT_DIFF_AUTO_COLLAPSE_FILE_THRESHOLD,
  GIT_DIFF_PARSE_BATCH_THRESHOLD,
  reconcileGitDiffCollapsedFileKeys,
  resolveGitDiffPreparationState,
  shouldCollapseGitDiffFileByDefault,
  shouldResetSelectedGitDiffCommit,
} from "./gitDiffPanelHelpers";
import {
  buildParsedGitDiffFileEntries,
  parseGitDiffFiles,
  type ParsedGitDiffFileEntry,
} from "../../git-diff/git-diff-parsing";

function makeCommit(
  overrides: Partial<WorkspaceCommitSummary> = {},
): WorkspaceCommitSummary {
  return {
    authorName: "Author",
    authoredAt: 1,
    sha: "abc123",
    shortSha: "abc123",
    subject: "Initial change",
    ...overrides,
  };
}

function buildPatchDiff(count: number): string {
  return Array.from({ length: count }, (_, index) => {
    const path = `src/file-${index}.ts`;

    return [
      `diff --git a/${path} b/${path}`,
      `--- a/${path}`,
      `+++ b/${path}`,
      "@@ -1 +1 @@",
      "-old line",
      "+new line",
    ].join("\n");
  }).join("\n");
}

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

function buildEntries(diff: string): ParsedGitDiffFileEntry[] {
  return buildParsedGitDiffFileEntries(parseGitDiffFiles(diff));
}

describe("gitDiffPanelHelpers", () => {
  it("uses a conservative threshold before auto-collapsing many files", () => {
    expect(GIT_DIFF_AUTO_COLLAPSE_FILE_THRESHOLD).toBe(10);
  });

  it("builds git diff targets from commit, uncommitted, and merge-base selections", () => {
    expect(buildGitDiffTarget("commit-sha", "main")).toEqual({
      sha: "commit-sha",
      type: "commit",
    });
    expect(buildGitDiffTarget("uncommitted", "main")).toEqual({
      type: "uncommitted",
    });
    expect(buildGitDiffTarget("uncommitted", undefined)).toEqual({
      type: "uncommitted",
    });
    expect(buildGitDiffTarget(null, "main")).toEqual({
      mergeBaseBranch: "main",
      type: "all",
    });
    expect(buildGitDiffTarget(null, undefined)).toBeUndefined();
  });

  it("builds selection options and resets missing commit selections", () => {
    const commits = [
      makeCommit({
        sha: "abc123",
        shortSha: "abc123",
        subject: "Initial change",
      }),
      makeCommit({
        sha: "def456",
        shortSha: "def456",
        subject: "Follow-up",
      }),
    ];

    expect(buildGitDiffSelectionOptions(commits)).toEqual([
      { value: "all", label: "All changes" },
      { value: "abc123", label: "Initial change", monoPrefix: "abc123" },
      { value: "def456", label: "Follow-up", monoPrefix: "def456" },
    ]);
    expect(shouldResetSelectedGitDiffCommit("missing", commits)).toBe(true);
    expect(shouldResetSelectedGitDiffCommit("abc123", commits)).toBe(false);
    expect(shouldResetSelectedGitDiffCommit(null, commits)).toBe(false);
  });

  it("inserts an uncommitted option when the working tree is dirty", () => {
    const commits = [
      makeCommit({ sha: "abc123", shortSha: "abc123", subject: "Feature" }),
    ];

    expect(
      buildGitDiffSelectionOptions(commits, { hasUncommittedChanges: true }),
    ).toEqual([
      { value: "all", label: "All changes" },
      { value: "uncommitted", label: "Uncommitted changes" },
      { value: "abc123", label: "Feature", monoPrefix: "abc123" },
    ]);

    expect(
      buildGitDiffSelectionOptions([], { hasUncommittedChanges: true }),
    ).toEqual([
      { value: "all", label: "All changes" },
      { value: "uncommitted", label: "Uncommitted changes" },
    ]);
  });

  it("resets an uncommitted selection once the working tree becomes clean", () => {
    expect(
      shouldResetSelectedGitDiffCommit("uncommitted", [], {
        hasUncommittedChanges: true,
      }),
    ).toBe(false);
    expect(
      shouldResetSelectedGitDiffCommit("uncommitted", [], {
        hasUncommittedChanges: false,
      }),
    ).toBe(true);
  });

  it("tracks when a diff is still preparing for the current parse key", () => {
    const currentGitDiff = buildPatchDiff(2);
    const state = resolveGitDiffPreparationState({
      currentGitDiff,
      isAwaitingPrerequisites: false,
      isGitDiffLoading: false,
      isParsingGitDiffFiles: false,
      lastParsedGitDiffKey: "stale-key",
      parsedGitDiffFileCount: 0,
    });

    expect(state.hasCurrentGitDiff).toBe(true);
    expect(state.isAwaitingCurrentGitDiffParse).toBe(true);
    expect(state.isPreparingGitDiff).toBe(true);

    const readyState = resolveGitDiffPreparationState({
      currentGitDiff,
      isAwaitingPrerequisites: false,
      isGitDiffLoading: false,
      isParsingGitDiffFiles: false,
      lastParsedGitDiffKey: state.currentGitDiffKey,
      parsedGitDiffFileCount: 2,
    });

    expect(readyState.hasParsedGitDiffFiles).toBe(true);
    expect(readyState.isPreparingGitDiff).toBe(false);
  });

  it("keeps preparing while prerequisites resolve, even with no diff payload yet", () => {
    const state = resolveGitDiffPreparationState({
      currentGitDiff: "",
      isAwaitingPrerequisites: true,
      isGitDiffLoading: false,
      isParsingGitDiffFiles: false,
      lastParsedGitDiffKey: "",
      parsedGitDiffFileCount: 0,
    });

    expect(state.isPreparingGitDiff).toBe(true);
  });

  it("chooses reset, immediate, and batched parse plans from diff shape", () => {
    expect(
      buildGitDiffParsePlan({
        gitDiff: "",
        isDiffPanelActive: true,
      }).kind,
    ).toBe("reset");

    expect(
      buildGitDiffParsePlan({
        gitDiff: buildPatchDiff(2),
        isDiffPanelActive: true,
      }).kind,
    ).toBe("immediate");

    expect(
      buildGitDiffParsePlan({
        gitDiff: buildPatchDiff(GIT_DIFF_PARSE_BATCH_THRESHOLD + 1),
        isDiffPanelActive: true,
      }).kind,
    ).toBe("batched");
  });

  it("collapses deleted files and large diffs by default", () => {
    const [modifiedEntry] = buildEntries(buildPatchDiff(1));
    const [deletedEntry] = buildEntries(DELETED_FILE_DIFF);
    expect(modifiedEntry).toBeDefined();
    expect(deletedEntry).toBeDefined();
    if (!modifiedEntry || !deletedEntry) return;

    expect(
      shouldCollapseGitDiffFileByDefault({
        entry: modifiedEntry,
        expectedFileCount: 1,
      }),
    ).toBe(false);
    expect(
      shouldCollapseGitDiffFileByDefault({
        entry: deletedEntry,
        expectedFileCount: 1,
      }),
    ).toBe(true);
    expect(
      shouldCollapseGitDiffFileByDefault({
        entry: modifiedEntry,
        expectedFileCount: GIT_DIFF_AUTO_COLLAPSE_FILE_THRESHOLD + 1,
      }),
    ).toBe(true);
  });

  it("reconciles collapsed state without losing existing file choices", () => {
    const [modifiedEntry] = buildEntries(buildPatchDiff(1));
    const [deletedEntry] = buildEntries(DELETED_FILE_DIFF);
    const [addedEntry] = buildEntries(NEW_FILE_DIFF);
    expect(modifiedEntry).toBeDefined();
    expect(deletedEntry).toBeDefined();
    expect(addedEntry).toBeDefined();
    if (!modifiedEntry || !deletedEntry || !addedEntry) return;

    const initialEntries = [modifiedEntry, deletedEntry];
    const initialCollapsed = reconcileGitDiffCollapsedFileKeys({
      bulkCollapsePreference: "default",
      currentCollapsedFileKeys: new Set<string>(),
      expectedFileCount: initialEntries.length,
      focusedFileKey: null,
      parsedGitDiffFileEntries: initialEntries,
      previousFileKeys: new Set<string>(),
    });
    expect(initialCollapsed.has(modifiedEntry.key)).toBe(false);
    expect(initialCollapsed.has(deletedEntry.key)).toBe(true);

    const userCollapsedModified = new Set([
      modifiedEntry.key,
      deletedEntry.key,
    ]);
    const nextCollapsed = reconcileGitDiffCollapsedFileKeys({
      bulkCollapsePreference: "default",
      currentCollapsedFileKeys: userCollapsedModified,
      expectedFileCount: 3,
      focusedFileKey: null,
      parsedGitDiffFileEntries: [modifiedEntry, deletedEntry, addedEntry],
      previousFileKeys: new Set(initialEntries.map((entry) => entry.key)),
    });
    expect(nextCollapsed.has(modifiedEntry.key)).toBe(true);
    expect(nextCollapsed.has(deletedEntry.key)).toBe(true);
    expect(nextCollapsed.has(addedEntry.key)).toBe(false);
  });

  it("honors explicit collapse-all and expand-all preferences for new entries", () => {
    const entries = buildEntries(
      [buildPatchDiff(1), DELETED_FILE_DIFF.trimEnd()].join("\n"),
    );

    expect(
      reconcileGitDiffCollapsedFileKeys({
        bulkCollapsePreference: "collapsed-all",
        currentCollapsedFileKeys: new Set<string>(),
        expectedFileCount: entries.length,
        focusedFileKey: null,
        parsedGitDiffFileEntries: entries,
        previousFileKeys: new Set<string>(),
      }),
    ).toEqual(new Set(entries.map((entry) => entry.key)));

    expect(
      reconcileGitDiffCollapsedFileKeys({
        bulkCollapsePreference: "expanded-all",
        currentCollapsedFileKeys: new Set(entries.map((entry) => entry.key)),
        expectedFileCount: entries.length,
        focusedFileKey: null,
        parsedGitDiffFileEntries: entries,
        previousFileKeys: new Set<string>(),
      }),
    ).toEqual(new Set());
  });

  it("focuses one diff file by collapsing every other parsed entry", () => {
    const entries = buildEntries(
      [buildPatchDiff(2), DELETED_FILE_DIFF.trimEnd()].join("\n"),
    );
    const focusedEntry = entries[1];
    expect(focusedEntry).toBeDefined();
    if (!focusedEntry) return;

    expect(
      reconcileGitDiffCollapsedFileKeys({
        bulkCollapsePreference: "default",
        currentCollapsedFileKeys: new Set<string>(),
        expectedFileCount: entries.length,
        focusedFileKey: focusedEntry.key,
        parsedGitDiffFileEntries: entries,
        previousFileKeys: new Set<string>(),
      }),
    ).toEqual(
      new Set(
        entries
          .filter((entry) => entry.key !== focusedEntry.key)
          .map((entry) => entry.key),
      ),
    );
  });
});
