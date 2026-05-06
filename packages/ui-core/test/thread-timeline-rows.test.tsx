// @vitest-environment jsdom

import {
  cleanup,
  fireEvent,
  render,
  screen,
  type RenderResult,
} from "@testing-library/react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { TimelineRow, TimelineSystemRow } from "@bb/server-contract";
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
  webFetchRow,
  webSearchRow,
} from "../fixtures/thread-timeline-rows.js";
import {
  ThreadTimelineRows,
  type ThreadTimelineRowsProps,
} from "../src/thread-timeline/ThreadTimelineRows.js";
import type {
  ThreadTimelineLocalFileLinkHandler,
  UserAttachmentImageSrcResolver,
} from "../src/thread-timeline/types.js";

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
    ...overrides,
    timelineRows,
  };
}

function renderRowsToStaticMarkup(args: ThreadTimelineRowsFixtureArgs): string {
  return renderToStaticMarkup(
    <ThreadTimelineRows {...threadTimelineRowsProps(args)} />,
  );
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
    const resolveUserAttachmentImageSrc =
      vi.fn<UserAttachmentImageSrcResolver>(
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

  it("shows the expand control when a short user message overflows by wrapping", () => {
    const wrappedShortMessage = "wrapped ".repeat(70);

    withElementScrollMetrics(() => {
      renderTimelineRows({
        timelineRows: [
          conversationRow({
            role: "user",
            text: wrappedShortMessage,
          }),
        ],
      });

      expect(
        screen.getByRole("button", { name: "Show more" }),
      ).toBeTruthy();
    });
  });

  it("uses active-latest treatment for trailing completed bundles in an active scope", () => {
    // New spec: a bundle that is the trailing/latest bundle in the open step
    // gets active-latest treatment (present tense + shimmer) regardless of
    // whether its children have completed. The displaced (non-latest) bundle
    // would render past-tense; see the displacement coverage below.
    const html = renderRowsToStaticMarkup({
      timelineRows: [
        commandRow({
          id: "read-1",
          command: "cat src/app.ts",
          activityIntents: [readIntent({ path: "src/app.ts" })],
          sourceSeqStart: 1,
        }),
        commandRow({
          id: "read-2",
          command: "cat src/other.ts",
          activityIntents: [readIntent({ path: "src/other.ts" })],
          sourceSeqStart: 2,
        }),
      ],
      overrides: {
        threadRuntimeDisplayStatus: "active",
      },
    });

    expect(html).toContain("Exploring");
    expect(html).toContain("2 files");
  });

  it("uses active wording for pending tail activity summaries in an active scope", () => {
    const html = renderRowsToStaticMarkup({
      timelineRows: [
        commandRow({
          id: "command-pending-1",
          command: "pnpm test",
          sourceSeqStart: 1,
          status: "pending",
        }),
        commandRow({
          id: "command-pending-2",
          command: "pnpm lint",
          sourceSeqStart: 2,
          status: "pending",
        }),
      ],
      overrides: {
        threadRuntimeDisplayStatus: "active",
      },
    });

    expect(html).toContain("Running");
    expect(html).toContain("2 commands");
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
        name: /Ran\s+rg timeline packages\/ui-core/u,
      }),
    );

    expect(view.container.textContent ?? "").toContain(
      "rg timeline packages/ui-core",
    );
  });

  it("does not render web search and fetch leaves as expandable rows", () => {
    const view = renderTimelineRows({
      timelineRows: [webSearchRow(), webFetchRow()],
    });

    expect(screen.getAllByRole("button")).toHaveLength(1);
    fireEvent.click(screen.getByRole("button"));

    expect(view.container.textContent ?? "").toContain("Ran web search");
    expect(view.container.textContent ?? "").toContain("Fetched");
    expect(screen.getAllByRole("button")).toHaveLength(1);
  });

  it("style contract: renders top-level timeline rows with a visible list gap", () => {
    const view = renderTimelineRows({
      timelineRows: [
        conversationRow({ id: "assistant-1", text: "Done." }),
        commandRow({
          id: "command-1",
          command: "pnpm test",
          sourceSeqStart: 2,
        }),
      ],
    });

    const topLevelList = view.container.querySelector(
      '[data-timeline-row-list="top-level"]',
    );
    expect(topLevelList).not.toBeNull();
    expect(topLevelList?.classList.contains("gap-1")).toBe(true);
    expect(topLevelList?.classList.contains("gap-0.5")).toBe(false);
  });

  it("style contract: adds bottom padding to non-user rows but not user message rows", () => {
    const view = renderTimelineRows({
      timelineRows: [
        conversationRow({ id: "assistant-1", text: "Done." }),
        conversationRow({
          id: "user-1",
          role: "user",
          text: "Please patch this.",
        }),
        commandRow({
          id: "command-1",
          command: "pnpm test",
          sourceSeqStart: 3,
        }),
      ],
    });

    const topLevelList = view.container.querySelector(
      '[data-timeline-row-list="top-level"]',
    );
    const topLevelRows = Array.from(topLevelList?.children ?? []);

    expect(topLevelRows).toHaveLength(3);
    expect(topLevelRows[0]?.classList.contains("pb-2")).toBe(true);
    expect(topLevelRows[1]?.classList.contains("pb-2")).toBe(false);
    expect(topLevelRows[2]?.classList.contains("pb-2")).toBe(true);
  });

  it("style contract: does not add bottom padding to nested rows", () => {
    const view = renderTimelineRows({
      timelineRows: [turnRow()],
      overrides: {
        turnSummaryRowsById: {
          "turn-summary-1": [
            commandRow({
              id: "nested-command-1",
              command: "pnpm test",
              sourceSeqStart: 11,
            }),
          ],
        },
      },
    });

    fireEvent.click(screen.getByRole("button", { name: /Worked for\s*4s/u }));

    const nestedList = view.container.querySelector(
      '[data-timeline-row-list="nested"]',
    );
    const nestedRows = Array.from(nestedList?.children ?? []);

    expect(nestedRows.length).toBeGreaterThan(0);
    expect(nestedRows.some((row) => row.classList.contains("pb-2"))).toBe(
      false,
    );
  });

  it("style contract: renders rows inside activity summaries with no list gap", () => {
    const view = renderTimelineRows({
      timelineRows: [
        commandRow({
          id: "command-1",
          command: "pnpm test",
          sourceSeqStart: 1,
        }),
        commandRow({
          id: "command-2",
          command: "pnpm lint",
          sourceSeqStart: 2,
        }),
      ],
    });

    fireEvent.click(screen.getByRole("button", { name: /Ran 2 commands/u }));

    const bundleList = view.container.querySelector(
      '[data-timeline-row-list="bundle"]',
    );
    expect(bundleList).not.toBeNull();
    expect(bundleList?.classList.contains("gap-0")).toBe(true);
    expect(bundleList?.classList.contains("gap-0.5")).toBe(false);
    expect(
      Array.from(bundleList?.children ?? []).some((child) =>
        child.classList.contains("pb-2"),
      ),
    ).toBe(false);

    const bundledCommandButton = screen.getByRole("button", {
      name: /Ran\s+pnpm test\s+2s/u,
    });
    expect(bundledCommandButton.classList.contains("px-0")).toBe(true);
    expect(bundledCommandButton.classList.contains("px-2")).toBe(false);
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

  it("style contract: uses flush horizontal padding for static title rows inside activity summaries", () => {
    const view = renderTimelineRows({
      timelineRows: [webSearchRow(), webFetchRow()],
    });

    fireEvent.click(screen.getByRole("button", { name: /Ran 1 web search/u }));

    const staticTitle = view.container.querySelector(
      '[title="Ran web search: timeline renderer"]',
    );
    expect(staticTitle).not.toBeNull();
    const staticHeader = staticTitle?.closest(".timeline-row-header");
    expect(staticHeader?.classList.contains("px-0")).toBe(true);
    expect(staticHeader?.classList.contains("px-2")).toBe(false);
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

  it("hides command detail until the row is expanded", () => {
    const view = renderTimelineRows({
      timelineRows: [
        commandRow({
          id: "command-1",
          command: "true",
        }),
      ],
    });

    expect(view.container.textContent ?? "").toContain("Ran");
    expect(screen.queryByRole("button", { name: /Ran 1 command/u })).toBeNull();
    expect(view.container.textContent ?? "").not.toContain("$ true");

    fireEvent.click(screen.getByRole("button", { name: /Ran\s+true/u }));

    expect(view.container.textContent ?? "").toContain("$ true");
    expect(view.container.textContent ?? "").toContain("exit code 0");
  });

  it("renders expanded tool details as labeled content", () => {
    const view = renderTimelineRows({
      timelineRows: [
        toolRow({
          id: "tool-detail-1",
          label: "LookupTool select:TodoWrite",
          output: "Matched tools: TodoWrite",
          toolArgs: { query: "select:TodoWrite" },
          toolName: "LookupTool",
        }),
      ],
    });

    fireEvent.click(
      screen.getByRole("button", { name: /Ran tool: LookupTool/u }),
    );

    const text = view.container.textContent ?? "";
    expect(text).toContain("Tool: LookupTool");
    expect(text).toContain("Arguments");
    expect(text).toContain('"query": "select:TodoWrite"');
    expect(text).toContain("Output");
    expect(text).toContain("Matched tools: TodoWrite");
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

  it("renders error command bundles with neutral status metadata", () => {
    renderTimelineRows({
      timelineRows: [
        commandRow({
          id: "command-error-1",
          command: "pnpm test",
          status: "error",
        }),
        commandRow({
          id: "command-error-2",
          command: "pnpm lint",
          status: "error",
          sourceSeqStart: 2,
        }),
      ],
    });

    const summaryButton = screen.getByRole("button", {
      name: /Ran 2 commands \(2 errors\)/u,
    });

    fireEvent.click(summaryButton);

    const button = screen.getByRole("button", {
      name: /Ran\s+pnpm test\s+\(2s, error\)/u,
    });
    expect(button).toBeTruthy();
  });

  it("renders failed structured tools with intent titles inside an exploration bundle", () => {
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

    const button = screen.getByRole("button", {
      name: /Read\s+app\.ts/u,
    });
    expect(button.textContent ?? "").not.toContain("Ran tool ");

    fireEvent.click(button);

    expect(view.container.textContent ?? "").toContain(
      "ENOENT: no such file or directory",
    );
  });

  it("does not auto-expand error command leaves", () => {
    const view = renderTimelineRows({
      timelineRows: [
        commandRow({
          id: "command-error-1",
          command: "pnpm test",
          output: "test failure",
          status: "error",
        }),
      ],
    });

    const commandButton = screen.getByRole("button", {
      name: /Ran\s+pnpm test/u,
    });
    expect(commandButton.getAttribute("aria-expanded")).toBe("false");
    expect(view.container.textContent ?? "").not.toContain("test failure");
  });

  it("auto-expands pending single work rows in an active turn", () => {
    const view = renderTimelineRows({
      timelineRows: [
        commandRow({
          id: "command-pending-1",
          command: "pnpm test",
          output: "still running",
          status: "pending",
        }),
      ],
      overrides: {
        threadRuntimeDisplayStatus: "active",
      },
    });

    const commandButton = screen.getByRole("button", {
      name: /Running\s+pnpm test\s+2s/u,
    });
    expect(commandButton.getAttribute("aria-expanded")).toBe("true");
    expect(view.container.textContent ?? "").toContain("still running");
  });

  it("default-expands completed rows when requested by the caller", () => {
    const view = renderTimelineRows({
      timelineRows: [
        commandRow({
          id: "command-completed-default-expanded",
          command: "pnpm test",
          output: "completed output",
        }),
      ],
      overrides: {
        defaultExpandAllRows: true,
      },
    });

    const commandButton = screen.getByRole("button", {
      name: /Ran\s+pnpm test/u,
    });
    expect(commandButton.getAttribute("aria-expanded")).toBe("true");
    expect(view.container.textContent ?? "").toContain("completed output");
  });

  it("auto-expands pending work summarized by an active bundle", () => {
    const view = renderTimelineRows({
      timelineRows: [
        commandRow({
          id: "command-pending-1",
          command: "pnpm test",
          output: "first output",
          sourceSeqStart: 1,
          status: "pending",
        }),
        commandRow({
          id: "command-pending-2",
          command: "pnpm lint",
          output: "second output",
          sourceSeqStart: 2,
          status: "pending",
        }),
      ],
      overrides: {
        threadRuntimeDisplayStatus: "active",
      },
    });

    const bundleButton = screen.getByRole("button", {
      name: /Running 2 commands/u,
    });
    expect(bundleButton.getAttribute("aria-expanded")).toBe("true");

    const commandButton = screen.getByRole("button", {
      name: /Running\s+pnpm test/u,
    });
    expect(commandButton.getAttribute("aria-expanded")).toBe("true");
    expect(view.container.textContent ?? "").toContain("first output");
    expect(view.container.textContent ?? "").toContain("second output");
  });

  it("auto-expands pending summaries when a pending steer is the trailing row", () => {
    const view = renderTimelineRows({
      timelineRows: [
        commandRow({
          id: "command-pending-1",
          command: "pnpm test",
          output: "first output",
          sourceSeqStart: 1,
          status: "pending",
        }),
        commandRow({
          id: "command-pending-2",
          command: "pnpm lint",
          output: "second output",
          sourceSeqStart: 2,
          status: "pending",
        }),
        conversationRow({
          id: "pending-steer-1",
          role: "user",
          text: "Keep this in mind",
          userRequest: { kind: "steer", status: "pending" },
        }),
      ],
      overrides: {
        threadRuntimeDisplayStatus: "active",
      },
    });

    const bundleButton = screen.getByRole("button", {
      name: /Running 2 commands/u,
    });
    expect(bundleButton.getAttribute("aria-expanded")).toBe("true");
    expect(view.container.textContent ?? "").toContain("first output");
    expect(view.container.textContent ?? "").toContain("second output");
    expect(screen.getByText("steer pending")).toBeTruthy();
  });

  it("auto-expands a mixed-status command bundle to show pending output", () => {
    // Same-concept consecutive work groups into a single bundle regardless of
    // child status; pending children in the bundle keep it auto-expanded so
    // active output stays visible.
    const view = renderTimelineRows({
      timelineRows: [
        commandRow({
          id: "command-pending-1",
          command: "pnpm test",
          output: "first still running",
          sourceSeqStart: 1,
          status: "pending",
        }),
        commandRow({
          id: "command-pending-2",
          command: "pnpm lint",
          output: "second still running",
          sourceSeqStart: 2,
          status: "pending",
        }),
        commandRow({
          id: "command-completed-1",
          command: "date",
          output: "today",
          sourceSeqStart: 3,
          status: "completed",
        }),
        commandRow({
          id: "command-completed-2",
          command: "pwd",
          output: "/repo",
          sourceSeqStart: 4,
          status: "completed",
        }),
      ],
      overrides: {
        threadRuntimeDisplayStatus: "active",
      },
    });

    const bundleButton = screen.getByRole("button", {
      name: /Running 4 commands/u,
    });
    expect(bundleButton.getAttribute("aria-expanded")).toBe("true");
    expect(view.container.textContent ?? "").toContain("first still running");
    expect(view.container.textContent ?? "").toContain("second still running");
  });

  it("omits command cwd metadata and mutes exit code detail", () => {
    const view = renderTimelineRows({
      timelineRows: [
        {
          ...commandRow({
            id: "command-detail-1",
            command: "pwd",
          }),
          cwd: "/repo",
          output: "done",
        },
      ],
    });

    fireEvent.click(screen.getByRole("button", { name: /Ran\s+pwd/u }));

    expect(view.container.textContent ?? "").not.toContain("cwd:");
    expect(view.container.textContent ?? "").toContain("exit code 0");
  });

  it("renders ANSI command output without leaking escape codes", () => {
    const view = renderTimelineRows({
      timelineRows: [
        commandRow({
          id: "command-ansi-1",
          command: "printf color",
          output: "\u001b[31mred\u001b[0m",
        }),
      ],
    });

    fireEvent.click(
      screen.getByRole("button", { name: /Ran\s+printf color/u }),
    );

    expect(view.container.textContent ?? "").toContain("red");
    expect(view.container.textContent ?? "").not.toContain("\u001b");
  });

  it("hides file diff detail until the row is expanded", () => {
    const view = renderTimelineRows({
      timelineRows: [fileChangeRow()],
    });

    expect(view.container.textContent ?? "").toContain("Edited");
    expect(
      view.container.querySelector("[data-timeline-file-diff]"),
    ).toBeNull();

    fireEvent.click(
      screen.getByRole("button", { name: /Edited\s+app\.ts/u }),
    );

    expect(
      view.container.querySelector("[data-timeline-file-diff]"),
    ).not.toBeNull();
    expect(view.container.textContent ?? "").not.toContain("applied");
  });

  it("style contract: mutes completed single file change title diff stats", () => {
    const html = renderRowsToStaticMarkup({
      timelineRows: [fileChangeRow()],
    });

    expect(html).toContain("+1");
    expect(html).toContain("-1");
    expect(html).not.toContain("text-diff-added");
    expect(html).not.toContain("text-diff-removed");
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

    fireEvent.click(
      screen.getByRole("button", { name: /Edited\s+app\.ts/u }),
    );

    expect(view.container.textContent ?? "").not.toContain(
      "Success. Updated the following files:",
    );
    expect(view.container.textContent ?? "").toContain("patch failed");
  });

  it("renders raw created-file diffs with the same diff viewer", () => {
    const view = renderTimelineRows({
      timelineRows: [
        fileChangeRow({
          id: "created-file-change-1",
          kind: "add",
          path: "src/new-file.ts",
          diff: "first line\nsecond line\n",
          diffStats: {
            added: 2,
            removed: 0,
          },
        }),
      ],
    });

    expect(
      screen.getByRole("button", {
        name: /Created\s+new-file\.ts\s+\+2/u,
      }),
    ).toBeTruthy();

    fireEvent.click(
      screen.getByRole("button", {
        name: /Created\s+new-file\.ts\s+\+2/u,
      }),
    );

    expect(
      view.container.querySelector("[data-timeline-file-diff]"),
    ).not.toBeNull();
    expect(view.container.textContent ?? "").not.toContain("No diff available");
  });

  it("renders assistant conversation rows without a role label", () => {
    const html = renderRowsToStaticMarkup({
      timelineRows: [conversationRow({ text: "Done." })],
    });

    expect(html).not.toContain("Assistant");
    expect(html).toContain("Done.");
  });

  it("style contract: renders user conversation rows as a right-aligned message bubble", () => {
    const html = renderRowsToStaticMarkup({
      timelineRows: [
        conversationRow({ role: "user", text: "Please patch this." }),
      ],
    });

    expect(html).not.toContain("User");
    expect(html).toContain("group mt-2 w-full");
    expect(html).toContain("ml-auto w-fit max-w-[80%]");
    expect(html).toContain("bg-primary/10");
    expect(html).toContain("Please patch this.");
  });

  it("renders accepted steer metadata below the user message bubble", () => {
    renderTimelineRows({
      timelineRows: [
        conversationRow({
          role: "user",
          text: "Use the existing renderer.",
          userRequest: { kind: "steer", status: "accepted" },
        }),
      ],
    });

    expect(screen.getByText("Use the existing renderer.")).toBeTruthy();
    expect(screen.getByText("steer")).toBeTruthy();
  });

  it("renders pending steer metadata below the user message bubble", () => {
    renderTimelineRows({
      timelineRows: [
        conversationRow({
          role: "user",
          text: "Still apply this steer.",
          userRequest: { kind: "steer", status: "pending" },
        }),
      ],
    });

    expect(screen.getByText("Still apply this steer.")).toBeTruthy();
    expect(screen.getByText("steer pending")).toBeTruthy();
  });

  it("style contract: puts top spacing on user messages instead of every timeline row", () => {
    const html = renderRowsToStaticMarkup({
      timelineRows: [
        conversationRow({ id: "assistant-1", text: "Before." }),
        conversationRow({
          id: "user-1",
          role: "user",
          text: "Please patch this.",
        }),
      ],
    });

    expect(html).not.toContain('class="pt-1"');
    expect(html).toContain("group mt-2 w-full");
  });

  it("renders assistant markdown with the custom timeline markdown styling", () => {
    const html = renderRowsToStaticMarkup({
      timelineRows: [
        conversationRow({
          text: [
            "Here is code:",
            "",
            "```ts",
            "const value = 1;",
            "const next = value + 1;",
            "```",
          ].join("\n"),
        }),
      ],
    });

    expect(html).not.toContain("Assistant");
    expect(html).toContain("Copy code");
    expect(html).toContain("border border-border/70 bg-muted/35");
    expect(html).toContain("language-ts");
  });

  it("keeps nested lazy-loaded bundles expandable", () => {
    const view = renderTimelineRows({
      timelineRows: [turnRow()],
      overrides: {
        turnSummaryRowsById: {
          "turn-summary-1": [
            commandRow({
              id: "command-1",
              command: "echo one",
              sourceSeqStart: 11,
            }),
            commandRow({
              id: "command-2",
              command: "echo two",
              sourceSeqStart: 12,
            }),
          ],
        },
      },
    });

    fireEvent.click(screen.getByRole("button", { name: /Worked for\s*4s/u }));

    const bundleButton = screen.getByRole("button", {
      name: /Ran 2 commands/u,
    });
    expect(bundleButton.getAttribute("aria-expanded")).toBe("false");
    expect(view.container.textContent ?? "").not.toContain("echo one");

    fireEvent.click(bundleButton);

    expect(bundleButton.getAttribute("aria-expanded")).toBe("true");
    expect(view.container.textContent ?? "").toContain("echo one");
    expect(view.container.textContent ?? "").toContain("echo two");
  });

  it("does not auto-expand lazy turn children when the runtime scope is idle", () => {
    const view = renderTimelineRows({
      timelineRows: [
        {
          ...turnRow(),
          status: "pending",
        },
      ],
      overrides: {
        turnSummaryRowsById: {
          "turn-summary-1": [
            commandRow({
              id: "nested-pending-command-1",
              command: "pnpm test",
              output: "still running",
              sourceSeqStart: 11,
              status: "pending",
            }),
          ],
        },
      },
    });

    fireEvent.click(screen.getByRole("button", { name: /Working for\s*4s/u }));

    const nestedCommandButton = screen.getByRole("button", {
      name: /Running\s+pnpm test/u,
    });
    expect(nestedCommandButton.getAttribute("aria-expanded")).toBe("false");
    expect(view.container.textContent ?? "").not.toContain("still running");
  });

  it("renders system rows with detail as expandable", () => {
    withElementScrollMetrics(() => {
      const view = renderTimelineRows({
        timelineRows: [systemRow()],
      });

      const systemButton = screen.getByRole("button", {
        name: /Provisioned thread/u,
      });
      expect(systemButton.getAttribute("aria-expanded")).toBe("false");
      expect(view.container.textContent ?? "").not.toContain("Running setup");

      fireEvent.click(systemButton);

      expect(systemButton.getAttribute("aria-expanded")).toBe("true");
      expect(view.container.textContent ?? "").toContain("Running setup");
      const detail = view.container.querySelector("pre");
      expect(detail?.className).toContain("whitespace-pre");
      expect(detail?.className).not.toContain("whitespace-pre-wrap");
      expect(detail?.scrollTop).toBe(900);
    });
  });

  it("uses destructive detail tone for failed system operations", () => {
    const failedOperationRow = {
      ...systemRow({ detail: "Release command failed" }),
      title: "Thread release failed",
      status: "error",
    } satisfies TimelineSystemRow;
    const view = renderTimelineRows({
      timelineRows: [failedOperationRow],
    });

    fireEvent.click(
      screen.getByRole("button", { name: /Thread release failed/u }),
    );

    const detail = view.container.querySelector("pre");
    expect(detail?.textContent).toBe("Release command failed");
    expect(detail?.className).toContain("text-destructive");
  });

  it("keeps expanded system details pinned unless the user scrolls up", () => {
    withElementScrollMetrics(() => {
      const view = renderTimelineRows({
        timelineRows: [systemRow({ detail: "first\nsecond" })],
      });

      fireEvent.click(
        screen.getByRole("button", { name: /Provisioned thread/u }),
      );
      const detail = view.container.querySelector("pre");
      expect(detail?.scrollTop).toBe(900);

      if (!detail) {
        throw new Error("Expected system detail to render");
      }

      detail.scrollTop = 500;
      fireEvent.scroll(detail);
      rerenderTimelineRows({
        view,
        timelineRows: [systemRow({ detail: "first\nsecond\nthird" })],
      });
      expect(detail.scrollTop).toBe(900);

      detail.scrollTop = 500;
      fireEvent.wheel(detail);
      fireEvent.scroll(detail);
      rerenderTimelineRows({
        view,
        timelineRows: [systemRow({ detail: "first\nsecond\nthird\nfourth" })],
      });
      expect(detail.scrollTop).toBe(500);
    });
  });

  it("routes markdown local file links through the timeline handler", () => {
    const onOpenLocalFileLink = vi.fn<ThreadTimelineLocalFileLinkHandler>(
      () => true,
    );

    renderTimelineRows({
      timelineRows: [
        conversationRow({
          text: "[Open file](/workspace/src/app.ts:7)",
        }),
      ],
      overrides: {
        onOpenLocalFileLink,
      },
    });

    fireEvent.click(screen.getByRole("link", { name: "Open file" }));

    expect(onOpenLocalFileLink).toHaveBeenCalledWith({
      lineNumber: 7,
      path: "/workspace/src/app.ts",
    });
  });

  it("renders user attachments and routes file attachment clicks", () => {
    const onOpenLocalFileLink = vi.fn<ThreadTimelineLocalFileLinkHandler>(
      () => true,
    );
    const resolveUserAttachmentImageSrc: UserAttachmentImageSrcResolver = (
      path,
      projectId,
    ) => `/attachments/${projectId}${path}`;

    renderTimelineRows({
      timelineRows: [
        conversationRow({
          role: "user",
          text: "Attached.",
          attachments: {
            webImages: 0,
            localImages: 1,
            localFiles: 1,
            imageUrls: [],
            localImagePaths: ["/workspace/shot.png"],
            localFilePaths: ["/workspace/notes.md"],
          },
        }),
      ],
      overrides: {
        onOpenLocalFileLink,
        projectId: "project-1",
        resolveUserAttachmentImageSrc,
      },
    });

    const image = screen.getByRole("img", { name: "shot.png" });
    expect(image.getAttribute("src")).toBe(
      "/attachments/project-1/workspace/shot.png",
    );

    fireEvent.click(screen.getByRole("button", { name: "notes.md" }));

    expect(onOpenLocalFileLink).toHaveBeenCalledWith({
      lineNumber: null,
      path: "/workspace/notes.md",
    });
  });
});
