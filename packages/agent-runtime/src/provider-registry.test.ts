import { describe, expect, it } from "vitest";
import {
  createProviderForId,
  listAvailableProviderInfos,
  resolveDefaultProviderId,
} from "./provider-registry.js";

describe("provider registry", () => {
  it("creates codex provider with expected process config", () => {
    const provider = createProviderForId("codex");
    expect(provider.id).toBe("codex");
    expect(provider.process.command).toBe("codex");
    expect(provider.process.args).toEqual(["app-server"]);
  });

  it("creates claude-code provider with expected process config", () => {
    const provider = createProviderForId("claude-code");
    expect(provider.id).toBe("claude-code");
    expect(provider.process.command).toBe("node");
    expect(provider.process.args).toHaveLength(1);
    expect(provider.process.args[0]).toMatch(
      /agent-runtime\/(src|dist)\/claude-code\/bridge\/bridge\.js$/,
    );
  });

  it("creates pi provider with expected process config", () => {
    const provider = createProviderForId("pi");
    expect(provider.id).toBe("pi");
    expect(provider.process.command).toBe("node");
    expect(provider.process.args).toHaveLength(1);
    expect(provider.process.args[0]).toMatch(
      /agent-runtime\/(src|dist)\/pi\/bridge\/bridge\.js$/,
    );
  });

  it("rejects unsupported adapters", () => {
    expect(() => createProviderForId("pi-mono")).toThrow(
      'Unsupported provider "pi-mono"',
    );
  });

  it("lists provider catalog", () => {
    const ids = listAvailableProviderInfos().map((provider) => provider.id);
    expect(ids).toEqual(["codex", "claude-code", "pi"]);
  });

  it("prefers BB_DEFAULT_PROVIDER when resolving the default provider", () => {
    expect(resolveDefaultProviderId({ BB_DEFAULT_PROVIDER: "pi" })).toBe("pi");
    expect(resolveDefaultProviderId({ BB_DEFAULT_PROVIDER: "claude-code" })).toBe("claude-code");
  });

  it("falls back to BB_E2E_PROVIDER when no default provider override is set", () => {
    expect(resolveDefaultProviderId({ BB_E2E_PROVIDER: "pi" })).toBe("pi");
  });
});
