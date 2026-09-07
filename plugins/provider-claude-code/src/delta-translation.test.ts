import { describe, expect, it } from "vitest";
import type { ThreadEvent } from "@bb/domain";
import { threadScope, turnScope } from "@bb/domain";
import {
  ITEM_ID_PATTERN,
  TURN_1,
  TURN_2,
  createClaudeDeltaHarness,
  loadFixture,
  spawningToolUseFor,
} from "./delta-test-harness.js";

const THREAD_ID = "thr_claude_rate_limits";

function sdkMessage(message: Record<string, unknown>): Record<string, unknown> {
  return {
    jsonrpc: "2.0",
    method: "sdk/message",
    params: { threadId: THREAD_ID, message },
  };
}

function providerErrors(events: readonly ThreadEvent[]) {
  return events.filter((event) => event.type === "provider/error");
}

describe("claude rate-limit classification (delta path)", () => {
  it("classifies an SDK rate-limit retry as a retrying rate-limit error", () => {
    const harness = createClaudeDeltaHarness();
    harness.translate(
      sdkMessage({
        type: "assistant",
        message: { id: "assistant-1", content: [] },
      }),
      { threadId: THREAD_ID },
    );

    const events = harness.translate(
      sdkMessage({
        type: "system",
        subtype: "api_retry",
        attempt: 2,
        max_retries: 5,
        retry_delay_ms: 1500,
        error_status: 429,
        error: "rate_limit",
      }),
      { threadId: THREAD_ID },
    );

    expect(providerErrors(events)).toEqual([
      expect.objectContaining({
        type: "provider/error",
        scope: turnScope(TURN_1),
        message: "Provider error",
        detail: "Claude Code API retry 2/5 after 1500ms: HTTP 429 rate_limit",
        willRetry: true,
        errorInfo: {
          category: "rate-limit",
          providerCode: "rate_limit",
          httpStatusCode: 429,
        },
      }),
    ]);
  });

  it("defers a hard rejection into one terminal rate-limit error on the result", () => {
    const harness = createClaudeDeltaHarness();

    const rejection = harness.translate(
      sdkMessage({
        type: "rate_limit_event",
        rate_limit_info: {
          status: "rejected",
          rateLimitType: "five_hour",
          resetsAt: 12_345,
        },
      }),
      { threadId: THREAD_ID },
    );

    expect(rejection.map((event) => event.type)).toEqual([
      "turn/started",
      "provider/rateLimits/updated",
    ]);
    expect(rejection).toContainEqual(
      expect.objectContaining({
        type: "provider/rateLimits/updated",
        rateLimits: expect.objectContaining({
          status: "blocked",
          kind: "subscription-window",
          reachedReason: "five_hour",
          windows: [
            expect.objectContaining({
              providerKey: "five_hour",
              resetsAtMs: 12_345_000,
            }),
          ],
        }),
      }),
    );
    expect(providerErrors(rejection)).toEqual([]);

    const result = harness.translate(
      sdkMessage({
        type: "result",
        subtype: "error_during_execution",
        is_error: true,
        api_error_status: 429,
        result:
          "You've hit your session limit · resets 1:50pm (America/Los_Angeles)",
        usage: {},
        modelUsage: {},
      }),
      { threadId: THREAD_ID },
    );

    expect(providerErrors(result)).toEqual([
      expect.objectContaining({
        type: "provider/error",
        scope: turnScope(TURN_1),
        detail: expect.stringContaining("You've hit your session limit"),
        errorInfo: {
          category: "rate-limit",
          providerCode: "error_during_execution",
          httpStatusCode: 429,
        },
      }),
    ]);
    expect(result).toContainEqual(
      expect.objectContaining({
        type: "turn/completed",
        scope: turnScope(TURN_1),
        status: "failed",
      }),
    );
  });

  it("drops a pending rejection once the provider reports allowed again", () => {
    const harness = createClaudeDeltaHarness();

    harness.translate(
      sdkMessage({
        type: "rate_limit_event",
        rate_limit_info: {
          status: "rejected",
          rateLimitType: "five_hour",
          resetsAt: 12_345,
        },
      }),
      { threadId: THREAD_ID },
    );
    harness.translate(
      sdkMessage({
        type: "rate_limit_event",
        rate_limit_info: { status: "allowed", rateLimitType: "five_hour" },
      }),
      { threadId: THREAD_ID },
    );

    const result = harness.translate(
      sdkMessage({
        type: "result",
        subtype: "success",
        is_error: false,
        usage: {},
        modelUsage: {},
      }),
      { threadId: THREAD_ID },
    );

    expect(providerErrors(result)).toEqual([]);
    expect(result).toContainEqual(
      expect.objectContaining({
        type: "turn/completed",
        scope: turnScope(TURN_1),
        status: "completed",
      }),
    );
  });
});

