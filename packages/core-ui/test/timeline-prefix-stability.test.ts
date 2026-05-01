import { describe, expect, it } from "vitest";
import type { TimelineRow, ViewMessage } from "@bb/domain";
import {
  collectLogicalTimelineRows,
  createTimelineEventFactory,
  expectTerminalRowsNeverRegress,
  renderTimelineFixture,
  type LogicalTimelineRow,
} from "./timeline-test-harness.js";

function provisioningLogicalRow(row: TimelineRow): LogicalTimelineRow | null {
  if (row.kind !== "message") {
    return null;
  }
  const message = row.message;
  if (
    message.kind !== "operation" ||
    message.opType !== "thread-provisioning" ||
    !message.provisioning
  ) {
    return null;
  }
  return {
    key: `provisioning:${message.provisioning.provisioningId}`,
    status: message.status ?? "pending",
    title: message.title,
  };
}

function operationLogicalRow(row: TimelineRow): LogicalTimelineRow | null {
  if (row.kind !== "message") {
    return null;
  }
  const message = row.message;
  if (
    message.kind !== "operation" ||
    message.opType !== "operation" ||
    !message.threadOperation
  ) {
    return null;
  }
  return {
    key: `operation:${message.threadOperation.operationId}`,
    status: message.status ?? "pending",
    title: message.title,
  };
}

function permissionGrantLogicalRow(
  row: TimelineRow,
): LogicalTimelineRow | null {
  if (row.kind !== "message") {
    return null;
  }
  const message = row.message;
  if (message.kind !== "permission-grant-lifecycle") {
    return null;
  }
  return {
    key: `permission-grant:${message.interactionId}`,
    status: message.status,
    title: message.title,
  };
}

function compactionLogicalRow(row: TimelineRow): LogicalTimelineRow | null {
  if (row.kind !== "message") {
    return null;
  }
  const message = row.message;
  if (message.kind !== "operation" || message.opType !== "compaction") {
    return null;
  }
  return {
    key: message.id,
    status: message.status ?? "pending",
    title: message.title,
  };
}

function toolCallLogicalRow(row: TimelineRow): LogicalTimelineRow | null {
  if (row.kind !== "message") {
    return null;
  }
  const message = row.message;
  if (message.kind !== "command" && message.kind !== "tool-call") {
    return null;
  }
  return {
    key: `tool:${message.callId}`,
    status: message.status,
    title:
      message.kind === "tool-call"
        ? (message.command ?? message.toolName)
        : (message.command ?? "command"),
  };
}

function webSearchLogicalRow(row: TimelineRow): LogicalTimelineRow | null {
  if (row.kind !== "message") {
    return null;
  }
  const message = row.message;
  if (message.kind !== "web-search") {
    return null;
  }
  return {
    key: `web-search:${message.callId}`,
    status: message.status,
    title: `Searched ${message.queries[0] ?? "web search"}`,
  };
}

function fileEditLogicalRow(row: TimelineRow): LogicalTimelineRow | null {
  if (row.kind !== "message") {
    return null;
  }
  const message = row.message;
  if (message.kind !== "file-edit") {
    return null;
  }
  return {
    key: `file-edit:${message.callId}`,
    status: message.status,
    title: message.changes[0]?.path ?? "file changes",
  };
}

function taskLogicalRow(row: TimelineRow): LogicalTimelineRow | null {
  if (row.kind !== "message") {
    return null;
  }
  const message = row.message;
  if (message.kind !== "tasks" || !message.callId) {
    return null;
  }
  return {
    key: `tasks:${message.callId}`,
    status: message.status,
    title: message.title,
  };
}

function assistantLogicalRow(row: TimelineRow): LogicalTimelineRow | null {
  if (row.kind !== "message") {
    return null;
  }
  const message = row.message;
  if (message.kind !== "assistant-text") {
    return null;
  }
  return {
    key: message.id,
    status: message.status === "streaming" ? "pending" : "completed",
    title: message.text,
  };
}

function userLogicalRow(row: TimelineRow): LogicalTimelineRow | null {
  if (row.kind !== "message") {
    return null;
  }
  const message = row.message;
  if (message.kind !== "user") {
    return null;
  }
  return {
    key: message.id,
    status: "completed",
    title: message.text,
  };
}

