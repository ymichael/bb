import { describe, expect, it } from "vitest";
import {
  createProviderEventEnvelope,
  type ThreadEvent,
} from "@beanbag/agent-core";
import { createPiProviderAdapter } from "../pi-provider-adapter.js";

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
      supportsDynamicTools: false,
      supportsToolCallRequests: false,
    });
  });

  it("does not support rename", () => {
    const adapter = createPiProviderAdapter();
    expect(adapter.threadNameSetMethod).toBeUndefined();
    expect(adapter.createThreadNameSetParams).toBeUndefined();
  });

  it("lists hardcoded pi models", async () => {
    const adapter = createPiProviderAdapter();
    const models = await adapter.listModels();
    const ids = models.map((m) => m.id);
    expect(ids).toContain("anthropic/claude-sonnet-4-20250514");
    expect(ids).toContain("anthropic/claude-opus-4-20250514");
    expect(ids).toContain("openai/codex-mini");
    expect(models.find((m) => m.isDefault)?.id).toBe(
      "anthropic/claude-sonnet-4-20250514",
    );
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

  it("does not support dynamic tools or tool call requests", () => {
    const adapter = createPiProviderAdapter();
    expect(adapter.capabilities.supportsDynamicTools).toBe(false);
    expect(adapter.capabilities.supportsToolCallRequests).toBe(false);
    expect(adapter.decodeToolCallRequest).toBeUndefined();
    expect(adapter.encodeToolCallResponse).toBeUndefined();
  });
});
