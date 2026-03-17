import { describe, expect, it } from "vitest";
import {
  buildClaudeCodeAvailableModels,
  createClaudeCodeProviderAdapter,
  shouldFetchClaudeCodeModelsFromAnthropic,
} from "../claude-code-provider-adapter.js";

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

  it("advertises trimmed capabilities", () => {
    const adapter = createClaudeCodeProviderAdapter();
    expect(adapter.capabilities).toEqual({
      supportsRename: false,
      supportsServiceTier: false,
    });
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
