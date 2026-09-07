// @vitest-environment jsdom

import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { TimelineCommandWorkRow } from "@bb/server-contract";
import { commandRow } from "@/test/fixtures/thread-timeline-rows";
import { createQueryClientTestHarness } from "@/test/queryClientTestHarness";
import { sdk } from "@/lib/sdk";
import { ThreadTimelineRows } from "./ThreadTimelineRows";

vi.mock("@/lib/sdk", () => ({
  sdk: { threads: { timelineTurnSummaryDetails: vi.fn() } },
}));

const timelineTurnSummaryDetails = vi.mocked(
  sdk.threads.timelineTurnSummaryDetails,
);

const FULL_OUTPUT = `FULL-HEAD ${"x".repeat(5_000)} FULL-TAIL`;
const PREVIEW_OUTPUT =
  "FULL-HEAD xxx\n…[4,000 characters omitted from preview]\nxxx FULL-TAIL";

function previewedCommandRow(
  overrides: Partial<Pick<TimelineCommandWorkRow, "status">> = {},
): TimelineCommandWorkRow {
  return {
    ...commandRow({
      id: "cmd_big",
      command: "pnpm test",
      output: PREVIEW_OUTPUT,
      sourceSeqStart: 4,
      sourceSeqEnd: 7,
      threadId: "thr_main",
      turnId: "turn_1",
      status: overrides.status ?? "completed",
      exitCode: overrides.status === "pending" ? null : 0,
    }),
    outputPreview: { totalChars: FULL_OUTPUT.length },
  };
}

function renderExpandedRow(row: TimelineCommandWorkRow) {
  const { wrapper: Wrapper } = createQueryClientTestHarness();
  return render(
    <MemoryRouter>
      <Wrapper>
        <ThreadTimelineRows
          initialExpanded={new Set([row.id])}
          threadId="thr_main"
          timelineRows={[row]}
          threadRuntimeDisplayStatus="idle"
          workspaceRootPath={undefined}
        />
      </Wrapper>
    </MemoryRouter>,
  );
}

beforeEach(() => {
  timelineTurnSummaryDetails.mockReset();
});

afterEach(() => {
  cleanup();
});

describe("previewed command output", () => {
  it("loads the full output for an expanded finished row through row-scoped turn details", async () => {
    timelineTurnSummaryDetails.mockResolvedValue({
      rows: [
        commandRow({
          id: "cmd_big",
          command: "pnpm test",
          output: FULL_OUTPUT,
          sourceSeqStart: 4,
          sourceSeqEnd: 7,
          threadId: "thr_main",
          turnId: "turn_1",
        }),
      ],
    });
    const view = renderExpandedRow(previewedCommandRow());

    await waitFor(() => {
      expect(timelineTurnSummaryDetails).toHaveBeenCalledTimes(1);
    });
    expect(timelineTurnSummaryDetails.mock.calls[0]?.[0]).toMatchObject({
      threadId: "thr_main",
      turnId: "turn_1",
      sourceSeqStart: "4",
      sourceSeqEnd: "7",
    });
    await waitFor(() => {
      expect(view.container.textContent).toContain(FULL_OUTPUT);
    });
    expect(view.container.textContent).not.toContain("characters omitted");
    expect(screen.queryByTestId("timeline-output-preview-note")).toBeNull();
  });

  it("keeps the live preview for a running row and does not fetch details", async () => {
    const view = renderExpandedRow(previewedCommandRow({ status: "pending" }));

    expect(view.container.textContent).toContain("characters omitted");
    expect(
      screen.getByTestId("timeline-output-preview-note").textContent,
    ).toContain("full output loads when this finishes");
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(timelineTurnSummaryDetails).not.toHaveBeenCalled();
  });

  it("shows the preview with a retry when the full-output load fails", async () => {
    timelineTurnSummaryDetails.mockRejectedValue(new Error("boom"));
    const view = renderExpandedRow(previewedCommandRow());

    await waitFor(() => {
      expect(screen.getByRole("button", { name: /retry/i })).toBeTruthy();
    });
    expect(view.container.textContent).toContain("characters omitted");
    expect(
      screen.getByTestId("timeline-output-preview-note").textContent,
    ).toContain("Failed to load the full output");
  });
});
