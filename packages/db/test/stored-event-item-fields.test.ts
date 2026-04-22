import { describe, expect, it } from "vitest";
import { deriveStoredEventItemFields } from "../src/stored-event-item-fields.js";

describe("deriveStoredEventItemFields", () => {
  it("derives item columns from started item events", () => {
    expect(
      deriveStoredEventItemFields({
        type: "item/started",
        threadId: "thread-1",
        providerThreadId: "provider-1",
        turnId: "turn-1",
        item: {
          id: "tool-1",
          type: "toolCall",
          tool: "read_file",
          status: "in_progress",
        },
      }),
    ).toEqual({
      itemId: "tool-1",
      itemKind: "toolCall",
    });
  });

  it("derives item columns from completed item events", () => {
    expect(
      deriveStoredEventItemFields({
        type: "item/completed",
        threadId: "thread-1",
        providerThreadId: "provider-1",
        turnId: "turn-1",
        item: {
          id: "msg-1",
          type: "agentMessage",
          text: "hello",
        },
      }),
    ).toEqual({
      itemId: "msg-1",
      itemKind: "agentMessage",
    });
  });

  it("derives item ids from delta and progress events without an item kind", () => {
    expect(
      deriveStoredEventItemFields({
        type: "item/toolCall/progress",
        threadId: "thread-1",
        providerThreadId: "provider-1",
        turnId: "turn-1",
        itemId: "tool-1",
        message: "still running",
      }),
    ).toEqual({
      itemId: "tool-1",
      itemKind: null,
    });
  });

  it("derives item ids from agent-message delta events", () => {
    expect(
      deriveStoredEventItemFields({
        type: "item/agentMessage/delta",
        threadId: "thread-1",
        providerThreadId: "provider-1",
        turnId: "turn-1",
        itemId: "msg-1",
        delta: "hel",
      }),
    ).toEqual({
      itemId: "msg-1",
      itemKind: null,
    });
  });

  it("returns null item columns for non-item events", () => {
    expect(
      deriveStoredEventItemFields({
        type: "system/error",
        threadId: "thread-1",
        code: "tool_failed",
        message: "Something failed",
      }),
    ).toEqual({
      itemId: null,
      itemKind: null,
    });
  });
});
