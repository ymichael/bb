import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { toUIMessages } from "../src/to-ui-messages.js";
import { buildThreadDetailRows } from "../src/thread-detail-rows.js";
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
            schema: "bb/provider-event-envelope",
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

  it("deduplicates repeated completed assistant final messages for the same item id", () => {
    const events: ThreadEvent[] = [
      {
        id: "evt-1",
        threadId: "thread-1",
        seq: 1,
        type: "item/completed",
        data: {
          __bb_provider_event: {
            schema: "bb/provider-event-envelope",
            version: 1,
            providerId: "codex",
            method: "item/completed",
            observedAt: 1,
          },
          payload: {
            threadId: "provider-thread-1",
            turnId: "turn-1",
            item: {
              type: "agentMessage",
              id: "assistant-1",
              text: "Hello",
              phase: "final_answer",
            },
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
          __bb_provider_event: {
            schema: "bb/provider-event-envelope",
            version: 1,
            providerId: "codex",
            method: "item/completed",
            observedAt: 2,
          },
          payload: {
            threadId: "provider-thread-1",
            turnId: "turn-1",
            item: {
              type: "agentMessage",
              id: "assistant-1",
              text: "Hello",
              phase: "final_answer",
            },
          },
        },
        createdAt: 2,
      },
    ];

    const projected = toUIMessages(events, { threadStatus: "idle" });
    const assistantMessages = projected.filter(
      (message): message is Extract<UIMessage, { kind: "assistant-text" }> =>
        message.kind === "assistant-text",
    );

    expect(assistantMessages).toHaveLength(1);
    expect(assistantMessages[0]?.text).toBe("Hello");
  });

  it("projects the direct raw-events fixture with stable, deduplicated output", () => {
    const events = loadFixture("thread-JQh4-pAyGlgHLACZ8AXY2-events.json");
    expect(events.length).toBeGreaterThan(500);

    const projected = toUIMessages(events, {
      threadStatus: "active",
    });
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
    expect(tool?.command).toBe("ls plans");
    expect(tool?.status).toBe("interrupted");
    expect(tool?.output).toContain("interrupted");
  });

  it("strips shell wrappers from string-form exec command lifecycle events", () => {
    const events: ThreadEvent[] = [
      {
        id: "evt-1",
        threadId: "thread-1",
        seq: 1,
        type: "exec_command_begin",
        data: {
          call_id: "call-1",
          turn_id: "turn-1",
          command: '/bin/bash -lc "npm test -- --runInBand"',
          cwd: "/repo",
          parsed_cmd: [{ type: "unknown", cmd: "npm test -- --runInBand" }],
          source: "agent",
          status: "pending",
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
          command: '/bin/bash -lc "npm test -- --runInBand"',
          cwd: "/repo",
          parsed_cmd: [{ type: "unknown", cmd: "npm test -- --runInBand" }],
          source: "agent",
          aggregated_output: "ok",
          exit_code: 0,
          status: "completed",
        },
        createdAt: 2,
      },
    ];

    const projected = toUIMessages(events, { threadStatus: "idle" });
    const tool = projected.find(
      (message): message is Extract<UIMessage, { kind: "tool-call" }> =>
        message.kind === "tool-call",
    );

    expect(tool).toBeDefined();
    expect(tool?.command).toBe("npm test -- --runInBand");
    expect(tool?.status).toBe("completed");
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

  it("keeps provisioning operations pending while thread provisioning is still in progress", () => {
    const events: ThreadEvent[] = [
      {
        id: "evt-1",
        threadId: "thread-1",
        seq: 1,
        type: "system/provisioning/started",
        data: {
          transcript: [{ key: "environment", text: "environment: Worktree" }],
        },
        createdAt: 1,
      },
      {
        id: "evt-2",
        threadId: "thread-1",
        seq: 2,
        type: "system/provisioning/env_setup",
        data: {
          status: "running",
          workspaceRoot: "/tmp/worktree",
          scriptPath: ".bb-env-setup.sh",
          detail: "+ pnpm install",
        },
        createdAt: 2,
      },
    ];

    const projected = toUIMessages(events, { threadStatus: "provisioning" });
    const rows = buildThreadDetailRows(projected, {
      includeToolGroupMessages: false,
    });
    const messageRows = rows.filter(
      (row): row is Extract<(typeof rows)[number], { kind: "message" }> =>
        row.kind === "message",
    );

    expect(messageRows).toHaveLength(1);
    expect(messageRows[0]?.message.kind).toBe("operation");
    if (messageRows[0]?.message.kind !== "operation") {
      return;
    }

    expect(messageRows[0].message.opType).toBe("provisioning");
    expect(messageRows[0].message.status).toBe("pending");
    expect(messageRows[0].message.title).toBe("Provisioning environment");
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

  it("keeps assistant text buffered while reasoning continues streaming on active threads", () => {
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

    expect(assistant).toBeUndefined();
    expect(reasoning).toBeDefined();
    expect(reasoning?.status).toBe("streaming");
  });

  it("renders completed assistant text immediately even while the thread is active", () => {
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
            type: "agentMessage",
            id: "msg-1",
            text: "Final answer",
          },
        },
        createdAt: 1,
      },
    ];

    const projected = toUIMessages(events, { threadStatus: "active" });

    const assistant = projected.find(
      (message): message is Extract<UIMessage, { kind: "assistant-text" }> =>
        message.kind === "assistant-text",
    );

    expect(assistant?.text).toBe("Final answer");
    expect(assistant?.status).toBe("completed");
  });

  it("flushes buffered assistant text when the turn completes even if thread status is still active", () => {
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
        type: "turn/completed",
        data: {
          threadId: "thread-1",
          turnId: "turn-1",
        },
        createdAt: 2,
      },
    ];

    const projected = toUIMessages(events, { threadStatus: "active" });
    const assistant = projected.find(
      (message): message is Extract<UIMessage, { kind: "assistant-text" }> =>
        message.kind === "assistant-text",
    );

    expect(assistant?.text).toBe("Partial reply");
    expect(assistant?.status).toBe("completed");
  });

  it("flushes buffered assistant text before interruption markers on idle threads", () => {
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
        type: "system/thread/interrupted",
        data: {
          threadId: "thread-1",
          turnId: "turn-1",
          message: "Stopped by user",
        },
        createdAt: 2,
      },
    ];

    const projected = toUIMessages(events, { threadStatus: "idle" });

    expect(projected[0]?.kind).toBe("assistant-text");
    if (projected[0]?.kind === "assistant-text") {
      expect(projected[0].text).toBe("Partial reply");
      expect(projected[0].status).toBe("completed");
    }
    expect(projected[1]?.kind).toBe("operation");
    if (projected[1]?.kind === "operation") {
      expect(projected[1].opType).toBe("thread-interrupted");
      expect(projected[1].status).toBe("interrupted");
    }
  });

  it("ignores trailing assistant deltas that arrive after completion", () => {
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
            type: "agentMessage",
            id: "msg-1",
            text: "Final answer",
          },
        },
        createdAt: 1,
      },
      {
        id: "evt-2",
        threadId: "thread-1",
        seq: 2,
        type: "item/agentMessage/delta",
        data: {
          threadId: "thread-1",
          turnId: "turn-1",
          itemId: "msg-1",
          delta: " trailing",
        },
        createdAt: 2,
      },
    ];

    const projected = toUIMessages(events, { threadStatus: "idle" });
    const assistants = projected.filter(
      (message): message is Extract<UIMessage, { kind: "assistant-text" }> =>
        message.kind === "assistant-text",
    );

    expect(assistants).toHaveLength(1);
    expect(assistants[0]?.text).toBe("Final answer");
    expect(assistants[0]?.status).toBe("completed");
  });

  it("ignores trailing reasoning deltas that arrive after completion", () => {
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
            type: "reasoning",
            id: "rs-1",
            text: "Final reasoning",
          },
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
          delta: " trailing",
        },
        createdAt: 2,
      },
    ];

    const projected = toUIMessages(events, { threadStatus: "idle" });
    const reasoning = projected.filter(
      (message): message is Extract<UIMessage, { kind: "assistant-reasoning" }> =>
        message.kind === "assistant-reasoning",
    );

    expect(reasoning).toHaveLength(1);
    expect(reasoning[0]?.text).toBe("Final reasoning");
    expect(reasoning[0]?.status).toBe("completed");
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

  it("projects item web search lifecycle as dedicated web-search cells", () => {
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
        },
        createdAt: 1,
      },
      {
        id: "evt-2",
        threadId: "thread-1",
        seq: 2,
        type: "item/completed",
        data: {
          item: {
            type: "webSearch",
            id: "web-1",
            query: "react suspense",
            action: { type: "search", query: "react suspense" },
          },
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

  it("preserves unknown provider web-search action types", () => {
    const events: ThreadEvent[] = [
      {
        id: "evt-1",
        threadId: "thread-1",
        seq: 1,
        type: "item/completed",
        data: {
          item: {
            type: "webSearch",
            id: "web-2",
            query: "new runtime action",
            action: { type: "providerCustomAction" },
          },
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

    const projected = toUIMessages(events, {
      threadStatus: "active",
    });
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

    const projected = toUIMessages(events, {
      threadStatus: "active",
    });
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

    const projected = toUIMessages(events, {
      threadStatus: "active",
    });
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

    const projected = toUIMessages(events, {
      threadStatus: "active",
    });
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

    const projected = toUIMessages(events, {
      threadStatus: "active",
    });
    const ops = projected.filter(
      (message): message is Extract<UIMessage, { kind: "operation" }> =>
        message.kind === "operation",
    );

    expect(ops).toHaveLength(1);
    expect(ops[0]?.opType).toBe("thread-title-updated");
    expect(ops[0]?.detail).toBe("Server-assigned title");
  });

  it("keeps in-progress compaction items pending for active threads", () => {
    const events: ThreadEvent[] = [
      {
        id: "evt-1",
        threadId: "thread-1",
        seq: 1,
        type: "item/started",
        data: {
          turnId: "turn-1",
          item: {
            id: "compact-1",
            type: "contextCompaction",
          },
        },
        createdAt: 1,
      },
    ];

    const projected = toUIMessages(events, { threadStatus: "active" });
    const op = projected.find(
      (message): message is Extract<UIMessage, { kind: "operation" }> =>
        message.kind === "operation",
    );

    expect(op).toBeDefined();
    expect(op?.opType).toBe("compaction");
    expect(op?.title).toBe("Context compacting...");
    expect(op?.status).toBe("pending");
  });

  it("coalesces compaction lifecycle events into a single completed operation", () => {
    const events: ThreadEvent[] = [
      {
        id: "evt-1",
        threadId: "thread-1",
        seq: 1,
        type: "item/started",
        data: {
          turnId: "turn-1",
          item: {
            id: "compact-1",
            type: "contextCompaction",
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
          turnId: "turn-1",
          item: {
            id: "compact-1",
            type: "contextCompaction",
          },
        },
        createdAt: 2,
      },
      {
        id: "evt-3",
        threadId: "thread-1",
        seq: 3,
        type: "thread/compacted",
        data: {
          threadId: "thread-1",
          turnId: "turn-1",
        },
        createdAt: 3,
      },
    ];

    const projected = toUIMessages(events);
    const ops = projected.filter(
      (message): message is Extract<UIMessage, { kind: "operation" }> =>
        message.kind === "operation",
    );

    expect(ops).toHaveLength(1);
    expect(ops[0]?.opType).toBe("compaction");
    expect(ops[0]?.title).toBe("Context compacted");
    expect(ops[0]?.sourceSeqStart).toBe(1);
    expect(ops[0]?.sourceSeqEnd).toBe(2);
  });

  it("projects legacy compaction events as operations", () => {
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

    const projected = toUIMessages(events, {
      threadStatus: "active",
    });
    const op = projected.find(
      (message): message is Extract<UIMessage, { kind: "operation" }> =>
        message.kind === "operation",
    );

    expect(op).toBeDefined();
    expect(op?.opType).toBe("compaction");
    expect(op?.title).toBe("Context compacted");
  });

  it("projects thread interruption events as interrupted operations", () => {
    const projected = toUIMessages([
      {
        id: "evt-1",
        threadId: "thread-1",
        seq: 1,
        type: "system/thread/interrupted",
        data: {
          reason: "user",
        },
        createdAt: 1,
      },
    ]);
    const op = projected.find(
      (message): message is Extract<UIMessage, { kind: "operation" }> =>
        message.kind === "operation",
    );

    expect(op).toBeDefined();
    expect(op?.opType).toBe("thread-interrupted");
    expect(op?.title).toBe("Stopped by user");
    expect(op?.status).toBe("interrupted");
  });

  it("projects provisioning env setup events as operations", () => {
    const events: ThreadEvent[] = [
      {
        id: "evt-1",
        threadId: "thread-1",
        seq: 1,
        type: "system/provisioning/env_setup",
        data: {
          workspaceRoot: "/tmp/worktree",
          setup: {
            status: "started",
            scriptPath: ".bb-env-setup.sh",
            timeoutMs: 600000,
          },
          transcript: [{ key: "setup", text: "running .bb-env-setup.sh", startedAt: 1 }],
        },
        createdAt: 1,
      },
      {
        id: "evt-2",
        threadId: "thread-1",
        seq: 2,
        type: "system/provisioning/env_setup",
        data: {
          workspaceRoot: "/tmp/worktree",
          setup: {
            status: "running",
            scriptPath: ".bb-env-setup.sh",
            timeoutMs: 600000,
            output: "pnpm install",
          },
          transcript: [{ key: "setup", text: "running .bb-env-setup.sh", startedAt: 2 }],
        },
        createdAt: 2,
      },
      {
        id: "evt-3",
        threadId: "thread-1",
        seq: 3,
        type: "system/provisioning/env_setup",
        data: {
          workspaceRoot: "/tmp/worktree",
          setup: {
            status: "completed",
            scriptPath: ".bb-env-setup.sh",
            durationMs: 125,
          },
          transcript: [{ key: "setup", text: "ran .bb-env-setup.sh in 125ms" }],
        },
        createdAt: 3,
      },
    ];

    const projected = toUIMessages(events, {
      threadStatus: "active",
    });
    const ops = projected.filter(
      (message): message is Extract<UIMessage, { kind: "operation" }> =>
        message.kind === "operation",
    );

    expect(ops).toHaveLength(3);
    expect(ops[0]?.opType).toBe("provisioning-env-setup");
    expect(ops[0]?.title).toBe("Environment setup started");
    expect(ops[0]?.detail).toBeUndefined();
    expect(ops[0]?.provisioning?.workspaceRoot).toBe("/tmp/worktree");
    expect(ops[0]?.provisioning?.setup?.scriptPath).toBe(".bb-env-setup.sh");
    expect(ops[0]?.provisioning?.setup?.timeoutMs).toBe(600000);
    expect(ops[0]?.provisioning?.setup?.startedAt).toBe(1);
    expect(ops[1]?.opType).toBe("provisioning-env-setup");
    expect(ops[1]?.title).toBe("Environment setup running");
    expect(ops[1]?.detail).toBeUndefined();
    expect(ops[1]?.provisioning?.setup?.output).toBe("pnpm install");
    expect(ops[1]?.provisioning?.setup?.startedAt).toBe(2);
    expect(ops[2]?.opType).toBe("provisioning-env-setup");
    expect(ops[2]?.title).toBe("Environment setup completed");
    expect(ops[2]?.detail).toBeUndefined();
    expect(ops[2]?.provisioning?.setup?.durationMs).toBe(125);
    expect(ops[2]?.provisioning?.setup?.startedAt).toBe(3);
  });

  it("projects provisioning progress events as operations", () => {
    const events: ThreadEvent[] = [
      {
        id: "evt-1",
        threadId: "thread-1",
        seq: 1,
        type: "system/provisioning/progress",
        data: {
          phase: "prepare_environment",
          status: "completed",
          durationMs: 1200,
        },
        createdAt: 1,
      },
      {
        id: "evt-2",
        threadId: "thread-1",
        seq: 2,
        type: "system/provisioning/progress",
        data: {
          phase: "start_provider_session",
          status: "started",
          transcript: [
            {
              key: "phase:start_provider_session",
              text: "starting provider session",
              startedAt: 2,
              metadata: {
                phase: "start_provider_session",
                status: "started",
              },
            },
          ],
        },
        createdAt: 2,
      },
    ];

    const projected = toUIMessages(events, {
      threadStatus: "provisioning",
    });
    const ops = projected.filter(
      (message): message is Extract<UIMessage, { kind: "operation" }> =>
        message.kind === "operation",
    );

    expect(ops).toHaveLength(2);
    expect(ops[0]?.opType).toBe("provisioning-progress");
    expect(ops[0]?.title).toBe("Environment prepared");
    expect(ops[0]?.status).toBe("completed");
    expect(ops[0]?.provisioning?.transcript).toBeUndefined();
    expect(ops[1]?.opType).toBe("provisioning-progress");
    expect(ops[1]?.title).toBe("Starting provider session");
    expect(ops[1]?.status).toBe("pending");
    expect(ops[1]?.provisioning?.transcript).toEqual([
      {
        key: "phase:start_provider_session",
        text: "starting provider session",
        startedAt: 2,
        metadata: {
          phase: "start_provider_session",
          status: "started",
        },
      },
    ]);
  });

  it("projects primary-checkout lifecycle events with stable metadata", () => {
    const events: ThreadEvent[] = [
      {
        id: "evt-1",
        threadId: "thread-1",
        seq: 1,
        type: "system/primary_checkout/updated",
        data: {
          action: "promote",
          status: "started",
          message: "Promoting thread worktree into primary checkout",
          projectId: "proj-1",
          activeThreadId: "thread-1",
        },
        createdAt: 1,
      },
      {
        id: "evt-2",
        threadId: "thread-1",
        seq: 2,
        type: "system/primary_checkout/updated",
        data: {
          action: "promote",
          status: "completed",
          message: "Primary checkout now reflects this thread worktree",
          projectId: "proj-1",
          activeThreadId: "thread-1",
          branch: "feat/example",
        },
        createdAt: 2,
      },
    ];

    const projected = toUIMessages(events, {
      threadStatus: "active",
    });
    const ops = projected.filter(
      (message): message is Extract<UIMessage, { kind: "operation" }> =>
        message.kind === "operation",
    );

    expect(ops).toHaveLength(2);
    expect(ops[0]?.opType).toBe("primary-checkout");
    expect(ops[0]?.title).toBe("Promoting primary checkout");
    expect(ops[0]?.primaryCheckout).toEqual({
      action: "promote",
      phase: "started",
    });

    expect(ops[1]?.opType).toBe("primary-checkout");
    expect(ops[1]?.title).toBe("Promoted to primary checkout");
    expect(ops[1]?.primaryCheckout).toEqual({
      action: "promote",
      phase: "completed",
    });
    expect(ops[1]?.detail).toContain("Branch: feat/example");
  });

  it("captures checkout sha on provisioning branch transcript entries", () => {
    const events: ThreadEvent[] = [
      {
        id: "evt-1",
        threadId: "thread-1",
        seq: 1,
        type: "system/provisioning/env_setup",
        data: {
          workspaceRoot: "/tmp/worktree",
          setup: {
            status: "started",
            scriptPath: ".bb-env-setup.sh",
          },
          transcript: [
            { key: "branch", text: "checked out branch bb/thread-123 (abcdef1)" },
            { key: "setup", text: "running .bb-env-setup.sh", startedAt: 1 },
          ],
        },
        createdAt: 1,
      },
    ];

    const projected = toUIMessages(events, {
      threadStatus: "provisioning",
    });
    const op = projected.find(
      (message): message is Extract<UIMessage, { kind: "operation" }> =>
        message.kind === "operation",
    );

    expect(op?.opType).toBe("provisioning-env-setup");
    expect(op?.provisioning?.transcript).toEqual([
      {
        key: "branch",
        text: "checked out branch bb/thread-123 (abcdef1)",
      },
      {
        key: "setup",
        text: "running .bb-env-setup.sh",
        startedAt: 1,
      },
    ]);
  });

  it("projects thread operation intent lifecycle events as operations", () => {
    const events: ThreadEvent[] = [
      {
        id: "evt-1",
        threadId: "thread-1",
        seq: 1,
        type: "system/thread_operation",
        data: {
          operation: "commit",
          status: "requested",
          message: "Commit operation requested",
        },
        createdAt: 1,
      },
      {
        id: "evt-2",
        threadId: "thread-1",
        seq: 2,
        type: "system/thread_operation",
        data: {
          operation: "commit",
          status: "queued",
          operationId: "op-1",
          message: "Commit operation queued for deterministic execution",
        },
        createdAt: 2,
      },
    ];

    const projected = toUIMessages(events, {
      threadStatus: "active",
    });
    const ops = projected.filter(
      (message): message is Extract<UIMessage, { kind: "operation" }> =>
        message.kind === "operation",
    );

    expect(ops).toHaveLength(2);
    expect(ops[0]?.opType).toBe("thread-operation-intent");
    expect(ops[0]?.title).toBe("Commit requested");
    expect(ops[0]?.threadOperation).toEqual({
      action: "commit",
      phase: "requested",
    });
    expect(ops[1]?.opType).toBe("thread-operation-intent");
    expect(ops[1]?.title).toBe("Commit queued");
    expect(ops[1]?.threadOperation).toEqual({
      action: "commit",
      phase: "queued",
      operationId: "op-1",
    });
    expect(ops[1]?.detail).toContain("deterministic execution");
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

  it("projects start-first provisioning failure timelines into user + provisioning + error rows", () => {
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
          input: [{ type: "text", text: "Fix env setup script regression" }],
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
        type: "system/provisioning/started",
        data: {
          transcript: [{ key: "environment", text: "environment: Worktree" }],
        },
        createdAt: 2,
      },
      {
        id: "evt-3",
        threadId: "thread-1",
        seq: 3,
        type: "system/provisioning/env_setup",
        data: {
          setup: {
            status: "started",
            scriptPath: ".bb-env-setup.sh",
            timeoutMs: 600000,
          },
          transcript: [{ key: "setup", text: "running .bb-env-setup.sh", startedAt: 3 }],
        },
        createdAt: 3,
      },
      {
        id: "evt-4",
        threadId: "thread-1",
        seq: 4,
        type: "system/provisioning/env_setup",
        data: {
          setup: {
            status: "failed",
            scriptPath: ".bb-env-setup.sh",
            timeoutMs: 600000,
            durationMs: 1593,
            output: "pnpm build failed",
          },
          transcript: [{ key: "setup", text: "setup script failed: .bb-env-setup.sh in 1.6s" }],
        },
        createdAt: 4,
      },
      {
        id: "evt-5",
        threadId: "thread-1",
        seq: 5,
        type: "system/error",
        data: {
          code: "thread_provisioning_failed",
          message: "Thread provisioning failed for project proj-1",
          detail: "pnpm build failed",
        },
        createdAt: 5,
      },
    ];

    const projected = toUIMessages(events, {
      threadStatus: "provisioning_failed",
    });
    const rows = buildThreadDetailRows(projected, {
      includeToolGroupMessages: false,
    });
    const messageRows = rows.filter(
      (row): row is Extract<(typeof rows)[number], { kind: "message" }> =>
        row.kind === "message",
    );

    expect(messageRows).toHaveLength(3);
    expect(messageRows[0]?.message.kind).toBe("user");
    if (messageRows[0]?.message.kind === "user") {
      expect(messageRows[0].message.text).toContain("Fix env setup script regression");
    }

    expect(messageRows[1]?.message.kind).toBe("operation");
    if (messageRows[1]?.message.kind === "operation") {
      expect(messageRows[1].message.opType).toBe("provisioning");
      expect(messageRows[1].message.title).toBe("Environment setup failed");
    }

    expect(messageRows[2]?.message.kind).toBe("error");
    if (messageRows[2]?.message.kind === "error") {
      expect(messageRows[2].message.message).toContain("Thread provisioning failed");
      expect(messageRows[2].message.message).toContain("pnpm build failed");
    }
  });

  it("renders provider-start provisioning failures as failed instead of interrupted", () => {
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
          input: [{ type: "text", text: "Retry the direct environment" }],
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
        type: "system/provisioning/started",
        data: {
          transcript: [{ key: "environment", text: "environment: Direct" }],
        },
        createdAt: 2,
      },
      {
        id: "evt-3",
        threadId: "thread-1",
        seq: 3,
        type: "system/error",
        data: {
          code: "thread_provisioning_failed",
          message: "Thread provisioning failed for project proj-1",
          detail: "Provider runtime is unavailable",
        },
        createdAt: 3,
      },
    ];

    const projected = toUIMessages(events, {
      threadStatus: "provisioning_failed",
    });
    const rows = buildThreadDetailRows(projected, {
      includeToolGroupMessages: false,
    });
    const messageRows = rows.filter(
      (row): row is Extract<(typeof rows)[number], { kind: "message" }> =>
        row.kind === "message",
    );

    expect(messageRows).toHaveLength(3);
    expect(messageRows[1]?.message.kind).toBe("operation");
    if (messageRows[1]?.message.kind === "operation") {
      expect(messageRows[1].message.opType).toBe("provisioning");
      expect(messageRows[1].message.title).toBe("Provisioning environment failed");
    }

    expect(messageRows[2]?.message.kind).toBe("error");
    if (messageRows[2]?.message.kind === "error") {
      expect(messageRows[2].message.message).toContain("Provider runtime is unavailable");
    }
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
        type: "client/turn/requested",
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

  it("keeps append-only tell request/start pairs as a single rendered user message", () => {
    const events: ThreadEvent[] = [
      {
        id: "evt-1",
        threadId: "thread-1",
        seq: 1,
        type: "client/turn/requested",
        data: {
          direction: "outbound",
          source: "tell",
          initiator: "agent",
          input: [{ type: "text", text: "Please keep going until the roadmap is done" }],
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
        type: "turn/started",
        data: { turnId: "turn-1" },
        createdAt: 2,
      },
      {
        id: "evt-3",
        threadId: "thread-1",
        seq: 3,
        type: "item/completed",
        data: {
          turnId: "turn-1",
          item: {
            id: "item-user-1",
            type: "user_message",
            content: [{ type: "text", text: "Please keep going until the roadmap is done" }],
          },
        },
        createdAt: 3,
      },
      {
        id: "evt-4",
        threadId: "thread-1",
        seq: 4,
        type: "client/turn/start",
        data: {
          direction: "outbound",
          source: "tell",
          initiator: "agent",
          input: [{ type: "text", text: "Please keep going until the roadmap is done" }],
          request: {
            method: "turn/start",
            params: {},
          },
          execution: {},
        },
        createdAt: 4,
      },
    ];

    const projected = toUIMessages(events, {
      threadStatus: "active",
    });
    const userMessages = projected.filter(
      (message): message is Extract<UIMessage, { kind: "user" }> =>
        message.kind === "user",
    );

    expect(userMessages).toHaveLength(1);
    expect(userMessages[0]?.text).toBe("Please keep going until the roadmap is done");
  });

  it("keeps the client thread input and suppresses a matching later user item event", () => {
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
    expect(userMessages[0]?.id).toContain("user-seed");
    expect(userMessages[0]?.text).toBe("Fix duplicate user messages");
  });

  it("deduplicates matching spawn thread/turn start inputs before provider user items arrive", () => {
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
          input: [{ type: "text", text: "Keep ordering sane" }],
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
        type: "client/turn/start",
        data: {
          direction: "outbound",
          source: "spawn",
          initiator: "agent",
          input: [{ type: "text", text: "Keep ordering sane" }],
          request: {
            method: "turn/start",
            params: {},
          },
          execution: {},
        },
        createdAt: 2,
      },
    ];

    const projected = toUIMessages(events, {
      threadStatus: "active",
    });
    const userMessages = projected.filter(
      (message): message is Extract<UIMessage, { kind: "user" }> =>
        message.kind === "user",
    );

    expect(userMessages).toHaveLength(1);
    expect(userMessages[0]?.id).toBe("thread-1:user-seed:1");
    expect(userMessages[0]?.text).toBe("Keep ordering sane");
  });

  it("keeps start-first ordering by showing one client input before provisioning when matching spawn/user item events appear later", () => {
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
          input: [{ type: "text", text: "Keep ordering sane" }],
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
        type: "system/provisioning/started",
        data: {
          transcript: [{ key: "environment", text: "environment: Worktree" }],
        },
        createdAt: 2,
      },
      {
        id: "evt-3",
        threadId: "thread-1",
        seq: 3,
        type: "system/provisioning/completed",
        data: {
          transcript: [{ key: "environment", text: "environment: Worktree" }],
        },
        createdAt: 3,
      },
      {
        id: "evt-4",
        threadId: "thread-1",
        seq: 4,
        type: "client/turn/start",
        data: {
          direction: "outbound",
          source: "spawn",
          initiator: "agent",
          input: [{ type: "text", text: "Keep ordering sane" }],
          request: {
            method: "turn/start",
            params: {},
          },
          execution: {},
        },
        createdAt: 4,
      },
      {
        id: "evt-5",
        threadId: "thread-1",
        seq: 5,
        type: "item/completed",
        data: {
          turnId: "turn-1",
          item: {
            id: "item-user-1",
            type: "user_message",
            content: [{ type: "text", text: "Keep ordering sane" }],
          },
        },
        createdAt: 5,
      },
    ];

    const projected = toUIMessages(events, {
      threadStatus: "idle",
    });
    const rows = buildThreadDetailRows(projected, {
      includeToolGroupMessages: false,
    });
    const messageRows = rows.filter(
      (row): row is Extract<(typeof rows)[number], { kind: "message" }> =>
        row.kind === "message",
    );

    expect(messageRows).toHaveLength(2);
    expect(messageRows[0]?.message.kind).toBe("user");
    if (messageRows[0]?.message.kind === "user") {
      expect(messageRows[0].message.id).toContain("user-seed");
      expect(messageRows[0].message.text).toBe("Keep ordering sane");
    }
    expect(messageRows[1]?.message.kind).toBe("operation");
    if (messageRows[1]?.message.kind === "operation") {
      expect(messageRows[1].message.opType).toBe("provisioning");
    }
  });

  it("projects docker provisioning rows from structured events without string details", () => {
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
          input: [{ type: "text", text: "Check the docker environment" }],
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
        type: "system/provisioning/started",
        data: {
          transcript: [{ key: "environment", text: "environment: Docker Sandbox" }],
        },
        createdAt: 2,
      },
      {
        id: "evt-3",
        threadId: "thread-1",
        seq: 3,
        type: "system/provisioning/completed",
        data: {
          transcript: [{ key: "environment", text: "environment: Docker Sandbox" }],
        },
        createdAt: 3,
      },
    ];

    const projected = toUIMessages(events, {
      threadStatus: "idle",
    });
    const rows = buildThreadDetailRows(projected, {
      includeToolGroupMessages: false,
    });
    const messageRows = rows.filter(
      (row): row is Extract<(typeof rows)[number], { kind: "message" }> =>
        row.kind === "message",
    );

    expect(messageRows).toHaveLength(2);
    expect(messageRows[1]?.message.kind).toBe("operation");
    if (messageRows[1]?.message.kind !== "operation") {
      return;
    }

    expect(messageRows[1].message.opType).toBe("provisioning");
    expect(messageRows[1].message.title).toBe("Provisioned environment");
    expect(messageRows[1].message.provisioning?.transcript?.[0]?.text).toBe(
      "environment: Docker Sandbox",
    );
    expect(messageRows[1].message.detail).toBeUndefined();
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

  it("ignores legacy codex/event user_message rows", () => {
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

  it("deduplicates provider userMessage image data URL in favor of client start localImage", () => {
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
    expect(users[0]?.attachments?.localImages).toBe(1);
    expect(users[0]?.attachments?.localImagePaths).toEqual(["/tmp/shot.png"]);
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
          message: "Project folder not found: /Users/michael/Projects/bb",
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

  it("does not render system-initiated client start input as a user message", () => {
    const projected = toUIMessages([
      {
        id: "evt-1",
        threadId: "thread-1",
        seq: 1,
        type: "client/turn/start",
        data: {
          direction: "outbound",
          source: "tell",
          initiator: "system",
          input: [{ type: "text", text: "[bb system] Welcome!" }],
          request: {
            method: "turn/start",
            params: {},
          },
          execution: {},
        },
        createdAt: 1,
      },
    ], { threadStatus: "idle" });

    expect(projected).toEqual([]);
  });

  it("projects manager user messages and suppresses raw assistant text for manager threads", () => {
    const projected = toUIMessages([
      {
        id: "evt-1",
        threadId: "thread-1",
        seq: 1,
        type: "item/completed",
        data: {
          threadId: "thread-1",
          turnId: "turn-1",
          item: {
            type: "agentMessage",
            id: "assistant-1",
            text: "internal manager chatter",
          },
        },
        createdAt: 1,
      },
      {
        id: "evt-2",
        threadId: "thread-1",
        seq: 2,
        type: "system/manager/user_message",
        data: {
          text: "Visible manager update",
          turnId: "turn-1",
        },
        createdAt: 2,
      },
    ], {
      threadStatus: "idle",
      threadType: "manager",
    });

    expect(projected).toHaveLength(1);
    expect(projected[0]?.kind).toBe("assistant-text");
    if (projected[0]?.kind === "assistant-text") {
      expect(projected[0].text).toBe("Visible manager update");
      expect(projected[0].turnId).toBe("turn-1");
    }
  });

  it("suppresses internal [bb system] user messages from provider items", () => {
    const projected = toUIMessages([
      {
        id: "evt-1",
        threadId: "thread-1",
        seq: 1,
        type: "client/turn/start",
        data: {
          direction: "outbound",
          source: "spawn",
          initiator: "system",
          input: [{ type: "text", text: "[bb system] Welcome!" }],
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
        type: "item/completed",
        data: {
          threadId: "thread-1",
          turnId: "turn-1",
          item: {
            type: "userMessage",
            id: "user-1",
            content: [{ type: "text", text: "[bb system] Welcome!" }],
          },
        },
        createdAt: 2,
      },
      {
        id: "evt-3",
        threadId: "thread-1",
        seq: 3,
        type: "system/manager/user_message",
        data: {
          text: "Visible manager update",
          turnId: "turn-1",
        },
        createdAt: 2,
      },
    ], {
      threadStatus: "idle",
      threadType: "manager",
    });

    expect(projected).toHaveLength(1);
    expect(projected[0]?.kind).toBe("assistant-text");
    if (projected[0]?.kind === "assistant-text") {
      expect(projected[0].text).toBe("Visible manager update");
    }
  });

  it("includes internal [bb system] messages when internal system messages are enabled", () => {
    const projected = toUIMessages([
      {
        id: "evt-1",
        threadId: "thread-1",
        seq: 1,
        type: "client/turn/start",
        data: {
          direction: "outbound",
          source: "spawn",
          initiator: "system",
          input: [{ type: "text", text: "[bb system] Welcome!" }],
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
        type: "item/completed",
        data: {
          threadId: "thread-1",
          turnId: "turn-1",
          item: {
            type: "userMessage",
            id: "user-1",
            content: [{ type: "text", text: "[bb system] Welcome!" }],
          },
        },
        createdAt: 2,
      },
      {
        id: "evt-3",
        threadId: "thread-1",
        seq: 3,
        type: "system/manager/user_message",
        data: {
          text: "Visible manager update",
          turnId: "turn-1",
        },
        createdAt: 3,
      },
    ], {
      threadStatus: "idle",
      threadType: "manager",
      includeInternalSystemMessages: true,
    });

    expect(projected).toHaveLength(2);
    expect(projected[0]?.kind).toBe("user");
    if (projected[0]?.kind === "user") {
      expect(projected[0].text).toBe("[bb system] Welcome!");
    }
    expect(projected[1]?.kind).toBe("assistant-text");
    if (projected[1]?.kind === "assistant-text") {
      expect(projected[1].text).toBe("Visible manager update");
    }
  });
});

describe("toolCall projection for bridge and Codex custom/function calls", () => {
  it("projects custom_tool_call start + custom_tool_call_output end into tool-call message", () => {
    const events: ThreadEvent[] = [
      {
        id: "evt-1",
        threadId: "thread-1",
        seq: 1,
        type: "item/started",
        data: {
          turnId: "turn-1",
          item: {
            type: "custom_tool_call",
            call_id: "call-1",
            name: "my_tool",
            input: JSON.stringify({ message: "hello" }),
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
          turnId: "turn-1",
          item: {
            type: "custom_tool_call_output",
            call_id: "call-1",
            output: "world",
          },
        },
        createdAt: 2,
      },
    ];

    const projected = toUIMessages(events, { threadStatus: "idle" });
    const toolCalls = projected.filter((m) => m.kind === "tool-call");
    expect(toolCalls).toHaveLength(1);
    const tc = toolCalls[0];
    if (tc?.kind === "tool-call") {
      expect(tc.toolName).toBe("my_tool");
      expect(tc.output).toBe("world");
      expect(tc.status).toBe("completed");
    }
  });

  it("projects bridge Read tool as exploring message", () => {
    const events: ThreadEvent[] = [
      {
        id: "evt-1",
        threadId: "thread-1",
        seq: 1,
        type: "item/started",
        data: {
          turnId: "turn-1",
          item: {
            type: "custom_tool_call",
            call_id: "call-read-1",
            name: "Read",
            input: JSON.stringify({ file_path: "/src/main.ts" }),
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
          turnId: "turn-1",
          item: {
            type: "custom_tool_call_output",
            call_id: "call-read-1",
            output: "file contents",
          },
        },
        createdAt: 2,
      },
      {
        id: "evt-3",
        threadId: "thread-1",
        seq: 3,
        type: "item/started",
        data: {
          turnId: "turn-1",
          item: {
            type: "custom_tool_call",
            call_id: "call-grep-1",
            name: "Grep",
            input: JSON.stringify({ pattern: "TODO", path: "/src" }),
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
          turnId: "turn-1",
          item: {
            type: "custom_tool_call_output",
            call_id: "call-grep-1",
            output: "found matches",
          },
        },
        createdAt: 4,
      },
    ];

    const projected = toUIMessages(events, { threadStatus: "idle" });
    // Read and Grep should be grouped into a single exploring message
    const exploring = projected.filter((m) => m.kind === "tool-exploring");
    expect(exploring.length).toBeGreaterThanOrEqual(1);
    if (exploring[0]?.kind === "tool-exploring") {
      expect(exploring[0].calls.length).toBe(2);
    }
  });

  it("projects bridge Bash tool via commandExecution (not custom_tool_call)", () => {
    // When bridges emit Bash as commandExecution, it should go through
    // the exec lifecycle path directly
    const events: ThreadEvent[] = [
      {
        id: "evt-1",
        threadId: "thread-1",
        seq: 1,
        type: "item/started",
        data: {
          turnId: "turn-1",
          item: {
            type: "commandExecution",
            id: "call-bash-1",
            command: "ls -la",
            cwd: "/tmp",
            status: "running",
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
          turnId: "turn-1",
          item: {
            type: "commandExecution",
            id: "call-bash-1",
            aggregatedOutput: "total 8\ndrwxr-xr-x",
            exitCode: 0,
            status: "completed",
          },
        },
        createdAt: 2,
      },
    ];

    const projected = toUIMessages(events, { threadStatus: "idle" });
    const toolCalls = projected.filter((m) => m.kind === "tool-call");
    expect(toolCalls).toHaveLength(1);
    if (toolCalls[0]?.kind === "tool-call") {
      expect(toolCalls[0].command).toBe("ls -la");
      expect(toolCalls[0].output).toBe("total 8\ndrwxr-xr-x");
      expect(toolCalls[0].exitCode).toBe(0);
    }
  });

  it("projects function_call and function_call_output into tool-call message", () => {
    const events: ThreadEvent[] = [
      {
        id: "evt-1",
        threadId: "thread-1",
        seq: 1,
        type: "item/started",
        data: {
          turnId: "turn-1",
          item: {
            type: "function_call",
            call_id: "fc-1",
            name: "get_weather",
            arguments: JSON.stringify({ city: "London" }),
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
          turnId: "turn-1",
          item: {
            type: "function_call_output",
            call_id: "fc-1",
            output: "Sunny, 22C",
          },
        },
        createdAt: 2,
      },
    ];

    const projected = toUIMessages(events, { threadStatus: "idle" });
    const toolCalls = projected.filter((m) => m.kind === "tool-call");
    expect(toolCalls).toHaveLength(1);
    if (toolCalls[0]?.kind === "tool-call") {
      expect(toolCalls[0].toolName).toBe("get_weather");
      expect(toolCalls[0].output).toBe("Sunny, 22C");
      expect(toolCalls[0].status).toBe("completed");
    }
  });

  it("interleaves commandExecution and custom_tool_call correctly", () => {
    const events: ThreadEvent[] = [
      {
        id: "evt-1",
        threadId: "thread-1",
        seq: 1,
        type: "item/started",
        data: {
          turnId: "turn-1",
          item: {
            type: "commandExecution",
            id: "exec-1",
            command: "npm test",
            status: "running",
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
          turnId: "turn-1",
          item: {
            type: "commandExecution",
            id: "exec-1",
            aggregatedOutput: "All tests passed",
            exitCode: 0,
            status: "completed",
          },
        },
        createdAt: 2,
      },
      {
        id: "evt-3",
        threadId: "thread-1",
        seq: 3,
        type: "item/started",
        data: {
          turnId: "turn-1",
          item: {
            type: "custom_tool_call",
            call_id: "ct-1",
            name: "deploy",
            input: JSON.stringify({ env: "staging" }),
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
          turnId: "turn-1",
          item: {
            type: "custom_tool_call_output",
            call_id: "ct-1",
            output: "deployed",
          },
        },
        createdAt: 4,
      },
    ];

    const projected = toUIMessages(events, { threadStatus: "idle" });
    const toolMessages = projected.filter(
      (m) => m.kind === "tool-call" || m.kind === "tool-exploring",
    );
    expect(toolMessages).toHaveLength(2);
    expect(toolMessages[0]?.kind).toBe("tool-call");
    expect(toolMessages[1]?.kind).toBe("tool-call");
    if (toolMessages[1]?.kind === "tool-call") {
      expect(toolMessages[1].toolName).toBe("deploy");
    }
  });
});
