import { describe, expect, it } from "vitest";

import {
  contentInsetForWidth,
  frameCompositionForWidth,
  frameHeightForWidth,
  INFO_PANEL_WIDTH,
  layoutBandForWidth,
  SIDEBAR_WIDTH,
  SURFACE_RAIL_WIDTH,
  surfaceRailWidth,
  THREAD_COMFORTABLE_WIDTH,
  THREAD_MIN_WIDTH,
} from "./responsive-layout";

describe("Theme Preview responsive layout", () => {
  it("uses intentional bands at both boundaries", () => {
    expect(layoutBandForWidth(320)).toBe("mobile");
    expect(layoutBandForWidth(599)).toBe("mobile");
    expect(layoutBandForWidth(600)).toBe("narrow");
    expect(layoutBandForWidth(1199)).toBe("narrow");
    expect(layoutBandForWidth(1200)).toBe("desktop");
  });

  it("keeps the narrow rail wide enough for compact interaction specimens", () => {
    expect(surfaceRailWidth(600)).toBe(SURFACE_RAIL_WIDTH);
    expect(surfaceRailWidth(768)).toBe(SURFACE_RAIL_WIDTH);
    expect(surfaceRailWidth(1199)).toBe(SURFACE_RAIL_WIDTH);
  });

  it("tightens only the outer content inset near the mobile boundary", () => {
    expect(contentInsetForWidth(600)).toBe(16);
    expect(contentInsetForWidth(719)).toBe(16);
    expect(contentInsetForWidth(720)).toBe(20);
  });

  it("derives every composition threshold from the mock's natural panel widths", () => {
    // A phone-width pane: thread only, tight chrome.
    expect(frameCompositionForWidth(THREAD_MIN_WIDTH)).toEqual({ sidebar: false, infoPanel: false, splitColumns: false, narrow: true });
    // The sidebar joins exactly when it and a readable thread both fit.
    const sidebarJoin = SIDEBAR_WIDTH + THREAD_MIN_WIDTH;
    expect(frameCompositionForWidth(sidebarJoin - 1).sidebar).toBe(false);
    expect(frameCompositionForWidth(sidebarJoin).sidebar).toBe(true);
    // Split panes go side by side only when each pane stays readable.
    const splitJoin = SIDEBAR_WIDTH + 2 * THREAD_MIN_WIDTH;
    expect(frameCompositionForWidth(splitJoin - 1).splitColumns).toBe(false);
    expect(frameCompositionForWidth(splitJoin).splitColumns).toBe(true);
    // The info panel is the last to join: it waits for a comfortable thread.
    const infoJoin = SIDEBAR_WIDTH + THREAD_COMFORTABLE_WIDTH + INFO_PANEL_WIDTH;
    expect(infoJoin).toBeGreaterThan(splitJoin);
    expect(frameCompositionForWidth(infoJoin - 1).infoPanel).toBe(false);
    expect(frameCompositionForWidth(infoJoin)).toEqual({ sidebar: true, infoPanel: true, splitColumns: true, narrow: false });
  });

  it("keeps the mock window height continuous in width, clamped to plausible sizes", () => {
    expect(frameHeightForWidth(360)).toBe(430);
    expect(frameHeightForWidth(1000)).toBe(560);
    expect(frameHeightForWidth(1001)).toBe(561);
    expect(frameHeightForWidth(2000)).toBe(720);
  });
});
