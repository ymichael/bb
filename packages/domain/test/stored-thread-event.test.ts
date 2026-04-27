import { describe, expect, it } from "vitest";
import {
  parseStoredThreadEvent,
  parseThreadEventRow,
} from "../src/stored-thread-event.js";
import { turnScope } from "../src/thread-event-scope.js";

describe("parseStoredThreadEvent", () => {
  it("rejects assistant deltas without an itemId", () => {
    expect(() =>
      parseStoredThreadEvent({
        type: "item/agentMessage/delta",
        threadId: "thread-1",
        providerThreadId: "provider-1",
        scope: turnScope("turn-1"),
        data: {
          delta: "partial reply",
        },
      }),
    ).toThrow();
  });

  it("requires stored rows to carry explicit scope", () => {
    expect(() =>
      parseThreadEventRow({
        id: "evt-1",
        type: "thread/started",
        threadId: "thread-1",
        seq: 1,
        data: {},
        createdAt: 1,
      }),
    ).toThrow(/scope/);
  });

  it("drops legacy data turnId and uses stored scope as ground truth", () => {
    const event = parseStoredThreadEvent({
      type: "item/completed",
      threadId: "thread-1",
      providerThreadId: "provider-1",
      scope: turnScope("turn-from-scope"),
      data: {
        turnId: "turn-from-data",
        item: {
          type: "agentMessage",
          id: "assistant-1",
          text: "Hello.",
        },
      },
    });

    expect(event).toMatchObject({
      type: "item/completed",
      scope: turnScope("turn-from-scope"),
    });
    expect(event).not.toHaveProperty("turnId");
  });
});