function providerNoticeLogicalRow(row: TimelineRow): LogicalTimelineRow | null {
  if (row.kind !== "message") {
    return null;
  }
  const message = row.message;
  if (message.kind === "error") {
    return {
      key: message.id,
      status: "error",
      title: message.message,
    };
  }
  if (
    message.kind !== "operation" ||
    (message.opType !== "warning" && message.opType !== "provider-unhandled")
  ) {
    return null;
  }
  return {
    key: message.id,
    status: message.status ?? "completed",
    title: message.title,
  };
}

describe("timeline prefix stability", () => {
  it("keeps completed provisioning stable when turn content arrives later", () => {
    const event = createTimelineEventFactory({
      threadId: "thread-1",
      providerThreadId: "provider-thread-1",
      turnId: "turn-1",
    });
    const events = [
      event.threadProvisioning({
        provisioningId: "tpv-prefix",
        status: "active",
        entries: [
          {
            type: "step",
            key: "workspace",
            text: "Preparing workspace",
            status: "started",
          },
        ],
      }),
      event.turnStarted({}),
      event.threadProvisioning({
        provisioningId: "tpv-prefix",
        status: "completed",
        entries: [],
      }),
      event.assistantCompleted({
        itemId: "assistant-1",
        text: "Ready.",
      }),
      event.turnCompleted({}),
    ];

    expectTerminalRowsNeverRegress({
      events,
      projectionOptions: {
        threadStatus: "idle",
        turnMessageDetail: "full",
      },
      resolveRow: provisioningLogicalRow,
      startAt: 3,
    });

    const completedPrefix = renderTimelineFixture({
      events: events.slice(0, 3),
      projectionOptions: {
        threadStatus: "idle",
        turnMessageDetail: "full",
      },
    });
    const contentPrefix = renderTimelineFixture({
      events: events.slice(0, 4),
      projectionOptions: {
        threadStatus: "idle",
        turnMessageDetail: "full",
      },
    });

    expect(
      completedPrefix.rows
        .map((row) => provisioningLogicalRow(row))
        .filter((row): row is LogicalTimelineRow => row !== null),
    ).toEqual([
      {
        key: "provisioning:tpv-prefix",
        status: "completed",
        title: "Provisioned thread",
      },
    ]);
    expect(
      contentPrefix.rows
        .map((row) => provisioningLogicalRow(row))
        .filter((row): row is LogicalTimelineRow => row !== null),
    ).toEqual([
      {
        key: "provisioning:tpv-prefix",
        status: "completed",
        title: "Provisioned thread",
      },
    ]);
  });

  it("keeps correctly ordered provisioning as one completed lifecycle", () => {
    const event = createTimelineEventFactory({
      threadId: "thread-1",
      providerThreadId: "provider-thread-1",
      turnId: "turn-1",
    });
    const events = [
      event.threadProvisioning({
        provisioningId: "tpv-correct-order",
        status: "active",
        entries: [],
      }),
      event.threadProvisioning({
        provisioningId: "tpv-correct-order",
        status: "completed",
        entries: [],
      }),
      event.turnStarted({}),
      event.assistantCompleted({
        itemId: "assistant-1",
        text: "Ready.",
      }),
      event.turnCompleted({}),
    ];

    expectTerminalRowsNeverRegress({
      events,
      projectionOptions: {
        threadStatus: "idle",
        turnMessageDetail: "full",
      },
      resolveRow: provisioningLogicalRow,
      startAt: 2,
    });

    const finalPrefix = renderTimelineFixture({
      events,
      projectionOptions: {
        threadStatus: "idle",
        turnMessageDetail: "full",
      },
    });

    expect(
      collectLogicalTimelineRows({
        rows: finalPrefix.rows,
        resolveRow: provisioningLogicalRow,
      }),
    ).toEqual([
      {
        key: "provisioning:tpv-correct-order",
        status: "completed",
        title: "Provisioned thread",
      },
    ]);
  });

  it("keeps completed system operations stable when turn content arrives later", () => {
    const event = createTimelineEventFactory({
      threadId: "thread-1",
      providerThreadId: "provider-thread-1",
      turnId: "turn-1",
    });
    const events = [
      event.systemOperation({
        operationId: "op-prefix",
        operation: "ownership_change",
        status: "running",
        message: "Ownership change running",
        metadata: { action: "assign" },
      }),
      event.turnStarted({}),
      event.systemOperation({
        operationId: "op-prefix",
        operation: "ownership_change",
        status: "completed",
        message: "Thread assigned to manager",
        metadata: { action: "assign" },
      }),
      event.assistantCompleted({
        itemId: "assistant-1",
        text: "Ready.",
      }),
      event.turnCompleted({}),
    ];

    expectTerminalRowsNeverRegress({
      events,
      projectionOptions: {
        threadStatus: "idle",
        turnMessageDetail: "full",
      },
      resolveRow: operationLogicalRow,
      startAt: 3,
    });

    const contentPrefix = renderTimelineFixture({
      events: events.slice(0, 4),
      projectionOptions: {
        threadStatus: "idle",
        turnMessageDetail: "full",
      },
    });

    expect(
      contentPrefix.rows
        .map((row) => operationLogicalRow(row))
        .filter((row): row is LogicalTimelineRow => row !== null),
    ).toEqual([
      {
        key: "operation:op-prefix",
        status: "completed",
        title: "Thread assigned to manager",
      },
    ]);
  });

  it("keeps completed permission grants stable when turn content arrives later", () => {
    const event = createTimelineEventFactory({
      threadId: "thread-1",
      providerThreadId: "provider-thread-1",
      turnId: "turn-1",
    });
    const events = [
      event.permissionGrantLifecycle({
        interactionId: "pi-prefix",
        status: "pending",
        message: "Waiting for approval to grant Bash",
      }),
      event.turnStarted({}),
      event.permissionGrantLifecycle({
        interactionId: "pi-prefix",
        status: "resolved",
        message: "Approved Bash",
      }),
      event.assistantCompleted({
        itemId: "assistant-1",
        text: "Ready.",
      }),
      event.turnCompleted({}),
    ];

    expectTerminalRowsNeverRegress({
      events,
      projectionOptions: {
        threadStatus: "idle",
        turnMessageDetail: "full",
      },
      resolveRow: permissionGrantLogicalRow,
      startAt: 3,
    });

    const contentPrefix = renderTimelineFixture({
      events: events.slice(0, 4),
      projectionOptions: {
        threadStatus: "idle",
        turnMessageDetail: "full",
      },
    });

    expect(
      contentPrefix.rows
        .map((row) => permissionGrantLogicalRow(row))
        .filter((row): row is LogicalTimelineRow => row !== null),
    ).toEqual([
      {
        key: "permission-grant:pi-prefix",
        status: "completed",
        title: "Approved Bash",
      },
    ]);
  });

  it("lets explicit compaction completion override turn-end inference", () => {
    const event = createTimelineEventFactory({
      threadId: "thread-1",
      providerThreadId: "provider-thread-1",
      turnId: "turn-1",
    });
    const events = [
      event.turnStarted({}),
      event.contextCompactionStarted({
        itemId: "compact-prefix",
      }),
      event.turnCompleted({
        status: "interrupted",
      }),
      event.threadCompacted({}),
      event.assistantCompleted({
        itemId: "assistant-1",
        text: "Ready.",
      }),
    ];

    expectTerminalRowsNeverRegress({
      events,
      projectionOptions: {
        threadStatus: "idle",
        turnMessageDetail: "full",
      },
      resolveRow: compactionLogicalRow,
      startAt: 4,
    });

    const completedPrefix = renderTimelineFixture({
      events: events.slice(0, 4),
      projectionOptions: {
        threadStatus: "idle",
        turnMessageDetail: "full",
      },
    });
    const contentPrefix = renderTimelineFixture({
      events,
      projectionOptions: {
        threadStatus: "idle",
        turnMessageDetail: "full",
      },
    });

    expect(
      completedPrefix.rows
        .map((row) => compactionLogicalRow(row))
        .filter((row): row is LogicalTimelineRow => row !== null),
    ).toEqual([
      {
        key: "thread-1:op:compaction:turn-1",
        status: "completed",
        title: "Context compacted",
      },
    ]);
    expect(
      collectLogicalTimelineRows({
        rows: contentPrefix.rows,
        resolveRow: compactionLogicalRow,
      }),
    ).toEqual([
      {
        key: "thread-1:op:compaction:turn-1",
        status: "completed",
        title: "Context compacted",
      },
    ]);
  });

  it("keeps completed tool and command calls stable through turn collapse", () => {
    const event = createTimelineEventFactory({
      threadId: "thread-1",
      providerThreadId: "provider-thread-1",
      turnId: "turn-1",
    });
    const events = [
      event.turnStarted({}),
      event.toolCallStarted({
        itemId: "tool-prefix",
        tool: "CustomTool",
        arguments: { input: "alpha" },
      }),
      event.toolCallCompleted({
        itemId: "tool-prefix",
        tool: "CustomTool",
        arguments: { input: "alpha" },
        result: "ok",
      }),
      event.commandStarted({
        itemId: "command-prefix",
        command: "pnpm test",
      }),
      event.commandOutputDelta({
        itemId: "command-prefix",
        delta: "running\n",
      }),
      event.commandCompleted({
        itemId: "command-prefix",
        command: "pnpm test",
        aggregatedOutput: "passed\n",
      }),
      event.assistantCompleted({
        itemId: "assistant-1",
        text: "Done.",
      }),
      event.turnCompleted({}),
      event.toolCallCompleted({
        itemId: "tool-prefix",
        tool: "CustomTool",
        arguments: { input: "alpha" },
        status: "failed",
        error: "late duplicate failure",
      }),
    ];

    expectTerminalRowsNeverRegress({
      events,
      projectionOptions: {
        threadStatus: "active",
        turnMessageDetail: "full",
      },
      resolveRow: toolCallLogicalRow,
      startAt: 3,
    });

    const contentPrefix = renderTimelineFixture({
      events,
      projectionOptions: {
        threadStatus: "active",
        turnMessageDetail: "full",
      },
    });

    expect(
      collectLogicalTimelineRows({
        rows: contentPrefix.rows,
        resolveRow: toolCallLogicalRow,
      }),
    ).toEqual([
      {
        key: "tool:tool-prefix",
        status: "completed",
        title: "CustomTool { input: alpha }",
      },
      {
        key: "tool:command-prefix",
        status: "completed",
        title: "pnpm test",
      },
    ]);
  });

  it("keeps explicitly interrupted tool calls stable through turn collapse", () => {
    const event = createTimelineEventFactory({
      threadId: "thread-1",
      providerThreadId: "provider-thread-1",
      turnId: "turn-1",
    });
    const events = [
      event.turnStarted({}),
      event.toolCallStarted({
        itemId: "tool-interrupted",
        tool: "CustomTool",
        arguments: { input: "alpha" },
      }),
      event.toolCallCompleted({
        itemId: "tool-interrupted",
        tool: "CustomTool",
        arguments: { input: "alpha" },
        status: "interrupted",
      }),
      event.assistantCompleted({
        itemId: "assistant-1",
        text: "Stopped.",
      }),
      event.turnCompleted({
        status: "interrupted",
      }),
    ];

    expectTerminalRowsNeverRegress({
      events,
      projectionOptions: {
        threadStatus: "idle",
        turnMessageDetail: "full",
      },
      resolveRow: toolCallLogicalRow,
      startAt: 3,
    });
  });

  it("keeps completed web searches stable through turn collapse", () => {
    const event = createTimelineEventFactory({
      threadId: "thread-1",
      providerThreadId: "provider-thread-1",
      turnId: "turn-1",
    });
    const events = [
      event.turnStarted({}),
      event.webSearchStarted({
        itemId: "web-prefix",
        queries: ["timeline projection stability"],
      }),
      event.webSearchCompleted({
        itemId: "web-prefix",
        queries: ["timeline projection stability"],
        resultText: "result",
      }),
      event.assistantCompleted({
        itemId: "assistant-1",
        text: "Done.",
      }),
      event.turnCompleted({}),
    ];

    expectTerminalRowsNeverRegress({
      events,
      projectionOptions: {
        threadStatus: "idle",
        turnMessageDetail: "full",
      },
      resolveRow: webSearchLogicalRow,
      startAt: 3,
    });
  });

  it("does not infer completed web searches from interrupted turns", () => {
    const event = createTimelineEventFactory({
      threadId: "thread-1",
      providerThreadId: "provider-thread-1",
      turnId: "turn-1",
    });
    const interruptedPrefix = renderTimelineFixture({
      events: [
        event.turnStarted({}),
        event.webSearchStarted({
          itemId: "web-interrupted",
          queries: ["unfinished search"],
        }),
        event.turnCompleted({
          status: "interrupted",
        }),
      ],
      projectionOptions: {
        threadStatus: "idle",
        turnMessageDetail: "full",
      },
    });

    expect(
      collectLogicalTimelineRows({
        rows: interruptedPrefix.rows,
        resolveRow: webSearchLogicalRow,
      }),
    ).toEqual([
      {
        key: "web-search:web-interrupted",
        status: "interrupted",
        title: "Searched unfinished search",
      },
    ]);
  });

  it("does not merge completed file edits into later pending file edits", () => {
    const event = createTimelineEventFactory({
      threadId: "thread-1",
      providerThreadId: "provider-thread-1",
      turnId: "turn-1",
    });
    const events = [
      event.turnStarted({}),
      event.fileChangeStarted({
        itemId: "file-a",
        changes: [{ path: "/repo/a.ts", kind: "update" }],
      }),
      event.fileChangeCompleted({
        itemId: "file-a",
        changes: [{ path: "/repo/a.ts", kind: "update" }],
      }),
      event.fileChangeStarted({
        itemId: "file-b",
        changes: [{ path: "/repo/b.ts", kind: "update" }],
      }),
      event.assistantCompleted({
        itemId: "assistant-1",
        text: "Still editing.",
      }),
      event.turnCompleted({}),
    ];

    expectTerminalRowsNeverRegress({
      events,
      projectionOptions: {
        threadStatus: "active",
        turnMessageDetail: "full",
      },
      resolveRow: fileEditLogicalRow,
      startAt: 3,
    });

    const mixedPrefix = renderTimelineFixture({
      events: events.slice(0, 4),
      projectionOptions: {
        threadStatus: "active",
        turnMessageDetail: "full",
      },
    });

    expect(
      collectLogicalTimelineRows({
        rows: mixedPrefix.rows,
        resolveRow: fileEditLogicalRow,
      }),
    ).toEqual([
      {
        key: "file-edit:file-a",
        status: "completed",
        title: "/repo/a.ts",
      },
      {
        key: "file-edit:file-b",
        status: "pending",
        title: "/repo/b.ts",
      },
    ]);
  });

  it("does not compact completed task updates into later pending task updates", () => {
    const event = createTimelineEventFactory({
      threadId: "thread-1",
      providerThreadId: "provider-thread-1",
      turnId: "turn-1",
    });
    const events = [
      event.turnStarted({}),
      event.toolCallStarted({
        itemId: "todo-a",
        tool: "TodoWrite",
        arguments: {
          todos: [{ content: "Inspect projection", status: "in_progress" }],
        },
      }),
      event.toolCallCompleted({
        itemId: "todo-a",
        tool: "TodoWrite",
        arguments: {
          todos: [{ content: "Inspect projection", status: "completed" }],
        },
      }),
      event.toolCallStarted({
        itemId: "todo-b",
        tool: "TodoWrite",
        arguments: {
          todos: [{ content: "Run validation", status: "in_progress" }],
        },
      }),
      event.assistantCompleted({
        itemId: "assistant-1",
        text: "Still updating tasks.",
      }),
      event.turnCompleted({}),
    ];

    expectTerminalRowsNeverRegress({
      events,
      projectionOptions: {
        threadStatus: "active",
        turnMessageDetail: "full",
      },
      resolveRow: taskLogicalRow,
      startAt: 3,
    });

    const mixedPrefix = renderTimelineFixture({
      events: events.slice(0, 4),
      projectionOptions: {
        threadStatus: "active",
        turnMessageDetail: "full",
      },
    });

    expect(
      collectLogicalTimelineRows({
        rows: mixedPrefix.rows,
        resolveRow: taskLogicalRow,
      }),
    ).toEqual([
      {
        key: "tasks:todo-a",
        status: "completed",
        title: "Tasks updated",
      },
      {
        key: "tasks:todo-b",
        status: "pending",
        title: "Updating tasks",
      },
    ]);
  });

  it("keeps assistant text stable after final content arrives", () => {
    const event = createTimelineEventFactory({
      threadId: "thread-1",
      providerThreadId: "provider-thread-1",
      turnId: "turn-1",
    });
    const events = [
      event.turnStarted({}),
      event.assistantDelta({
        itemId: "assistant-prefix",
        delta: "Hel",
      }),
      event.assistantCompleted({
        itemId: "assistant-prefix",
        text: "Hello.",
      }),
      event.turnCompleted({}),
      event.assistantDelta({
        itemId: "assistant-prefix",
        delta: " late",
      }),
    ];

    expectTerminalRowsNeverRegress({
      events,
      projectionOptions: {
        threadStatus: "idle",
        turnMessageDetail: "full",
      },
      resolveRow: assistantLogicalRow,
      startAt: 3,
    });
  });

  it("does not reopen active thinking after late reasoning deltas", () => {
    const event = createTimelineEventFactory({
      threadId: "thread-1",
      providerThreadId: "provider-thread-1",
      turnId: "turn-1",
    });
    const activePrefix = renderTimelineFixture({
      events: [
        event.turnStarted({
          createdAt: 1,
        }),
        event.reasoningDelta({
          createdAt: 2,
          itemId: "reasoning-open",
          delta: "Thinking through the repo.\nTrailing partial",
        }),
      ],
      projectionOptions: {
        threadStatus: "active",
        turnMessageDetail: "full",
      },
    });

    expect(activePrefix.projection.state.activeThinking).toMatchObject({
      id: "reasoning-open",
      text: "Thinking through the repo.\n",
      startedAt: 2,
      updatedAt: 2,
    });

    const events = [
      event.turnStarted({
        createdAt: 3,
      }),
      event.reasoningDelta({
        createdAt: 4,
        itemId: "reasoning-prefix",
        delta: "Thinking",
      }),
      event.reasoningCompleted({
        createdAt: 5,
        itemId: "reasoning-prefix",
        text: "Done thinking.",
      }),
      event.turnCompleted({
        createdAt: 6,
      }),
      event.reasoningDelta({
        createdAt: 7,
        itemId: "reasoning-prefix",
        delta: " late",
      }),
    ];
    const finalPrefix = renderTimelineFixture({
      events,
      projectionOptions: {
        threadStatus: "active",
        turnMessageDetail: "full",
      },
    });

    expect(finalPrefix.projection.state.activeThinking).toBeNull();
  });

  it("keeps client-requested input stable when the turn is accepted", () => {
    const event = createTimelineEventFactory({
      threadId: "thread-1",
      providerThreadId: "provider-thread-1",
      turnId: "turn-1",
    });
    const events = [
      event.turnStarted({}),
      event.clientTurnRequested({
        text: "Please check the timeline.",
      }),
      event.inputAccepted({
        clientRequestSequence: 2,
      }),
      event.assistantCompleted({
        itemId: "assistant-1",
        text: "Checking.",
      }),
      event.turnCompleted({}),
    ];

    expectTerminalRowsNeverRegress({
      events,
      projectionOptions: {
        threadStatus: "active",
        turnMessageDetail: "full",
      },
      resolveRow: userLogicalRow,
      startAt: 2,
    });
  });

  it("keeps provider notices and errors stable around visible turn output", () => {
    const event = createTimelineEventFactory({
      threadId: "thread-1",
      providerThreadId: "provider-thread-1",
      turnId: "turn-1",
    });
    const events = [
      event.turnStarted({}),
      event.warning({
        summary: "Configuration warning",
        details: "Using fallback config",
      }),
      event.providerUnhandled({
        rawType: "session.updated",
      }),
      event.providerError({
        message: "Provider retry failed",
      }),
      event.assistantCompleted({
        itemId: "assistant-1",
        text: "Recovered.",
      }),
      event.turnCompleted({}),
    ];

    expectTerminalRowsNeverRegress({
      events,
      projectionOptions: {
        includeDebugRawEvents: true,
        threadStatus: "idle",
        turnMessageDetail: "full",
      },
      resolveRow: providerNoticeLogicalRow,
      startAt: 2,
    });
  });
});
