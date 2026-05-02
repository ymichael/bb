// @vitest-environment jsdom

import { cleanup, render, screen } from "@testing-library/react";
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

  it("renders body children only while expanded", () => {
    const renderBody = vi.fn(() => <div>expensive details</div>);
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
    expect(view.container.textContent ?? "").not.toContain("expensive details");
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
    expect(screen.getByRole("button").className).not.toContain(
      "justify-between",
    );
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
    expect(button.className).toContain("leading-4");
    expect(button.className).toContain("py-0");
    expect(button.className).not.toContain("py-0.5");
    expect(button.parentElement?.className).toContain("py-0");
    expect(button.parentElement?.className).not.toContain("py-0.5");
    expect(view.container.innerHTML).not.toContain("py-1");
  });

  it("drops wrapper group class while expanded so hover does not leak to nested rows", () => {
    const view = render(
      <ExpandableTimelineRow
        title={TITLE}
        isExpanded={false}
        onToggle={() => {}}
        renderBody={() => <div>details</div>}
      />,
    );

    expect(view.container.firstElementChild?.className).toContain("group");

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
