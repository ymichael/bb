import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { threadScope, turnScope } from "@bb/domain";
import type { AgentSessionEvent } from "@mariozechner/pi-coding-agent";
import { createPiProviderAdapter } from "./adapter.js";
import { buildPiAvailableModels } from "./model-list.js";
import type { ProviderExecutionContext } from "../provider-adapter.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const FIXTURES = resolve(__dirname, "../__fixtures__/pi");

function loadFixture(name: string): AgentSessionEvent {
  return JSON.parse(
    readFileSync(resolve(FIXTURES, name), "utf8"),
  ) as AgentSessionEvent;
}

const fullProviderExecutionContext = {
  permissionMode: "full",
  permissionEscalation: null,
} satisfies ProviderExecutionContext;

type PiProviderAdapter = ReturnType<typeof createPiProviderAdapter>;

interface PiTestThreadContext {
  threadId: string;
}

interface PiBashStartEventArgs {
  command: string;
  cwd?: string;
  toolCallId: string;
}

function createPiBashStartEvent(args: PiBashStartEventArgs): AgentSessionEvent {
  return {
    type: "tool_execution_start",
    toolCallId: args.toolCallId,
    toolName: "bash",
    args: {
      command: args.command,
      cwd: args.cwd ?? "/repo",
    },
  };
}

interface PiBashUpdateEventArgs {
  text: string;
  threadId: string;
  toolCallId: string;
}

function createPiBashUpdateEvent(args: PiBashUpdateEventArgs) {
  return {
    jsonrpc: "2.0" as const,
    method: "sdk/message",
    params: {
      threadId: args.threadId,
      message: {
        type: "tool_execution_update" as const,
        toolCallId: args.toolCallId,
        toolName: "bash" as const,
        partialResult: {
          content: [{ type: "text" as const, text: args.text }],
        },
      },
    },
  };
}

interface SeedPiBashSnapshotArgs {
  adapter: PiProviderAdapter;
  context: PiTestThreadContext;
  toolCallId: string;
}

function seedPiBashOutputSnapshot(args: SeedPiBashSnapshotArgs): void {
  args.adapter.translateEvent(loadFixture("agent-start.json"), args.context);
  args.adapter.translateEvent(
    createPiBashStartEvent({
      toolCallId: args.toolCallId,
      command: "printf 'FIRST\\n'",
    }),
    args.context,
  );
  args.adapter.translateEvent(
    createPiBashUpdateEvent({
      threadId: args.context.threadId,
      toolCallId: args.toolCallId,
      text: "FIRST\n",
    }),
    args.context,
  );
}

interface ExpectPiBashSnapshotResetArgs {
  adapter: PiProviderAdapter;
  context: PiTestThreadContext;
  reset: () => void;
  toolCallId: string;
}

