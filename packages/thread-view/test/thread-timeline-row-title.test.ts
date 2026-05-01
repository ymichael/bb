import { describe, expect, it } from "vitest";
import type {
  TimelineMessageRow,
  TimelineRow,
  TimelineToolBundleRow,
  TimelineTurnSummaryRow,
  ViewCommandMessage,
  ViewDelegationMessage,
  ViewToolCallMessage,
  ViewWebSearchMessage,
  ViewProjection,
} from "@bb/domain";
import { threadScope } from "@bb/domain";
import {
  getThreadTimelineRowTitle,
  type ThreadTimelineRichTitle,
  type ThreadTimelineTitleContext,
} from "../src/thread-timeline-row-title.js";

type DelegationStatus = ViewDelegationMessage["status"];
type WebSearchStatus = ViewWebSearchMessage["status"];
type CommandStatus = ViewCommandMessage["status"];
type ToolCallStatus = ViewToolCallMessage["status"];

interface CommandRowArgs {
  approvalStatus?: ViewCommandMessage["approvalStatus"];
  status: CommandStatus;
}

const titleContext: ThreadTimelineTitleContext = {
  preferOngoingLabels: false,
};

function title(row: TimelineRow): string {
  return getThreadTimelineRowTitle(row, titleContext).plain;
}

function richTitle(row: TimelineRow): ThreadTimelineRichTitle {
  return getThreadTimelineRowTitle(row, titleContext).rich;
}

function titleWithOngoingPreference(row: TimelineRow): string {
  return getThreadTimelineRowTitle(row, {
    preferOngoingLabels: true,
  }).plain;
}

function emptyProjection(): ViewProjection {
  return {
    entries: [],
    state: {
      activeThinking: null,
    },
  };
}

function delegationRow(status: DelegationStatus): TimelineMessageRow {
  const message: ViewDelegationMessage = {
    kind: "delegation",
    id: "delegation-1",
    threadId: "thread-1",
    sourceSeqStart: 1,
    sourceSeqEnd: 1,
    createdAt: 1,
    scope: threadScope(),
    toolName: "Agent",
    callId: "agent-1",
    status,
    subagentType: "Explore",
    description: "Inspect the docs tree",
    output: "",
    durationMs: null,
    childProjection: emptyProjection(),
  };
  return {
    kind: "message",
    id: message.id,
    message,
  };
}

function webSearchRow(status: WebSearchStatus): TimelineMessageRow {
  const message: ViewWebSearchMessage = {
    kind: "web-search",
    id: "web-search-1",
    threadId: "thread-1",
    sourceSeqStart: 1,
    sourceSeqEnd: 1,
    createdAt: 1,
    scope: threadScope(),
    callId: "web-call-1",
    queries: ["react suspense"],
    resultText: null,
    status,
  };
  return {
    kind: "message",
    id: message.id,
    message,
  };
}

function commandRow(args: CommandRowArgs): TimelineMessageRow {
  const message: ViewCommandMessage = {
    kind: "command",
    id: "command-1",
    threadId: "thread-1",
    sourceSeqStart: 1,
    sourceSeqEnd: 1,
    createdAt: 1,
    scope: threadScope(),
    callId: "call-1",
    command: "echo hello",
    cwd: null,
    parsedIntents: [],
    source: null,
    output: "",
    exitCode: null,
    durationMs: null,
    approvalStatus: args.approvalStatus ?? null,
    status: args.status,
  };
  return {
    kind: "message",
    id: message.id,
    message,
  };
}

function toolCallRow(status: ToolCallStatus): TimelineMessageRow {
  const message: ViewToolCallMessage = {
    kind: "tool-call",
    id: "tool-call-1",
    threadId: "thread-1",
    sourceSeqStart: 1,
    sourceSeqEnd: 1,
    createdAt: 1,
    scope: threadScope(),
    toolName: "Bash",
    toolArgs: { command: "echo hello" },
    callId: "call-1",
    parsedIntents: [],
    output: "",
    durationMs: null,
    approvalStatus: null,
    status,
  };
  return {
    kind: "message",
    id: message.id,
    message,
  };
}

describe("getThreadTimelineRowTitle", () => {
  it("keeps CLI-compatible plain text and rich execution titles", () => {
    const row = commandRow({ status: "pending" });

    expect(title(row)).toBe("Tool Call: exec_command");
    expect(richTitle(row)).toEqual({
      kind: "prefixed",
      prefix: "Running",
      content: "echo hello",
      metadata: null,
    });
  });

  it("uses approval state for rich execution title prefixes", () => {
    const row = commandRow({
      approvalStatus: "waiting_for_approval",
      status: "pending",
    });

    expect(richTitle(row)).toEqual({
      kind: "prefixed",
      prefix: "Waiting for approval to run",
      content: "echo hello",
      metadata: null,
    });
  });

  it("formats generic tool-call content from tool args", () => {
    const row = toolCallRow("completed");

    expect(title(row)).toBe("Tool Call: Bash");
    expect(richTitle(row)).toEqual({
      kind: "prefixed",
      prefix: "Completed",
      content: "echo hello",
      metadata: null,
    });
  });

  it("formats command bundle titles and active-label preference", () => {
    const row: TimelineToolBundleRow = {
      kind: "tool-bundle",
      bundleKind: "commands",
      id: "bundle-1",
      presentation: "default",
      turnId: "turn-1",
      sourceSeqStart: 1,
      sourceSeqEnd: 2,
      startedAt: 10,
      createdAt: 20,
      status: "completed",
      summary: {
        kind: "commands",
        commands: 2,
      },
      rows: [],
    };

    expect(title(row)).toBe("Ran 2 commands");
    expect(richTitle(row)).toEqual({
      kind: "prefixed",
      prefix: "Ran",
      content: "2 commands",
      metadata: null,
    });
    expect(titleWithOngoingPreference(row)).toBe("Running 2 commands");
  });

  it("formats turn summary titles with duration", () => {
    const row: TimelineTurnSummaryRow = {
      kind: "turn-summary",
      id: "turn-summary-1",
      turnId: "turn-1",
      summaryCount: 22,
      sourceSeqStart: 1,
      sourceSeqEnd: 22,
      startedAt: 1,
      createdAt: 128_001,
      durationMs: 128_000,
      status: "completed",
      rows: null,
    };

    expect(title(row)).toBe("Worked for 2m 8s");
    expect(titleWithOngoingPreference(row)).toBe("Working for 2m 8s");
  });

  it("formats delegation row titles from structured metadata", () => {
    const row = delegationRow("completed");

    expect(title(row)).toBe("Ran subagent: Inspect the docs tree (Explore)");
    expect(richTitle(row)).toEqual({
      kind: "prefixed",
      prefix: "Ran subagent:",
      content: "Inspect the docs tree",
      metadata: "Explore",
    });
  });

  it("uses the row status for standalone delegation titles", () => {
    const row = delegationRow("completed");

    expect(titleWithOngoingPreference(row)).toBe(
      "Ran subagent: Inspect the docs tree (Explore)",
    );
  });

  it("keeps CLI-compatible plain text and status-rich text for web rows", () => {
    const row = webSearchRow("pending");

    expect(title(row)).toBe("Searched react suspense");
    expect(richTitle(row)).toEqual({
      kind: "prefixed",
      prefix: "Searching",
      content: "react suspense",
      metadata: null,
    });
  });
});
