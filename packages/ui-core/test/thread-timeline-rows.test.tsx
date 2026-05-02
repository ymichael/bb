// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import type {
  TimelineActivityIntent,
  TimelineCommandWorkRow,
  TimelineConversationAttachments,
  TimelineConversationRow,
  TimelineFileChangeWorkRow,
  TimelineRow,
  TimelineRowBase,
  TimelineRowStatus,
  TimelineTurnRow,
  TimelineWebFetchWorkRow,
  TimelineWebSearchWorkRow,
} from "@bb/server-contract";
import { ThreadTimelineRows } from "../src/thread-timeline/ThreadTimelineRows.js";
import type {
  ThreadTimelineLocalFileLinkHandler,
  UserAttachmentImageSrcResolver,
} from "../src/thread-timeline/types.js";

interface BaseRowArgs {
  id: string;
  sourceSeqStart: number;
}

interface CommandRowArgs {
  id: string;
  command: string;
  activityIntents?: TimelineActivityIntent[];
  output?: string;
  sourceSeqStart?: number;
  status?: TimelineRowStatus;
}

interface ConversationRowArgs {
  attachments?: TimelineConversationAttachments | null;
  id?: string;
  role?: TimelineConversationRow["role"];
  text: string;
}

function baseRow({ id, sourceSeqStart }: BaseRowArgs): TimelineRowBase {
  return {
    id,
    threadId: "thread-1",
    turnId: "turn-1",
    sourceSeqStart,
    sourceSeqEnd: sourceSeqStart,
    startedAt: sourceSeqStart,
    createdAt: sourceSeqStart,
  };
}

function conversationRow({
  attachments = null,
  id = "conversation-1",
  role = "assistant",
  text,
}: ConversationRowArgs): TimelineConversationRow {
  return {
    ...baseRow({ id, sourceSeqStart: 1 }),
    kind: "conversation",
    role,
    text,
    attachments,
  };
}

function commandRow({
  activityIntents = [],
  command,
  id,
  output = "",
  sourceSeqStart = 1,
  status = "completed",
}: CommandRowArgs): TimelineCommandWorkRow {
  return {
    ...baseRow({ id, sourceSeqStart }),
    kind: "work",
    workKind: "command",
    status,
    callId: id,
    command,
    cwd: null,
    source: null,
    output,
    exitCode: status === "completed" ? 0 : null,
    durationMs: 2_000,
    approvalStatus: null,
    activityIntents,
  };
}

function readIntent(path: string): TimelineActivityIntent {
  return {
    type: "read",
    command: `cat ${path}`,
    name: path.split("/").pop() ?? path,
    path,
  };
}

function webSearchRow(): TimelineWebSearchWorkRow {
  return {
    ...baseRow({ id: "web-search-1", sourceSeqStart: 1 }),
    kind: "work",
    workKind: "web-search",
    status: "completed",
    callId: "web-search-1",
    queries: ["timeline renderer"],
    resultText: "search result body",
  };
}

function fileChangeRow(): TimelineFileChangeWorkRow {
  return {
    ...baseRow({ id: "file-change-1", sourceSeqStart: 1 }),
    kind: "work",
    workKind: "file-change",
    status: "completed",
    callId: "file-change-1",
    change: {
      path: "src/app.ts",
      kind: "update",
      movePath: null,
      diff: "@@ -1 +1 @@\n-before\n+after",
      diffStats: {
        added: 1,
        removed: 1,
      },
    },
    stdout: "applied",
    stderr: null,
    approvalStatus: null,
  };
}

function webFetchRow(): TimelineWebFetchWorkRow {
  return {
    ...baseRow({ id: "web-fetch-1", sourceSeqStart: 2 }),
    kind: "work",
    workKind: "web-fetch",
    status: "completed",
    callId: "web-fetch-1",
    url: "https://example.com/docs",
    prompt: null,
    pattern: null,
    resultText: "fetch result body",
  };
}

