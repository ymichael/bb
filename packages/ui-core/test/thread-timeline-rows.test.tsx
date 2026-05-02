// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import type {
  TimelineActivityIntent,
  TimelineCommandWorkRow,
  TimelineConversationAttachments,
  TimelineConversationRow,
  TimelineDelegationWorkRow,
  TimelineFileChangeWorkRow,
  TimelineRow,
  TimelineRowBase,
  TimelineRowStatus,
  TimelineSystemRow,
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

interface FileChangeRowArgs {
  diff?: string;
  diffStats?: {
    added: number;
    removed: number;
  };
  id?: string;
  kind?: string;
  path?: string;
  stderr?: string | null;
  stdout?: string | null;
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

function searchIntent(query: string, path: string): TimelineActivityIntent {
  return {
    type: "search",
    command: `rg ${query} ${path}`,
    query,
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

function fileChangeRow({
  diff = "@@ -1 +1 @@\n-before\n+after",
  diffStats = {
    added: 1,
    removed: 1,
  },
  id = "file-change-1",
  kind = "update",
  path = "src/app.ts",
  stderr = null,
  stdout = "applied",
}: FileChangeRowArgs = {}): TimelineFileChangeWorkRow {
  return {
    ...baseRow({ id, sourceSeqStart: 1 }),
    kind: "work",
    workKind: "file-change",
    status: "completed",
    callId: id,
    change: {
      path,
      kind,
      movePath: null,
      diff,
      diffStats,
    },
    stdout,
    stderr,
    approvalStatus: null,
  };
}

function delegationRow(): TimelineDelegationWorkRow {
  return {
    ...baseRow({ id: "delegation-1", sourceSeqStart: 1 }),
    kind: "work",
    workKind: "delegation",
    status: "completed",
    callId: "delegation-1",
    toolName: "spawnAgent",
    subagentType: "general-purpose",
    description: "Review renderer",
    output: "Final subagent answer.",
    durationMs: 2_000,
    childRows: [
      commandRow({
        id: "delegation-child-command-1",
        command: "rg timeline packages/ui-core",
        sourceSeqStart: 2,
      }),
    ],
  };
}

function systemRow(): TimelineSystemRow {
  return {
    ...baseRow({ id: "system-1", sourceSeqStart: 1 }),
    kind: "system",
    systemKind: "operation",
    title: "Provisioned thread",
    detail: "Running setup\nProvisioned thread (2s)",
    status: "completed",
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

  it("renders activity summary exploration details as compact static rows", () => {
    const view = render(
      <ThreadTimelineRows
        loadingTurnSummaryIds={new Set()}
        erroredTurnSummaryIds={new Set()}
        onLoadTurnSummaryRows={() => {}}
        timelineRows={[
          commandRow({
            id: "exploration-1",
            command: "cat src/app.ts && rg TODO src",
            activityIntents: [
              readIntent("src/app.ts"),
              searchIntent("TODO", "src"),
            ],
            output: "large file contents",
          }),
        ]}
        threadRuntimeDisplayStatus="idle"
        turnSummaryRowsById={{}}
      />,
    );

    expect(screen.getAllByRole("button")).toHaveLength(1);

    fireEvent.click(screen.getByRole("button"));

    expect(
      view.container.querySelector('[aria-label="Read app.ts"]'),
    ).not.toBeNull();
    expect(view.container.textContent ?? "").not.toContain("Read src/app.ts");
    expect(
      view.container.querySelector('[aria-label="Searched for TODO in src"]'),
    ).not.toBeNull();
    expect(view.container.textContent ?? "").not.toContain("$ cat src/app.ts");
    expect(view.container.textContent ?? "").not.toContain(
      "large file contents",
    );
    expect(screen.getAllByRole("button")).toHaveLength(1);
  });

  it("renders delegation child progress and final output when both are present", () => {
    const view = render(
      <ThreadTimelineRows
        loadingTurnSummaryIds={new Set()}
        erroredTurnSummaryIds={new Set()}
        onLoadTurnSummaryRows={() => {}}
        timelineRows={[delegationRow()]}
        threadRuntimeDisplayStatus="idle"
        turnSummaryRowsById={{}}
      />,
    );

    expect(view.container.textContent ?? "").not.toContain(
      "Final subagent answer.",
    );

    fireEvent.click(screen.getByRole("button"));

    expect(view.container.textContent ?? "").toContain(
      "rg timeline packages/ui-core",
    );
    expect(view.container.textContent ?? "").toContain("Final subagent answer.");
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

  it("renders error command titles with normal command styling", () => {
    const view = render(
      <ThreadTimelineRows
        loadingTurnSummaryIds={new Set()}
        erroredTurnSummaryIds={new Set()}
        onLoadTurnSummaryRows={() => {}}
        timelineRows={[
          commandRow({
            id: "command-error-1",
            command: "pnpm test",
            status: "error",
          }),
        ]}
        threadRuntimeDisplayStatus="idle"
        turnSummaryRowsById={{}}
      />,
    );

    const button = screen.getByRole("button", {
      name: /Ran\s+pnpm test\s+2s/u,
    });
    expect(button.textContent ?? "").not.toContain("(error");
    expect(view.container.innerHTML).not.toContain("text-destructive");
  });

  it("does not auto-expand error command details", () => {
    const view = render(
      <ThreadTimelineRows
        loadingTurnSummaryIds={new Set()}
        erroredTurnSummaryIds={new Set()}
        onLoadTurnSummaryRows={() => {}}
        timelineRows={[
          commandRow({
            id: "command-error-1",
            command: "pnpm test",
            output: "test failure",
            status: "error",
          }),
        ]}
        threadRuntimeDisplayStatus="idle"
        turnSummaryRowsById={{}}
      />,
    );

    const button = screen.getByRole("button", { name: /Ran\s+pnpm test/u });
    expect(button.getAttribute("aria-expanded")).toBe("false");
    expect(view.container.textContent ?? "").not.toContain("test failure");
  });

  it("auto-expands pending direct work in an active turn", () => {
    const view = render(
      <ThreadTimelineRows
        loadingTurnSummaryIds={new Set()}
        erroredTurnSummaryIds={new Set()}
        onLoadTurnSummaryRows={() => {}}
        timelineRows={[
          commandRow({
            id: "command-pending-1",
            command: "pnpm test",
            output: "still running",
            status: "pending",
          }),
        ]}
        threadRuntimeDisplayStatus="active"
        turnSummaryRowsById={{}}
      />,
    );

    const button = screen.getByRole("button", {
      name: /Running\s+pnpm test/u,
    });
    expect(button.getAttribute("aria-expanded")).toBe("true");
    expect(view.container.textContent ?? "").toContain("still running");
  });

  it("does not auto-expand pending work already summarized by an active bundle", () => {
    const view = render(
      <ThreadTimelineRows
        loadingTurnSummaryIds={new Set()}
        erroredTurnSummaryIds={new Set()}
        onLoadTurnSummaryRows={() => {}}
        timelineRows={[
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
        ]}
        threadRuntimeDisplayStatus="active"
        turnSummaryRowsById={{}}
      />,
    );

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

  it("omits command cwd metadata and mutes exit code detail", () => {
    const view = render(
      <ThreadTimelineRows
        loadingTurnSummaryIds={new Set()}
        erroredTurnSummaryIds={new Set()}
        onLoadTurnSummaryRows={() => {}}
        timelineRows={[
          {
            ...commandRow({
              id: "command-detail-1",
              command: "pwd",
            }),
            cwd: "/repo",
            output: "done",
          },
        ]}
        threadRuntimeDisplayStatus="idle"
        turnSummaryRowsById={{}}
      />,
    );

    fireEvent.click(screen.getByRole("button"));

    expect(view.container.textContent ?? "").not.toContain("cwd:");
    expect(view.container.textContent ?? "").toContain("exit code 0");
    expect(view.container.innerHTML).toContain("text-muted-foreground");
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
    expect(view.container.textContent ?? "").not.toContain("applied");
  });

  it("renders file-change stderr without rendering stdout below diffs", () => {
    const view = render(
      <ThreadTimelineRows
        loadingTurnSummaryIds={new Set()}
        erroredTurnSummaryIds={new Set()}
        onLoadTurnSummaryRows={() => {}}
        timelineRows={[
          fileChangeRow({
            stdout: "Success. Updated the following files:\nM src/app.ts",
            stderr: "patch failed",
          }),
        ]}
        threadRuntimeDisplayStatus="idle"
        turnSummaryRowsById={{}}
      />,
    );

    fireEvent.click(screen.getByRole("button"));

    expect(view.container.textContent ?? "").not.toContain(
      "Success. Updated the following files:",
    );
    expect(view.container.textContent ?? "").toContain("patch failed");
  });

  it("renders raw created-file diffs with the same diff viewer", () => {
    const view = render(
      <ThreadTimelineRows
        loadingTurnSummaryIds={new Set()}
        erroredTurnSummaryIds={new Set()}
        onLoadTurnSummaryRows={() => {}}
        timelineRows={[
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
        ]}
        threadRuntimeDisplayStatus="idle"
        turnSummaryRowsById={{}}
      />,
    );

    expect(
      screen.getByRole("button", { name: /Created\s+new-file\.ts\s+\+2/u }),
    ).toBeTruthy();

    fireEvent.click(screen.getByRole("button"));

    expect(
      view.container.querySelector("[data-timeline-file-diff]"),
    ).not.toBeNull();
    expect(view.container.textContent ?? "").not.toContain("No diff available");
  });

  it("renders assistant conversation rows without a role label", () => {
    const html = renderRowsToStaticMarkup([conversationRow({ text: "Done." })]);

    expect(html).not.toContain("Assistant");
    expect(html).toContain("Done.");
  });

  it("renders user conversation rows as a right-aligned message bubble", () => {
    const html = renderRowsToStaticMarkup([
      conversationRow({ role: "user", text: "Please patch this." }),
    ]);

    expect(html).not.toContain("User");
    expect(html).toContain("ml-auto w-fit max-w-[80%]");
    expect(html).toContain("bg-primary/10");
    expect(html).toContain("Please patch this.");
  });

  it("preserves top-level user message spacing", () => {
    const html = renderRowsToStaticMarkup([
      conversationRow({ id: "assistant-1", text: "Before." }),
      conversationRow({
        id: "user-1",
        role: "user",
        text: "Please patch this.",
      }),
    ]);

    expect(html).toContain('class="pt-1"');
  });

  it("renders assistant markdown with the custom timeline markdown styling", () => {
    const html = renderRowsToStaticMarkup([
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
    ]);

    expect(html).not.toContain("Assistant");
    expect(html).toContain("Copy code");
    expect(html).toContain("border border-border/70 bg-muted/35");
    expect(html).toContain("language-ts");
  });

  it("keeps nested lazy-loaded bundles expandable", () => {
    const view = render(
      <ThreadTimelineRows
        loadingTurnSummaryIds={new Set()}
        erroredTurnSummaryIds={new Set()}
        onLoadTurnSummaryRows={() => {}}
        timelineRows={[turnRow()]}
        threadRuntimeDisplayStatus="idle"
        turnSummaryRowsById={{
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
        }}
      />,
    );

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

  it("renders system rows with detail as expandable", () => {
    const view = render(
      <ThreadTimelineRows
        loadingTurnSummaryIds={new Set()}
        erroredTurnSummaryIds={new Set()}
        onLoadTurnSummaryRows={() => {}}
        timelineRows={[systemRow()]}
        threadRuntimeDisplayStatus="idle"
        turnSummaryRowsById={{}}
      />,
    );

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
