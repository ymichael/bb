import { describe, expect, it } from "vitest";
import {
  buildPiAvailableModels,
  createPiProviderAdapter,
} from "../pi-provider-adapter.js";

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

  it("advertises trimmed capabilities", () => {
    const adapter = createPiProviderAdapter();
    expect(adapter.capabilities).toEqual({
      supportsRename: false,
      supportsServiceTier: false,
    });
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

    const ids = models.map((model) => model.id);
    expect(ids).toContain("anthropic/claude-sonnet-4-20250514");
    expect(ids).toContain("openai/codex-mini");
    expect(ids).not.toContain("google/gemini-2.5-pro");
    expect(models.find((model) => model.isDefault)?.id).toBe(
      "anthropic/claude-sonnet-4-20250514",
    );
  });
});
