import type { WorkspaceCommitSummary } from "@bb/domain";
import { describe, expect, it } from "vitest";
import {
  buildGitDiffSelectionOptions,
  buildGitDiffTarget,
  COMMITTED_GIT_DIFF_SELECTION,
  shouldResetSelectedGitDiffSelection,
  UNCOMMITTED_GIT_DIFF_SELECTION,
} from "./gitDiffPanelHelpers";

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

describe("gitDiffPanelHelpers", () => {
  it("builds git diff targets from commit, committed, uncommitted, and merge-base selections", () => {
    expect(buildGitDiffTarget("commit-sha", "main")).toEqual({
      sha: "commit-sha",
      type: "commit",
    });
    expect(buildGitDiffTarget(COMMITTED_GIT_DIFF_SELECTION, "main")).toEqual({
      mergeBaseBranch: "main",
      type: "branch_committed",
    });
    expect(
      buildGitDiffTarget(COMMITTED_GIT_DIFF_SELECTION, undefined),
    ).toBeUndefined();
    expect(buildGitDiffTarget(UNCOMMITTED_GIT_DIFF_SELECTION, "main")).toEqual({
      type: "uncommitted",
    });
    expect(
      buildGitDiffTarget(UNCOMMITTED_GIT_DIFF_SELECTION, undefined),
    ).toEqual({
      type: "uncommitted",
    });
    expect(buildGitDiffTarget(null, "main")).toEqual({
      mergeBaseBranch: "main",
      type: "all",
    });
    expect(buildGitDiffTarget(null, undefined)).toBeUndefined();
  });

  it("builds selection options and resets stale selections", () => {
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
      { value: "branch_committed", label: "Committed changes" },
      { value: "abc123", label: "Initial change", monoPrefix: "abc123" },
      { value: "def456", label: "Follow-up", monoPrefix: "def456" },
    ]);
    expect(
      buildGitDiffSelectionOptions(commits, { hasUncommittedChanges: true }),
    ).toEqual([
      { value: "all", label: "All changes" },
      { value: "branch_committed", label: "Committed changes" },
      { value: "uncommitted", label: "Uncommitted changes" },
      { value: "abc123", label: "Initial change", monoPrefix: "abc123" },
      { value: "def456", label: "Follow-up", monoPrefix: "def456" },
    ]);
    expect(
      buildGitDiffSelectionOptions([], { hasUncommittedChanges: true }),
    ).toEqual([
      { value: "all", label: "All changes" },
      { value: "uncommitted", label: "Uncommitted changes" },
    ]);
    expect(
      buildGitDiffSelectionOptions([], { hasUncommittedChanges: false }),
    ).toEqual([{ value: "all", label: "All changes" }]);
    expect(shouldResetSelectedGitDiffSelection("missing", commits)).toBe(true);
    expect(shouldResetSelectedGitDiffSelection("abc123", commits)).toBe(false);
    expect(shouldResetSelectedGitDiffSelection(null, commits)).toBe(false);
    expect(
      shouldResetSelectedGitDiffSelection(
        COMMITTED_GIT_DIFF_SELECTION,
        commits,
      ),
    ).toBe(false);
    expect(
      shouldResetSelectedGitDiffSelection(COMMITTED_GIT_DIFF_SELECTION, []),
    ).toBe(true);
    expect(
      shouldResetSelectedGitDiffSelection(UNCOMMITTED_GIT_DIFF_SELECTION, [], {
        hasUncommittedChanges: true,
      }),
    ).toBe(false);
    expect(
      shouldResetSelectedGitDiffSelection(UNCOMMITTED_GIT_DIFF_SELECTION, [], {
        hasUncommittedChanges: false,
      }),
    ).toBe(true);
  });
});
