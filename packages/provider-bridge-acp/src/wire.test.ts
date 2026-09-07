import { describe, expect, it } from "vitest";
import {
  acpInitializeResultSchema,
  acpRequestPermissionParamsSchema,
  acpSessionForkResultSchema,
  acpSessionNewResultSchema,
  acpToolCallUpdateEventSchema,
} from "./wire.js";

describe("acpToolCallUpdateEventSchema", () => {
  it("parses an unknown kind as `other` and keeps the agent's word on rawKind", () => {
    const parsed = acpToolCallUpdateEventSchema.parse({
      sessionUpdate: "tool_call",
      toolCallId: "call-1",
      title: "Deploy preview",
      kind: "deploy",
      status: "in_progress",
    });

    expect(parsed.kind).toBe("other");
    expect(parsed.rawKind).toBe("deploy");
    expect(parsed.status).toBe("in_progress");
  });

  it("accepts switch_mode and the v2 cancelled status", () => {
    const parsed = acpToolCallUpdateEventSchema.parse({
      sessionUpdate: "tool_call_update",
      toolCallId: "call-1",
      kind: "switch_mode",
      status: "cancelled",
    });

    expect(parsed.kind).toBe("switch_mode");
    expect(parsed.rawKind).toBeUndefined();
    expect(parsed.status).toBe("cancelled");
  });

  it("parses an unknown status as pending and a null kind or status as absent", () => {
    const unknownStatus = acpToolCallUpdateEventSchema.parse({
      sessionUpdate: "tool_call_update",
      toolCallId: "call-1",
      status: "queued",
    });
    expect(unknownStatus.status).toBe("pending");

    const nulls = acpToolCallUpdateEventSchema.parse({
      sessionUpdate: "tool_call",
      toolCallId: "call-2",
      kind: null,
      status: null,
    });
    expect(nulls.kind).toBeUndefined();
    expect(nulls.status).toBeUndefined();
  });

  it("skips a content entry of an unknown type instead of dropping the call", () => {
    const parsed = acpToolCallUpdateEventSchema.parse({
      sessionUpdate: "tool_call_update",
      toolCallId: "call-1",
      status: "completed",
      content: [
        { type: "hologram", frames: 3 },
        { type: "content", content: { type: "text", text: "done" } },
      ],
    });

    expect(parsed.content).toEqual([
      { type: "content", content: { type: "text", text: "done" } },
    ]);
  });

  it("opens the enums on a permission request's tool call too", () => {
    const parsed = acpRequestPermissionParamsSchema.parse({
      sessionId: "s",
      toolCall: { toolCallId: "call-1", kind: "deploy", status: "queued" },
      options: [{ optionId: "y", name: "Allow", kind: "allow_once" }],
    });

    expect(parsed.toolCall).toMatchObject({
      kind: "other",
      rawKind: "deploy",
      status: "pending",
    });
  });
});

describe("acpInitializeResultSchema", () => {
  it("exposes the unstable session fork capability", () => {
    const parsed = acpInitializeResultSchema.parse({
      protocolVersion: 1,
      agentCapabilities: {
        sessionCapabilities: { fork: {} },
      },
    });

    expect(parsed.agentCapabilities?.sessionCapabilities?.fork).toEqual({});
  });
});

describe("acpSessionNewResultSchema", () => {
  it("accepts explicit null for optional model and config-option strings", () => {
    const parsed = acpSessionNewResultSchema.safeParse({
      sessionId: "session-1",
      models: {
        currentModelId: "openai-codex/gpt-5.5",
        availableModels: [
          {
            modelId: "openai-codex/gpt-5.5",
            name: "openai-codex/GPT-5.5",
            description: null,
          },
        ],
      },
      configOptions: [
        {
          type: "select",
          id: "model",
          category: "model",
          name: "Model",
          description: "Select the model for this session",
          currentValue: "openai-codex/gpt-5.5",
          options: [
            {
              value: "openai-codex/gpt-5.5",
              name: "openai-codex/GPT-5.5",
              description: null,
            },
          ],
        },
        {
          type: "select",
          id: "thought_level",
          category: null,
          name: "Thinking",
          currentValue: "medium",
          options: [{ value: "medium", name: null }],
        },
      ],
    });

    expect(parsed.success).toBe(true);
    if (!parsed.success) {
      return;
    }
    expect(
      parsed.data.models?.availableModels?.[0].description,
    ).toBeUndefined();
    expect(parsed.data.configOptions?.[0].options?.[0].name).toBe(
      "openai-codex/GPT-5.5",
    );
    expect(parsed.data.configOptions?.[1].category).toBeUndefined();
    expect(parsed.data.configOptions?.[1].options?.[0].name).toBeUndefined();
  });
});

describe("acpSessionForkResultSchema", () => {
  it("accepts the SDK's nullable configOptions field", () => {
    const parsed = acpSessionForkResultSchema.parse({
      sessionId: "forked-session",
      configOptions: null,
    });

    expect(parsed).toEqual({
      sessionId: "forked-session",
      configOptions: undefined,
    });
  });
});
