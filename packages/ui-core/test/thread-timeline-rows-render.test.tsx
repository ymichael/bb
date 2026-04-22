import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import type {
  TimelineAssistantStepSummaryRow,
  TimelineMessageRow,
  TimelineToolBundleRow,
  TimelineTurnSummaryRow,
  ViewAssistantTextMessage,
  ViewToolCallMessage,
  ViewToolExploringMessage,
  ViewUserMessage,
} from "@bb/domain";
import { ThreadTimelineRows } from "../src/thread-timeline/ThreadTimelineRows.js";

const MULTILINE_USER_MESSAGE = `I think we should change the EnvironmentWorkspaceDisplayKind type, the icons and labels to be:

export function resolveEnvironmentWorkspaceDisplayKind({
  environment,
  hostType,
}): EnvironmentWorkspaceDisplayKind {
  if (hostType === "ephemeral") {
    return "sandbox";
  }
  if (provisioningType === "managed-worktree") {
    return "managed-worktree"
  }
  if (environment.isWorktree === true) {
    return "unmanaged-worktree";
  }
  return "other";
}

Icons:

sandbox              -> Container`;

function buildToolGroupRow(): TimelineTurnSummaryRow {
  return {
    kind: "turn-summary",
    id: "group-1",
    turnId: "turn-1",
    summaryCount: 3,
    sourceSeqStart: 1,
    sourceSeqEnd: 3,
    startedAt: 1,
    createdAt: 1,
    durationMs: 128_000,
    status: "error",
    rows: null,
  };
}

function buildUserMessageRow(): TimelineMessageRow {
  const message: ViewUserMessage = {
    kind: "user",
    id: "message-1",
    threadId: "thread-1",
    sourceSeqStart: 1,
    sourceSeqEnd: 1,
    createdAt: 1,
    text: MULTILINE_USER_MESSAGE,
  };

  return {
    kind: "message",
    id: "row-1",
    message,
  };
}

function buildAssistantMessageRow(
  id: string,
  sourceSeq: number,
): TimelineMessageRow {
  const message: ViewAssistantTextMessage = {
    kind: "assistant-text",
    id,
    threadId: "thread-1",
    turnId: "turn-1",
    sourceSeqStart: sourceSeq,
    sourceSeqEnd: sourceSeq,
    createdAt: sourceSeq,
    status: "completed",
    text: "Working",
  };

  return {
    kind: "message",
    id: `row-${id}`,
    message,
  };
}

function buildExplorationBundleRow(
  status: ViewToolExploringMessage["status"] = "pending",
): TimelineToolBundleRow {
  const message: ViewToolExploringMessage = {
    kind: "tool-exploring",
    id: "explore-1",
    threadId: "thread-1",
    turnId: "turn-1",
    sourceSeqStart: 1,
    sourceSeqEnd: 1,
    createdAt: 1,
    status,
    calls: [
      {
        callId: "search-1",
        command: "Grep 'eyeDropper' in packages/excalidraw",
        parsedCmd: [
          {
            type: "search",
            cmd: "Grep 'eyeDropper' in packages/excalidraw",
            query: "eyeDropper",
            path: "packages/excalidraw",
          },
        ],
        status,
      },
    ],
  };

  return {
    kind: "tool-bundle",
    id: "bundle-1",
    bundleKind: "exploration",
    presentation: "default",
    turnId: "turn-1",
    sourceSeqStart: 1,
    sourceSeqEnd: 1,
    startedAt: 1,
    createdAt: 1,
    status,
    summary: {
      kind: "exploration",
      filesRead: 0,
      searches: 1,
      lists: 0,
    },
    rows: [
      {
        kind: "message",
        id: "message-explore-1",
        message,
      },
    ],
  };
}

function buildCommandBundleRow(
  status: ViewToolCallMessage["status"] = "completed",
): TimelineToolBundleRow {
  const message: ViewToolCallMessage = {
    kind: "tool-call",
    id: "command-1",
    threadId: "thread-1",
    turnId: "turn-1",
    sourceSeqStart: 2,
    sourceSeqEnd: 2,
    createdAt: 2,
    toolName: "exec_command",
    callId: "command-1",
    command: "ls",
    status,
  };

  return {
    kind: "tool-bundle",
    id: "bundle-command-1",
    bundleKind: "commands",
    presentation: "default",
    turnId: "turn-1",
    sourceSeqStart: 2,
    sourceSeqEnd: 2,
    startedAt: 2,
    createdAt: 2,
    status,
    summary: {
      kind: "commands",
      commands: 1,
    },
    rows: [
      {
        kind: "message",
        id: "message-command-1",
        message,
      },
    ],
  };
}

function buildPendingCommandBundleRow(
  id: string,
  sourceSeq: number,
): TimelineToolBundleRow {
  const message: ViewToolCallMessage = {
    kind: "tool-call",
    id,
    threadId: "thread-1",
    turnId: "turn-1",
    sourceSeqStart: sourceSeq,
    sourceSeqEnd: sourceSeq,
    createdAt: sourceSeq,
    toolName: "exec_command",
    callId: id,
    command: `command-${sourceSeq}`,
    status: "pending",
  };

  return {
    kind: "tool-bundle",
    id: `bundle-${id}`,
    bundleKind: "commands",
    presentation: "default",
    turnId: "turn-1",
    sourceSeqStart: sourceSeq,
    sourceSeqEnd: sourceSeq,
    startedAt: sourceSeq,
    createdAt: sourceSeq,
    status: "pending",
    summary: {
      kind: "commands",
      commands: 1,
    },
    rows: [
      {
        kind: "message",
        id: `message-${id}`,
        message,
      },
    ],
  };
}