describe("claude turn and checkpoint lifecycle", () => {
  it("emits turn/started + item/completed for assistant message", () => {
    const harness = createClaudeDeltaHarness();
    const events = harness.translate({
      type: "assistant",
      message: {
        id: "msg-1",
        role: "assistant",
        content: [{ type: "text", text: "Hello world" }],
      },
      session_id: "sess-1",
    });

    expect(events).toContainEqual(
      expect.objectContaining({
        type: "turn/started",
        scope: turnScope(TURN_1),
      }),
    );
    expect(events).toContainEqual(
      expect.objectContaining({
        type: "item/completed",
        item: expect.objectContaining({
          type: "agentMessage",
          id: expect.stringMatching(ITEM_ID_PATTERN),
          text: "Hello world",
        }),
      }),
    );
  });

  it("records the latest Claude assistant message as the turn checkpoint", () => {
    const harness = createClaudeDeltaHarness();
    harness.translate({
      type: "assistant",
      uuid: "assistant-message-42",
      message: {
        id: "msg-1",
        role: "assistant",
        content: [{ type: "text", text: "Done" }],
      },
      session_id: "sess-1",
    });

    const events = harness.translate({
      type: "result",
      subtype: "success",
      session_id: "sess-1",
    });

    expect(events).toContainEqual(
      expect.objectContaining({
        type: "turn/completed",
        status: "completed",
        providerCheckpointId: "assistant-message-42",
      }),
    );
  });

  it("does not replace the root checkpoint with a sidechain assistant UUID", () => {
    const harness = createClaudeDeltaHarness();
    harness.translate(
      {
        type: "assistant",
        uuid: "root-assistant-message",
        message: {
          id: "root-message",
          role: "assistant",
          content: [{ type: "text", text: "Root response" }],
        },
        session_id: "sess-1",
      },
      { threadId: "bb-thread-1" },
    );
    harness.translate(
      {
        type: "assistant",
        uuid: "sidechain-assistant-message",
        message: {
          id: "sidechain-message",
          role: "assistant",
          content: [{ type: "text", text: "Subagent response" }],
        },
        session_id: "sess-1",
      },
      { threadId: "bb-thread-1", parentToolCallId: "tool-subagent" },
    );

    const events = harness.translate(
      {
        type: "result",
        subtype: "success",
        session_id: "sess-1",
      },
      { threadId: "bb-thread-1" },
    );

    expect(events).toContainEqual(
      expect.objectContaining({
        type: "turn/completed",
        providerCheckpointId: "root-assistant-message",
      }),
    );
  });

  it("keeps assistant message ids distinct within one turn", () => {
    const harness = createClaudeDeltaHarness();

    const firstEvents = harness.translate({
      type: "assistant",
      message: {
        id: "msg-1",
        role: "assistant",
        content: [{ type: "text", text: "Now let me read the main files:" }],
      },
      session_id: "sess-1",
    });

    const secondEvents = harness.translate({
      type: "assistant",
      message: {
        id: "msg-2",
        role: "assistant",
        content: [{ type: "text", text: "Now let me read the test file:" }],
      },
      session_id: "sess-1",
    });

    const firstCompleted = firstEvents.find(
      (event) => event.type === "item/completed",
    );
    const secondCompleted = secondEvents.find(
      (event) => event.type === "item/completed",
    );
    expect(firstCompleted?.item).toMatchObject({
      type: "agentMessage",
      text: "Now let me read the main files:",
    });
    expect(secondCompleted?.item).toMatchObject({
      type: "agentMessage",
      text: "Now let me read the test file:",
    });
    expect(firstCompleted?.item.id).not.toBe(secondCompleted?.item.id);
  });

  it("increments turn IDs across turns", () => {
    const harness = createClaudeDeltaHarness();

    harness.translate({
      type: "assistant",
      message: {
        role: "assistant",
        content: [{ type: "text", text: "first" }],
      },
      session_id: "sess-1",
    });
    harness.translate({
      type: "result",
      subtype: "end_turn",
      session_id: "sess-1",
    });

    const events = harness.translate({
      type: "assistant",
      message: {
        role: "assistant",
        content: [{ type: "text", text: "second" }],
      },
      session_id: "sess-1",
    });

    expect(events).toContainEqual(
      expect.objectContaining({
        type: "turn/started",
        scope: turnScope(TURN_2),
      }),
    );
  });

  it("emits turn/completed on result message", () => {
    const harness = createClaudeDeltaHarness();
    harness.translate({
      type: "assistant",
      message: { role: "assistant", content: [{ type: "text", text: "done" }] },
      session_id: "sess-1",
    });

    const events = harness.translate({
      type: "result",
      subtype: "end_turn",
      session_id: "sess-1",
    });

    expect(events).toContainEqual(
      expect.objectContaining({
        type: "turn/completed",
        scope: turnScope(TURN_1),
        status: "completed",
      }),
    );
  });

  it("emits failed status for error result", () => {
    const harness = createClaudeDeltaHarness();
    harness.translate({
      type: "assistant",
      message: { role: "assistant", content: [{ type: "text", text: "x" }] },
      session_id: "sess-1",
    });

    const events = harness.translate({
      type: "result",
      subtype: "error",
      session_id: "sess-1",
    });

    expect(events).toContainEqual(
      expect.objectContaining({
        type: "turn/completed",
        status: "failed",
      }),
    );
  });

  it("does not open a provider-only turn while a failed turn's subagent drains", () => {
    const harness = createClaudeDeltaHarness();
    const context = { threadId: "bb-thread-rate-limited" };
    harness.acceptInput("creq_23456789af", context.threadId);
    harness.translate(
      spawningToolUseFor(loadFixture("task-started-subagent.json")),
      context,
    );
    harness.translate(loadFixture("task-started-subagent.json"), context);
    harness.translate(
      {
        type: "rate_limit_event",
        rate_limit_info: {
          status: "rejected",
          rateLimitType: "five_hour",
          resetsAt: 12345,
        },
        session_id: "claude-session-1",
      },
      context,
    );

    const failed = harness.translate(
      {
        type: "result",
        subtype: "error_during_execution",
        is_error: true,
        api_error_status: 429,
        result: "You've hit your session limit",
        usage: {},
        modelUsage: {},
        session_id: "claude-session-1",
      },
      context,
    );
    expect(failed).toContainEqual(
      expect.objectContaining({
        type: "turn/completed",
        scope: turnScope(TURN_1),
        status: "failed",
      }),
    );

    const taskCompleted = harness.translate(
      loadFixture("task-notification-subagent.json"),
      context,
    );
    expect(taskCompleted).toContainEqual(
      expect.objectContaining({ type: "item/backgroundTask/completed" }),
    );
    expect(
      harness.translate(
        {
          type: "assistant",
          message: {
            id: "late-subagent-message",
            role: "assistant",
            content: [{ type: "text", text: "Late subagent output" }],
          },
          session_id: "claude-session-1",
        },
        {
          ...context,
          parentToolCallId: "toolu_01W1cLr7AsTRvbya9LM5LSAV",
        },
      ),
    ).toEqual([]);

    harness.acceptInput("creq_23456789ad", context.threadId);
    const followUp = harness.translate(
      {
        type: "assistant",
        message: {
          id: "follow-up-message",
          role: "assistant",
          content: [{ type: "text", text: "Working again" }],
        },
        session_id: "claude-session-1",
      },
      context,
    );
    expect(followUp).toContainEqual(
      expect.objectContaining({
        type: "turn/started",
        scope: turnScope(TURN_2),
      }),
    );
    expect(followUp).toContainEqual(
      expect.objectContaining({
        type: "turn/input/accepted",
        clientRequestId: "creq_23456789ad",
        scope: turnScope(TURN_2),
      }),
    );
    expect(followUp).toContainEqual(
      expect.objectContaining({
        type: "item/completed",
        scope: turnScope(TURN_2),
      }),
    );
  });

  it("does not open a provider-only turn for a bridge error after terminal failure", () => {
    const harness = createClaudeDeltaHarness();
    const context = { threadId: "bb-thread-bridge-error-drain" };
    harness.acceptInput("creq_23456789bg", context.threadId);
    harness.translate(
      {
        type: "assistant",
        message: {
          id: "assistant-before-failure",
          role: "assistant",
          content: [{ type: "text", text: "Working" }],
        },
        session_id: "claude-session-1",
      },
      context,
    );
    expect(
      harness.translate(
        {
          type: "result",
          subtype: "error_during_execution",
          is_error: true,
          result: "Usage limit reached",
          usage: {},
          modelUsage: {},
          session_id: "claude-session-1",
        },
        context,
      ),
    ).toContainEqual(
      expect.objectContaining({
        type: "turn/completed",
        scope: turnScope(TURN_1),
        status: "failed",
      }),
    );

    expect(
      harness.translate(
        {
          jsonrpc: "2.0",
          method: "error",
          params: { message: "Late SDK stream failure" },
        },
        context,
      ),
    ).toEqual([]);
  });
});

