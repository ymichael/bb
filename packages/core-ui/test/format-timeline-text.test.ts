import { describe, expect, it } from "vitest";
import {
  formatTimelineAsText,
  type TimelineTextFormatOptions,
} from "../src/format-timeline-text.js";
import { buildTimelineRows } from "../src/thread-detail-rows.js";
import type {
  TimelineRow,
  ViewMessage,
  ViewProjection,
  ViewTurn,
  ViewTurnStatus,
} from "@bb/domain";

function getStartedAt(message: ViewMessage): number {
  return message.startedAt ?? message.createdAt;
}

function getTurnStatus(messages: ViewMessage[]): ViewTurnStatus {
  if (messages.some((message) => message.kind === "error")) {
    return "error";
  }
  if (
    messages.some((message) =>
      "status" in message &&
      (message.status === "pending" || message.status === "streaming")
    )
  ) {
    return "pending";
  }
  return "completed";
}

function projectionTurnFromMessages(
  turnId: string,
  messages: ViewMessage[],
): ViewTurn {
  const sourceSeqStart = Math.min(...messages.map((message) => message.sourceSeqStart));
  const sourceSeqEnd = Math.max(...messages.map((message) => message.sourceSeqEnd));
  const startedAt = Math.min(...messages.map((message) => getStartedAt(message)));
  const createdAt = Math.max(...messages.map((message) => message.createdAt));
  const status = getTurnStatus(messages);
  return {
    turnId,
    threadId: messages[0]?.threadId ?? "thread-1",
    sourceSeqStart,
    sourceSeqEnd,
    startedAt,
    createdAt,
    completedAt: status === "pending" ? null : createdAt,
    status,
    summaryCount: 0,
    messages,
  };
}

function projectionFromMessages(messages: ViewMessage[]): ViewProjection {
  const entries: ViewProjection["entries"] = [];
  const turnMessagesById = new Map<string, ViewMessage[]>();
  const emittedTurnIds = new Set<string>();

  for (const message of messages) {
    if (!message.turnId) {
      entries.push({ kind: "message", message });
      continue;
    }

    const turnMessages = turnMessagesById.get(message.turnId) ?? [];
    turnMessages.push(message);
    turnMessagesById.set(message.turnId, turnMessages);
    if (!emittedTurnIds.has(message.turnId)) {
      emittedTurnIds.add(message.turnId);
      entries.push({
        kind: "turn",
        turn: projectionTurnFromMessages(message.turnId, turnMessages),
      });
    }
  }

  return {
    entries: entries.map((entry) => {
      if (entry.kind === "message") {
        return entry;
      }
      const messagesForTurn = turnMessagesById.get(entry.turn.turnId) ?? [];
      return {
        kind: "turn",
        turn: projectionTurnFromMessages(entry.turn.turnId, messagesForTurn),
      };
    }),
  };
}

function timelineRowsFromMessages(messages: ViewMessage[]): TimelineRow[] {
  return buildTimelineRows(projectionFromMessages(messages));
}

function formatMessagesAsText(
  messages: ViewMessage[],
  options?: TimelineTextFormatOptions,
): string {
  return formatTimelineAsText(timelineRowsFromMessages(messages), options);
}

