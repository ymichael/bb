// @vitest-environment jsdom

import { render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { describe, expect, it } from "vitest";
import { systemRow } from "@/test/fixtures/thread-timeline-rows";
import { ThreadTimelineRows } from "./ThreadTimelineRows";

describe("completed reasoning typography", () => {
  it("renders completed reasoning as proportional italic prose", () => {
    const row = systemRow({
      id: "thread-1:op:reasoning:turn-1:item-1",
      turnId: "turn-1",
      title: "Thought for 3s",
      detail: "Inspect the renderer hierarchy first.",
      operationKind: "generic",
    });

    render(
      <MemoryRouter>
        <ThreadTimelineRows
          threadId="thread-1"
          threadRuntimeDisplayStatus="idle"
          workspaceRootPath={undefined}
          timelineRows={[row]}
          initialExpanded={new Set([row.id])}
        />
      </MemoryRouter>,
    );

    const detail = screen.getByText("Inspect the renderer hierarchy first.");
    expect(detail.tagName).toBe("DIV");
    expect(detail.className.split(" ")).toEqual(
      expect.arrayContaining(["text-sm", "italic", "leading-relaxed"]),
    );
    expect(detail.className.split(" ")).not.toContain("font-mono");
  });

  it("keeps other system operation details monospace", () => {
    const row = systemRow({
      id: "thread-1:op:setup:item-1",
      title: "Prepared environment",
      detail: "$ build\nfinished",
      operationKind: "generic",
    });

    render(
      <MemoryRouter>
        <ThreadTimelineRows
          threadId="thread-1"
          threadRuntimeDisplayStatus="idle"
          workspaceRootPath={undefined}
          timelineRows={[row]}
          initialExpanded={new Set([row.id])}
        />
      </MemoryRouter>,
    );

    const detail = screen.getByText(
      (_, element) =>
        element?.tagName === "PRE" && element.textContent === "$ build\nfinished",
    );
    expect(detail.tagName).toBe("PRE");
    expect(detail.className.split(" ")).toEqual(
      expect.arrayContaining(["font-mono", "text-xs", "leading-tight"]),
    );
  });
});
