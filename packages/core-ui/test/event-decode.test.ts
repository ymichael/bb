import { describe, expect, it } from "vitest";
import type { ThreadEventRow } from "@bb/domain";
import { decodeRow } from "../src/event-decode.js";

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
});
