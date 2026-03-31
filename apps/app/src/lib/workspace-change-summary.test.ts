import { describe, expect, it } from "vitest";
import {
  formatChangeSummary,
  formatDirtyWorkspaceLabel,
  formatWorkspaceChangeSummary,
  formatWorkspaceChangedFilesLabel,
  formatWorkspaceFileStatus,
  hasWorkspaceLineChanges,
} from "./workspace-change-summary";

describe("workspace-change-summary", () => {
  it("formats singular and plural file labels", () => {
    expect(formatWorkspaceChangedFilesLabel(1)).toBe("1 file");
    expect(formatWorkspaceChangedFilesLabel(2)).toBe("2 files");
  });

  it("includes +/- counts when line changes exist", () => {
    expect(
      formatWorkspaceChangeSummary({
        changedFiles: 3,
        insertions: 9,
        deletions: 4,
      }),
    ).toBe("3 files, +9 -4");
  });

  it("formats generic change summaries", () => {
    expect(
      formatChangeSummary({
        changedFiles: 2,
        insertions: 5,
        deletions: 1,
      }),
    ).toBe("2 files, +5 -1");
  });

  it("omits +/- counts when only file-level changes exist", () => {
    expect(
      formatWorkspaceChangeSummary({
        changedFiles: 1,
        insertions: 0,
        deletions: 0,
      }),
    ).toBe("1 file");
  });

  it("formats dirty labels with file fallback when line counts are zero", () => {
    expect(
      formatDirtyWorkspaceLabel({
        changedFiles: 1,
        insertions: 0,
        deletions: 0,
      }),
    ).toBe("Dirty 1 file");
    expect(
      formatDirtyWorkspaceLabel({
        changedFiles: 0,
        insertions: 0,
        deletions: 0,
      }),
    ).toBe("Dirty");
  });

  it("detects line changes", () => {
    expect(
      hasWorkspaceLineChanges({
        changedFiles: 2,
        insertions: 1,
        deletions: 0,
      }),
    ).toBe(true);
    expect(
      hasWorkspaceLineChanges({
        changedFiles: 2,
        insertions: 0,
        deletions: 0,
      }),
    ).toBe(false);
  });

  it("maps untracked status and preserves unknown statuses", () => {
    expect(formatWorkspaceFileStatus("??")).toBe("A?");
    expect(formatWorkspaceFileStatus("XY")).toBe("XY");
  });
});
