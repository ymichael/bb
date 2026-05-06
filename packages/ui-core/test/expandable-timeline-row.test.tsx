// @vitest-environment jsdom

import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { TimelineTitle } from "@bb/thread-view";
import { ExpandableTimelineRow } from "../src/thread-timeline/ExpandableTimelineRow.js";

const TITLE: TimelineTitle = {
  action: null,
  segments: [
    { text: "Ran", em: false, shimmer: false, truncate: false },
    { text: "details", em: true, shimmer: false, truncate: true },
  ],
  decorations: [],
  plain: "Ran details",
  tone: "default",
};

afterEach(() => {
  cleanup();
});

describe("ExpandableTimelineRow", () => {
  it("does not render body children while collapsed", () => {
    const renderBody = vi.fn(() => <div>expensive details</div>);
    const view = render(
      <ExpandableTimelineRow
        title={TITLE}
        renderBody={renderBody}
      />,
    );

    expect(renderBody).not.toHaveBeenCalled();
    expect(view.container.textContent ?? "").not.toContain("expensive details");
  });

  it("renders body children while expanded and through the close animation", () => {
    vi.useFakeTimers();
    const renderBody = vi.fn(() => <div>expensive details</div>);
    try {
      const view = render(
        <ExpandableTimelineRow
          title={TITLE}
          renderBody={renderBody}
        />,
      );

      view.rerender(
        <ExpandableTimelineRow
          title={TITLE}
          autoExpanded
          renderBody={renderBody}
        />,
      );

      expect(renderBody).toHaveBeenCalledTimes(1);
      expect(view.container.textContent ?? "").toContain("expensive details");

      view.rerender(
        <ExpandableTimelineRow
          title={TITLE}
          renderBody={renderBody}
        />,
      );

      expect(renderBody).toHaveBeenCalledTimes(1);
      expect(view.container.textContent ?? "").toContain("expensive details");

      act(() => {
        vi.advanceTimersByTime(200);
      });

      expect(renderBody).toHaveBeenCalledTimes(1);
      expect(view.container.textContent ?? "").not.toContain(
        "expensive details",
      );
    } finally {
      vi.useRealTimers();
    }
  });

  it("exposes expansion state on the toggle button", () => {
    const view = render(
      <ExpandableTimelineRow
        title={TITLE}
        renderBody={() => <div>details</div>}
      />,
    );

    expect(screen.getByRole("button").getAttribute("aria-expanded")).toBe(
      "false",
    );

    view.rerender(
      <ExpandableTimelineRow
        title={TITLE}
        autoExpanded
        renderBody={() => <div>details</div>}
      />,
    );

    expect(screen.getByRole("button").getAttribute("aria-expanded")).toBe(
      "true",
    );
  });

  it("exposes hidden and visible states for the animated body", () => {
    const view = render(
      <ExpandableTimelineRow
        title={TITLE}
        renderBody={() => <div>expanded body details</div>}
      />,
    );

    const button = screen.getByRole("button", { name: /Ran details/u });
    const body = view.container.querySelector('div[aria-hidden="true"]');
    expect(button.getAttribute("aria-expanded")).toBe("false");
    expect(body).not.toBeNull();
    expect(view.container.textContent ?? "").not.toContain(
      "expanded body details",
    );

    fireEvent.click(button);

    const expandedBody = view.container.querySelector(
      'div[aria-hidden="false"]',
    );
    expect(button.getAttribute("aria-expanded")).toBe("true");
    expect(expandedBody?.textContent ?? "").toContain("expanded body details");
  });

  it("style contract: keeps the chevron from becoming a separate pointer target", () => {
    const onToggle = vi.fn();
    const view = render(
      <ExpandableTimelineRow
        title={TITLE}
        onBeforeExpand={onToggle}
        renderBody={() => <div>details</div>}
      />,
    );

    const chevron = view.container.querySelector("svg");
    expect(chevron?.getAttribute("class") ?? "").toContain(
      "pointer-events-none",
    );
  });

  it("toggles from the accessible row header", () => {
    const view = render(
      <ExpandableTimelineRow
        title={TITLE}
        renderBody={() => <div>expanded row content</div>}
      />,
    );

    const button = screen.getByRole("button", { name: /Ran details/u });
    expect(button.getAttribute("aria-expanded")).toBe("false");
    expect(view.container.textContent ?? "").not.toContain(
      "expanded row content",
    );

    fireEvent.click(button);

    expect(button.getAttribute("aria-expanded")).toBe("true");
    expect(view.container.textContent ?? "").toContain(
      "expanded row content",
    );
  });

  it("style contract: scopes chevron hover state to the toggle button", () => {
    const view = render(
      <ExpandableTimelineRow
        title={TITLE}
        renderBody={() => <div>details</div>}
      />,
    );

    const chevron = view.container.querySelector("svg");
    const chevronClassName = chevron?.getAttribute("class") ?? "";

    expect(screen.getByRole("button").className).toContain("group/toggle");
    expect(chevronClassName).toContain("group-hover/toggle:opacity-100");
    expect(chevronClassName).toContain(
      "group-focus-visible/toggle:opacity-100",
    );
    expect(chevronClassName).not.toContain("group-hover:opacity-100");
    expect(chevronClassName).not.toContain("group-focus/toggle:opacity-100");
    expect(view.container.firstElementChild?.className).not.toContain("group");
  });

  it("style contract: uses compact timeline header spacing", () => {
    render(
      <ExpandableTimelineRow
        title={TITLE}
        renderBody={() => <div>details</div>}
      />,
    );

    const button = screen.getByRole("button");
    expect(button.classList.contains("timeline-row-header")).toBe(true);
    expect(button.classList.contains("leading-5")).toBe(true);
    expect(button.classList.contains("py-0")).toBe(true);
    expect(button.classList.contains("py-0.5")).toBe(false);
  });

  it("style contract: can render flush horizontal padding for bundled rows", () => {
    render(
      <ExpandableTimelineRow
        title={TITLE}
        horizontalPadding="flush"
        autoExpanded
        renderBody={() => <div>details</div>}
      />,
    );

    const button = screen.getByRole("button");
    expect(button.classList.contains("px-0")).toBe(true);
    expect(button.classList.contains("px-2")).toBe(false);
  });

  it("style contract: keeps a small gap between an expanded title and its contents", () => {
    const view = render(
      <ExpandableTimelineRow
        title={TITLE}
        autoExpanded
        renderBody={() => <div>details</div>}
      />,
    );

    expect(view.container.innerHTML).toContain("pt-0.5");
    expect(view.container.innerHTML).not.toContain("pt-0 ");
  });

  it("style contract: does not put hover group state on the row wrapper", () => {
    const view = render(
      <ExpandableTimelineRow
        title={TITLE}
        renderBody={() => <div>details</div>}
      />,
    );

    expect(view.container.firstElementChild?.className).not.toContain("group");

    view.rerender(
      <ExpandableTimelineRow
        title={TITLE}
        autoExpanded
        renderBody={() => <div>details</div>}
      />,
    );

    expect(view.container.firstElementChild?.className).not.toContain("group");
  });

  it("keeps manual collapse across auto-expanded rerenders", () => {
    const view = render(
      <ExpandableTimelineRow
        title={TITLE}
        autoExpanded
        renderBody={() => <div>details</div>}
      />,
    );

    expect(screen.getByRole("button").getAttribute("aria-expanded")).toBe(
      "true",
    );

    fireEvent.click(screen.getByRole("button"));
    expect(screen.getByRole("button").getAttribute("aria-expanded")).toBe(
      "false",
    );

    view.rerender(
      <ExpandableTimelineRow
        title={TITLE}
        autoExpanded
        renderBody={() => <div>details</div>}
      />,
    );

    expect(screen.getByRole("button").getAttribute("aria-expanded")).toBe(
      "false",
    );
  });

  it("runs before-expand work only when opening locally", () => {
    const onBeforeExpand = vi.fn();
    render(
      <ExpandableTimelineRow
        title={TITLE}
        onBeforeExpand={onBeforeExpand}
        renderBody={() => <div>details</div>}
      />,
    );

    fireEvent.click(screen.getByRole("button"));
    expect(onBeforeExpand).toHaveBeenCalledTimes(1);

    fireEvent.click(screen.getByRole("button"));
    expect(onBeforeExpand).toHaveBeenCalledTimes(1);
  });
});
