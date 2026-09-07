// @vitest-environment jsdom

import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  getCompactHomeScrollViewportTop,
  RootComposeCompactHome,
} from "./RootComposeCompactHome";
import {
  MOBILE_RECENT_LABEL_HEIGHT_PX,
  MOBILE_RECENT_ROW_HEIGHT_PX,
} from "./RootComposeMobileRecents";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

function renderCompactHome() {
  return render(
    <RootComposeCompactHome composer={<div data-testid="composer" />}>
      <div data-testid="recents" />
    </RootComposeCompactHome>,
  );
}

describe("RootComposeCompactHome", () => {
  it("keeps the composer above a scroll viewport that runs behind it", () => {
    renderCompactHome();

    const viewport = screen.getByTestId("root-compose-compact-scroll-viewport");
    const composer = screen.getByTestId("root-compose-compact-composer");

    expect(viewport.className).toContain("bottom-0");
    expect(viewport.className).toContain("overflow-y-auto");
    expect(composer.className).toContain("absolute");
    expect(composer.className).toContain("bottom-0");
    expect(composer.className).toContain("z-10");
    expect(composer.contains(screen.getByTestId("composer"))).toBe(true);
    expect(viewport.contains(screen.getByTestId("recents"))).toBe(true);
  });

  it("pins the scroll viewport so 5.5 rows show once the label sticks", () => {
    const scrolledBandPx =
      5.5 * MOBILE_RECENT_ROW_HEIGHT_PX + MOBILE_RECENT_LABEL_HEIGHT_PX;

    expect(
      getCompactHomeScrollViewportTop({
        regionHeight: 852,
        composerHeight: 188,
      }),
    ).toBe(852 - 188 - scrolledBandPx);
  });

  it("writes measured geometry directly before the compact home paints", () => {
    vi.spyOn(HTMLElement.prototype, "offsetHeight", "get").mockImplementation(
      function (this: HTMLElement) {
        if (this.dataset.testid === "root-compose-compact-home") return 852;
        if (this.dataset.testid === "root-compose-compact-composer") {
          return 188;
        }
        return 0;
      },
    );

    renderCompactHome();

    const viewport = screen.getByTestId("root-compose-compact-scroll-viewport");
    const bottomSpacer = viewport.lastElementChild;
    if (!(bottomSpacer instanceof HTMLElement)) {
      throw new Error("Expected a trailing composer spacer");
    }
    expect(viewport.style.top).toBe("310px");
    expect(bottomSpacer.style.height).toBe("188px");
  });

  it("never lifts the scroll viewport above the app chrome row", () => {
    expect(
      getCompactHomeScrollViewportTop({
        regionHeight: 420,
        composerHeight: 188,
      }),
    ).toBe(56);
  });

  it("offsets the resting list by one row so 4.5 show before scrolling", () => {
    renderCompactHome();

    const offset = screen.getByTestId("root-compose-compact-recents-offset");
    expect(offset.style.height).toBe(`${MOBILE_RECENT_ROW_HEIGHT_PX}px`);
  });

  it("pads the list tail so the last row can clear the composer", () => {
    renderCompactHome();

    const viewport = screen.getByTestId("root-compose-compact-scroll-viewport");
    const bottomSpacer = viewport.lastElementChild;
    if (!(bottomSpacer instanceof HTMLElement)) {
      throw new Error("Expected a trailing composer spacer");
    }
    expect(bottomSpacer.style.height).toBe("0px");
  });

  it("renders a strong fade so rows dissolve into the composer", () => {
    renderCompactHome();

    const composer = screen.getByTestId("root-compose-compact-composer");
    const fade = composer.querySelector('[data-overflow-fade="above"]');
    if (!(fade instanceof HTMLElement)) {
      throw new Error("Expected an above fade over the composer");
    }
    expect(fade.className).toContain("h-24");
    expect(fade.className).toContain("-top-24");
  });
});
