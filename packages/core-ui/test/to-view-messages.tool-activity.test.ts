import { describe, expect, it } from "vitest";
import type { ThreadEventRow, ViewMessage } from "@bb/domain";
import { threadScope, turnScope } from "@bb/domain";
import { toViewMessages } from "../src/to-view-messages.js";
import {
  assertMonotonicSourceSeq,
  createTimelineEventFactory,
  flattenProjectionMessages,
  fromRows,
} from "./timeline-test-harness.js";

function isToolCallMessage(
  message: ViewMessage,
): message is Extract<ViewMessage, { kind: "tool-call" }> {
  return message.kind === "tool-call";
}

function isCommandMessage(
  message: ViewMessage,
): message is Extract<ViewMessage, { kind: "command" }> {
  return message.kind === "command";
}

describe("toViewMessages tool activity", () => {
  it("marks incomplete tools as interrupted when thread is not active", () => {
    const events: ThreadEventRow[] = [
      {
        id: "evt-1",
        threadId: "thread-1",
        seq: 1,
        type: "item/started",
        data: {
          providerThreadId: "thread-1",
          item: {
            type: "commandExecution",
            id: "call-1",
            command: "/bin/zsh -lc 'ls plans'",
            cwd: "/repo",
            status: "pending",
          },
          turnId: "turn-1",
        },
        createdAt: 1,
        scope: turnScope("turn-1"),
      },
    ];

    const projected = toViewMessages(fromRows(events), {
      threadStatus: "idle",
    });
    const toolMessage = projected.find(isCommandMessage);

    expect(toolMessage).toBeDefined();
    expect(toolMessage?.command).toBe("ls plans");
    expect(toolMessage?.status).toBe("interrupted");
    expect(toolMessage?.output).toContain("interrupted");
  });

  it("strips shell wrappers from string-form exec command lifecycle events", () => {
    const events: ThreadEventRow[] = [
      {
        id: "evt-1",
        threadId: "thread-1",
        seq: 1,
        type: "item/started",
        data: {
          providerThreadId: "thread-1",
          turnId: "turn-1",
          item: {
            type: "commandExecution",
            id: "call-1",
            command: '/bin/bash -lc "npm test -- --runInBand"',
            cwd: "/repo",
            status: "pending",
          },
        },
        createdAt: 1,
        scope: turnScope("turn-1"),
      },
      {
        id: "evt-2",
        threadId: "thread-1",
        seq: 2,
        type: "item/completed",
        data: {
          providerThreadId: "thread-1",
          turnId: "turn-1",
          item: {
            type: "commandExecution",
            id: "call-1",
            command: '/bin/bash -lc "npm test -- --runInBand"',
            cwd: "/repo",
            aggregatedOutput: "ok",
            exitCode: 0,
            status: "completed",
          },
        },
        createdAt: 2,
        scope: turnScope("turn-1"),
      },
    ];

    const projected = toViewMessages(fromRows(events), {
      threadStatus: "idle",
    });
    const tool = projected.find(isCommandMessage);

    expect(tool).toBeDefined();
    expect(tool?.command).toBe("npm test -- --runInBand");
    expect(tool?.status).toBe("completed");
  });

  it("projects synthesized durationMs for command execution lifecycles", () => {
    const events: ThreadEventRow[] = [
      {
        id: "evt-1",
        threadId: "thread-1",
        seq: 1,
        type: "item/started",
        data: {
          providerThreadId: "thread-1",
          turnId: "turn-1",
          item: {
            type: "commandExecution",
            id: "call-1",
            command: "echo hello",
            cwd: "/repo",
            status: "pending",
          },
        },
        createdAt: 100,
        scope: turnScope("turn-1"),
      },
      {
        id: "evt-2",
        threadId: "thread-1",
        seq: 2,
        type: "item/completed",
        data: {
          providerThreadId: "thread-1",
          turnId: "turn-1",
          item: {
            type: "commandExecution",
            id: "call-1",
            command: "echo hello",
            cwd: "/repo",
            exitCode: 0,
            status: "completed",
          },
        },
        createdAt: 500,
        scope: turnScope("turn-1"),
      },
    ];

    const projected = toViewMessages(fromRows(events), {
      threadStatus: "idle",
    });
    const tool = projected.find(isCommandMessage);

    expect(tool?.durationMs).toBe(400);
  });

  it("projects provider plan updates into tasks messages", () => {
    const events: ThreadEventRow[] = [
      {
        id: "evt-1",
        threadId: "thread-1",
        seq: 1,
        type: "turn/plan/updated",
        data: {
          threadId: "thread-1",
          providerThreadId: "provider-thread-1",
          turnId: "turn-1",
          plan: [
            { step: "Inspect SearchMenu.tsx", status: "completed" },
            { step: "Implement better empty state", status: "active" },
          ],
        },
        createdAt: 1,
        scope: turnScope("turn-1"),
      },
    ];

    const projected = toViewMessages(fromRows(events), {
      threadStatus: "idle",
    });
    const tasks = projected.find(
      (message): message is Extract<ViewMessage, { kind: "tasks" }> =>
        message.kind === "tasks",
    );

    expect(tasks).toBeDefined();
    expect(tasks?.source).toBe("plan");
    expect(tasks?.title).toBe("Tasks updated");
    expect(tasks?.tasks).toEqual([
      { text: "Inspect SearchMenu.tsx", status: "completed" },
      { text: "Implement better empty state", status: "active" },
    ]);
  });

  it("projects TodoWrite tool calls into a compact tasks message", () => {
    const events: ThreadEventRow[] = [
      {
        id: "evt-1",
        threadId: "thread-1",
        seq: 1,
        type: "item/started",
        data: {
          threadId: "thread-1",
          providerThreadId: "provider-thread-1",
          turnId: "turn-1",
          item: {
            type: "toolCall",
            id: "todo-1",
            tool: "TodoWrite",
            arguments: {
              todos: [
                {
                  content: "Trace SearchMenu implementation",
                  status: "completed",
                },
                {
                  content: "Add better no-results copy",
                  status: "in_progress",
                },
              ],
            },
            status: "pending",
          },
        },
        createdAt: 1,
        scope: turnScope("turn-1"),
      },
      {
        id: "evt-2",
        threadId: "thread-1",
        seq: 2,
        type: "item/completed",
        data: {
          threadId: "thread-1",
          providerThreadId: "provider-thread-1",
          turnId: "turn-1",
          item: {
            type: "toolCall",
            id: "todo-1",
            tool: "TodoWrite",
            arguments: {
              todos: [
                {
                  content: "Trace SearchMenu implementation",
                  status: "completed",
                },
                { content: "Add better no-results copy", status: "completed" },
              ],
            },
            status: "completed",
          },
        },
        createdAt: 2,
        scope: turnScope("turn-1"),
      },
    ];

    const projected = toViewMessages(fromRows(events), {
      threadStatus: "idle",
    });
    const tasksMessages = projected.filter(
      (message): message is Extract<ViewMessage, { kind: "tasks" }> =>
        message.kind === "tasks",
    );

    expect(tasksMessages).toHaveLength(1);
    expect(tasksMessages[0]).toMatchObject({
      source: "todo",
      title: "Tasks updated",
      status: "completed",
      callId: "todo-1",
      sourceSeqStart: 1,
      sourceSeqEnd: 2,
    });
    expect(tasksMessages[0]?.tasks).toEqual([
      { text: "Trace SearchMenu implementation", status: "completed" },
      { text: "Add better no-results copy", status: "completed" },
    ]);
  });

  it("suppresses low-value TodoRead tool churn", () => {
    const events: ThreadEventRow[] = [
      {
        id: "evt-1",
        threadId: "thread-1",
        seq: 1,
        type: "item/started",
        data: {
          threadId: "thread-1",
          providerThreadId: "provider-thread-1",
          turnId: "turn-1",
          item: {
            type: "toolCall",
            id: "todo-read-1",
            tool: "TodoRead",
            status: "pending",
          },
        },
        createdAt: 1,
        scope: turnScope("turn-1"),
      },
      {
        id: "evt-2",
        threadId: "thread-1",
        seq: 2,
        type: "item/completed",
        data: {
          threadId: "thread-1",
          providerThreadId: "provider-thread-1",
          turnId: "turn-1",
          item: {
            type: "toolCall",
            id: "todo-read-1",
            tool: "TodoRead",
            status: "completed",
            result: {
              todos: [{ content: "Read me", status: "completed" }],
            },
          },
        },
        createdAt: 2,
        scope: turnScope("turn-1"),
      },
    ];

    const projected = toViewMessages(fromRows(events), {
      threadStatus: "idle",
    });

    expect(projected).toEqual([]);
  });

  it("nests delegated child activity under a delegation message", () => {
    const events: ThreadEventRow[] = [
      {
        id: "evt-1",
        threadId: "thread-1",
        seq: 1,
        type: "item/started",
        data: {
          threadId: "thread-1",
          providerThreadId: "provider-thread-1",
          turnId: "turn-1",
          item: {
            type: "toolCall",
            id: "agent-1",
            tool: "Agent",
            arguments: {
              subagent_type: "Explore",
              description: "Explore SearchMenu implementation",
            },
            status: "pending",
          },
        },
        createdAt: 1,
        scope: turnScope("turn-1"),
      },
      {
        id: "evt-2",
        threadId: "thread-1",
        seq: 2,
        type: "item/started",
        data: {
          threadId: "thread-1",
          providerThreadId: "provider-thread-1",
          turnId: "turn-1",
          item: {
            type: "commandExecution",
            id: "exec-1",
            command: "/bin/zsh -lc 'rg -n \"SearchMenu\" packages/excalidraw'",
            cwd: "/repo",
            status: "pending",
            parentToolCallId: "agent-1",
          },
        },
        createdAt: 2,
        scope: turnScope("turn-1"),
      },
      {
        id: "evt-3",
        threadId: "thread-1",
        seq: 3,
        type: "item/completed",
        data: {
          threadId: "thread-1",
          providerThreadId: "provider-thread-1",
          turnId: "turn-1",
          item: {
            type: "commandExecution",
            id: "exec-1",
            command: "/bin/zsh -lc 'rg -n \"SearchMenu\" packages/excalidraw'",
            cwd: "/repo",
            aggregatedOutput:
              "packages/excalidraw/components/SearchMenu.tsx:14:export function SearchMenu()",
            exitCode: 0,
            status: "completed",
            parentToolCallId: "agent-1",
          },
        },
        createdAt: 3,
        scope: turnScope("turn-1"),
      },
      {
        id: "evt-4",
        threadId: "thread-1",
        seq: 4,
        type: "item/completed",
        data: {
          threadId: "thread-1",
          providerThreadId: "provider-thread-1",
          turnId: "turn-1",
          item: {
            type: "toolCall",
            id: "agent-1",
            tool: "Agent",
            status: "completed",
            result: "Found the SearchMenu component and surrounding tests.",
          },
        },
        createdAt: 4,
        scope: turnScope("turn-1"),
      },
    ];

    const projected = toViewMessages(fromRows(events), {
      threadStatus: "idle",
    });
    const delegation = projected.find(
      (message): message is Extract<ViewMessage, { kind: "delegation" }> =>
        message.kind === "delegation",
    );

    expect(delegation).toBeDefined();
    expect(delegation).toMatchObject({
      toolName: "Agent",
      callId: "agent-1",
      subagentType: "Explore",
      description: "Explore SearchMenu implementation",
      status: "completed",
      sourceSeqStart: 1,
      sourceSeqEnd: 4,
    });
    const childMessages = delegation
      ? flattenProjectionMessages(delegation.childProjection)
      : [];
    expect(childMessages).toHaveLength(1);
    expect(childMessages[0]?.kind).toBe("command");
    if (childMessages[0]?.kind === "command") {
      expect(childMessages[0].callId).toBe("exec-1");
      expect(childMessages[0].status).toBe("completed");
    }
  });

  it("infers delegated child activity from provider child thread ids", () => {
    const events: ThreadEventRow[] = [
      {
        id: "evt-1",
        threadId: "thread-1",
        seq: 1,
        type: "item/started",
        data: {
          threadId: "thread-1",
          providerThreadId: "provider-thread-1",
          turnId: "turn-1",
          item: {
            type: "toolCall",
            id: "agent-1",
            tool: "spawnAgent",
            arguments: {
              receiverThreadIds: ["provider-thread-child-1"],
              prompt: "Explore SearchMenu implementation",
            },
            status: "pending",
          },
        },
        createdAt: 1,
        scope: turnScope("turn-1"),
      },
      {
        id: "evt-2",
        threadId: "thread-1",
        seq: 2,
        type: "item/completed",
        data: {
          threadId: "thread-1",
          providerThreadId: "provider-thread-1",
          turnId: "turn-1",
          item: {
            type: "toolCall",
            id: "agent-1",
            tool: "spawnAgent",
            arguments: {
              receiverThreadIds: ["provider-thread-child-1"],
              prompt: "Explore SearchMenu implementation",
            },
            status: "completed",
            result: {
              "provider-thread-child-1": {
                status: "completed",
              },
            },
          },
        },
        createdAt: 2,
        scope: turnScope("turn-1"),
      },
      {
        id: "evt-3",
        threadId: "thread-1",
        seq: 3,
        type: "item/started",
        data: {
          threadId: "thread-1",
          providerThreadId: "provider-thread-child-1",
          turnId: "turn-1",
          item: {
            type: "commandExecution",
            id: "exec-1",
            command: "/bin/zsh -lc 'rg -n \"SearchMenu\" packages/excalidraw'",
            cwd: "/repo",
            status: "pending",
          },
        },
        createdAt: 3,
        scope: turnScope("turn-1"),
      },
      {
        id: "evt-4",
        threadId: "thread-1",
        seq: 4,
        type: "item/completed",
        data: {
          threadId: "thread-1",
          providerThreadId: "provider-thread-child-1",
          turnId: "turn-1",
          item: {
            type: "commandExecution",
            id: "exec-1",
            command: "/bin/zsh -lc 'rg -n \"SearchMenu\" packages/excalidraw'",
            cwd: "/repo",
            aggregatedOutput:
              "packages/excalidraw/components/SearchMenu.tsx:14:export function SearchMenu()",
            exitCode: 0,
            status: "completed",
          },
        },
        createdAt: 4,
        scope: turnScope("turn-1"),
      },
      {
        id: "evt-5",
        threadId: "thread-1",
        seq: 5,
        type: "item/completed",
        data: {
          threadId: "thread-1",
          providerThreadId: "provider-thread-1",
          turnId: "turn-1",
          item: {
            type: "toolCall",
            id: "wait-1",
            tool: "wait",
            arguments: {
              receiverThreadIds: ["provider-thread-child-1"],
            },
            status: "completed",
            result: {
              "provider-thread-child-1": {
                status: "completed",
              },
            },
          },
        },
        createdAt: 5,
        scope: turnScope("turn-1"),
      },
    ];

    const projected = toViewMessages(fromRows(events), {
      threadStatus: "idle",
    });
    const delegation = projected.find(
      (message): message is Extract<ViewMessage, { kind: "delegation" }> =>
        message.kind === "delegation",
    );

    expect(delegation).toBeDefined();
    expect(delegation).toMatchObject({
      callId: "agent-1",
      description: "Explore SearchMenu implementation",
    });
    const childMessages = delegation
      ? flattenProjectionMessages(delegation.childProjection)
      : [];
    expect(childMessages).toHaveLength(2);
    expect(childMessages[0]?.kind).toBe("command");
    expect(childMessages[1]?.kind).toBe("tool-call");

    if (childMessages[0]?.kind === "command") {
      expect(childMessages[0].callId).toBe("exec-1");
      expect(childMessages[0].status).toBe("completed");
    }

    if (childMessages[1]?.kind === "tool-call") {
      expect(childMessages[1].toolName).toBe("wait");
      expect(childMessages[1].parentToolCallId).toBe("agent-1");
    }
  });

  it("updates flushed pending tool calls in place without appending duplicate interrupted rows", () => {
    const events: ThreadEventRow[] = [
      {
        id: "evt-1",
        threadId: "thread-1",
        seq: 1,
        type: "item/started",
        data: {
          providerThreadId: "thread-1",
          item: {
            type: "commandExecution",
            id: "call-1",
            command: "/bin/zsh -lc 'git rebase --continue'",
            cwd: "/repo",
            status: "pending",
          },
          turnId: "turn-1",
        },
        createdAt: 1,
        scope: turnScope("turn-1"),
      },
      {
        id: "evt-2",
        threadId: "thread-1",
        seq: 2,
        type: "item/commandExecution/outputDelta",
        data: {
          providerThreadId: "thread-1",
          threadId: "thread-1",
          turnId: "turn-1",
          itemId: "call-1",
          delta: "opened COMMIT_EDITMSG",
        },
        createdAt: 2,
        scope: turnScope("turn-1"),
      },
      {
        id: "evt-3",
        threadId: "thread-1",
        seq: 3,
        type: "item/reasoning/summaryTextDelta",
        data: {
          providerThreadId: "thread-1",
          threadId: "thread-1",
          turnId: "turn-1",
          itemId: "rs-1",
          delta: "thinking",
        },
        createdAt: 3,
        scope: turnScope("turn-1"),
      },
    ];

    const projected = toViewMessages(fromRows(events), {
      threadStatus: "idle",
    });
    const tools = projected.filter(
      (message): message is Extract<ViewMessage, { kind: "command" }> =>
        message.kind === "command" && message.callId === "call-1",
    );

    expect(tools).toHaveLength(1);
    expect(tools[0]?.status).toBe("interrupted");
    expect(tools[0]?.output).toContain("opened COMMIT_EDITMSG");
    assertMonotonicSourceSeq(projected);
  });

  it("keeps in-progress tools pending for active threads", () => {
    const events: ThreadEventRow[] = [
      {
        id: "evt-1",
        threadId: "thread-1",
        seq: 1,
        type: "item/started",
        data: {
          providerThreadId: "thread-1",
          item: {
            type: "commandExecution",
            id: "call-1",
            command: "/bin/zsh -lc 'ls plans'",
            cwd: "/repo",
            status: "pending",
          },
          turnId: "turn-1",
        },
        createdAt: 1,
        scope: turnScope("turn-1"),
      },
    ];

    const projected = toViewMessages(fromRows(events), {
      threadStatus: "active",
    });
    const toolMessage = projected.find(isCommandMessage);

    expect(toolMessage).toBeDefined();
    expect(toolMessage?.status).toBe("pending");
  });

  it("interrupts pending subagents from an old interrupted turn while preserving active follow-up work", () => {
    const factory = createTimelineEventFactory({ threadId: "thread-1" });
    const events: ThreadEventRow[] = [
      factory.turnStarted({ turnId: "turn-1" }),
      factory.toolCallStarted({
        turnId: "turn-1",
        itemId: "agent-old",
        tool: "Agent",
        arguments: {
          subagent_type: "Explore",
          description: "Inspect lifecycle recovery",
        },
      }),
      factory.turnCompleted({
        turnId: "turn-1",
        status: "interrupted",
      }),
      factory.clientTurnRequested({
        text: "Keep going",
      }),
      factory.turnStarted({ turnId: "turn-2" }),
      factory.toolCallStarted({
        turnId: "turn-2",
        itemId: "agent-new",
        tool: "Agent",
        arguments: {
          subagent_type: "Explore",
          description: "Continue lifecycle recovery",
        },
      }),
    ];

    const projected = toViewMessages(fromRows(events), {
      threadStatus: "active",
    });
    const delegations = projected.filter(
      (message): message is Extract<ViewMessage, { kind: "delegation" }> =>
        message.kind === "delegation",
    );
    const delegationByCallId = new Map(
      delegations.map((message) => [message.callId, message]),
    );

    expect(delegationByCallId.get("agent-old")).toMatchObject({
      status: "interrupted",
      output: "Tool execution interrupted",
    });
    expect(delegationByCallId.get("agent-new")).toMatchObject({
      status: "pending",
    });
  });

  it("coalesces command output deltas and completion state", () => {
    const events: ThreadEventRow[] = [
      {
        id: "evt-1",
        threadId: "thread-1",
        seq: 1,
        type: "item/started",
        data: {
          providerThreadId: "thread-1",
          item: {
            type: "commandExecution",
            id: "call-1",
            command: "/bin/zsh -lc 'ls plans'",
            cwd: "/repo",
            status: "pending",
          },
          turnId: "turn-1",
        },
        createdAt: 1,
        scope: turnScope("turn-1"),
      },
      {
        id: "evt-2",
        threadId: "thread-1",
        seq: 2,
        type: "item/commandExecution/outputDelta",
        data: {
          providerThreadId: "thread-1",
          threadId: "thread-1",
          turnId: "turn-1",
          itemId: "call-1",
          delta: "first\n",
        },
        createdAt: 2,
        scope: turnScope("turn-1"),
      },
      {
        id: "evt-3",
        threadId: "thread-1",
        seq: 3,
        type: "item/commandExecution/outputDelta",
        data: {
          providerThreadId: "thread-1",
          threadId: "thread-1",
          turnId: "turn-1",
          itemId: "call-1",
          delta: "second\n",
        },
        createdAt: 3,
        scope: turnScope("turn-1"),
      },
      {
        id: "evt-4",
        threadId: "thread-1",
        seq: 4,
        type: "item/completed",
        data: {
          providerThreadId: "thread-1",
          item: {
            type: "commandExecution",
            id: "call-1",
            command: "/bin/zsh -lc 'ls plans'",
            cwd: "/repo",
            aggregatedOutput: "first\nsecond\n",
            exitCode: 0,
            status: "completed",
          },
          turnId: "turn-1",
        },
        createdAt: 4,
        scope: turnScope("turn-1"),
      },
    ];

    const projected = toViewMessages(fromRows(events), {
      threadStatus: "idle",
    });
    const toolMessage = projected.find(isCommandMessage);

    expect(toolMessage).toBeDefined();
    expect(toolMessage?.status).toBe("completed");
    expect(toolMessage?.output).toContain("first");
    expect(toolMessage?.output).toContain("second");
  });

  it("replaces command output when a provider emits a reset delta", () => {
    const events: ThreadEventRow[] = [
      {
        id: "evt-1",
        threadId: "thread-1",
        seq: 1,
        type: "item/started",
        data: {
          providerThreadId: "thread-1",
          item: {
            type: "commandExecution",
            id: "call-1",
            command: "/bin/zsh -lc 'printf first second'",
            cwd: "/repo",
            status: "pending",
          },
          turnId: "turn-1",
        },
        createdAt: 1,
        scope: turnScope("turn-1"),
      },
      {
        id: "evt-2",
        threadId: "thread-1",
        seq: 2,
        type: "item/commandExecution/outputDelta",
        data: {
          providerThreadId: "thread-1",
          threadId: "thread-1",
          turnId: "turn-1",
          itemId: "call-1",
          delta: "first\nsecond\n",
        },
        createdAt: 2,
        scope: turnScope("turn-1"),
      },
      {
        id: "evt-3",
        threadId: "thread-1",
        seq: 3,
        type: "item/commandExecution/outputDelta",
        data: {
          providerThreadId: "thread-1",
          threadId: "thread-1",
          turnId: "turn-1",
          itemId: "call-1",
          delta: "reset\n",
          reset: true,
        },
        createdAt: 3,
        scope: turnScope("turn-1"),
      },
    ];

    const projected = toViewMessages(fromRows(events), {
      threadStatus: "active",
    });
    const toolMessage = projected.find(isCommandMessage);

    expect(toolMessage).toBeDefined();
    expect(toolMessage?.output).toBe("reset\n");
  });

  it("appends output deltas that arrive after a command has completed", () => {
    const events: ThreadEventRow[] = [
      {
        id: "evt-1",
        threadId: "thread-1",
        seq: 1,
        type: "item/started",
        data: {
          providerThreadId: "thread-1",
          item: {
            type: "commandExecution",
            id: "call-1",
            command: "/bin/zsh -lc 'printf first second'",
            cwd: "/repo",
            status: "pending",
          },
          turnId: "turn-1",
        },
        createdAt: 1,
        scope: turnScope("turn-1"),
      },
      {
        id: "evt-2",
        threadId: "thread-1",
        seq: 2,
        type: "item/completed",
        data: {
          providerThreadId: "thread-1",
          item: {
            type: "commandExecution",
            id: "call-1",
            command: "/bin/zsh -lc 'printf first second'",
            cwd: "/repo",
            aggregatedOutput: "first\n",
            exitCode: 0,
            status: "completed",
          },
          turnId: "turn-1",
        },
        createdAt: 2,
        scope: turnScope("turn-1"),
      },
      {
        id: "evt-3",
        threadId: "thread-1",
        seq: 3,
        type: "item/commandExecution/outputDelta",
        data: {
          providerThreadId: "thread-1",
          threadId: "thread-1",
          turnId: "turn-1",
          itemId: "call-1",
          delta: "second\n",
        },
        createdAt: 3,
        scope: turnScope("turn-1"),
      },
    ];

    const projected = toViewMessages(fromRows(events), {
      threadStatus: "idle",
    });
    const toolMessage = projected.find(isCommandMessage);

    expect(toolMessage).toBeDefined();
    expect(toolMessage?.status).toBe("completed");
    expect(toolMessage?.output).toBe("first\nsecond\n");
  });

  it("hides partial command output until a newline or terminal boundary", () => {
    const events: ThreadEventRow[] = [
      {
        id: "evt-1",
        threadId: "thread-1",
        seq: 1,
        type: "item/started",
        data: {
          providerThreadId: "thread-1",
          item: {
            type: "commandExecution",
            id: "call-1",
            command: "/bin/zsh -lc 'printf partial'",
            cwd: "/repo",
            status: "pending",
          },
          turnId: "turn-1",
        },
        createdAt: 1,
        scope: turnScope("turn-1"),
      },
      {
        id: "evt-2",
        threadId: "thread-1",
        seq: 2,
        type: "item/commandExecution/outputDelta",
        data: {
          providerThreadId: "thread-1",
          threadId: "thread-1",
          turnId: "turn-1",
          itemId: "call-1",
          delta: "partial",
        },
        createdAt: 2,
        scope: turnScope("turn-1"),
      },
      {
        id: "evt-3",
        threadId: "thread-1",
        seq: 3,
        type: "item/commandExecution/outputDelta",
        data: {
          providerThreadId: "thread-1",
          threadId: "thread-1",
          turnId: "turn-1",
          itemId: "call-1",
          delta: "\ntrailing",
        },
        createdAt: 3,
        scope: turnScope("turn-1"),
      },
    ];

    const projected = toViewMessages(fromRows(events), {
      threadStatus: "active",
    });
    const toolMessage = projected.find(isCommandMessage);

    expect(toolMessage).toBeDefined();
    expect(toolMessage?.output).toBe("partial\n");
    expect(toolMessage?.status).toBe("pending");
  });

  it("flushes partial command output before interruption markers", () => {
    const events: ThreadEventRow[] = [
      {
        id: "evt-1",
        threadId: "thread-1",
        seq: 1,
        type: "item/started",
        data: {
          providerThreadId: "thread-1",
          item: {
            type: "commandExecution",
            id: "call-1",
            command: "/bin/zsh -lc 'printf partial'",
            cwd: "/repo",
            status: "pending",
          },
          turnId: "turn-1",
        },
        createdAt: 1,
        scope: turnScope("turn-1"),
      },
      {
        id: "evt-2",
        threadId: "thread-1",
        seq: 2,
        type: "item/commandExecution/outputDelta",
        data: {
          providerThreadId: "thread-1",
          threadId: "thread-1",
          turnId: "turn-1",
          itemId: "call-1",
          delta: "partial",
        },
        createdAt: 2,
        scope: turnScope("turn-1"),
      },
      {
        id: "evt-3",
        threadId: "thread-1",
        seq: 3,
        type: "system/thread/interrupted",
        data: {
          threadId: "thread-1",
          turnId: "turn-1",
          reason: "manual-stop",
        },
        createdAt: 3,
        scope: threadScope(),
      },
    ];

    const projected = toViewMessages(fromRows(events), {
      threadStatus: "idle",
    });
    const toolMessage = projected.find(isCommandMessage);

    expect(toolMessage?.output).toBe("partial");
    expect(toolMessage?.status).toBe("interrupted");
  });

  it("projects consecutive exploring toolCall calls as ordinary tool calls", () => {
    const events: ThreadEventRow[] = [
      {
        id: "evt-1",
        threadId: "thread-1",
        seq: 1,
        type: "item/started",
        data: {
          providerThreadId: "thread-1",
          turnId: "turn-1",
          item: {
            type: "toolCall",
            id: "call-1",
            tool: "Read",
            arguments: { file_path: "/repo/README.md" },
            status: "pending",
          },
        },
        createdAt: 1,
        scope: turnScope("turn-1"),
      },
      {
        id: "evt-2",
        threadId: "thread-1",
        seq: 2,
        type: "item/completed",
        data: {
          providerThreadId: "thread-1",
          turnId: "turn-1",
          item: {
            type: "toolCall",
            id: "call-1",
            tool: "Read",
            arguments: { file_path: "/repo/README.md" },
            result: "README",
            status: "completed",
          },
        },
        createdAt: 2,
        scope: turnScope("turn-1"),
      },
      {
        id: "evt-3",
        threadId: "thread-1",
        seq: 3,
        type: "item/started",
        data: {
          providerThreadId: "thread-1",
          turnId: "turn-1",
          item: {
            type: "toolCall",
            id: "call-2",
            tool: "Read",
            arguments: { file_path: "/repo/package.json" },
            status: "pending",
          },
        },
        createdAt: 3,
        scope: turnScope("turn-1"),
      },
      {
        id: "evt-4",
        threadId: "thread-1",
        seq: 4,
        type: "item/completed",
        data: {
          providerThreadId: "thread-1",
          turnId: "turn-1",
          item: {
            type: "toolCall",
            id: "call-2",
            tool: "Read",
            arguments: { file_path: "/repo/package.json" },
            result: "{}",
            status: "completed",
          },
        },
        createdAt: 4,
        scope: turnScope("turn-1"),
      },
    ];

    const projected = toViewMessages(fromRows(events), {
      threadStatus: "idle",
    });
    const toolCalls = projected.filter(isToolCallMessage);

    expect(toolCalls).toHaveLength(2);
    expect(toolCalls.map((message) => message.callId)).toEqual([
      "call-1",
      "call-2",
    ]);
    expect(toolCalls.map((message) => message.status)).toEqual([
      "completed",
      "completed",
    ]);
  });

  it("updates a flushed exploring tool-call cell when completion arrives later", () => {
    const events: ThreadEventRow[] = [
      {
        id: "evt-1",
        threadId: "thread-1",
        seq: 1,
        type: "item/started",
        data: {
          providerThreadId: "thread-1",
          turnId: "turn-1",
          item: {
            type: "toolCall",
            id: "call-1",
            tool: "Read",
            arguments: { file_path: "/repo/README.md" },
            status: "pending",
          },
        },
        createdAt: 1,
        scope: turnScope("turn-1"),
      },
      {
        id: "evt-2",
        threadId: "thread-1",
        seq: 2,
        type: "thread/name/updated",
        data: {
          providerThreadId: "thread-1",
          threadId: "thread-1",
          threadName: "server restart bug",
        },
        createdAt: 2,
        scope: threadScope(),
      },
      {
        id: "evt-3",
        threadId: "thread-1",
        seq: 3,
        type: "item/completed",
        data: {
          providerThreadId: "thread-1",
          turnId: "turn-1",
          item: {
            type: "toolCall",
            id: "call-1",
            tool: "Read",
            arguments: { file_path: "/repo/README.md" },
            result: "README",
            status: "completed",
          },
        },
        createdAt: 3,
        scope: turnScope("turn-1"),
      },
    ];

    const projected = toViewMessages(fromRows(events), {
      threadStatus: "active",
    });

    const toolCalls = projected.filter(isToolCallMessage);
    expect(toolCalls).toHaveLength(1);
    expect(toolCalls[0]?.status).toBe("completed");
    expect(toolCalls[0]?.sourceSeqStart).toBe(1);
    expect(toolCalls[0]?.sourceSeqEnd).toBe(3);
    expect(toolCalls[0]?.callId).toBe("call-1");
  });

  it("updates a flushed tool-call cell when completion arrives later", () => {
    const events: ThreadEventRow[] = [
      {
        id: "evt-1",
        threadId: "thread-1",
        seq: 1,
        type: "item/started",
        data: {
          providerThreadId: "thread-1",
          turnId: "turn-1",
          item: {
            type: "commandExecution",
            id: "call-1",
            command: "/bin/zsh -lc 'pnpm test'",
            cwd: "/repo",
            status: "pending",
          },
        },
        createdAt: 1,
        scope: turnScope("turn-1"),
      },
      {
        id: "evt-2",
        threadId: "thread-1",
        seq: 2,
        type: "thread/name/updated",
        data: {
          providerThreadId: "thread-1",
          threadId: "thread-1",
          threadName: "new thread name",
        },
        createdAt: 2,
        scope: threadScope(),
      },
      {
        id: "evt-3",
        threadId: "thread-1",
        seq: 3,
        type: "item/completed",
        data: {
          providerThreadId: "thread-1",
          turnId: "turn-1",
          item: {
            type: "commandExecution",
            id: "call-1",
            command: "/bin/zsh -lc 'pnpm test'",
            cwd: "/repo",
            aggregatedOutput: "ok",
            exitCode: 0,
            status: "completed",
          },
        },
        createdAt: 3,
        scope: turnScope("turn-1"),
      },
    ];

    const projected = toViewMessages(fromRows(events), {
      threadStatus: "active",
    });

    const toolCalls = projected.filter(isCommandMessage);
    expect(toolCalls).toHaveLength(1);
    expect(toolCalls[0]?.status).toBe("completed");
    expect(toolCalls[0]?.sourceSeqStart).toBe(1);
    expect(toolCalls[0]?.sourceSeqEnd).toBe(3);
    expect(toolCalls[0]?.output).toBe("ok");
  });

  it("flushes completed non-exploring exec cells before assistant text", () => {
    const events: ThreadEventRow[] = [
      {
        id: "evt-1",
        threadId: "thread-1",
        seq: 1,
        type: "item/started",
        data: {
          providerThreadId: "thread-1",
          turnId: "turn-1",
          item: {
            type: "commandExecution",
            id: "call-1",
            command: "/bin/zsh -lc 'npm test'",
            cwd: "/repo",
            status: "pending",
          },
        },
        createdAt: 1,
        scope: turnScope("turn-1"),
      },
      {
        id: "evt-2",
        threadId: "thread-1",
        seq: 2,
        type: "item/completed",
        data: {
          providerThreadId: "thread-1",
          turnId: "turn-1",
          item: {
            type: "commandExecution",
            id: "call-1",
            command: "/bin/zsh -lc 'npm test'",
            cwd: "/repo",
            aggregatedOutput: "ok",
            exitCode: 0,
            status: "completed",
          },
        },
        createdAt: 2,
        scope: turnScope("turn-1"),
      },
      {
        id: "evt-3",
        threadId: "thread-1",
        seq: 3,
        type: "item/completed",
        data: {
          providerThreadId: "thread-1",
          threadId: "thread-1",
          turnId: "turn-1",
          item: {
            type: "agentMessage",
            id: "msg-1",
            text: "done",
          },
        },
        createdAt: 3,
        scope: turnScope("turn-1"),
      },
    ];

    const projected = toViewMessages(fromRows(events), {
      threadStatus: "idle",
    });
    expect(projected.map((message) => message.kind)).toEqual([
      "command",
      "assistant-text",
    ]);
  });

  it("projects item web search lifecycle as dedicated web-search cells", () => {
    const events: ThreadEventRow[] = [
      {
        id: "evt-1",
        threadId: "thread-1",
        seq: 1,
        type: "item/started",
        data: {
          providerThreadId: "thread-1",
          turnId: "turn-1",
          item: {
            type: "webSearch",
            id: "web-1",
            queries: ["react suspense"],
            resultText: null,
          },
        },
        createdAt: 1,
        scope: turnScope("turn-1"),
      },
      {
        id: "evt-2",
        threadId: "thread-1",
        seq: 2,
        type: "item/completed",
        data: {
          providerThreadId: "thread-1",
          turnId: "turn-1",
          item: {
            type: "webSearch",
            id: "web-1",
            queries: ["react suspense"],
            resultText: "Found the React Suspense docs",
          },
        },
        createdAt: 2,
        scope: turnScope("turn-1"),
      },
    ];

    const projected = toViewMessages(fromRows(events), {
      threadStatus: "idle",
    });
    const search = projected.find(
      (message): message is Extract<ViewMessage, { kind: "web-search" }> =>
        message.kind === "web-search",
    );

    expect(search).toBeDefined();
    expect(search?.status).toBe("completed");
    expect(search?.queries).toEqual(["react suspense"]);
    expect(search?.resultText).toBe("Found the React Suspense docs");
  });

  it("merges a completed web search into a flushed pending web-search cell", () => {
    const events: ThreadEventRow[] = [
      {
        id: "evt-1",
        threadId: "thread-1",
        seq: 1,
        type: "item/started",
        data: {
          providerThreadId: "thread-1",
          turnId: "turn-1",
          item: {
            type: "webSearch",
            id: "web-1",
            queries: ["react suspense"],
            resultText: null,
          },
        },
        createdAt: 1,
        scope: turnScope("turn-1"),
      },
      {
        id: "evt-2",
        threadId: "thread-1",
        seq: 2,
        type: "item/completed",
        data: {
          providerThreadId: "thread-1",
          turnId: "turn-1",
          item: {
            type: "agentMessage",
            id: "assistant-1",
            text: "I found the relevant docs.",
          },
        },
        createdAt: 2,
        scope: turnScope("turn-1"),
      },
      {
        id: "evt-3",
        threadId: "thread-1",
        seq: 3,
        type: "item/completed",
        data: {
          providerThreadId: "thread-1",
          turnId: "turn-1",
          item: {
            type: "webSearch",
            id: "web-1",
            queries: ["react suspense"],
            resultText: "Found the React Suspense docs",
          },
        },
        createdAt: 3,
        scope: turnScope("turn-1"),
      },
    ];

    const projected = toViewMessages(fromRows(events), {
      threadStatus: "idle",
    });
    const searches = projected.filter(
      (message): message is Extract<ViewMessage, { kind: "web-search" }> =>
        message.kind === "web-search",
    );

    expect(searches).toHaveLength(1);
    expect(searches[0]).toMatchObject({
      id: "thread-1:web-search:web-1",
      sourceSeqStart: 1,
      sourceSeqEnd: 3,
      createdAt: 3,
      status: "completed",
      queries: ["react suspense"],
      resultText: "Found the React Suspense docs",
    });
  });

  it("projects item web fetch lifecycle as dedicated web-fetch cells", () => {
    const events: ThreadEventRow[] = [
      {
        id: "evt-1",
        threadId: "thread-1",
        seq: 1,
        type: "item/completed",
        data: {
          providerThreadId: "thread-1",
          turnId: "turn-1",
          item: {
            type: "webFetch",
            id: "web-fetch-1",
            url: "https://example.com",
            prompt: "page title",
            pattern: null,
            resultText: "Example Domain",
          },
        },
        createdAt: 1,
        scope: turnScope("turn-1"),
      },
    ];

    const projected = toViewMessages(fromRows(events), {
      threadStatus: "idle",
    });
    const fetch = projected.find(
      (message): message is Extract<ViewMessage, { kind: "web-fetch" }> =>
        message.kind === "web-fetch",
    );

    expect(fetch).toBeDefined();
    expect(fetch).toMatchObject({
      url: "https://example.com",
      prompt: "page title",
      pattern: null,
      resultText: "Example Domain",
    });
  });

  it("interrupts mismatched pending web rows before projecting a new web activity kind", () => {
    const events: ThreadEventRow[] = [
      {
        id: "evt-1",
        threadId: "thread-1",
        seq: 1,
        type: "item/started",
        data: {
          providerThreadId: "thread-1",
          turnId: "turn-1",
          item: {
            type: "webSearch",
            id: "web-shared-1",
            queries: ["react suspense"],
            resultText: null,
          },
        },
        createdAt: 1,
        scope: turnScope("turn-1"),
      },
      {
        id: "evt-2",
        threadId: "thread-1",
        seq: 2,
        type: "item/completed",
        data: {
          providerThreadId: "thread-1",
          turnId: "turn-1",
          item: {
            type: "webFetch",
            id: "web-shared-1",
            url: "https://example.com",
            prompt: null,
            pattern: null,
            resultText: "Example Domain",
          },
        },
        createdAt: 2,
        scope: turnScope("turn-1"),
      },
    ];

    const projected = toViewMessages(fromRows(events), {
      threadStatus: "idle",
    });
    const webMessages = projected.filter(
      (
        message,
      ): message is Extract<
        ViewMessage,
        { kind: "web-search" | "web-fetch" }
      > => message.kind === "web-search" || message.kind === "web-fetch",
    );

    expect(webMessages).toHaveLength(2);
    expect(webMessages).toMatchObject([
      {
        kind: "web-search",
        callId: "web-shared-1",
        status: "interrupted",
        queries: ["react suspense"],
      },
      {
        kind: "web-fetch",
        callId: "web-shared-1",
        status: "completed",
        url: "https://example.com",
      },
    ]);
  });

  it("merges file-change lifecycle with output delta details", () => {
    const events: ThreadEventRow[] = [
      {
        id: "evt-1",
        threadId: "thread-1",
        seq: 1,
        type: "item/started",
        data: {
          providerThreadId: "thread-1",
          item: {
            type: "fileChange",
            id: "call-edit-1",
            status: "pending",
            changes: [
              {
                path: "/repo/src/a.ts",
                kind: "update",
                diff: "@@ -1 +1 @@",
              },
            ],
          },
          turnId: "turn-1",
        },
        createdAt: 1,
        scope: turnScope("turn-1"),
      },
      {
        id: "evt-2",
        threadId: "thread-1",
        seq: 2,
        type: "item/fileChange/outputDelta",
        data: {
          providerThreadId: "thread-1",
          threadId: "thread-1",
          turnId: "turn-1",
          itemId: "call-edit-1",
          delta: "patched",
        },
        createdAt: 2,
        scope: turnScope("turn-1"),
      },
      {
        id: "evt-3",
        threadId: "thread-1",
        seq: 3,
        type: "item/completed",
        data: {
          providerThreadId: "thread-1",
          item: {
            type: "fileChange",
            id: "call-edit-1",
            status: "completed",
            changes: [
              {
                path: "/repo/src/a.ts",
                kind: "update",
                diff: "@@ -1 +1,2 @@",
              },
            ],
          },
          turnId: "turn-1",
        },
        createdAt: 3,
        scope: turnScope("turn-1"),
      },
    ];

    const projected = toViewMessages(fromRows(events), {
      threadStatus: "idle",
    });
    const fileEdit = projected.find(
      (message): message is Extract<ViewMessage, { kind: "file-edit" }> =>
        message.kind === "file-edit",
    );

    expect(fileEdit).toBeDefined();
    expect(fileEdit?.status).toBe("completed");
    expect(fileEdit?.changes).toHaveLength(1);
    expect(fileEdit?.changes[0]?.path).toBe("/repo/src/a.ts");
    expect(fileEdit?.stdout).toContain("patched");
  });

  it("keeps file-change stdout hidden until a newline or terminal boundary", () => {
    const events: ThreadEventRow[] = [
      {
        id: "evt-1",
        threadId: "thread-1",
        seq: 1,
        type: "item/started",
        data: {
          providerThreadId: "thread-1",
          item: {
            type: "fileChange",
            id: "call-edit-1",
            status: "pending",
            changes: [],
          },
          turnId: "turn-1",
        },
        createdAt: 1,
        scope: turnScope("turn-1"),
      },
      {
        id: "evt-2",
        threadId: "thread-1",
        seq: 2,
        type: "item/fileChange/outputDelta",
        data: {
          providerThreadId: "thread-1",
          threadId: "thread-1",
          turnId: "turn-1",
          itemId: "call-edit-1",
          delta: "patched",
        },
        createdAt: 2,
        scope: turnScope("turn-1"),
      },
      {
        id: "evt-3",
        threadId: "thread-1",
        seq: 3,
        type: "item/fileChange/outputDelta",
        data: {
          providerThreadId: "thread-1",
          threadId: "thread-1",
          turnId: "turn-1",
          itemId: "call-edit-1",
          delta: "\ntrailing",
        },
        createdAt: 3,
        scope: turnScope("turn-1"),
      },
    ];

    const projected = toViewMessages(fromRows(events), {
      threadStatus: "active",
    });
    const fileEdit = projected.find(
      (message): message is Extract<ViewMessage, { kind: "file-edit" }> =>
        message.kind === "file-edit",
    );

    expect(fileEdit?.stdout).toBe("patched\n");
    expect(fileEdit?.status).toBe("pending");
  });

  it("maps interrupted command executions to interrupted status", () => {
    const events: ThreadEventRow[] = [
      {
        id: "evt-1",
        threadId: "thread-1",
        seq: 1,
        type: "item/completed",
        data: {
          providerThreadId: "thread-1",
          item: {
            type: "commandExecution",
            id: "call-declined-1",
            status: "interrupted",
            command: "/bin/zsh -lc 'rm -rf /tmp/nope'",
            cwd: "/repo",
          },
          turnId: "turn-1",
        },
        createdAt: 1,
        scope: turnScope("turn-1"),
      },
    ];

    const projected = toViewMessages(fromRows(events), {
      threadStatus: "idle",
    });
    const tool = projected.find(isCommandMessage);

    expect(tool).toBeDefined();
    expect(tool?.status).toBe("interrupted");
  });

  it("maps interrupted file changes to interrupted status", () => {
    const events: ThreadEventRow[] = [
      {
        id: "evt-1",
        threadId: "thread-1",
        seq: 1,
        type: "item/completed",
        data: {
          providerThreadId: "thread-1",
          item: {
            type: "fileChange",
            id: "file-declined-1",
            status: "interrupted",
            changes: [
              {
                path: "/repo/src/example.ts",
                kind: "update",
                diff: "@@ -1 +1 @@",
              },
            ],
          },
          turnId: "turn-1",
        },
        createdAt: 1,
        scope: turnScope("turn-1"),
      },
    ];

    const projected = toViewMessages(fromRows(events), {
      threadStatus: "idle",
    });
    const fileEdit = projected.find(
      (message): message is Extract<ViewMessage, { kind: "file-edit" }> =>
        message.kind === "file-edit",
    );

    expect(fileEdit).toBeDefined();
    expect(fileEdit?.status).toBe("interrupted");
  });

  it("preserves add/delete file-change kinds from item completion events", () => {
    const events: ThreadEventRow[] = [
      {
        id: "evt-1",
        threadId: "thread-1",
        seq: 1,
        type: "item/completed",
        data: {
          providerThreadId: "thread-1",
          item: {
            type: "fileChange",
            id: "call-edit-2",
            status: "completed",
            changes: [
              {
                path: "/repo/src/new-file.ts",
                kind: "add",
                diff: "export const created = true;\n",
              },
              {
                path: "/repo/src/old-file.ts",
                kind: "delete",
                diff: "export const removed = true;\n",
              },
            ],
          },
          turnId: "turn-1",
        },
        createdAt: 1,
        scope: turnScope("turn-1"),
      },
    ];

    const projected = toViewMessages(fromRows(events), {
      threadStatus: "idle",
    });
    const fileEdit = projected.find(
      (message): message is Extract<ViewMessage, { kind: "file-edit" }> =>
        message.kind === "file-edit",
    );

    expect(fileEdit).toBeDefined();
    expect(fileEdit?.changes).toHaveLength(2);
    expect(
      fileEdit?.changes.find((change) => change.path.endsWith("new-file.ts"))
        ?.kind,
    ).toBe("add");
    expect(
      fileEdit?.changes.find((change) => change.path.endsWith("old-file.ts"))
        ?.kind,
    ).toBe("delete");
  });

  it("projects shared tool progress onto the active tool call", () => {
    const projected = toViewMessages(
      fromRows([
        {
          id: "evt-1",
          threadId: "thread-1",
          seq: 1,
          type: "item/started",
          data: {
            providerThreadId: "thread-1",
            turnId: "turn-1",
            item: {
              type: "toolCall",
              id: "tool-1",
              tool: "bash",
              arguments: { command: "npm test" },
              status: "pending",
            },
          },
          createdAt: 1,
          scope: turnScope("turn-1"),
        },
        {
          id: "evt-2",
          threadId: "thread-1",
          seq: 2,
          type: "item/toolCall/progress",
          data: {
            providerThreadId: "provider-thread-1",
            turnId: "turn-1",
            itemId: "tool-1",
            message: "partial output",
          },
          createdAt: 2,
          scope: turnScope("turn-1"),
        },
      ]),
      {
        threadStatus: "active",
      },
    );
    const toolCall = projected.find(
      (message): message is Extract<ViewMessage, { kind: "tool-call" }> =>
        message.kind === "tool-call",
    );

    expect(toolCall).toBeDefined();
    expect(toolCall?.status).toBe("pending");
    expect(toolCall?.output).toContain("partial output");
  });

  it("keeps tool calls open through progress events until the completion event arrives", () => {
    const projected = toViewMessages(
      fromRows([
        {
          id: "evt-1",
          threadId: "thread-1",
          seq: 1,
          type: "item/started",
          data: {
            providerThreadId: "thread-1",
            turnId: "turn-1",
            item: {
              type: "toolCall",
              id: "tool-1",
              tool: "bash",
              arguments: { command: "npm test" },
              status: "pending",
            },
          },
          createdAt: 1_000,
          scope: turnScope("turn-1"),
        },
        {
          id: "evt-2",
          threadId: "thread-1",
          seq: 2,
          type: "item/toolCall/progress",
          data: {
            providerThreadId: "provider-thread-1",
            turnId: "turn-1",
            itemId: "tool-1",
            message: "partial output",
          },
          createdAt: 1_500,
          scope: turnScope("turn-1"),
        },
        {
          id: "evt-3",
          threadId: "thread-1",
          seq: 3,
          type: "item/completed",
          data: {
            providerThreadId: "thread-1",
            turnId: "turn-1",
            item: {
              type: "toolCall",
              id: "tool-1",
              tool: "bash",
              arguments: { command: "npm test" },
              status: "completed",
              result: "partial output\nfinal result",
              durationMs: 2_000,
            },
          },
          createdAt: 3_000,
          scope: turnScope("turn-1"),
        },
      ]),
      {
        threadStatus: "idle",
      },
    );
    const toolCall = projected.find(
      (message): message is Extract<ViewMessage, { kind: "tool-call" }> =>
        message.kind === "tool-call",
    );

    expect(toolCall).toBeDefined();
    expect(toolCall?.status).toBe("completed");
    expect(toolCall?.output).toContain("final result");
    expect(toolCall?.durationMs).toBe(2_000);
  });

  it("projects toolCall start + completed end into tool-call message", () => {
    const events: ThreadEventRow[] = [
      {
        id: "evt-1",
        threadId: "thread-1",
        seq: 1,
        type: "item/started",
        data: {
          providerThreadId: "thread-1",
          turnId: "turn-1",
          item: {
            type: "toolCall",
            id: "call-1",
            tool: "my_tool",
            arguments: { message: "hello" },
            status: "pending",
          },
        },
        createdAt: 1,
        scope: turnScope("turn-1"),
      },
      {
        id: "evt-2",
        threadId: "thread-1",
        seq: 2,
        type: "item/completed",
        data: {
          providerThreadId: "thread-1",
          turnId: "turn-1",
          item: {
            type: "toolCall",
            id: "call-1",
            tool: "my_tool",
            arguments: { message: "hello" },
            result: "world",
            status: "completed",
          },
        },
        createdAt: 2,
        scope: turnScope("turn-1"),
      },
    ];

    const projected = toViewMessages(fromRows(events), {
      threadStatus: "idle",
    });
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
    const events: ThreadEventRow[] = [
      {
        id: "evt-1",
        threadId: "thread-1",
        seq: 1,
        type: "item/started",
        data: {
          providerThreadId: "thread-1",
          turnId: "turn-1",
          item: {
            type: "toolCall",
            id: "call-read-1",
            tool: "Read",
            arguments: { file_path: "/src/main.ts" },
            status: "pending",
          },
        },
        createdAt: 1,
        scope: turnScope("turn-1"),
      },
      {
        id: "evt-2",
        threadId: "thread-1",
        seq: 2,
        type: "item/completed",
        data: {
          providerThreadId: "thread-1",
          turnId: "turn-1",
          item: {
            type: "toolCall",
            id: "call-read-1",
            tool: "Read",
            arguments: { file_path: "/src/main.ts" },
            result: "file contents",
            status: "completed",
          },
        },
        createdAt: 2,
        scope: turnScope("turn-1"),
      },
      {
        id: "evt-3",
        threadId: "thread-1",
        seq: 3,
        type: "item/started",
        data: {
          providerThreadId: "thread-1",
          turnId: "turn-1",
          item: {
            type: "toolCall",
            id: "call-grep-1",
            tool: "Grep",
            arguments: { pattern: "TODO", path: "/src" },
            status: "pending",
          },
        },
        createdAt: 3,
        scope: turnScope("turn-1"),
      },
      {
        id: "evt-4",
        threadId: "thread-1",
        seq: 4,
        type: "item/completed",
        data: {
          providerThreadId: "thread-1",
          turnId: "turn-1",
          item: {
            type: "toolCall",
            id: "call-grep-1",
            tool: "Grep",
            arguments: { pattern: "TODO", path: "/src" },
            result: "found matches",
            status: "completed",
          },
        },
        createdAt: 4,
        scope: turnScope("turn-1"),
      },
    ];

    const projected = toViewMessages(fromRows(events), {
      threadStatus: "idle",
    });
    const toolCalls = projected.filter(isToolCallMessage);
    expect(toolCalls.map((message) => message.callId)).toEqual([
      "call-read-1",
      "call-grep-1",
    ]);
  });

  it("projects bridge Bash commandExecution with shell exploration intent", () => {
    // When bridges emit Bash as commandExecution, it should go through
    // the exec lifecycle path directly
    const events: ThreadEventRow[] = [
      {
        id: "evt-1",
        threadId: "thread-1",
        seq: 1,
        type: "item/started",
        data: {
          providerThreadId: "thread-1",
          turnId: "turn-1",
          item: {
            type: "commandExecution",
            id: "call-bash-1",
            command: "ls -la",
            cwd: "/tmp",
            status: "pending",
          },
        },
        createdAt: 1,
        scope: turnScope("turn-1"),
      },
      {
        id: "evt-2",
        threadId: "thread-1",
        seq: 2,
        type: "item/completed",
        data: {
          providerThreadId: "thread-1",
          turnId: "turn-1",
          item: {
            type: "commandExecution",
            id: "call-bash-1",
            command: "ls -la",
            cwd: "/tmp",
            aggregatedOutput: "total 8\ndrwxr-xr-x",
            exitCode: 0,
            status: "completed",
          },
        },
        createdAt: 2,
        scope: turnScope("turn-1"),
      },
    ];

    const projected = toViewMessages(fromRows(events), {
      threadStatus: "idle",
    });
    const toolMessages = projected.filter(isCommandMessage);
    expect(toolMessages).toHaveLength(1);

    expect(toolMessages[0]?.command).toBe("ls -la");
    expect(toolMessages[0]?.output).toBe("total 8\ndrwxr-xr-x");
    expect(toolMessages[0]?.exitCode).toBe(0);
  });

  it("projects toolCall with result into tool-call message", () => {
    const events: ThreadEventRow[] = [
      {
        id: "evt-1",
        threadId: "thread-1",
        seq: 1,
        type: "item/started",
        data: {
          providerThreadId: "thread-1",
          turnId: "turn-1",
          item: {
            type: "toolCall",
            id: "fc-1",
            tool: "get_weather",
            arguments: { city: "London" },
            status: "pending",
          },
        },
        createdAt: 1,
        scope: turnScope("turn-1"),
      },
      {
        id: "evt-2",
        threadId: "thread-1",
        seq: 2,
        type: "item/completed",
        data: {
          providerThreadId: "thread-1",
          turnId: "turn-1",
          item: {
            type: "toolCall",
            id: "fc-1",
            tool: "get_weather",
            arguments: { city: "London" },
            result: "Sunny, 22C",
            status: "completed",
          },
        },
        createdAt: 2,
        scope: turnScope("turn-1"),
      },
    ];

    const projected = toViewMessages(fromRows(events), {
      threadStatus: "idle",
    });
    const toolCalls = projected.filter((m) => m.kind === "tool-call");
    expect(toolCalls).toHaveLength(1);
    if (toolCalls[0]?.kind === "tool-call") {
      expect(toolCalls[0].toolName).toBe("get_weather");
      expect(toolCalls[0].output).toBe("Sunny, 22C");
      expect(toolCalls[0].status).toBe("completed");
    }
  });

  it("interleaves commandExecution and toolCall correctly", () => {
    const events: ThreadEventRow[] = [
      {
        id: "evt-1",
        threadId: "thread-1",
        seq: 1,
        type: "item/started",
        data: {
          providerThreadId: "thread-1",
          turnId: "turn-1",
          item: {
            type: "commandExecution",
            id: "exec-1",
            command: "npm test",
            cwd: "/repo",
            status: "pending",
          },
        },
        createdAt: 1,
        scope: turnScope("turn-1"),
      },
      {
        id: "evt-2",
        threadId: "thread-1",
        seq: 2,
        type: "item/completed",
        data: {
          providerThreadId: "thread-1",
          turnId: "turn-1",
          item: {
            type: "commandExecution",
            id: "exec-1",
            command: "npm test",
            cwd: "/repo",
            aggregatedOutput: "All tests passed",
            exitCode: 0,
            status: "completed",
          },
        },
        createdAt: 2,
        scope: turnScope("turn-1"),
      },
      {
        id: "evt-3",
        threadId: "thread-1",
        seq: 3,
        type: "item/started",
        data: {
          providerThreadId: "thread-1",
          turnId: "turn-1",
          item: {
            type: "toolCall",
            id: "ct-1",
            tool: "deploy",
            arguments: { env: "staging" },
            status: "pending",
          },
        },
        createdAt: 3,
        scope: turnScope("turn-1"),
      },
      {
        id: "evt-4",
        threadId: "thread-1",
        seq: 4,
        type: "item/completed",
        data: {
          providerThreadId: "thread-1",
          turnId: "turn-1",
          item: {
            type: "toolCall",
            id: "ct-1",
            tool: "deploy",
            arguments: { env: "staging" },
            result: "deployed",
            status: "completed",
          },
        },
        createdAt: 4,
        scope: turnScope("turn-1"),
      },
    ];

    const projected = toViewMessages(fromRows(events), {
      threadStatus: "idle",
    });
    const toolMessages = projected.filter(
      (
        message,
      ): message is Extract<ViewMessage, { kind: "command" | "tool-call" }> =>
        message.kind === "command" || message.kind === "tool-call",
    );
    expect(toolMessages).toHaveLength(2);
    expect(toolMessages[0]?.kind).toBe("command");
    expect(toolMessages[1]?.kind).toBe("tool-call");
    if (toolMessages[1]?.kind === "tool-call") {
      expect(toolMessages[1].toolName).toBe("deploy");
    }
  });
});
