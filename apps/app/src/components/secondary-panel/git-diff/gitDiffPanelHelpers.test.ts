import type { WorkspaceCommitSummary } from "@bb/domain";
import { describe, expect, it } from "vitest";
import {
  buildGitDiffParsePlan,
  buildGitDiffSelectionOptions,
  buildGitDiffTarget,
  GIT_DIFF_PARSE_BATCH_THRESHOLD,
  resolveGitDiffPreparationState,
  shouldResetSelectedGitDiffCommit,
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

describe("gitDiffPanelHelpers", () => {
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
      isGitDiffLoading: false,
      isParsingGitDiffFiles: false,
      lastParsedGitDiffKey: state.currentGitDiffKey,
      parsedGitDiffFileCount: 2,
    });

    expect(readyState.hasParsedGitDiffFiles).toBe(true);
    expect(readyState.isPreparingGitDiff).toBe(false);
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
});
