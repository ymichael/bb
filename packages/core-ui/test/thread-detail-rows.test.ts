import { describe, expect, it } from "vitest";
import { buildTimelineRows, type TimelineRow } from "../src/thread-detail-rows.js";
import type { ViewMessage, ViewProvisioningTranscriptEntry } from "@bb/domain";

type TimelineMessageRow = Extract<TimelineRow, { kind: "message" }>;
type TimelineToolGroupRow = Extract<TimelineRow, { kind: "tool-group" }>;
type ViewAssistantTextMessage = Extract<ViewMessage, { kind: "assistant-text" }>;
type ViewErrorMessage = Extract<ViewMessage, { kind: "error" }>;

function expectToolGroupRow(row: TimelineRow | undefined): TimelineToolGroupRow {
  expect(row?.kind).toBe("tool-group");
  if (!row || row.kind !== "tool-group") {
    throw new Error("Expected a tool-group row");
  }
  return row;
}

function expectMessageRow(row: TimelineRow | undefined): TimelineMessageRow {
  expect(row?.kind).toBe("message");
  if (!row || row.kind !== "message") {
    throw new Error("Expected a message row");
  }
  return row;
}

function expectAssistantTextMessage(
  message: ViewMessage | undefined,
): ViewAssistantTextMessage {
  expect(message?.kind).toBe("assistant-text");
  if (!message || message.kind !== "assistant-text") {
    throw new Error("Expected an assistant-text message");
  }
  return message;
}

function expectErrorMessage(message: ViewMessage | undefined): ViewErrorMessage {
  expect(message?.kind).toBe("error");
  if (!message || message.kind !== "error") {
    throw new Error("Expected an error message");
  }
  return message;
}

function provisioningOperation(
  seq: number,
  title: string,
  status: "pending" | "completed" | "error" | "interrupted",
  detail?: string,
  options?: {
    environmentId?: string;
    transcript?: ViewProvisioningTranscriptEntry[];
  },
): Extract<ViewMessage, { kind: "operation" }> {
  return {
    kind: "operation",
    id: `provisioning-${seq}`,
    threadId: "thread-1",
    sourceSeqStart: seq,
    sourceSeqEnd: seq,
    createdAt: seq,
    opType: "thread-provisioning",
    title,
    status,
    ...((options?.environmentId ||
    (options?.transcript && options.transcript.length > 0))
      ? {
          provisioning: {
            ...(options?.environmentId ? { environmentId: options.environmentId } : {}),
            ...((options?.transcript && options.transcript.length > 0) ? { transcript: options.transcript } : {}),
          },
        }
      : {}),
    ...(detail ? { detail } : {}),
  };
}

function getOperationRows(messages: ViewMessage[]): Array<Extract<ViewMessage, { kind: "operation" }>> {
  return buildTimelineRows(messages)
    .filter((row): row is Extract<TimelineRow, { kind: "message" }> =>
      row.kind === "message" && row.message.kind === "operation")
    .map((row) => row.message);
}

