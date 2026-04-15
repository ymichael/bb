import { describe, expect, it } from "vitest";
import {
  formatChangeSummary,
  formatWorkspaceChangedFilesLabel,
  formatWorkspaceFileStatus,
} from "./workspace-change-summary";

describe("workspace-change-summary", () => {
  it("formats singular and plural file labels", () => {
    expect(formatWorkspaceChangedFilesLabel(1)).toBe("1 file");
    expect(formatWorkspaceChangedFilesLabel(2)).toBe("2 files");
  });

  it("includes +/- counts when line changes exist", () => {
    expect(
      formatChangeSummary({
        files: [
          { path: "a", status: "M" },
          { path: "b", status: "M" },
          { path: "c", status: "M" },
        ],
        insertions: 9,
        deletions: 4,
      }),
    ).toBe("3 files, +9 -4");
  });

  it("omits +/- counts when only file-level changes exist", () => {
    expect(
      formatChangeSummary({
        files: [{ path: "a", status: "M" }],
        insertions: 0,
        deletions: 0,
      }),
    ).toBe("1 file");
  });

  it("maps untracked status and preserves unknown statuses", () => {
    expect(formatWorkspaceFileStatus("??")).toBe("A?");
    expect(formatWorkspaceFileStatus("XY")).toBe("XY");
  });
});
