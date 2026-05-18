// @vitest-environment jsdom

import {
  cleanup,
  fireEvent,
  render,
  screen,
  type RenderResult,
} from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { TimelineRow } from "@bb/server-contract";
import {
  commandRow,
  conversationRow,
  delegationRow,
  fileChangeRow,
  systemRow,
  turnRow,
} from "@/test/fixtures/thread-timeline-rows";
import {
  ThreadTimelineRows,
  type ThreadTimelineRowsProps,
} from "@/components/thread/timeline/ThreadTimelineRows";

type ElementScrollMetricName = "clientHeight" | "scrollHeight";
type ThreadTimelineRowsPropsOverrides = Partial<
  Omit<ThreadTimelineRowsProps, "timelineRows">
>;

interface ThreadTimelineRowsFixtureArgs {
  overrides?: ThreadTimelineRowsPropsOverrides;
  timelineRows: TimelineRow[];
}

interface RerenderTimelineRowsArgs extends ThreadTimelineRowsFixtureArgs {
  view: RenderResult;
}

function threadTimelineRowsProps({
  overrides = {},
  timelineRows,
}: ThreadTimelineRowsFixtureArgs): ThreadTimelineRowsProps {
  return {
    loadingTurnSummaryIds: new Set(),
    erroredTurnSummaryIds: new Set(),
    onLoadTurnSummaryRows: () => {},
    threadRuntimeDisplayStatus: "idle",
    turnSummaryRowsIdentity: "test-view",
    turnSummaryRowsById: {},
    workspaceRootPath: undefined,
    ...overrides,
    timelineRows,
  };
}

function renderTimelineRows(args: ThreadTimelineRowsFixtureArgs): RenderResult {
  return render(<ThreadTimelineRows {...threadTimelineRowsProps(args)} />);
}

function rerenderTimelineRows({
  overrides,
  timelineRows,
  view,
}: RerenderTimelineRowsArgs): void {
  view.rerender(
    <ThreadTimelineRows
      {...threadTimelineRowsProps({
        overrides,
        timelineRows,
      })}
    />,
  );
}

function restoreElementScrollMetric(
  name: ElementScrollMetricName,
  descriptor: PropertyDescriptor | undefined,
): void {
  if (descriptor) {
    Object.defineProperty(HTMLElement.prototype, name, descriptor);
    return;
  }
  delete HTMLElement.prototype[name];
}

function withElementScrollMetrics(run: () => void): void {
  const originalClientHeight = Object.getOwnPropertyDescriptor(
    HTMLElement.prototype,
    "clientHeight",
  );
  const originalScrollHeight = Object.getOwnPropertyDescriptor(
    HTMLElement.prototype,
    "scrollHeight",
  );
  Object.defineProperty(HTMLElement.prototype, "clientHeight", {
    configurable: true,
    get() {
      return 100;
    },
  });
  Object.defineProperty(HTMLElement.prototype, "scrollHeight", {
    configurable: true,
    get() {
      return 1_000;
    },
  });

  try {
    run();
  } finally {
    restoreElementScrollMetric("clientHeight", originalClientHeight);
    restoreElementScrollMetric("scrollHeight", originalScrollHeight);
  }
}

afterEach(() => {
  cleanup();
});

