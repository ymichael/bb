// @vitest-environment jsdom

import { cleanup, render } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { BottomAnchoredScrollBody } from "@/components/ui/bottom-anchored-scroll-body";

class ResizeObserverMock implements ResizeObserver {
  observe() {}
  unobserve() {}
  disconnect() {}
}

beforeEach(() => {
  vi.stubGlobal("ResizeObserver", ResizeObserverMock);
  vi.stubGlobal(
    "requestAnimationFrame",
    vi.fn(() => 1),
  );
  vi.stubGlobal("cancelAnimationFrame", vi.fn());
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

function renderBody() {
  const view = render(
    <BottomAnchoredScrollBody
      footer={<div>Footer</div>}
      maxWidthClassName="max-w-none"
      scrollAnchorThreadId="thread-a"
    >
      <div data-timeline-row-id="row-a">row-a</div>
    </BottomAnchoredScrollBody>,
  );
  const row = view.container.querySelector('[data-timeline-row-id="row-a"]');
  const contentWrapper = row?.parentElement;
  const sentinel = view.container.querySelector(".scroll-bottom-anchor");
  if (!contentWrapper || !sentinel) {
    throw new Error("Scroll body did not render its wrapper and sentinel");
  }
  return { container: view.container, contentWrapper, sentinel };
}

describe("BottomAnchoredScrollBody scroll-anchor exclusion", () => {
  it("excludes only the content wrapper and keeps the sentinel outside it", () => {
    vi.stubGlobal("CSS", {
      supports: (property: string, value: string) =>
        property === "overflow-anchor" && value === "none",
    });
    const { container, contentWrapper, sentinel } = renderBody();

    expect(contentWrapper.classList).toContain("scroll-bottom-anchor-content");
    expect(
      container.querySelectorAll(".scroll-bottom-anchor-content"),
    ).toHaveLength(1);
    expect(contentWrapper.contains(sentinel)).toBe(false);
    expect(sentinel.parentElement).toBe(contentWrapper.parentElement);
    const footer = container.querySelector("[data-scroll-footer]");
    expect(footer?.className).toContain("[overflow-anchor:none]");
    expect(footer?.previousElementSibling).toBe(sentinel);
  });

  it("never applies the exclusion class where scroll anchoring is unsupported", () => {
    vi.stubGlobal("CSS", { supports: () => false });
    const { container } = renderBody();

    expect(container.querySelector(".scroll-bottom-anchor-content")).toBeNull();
    expect(container.querySelector(".scroll-bottom-anchor")).not.toBeNull();
  });
});
