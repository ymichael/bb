import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import type { AgentSessionEvent } from "@mariozechner/pi-coding-agent";
import {
  createPiProviderAdapter,
} from "./adapter.js";
import { buildPiAvailableModels } from "./model-list.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const FIXTURES = resolve(__dirname, "../__fixtures__/pi");

function loadFixture(name: string): AgentSessionEvent {
  return JSON.parse(readFileSync(resolve(FIXTURES, name), "utf8")) as AgentSessionEvent;
}

describe("pi provider adapter", () => {
  // -- Identity & capabilities ---------------------------------------------

  it("has correct identity", () => {
    const adapter = createPiProviderAdapter();
    expect(adapter.id).toBe("pi");
    expect(adapter.displayName).toBe("Pi");
  });

  it("has correct process config", () => {
    const adapter = createPiProviderAdapter();
    expect(adapter.process.command).toBe("node");
    expect(adapter.process.args).toHaveLength(1);
    expect(adapter.process.args[0]).toMatch(/bridge\.js$/);
  });

  it("uses the configured bridge bundle directory when present", () => {
    const adapter = createPiProviderAdapter({
      bridgeBundleDir: "/tmp",
    });
    expect(adapter.process.args[0]).toBe("/tmp/bb-pi-bridge.mjs");
  });

  it("advertises trimmed capabilities", () => {
    const adapter = createPiProviderAdapter();
    expect(adapter.capabilities).toEqual({
      supportsRename: false,
      supportsServiceTier: false,
    });
  });

  // -- buildCommand --------------------------------------------------------

  it("buildCommand thread/start includes threadId and baseInstructions", () => {
    const adapter = createPiProviderAdapter();
    const cmd = adapter.buildCommand({
      type: "thread/start",
      cwd: "/tmp/worktree",
      threadId: "t1",
      input: [{ type: "text", text: "hello" }],
    });
    expect(cmd).toMatchObject({
      method: "thread/start",
      params: {
        threadId: "t1",
        cwd: "/tmp/worktree",
      },
    });
    expect((cmd as { params: { baseInstructions?: string } }).params.baseInstructions).toBeDefined();
  });

  it("buildCommand thread/start passes through model, env vars, instructions, reasoning level, and dynamic tools", () => {
    const adapter = createPiProviderAdapter();
    const cmd = adapter.buildCommand({
      type: "thread/start",
      cwd: "/tmp/worktree",
      threadId: "bb-thread-1",
      input: [{ type: "text", text: "hello" }],
      options: {
        model: "anthropic/claude-sonnet-4-20250514",
        instructions: "Focus on the failing tests first.",
        reasoningLevel: "high",
        envVars: {
          "BAD.KEY": "ignored",
          TEST_VAR: "123",
        },
      },
      dynamicTools: [{
        name: "bb_test_ping",
        description: "Ping the host",
        inputSchema: {
          type: "object",
          properties: {
            ping: { type: "boolean" },
          },
          required: ["ping"],
        },
      }],
    });

    expect(cmd).toMatchObject({
      method: "thread/start",
      params: {
        threadId: "bb-thread-1",
        model: "anthropic/claude-sonnet-4-20250514",
        baseInstructions: expect.stringContaining("Focus on the failing tests first."),
        dynamicTools: [{
          name: "bb_test_ping",
          description: "Ping the host",
          inputSchema: {
            type: "object",
            properties: {
              ping: { type: "boolean" },
            },
            required: ["ping"],
          },
        }],
      },
    });
    expect((cmd as { params: { config?: Record<string, unknown> } }).params.config).toMatchObject({
      "shell_environment_policy.set.BB_THREAD_ID": "bb-thread-1",
      "shell_environment_policy.set.TEST_VAR": "123",
      model_reasoning_effort: "high",
    });
    expect(cmd).not.toMatchObject({
      params: {
        config: {
          "shell_environment_policy.set.BAD.KEY": "ignored",
        },
      },
    });
  });

  it("buildCommand thread/resume routes to provider thread id", () => {
    const adapter = createPiProviderAdapter();
    const cmd = adapter.buildCommand({
      type: "thread/resume",
      cwd: "/tmp/worktree",
      threadId: "bb-t1",
      providerThreadId: "pi-session-1",
    });
    expect(cmd).toMatchObject({
      method: "thread/resume",
      params: {
        threadId: "pi-session-1",
        cwd: "/tmp/worktree",
      },
    });
  });

  it("buildCommand thread/stop returns null", () => {
    const adapter = createPiProviderAdapter();
    expect(
      adapter.buildCommand({
        type: "thread/stop",
        threadId: "bb-t1",
      }),
    ).toBeNull();
  });

  it("buildCommand turn/start includes input", () => {
    const adapter = createPiProviderAdapter();
    const cmd = adapter.buildCommand({
      type: "turn/start",
      threadId: "t1",
      providerThreadId: "pi-1",
      input: [{ type: "text", text: "do it" }],
    });
    expect(cmd).toMatchObject({
      method: "turn/start",
      params: { threadId: "pi-1" },
    });
  });

  it("buildCommand turn/steer includes expectedTurnId", () => {
    const adapter = createPiProviderAdapter();
    const cmd = adapter.buildCommand({
      type: "turn/steer",
      threadId: "t1",
      providerThreadId: "pi-1",
      expectedTurnId: "turn-1",
      input: [{ type: "text", text: "steer" }],
    });
    expect(cmd).toMatchObject({
      method: "turn/steer",
      params: {
        threadId: "pi-1",
        expectedTurnId: "turn-1",
      },
    });
  });

  it("buildCommand thread/name/set returns null (unsupported)", () => {
    const adapter = createPiProviderAdapter();
    expect(
      adapter.buildCommand({
        type: "thread/name/set",
        threadId: "t1",
        providerThreadId: "p1",
        title: "hi",
      }),
    ).toBeNull();
  });

  it("decodeToolCallRequest preserves string request ids", () => {
    const adapter = createPiProviderAdapter();
    expect(
      adapter.decodeToolCallRequest({
        jsonrpc: "2.0",
        id: "req-1",
        method: "item/tool/call",
        params: {
          threadId: "t1",
          providerThreadId: "t1",
          turnId: "turn-1",
          callId: "call-1",
          tool: "bb_test_ping",
          arguments: { ping: true },
        },
      }),
    ).toEqual({
      requestId: "req-1",
      threadId: "t1",
      providerThreadId: "t1",
      turnId: "turn-1",
      callId: "call-1",
      tool: "bb_test_ping",
      arguments: { ping: true },
    });
  });

  it("decodeToolCallRequest rejects non-string, non-number request ids", () => {
    const adapter = createPiProviderAdapter();
    const malformedRequest = JSON.parse(
      "{\"jsonrpc\":\"2.0\",\"id\":true,\"method\":\"item/tool/call\",\"params\":{\"threadId\":\"t1\",\"turnId\":\"turn-1\",\"callId\":\"call-1\",\"tool\":\"bb_test_ping\",\"arguments\":{\"ping\":true}}}",
    );

    expect(
      adapter.decodeToolCallRequest(malformedRequest),
    ).toBeNull();
  });

  // -- translateEvent: turn lifecycle --------------------------------------

  it("translateEvent agent_start emits turn/started", () => {
    const adapter = createPiProviderAdapter();
    const events = adapter.translateEvent(loadFixture("agent-start.json"));

    expect(events).toContainEqual(
      expect.objectContaining({ type: "turn/started", turnId: "turn-1" }),
    );
  });

  it("translateEvent agent_end emits agentMessage + turn/completed", () => {
    const adapter = createPiProviderAdapter();
    // Start a turn first
    adapter.translateEvent(loadFixture("agent-start.json"));

    const events = adapter.translateEvent(loadFixture("agent-end-with-message.json"));

    expect(events).toContainEqual(
      expect.objectContaining({
        type: "item/completed",
        item: expect.objectContaining({ type: "agentMessage" }),
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

  // -- translateEvent: streaming -------------------------------------------

  it("translateEvent message_update emits agentMessage delta", () => {
    const adapter = createPiProviderAdapter();
    // Start a turn first
    adapter.translateEvent(loadFixture("agent-start.json"));

    const events = adapter.translateEvent(loadFixture("message-update-delta.json"));

    expect(events).toContainEqual(
      expect.objectContaining({
        type: "item/agentMessage/delta",
        itemId: expect.stringMatching(/^pi-assistant-/),
        delta: expect.any(String),
      }),
    );
  });

  it("translateEvent reuses the streamed assistant item id when the turn ends", () => {
    const adapter = createPiProviderAdapter();
    adapter.translateEvent(loadFixture("agent-start.json"));

    const deltaEvents = adapter.translateEvent(loadFixture("message-update-delta.json"));
    const deltaEvent = deltaEvents.find(
      (event): event is Extract<(typeof deltaEvents)[number], { type: "item/agentMessage/delta" }> =>
        event.type === "item/agentMessage/delta",
    );
    const completedEvents = adapter.translateEvent(loadFixture("agent-end-with-message.json"));

    expect(deltaEvent?.itemId).toMatch(/^pi-assistant-/);
    expect(completedEvents).toContainEqual(
      expect.objectContaining({
        type: "item/completed",
        item: expect.objectContaining({
          type: "agentMessage",
          id: deltaEvent?.itemId,
        }),
      }),
    );
  });

  it("translateEvent assigns a new assistant id after a tool call interrupts streaming", () => {
    const adapter = createPiProviderAdapter();
    adapter.translateEvent(loadFixture("agent-start.json"));

    // Stream assistant text before tool call
    const preDelta = adapter.translateEvent(loadFixture("message-update-delta.json"));
    const preItemId = preDelta.find(
      (e): e is Extract<(typeof preDelta)[number], { type: "item/agentMessage/delta" }> =>
        e.type === "item/agentMessage/delta",
    )?.itemId;

    // Tool call starts — should close the assistant scope
    adapter.translateEvent({
      type: "tool_execution_start",
      toolCallId: "tool-bash-1",
      toolName: "bash",
      args: { command: "ls" },
    });

    // Stream assistant text after tool call
    const postDelta = adapter.translateEvent(loadFixture("message-update-delta.json"));
    const postItemId = postDelta.find(
      (e): e is Extract<(typeof postDelta)[number], { type: "item/agentMessage/delta" }> =>
        e.type === "item/agentMessage/delta",
    )?.itemId;

    // Completed assistant message at agent_end should use the post-tool id
    const endEvents = adapter.translateEvent(loadFixture("agent-end-with-message.json"));
    const completedId = endEvents.find(
      (e) => e.type === "item/completed" && e.item.type === "agentMessage",
    );

    expect(preItemId).toMatch(/^pi-assistant-/);
    expect(postItemId).toMatch(/^pi-assistant-/);
    expect(preItemId).not.toBe(postItemId);
    expect(completedId).toBeDefined();
    if (completedId?.type === "item/completed" && completedId.item.type === "agentMessage") {
      expect(completedId.item.id).toBe(postItemId);
    }
  });

  // -- translateEvent: tool calls ------------------------------------------

  it("translateEvent tool_execution_start emits item/started", () => {
    const adapter = createPiProviderAdapter();
    // Start a turn first
    adapter.translateEvent(loadFixture("agent-start.json"));

    const events = adapter.translateEvent(loadFixture("tool-execution-start-bash.json"));

    expect(events).toContainEqual(
      expect.objectContaining({
        type: "item/started",
        item: expect.objectContaining({
          type: "commandExecution",
          id: "tc_01a2b3c4d5e6f7g8h9i0j1k2",
          status: "pending",
        }),
      }),
    );
  });

  it("translateEvent preserves parent_tool_use_id on nested sdk/message events", () => {
    const adapter = createPiProviderAdapter();
    adapter.translateEvent(loadFixture("agent-start.json"));

    const events = adapter.translateEvent({
      jsonrpc: "2.0",
      method: "sdk/message",
      params: {
        threadId: "pi-thread-1",
        parent_tool_use_id: "agent-parent-1",
        message: {
          type: "tool_execution_start",
          toolCallId: "tool-bash-1",
          toolName: "bash",
          args: {
            command: "ls",
          },
        },
      },
    });

    expect(events).toContainEqual(
      expect.objectContaining({
        type: "item/started",
        item: expect.objectContaining({
          type: "commandExecution",
          id: "tool-bash-1",
          parentToolCallId: "agent-parent-1",
        }),
      }),
    );
  });

  it("translateEvent falls back to a generic tool call when bash args are malformed", () => {
    const adapter = createPiProviderAdapter();
    adapter.translateEvent(loadFixture("agent-start.json"));

    const events = adapter.translateEvent({
      type: "tool_execution_start",
      toolCallId: "tool-bash-1",
      toolName: "bash",
      args: {
        command: 42,
      },
    } as AgentSessionEvent);

    expect(events).toContainEqual(
      expect.objectContaining({
        type: "item/started",
        item: expect.objectContaining({
          type: "toolCall",
          id: "tool-bash-1",
          tool: "bash",
          status: "pending",
        }),
      }),
    );
  });

  it("translateEvent surfaces malformed handled sdk envelopes as provider/unhandled", () => {
    const adapter = createPiProviderAdapter();

    const events = adapter.translateEvent({
      jsonrpc: "2.0",
      method: "sdk/message",
      params: {
        threadId: "pi-thread-1",
        message: {
          type: "agent_end",
        },
      },
    });

    expect(events).toEqual([
      expect.objectContaining({
        type: "provider/unhandled",
        providerId: "pi",
        rawType: "sdk/agent_end",
      }),
    ]);
  });

  it("translateEvent tool_execution_start with edit args emits fileChange with diff", () => {
    const adapter = createPiProviderAdapter();
    adapter.translateEvent(loadFixture("agent-start.json"));

    const events = adapter.translateEvent({
      type: "tool_execution_start",
      toolCallId: "tool-edit-1",
      toolName: "edit",
      args: {
        path: "src/app.ts",
        oldText: "const enabled = false;\n",
        newText: "const enabled = true;\n",
      },
    } as AgentSessionEvent);

    expect(events).toContainEqual(
      expect.objectContaining({
        type: "item/started",
        item: expect.objectContaining({
          type: "fileChange",
          id: "tool-edit-1",
          status: "pending",
          changes: [
            expect.objectContaining({
              path: "src/app.ts",
              diff: expect.stringContaining("const enabled = true;"),
            }),
          ],
        }),
      }),
    );
  });

  it("translateEvent tool_execution_start with content-only write args marks the change as an add", () => {
    const adapter = createPiProviderAdapter();
    adapter.translateEvent(loadFixture("agent-start.json"));

    const events = adapter.translateEvent({
      type: "tool_execution_start",
      toolCallId: "tool-write-1",
      toolName: "write",
      args: {
        path: "src/app.ts",
        content: "console.log('updated');\n",
      },
    } as AgentSessionEvent);

    const started = events.find(
      (event): event is Extract<(typeof events)[number], { type: "item/started" }> =>
        event.type === "item/started",
    );
    expect(started?.item).toMatchObject({
      type: "fileChange",
      id: "tool-write-1",
      status: "pending",
      changes: [
        {
          path: "src/app.ts",
          kind: "add",
        },
      ],
    });
    if (!started || started.item.type !== "fileChange") return;
    expect(started.item.changes[0]?.diff).toContain("+++ b/src/app.ts");
  });

  it("translateEvent tool_execution_start with read args preserves structured tool arguments", () => {
    const adapter = createPiProviderAdapter();
    adapter.translateEvent(loadFixture("agent-start.json"));

    const events = adapter.translateEvent({
      type: "tool_execution_start",
      toolCallId: "tool-read-1",
      toolName: "read",
      args: {
        path: "src/app.ts",
        offset: 1,
        limit: 20,
      },
    } as AgentSessionEvent);

    expect(events).toContainEqual(
      expect.objectContaining({
        type: "item/started",
        item: expect.objectContaining({
          type: "toolCall",
          id: "tool-read-1",
          tool: "read",
          status: "pending",
          arguments: expect.objectContaining({
            path: "src/app.ts",
            offset: 1,
            limit: 20,
          }),
        }),
      }),
    );
  });

  it("translateEvent tool_execution_end emits item/completed", () => {
    const adapter = createPiProviderAdapter();
    // Start a turn first
    adapter.translateEvent(loadFixture("agent-start.json"));

    const events = adapter.translateEvent(loadFixture("tool-execution-end-bash.json"));

    expect(events).toContainEqual(
      expect.objectContaining({
        type: "item/completed",
        item: expect.objectContaining({
          type: "commandExecution",
          id: "tc_01a2b3c4d5e6f7g8h9i0j1k2",
          status: "completed",
        }),
      }),
    );
  });

  it("translateEvent tool_execution_end marks bash failures", () => {
    const adapter = createPiProviderAdapter();
    adapter.translateEvent(loadFixture("agent-start.json"));

    adapter.translateEvent({
      type: "tool_execution_start",
      toolCallId: "tool-bash-1",
      toolName: "bash",
      args: {
        command: "npm test",
        cwd: "/repo",
      },
    } as AgentSessionEvent);

    const events = adapter.translateEvent({
      type: "tool_execution_end",
      toolCallId: "tool-bash-1",
      toolName: "bash",
      isError: true,
      result: "tests failed",
    } as AgentSessionEvent);

    expect(events).toContainEqual(
      expect.objectContaining({
        type: "item/completed",
        item: expect.objectContaining({
          type: "commandExecution",
          id: "tool-bash-1",
          command: "npm test",
          cwd: "/repo",
          aggregatedOutput: "tests failed",
          exitCode: 1,
          status: "failed",
        }),
      }),
    );
  });

  it("translateEvent recovers non-bash tool results from the started item", () => {
    const adapter = createPiProviderAdapter();
    adapter.translateEvent(loadFixture("agent-start.json"));

    adapter.translateEvent({
      type: "tool_execution_start",
      toolCallId: "tool-read-1",
      toolName: "read",
      args: {
        path: "src/app.ts",
        offset: 1,
        limit: 20,
      },
    } as AgentSessionEvent);

    const events = adapter.translateEvent({
      type: "tool_execution_end",
      toolCallId: "tool-read-1",
      toolName: "read",
      isError: false,
      result: "file contents",
    } as AgentSessionEvent);

    expect(events).toContainEqual(
      expect.objectContaining({
        type: "item/completed",
        item: expect.objectContaining({
          type: "toolCall",
          id: "tool-read-1",
          tool: "read",
          status: "completed",
          result: "file contents",
          arguments: expect.objectContaining({
            path: "src/app.ts",
            offset: 1,
            limit: 20,
          }),
        }),
      }),
    );
  });

  it("translateEvent maps tool execution updates to shared tool progress", () => {
    const adapter = createPiProviderAdapter();
    adapter.translateEvent(loadFixture("agent-start.json"));

    const events = adapter.translateEvent({
      jsonrpc: "2.0",
      method: "sdk/message",
      params: {
        threadId: "pi-thread-1",
        message: {
          type: "tool_execution_update",
          toolCallId: "tool-bash-1",
          toolName: "bash",
          partialResult: {
            content: [{ type: "text", text: "partial output" }],
          },
        },
      },
    });

    expect(events).toContainEqual(
      expect.objectContaining({
        type: "item/toolCall/progress",
        itemId: "tool-bash-1",
        message: "partial output",
      }),
    );
  });

  it("translateEvent surfaces tool events without an active turn as provider/unhandled", () => {
    const adapter = createPiProviderAdapter();

    const events = adapter.translateEvent({
      jsonrpc: "2.0",
      method: "sdk/message",
      params: {
        threadId: "pi-thread-1",
        message: {
          type: "tool_execution_start",
          toolCallId: "tool-bash-1",
          toolName: "bash",
          args: {
            command: "npm test",
          },
        },
      },
    });

    expect(events).toContainEqual(
      expect.objectContaining({
        type: "provider/unhandled",
        providerId: "pi",
        rawType: "sdk/tool_execution_start",
      }),
    );
  });

  it("translateEvent ignores auto retry notifications for now", () => {
    const adapter = createPiProviderAdapter();

    const events = adapter.translateEvent({
      jsonrpc: "2.0",
      method: "sdk/message",
      params: {
        threadId: "pi-thread-1",
        message: {
          type: "auto_retry_start",
          attempt: 1,
          maxAttempts: 2,
          delayMs: 2000,
        },
      },
    });

    expect(events).toEqual([]);
  });

  // -- translateEvent: multiple turns --------------------------------------

  it("translateEvent increments turn IDs across turns", () => {
    const adapter = createPiProviderAdapter();

    // Turn 1
    adapter.translateEvent(loadFixture("agent-start.json"));
    adapter.translateEvent(loadFixture("agent-end-with-message.json"));

    // Turn 2
    const events = adapter.translateEvent(loadFixture("agent-start.json"));

    expect(events).toContainEqual(
      expect.objectContaining({ type: "turn/started", turnId: "turn-2" }),
    );
  });

  it("translateEvent accumulates Pi token usage across turns", () => {
    const adapter = createPiProviderAdapter({
      resolveModelContextWindow: () => 123_456,
    });

    adapter.translateEvent(loadFixture("agent-start.json"));
    const firstTurnEvents = adapter.translateEvent(loadFixture("agent-end-with-message.json"));

    adapter.translateEvent(loadFixture("agent-start.json"));
    const secondTurnEvents = adapter.translateEvent(loadFixture("agent-end-with-message.json"));

    const firstTokenUsage = firstTurnEvents.find(
      (event): event is Extract<(typeof firstTurnEvents)[number], { type: "thread/tokenUsage/updated" }> =>
        event.type === "thread/tokenUsage/updated",
    );
    const secondTokenUsage = secondTurnEvents.find(
      (event): event is Extract<(typeof secondTurnEvents)[number], { type: "thread/tokenUsage/updated" }> =>
        event.type === "thread/tokenUsage/updated",
    );

    expect(firstTokenUsage?.tokenUsage.last).toMatchObject({
      totalTokens: 7736,
      inputTokens: 4200,
      cachedInputTokens: 3380,
      outputTokens: 156,
    });
    expect(firstTokenUsage?.tokenUsage.modelContextWindow).toBe(123_456);
    expect(secondTokenUsage?.tokenUsage.total).toMatchObject({
      totalTokens: 15472,
      inputTokens: 8400,
      cachedInputTokens: 6760,
      outputTokens: 312,
    });
    expect(secondTokenUsage?.tokenUsage.last).toEqual(firstTokenUsage?.tokenUsage.last);
    expect(secondTokenUsage?.tokenUsage.modelContextWindow).toBe(123_456);
  });

  it("translateEvent clears stale tool state when a turn ends without tool results", () => {
    const adapter = createPiProviderAdapter();

    adapter.translateEvent(loadFixture("agent-start.json"));
    adapter.translateEvent({
      type: "tool_execution_start",
      toolCallId: "tool-bash-1",
      toolName: "bash",
      args: {
        command: "npm test",
        cwd: "/repo",
      },
    } as AgentSessionEvent);
    adapter.translateEvent(loadFixture("agent-end-with-message.json"));

    adapter.translateEvent(loadFixture("agent-start.json"));
    const events = adapter.translateEvent({
      type: "tool_execution_end",
      toolCallId: "tool-bash-1",
      toolName: "bash",
      isError: false,
      result: "late output",
    } as AgentSessionEvent);

    expect(events).toContainEqual(
      expect.objectContaining({
        type: "item/completed",
        item: expect.objectContaining({
          type: "commandExecution",
          id: "tool-bash-1",
          command: "",
          cwd: "",
          aggregatedOutput: "late output",
        }),
      }),
    );
  });

  // -- Model catalog -------------------------------------------------------

  it("builds a dynamic model list from the Pi catalog", () => {
    const models = buildPiAvailableModels({
      providers: ["anthropic", "openai", "google"],
      getModels: (provider) => {
        switch (provider) {
          case "anthropic":
            return [
              {
                id: "claude-sonnet-4",
                name: "Claude Sonnet 4",
                provider: "anthropic",
                reasoning: true,
                input: ["text", "image"],
                supportsXhigh: false,
              },
            ];
          case "openai":
            return [
              {
                id: "codex-mini",
                name: "Codex Mini",
                provider: "openai",
                reasoning: true,
                input: ["text"],
                supportsXhigh: false,
              },
            ];
          default:
            return [
              {
                id: "gemini-2.5-pro",
                name: "Gemini 2.5 Pro",
                provider: "google",
                reasoning: true,
                input: ["text"],
                supportsXhigh: false,
              },
            ];
        }
      },
      hasAuth: (provider) => provider !== "google",
    });

    const ids = models.map((model) => model.id);
    expect(ids).toContain("anthropic/claude-sonnet-4");
    expect(ids).toContain("openai/codex-mini");
    expect(ids).not.toContain("google/gemini-2.5-pro");
    expect(models.find((model) => model.isDefault)?.id).toBe(
      "anthropic/claude-sonnet-4",
    );
  });

});
