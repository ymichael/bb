import { describe, expect, it } from "vitest";
import {
  getBuiltInAgentProviderInfo,
  getCloudAuthProvider,
  listBuiltInAgentProviderInfos,
  listCloudAuthProviders,
  PI_DEFAULT_MODEL_PER_PROVIDER,
  resolvePiDefaultModelId,
} from "../src/index.js";

describe("agent provider catalog", () => {
  it("lists built-in providers with shared display metadata", () => {
    expect(listBuiltInAgentProviderInfos()).toEqual([
      {
        id: "codex",
        displayName: "Codex",
        capabilities: {
          supportsRename: true,
          supportsServiceTier: true,
        },
        available: true,
      },
      {
        id: "claude-code",
        displayName: "Claude Code",
        capabilities: {
          supportsRename: false,
          supportsServiceTier: false,
        },
        available: true,
      },
      {
        id: "pi",
        displayName: "Pi",
        capabilities: {
          supportsRename: false,
          supportsServiceTier: false,
        },
        available: true,
      },
    ]);
  });

  it("declares cloud auth runtime consumers", () => {
    expect(listCloudAuthProviders()).toEqual([
      {
        id: "claude-code",
        displayName: "Claude Code",
        authMode: "subscription-oauth",
        runtimeConsumers: [
          {
            authConsumerId: "claude-code",
            runtimeProviderId: "claude-code",
          },
          {
            authConsumerId: "anthropic",
            runtimeProviderId: "pi",
          },
        ],
      },
      {
        id: "codex",
        displayName: "Codex",
        authMode: "subscription-oauth",
        runtimeConsumers: [
          {
            authConsumerId: "codex",
            runtimeProviderId: "codex",
          },
          {
            authConsumerId: "openai-codex",
            runtimeProviderId: "pi",
          },
        ],
      },
    ]);
  });

  it("returns cloned catalog entries", () => {
    const provider = getBuiltInAgentProviderInfo("codex");
    provider.displayName = "Mutated";

    expect(getBuiltInAgentProviderInfo("codex").displayName).toBe("Codex");
  });

  it("exposes pi default model declarations", () => {
    expect(PI_DEFAULT_MODEL_PER_PROVIDER["openai-codex"]).toBe("gpt-5.4");
    expect(resolvePiDefaultModelId("anthropic")).toBe("claude-opus-4-6");
    expect(getCloudAuthProvider("claude-code").runtimeConsumers).toContainEqual({
      authConsumerId: "anthropic",
      runtimeProviderId: "pi",
    });
  });
});