describe("formatTimelineAsText", () => {
  it("renders command approval state on tool-call rows", () => {
    const text = formatMessagesAsText([
      {
        kind: "tool-call",
        id: "approval-1",
        threadId: "t1",
        sourceSeqStart: 1,
        sourceSeqEnd: 1,
        createdAt: 1,
        toolName: "exec_command",
        callId: "item-1",
        command: "git push",
        status: "pending",
        approvalStatus: "waiting_for_approval",
      },
    ], { verbose: true });

    expect(text).toContain("Waiting for approval to run git push");
    expect(text).toContain("git push");
  });

  it("renders user + assistant + tool-call in minimal mode", () => {
    const messages: ViewMessage[] = [
      {
        kind: "user",
        id: "u1",
        threadId: "t1",
        sourceSeqStart: 1,
        sourceSeqEnd: 1,
        createdAt: 1,
        text: "Fix the bug",
      },
      {
        kind: "assistant-text",
        id: "a1",
        threadId: "t1",
        sourceSeqStart: 2,
        sourceSeqEnd: 2,
        createdAt: 2,
        text: "I'll fix it now.",
        status: "completed",
      },
      {
        kind: "tool-call",
        id: "tc1",
        threadId: "t1",
        sourceSeqStart: 3,
        sourceSeqEnd: 4,
        createdAt: 3,
        toolName: "Bash",
        callId: "call-1",
        command: "npm test",
        output: "All tests passed",
        exitCode: 0,
        status: "completed",
      },
    ];

    const text = formatMessagesAsText(messages, { color: false });
    expect(text).toContain("User");
    expect(text).toContain("Fix the bug");
    expect(text).toContain("Assistant");
    expect(text).toContain("I'll fix it now.");
    expect(text).toContain("Tool Call: Bash");
    expect(text).toContain("npm test");
    expect(text).toContain("All tests passed");
  });

  it("collapses exploring calls in minimal mode", () => {
    const messages: ViewMessage[] = [
      {
        kind: "tool-exploring",
        id: "exp1",
        threadId: "t1",
        sourceSeqStart: 1,
        sourceSeqEnd: 3,
        createdAt: 1,
        status: "completed",
        calls: [
          {
            callId: "c1",
            command: "Read /src/main.ts",
            parsedCmd: [{ type: "read", cmd: "Read /src/main.ts", name: "Read", path: "/src/main.ts" }],
            output: "file contents here...",
            status: "completed",
          },
          {
            callId: "c2",
            command: "Grep 'bug' in /src",
            parsedCmd: [{ type: "search", cmd: "Grep 'bug' in /src", query: "bug", path: "/src" }],
            output: "found 3 matches",
            status: "completed",
          },
        ],
      },
    ];

    const minimal = formatMessagesAsText(messages, { color: false });
    expect(minimal).toContain("Explored 1 file, 1 search");
    expect(minimal).not.toContain("Read main.ts");
    expect(minimal).not.toContain("Search bug in /src");

    const verbose = formatMessagesAsText(messages, { color: false, verbose: true });
    expect(verbose).toContain("Explored 1 file, 1 search");
    expect(verbose).toContain("Read /src/main.ts");
    expect(verbose).toContain("Search bug in /src");
    expect(verbose).not.toContain("Read exec_command");
    expect(verbose).not.toContain("file contents here");
  });

  it("limits large exploring groups in minimal mode", () => {
    const calls = Array.from({ length: 10 }, (_, index) => ({
      callId: `c${index + 1}`,
      command: `Read /src/file-${index + 1}.ts`,
      parsedCmd: [
        {
          type: "read" as const,
          cmd: `Read /src/file-${index + 1}.ts`,
          name: "Read",
          path: `/src/file-${index + 1}.ts`,
        },
      ],
      status: "completed" as const,
    }));

    const minimal = formatMessagesAsText(
      [
        {
          kind: "tool-exploring",
          id: "exp-large",
          threadId: "t1",
          sourceSeqStart: 1,
          sourceSeqEnd: 10,
          createdAt: 1,
          status: "completed",
          calls,
        },
      ],
      { color: false },
    );

    expect(minimal).toContain("Explored 10 files");
    expect(minimal).not.toContain("Read /src/file-1.ts");
  });

  it("renders file edit with path", () => {
    const messages: ViewMessage[] = [
      {
        kind: "file-edit",
        id: "fe1",
        threadId: "t1",
        sourceSeqStart: 1,
        sourceSeqEnd: 2,
        createdAt: 1,
        callId: "call-1",
        changes: [
          { path: "/src/auth.ts", kind: "update", diff: "+  if (!user) return null;" },
        ],
        status: "completed",
      },
    ];

    const minimal = formatMessagesAsText(messages, { color: false });
    expect(minimal).toContain("File Edit");
    expect(minimal).toContain("/src/auth.ts");
    expect(minimal).not.toContain("if (!user)"); // diff hidden in minimal

    const verbose = formatMessagesAsText(messages, { color: false, verbose: true });
    expect(verbose).toContain("if (!user)"); // diff shown in verbose
  });

  it("renders errors", () => {
    const messages: ViewMessage[] = [
      {
        kind: "error",
        id: "e1",
        threadId: "t1",
        sourceSeqStart: 1,
        sourceSeqEnd: 1,
        createdAt: 1,
        rawType: "system/error",
        message: "Provider unavailable",
      },
    ];

    const text = formatMessagesAsText(messages, { color: false });
    expect(text).toContain("Error");
    expect(text).toContain("Provider unavailable");
  });

  it("omits reasoning from timeline rows", () => {
    const messages: ViewMessage[] = [
      {
        kind: "assistant-reasoning",
        id: "r1",
        threadId: "t1",
        sourceSeqStart: 1,
        sourceSeqEnd: 1,
        createdAt: 1,
        text: "Let me think about this...",
        status: "completed",
      },
    ];

    const minimal = formatMessagesAsText(messages, { color: false });
    expect(minimal).toBe("");

    const verbose = formatMessagesAsText(messages, { color: false, verbose: true });
    expect(verbose).toBe("");
  });

  it("collapses grouped tool activity in minimal mode and expands it in verbose mode", () => {
    const messages: ViewMessage[] = [
      {
        kind: "tool-call",
        id: "tc1",
        threadId: "t1",
        turnId: "turn-1",
        sourceSeqStart: 1,
        sourceSeqEnd: 1,
        createdAt: 1,
        startedAt: 1,
        toolName: "exec_command",
        callId: "call-1",
        command: "npm test",
        output: "ok",
        status: "completed",
      },
      {
        kind: "tool-call",
        id: "tc2",
        threadId: "t1",
        turnId: "turn-1",
        sourceSeqStart: 2,
        sourceSeqEnd: 2,
        createdAt: 2,
        startedAt: 2,
        toolName: "exec_command",
        callId: "call-2",
        command: "npm run lint",
        output: "clean",
        status: "completed",
      },
      {
        kind: "assistant-text",
        id: "a1",
        threadId: "t1",
        turnId: "turn-1",
        sourceSeqStart: 3,
        sourceSeqEnd: 3,
        createdAt: 3,
        text: "Tests pass.",
        status: "completed",
      },
    ];

    const minimal = formatMessagesAsText(messages, { color: false });
    expect(minimal).toContain("Worked on 2 items");
    expect(minimal).toContain("Assistant");
    expect(minimal).toContain("Tests pass.");
    expect(minimal).not.toContain("npm test");

    const verbose = formatMessagesAsText(messages, { color: false, verbose: true });
    expect(verbose).toContain("Worked on 2 items");
    expect(verbose).toContain("npm test");
    expect(verbose).toContain("npm run lint");
    expect(verbose).toContain("ok");
    expect(verbose).toContain("clean");
  });

  it("renders error as standalone terminal message, not grouped with preceding tasks", () => {
    const text = formatMessagesAsText(
      [
        {
          kind: "tasks",
          id: "tasks-1",
          threadId: "t1",
          turnId: "turn-1",
          sourceSeqStart: 1,
          sourceSeqEnd: 1,
          createdAt: 1,
          title: "Tasks updated",
          source: "todo",
          status: "completed",
          tasks: [{ text: "Run validation", status: "active" }],
        },
        {
          kind: "error",
          id: "error-1",
          threadId: "t1",
          turnId: "turn-1",
          sourceSeqStart: 2,
          sourceSeqEnd: 2,
          createdAt: 2,
          rawType: "provider/error",
          message: "Validation failed",
        },
      ],
      { color: false },
    );

    // Error is terminal — tasks before it gets collapsed into a group.
    expect(text).toContain("Worked on 1 item");
    expect(text).toContain("Validation failed");
  });

  it("formats grouped duration summaries without item-count suffixes", () => {
    const text = formatTimelineAsText(
      [
        {
          kind: "tool-group",
          id: "group-1",
          turnId: "turn-1",
          summaryCount: 22,
          sourceSeqStart: 1,
          sourceSeqEnd: 22,
          startedAt: 1,
          createdAt: 128_001,
          durationMs: 128_000,
          status: "completed",
          messages: [],
        },
      ],
      { color: false },
    );

    expect(text).toContain("Worked for 2m 8s");
    expect(text).not.toContain("22 items");
  });

  it("omits completed badges for warning operations", () => {
    const text = formatMessagesAsText(
      [
        {
          kind: "operation",
          id: "op-1",
          threadId: "t1",
          turnId: "turn-1",
          sourceSeqStart: 1,
          sourceSeqEnd: 1,
          createdAt: 1,
          opType: "warning",
          title: "Warning",
          detail: "Rate limit status updated",
          status: "completed",
        },
      ],
      { color: false },
    );

    expect(text).toContain("Operation: Warning");
    expect(text).toContain("Rate limit status updated");
    expect(text).not.toContain("✓");
  });

  it("renders delegation summaries from structured fields and shows full output in verbose mode", () => {
    const messages: ViewMessage[] = [
      {
        kind: "delegation",
        id: "d1",
        threadId: "t1",
        sourceSeqStart: 1,
        sourceSeqEnd: 1,
        createdAt: 1,
        toolName: "Agent",
        callId: "agent-1",
        status: "completed",
        subagentType: "Explore",
        description: "Inspect the docs tree",
        output: "## Findings\n\n- alpha\n- beta",
        childProjection: { entries: [] },
      },
    ];

    const minimal = formatMessagesAsText(messages, { color: false });
    expect(minimal).toContain("Subagent Explore: Inspect the docs tree");
    expect(minimal).toContain("## Findings");

    const verbose = formatMessagesAsText(messages, { color: false, verbose: true });
    expect(verbose).toContain("Subagent Explore: Inspect the docs tree");
    expect(verbose).toContain("## Findings");
    expect(verbose).toContain("- alpha");
    expect(verbose).toContain("- beta");
  });

  it("labels tasks consistently as Updated tasks", () => {
    const messages: ViewMessage[] = [
      {
        kind: "tasks",
        id: "tasks-1",
        threadId: "t1",
        sourceSeqStart: 1,
        sourceSeqEnd: 1,
        createdAt: 1,
        title: "Tasks updated",
        tasks: [
          { text: "Inspect docs", status: "completed" },
          { text: "Write summary", status: "active" },
        ],
      },
    ];

    const text = formatMessagesAsText(messages, { color: false });
    expect(text).toContain("Updated tasks");
    expect(text).not.toContain("Tasks updated");
    expect(text).toContain("Inspect docs");
    expect(text).toContain("Write summary");
  });
});
