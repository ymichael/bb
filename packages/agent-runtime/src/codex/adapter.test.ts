import { beforeEach, describe, expect, it, vi } from "vitest";

import { createCodexProviderAdapter } from "./adapter.js";
import type { CodexEvent } from "./adapter.js";

// ---------------------------------------------------------------------------
// Helpers to build typed CodexEvent fixtures
// ---------------------------------------------------------------------------

function codexEvent<M extends CodexEvent["method"]>(
  method: M,
  params: Extract<CodexEvent, { method: M }>["params"],
) {
  return {
    jsonrpc: "2.0" as const,
    method,
    params,
  };
}

describe("codex provider adapter", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  // -- Identity & capabilities ---------------------------------------------

  it("advertises trimmed capabilities", () => {
    const adapter = createCodexProviderAdapter();
    expect(adapter.capabilities).toEqual({
      supportsRename: true,
      supportsServiceTier: true,
    });
  });

  it("has correct process config", () => {
    const adapter = createCodexProviderAdapter();
    expect(adapter.process.command).toBe("codex");
    expect(adapter.process.args).toEqual(["app-server"]);
  });

  // -- buildCommand --------------------------------------------------------

  it("buildCommand returns codex initialize with experimental API", () => {
    const adapter = createCodexProviderAdapter();
    const cmd = adapter.buildCommand({ type: "initialize" });
    expect(cmd).toMatchObject({
      method: "initialize",
      params: {
        clientInfo: { name: "bb", version: "1.0.0", title: null },
        capabilities: { experimentalApi: true },
      },
    });
  });

  it("buildCommand model/list maps to the codex protocol", () => {
    const adapter = createCodexProviderAdapter();
    const cmd = adapter.buildCommand({ type: "model/list" });

    expect(cmd).toEqual({
      jsonrpc: "2.0",
      method: "model/list",
      params: {},
    });
  });

  it("buildCommand thread/start includes approval policy and sandbox", () => {
    const adapter = createCodexProviderAdapter();
    const cmd = adapter.buildCommand({
      type: "thread/start",
      cwd: "/tmp/worktree",
      threadId: "t1",
      input: [{ type: "text", text: "hello" }],
    });
    expect(cmd).toMatchObject({
      method: "thread/start",
      params: {
        approvalPolicy: "never",
        sandbox: "danger-full-access",
        cwd: "/tmp/worktree",
      },
    });
  });

  it("buildCommand thread/start passes through model, service tier, env vars, instructions, and dynamic tools", () => {
    const adapter = createCodexProviderAdapter();
    const cmd = adapter.buildCommand({
      type: "thread/start",
      cwd: "/tmp/worktree",
      threadId: "bb-thread-1",
      input: [{ type: "text", text: "hello" }],
      options: {
        model: "gpt-5.4",
        serviceTier: "fast",
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
        model: "gpt-5.4",
        serviceTier: "fast",
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
        "shell_environment_policy.set.BB_THREAD_ID": "bb-thread-1",
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

  it("buildCommand thread/resume routes to provider thread id", () => {
    const adapter = createCodexProviderAdapter();
    const cmd = adapter.buildCommand({
      type: "thread/resume",
      cwd: "/tmp/worktree",
      threadId: "bb-t1",
      providerThreadId: "codex-uuid-1",
    });
    expect(cmd).toMatchObject({
      method: "thread/resume",
      params: {
        threadId: "codex-uuid-1",
        cwd: "/tmp/worktree",
      },
    });
  });

  it("buildCommand thread/resume falls back to context threadId", () => {
    const adapter = createCodexProviderAdapter();
    const cmd = adapter.buildCommand({
      type: "thread/resume",
      cwd: "/tmp/worktree",
      threadId: "bb-t1",
      providerThreadId: undefined,
    });
    expect(cmd).toMatchObject({
      method: "thread/resume",
      params: {
        threadId: "bb-t1",
        cwd: "/tmp/worktree",
      },
    });
  });

  it("buildCommand thread/stop returns null", () => {
    const adapter = createCodexProviderAdapter();
    expect(
      adapter.buildCommand({
        type: "thread/stop",
        threadId: "bb-t1",
      }),
    ).toBeNull();
  });

  it("buildCommand turn/start includes input and sandbox policy", () => {
    const adapter = createCodexProviderAdapter();
    const cmd = adapter.buildCommand({
      type: "turn/start",
      threadId: "t1",
      providerThreadId: "codex-1",
      input: [{ type: "text", text: "do it" }],
    });
    expect(cmd).toMatchObject({
      method: "turn/start",
      params: {
        threadId: "codex-1",
        input: [{ type: "text", text: "do it" }],
        approvalPolicy: "never",
      },
    });
  });

  it("buildCommand turn/start maps read-only sandbox policy", () => {
    const adapter = createCodexProviderAdapter();
    const cmd = adapter.buildCommand({
      type: "turn/start",
      threadId: "t1",
      providerThreadId: "codex-1",
      input: [{ type: "text", text: "inspect only" }],
      options: { sandboxMode: "read-only" },
    });
    expect(cmd).toMatchObject({
      method: "turn/start",
      params: {
        sandboxPolicy: {
          type: "readOnly",
          access: { type: "fullAccess" },
          networkAccess: false,
        },
      },
    });
  });

  it("buildCommand turn/start maps workspace-write sandbox policy", () => {
    const adapter = createCodexProviderAdapter();
    const cmd = adapter.buildCommand({
      type: "turn/start",
      threadId: "t1",
      providerThreadId: "codex-1",
      input: [{ type: "text", text: "edit it" }],
      options: { sandboxMode: "workspace-write" },
    });
    expect(cmd).toMatchObject({
      method: "turn/start",
      params: {
        sandboxPolicy: {
          type: "workspaceWrite",
          writableRoots: [],
          readOnlyAccess: { type: "fullAccess" },
          networkAccess: true,
          excludeTmpdirEnvVar: false,
          excludeSlashTmp: false,
        },
      },
    });
  });

  it("buildCommand turn/steer includes expectedTurnId", () => {
    const adapter = createCodexProviderAdapter();
    const cmd = adapter.buildCommand({
      type: "turn/steer",
      threadId: "t1",
      providerThreadId: "codex-1",
      expectedTurnId: "turn-3",
      input: [{ type: "text", text: "steer it" }],
    });
    expect(cmd).toMatchObject({
      method: "turn/steer",
      params: {
        threadId: "codex-1",
        expectedTurnId: "turn-3",
        input: [{ type: "text", text: "steer it" }],
      },
    });
  });

  it("buildCommand thread/name/set returns command when rename supported", () => {
    const adapter = createCodexProviderAdapter();
    const cmd = adapter.buildCommand({
      type: "thread/name/set",
      threadId: "t1",
      providerThreadId: "codex-1",
      title: "New title",
    });
    expect(cmd).toMatchObject({
      method: "thread/name/set",
      params: { threadId: "codex-1", name: "New title" },
    });
  });

  // -- translateEvent: turn lifecycle --------------------------------------

  it("translateEvent turn/started", () => {
    const adapter = createCodexProviderAdapter();
    const events = adapter.translateEvent(
      codexEvent("turn/started", {
        threadId: "t1",
        turn: { id: "turn-1", items: [], status: "inProgress", error: null },
      }),
    );
    expect(events).toContainEqual({
      type: "turn/started",
      threadId: "t1",
      providerThreadId: "t1",
      turnId: "turn-1",
    });
  });

  it("translateEvent accepts legacy Codex bridge envelopes without jsonrpc", () => {
    const adapter = createCodexProviderAdapter();
    const events = adapter.translateEvent({
      method: "turn/started",
      params: {
        threadId: "t1",
        turn: { id: "turn-1", items: [], status: "inProgress", error: null },
      },
    });

    expect(events).toContainEqual({
      type: "turn/started",
      threadId: "t1",
      providerThreadId: "t1",
      turnId: "turn-1",
    });
  });

  it("translateEvent surfaces malformed handled Codex events as provider/unhandled", () => {
    const adapter = createCodexProviderAdapter();
    const events = adapter.translateEvent({
      jsonrpc: "2.0",
      method: "turn/started",
      params: {
        threadId: "t1",
      },
    });

    expect(events).toContainEqual(
      expect.objectContaining({
        type: "provider/unhandled",
        providerId: "codex",
        rawType: "turn/started",
        threadId: "t1",
      }),
    );
  });

  it("translateEvent turn/completed with status and error", () => {
    const adapter = createCodexProviderAdapter();
    const events = adapter.translateEvent(
      codexEvent("turn/completed", {
        threadId: "t1",
        turn: {
          id: "turn-1",
          items: [],
          status: "failed",
          error: { message: "rate limited", codexErrorInfo: null, additionalDetails: "try again" },
        },
      }),
    );
    expect(events).toContainEqual(
      expect.objectContaining({
        type: "turn/completed",
        threadId: "t1",
        turnId: "turn-1",
        status: "failed",
        error: { message: "rate limited" },
      }),
    );
  });

  it("translateEvent turn/completed maps interrupted status", () => {
    const adapter = createCodexProviderAdapter();
    const events = adapter.translateEvent(
      codexEvent("turn/completed", {
        threadId: "t1",
        turn: { id: "turn-1", items: [], status: "interrupted", error: null },
      }),
    );
    expect(events).toContainEqual(
      expect.objectContaining({ type: "turn/completed", status: "interrupted" }),
    );
  });

  // -- translateEvent: thread lifecycle ------------------------------------

  it("translateEvent thread/started emits started + identity + name", () => {
    const adapter = createCodexProviderAdapter();
    const events = adapter.translateEvent(
      codexEvent("thread/started", {
        thread: {
          id: "codex-uuid-123",
          preview: "Fix the tests",
          ephemeral: false,
          modelProvider: "openai",
          createdAt: 0,
          updatedAt: 0,
          status: { type: "idle" },
          path: null,
          cwd: "/tmp",
          cliVersion: "0.1",
          source: "appServer",
          agentNickname: null,
          agentRole: null,
          gitInfo: null,
          name: null,
          turns: [],
        },
      }),
    );
    expect(events).toContainEqual({ type: "thread/started", threadId: "codex-uuid-123" });
    expect(events).toContainEqual({
      type: "thread/identity",
      threadId: "codex-uuid-123",
      providerThreadId: "codex-uuid-123",
    });
    expect(events).toContainEqual({
      type: "thread/name/updated",
      threadId: "codex-uuid-123",
      providerThreadId: "codex-uuid-123",
      threadName: "Fix the tests",
    });
  });

  it("translateEvent thread/name/updated", () => {
    const adapter = createCodexProviderAdapter();
    const events = adapter.translateEvent(
      codexEvent("thread/name/updated", { threadId: "t1", threadName: "Updated title" }),
    );
    expect(events).toContainEqual({
      type: "thread/name/updated",
      threadId: "t1",
      providerThreadId: "t1",
      threadName: "Updated title",
    });
  });

  it("translateEvent thread/name/updated ignores empty name", () => {
    const adapter = createCodexProviderAdapter();
    const events = adapter.translateEvent(
      codexEvent("thread/name/updated", { threadId: "t1" }),
    );
    expect(events).toHaveLength(0);
  });

  it("translateEvent thread/compacted emits a compacted event", () => {
    const adapter = createCodexProviderAdapter();
    const events = adapter.translateEvent(
      codexEvent("thread/compacted", { threadId: "t1", turnId: "turn-1" }),
    );
    expect(events).toContainEqual({
      type: "thread/compacted",
      threadId: "t1",
      providerThreadId: "t1",
    });
  });

  // -- translateEvent: items -----------------------------------------------

  it("translateEvent item/started with agentMessage", () => {
    const adapter = createCodexProviderAdapter();
    const events = adapter.translateEvent(
      codexEvent("item/started", {
        threadId: "t1",
        turnId: "turn-1",
        item: { type: "agentMessage", id: "item-1", text: "Hello", phase: null, memoryCitation: null },
      }),
    );
    expect(events).toContainEqual({
      type: "item/started",
      threadId: "t1",
      providerThreadId: "t1",
      turnId: "turn-1",
      item: { type: "agentMessage", id: "item-1", text: "Hello" },
    });
  });

  it("translateEvent item/started with userMessage preserves supported content", () => {
    const adapter = createCodexProviderAdapter();
    const events = adapter.translateEvent(
      codexEvent("item/started", {
        threadId: "t1",
        turnId: "turn-1",
        item: {
          type: "userMessage",
          id: "user-1",
          content: [
            { type: "text", text: "hello", text_elements: [] },
            { type: "image", url: "https://example.com/image.png" },
            { type: "localImage", path: "/tmp/image.png" },
            { type: "skill", name: "repo-research", path: "/tmp/SKILL.md" },
          ],
        },
      }),
    );
    expect(events).toContainEqual({
      type: "item/started",
      threadId: "t1",
      providerThreadId: "t1",
      turnId: "turn-1",
      item: {
        type: "userMessage",
        id: "user-1",
        content: [
          { type: "text", text: "hello" },
          { type: "image", url: "https://example.com/image.png" },
          { type: "localImage", path: "/tmp/image.png" },
          { type: "text", text: "[skill: repo-research]" },
        ],
      },
    });
  });

  it("translateEvent item/started with unsupported item type falls back to provider/unhandled", () => {
    const adapter = createCodexProviderAdapter();
    const events = adapter.translateEvent(
      codexEvent("item/started", {
        threadId: "t1",
        turnId: "turn-1",
        item: {
          type: "imageView",
          id: "image-1",
          path: "/tmp/image.png",
        },
      }),
    );

    expect(events).toContainEqual(
      expect.objectContaining({
        type: "provider/unhandled",
        providerId: "codex",
        rawType: "item/started",
        threadId: "t1",
        turnId: "turn-1",
        detailEntries: [{ label: "item", value: "imageView" }],
      }),
    );
  });

  it("translateEvent unknown codex notifications fall back to provider/unhandled", () => {
    const adapter = createCodexProviderAdapter();
    const events = adapter.translateEvent({
      jsonrpc: "2.0",
      method: "item/tool/requestUserInput",
      params: {
        threadId: "t1",
        turnId: "turn-1",
      },
    });

    expect(events).toContainEqual(
      expect.objectContaining({
        type: "provider/unhandled",
        providerId: "codex",
        rawType: "item/tool/requestUserInput",
        threadId: "t1",
        turnId: "turn-1",
      }),
    );
  });

  it("translateEvent item/mcpToolCall/progress maps to shared tool progress", () => {
    const adapter = createCodexProviderAdapter();
    const events = adapter.translateEvent(
      codexEvent("item/mcpToolCall/progress", {
        threadId: "t1",
        turnId: "turn-1",
        itemId: "mcp-1",
        message: "Connecting to MCP server",
      }),
    );

    expect(events).toContainEqual({
      type: "item/toolCall/progress",
      threadId: "t1",
      providerThreadId: "t1",
      turnId: "turn-1",
      itemId: "mcp-1",
      message: "Connecting to MCP server",
    });
  });

  it("translateEvent item/completed with commandExecution maps status", () => {
    const adapter = createCodexProviderAdapter();
    const events = adapter.translateEvent(
      codexEvent("item/completed", {
        threadId: "t1",
        turnId: "turn-1",
        item: {
          type: "commandExecution",
          id: "cmd-1",
          command: "ls -la",
          cwd: "/tmp",
          processId: null,
          status: "completed",
          commandActions: [],
          aggregatedOutput: "file1\nfile2",
          exitCode: 0,
          durationMs: 150,
        },
      }),
    );
    expect(events).toContainEqual({
      type: "item/completed",
      threadId: "t1",
      providerThreadId: "t1",
      turnId: "turn-1",
      item: expect.objectContaining({
        type: "commandExecution",
        id: "cmd-1",
        command: "ls -la",
        status: "completed",
        exitCode: 0,
        durationMs: 150,
      }),
    });
  });

  it("translateEvent item/completed with fileChange maps kind correctly", () => {
    const adapter = createCodexProviderAdapter();
    const events = adapter.translateEvent(
      codexEvent("item/completed", {
        threadId: "t1",
        turnId: "turn-1",
        item: {
          type: "fileChange",
          id: "fc-1",
          changes: [
            { path: "src/foo.ts", kind: { type: "update", move_path: null }, diff: "+line" },
            { path: "src/bar.ts", kind: { type: "add" }, diff: "" },
          ],
          status: "completed",
        },
      }),
    );
    const itemEvent = events.find((e) => e.type === "item/completed");
    expect(itemEvent).toBeDefined();
    if (itemEvent?.type === "item/completed" && itemEvent.item.type === "fileChange") {
      expect(itemEvent.item.changes).toEqual([
        { path: "src/foo.ts", kind: "update", movePath: undefined, diff: "+line" },
        { path: "src/bar.ts", kind: "add", movePath: undefined, diff: undefined },
      ]);
      expect(itemEvent.item.status).toBe("completed");
    }
  });

  it("translateEvent item/completed with mcpToolCall maps to toolCall", () => {
    const adapter = createCodexProviderAdapter();
    const events = adapter.translateEvent(
      codexEvent("item/completed", {
        threadId: "t1",
        turnId: "turn-1",
        item: {
          type: "mcpToolCall",
          id: "mcp-1",
          server: "myserver",
          tool: "search",
          status: "completed",
          arguments: { query: "test" },
          result: null,
          error: null,
          durationMs: 200,
        },
      }),
    );
    expect(events).toContainEqual({
      type: "item/completed",
      threadId: "t1",
      providerThreadId: "t1",
      turnId: "turn-1",
      item: expect.objectContaining({
        type: "toolCall",
        id: "mcp-1",
        server: "myserver",
        tool: "search",
        status: "completed",
        durationMs: 200,
      }),
    });
  });

  it("translateEvent item/completed with dynamicToolCall maps to toolCall", () => {
    const adapter = createCodexProviderAdapter();
    const events = adapter.translateEvent(
      codexEvent("item/completed", {
        threadId: "t1",
        turnId: "turn-1",
        item: {
          type: "dynamicToolCall",
          id: "dyn-1",
          tool: "bb_test_ping",
          arguments: {},
          status: "completed",
          contentItems: [{ type: "inputText", text: "PONG_FROM_TOOL" }],
          success: true,
          durationMs: 3,
        },
      }),
    );
    expect(events).toContainEqual({
      type: "item/completed",
      threadId: "t1",
      providerThreadId: "t1",
      turnId: "turn-1",
      item: expect.objectContaining({
        type: "toolCall",
        id: "dyn-1",
        tool: "bb_test_ping",
        status: "completed",
        result: "PONG_FROM_TOOL",
        durationMs: 3,
      }),
    });
  });

  it("translateEvent item/completed with failed dynamicToolCall preserves textual errors", () => {
    const adapter = createCodexProviderAdapter();
    const events = adapter.translateEvent({
      jsonrpc: "2.0",
      method: "item/completed",
      params: {
        threadId: "t1",
        turnId: "turn-1",
        item: {
          type: "dynamicToolCall",
          id: "dyn-err-1",
          tool: "bb_test_ping",
          arguments: {},
          status: "failed",
          contentItems: [{ type: "inputText", text: "permission denied" }],
          success: false,
          durationMs: 8,
        },
      },
    });

    expect(events).toContainEqual({
      type: "item/completed",
      threadId: "t1",
      providerThreadId: "t1",
      turnId: "turn-1",
      item: expect.objectContaining({
        type: "toolCall",
        id: "dyn-err-1",
        status: "failed",
        result: "permission denied",
        error: "permission denied",
      }),
    });
  });

  it("translateEvent item/completed with image-only dynamicToolCall keeps readable output", () => {
    const adapter = createCodexProviderAdapter();
    const events = adapter.translateEvent(
      codexEvent("item/completed", {
        threadId: "t1",
        turnId: "turn-1",
        item: {
          type: "dynamicToolCall",
          id: "dyn-img-1",
          tool: "bb_test_image",
          arguments: {},
          status: "failed",
          contentItems: [{ type: "inputImage", imageUrl: "https://example.com/tool-result.png" }],
          success: false,
          durationMs: 4,
        },
      }),
    );

    expect(events).toContainEqual({
      type: "item/completed",
      threadId: "t1",
      providerThreadId: "t1",
      turnId: "turn-1",
      item: expect.objectContaining({
        type: "toolCall",
        id: "dyn-img-1",
        status: "failed",
        result: "[image: https://example.com/tool-result.png]",
        error: "[image: https://example.com/tool-result.png]",
      }),
    });
  });

  it("translateEvent item/completed with collabAgentToolCall maps to toolCall", () => {
    const adapter = createCodexProviderAdapter();
    const events = adapter.translateEvent(
      codexEvent("item/completed", {
        threadId: "t1",
        turnId: "turn-1",
        item: {
          type: "collabAgentToolCall",
          id: "collab-1",
          tool: "spawnAgent",
          status: "completed",
          senderThreadId: "t1",
          receiverThreadIds: ["sub-thread-1"],
          prompt: "Inspect the docs directory",
          model: "gpt-5.4",
          reasoningEffort: "medium",
          agentsStates: {
            "sub-thread-1": { status: "completed", message: "done" },
          },
        },
      }),
    );
    expect(events).toContainEqual({
      type: "item/completed",
      threadId: "t1",
      providerThreadId: "t1",
      turnId: "turn-1",
      item: expect.objectContaining({
        type: "toolCall",
        id: "collab-1",
        tool: "spawnAgent",
        status: "completed",
        arguments: expect.objectContaining({
          senderThreadId: "t1",
          receiverThreadIds: ["sub-thread-1"],
          prompt: "Inspect the docs directory",
          model: "gpt-5.4",
          reasoningEffort: "medium",
        }),
        result: {
          "sub-thread-1": { status: "completed", message: "done" },
        },
      }),
    });
  });

  it("translateEvent item/completed with declined collabAgentToolCall maps to interrupted", () => {
    const adapter = createCodexProviderAdapter();
    const events = adapter.translateEvent({
      jsonrpc: "2.0",
      method: "item/completed",
      params: {
        threadId: "t1",
        turnId: "turn-1",
        item: {
          type: "collabAgentToolCall",
          id: "collab-declined-1",
          tool: "spawnAgent",
          status: "declined",
          senderThreadId: "t1",
          receiverThreadIds: ["sub-thread-1"],
          prompt: null,
          model: null,
          reasoningEffort: null,
          agentsStates: {},
        },
      },
    });

    expect(events).toContainEqual({
      type: "item/completed",
      threadId: "t1",
      providerThreadId: "t1",
      turnId: "turn-1",
      item: expect.objectContaining({
        type: "toolCall",
        id: "collab-declined-1",
        status: "interrupted",
      }),
    });
  });

  it("translateEvent item/completed with webSearch maps to webSearch", () => {
    const adapter = createCodexProviderAdapter();
    const events = adapter.translateEvent(
      codexEvent("item/completed", {
        threadId: "t1",
        turnId: "turn-1",
        item: {
          type: "webSearch",
          id: "web-1",
          query: "react suspense",
          action: { type: "search", query: "react suspense", queries: null },
        },
      }),
    );
    expect(events).toContainEqual({
      type: "item/completed",
      threadId: "t1",
      providerThreadId: "t1",
      turnId: "turn-1",
      item: {
        type: "webSearch",
        id: "web-1",
        query: "react suspense",
        action: "search",
      },
    });
  });

  it("translateEvent item/completed with reasoning maps to reasoning", () => {
    const adapter = createCodexProviderAdapter();
    const events = adapter.translateEvent(
      codexEvent("item/completed", {
        threadId: "t1",
        turnId: "turn-1",
        item: {
          type: "reasoning",
          id: "reasoning-1",
          summary: ["Read the search flow"],
          content: ["Investigated the search sidebar state machine."],
        },
      }),
    );
    expect(events).toContainEqual({
      type: "item/completed",
      threadId: "t1",
      providerThreadId: "t1",
      turnId: "turn-1",
      item: {
        type: "reasoning",
        id: "reasoning-1",
        summary: ["Read the search flow"],
        content: ["Investigated the search sidebar state machine."],
      },
    });
  });

  it("translateEvent item/completed with plan maps to plan", () => {
    const adapter = createCodexProviderAdapter();
    const events = adapter.translateEvent(
      codexEvent("item/completed", {
        threadId: "t1",
        turnId: "turn-1",
        item: {
          type: "plan",
          id: "plan-1",
          text: "1. Read the file\n2. Edit the function",
        },
      }),
    );
    expect(events).toContainEqual({
      type: "item/completed",
      threadId: "t1",
      providerThreadId: "t1",
      turnId: "turn-1",
      item: {
        type: "plan",
        id: "plan-1",
        text: "1. Read the file\n2. Edit the function",
      },
    });
  });

  it("translateEvent item/started with contextCompaction maps to contextCompaction", () => {
    const adapter = createCodexProviderAdapter();
    const events = adapter.translateEvent(
      codexEvent("item/started", {
        threadId: "t1",
        turnId: "turn-1",
        item: {
          type: "contextCompaction",
          id: "compact-1",
        },
      }),
    );
    expect(events).toContainEqual({
      type: "item/started",
      threadId: "t1",
      providerThreadId: "t1",
      turnId: "turn-1",
      item: {
        type: "contextCompaction",
        id: "compact-1",
      },
    });
  });

  // -- translateEvent: streaming deltas ------------------------------------

  it("translateEvent item/agentMessage/delta", () => {
    const adapter = createCodexProviderAdapter();
    const events = adapter.translateEvent(
      codexEvent("item/agentMessage/delta", {
        threadId: "t1",
        turnId: "turn-1",
        itemId: "item-1",
        delta: "hello ",
      }),
    );
    expect(events).toContainEqual({
      type: "item/agentMessage/delta",
      threadId: "t1",
      providerThreadId: "t1",
      turnId: "turn-1",
      itemId: "item-1",
      delta: "hello ",
    });
  });

  it("translateEvent item/commandExecution/outputDelta", () => {
    const adapter = createCodexProviderAdapter();
    const events = adapter.translateEvent(
      codexEvent("item/commandExecution/outputDelta", {
        threadId: "t1",
        turnId: "turn-1",
        itemId: "cmd-1",
        delta: "output line\n",
      }),
    );
    expect(events).toContainEqual({
      type: "item/commandExecution/outputDelta",
      threadId: "t1",
      providerThreadId: "t1",
      turnId: "turn-1",
      itemId: "cmd-1",
      delta: "output line\n",
    });
  });

  // -- translateEvent: token usage -----------------------------------------

  it("translateEvent thread/tokenUsage/updated", () => {
    const adapter = createCodexProviderAdapter();
    const events = adapter.translateEvent(
      codexEvent("thread/tokenUsage/updated", {
        threadId: "t1",
        turnId: "turn-1",
        tokenUsage: {
          total: { totalTokens: 100, inputTokens: 60, cachedInputTokens: 10, outputTokens: 30, reasoningOutputTokens: 0 },
          last: { totalTokens: 50, inputTokens: 30, cachedInputTokens: 5, outputTokens: 15, reasoningOutputTokens: 0 },
          modelContextWindow: 128000,
        },
      }),
    );
    expect(events).toContainEqual(
      expect.objectContaining({
        type: "thread/tokenUsage/updated",
        threadId: "t1",
        tokenUsage: expect.objectContaining({
          total: expect.objectContaining({ totalTokens: 100 }),
          modelContextWindow: 128000,
        }),
      }),
    );
  });

  // -- translateEvent: plan/diff -------------------------------------------

  it("translateEvent turn/plan/updated maps step statuses", () => {
    const adapter = createCodexProviderAdapter();
    const events = adapter.translateEvent(
      codexEvent("turn/plan/updated", {
        threadId: "t1",
        turnId: "turn-1",
        explanation: "Here's the plan",
        plan: [
          { step: "Read the file", status: "completed" },
          { step: "Edit the function", status: "inProgress" },
          { step: "Run tests", status: "pending" },
        ],
      }),
    );
    expect(events).toContainEqual({
      type: "turn/plan/updated",
      threadId: "t1",
      providerThreadId: "t1",
      turnId: "turn-1",
      explanation: "Here's the plan",
      plan: [
        { step: "Read the file", status: "completed" },
        { step: "Edit the function", status: "active" },
        { step: "Run tests", status: "pending" },
      ],
    });
  });

  it("translateEvent turn/plan/updated tolerates null explanations", () => {
    const adapter = createCodexProviderAdapter();
    const events = adapter.translateEvent({
      method: "turn/plan/updated",
      params: {
        threadId: "t1",
        turnId: "turn-1",
        explanation: null,
        plan: [
          { step: "Read the file", status: "completed" },
          { step: "Run tests", status: "pending" },
        ],
      },
    });

    expect(events).toContainEqual({
      type: "turn/plan/updated",
      threadId: "t1",
      providerThreadId: "t1",
      turnId: "turn-1",
      plan: [
        { step: "Read the file", status: "completed" },
        { step: "Run tests", status: "pending" },
      ],
    });
  });

  // -- translateEvent: errors ----------------------------------------------

  it("translateEvent error includes detail and willRetry", () => {
    const adapter = createCodexProviderAdapter();
    const events = adapter.translateEvent(
      codexEvent("error", {
        threadId: "t1",
        turnId: "turn-1",
        error: {
          message: "Rate limited",
          codexErrorInfo: null,
          additionalDetails: "retry after 30s",
        },
        willRetry: true,
      }),
    );
    expect(events).toContainEqual({
      type: "error",
      threadId: "t1",
      providerThreadId: "t1",
      turnId: "turn-1",
      message: "Provider error",
      detail: "Rate limited\nretry after 30s",
      willRetry: true,
    });
  });

  // -- translateEvent: warnings --------------------------------------------

  it("translateEvent deprecationNotice maps to warning", () => {
    const adapter = createCodexProviderAdapter();
    const events = adapter.translateEvent(
      codexEvent("deprecationNotice", {
        summary: "Model deprecated",
        details: "Use newer model",
      }),
    );
    expect(events).toContainEqual({
      type: "warning",
      threadId: "",
      providerThreadId: "",
      category: "deprecation",
      summary: "Model deprecated",
      details: "Use newer model",
    });
  });

  it("translateEvent configWarning maps to warning", () => {
    const adapter = createCodexProviderAdapter();
    const events = adapter.translateEvent(
      codexEvent("configWarning", {
        summary: "Bad config",
        details: null,
      }),
    );
    expect(events).toContainEqual({
      type: "warning",
      threadId: "",
      providerThreadId: "",
      category: "config",
      summary: "Bad config",
      details: undefined,
    });
  });

  // -- translateEvent: unknown events --------------------------------------

  it("translateEvent returns empty for unhandled codex events", () => {
    const adapter = createCodexProviderAdapter();
    const events = adapter.translateEvent(
      codexEvent("account/rateLimits/updated", {
        rateLimits: {
          limitId: null,
          limitName: null,
          primary: null,
          secondary: null,
          credits: null,
          planType: null,
        },
      }),
    );
    expect(events).toEqual([]);
  });

  it("decodeToolCallRequest preserves numeric request ids", () => {
    const adapter = createCodexProviderAdapter();
    expect(
      adapter.decodeToolCallRequest({
        jsonrpc: "2.0",
        id: 7,
        method: "item/tool/call",
        params: {
          threadId: "t1",
          turnId: "turn-1",
          callId: "call-1",
          tool: "bb_test_ping",
          arguments: { ping: true },
        },
      }),
    ).toEqual({
      requestId: 7,
      providerThreadId: "t1",
      turnId: "turn-1",
      callId: "call-1",
      tool: "bb_test_ping",
      arguments: { ping: true },
    });
  });

  it("decodeToolCallRequest returns null when the request id is missing", () => {
    const adapter = createCodexProviderAdapter();
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

  // -- listModels ----------------------------------------------------------

  it("parseModelListResult validates model/list payloads", () => {
    const adapter = createCodexProviderAdapter();
    expect(
      adapter.parseModelListResult({
        data: [
          {
            id: "codex-mini",
            model: "codex-mini",
            displayName: "Codex Mini",
            description: "Fast coding model",
            supportedReasoningEfforts: [],
            defaultReasoningEffort: "medium",
            isDefault: true,
          },
        ],
      }),
    ).toHaveLength(1);
  });
});
