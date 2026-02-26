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

  it("creates additional first-party adapters", () => {
    const pi = createProviderAdapter({ providerId: "pi-mono" });
    const claude = createProviderAdapter({ providerId: "claude-code" });

    expect(pi.id).toBe("pi-mono");
    expect(claude.id).toBe("claude-code");
    expect(claude.capabilities.supportsSteer).toBe(false);
  });

  it("lists provider catalog", () => {
    const ids = listAvailableProviderInfos().map((provider) => provider.id);
    expect(ids).toEqual(["codex", "pi-mono", "claude-code"]);
  });
});
