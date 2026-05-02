// @vitest-environment jsdom

import { act, cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { TimelineTitle } from "@bb/thread-view";
import { ExpandableTimelineRow } from "../src/thread-timeline/ExpandableTimelineRow.js";

const TITLE: TimelineTitle = {
  content: "details",
  contentTone: "emphasis",
  plain: "Ran details",
  prefix: "Ran",
  shimmerPrefix: false,
  suffix: null,
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
        isExpanded={false}
        onToggle={() => {}}
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
          isExpanded={false}
          onToggle={() => {}}
          renderBody={renderBody}
        />,
      );

      view.rerender(
        <ExpandableTimelineRow
          title={TITLE}
          isExpanded={true}
          onToggle={() => {}}
          renderBody={renderBody}
        />,
      );

      expect(renderBody).toHaveBeenCalledTimes(1);
      expect(view.container.textContent ?? "").toContain("expensive details");

      view.rerender(
        <ExpandableTimelineRow
          title={TITLE}
          isExpanded={false}
          onToggle={() => {}}
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
        isExpanded={false}
        onToggle={() => {}}
        renderBody={() => <div>details</div>}
      />,
    );

    expect(screen.getByRole("button").getAttribute("aria-expanded")).toBe(
      "false",
    );

    view.rerender(
      <ExpandableTimelineRow
        title={TITLE}
        isExpanded={true}
        onToggle={() => {}}
        renderBody={() => <div>details</div>}
      />,
    );

    expect(screen.getByRole("button").getAttribute("aria-expanded")).toBe(
      "true",
    );
  });

  it("does not let collapsed animated body intercept row clicks", () => {
    const view = render(
      <ExpandableTimelineRow
        title={TITLE}
        isExpanded={false}
        onToggle={() => {}}
        renderBody={() => <div>details</div>}
      />,
    );

    const body = view.container.querySelector('div[aria-hidden="true"]');
    expect(body?.className).toContain("pointer-events-none");

    view.rerender(
      <ExpandableTimelineRow
        title={TITLE}
        isExpanded={true}
        onToggle={() => {}}
        renderBody={() => <div>details</div>}
      />,
    );

    const expandedBody = view.container.querySelector(
      'div[aria-hidden="false"]',
    );
    expect(expandedBody?.className).toContain("pointer-events-auto");
  });

  it("keeps the chevron from becoming a separate pointer target", () => {
    const onToggle = vi.fn();
    const view = render(
      <ExpandableTimelineRow
        title={TITLE}
        isExpanded={false}
        onToggle={onToggle}
        renderBody={() => <div>details</div>}
      />,
    );

    const chevron = view.container.querySelector("svg");
    expect(chevron?.getAttribute("class") ?? "").toContain(
      "pointer-events-none",
    );
  });

  it("makes the whole row header clickable", () => {
    render(
      <ExpandableTimelineRow
        title={TITLE}
        isExpanded={false}
        onToggle={() => {}}
        renderBody={() => <div>details</div>}
      />,
    );

    expect(screen.getByRole("button").className).toContain("w-full");
    expect(screen.getByRole("button").className).toContain("justify-start");
    expect(screen.getByRole("button").className).toContain(
      "timeline-row-header",
    );
    expect(screen.getByRole("button").className).toContain("group/toggle");
    expect(screen.getByRole("button").className).toContain("px-2");
    expect(screen.getByRole("button").className).not.toContain(
      "justify-between",
    );
  });

  it("shows the chevron from the clickable button hover state", () => {
    const view = render(
      <ExpandableTimelineRow
        title={TITLE}
        isExpanded={false}
        onToggle={() => {}}
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

  it("uses compact timeline header padding", () => {
    const view = render(
      <ExpandableTimelineRow
        title={TITLE}
        isExpanded={false}
        onToggle={() => {}}
        renderBody={() => <div>details</div>}
      />,
    );

    const button = screen.getByRole("button");
    expect(button.className).not.toContain("leading-none");
    expect(button.className).not.toContain("leading-4");
    expect(button.className).toContain("py-0");
    expect(button.className).not.toContain("py-0.5");
    expect(button.parentElement?.className).not.toContain("py-0");
    expect(button.parentElement?.className).not.toContain("py-0.5");
    expect(view.container.innerHTML).not.toContain("py-1");
  });

  it("can render flush horizontal padding for bundled rows", () => {
    const view = render(
      <ExpandableTimelineRow
        title={TITLE}
        horizontalPadding="flush"
        isExpanded={true}
        onToggle={() => {}}
        renderBody={() => <div>details</div>}
      />,
    );

    const button = screen.getByRole("button");
    expect(button.className).toContain("px-0");
    expect(button.className).not.toContain("px-2");
    expect(view.container.innerHTML).toContain("px-0");
  });

  it("keeps a small gap between an expanded title and its contents", () => {
    const view = render(
      <ExpandableTimelineRow
        title={TITLE}
        isExpanded={true}
        onToggle={() => {}}
        renderBody={() => <div>details</div>}
      />,
    );

    expect(view.container.innerHTML).toContain("pt-0.5");
    expect(view.container.innerHTML).not.toContain("pt-0 ");
  });

  it("does not put hover group state on the row wrapper", () => {
    const view = render(
      <ExpandableTimelineRow
        title={TITLE}
        isExpanded={false}
        onToggle={() => {}}
        renderBody={() => <div>details</div>}
      />,
    );

    expect(view.container.firstElementChild?.className).not.toContain("group");

    view.rerender(
      <ExpandableTimelineRow
        title={TITLE}
        isExpanded={true}
        onToggle={() => {}}
        renderBody={() => <div>details</div>}
      />,
    );

    expect(view.container.firstElementChild?.className).not.toContain("group");
  });
});
