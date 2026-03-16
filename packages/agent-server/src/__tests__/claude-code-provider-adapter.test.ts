import { describe, expect, it } from "vitest";
import {
  createProviderEventEnvelope,
  type ProviderDynamicTool,
  type ThreadEvent,
} from "@bb/core";
import {
  buildClaudeCodeAvailableModels,
  createClaudeCodeProviderAdapter,
  shouldFetchClaudeCodeModelsFromAnthropic,
} from "../claude-code-provider-adapter.js";

const DEFAULT_BASE_INSTRUCTIONS =
  "You are a coding agent working on a project thread. Follow the instructions carefully and write clean, working code.";

type ThreadEventOverrides = Partial<Omit<ThreadEvent, "type" | "data">> & {
  type?: string;
  data?: unknown;
};

function makeEvent(overrides: ThreadEventOverrides = {}): ThreadEvent {
  return {
    id: "evt-1",
    threadId: "thread-1",
    seq: 1,
    type: "turn/started",
    data: {},
    createdAt: 1000,
    ...overrides,
  } as ThreadEvent;
}

describe("claude-code provider adapter", () => {
  it("has correct identity", () => {
    const adapter = createClaudeCodeProviderAdapter();
    expect(adapter.id).toBe("claude-code");
    expect(adapter.displayName).toBe("Claude Code");
  });

  it("normalizes event type tokens", () => {
    const adapter = createClaudeCodeProviderAdapter();
    expect(adapter.normalizeEventType("turn.started")).toBe("turn/started");
    expect(adapter.normalizeEventType("TURN/COMPLETED")).toBe("turn/completed");
  });

  it("derives status transitions from turn lifecycle events", () => {
    const adapter = createClaudeCodeProviderAdapter();
    expect(adapter.statusForEvent("turn/start")).toBe("active");
    expect(adapter.statusForEvent("turn/started")).toBe("active");
    expect(adapter.statusForEvent("turn/end")).toBe("idle");
    expect(adapter.statusForEvent("turn/completed")).toBe("idle");
    expect(adapter.statusForEvent("item/completed")).toBeUndefined();
  });

  it("suppresses delta events from persistence and broadcast", () => {
    const adapter = createClaudeCodeProviderAdapter();
    expect(adapter.shouldPersistEvent?.("item/agentMessage/delta", {})).toBe(
      false,
    );
    expect(adapter.shouldBroadcastForEvent("item/agentMessage/delta")).toBe(
      false,
    );
    expect(adapter.shouldPersistEvent?.("item/completed", {})).toBe(true);
    expect(adapter.shouldBroadcastForEvent("item/completed")).toBe(true);
  });

  it("advertises correct capabilities", () => {
    const adapter = createClaudeCodeProviderAdapter();
    expect(adapter.capabilities).toEqual({
      supportsSteer: true,
      supportsRename: false,
      supportsModelList: true,
      supportsReasoningLevels: true,
      supportsServiceTier: false,
      supportsMultimodalInput: true,
      supportsDynamicTools: true,
      supportsToolCallRequests: true,
    });
  });

  it("does not support rename", () => {
    const adapter = createClaudeCodeProviderAdapter();
    expect(adapter.threadNameSetMethod).toBeUndefined();
    expect(adapter.createThreadNameSetParams).toBeUndefined();
  });

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
        id: "claude-haiku-4-5",
        created_at: "2026-01-03T00:00:00Z",
        display_name: "Claude Haiku 4.5",
        type: "model",
      },
      {
        id: "text-embedding-3-large",
        created_at: "2026-01-04T00:00:00Z",
        display_name: "Embedding",
        type: "model",
      },
    ]);

    const ids = models.map((m) => m.id);
    expect(ids).toContain("claude-sonnet-4-6");
    expect(ids).toContain("claude-opus-4-6");
    expect(ids).toContain("claude-haiku-4-5");
    expect(ids).not.toContain("text-embedding-3-large");
    expect(models.find((m) => m.isDefault)?.id).toBe("claude-sonnet-4-6");
    expect(models.find((m) => m.id === "claude-opus-4-6")).toMatchObject({
      defaultReasoningEffort: "medium",
      supportedReasoningEfforts: expect.arrayContaining([
        expect.objectContaining({ reasoningEffort: "xhigh" }),
      ]),
    });
  });

  it("uses the supplied listModels implementation", async () => {
    const adapter = createClaudeCodeProviderAdapter({
      listModels: async () => [
        {
          id: "claude-custom",
          model: "claude-custom",
          displayName: "Claude Custom",
          description: "Custom test model",
          supportedReasoningEfforts: [
            { reasoningEffort: "low", description: "Low reasoning effort" },
          ],
          defaultReasoningEffort: "low",
          isDefault: true,
        },
      ],
    });

    const models = await adapter.listModels();
    expect(models).toEqual([
      expect.objectContaining({
        id: "claude-custom",
        isDefault: true,
      }),
    ]);
  });

  it("uses Anthropic model listing only when an API key is available", () => {
    expect(
      shouldFetchClaudeCodeModelsFromAnthropic({
        ANTHROPIC_API_KEY: "sk-ant-api03-test",
      }),
    ).toBe(true);
    expect(
      shouldFetchClaudeCodeModelsFromAnthropic({
        CLAUDE_CODE_OAUTH_TOKEN: "sk-ant-oat01-test",
      }),
    ).toBe(false);
    expect(
      shouldFetchClaudeCodeModelsFromAnthropic({
        ANTHROPIC_API_KEY: "sk-ant-api03-test",
        CLAUDE_CODE_USE_BEDROCK: "1",
      }),
    ).toBe(false);
  });

  it("maps developerInstructions to baseInstructions for thread/start", () => {
    const adapter = createClaudeCodeProviderAdapter();
    const params = adapter.createThreadStartParams(
      {
        projectId: "proj-1",
        developerInstructions: "[bb system] custom instructions",
      },
      { projectId: "proj-1", threadId: "thread-1" },
    );
    expect(params).toMatchObject({
      baseInstructions: [
        DEFAULT_BASE_INSTRUCTIONS,
        "[bb system] custom instructions",
      ].join("\n\n"),
    });
  });

  it("passes environment policy via config", () => {
    const adapter = createClaudeCodeProviderAdapter();
    const params = adapter.createThreadStartParams(
      { projectId: "proj-1" },
      {
        projectId: "proj-1",
        threadId: "thread-1",
        daemonUrl: "http://127.0.0.1:3333/api/v1",
      },
    );
    expect(params).toMatchObject({
      config: {
        "shell_environment_policy.set.BB_PROJECT_ID": "proj-1",
        "shell_environment_policy.set.BB_THREAD_ID": "thread-1",
        "shell_environment_policy.set.BB_DAEMON_URL":
          "http://127.0.0.1:3333/api/v1",
      },
    });
  });

  it("passes model and reasoning level in execution options", () => {
    const adapter = createClaudeCodeProviderAdapter();
    const params = adapter.createThreadStartParams(
      {
        projectId: "proj-1",
        model: "claude-opus-4-6",
        reasoningLevel: "high",
      },
      { projectId: "proj-1", threadId: "thread-1" },
    );
    expect(params).toMatchObject({
      model: "claude-opus-4-6",
      config: {
        model_reasoning_effort: "high",
      },
    });
  });

  it("creates resume params with threadId", () => {
    const adapter = createClaudeCodeProviderAdapter();
    const params = adapter.createThreadResumeParams(
      "provider-thread-1",
      { projectId: "proj-1", threadId: "thread-1" },
      { model: "claude-opus-4-6" },
    );
    expect(params).toMatchObject({
      threadId: "provider-thread-1",
      model: "claude-opus-4-6",
    });
  });

  it("creates turn start params", () => {
    const adapter = createClaudeCodeProviderAdapter();
    const params = adapter.createTurnStartParams(
      "provider-thread-1",
      [{ type: "text", text: "Continue" }],
    );
    expect(params).toMatchObject({
      threadId: "provider-thread-1",
      input: [{ type: "text", text: "Continue" }],
    });
  });

  it("creates steer params", () => {
    const adapter = createClaudeCodeProviderAdapter();
    expect(adapter.turnSteerMethod).toBe("turn/steer");
    const params = adapter.createTurnSteerParams!(
      "provider-thread-1",
      "turn-42",
      [{ type: "text", text: "Actually, do this instead" }],
    );
    expect(params).toEqual({
      threadId: "provider-thread-1",
      expectedTurnId: "turn-42",
      input: [{ type: "text", text: "Actually, do this instead" }],
    });
  });

  it("adds dynamic tools to thread/start params", () => {
    const adapter = createClaudeCodeProviderAdapter();
    const tools: ProviderDynamicTool[] = [
      {
        name: "lookup_ticket",
        description: "Look up a ticket",
        inputSchema: {
          type: "object",
          properties: { id: { type: "string" } },
          required: ["id"],
        },
      },
    ];
    const params = adapter.createThreadStartParams(
      { projectId: "proj-1" },
      { projectId: "proj-1", threadId: "thread-1" },
      tools,
    );
    expect(params).toMatchObject({
      dynamicTools: [
        {
          name: "lookup_ticket",
          description: "Look up a ticket",
          inputSchema: {
            type: "object",
            properties: { id: { type: "string" } },
            required: ["id"],
          },
        },
      ],
    });
  });

  it("extracts assistant output from item/completed events", () => {
    const adapter = createClaudeCodeProviderAdapter();
    const output = adapter.outputFromEvent(
      makeEvent({
        type: "item/completed",
        data: {
          item: {
            type: "agentMessage",
            text: "Final answer",
          },
        },
      }),
    );
    expect(output).toBe("Final answer");
  });

  it("extracts assistant output from enveloped item/completed events", () => {
    const adapter = createClaudeCodeProviderAdapter();
    const output = adapter.outputFromEvent(
      makeEvent({
        type: "item/completed",
        data: createProviderEventEnvelope({
          providerId: "claude-code",
          method: "item/completed",
          payload: {
            item: {
              type: "agentMessage",
              text: [{ text: "Final " }, { value: "answer" }],
            },
          },
        }),
      }),
    );
    expect(output).toBe("Final answer");
  });

  it("decodes and encodes tool calls", () => {
    const adapter = createClaudeCodeProviderAdapter();
    expect(
      adapter.decodeToolCallRequest?.(61, "item/tool/call", {
        threadId: "thr_123",
        turnId: "turn_123",
        callId: "call_123",
        tool: "lookup_ticket",
        arguments: { id: "ABC-123" },
      }),
    ).toEqual({
      requestId: 61,
      threadId: "thr_123",
      turnId: "turn_123",
      callId: "call_123",
      tool: "lookup_ticket",
      arguments: { id: "ABC-123" },
    });

    expect(
      adapter.encodeToolCallResponse?.({
        success: true,
        contentItems: [{ type: "inputText", text: "Ticket ABC-123 is open." }],
      }),
    ).toEqual({
      success: true,
      contentItems: [{ type: "inputText", text: "Ticket ABC-123 is open." }],
    });
  });

  it("derives thread title from input", () => {
    const adapter = createClaudeCodeProviderAdapter();
    expect(
      adapter.deriveThreadTitle([
        { type: "text", text: "  Hello world  " },
      ]),
    ).toBe("Hello world");
    expect(adapter.deriveThreadTitle([])).toBeUndefined();
  });

  it("returns inactive session error message", () => {
    const adapter = createClaudeCodeProviderAdapter();
    expect(adapter.inactiveSessionErrorMessage("t-1")).toBe(
      "Thread t-1 has no Claude Code session",
    );
  });

  it("titleFromEvent always returns undefined", () => {
    const adapter = createClaudeCodeProviderAdapter();
    expect(
      adapter.titleFromEvent("thread/started", { thread: { preview: "Hi" } }),
    ).toBeUndefined();
  });
});