describe("claude synthetic no-response handling", () => {
  it("completes a pending turn for Claude synthetic no-response messages", () => {
    const harness = createClaudeDeltaHarness();
    expect(harness.acceptInput("creq_23456789af", "bb-thread-1")).toEqual([]);

    const events = harness.translate(
      {
        type: "assistant",
        message: {
          role: "assistant",
          content: [{ type: "text", text: "No response requested." }],
          model: "<synthetic>",
          stop_reason: "stop_sequence",
          stop_sequence: "",
          usage: {
            input_tokens: 0,
            cache_creation_input_tokens: 0,
            cache_read_input_tokens: 0,
            output_tokens: 0,
          },
        },
        session_id: "claude-session-1",
      },
      { threadId: "bb-thread-1" },
    );

    expect(events).toEqual([
      {
        type: "turn/started",
        threadId: "",
        providerThreadId: "",
        scope: turnScope(TURN_1),
      },
      {
        type: "turn/input/accepted",
        threadId: "",
        providerThreadId: "",
        scope: turnScope(TURN_1),
        clientRequestId: "creq_23456789af",
      },
      {
        type: "turn/completed",
        threadId: "",
        providerThreadId: "",
        scope: turnScope(TURN_1),
        status: "completed",
      },
    ]);
  });

  it("maps a conversation reset and settles its zero-work turn", () => {
    const harness = createClaudeDeltaHarness();
    harness.acceptInput("creq_23456789af", "bb-thread-1");

    const resetEvents = harness.translate(
      {
        type: "conversation_reset",
        session_id: "claude-session-1",
      },
      { threadId: "bb-thread-1" },
    );

    expect(resetEvents.map((event) => event.type)).toEqual([
      "turn/started",
      "turn/input/accepted",
      "thread/context/cleared",
    ]);
    expect(resetEvents).toContainEqual({
      type: "thread/context/cleared",
      threadId: "",
      providerThreadId: "",
      scope: turnScope(TURN_1),
    });

    const resultEvents = harness.translate(
      {
        type: "result",
        subtype: "success",
        is_error: false,
        num_turns: 0,
        result: "",
        session_id: "claude-session-1",
      },
      { threadId: "bb-thread-1" },
    );

    expect(resultEvents.map((event) => event.type)).toEqual(["turn/completed"]);
    expect(resultEvents).toContainEqual(
      expect.objectContaining({
        type: "turn/completed",
        scope: turnScope(TURN_1),
        status: "completed",
      }),
    );
  });

  it("does not let a recovered task notification settle pending human input", () => {
    const harness = createClaudeDeltaHarness();
    harness.acceptInput("creq_23456789af", "bb-thread-1");

    expect(
      harness.translate(
        {
          type: "result",
          subtype: "success",
          is_error: false,
          num_turns: 0,
          result: "",
          origin: { kind: "task-notification" },
          session_id: "claude-session-1",
        },
        { threadId: "bb-thread-1" },
      ),
    ).toEqual([]);

    const assistantEvents = harness.translate(
      {
        type: "assistant",
        message: {
          id: "human-response",
          role: "assistant",
          content: [{ type: "text", text: "I am working on it." }],
        },
        session_id: "claude-session-1",
      },
      { threadId: "bb-thread-1" },
    );

    expect(assistantEvents).toContainEqual(
      expect.objectContaining({
        type: "turn/input/accepted",
        scope: turnScope(TURN_1),
        clientRequestId: "creq_23456789af",
      }),
    );
    expect(assistantEvents).toContainEqual(
      expect.objectContaining({
        type: "item/completed",
        scope: turnScope(TURN_1),
        item: expect.objectContaining({ text: "I am working on it." }),
      }),
    );

    expect(
      harness.translate(
        {
          type: "result",
          subtype: "success",
          is_error: false,
          origin: { kind: "human" },
          session_id: "claude-session-1",
        },
        { threadId: "bb-thread-1" },
      ),
    ).toContainEqual(
      expect.objectContaining({
        type: "turn/completed",
        scope: turnScope(TURN_1),
        status: "completed",
      }),
    );
  });

  it("ignores a trailing result once the turn has closed", () => {
    const harness = createClaudeDeltaHarness();
    harness.acceptInput("creq_23456789af", "bb-thread-1");
    harness.translate(
      {
        type: "assistant",
        message: {
          id: "msg-1",
          role: "assistant",
          content: [{ type: "text", text: "Hello world" }],
        },
        session_id: "claude-session-1",
      },
      { threadId: "bb-thread-1" },
    );

    harness.translate(
      { type: "result", subtype: "success", session_id: "claude-session-1" },
      { threadId: "bb-thread-1" },
    );

    expect(
      harness.translate(
        { type: "result", subtype: "success", session_id: "claude-session-1" },
        { threadId: "bb-thread-1" },
      ),
    ).toEqual([]);
  });

  it("completes a pending turn for wrapped Claude synthetic no-response messages", () => {
    const harness = createClaudeDeltaHarness();
    harness.acceptInput("creq_23456789af", "bb-thread-1");

    const events = harness.translate(
      {
        jsonrpc: "2.0",
        method: "sdk/message",
        params: {
          threadId: "bb-thread-1",
          message: {
            type: "assistant",
            message: {
              role: "assistant",
              content: [{ type: "text", text: "No response requested." }],
              model: "<synthetic>",
              stop_reason: "stop_sequence",
              stop_sequence: "",
              usage: {
                input_tokens: 0,
                cache_creation_input_tokens: 0,
                cache_read_input_tokens: 0,
                output_tokens: 0,
              },
            },
            session_id: "claude-session-1",
          },
        },
      },
      { threadId: "bb-thread-1" },
    );

    expect(events).toEqual([
      {
        type: "turn/started",
        threadId: "",
        providerThreadId: "",
        scope: turnScope(TURN_1),
      },
      {
        type: "turn/input/accepted",
        threadId: "",
        providerThreadId: "",
        scope: turnScope(TURN_1),
        clientRequestId: "creq_23456789af",
      },
      {
        type: "turn/completed",
        threadId: "",
        providerThreadId: "",
        scope: turnScope(TURN_1),
        status: "completed",
      },
    ]);
  });

  it("does not treat Claude synthetic assistant errors as no-response messages", () => {
    const harness = createClaudeDeltaHarness();

    const events = harness.translate(
      {
        type: "assistant",
        error: "rate_limit",
        isApiErrorMessage: true,
        apiErrorStatus: 429,
        message: {
          role: "assistant",
          content: [
            {
              type: "text",
              text: "API Error: Server is temporarily limiting requests.",
            },
          ],
          model: "<synthetic>",
          stop_reason: "stop_sequence",
          stop_sequence: "",
          usage: {
            input_tokens: 0,
            cache_creation_input_tokens: 0,
            cache_read_input_tokens: 0,
            output_tokens: 0,
          },
        },
        session_id: "claude-session-1",
      },
      { threadId: "bb-thread-1" },
    );

    expect(events).toContainEqual(
      expect.objectContaining({
        type: "item/completed",
        item: expect.objectContaining({
          type: "agentMessage",
          text: "API Error: Server is temporarily limiting requests.",
        }),
      }),
    );
    expect(events).not.toContainEqual(
      expect.objectContaining({
        type: "turn/completed",
      }),
    );
  });

  it("completes an open turn for Claude synthetic no-response messages", () => {
    const harness = createClaudeDeltaHarness();

    harness.translate(
      {
        type: "stream_event",
        event: {
          type: "content_block_delta",
          index: 0,
          delta: { type: "text_delta", text: "Starting" },
        },
        session_id: "claude-session-1",
      },
      { threadId: "bb-thread-1" },
    );

    const events = harness.translate(
      {
        type: "assistant",
        message: {
          role: "assistant",
          content: [{ type: "text", text: "No response requested." }],
          model: "<synthetic>",
          stop_reason: "stop_sequence",
          stop_sequence: "",
          usage: {
            input_tokens: 0,
            cache_creation_input_tokens: 0,
            cache_read_input_tokens: 0,
            output_tokens: 0,
          },
        },
        session_id: "claude-session-1",
      },
      { threadId: "bb-thread-1" },
    );

    expect(events).toEqual([
      {
        type: "turn/completed",
        threadId: "",
        providerThreadId: "",
        scope: turnScope(TURN_1),
        status: "completed",
      },
    ]);
  });

  it("keeps an open turn for synthetic no-response messages while an agent is running", () => {
    const harness = createClaudeDeltaHarness();
    const context = { threadId: "bb-thread-1" };
    harness.translate(
      spawningToolUseFor(loadFixture("task-started-subagent.json")),
      context,
    );
    harness.translate(loadFixture("task-started-subagent.json"), context);

    const events = harness.translate(
      {
        type: "assistant",
        message: {
          role: "assistant",
          content: [{ type: "text", text: "No response requested." }],
          model: "<synthetic>",
          stop_reason: "stop_sequence",
          stop_sequence: "",
          usage: {
            input_tokens: 0,
            cache_creation_input_tokens: 0,
            cache_read_input_tokens: 0,
            output_tokens: 0,
          },
        },
        session_id: "claude-session-1",
      },
      context,
    );

    expect(events).toEqual([]);
    harness.translate(loadFixture("task-notification-subagent.json"), context);
    const finalEvents = harness.translate(
      {
        type: "result",
        subtype: "end_turn",
        session_id: "claude-session-1",
      },
      context,
    );
    expect(finalEvents).toContainEqual(
      expect.objectContaining({
        type: "turn/completed",
        scope: turnScope(TURN_1),
        status: "completed",
      }),
    );
  });
});

