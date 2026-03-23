import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import {
  buildClaudeCodeAvailableModels,
  createClaudeCodeProviderAdapter,
  shouldFetchClaudeCodeModelsFromAnthropic,
} from "./adapter.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const FIXTURES = resolve(__dirname, "../__fixtures__/claude-code");

function loadFixture(name: string): SDKMessage {
  return JSON.parse(readFileSync(resolve(FIXTURES, name), "utf8")) as SDKMessage;
}

describe("claude-code provider adapter", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  // -- Identity & capabilities ---------------------------------------------

  it("has correct identity", () => {
    const adapter = createClaudeCodeProviderAdapter();
    expect(adapter.id).toBe("claude-code");
    expect(adapter.displayName).toBe("Claude Code");
  });

  it("has correct process config", () => {
    const adapter = createClaudeCodeProviderAdapter();
    expect(adapter.process.command).toBe("node");
    expect(adapter.process.args).toHaveLength(1);
    expect(adapter.process.args[0]).toMatch(/bridge\.js$/);
  });

  it("advertises trimmed capabilities", () => {
    const adapter = createClaudeCodeProviderAdapter();
    expect(adapter.capabilities).toEqual({
      supportsRename: false,
      supportsServiceTier: false,
    });
  });

  // -- buildCommand --------------------------------------------------------

  it("buildCommand returns null for thread/name/set (rename unsupported)", () => {
    const adapter = createClaudeCodeProviderAdapter();
    expect(
      adapter.buildCommand({
        type: "thread/name/set",
        threadId: "t1",
        providerThreadId: "p1",
        title: "hi",
      }),
    ).toBeNull();
  });

  it("buildCommand thread/start routes threadId from command", () => {
    const adapter = createClaudeCodeProviderAdapter();
    const cmd = adapter.buildCommand({
      type: "thread/start",
      threadId: "bb-thread-1",
      input: [{ type: "text", text: "hello" }],
    });
    expect(cmd?.params).toMatchObject({ threadId: "bb-thread-1" });
  });

  it("buildCommand thread/resume passes providerThreadId", () => {
    const adapter = createClaudeCodeProviderAdapter();
    const cmd = adapter.buildCommand({
      type: "thread/resume",
      threadId: "bb-thread-1",
      providerThreadId: "claude-session-1",
    });
    expect(cmd?.params).toMatchObject({
      threadId: "bb-thread-1",
      providerThreadId: "claude-session-1",
    });
  });

  it("buildCommand thread/resume uses null for missing providerThreadId", () => {
    const adapter = createClaudeCodeProviderAdapter();
    const cmd = adapter.buildCommand({
      type: "thread/resume",
      threadId: "bb-thread-1",
      providerThreadId: undefined,
    });
    expect(cmd?.params).toMatchObject({
      threadId: "bb-thread-1",
      providerThreadId: null,
    });
  });

  it("buildCommand turn/start includes input and providerThreadId", () => {
    const adapter = createClaudeCodeProviderAdapter();
    const cmd = adapter.buildCommand({
      type: "turn/start",
      threadId: "bb-thread-1",
      providerThreadId: "claude-session-1",
      input: [{ type: "text", text: "follow up" }],
    });
    expect(cmd?.params).toMatchObject({
      threadId: "bb-thread-1",
      providerThreadId: "claude-session-1",
    });
  });

  it("buildCommand turn/steer includes expectedTurnId", () => {
    const adapter = createClaudeCodeProviderAdapter();
    const cmd = adapter.buildCommand({
      type: "turn/steer",
      threadId: "bb-thread-1",
      providerThreadId: "claude-session-1",
      expectedTurnId: "turn-1",
      input: [{ type: "text", text: "steer" }],
    });
    expect(cmd?.params).toMatchObject({
      threadId: "bb-thread-1",
      providerThreadId: "claude-session-1",
      expectedTurnId: "turn-1",
    });
  });

  // -- translateEvent: assistant messages -----------------------------------

  it("translateEvent emits turn/started + item/completed for assistant message", () => {
    const adapter = createClaudeCodeProviderAdapter();
    const events = adapter.translateEvent({
      type: "assistant",
      message: {
        role: "assistant",
        content: [{ type: "text", text: "Hello world" }],
      },
      session_id: "sess-1",
    } as SDKMessage);

    expect(events).toContainEqual(
      expect.objectContaining({ type: "turn/started", turnId: "turn-1" }),
    );
    expect(events).toContainEqual(
      expect.objectContaining({
        type: "item/completed",
        item: expect.objectContaining({ type: "agentMessage", text: "Hello world" }),
      }),
    );
  });

  it("translateEvent emits item/started for tool use blocks", () => {
    const adapter = createClaudeCodeProviderAdapter();
    // First send an assistant message to start a turn
    adapter.translateEvent({
      type: "assistant",
      message: { role: "assistant", content: [{ type: "text", text: "Let me check" }] },
      session_id: "sess-1",
    } as SDKMessage);

    const events = adapter.translateEvent({
      type: "assistant",
      message: {
        role: "assistant",
        content: [
          { type: "tool_use", id: "tool-1", name: "Bash", input: { command: "ls" } },
        ],
      },
      session_id: "sess-1",
    } as SDKMessage);

    expect(events).toContainEqual(
      expect.objectContaining({
        type: "item/started",
        item: expect.objectContaining({
          type: "commandExecution",
          id: "tool-1",
          status: "pending",
        }),
      }),
    );
  });

  // -- translateEvent: stream events ---------------------------------------

  it("translateEvent emits item/agentMessage/delta for stream text", () => {
    const adapter = createClaudeCodeProviderAdapter();
    // Start a turn first
    adapter.translateEvent({
      type: "assistant",
      message: { role: "assistant", content: [{ type: "text", text: "x" }] },
      session_id: "sess-1",
    } as SDKMessage);

    const events = adapter.translateEvent({
      type: "stream_event",
      event: {
        type: "content_block_delta",
        delta: { type: "text_delta", text: "streaming..." },
      },
      session_id: "sess-1",
    } as SDKMessage);

    expect(events).toContainEqual(
      expect.objectContaining({
        type: "item/agentMessage/delta",
        delta: "streaming...",
      }),
    );
  });

  // -- translateEvent: result (turn complete) -------------------------------

  it("translateEvent emits turn/completed on result message", () => {
    const adapter = createClaudeCodeProviderAdapter();
    // Start a turn
    adapter.translateEvent({
      type: "assistant",
      message: { role: "assistant", content: [{ type: "text", text: "done" }] },
      session_id: "sess-1",
    } as SDKMessage);

    const events = adapter.translateEvent({
      type: "result",
      subtype: "end_turn",
      session_id: "sess-1",
    } as unknown as SDKMessage);

    expect(events).toContainEqual(
      expect.objectContaining({
        type: "turn/completed",
        turnId: "turn-1",
        status: "completed",
      }),
    );
  });

  it("translateEvent emits failed status for error result", () => {
    const adapter = createClaudeCodeProviderAdapter();
    // Start a turn
    adapter.translateEvent({
      type: "assistant",
      message: { role: "assistant", content: [{ type: "text", text: "x" }] },
      session_id: "sess-1",
    } as SDKMessage);

    const events = adapter.translateEvent({
      type: "result",
      subtype: "error",
      session_id: "sess-1",
    } as unknown as SDKMessage);

    expect(events).toContainEqual(
      expect.objectContaining({
        type: "turn/completed",
        status: "failed",
      }),
    );
  });

  // -- translateEvent: tool results ----------------------------------------

  it("translateEvent emits item/completed for user tool results", () => {
    const adapter = createClaudeCodeProviderAdapter();
    // Start a turn
    adapter.translateEvent({
      type: "assistant",
      message: { role: "assistant", content: [{ type: "text", text: "x" }] },
      session_id: "sess-1",
    } as SDKMessage);

    const events = adapter.translateEvent({
      type: "user",
      message: {
        role: "user",
        content: [
          { type: "tool_result", tool_use_id: "tool-1", tool_name: "Bash", content: "output text" },
        ],
      },
      session_id: "sess-1",
    } as unknown as SDKMessage);

    expect(events).toContainEqual(
      expect.objectContaining({
        type: "item/completed",
        item: expect.objectContaining({
          type: "commandExecution",
          id: "tool-1",
          status: "completed",
        }),
      }),
    );
  });

  // -- translateEvent: system message --------------------------------------

  it("translateEvent returns empty for system messages", () => {
    const adapter = createClaudeCodeProviderAdapter();
    const events = adapter.translateEvent({
      type: "system",
      session_id: "sess-1",
    } as SDKMessage);
    expect(events).toEqual([]);
  });

  // -- translateEvent: multiple turns --------------------------------------

  it("translateEvent increments turn IDs across turns", () => {
    const adapter = createClaudeCodeProviderAdapter();

    // Turn 1
    adapter.translateEvent({
      type: "assistant",
      message: { role: "assistant", content: [{ type: "text", text: "first" }] },
      session_id: "sess-1",
    } as SDKMessage);
    adapter.translateEvent({
      type: "result",
      subtype: "end_turn",
      session_id: "sess-1",
    } as unknown as SDKMessage);

    // Turn 2
    const events = adapter.translateEvent({
      type: "assistant",
      message: { role: "assistant", content: [{ type: "text", text: "second" }] },
      session_id: "sess-1",
    } as SDKMessage);

    expect(events).toContainEqual(
      expect.objectContaining({ type: "turn/started", turnId: "turn-2" }),
    );
  });

  // -- translateEvent: real SDK fixtures ------------------------------------

  it("fixture: assistant-text produces turn/started + item/completed agentMessage", () => {
    const adapter = createClaudeCodeProviderAdapter();
    const events = adapter.translateEvent(loadFixture("assistant-text.json"));

    expect(events).toContainEqual(
      expect.objectContaining({ type: "turn/started", turnId: "turn-1" }),
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
    const adapter = createClaudeCodeProviderAdapter();
    const events = adapter.translateEvent(loadFixture("assistant-tool-use.json"));

    // Should have turn/started, item/completed (text), item/started (tool)
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
          id: "toolu_01AbCdEfGhIjKlMnOpQrStUv",
          command: "ls -la src/",
          status: "pending",
        }),
      }),
    );
  });

  it("fixture: assistant-file-edit produces fileChange item", () => {
    const adapter = createClaudeCodeProviderAdapter();
    const events = adapter.translateEvent(loadFixture("assistant-file-edit.json"));

    expect(events).toContainEqual(
      expect.objectContaining({
        type: "item/started",
        item: expect.objectContaining({
          type: "fileChange",
          status: "pending",
        }),
      }),
    );
  });

  it("fixture: stream-text-delta produces agentMessage delta", () => {
    const adapter = createClaudeCodeProviderAdapter();
    // Start a turn first
    adapter.translateEvent(loadFixture("assistant-text.json"));

    const events = adapter.translateEvent(loadFixture("stream-text-delta.json"));

    expect(events).toContainEqual(
      expect.objectContaining({
        type: "item/agentMessage/delta",
        delta: expect.any(String),
      }),
    );
  });

  it("fixture: result-success produces token usage + turn/completed", () => {
    const adapter = createClaudeCodeProviderAdapter();
    // Start a turn first
    adapter.translateEvent(loadFixture("assistant-text.json"));

    const events = adapter.translateEvent(loadFixture("result-success.json"));

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
        type: "turn/completed",
        turnId: "turn-1",
        status: "completed",
      }),
    );
  });

  it("fixture: user-tool-result produces commandExecution completed", () => {
    const adapter = createClaudeCodeProviderAdapter();
    // Start a turn first
    adapter.translateEvent(loadFixture("assistant-text.json"));

    const events = adapter.translateEvent(loadFixture("user-tool-result.json"));

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
    const adapter = createClaudeCodeProviderAdapter();
    // Start a turn first
    adapter.translateEvent(loadFixture("assistant-text.json"));

    const events = adapter.translateEvent(loadFixture("user-tool-result-generic.json"));

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

  it("fixture: system-init produces no events", () => {
    const adapter = createClaudeCodeProviderAdapter();
    const events = adapter.translateEvent(loadFixture("system-init.json"));
    expect(events).toEqual([]);
  });

  // -- Model catalog -------------------------------------------------------

  it("builds a dynamic Claude model list from the Anthropic models API", () => {
    const models = buildClaudeCodeAvailableModels([
      {
        id: "claude-sonnet-4-6",
        created_at: "2026-01-01T00:00:00Z",
        display_name: "Claude Sonnet 4.6",
        type: "model",
      },
      {
        id: "claude-opus-4-6",
        created_at: "2026-01-02T00:00:00Z",
        display_name: "Claude Opus 4.6",
        type: "model",
      },
      {
        id: "text-embedding-3-large",
        created_at: "2026-01-04T00:00:00Z",
        display_name: "Embedding",
        type: "model",
      },
    ]);

    const ids = models.map((model) => model.id);
    expect(ids).toContain("claude-sonnet-4-6");
    expect(ids).toContain("claude-opus-4-6");
    expect(ids).not.toContain("text-embedding-3-large");
    expect(models.find((model) => model.isDefault)?.id).toBe("claude-sonnet-4-6");
  });

  it("recognizes when Anthropic-backed model fetching should be skipped", () => {
    expect(
      shouldFetchClaudeCodeModelsFromAnthropic({
        ANTHROPIC_API_KEY: "key",
      }),
    ).toBe(true);
    expect(
      shouldFetchClaudeCodeModelsFromAnthropic({
        ANTHROPIC_AUTH_TOKEN: "token",
      }),
    ).toBe(false);
    expect(shouldFetchClaudeCodeModelsFromAnthropic({})).toBe(false);
  });
});
