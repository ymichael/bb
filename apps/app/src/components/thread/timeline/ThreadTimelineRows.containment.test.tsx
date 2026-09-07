// @vitest-environment jsdom

import { act, cleanup, render } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  commandRow,
  conversationRow,
  turnRow,
} from "@/test/fixtures/thread-timeline-rows";
import { ThreadTimelineRows } from "./ThreadTimelineRows";
import {
  estimateTimelineRowIntrinsicBlockSizePx,
  TOP_LEVEL_TIMELINE_ROW_CLASS_NAME,
  TOP_LEVEL_TIMELINE_ROW_INTRINSIC_SIZE_CLASS_NAME,
} from "./timeline-row-containment";

function stubScrollAnchoring(supported: boolean): void {
  vi.stubGlobal("CSS", {
    supports: (property: string, value: string) =>
      supported && property === "overflow-anchor" && value === "none",
  });
}

beforeEach(() => {
  stubScrollAnchoring(true);
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

function rowWrapper(container: HTMLElement, rowId: string): HTMLElement {
  const element = container.querySelector<HTMLElement>(
    `[data-timeline-row-id="${rowId}"]`,
  );
  if (element === null) {
    throw new Error(`row ${rowId} did not render`);
  }
  return element;
}

function nextAnimationFrame(): Promise<void> {
  return new Promise((resolve) => {
    window.requestAnimationFrame(() => resolve());
  });
}

describe("ThreadTimelineRows row containment", () => {
  it("applies content-visibility containment to top-level row wrappers only, after their first layout", async () => {
    const rows = [
      conversationRow({
        id: "user_1",
        role: "user",
        text: "Please look into the flaky test.",
        seq: 1,
      }),
      turnRow({
        id: "turn_1",
        status: "completed",
        children: [
          commandRow({ id: "cmd_nested", command: "pnpm test", seq: 2 }),
          conversationRow({
            id: "assistant_nested",
            role: "assistant",
            text: "Nested answer.",
            seq: 3,
          }),
        ],
      }),
      conversationRow({
        id: "assistant_1",
        role: "assistant",
        text: "x".repeat(600),
        seq: 4,
      }),
    ];
    const view = render(
      <MemoryRouter>
        <QueryClientProvider client={new QueryClient()}>
          <ThreadTimelineRows
            threadId="thr_main"
            timelineRows={rows}
            threadRuntimeDisplayStatus="idle"
            workspaceRootPath={undefined}
            initialExpanded={new Set(["turn_1"])}
          />
        </QueryClientProvider>
      </MemoryRouter>,
    );

    for (const rowId of ["user_1", "turn_1", "assistant_1"]) {
      expect(rowWrapper(view.container, rowId).className).toBe(
        TOP_LEVEL_TIMELINE_ROW_INTRINSIC_SIZE_CLASS_NAME,
      );
    }
    expect(TOP_LEVEL_TIMELINE_ROW_INTRINSIC_SIZE_CLASS_NAME).not.toContain(
      "content-visibility",
    );

    await act(nextAnimationFrame);
    expect(rowWrapper(view.container, "assistant_1").className).toBe(
      TOP_LEVEL_TIMELINE_ROW_INTRINSIC_SIZE_CLASS_NAME,
    );
    await act(nextAnimationFrame);
    const armedClassNames = TOP_LEVEL_TIMELINE_ROW_CLASS_NAME.split(" ");
    expect(armedClassNames).toContain("max-md:[content-visibility:auto]");
    expect(armedClassNames).toContain(
      TOP_LEVEL_TIMELINE_ROW_INTRINSIC_SIZE_CLASS_NAME,
    );
    for (const rowId of ["user_1", "turn_1", "assistant_1"]) {
      expect(
        Array.from(rowWrapper(view.container, rowId).classList).sort(),
      ).toEqual([...armedClassNames].sort());
    }

    rowWrapper(view.container, "assistant_1").classList.add("bb-search-flash");
    view.rerender(
      <MemoryRouter>
        <QueryClientProvider client={new QueryClient()}>
          <ThreadTimelineRows
            threadId="thr_main"
            timelineRows={rows}
            threadRuntimeDisplayStatus="active"
            workspaceRootPath={undefined}
            initialExpanded={new Set(["turn_1"])}
          />
        </QueryClientProvider>
      </MemoryRouter>,
    );
    expect(
      rowWrapper(view.container, "assistant_1").classList.contains(
        "bb-search-flash",
      ),
    ).toBe(true);
    expect(
      rowWrapper(view.container, "assistant_1").classList.contains(
        "max-md:[content-visibility:auto]",
      ),
    ).toBe(true);

    expect(rowWrapper(view.container, "cmd_nested").className).toBe("");
    expect(rowWrapper(view.container, "assistant_nested").className).toBe("");
    expect(rowWrapper(view.container, "assistant_nested").style.length).toBe(0);

    expect(rowWrapper(view.container, "turn_1").style.length).toBe(0);
    expect(
      rowWrapper(view.container, "assistant_1").style.containIntrinsicBlockSize,
    ).toBe(`auto ${estimateTimelineRowIntrinsicBlockSizePx(rows[2]!)}px`);
    expect(estimateTimelineRowIntrinsicBlockSizePx(rows[2]!)).toBeGreaterThan(
      estimateTimelineRowIntrinsicBlockSizePx(rows[0]!) ?? Number.NaN,
    );
  });

  it("never arms content-visibility where CSS scroll anchoring is missing (WebKit)", async () => {
    stubScrollAnchoring(false);
    const rows = [
      conversationRow({
        id: "user_1",
        role: "user",
        text: "Please look into the flaky test.",
        seq: 1,
      }),
      conversationRow({
        id: "assistant_1",
        role: "assistant",
        text: "x".repeat(600),
        seq: 2,
      }),
    ];
    const view = render(
      <MemoryRouter>
        <QueryClientProvider client={new QueryClient()}>
          <ThreadTimelineRows
            threadId="thr_main"
            timelineRows={rows}
            threadRuntimeDisplayStatus="idle"
            workspaceRootPath={undefined}
            initialExpanded={new Set()}
          />
        </QueryClientProvider>
      </MemoryRouter>,
    );
    await act(nextAnimationFrame);
    await act(nextAnimationFrame);
    await act(nextAnimationFrame);
    for (const rowId of ["user_1", "assistant_1"]) {
      const classes = Array.from(rowWrapper(view.container, rowId).classList);
      expect(classes).toContain(
        TOP_LEVEL_TIMELINE_ROW_INTRINSIC_SIZE_CLASS_NAME,
      );
      expect(classes).not.toContain("max-md:[content-visibility:auto]");
    }
  });
});