describe("claude streaming", () => {
  it("emits item/agentMessage/delta for stream text", () => {
    const harness = createClaudeDeltaHarness();
    harness.translate({
      type: "assistant",
      message: { role: "assistant", content: [{ type: "text", text: "x" }] },
      session_id: "sess-1",
    });

    const events = harness.translate({
      type: "stream_event",
      event: {
        type: "content_block_delta",
        index: 0,
        delta: { type: "text_delta", text: "streaming..." },
      },
      session_id: "sess-1",
    });

    expect(events).toContainEqual(
      expect.objectContaining({
        type: "item/agentMessage/delta",
        itemId: expect.stringMatching(ITEM_ID_PATTERN),
        delta: "streaming...",
      }),
    );
  });

  it("reuses the streamed assistant item id when the final assistant arrives", () => {
    const harness = createClaudeDeltaHarness();

    const deltaEvents = harness.translate({
      type: "stream_event",
      event: {
        type: "content_block_delta",
        index: 0,
        delta: { type: "text_delta", text: "PONG" },
      },
      session_id: "sess-1",
    });
    const deltaEvent = deltaEvents.find(
      (
        event,
      ): event is Extract<
        (typeof deltaEvents)[number],
        { type: "item/agentMessage/delta" }
      > => event.type === "item/agentMessage/delta",
    );

    const assistantEvents = harness.translate({
      type: "assistant",
      message: {
        id: "provider-msg-1",
        role: "assistant",
        content: [{ type: "text", text: "PONG" }],
      },
      session_id: "sess-1",
    });

    expect(deltaEvent?.itemId).toMatch(ITEM_ID_PATTERN);
    expect(assistantEvents).toContainEqual(
      expect.objectContaining({
        type: "item/completed",
        item: expect.objectContaining({
          type: "agentMessage",
          id: deltaEvent?.itemId,
          text: "PONG",
        }),
      }),
    );
  });

  it("starts a turn when stream text arrives before the assistant envelope", () => {
    const harness = createClaudeDeltaHarness();

    const events = harness.translate({
      type: "stream_event",
      event: {
        type: "content_block_delta",
        index: 0,
        delta: { type: "text_delta", text: "PONG" },
      },
      session_id: "sess-1",
    });

    expect(events).toContainEqual(
      expect.objectContaining({
        type: "turn/started",
        scope: turnScope(TURN_1),
      }),
    );
    expect(events).toContainEqual(
      expect.objectContaining({
        type: "item/started",
        scope: turnScope(TURN_1),
        item: expect.objectContaining({
          type: "agentMessage",
          id: expect.stringMatching(ITEM_ID_PATTERN),
        }),
      }),
    );
    expect(events).toContainEqual(
      expect.objectContaining({
        type: "item/agentMessage/delta",
        itemId: expect.stringMatching(ITEM_ID_PATTERN),
        scope: turnScope(TURN_1),
        delta: "PONG",
      }),
    );
  });

  it("settles a partially streamed assistant message when interrupted", () => {
    const harness = createClaudeDeltaHarness();

    const deltaEvents = harness.translate({
      type: "stream_event",
      event: {
        type: "content_block_delta",
        index: 0,
        delta: { type: "text_delta", text: "partial answer" },
      },
      session_id: "sess-1",
    });
    const started = deltaEvents.find(
      (event) =>
        event.type === "item/started" && event.item.type === "agentMessage",
    );

    const settled = harness.settleSession();

    expect(started).toMatchObject({
      type: "item/started",
      item: {
        type: "agentMessage",
        id: expect.stringMatching(ITEM_ID_PATTERN),
      },
    });
    expect(settled).toEqual([
      expect.objectContaining({
        type: "item/completed",
        item: expect.objectContaining({
          type: "agentMessage",
          id: started?.type === "item/started" ? started.item.id : "",
          text: "partial answer",
        }),
      }),
      expect.objectContaining({
        type: "turn/completed",
        status: "interrupted",
      }),
    ]);
  });

  it("streams thinking and finalizes it on the assistant message", () => {
    const harness = createClaudeDeltaHarness();

    const deltaEvents = harness.translate({
      type: "stream_event",
      event: {
        type: "content_block_delta",
        index: 0,
        delta: {
          type: "thinking_delta",
          thinking: "Let me inspect this first.",
        },
      },
      session_id: "sess-1",
    });
    const reasoningDelta = deltaEvents.find(
      (
        event,
      ): event is Extract<
        (typeof deltaEvents)[number],
        { type: "item/reasoning/textDelta" }
      > => event.type === "item/reasoning/textDelta",
    );

    const assistantEvents = harness.translate({
      type: "assistant",
      message: {
        role: "assistant",
        content: [
          {
            type: "thinking",
            thinking: "Let me inspect this first.",
          },
        ],
      },
      session_id: "sess-1",
    });

    expect(reasoningDelta?.itemId).toMatch(ITEM_ID_PATTERN);
    expect(deltaEvents).toContainEqual(
      expect.objectContaining({
        type: "item/started",
        item: expect.objectContaining({
          type: "reasoning",
          id: reasoningDelta?.itemId,
        }),
      }),
    );
    expect(assistantEvents).toContainEqual(
      expect.objectContaining({
        type: "item/completed",
        item: expect.objectContaining({
          type: "reasoning",
          id: reasoningDelta?.itemId,
          content: ["Let me inspect this first."],
        }),
      }),
    );
  });
});

