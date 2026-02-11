import { describe, expect, it } from "vitest";
import type { UIMessage } from "@beanbag/core";
import { buildThreadDetailRows } from "./threadDetailRows";

function baseMessage(
  id: string,
  sourceSeq: number,
): Pick<UIMessage, "id" | "threadId" | "sourceSeqStart" | "sourceSeqEnd" | "createdAt"> {
  return {
    id,
    threadId: "thread-1",
    sourceSeqStart: sourceSeq,
    sourceSeqEnd: sourceSeq,
    createdAt: sourceSeq,
  };
}

describe("buildThreadDetailRows", () => {
  it("collapses all non-user rows before the final assistant message", () => {
    const messages: UIMessage[] = [
      {
        ...baseMessage("user-1", 1),
        kind: "user",
        turnId: "turn-1",
        text: "do work",
      },
      {
        ...baseMessage("tool-1", 2),
        kind: "tool-call",
        turnId: "turn-1",
        toolName: "exec_command",
        callId: "call-1",
        command: "ls",
        status: "completed",
      },
      {
        ...baseMessage("edit-1", 3),
        kind: "file-edit",
        turnId: "turn-1",
        callId: "edit-call-1",
        changes: [{ path: "/repo/a.ts" }],
        status: "completed",
      },
      {
        ...baseMessage("assistant-1", 4),
        kind: "assistant-text",
        turnId: "turn-1",
        text: "done",
        status: "completed",
      },
      {
        ...baseMessage("tool-2", 5),
        kind: "tool-call",
        turnId: "turn-1",
        toolName: "exec_command",
        callId: "call-2",
        command: "pwd",
        status: "completed",
      },
    ];

    const rows = buildThreadDetailRows(messages);

    expect(rows.map((row) => row.kind)).toEqual([
      "message",
      "tool-group",
      "message",
      "message",
    ]);

    const group = rows.find((row) => row.kind === "tool-group");
    expect(group).toBeDefined();
    if (!group || group.kind !== "tool-group") return;
    expect(group.messages.map((message) => message.id)).toEqual([
      "tool-1",
      "edit-1",
    ]);

    const renderedMessageIds = rows
      .filter((row): row is Extract<(typeof rows)[number], { kind: "message" }> => row.kind === "message")
      .map((row) => row.message.id);
    expect(renderedMessageIds).toEqual(["user-1", "assistant-1", "tool-2"]);
  });

  it("keeps user and final assistant rows visible while collapsing earlier non-user rows", () => {
    const messages: UIMessage[] = [
      {
        ...baseMessage("user-1", 1),
        kind: "user",
        turnId: "turn-1",
        text: "do work",
      },
      {
        ...baseMessage("op-1", 2),
        kind: "operation",
        turnId: "turn-1",
        opType: "compaction",
        title: "Context compacted",
      },
      {
        ...baseMessage("assistant-1", 3),
        kind: "assistant-text",
        turnId: "turn-1",
        text: "done",
        status: "completed",
      },
    ];

    const rows = buildThreadDetailRows(messages);
    const renderedMessageIds = rows
      .filter((row): row is Extract<(typeof rows)[number], { kind: "message" }> => row.kind === "message")
      .map((row) => row.message.id);

    expect(renderedMessageIds).toEqual(["user-1", "assistant-1"]);

    const group = rows.find((row) => row.kind === "tool-group");
    expect(group).toBeDefined();
    if (!group || group.kind !== "tool-group") return;
    expect(group.messages.map((message) => message.id)).toEqual(["op-1"]);
  });

  it("does not collapse rows when a turn has no assistant message", () => {
    const messages: UIMessage[] = [
      {
        ...baseMessage("user-1", 1),
        kind: "user",
        turnId: "turn-1",
        text: "do work",
      },
      {
        ...baseMessage("tool-1", 2),
        kind: "tool-call",
        turnId: "turn-1",
        toolName: "exec_command",
        callId: "call-1",
        command: "ls",
        status: "pending",
      },
      {
        ...baseMessage("edit-1", 3),
        kind: "file-edit",
        turnId: "turn-1",
        callId: "edit-call-1",
        changes: [{ path: "/repo/a.ts" }],
        status: "pending",
      },
    ];

    const rows = buildThreadDetailRows(messages);
    expect(rows.map((row) => row.kind)).toEqual(["message", "message", "message"]);
  });

  it("collapses each turn independently", () => {
    const messages: UIMessage[] = [
      {
        ...baseMessage("tool-1", 1),
        kind: "tool-call",
        turnId: "turn-1",
        toolName: "exec_command",
        callId: "call-1",
        command: "ls",
        status: "completed",
      },
      {
        ...baseMessage("assistant-1", 2),
        kind: "assistant-text",
        turnId: "turn-1",
        text: "turn 1",
        status: "completed",
      },
      {
        ...baseMessage("tool-2", 3),
        kind: "tool-call",
        turnId: "turn-2",
        toolName: "exec_command",
        callId: "call-2",
        command: "pwd",
        status: "completed",
      },
      {
        ...baseMessage("assistant-2", 4),
        kind: "assistant-text",
        turnId: "turn-2",
        text: "turn 2",
        status: "completed",
      },
    ];

    const rows = buildThreadDetailRows(messages);
    const groupedRows = rows.filter((row) => row.kind === "tool-group");
    expect(groupedRows).toHaveLength(2);

    const groupedTurnIds = groupedRows.map((row) => row.turnId);
    expect(groupedTurnIds).toEqual(["turn-1", "turn-2"]);
  });
});
