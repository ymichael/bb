import { describe, expect, it } from "vitest";
import { threadQueuedMessageSchema } from "../src/thread.js";

describe("thread queued message schema", () => {
  it("requires the explicit grouping boundary flag", () => {
    expect(
      threadQueuedMessageSchema.parse({
        id: "qmsg_123",
        threadId: "thread_1",
        content: [{ type: "text", text: "Queued message", mentions: [] }],
        model: "gpt-5",
        reasoningLevel: "medium",
        permissionMode: "accept-edits",
        serviceTier: "default",
        groupWithNext: false,
        sendAt: null,
        waitingOn: null,
        failureReason: null,
        payload: { kind: "inline" },
        editable: true,
        createdAt: 1,
        updatedAt: 1,
      }),
    ).toMatchObject({
      id: "qmsg_123",
      groupWithNext: false,
    });

    expect(() =>
      threadQueuedMessageSchema.parse({
        id: "qmsg_123",
        threadId: "thread_1",
        content: [{ type: "text", text: "Queued message", mentions: [] }],
        model: "gpt-5",
        reasoningLevel: "medium",
        permissionMode: "accept-edits",
        serviceTier: "default",
        sendAt: null,
        waitingOn: null,
        failureReason: null,
        payload: { kind: "inline" },
        editable: true,
        createdAt: 1,
        updatedAt: 1,
      }),
    ).toThrow();
  });
});
