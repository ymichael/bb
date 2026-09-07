import { describe, expect, it } from "vitest";
import type { BbDesktopInfo } from "@bb/desktop-contract";
import { createBbDesktopApi } from "@/test/bb-desktop-test-utils";
import {
  CHROME_ROW_HEIGHT_CLASS,
  MACOS_COLLAPSED_TOP_LEFT_RESERVE_CLASS,
  MACOS_TRAFFIC_LIGHT_RESERVE_OFFSET_CLASS,
  shouldReserveMacosTrafficLights,
} from "./bb-desktop";

const desktopInfo: BbDesktopInfo = {
  lastCheckedAt: null,
  latestVersion: null,
  pendingVersion: null,
  platform: "macos",
  updateAvailable: false,
  updateDownloaded: false,
  version: "0.0.0-test",
};

describe("desktop chrome geometry", () => {
  it("sizes chrome rows from the shared app chrome token", () => {
    expect(CHROME_ROW_HEIGHT_CLASS).toBe("h-(--bb-app-chrome-row-height)");
  });

  it("reserves macOS traffic-light space only when lights are visible", () => {
    const desktopApi = createBbDesktopApi(desktopInfo);

    expect(
      shouldReserveMacosTrafficLights({
        desktopInfo: desktopApi,
        windowState: { isFullScreen: false },
      }),
    ).toBe(true);
    expect(
      shouldReserveMacosTrafficLights({
        desktopInfo: desktopApi,
        windowState: { isFullScreen: true },
      }),
    ).toBe(false);
    expect(
      shouldReserveMacosTrafficLights({
        desktopInfo: null,
        windowState: { isFullScreen: false },
      }),
    ).toBe(false);
  });

  it("lands the collapsed reserve at the traffic-light-clearing target", () => {
    const px = (className: string): number => {
      const match = /\[(\d+)px\]/.exec(className);
      if (match === null) {
        throw new Error(`no px token in "${className}"`);
      }
      return Number(match[1]);
    };

    const TRIGGER_OFFSET = px(MACOS_TRAFFIC_LIGHT_RESERVE_OFFSET_CLASS);
    const TRIGGER_BUTTON = 28;
    const TRIGGER_GAP = 8;
    const TARGET = TRIGGER_OFFSET + TRIGGER_BUTTON + TRIGGER_GAP;

    const BASE_INSET = 16;

    expect(BASE_INSET + px(MACOS_COLLAPSED_TOP_LEFT_RESERVE_CLASS)).toBe(
      TARGET,
    );
  });
});
