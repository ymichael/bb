import { describe, expect, it, beforeEach } from "vitest";
import {
  translatePiEvent,
  createTurnCounterState,
  type TurnCounterState,
} from "../event-translator.js";

describe("event-translator", () => {
  let counterState: TurnCounterState;

  beforeEach(() => {
    counterState = createTurnCounterState();
  });

  it("emits turn/started on agent_start", () => {
    const { notifications, turnId } = translatePiEvent(
      { type: "agent_start" },
      "thread-1",
      undefined,
      counterState,
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
      counterState,
    );
    expect(turnId).toBeUndefined();
    expect(notifications).toHaveLength(2);
    expect(notifications[0]).toMatchObject({
      method: "item/completed",
      params: {
        item: { type: "agentMessage", text: "Hello world" },
      },
    });
    expect(notifications[1]).toMatchObject({
      method: "turn/completed",
      params: { threadId: "thread-1", turnId: "turn-1" },
    });
  });

  it("emits token usage on agent_end when session stats are available", () => {
    const { notifications } = translatePiEvent(
      {
        type: "agent_end",
        messages: [
          {
            role: "assistant",
            content: [{ type: "text", text: "Hello world" }],
            usage: {
              input: 100,
              output: 20,
              cacheRead: 10,
              cacheWrite: 5,
              totalTokens: 135,
            },
          },
        ],
      },
      "thread-1",
      "turn-1",
      counterState,
      {
        sessionStats: {
          sessionFile: "/tmp/test.jsonl",
          sessionId: "session-1",
          userMessages: 1,
          assistantMessages: 1,
          toolCalls: 0,
          toolResults: 0,
          totalMessages: 2,
          tokens: {
            input: 300,
            output: 90,
            cacheRead: 25,
            cacheWrite: 15,
            total: 430,
          },
          cost: 0.42,
        },
        contextUsage: {
          tokens: 430,
          contextWindow: 200000,
          percent: 0.215,
        },
      },
    );

    expect(notifications).toHaveLength(3);
    expect(notifications[1]).toMatchObject({
      method: "thread/tokenUsage/updated",
      params: {
        threadId: "thread-1",
        turnId: "turn-1",
        tokenUsage: {
          total: {
            totalTokens: 430,
            inputTokens: 300,
            cachedInputTokens: 40,
            outputTokens: 90,
            reasoningOutputTokens: 0,
          },
          last: {
            totalTokens: 135,
            inputTokens: 100,
            cachedInputTokens: 15,
            outputTokens: 20,
            reasoningOutputTokens: 0,
          },
          modelContextWindow: 200000,
        },
      },
    });
    expect(notifications[2]).toMatchObject({
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
      counterState,
    );
    expect(notifications).toHaveLength(1);
    expect(notifications[0]).toMatchObject({
      method: "item/agentMessage/delta",
      params: { delta: "chunk" },
    });
  });

  it("maps bash tool_execution_start to commandExecution", () => {
    const { notifications } = translatePiEvent(
      {
        type: "tool_execution_start",
        toolCallId: "call-1",
        toolName: "bash",
        args: { command: "ls" },
      },
      "thread-1",
      "turn-1",
      counterState,
    );
    expect(notifications).toHaveLength(1);
    expect(notifications[0]).toMatchObject({
      method: "item/started",
      params: {
        item: {
          type: "commandExecution",
          id: "call-1",
          command: "ls",
          status: "running",
        },
      },
    });
  });

  it("maps bash tool_execution_end to commandExecution completed", () => {
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
      counterState,
    );
    expect(notifications).toHaveLength(1);
    expect(notifications[0]).toMatchObject({
      method: "item/completed",
      params: {
        item: {
          type: "commandExecution",
          id: "call-1",
          aggregatedOutput: "output",
          exitCode: 0,
          status: "completed",
        },
      },
    });
  });

  it("maps edit tool to filechange item type", () => {
    const { notifications } = translatePiEvent(
      {
        type: "tool_execution_start",
        toolCallId: "call-2",
        toolName: "edit",
        args: { file_path: "/src/app.ts" },
      },
      "thread-1",
      "turn-1",
      counterState,
    );
    expect(notifications).toHaveLength(1);
    expect(notifications[0]).toMatchObject({
      method: "item/started",
      params: {
        item: {
          type: "filechange",
          id: "call-2",
          changes: [{ path: "/src/app.ts", kind: { type: "update" } }],
        },
      },
    });
  });

  it("maps unknown tool to custom_tool_call", () => {
    const { notifications } = translatePiEvent(
      {
        type: "tool_execution_start",
        toolCallId: "call-3",
        toolName: "my_custom_tool",
        args: { message: "hello" },
      },
      "thread-1",
      "turn-1",
      counterState,
    );
    expect(notifications).toHaveLength(1);
    expect(notifications[0]).toMatchObject({
      method: "item/started",
      params: {
        item: {
          type: "custom_tool_call",
          call_id: "call-3",
          name: "my_custom_tool",
        },
      },
    });
  });

  it("maps unknown tool_execution_end to custom_tool_call_output", () => {
    const { notifications } = translatePiEvent(
      {
        type: "tool_execution_end",
        toolCallId: "call-3",
        toolName: "my_custom_tool",
        result: "done",
        isError: false,
      },
      "thread-1",
      "turn-1",
      counterState,
    );
    expect(notifications).toHaveLength(1);
    expect(notifications[0]).toMatchObject({
      method: "item/completed",
      params: {
        item: {
          type: "custom_tool_call_output",
          call_id: "call-3",
          output: "done",
        },
      },
    });
  });

  it("ignores unknown event types", () => {
    const { notifications } = translatePiEvent(
      { type: "auto_compaction_start" },
      "thread-1",
      "turn-1",
      counterState,
    );
    expect(notifications).toHaveLength(0);
  });

  it("maintains separate turn counters per state object", () => {
    const counterA = createTurnCounterState();
    const counterB = createTurnCounterState();

    const resultA = translatePiEvent(
      { type: "agent_start" },
      "thread-A",
      undefined,
      counterA,
    );
    const resultB = translatePiEvent(
      { type: "agent_start" },
      "thread-B",
      undefined,
      counterB,
    );

    expect(resultA.turnId).toBe("turn-1");
    expect(resultB.turnId).toBe("turn-1");
  });
});
