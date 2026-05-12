// @vitest-environment jsdom

import { cleanup, render } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import {
  AutoHeightContainer,
  HeightTransition,
} from "@/components/ui/height-transition";

afterEach(() => {
  cleanup();
});

describe("HeightTransition", () => {
  it("renders its children when visible", () => {
    const view = render(
      <HeightTransition visible>
        <span data-testid="visible">hello</span>
      </HeightTransition>,
    );
    expect(view.getByTestId("visible").textContent).toBe("hello");
  });

  it("keeps children mounted across visibility toggles", () => {
    // Children stay in the tree so consumer state (an expandable panel's
    // open flag, for example) survives a hide/show.
    const view = render(
      <HeightTransition visible={false}>
        <span data-testid="hidden">hello</span>
      </HeightTransition>,
    );
    expect(view.getByTestId("hidden").textContent).toBe("hello");
    view.rerender(
      <HeightTransition visible>
        <span data-testid="hidden">hello</span>
      </HeightTransition>,
    );
    expect(view.getByTestId("hidden").textContent).toBe("hello");
  });

  it("clips the wrapper vertically without forming a horizontal scroll container", () => {
    // `overflow: visible clip` lets the height transition clip overflow on
    // the y-axis (so intermediate heights don't leak content past the
    // wrapper) without making the wrapper an overflow-x scroll container —
    // children that intentionally extend horizontally (markdown table
    // breakout, etc.) need to bleed past the wrapper.
    const { container } = render(
      <HeightTransition visible>
        <span>x</span>
      </HeightTransition>,
    );
    const wrapper = container.firstElementChild as HTMLElement | null;
    expect(wrapper).not.toBeNull();
    expect(wrapper?.style.overflowX).toBe("visible");
    expect(wrapper?.style.overflowY).toBe("clip");
  });

  it("declares a CSS transition on height and opacity", () => {
    const { container } = render(
      <HeightTransition visible>
        <span>x</span>
      </HeightTransition>,
    );
    const wrapper = container.firstElementChild as HTMLElement | null;
    expect(wrapper).not.toBeNull();
    expect(wrapper?.style.transition).toContain("height");
    expect(wrapper?.style.transition).toContain("opacity");
  });
});

describe("AutoHeightContainer", () => {
  it("renders its children", () => {
    const view = render(
      <AutoHeightContainer>
        <span data-testid="child">hello</span>
      </AutoHeightContainer>,
    );
    expect(view.getByTestId("child").textContent).toBe("hello");
  });

  it("declares a CSS transition on height", () => {
    const { container } = render(
      <AutoHeightContainer>
        <span>x</span>
      </AutoHeightContainer>,
    );
    const wrapper = container.firstElementChild as HTMLElement | null;
    expect(wrapper).not.toBeNull();
    expect(wrapper?.style.transition).toContain("height");
  });

  it("clips the wrapper vertically without forming a horizontal scroll container", () => {
    // Same constraint as HeightTransition: clip the y-axis during the
    // height animation, leave the x-axis visible so horizontally bleeding
    // children (markdown table breakout) aren't masked.
    const { container } = render(
      <AutoHeightContainer>
        <span>x</span>
      </AutoHeightContainer>,
    );
    const wrapper = container.firstElementChild as HTMLElement | null;
    expect(wrapper?.style.overflowX).toBe("visible");
    expect(wrapper?.style.overflowY).toBe("clip");
  });
});
