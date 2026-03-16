import { describe, expect, it, beforeEach } from "vitest";
import {
  translatePiEvent,
  resetTurnCounter,
} from "../event-translator.js";

describe("event-translator", () => {
  beforeEach(() => {
    resetTurnCounter();
  });

  it("emits turn/started on agent_start", () => {
    const { notifications, turnId } = translatePiEvent(
      { type: "agent_start" },
      "thread-1",
      undefined,
    );
    expect(turnId).toBe("turn-1");
    expect(notifications).toHaveLength(1);
    expect(notifications[0]).toMatchObject({
      method: "turn/started",
      params: { threadId: "thread-1", turnId: "turn-1" },
    });
  });

  it("emits item/completed + turn/completed on agent_end with assistant message", () => {
    const { notifications, turnId } = translatePiEvent(
      {
        type: "agent_end",
        messages: [
          {
            role: "assistant",
            content: [{ type: "text", text: "Hello world" }],
          },
        ],
      },
      "thread-1",
      "turn-1",
    );
    expect(turnId).toBeUndefined();
    expect(notifications).toHaveLength(2);
    expect(notifications[0]).toMatchObject({
      method: "item/completed",
      params: {
        item: { normalizedType: "agentmessage", text: { text: "Hello world" } },
      },
    });
    expect(notifications[1]).toMatchObject({
      method: "turn/completed",
      params: { threadId: "thread-1", turnId: "turn-1" },
    });
  });

  it("emits delta for message_update text_delta", () => {
    const { notifications } = translatePiEvent(
      {
        type: "message_update",
        assistantMessageEvent: {
          type: "text_delta",
          delta: "chunk",
        },
      },
      "thread-1",
      "turn-1",
    );
    expect(notifications).toHaveLength(1);
    expect(notifications[0]).toMatchObject({
      method: "item/agentMessage/delta",
      params: { delta: "chunk" },
    });
  });

  it("emits item/started for tool_execution_start", () => {
    const { notifications } = translatePiEvent(
      {
        type: "tool_execution_start",
        toolCallId: "call-1",
        toolName: "bash",
        args: { command: "ls" },
      },
      "thread-1",
      "turn-1",
    );
    expect(notifications).toHaveLength(1);
    expect(notifications[0]).toMatchObject({
      method: "item/started",
      params: {
        item: {
          normalizedType: "toolcall",
          callId: "call-1",
          tool: "bash",
        },
      },
    });
  });

  it("emits item/completed for tool_execution_end", () => {
    const { notifications } = translatePiEvent(
      {
        type: "tool_execution_end",
        toolCallId: "call-1",
        toolName: "bash",
        result: { content: [{ type: "text", text: "output" }] },
        isError: false,
      },
      "thread-1",
      "turn-1",
    );
    expect(notifications).toHaveLength(1);
    expect(notifications[0]).toMatchObject({
      method: "item/completed",
      params: {
        item: {
          normalizedType: "toolresult",
          callId: "call-1",
          isError: false,
        },
      },
    });
  });

  it("ignores unknown event types", () => {
    const { notifications } = translatePiEvent(
      { type: "auto_compaction_start" },
      "thread-1",
      "turn-1",
    );
    expect(notifications).toHaveLength(0);
  });
});