function turnRow(): TimelineTurnRow {
  return {
    ...baseRow({ id: "turn-summary-1", sourceSeqStart: 10 }),
    kind: "turn",
    status: "completed",
    summaryCount: 1,
    durationMs: 4_000,
    children: null,
  };
}

function renderRowsToStaticMarkup(timelineRows: TimelineRow[]): string {
  return renderToStaticMarkup(
    <ThreadTimelineRows
      loadingTurnSummaryIds={new Set()}
      erroredTurnSummaryIds={new Set()}
      onLoadTurnSummaryRows={() => {}}
      timelineRows={timelineRows}
      threadRuntimeDisplayStatus="idle"
      turnSummaryRowsById={{}}
    />,
  );
}

afterEach(() => {
  cleanup();
});

describe("ThreadTimelineRows", () => {
  it("uses active wording for the tail activity summary in an active scope", () => {
    const html = renderToStaticMarkup(
      <ThreadTimelineRows
        loadingTurnSummaryIds={new Set()}
        erroredTurnSummaryIds={new Set()}
        onLoadTurnSummaryRows={() => {}}
        timelineRows={[
          commandRow({
            id: "read-1",
            command: "cat src/app.ts",
            activityIntents: [readIntent("src/app.ts")],
          }),
        ]}
        threadRuntimeDisplayStatus="active"
        turnSummaryRowsById={{}}
      />,
    );

    expect(html).toContain("Exploring");
    expect(html).toContain("1 file");
  });

  it("does not render web search and fetch leaves as expandable rows", () => {
    const view = render(
      <ThreadTimelineRows
        loadingTurnSummaryIds={new Set()}
        erroredTurnSummaryIds={new Set()}
        onLoadTurnSummaryRows={() => {}}
        timelineRows={[webSearchRow(), webFetchRow()]}
        threadRuntimeDisplayStatus="idle"
        turnSummaryRowsById={{}}
      />,
    );

    expect(screen.getAllByRole("button")).toHaveLength(1);
    fireEvent.click(screen.getByRole("button"));

    expect(view.container.textContent ?? "").toContain("Ran web search:");
    expect(view.container.textContent ?? "").toContain("Fetched:");
    expect(screen.getAllByRole("button")).toHaveLength(1);
  });

  it("loads lazy turn details once for one expansion", () => {
    const onLoadTurnSummaryRows = vi.fn();
    const view = render(
      <ThreadTimelineRows
        loadingTurnSummaryIds={new Set()}
        erroredTurnSummaryIds={new Set()}
        onLoadTurnSummaryRows={onLoadTurnSummaryRows}
        timelineRows={[turnRow()]}
        threadRuntimeDisplayStatus="idle"
        turnSummaryRowsById={{}}
      />,
    );

    fireEvent.click(screen.getByRole("button"));
    expect(onLoadTurnSummaryRows).toHaveBeenCalledTimes(1);

    view.rerender(
      <ThreadTimelineRows
        loadingTurnSummaryIds={new Set()}
        erroredTurnSummaryIds={new Set()}
        onLoadTurnSummaryRows={onLoadTurnSummaryRows}
        timelineRows={[turnRow()]}
        threadRuntimeDisplayStatus="idle"
        turnSummaryRowsById={{}}
      />,
    );

    expect(onLoadTurnSummaryRows).toHaveBeenCalledTimes(1);
  });

  it("hides command detail until the row is expanded", () => {
    const view = render(
      <ThreadTimelineRows
        loadingTurnSummaryIds={new Set()}
        erroredTurnSummaryIds={new Set()}
        onLoadTurnSummaryRows={() => {}}
        timelineRows={[
          commandRow({
            id: "command-1",
            command: "true",
          }),
        ]}
        threadRuntimeDisplayStatus="idle"
        turnSummaryRowsById={{}}
      />,
    );

    expect(view.container.textContent ?? "").toContain("Ran");
    expect(view.container.textContent ?? "").not.toContain("$ true");

    fireEvent.click(screen.getByRole("button"));

    expect(view.container.textContent ?? "").toContain("$ true");
    expect(view.container.textContent ?? "").toContain("exit code 0");
  });

  it("renders ANSI command output without leaking escape codes", () => {
    const view = render(
      <ThreadTimelineRows
        loadingTurnSummaryIds={new Set()}
        erroredTurnSummaryIds={new Set()}
        onLoadTurnSummaryRows={() => {}}
        timelineRows={[
          commandRow({
            id: "command-ansi-1",
            command: "printf red",
            output: "\u001b[31mred\u001b[0m",
          }),
        ]}
        threadRuntimeDisplayStatus="idle"
        turnSummaryRowsById={{}}
      />,
    );

    fireEvent.click(screen.getByRole("button"));

    expect(view.container.textContent ?? "").toContain("red");
    expect(view.container.textContent ?? "").not.toContain("\u001b");
  });

  it("hides file diff detail until the row is expanded", () => {
    const view = render(
      <ThreadTimelineRows
        loadingTurnSummaryIds={new Set()}
        erroredTurnSummaryIds={new Set()}
        onLoadTurnSummaryRows={() => {}}
        timelineRows={[fileChangeRow()]}
        threadRuntimeDisplayStatus="idle"
        turnSummaryRowsById={{}}
      />,
    );

    expect(view.container.textContent ?? "").toContain("Edited");
    expect(view.container.querySelector("[data-timeline-file-diff]")).toBeNull();

    fireEvent.click(screen.getByRole("button"));

    expect(
      view.container.querySelector("[data-timeline-file-diff]"),
    ).not.toBeNull();
    expect(view.container.textContent ?? "").toContain("applied");
  });

  it("renders plain conversation rows through the timeline path", () => {
    const html = renderRowsToStaticMarkup([conversationRow({ text: "Done." })]);

    expect(html).toContain("Assistant");
    expect(html).toContain("Done.");
  });

  it("routes markdown local file links through the timeline handler", () => {
    const onOpenLocalFileLink =
      vi.fn<ThreadTimelineLocalFileLinkHandler>(() => true);

    render(
      <ThreadTimelineRows
        loadingTurnSummaryIds={new Set()}
        erroredTurnSummaryIds={new Set()}
        onLoadTurnSummaryRows={() => {}}
        onOpenLocalFileLink={onOpenLocalFileLink}
        timelineRows={[
          conversationRow({
            text: "[Open file](/workspace/src/app.ts:7)",
          }),
        ]}
        threadRuntimeDisplayStatus="idle"
        turnSummaryRowsById={{}}
      />,
    );

    fireEvent.click(screen.getByRole("link", { name: "Open file" }));

    expect(onOpenLocalFileLink).toHaveBeenCalledWith({
      lineNumber: 7,
      path: "/workspace/src/app.ts",
    });
  });

  it("renders user attachments and routes file attachment clicks", () => {
    const onOpenLocalFileLink =
      vi.fn<ThreadTimelineLocalFileLinkHandler>(() => true);
    const resolveUserAttachmentImageSrc: UserAttachmentImageSrcResolver = (
      path,
      projectId,
    ) => `/attachments/${projectId}${path}`;

    render(
      <ThreadTimelineRows
        loadingTurnSummaryIds={new Set()}
        erroredTurnSummaryIds={new Set()}
        onLoadTurnSummaryRows={() => {}}
        onOpenLocalFileLink={onOpenLocalFileLink}
        projectId="project-1"
        resolveUserAttachmentImageSrc={resolveUserAttachmentImageSrc}
        timelineRows={[
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
        ]}
        threadRuntimeDisplayStatus="idle"
        turnSummaryRowsById={{}}
      />,
    );

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
