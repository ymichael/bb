// @vitest-environment jsdom

import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
} from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { TimelineTitle } from "@bb/thread-view";
import { ExpandableTimelineRow } from "@/components/thread/timeline/ExpandableTimelineRow";

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
  it("renders body children while expanded and through the close animation", () => {
    vi.useFakeTimers();
    const renderBody = vi.fn(() => <div>expensive details</div>);
    try {
      const view = render(
        <ExpandableTimelineRow title={TITLE} renderBody={renderBody} />,
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
        <ExpandableTimelineRow title={TITLE} renderBody={renderBody} />,
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
    expect(view.container.textContent ?? "").toContain("expanded row content");
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
