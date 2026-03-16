import { describe, expect, it } from "vitest";
import {
  createProviderAdapter,
  listAvailableProviderInfos,
} from "../provider-registry.js";

describe("provider registry", () => {
  it("creates codex provider by default", () => {
    const provider = createProviderAdapter({ providerId: "codex" });
    expect(provider.id).toBe("codex");
    expect(provider.processCommand).toBeTruthy();
  });

  it("creates claude-code provider", () => {
    const provider = createProviderAdapter({ providerId: "claude-code" });
    expect(provider.id).toBe("claude-code");
    expect(provider.processCommand).toBeTruthy();
  });

  it("creates pi provider", () => {
    const provider = createProviderAdapter({ providerId: "pi" });
    expect(provider.id).toBe("pi");
    expect(provider.processCommand).toBeTruthy();
  });

  it("rejects unsupported adapters", () => {
    expect(() => createProviderAdapter({ providerId: "pi-mono" })).toThrow(
      'Unsupported provider "pi-mono"',
    );
  });

  it("lists provider catalog", () => {
    const ids = listAvailableProviderInfos().map((provider) => provider.id);
    expect(ids).toEqual(["codex", "claude-code", "pi"]);
  });
});
