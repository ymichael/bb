import { describe, expect, it } from "vitest";
import {
  threadEventScopePolicyByType,
  threadScope,
  turnScope,
} from "@bb/domain";
import type { ThreadEventRow, ViewMessage } from "@bb/domain";
import { toViewMessages, toViewProjection } from "../src/to-view-messages.js";
import { fromRows } from "./timeline-test-harness.js";

type AssistantStreamFixtureScope = ThreadEventRow["scope"];

type AssistantStreamFixtureRow = Omit<ThreadEventRow, "scope"> & {
  scope?: AssistantStreamFixtureScope;
};

type AssistantStreamFixtureRows = AssistantStreamFixtureRow[];

function inferFixtureScope(
  row: AssistantStreamFixtureRow,
): AssistantStreamFixtureScope {
  const scopePolicy = threadEventScopePolicyByType[row.type];

  if (scopePolicy === "thread") {
    return threadScope();
  }

  if ("turnId" in row.data && typeof row.data.turnId === "string") {
    return turnScope(row.data.turnId);
  }

  return threadScope();
}

function decodeFixtureRows(rows: AssistantStreamFixtureRows) {
  return fromRows(
    rows.map((row) => ({
      ...row,
      scope: row.scope ?? inferFixtureScope(row),
    })),
  );
}