function buildAssistantStepSummaryRow(
  status: TimelineAssistantStepSummaryRow["status"] = "completed",
): TimelineAssistantStepSummaryRow {
  return {
    kind: "assistant-step-summary",
    id: "assistant-step-1",
    turnId: "turn-1",
    sourceSeqStart: 1,
    sourceSeqEnd: 2,
    startedAt: 1,
    createdAt: 1,
    status,
    rows: [
      buildExplorationBundleRow(status === "pending" ? "pending" : "completed"),
      buildCommandBundleRow(status),
    ],
  };
}

describe("ThreadTimelineRows rendering", () => {
  it("keeps grouped work summaries neutral even when a child call failed", () => {
    const html = renderToStaticMarkup(
      <ThreadTimelineRows
        latestActivityRowId={null}
        loadingTurnSummaryIds={new Set()}
        onLoadTurnSummaryRows={() => {}}
        threadDetailRows={[buildToolGroupRow()]}
        threadStatus="completed"
        turnSummaryRowsById={{}}
      />,
    );

    expect(html).toContain("Worked for");
    expect(html).not.toContain("text-destructive");
  });

  it("shows the message expansion toggle for short messages with many explicit lines", () => {
    const html = renderToStaticMarkup(
      <ThreadTimelineRows
        latestActivityRowId={null}
        loadingTurnSummaryIds={new Set()}
        onLoadTurnSummaryRows={() => {}}
        threadDetailRows={[buildUserMessageRow()]}
        threadStatus="completed"
        turnSummaryRowsById={{}}
      />,
    );

    expect(MULTILINE_USER_MESSAGE.length).toBeLessThan(800);
    expect(html).toContain("line-clamp-[15]");
    expect(html).toContain("Show more");
  });

  it("renders exploration bundle details without a repeated nested exploration header", () => {
    const html = renderToStaticMarkup(
      <ThreadTimelineRows
        latestActivityRowId={null}
        loadingTurnSummaryIds={new Set()}
        onLoadTurnSummaryRows={() => {}}
        threadDetailRows={[buildExplorationBundleRow()]}
        threadStatus="active"
        turnSummaryRowsById={{}}
      />,
    );

    expect(html.match(/Exploring 1 search/g)).toHaveLength(1);
    expect(html).toContain(
      'class="truncate text-foreground/95 font-semibold animate-shine">Exploring 1 search</span>',
    );
    expect(html).toContain("Search eyeDropper in packages/excalidraw");
  });

  it("renders assistant-step-summary titles without emphasis while keeping nested bundles emphasized", () => {
    const html = renderToStaticMarkup(
      <ThreadTimelineRows
        latestActivityRowId={null}
        loadingTurnSummaryIds={new Set()}
        onLoadTurnSummaryRows={() => {}}
        threadDetailRows={[buildAssistantStepSummaryRow()]}
        threadStatus="active"
        turnSummaryRowsById={{}}
      />,
    );

    expect(html).toContain(
      'class="truncate text-foreground/95">Explored 1 search, ran 1 command</span>',
    );
    expect(html).toContain(
      'class="truncate text-foreground/95 font-semibold">Ran 1 command</span>',
    );
  });

  it("keeps pending assistant-step-summary titles neutral and non-shimmering", () => {
    const html = renderToStaticMarkup(
      <ThreadTimelineRows
        latestActivityRowId={null}
        loadingTurnSummaryIds={new Set()}
        onLoadTurnSummaryRows={() => {}}
        threadDetailRows={[buildAssistantStepSummaryRow("pending")]}
        threadStatus="active"
        turnSummaryRowsById={{}}
      />,
    );

    expect(html).toContain(
      'class="truncate text-foreground/95">Explored 1 search, ran 1 command</span>',
    );
    expect(html).not.toContain(
      'class="truncate text-foreground/95 animate-shine">Explored 1 search, ran 1 command</span>',
    );
  });

  it("renders a single-bundle assistant-step placeholder without emphasis", () => {
    const html = renderToStaticMarkup(
      <ThreadTimelineRows
        latestActivityRowId={null}
        loadingTurnSummaryIds={new Set()}
        onLoadTurnSummaryRows={() => {}}
        threadDetailRows={[
          buildAssistantMessageRow("assistant-1", 1),
          {
            ...buildExplorationBundleRow("completed"),
            presentation: "assistant-step-summary-placeholder",
          },
          buildAssistantMessageRow("assistant-2", 3),
        ]}
        threadStatus="active"
        turnSummaryRowsById={{}}
      />,
    );

    expect(html).toContain(
      'class="truncate text-foreground/95">Explored 1 search</span>',
    );
    expect(html).not.toContain(
      'class="truncate text-foreground/95 font-semibold">Explored 1 search</span>',
    );
  });

  it("keeps multiple pending command bundles expanded at the same time", () => {
    const html = renderToStaticMarkup(
      <ThreadTimelineRows
        latestActivityRowId="message-command-2"
        loadingTurnSummaryIds={new Set()}
        onLoadTurnSummaryRows={() => {}}
        threadDetailRows={[
          buildPendingCommandBundleRow("command-1", 1),
          buildPendingCommandBundleRow("command-2", 2),
        ]}
        threadStatus="active"
        turnSummaryRowsById={{}}
      />,
    );

    expect(html.match(/Running 1 command/g)).toHaveLength(2);
    expect(html.match(/grid-rows-\[1fr\] opacity-100/g)).toHaveLength(4);
  });
});
