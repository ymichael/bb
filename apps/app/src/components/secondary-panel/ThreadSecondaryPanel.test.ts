import { describe, expect, it } from "vitest";
import {
  getSecondaryPanelChromeStackClassName,
  getReservedInlinePanelToggleClassName,
  isSecondaryPanelLayoutTransition,
  resolveCollapsedPanelTrafficLightReserveClassName,
} from "./ThreadSecondaryPanel";
import {
  CHROME_ROW_CLASS,
  CHROME_ROW_HEIGHT_CLASS,
  MACOS_COLLAPSED_TOP_LEFT_RESERVE_CLASS,
} from "@/lib/bb-desktop";
import { SECONDARY_PANEL_TOP_CHROME_BACKGROUND_CLASS } from "./panelChromeClasses";

describe("secondary panel surface tone", () => {
  it("uses the same sidebar background token as the primary sidebar", () => {
    expect(SECONDARY_PANEL_TOP_CHROME_BACKGROUND_CLASS).toBe("bg-sidebar");
  });
});

describe("secondary panel native browser bounds settling", () => {
  it("recognizes the flex transitions that move the panel back to its restored position", () => {
    expect(isSecondaryPanelLayoutTransition("flex-grow")).toBe(true);
    expect(isSecondaryPanelLayoutTransition("flex-basis")).toBe(true);
    expect(isSecondaryPanelLayoutTransition("opacity")).toBe(false);
  });
});

describe("getSecondaryPanelChromeStackClassName", () => {
  it("reserves the combined navigation and active Diff toolbar height", () => {
    const className = getSecondaryPanelChromeStackClassName(true);

    expect(className).toContain("flex");
    expect(className).toContain("flex-col");
    expect(className).toContain("shrink-0");
    expect(className).not.toContain(CHROME_ROW_HEIGHT_CLASS);
    expect(CHROME_ROW_CLASS).toContain(CHROME_ROW_HEIGHT_CLASS);
  });
});

describe("getReservedInlinePanelToggleClassName", () => {
  it("carves the slot out of the window-drag chrome row under macOS desktop chrome", () => {
    const className = getReservedInlinePanelToggleClassName(true);

    expect(className).toContain("[app-region:no-drag]");
    expect(className).toContain("[-webkit-app-region:no-drag]");
  });

  it("leaves the slot untouched off macOS desktop chrome", () => {
    const className = getReservedInlinePanelToggleClassName(false);

    expect(className).not.toContain("app-region");
  });
});

describe("resolveCollapsedPanelTrafficLightReserveClassName", () => {
  const base = {
    isConversationCollapsed: true,
    renderAsDrawer: false,
    isSidebarShowing: false as boolean | null,
    reserveMacosTrafficLights: true,
  };

  it("reserves the safe area for the panel full-screen case", () => {
    expect(resolveCollapsedPanelTrafficLightReserveClassName(base)).toBe(
      MACOS_COLLAPSED_TOP_LEFT_RESERVE_CLASS,
    );
  });

  it("does not reserve when the main sidebar is showing (it hosts the lights)", () => {
    expect(
      resolveCollapsedPanelTrafficLightReserveClassName({
        ...base,
        isSidebarShowing: true,
      }),
    ).toBe(false);
  });

  it("does not reserve when the conversation is expanded (panel sits on the right)", () => {
    expect(
      resolveCollapsedPanelTrafficLightReserveClassName({
        ...base,
        isConversationCollapsed: false,
      }),
    ).toBe(false);
  });

  it("does not reserve in the compact drawer layout", () => {
    expect(
      resolveCollapsedPanelTrafficLightReserveClassName({
        ...base,
        renderAsDrawer: true,
      }),
    ).toBe(false);
  });

  it("does not reserve off macOS chrome or in fullscreen (no visible lights)", () => {
    expect(
      resolveCollapsedPanelTrafficLightReserveClassName({
        ...base,
        reserveMacosTrafficLights: false,
      }),
    ).toBe(false);
  });

  it("treats an absent sidebar context (null) as showing, so it does not reserve", () => {
    expect(
      resolveCollapsedPanelTrafficLightReserveClassName({
        ...base,
        isSidebarShowing: null,
      }),
    ).toBe(false);
  });
});