describe("claude unhandled and ignored events", () => {
  it("falls back to provider/unhandled for unknown sdk envelopes", () => {
    const harness = createClaudeDeltaHarness();

    const events = harness.translate({
      jsonrpc: "2.0",
      method: "sdk/message",
      params: {
        threadId: "bb-thread-1",
        message: {
          type: "custom_event",
        },
      },
    });

    expect(events).toEqual([
      expect.objectContaining({
        type: "provider/unhandled",
        providerId: "claude-code",
        rawType: "sdk/custom_event",
        scope: threadScope(),
        rawEvent: expect.objectContaining({
          method: "sdk/message",
        }),
      }),
    ]);
  });

  it("ignores sdk user text echoes", () => {
    const harness = createClaudeDeltaHarness();

    const events = harness.translate({
      jsonrpc: "2.0",
      method: "sdk/message",
      params: {
        threadId: "bb-thread-1",
        message: {
          type: "user",
          message: {
            role: "user",
            content: [
              {
                type: "text",
                text: "This session is being continued from a previous conversation.",
              },
            ],
          },
          parent_tool_use_id: null,
          session_id: "sess-1",
          uuid: "user-message-1",
          timestamp: "2026-05-03T07:53:31.543Z",
          isSynthetic: true,
        },
      },
    });

    expect(events).toEqual([]);
  });

  it("ignores sdk stream ping keepalives", () => {
    const harness = createClaudeDeltaHarness();

    const events = harness.translate({
      jsonrpc: "2.0",
      method: "sdk/message",
      params: {
        threadId: "bb-thread-1",
        message: {
          type: "stream_event",
          event: {
            type: "ping",
          },
          session_id: "sess-1",
          parent_tool_use_id: null,
          uuid: "stream-ping-1",
        },
      },
    });

    expect(events).toEqual([]);
  });

  it("preserves the active turn on unknown sdk envelopes", () => {
    const harness = createClaudeDeltaHarness();

    harness.translate(
      {
        type: "assistant",
        message: {
          role: "assistant",
          content: [{ type: "text", text: "Working on it." }],
        },
        session_id: "sess-1",
      },
      { threadId: "bb-thread-1" },
    );

    const events = harness.translate(
      {
        jsonrpc: "2.0",
        method: "sdk/message",
        params: {
          threadId: "bb-thread-1",
          message: {
            type: "custom_event",
          },
        },
      },
      { threadId: "bb-thread-1" },
    );

    expect(events).toEqual([
      expect.objectContaining({
        type: "provider/unhandled",
        scope: turnScope(TURN_1),
        rawType: "sdk/custom_event",
      }),
    ]);
  });

  it("surfaces malformed handled sdk envelopes as provider/unhandled", () => {
    const harness = createClaudeDeltaHarness();

    const events = harness.translate({
      jsonrpc: "2.0",
      method: "sdk/message",
      params: {
        threadId: "claude-thread-1",
        message: {
          type: "result",
        },
      },
    });

    expect(events).toEqual([
      expect.objectContaining({
        type: "provider/unhandled",
        providerId: "claude-code",
        rawType: "sdk/result",
        scope: threadScope(),
        rawEvent: expect.objectContaining({
          method: "sdk/message",
        }),
      }),
    ]);
  });

  it("ignores task-updated system events from the SDK envelope", () => {
    const harness = createClaudeDeltaHarness();

    const events = harness.translate({
      jsonrpc: "2.0",
      method: "sdk/message",
      params: {
        threadId: "claude-thread-1",
        message: {
          type: "system",
          subtype: "task_updated",
          task_id: "task-1",
          patch: {
            is_backgrounded: true,
          },
        },
      },
    });

    expect(events).toMatchObject([]);
  });

  it("ignores thinking-token system events from the SDK envelope", () => {
    const harness = createClaudeDeltaHarness();

    const events = harness.translate({
      jsonrpc: "2.0",
      method: "sdk/message",
      params: {
        threadId: "claude-thread-1",
        message: {
          type: "system",
          subtype: "thinking_tokens",
          estimated_tokens: 24,
          estimated_tokens_delta: 23,
          uuid: "message-1",
          session_id: "session-1",
        },
      },
    });

    expect(events).toMatchObject([]);
  });

  it("ignores async hook lifecycle system events from the SDK envelope", () => {
    const harness = createClaudeDeltaHarness();

    for (const subtype of [
      "hook_started",
      "hook_progress",
      "hook_response",
      "commands_changed",
    ] as const) {
      const events = harness.translate({
        jsonrpc: "2.0",
        method: "sdk/message",
        params: {
          threadId: "claude-thread-1",
          message: {
            type: "system",
            subtype,
            hook_name: "SessionStart:startup",
            hook_event: "SessionStart",
            uuid: "message-1",
            session_id: "session-1",
          },
        },
      });

      expect(events).toMatchObject([]);
    }
  });

  it("returns empty for non-compaction system messages", () => {
    const harness = createClaudeDeltaHarness();
    const events = harness.translate({
      type: "system",
      subtype: "init",
      session_id: "sess-1",
    });
    expect(events).toMatchObject([]);
  });

  it("fixture: system-init produces no events", () => {
    const harness = createClaudeDeltaHarness();
    const events = harness.translate(loadFixture("system-init.json"));
    expect(events).toMatchObject([]);
  });

  it("ignores Claude command lifecycle events", () => {
    const harness = createClaudeDeltaHarness();
    const events = harness.translate({
      jsonrpc: "2.0",
      method: "sdk/message",
      params: {
        threadId: "thread-1",
        message: {
          type: "command_lifecycle",
          command_uuid: "command-1",
          state: "started",
          uuid: "message-1",
          session_id: "session-1",
        },
      },
    });

    expect(events).toEqual([]);
  });
});

