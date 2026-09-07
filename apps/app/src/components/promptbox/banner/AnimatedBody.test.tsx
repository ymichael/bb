// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { useState } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { workflowRow } from "@/test/fixtures/thread-timeline-rows";
import { AnimatedBody } from "./AnimatedBody";
import { ThreadBackgroundCommandsCard } from "./ThreadBackgroundCommandsCard";

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe("AnimatedBody", () => {
  it("realizes the body on the first expand and retains it after collapse", () => {
    const { rerender } = render(
      <AnimatedBody
        id="body"
        labelledBy="toggle"
        isExpanded={false}
        collapsedBorder="none"
      >
        <span>expensive body</span>
      </AnimatedBody>,
    );
    expect(screen.queryByText("expensive body")).toBeNull();

    rerender(
      <AnimatedBody
        id="body"
        labelledBy="toggle"
        isExpanded
        collapsedBorder="none"
      >
        <span>expensive body</span>
      </AnimatedBody>,
    );
    expect(screen.getByText("expensive body")).not.toBeNull();

    rerender(
      <AnimatedBody
        id="body"
        labelledBy="toggle"
        isExpanded={false}
        collapsedBorder="none"
      >
        <span>expensive body</span>
      </AnimatedBody>,
    );
    expect(screen.getByText("expensive body")).not.toBeNull();
    expect(
      screen.getByRole("region", { hidden: true }).getAttribute("aria-hidden"),
    ).toBe("true");
  });
});

describe("prompt-stack card bodies", () => {
  it("does not mount per-row live durations for a collapsed background-activity card", () => {
    vi.useFakeTimers();
    const setInterval = vi.spyOn(globalThis, "setInterval");
    const startedAt = Date.now() - 5_000;
    function Card() {
      const [isExpanded, setIsExpanded] = useState(false);
      return (
        <ThreadBackgroundCommandsCard
          commands={[1, 2, 3].map((index) =>
            workflowRow({
              id: `wf_${index}`,
              description: `Background agent ${index}`,
              model: "haiku",
              startedAt,
              status: "pending",
              taskStatus: "running",
              taskType: "local_agent",
              workflowName: null,
            }),
          )}
          isExpanded={isExpanded}
          onToggle={() => setIsExpanded((value) => !value)}
        />
      );
    }
    render(<Card />);
    expect(screen.queryByText("Background agent 2")).toBeNull();
    expect(setInterval).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole("button", { expanded: false }));
    expect(screen.getByText("Background agent 2")).not.toBeNull();
    expect(setInterval).toHaveBeenCalledTimes(1);
  });
});