describe("buildTimelineRows tool group collapsing", () => {
  it("collapses earlier assistant messages before the last terminal into a tool group", () => {
    const rows = buildTimelineRows([
      {
        kind: "user",
        id: "user-1",
        threadId: "thread-1",
        sourceSeqStart: 1,
        sourceSeqEnd: 1,
        createdAt: 1,
        turnId: "turn-1",
        text: "say hi",
      },
      {
        kind: "assistant-text",
        id: "assistant-1",
        threadId: "thread-1",
        sourceSeqStart: 2,
        sourceSeqEnd: 2,
        createdAt: 2,
        turnId: "turn-1",
        text: "Hi!",
        status: "completed",
      },
      {
        kind: "assistant-text",
        id: "assistant-2",
        threadId: "thread-1",
        sourceSeqStart: 3,
        sourceSeqEnd: 3,
        createdAt: 3,
        turnId: "turn-1",
        text: "What can I help with?",
        status: "completed",
      },
    ]);

    expect(rows.map((row) => row.kind)).toEqual(["message", "tool-group", "message"]);
  });

  it("collapses delegation and tasks rows into a tool group before the final assistant text", () => {
    const rows = buildTimelineRows([
      {
        kind: "delegation",
        id: "delegation-1",
        threadId: "thread-1",
        sourceSeqStart: 1,
        sourceSeqEnd: 3,
        createdAt: 3,
        startedAt: 1,
        turnId: "turn-1",
        toolName: "Agent",
        callId: "agent-1",
        command: "Agent [Explore] Search for SearchMenu references",
        output: "Subagent report: found SearchMenu component and tests",
        status: "completed",
        children: [
          {
            kind: "tool-exploring",
            id: "child-exploring-1",
            threadId: "thread-1",
            sourceSeqStart: 2,
            sourceSeqEnd: 2,
            createdAt: 2,
            turnId: "turn-1",
            label: "Exploring",
            status: "completed",
            calls: [
              {
                callId: "exec-1",
                command: 'rg -n "SearchMenu" packages/excalidraw',
                status: "completed",
                output: "packages/excalidraw/components/SearchMenu.tsx:14",
                parsedCmd: [{ type: "search", query: "SearchMenu" }],
              },
            ],
          },
        ],
      },
      {
        kind: "tasks",
        id: "tasks-1",
        threadId: "thread-1",
        sourceSeqStart: 4,
        sourceSeqEnd: 4,
        createdAt: 4,
        turnId: "turn-1",
        source: "todo",
        title: "Tasks updated",
        status: "completed",
        tasks: [
          { text: "Inspect SearchMenu.tsx", status: "completed" },
          { text: "Add better empty state", status: "active" },
        ],
      },
      {
        kind: "assistant-text",
        id: "assistant-1",
        threadId: "thread-1",
        sourceSeqStart: 5,
        sourceSeqEnd: 5,
        createdAt: 5,
        turnId: "turn-1",
        text: "I found the relevant files and updated the task list.",
        status: "completed",
      },
    ]);

    expect(rows.map((row) => row.kind)).toEqual(["tool-group", "message"]);
    expect(rows[0]?.kind).toBe("tool-group");
    if (rows[0]?.kind === "tool-group") {
      expect(rows[0].summaryCount).toBe(2);
      expect(rows[0].status).toBe("completed");
      expect(rows[0].messages).toHaveLength(2);
      expect(rows[0].messages[0]?.kind).toBe("delegation");
      expect(rows[0].messages[1]?.kind).toBe("tasks");
    }
    expect(rows[1]?.kind).toBe("message");
    if (rows[1]?.kind === "message") {
      expect(rows[1].message.kind).toBe("assistant-text");
    }
  });

  it("keeps intermediate assistant text inside the tool group and the last assistant text standalone", () => {
    const rows = buildTimelineRows([
      {
        kind: "user",
        id: "user-1",
        threadId: "thread-1",
        sourceSeqStart: 1,
        sourceSeqEnd: 1,
        createdAt: 1,
        turnId: "turn-1",
        text: "Trace the bug",
      },
      {
        kind: "assistant-text",
        id: "assistant-1",
        threadId: "thread-1",
        sourceSeqStart: 2,
        sourceSeqEnd: 4,
        createdAt: 4,
        turnId: "turn-1",
        text: "I found the likely area.",
        status: "completed",
      },
      {
        kind: "tool-call",
        id: "tool-1",
        threadId: "thread-1",
        sourceSeqStart: 5,
        sourceSeqEnd: 6,
        createdAt: 6,
        turnId: "turn-1",
        toolName: "exec_command",
        callId: "call-1",
        command: "rg -n focusIndex packages/excalidraw/components/SearchMenu.tsx",
        status: "completed",
      },
      {
        kind: "assistant-text",
        id: "assistant-2",
        threadId: "thread-1",
        sourceSeqStart: 7,
        sourceSeqEnd: 9,
        createdAt: 9,
        turnId: "turn-1",
        text: "The fix is in SearchMenu.tsx.",
        status: "completed",
      },
    ]);

    expect(rows.map((row) => row.kind)).toEqual(["message", "tool-group", "message"]);
    const toolGroup = expectToolGroupRow(rows[1]);
    expect(toolGroup.messages.map((message) => message.kind)).toEqual([
      "assistant-text",
      "tool-call",
    ]);
    const finalRow = expectMessageRow(rows[2]);
    expect(expectAssistantTextMessage(finalRow.message).text).toBe(
      "The fix is in SearchMenu.tsx.",
    );
  });

  it("marks grouped error rows as failed work and counts non-tool rows", () => {
    const rows = buildTimelineRows([
      {
        kind: "tasks",
        id: "tasks-1",
        threadId: "thread-1",
        sourceSeqStart: 1,
        sourceSeqEnd: 1,
        createdAt: 1,
        turnId: "turn-1",
        source: "todo",
        title: "Tasks updated",
        status: "completed",
        tasks: [{ text: "Run validation", status: "active" }],
      },
      {
        kind: "error",
        id: "error-1",
        threadId: "thread-1",
        sourceSeqStart: 2,
        sourceSeqEnd: 2,
        createdAt: 2,
        turnId: "turn-1",
        rawType: "provider/error",
        message: "Validation failed",
      },
      {
        kind: "assistant-text",
        id: "assistant-1",
        threadId: "thread-1",
        sourceSeqStart: 3,
        sourceSeqEnd: 3,
        createdAt: 3,
        turnId: "turn-1",
        text: "I hit a validation error.",
        status: "completed",
      },
    ]);

    expect(rows.map((row) => row.kind)).toEqual(["tool-group", "message"]);
    const toolGroup = expectToolGroupRow(rows[0]);
    expect(toolGroup.summaryCount).toBe(2);
    expect(toolGroup.status).toBe("error");
    expect(toolGroup.messages.map((message) => message.kind)).toEqual([
      "tasks",
      "error",
    ]);
  });

  it("counts intermediate assistant-text messages in summaryCount", () => {
    const rows = buildTimelineRows([
      {
        kind: "assistant-text",
        id: "assistant-1",
        threadId: "thread-1",
        sourceSeqStart: 1,
        sourceSeqEnd: 1,
        createdAt: 1,
        turnId: "turn-1",
        text: "Let me check that.",
        status: "completed",
      },
      {
        kind: "tool-call",
        id: "tool-1",
        threadId: "thread-1",
        sourceSeqStart: 2,
        sourceSeqEnd: 2,
        createdAt: 2,
        turnId: "turn-1",
        toolName: "exec_command",
        callId: "call-1",
        command: "npm test",
        status: "completed",
      },
      {
        kind: "assistant-text",
        id: "assistant-2",
        threadId: "thread-1",
        sourceSeqStart: 3,
        sourceSeqEnd: 3,
        createdAt: 3,
        turnId: "turn-1",
        text: "Tests pass!",
        status: "completed",
      },
    ]);

    expect(rows.map((row) => row.kind)).toEqual(["tool-group", "message"]);
    const toolGroup = expectToolGroupRow(rows[0]);
    expect(toolGroup.summaryCount).toBe(2);
    expect(toolGroup.messages.map((m) => m.kind)).toEqual([
      "assistant-text",
      "tool-call",
    ]);
  });

  it("groups pre-terminal messages before the last assistant-text, leaving it standalone", () => {
    const rows = buildTimelineRows([
      {
        kind: "assistant-text",
        id: "assistant-1",
        threadId: "thread-1",
        sourceSeqStart: 2,
        sourceSeqEnd: 4,
        createdAt: 4,
        turnId: "turn-1",
        text: "I’m validating the fix now.",
        status: "completed",
      },
      {
        kind: "tool-call",
        id: "tool-1",
        threadId: "thread-1",
        sourceSeqStart: 3,
        sourceSeqEnd: 8,
        createdAt: 8,
        turnId: "turn-1",
        toolName: "exec_command",
        callId: "call-1",
        command: "pnpm exec turbo run test --filter=@bb/core-ui",
        status: "completed",
      },
      {
        kind: "assistant-text",
        id: "assistant-2",
        threadId: "thread-1",
        sourceSeqStart: 5,
        sourceSeqEnd: 6,
        createdAt: 6,
        turnId: "turn-1",
        text: "The tests pass with the fix.",
        status: "completed",
      },
    ]);

    // Last terminal is assistant-2, so assistant-1 + tool-1 get grouped; assistant-2 stays standalone
    expect(rows).toHaveLength(2);
    const toolGroup = expectToolGroupRow(rows[0]);
    expect(toolGroup.messages.map((message) => message.kind)).toEqual([
      "assistant-text",
      "tool-call",
    ]);
    expectMessageRow(rows[1]);
  });

  it("groups delegation, tasks, and errors together before the final answer", () => {
    const rows = buildTimelineRows([
      {
        kind: "delegation",
        id: "delegation-1",
        threadId: "thread-1",
        sourceSeqStart: 1,
        sourceSeqEnd: 2,
        createdAt: 2,
        turnId: "turn-1",
        toolName: "Agent",
        callId: "agent-1",
        status: "completed",
        children: [],
      },
      {
        kind: "tasks",
        id: "tasks-1",
        threadId: "thread-1",
        sourceSeqStart: 3,
        sourceSeqEnd: 3,
        createdAt: 3,
        turnId: "turn-1",
        source: "todo",
        title: "Tasks updated",
        status: "completed",
        tasks: [{ text: "Re-run the focused test", status: "active" }],
      },
      {
        kind: "error",
        id: "error-1",
        threadId: "thread-1",
        sourceSeqStart: 4,
        sourceSeqEnd: 4,
        createdAt: 4,
        turnId: "turn-1",
        rawType: "error",
        message: "Reconnecting... 2/5",
      },
      {
        kind: "assistant-text",
        id: "assistant-1",
        threadId: "thread-1",
        sourceSeqStart: 5,
        sourceSeqEnd: 5,
        createdAt: 5,
        turnId: "turn-1",
        text: "I retried, verified the fix, and updated the task list.",
        status: "completed",
      },
    ]);

    expect(rows.map((row) => row.kind)).toEqual(["tool-group", "message"]);
    const toolGroup = expectToolGroupRow(rows[0]);
    expect(toolGroup.messages.map((message) => message.kind)).toEqual([
      "delegation",
      "tasks",
      "error",
    ]);
  });

  it("groups each turn independently in multi-turn conversations", () => {
    const rows = buildTimelineRows([
      {
        kind: "user",
        id: "user-1",
        threadId: "thread-1",
        sourceSeqStart: 1,
        sourceSeqEnd: 1,
        createdAt: 1,
        turnId: "turn-1",
        text: "Fix the bug",
      },
      {
        kind: "tasks",
        id: "tasks-1",
        threadId: "thread-1",
        sourceSeqStart: 2,
        sourceSeqEnd: 2,
        createdAt: 2,
        turnId: "turn-1",
        source: "todo",
        title: "Tasks updated",
        status: "completed",
        tasks: [{ text: "Inspect SearchMenu.tsx", status: "completed" }],
      },
      {
        kind: "tool-call",
        id: "tool-1",
        threadId: "thread-1",
        sourceSeqStart: 3,
        sourceSeqEnd: 3,
        createdAt: 3,
        turnId: "turn-1",
        toolName: "exec_command",
        callId: "call-1",
        command: "pnpm exec turbo run test --filter=@bb/core-ui",
        status: "completed",
      },
      {
        kind: "assistant-text",
        id: "assistant-1",
        threadId: "thread-1",
        sourceSeqStart: 4,
        sourceSeqEnd: 4,
        createdAt: 4,
        turnId: "turn-1",
        text: "Turn one is complete.",
        status: "completed",
      },
      {
        kind: "user",
        id: "user-2",
        threadId: "thread-1",
        sourceSeqStart: 5,
        sourceSeqEnd: 5,
        createdAt: 5,
        turnId: "turn-2",
        text: "Add the summary UI",
      },
      {
        kind: "tasks",
        id: "tasks-2",
        threadId: "thread-1",
        sourceSeqStart: 6,
        sourceSeqEnd: 6,
        createdAt: 6,
        turnId: "turn-2",
        source: "todo",
        title: "Tasks updated",
        status: "completed",
        tasks: [{ text: "Update search summary copy", status: "completed" }],
      },
      {
        kind: "tool-call",
        id: "tool-2",
        threadId: "thread-1",
        sourceSeqStart: 7,
        sourceSeqEnd: 7,
        createdAt: 7,
        turnId: "turn-2",
        toolName: "exec_command",
        callId: "call-2",
        command: "pnpm exec turbo run test --filter=@bb/ui-core",
        status: "completed",
      },
      {
        kind: "assistant-text",
        id: "assistant-2",
        threadId: "thread-1",
        sourceSeqStart: 8,
        sourceSeqEnd: 8,
        createdAt: 8,
        turnId: "turn-2",
        text: "Turn two is complete.",
        status: "completed",
      },
    ]);

    expect(rows.map((row) => row.kind)).toEqual([
      "message",
      "tool-group",
      "message",
      "message",
      "tool-group",
      "message",
    ]);
    const toolGroups = rows.filter((row): row is Extract<TimelineRow, { kind: "tool-group" }> =>
      row.kind === "tool-group");
    expect(toolGroups).toHaveLength(2);
    expect(toolGroups[0]?.turnId).toBe("turn-1");
    expect(toolGroups[1]?.turnId).toBe("turn-2");
  });

  it("does not group a reused turn id across a later user message", () => {
    const rows = buildTimelineRows([
      {
        kind: "user",
        id: "user-1",
        threadId: "thread-1",
        sourceSeqStart: 1,
        sourceSeqEnd: 1,
        createdAt: 1,
        text: "First prompt",
      },
      {
        kind: "tool-call",
        id: "tool-1",
        threadId: "thread-1",
        sourceSeqStart: 2,
        sourceSeqEnd: 2,
        createdAt: 2,
        turnId: "turn-1",
        toolName: "exec_command",
        callId: "call-1",
        command: "pnpm exec turbo run test --filter=@bb/core-ui",
        status: "completed",
      },
      {
        kind: "assistant-text",
        id: "assistant-1",
        threadId: "thread-1",
        sourceSeqStart: 3,
        sourceSeqEnd: 3,
        createdAt: 3,
        turnId: "turn-1",
        text: "First answer.",
        status: "completed",
      },
      {
        kind: "user",
        id: "user-2",
        threadId: "thread-1",
        sourceSeqStart: 4,
        sourceSeqEnd: 4,
        createdAt: 4,
        text: "Second prompt after a resumed provider session",
      },
      {
        kind: "tool-call",
        id: "tool-2",
        threadId: "thread-1",
        sourceSeqStart: 5,
        sourceSeqEnd: 5,
        createdAt: 5,
        turnId: "turn-1",
        toolName: "exec_command",
        callId: "call-2",
        command: "pnpm exec turbo run build --filter=@bb/core-ui",
        status: "completed",
      },
      {
        kind: "assistant-text",
        id: "assistant-2",
        threadId: "thread-1",
        sourceSeqStart: 6,
        sourceSeqEnd: 6,
        createdAt: 6,
        turnId: "turn-1",
        text: "Second answer.",
        status: "completed",
      },
    ]);

    expect(rows.map((row) => row.kind)).toEqual([
      "message",
      "tool-group",
      "message",
      "message",
      "tool-group",
      "message",
    ]);
    const toolGroups = rows.filter((row): row is Extract<TimelineRow, { kind: "tool-group" }> =>
      row.kind === "tool-group");
    expect(toolGroups).toHaveLength(2);
    expect(toolGroups[0]?.sourceSeqStart).toBe(2);
    expect(toolGroups[0]?.sourceSeqEnd).toBe(2);
    expect(toolGroups[1]?.sourceSeqStart).toBe(5);
    expect(toolGroups[1]?.sourceSeqEnd).toBe(5);
  });

  it("does not collapse a turn that has only one tool message and no terminal", () => {
    const rows = buildTimelineRows([
      {
        kind: "user",
        id: "user-1",
        threadId: "thread-1",
        sourceSeqStart: 1,
        sourceSeqEnd: 1,
        createdAt: 1,
        turnId: "turn-1",
        text: "Run the test",
      },
      {
        kind: "tool-call",
        id: "tool-1",
        threadId: "thread-1",
        sourceSeqStart: 2,
        sourceSeqEnd: 2,
        createdAt: 2,
        turnId: "turn-1",
        toolName: "exec_command",
        callId: "call-1",
        command: "pnpm exec turbo run test --filter=@bb/core-ui",
        status: "completed",
      },
    ]);

    expect(rows.map((row) => row.kind)).toEqual(["message", "message"]);
  });

  it("does not collapse an active turn before a streaming assistant message", () => {
    const rows = buildTimelineRows([
      {
        kind: "user",
        id: "user-1",
        threadId: "thread-1",
        sourceSeqStart: 1,
        sourceSeqEnd: 1,
        createdAt: 1,
        turnId: "turn-1",
        text: "Fix the bug",
      },
      {
        kind: "tasks",
        id: "tasks-1",
        threadId: "thread-1",
        sourceSeqStart: 2,
        sourceSeqEnd: 2,
        createdAt: 2,
        turnId: "turn-1",
        source: "todo",
        title: "Tasks updated",
        status: "completed",
        tasks: [{ text: "Inspect SearchMenu.tsx", status: "completed" }],
      },
      {
        kind: "tool-call",
        id: "tool-1",
        threadId: "thread-1",
        sourceSeqStart: 3,
        sourceSeqEnd: 3,
        createdAt: 3,
        turnId: "turn-1",
        toolName: "exec_command",
        callId: "call-1",
        command: "pnpm exec turbo run test --filter=@bb/core-ui",
        status: "completed",
      },
      {
        kind: "assistant-text",
        id: "assistant-1",
        threadId: "thread-1",
        sourceSeqStart: 4,
        sourceSeqEnd: 4,
        createdAt: 4,
        turnId: "turn-1",
        text: "I am still working on this.",
        status: "streaming",
      },
    ]);

    expect(rows.map((row) => row.kind)).toEqual([
      "message",
      "message",
      "message",
      "message",
    ]);
  });

  it("does not collapse an active turn with pending tool work", () => {
    const rows = buildTimelineRows([
      {
        kind: "user",
        id: "user-1",
        threadId: "thread-1",
        sourceSeqStart: 1,
        sourceSeqEnd: 1,
        createdAt: 1,
        turnId: "turn-1",
        text: "Run validation",
      },
      {
        kind: "tasks",
        id: "tasks-1",
        threadId: "thread-1",
        sourceSeqStart: 2,
        sourceSeqEnd: 2,
        createdAt: 2,
        turnId: "turn-1",
        source: "todo",
        title: "Tasks updated",
        status: "completed",
        tasks: [{ text: "Run focused tests", status: "active" }],
      },
      {
        kind: "tool-call",
        id: "tool-1",
        threadId: "thread-1",
        sourceSeqStart: 3,
        sourceSeqEnd: 3,
        createdAt: 3,
        turnId: "turn-1",
        toolName: "exec_command",
        callId: "call-1",
        command: "pnpm exec turbo run test --filter=@bb/core-ui",
        status: "pending",
      },
      {
        kind: "assistant-text",
        id: "assistant-1",
        threadId: "thread-1",
        sourceSeqStart: 4,
        sourceSeqEnd: 4,
        createdAt: 4,
        turnId: "turn-1",
        text: "I am waiting for validation.",
        status: "completed",
      },
    ]);

    expect(rows.map((row) => row.kind)).toEqual([
      "message",
      "message",
      "message",
      "message",
    ]);
  });

  it("leaves all turn activity standalone when assistant-text is the only terminal message and nothing precedes it to group", () => {
    const rows = buildTimelineRows([
      {
        kind: "user",
        id: "user-1",
        threadId: "thread-1",
        sourceSeqStart: 1,
        sourceSeqEnd: 1,
        createdAt: 1,
        turnId: "turn-1",
        text: "Fix the bug",
      },
      {
        kind: "assistant-text",
        id: "assistant-1",
        threadId: "thread-1",
        sourceSeqStart: 2,
        sourceSeqEnd: 2,
        createdAt: 2,
        turnId: "turn-1",
        text: "I found the issue. Now I will validate the fix.",
        status: "completed",
      },
      {
        kind: "tool-call",
        id: "tool-1",
        threadId: "thread-1",
        sourceSeqStart: 3,
        sourceSeqEnd: 3,
        createdAt: 3,
        turnId: "turn-1",
        toolName: "exec_command",
        callId: "call-1",
        command: "npx jest search.test.tsx",
        status: "error",
      },
      {
        kind: "tool-call",
        id: "tool-2",
        threadId: "thread-1",
        sourceSeqStart: 4,
        sourceSeqEnd: 4,
        createdAt: 4,
        turnId: "turn-1",
        toolName: "exec_command",
        callId: "call-2",
        command: "npx vitest run search.test.tsx",
        status: "completed",
      },
    ]);

    // assistant-1 is the last terminal; only user-1 precedes it, but user messages are ungroupable,
    // so no group forms. Everything after the terminal stays standalone too.
    expect(rows.map((row) => row.kind)).toEqual(["message", "message", "message", "message"]);
    expect(expectMessageRow(rows[0]).message.kind).toBe("user");
    expect(expectMessageRow(rows[1]).message.kind).toBe("assistant-text");
    expect(expectMessageRow(rows[2]).message.kind).toBe("tool-call");
    expect(expectMessageRow(rows[3]).message.kind).toBe("tool-call");
  });

  it("leaves messages standalone when the only terminal is first and nothing non-ungroupable precedes it", () => {
    const rows = buildTimelineRows([
      {
        kind: "user",
        id: "user-1",
        threadId: "thread-1",
        sourceSeqStart: 1,
        sourceSeqEnd: 1,
        createdAt: 1,
        turnId: "turn-1",
        text: "Fix the bug",
      },
      {
        kind: "assistant-text",
        id: "assistant-1",
        threadId: "thread-1",
        sourceSeqStart: 2,
        sourceSeqEnd: 2,
        createdAt: 2,
        turnId: "turn-1",
        text: "I found the issue. Now I will validate the fix.",
        status: "completed",
      },
      {
        kind: "tool-call",
        id: "tool-1",
        threadId: "thread-1",
        sourceSeqStart: 3,
        sourceSeqEnd: 3,
        createdAt: 3,
        turnId: "turn-1",
        toolName: "exec_command",
        callId: "call-1",
        command: "npx vitest run search.test.tsx",
        status: "completed",
      },
    ]);

    // assistant-1 is the last terminal; only user-1 precedes it (ungroupable), so no group forms.
    // tool-1 is after the terminal and stays standalone.
    expect(rows.map((row) => row.kind)).toEqual(["message", "message", "message"]);
    expect(expectMessageRow(rows[0]).message.kind).toBe("user");
    expect(expectMessageRow(rows[1]).message.kind).toBe("assistant-text");
    expect(expectMessageRow(rows[2]).message.kind).toBe("tool-call");
  });

});