describe("toViewMessages assistant streams", () => {
  it("projects flat event data with the same output as raw events", () => {
    const events: AssistantStreamFixtureRows = [
      {
        id: "evt-1",
        threadId: "thread-1",
        seq: 1,
        type: "item/completed",
        data: {
          providerThreadId: "thread-1",
          turnId: "turn-1",
          item: {
            type: "agentMessage",
            id: "assistant-1",
            text: "Flat output",
          },
        },
        createdAt: 1,
      },
    ];

    const projected = toViewMessages(decodeFixtureRows(events), {
      threadStatus: "idle",
    });
    expect(projected).toHaveLength(1);
    expect(projected[0]?.kind).toBe("assistant-text");
    if (projected[0]?.kind === "assistant-text") {
      expect(projected[0].text).toBe("Flat output");
      expect(projected[0].scope).toEqual(turnScope("turn-1"));
    }
  });

  it("deduplicates repeated completed assistant final messages for the same item id", () => {
    const events: AssistantStreamFixtureRows = [
      {
        id: "evt-1",
        threadId: "thread-1",
        seq: 1,
        type: "item/completed",
        data: {
          providerThreadId: "thread-1",
          turnId: "turn-1",
          item: {
            type: "agentMessage",
            id: "assistant-1",
            text: "Hello",
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
          providerThreadId: "thread-1",
          turnId: "turn-1",
          item: {
            type: "agentMessage",
            id: "assistant-1",
            text: "Hello",
          },
        },
        createdAt: 2,
      },
    ];

    const projected = toViewMessages(decodeFixtureRows(events), {
      threadStatus: "idle",
    });
    const assistantMessages = projected.filter(
      (message): message is Extract<ViewMessage, { kind: "assistant-text" }> =>
        message.kind === "assistant-text",
    );

    expect(assistantMessages).toHaveLength(1);
    expect(assistantMessages[0]?.text).toBe("Hello");
  });

  it("keeps streamed assistant text separate when the later final uses a different item id key", () => {
    const events: AssistantStreamFixtureRows = [
      {
        id: "evt-1",
        threadId: "thread-1",
        seq: 1,
        type: "item/agentMessage/delta",
        data: {
          providerThreadId: "thread-1",
          turnId: "turn-1",
          itemId: "assistant-stream-1",
          delta: "PONG",
        },
        createdAt: 1,
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
            text: "PONG",
          },
        },
        createdAt: 2,
      },
    ];

    const projected = toViewMessages(decodeFixtureRows(events), {
      threadStatus: "idle",
    });
    const assistantMessages = projected.filter(
      (message): message is Extract<ViewMessage, { kind: "assistant-text" }> =>
        message.kind === "assistant-text",
    );

    expect(assistantMessages).toHaveLength(2);
    expect(
      assistantMessages.some(
        (message) => message.text === "PONG" && message.status === "completed",
      ),
    ).toBe(true);
  });

  it("finalizes streaming assistant messages and clears active thinking when thread is idle", () => {
    const events: AssistantStreamFixtureRows = [
      {
        id: "evt-1",
        threadId: "thread-1",
        seq: 1,
        type: "turn/started",
        data: {
          providerThreadId: "thread-1",
          threadId: "thread-1",
          turnId: "turn-1",
        },
        createdAt: 1,
      },
      {
        id: "evt-2",
        threadId: "thread-1",
        seq: 2,
        type: "item/agentMessage/delta",
        data: {
          providerThreadId: "thread-1",
          threadId: "thread-1",
          turnId: "turn-1",
          itemId: "msg-1",
          delta: "Partial reply",
        },
        createdAt: 2,
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
          delta: "Partial reasoning",
        },
        createdAt: 3,
      },
    ];

    const projected = toViewMessages(decodeFixtureRows(events), {
      threadStatus: "idle",
    });
    const projection = toViewProjection(decodeFixtureRows(events), {
      threadStatus: "idle",
      turnMessageDetail: "full",
    });
    const assistant = projected.find(
      (message): message is Extract<ViewMessage, { kind: "assistant-text" }> =>
        message.kind === "assistant-text",
    );

    expect(assistant).toBeDefined();
    expect(assistant?.status).toBe("completed");
    expect(
      projected.some(
        (message) =>
          message.kind === "assistant-text" && message.status === "streaming",
      ),
    ).toBe(false);
    expect(projection.state.activeThinking).toBeNull();
  });

  it("keeps assistant text buffered and active thinking open on active threads until a newline or terminal boundary arrives", () => {
    const events: AssistantStreamFixtureRows = [
      {
        id: "evt-1",
        threadId: "thread-1",
        seq: 1,
        type: "item/agentMessage/delta",
        data: {
          providerThreadId: "thread-1",
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
          providerThreadId: "thread-1",
          threadId: "thread-1",
          turnId: "turn-1",
          itemId: "rs-1",
          delta: "Partial reasoning",
        },
        createdAt: 2,
      },
    ];

    const projected = toViewMessages(decodeFixtureRows(events), {
      threadStatus: "active",
    });
    const projection = toViewProjection(decodeFixtureRows(events), {
      threadStatus: "active",
      turnMessageDetail: "full",
    });
    const assistant = projected.find(
      (message): message is Extract<ViewMessage, { kind: "assistant-text" }> =>
        message.kind === "assistant-text",
    );

    expect(assistant).toBeUndefined();
    expect(projection.state.activeThinking).toMatchObject({
      id: "rs-1",
      text: "",
      startedAt: 2,
      updatedAt: 2,
    });
  });

  it("does not flush hidden assistant or reasoning partials when thread status is omitted", () => {
    const events: AssistantStreamFixtureRows = [
      {
        id: "evt-1",
        threadId: "thread-1",
        seq: 1,
        type: "item/agentMessage/delta",
        data: {
          providerThreadId: "thread-1",
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
          providerThreadId: "thread-1",
          threadId: "thread-1",
          turnId: "turn-1",
          itemId: "rs-1",
          delta: "Partial reasoning",
        },
        createdAt: 2,
      },
    ];

    expect(toViewMessages(decodeFixtureRows(events))).toEqual([]);
  });

  it("surfaces newline-terminated assistant chunks while keeping reasoning in active thinking state", () => {
    const events: AssistantStreamFixtureRows = [
      {
        id: "evt-1",
        threadId: "thread-1",
        seq: 1,
        type: "turn/started",
        data: {
          providerThreadId: "thread-1",
          threadId: "thread-1",
          turnId: "turn-1",
        },
        createdAt: 1,
      },
      {
        id: "evt-2",
        threadId: "thread-1",
        seq: 2,
        type: "item/agentMessage/delta",
        data: {
          providerThreadId: "thread-1",
          threadId: "thread-1",
          turnId: "turn-1",
          itemId: "msg-1",
          delta: "First line\nSecond",
        },
        createdAt: 2,
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
          delta: "Reasoning line\nTrailing",
        },
        createdAt: 3,
      },
    ];

    const projected = toViewMessages(decodeFixtureRows(events), {
      threadStatus: "active",
    });
    const projection = toViewProjection(decodeFixtureRows(events), {
      threadStatus: "active",
      turnMessageDetail: "full",
    });
    const assistant = projected.find(
      (message): message is Extract<ViewMessage, { kind: "assistant-text" }> =>
        message.kind === "assistant-text",
    );

    expect(assistant?.text).toBe("First line\n");
    expect(assistant?.status).toBe("streaming");
    expect(projection.state.activeThinking?.text).toBe("Reasoning line\n");
  });

  it("preserves startedAt for assistant streams after completion", () => {
    const events: AssistantStreamFixtureRows = [
      {
        id: "evt-1",
        threadId: "thread-1",
        seq: 1,
        type: "item/agentMessage/delta",
        data: {
          providerThreadId: "thread-1",
          threadId: "thread-1",
          turnId: "turn-1",
          itemId: "msg-1",
          delta: "Partial reply",
        },
        createdAt: 10,
      },
      {
        id: "evt-2",
        threadId: "thread-1",
        seq: 2,
        type: "item/agentMessage/delta",
        data: {
          providerThreadId: "thread-1",
          threadId: "thread-1",
          turnId: "turn-1",
          itemId: "msg-1",
          delta: " finished",
        },
        createdAt: 25,
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
          delta: "Reasoning start",
        },
        createdAt: 30,
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
            type: "agentMessage",
            id: "msg-1",
            text: "Partial reply finished",
          },
        },
        createdAt: 40,
      },
      {
        id: "evt-5",
        threadId: "thread-1",
        seq: 5,
        type: "item/completed",
        data: {
          providerThreadId: "thread-1",
          turnId: "turn-1",
          item: {
            type: "reasoning",
            id: "rs-1",
            summary: ["Reasoning start"],
            content: [],
          },
        },
        createdAt: 45,
      },
    ];

    const projected = toViewMessages(decodeFixtureRows(events), {
      threadStatus: "idle",
    });
    const assistant = projected.find(
      (message): message is Extract<ViewMessage, { kind: "assistant-text" }> =>
        message.kind === "assistant-text",
    );

    expect(assistant?.startedAt).toBe(10);
    expect(assistant?.createdAt).toBe(40);
  });

  it("renders completed assistant text immediately even while the thread is active", () => {
    const events: AssistantStreamFixtureRows = [
      {
        id: "evt-1",
        threadId: "thread-1",
        seq: 1,
        type: "item/completed",
        data: {
          providerThreadId: "thread-1",
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

    const projected = toViewMessages(decodeFixtureRows(events), {
      threadStatus: "active",
    });

    const assistant = projected.find(
      (message): message is Extract<ViewMessage, { kind: "assistant-text" }> =>
        message.kind === "assistant-text",
    );

    expect(assistant?.text).toBe("Final answer");
    expect(assistant?.status).toBe("completed");
  });

  it("flushes buffered assistant text when the turn completes even if thread status is still active", () => {
    const events: AssistantStreamFixtureRows = [
      {
        id: "evt-1",
        threadId: "thread-1",
        seq: 1,
        type: "item/agentMessage/delta",
        data: {
          providerThreadId: "thread-1",
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
          providerThreadId: "thread-1",
          threadId: "thread-1",
          turnId: "turn-1",
          status: "completed",
        },
        createdAt: 2,
      },
    ];

    const projected = toViewMessages(decodeFixtureRows(events), {
      threadStatus: "active",
    });
    const assistant = projected.find(
      (message): message is Extract<ViewMessage, { kind: "assistant-text" }> =>
        message.kind === "assistant-text",
    );

    expect(assistant?.text).toBe("Partial reply");
    expect(assistant?.status).toBe("completed");
  });

  it("flushes buffered assistant text before interruption markers on idle threads", () => {
    const events: AssistantStreamFixtureRows = [
      {
        id: "evt-1",
        threadId: "thread-1",
        seq: 1,
        type: "item/agentMessage/delta",
        data: {
          providerThreadId: "thread-1",
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
          reason: "manual-stop",
        },
        createdAt: 2,
      },
    ];

    const projected = toViewMessages(decodeFixtureRows(events), {
      threadStatus: "idle",
    });

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
    const events: AssistantStreamFixtureRows = [
      {
        id: "evt-1",
        threadId: "thread-1",
        seq: 1,
        type: "item/completed",
        data: {
          providerThreadId: "thread-1",
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
          providerThreadId: "thread-1",
          threadId: "thread-1",
          turnId: "turn-1",
          itemId: "msg-1",
          delta: " trailing",
        },
        createdAt: 2,
      },
    ];

    const projected = toViewMessages(decodeFixtureRows(events), {
      threadStatus: "idle",
    });
    const assistants = projected.filter(
      (message): message is Extract<ViewMessage, { kind: "assistant-text" }> =>
        message.kind === "assistant-text",
    );

    expect(assistants).toHaveLength(1);
    expect(assistants[0]?.text).toBe("Final answer");
    expect(assistants[0]?.status).toBe("completed");
  });

  it("keeps active thinking cleared after trailing reasoning deltas arrive post-completion", () => {
    const events: AssistantStreamFixtureRows = [
      {
        id: "evt-1",
        threadId: "thread-1",
        seq: 1,
        type: "turn/started",
        data: {
          providerThreadId: "thread-1",
          threadId: "thread-1",
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
          providerThreadId: "thread-1",
          threadId: "thread-1",
          turnId: "turn-1",
          item: {
            type: "reasoning",
            id: "rs-1",
            summary: ["Final reasoning"],
            content: [],
          },
        },
        createdAt: 2,
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
          delta: " trailing",
        },
        createdAt: 3,
      },
    ];

    const projection = toViewProjection(decodeFixtureRows(events), {
      threadStatus: "idle",
      turnMessageDetail: "full",
    });

    expect(projection.state.activeThinking).toBeNull();
  });

  it("does not reopen active thinking on active threads after a reasoning item completes", () => {
    const events: AssistantStreamFixtureRows = [
      {
        id: "evt-1",
        threadId: "thread-1",
        seq: 1,
        type: "turn/started",
        data: {
          providerThreadId: "thread-1",
          threadId: "thread-1",
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
          providerThreadId: "thread-1",
          threadId: "thread-1",
          turnId: "turn-1",
          item: {
            type: "reasoning",
            id: "rs-1",
            summary: [],
            content: [],
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
          providerThreadId: "thread-1",
          threadId: "thread-1",
          turnId: "turn-1",
          item: {
            type: "reasoning",
            id: "rs-1",
            summary: ["Final reasoning"],
            content: [],
          },
        },
        createdAt: 3,
      },
      {
        id: "evt-4",
        threadId: "thread-1",
        seq: 4,
        type: "item/reasoning/textDelta",
        data: {
          providerThreadId: "thread-1",
          threadId: "thread-1",
          turnId: "turn-1",
          itemId: "rs-1",
          delta: " late",
          contentIndex: 0,
        },
        createdAt: 4,
      },
    ];

    const projection = toViewProjection(decodeFixtureRows(events), {
      threadStatus: "active",
      turnMessageDetail: "full",
    });

    expect(projection.state.activeThinking).toBeNull();
  });

  it("does not surface active thinking when a fresh reasoning item arrives after the turn completes", () => {
    const events: AssistantStreamFixtureRows = [
      {
        id: "evt-1",
        threadId: "thread-1",
        seq: 1,
        type: "turn/started",
        data: {
          providerThreadId: "thread-1",
          threadId: "thread-1",
          turnId: "turn-1",
        },
        createdAt: 1,
      },
      {
        id: "evt-2",
        threadId: "thread-1",
        seq: 2,
        type: "turn/completed",
        data: {
          providerThreadId: "thread-1",
          threadId: "thread-1",
          turnId: "turn-1",
          status: "completed",
        },
        createdAt: 2,
      },
      {
        id: "evt-3",
        threadId: "thread-1",
        seq: 3,
        type: "item/reasoning/textDelta",
        data: {
          providerThreadId: "thread-1",
          threadId: "thread-1",
          turnId: "turn-1",
          itemId: "rs-99",
          delta: " late",
          contentIndex: 0,
        },
        createdAt: 3,
      },
    ];

    const projection = toViewProjection(decodeFixtureRows(events), {
      threadStatus: "active",
      turnMessageDetail: "full",
    });

    expect(projection.state.activeThinking).toBeNull();
  });

  it("does not surface active thinking while a thread is still provisioning", () => {
    const events: AssistantStreamFixtureRows = [
      {
        id: "evt-1",
        threadId: "thread-1",
        seq: 1,
        type: "item/started",
        data: {
          providerThreadId: "thread-1",
          threadId: "thread-1",
          turnId: "turn-1",
          item: {
            type: "reasoning",
            id: "rs-1",
            summary: [],
            content: [],
          },
        },
        createdAt: 1,
      },
    ];

    const projection = toViewProjection(decodeFixtureRows(events), {
      threadStatus: "provisioning",
      turnMessageDetail: "full",
    });

    expect(projection.state.activeThinking).toBeNull();
  });

  it("treats raw reasoning text deltas as newline-buffered active thinking updates", () => {
    const events: AssistantStreamFixtureRows = [
      {
        id: "evt-1",
        threadId: "thread-1",
        seq: 1,
        type: "turn/started",
        data: {
          providerThreadId: "thread-1",
          threadId: "thread-1",
          turnId: "turn-1",
        },
        createdAt: 1,
      },
      {
        id: "evt-2",
        threadId: "thread-1",
        seq: 2,
        type: "item/reasoning/textDelta",
        data: {
          providerThreadId: "thread-1",
          threadId: "thread-1",
          turnId: "turn-1",
          itemId: "reasoning-1",
          delta: "raw-reasoning\npartial",
          contentIndex: 0,
        },
        createdAt: 2,
      },
    ];

    const projection = toViewProjection(decodeFixtureRows(events), {
      threadStatus: "active",
      turnMessageDetail: "full",
    });

    expect(projection.state.activeThinking?.text).toBe("raw-reasoning\n");
  });

  it("keeps assistant-side items from earlier and later assistant responses", () => {
    const events: AssistantStreamFixtureRows = [
      {
        id: "evt-1",
        threadId: "thread-1",
        seq: 1,
        type: "client/turn/requested",
        data: {
          direction: "outbound",
          source: "tell",
          initiator: "user",
          input: [{ type: "text", text: "First question" }],
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
        createdAt: 1,
      },
      {
        id: "evt-2",
        threadId: "thread-1",
        seq: 2,
        type: "item/completed",
        data: {
          providerThreadId: "thread-1",
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
          providerThreadId: "thread-1",
          threadId: "thread-1",
          turnId: "turn-1",
          item: {
            type: "reasoning",
            id: "reasoning-2",
            summary: ["More thinking"],
            content: [],
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
          providerThreadId: "thread-1",
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
        type: "client/turn/requested",
        data: {
          direction: "outbound",
          source: "tell",
          initiator: "user",
          input: [{ type: "text", text: "Second question" }],
          target: { kind: "auto", expectedTurnId: "turn-2" },
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
        createdAt: 5,
      },
    ];

    const projected = toViewMessages(decodeFixtureRows(events), {
      threadStatus: "idle",
    });

    expect(
      projected.some(
        (message) =>
          message.kind === "user" &&
          message.scope.kind === "turn" &&
          message.scope.turnId === "turn-1" &&
          message.text.includes("First question"),
      ),
    ).toBe(true);
    expect(
      projected.some(
        (message) =>
          message.kind === "assistant-text" &&
          message.scope.kind === "turn" &&
          message.scope.turnId === "turn-1" &&
          message.text.includes("Old assistant output"),
      ),
    ).toBe(true);
    expect(
      projected.some(
        (message) =>
          message.kind === "assistant-text" &&
          message.scope.kind === "turn" &&
          message.scope.turnId === "turn-1" &&
          message.text.includes("Latest assistant output"),
      ),
    ).toBe(true);
    expect(
      projected.some(
        (message) =>
          message.kind === "user" &&
          message.scope.kind === "turn" &&
          message.scope.turnId === "turn-2" &&
          message.text.includes("Second question"),
      ),
    ).toBe(true);
  });
});
