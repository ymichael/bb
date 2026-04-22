import { describe, expect, it } from "vitest";
import type { ThreadEventRow } from "@bb/domain";
import { toViewProjection } from "../src/to-view-messages.js";
import { buildTimelineRows } from "../src/thread-detail-rows.js";
import {
  createTimelineEventFactory,
  flattenProjectionMessages,
  fromRows,
} from "./timeline-test-harness.js";

describe("toViewProjection turn lifecycle", () => {
  it("fails loudly when a turn has duplicate turn/started lifecycle events", () => {
    const events: ThreadEventRow[] = [
      {
        id: "evt-1",
        threadId: "thread-1",
        seq: 1,
        type: "turn/started",
        data: {
          providerThreadId: "provider-thread-1",
          turnId: "turn-1",
        },
        createdAt: 10,
      },
      {
        id: "evt-2",
        threadId: "thread-1",
        seq: 2,
        type: "turn/started",
        data: {
          providerThreadId: "provider-thread-1",
          turnId: "turn-1",
        },
        createdAt: 20,
      },
    ];

    expect(() =>
      toViewProjection(fromRows(events), {
        threadStatus: "active",
        turnMessageDetail: "summary",
      }),
    ).toThrow(/duplicate turn\/started for turn-1/);
  });

  it("uses turn/completed as the authoritative completed state in summary mode", () => {
    const events: ThreadEventRow[] = [
      {
        id: "evt-1",
        threadId: "thread-1",
        seq: 1,
        type: "turn/started",
        data: {
          providerThreadId: "provider-thread-1",
          turnId: "turn-1",
        },
        createdAt: 10,
      },
      {
        id: "evt-2",
        threadId: "thread-1",
        seq: 2,
        type: "item/started",
        data: {
          providerThreadId: "provider-thread-1",
          turnId: "turn-1",
          item: {
            type: "toolCall",
            id: "tool-1",
            tool: "exec_command",
            arguments: { cmd: "pnpm test" },
            status: "pending",
          },
        },
        createdAt: 20,
      },
      {
        id: "evt-3",
        threadId: "thread-1",
        seq: 3,
        type: "item/completed",
        data: {
          providerThreadId: "provider-thread-1",
          turnId: "turn-1",
          item: {
            type: "agentMessage",
            id: "assistant-1",
            text: "Done.",
          },
        },
        createdAt: 30,
      },
      {
        id: "evt-4",
        threadId: "thread-1",
        seq: 4,
        type: "turn/completed",
        data: {
          providerThreadId: "provider-thread-1",
          turnId: "turn-1",
          status: "completed",
        },
        createdAt: 40,
      },
    ];

    const projection = toViewProjection(fromRows(events), {
      threadStatus: "active",
      turnMessageDetail: "summary",
    });

    expect(projection.entries).toHaveLength(1);
    const entry = projection.entries[0];
    expect(entry?.kind).toBe("turn");
    if (entry?.kind !== "turn") {
      throw new Error("Expected a turn entry");
    }
    expect(entry.turn.status).toBe("completed");
    expect(entry.turn.sourceSeqStart).toBe(1);
    expect(entry.turn.sourceSeqEnd).toBe(4);
    expect(entry.turn.completedAt).toBe(40);
    expect(entry.turn.durationMs).toBe(30);
    expect(entry.turn.summaryCount).toBe(1);
    expect(entry.turn.messages).toBeUndefined();
    expect(entry.turn.terminalMessage?.kind).toBe("assistant-text");
  });

  it("keeps zero duration on completed turns instead of dropping it", () => {
    const events: ThreadEventRow[] = [
      {
        id: "evt-1",
        threadId: "thread-1",
        seq: 1,
        type: "turn/started",
        data: {
          providerThreadId: "provider-thread-1",
          turnId: "turn-1",
        },
        createdAt: 10,
      },
      {
        id: "evt-2",
        threadId: "thread-1",
        seq: 2,
        type: "item/completed",
        data: {
          providerThreadId: "provider-thread-1",
          turnId: "turn-1",
          item: {
            type: "agentMessage",
            id: "assistant-1",
            text: "Done.",
          },
        },
        createdAt: 10,
      },
      {
        id: "evt-3",
        threadId: "thread-1",
        seq: 3,
        type: "turn/completed",
        data: {
          providerThreadId: "provider-thread-1",
          turnId: "turn-1",
          status: "completed",
        },
        createdAt: 10,
      },
    ];

    const projection = toViewProjection(fromRows(events), {
      threadStatus: "idle",
      turnMessageDetail: "summary",
    });

    const entry = projection.entries[0];
    expect(entry?.kind).toBe("turn");
    if (entry?.kind !== "turn") {
      throw new Error("Expected a turn entry");
    }
    expect(entry.turn.completedAt).toBe(10);
    expect(entry.turn.durationMs).toBe(0);
  });

  it("keeps pending turn messages present even when current messages are terminal", () => {
    const events: ThreadEventRow[] = [
      {
        id: "evt-1",
        threadId: "thread-1",
        seq: 1,
        type: "turn/started",
        data: {
          providerThreadId: "provider-thread-1",
          turnId: "turn-1",
        },
        createdAt: 1,
      },
      {
        id: "evt-2",
        threadId: "thread-1",
        seq: 2,
        type: "item/completed",
        data: {
          providerThreadId: "provider-thread-1",
          turnId: "turn-1",
          item: {
            type: "agentMessage",
            id: "assistant-1",
            text: "Still working.",
          },
        },
        createdAt: 2,
      },
    ];

    const projection = toViewProjection(fromRows(events), {
      threadStatus: "idle",
      turnMessageDetail: "summary",
    });

    const entry = projection.entries[0];
    expect(entry?.kind).toBe("turn");
    if (entry?.kind !== "turn") {
      throw new Error("Expected a turn entry");
    }
    expect(entry.turn.status).toBe("pending");
    expect(entry.turn.messages).toHaveLength(1);
    expect(entry.turn.messages?.[0]?.kind).toBe("assistant-text");
  });

  it("keeps summary turn messages when messages after the terminal need standalone rows", () => {
    const events: ThreadEventRow[] = [
      {
        id: "evt-1",
        threadId: "thread-1",
        seq: 1,
        type: "turn/started",
        data: {
          providerThreadId: "provider-thread-1",
          turnId: "turn-1",
        },
        createdAt: 1,
      },
      {
        id: "evt-2",
        threadId: "thread-1",
        seq: 2,
        type: "item/completed",
        data: {
          providerThreadId: "provider-thread-1",
          turnId: "turn-1",
          item: {
            type: "toolCall",
            id: "tool-1",
            tool: "exec_command",
            arguments: { cmd: "pnpm test" },
            status: "completed",
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
          providerThreadId: "provider-thread-1",
          turnId: "turn-1",
          item: {
            type: "agentMessage",
            id: "assistant-1",
            text: "Done.",
          },
        },
        createdAt: 3,
      },
      {
        id: "evt-4",
        threadId: "thread-1",
        seq: 4,
        type: "turn/diff/updated",
        data: {
          providerThreadId: "provider-thread-1",
          turnId: "turn-1",
          diff: "M package.json",
        },
        createdAt: 4,
      },
      {
        id: "evt-5",
        threadId: "thread-1",
        seq: 5,
        type: "turn/completed",
        data: {
          providerThreadId: "provider-thread-1",
          turnId: "turn-1",
          status: "completed",
        },
        createdAt: 5,
      },
    ];

    const projection = toViewProjection(fromRows(events), {
      includeOptionalOperations: true,
      threadStatus: "idle",
      turnMessageDetail: "summary",
    });

    const entry = projection.entries[0];
    expect(entry?.kind).toBe("turn");
    if (entry?.kind !== "turn") {
      throw new Error("Expected a turn entry");
    }
    expect(entry.turn.summaryCount).toBe(1);
    expect(entry.turn.messages?.map((message) => message.kind)).toEqual([
      "tool-call",
      "assistant-text",
      "operation",
    ]);
  });

  it("summarizes completed tool-only turns without retaining full messages", () => {
    const events: ThreadEventRow[] = [
      {
        id: "evt-1",
        threadId: "thread-1",
        seq: 1,
        type: "turn/started",
        data: {
          providerThreadId: "provider-thread-1",
          turnId: "turn-1",
        },
        createdAt: 1,
      },
      {
        id: "evt-2",
        threadId: "thread-1",
        seq: 2,
        type: "item/completed",
        data: {
          providerThreadId: "provider-thread-1",
          turnId: "turn-1",
          item: {
            type: "toolCall",
            id: "tool-1",
            tool: "exec_command",
            arguments: { cmd: "pnpm test" },
            status: "completed",
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
          providerThreadId: "provider-thread-1",
          turnId: "turn-1",
          status: "completed",
        },
        createdAt: 3,
      },
    ];

    const projection = toViewProjection(fromRows(events), {
      threadStatus: "idle",
      turnMessageDetail: "summary",
    });

    const entry = projection.entries[0];
    expect(entry?.kind).toBe("turn");
    if (entry?.kind !== "turn") {
      throw new Error("Expected a turn entry");
    }
    expect(entry.turn.summaryCount).toBe(1);
    expect(entry.turn.terminalMessage).toBeUndefined();
    expect(entry.turn.messages).toBeUndefined();

    const rows = buildTimelineRows(projection);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.kind).toBe("turn-summary");
  });

  it("retains completed no-terminal turns when they contain standalone-only messages", () => {
    const events: ThreadEventRow[] = [
      {
        id: "evt-1",
        threadId: "thread-1",
        seq: 1,
        type: "turn/started",
        data: {
          providerThreadId: "provider-thread-1",
          turnId: "turn-1",
        },
        createdAt: 1,
      },
      {
        id: "evt-2",
        threadId: "thread-1",
        seq: 2,
        type: "client/turn/requested",
        data: {
          direction: "outbound",
          source: "tell",
          initiator: "user",
          input: [{ type: "text", text: "Follow-up question" }],
          target: { kind: "auto", expectedTurnId: "turn-1" },
          request: {
            method: "turn/start",
            params: {},
          },
          execution: {
            model: "gpt-5",
            serviceTier: "default",
            reasoningLevel: "medium",
            permissionMode: "full",
            source: "client/turn/requested",
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
          providerThreadId: "provider-thread-1",
          turnId: "turn-1",
          status: "completed",
        },
        createdAt: 3,
      },
    ];

    const projection = toViewProjection(fromRows(events), {
      threadStatus: "idle",
      turnMessageDetail: "summary",
    });

    const entry = projection.entries[0];
    expect(entry?.kind).toBe("turn");
    if (entry?.kind !== "turn") {
      throw new Error("Expected a turn entry");
    }
    expect(entry.turn.summaryCount).toBe(0);
    expect(entry.turn.messages?.map((message) => message.kind)).toEqual([
      "user",
    ]);
  });

  it("rejects turn-scoped messages that do not have turn lifecycle events", () => {
    const events: ThreadEventRow[] = [
      {
        id: "evt-1",
        threadId: "thread-1",
        seq: 1,
        type: "item/completed",
        data: {
          providerThreadId: "provider-thread-1",
          turnId: "missing-turn",
          item: {
            type: "agentMessage",
            id: "assistant-1",
            text: "No lifecycle.",
          },
        },
        createdAt: 1,
      },
    ];

    expect(() =>
      toViewProjection(fromRows(events), {
        threadStatus: "idle",
        turnMessageDetail: "summary",
      }),
    ).toThrow(/without turn\/started/);
  });
});