describe("buildTimelineRows reconnect error collapsing", () => {
  it("collapses consecutive reconnect retry errors into the latest row", () => {
    const rows = buildTimelineRows([
      {
        kind: "error",
        id: "error-1",
        threadId: "thread-1",
        sourceSeqStart: 10,
        sourceSeqEnd: 10,
        createdAt: 10,
        turnId: "turn-1",
        rawType: "error",
        message: "Reconnecting... 2/5",
      },
      {
        kind: "error",
        id: "error-2",
        threadId: "thread-1",
        sourceSeqStart: 11,
        sourceSeqEnd: 11,
        createdAt: 11,
        turnId: "turn-1",
        rawType: "error",
        message: "Reconnecting... 3/5",
      },
      {
        kind: "error",
        id: "error-3",
        threadId: "thread-1",
        sourceSeqStart: 12,
        sourceSeqEnd: 12,
        createdAt: 12,
        turnId: "turn-1",
        rawType: "error",
        message: "Reconnecting... 4/5",
      },
    ]);

    expect(rows).toHaveLength(1);
    const messageRow = expectMessageRow(rows[0]);
    const errorMessage = expectErrorMessage(messageRow.message);
    expect(errorMessage.message).toBe("Reconnecting... 4/5");
    expect(errorMessage.sourceSeqStart).toBe(10);
    expect(errorMessage.sourceSeqEnd).toBe(12);
    expect(errorMessage.createdAt).toBe(12);
    expect(errorMessage.startedAt).toBe(10);
  });

  it("groups pre-terminal activity before the last error, leaving it standalone", () => {
    const rows = buildTimelineRows([
      {
        kind: "error",
        id: "error-1",
        threadId: "thread-1",
        sourceSeqStart: 10,
        sourceSeqEnd: 10,
        createdAt: 10,
        turnId: "turn-1",
        rawType: "error",
        message: "Reconnecting... 2/5",
      },
      {
        kind: "tool-call",
        id: "tool-1",
        threadId: "thread-1",
        sourceSeqStart: 11,
        sourceSeqEnd: 11,
        createdAt: 11,
        turnId: "turn-1",
        toolName: "exec_command",
        callId: "call-1",
        status: "completed",
      },
      {
        kind: "error",
        id: "error-2",
        threadId: "thread-1",
        sourceSeqStart: 12,
        sourceSeqEnd: 12,
        createdAt: 12,
        turnId: "turn-1",
        rawType: "error",
        message: "Reconnecting... 3/4",
      },
      {
        kind: "error",
        id: "error-3",
        threadId: "thread-1",
        sourceSeqStart: 13,
        sourceSeqEnd: 13,
        createdAt: 13,
        turnId: "turn-1",
        rawType: "error",
        message: "Reconnecting... 4/5",
      },
    ]);

    // Last terminal is error-3; error-1, tool-1, error-2 are grouped before it; error-3 stays standalone
    expect(rows).toHaveLength(2);
    expect(rows[0]?.kind).toBe("tool-group");
    expect(rows[1]?.kind).toBe("message");
  });
});