describe("claude warnings and identity", () => {
  it("surfaces automatic permission denials as warnings", () => {
    const harness = createClaudeDeltaHarness();

    const events = harness.translate({
      jsonrpc: "2.0",
      method: "sdk/message",
      params: {
        threadId: "claude-thread-1",
        message: {
          type: "system",
          subtype: "permission_denied",
          tool_name: "Bash",
          tool_use_id: "tool-1",
          decision_reason_type: "classifier",
          decision_reason: "The command is too risky to approve automatically.",
          message: "Permission denied",
          uuid: "message-1",
          session_id: "session-1",
        },
      },
    });

    expect(events).toEqual([
      expect.objectContaining({
        type: "provider/warning",
        category: "general",
        summary: "Bash was denied automatically",
        details:
          "The command is too risky to approve automatically. (classifier)",
      }),
    ]);
    expect(events.some((event) => event.type === "provider/unhandled")).toBe(
      false,
    );
  });

  it("maps thread identity envelopes", () => {
    const harness = createClaudeDeltaHarness();

    const events = harness.translate({
      jsonrpc: "2.0",
      method: "thread/identity",
      params: {
        threadId: "bb-thread-1",
        providerThreadId: "claude-thread-1",
      },
    });

    expect(events).toEqual([
      {
        type: "thread/identity",
        threadId: "",
        providerThreadId: "claude-thread-1",
        scope: threadScope(),
      },
    ]);
  });

  it("tracks the open turn for the bridge's interaction gate", () => {
    const harness = createClaudeDeltaHarness();
    expect(harness.translator.hasOpenTurn("thr_1")).toBe(false);
    harness.translate(
      {
        type: "assistant",
        message: { role: "assistant", content: [{ type: "text", text: "x" }] },
        session_id: "sess-1",
      },
      { threadId: "thr_1" },
    );
    expect(harness.translator.hasOpenTurn("thr_1")).toBe(true);
    harness.translate(
      { type: "result", subtype: "end_turn", session_id: "sess-1" },
      { threadId: "thr_1" },
    );
    expect(harness.translator.hasOpenTurn("thr_1")).toBe(false);
  });
});