function expectPiBashSnapshotReset(args: ExpectPiBashSnapshotResetArgs): void {
  args.reset();
  args.adapter.translateEvent(loadFixture("agent-start.json"), args.context);
  args.adapter.translateEvent(
    createPiBashStartEvent({
      toolCallId: args.toolCallId,
      command: "printf 'FIRST\\nSECOND\\n'",
    }),
    args.context,
  );

  const events = args.adapter.translateEvent(
    createPiBashUpdateEvent({
      threadId: args.context.threadId,
      toolCallId: args.toolCallId,
      text: "FIRST\nSECOND\n",
    }),
    args.context,
  );

  expect(events).toContainEqual(
    expect.objectContaining({
      type: "item/commandExecution/outputDelta",
      itemId: args.toolCallId,
      delta: "FIRST\nSECOND\n",
    }),
  );
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
      supportedPermissionModes: ["full"],
    });
  });

  it("translates accepted steers to input accepted events", () => {
    const adapter = createPiProviderAdapter();

    expect(
      adapter.translateAcceptedCommand({
        command: {
          type: "turn/steer",
          threadId: "thread-1",
          providerThreadId: "provider-thread-1",
          expectedTurnId: "turn-1",
          clientRequestSequence: 9,
          input: [{ type: "text", text: "steer turn" }],
          options: fullProviderExecutionContext,
        },
      }),
    ).toEqual([
      {
        type: "turn/input/accepted",
        threadId: "thread-1",
        providerThreadId: "provider-thread-1",
        scope: turnScope("turn-1"),
        clientRequestSequence: 9,
      },
    ]);
  });

  it("translateEvent completes a failed turn for thread-scoped bridge errors", () => {
    const adapter = createPiProviderAdapter();

    const events = adapter.translateEvent(
      {
        jsonrpc: "2.0",
        method: "error",
        params: {
          message: "No API key found for openai.",
        },
      },
      { threadId: "bb-thread-1" },
    );

    expect(events).toEqual([
      {
        type: "turn/started",
        threadId: "",
        providerThreadId: "",
        scope: turnScope("turn-1"),
      },
      {
        type: "provider/error",
        threadId: "",
        providerThreadId: "",
        scope: turnScope("turn-1"),
        message: "Provider error",
        detail: "No API key found for openai.",
      },
      {
        type: "turn/completed",
        threadId: "",
        providerThreadId: "",
        scope: turnScope("turn-1"),
        status: "failed",
      },
    ]);
  });

  // -- buildCommand --------------------------------------------------------

  it("buildCommand thread/start includes threadId and omits instruction overrides when empty", () => {
    const adapter = createPiProviderAdapter();
    const cmd = adapter.buildCommandPlan({
      type: "thread/start",
      cwd: "/tmp/worktree",
      threadId: "t1",
      input: [{ type: "text", text: "hello" }],
      instructionMode: "append",
      options: fullProviderExecutionContext,
    });
    expect(cmd).toMatchObject({
      method: "thread/start",
      params: {
        threadId: "t1",
        cwd: "/tmp/worktree",
      },
    });
    expect(cmd).not.toMatchObject({
      params: {
        baseInstructions: expect.any(String),
      },
    });
    expect(cmd).not.toMatchObject({
      params: {
        appendSystemPrompt: expect.any(String),
      },
    });
  });

  it("buildCommand thread/start passes through model, env vars, append instructions, reasoning level, and dynamic tools", () => {
    const adapter = createPiProviderAdapter();
    const cmd = adapter.buildCommandPlan({
      type: "thread/start",
      cwd: "/tmp/worktree",
      threadId: "bb-thread-1",
      input: [{ type: "text", text: "hello" }],
      instructionMode: "append",
      options: {
        ...fullProviderExecutionContext,
        model: "anthropic/claude-sonnet-4-20250514",
        instructions: "Focus on the failing tests first.",
        reasoningLevel: "high",
        envVars: {
          "BAD.KEY": "ignored",
          TEST_VAR: "123",
        },
      },
      dynamicTools: [
        {
          name: "bb_test_ping",
          description: "Ping the host",
          inputSchema: {
            type: "object",
            properties: {
              ping: { type: "boolean" },
            },
            required: ["ping"],
          },
        },
      ],
    });

    expect(cmd).toMatchObject({
      method: "thread/start",
      params: {
        threadId: "bb-thread-1",
        model: "anthropic/claude-sonnet-4-20250514",
        reasoningLevel: "high",
        appendSystemPrompt: "Focus on the failing tests first.",
        dynamicTools: [
          {
            name: "bb_test_ping",
            description: "Ping the host",
            inputSchema: {
              type: "object",
              properties: {
                ping: { type: "boolean" },
              },
              required: ["ping"],
            },
          },
        ],
      },
    });
    expect(cmd).not.toMatchObject({
      params: {
        baseInstructions: expect.any(String),
      },
    });
    expect(
      (cmd as { params: { config?: Record<string, unknown> } }).params.config,
    ).toMatchObject({
      "shell_environment_policy.set.BB_THREAD_ID": "bb-thread-1",
      "shell_environment_policy.set.TEST_VAR": "123",
    });
    expect(cmd).not.toMatchObject({
      params: {
        config: {
          "shell_environment_policy.set.BAD.KEY": "ignored",
        },
      },
    });
  });

  it("buildCommand thread/start uses baseInstructions for replace instructions", () => {
    const adapter = createPiProviderAdapter();
    const cmd = adapter.buildCommandPlan({
      type: "thread/start",
      cwd: "/tmp/worktree",
      threadId: "bb-thread-replace",
      input: [{ type: "text", text: "hello" }],
      instructionMode: "replace",
      options: {
        ...fullProviderExecutionContext,
        instructions: "Replace the provider prompt.",
      },
    });

    expect(cmd).toMatchObject({
      method: "thread/start",
      params: {
        threadId: "bb-thread-replace",
        baseInstructions: "Replace the provider prompt.",
      },
    });
    expect(cmd).not.toMatchObject({
      params: {
        appendSystemPrompt: expect.any(String),
      },
    });
  });

  it("buildCommand thread/resume routes to provider thread id", () => {
    const adapter = createPiProviderAdapter();
    const cmd = adapter.buildCommandPlan({
      type: "thread/resume",
      cwd: "/tmp/worktree",
      threadId: "bb-t1",
      providerThreadId: "pi-session-1",
      instructionMode: "append",
      options: fullProviderExecutionContext,
    });
    expect(cmd).toMatchObject({
      method: "thread/resume",
      params: {
        threadId: "pi-session-1",
        cwd: "/tmp/worktree",
      },
    });
  });

  it("buildCommand thread/resume uses appendSystemPrompt for append instructions", () => {
    const adapter = createPiProviderAdapter();
    const cmd = adapter.buildCommandPlan({
      type: "thread/resume",
      cwd: "/tmp/worktree",
      threadId: "bb-t1",
      providerThreadId: "pi-session-1",
      instructionMode: "append",
      options: {
        ...fullProviderExecutionContext,
        instructions: "Keep responses brief.",
      },
    });
    expect(cmd).toMatchObject({
      method: "thread/resume",
      params: {
        threadId: "pi-session-1",
        appendSystemPrompt: "Keep responses brief.",
      },
    });
    expect(cmd).not.toMatchObject({
      params: {
        baseInstructions: expect.any(String),
      },
    });
  });

  it("buildCommand thread/stop maps to the bridge stop command", () => {
    const adapter = createPiProviderAdapter();
    const cmd = adapter.buildCommandPlan({
      type: "thread/stop",
      threadId: "bb-t1",
      providerThreadId: "pi-session-1",
      activeTurnId: "turn-1",
    });
    expect(cmd).toEqual({
      kind: "request",
      method: "thread/stop",
      params: {
        threadId: "pi-session-1",
      },
    });
  });

  it("buildCommand turn/start includes input", () => {
    const adapter = createPiProviderAdapter();
    const cmd = adapter.buildCommandPlan({
      type: "turn/start",
      threadId: "t1",
      providerThreadId: "pi-1",
      input: [{ type: "text", text: "do it" }],
      options: fullProviderExecutionContext,
    });
    expect(cmd).toMatchObject({
      method: "turn/start",
      params: { threadId: "pi-1" },
    });
  });

  it("buildCommand turn/steer includes expectedTurnId", () => {
    const adapter = createPiProviderAdapter();
    const cmd = adapter.buildCommandPlan({
      type: "turn/steer",
      threadId: "t1",
      providerThreadId: "pi-1",
      expectedTurnId: "turn-1",
      input: [{ type: "text", text: "steer" }],
      options: fullProviderExecutionContext,
    });
    expect(cmd).toMatchObject({
      method: "turn/steer",
      params: {
        threadId: "pi-1",
        expectedTurnId: "turn-1",
      },
    });
  });

  it("buildCommand thread/name/set returns an unsupported no-op", () => {
    const adapter = createPiProviderAdapter();
    expect(
      adapter.buildCommandPlan({
        type: "thread/name/set",
        threadId: "t1",
        providerThreadId: "p1",
        title: "hi",
      }),
    ).toEqual({
      kind: "noop",
      reason: "rename unsupported",
    });
  });

  it("decodeToolCallRequest preserves string request ids", () => {
    const adapter = createPiProviderAdapter();
    expect(
      adapter.decodeToolCallRequest({
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
      '{"jsonrpc":"2.0","id":true,"method":"item/tool/call","params":{"threadId":"t1","turnId":"turn-1","callId":"call-1","tool":"bb_test_ping","arguments":{"ping":true}}}',
    );

    expect(adapter.decodeToolCallRequest(malformedRequest)).toBeNull();
  });

  // -- translateEvent: turn lifecycle --------------------------------------

  it("translateEvent agent_start emits turn/started", () => {
    const adapter = createPiProviderAdapter();
    const events = adapter.translateEvent(loadFixture("agent-start.json"));

    expect(events).toContainEqual(
      expect.objectContaining({
        type: "turn/started",
        scope: turnScope("turn-1"),
      }),
    );
  });

  it("translateEvent keeps turn_start as internal noise while agent_start owns the bb turn", () => {
    const adapter = createPiProviderAdapter();
    adapter.translateEvent(loadFixture("agent-start.json"));

    const events = adapter.translateEvent({
      type: "turn_start",
    } as AgentSessionEvent);

    expect(events).toMatchObject([]);
  });

  it("translateEvent agent_end emits agentMessage + turn/completed", () => {
    const adapter = createPiProviderAdapter();
    // Start a turn first
    adapter.translateEvent(loadFixture("agent-start.json"));

    const events = adapter.translateEvent(
      loadFixture("agent-end-with-message.json"),
    );

    expect(events).toContainEqual(
      expect.objectContaining({
        type: "item/completed",
        item: expect.objectContaining({ type: "agentMessage" }),
      }),
    );
    expect(events).toContainEqual(
      expect.objectContaining({
        type: "turn/completed",
        scope: turnScope("turn-1"),
        status: "completed",
      }),
    );
  });

  it("translateEvent compaction_start emits a compaction item", () => {
    const adapter = createPiProviderAdapter();
    adapter.translateEvent(loadFixture("agent-start.json"));

    const event = {
      type: "compaction_start",
      reason: "threshold",
    } satisfies AgentSessionEvent;
    const events = adapter.translateEvent(event);

    expect(events).toContainEqual(
      expect.objectContaining({
        type: "item/started",
        threadId: "",
        providerThreadId: "",
        scope: turnScope("turn-1"),
        item: {
          type: "contextCompaction",
          id: "pi-compaction-turn-1",
        },
      }),
    );
  });

  it("translateEvent compaction_end emits thread/compacted", () => {
    const adapter = createPiProviderAdapter();
    adapter.translateEvent(loadFixture("agent-start.json"));
    const startEvent = {
      type: "compaction_start",
      reason: "threshold",
    } satisfies AgentSessionEvent;
    adapter.translateEvent(startEvent);

    const endEvent = {
      type: "compaction_end",
      reason: "threshold",
      result: undefined,
      aborted: false,
      willRetry: false,
    } satisfies AgentSessionEvent;
    const events = adapter.translateEvent(endEvent);

    expect(events).toContainEqual(
      expect.objectContaining({
        type: "thread/compacted",
        threadId: "",
        providerThreadId: "",
        scope: turnScope("turn-1"),
      }),
    );
  });

  it("translateEvent compaction_end without a known turn is unhandled", () => {
    const adapter = createPiProviderAdapter();
    const event = {
      type: "compaction_end",
      reason: "threshold",
      result: undefined,
      aborted: false,
      willRetry: false,
    } satisfies AgentSessionEvent;

    const events = adapter.translateEvent(event);

    expect(events).toContainEqual(
      expect.objectContaining({
        type: "provider/unhandled",
      }),
    );
  });

  it("translateEvent compaction_start reuses the last completed turn id without opening a new turn", () => {
    const adapter = createPiProviderAdapter();
    adapter.translateEvent(loadFixture("agent-start.json"));
    adapter.translateEvent(loadFixture("agent-end-with-message.json"));

    const event = {
      type: "compaction_start",
      reason: "threshold",
    } satisfies AgentSessionEvent;
    const events = adapter.translateEvent(event);

    expect(events).toEqual([
      {
        type: "item/started",
        threadId: "",
        providerThreadId: "",
        scope: turnScope("turn-1"),
        item: {
          type: "contextCompaction",
          id: "pi-compaction-turn-1",
        },
      },
    ]);
  });

  // -- translateEvent: streaming -------------------------------------------

  it("translateEvent message_update emits agentMessage delta", () => {
    const adapter = createPiProviderAdapter();
    // Start a turn first
    adapter.translateEvent(loadFixture("agent-start.json"));

    const events = adapter.translateEvent(
      loadFixture("message-update-delta.json"),
    );

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

    const deltaEvents = adapter.translateEvent(
      loadFixture("message-update-delta.json"),
    );
    const deltaEvent = deltaEvents.find(
      (
        event,
      ): event is Extract<
        (typeof deltaEvents)[number],
        { type: "item/agentMessage/delta" }
      > => event.type === "item/agentMessage/delta",
    );
    const completedEvents = adapter.translateEvent(
      loadFixture("agent-end-with-message.json"),
    );

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
    const preDelta = adapter.translateEvent(
      loadFixture("message-update-delta.json"),
    );
    const preItemId = preDelta.find(
      (
        e,
      ): e is Extract<
        (typeof preDelta)[number],
        { type: "item/agentMessage/delta" }
      > => e.type === "item/agentMessage/delta",
    )?.itemId;

    // Tool call starts — should close the assistant scope
    adapter.translateEvent({
      type: "tool_execution_start",
      toolCallId: "tool-bash-1",
      toolName: "bash",
      args: { command: "ls" },
    });

    // Stream assistant text after tool call
    const postDelta = adapter.translateEvent(
      loadFixture("message-update-delta.json"),
    );
    const postItemId = postDelta.find(
      (
        e,
      ): e is Extract<
        (typeof postDelta)[number],
        { type: "item/agentMessage/delta" }
      > => e.type === "item/agentMessage/delta",
    )?.itemId;

    // Completed assistant message at agent_end should use the post-tool id
    const endEvents = adapter.translateEvent(
      loadFixture("agent-end-with-message.json"),
    );
    const completedId = endEvents.find(
      (e) => e.type === "item/completed" && e.item.type === "agentMessage",
    );

    expect(preItemId).toMatch(/^pi-assistant-/);
    expect(postItemId).toMatch(/^pi-assistant-/);
    expect(preItemId).not.toBe(postItemId);
    expect(completedId).toBeDefined();
    if (
      completedId?.type === "item/completed" &&
      completedId.item.type === "agentMessage"
    ) {
      expect(completedId.item.id).toBe(postItemId);
    }
  });

  it("translateEvent streams and finalizes Pi thinking with a stable reasoning id", () => {
    const adapter = createPiProviderAdapter();
    adapter.translateEvent(loadFixture("agent-start.json"));

    const deltaEvents = adapter.translateEvent({
      type: "message_update",
      assistantMessageEvent: {
        type: "thinking_delta",
        contentIndex: 0,
        delta: "Thinking through the edit.",
      },
    } as AgentSessionEvent);
    const reasoningDelta = deltaEvents.find(
      (
        event,
      ): event is Extract<
        (typeof deltaEvents)[number],
        { type: "item/reasoning/textDelta" }
      > => event.type === "item/reasoning/textDelta",
    );

    const completedEvents = adapter.translateEvent({
      type: "message_update",
      assistantMessageEvent: {
        type: "thinking_end",
        contentIndex: 0,
        content: "Thinking through the edit.",
      },
    } as AgentSessionEvent);

    expect(reasoningDelta?.itemId).toMatch(/^pi-reasoning-/);
    expect(completedEvents).toContainEqual(
      expect.objectContaining({
        type: "item/completed",
        item: expect.objectContaining({
          type: "reasoning",
          id: reasoningDelta?.itemId,
          content: ["Thinking through the edit."],
        }),
      }),
    );
  });

  it("translateEvent surfaces Pi thinking without contentIndex as provider/unhandled", () => {
    const adapter = createPiProviderAdapter();
    adapter.translateEvent(loadFixture("agent-start.json"));

    const events = adapter.translateEvent({
      type: "message_update",
      assistantMessageEvent: {
        type: "thinking_delta",
        delta: "Thinking without a scope.",
      },
    } as AgentSessionEvent);

    expect(events).toEqual([
      expect.objectContaining({
        type: "provider/unhandled",
        providerId: "pi",
        rawType: "sdk/message_update:thinking_delta",
        scope: turnScope("turn-1"),
      }),
    ]);
  });

  // -- translateEvent: tool calls ------------------------------------------

  it("translateEvent tool_execution_start emits item/started", () => {
    const adapter = createPiProviderAdapter();
    // Start a turn first
    adapter.translateEvent(loadFixture("agent-start.json"));

    const events = adapter.translateEvent(
      loadFixture("tool-execution-start-bash.json"),
    );

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
        scope: threadScope(),
        rawEvent: expect.objectContaining({
          method: "sdk/message",
        }),
      }),
    ]);
  });

  it("translateEvent scopes unknown sdk envelopes to the active turn", () => {
    const adapter = createPiProviderAdapter();
    const context = { threadId: "pi-thread-1" };
    adapter.translateEvent(loadFixture("agent-start.json"), context);

    const events = adapter.translateEvent(
      {
        jsonrpc: "2.0",
        method: "sdk/message",
        params: {
          threadId: "pi-thread-1",
          message: {
            type: "future_event",
            value: true,
          },
        },
      },
      context,
    );

    expect(events).toEqual([
      expect.objectContaining({
        type: "provider/unhandled",
        providerId: "pi",
        scope: turnScope("turn-1"),
        rawEvent: expect.objectContaining({
          method: "sdk/message",
        }),
      }),
    ]);
  });

  it("translateEvent keeps late unknown sdk envelopes thread scoped", () => {
    const adapter = createPiProviderAdapter();
    const context = { threadId: "pi-thread-1" };
    adapter.translateEvent(loadFixture("agent-start.json"), context);
    adapter.translateEvent(loadFixture("agent-end-with-message.json"), context);

    const events = adapter.translateEvent(
      {
        jsonrpc: "2.0",
        method: "sdk/message",
        params: {
          threadId: "pi-thread-1",
          message: {
            type: "future_event",
            value: true,
          },
        },
      },
      context,
    );

    expect(events).toEqual([
      expect.objectContaining({
        type: "provider/unhandled",
        providerId: "pi",
        scope: threadScope(),
        rawEvent: expect.objectContaining({
          method: "sdk/message",
        }),
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
      (
        event,
      ): event is Extract<(typeof events)[number], { type: "item/started" }> =>
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

    const events = adapter.translateEvent(
      loadFixture("tool-execution-end-bash.json"),
    );

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

  it("translateEvent maps bash tool execution updates to command output deltas", () => {
    const adapter = createPiProviderAdapter();
    adapter.translateEvent(loadFixture("agent-start.json"));
    adapter.translateEvent({
      type: "tool_execution_start",
      toolCallId: "tool-bash-1",
      toolName: "bash",
      args: {
        command: "printf 'FIRST\\nSECOND\\n'",
        cwd: "/repo",
      },
    } as AgentSessionEvent);

    const firstEvents = adapter.translateEvent({
      jsonrpc: "2.0",
      method: "sdk/message",
      params: {
        threadId: "pi-thread-1",
        message: {
          type: "tool_execution_update",
          toolCallId: "tool-bash-1",
          toolName: "bash",
          partialResult: {
            content: [{ type: "text", text: "FIRST\n" }],
          },
        },
      },
    });

    expect(firstEvents).toContainEqual(
      expect.objectContaining({
        type: "item/commandExecution/outputDelta",
        itemId: "tool-bash-1",
        delta: "FIRST\n",
      }),
    );

    const secondEvents = adapter.translateEvent({
      jsonrpc: "2.0",
      method: "sdk/message",
      params: {
        threadId: "pi-thread-1",
        message: {
          type: "tool_execution_update",
          toolCallId: "tool-bash-1",
          toolName: "bash",
          partialResult: {
            content: [{ type: "text", text: "FIRST\nSECOND\n" }],
          },
        },
      },
    });

    expect(secondEvents).toContainEqual(
      expect.objectContaining({
        type: "item/commandExecution/outputDelta",
        itemId: "tool-bash-1",
        delta: "SECOND\n",
      }),
    );
  });

  it("translateEvent emits the full bash delta when Pi resets cumulative output", () => {
    const adapter = createPiProviderAdapter();
    adapter.translateEvent(loadFixture("agent-start.json"));
    adapter.translateEvent(
      createPiBashStartEvent({
        toolCallId: "tool-bash-1",
        command: "printf 'FIRST\\nSECOND\\n'",
      }),
    );

    adapter.translateEvent(
      createPiBashUpdateEvent({
        threadId: "pi-thread-1",
        toolCallId: "tool-bash-1",
        text: "FIRST\nSECOND\n",
      }),
    );

    const resetEvents = adapter.translateEvent(
      createPiBashUpdateEvent({
        threadId: "pi-thread-1",
        toolCallId: "tool-bash-1",
        text: "RESET\n",
      }),
    );

    expect(resetEvents).toContainEqual(
      expect.objectContaining({
        type: "item/commandExecution/outputDelta",
        itemId: "tool-bash-1",
        delta: "RESET\n",
        reset: true,
      }),
    );
  });

  it("translateEvent clears bash output snapshots when a turn completes", () => {
    const adapter = createPiProviderAdapter();
    const context = { threadId: "bb-thread-1" };

    seedPiBashOutputSnapshot({
      adapter,
      context,
      toolCallId: "tool-bash-1",
    });

    expectPiBashSnapshotReset({
      adapter,
      context,
      toolCallId: "tool-bash-1",
      reset: () => {
        adapter.translateEvent(
          loadFixture("agent-end-with-message.json"),
          context,
        );
      },
    });
  });

  it("buildCommand thread/start clears stale bash output snapshots", () => {
    const adapter = createPiProviderAdapter();
    const context = { threadId: "bb-thread-1" };

    seedPiBashOutputSnapshot({
      adapter,
      context,
      toolCallId: "tool-bash-1",
    });

    expectPiBashSnapshotReset({
      adapter,
      context,
      toolCallId: "tool-bash-1",
      reset: () => {
        adapter.buildCommandPlan({
          type: "thread/start",
          cwd: "/tmp/worktree",
          threadId: "bb-thread-1",
          input: [{ type: "text", text: "hello" }],
          instructionMode: "append",
          options: fullProviderExecutionContext,
        });
      },
    });
  });

  it("buildCommand thread/resume clears stale bash output snapshots", () => {
    const adapter = createPiProviderAdapter();
    const context = { threadId: "bb-thread-1" };

    seedPiBashOutputSnapshot({
      adapter,
      context,
      toolCallId: "tool-bash-1",
    });

    expectPiBashSnapshotReset({
      adapter,
      context,
      toolCallId: "tool-bash-1",
      reset: () => {
        adapter.buildCommandPlan({
          type: "thread/resume",
          cwd: "/tmp/worktree",
          threadId: "bb-thread-1",
          providerThreadId: "pi-thread-1",
          instructionMode: "append",
          options: fullProviderExecutionContext,
        });
      },
    });
  });

  it("buildCommand thread/stop clears stale bash output snapshots", () => {
    const adapter = createPiProviderAdapter();
    const context = { threadId: "bb-thread-1" };

    seedPiBashOutputSnapshot({
      adapter,
      context,
      toolCallId: "tool-bash-1",
    });

    expectPiBashSnapshotReset({
      adapter,
      context,
      toolCallId: "tool-bash-1",
      reset: () => {
        adapter.buildCommandPlan({
          type: "thread/stop",
          threadId: "bb-thread-1",
          providerThreadId: "pi-thread-1",
          activeTurnId: "turn-1",
        });
      },
    });
  });

  it("translateEvent skips empty bash updates with no content", () => {
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
            content: [],
          },
        },
      },
    });

    expect(events).toMatchObject([]);
  });

  it("translateEvent skips Pi bash update placeholders", () => {
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
            content: [{ type: "text", text: "(no output)" }],
          },
        },
      },
    });

    expect(events).toMatchObject([]);
  });

  it("translateEvent keeps non-bash tool execution updates as shared tool progress", () => {
    const adapter = createPiProviderAdapter();
    adapter.translateEvent(loadFixture("agent-start.json"));

    const events = adapter.translateEvent({
      jsonrpc: "2.0",
      method: "sdk/message",
      params: {
        threadId: "pi-thread-1",
        message: {
          type: "tool_execution_update",
          toolCallId: "tool-read-1",
          toolName: "read",
          partialResult: {
            content: [{ type: "text", text: "partial output" }],
          },
        },
      },
    });

    expect(events).toContainEqual(
      expect.objectContaining({
        type: "item/toolCall/progress",
        itemId: "tool-read-1",
        message: "partial output",
      }),
    );
  });

  it("translateEvent falls back to legacy non-bash progress text when partial output is empty", () => {
    const adapter = createPiProviderAdapter();
    adapter.translateEvent(loadFixture("agent-start.json"));

    const events = adapter.translateEvent({
      jsonrpc: "2.0",
      method: "sdk/message",
      params: {
        threadId: "pi-thread-1",
        message: {
          type: "tool_execution_update",
          toolCallId: "tool-read-1",
          toolName: "read",
          partialResult: {
            content: [],
          },
        },
      },
    });

    expect(events).toContainEqual(
      expect.objectContaining({
        type: "item/toolCall/progress",
        itemId: "tool-read-1",
        message: "read progress update",
      }),
    );
  });

  it("translateEvent strips Pi no-output placeholders from bash completions", () => {
    const adapter = createPiProviderAdapter();
    adapter.translateEvent(loadFixture("agent-start.json"));
    adapter.translateEvent({
      type: "tool_execution_start",
      toolCallId: "tool-bash-1",
      toolName: "bash",
      args: {
        command: "true",
        cwd: "/repo",
      },
    } as AgentSessionEvent);

    const events = adapter.translateEvent({
      type: "tool_execution_end",
      toolCallId: "tool-bash-1",
      toolName: "bash",
      isError: false,
      result: {
        content: [{ type: "text", text: "(no output)" }],
      },
    } as AgentSessionEvent);

    const completedEvent = events.find(
      (
        event,
      ): event is Extract<
        (typeof events)[number],
        { type: "item/completed" }
      > => event.type === "item/completed",
    );

    expect(completedEvent?.item).toMatchObject({
      type: "commandExecution",
      id: "tool-bash-1",
      command: "true",
      cwd: "/repo",
      status: "completed",
      exitCode: 0,
    });
    if (completedEvent?.item.type !== "commandExecution") {
      throw new Error("Expected commandExecution completion");
    }
    expect(completedEvent.item.aggregatedOutput).toBeUndefined();
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
        rawEvent: expect.objectContaining({
          method: "sdk/message",
        }),
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

    expect(events).toMatchObject([]);
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
      expect.objectContaining({
        type: "turn/started",
        scope: turnScope("turn-2"),
      }),
    );
  });

  it("translateEvent accumulates Pi token usage across turns", () => {
    const adapter = createPiProviderAdapter({
      resolveModelContextWindow: () => 123_456,
    });

    adapter.translateEvent(loadFixture("agent-start.json"));
    const firstTurnEvents = adapter.translateEvent(
      loadFixture("agent-end-with-message.json"),
    );

    adapter.translateEvent(loadFixture("agent-start.json"));
    const secondTurnEvents = adapter.translateEvent(
      loadFixture("agent-end-with-message.json"),
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
    expect(secondTokenUsage?.tokenUsage.last).toEqual(
      firstTokenUsage?.tokenUsage.last,
    );
    expect(secondTokenUsage?.tokenUsage.modelContextWindow).toBe(123_456);
  });

  it("translateEvent maps bridge context-window usage updates into the meter event", () => {
    const adapter = createPiProviderAdapter();

    adapter.translateEvent(loadFixture("agent-start.json"), {
      threadId: "bb-thread-1",
    });
    adapter.translateEvent(loadFixture("agent-end-with-message.json"), {
      threadId: "bb-thread-1",
    });

    const events = adapter.translateEvent({
      jsonrpc: "2.0",
      method: "thread/contextWindowUsage/updated",
      params: {
        threadId: "bb-thread-1",
        contextWindowUsage: {
          usedTokens: 54321,
          modelContextWindow: 123456,
          estimated: true,
        },
      },
    });

    expect(events).toContainEqual(
      expect.objectContaining({
        type: "thread/contextWindowUsage/updated",
        threadId: "bb-thread-1",
        providerThreadId: "bb-thread-1",
        scope: turnScope("turn-1"),
        contextWindowUsage: {
          usedTokens: 54321,
          modelContextWindow: 123456,
          estimated: true,
        },
      }),
    );
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

  it("uses active Pi catalog entries for Opus 4.6 when still available", () => {
    const models = buildPiAvailableModels({
      providers: ["anthropic"],
      getModels: () => [
        {
          id: "claude-opus-4-7",
          name: "Claude Opus 4.7",
          provider: "anthropic",
          reasoning: true,
          input: ["text"],
          supportsXhigh: true,
        },
        {
          id: "claude-opus-4-6",
          name: "Claude Opus 4.6",
          provider: "anthropic",
          reasoning: true,
          input: ["text"],
          supportsXhigh: false,
        },
      ],
      hasAuth: () => true,
      selectedModel: "anthropic/claude-opus-4-6",
    });

    expect(models.map((model) => model.id)).toMatchObject([
      "anthropic/claude-opus-4-7",
      "anthropic/claude-opus-4-6",
    ]);
    expect(models[1]).toEqual(
      expect.objectContaining({
        displayName: "Claude Opus 4.6",
        isDefault: false,
      }),
    );
  });

  it("does not inject removed Pi fallback models", () => {
    const models = buildPiAvailableModels({
      providers: ["anthropic"],
      getModels: () => [
        {
          id: "claude-opus-4-7",
          name: "Claude Opus 4.7",
          provider: "anthropic",
          reasoning: true,
          input: ["text"],
          supportsXhigh: true,
        },
      ],
      hasAuth: () => true,
      selectedModel: "anthropic/claude-opus-4-6",
    });

    expect(models.map((model) => model.id)).toEqual(["anthropic/claude-opus-4-7"]);
  });
});
