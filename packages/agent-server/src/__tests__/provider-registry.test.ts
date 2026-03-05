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

  it("rejects unsupported adapters", () => {
    expect(() => createProviderAdapter({ providerId: "pi-mono" })).toThrow(
      'Unsupported provider "pi-mono"',
    );
    expect(() => createProviderAdapter({ providerId: "claude-code" })).toThrow(
      'Unsupported provider "claude-code"',
    );
  });

  it("lists provider catalog", () => {
    const ids = listAvailableProviderInfos().map((provider) => provider.id);
    expect(ids).toEqual(["codex"]);
  });
});
