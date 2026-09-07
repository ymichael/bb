import { describe, expect, it } from "vitest";
import {
  DIFF_CARD_HEADER_HEIGHT_PX,
  estimateCardHeight,
  resolveDiffFileCardInitialState,
} from "./diffFilesStore";
import { GIT_DIFF_AUTO_COLLAPSE_FILE_THRESHOLD } from "./gitDiffPanelHelpers";
import { makeDiffFileEntry as buildEntry } from "@/test/fixtures/diff-files";

describe("resolveDiffFileCardInitialState", () => {
  it("collapses by default once the file count exceeds the threshold", () => {
    const fileCount = GIT_DIFF_AUTO_COLLAPSE_FILE_THRESHOLD + 1;
    expect(
      resolveDiffFileCardInitialState({ entry: buildEntry(), fileCount })
        .collapsed,
    ).toBe(true);
  });

  it("expands by default for a small diff", () => {
    expect(
      resolveDiffFileCardInitialState({
        entry: buildEntry(),
        fileCount: GIT_DIFF_AUTO_COLLAPSE_FILE_THRESHOLD,
      }).collapsed,
    ).toBe(false);
  });

  it("collapses deleted files by default even in a small diff", () => {
    expect(
      resolveDiffFileCardInitialState({
        entry: buildEntry({ changeKind: "deleted" }),
        fileCount: 1,
      }).collapsed,
    ).toBe(true);
  });
});

describe("estimateCardHeight", () => {
  it("returns the header floor for a zero-change entry", () => {
    const heightWithChanges = estimateCardHeight({
      entry: buildEntry({ additions: 5, deletions: 5 }),
      collapsed: false,
    });
    const heightWithoutChanges = estimateCardHeight({
      entry: buildEntry(),
      collapsed: false,
    });
    expect(heightWithoutChanges).toBeLessThan(heightWithChanges);
  });

  it("grows with the changed-line count", () => {
    const small = estimateCardHeight({
      entry: buildEntry({ additions: 2 }),
      collapsed: false,
    });
    const larger = estimateCardHeight({
      entry: buildEntry({ additions: 40 }),
      collapsed: false,
    });
    expect(larger).toBeGreaterThan(small);
  });

  it("caps the estimate for very large files", () => {
    const big = estimateCardHeight({
      entry: buildEntry({ additions: 200 }),
      collapsed: false,
    });
    const huge = estimateCardHeight({
      entry: buildEntry({ additions: 20_000 }),
      collapsed: false,
    });
    expect(huge).toBe(big);
  });

  it("estimates the header floor for a collapsed card regardless of change count", () => {
    const entry = buildEntry({ additions: 500, deletions: 500 });
    const expanded = estimateCardHeight({ entry, collapsed: false });
    const collapsed = estimateCardHeight({ entry, collapsed: true });

    expect(collapsed).toBe(DIFF_CARD_HEADER_HEIGHT_PX);
    expect(collapsed).toBeLessThan(expanded);
  });
});