describe("buildTimelineRows provisioning operation collapsing", () => {
  it("collapses multiple provisioning events into one operation row", () => {
    const rows = getOperationRows([
      provisioningOperation(1, "Provisioning thread", "pending", undefined, {
        transcript: [{ type: "step", key: "provision", text: "Creating worktree", status: "started" }],
      }),
      provisioningOperation(2, "Provisioning thread", "pending", undefined, {
        transcript: [{ type: "step", key: "setup", text: "Running .bb-env-setup.sh", status: "started" }],
      }),
      provisioningOperation(3, "Provisioning thread", "pending", undefined, {
        transcript: [{ type: "step", key: "setup", text: ".bb-env-setup.sh finished", status: "completed" }],
      }),
      provisioningOperation(4, "Provisioned thread", "completed", undefined, {
        transcript: [{ type: "step", key: "provision", text: "Created worktree", status: "completed" }],
      }),
    ]);

    expect(rows).toHaveLength(1);
    expect(rows[0]?.opType).toBe("thread-provisioning");
    expect(rows[0]?.title).toBe("Provisioned thread");
    const envEntry = rows[0]?.provisioning?.transcript?.find((e) => e.key === "provision");
    expect(envEntry).toBeDefined();
    if (envEntry?.type === "step") {
      expect(envEntry.text).toBe("Creating worktree");
    }
    const setupEntries = rows[0]?.provisioning?.transcript?.filter((e) => e.key === "setup");
    expect(setupEntries?.map((entry) => entry.text)).toEqual([
      "Running .bb-env-setup.sh",
      ".bb-env-setup.sh finished",
    ]);
    expect(setupEntries?.map((entry) => (entry.type === "step" ? entry.status : undefined))).toEqual([
      "started",
      "completed",
    ]);
    expect(rows[0]?.sourceSeqStart).toBe(1);
    expect(rows[0]?.sourceSeqEnd).toBe(4);
    expect(rows[0]?.detail).toBeUndefined();
  });

  it("keeps completed provisioning rows fully structured", () => {
    const rows = getOperationRows([
      provisioningOperation(1, "Provisioning thread", "pending", undefined, {
        transcript: [{ type: "step", key: "provision", text: "Provisioning thread", status: "started" }],
      }),
      provisioningOperation(2, "Provisioned thread", "completed", undefined, {
        transcript: [{ type: "step", key: "provision", text: "Provisioning thread", status: "started" }],
      }),
    ]);

    expect(rows).toHaveLength(1);
    expect(rows[0]?.opType).toBe("thread-provisioning");
    expect(rows[0]?.title).toBe("Provisioned thread");
    const envEntry = rows[0]?.provisioning?.transcript?.find((e) => e.key === "provision");
    expect(envEntry).toBeDefined();
    if (envEntry?.type === "step") {
      expect(envEntry.text).toBe("Provisioning thread");
    }
    expect(rows[0]?.detail).toBeUndefined();
  });

  it("keeps a stable merged provisioning id as new lifecycle updates arrive", () => {
    const startedRows = getOperationRows([
      provisioningOperation(1, "Provisioning thread", "pending", undefined, {
        transcript: [{ type: "step", key: "provision", text: "Creating worktree", status: "started" }],
      }),
    ]);
    const mergedRows = getOperationRows([
      provisioningOperation(1, "Provisioning thread", "pending", undefined, {
        transcript: [{ type: "step", key: "provision", text: "Creating worktree", status: "started" }],
      }),
      provisioningOperation(2, "Provisioning thread", "pending", undefined, {
        transcript: [{ type: "step", key: "setup", text: "Running .bb-env-setup.sh", status: "started" }],
      }),
      provisioningOperation(3, "Provisioning thread", "pending", undefined, {
        transcript: [{ type: "step", key: "setup", text: "Running .bb-env-setup.sh", status: "started" }],
      }),
    ]);

    expect(startedRows[0]?.id).toBe("provisioning-1");
    expect(startedRows[0]?.opType).toBe("thread-provisioning");
    expect(startedRows[0]?.title).toBe("Provisioning thread");
    expect(mergedRows[0]?.id).toBe("provisioning-1");
  });

  it("preserves transcript entries when collapsing provisioning rows", () => {
    const rows = getOperationRows([
      provisioningOperation(1, "Provisioning thread", "pending", undefined, {
        transcript: [{ type: "step", key: "provision", text: "Creating worktree", status: "started" }],
      }),
      provisioningOperation(2, "Provisioning thread", "pending", undefined, {
        transcript: [{ type: "step", key: "setup", text: "Running .bb-env-setup.sh", status: "started" }],
      }),
      provisioningOperation(3, "Provisioning thread", "pending", undefined, {
        transcript: [{ type: "output", key: "setup-out-1", text: "+ pnpm install" }],
      }),
      provisioningOperation(4, "Provisioning thread", "pending", undefined, {
        transcript: [{ type: "output", key: "setup-out-2", text: "Done in 3.2s" }],
      }),
    ]);

    expect(rows).toHaveLength(1);
    expect(rows[0]?.opType).toBe("thread-provisioning");
    expect(rows[0]?.title).toBe("Provisioning thread");
    const envEntry = rows[0]?.provisioning?.transcript?.find((e) => e.key === "provision");
    expect(envEntry).toBeDefined();
    if (envEntry?.type === "step") {
      expect(envEntry.text).toBe("Creating worktree");
    }
    const setupEntry = rows[0]?.provisioning?.transcript?.find((e) => e.key === "setup");
    expect(setupEntry).toBeDefined();
    expect(setupEntry?.text).toBe("Running .bb-env-setup.sh");
    const outputEntries = rows[0]?.provisioning?.transcript?.filter((e) => e.type === "output");
    expect(outputEntries).toHaveLength(2);
    expect(rows[0]?.detail).toBeUndefined();
  });

  it("preserves provisioning transcript when collapsing provisioning rows", () => {
    const rows = getOperationRows([
      provisioningOperation(1, "Provisioning thread", "pending", undefined, {
        transcript: [
          { type: "step", key: "provision", text: "Provisioning thread", status: "started" },
        ],
      }),
      provisioningOperation(2, "Provisioning thread", "pending", undefined, {
        transcript: [
          { type: "step", key: "session", text: "Starting agent session", status: "started" },
        ],
      }),
    ]);

    expect(rows).toHaveLength(1);
    expect(rows[0]?.opType).toBe("thread-provisioning");
    expect(rows[0]?.title).toBe("Provisioning thread");
    expect(rows[0]?.provisioning?.transcript?.map((entry) => entry.key)).toEqual([
      "provision",
      "session",
    ]);
  });

  it("keeps one provisioning row when user interruption lands mid-provisioning", () => {
    const rows = buildTimelineRows([
      provisioningOperation(1, "Provisioning thread", "pending", undefined, {
        transcript: [
          { type: "step", key: "provision", text: "Provisioning thread", status: "started" },
        ],
      }),
      provisioningOperation(2, "Provisioning thread", "pending", undefined, {
        transcript: [
          { type: "step", key: "session", text: "Starting agent session", status: "started" },
        ],
      }),
      {
        kind: "operation",
        id: "op-3",
        threadId: "thread-1",
        sourceSeqStart: 3,
        sourceSeqEnd: 3,
        createdAt: 3,
        startedAt: 3,
        opType: "thread-interrupted",
        title: "Stopped by user",
        status: "interrupted",
      },
      provisioningOperation(4, "Provisioning thread failed", "error", undefined, {
        transcript: [
          { type: "step", key: "session", text: "Agent session failed", status: "failed" },
        ],
      }),
      {
        kind: "error",
        id: "error-5",
        threadId: "thread-1",
        sourceSeqStart: 5,
        sourceSeqEnd: 5,
        createdAt: 5,
        rawType: "system/error",
        message: "Provisioning thread failed",
      },
    ]).filter((row): row is Extract<TimelineRow, { kind: "message" }> => row.kind === "message");

    expect(rows).toHaveLength(3);
    expect(rows[0]?.message.kind).toBe("operation");
    if (rows[0]?.message.kind === "operation") {
      expect(rows[0].message.opType).toBe("thread-provisioning");
      expect(rows[0].message.title).toBe("Provisioning thread failed");
      expect(rows[0].message.sourceSeqStart).toBe(1);
      expect(rows[0].message.sourceSeqEnd).toBe(4);
    }
    expect(rows[1]?.message.kind).toBe("operation");
    if (rows[1]?.message.kind === "operation") {
      expect(rows[1].message.opType).toBe("thread-interrupted");
      expect(rows[1].message.title).toBe("Stopped by user");
    }
  });

  it("preserves ordered provisioning transcript items when collapsing rows", () => {
    const rows = getOperationRows([
      provisioningOperation(1, "Provisioning thread", "pending", undefined, {
        transcript: [
          { type: "step", key: "provision", text: "Creating worktree", status: "started" },
          { type: "step", key: "worktree", text: "Created worktree", status: "completed" },
        ],
      }),
      provisioningOperation(2, "Provisioning thread", "pending", undefined, {
        transcript: [
          { type: "step", key: "branch", text: "Using branch: feature/test (abcdef1)", status: "completed" },
          { type: "step", key: "setup", text: "Running .bb-env-setup.sh", status: "started" },
        ],
      }),
      provisioningOperation(3, "Provisioning thread", "pending", undefined, {
        transcript: [
          { type: "step", key: "session", text: "Agent session ready", status: "completed" },
        ],
      }),
    ]);

    expect(rows).toHaveLength(1);
    expect(rows[0]?.opType).toBe("thread-provisioning");
    expect(rows[0]?.provisioning?.transcript?.map((entry) => entry.key)).toEqual([
      "provision",
      "worktree",
      "branch",
      "setup",
      "session",
    ]);
  });

  it("preserves transcript entries with the same key", () => {
    const rows = getOperationRows([
      provisioningOperation(1, "Provisioning thread", "pending", undefined, {
        transcript: [{ type: "step", key: "setup", text: "Running .bb-env-setup.sh", status: "started" }],
      }),
      provisioningOperation(2, "Provisioning thread", "pending", undefined, {
        transcript: [{ type: "step", key: "setup", text: "Running .bb-env-setup.sh", status: "started" }],
      }),
      provisioningOperation(3, "Provisioned thread", "completed", undefined, {
        transcript: [{ type: "step", key: "setup", text: ".bb-env-setup.sh finished", status: "completed" }],
      }),
    ]);

    expect(rows).toHaveLength(1);
    const setupEntries = rows[0]?.provisioning?.transcript?.filter((e) => e.key === "setup");
    expect(setupEntries?.map((entry) => entry.text)).toEqual([
      "Running .bb-env-setup.sh",
      "Running .bb-env-setup.sh",
      ".bb-env-setup.sh finished",
    ]);
    expect(setupEntries?.map((entry) => (entry.type === "step" ? entry.status : undefined))).toEqual([
      "started",
      "started",
      "completed",
    ]);
  });

  it("collapses two provisioning updates into a single completed row", () => {
    const rows = getOperationRows([
      provisioningOperation(1, "Provisioning thread", "pending", undefined, {
        transcript: [{ type: "step", key: "setup", text: "Running .bb-env-setup.sh", status: "started" }],
      }),
      provisioningOperation(2, "Provisioned thread", "completed", undefined, {
        transcript: [{ type: "step", key: "setup", text: ".bb-env-setup.sh finished", status: "completed" }],
      }),
    ]);

    expect(rows).toHaveLength(1);
    expect(rows[0]?.opType).toBe("thread-provisioning");
    expect(rows[0]?.title).toBe("Provisioned thread");
    expect(rows[0]?.sourceSeqStart).toBe(1);
    expect(rows[0]?.sourceSeqEnd).toBe(2);
    const setupEntries = rows[0]?.provisioning?.transcript?.filter((e) => e.key === "setup");
    expect(setupEntries?.map((entry) => entry.text)).toEqual([
      "Running .bb-env-setup.sh",
      ".bb-env-setup.sh finished",
    ]);
    expect(setupEntries?.map((entry) => (entry.type === "step" ? entry.status : undefined))).toEqual([
      "started",
      "completed",
    ]);
    expect(rows[0]?.detail).toBeUndefined();
  });

  it("shows completed when provisioning succeeds but thread later errors", () => {
    // Regression: finalizeOperationMessage marks pending (in-progress)
    // provisioning ops as error when the thread status is "error". The merge
    // must still produce "completed" when the final provisioning event succeeded.
    const rows = getOperationRows([
      provisioningOperation(1, "Provisioning thread", "error", undefined, {
        transcript: [{ type: "step", key: "provision", text: "Waiting for workspace", status: "started" }],
      }),
      provisioningOperation(2, "Provisioning thread", "error", undefined, {
        transcript: [{ type: "step", key: "git-clone", text: "git clone ...", status: "completed" }],
      }),
      provisioningOperation(3, "Provisioned thread", "completed", undefined, {
        transcript: [{ type: "step", key: "branch", text: "Using branch: main", status: "completed" }],
      }),
    ]);

    expect(rows).toHaveLength(1);
    expect(rows[0]?.opType).toBe("thread-provisioning");
    expect(rows[0]?.status).toBe("completed");
    expect(rows[0]?.title).toBe("Provisioned thread");
  });

  it("shows completed when a completed provisioning event is followed by stale interrupted updates", () => {
    const rows = getOperationRows([
      provisioningOperation(1, "Provisioned thread", "completed", undefined, {
        transcript: [{ type: "step", key: "branch", text: "Using branch: main", status: "completed" }],
      }),
      provisioningOperation(2, "Provisioning thread", "interrupted", undefined, {
        transcript: [{ type: "output", key: "setup-out-1", text: "Done in 8.4s" }],
      }),
    ]);

    expect(rows).toHaveLength(1);
    expect(rows[0]?.opType).toBe("thread-provisioning");
    expect(rows[0]?.status).toBe("completed");
    expect(rows[0]?.title).toBe("Provisioned thread");
  });
});
