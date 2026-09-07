import { describe, expect, it } from "vitest";
import { turnScope } from "@bb/domain";
import {
  TURN_1,
  createClaudeDeltaHarness,
  loadFixture,
} from "./delta-test-harness.js";

describe("claude usage and fixture translation (delta path)", () => {
  it("fixture: assistant-text produces turn/started + item/completed agentMessage", () => {
    const harness = createClaudeDeltaHarness();
    const events = harness.translate(loadFixture("assistant-text.json"));

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
          text: expect.stringContaining("refactor that function"),
        }),
      }),
    );
  });

  it("fixture: assistant-tool-use produces agentMessage + commandExecution item", () => {
    const harness = createClaudeDeltaHarness();
    const events = harness.translate(loadFixture("assistant-tool-use.json"));

    expect(events).toContainEqual(
      expect.objectContaining({ type: "turn/started" }),
    );
    expect(events).toContainEqual(
      expect.objectContaining({
        type: "item/completed",
        item: expect.objectContaining({ type: "agentMessage" }),
      }),
    );
    expect(events).toContainEqual(
      expect.objectContaining({
        type: "item/started",
        item: expect.objectContaining({
          type: "commandExecution",
          id: harness.itemId("toolu_01AbCdEfGhIjKlMnOpQrStUv"),
          command: "ls -la src/",
          status: "pending",
        }),
      }),
    );
  });

  it("fixture: assistant-file-edit produces fileChange item", () => {
    const harness = createClaudeDeltaHarness();
    const events = harness.translate(loadFixture("assistant-file-edit.json"));

    expect(events).toContainEqual(
      expect.objectContaining({
        type: "item/started",
        item: expect.objectContaining({
          type: "fileChange",
          status: "pending",
          changes: [
            expect.objectContaining({
              path: "/Users/developer/project/src/utils/format.ts",
              diff: expect.stringContaining("toLocaleDateString"),
            }),
          ],
        }),
      }),
    );
  });

  it("fixture: stream-text-delta produces agentMessage delta", () => {
    const harness = createClaudeDeltaHarness();
    harness.translate(loadFixture("assistant-text.json"));

    const events = harness.translate(loadFixture("stream-text-delta.json"));

    expect(events).toContainEqual(
      expect.objectContaining({
        type: "item/started",
        item: expect.objectContaining({ type: "agentMessage" }),
      }),
    );
    expect(events).toContainEqual(
      expect.objectContaining({
        type: "item/agentMessage/delta",
        delta: expect.any(String),
      }),
    );
  });

  it("fixture: user-tool-result produces commandExecution completed", () => {
    const harness = createClaudeDeltaHarness();
    harness.translate(loadFixture("assistant-text.json"));

    const events = harness.translate(loadFixture("user-tool-result.json"));

    expect(events).toContainEqual(
      expect.objectContaining({
        type: "item/completed",
        item: expect.objectContaining({
          type: "commandExecution",
          status: "completed",
        }),
      }),
    );
  });

  it("fixture: user-tool-result-generic produces toolCall completed", () => {
    const harness = createClaudeDeltaHarness();
    harness.translate(loadFixture("assistant-text.json"));

    const events = harness.translate(
      loadFixture("user-tool-result-generic.json"),
    );

    expect(events).toContainEqual(
      expect.objectContaining({
        type: "item/completed",
        item: expect.objectContaining({
          type: "toolCall",
          status: "completed",
        }),
      }),
    );
  });

  it("fixture: result-success produces request context usage, token usage, and turn/completed", () => {
    const harness = createClaudeDeltaHarness();
    harness.translate(loadFixture("assistant-text.json"));

    const events = harness.translate(loadFixture("result-success.json"));

    expect(events).toContainEqual(
      expect.objectContaining({
        type: "thread/tokenUsage/updated",
        tokenUsage: expect.objectContaining({
          total: expect.objectContaining({
            inputTokens: 8420,
            outputTokens: 1253,
          }),
          modelContextWindow: 200000,
        }),
      }),
    );
    expect(events).toContainEqual(
      expect.objectContaining({
        type: "thread/contextWindowUsage/updated",
        contextWindowUsage: {
          usedTokens: 2_723,
          modelContextWindow: 200000,
          estimated: true,
        },
      }),
    );
    expect(events).toContainEqual(
      expect.objectContaining({
        type: "turn/completed",
        scope: turnScope(TURN_1),
        status: "completed",
      }),
    );
  });

  it("uses the latest Claude request context for context-window usage while keeping aggregate token usage", () => {
    const harness = createClaudeDeltaHarness();

    harness.translate({
      type: "assistant",
      message: {
        type: "message",
        role: "assistant",
        content: [],
        usage: {
          input_tokens: 1,
          cache_read_input_tokens: 49_000,
          cache_creation_input_tokens: 999,
          output_tokens: 120,
        },
      },
    });
    harness.translate({
      type: "assistant",
      message: {
        type: "message",
        role: "assistant",
        content: [],
        usage: {
          input_tokens: 1,
          cache_read_input_tokens: 51_908,
          cache_creation_input_tokens: 300,
          output_tokens: 164,
        },
      },
    });

    const events = harness.translate({
      type: "result",
      subtype: "success",
      duration_ms: 1,
      duration_api_ms: 1,
      is_error: false,
      num_turns: 1,
      result: "ok",
      stop_reason: "end_turn",
      total_cost_usd: 0,
      usage: {
        input_tokens: 16,
        cache_read_input_tokens: 704_436,
        cache_creation_input_tokens: 0,
        output_tokens: 2_544,
      },
      modelUsage: {
        "claude-opus-4-7": {
          contextWindow: 1_000_000,
        },
      },
      session_id: "session-1",
    });

    expect(events).toContainEqual(
      expect.objectContaining({
        type: "thread/tokenUsage/updated",
        tokenUsage: expect.objectContaining({
          last: expect.objectContaining({
            totalTokens: 706_996,
            inputTokens: 16,
            cachedInputTokens: 704_436,
            outputTokens: 2_544,
          }),
        }),
      }),
    );
    expect(events).toContainEqual(
      expect.objectContaining({
        type: "thread/contextWindowUsage/updated",
        contextWindowUsage: {
          usedTokens: 52_209,
          modelContextWindow: 1_000_000,
          estimated: true,
        },
      }),
    );
  });

  it("clears the latest Claude request context when a non-assistant event starts the next turn", () => {
    const harness = createClaudeDeltaHarness();

    harness.translate(loadFixture("assistant-text.json"), {
      threadId: "bb-thread-1",
    });
    harness.translate(loadFixture("result-success.json"), {
      threadId: "bb-thread-1",
    });
    harness.translate(
      {
        type: "system",
        subtype: "status",
        status: "compacting",
        session_id: "session-1",
      },
      {
        threadId: "bb-thread-1",
      },
    );

    const events = harness.translate(
      {
        type: "result",
        subtype: "success",
        duration_ms: 1,
        duration_api_ms: 1,
        is_error: false,
        num_turns: 1,
        result: "ok",
        stop_reason: "end_turn",
        total_cost_usd: 0,
        usage: {
          input_tokens: 100,
          output_tokens: 20,
          cache_creation_input_tokens: 30,
          cache_read_input_tokens: 40,
        },
        session_id: "session-1",
      },
      {
        threadId: "bb-thread-1",
      },
    );

    expect(events).toContainEqual(
      expect.objectContaining({
        type: "thread/contextWindowUsage/updated",
        contextWindowUsage: {
          usedTokens: null,
          modelContextWindow: 200000,
          estimated: true,
        },
      }),
    );
  });

  it("fixture: result-success accumulates Claude token usage across turns", () => {
    const harness = createClaudeDeltaHarness();

    harness.translate(loadFixture("assistant-text.json"));
    const firstTurnEvents = harness.translate(
      loadFixture("result-success.json"),
    );

    harness.translate(loadFixture("assistant-text.json"));
    const secondTurnEvents = harness.translate(
      loadFixture("result-success.json"),
    );

    const firstTokenUsage = firstTurnEvents.find(
      (
        event,
      ): event is Extract<
        (typeof firstTurnEvents)[number],
        { type: "thread/tokenUsage/updated" }
      > => event.type === "thread/tokenUsage/updated",
    );
    const secondTokenUsage = secondTurnEvents.find(
      (
        event,
      ): event is Extract<
        (typeof secondTurnEvents)[number],
        { type: "thread/tokenUsage/updated" }
      > => event.type === "thread/tokenUsage/updated",
    );

    expect(firstTokenUsage?.tokenUsage.last).toMatchObject({
      totalTokens: 16685,
      inputTokens: 8420,
      outputTokens: 1253,
      cachedInputTokens: 7012,
    });
    expect(secondTokenUsage?.tokenUsage.total).toMatchObject({
      totalTokens: 33370,
      inputTokens: 16840,
      outputTokens: 2506,
      cachedInputTokens: 14024,
    });
    expect(secondTokenUsage?.tokenUsage.last).toEqual(
      firstTokenUsage?.tokenUsage.last,
    );
  });

  it("falls back to a model-based context window when Claude omits modelUsage.contextWindow", () => {
    const harness = createClaudeDeltaHarness();

    harness.translator.setClaudeModelContextWindowHint(
      "bb-thread-1",
      "claude-opus-4-7[1m]",
    );
    harness.translate(loadFixture("assistant-text.json"), {
      threadId: "bb-thread-1",
    });

    const events = harness.translate(
      {
        type: "result",
        subtype: "success",
        duration_ms: 1,
        duration_api_ms: 1,
        is_error: false,
        num_turns: 1,
        result: "ok",
        stop_reason: "end_turn",
        total_cost_usd: 0,
        usage: {
          input_tokens: 100,
          output_tokens: 20,
          cache_creation_input_tokens: 30,
          cache_read_input_tokens: 40,
        },
        session_id: "session-1",
      },
      {
        threadId: "bb-thread-1",
      },
    );

    expect(events).toContainEqual(
      expect.objectContaining({
        type: "thread/contextWindowUsage/updated",
        contextWindowUsage: {
          usedTokens: 2_723,
          modelContextWindow: 1_000_000,
          estimated: true,
        },
      }),
    );
  });

  it("keeps Claude context-window capacity unknown when no model hint exists", () => {
    const harness = createClaudeDeltaHarness();

    harness.translate(loadFixture("assistant-text.json"), {
      threadId: "bb-thread-unknown",
    });

    const events = harness.translate(
      {
        type: "result",
        subtype: "success",
        duration_ms: 1,
        duration_api_ms: 1,
        is_error: false,
        num_turns: 1,
        result: "ok",
        stop_reason: "end_turn",
        total_cost_usd: 0,
        usage: {
          input_tokens: 100,
          output_tokens: 20,
          cache_creation_input_tokens: 30,
          cache_read_input_tokens: 40,
        },
        session_id: "session-1",
      },
      {
        threadId: "bb-thread-unknown",
      },
    );

    expect(events).toContainEqual(
      expect.objectContaining({
        type: "thread/contextWindowUsage/updated",
        contextWindowUsage: {
          usedTokens: 2_723,
          modelContextWindow: null,
          estimated: true,
        },
      }),
    );
  });

  it("keeps Claude context-window capacity unknown for the ambiguous default model alias", () => {
    const harness = createClaudeDeltaHarness();

    harness.translator.setClaudeModelContextWindowHint(
      "bb-thread-default",
      "default",
    );
    harness.translate(loadFixture("assistant-text.json"), {
      threadId: "bb-thread-default",
    });

    const events = harness.translate(
      {
        type: "result",
        subtype: "success",
        duration_ms: 1,
        duration_api_ms: 1,
        is_error: false,
        num_turns: 1,
        result: "ok",
        stop_reason: "end_turn",
        total_cost_usd: 0,
        usage: {
          input_tokens: 100,
          output_tokens: 20,
          cache_creation_input_tokens: 30,
          cache_read_input_tokens: 40,
        },
        session_id: "session-1",
      },
      {
        threadId: "bb-thread-default",
      },
    );

    expect(events).toContainEqual(
      expect.objectContaining({
        type: "thread/contextWindowUsage/updated",
        contextWindowUsage: {
          usedTokens: 2_723,
          modelContextWindow: null,
          estimated: true,
        },
      }),
    );
  });

  it("reuses the last known Claude context window when a later result omits modelUsage.contextWindow", () => {
    const harness = createClaudeDeltaHarness();

    harness.translate(loadFixture("assistant-text.json"), {
      threadId: "bb-thread-1",
    });
    harness.translate(loadFixture("result-success.json"), {
      threadId: "bb-thread-1",
    });

    harness.translate(loadFixture("assistant-text.json"), {
      threadId: "bb-thread-1",
    });

    const events = harness.translate(
      {
        type: "result",
        subtype: "success",
        duration_ms: 1,
        duration_api_ms: 1,
        is_error: false,
        num_turns: 1,
        result: "ok",
        stop_reason: "end_turn",
        total_cost_usd: 0,
        usage: {
          input_tokens: 100,
          output_tokens: 20,
          cache_creation_input_tokens: 30,
          cache_read_input_tokens: 40,
        },
        session_id: "session-1",
      },
      {
        threadId: "bb-thread-1",
      },
    );

    expect(events).toContainEqual(
      expect.objectContaining({
        type: "thread/contextWindowUsage/updated",
        contextWindowUsage: {
          usedTokens: 2_723,
          modelContextWindow: 200000,
          estimated: true,
        },
      }),
    );
  });
});
