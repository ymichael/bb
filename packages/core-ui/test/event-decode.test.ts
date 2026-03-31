import { describe, expect, it } from "vitest";
import type { ThreadEventRow } from "@bb/domain";
import { decodeRow, isKnownThreadEvent } from "../src/event-decode.js";

describe("decodeRow", () => {
  it("parses persisted provider events through the thread event schema", () => {
    const row: ThreadEventRow = {
      id: "row-1",
      threadId: "thread-1",
      seq: 1,
      type: "item/completed",
      data: {
        providerThreadId: "provider-thread-1",
        turnId: "turn-1",
        item: {
          type: "toolCall",
          id: "tool-1",
          tool: "Read",
          status: "completed",
        },
      },
      createdAt: 123,
    };

    expect(decodeRow(row)).toEqual({
      event: {
        type: "item/completed",
        threadId: "thread-1",
        providerThreadId: "provider-thread-1",
        turnId: "turn-1",
        item: {
          type: "toolCall",
          id: "tool-1",
          tool: "Read",
          status: "completed",
        },
      },
      meta: {
        id: "row-1",
        seq: 1,
        createdAt: 123,
      },
    });
  });

  it("throws when persisted event data does not match the thread event schema", () => {
    const row: ThreadEventRow = {
      id: "row-1",
      threadId: "thread-1",
      seq: 1,
      type: "item/completed",
      data: {
        providerThreadId: "provider-thread-1",
        turnId: "turn-1",
        item: {
          type: "toolCall",
          id: "tool-1",
          tool: "Read",
          status: "bogus",
        },
      },
      createdAt: 123,
    };

    expect(() => decodeRow(row)).toThrow();
  });

  it("normalizes legacy persisted turn rows before parsing", () => {
    const row: ThreadEventRow = {
      id: "row-legacy-turn",
      threadId: "bb-thread-1",
      seq: 2,
      type: "turn/completed",
      data: {
        threadId: "provider-thread-1",
        turn: {
          id: "turn-1",
          status: "completed",
          error: null,
        },
      },
      createdAt: 456,
    };

    expect(decodeRow(row)).toEqual({
      event: {
        type: "turn/completed",
        threadId: "bb-thread-1",
        providerThreadId: "provider-thread-1",
        turnId: "turn-1",
        status: "completed",
      },
      meta: {
        id: "row-legacy-turn",
        seq: 2,
        createdAt: 456,
      },
    });
  });

  it("throws when turn/completed rows omit canonical status", () => {
    const row: ThreadEventRow = {
      id: "row-turn-status-missing",
      threadId: "thread-1",
      seq: 3,
      type: "turn/completed",
      data: {
        providerThreadId: "provider-thread-1",
        turnId: "turn-1",
      },
      createdAt: 789,
    };

    expect(() => decodeRow(row)).toThrow();
  });

  it("throws when system rows rely on deleted default fields", () => {
    const row: ThreadEventRow = {
      id: "row-thread-interrupted",
      threadId: "thread-1",
      seq: 4,
      type: "system/thread/interrupted",
      data: {
        message: "Stopped by user",
      },
      createdAt: 999,
    };

    expect(() => decodeRow(row)).toThrow();
  });

  it("throws when web-search items use legacy structured action payloads", () => {
    const row: ThreadEventRow = {
      id: "row-web-search-action",
      threadId: "thread-1",
      seq: 5,
      type: "item/completed",
      data: {
        providerThreadId: "provider-thread-1",
        turnId: "turn-1",
        item: {
          type: "webSearch",
          id: "web-1",
          query: "react suspense",
          action: { type: "search", query: "react suspense" },
          outputText: "Found the React Suspense docs",
        },
      },
      createdAt: 1111,
    };

    expect(() => decodeRow(row)).toThrow();
  });

  it("identifies unknown decoded rows by event type instead of rawData shape", () => {
    const decoded = decodeRow({
      id: "row-unknown-1",
      threadId: "thread-1",
      seq: 3,
      type: "provider/future-event",
      data: {
        providerThreadId: "provider-thread-1",
        rawData: "payload-shaped-like-a-future-event",
      },
      createdAt: 789,
    });

    expect(isKnownThreadEvent(decoded.event)).toBe(false);
  });
});