describe("ThreadTimelineRows", () => {
  it("renders an unread divider before the first row newer than the frozen read cutoff", () => {
    renderTimelineRows({
      overrides: {
        unreadDividerPlacement: { kind: "after-cutoff", cutoffAt: 15 },
      },
      timelineRows: [
        conversationRow({
          id: "old-message",
          sourceSeqStart: 10,
          text: "Read before cutoff",
        }),
        conversationRow({
          id: "new-message",
          sourceSeqStart: 20,
          text: "Manager update after cutoff",
        }),
      ],
    });

    const divider = screen.getByRole("separator", { name: "New messages" });
    const oldMessage = screen.getByText("Read before cutoff");
    const newMessage = screen.getByText("Manager update after cutoff");
    expect(
      oldMessage.compareDocumentPosition(divider) &
        Node.DOCUMENT_POSITION_FOLLOWING,
    ).not.toBe(0);
    expect(
      divider.compareDocumentPosition(newMessage) &
        Node.DOCUMENT_POSITION_FOLLOWING,
    ).not.toBe(0);
  });

  it("omits the unread divider when no rows are newer than the cutoff", () => {
    renderTimelineRows({
      overrides: {
        unreadDividerPlacement: { kind: "after-cutoff", cutoffAt: 20 },
      },
      timelineRows: [
        conversationRow({
          id: "read-message",
          sourceSeqStart: 20,
          text: "Read manager update",
        }),
      ],
    });

    expect(
      screen.queryByRole("separator", { name: "New messages" }),
    ).toBeNull();
  });

  it("renders delegation child progress and final output when both are present", () => {
    const view = renderTimelineRows({
      timelineRows: [delegationRow()],
    });

    expect(view.container.textContent ?? "").not.toContain(
      "Final subagent answer.",
    );

    fireEvent.click(screen.getByRole("button", { name: /Ran subagent/u }));
    expect(view.container.textContent ?? "").toContain(
      "Final subagent answer.",
    );

    fireEvent.click(
      screen.getByRole("button", {
        name: /Ran\s+rg timeline apps\/app/u,
      }),
    );

    expect(view.container.textContent ?? "").toContain("rg timeline apps/app");
  });

  it("preserves completed activity summary identity when work appends", () => {
    const firstCommand = commandRow({
      id: "command-1",
      command: "pnpm test",
      sourceSeqStart: 1,
    });
    const secondCommand = commandRow({
      id: "command-2",
      command: "pnpm lint",
      sourceSeqStart: 2,
    });
    const view = renderTimelineRows({
      timelineRows: [firstCommand, secondCommand],
    });

    const summaryButton = screen.getByRole("button", {
      name: /Ran 2 commands/u,
    });
    fireEvent.click(summaryButton);

    expect(summaryButton.getAttribute("aria-expanded")).toBe("true");
    expect(
      screen.getByRole("button", { name: /Ran\s+pnpm test/u }),
    ).toBeTruthy();

    rerenderTimelineRows({
      view,
      timelineRows: [
        firstCommand,
        secondCommand,
        commandRow({
          id: "command-3",
          command: "pnpm typecheck",
          sourceSeqStart: 3,
        }),
      ],
    });

    const appendedSummaryButton = screen.getByRole("button", {
      name: /Ran 3 commands/u,
    });
    expect(appendedSummaryButton).toBe(summaryButton);
    expect(appendedSummaryButton.getAttribute("aria-expanded")).toBe("true");
    expect(
      screen.getByRole("button", { name: /Ran\s+pnpm typecheck/u }),
    ).toBeTruthy();
  });

  it("requests lazy turn details when expanding a turn summary", () => {
    const onLoadTurnSummaryRows = vi.fn();
    const view = renderTimelineRows({
      timelineRows: [turnRow()],
      overrides: {
        onLoadTurnSummaryRows,
      },
    });

    fireEvent.click(screen.getByRole("button"));
    expect(onLoadTurnSummaryRows).toHaveBeenCalled();
    expect(onLoadTurnSummaryRows).toHaveBeenCalledWith(
      expect.objectContaining({
        id: "turn-summary-1",
        sourceSeqStart: 10,
        sourceSeqEnd: 10,
      }),
    );

    rerenderTimelineRows({
      view,
      timelineRows: [turnRow()],
      overrides: {
        onLoadTurnSummaryRows,
      },
    });

    expect(view.container.textContent ?? "").toContain(
      "Loading turn details...",
    );
  });

  it("retries lazy turn details from the error state", () => {
    const onLoadTurnSummaryRows = vi.fn();
    const view = renderTimelineRows({
      timelineRows: [turnRow()],
      overrides: {
        onLoadTurnSummaryRows,
      },
    });

    fireEvent.click(screen.getByRole("button"));
    expect(onLoadTurnSummaryRows).toHaveBeenCalled();
    onLoadTurnSummaryRows.mockClear();

    rerenderTimelineRows({
      view,
      timelineRows: [turnRow()],
      overrides: {
        erroredTurnSummaryIds: new Set(["turn-summary-1"]),
        onLoadTurnSummaryRows,
      },
    });

    expect(view.container.textContent ?? "").toContain(
      "Failed to load turn details.",
    );

    fireEvent.click(screen.getByRole("button", { name: "Retry" }));

    expect(onLoadTurnSummaryRows).toHaveBeenCalledTimes(1);
  });

  it("reloads lazy turn details after the loaded-row identity changes", () => {
    const onLoadTurnSummaryRows = vi.fn();
    const view = renderTimelineRows({
      timelineRows: [turnRow()],
      overrides: {
        onLoadTurnSummaryRows,
        turnSummaryRowsIdentity: "thread-1:conversation",
      },
    });

    const turnButton = screen.getByRole("button", {
      name: /Worked for\s*4s/u,
    });
    fireEvent.click(turnButton);
    expect(onLoadTurnSummaryRows).toHaveBeenCalledTimes(1);

    rerenderTimelineRows({
      view,
      timelineRows: [turnRow()],
      overrides: {
        onLoadTurnSummaryRows,
        turnSummaryRowsIdentity: "thread-1:conversation",
        turnSummaryRowsById: {
          "turn-summary-1": [
            conversationRow({
              id: "conversation-detail-1",
              text: "Conversation view details",
            }),
          ],
        },
      },
    });
    expect(view.container.textContent ?? "").toContain(
      "Conversation view details",
    );

    fireEvent.click(turnButton);
    expect(turnButton.getAttribute("aria-expanded")).toBe("false");

    rerenderTimelineRows({
      view,
      timelineRows: [turnRow()],
      overrides: {
        onLoadTurnSummaryRows,
        turnSummaryRowsIdentity: "thread-1:standard",
      },
    });

    const standardTurnButton = screen.getByRole("button", {
      name: /Worked for\s*4s/u,
    });
    fireEvent.click(standardTurnButton);
    expect(onLoadTurnSummaryRows).toHaveBeenCalledTimes(2);
    expect(view.container.textContent ?? "").toContain(
      "Loading turn details...",
    );

    rerenderTimelineRows({
      view,
      timelineRows: [turnRow()],
      overrides: {
        onLoadTurnSummaryRows,
        turnSummaryRowsIdentity: "thread-1:standard",
        turnSummaryRowsById: {
          "turn-summary-1": [
            conversationRow({
              id: "standard-detail-1",
              text: "Standard view details",
            }),
          ],
        },
      },
    });
    expect(view.container.textContent ?? "").toContain("Standard view details");
    expect(view.container.textContent ?? "").not.toContain(
      "Loading turn details...",
    );
  });

  it("updates expanded pending command output when source sequence advances", () => {
    const view = renderTimelineRows({
      timelineRows: [
        commandRow({
          id: "command-streaming-1",
          command: "pnpm test",
          output: "first chunk",
          sourceSeqEnd: 1,
          sourceSeqStart: 1,
          status: "pending",
        }),
      ],
    });

    fireEvent.click(
      screen.getByRole("button", { name: /Running\s+pnpm test/u }),
    );

    expect(view.container.textContent ?? "").toContain("first chunk");

    rerenderTimelineRows({
      view,
      timelineRows: [
        commandRow({
          id: "command-streaming-1",
          command: "pnpm test",
          output: "second chunk",
          sourceSeqEnd: 2,
          sourceSeqStart: 1,
          status: "pending",
        }),
      ],
    });

    expect(view.container.textContent ?? "").toContain("second chunk");
    expect(view.container.textContent ?? "").not.toContain("first chunk");
  });

  it("renders file-change stderr without rendering stdout below diffs", () => {
    const view = renderTimelineRows({
      timelineRows: [
        fileChangeRow({
          stdout: "Success. Updated the following files:\nM src/app.ts",
          stderr: "patch failed",
        }),
      ],
    });

    fireEvent.click(screen.getByRole("button", { name: /Edited\s+app\.ts/u }));

    expect(view.container.textContent ?? "").not.toContain(
      "Success. Updated the following files:",
    );
    expect(view.container.textContent ?? "").toContain("patch failed");
  });

  it("collapses lazy turn-detail trailing work into a step-summary", () => {
    // Lazy turn-detail children belong to a completed turn. Its closure
    // depends on the end-of-input flush taking the closed-scope branch.
    // Without that flag, mixed-concept trailing work renders as a
    // sequence of bundles and leaves instead of one step-summary,
    // exactly the bug seen on the live timeline. See `timeline-view.ts`
    // `closeOpenStepAtBoundary` vs `flushOpenStepAsBundles`.
    renderTimelineRows({
      timelineRows: [turnRow()],
      overrides: {
        turnSummaryRowsById: {
          "turn-summary-1": [
            commandRow({
              id: "nested-tool-1",
              command: "rg pattern",
              sourceSeqStart: 11,
            }),
            commandRow({
              id: "nested-tool-2",
              command: "pnpm test",
              sourceSeqStart: 12,
            }),
            fileChangeRow({
              id: "nested-edit-1",
              path: "src/a.ts",
              sourceSeqStart: 13,
            }),
            fileChangeRow({
              id: "nested-edit-2",
              path: "src/b.ts",
              sourceSeqStart: 14,
            }),
            commandRow({
              id: "nested-tool-3",
              command: "pnpm typecheck",
              sourceSeqStart: 15,
            }),
            fileChangeRow({
              id: "nested-edit-3",
              path: "src/c.ts",
              sourceSeqStart: 16,
            }),
          ],
        },
      },
    });

    fireEvent.click(screen.getByRole("button", { name: /Worked for\s*4s/u }));

    // Mixed-concept trailing run (commands + file edits) collapses into
    // a single step-summary describing the combined work, not separate
    // bundles per consecutive same-concept run.
    const stepSummary = screen.getByRole("button", {
      name: /Ran 3 commands, edited 3 files/u,
    });
    expect(stepSummary).toBeTruthy();
    expect(
      screen.queryByRole("button", { name: /^Edited 2 files\b/u }),
    ).toBeNull();
  });

  it("keeps expanded system details pinned to bottom on streaming updates unless the user scrolls up", () => {
    // Sticky-bottom only fires while the row is still pending — completed
    // system rows preserve whatever scroll position the user landed on.
    withElementScrollMetrics(() => {
      const view = renderTimelineRows({
        timelineRows: [
          systemRow({ detail: "first\nsecond", status: "pending" }),
        ],
      });

      fireEvent.click(
        screen.getByRole("button", { name: /Provisioned thread/u }),
      );
      const scrollArea = view.container.querySelector<HTMLElement>(
        "[data-detail-scroll-area]",
      );
      expect(scrollArea?.scrollTop).toBe(900);

      if (!scrollArea) {
        throw new Error("Expected system detail scroll area to render");
      }

      scrollArea.scrollTop = 500;
      fireEvent.scroll(scrollArea);
      rerenderTimelineRows({
        view,
        timelineRows: [
          systemRow({ detail: "first\nsecond\nthird", status: "pending" }),
        ],
      });
      expect(scrollArea.scrollTop).toBe(900);

      scrollArea.scrollTop = 500;
      fireEvent.wheel(scrollArea);
      fireEvent.scroll(scrollArea);
      rerenderTimelineRows({
        view,
        timelineRows: [
          systemRow({
            detail: "first\nsecond\nthird\nfourth",
            status: "pending",
          }),
        ],
      });
      expect(scrollArea.scrollTop).toBe(500);
    });
  });

});
