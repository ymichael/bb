import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { toUIMessages } from "../src/to-ui-messages.js";
import type { ThreadEvent } from "../src/types.js";
import type { UIMessage } from "../src/ui-message.js";

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
  it("projects provider-envelope payloads with the same output as raw events", () => {
    const events: ThreadEvent[] = [
      {
        id: "evt-1",
        threadId: "thread-1",
        seq: 1,
        type: "item/completed",
        data: {
          __bb_provider_event: {
            schema: "beanbag/provider-event-envelope",
            version: 1,
            providerId: "codex",
            method: "item/completed",
            observedAt: 1,
          },
          payload: {
            threadId: "thread-1",
            turnId: "turn-1",
            item: {
              type: "agentMessage",
              id: "assistant-1",
              text: "Envelope output",
            },
          },
        },
        createdAt: 1,
      },
    ];

    const projected = toUIMessages(events, { threadStatus: "idle" });
    expect(projected).toHaveLength(1);
    expect(projected[0]?.kind).toBe("assistant-text");
    if (projected[0]?.kind === "assistant-text") {
      expect(projected[0].text).toBe("Envelope output");
      expect(projected[0].turnId).toBe("turn-1");
    }
  });

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

  it("updates flushed pending tool calls in place without appending duplicate interrupted rows", () => {
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
            command: "/bin/zsh -lc 'git rebase --continue'",
            status: "inProgress",
          },
          turnId: "turn-1",
        },
        createdAt: 1,
      },
      {
        id: "evt-2",
        threadId: "thread-1",
        seq: 2,
        type: "item/commandExecution/outputDelta",
        data: {
          threadId: "thread-1",
          turnId: "turn-1",
          itemId: "call-1",
          delta: "opened COMMIT_EDITMSG",
        },
        createdAt: 2,
      },
      {
        id: "evt-3",
        threadId: "thread-1",
        seq: 3,
        type: "item/reasoning/summaryTextDelta",
        data: {
          threadId: "thread-1",
          turnId: "turn-1",
          itemId: "rs-1",
          delta: "thinking",
        },
        createdAt: 3,
      },
    ];

    const projected = toUIMessages(events, { threadStatus: "idle" });
    const tools = projected.filter(
      (message): message is Extract<UIMessage, { kind: "tool-call" }> =>
        message.kind === "tool-call" && message.callId === "call-1",
    );

    expect(tools).toHaveLength(1);
    expect(tools[0]?.status).toBe("interrupted");
    expect(tools[0]?.output).toContain("opened COMMIT_EDITMSG");
    assertMonotonicSourceSeq(projected);
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
        type: "item/agentMessage/delta",
        data: {
          threadId: "thread-1",
          turnId: "turn-1",
          itemId: "msg-1",
          delta: "Partial reply",
        },
        createdAt: 1,
      },
      {
        id: "evt-2",
        threadId: "thread-1",
        seq: 2,
        type: "item/reasoning/summaryTextDelta",
        data: {
          threadId: "thread-1",
          turnId: "turn-1",
          itemId: "rs-1",
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
        type: "item/agentMessage/delta",
        data: {
          threadId: "thread-1",
          turnId: "turn-1",
          itemId: "msg-1",
          delta: "Partial reply",
        },
        createdAt: 1,
      },
      {
        id: "evt-2",
        threadId: "thread-1",
        seq: 2,
        type: "item/reasoning/summaryTextDelta",
        data: {
          threadId: "thread-1",
          turnId: "turn-1",
          itemId: "rs-1",
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
        type: "item/started",
        data: {
          item: {
            type: "commandExecution",
            id: "call-1",
            command: ["/bin/zsh", "-lc", "ls plans"],
            cwd: "/repo",
            status: "inProgress",
          },
          turnId: "turn-1",
        },
        createdAt: 1,
      },
      {
        id: "evt-2",
        threadId: "thread-1",
        seq: 2,
        type: "item/commandExecution/outputDelta",
        data: {
          threadId: "thread-1",
          turnId: "turn-1",
          itemId: "call-1",
          delta: "first\n",
        },
        createdAt: 2,
      },
      {
        id: "evt-3",
        threadId: "thread-1",
        seq: 3,
        type: "item/commandExecution/outputDelta",
        data: {
          threadId: "thread-1",
          turnId: "turn-1",
          itemId: "call-1",
          delta: "second\n",
        },
        createdAt: 3,
      },
      {
        id: "evt-4",
        threadId: "thread-1",
        seq: 4,
        type: "item/completed",
        data: {
          item: {
            type: "commandExecution",
            id: "call-1",
            command: ["/bin/zsh", "-lc", "ls plans"],
            aggregatedOutput: "first\nsecond\n",
            exitCode: 0,
            status: "completed",
          },
          turnId: "turn-1",
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

  it("coalesces consecutive exploring exec calls into one exploring cell", () => {
    const events: ThreadEvent[] = [
      {
        id: "evt-1",
        threadId: "thread-1",
        seq: 1,
        type: "exec_command_begin",
        data: {
          call_id: "call-1",
          turn_id: "turn-1",
          command: ["/bin/zsh", "-lc", "cat README.md"],
          cwd: "/repo",
          parsed_cmd: [
            {
              type: "read",
              cmd: "cat README.md",
              name: "README.md",
              path: "/repo/README.md",
            },
          ],
          source: "agent",
        },
        createdAt: 1,
      },
      {
        id: "evt-2",
        threadId: "thread-1",
        seq: 2,
        type: "exec_command_end",
        data: {
          call_id: "call-1",
          turn_id: "turn-1",
          command: ["/bin/zsh", "-lc", "cat README.md"],
          cwd: "/repo",
          parsed_cmd: [
            {
              type: "read",
              cmd: "cat README.md",
              name: "README.md",
              path: "/repo/README.md",
            },
          ],
          source: "agent",
          stdout: "",
          stderr: "",
          aggregated_output: "README",
          exit_code: 0,
          duration: "10ms",
          formatted_output: "README",
        },
        createdAt: 2,
      },
      {
        id: "evt-3",
        threadId: "thread-1",
        seq: 3,
        type: "exec_command_begin",
        data: {
          call_id: "call-2",
          turn_id: "turn-1",
          command: ["/bin/zsh", "-lc", "cat package.json"],
          cwd: "/repo",
          parsed_cmd: [
            {
              type: "read",
              cmd: "cat package.json",
              name: "package.json",
              path: "/repo/package.json",
            },
          ],
          source: "agent",
        },
        createdAt: 3,
      },
      {
        id: "evt-4",
        threadId: "thread-1",
        seq: 4,
        type: "exec_command_end",
        data: {
          call_id: "call-2",
          turn_id: "turn-1",
          command: ["/bin/zsh", "-lc", "cat package.json"],
          cwd: "/repo",
          parsed_cmd: [
            {
              type: "read",
              cmd: "cat package.json",
              name: "package.json",
              path: "/repo/package.json",
            },
          ],
          source: "agent",
          stdout: "",
          stderr: "",
          aggregated_output: "{}",
          exit_code: 0,
          duration: "8ms",
          formatted_output: "{}",
        },
        createdAt: 4,
      },
    ];

    const projected = toUIMessages(events, { threadStatus: "idle" });
    const exploringRows = projected.filter(
      (message): message is Extract<UIMessage, { kind: "tool-exploring" }> =>
        message.kind === "tool-exploring",
    );

    expect(exploringRows).toHaveLength(1);
    expect(exploringRows[0]?.calls).toHaveLength(2);
    expect(exploringRows[0]?.status).toBe("completed");
  });

  it("updates a flushed exploring cell when completion arrives later", () => {
    const events: ThreadEvent[] = [
      {
        id: "evt-1",
        threadId: "thread-1",
        seq: 1,
        type: "exec_command_begin",
        data: {
          call_id: "call-1",
          turn_id: "turn-1",
          command: ["/bin/zsh", "-lc", "cat README.md"],
          cwd: "/repo",
          parsed_cmd: [
            {
              type: "read",
              cmd: "cat README.md",
              name: "README.md",
              path: "/repo/README.md",
            },
          ],
          source: "agent",
          status: "pending",
        },
        createdAt: 1,
      },
      {
        id: "evt-2",
        threadId: "thread-1",
        seq: 2,
        type: "system/thread-title/updated",
        data: {
          turnId: "turn-1",
          title: "daemon restart bug",
          previousTitle: "threads - why is that?",
        },
        createdAt: 2,
      },
      {
        id: "evt-3",
        threadId: "thread-1",
        seq: 3,
        type: "exec_command_end",
        data: {
          call_id: "call-1",
          turn_id: "turn-1",
          command: ["/bin/zsh", "-lc", "cat README.md"],
          cwd: "/repo",
          parsed_cmd: [
            {
              type: "read",
              cmd: "cat README.md",
              name: "README.md",
              path: "/repo/README.md",
            },
          ],
          source: "agent",
          aggregated_output: "README",
          exit_code: 0,
          duration: "10ms",
          status: "completed",
        },
        createdAt: 3,
      },
    ];

    const projected = toUIMessages(events, { threadStatus: "active" });

    const exploringRows = projected.filter(
      (message): message is Extract<UIMessage, { kind: "tool-exploring" }> =>
        message.kind === "tool-exploring",
    );
    expect(exploringRows).toHaveLength(1);
    expect(exploringRows[0]?.status).toBe("completed");
    expect(exploringRows[0]?.sourceSeqStart).toBe(1);
    expect(exploringRows[0]?.sourceSeqEnd).toBe(3);
    expect(exploringRows[0]?.calls).toHaveLength(1);
    expect(exploringRows[0]?.calls[0]?.status).toBe("completed");
    expect(exploringRows[0]?.calls[0]?.sourceSeqEnd).toBe(3);
  });

  it("updates a flushed tool-call cell when completion arrives later", () => {
    const events: ThreadEvent[] = [
      {
        id: "evt-1",
        threadId: "thread-1",
        seq: 1,
        type: "exec_command_begin",
        data: {
          call_id: "call-1",
          turn_id: "turn-1",
          command: ["/bin/zsh", "-lc", "pnpm test"],
          cwd: "/repo",
          parsed_cmd: [{ type: "unknown", cmd: "pnpm test" }],
          source: "agent",
          status: "pending",
        },
        createdAt: 1,
      },
      {
        id: "evt-2",
        threadId: "thread-1",
        seq: 2,
        type: "system/thread-title/updated",
        data: {
          turnId: "turn-1",
          title: "new thread name",
        },
        createdAt: 2,
      },
      {
        id: "evt-3",
        threadId: "thread-1",
        seq: 3,
        type: "exec_command_end",
        data: {
          call_id: "call-1",
          turn_id: "turn-1",
          command: ["/bin/zsh", "-lc", "pnpm test"],
          cwd: "/repo",
          parsed_cmd: [{ type: "unknown", cmd: "pnpm test" }],
          source: "agent",
          aggregated_output: "ok",
          exit_code: 0,
          duration: "23ms",
          status: "completed",
        },
        createdAt: 3,
      },
    ];

    const projected = toUIMessages(events, { threadStatus: "active" });

    const toolCalls = projected.filter(
      (message): message is Extract<UIMessage, { kind: "tool-call" }> =>
        message.kind === "tool-call",
    );
    expect(toolCalls).toHaveLength(1);
    expect(toolCalls[0]?.status).toBe("completed");
    expect(toolCalls[0]?.sourceSeqStart).toBe(1);
    expect(toolCalls[0]?.sourceSeqEnd).toBe(3);
    expect(toolCalls[0]?.output).toBe("ok");
  });

  it("flushes completed non-exploring exec cells before assistant text", () => {
    const events: ThreadEvent[] = [
      {
        id: "evt-1",
        threadId: "thread-1",
        seq: 1,
        type: "exec_command_begin",
        data: {
          call_id: "call-1",
          turn_id: "turn-1",
          command: ["/bin/zsh", "-lc", "npm test"],
          cwd: "/repo",
          parsed_cmd: [{ type: "unknown", cmd: "npm test" }],
          source: "agent",
        },
        createdAt: 1,
      },
      {
        id: "evt-2",
        threadId: "thread-1",
        seq: 2,
        type: "exec_command_end",
        data: {
          call_id: "call-1",
          turn_id: "turn-1",
          command: ["/bin/zsh", "-lc", "npm test"],
          cwd: "/repo",
          parsed_cmd: [{ type: "unknown", cmd: "npm test" }],
          source: "agent",
          stdout: "",
          stderr: "",
          aggregated_output: "ok",
          exit_code: 0,
          duration: "123ms",
          formatted_output: "ok",
        },
        createdAt: 2,
      },
      {
        id: "evt-3",
        threadId: "thread-1",
        seq: 3,
        type: "item/completed",
        data: {
          threadId: "thread-1",
          turnId: "turn-1",
          item: {
            type: "agentMessage",
            id: "msg-1",
            text: "done",
          },
        },
        createdAt: 3,
      },
    ];

    const projected = toUIMessages(events, { threadStatus: "idle" });
    expect(projected.map((message) => message.kind)).toEqual([
      "tool-call",
      "assistant-text",
    ]);
  });

  it("projects web search begin/end as dedicated web-search cells", () => {
    const events: ThreadEvent[] = [
      {
        id: "evt-1",
        threadId: "thread-1",
        seq: 1,
        type: "web_search_begin",
        data: {
          call_id: "web-1",
        },
        createdAt: 1,
      },
      {
        id: "evt-2",
        threadId: "thread-1",
        seq: 2,
        type: "web_search_end",
        data: {
          call_id: "web-1",
          query: "react suspense",
          action: { type: "search", query: "react suspense" },
        },
        createdAt: 2,
      },
    ];

    const projected = toUIMessages(events, { threadStatus: "idle" });
    const search = projected.find(
      (message): message is Extract<UIMessage, { kind: "web-search" }> =>
        message.kind === "web-search",
    );

    expect(search).toBeDefined();
    expect(search?.status).toBe("completed");
    expect(search?.query).toBe("react suspense");
  });

  it("deduplicates duplicate web-search lifecycle events from item and codex streams", () => {
    const events: ThreadEvent[] = [
      {
        id: "evt-1",
        threadId: "thread-1",
        seq: 1,
        type: "item/started",
        data: {
          item: {
            type: "webSearch",
            id: "web-1",
            query: "",
            action: { type: "other" },
          },
          turnId: "turn-1",
        },
        createdAt: 1,
      },
      {
        id: "evt-2",
        threadId: "thread-1",
        seq: 2,
        type: "codex/event/web_search_begin",
        data: {
          msg: {
            type: "web_search_begin",
            call_id: "web-1",
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
            type: "webSearch",
            id: "web-1",
            query: "react suspense",
            action: { type: "search", query: "react suspense" },
          },
          turnId: "turn-1",
        },
        createdAt: 3,
      },
      {
        id: "evt-4",
        threadId: "thread-1",
        seq: 4,
        type: "codex/event/web_search_end",
        data: {
          msg: {
            type: "web_search_end",
            call_id: "web-1",
            query: "react suspense",
            action: { type: "search", query: "react suspense" },
          },
        },
        createdAt: 4,
      },
    ];

    const projected = toUIMessages(events, { threadStatus: "idle" });
    const searches = projected.filter(
      (message): message is Extract<UIMessage, { kind: "web-search" }> =>
        message.kind === "web-search",
    );

    expect(searches).toHaveLength(1);
    expect(searches[0]?.status).toBe("completed");
    expect(searches[0]?.query).toBe("react suspense");
  });

  it("preserves unknown provider web-search action types", () => {
    const events: ThreadEvent[] = [
      {
        id: "evt-1",
        threadId: "thread-1",
        seq: 1,
        type: "web_search_end",
        data: {
          call_id: "web-2",
          query: "new runtime action",
          action: { type: "providerCustomAction" },
        },
        createdAt: 1,
      },
    ];

    const projected = toUIMessages(events, { threadStatus: "idle" });
    const search = projected.find(
      (message): message is Extract<UIMessage, { kind: "web-search" }> =>
        message.kind === "web-search",
    );

    expect(search).toBeDefined();
    expect(search?.action).toBe("providerCustomAction");
  });

  it("merges file-change lifecycle with output delta details", () => {
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
        type: "item/fileChange/outputDelta",
        data: {
          threadId: "thread-1",
          turnId: "turn-1",
          itemId: "call-edit-1",
          delta: "patched",
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

  it("preserves add/delete file-change kinds from item completion events", () => {
    const events: ThreadEvent[] = [
      {
        id: "evt-1",
        threadId: "thread-1",
        seq: 1,
        type: "item/completed",
        data: {
          item: {
            type: "fileChange",
            id: "call-edit-2",
            status: "completed",
            changes: [
              {
                path: "/repo/src/new-file.ts",
                kind: { type: "add", move_path: null },
                diff: "export const created = true;\n",
              },
              {
                path: "/repo/src/old-file.ts",
                kind: { type: "delete", move_path: null },
                diff: "export const removed = true;\n",
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
    expect(op?.detail).toContain("• [In progress] Apply fix");
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

  it("projects system thread title updates as operations", () => {
    const events: ThreadEvent[] = [
      {
        id: "evt-1",
        threadId: "thread-1",
        seq: 1,
        type: "system/thread-title/updated",
        data: {
          title: "Fix collapsed groups",
          previousTitle: "Investigate slowness",
          source: "provider",
          providerMethod: "thread/started",
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
    expect(op?.opType).toBe("thread-title-updated");
    expect(op?.title).toBe("Title updated");
    expect(op?.detail).toBe("Investigate slowness → Fix collapsed groups");
  });

  it("projects provider thread name updates as operations", () => {
    const events: ThreadEvent[] = [
      {
        id: "evt-1",
        threadId: "thread-1",
        seq: 1,
        type: "thread/name/updated",
        data: {
          threadId: "thread-1",
          threadName: "Compaction summary title",
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
    expect(op?.opType).toBe("thread-title-updated");
    expect(op?.title).toBe("Title updated");
    expect(op?.detail).toBe("Compaction summary title");
  });

  it("deduplicates provider + system title update pairs", () => {
    const events: ThreadEvent[] = [
      {
        id: "evt-1",
        threadId: "thread-1",
        seq: 1,
        type: "thread/name/updated",
        data: {
          threadId: "thread-1",
          threadName: "Server-assigned title",
        },
        createdAt: 1,
      },
      {
        id: "evt-2",
        threadId: "thread-1",
        seq: 2,
        type: "system/thread-title/updated",
        data: {
          title: "Server-assigned title",
          previousTitle: "Old title",
          source: "provider",
          providerMethod: "thread/name/updated",
        },
        createdAt: 2,
      },
    ];

    const projected = toUIMessages(events);
    const ops = projected.filter(
      (message): message is Extract<UIMessage, { kind: "operation" }> =>
        message.kind === "operation",
    );

    expect(ops).toHaveLength(1);
    expect(ops[0]?.opType).toBe("thread-title-updated");
    expect(ops[0]?.detail).toBe("Server-assigned title");
  });

  it("projects compaction events as operations", () => {
    const events: ThreadEvent[] = [
      {
        id: "evt-1",
        threadId: "thread-1",
        seq: 1,
        type: "thread/compacted",
        data: {
          threadId: "thread-1",
          turnId: "turn-1",
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
    expect(op?.opType).toBe("compaction");
    expect(op?.title).toBe("Context compacted");
  });

  it("projects provisioning env setup events as operations", () => {
    const events: ThreadEvent[] = [
      {
        id: "evt-1",
        threadId: "thread-1",
        seq: 1,
        type: "system/provisioning/env_setup",
        data: {
          status: "started",
          scriptPath: ".bb-env-setup.sh",
          timeoutMs: 600000,
        },
        createdAt: 1,
      },
      {
        id: "evt-2",
        threadId: "thread-1",
        seq: 2,
        type: "system/provisioning/env_setup",
        data: {
          status: "completed",
          scriptPath: ".bb-env-setup.sh",
          durationMs: 125,
        },
        createdAt: 2,
      },
    ];

    const projected = toUIMessages(events);
    const ops = projected.filter(
      (message): message is Extract<UIMessage, { kind: "operation" }> =>
        message.kind === "operation",
    );

    expect(ops).toHaveLength(2);
    expect(ops[0]?.opType).toBe("provisioning-env-setup");
    expect(ops[0]?.title).toBe("Environment setup started");
    expect(ops[0]?.detail).toContain(".bb-env-setup.sh");
    expect(ops[1]?.opType).toBe("provisioning-env-setup");
    expect(ops[1]?.title).toBe("Environment setup completed");
    expect(ops[1]?.detail).toContain("Duration 125ms");
  });

  it("wraps unknown events in debug mode and drops them otherwise", () => {
    const events: ThreadEvent[] = [
      {
        id: "evt-1",
        threadId: "thread-1",
        seq: 1,
        type: "account/updated",
        data: {
          authMode: null,
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
      expect(withDebug[0].rawType).toBe("account/updated");
    }
  });

  it("classifies duplicate-event types but does not emit debug rows for them", () => {
    const events: ThreadEvent[] = [
      {
        id: "evt-1",
        threadId: "thread-1",
        seq: 1,
        type: "turn/started",
        data: {
          threadId: "thread-1",
          turn: {
            id: "turn-1",
            items: [],
            status: "inProgress",
            error: null,
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
          threadId: "thread-1",
          turn: { id: "turn-1", items: [], status: "inProgress", error: null },
        },
        createdAt: 1,
      },
      {
        id: "evt-2",
        threadId: "thread-1",
        seq: 2,
        type: "turn/started",
        data: {
          threadId: "thread-1",
          turn: { id: "turn-1", items: [], status: "inProgress", error: null },
        },
        createdAt: 2,
      },
      {
        id: "evt-3",
        threadId: "thread-1",
        seq: 3,
        type: "turn/completed",
        data: {
          threadId: "thread-1",
          turn: { id: "turn-1", items: [], status: "completed", error: null },
        },
        createdAt: 3,
      },
      {
        id: "evt-4",
        threadId: "thread-1",
        seq: 4,
        type: "turn/completed",
        data: {
          threadId: "thread-1",
          turn: { id: "turn-1", items: [], status: "completed", error: null },
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
        type: "item/completed",
        data: {
          threadId: "thread-1",
          turnId: "turn-1",
          item: {
            type: "userMessage",
            id: "user-1",
            content: [
              { type: "text", text: "First question" },
            ],
          },
        },
        createdAt: 1,
      },
      {
        id: "evt-2",
        threadId: "thread-1",
        seq: 2,
        type: "item/completed",
        data: {
          threadId: "thread-1",
          turnId: "turn-1",
          item: {
            type: "agentMessage",
            id: "msg-1",
            text: "Old assistant output",
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
          threadId: "thread-1",
          turnId: "turn-1",
          item: {
            type: "reasoning",
            id: "reasoning-2",
            summary: "More thinking",
          },
        },
        createdAt: 3,
      },
      {
        id: "evt-4",
        threadId: "thread-1",
        seq: 4,
        type: "item/completed",
        data: {
          threadId: "thread-1",
          turnId: "turn-1",
          item: {
            type: "agentMessage",
            id: "msg-2",
            text: "Latest assistant output",
          },
        },
        createdAt: 4,
      },
      {
        id: "evt-5",
        threadId: "thread-1",
        seq: 5,
        type: "item/completed",
        data: {
          threadId: "thread-1",
          turnId: "turn-2",
          item: {
            type: "userMessage",
            id: "user-2",
            content: [
              { type: "text", text: "Second question" },
            ],
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

  it("renders initial client thread input while provisioning has failed", () => {
    const events: ThreadEvent[] = [
      {
        id: "evt-1",
        threadId: "thread-1",
        seq: 1,
        type: "client/thread/start",
        data: {
          direction: "outbound",
          source: "spawn",
          initiator: "agent",
          input: [{ type: "text", text: "Fix the sidebar menu state bug" }],
          request: {
            method: "thread/start",
            params: {
              model: "gpt-5.3-codex",
            },
          },
          execution: {},
        },
        createdAt: 1,
      },
    ];

    const projected = toUIMessages(events, {
      threadStatus: "provisioning_failed",
    });

    expect(
      projected.some(
        (message) =>
          message.kind === "user" &&
          message.text.includes("Fix the sidebar menu state bug"),
      ),
    ).toBe(true);
  });

  it("renders initial client thread input while idle when no user item events exist", () => {
    const events: ThreadEvent[] = [
      {
        id: "evt-1",
        threadId: "thread-1",
        seq: 1,
        type: "client/thread/start",
        data: {
          direction: "outbound",
          source: "spawn",
          initiator: "agent",
          input: [{ type: "text", text: "Recover from provisioning failure" }],
          request: {
            method: "thread/start",
            params: {},
          },
          execution: {},
        },
        createdAt: 1,
      },
    ];

    const projected = toUIMessages(events, {
      threadStatus: "idle",
    });

    expect(
      projected.some(
        (message) =>
          message.kind === "user" &&
          message.text.includes("Recover from provisioning failure"),
      ),
    ).toBe(true);
  });

  it("renders follow-up client turn input while active when no user item events exist yet", () => {
    const events: ThreadEvent[] = [
      {
        id: "evt-1",
        threadId: "thread-1",
        seq: 1,
        type: "client/turn/start",
        data: {
          direction: "outbound",
          source: "tell",
          initiator: "agent",
          input: [{ type: "text", text: "Follow up fix for lag" }],
          request: {
            method: "turn/start",
            params: {},
          },
          execution: {},
        },
        createdAt: 1,
      },
    ];

    const projected = toUIMessages(events, {
      threadStatus: "active",
    });

    expect(
      projected.some(
        (message) =>
          message.kind === "user" &&
          message.text.includes("Follow up fix for lag"),
      ),
    ).toBe(true);
  });

  it("does not duplicate client thread input when a real user item event exists", () => {
    const events: ThreadEvent[] = [
      {
        id: "evt-1",
        threadId: "thread-1",
        seq: 1,
        type: "client/thread/start",
        data: {
          direction: "outbound",
          source: "spawn",
          initiator: "agent",
          input: [{ type: "text", text: "Fix duplicate user messages" }],
          request: {
            method: "thread/start",
            params: {},
          },
          execution: {},
        },
        createdAt: 1,
      },
      {
        id: "evt-2",
        threadId: "thread-1",
        seq: 2,
        type: "item/completed",
        data: {
          turnId: "turn-1",
          item: {
            id: "item-user-1",
            type: "user_message",
            content: [{ type: "text", text: "Fix duplicate user messages" }],
          },
        },
        createdAt: 2,
      },
    ];

    const projected = toUIMessages(events, {
      threadStatus: "idle",
    });
    const userMessages = projected.filter(
      (message): message is Extract<UIMessage, { kind: "user" }> =>
        message.kind === "user",
    );

    expect(userMessages).toHaveLength(1);
    expect(userMessages[0]?.id).not.toContain("user-seed");
    expect(userMessages[0]?.text).toBe("Fix duplicate user messages");
  });

  it("keeps non-duplicated initial client thread input alongside later user items", () => {
    const events: ThreadEvent[] = [
      {
        id: "evt-1",
        threadId: "thread-1",
        seq: 1,
        type: "client/thread/start",
        data: {
          direction: "outbound",
          source: "spawn",
          initiator: "agent",
          input: [{ type: "text", text: "Original failed prompt" }],
          request: {
            method: "thread/start",
            params: {},
          },
          execution: {},
        },
        createdAt: 1,
      },
      {
        id: "evt-2",
        threadId: "thread-1",
        seq: 2,
        type: "item/completed",
        data: {
          turnId: "turn-2",
          item: {
            id: "item-user-2",
            type: "user_message",
            content: [{ type: "text", text: "sanity retry" }],
          },
        },
        createdAt: 2,
      },
    ];

    const projected = toUIMessages(events, {
      threadStatus: "idle",
    });
    const userMessages = projected.filter(
      (message): message is Extract<UIMessage, { kind: "user" }> =>
        message.kind === "user",
    );

    expect(userMessages).toHaveLength(2);
    expect(userMessages.some((message) => message.text === "Original failed prompt")).toBe(true);
    expect(userMessages.some((message) => message.text === "sanity retry")).toBe(true);
  });

  it("preserves user attachment paths and urls from client start input", () => {
    const events: ThreadEvent[] = [
      {
        id: "evt-1",
        threadId: "thread-1",
        seq: 1,
        type: "client/thread/start",
        data: {
          direction: "outbound",
          source: "spawn",
          initiator: "agent",
          input: [
            { type: "text", text: "check these" },
            { type: "image", url: "https://example.com/a.png" },
            { type: "localImage", path: "/tmp/local-a.png" },
            { type: "localFile", path: "/tmp/notes.md" },
          ],
          request: {
            method: "thread/start",
            params: {},
          },
          execution: {},
        },
        createdAt: 1,
      },
    ];

    const projected = toUIMessages(events, {
      threadStatus: "idle",
    });
    const user = projected.find(
      (message): message is Extract<UIMessage, { kind: "user" }> =>
        message.kind === "user",
    );

    expect(user).toBeDefined();
    expect(user?.attachments?.imageUrls).toEqual(["https://example.com/a.png"]);
    expect(user?.attachments?.localImagePaths).toEqual(["/tmp/local-a.png"]);
    expect(user?.attachments?.localFilePaths).toEqual(["/tmp/notes.md"]);
  });

  it("deduplicates client start input when codex user_message exists", () => {
    const events: ThreadEvent[] = [
      {
        id: "evt-1",
        threadId: "thread-1",
        seq: 1,
        type: "client/thread/start",
        data: {
          direction: "outbound",
          source: "spawn",
          initiator: "agent",
          input: [
            { type: "text", text: "Check screenshot" },
            { type: "localImage", path: "/tmp/shot.png" },
          ],
          request: {
            method: "thread/start",
            params: {},
          },
          execution: {},
        },
        createdAt: 1,
      },
      {
        id: "evt-2",
        threadId: "thread-1",
        seq: 2,
        type: "codex/event/user_message",
        data: {
          id: "turn-1",
          msg: {
            type: "user_message",
            message: "Check screenshot",
            images: [],
            local_images: ["/tmp/shot.png"],
            text_elements: [],
          },
        },
        createdAt: 2,
      },
    ];

    const projected = toUIMessages(events, {
      threadStatus: "idle",
    });
    const users = projected.filter(
      (message): message is Extract<UIMessage, { kind: "user" }> =>
        message.kind === "user",
    );

    expect(users).toHaveLength(1);
    expect(users[0]?.attachments?.localImagePaths).toEqual(["/tmp/shot.png"]);
  });

  it("deduplicates client start localImage against provider userMessage image data URL", () => {
    const events: ThreadEvent[] = [
      {
        id: "evt-1",
        threadId: "thread-1",
        seq: 1,
        type: "client/turn/start",
        data: {
          direction: "outbound",
          source: "tell",
          initiator: "agent",
          input: [
            { type: "text", text: "why is the theme selector not all the way to the right?" },
            { type: "localImage", path: "/tmp/shot.png" },
          ],
          request: {
            method: "turn/start",
            params: {},
          },
          execution: {},
        },
        createdAt: 1,
      },
      {
        id: "evt-2",
        threadId: "thread-1",
        seq: 2,
        type: "item/started",
        data: {
          turnId: "turn-1",
          item: {
            id: "item-user-1",
            type: "user_message",
            content: [
              { type: "text", text: "why is the theme selector not all the way to the right?" },
              { type: "image", url: "data:image/png;base64,abc" },
            ],
          },
        },
        createdAt: 2,
      },
    ];

    const projected = toUIMessages(events, {
      threadStatus: "active",
    });
    const users = projected.filter(
      (message): message is Extract<UIMessage, { kind: "user" }> =>
        message.kind === "user",
    );

    expect(users).toHaveLength(1);
    expect(users[0]?.attachments?.webImages).toBe(1);
  });

  it("formats system error messages with detail", () => {
    const events: ThreadEvent[] = [
      {
        id: "evt-1",
        threadId: "thread-1",
        seq: 1,
        type: "system/error",
        data: {
          code: "project_root_missing",
          message: "Project folder not found: /Users/michael/Projects/beanbag",
          detail:
            "This project points to a folder that no longer exists. Update the project path and retry.",
        },
        createdAt: 1,
      },
    ];

    const projected = toUIMessages(events, {
      threadStatus: "provisioning_failed",
    });
    const error = projected.find(
      (message): message is Extract<UIMessage, { kind: "error" }> =>
        message.kind === "error",
    );

    expect(error).toBeDefined();
    expect(error?.message).toContain("Project folder not found");
    expect(error?.message).toContain("Update the project path and retry");
  });
});
