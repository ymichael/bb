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
  webFetchRow,
  webSearchRow,
} from "@/test/fixtures/thread-timeline-rows";
import {
  ThreadTimelineRows,
  type ThreadTimelineRowsProps,
} from "@/components/thread/timeline/ThreadTimelineRows";
import type {
  ThreadTimelineLocalFileLinkHandler,
  UserAttachmentImageSrcResolver,
} from "@/components/thread/timeline/types";

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

      expect(screen.getByRole("button", { name: "Show more" })).toBeTruthy();
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

  it("does not auto-expand a displaced completed bundle in an active scope", () => {
    // Two completed bundles in an active scope: only the trailing/latest
    // bundle should auto-expand. The earlier displaced bundle stays
    // collapsed so the timeline doesn't surface stale, finished work.
    renderTimelineRows({
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
        commandRow({
          id: "explore-1",
          command: "cat src/app.ts",
          activityIntents: [readIntent({ path: "src/app.ts" })],
          sourceSeqStart: 3,
        }),
        commandRow({
          id: "explore-2",
          command: "cat src/other.ts",
          activityIntents: [readIntent({ path: "src/other.ts" })],
          sourceSeqStart: 4,
        }),
      ],
      overrides: {
        threadRuntimeDisplayStatus: "active",
      },
    });

    const ranBundleButton = screen.getByRole("button", {
      name: /Ran 2 commands/u,
    });
    expect(ranBundleButton.getAttribute("aria-expanded")).toBe("false");

    const exploringBundleButton = screen.getByRole("button", {
      name: /Exploring 2 files/u,
    });
    expect(exploringBundleButton.getAttribute("aria-expanded")).toBe("true");
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
        name: /Ran\s+rg timeline apps\/app/u,
      }),
    );

    expect(view.container.textContent ?? "").toContain("rg timeline apps/app");
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

  it("auto-expands a trailing bundle in an active scope without expanding its children", () => {
    // The single auto-expand rule: in an active container, expand the
    // literal last row if it is expandable. The bundle is the trailing
    // row, so it expands. Bundle children do not get the rule applied —
    // they render collapsed until the user clicks them.
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
    expect(commandButton.getAttribute("aria-expanded")).toBe("false");
    expect(view.container.textContent ?? "").not.toContain("first output");
    expect(view.container.textContent ?? "").not.toContain("second output");
  });

  it("looks past trailing user conversation rows when finding the frontier", () => {
    // User-role conversation rows (initial messages, follow-ups, pending
    // or accepted steers) are inputs to the agent, not events the agent
    // produced. The rule skips them when locating the frontier. Here a
    // pending steer trails the bundle; the bundle is the agent's frontier
    // and auto-expands.
    renderTimelineRows({
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
    expect(screen.getByText("steer pending")).toBeTruthy();
  });

  it("does not auto-expand anything when an assistant message is the frontier", () => {
    // Assistant-role conversation rows are events the agent produced, so
    // they do count as the frontier. They are not expandable, so when
    // they trail the timeline the rule produces no auto-expansion — even
    // if a bundle sits just before them.
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
          id: "assistant-final",
          role: "assistant",
          text: "All done.",
        }),
      ],
      overrides: {
        threadRuntimeDisplayStatus: "active",
      },
    });

    const bundleButton = screen.getByRole("button", {
      name: /Ran 2 commands/u,
    });
    expect(bundleButton.getAttribute("aria-expanded")).toBe("false");
    expect(view.container.textContent ?? "").not.toContain("first output");
    expect(view.container.textContent ?? "").not.toContain("second output");
    expect(view.container.textContent ?? "").toContain("All done.");
  });

  it("renders multi-line command titles on a single line", () => {
    // Command content can include literal newlines (heredocs, scripts
    // pasted as a single argument, etc.). The title segment renders with
    // CSS `whitespace-pre`, which would honor `\n` as a line break — so
    // titles must collapse newlines at segment construction time. Verifies
    // the rendered title text and the HTML title (used for hover tooltip
    // and CLI plain rendering) are both single-line.
    const command = "node <<'EOF'\nconst x = 1;\nconsole.log(x);\nEOF";
    renderTimelineRows({
      timelineRows: [
        commandRow({
          id: "command-multiline-1",
          command,
        }),
      ],
    });

    const button = screen.getByRole("button", { name: /Ran/u });
    expect(button.textContent ?? "").not.toContain("\n");

    // Every `[title]` descendant carries the plain-text rendering of
    // some segment span — none of them may contain a newline. Iterating
    // catches a regression even if a future change adds a sibling
    // metadata pill that also has a `title` attribute.
    const titleSpans = button.querySelectorAll("[title]");
    expect(titleSpans.length).toBeGreaterThan(0);
    for (const span of Array.from(titleSpans)) {
      expect(span.getAttribute("title") ?? "").not.toContain("\n");
    }
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

    fireEvent.click(screen.getByRole("button", { name: /Edited\s+app\.ts/u }));

    expect(
      view.container.querySelector("[data-timeline-file-diff]"),
    ).not.toBeNull();
    expect(view.container.textContent ?? "").not.toContain("applied");
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

  it("does not auto-expand a pending delegation's frontier on an idle thread", () => {
    // Strict scope propagation: the active scope must come from the
    // top-level thread runtime. A pending delegation does not magically
    // open an active scope on an idle thread — the user is browsing
    // history, not watching live work. Verifies the regression-prone
    // "single rule" promise.
    const view = renderTimelineRows({
      timelineRows: [
        delegationRow({
          id: "idle-pending-delegation",
          status: "pending",
          childRows: [
            commandRow({
              id: "nested-pending-command",
              command: "pnpm test",
              output: "still running",
              sourceSeqStart: 50,
              status: "pending",
            }),
          ],
        }),
      ],
      // threadRuntimeDisplayStatus defaults to "idle"
    });

    fireEvent.click(screen.getByRole("button", { name: /Running subagent/u }));

    const nestedCommandButton = screen.getByRole("button", {
      name: /Running\s+pnpm test/u,
    });
    expect(nestedCommandButton.getAttribute("aria-expanded")).toBe("false");
    expect(view.container.textContent ?? "").not.toContain("still running");
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

    fireEvent.click(screen.getByRole("button", { name: /Working\s*4s/u }));

    const nestedCommandButton = screen.getByRole("button", {
      name: /Running\s+pnpm test/u,
    });
    expect(nestedCommandButton.getAttribute("aria-expanded")).toBe("false");
    expect(view.container.textContent ?? "").not.toContain("still running");
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
