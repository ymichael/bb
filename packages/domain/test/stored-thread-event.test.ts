import { describe, expect, it } from "vitest";
import { parseStoredThreadEvent } from "../src/stored-thread-event.js";

describe("parseStoredThreadEvent", () => {
  it("rejects assistant deltas without an itemId", () => {
    expect(() =>
      parseStoredThreadEvent({
        type: "item/agentMessage/delta",
        threadId: "thread-1",
        providerThreadId: "provider-1",
        turnId: "turn-1",
        data: {
          delta: "partial reply",
        },
      }),
    ).toThrow();
  });
});
