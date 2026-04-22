import { describe, expect, it } from "vitest";
import {
  captureTimelineScrollAnchorFromViewport,
  getTimelineAnchorOffsetDelta,
  hasMeaningfulComposerHeightChange,
  hasMeaningfulTimelineContainerResize,
  isTimelineNearBottom,
  resolveTimelineScrollMode,
  shouldLoadNestedRows,
  shouldShowTimelineScrollToBottom,
} from "./threadTimelineControllerHelpers";

describe("threadTimelineControllerHelpers", () => {
  it("treats the bottom of the timeline as pinned and hides the jump control", () => {
    const snapshot = {
      clientHeight: 400,
      scrollHeight: 1_000,
      scrollTop: 600,
    };

    expect(isTimelineNearBottom(snapshot)).toBe(true);
    expect(shouldShowTimelineScrollToBottom(snapshot)).toBe(false);
  });

  it("shows the jump control when the timeline is scrollable and reading history", () => {
    const snapshot = {
      clientHeight: 400,
      scrollHeight: 1_000,
      scrollTop: 200,
    };

    expect(isTimelineNearBottom(snapshot)).toBe(false);
    expect(shouldShowTimelineScrollToBottom(snapshot)).toBe(true);
  });

  it("captures the first visible row as the scroll anchor", () => {
    expect(
      captureTimelineScrollAnchorFromViewport({
        clientHeight: 300,
        containerTop: 100,
        rows: [
          { rowId: "row-hidden", top: 40, bottom: 99 },
          { rowId: "row-visible", top: 108, bottom: 140 },
          { rowId: "row-later", top: 150, bottom: 180 },
        ],
        scrollHeight: 1_000,
        scrollTop: 200,
      }),
    ).toEqual({
      offsetTop: 8,
      rowId: "row-visible",
    });
  });

  it("returns stable resize deltas only when the change is meaningful", () => {
    expect(
      getTimelineAnchorOffsetDelta({
        anchor: {
          offsetTop: 12,
          rowId: "row-1",
        },
        containerTop: 100,
        targetTop: 112.2,
      }),
    ).toBe(0);

    expect(
      getTimelineAnchorOffsetDelta({
        anchor: {
          offsetTop: 12,
          rowId: "row-1",
        },
        containerTop: 100,
        targetTop: 120,
      }),
    ).toBe(8);

    expect(
      hasMeaningfulTimelineContainerResize(
        { height: 600, width: 800 },
        { height: 600.6, width: 800 },
      ),
    ).toBe(true);
    expect(
      hasMeaningfulTimelineContainerResize(
        { height: 600, width: 800 },
        { height: 600.2, width: 800.2 },
      ),
    ).toBe(false);
    expect(hasMeaningfulComposerHeightChange(64, 64.6)).toBe(true);
    expect(hasMeaningfulComposerHeightChange(64, 64.2)).toBe(false);
  });

  it("computes nested row loading eligibility", () => {
    expect(
      shouldLoadNestedRows({
        cachedRowCount: 0,
        inlineRowCount: 0,
        isLoading: false,
        threadId: "thread-1",
      }),
    ).toBe(true);
    expect(
      shouldLoadNestedRows({
        cachedRowCount: 1,
        inlineRowCount: 0,
        isLoading: false,
        threadId: "thread-1",
      }),
    ).toBe(false);
    expect(
      shouldLoadNestedRows({
        cachedRowCount: 0,
        inlineRowCount: 0,
        isLoading: true,
        threadId: "thread-1",
      }),
    ).toBe(false);
  });

  it("preserves reading-history mode during controlled layout reconciliation", () => {
    expect(
      resolveTimelineScrollMode({
        currentMode: "reading_history",
        isNearBottom: true,
        preserveReadingHistoryDuringReconcile: true,
        source: "controlled_reconcile",
      }),
    ).toBe("reading_history");
  });

  it("lets explicit user scroll to bottom leave reading-history mode", () => {
    expect(
      resolveTimelineScrollMode({
        currentMode: "reading_history",
        isNearBottom: true,
        preserveReadingHistoryDuringReconcile: true,
        source: "user_scroll",
      }),
    ).toBe("pinned_bottom");
  });
});