describe("claude model refusals", () => {
  it("normalizes Claude model refusal fallbacks", () => {
    const harness = createClaudeDeltaHarness();
    const events = harness.translate({
      type: "system",
      subtype: "model_refusal_fallback",
      original_model: "claude-fable-5",
      fallback_model: "claude-opus-4-8",
      content: "Fable refused this request. Switched to Opus.",
      session_id: "sess-1",
    });

    expect(events).toEqual([
      expect.objectContaining({
        type: "provider/modelFallback",
        scope: threadScope(),
        originalModel: "claude-fable-5",
        fallbackModel: "claude-opus-4-8",
        reason: "refusal",
        message: "Fable refused this request. Switched to Opus.",
      }),
    ]);
  });

  it("emits the early assistant fallback block and deduplicates the later system event", () => {
    const harness = createClaudeDeltaHarness();
    const earlyEvents = harness.translate({
      type: "assistant",
      message: {
        role: "assistant",
        model: "claude-opus-4-8",
        content: [
          {
            type: "fallback",
            from: { model: "claude-fable-5" },
            to: { model: "claude-opus-4-8" },
          },
        ],
      },
      session_id: "sess-1",
    });

    expect(earlyEvents).toEqual([
      expect.objectContaining({
        type: "turn/started",
        scope: turnScope(TURN_1),
      }),
      expect.objectContaining({
        type: "provider/modelFallback",
        scope: turnScope(TURN_1),
        originalModel: "claude-fable-5",
        fallbackModel: "claude-opus-4-8",
        reason: "provider",
        message: "Switched from claude-fable-5 to claude-opus-4-8.",
      }),
    ]);

    const detailedEvents = harness.translate({
      type: "system",
      subtype: "model_refusal_fallback",
      original_model: "claude-fable-5",
      fallback_model: "claude-opus-4-8",
      content: "Fable refused this request. Switched to Opus.",
      session_id: "sess-1",
    });

    expect(detailedEvents).toEqual([]);
  });

  it("surfaces refusal without fallback as a warning", () => {
    const harness = createClaudeDeltaHarness();
    const events = harness.translate({
      type: "system",
      subtype: "model_refusal_no_fallback",
      content: "The model refused and no fallback was configured.",
      session_id: "sess-1",
    });

    expect(events).toEqual([
      expect.objectContaining({
        type: "provider/warning",
        category: "general",
        summary: "Model refused the request",
        details: "The model refused and no fallback was configured.",
      }),
    ]);
  });
});

describe("claude compaction", () => {
  it("status compacting starts a turn and emits a compaction item", () => {
    const harness = createClaudeDeltaHarness();
    const events = harness.translate({
      type: "system",
      subtype: "status",
      status: "compacting",
      session_id: "sess-1",
    });

    expect(events).toContainEqual(
      expect.objectContaining({
        type: "turn/started",
        threadId: "",
        providerThreadId: "",
        scope: turnScope(TURN_1),
      }),
    );
    expect(events).toContainEqual(
      expect.objectContaining({
        type: "item/started",
        threadId: "",
        providerThreadId: "",
        scope: turnScope(TURN_1),
        item: {
          type: "contextCompaction",
          id: expect.stringMatching(ITEM_ID_PATTERN),
          presentation: {
            label: {
              pending: "Compacting context",
              completed: "Compacted context",
            },
            icon: { glyph: "Archive" },
          },
        },
      }),
    );
  });

  it("status null completes the open compaction item", () => {
    const harness = createClaudeDeltaHarness();
    const started = harness.translate({
      type: "system",
      subtype: "status",
      status: "compacting",
      session_id: "sess-1",
    });
    const startedItem = started.find((event) => event.type === "item/started");

    const events = harness.translate({
      type: "system",
      subtype: "status",
      status: null,
      session_id: "sess-1",
    });

    expect(events).toContainEqual(
      expect.objectContaining({
        type: "item/completed",
        scope: turnScope(TURN_1),
        item: {
          type: "contextCompaction",
          id: startedItem?.item.id,
          presentation: {
            label: {
              pending: "Compacting context",
              completed: "Compacted context",
            },
            icon: { glyph: "Archive" },
          },
        },
      }),
    );
  });

  it("status null after the compaction turn ended emits nothing", () => {
    const harness = createClaudeDeltaHarness();
    harness.translate({
      type: "system",
      subtype: "status",
      status: "compacting",
      session_id: "sess-1",
    });
    harness.translate({
      type: "result",
      subtype: "end_turn",
      session_id: "sess-1",
    });

    const events = harness.translate({
      type: "system",
      subtype: "status",
      status: null,
      session_id: "sess-1",
    });

    expect(
      events.filter((event) => event.type === "item/completed"),
    ).toHaveLength(0);
  });

  it("compact_boundary emits thread/compacted", () => {
    const harness = createClaudeDeltaHarness();

    harness.translate({
      type: "system",
      subtype: "status",
      status: "compacting",
      session_id: "sess-1",
    });

    const events = harness.translate({
      type: "system",
      subtype: "compact_boundary",
      session_id: "sess-1",
      compact_metadata: {
        pre_tokens: 199622,
        trigger: "auto",
      },
    });

    expect(events).toContainEqual(
      expect.objectContaining({
        type: "thread/compacted",
        threadId: "",
        providerThreadId: "",
        scope: turnScope(TURN_1),
      }),
    );
  });

  it("compact_boundary without a known turn is unhandled", () => {
    const harness = createClaudeDeltaHarness();

    const events = harness.translate({
      type: "system",
      subtype: "compact_boundary",
      session_id: "sess-1",
    });

    expect(events).toContainEqual(
      expect.objectContaining({
        type: "provider/unhandled",
      }),
    );
  });
});

