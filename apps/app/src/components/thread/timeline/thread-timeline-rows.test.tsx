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
  readIntent,
  searchIntent,
  systemRow,
  toolRow,
  turnRow,
} from "@/test/fixtures/thread-timeline-rows";
import {
  ThreadTimelineRows,
  type ThreadTimelineRowsProps,
} from "@/components/thread/timeline/ThreadTimelineRows";
import type { UserAttachmentImageSrcResolver } from "@/components/thread/timeline/types";

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
  it("keeps same-props timeline rerenders from re-resolving attachment image sources", () => {
    const erroredTurnSummaryIds = new Set<string>();
    const loadingTurnSummaryIds = new Set<string>();
    const onLoadTurnSummaryRows = () => {};
    const resolveUserAttachmentImageSrc = vi.fn<UserAttachmentImageSrcResolver>(
      (path, projectId) => `/attachments/${projectId}${path}`,
    );
    const timelineRows = [
      conversationRow({
        role: "user",
        text: "Attached.",
        attachments: {
          webImages: 0,
          localImages: 1,
          localFiles: 0,
          imageUrls: [],
          localImagePaths: ["/workspace/shot.png"],
          localFilePaths: [],
        },
      }),
    ];
    const turnSummaryRowsById = {};

    const view = render(
      <ThreadTimelineRows
        erroredTurnSummaryIds={erroredTurnSummaryIds}
        loadingTurnSummaryIds={loadingTurnSummaryIds}
        onLoadTurnSummaryRows={onLoadTurnSummaryRows}
        projectId="project-1"
        resolveUserAttachmentImageSrc={resolveUserAttachmentImageSrc}
        timelineRows={timelineRows}
        threadRuntimeDisplayStatus="idle"
        turnSummaryRowsIdentity="test-view"
        turnSummaryRowsById={turnSummaryRowsById}
      />,
    );
    expect(resolveUserAttachmentImageSrc).toHaveBeenCalledTimes(1);

    view.rerender(
      <ThreadTimelineRows
        erroredTurnSummaryIds={erroredTurnSummaryIds}
        loadingTurnSummaryIds={loadingTurnSummaryIds}
        onLoadTurnSummaryRows={onLoadTurnSummaryRows}
        projectId="project-1"
        resolveUserAttachmentImageSrc={resolveUserAttachmentImageSrc}
        timelineRows={timelineRows}
        threadRuntimeDisplayStatus="idle"
        turnSummaryRowsIdentity="test-view"
        turnSummaryRowsById={turnSummaryRowsById}
      />,
    );

    expect(resolveUserAttachmentImageSrc).toHaveBeenCalledTimes(1);
  });

  it("renders activity summary exploration details as compact static rows", () => {
    const view = renderTimelineRows({
      timelineRows: [
        commandRow({
          id: "exploration-1",
          command: "cat src/app.ts && rg TODO src",
          activityIntents: [
            readIntent({ path: "src/app.ts" }),
            searchIntent({ query: "TODO", path: "src" }),
          ],
          output: "large file contents",
          sourceSeqStart: 1,
        }),
        commandRow({
          id: "exploration-2",
          command: "rg FIXME src",
          activityIntents: [searchIntent({ query: "FIXME", path: "src" })],
          output: "more large output",
          sourceSeqStart: 2,
        }),
      ],
    });

    expect(screen.getAllByRole("button")).toHaveLength(1);

    fireEvent.click(screen.getByRole("button"));

    expect(
      view.container.querySelector('[title="Read src/app.ts"]'),
    ).not.toBeNull();
    expect(view.container.textContent ?? "").not.toContain("Read src/app.ts");
    expect(
      view.container.querySelector('[title="Searched for TODO in src"]'),
    ).not.toBeNull();
    expect(view.container.textContent ?? "").not.toContain("$ cat src/app.ts");
    expect(view.container.textContent ?? "").not.toContain(
      "large file contents",
    );
    expect(view.container.textContent ?? "").not.toContain("more large output");
    expect(screen.getAllByRole("button")).toHaveLength(1);
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

  it("groups completed work once a second completed row appends to the run", () => {
    const firstCommand = commandRow({
      id: "command-1",
      command: "pnpm test",
      sourceSeqStart: 1,
    });
    const view = renderTimelineRows({
      timelineRows: [firstCommand],
    });

    expect(
      screen.getByRole("button", {
        name: /Ran\s+pnpm test\s+2s/u,
      }),
    ).toBeTruthy();

    rerenderTimelineRows({
      view,
      timelineRows: [
        firstCommand,
        commandRow({
          id: "command-2",
          command: "pnpm lint",
          sourceSeqStart: 2,
        }),
      ],
    });

    expect(
      screen.queryByRole("button", { name: /Ran\s+pnpm test\s+2s/u }),
    ).toBeNull();
    expect(
      screen.getByRole("button", { name: /Ran 2 commands/u }),
    ).toBeTruthy();
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

  it("renders failed structured tools as compact intent rows with an (error) marker", () => {
    // Inside a bundle, an errored exploration tool stays in the compact
    // static intent listing — same shape as its successful siblings — but
    // its title carries an (error) decoration so the user can identify
    // the failing row. The bundle's aggregate "(N errors)" label only
    // counts errors; per-row marking is what tells you *which* row.
    const view = renderTimelineRows({
      timelineRows: [
        toolRow({
          id: "tool-1",
          activityIntents: [readIntent({ path: "/repo/src/app.ts" })],
          output: "ENOENT: no such file or directory",
          status: "error",
          sourceSeqStart: 1,
        }),
        toolRow({
          id: "tool-2",
          activityIntents: [readIntent({ path: "/repo/src/lib.ts" })],
          status: "completed",
          sourceSeqStart: 2,
        }),
      ],
    });

    const summaryButton = screen.getByRole("button", {
      name: /Explored 2 files \(1 error\)/u,
    });
    fireEvent.click(summaryButton);

    // The HTML title attribute carries the plain-text form of segments +
    // decorations, so a successful read is "Read <path>" and a failed
    // read is "Read <path> (error)". This is the per-row marker the
    // bundle's aggregate count alone does not provide.
    const errorRow = view.container.querySelector(
      '[title="Read /repo/src/app.ts (error)"]',
    );
    expect(errorRow).not.toBeNull();

    const successRow = view.container.querySelector(
      '[title="Read /repo/src/lib.ts"]',
    );
    expect(successRow).not.toBeNull();

    // Errored intent rows in the bundle stay static — no button affordance,
    // matching the rest of the compact listing. This is a deliberate
    // tradeoff: the user loses the click-to-expand affordance that would
    // have shown the error output. The (error) marker is the entire
    // per-row signal; the underlying error body is intentionally
    // unreachable from inside the bundle.
    expect(
      screen.queryByRole("button", { name: /Read\s+app\.ts/u }),
    ).toBeNull();
    expect(view.container.textContent ?? "").not.toContain(
      "ENOENT: no such file or directory",
    );
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
