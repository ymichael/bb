import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { toUIMessages, type ThreadEvent, type UIMessage } from "@beanbag/core";

function fixturePath(name: string): string {
  const __dirname = path.dirname(fileURLToPath(import.meta.url));
  return path.join(__dirname, "__fixtures__", name);
}

function loadFixture(name: string): ThreadEvent[] {
  return JSON.parse(readFileSync(fixturePath(name), "utf8")) as ThreadEvent[];
}

function unique<T>(values: T[]): T[] {
  return [...new Set(values)];
}

function assertMonotonicSourceSeq(messages: UIMessage[]): void {
  for (let i = 1; i < messages.length; i += 1) {
    const prev = messages[i - 1];
    const next = messages[i];
    expect(prev).toBeDefined();
    expect(next).toBeDefined();
    if (!prev || !next) continue;
    expect(next.sourceSeqStart).toBeGreaterThanOrEqual(prev.sourceSeqStart);
  }
}

describe("toUIMessages replay coverage", () => {
  it("projects the direct raw-events fixture with stable, deduplicated output", () => {
    const events = loadFixture("thread-JQh4-pAyGlgHLACZ8AXY2-events.json");
    expect(events.length).toBeGreaterThan(500);

    const projected = toUIMessages(events);
    const projectedAgain = toUIMessages(events);

    expect(projected.length).toBeGreaterThan(0);
    expect(projected.map((message) => message.id)).toEqual(
      projectedAgain.map((message) => message.id),
    );

    const kinds = unique(projected.map((message) => message.kind));
    expect(kinds).toContain("user");
    expect(kinds).toContain("assistant-text");

    expect(projected.some((message) => message.kind === "debug/raw-event")).toBe(
      false,
    );

    const userMessages = projected.filter(
      (message): message is Extract<UIMessage, { kind: "user" }> =>
        message.kind === "user",
    );
    if (userMessages.length > 0) {
      const userTurnIds = userMessages
        .map((message) => message.turnId)
        .filter((value): value is string => typeof value === "string");
      expect(unique(userTurnIds).length).toBe(userTurnIds.length);
    }

    assertMonotonicSourceSeq(projected);
  });

  it("projects wrapped provider/event fixture with tool, file edit, and operation coverage", () => {
    const events = loadFixture("thread-krCVJ3aDzp5kmOS44wilS-events.json");
    expect(events.length).toBeGreaterThan(1500);
    expect(events.some((event) => event.type === "provider/event")).toBe(true);

    const projected = toUIMessages(events);

    const kinds = unique(projected.map((message) => message.kind));
    expect(kinds).toContain("user");
    expect(kinds).toContain("assistant-text");

    const operations = projected.filter(
      (message): message is Extract<UIMessage, { kind: "operation" }> =>
        message.kind === "operation",
    );
    expect(operations.some((op) => op.opType === "task-started")).toBe(false);

    expect(projected.some((message) => message.kind === "debug/raw-event")).toBe(
      false,
    );

    assertMonotonicSourceSeq(projected);
  });

  it("emits only unhandled debug wrappers when requested", () => {
    const events = loadFixture("thread-krCVJ3aDzp5kmOS44wilS-events.json");
    const projected = toUIMessages(events, {
      includeDebugRawEvents: true,
    });

    const debugRows = projected.filter(
      (message): message is Extract<UIMessage, { kind: "debug/raw-event" }> =>
        message.kind === "debug/raw-event",
    );

    expect(debugRows.some((row) => row.reason === "ignored-noise")).toBe(false);
    expect(debugRows.some((row) => row.reason === "duplicate-event")).toBe(false);
    expect(debugRows.every((row) => row.reason === "unhandled")).toBe(true);
  });

  it("marks incomplete tools as interrupted when thread is not active", () => {
    const events: ThreadEvent[] = [
      {
        id: "evt-1",
        threadId: "thread-1",
        seq: 1,
        type: "item/started",
        data: {
          item: {
            type: "commandExecution",
            id: "call-1",
            command: "/bin/zsh -lc 'ls plans'",
            status: "inProgress",
          },
          turnId: "turn-1",
        },
        createdAt: 1,
      },
    ];

    const projected = toUIMessages(events, { threadStatus: "idle" });
    const tool = projected.find(
      (message): message is Extract<UIMessage, { kind: "tool-call" }> =>
        message.kind === "tool-call",
    );

    expect(tool).toBeDefined();
    expect(tool?.status).toBe("interrupted");
    expect(tool?.output).toContain("interrupted");
  });

  it("keeps in-progress tools pending for active threads", () => {
    const events: ThreadEvent[] = [
      {
        id: "evt-1",
        threadId: "thread-1",
        seq: 1,
        type: "item/started",
        data: {
          item: {
            type: "commandExecution",
            id: "call-1",
            command: "/bin/zsh -lc 'ls plans'",
            status: "inProgress",
          },
          turnId: "turn-1",
        },
        createdAt: 1,
      },
    ];

    const projected = toUIMessages(events, { threadStatus: "active" });
    const tool = projected.find(
      (message): message is Extract<UIMessage, { kind: "tool-call" }> =>
        message.kind === "tool-call",
    );

    expect(tool).toBeDefined();
    expect(tool?.status).toBe("pending");
  });

  it("finalizes streaming assistant and reasoning messages when thread is idle", () => {
    const events: ThreadEvent[] = [
      {
        id: "evt-1",
        threadId: "thread-1",
        seq: 1,
        type: "message/assistant/delta",
        data: {
          role: "assistant",
          turnId: "turn-1",
          itemId: "msg-1",
          text: "Partial reply",
          delta: "Partial reply",
        },
        createdAt: 1,
      },
      {
        id: "evt-2",
        threadId: "thread-1",
        seq: 2,
        type: "message/reasoning/delta",
        data: {
          role: "assistant",
          kind: "reasoning",
          turnId: "turn-1",
          itemId: "rs-1",
          text: "Partial reasoning",
          delta: "Partial reasoning",
        },
        createdAt: 2,
      },
    ];

    const projected = toUIMessages(events, { threadStatus: "idle" });
    const assistant = projected.find(
      (message): message is Extract<UIMessage, { kind: "assistant-text" }> =>
        message.kind === "assistant-text",
    );
    const reasoning = projected.find(
      (message): message is Extract<UIMessage, { kind: "assistant-reasoning" }> =>
        message.kind === "assistant-reasoning",
    );

    expect(assistant).toBeDefined();
    expect(assistant?.status).toBe("completed");
    expect(reasoning).toBeDefined();
    expect(reasoning?.status).toBe("completed");
    expect(
      projected.some(
        (message) =>
          (message.kind === "assistant-text" ||
            message.kind === "assistant-reasoning") &&
          message.status === "streaming",
      ),
    ).toBe(false);
  });

  it("keeps assistant and reasoning deltas streaming while thread is active", () => {
    const events: ThreadEvent[] = [
      {
        id: "evt-1",
        threadId: "thread-1",
        seq: 1,
        type: "message/assistant/delta",
        data: {
          role: "assistant",
          turnId: "turn-1",
          itemId: "msg-1",
          text: "Partial reply",
          delta: "Partial reply",
        },
        createdAt: 1,
      },
      {
        id: "evt-2",
        threadId: "thread-1",
        seq: 2,
        type: "message/reasoning/delta",
        data: {
          role: "assistant",
          kind: "reasoning",
          turnId: "turn-1",
          itemId: "rs-1",
          text: "Partial reasoning",
          delta: "Partial reasoning",
        },
        createdAt: 2,
      },
    ];

    const projected = toUIMessages(events, { threadStatus: "active" });
    const assistant = projected.find(
      (message): message is Extract<UIMessage, { kind: "assistant-text" }> =>
        message.kind === "assistant-text",
    );
    const reasoning = projected.find(
      (message): message is Extract<UIMessage, { kind: "assistant-reasoning" }> =>
        message.kind === "assistant-reasoning",
    );

    expect(assistant).toBeDefined();
    expect(assistant?.status).toBe("streaming");
    expect(reasoning).toBeDefined();
    expect(reasoning?.status).toBe("streaming");
  });

  it("coalesces command output deltas and completion state", () => {
    const events: ThreadEvent[] = [
      {
        id: "evt-1",
        threadId: "thread-1",
        seq: 1,
        type: "codex/event/exec_command_begin",
        data: {
          id: "1",
          msg: {
            call_id: "call-1",
            command: ["/bin/zsh", "-lc", "ls plans"],
            cwd: "/repo",
          },
        },
        createdAt: 1,
      },
      {
        id: "evt-2",
        threadId: "thread-1",
        seq: 2,
        type: "codex/event/exec_command_output_delta",
        data: {
          id: "1",
          msg: {
            call_id: "call-1",
            delta: "first\n",
          },
        },
        createdAt: 2,
      },
      {
        id: "evt-3",
        threadId: "thread-1",
        seq: 3,
        type: "codex/event/exec_command_output_delta",
        data: {
          id: "1",
          msg: {
            call_id: "call-1",
            delta: "second\n",
          },
        },
        createdAt: 3,
      },
      {
        id: "evt-4",
        threadId: "thread-1",
        seq: 4,
        type: "codex/event/exec_command_end",
        data: {
          id: "1",
          msg: {
            call_id: "call-1",
            aggregated_output: "first\nsecond\n",
            exit_code: 0,
          },
        },
        createdAt: 4,
      },
    ];

    const projected = toUIMessages(events, { threadStatus: "idle" });
    const tool = projected.find(
      (message): message is Extract<UIMessage, { kind: "tool-call" }> =>
        message.kind === "tool-call",
    );

    expect(tool).toBeDefined();
    expect(tool?.status).toBe("completed");
    expect(tool?.output).toContain("first");
    expect(tool?.output).toContain("second");
  });

  it("merges file-change lifecycle with patch payload details", () => {
    const events: ThreadEvent[] = [
      {
        id: "evt-1",
        threadId: "thread-1",
        seq: 1,
        type: "item/started",
        data: {
          item: {
            type: "fileChange",
            id: "call-edit-1",
            status: "inProgress",
            changes: [
              {
                path: "/repo/src/a.ts",
                kind: { type: "update", move_path: null },
                diff: "@@ -1 +1 @@",
              },
            ],
          },
          turnId: "turn-1",
        },
        createdAt: 1,
      },
      {
        id: "evt-2",
        threadId: "thread-1",
        seq: 2,
        type: "codex/event/patch_apply_end",
        data: {
          id: "1",
          msg: {
            call_id: "call-edit-1",
            success: true,
            stdout: "patched",
            changes: {
              "/repo/src/a.ts": {
                type: "update",
                unified_diff: "@@ -1 +1,2 @@",
                move_path: null,
              },
            },
          },
        },
        createdAt: 2,
      },
      {
        id: "evt-3",
        threadId: "thread-1",
        seq: 3,
        type: "item/completed",
        data: {
          item: {
            type: "fileChange",
            id: "call-edit-1",
            status: "completed",
            changes: [
              {
                path: "/repo/src/a.ts",
                kind: { type: "update", move_path: null },
                diff: "@@ -1 +1,2 @@",
              },
            ],
          },
          turnId: "turn-1",
        },
        createdAt: 3,
      },
    ];

    const projected = toUIMessages(events, { threadStatus: "idle" });
    const fileEdit = projected.find(
      (message): message is Extract<UIMessage, { kind: "file-edit" }> =>
        message.kind === "file-edit",
    );

    expect(fileEdit).toBeDefined();
    expect(fileEdit?.status).toBe("completed");
    expect(fileEdit?.changes).toHaveLength(1);
    expect(fileEdit?.changes[0]?.path).toBe("/repo/src/a.ts");
    expect(fileEdit?.stdout).toContain("patched");
  });

  it("maps declined command executions to interrupted status", () => {
    const events: ThreadEvent[] = [
      {
        id: "evt-1",
        threadId: "thread-1",
        seq: 1,
        type: "item/completed",
        data: {
          item: {
            type: "commandExecution",
            id: "call-declined-1",
            status: "declined",
            command: "/bin/zsh -lc 'rm -rf /tmp/nope'",
          },
          turnId: "turn-1",
        },
        createdAt: 1,
      },
    ];

    const projected = toUIMessages(events, { threadStatus: "idle" });
    const tool = projected.find(
      (message): message is Extract<UIMessage, { kind: "tool-call" }> =>
        message.kind === "tool-call",
    );

    expect(tool).toBeDefined();
    expect(tool?.status).toBe("interrupted");
  });

  it("maps declined file changes to interrupted status", () => {
    const events: ThreadEvent[] = [
      {
        id: "evt-1",
        threadId: "thread-1",
        seq: 1,
        type: "item/completed",
        data: {
          item: {
            type: "fileChange",
            id: "file-declined-1",
            status: "declined",
            changes: [
              {
                path: "/repo/src/example.ts",
                kind: { type: "update", move_path: null },
                diff: "@@ -1 +1 @@",
              },
            ],
          },
          turnId: "turn-1",
        },
        createdAt: 1,
      },
    ];

    const projected = toUIMessages(events, { threadStatus: "idle" });
    const fileEdit = projected.find(
      (message): message is Extract<UIMessage, { kind: "file-edit" }> =>
        message.kind === "file-edit",
    );

    expect(fileEdit).toBeDefined();
    expect(fileEdit?.status).toBe("interrupted");
  });

  it("preserves add/delete patch kinds from patch_apply events", () => {
    const events: ThreadEvent[] = [
      {
        id: "evt-1",
        threadId: "thread-1",
        seq: 1,
        type: "codex/event/patch_apply_end",
        data: {
          id: "1",
          msg: {
            call_id: "call-edit-2",
            success: true,
            changes: {
              "/repo/src/new-file.ts": {
                type: "add",
                content: "export const created = true;\n",
              },
              "/repo/src/old-file.ts": {
                type: "delete",
                content: "export const removed = true;\n",
              },
            },
          },
        },
        createdAt: 1,
      },
    ];

    const projected = toUIMessages(events, { threadStatus: "idle" });
    const fileEdit = projected.find(
      (message): message is Extract<UIMessage, { kind: "file-edit" }> =>
        message.kind === "file-edit",
    );

    expect(fileEdit).toBeDefined();
    expect(fileEdit?.changes).toHaveLength(2);
    expect(fileEdit?.changes.find((change) => change.path.endsWith("new-file.ts"))?.kind).toBe(
      "add",
    );
    expect(fileEdit?.changes.find((change) => change.path.endsWith("old-file.ts"))?.kind).toBe(
      "delete",
    );
  });

  it("projects turn plan updates as operation rows", () => {
    const events: ThreadEvent[] = [
      {
        id: "evt-1",
        threadId: "thread-1",
        seq: 1,
        type: "turn/plan/updated",
        data: {
          threadId: "thread-1",
          turnId: "turn-1",
          explanation: "Plan is now clearer",
          plan: [
            { step: "Inspect project", status: "completed" },
            { step: "Apply fix", status: "inProgress" },
          ],
        },
        createdAt: 1,
      },
    ];

    const projected = toUIMessages(events);
    const op = projected.find(
      (message): message is Extract<UIMessage, { kind: "operation" }> =>
        message.kind === "operation",
    );

    expect(op).toBeDefined();
    expect(op?.opType).toBe("plan-updated");
    expect(op?.title).toBe("Plan updated");
    expect(op?.detail).toContain("Plan is now clearer");
  });

  it("treats raw reasoning text deltas as reasoning stream updates", () => {
    const events: ThreadEvent[] = [
      {
        id: "evt-1",
        threadId: "thread-1",
        seq: 1,
        type: "item/reasoning/textDelta",
        data: {
          threadId: "thread-1",
          turnId: "turn-1",
          itemId: "reasoning-1",
          delta: "raw-reasoning",
          contentIndex: 0,
        },
        createdAt: 1,
      },
    ];

    const projected = toUIMessages(events, { threadStatus: "active" });
    const reasoning = projected.find(
      (message): message is Extract<UIMessage, { kind: "assistant-reasoning" }> =>
        message.kind === "assistant-reasoning",
    );

    expect(reasoning).toBeDefined();
    expect(reasoning?.text).toContain("raw-reasoning");
    expect(reasoning?.status).toBe("streaming");
  });

  it("projects deprecation and config warnings as operations", () => {
    const events: ThreadEvent[] = [
      {
        id: "evt-1",
        threadId: "thread-1",
        seq: 1,
        type: "deprecationNotice",
        data: {
          summary: "Legacy API will be removed",
          details: "Use v2 APIs instead",
        },
        createdAt: 1,
      },
      {
        id: "evt-2",
        threadId: "thread-1",
        seq: 2,
        type: "configWarning",
        data: {
          summary: "Unknown config key",
          details: "Remove 'legacyFlag'",
        },
        createdAt: 2,
      },
    ];

    const projected = toUIMessages(events);
    const ops = projected.filter(
      (message): message is Extract<UIMessage, { kind: "operation" }> =>
        message.kind === "operation",
    );

    expect(ops.some((message) => message.opType === "deprecation")).toBe(true);
    expect(ops.some((message) => message.opType === "warning")).toBe(true);
  });

  it("wraps unknown events in debug mode and drops them otherwise", () => {
    const events: ThreadEvent[] = [
      {
        id: "evt-1",
        threadId: "thread-1",
        seq: 1,
        type: "codex/event/new_thing",
        data: {
          id: "1",
          msg: {
            detail: "future event",
          },
        },
        createdAt: 1,
      },
    ];

    expect(toUIMessages(events)).toEqual([]);

    const withDebug = toUIMessages(events, { includeDebugRawEvents: true });
    expect(withDebug).toHaveLength(1);
    expect(withDebug[0]?.kind).toBe("debug/raw-event");
    if (withDebug[0]?.kind === "debug/raw-event") {
      expect(withDebug[0].reason).toBe("unhandled");
      expect(withDebug[0].rawType).toBe("codex/event/new_thing");
    }
  });

  it("classifies duplicate-event types but does not emit debug rows for them", () => {
    const events: ThreadEvent[] = [
      {
        id: "evt-1",
        threadId: "thread-1",
        seq: 1,
        type: "provider/event",
        data: {
          provider: "codex",
          providerEventType: "codex/event/reasoning_content_delta",
          payload: {
            id: "1",
            msg: {
              type: "reasoning_content_delta",
              delta: "hello",
            },
          },
        },
        createdAt: 1,
      },
    ];

    const withDebug = toUIMessages(events, { includeDebugRawEvents: true });
    expect(withDebug).toEqual([]);
  });

  it("drops turn/task lifecycle duplicates in debug mode", () => {
    const events: ThreadEvent[] = [
      {
        id: "evt-1",
        threadId: "thread-1",
        seq: 1,
        type: "turn/started",
        data: {
          turn: { id: "turn-1" },
        },
        createdAt: 1,
      },
      {
        id: "evt-2",
        threadId: "thread-1",
        seq: 2,
        type: "provider/event",
        data: {
          provider: "codex",
          providerEventType: "codex/event/task_started",
          payload: {
            id: "turn-1",
            msg: {
              type: "task_started",
            },
          },
        },
        createdAt: 2,
      },
      {
        id: "evt-3",
        threadId: "thread-1",
        seq: 3,
        type: "turn/completed",
        data: {
          turn: { id: "turn-1", status: "completed" },
        },
        createdAt: 3,
      },
      {
        id: "evt-4",
        threadId: "thread-1",
        seq: 4,
        type: "provider/event",
        data: {
          provider: "codex",
          providerEventType: "codex/event/task_complete",
          payload: {
            id: "turn-1",
            msg: {
              type: "task_complete",
            },
          },
        },
        createdAt: 4,
      },
    ];

    const withDebug = toUIMessages(events, { includeDebugRawEvents: true });
    expect(withDebug).toEqual([]);
  });

  it("drops structural item/started noise in debug mode", () => {
    const events: ThreadEvent[] = [
      {
        id: "evt-1",
        threadId: "thread-1",
        seq: 1,
        type: "item/started",
        data: {
          item: { type: "reasoning", id: "rs-1", summary: [], content: [] },
          turnId: "turn-1",
        },
        createdAt: 1,
      },
      {
        id: "evt-2",
        threadId: "thread-1",
        seq: 2,
        type: "item/started",
        data: {
          item: { type: "agentMessage", id: "msg-1", text: "" },
          turnId: "turn-1",
        },
        createdAt: 2,
      },
    ];

    const withDebug = toUIMessages(events, { includeDebugRawEvents: true });
    expect(withDebug).toEqual([]);
  });

  it("drops reasoning section markers in debug mode", () => {
    const events: ThreadEvent[] = [
      {
        id: "evt-1",
        threadId: "thread-1",
        seq: 1,
        type: "codex/event/agent_reasoning_section_break",
        data: {
          id: "1",
          msg: {
            type: "agent_reasoning_section_break",
            item_id: "rs-1",
            summary_index: 0,
          },
        },
        createdAt: 1,
      },
      {
        id: "evt-2",
        threadId: "thread-1",
        seq: 2,
        type: "item/reasoning/summaryPartAdded",
        data: {
          threadId: "thread-1",
          turnId: "turn-1",
          itemId: "rs-1",
          summaryIndex: 0,
        },
        createdAt: 2,
      },
    ];

    const withDebug = toUIMessages(events, { includeDebugRawEvents: true });
    expect(withDebug).toEqual([]);
  });

  it("keeps assistant-side items from earlier and later assistant responses", () => {
    const events: ThreadEvent[] = [
      {
        id: "evt-1",
        threadId: "thread-1",
        seq: 1,
        type: "codex/event/user_message",
        data: {
          id: "turn-1",
          msg: {
            type: "user_message",
            message: "First question",
            images: [],
            local_images: [],
          },
        },
        createdAt: 1,
      },
      {
        id: "evt-2",
        threadId: "thread-1",
        seq: 2,
        type: "message/assistant",
        data: {
          role: "assistant",
          turnId: "turn-1",
          itemId: "msg-1",
          text: "Old assistant output",
        },
        createdAt: 2,
      },
      {
        id: "evt-3",
        threadId: "thread-1",
        seq: 3,
        type: "message/reasoning",
        data: {
          role: "assistant",
          kind: "reasoning",
          turnId: "turn-1",
          itemId: "reasoning-2",
          text: "More thinking",
        },
        createdAt: 3,
      },
      {
        id: "evt-4",
        threadId: "thread-1",
        seq: 4,
        type: "message/assistant",
        data: {
          role: "assistant",
          turnId: "turn-1",
          itemId: "msg-2",
          text: "Latest assistant output",
        },
        createdAt: 4,
      },
      {
        id: "evt-5",
        threadId: "thread-1",
        seq: 5,
        type: "codex/event/user_message",
        data: {
          id: "turn-2",
          msg: {
            type: "user_message",
            message: "Second question",
            images: [],
            local_images: [],
          },
        },
        createdAt: 5,
      },
    ];

    const projected = toUIMessages(events);

    expect(
      projected.some(
        (message) =>
          message.kind === "user" &&
          message.turnId === "turn-1" &&
          message.text.includes("First question"),
      ),
    ).toBe(true);
    expect(
      projected.some(
        (message) =>
          message.kind === "assistant-text" &&
          message.turnId === "turn-1" &&
          message.text.includes("Old assistant output"),
      ),
    ).toBe(true);
    expect(
      projected.some(
        (message) =>
          message.turnId === "turn-1" &&
          message.kind === "assistant-reasoning" &&
          message.text.includes("More thinking"),
      ),
    ).toBe(true);
    expect(
      projected.some(
        (message) =>
          message.kind === "assistant-text" &&
          message.turnId === "turn-1" &&
          message.text.includes("Latest assistant output"),
      ),
    ).toBe(true);
    expect(
      projected.some(
        (message) =>
          message.kind === "user" &&
          message.turnId === "turn-2" &&
          message.text.includes("Second question"),
      ),
    ).toBe(true);
  });
});