describe("claude error translation", () => {
  it("maps error envelopes", () => {
    const harness = createClaudeDeltaHarness();

    const events = harness.translate({
      jsonrpc: "2.0",
      method: "error",
      params: {
        message: "bridge failed",
      },
    });

    expect(events).toEqual([
      {
        type: "provider/error",
        threadId: "",
        providerThreadId: "",
        scope: threadScope(),
        message: "Provider error",
        detail: "bridge failed",
      },
    ]);
  });

  it("completes a failed turn for thread-scoped bridge errors", () => {
    const harness = createClaudeDeltaHarness();

    const events = harness.translate(
      {
        jsonrpc: "2.0",
        method: "error",
        params: {
          message: "Claude auth expired",
        },
      },
      { threadId: "bb-thread-1" },
    );

    expect(events).toEqual([
      {
        type: "turn/started",
        threadId: "",
        providerThreadId: "",
        scope: turnScope(TURN_1),
      },
      {
        type: "provider/error",
        threadId: "",
        providerThreadId: "",
        scope: turnScope(TURN_1),
        message: "Provider error",
        detail: "Claude auth expired",
      },
      {
        type: "turn/completed",
        threadId: "",
        providerThreadId: "",
        scope: turnScope(TURN_1),
        status: "failed",
      },
    ]);
  });

  it("marks Claude result events with is_error as failed", () => {
    const harness = createClaudeDeltaHarness();

    harness.translate({
      jsonrpc: "2.0",
      method: "sdk/message",
      params: {
        threadId: "claude-thread-1",
        message: {
          type: "assistant",
          message: {
            id: "assistant-1",
            content: [
              {
                type: "text",
                text: 'API Error: 529 {"type":"error","error":{"type":"overloaded_error","message":"Overloaded. https://docs.claude.com/en/api/errors"},"request_id":"req_123"}',
              },
            ],
          },
        },
      },
    });

    const events = harness.translate({
      jsonrpc: "2.0",
      method: "sdk/message",
      params: {
        threadId: "claude-thread-1",
        message: {
          type: "result",
          subtype: "success",
          is_error: true,
          api_error_status: 529,
          result:
            'API Error: 529 {"type":"error","error":{"type":"overloaded_error","message":"Overloaded. https://docs.claude.com/en/api/errors"},"request_id":"req_123"}',
          usage: {},
          modelUsage: {},
        },
      },
    });

    expect(events).toContainEqual(
      expect.objectContaining({
        type: "turn/completed",
        scope: turnScope(TURN_1),
        status: "failed",
      }),
    );
    expect(events).toContainEqual(
      expect.objectContaining({
        type: "provider/error",
        message: "Provider error",
        errorInfo: {
          category: "overloaded",
          providerCode: null,
          httpStatusCode: 529,
        },
      }),
    );
  });

  it("maps Claude result error subtypes to provider error info", () => {
    const harness = createClaudeDeltaHarness();

    harness.translate({
      jsonrpc: "2.0",
      method: "sdk/message",
      params: {
        threadId: "claude-thread-1",
        message: {
          type: "assistant",
          message: {
            id: "assistant-1",
            content: [],
          },
        },
      },
    });

    const events = harness.translate({
      jsonrpc: "2.0",
      method: "sdk/message",
      params: {
        threadId: "claude-thread-1",
        message: {
          type: "result",
          subtype: "error_max_budget_usd",
          is_error: true,
          errors: ["Budget limit reached"],
          usage: {},
          modelUsage: {},
        },
      },
    });

    expect(events).toContainEqual(
      expect.objectContaining({
        type: "provider/error",
        scope: turnScope(TURN_1),
        message: "Provider error",
        detail: "Budget limit reached",
        errorInfo: {
          category: "budget-exceeded",
          providerCode: "error_max_budget_usd",
          httpStatusCode: null,
        },
      }),
    );
  });

  it("preserves unknown Claude rate limit window keys", () => {
    const harness = createClaudeDeltaHarness();

    const events = harness.translate({
      jsonrpc: "2.0",
      method: "sdk/message",
      params: {
        threadId: "claude-thread-1",
        message: {
          type: "rate_limit_event",
          rate_limit_info: {
            status: "allowed",
            rateLimitType: "seven_day_fable",
            overageStatus: "rejected",
            overageDisabledReason: "out_of_credits",
          },
        },
      },
    });

    expect(events).toEqual([
      expect.objectContaining({
        type: "provider/rateLimits/updated",
        scope: threadScope(),
        rateLimits: expect.objectContaining({
          providerId: "claude-code",
          status: "allowed",
          windows: [
            expect.objectContaining({
              providerKey: "seven_day_fable",
              label: null,
            }),
          ],
        }),
      }),
    ]);
  });

  it("keeps overage-covered rejections nonterminal", () => {
    const harness = createClaudeDeltaHarness();

    const events = harness.translate({
      jsonrpc: "2.0",
      method: "sdk/message",
      params: {
        threadId: "claude-thread-1",
        message: {
          type: "rate_limit_event",
          rate_limit_info: {
            status: "rejected",
            rateLimitType: "five_hour",
            resetsAt: 1781120400,
            overageStatus: "allowed",
          },
        },
      },
    });

    expect(events).toEqual([
      expect.objectContaining({
        type: "provider/rateLimits/updated",
        rateLimits: expect.objectContaining({
          status: "allowed",
          overageStatus: "allowed",
          windows: [
            expect.objectContaining({
              providerKey: "five_hour",
              status: "blocked",
              resetsAtMs: 1_781_120_400_000,
            }),
          ],
        }),
      }),
    ]);
  });
});
