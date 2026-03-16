import { describe, expect, it } from "vitest";
import {
  createProviderEventEnvelope,
  type ThreadEvent,
} from "@bb/core";
import {
  buildPiAvailableModels,
  createPiProviderAdapter,
} from "../pi-provider-adapter.js";

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

describe("pi provider adapter", () => {
  it("has correct identity", () => {
    const adapter = createPiProviderAdapter();
    expect(adapter.id).toBe("pi");
    expect(adapter.displayName).toBe("Pi");
  });

  it("normalizes event type tokens", () => {
    const adapter = createPiProviderAdapter();
    expect(adapter.normalizeEventType("turn.started")).toBe("turn/started");
    expect(adapter.normalizeEventType("TURN/COMPLETED")).toBe("turn/completed");
  });

  it("derives status transitions from turn lifecycle events", () => {
    const adapter = createPiProviderAdapter();
    expect(adapter.statusForEvent("turn/started")).toBe("active");
    expect(adapter.statusForEvent("turn/completed")).toBe("idle");
    expect(adapter.statusForEvent("item/completed")).toBeUndefined();
  });

  it("advertises correct capabilities", () => {
    const adapter = createPiProviderAdapter();
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
    const adapter = createPiProviderAdapter();
    expect(adapter.threadNameSetMethod).toBeUndefined();
    expect(adapter.createThreadNameSetParams).toBeUndefined();
  });

  it("builds a dynamic model list from the Pi catalog", () => {
    const models = buildPiAvailableModels({
      providers: ["anthropic", "openai", "google"],
      getModels: (provider) => {
        switch (provider) {
          case "anthropic":
            return [
              {
                id: "claude-sonnet-4-20250514",
                name: "Claude Sonnet 4",
                provider: "anthropic",
                reasoning: true,
                input: ["text", "image"],
              },
              {
                id: "claude-opus-4-20250514",
                name: "Claude Opus 4",
                provider: "anthropic",
                reasoning: true,
                input: ["text"],
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
              },
            ];
        }
      },
      hasAuth: (provider) => provider !== "google",
    });

    const ids = models.map((m) => m.id);
    expect(ids).toContain("anthropic/claude-sonnet-4-20250514");
    expect(ids).toContain("anthropic/claude-opus-4-20250514");
    expect(ids).toContain("openai/codex-mini");
    expect(ids).not.toContain("google/gemini-2.5-pro");
    expect(models.find((m) => m.isDefault)?.id).toBe(
      "anthropic/claude-sonnet-4-20250514",
    );
    expect(
      models.find((m) => m.id === "anthropic/claude-sonnet-4-20250514"),
    ).toMatchObject({
      displayName: "Claude Sonnet 4",
      defaultReasoningEffort: "medium",
    });
  });

  it("uses the supplied listModels implementation", async () => {
    const adapter = createPiProviderAdapter({
      listModels: async () => [
        {
          id: "provider/model-a",
          model: "provider/model-a",
          displayName: "Model A",
          description: "A test model",
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
        id: "provider/model-a",
        isDefault: true,
      }),
    ]);
  });

  it("passes environment policy via config", () => {
    const adapter = createPiProviderAdapter();
    const params = adapter.createThreadStartParams(
      { projectId: "proj-1" },
      {
        projectId: "proj-1",
        threadId: "thread-1",
        daemonUrl: "http://127.0.0.1:3333/api/v1",
      },
    );
    expect(params).toMatchObject({
      threadId: "thread-1",
      config: {
        "shell_environment_policy.set.BB_PROJECT_ID": "proj-1",
        "shell_environment_policy.set.BB_THREAD_ID": "thread-1",
        "shell_environment_policy.set.BB_DAEMON_URL":
          "http://127.0.0.1:3333/api/v1",
      },
    });
  });

  it("passes model in execution options", () => {
    const adapter = createPiProviderAdapter();
    const params = adapter.createThreadStartParams(
      { projectId: "proj-1", model: "anthropic/claude-opus-4-20250514" },
      { projectId: "proj-1", threadId: "thread-1" },
    );
    expect(params).toMatchObject({
      model: "anthropic/claude-opus-4-20250514",
    });
  });

  it("passes the daemon resume path through thread/resume params", () => {
    const adapter = createPiProviderAdapter();
    const params = adapter.createThreadResumeParams(
      "provider-thread-1",
      { projectId: "proj-1", threadId: "thread-1" },
      undefined,
      "/tmp/pi-sessions/provider-thread-1.jsonl",
    );

    expect(params).toMatchObject({
      threadId: "provider-thread-1",
      sessionPath: "/tmp/pi-sessions/provider-thread-1.jsonl",
    });
  });

  it("creates steer params", () => {
    const adapter = createPiProviderAdapter();
    expect(adapter.turnSteerMethod).toBe("turn/steer");
    const params = adapter.createTurnSteerParams!(
      "provider-thread-1",
      "turn-42",
      [{ type: "text", text: "Do this instead" }],
    );
    expect(params).toEqual({
      threadId: "provider-thread-1",
      expectedTurnId: "turn-42",
      input: [{ type: "text", text: "Do this instead" }],
    });
  });

  it("extracts assistant output from item/completed events", () => {
    const adapter = createPiProviderAdapter();
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

  it("derives thread title from input", () => {
    const adapter = createPiProviderAdapter();
    expect(
      adapter.deriveThreadTitle([{ type: "text", text: "  Hello world  " }]),
    ).toBe("Hello world");
  });

  it("supports dynamic tools and tool call requests", () => {
    const adapter = createPiProviderAdapter();
    expect(adapter.capabilities.supportsDynamicTools).toBe(true);
    expect(adapter.capabilities.supportsToolCallRequests).toBe(true);
  });
});
