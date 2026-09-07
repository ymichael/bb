import { describe, expect, it } from "vitest";
import { createTestProviderRegistry } from "../helpers/provider-registry.js";
import { getSupportedReasoningLevelsForProvider } from "../../src/services/threads/thread-reasoning-policy.js";

const registry = await createTestProviderRegistry();

describe("getSupportedReasoningLevelsForProvider", () => {
  it("returns each registered ACP agent's declared reasoning levels", () => {
    expect(
      getSupportedReasoningLevelsForProvider(registry, "acp-cursor"),
    ).toEqual(["low", "medium", "high", "xhigh", "max"]);
    expect(
      getSupportedReasoningLevelsForProvider(registry, "acp-grok"),
    ).toEqual(["low", "medium", "high"]);
    expect(
      getSupportedReasoningLevelsForProvider(registry, "acp-my-agent"),
    ).toEqual([]);
  });

  it("keeps unknown non-ACP providers on the soft-fail path", () => {
    expect(
      getSupportedReasoningLevelsForProvider(registry, "not-a-provider"),
    ).toEqual([]);
  });
});
