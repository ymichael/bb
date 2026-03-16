import { describe, expect, it, beforeEach } from "vitest";
import {
  translateSdkMessage,
  createTurnCounterState,
  type TurnCounterState,
} from "../event-translator.js";
import type { SDKMessage } from "@anthropic-ai/claude-agent-sdk";

describe("event-translator", () => {
  let counterState: TurnCounterState;

  beforeEach(() => {
    counterState = createTurnCounterState();
  });

  it("captures system init without emitting notifications", () => {
    const message = {
      type: "system",
      subtype: "init",
      session_id: "sess-1",
    } as unknown as SDKMessage;

    const { notifications, turnId } = translateSdkMessage(
      message,
      "thread-1",
      undefined,
      counterState,
    );

    expect(notifications).toHaveLength(0);
    expect(turnId).toBeUndefined();
  });

  it("emits turn/started + item/completed for assistant text", () => {
    const message = {
      type: "assistant",
      message: {
        role: "assistant",
        content: [{ type: "text", text: "Hello world" }],
      },
    } as unknown as SDKMessage;

    const { notifications, turnId } = translateSdkMessage(
      message,
      "thread-1",
      undefined,
      counterState,
    );

    expect(turnId).toBe("turn-1");
    expect(notifications).toHaveLength(2);
    expect(notifications[0]).toMatchObject({
      method: "turn/started",
      params: { threadId: "thread-1", turnId: "turn-1" },
    });
    expect(notifications[1]).toMatchObject({
      method: "item/completed",
      params: {
        threadId: "thread-1",
        turnId: "turn-1",
        item: { type: "agentMessage", text: "Hello world" },
      },
    });
  });

  it("emits item/started for tool_use blocks", () => {
    const message = {
      type: "assistant",
      message: {
        role: "assistant",
        content: [
          {
            type: "tool_use",
            id: "call-1",
            name: "read_file",
            input: { path: "/test.ts" },
          },
        ],
      },
    } as unknown as SDKMessage;

    const { notifications } = translateSdkMessage(
      message,
      "thread-1",
      undefined,
      counterState,
    );

    // turn/started + item/started (no text so no item/completed for text)
    expect(notifications).toHaveLength(2);
    // Unknown tools emit as custom_tool_call
    expect(notifications[1]).toMatchObject({
      method: "item/started",
      params: {
        item: {
          type: "custom_tool_call",
          call_id: "call-1",
          name: "read_file",
        },
      },
    });
  });

  it("maps Bash tool_use to commandExecution item type", () => {
    const message = {
      type: "assistant",
      message: {
        role: "assistant",
        content: [
          {
            type: "tool_use",
            id: "call-bash",
            name: "Bash",
            input: { command: "ls -la", cwd: "/tmp" },
          },
        ],
      },
    } as unknown as SDKMessage;

    const { notifications } = translateSdkMessage(
      message,
      "thread-1",
      undefined,
      counterState,
    );

    expect(notifications[1]).toMatchObject({
      method: "item/started",
      params: {
        item: {
          type: "commandExecution",
          id: "call-bash",
          command: "ls -la",
          cwd: "/tmp",
          status: "running",
        },
      },
    });
  });

  it("maps Edit tool_use to filechange item type", () => {
    const message = {
      type: "assistant",
      message: {
        role: "assistant",
        content: [
          {
            type: "tool_use",
            id: "call-edit",
            name: "Edit",
            input: { file_path: "/src/main.ts", old_string: "a", new_string: "b" },
          },
        ],
      },
    } as unknown as SDKMessage;

    const { notifications } = translateSdkMessage(
      message,
      "thread-1",
      undefined,
      counterState,
    );

    expect(notifications[1]).toMatchObject({
      method: "item/started",
      params: {
        item: {
          type: "filechange",
          id: "call-edit",
          changes: [{ path: "/src/main.ts", kind: { type: "update" } }],
        },
      },
    });
  });

  it("maps WebSearch tool_use to webSearch item type", () => {
    const message = {
      type: "assistant",
      message: {
        role: "assistant",
        content: [
          {
            type: "tool_use",
            id: "call-ws",
            name: "WebSearch",
            input: { query: "vitest docs" },
          },
        ],
      },
    } as unknown as SDKMessage;

    const { notifications } = translateSdkMessage(
      message,
      "thread-1",
      undefined,
      counterState,
    );

    expect(notifications[1]).toMatchObject({
      method: "item/started",
      params: {
        item: {
          type: "webSearch",
          id: "call-ws",
          query: "vitest docs",
        },
      },
    });
  });

  it("maps tool result for Bash to commandExecution completed", () => {
    const message = {
      type: "user",
      message: {
        role: "user",
        content: [
          {
            type: "tool_result",
            tool_use_id: "call-bash",
            tool_name: "Bash",
            content: "file listing output",
          },
        ],
      },
    } as unknown as SDKMessage;

    const { notifications } = translateSdkMessage(
      message,
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
          id: "call-bash",
          aggregatedOutput: "file listing output",
          exitCode: 0,
          status: "completed",
        },
      },
    });
  });

  it("maps tool result without known tool name to custom_tool_call_output", () => {
    const message = {
      type: "user",
      message: {
        role: "user",
        content: [
          {
            type: "tool_result",
            tool_use_id: "call-1",
            content: "file contents here",
          },
        ],
      },
    } as unknown as SDKMessage;

    const { notifications } = translateSdkMessage(
      message,
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
          call_id: "call-1",
        },
      },
    });
  });

  it("emits delta for stream_event text", () => {
    const message = {
      type: "stream_event",
      event: {
        type: "content_block_delta",
        delta: { type: "text_delta", text: "chunk" },
      },
    } as unknown as SDKMessage;

    const { notifications } = translateSdkMessage(
      message,
      "thread-1",
      "turn-1",
      counterState,
    );

    expect(notifications).toHaveLength(1);
    expect(notifications[0]).toMatchObject({
      method: "item/agentMessage/delta",
      params: { threadId: "thread-1", turnId: "turn-1", delta: "chunk" },
    });
  });

  it("emits turn/completed for result message", () => {
    const message = {
      type: "result",
      subtype: "success",
    } as unknown as SDKMessage;

    const { notifications, turnId } = translateSdkMessage(
      message,
      "thread-1",
      "turn-1",
      counterState,
    );

    expect(turnId).toBeUndefined();
    expect(notifications).toHaveLength(1);
    expect(notifications[0]).toMatchObject({
      method: "turn/completed",
      params: {
        threadId: "thread-1",
        turnId: "turn-1",
        result: { subtype: "success" },
      },
    });
  });

  it("emits token usage before turn/completed for result messages with usage", () => {
    const message = {
      type: "result",
      subtype: "success",
      usage: {
        input_tokens: 120,
        output_tokens: 45,
        cache_read_input_tokens: 30,
        cache_creation_input_tokens: 10,
      },
      modelUsage: {
        "claude-sonnet-4": {
          inputTokens: 120,
          outputTokens: 45,
          cacheReadInputTokens: 30,
          cacheCreationInputTokens: 10,
          webSearchRequests: 0,
          costUSD: 0.12,
          contextWindow: 200000,
          maxOutputTokens: 64000,
        },
      },
    } as unknown as SDKMessage;

    const { notifications } = translateSdkMessage(
      message,
      "thread-1",
      "turn-1",
      counterState,
    );

    expect(notifications).toHaveLength(2);
    expect(notifications[0]).toMatchObject({
      method: "thread/tokenUsage/updated",
      params: {
        threadId: "thread-1",
        turnId: "turn-1",
        tokenUsage: {
          total: {
            totalTokens: 205,
            inputTokens: 120,
            cachedInputTokens: 40,
            outputTokens: 45,
            reasoningOutputTokens: 0,
          },
          last: {
            totalTokens: 205,
            inputTokens: 120,
            cachedInputTokens: 40,
            outputTokens: 45,
            reasoningOutputTokens: 0,
          },
          modelContextWindow: 200000,
        },
      },
    });
    expect(notifications[1]).toMatchObject({
      method: "turn/completed",
      params: {
        threadId: "thread-1",
        turnId: "turn-1",
        result: { subtype: "success" },
      },
    });
  });

  it("does not emit turn/started twice for same turn", () => {
    const msg1 = {
      type: "assistant",
      message: {
        role: "assistant",
        content: [{ type: "text", text: "Part 1" }],
      },
    } as unknown as SDKMessage;

    const result1 = translateSdkMessage(msg1, "thread-1", undefined, counterState);
    expect(result1.turnId).toBe("turn-1");

    const msg2 = {
      type: "assistant",
      message: {
        role: "assistant",
        content: [{ type: "text", text: "Part 2" }],
      },
    } as unknown as SDKMessage;

    const result2 = translateSdkMessage(msg2, "thread-1", result1.turnId, counterState);
    const turnStartedCount = result2.notifications.filter(
      (n) => n.method === "turn/started",
    ).length;
    expect(turnStartedCount).toBe(0);
  });

  it("emits tool result items from user messages (generic tool)", () => {
    const message = {
      type: "user",
      message: {
        role: "user",
        content: [
          {
            type: "tool_result",
            tool_use_id: "call-1",
            content: "file contents here",
          },
        ],
      },
    } as unknown as SDKMessage;

    const { notifications } = translateSdkMessage(
      message,
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
          call_id: "call-1",
          output: "file contents here",
        },
      },
    });
  });

  it("maintains separate turn counters per state object", () => {
    const counterA = createTurnCounterState();
    const counterB = createTurnCounterState();

    const msg = {
      type: "assistant",
      message: {
        role: "assistant",
        content: [{ type: "text", text: "Hello" }],
      },
    } as unknown as SDKMessage;

    const resultA = translateSdkMessage(msg, "thread-A", undefined, counterA);
    const resultB = translateSdkMessage(msg, "thread-B", undefined, counterB);

    expect(resultA.turnId).toBe("turn-1");
    expect(resultB.turnId).toBe("turn-1");
  });
});
