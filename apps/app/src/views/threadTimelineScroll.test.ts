import { describe, expect, it } from "vitest";
import {
  calculateComposerResizeScrollTop,
  shouldRestoreScrollAnchorForWidthChange,
} from "./threadTimelineScroll";

describe("threadTimelineScroll", () => {
  describe("calculateComposerResizeScrollTop", () => {
    it("stays pinned to bottom when already sticking", () => {
      expect(
        calculateComposerResizeScrollTop({
          clientHeight: 400,
          currentScrollTop: 600,
          heightDelta: 80,
          isStickingToBottom: true,
          scrollHeight: 1080,
        }),
      ).toBe(1080);
    });

    it("preserves viewport offset when scrolled away from bottom", () => {
      expect(
        calculateComposerResizeScrollTop({
          clientHeight: 400,
          currentScrollTop: 300,
          heightDelta: 80,
          isStickingToBottom: false,
          scrollHeight: 1080,
        }),
      ).toBe(380);
    });

    it("snaps back to bottom when close to the bottom threshold", () => {
      expect(
        calculateComposerResizeScrollTop({
          clientHeight: 400,
          currentScrollTop: 645,
          heightDelta: 80,
          isStickingToBottom: false,
          scrollHeight: 1080,
        }),
      ).toBe(1080);
    });
  });

  describe("shouldRestoreScrollAnchorForWidthChange", () => {
    it("restores anchors only when width changes meaningfully and an anchor exists", () => {
      expect(
        shouldRestoreScrollAnchorForWidthChange({
          anchorExists: true,
          previousWidth: 800,
          nextWidth: 820,
        }),
      ).toBe(true);
      expect(
        shouldRestoreScrollAnchorForWidthChange({
          anchorExists: true,
          previousWidth: 800,
          nextWidth: 800.2,
        }),
      ).toBe(false);
      expect(
        shouldRestoreScrollAnchorForWidthChange({
          anchorExists: false,
          previousWidth: 800,
          nextWidth: 820,
        }),
      ).toBe(false);
    });
  });
});
