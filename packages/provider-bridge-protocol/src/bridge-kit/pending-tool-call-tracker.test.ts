import { describe, expect, it } from "vitest";
import type { BridgeToolCallRequest } from "./bridge-tool-calls.js";
import { createPendingToolCallTracker } from "./pending-tool-call-tracker.js";

function createTracker() {
  const sent: BridgeToolCallRequest[] = [];
  const tracker = createPendingToolCallTracker({
    sendToolCall: (request) => sent.push(request),
  });
  return { sent, tracker };
}

describe("createPendingToolCallTracker", () => {
  it("mints incrementing item/tool/call requests", () => {
    const { sent, tracker } = createTracker();
    const scope = {};
    void tracker.forwardToolCall({
      arguments: { a: 1 },
      providerThreadId: "provider-1",
      scope,
      threadId: "thread-1",
      toolName: "my_tool",
    });
    void tracker.forwardToolCall({
      arguments: {},
      providerThreadId: "provider-1",
      scope,
      threadId: "thread-1",
      toolName: "other_tool",
    });

    expect(sent).toHaveLength(2);
    expect(sent[0]).toEqual({
      jsonrpc: "2.0",
      id: 1,
      method: "item/tool/call",
      params: {
        threadId: "thread-1",
        providerThreadId: "provider-1",
        turnId: null,
        callId: "call-1",
        tool: "my_tool",
        arguments: { a: 1 },
      },
    });
    expect(sent[1]?.id).toBe(2);
    expect(sent[1]?.params.callId).toBe("call-2");
  });

  it("settles a pending call from a success response payload", async () => {
    const { tracker } = createTracker();
    const result = tracker.forwardToolCall({
      arguments: {},
      providerThreadId: "provider-1",
      scope: {},
      threadId: "thread-1",
      toolName: "my_tool",
    });

    expect(
      tracker.handleToolCallResponse({
        jsonrpc: "2.0",
        id: 1,
        result: {
          success: true,
          contentItems: [{ type: "inputText", text: "hello" }],
        },
      }),
    ).toBe(true);
    await expect(result).resolves.toEqual({
      content: "hello",
      contentBlocks: [{ type: "text", text: "hello" }],
      images: [],
      isError: false,
    });
  });

  it("settles a pending call from an error response", async () => {
    const { tracker } = createTracker();
    const result = tracker.forwardToolCall({
      arguments: {},
      providerThreadId: "provider-1",
      scope: {},
      threadId: "thread-1",
      toolName: "my_tool",
    });

    expect(
      tracker.handleToolCallResponse({
        jsonrpc: "2.0",
        id: 1,
        error: { code: -32000, message: "boom" },
      }),
    ).toBe(true);
    await expect(result).resolves.toEqual({ content: "boom", isError: true });
  });

  it("returns false for responses that match no pending call", () => {
    const { tracker } = createTracker();
    expect(
      tracker.handleToolCallResponse({ jsonrpc: "2.0", id: 99, result: {} }),
    ).toBe(false);
  });

  it("does not settle the same call twice", async () => {
    const { tracker } = createTracker();
    void tracker.forwardToolCall({
      arguments: {},
      providerThreadId: "provider-1",
      scope: {},
      threadId: "thread-1",
      toolName: "my_tool",
    });
    const response = {
      jsonrpc: "2.0",
      id: 1,
      result: { success: true, contentItems: [] },
    } as const;
    expect(tracker.handleToolCallResponse(response)).toBe(true);
    expect(tracker.handleToolCallResponse(response)).toBe(false);
  });

  it("error-resolves only the pending calls of the given scope", async () => {
    const { tracker } = createTracker();
    const sessionA = {};
    const sessionB = {};
    const resultA = tracker.forwardToolCall({
      arguments: {},
      providerThreadId: "provider-a",
      scope: sessionA,
      threadId: "thread-a",
      toolName: "my_tool",
    });
    const resultB = tracker.forwardToolCall({
      arguments: {},
      providerThreadId: "provider-b",
      scope: sessionB,
      threadId: "thread-b",
      toolName: "my_tool",
    });

    tracker.resolvePendingToolCalls(sessionA, "session closed");
    await expect(resultA).resolves.toEqual({
      content: "session closed",
      isError: true,
    });

    expect(
      tracker.handleToolCallResponse({
        jsonrpc: "2.0",
        id: 2,
        result: {
          success: true,
          contentItems: [{ type: "inputText", text: "b" }],
        },
      }),
    ).toBe(true);
    await expect(resultB).resolves.toEqual({
      content: "b",
      contentBlocks: [{ type: "text", text: "b" }],
      images: [],
      isError: false,
    });
  });
});

describe("createPendingToolCallTracker send failures", () => {
  it("resolves an error result instead of rejecting when the sender throws", async () => {
    const tracker = createPendingToolCallTracker({
      sendToolCall: () => {
        throw new Error("transport closed");
      },
    });
    const scope = {};

    const result = await tracker.forwardToolCall({
      arguments: {},
      providerThreadId: "provider-1",
      scope,
      threadId: "thread-1",
      toolName: "my_tool",
    });
    expect(result).toEqual({ content: "transport closed", isError: true });

    tracker.resolvePendingToolCalls(scope, "closing");
    const response = tracker.handleToolCallResponse({
      jsonrpc: "2.0",
      id: 1,
      result: { content: "late" },
    });
    expect(response).toBe(false);
  });
});
