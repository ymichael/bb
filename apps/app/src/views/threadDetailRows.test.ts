import { describe, expect, it } from "vitest";
import type { UIMessage } from "@beanbag/agent-core";
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
  it("collapses tool activity before the final assistant message in a turn", () => {
    const messages: UIMessage[] = [
      {
        ...baseMessage("user-1", 1),
        kind: "user",
        turnId: "turn-1",
        text: "do work",
      },
      {
        ...baseMessage("exploring-1", 2),
        kind: "tool-exploring",
        turnId: "turn-1",
        status: "completed",
        calls: [
          {
            callId: "call-1",
            command: "cat README.md",
            parsedCmd: [
              {
                type: "read",
                cmd: "cat README.md",
                name: "README.md",
                path: "/repo/README.md",
              },
            ],
            status: "completed",
          },
        ],
      },
      {
        ...baseMessage("exploring-2", 3),
        kind: "tool-exploring",
        turnId: "turn-1",
        status: "completed",
        calls: [
          {
            callId: "call-2",
            command: "rg TODO src",
            parsedCmd: [
              {
                type: "search",
                cmd: "rg TODO src",
                query: "TODO",
                path: "src",
              },
            ],
            status: "completed",
          },
        ],
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
    expect(group.summaryCount).toBe(2);
    expect(group.messages).toHaveLength(1);
    expect(group.messages[0]?.kind).toBe("tool-exploring");
    if (group.messages[0]?.kind !== "tool-exploring") return;
    expect(group.messages[0].calls).toHaveLength(2);

    const renderedMessageIds = rows
      .filter((row): row is Extract<(typeof rows)[number], { kind: "message" }> => row.kind === "message")
      .map((row) => row.message.id);
    expect(renderedMessageIds).toEqual(["user-1", "assistant-1", "tool-2"]);
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
        ...baseMessage("search-1", 2),
        kind: "web-search",
        turnId: "turn-1",
        callId: "web-1",
        status: "pending",
      },
      {
        ...baseMessage("exploring-1", 3),
        kind: "tool-exploring",
        turnId: "turn-1",
        status: "pending",
        calls: [
          {
            callId: "call-1",
            command: "cat README.md",
            parsedCmd: [
              {
                type: "read",
                cmd: "cat README.md",
                name: "README.md",
                path: "/repo/README.md",
              },
            ],
            status: "pending",
          },
        ],
      },
    ];

    const rows = buildThreadDetailRows(messages);
    expect(rows.map((row) => row.kind)).toEqual(["message", "message", "message"]);
  });

  it("collapses each turn independently", () => {
    const messages: UIMessage[] = [
      {
        ...baseMessage("exploring-1", 1),
        kind: "tool-exploring",
        turnId: "turn-1",
        status: "completed",
        calls: [
          {
            callId: "call-1",
            command: "cat README.md",
            parsedCmd: [
              {
                type: "read",
                cmd: "cat README.md",
                name: "README.md",
                path: "/repo/README.md",
              },
            ],
            status: "completed",
          },
        ],
      },
      {
        ...baseMessage("assistant-1", 2),
        kind: "assistant-text",
        turnId: "turn-1",
        text: "turn 1",
        status: "completed",
      },
      {
        ...baseMessage("search-2", 3),
        kind: "web-search",
        turnId: "turn-2",
        callId: "web-2",
        query: "vite cache",
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
    expect(groupedRows.map((row) => row.turnId)).toEqual(["turn-1", "turn-2"]);
  });

  it("does not merge exploring messages across non-exploring entries", () => {
    const messages: UIMessage[] = [
      {
        ...baseMessage("exploring-1", 1),
        kind: "tool-exploring",
        turnId: "turn-1",
        status: "completed",
        calls: [
          {
            callId: "call-1",
            command: "cat README.md",
            parsedCmd: [
              {
                type: "read",
                cmd: "cat README.md",
                name: "README.md",
                path: "/repo/README.md",
              },
            ],
            status: "completed",
          },
        ],
      },
      {
        ...baseMessage("file-1", 2),
        kind: "file-edit",
        turnId: "turn-1",
        callId: "edit-1",
        changes: [{ path: "/repo/a.ts" }],
        status: "completed",
      },
      {
        ...baseMessage("exploring-2", 3),
        kind: "tool-exploring",
        turnId: "turn-1",
        status: "completed",
        calls: [
          {
            callId: "call-2",
            command: "cat package.json",
            parsedCmd: [
              {
                type: "read",
                cmd: "cat package.json",
                name: "package.json",
                path: "/repo/package.json",
              },
            ],
            status: "completed",
          },
        ],
      },
      {
        ...baseMessage("assistant-1", 4),
        kind: "assistant-text",
        turnId: "turn-1",
        text: "done",
        status: "completed",
      },
    ];

    const rows = buildThreadDetailRows(messages);
    const group = rows.find((row) => row.kind === "tool-group");
    expect(group).toBeDefined();
    if (!group || group.kind !== "tool-group") return;

    expect(group.summaryCount).toBe(3);
    expect(group.messages.map((message) => message.kind)).toEqual([
      "tool-exploring",
      "file-edit",
      "tool-exploring",
    ]);
  });

  it("merges consecutive exploring rows even when they are not in a tool-group", () => {
    const messages: UIMessage[] = [
      {
        ...baseMessage("assistant-1", 1),
        kind: "assistant-text",
        turnId: "turn-1",
        text: "I will inspect the repo",
        status: "completed",
      },
      {
        ...baseMessage("exploring-1", 2),
        kind: "tool-exploring",
        turnId: "turn-1",
        status: "completed",
        calls: [
          {
            callId: "call-1",
            command: "cat README.md",
            parsedCmd: [
              {
                type: "read",
                cmd: "cat README.md",
                name: "README.md",
                path: "/repo/README.md",
              },
            ],
            status: "completed",
          },
        ],
      },
      {
        ...baseMessage("exploring-2", 3),
        kind: "tool-exploring",
        turnId: "turn-1",
        status: "completed",
        calls: [
          {
            callId: "call-2",
            command: "rg TODO src",
            parsedCmd: [
              {
                type: "search",
                cmd: "rg TODO src",
                query: "TODO",
                path: "src",
              },
            ],
            status: "completed",
          },
        ],
      },
    ];

    const rows = buildThreadDetailRows(messages);
    expect(rows).toHaveLength(2);
    expect(rows[0]?.kind).toBe("message");
    expect(rows[1]?.kind).toBe("message");
    if (rows[1]?.kind !== "message") return;
    expect(rows[1].message.kind).toBe("tool-exploring");
    if (rows[1].message.kind !== "tool-exploring") return;
    expect(rows[1].message.calls).toHaveLength(2);
  });
});
