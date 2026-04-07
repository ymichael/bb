import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  createClaudeCodeProviderAdapter,
} from "./adapter.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const FIXTURES = resolve(__dirname, "../__fixtures__/claude-code");

function loadFixture(name: string): unknown {
  return JSON.parse(readFileSync(resolve(FIXTURES, name), "utf8"));
}

describe("claude-code provider adapter", () => {
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

  it("uses the configured bridge bundle directory when present", () => {
    const adapter = createClaudeCodeProviderAdapter({
      bridgeBundleDir: "/tmp",
    });
    expect(adapter.process.args[0]).toBe("/tmp/bb-claude-code-bridge.mjs");
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

  it("buildCommand model/list routes through the bridge", () => {
    const adapter = createClaudeCodeProviderAdapter();
    expect(adapter.buildCommand({ type: "model/list" })).toEqual({
      jsonrpc: "2.0",
      method: "model/list",
      params: {},
    });
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

  it("buildCommand thread/start passes through model, env vars, instructions, reasoning level, and dynamic tools", () => {
    const adapter = createClaudeCodeProviderAdapter();
    const cmd = adapter.buildCommand({
      type: "thread/start",
      threadId: "bb-thread-1",
      input: [{ type: "text", text: "hello" }],
      options: {
        model: "claude-sonnet-4-5",
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
        model: "claude-sonnet-4-5",
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
    expect(cmd?.params).toMatchObject({
      config: {
        "shell_environment_policy.set.TEST_VAR": "123",
        model_reasoning_effort: "high",
      },
    });
    expect(cmd).not.toMatchObject({
      params: {
        config: {
          "shell_environment_policy.set.BAD.KEY": "ignored",
        },
      },
    });
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

  it("parseModelListResult validates bridge model payloads", () => {
    const adapter = createClaudeCodeProviderAdapter();
    expect(
      adapter.parseModelListResult([
        {
          id: "claude-sonnet-4-6",
          model: "claude-sonnet-4-6",
          displayName: "Claude Sonnet 4.6",
          description: "Fast, intelligent model for everyday coding tasks",
          supportedReasoningEfforts: [
            { reasoningEffort: "medium", description: "Medium reasoning effort" },
          ],
          defaultReasoningEffort: "medium",
          isDefault: true,
        },
      ]),
    ).toHaveLength(1);
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

  it("buildCommand thread/resume passes through options and dynamic tools", () => {
    const adapter = createClaudeCodeProviderAdapter();
    const cmd = adapter.buildCommand({
      type: "thread/resume",
      threadId: "bb-thread-1",
      providerThreadId: "claude-session-1",
      options: {
        model: "claude-sonnet-4-5",
        instructions: "Reopen the thread and continue carefully.",
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
      method: "thread/resume",
      params: {
        threadId: "bb-thread-1",
        providerThreadId: "claude-session-1",
        model: "claude-sonnet-4-5",
        baseInstructions: "Reopen the thread and continue carefully.",
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
    expect(cmd?.params).toMatchObject({
      config: {
        "shell_environment_policy.set.TEST_VAR": "123",
        model_reasoning_effort: "high",
      },
    });
    expect(cmd).not.toMatchObject({
      params: {
        config: {
          "shell_environment_policy.set.BAD.KEY": "ignored",
        },
      },
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

  it("buildCommand thread/stop returns null", () => {
    const adapter = createClaudeCodeProviderAdapter();
    expect(
      adapter.buildCommand({
        type: "thread/stop",
        threadId: "bb-thread-1",
      }),
    ).toBeNull();
  });

  it("decodeToolCallRequest preserves string request ids", () => {
    const adapter = createClaudeCodeProviderAdapter();
    expect(
      adapter.decodeToolCallRequest({
        jsonrpc: "2.0",
        id: "req-1",
        method: "item/tool/call",
        params: {
          threadId: "t1",
          providerThreadId: "claude-session-1",
          turnId: "turn-1",
          callId: "call-1",
          tool: "bb_test_ping",
          arguments: { ping: true },
        },
      }),
    ).toEqual({
      requestId: "req-1",
      threadId: "t1",
      providerThreadId: "claude-session-1",
      turnId: "turn-1",
      callId: "call-1",
      tool: "bb_test_ping",
      arguments: { ping: true },
    });
  });

  it("decodeToolCallRequest returns null when the request id is missing", () => {
    const adapter = createClaudeCodeProviderAdapter();
    expect(
      adapter.decodeToolCallRequest({
        jsonrpc: "2.0",
        method: "item/tool/call",
        params: {
          threadId: "t1",
          turnId: "turn-1",
          callId: "call-1",
          tool: "bb_test_ping",
          arguments: { ping: true },
        },
      }),
    ).toBeNull();
  });

  // -- translateEvent: assistant messages -----------------------------------

  it("translateEvent emits turn/started + item/completed for assistant message", () => {
    const adapter = createClaudeCodeProviderAdapter();
    const events = adapter.translateEvent({
      type: "assistant",
      message: {
        id: "msg-1",
        role: "assistant",
        content: [{ type: "text", text: "Hello world" }],
      },
      session_id: "sess-1",
    });

    expect(events).toContainEqual(
      expect.objectContaining({ type: "turn/started", turnId: "turn-1" }),
    );
    expect(events).toContainEqual(
      expect.objectContaining({
        type: "item/completed",
        item: expect.objectContaining({
          type: "agentMessage",
          id: "msg-1",
          text: "Hello world",
        }),
      }),
    );
  });

  it("translateEvent keeps assistant message ids distinct within one turn", () => {
    const adapter = createClaudeCodeProviderAdapter();

    const firstEvents = adapter.translateEvent({
      type: "assistant",
      message: {
        id: "msg-1",
        role: "assistant",
        content: [{ type: "text", text: "Now let me read the main files:" }],
      },
      session_id: "sess-1",
    });

    const secondEvents = adapter.translateEvent({
      type: "assistant",
      message: {
        id: "msg-2",
        role: "assistant",
        content: [{ type: "text", text: "Now let me read the test file:" }],
      },
      session_id: "sess-1",
    });

    expect(firstEvents).toContainEqual(
      expect.objectContaining({
        type: "item/completed",
        item: expect.objectContaining({
          type: "agentMessage",
          id: "msg-1",
          text: "Now let me read the main files:",
        }),
      }),
    );
    expect(secondEvents).toContainEqual(
      expect.objectContaining({
        type: "item/completed",
        item: expect.objectContaining({
          type: "agentMessage",
          id: "msg-2",
          text: "Now let me read the test file:",
        }),
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
    });

    const events = adapter.translateEvent({
      type: "assistant",
      message: {
        role: "assistant",
        content: [
          { type: "tool_use", id: "tool-1", name: "Bash", input: { command: "ls" } },
        ],
      },
      session_id: "sess-1",
    });

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

  it("translateEvent falls back to a generic tool call when Bash args are malformed", () => {
    const adapter = createClaudeCodeProviderAdapter();
    adapter.translateEvent({
      type: "assistant",
      message: { role: "assistant", content: [{ type: "text", text: "Let me check" }] },
      session_id: "sess-1",
    });

    const events = adapter.translateEvent({
      type: "assistant",
      message: {
        role: "assistant",
        content: [
          { type: "tool_use", id: "tool-1", name: "Bash", input: { command: 42 } },
        ],
      },
      session_id: "sess-1",
    });

    expect(events).toContainEqual(
      expect.objectContaining({
        type: "item/started",
        item: expect.objectContaining({
          type: "toolCall",
          id: "tool-1",
          tool: "Bash",
          status: "pending",
        }),
      }),
    );
  });

  it("translateEvent maps WebSearch and WebFetch tool uses into webSearch items", () => {
    const adapter = createClaudeCodeProviderAdapter();

    const events = adapter.translateEvent({
      type: "assistant",
      message: {
        role: "assistant",
        content: [
          {
            type: "tool_use",
            id: "tool-search-1",
            name: "WebSearch",
            input: { query: "react suspense" },
          },
          {
            type: "tool_use",
            id: "tool-fetch-1",
            name: "WebFetch",
            input: { url: "https://example.com" },
          },
        ],
      },
      session_id: "sess-1",
    });

    expect(events).toContainEqual(
      expect.objectContaining({
        type: "item/started",
        item: expect.objectContaining({
          type: "webSearch",
          id: "tool-search-1",
          query: "react suspense",
        }),
      }),
    );
    expect(events).toContainEqual(
      expect.objectContaining({
        type: "item/started",
        item: expect.objectContaining({
          type: "webSearch",
          id: "tool-fetch-1",
          query: "https://example.com",
          action: "fetch",
        }),
      }),
    );
  });

  it("translateEvent preserves completed WebSearch output text", () => {
    const adapter = createClaudeCodeProviderAdapter();

    adapter.translateEvent({
      type: "assistant",
      message: {
        role: "assistant",
        content: [{
          type: "tool_use",
          id: "tool-search-1",
          name: "WebSearch",
          input: { query: "react suspense" },
        }],
      },
      session_id: "sess-1",
    });

    const events = adapter.translateEvent({
      type: "user",
      message: {
        role: "user",
        content: [{
          type: "tool_result",
          tool_use_id: "tool-search-1",
          content: "Found the Suspense docs",
          is_error: false,
        }],
      },
      session_id: "sess-1",
    });

    expect(events).toContainEqual(
      expect.objectContaining({
        type: "item/completed",
        item: expect.objectContaining({
          type: "webSearch",
          id: "tool-search-1",
          query: "react suspense",
          outputText: "Found the Suspense docs",
        }),
      }),
    );
  });

  it("translateEvent ignores rate limit events", () => {
    const adapter = createClaudeCodeProviderAdapter();

    const events = adapter.translateEvent({
      jsonrpc: "2.0",
      method: "sdk/message",
      params: {
        threadId: "claude-thread-1",
        message: {
          type: "rate_limit_event",
          rate_limit_info: {
            status: "allowed",
            rateLimitType: "five_hour",
            overageStatus: "rejected",
            overageDisabledReason: "out_of_credits",
          },
        },
      },
    });

    expect(events).toEqual([]);
  });

  it("translateEvent maps thread identity envelopes", () => {
    const adapter = createClaudeCodeProviderAdapter();

    const events = adapter.translateEvent({
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
        threadId: "bb-thread-1",
        providerThreadId: "claude-thread-1",
      },
    ]);
  });

  it("translateEvent maps error envelopes", () => {
    const adapter = createClaudeCodeProviderAdapter();

    const events = adapter.translateEvent({
      jsonrpc: "2.0",
      method: "error",
      params: {
        message: "bridge failed",
      },
    });

    expect(events).toEqual([
      {
        type: "error",
        threadId: "",
        providerThreadId: "",
        message: "Provider error",
        detail: "bridge failed",
      },
    ]);
  });

  it("translateEvent marks Claude result events with is_error as failed", () => {
    const adapter = createClaudeCodeProviderAdapter();

    adapter.translateEvent({
      jsonrpc: "2.0",
      method: "sdk/message",
      params: {
        threadId: "claude-thread-1",
        message: {
          type: "assistant",
          message: {
            id: "assistant-1",
            content: [{
              type: "text",
              text:
                "API Error: 529 {\"type\":\"error\",\"error\":{\"type\":\"overloaded_error\",\"message\":\"Overloaded. https://docs.claude.com/en/api/errors\"},\"request_id\":\"req_123\"}",
            }],
          },
        },
      },
    });

    const events = adapter.translateEvent({
      jsonrpc: "2.0",
      method: "sdk/message",
      params: {
        threadId: "claude-thread-1",
        message: {
          type: "result",
          subtype: "success",
          is_error: true,
          result:
            "API Error: 529 {\"type\":\"error\",\"error\":{\"type\":\"overloaded_error\",\"message\":\"Overloaded. https://docs.claude.com/en/api/errors\"},\"request_id\":\"req_123\"}",
          usage: {},
          modelUsage: {},
        },
      },
    });

    expect(events).toContainEqual(
      expect.objectContaining({
        type: "turn/completed",
        turnId: "turn-1",
        status: "failed",
      }),
    );
    expect(events).toContainEqual(
      expect.objectContaining({
        type: "error",
        message: "Provider error",
      }),
    );
  });

  it("translateEvent falls back to provider/unhandled for unknown sdk envelopes", () => {
    const adapter = createClaudeCodeProviderAdapter();

    const events = adapter.translateEvent({
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
        threadId: "bb-thread-1",
        providerThreadId: "bb-thread-1",
        providerId: "claude-code",
        rawType: "sdk/custom_event",
      }),
    ]);
  });

  it("translateEvent surfaces malformed handled sdk envelopes as provider/unhandled", () => {
    const adapter = createClaudeCodeProviderAdapter();

    const events = adapter.translateEvent({
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
      }),
    ]);
  });

  it("translateEvent emits fileChange items with diffs for Edit tool uses", () => {
    const adapter = createClaudeCodeProviderAdapter();

    adapter.translateEvent({
      type: "assistant",
      message: { role: "assistant", content: [{ type: "text", text: "Let me patch that" }] },
      session_id: "sess-1",
    });

    const events = adapter.translateEvent({
      type: "assistant",
      message: {
        role: "assistant",
        content: [
          {
            type: "tool_use",
            id: "tool-edit-1",
            name: "Edit",
            input: {
              file_path: "src/app.ts",
              old_string: "const answer = 1;",
              new_string: "const answer = 2;",
            },
          },
        ],
      },
      session_id: "sess-1",
    });

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
              diff: expect.stringContaining("const answer = 2;"),
            }),
          ],
        }),
      }),
    );
  });

  it("translateEvent marks content-only Write tool uses as add changes", () => {
    const adapter = createClaudeCodeProviderAdapter();

    const events = adapter.translateEvent({
      type: "assistant",
      message: {
        role: "assistant",
        content: [
          {
            type: "tool_use",
            id: "tool-write-1",
            name: "Write",
            input: {
              path: "src/app.ts",
              content: "console.log('updated');\n",
            },
          },
        ],
      },
      session_id: "sess-1",
    });

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

  it("translateEvent preserves structured Agent arguments on tool calls", () => {
    const adapter = createClaudeCodeProviderAdapter();

    adapter.translateEvent({
      type: "assistant",
      message: { role: "assistant", content: [{ type: "text", text: "Let me delegate that" }] },
      session_id: "sess-1",
    });

    const events = adapter.translateEvent({
      type: "assistant",
      message: {
        role: "assistant",
        content: [
          {
            type: "tool_use",
            id: "tool-agent-1",
            name: "Agent",
            input: {
              subagent_type: "Explore",
              description: "Inspect the docs tree",
              prompt: "List every markdown file",
            },
          },
        ],
      },
      session_id: "sess-1",
    });

    expect(events).toContainEqual(
      expect.objectContaining({
        type: "item/started",
        item: expect.objectContaining({
          type: "toolCall",
          id: "tool-agent-1",
          tool: "Agent",
          status: "pending",
          arguments: expect.objectContaining({
            subagent_type: "Explore",
            description: "Inspect the docs tree",
            prompt: "List every markdown file",
          }),
        }),
      }),
    );
  });

  it("translateEvent preserves structured Read, Grep, and Glob arguments on tool calls", () => {
    const adapter = createClaudeCodeProviderAdapter();

    adapter.translateEvent({
      type: "assistant",
      message: { role: "assistant", content: [{ type: "text", text: "Let me inspect the repo" }] },
      session_id: "sess-1",
    });

    const events = adapter.translateEvent({
      type: "assistant",
      message: {
        role: "assistant",
        content: [
          {
            type: "tool_use",
            id: "tool-read-1",
            name: "Read",
            input: { file_path: "src/index.ts" },
          },
          {
            type: "tool_use",
            id: "tool-grep-1",
            name: "Grep",
            input: { pattern: "TODO", path: "src" },
          },
          {
            type: "tool_use",
            id: "tool-glob-1",
            name: "Glob",
            input: { pattern: "**/*.ts", path: "src" },
          },
        ],
      },
      session_id: "sess-1",
    });

    expect(events).toContainEqual(
      expect.objectContaining({
        type: "item/started",
        item: expect.objectContaining({
          type: "toolCall",
          id: "tool-read-1",
          tool: "Read",
          arguments: expect.objectContaining({
            file_path: "src/index.ts",
          }),
        }),
      }),
    );
    expect(events).toContainEqual(
      expect.objectContaining({
        type: "item/started",
        item: expect.objectContaining({
          type: "toolCall",
          id: "tool-grep-1",
          tool: "Grep",
          arguments: expect.objectContaining({
            pattern: "TODO",
            path: "src",
          }),
        }),
      }),
    );
    expect(events).toContainEqual(
      expect.objectContaining({
        type: "item/started",
        item: expect.objectContaining({
          type: "toolCall",
          id: "tool-glob-1",
          tool: "Glob",
          arguments: expect.objectContaining({
            pattern: "**/*.ts",
            path: "src",
          }),
        }),
      }),
    );
  });

  it("translateEvent falls back to generic tool calls for malformed structured args", () => {
    const adapter = createClaudeCodeProviderAdapter();

    adapter.translateEvent({
      type: "assistant",
      message: { role: "assistant", content: [{ type: "text", text: "Let me inspect that" }] },
      session_id: "sess-1",
    });

    const events = adapter.translateEvent({
      type: "assistant",
      message: {
        role: "assistant",
        content: [
          {
            type: "tool_use",
            id: "tool-read-bad-1",
            name: "Read",
            input: "not-an-object",
          },
        ],
      },
      session_id: "sess-1",
    });

    expect(events).toContainEqual(
      expect.objectContaining({
        type: "item/started",
        item: expect.objectContaining({
          type: "toolCall",
          id: "tool-read-bad-1",
          tool: "Read",
          status: "pending",
        }),
      }),
    );
    expect(events).not.toContainEqual(
      expect.objectContaining({
        type: "item/started",
        item: expect.objectContaining({
          id: "tool-read-bad-1",
          arguments: expect.anything(),
        }),
      }),
    );
  });

  it("translateEvent preserves parent_tool_use_id on nested sdk/message events", () => {
    const adapter = createClaudeCodeProviderAdapter();

    const events = adapter.translateEvent({
      jsonrpc: "2.0",
      method: "sdk/message",
      params: {
        message: {
          type: "assistant",
          message: {
            role: "assistant",
            content: [
              { type: "tool_use", id: "tool-1", name: "Bash", input: { command: "ls" } },
            ],
          },
          parent_tool_use_id: "agent-parent-1",
          session_id: "sess-1",
        },
      },
    });

    expect(events).toContainEqual(
      expect.objectContaining({
        type: "item/started",
        item: expect.objectContaining({
          type: "commandExecution",
          id: "tool-1",
          parentToolCallId: "agent-parent-1",
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
    });

    const events = adapter.translateEvent({
      type: "stream_event",
      event: {
        type: "content_block_delta",
        delta: { type: "text_delta", text: "streaming..." },
      },
      session_id: "sess-1",
    });

    expect(events).toContainEqual(
      expect.objectContaining({
        type: "item/agentMessage/delta",
        itemId: expect.stringMatching(/^claude-assistant-/),
        delta: "streaming...",
      }),
    );
  });

  it("translateEvent reuses the streamed assistant item id when the final assistant arrives", () => {
    const adapter = createClaudeCodeProviderAdapter();

    const deltaEvents = adapter.translateEvent({
      type: "stream_event",
      event: {
        type: "content_block_delta",
        delta: { type: "text_delta", text: "PONG" },
      },
      session_id: "sess-1",
    });
    const deltaEvent = deltaEvents.find(
      (event): event is Extract<(typeof deltaEvents)[number], { type: "item/agentMessage/delta" }> =>
        event.type === "item/agentMessage/delta",
    );

    const assistantEvents = adapter.translateEvent({
      type: "assistant",
      message: {
        id: "provider-msg-1",
        role: "assistant",
        content: [{ type: "text", text: "PONG" }],
      },
      session_id: "sess-1",
    });

    expect(deltaEvent?.itemId).toMatch(/^claude-assistant-/);
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

  it("translateEvent starts a turn when stream text arrives before the assistant envelope", () => {
    const adapter = createClaudeCodeProviderAdapter();

    const events = adapter.translateEvent({
      type: "stream_event",
      event: {
        type: "content_block_delta",
        delta: { type: "text_delta", text: "PONG" },
      },
      session_id: "sess-1",
    });

    expect(events).toContainEqual(
      expect.objectContaining({
        type: "turn/started",
        turnId: "turn-1",
      }),
    );
    expect(events).toContainEqual(
      expect.objectContaining({
        type: "item/agentMessage/delta",
        itemId: expect.stringMatching(/^claude-assistant-/),
        turnId: "turn-1",
        delta: "PONG",
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
    });

    const events = adapter.translateEvent({
      type: "result",
      subtype: "end_turn",
      session_id: "sess-1",
    });

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
    });

    const events = adapter.translateEvent({
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

  // -- translateEvent: tool results ----------------------------------------

  it("translateEvent emits item/completed for user tool results", () => {
    const adapter = createClaudeCodeProviderAdapter();
    // Start a turn
    adapter.translateEvent({
      type: "assistant",
      message: { role: "assistant", content: [{ type: "text", text: "x" }] },
      session_id: "sess-1",
    });

    const events = adapter.translateEvent({
      type: "user",
      message: {
        role: "user",
        content: [
          { type: "tool_result", tool_use_id: "tool-1", tool_name: "Bash", content: "output text" },
        ],
      },
      session_id: "sess-1",
    });

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

  it("translateEvent marks Bash tool results with is_error as failed", () => {
    const adapter = createClaudeCodeProviderAdapter();

    adapter.translateEvent({
      type: "assistant",
      message: {
        role: "assistant",
        content: [
          {
            type: "tool_use",
            id: "tool-1",
            name: "Bash",
            input: { command: "npm test", cwd: "/repo" },
          },
        ],
      },
      session_id: "sess-1",
    });

    const events = adapter.translateEvent({
      type: "user",
      message: {
        role: "user",
        content: [
          {
            type: "tool_result",
            tool_use_id: "tool-1",
            tool_name: "Bash",
            content: "command failed",
            is_error: true,
          },
        ],
      },
      session_id: "sess-1",
    });

    expect(events).toContainEqual(
      expect.objectContaining({
        type: "item/completed",
        item: expect.objectContaining({
          type: "commandExecution",
          id: "tool-1",
          command: "npm test",
          cwd: "/repo",
          aggregatedOutput: "command failed",
          exitCode: 1,
          status: "failed",
        }),
      }),
    );
  });

  it("translateEvent recovers missing tool names from prior tool uses", () => {
    const adapter = createClaudeCodeProviderAdapter();

    adapter.translateEvent({
      type: "assistant",
      message: {
        role: "assistant",
        content: [
          {
            type: "tool_use",
            id: "tool-1",
            name: "Edit",
            input: { file_path: "notes/todo.txt" },
          },
        ],
      },
      session_id: "sess-1",
    });

    const events = adapter.translateEvent({
      type: "user",
      message: {
        role: "user",
        content: [
          {
            type: "tool_result",
            tool_use_id: "tool-1",
            content: "updated",
          },
        ],
      },
      session_id: "sess-1",
    });

    expect(events).toContainEqual(
      expect.objectContaining({
        type: "item/completed",
        item: expect.objectContaining({
          type: "fileChange",
          id: "tool-1",
          status: "completed",
        }),
      }),
    );
  });

  it("translateEvent clears stale tool state when a turn ends without tool results", () => {
    const adapter = createClaudeCodeProviderAdapter();

    adapter.translateEvent({
      type: "assistant",
      message: {
        role: "assistant",
        content: [
          {
            type: "tool_use",
            id: "tool-1",
            name: "Bash",
            input: { command: "npm test", cwd: "/repo" },
          },
        ],
      },
      session_id: "sess-1",
    });

    adapter.translateEvent({
      type: "result",
      subtype: "end_turn",
      session_id: "sess-1",
    });

    const events = adapter.translateEvent({
      type: "user",
      message: {
        role: "user",
        content: [
          {
            type: "tool_result",
            tool_use_id: "tool-1",
            tool_name: "Bash",
            content: "late output",
          },
        ],
      },
      session_id: "sess-1",
    });

    expect(events).toContainEqual(
      expect.objectContaining({
        type: "item/completed",
        item: expect.objectContaining({
          type: "commandExecution",
          id: "tool-1",
          command: "",
          cwd: "",
          aggregatedOutput: "late output",
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
    });
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
    });
    adapter.translateEvent({
      type: "result",
      subtype: "end_turn",
      session_id: "sess-1",
    });

    // Turn 2
    const events = adapter.translateEvent({
      type: "assistant",
      message: { role: "assistant", content: [{ type: "text", text: "second" }] },
      session_id: "sess-1",
    });

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

  it("fixture: result-success accumulates Claude token usage across turns", () => {
    const adapter = createClaudeCodeProviderAdapter();

    adapter.translateEvent(loadFixture("assistant-text.json"));
    const firstTurnEvents = adapter.translateEvent(loadFixture("result-success.json"));

    adapter.translateEvent(loadFixture("assistant-text.json"));
    const secondTurnEvents = adapter.translateEvent(loadFixture("result-success.json"));

    const firstTokenUsage = firstTurnEvents.find(
      (event): event is Extract<(typeof firstTurnEvents)[number], { type: "thread/tokenUsage/updated" }> =>
        event.type === "thread/tokenUsage/updated",
    );
    const secondTokenUsage = secondTurnEvents.find(
      (event): event is Extract<(typeof secondTurnEvents)[number], { type: "thread/tokenUsage/updated" }> =>
        event.type === "thread/tokenUsage/updated",
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
    expect(secondTokenUsage?.tokenUsage.last).toEqual(firstTokenUsage?.tokenUsage.last);
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

});
