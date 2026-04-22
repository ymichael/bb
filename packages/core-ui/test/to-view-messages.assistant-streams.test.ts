import { describe, expect, it } from "vitest";
import type { ThreadEventRow, ViewMessage } from "@bb/domain";
import { toViewMessages } from "../src/to-view-messages.js";
import { fromRows } from "./timeline-test-harness.js";

describe("toViewMessages assistant streams", () => {
  it("projects flat event data with the same output as raw events", () => {
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
            type: "agentMessage",
            id: "assistant-1",
            text: "Flat output",
          },
        },
        createdAt: 1,
      },
    ];

    const projected = toViewMessages(fromRows(events), {
      threadStatus: "idle",
    });
    expect(projected).toHaveLength(1);
    expect(projected[0]?.kind).toBe("assistant-text");
    if (projected[0]?.kind === "assistant-text") {
      expect(projected[0].text).toBe("Flat output");
      expect(projected[0].turnId).toBe("turn-1");
    }
  });

  it("deduplicates repeated completed assistant final messages for the same item id", () => {
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

    const projected = toViewMessages(fromRows(events), {
      threadStatus: "idle",
    });
    const assistantMessages = projected.filter(
      (message): message is Extract<ViewMessage, { kind: "assistant-text" }> =>
        message.kind === "assistant-text",
    );

    expect(assistantMessages).toHaveLength(1);
    expect(assistantMessages[0]?.text).toBe("Hello");
  });

  it("keeps later-turn assistant messages when the same item id is reused across turns", () => {
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
            type: "agentMessage",
            id: "assistant-1",
            text: "First answer",
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
          turnId: "turn-2",
          itemId: "assistant-1",
          delta: "Second",
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
          turnId: "turn-2",
          item: {
            type: "agentMessage",
            id: "assistant-1",
            text: "Second answer",
          },
        },
        createdAt: 3,
      },
    ];

    const projected = toViewMessages(fromRows(events), {
      threadStatus: "idle",
    });
    const assistantMessages = projected.filter(
      (message): message is Extract<ViewMessage, { kind: "assistant-text" }> =>
        message.kind === "assistant-text",
    );

    expect(assistantMessages).toHaveLength(2);
    expect(assistantMessages.map((message) => message.text)).toEqual([
      "First answer",
      "Second answer",
    ]);
    expect(assistantMessages.map((message) => message.turnId)).toEqual([
      "turn-1",
      "turn-2",
    ]);
  });

  it("keeps later-turn reasoning messages when the same item id is reused across turns", () => {
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
            type: "reasoning",
            id: "reasoning-1",
            summary: ["First reasoning"],
            content: [],
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
          providerThreadId: "thread-1",
          turnId: "turn-2",
          itemId: "reasoning-1",
          delta: "Second reasoning",
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
          turnId: "turn-2",
          item: {
            type: "reasoning",
            id: "reasoning-1",
            summary: ["Second reasoning"],
            content: [],
          },
        },
        createdAt: 3,
      },
    ];

    const projected = toViewMessages(fromRows(events), {
      threadStatus: "idle",
    });
    const reasoningMessages = projected.filter(
      (
        message,
      ): message is Extract<ViewMessage, { kind: "assistant-reasoning" }> =>
        message.kind === "assistant-reasoning",
    );

    expect(reasoningMessages).toHaveLength(2);
    expect(reasoningMessages.map((message) => message.text)).toEqual([
      "First reasoning",
      "Second reasoning",
    ]);
    expect(reasoningMessages.map((message) => message.turnId)).toEqual([
      "turn-1",
      "turn-2",
    ]);
  });

  it("keeps same-turn assistant messages when the same item id is reused under different parent tool calls", () => {
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
            type: "agentMessage",
            id: "assistant-1",
            text: "Child A",
            parentToolCallId: "tool-1",
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
          turnId: "turn-1",
          itemId: "assistant-1",
          parentToolCallId: "tool-2",
          delta: "Child B",
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
          turnId: "turn-1",
          item: {
            type: "agentMessage",
            id: "assistant-1",
            text: "Child B",
            parentToolCallId: "tool-2",
          },
        },
        createdAt: 3,
      },
    ];

    const projected = toViewMessages(fromRows(events), {
      threadStatus: "idle",
    });
    const assistantMessages = projected.filter(
      (message): message is Extract<ViewMessage, { kind: "assistant-text" }> =>
        message.kind === "assistant-text",
    );

    expect(assistantMessages).toHaveLength(2);
    expect(assistantMessages.map((message) => message.text)).toEqual([
      "Child A",
      "Child B",
    ]);
    expect(
      assistantMessages.map((message) => message.parentToolCallId ?? null),
    ).toEqual(["tool-1", "tool-2"]);
  });

  it("keeps same-turn reasoning messages when the same item id is reused under different parent tool calls", () => {
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
            type: "reasoning",
            id: "reasoning-1",
            summary: ["Child reasoning A"],
            content: [],
            parentToolCallId: "tool-1",
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
          providerThreadId: "thread-1",
          turnId: "turn-1",
          itemId: "reasoning-1",
          parentToolCallId: "tool-2",
          delta: "Child reasoning B",
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
          turnId: "turn-1",
          item: {
            type: "reasoning",
            id: "reasoning-1",
            summary: ["Child reasoning B"],
            content: [],
            parentToolCallId: "tool-2",
          },
        },
        createdAt: 3,
      },
    ];

    const projected = toViewMessages(fromRows(events), {
      threadStatus: "idle",
    });
    const reasoningMessages = projected.filter(
      (
        message,
      ): message is Extract<ViewMessage, { kind: "assistant-reasoning" }> =>
        message.kind === "assistant-reasoning",
    );

    expect(reasoningMessages).toHaveLength(2);
    expect(reasoningMessages.map((message) => message.text)).toEqual([
      "Child reasoning A",
      "Child reasoning B",
    ]);
    expect(
      reasoningMessages.map((message) => message.parentToolCallId ?? null),
    ).toEqual(["tool-1", "tool-2"]);
  });

  it("finalizes streaming assistant and reasoning messages when thread is idle", () => {
    const events: ThreadEventRow[] = [
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

    const projected = toViewMessages(fromRows(events), {
      threadStatus: "idle",
    });
    const assistant = projected.find(
      (message): message is Extract<ViewMessage, { kind: "assistant-text" }> =>
        message.kind === "assistant-text",
    );
    const reasoning = projected.find(
      (
        message,
      ): message is Extract<ViewMessage, { kind: "assistant-reasoning" }> =>
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

  it("keeps assistant and reasoning text buffered on active threads until a newline or terminal boundary arrives", () => {
    const events: ThreadEventRow[] = [
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

    const projected = toViewMessages(fromRows(events), {
      threadStatus: "active",
    });
    const assistant = projected.find(
      (message): message is Extract<ViewMessage, { kind: "assistant-text" }> =>
        message.kind === "assistant-text",
    );
    const reasoning = projected.find(
      (
        message,
      ): message is Extract<ViewMessage, { kind: "assistant-reasoning" }> =>
        message.kind === "assistant-reasoning",
    );

    expect(assistant).toBeUndefined();
    expect(reasoning).toBeUndefined();
  });

  it("does not flush hidden assistant or reasoning partials when thread status is omitted", () => {
    const events: ThreadEventRow[] = [
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

    expect(toViewMessages(fromRows(events))).toEqual([]);
  });

  it("surfaces newline-terminated assistant and reasoning chunks while streaming", () => {
    const events: ThreadEventRow[] = [
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
          delta: "First line\nSecond",
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
          delta: "Reasoning line\nTrailing",
        },
        createdAt: 2,
      },
    ];

    const projected = toViewMessages(fromRows(events), {
      threadStatus: "active",
    });
    const assistant = projected.find(
      (message): message is Extract<ViewMessage, { kind: "assistant-text" }> =>
        message.kind === "assistant-text",
    );
    const reasoning = projected.find(
      (
        message,
      ): message is Extract<ViewMessage, { kind: "assistant-reasoning" }> =>
        message.kind === "assistant-reasoning",
    );

    expect(assistant?.text).toBe("First line\n");
    expect(assistant?.status).toBe("streaming");
    expect(reasoning?.text).toBe("Reasoning line\n");
    expect(reasoning?.status).toBe("streaming");
  });

  it("preserves startedAt for assistant and reasoning streams after completion", () => {
    const events: ThreadEventRow[] = [
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

    const projected = toViewMessages(fromRows(events), {
      threadStatus: "idle",
    });
    const assistant = projected.find(
      (message): message is Extract<ViewMessage, { kind: "assistant-text" }> =>
        message.kind === "assistant-text",
    );
    const reasoning = projected.find(
      (
        message,
      ): message is Extract<ViewMessage, { kind: "assistant-reasoning" }> =>
        message.kind === "assistant-reasoning",
    );

    expect(assistant?.startedAt).toBe(10);
    expect(assistant?.createdAt).toBe(40);
    expect(reasoning?.startedAt).toBe(30);
    expect(reasoning?.createdAt).toBe(45);
  });

  it("renders completed assistant text immediately even while the thread is active", () => {
    const events: ThreadEventRow[] = [
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

    const projected = toViewMessages(fromRows(events), {
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
    const events: ThreadEventRow[] = [
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

    const projected = toViewMessages(fromRows(events), {
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
    const events: ThreadEventRow[] = [
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
          reason: "user",
          message: "Stopped by user",
        },
        createdAt: 2,
      },
    ];

    const projected = toViewMessages(fromRows(events), {
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
    const events: ThreadEventRow[] = [
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

    const projected = toViewMessages(fromRows(events), {
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

  it("ignores trailing reasoning deltas that arrive after completion", () => {
    const events: ThreadEventRow[] = [
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
            type: "reasoning",
            id: "rs-1",
            summary: ["Final reasoning"],
            content: [],
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
          providerThreadId: "thread-1",
          threadId: "thread-1",
          turnId: "turn-1",
          itemId: "rs-1",
          delta: " trailing",
        },
        createdAt: 2,
      },
    ];

    const projected = toViewMessages(fromRows(events), {
      threadStatus: "idle",
    });
    const reasoning = projected.filter(
      (
        message,
      ): message is Extract<ViewMessage, { kind: "assistant-reasoning" }> =>
        message.kind === "assistant-reasoning",
    );

    expect(reasoning).toHaveLength(1);
    expect(reasoning[0]?.text).toBe("Final reasoning");
    expect(reasoning[0]?.status).toBe("completed");
  });

  it("treats raw reasoning text deltas as newline-buffered reasoning stream updates", () => {
    const events: ThreadEventRow[] = [
      {
        id: "evt-1",
        threadId: "thread-1",
        seq: 1,
        type: "item/reasoning/textDelta",
        data: {
          providerThreadId: "thread-1",
          threadId: "thread-1",
          turnId: "turn-1",
          itemId: "reasoning-1",
          delta: "raw-reasoning\npartial",
          contentIndex: 0,
        },
        createdAt: 1,
      },
    ];

    const projected = toViewMessages(fromRows(events), {
      threadStatus: "active",
    });
    const reasoning = projected.find(
      (
        message,
      ): message is Extract<ViewMessage, { kind: "assistant-reasoning" }> =>
        message.kind === "assistant-reasoning",
    );

    expect(reasoning).toBeDefined();
    expect(reasoning?.text).toBe("raw-reasoning\n");
    expect(reasoning?.status).toBe("streaming");
  });

  it("keeps assistant-side items from earlier and later assistant responses", () => {
    const events: ThreadEventRow[] = [
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

    const projected = toViewMessages(fromRows(events), {
      threadStatus: "idle",
    });

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
