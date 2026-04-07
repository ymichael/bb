import { describe, expect, it } from "vitest";
import { decodeProviderToolCallRequest } from "./provider-tool-call-contract.js";

describe("provider-tool-call-contract", () => {
  it("preserves both ids for already-normalized bridge tool calls", () => {
    expect(decodeProviderToolCallRequest(
      "req-1",
      "item/tool/call",
      {
        threadId: "thr_123",
        providerThreadId: "provider-abc",
        turnId: "turn-1",
        callId: "call-1",
        tool: "message_user",
        arguments: { text: "hello" },
      },
    )).toEqual({
      requestId: "req-1",
      threadId: "thr_123",
      providerThreadId: "provider-abc",
      turnId: "turn-1",
      callId: "call-1",
      tool: "message_user",
      arguments: { text: "hello" },
    });
  });

  it("treats single-id provider tool calls as provider-native requests", () => {
    expect(decodeProviderToolCallRequest(
      "req-2",
      "item/tool/call",
      {
        threadId: "provider-abc",
        turnId: "turn-1",
        callId: "call-1",
        tool: "message_user",
        arguments: { text: "hello" },
      },
    )).toEqual({
      requestId: "req-2",
      providerThreadId: "provider-abc",
      turnId: "turn-1",
      callId: "call-1",
      tool: "message_user",
      arguments: { text: "hello" },
    });
  });
});
