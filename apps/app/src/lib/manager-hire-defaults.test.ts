import { describe, expect, it } from "vitest";
import type { AvailableModel } from "@bb/domain";
import type { SystemProviderInfo } from "@bb/server-contract";
import {
  resolvePreferredManagerModel,
  resolvePreferredManagerProviderId,
  resolvePreferredManagerReasoningLevel,
} from "./manager-hire-defaults";

function makeProvider(id: string): SystemProviderInfo {
  return {
    id,
    displayName: id,
    capabilities: {
      supportsRename: true,
      supportsServiceTier: true,
      supportedPermissionModes: ["full", "workspace-write", "readonly"],
    },
    available: true,
  };
}

function makeModel(
  model: string,
  overrides: Partial<AvailableModel> = {},
): AvailableModel {
  return {
    id: model,
    model,
    displayName: model,
    description: model,
    supportedReasoningEfforts: [
      { reasoningEffort: "low", description: "Low reasoning effort" },
      { reasoningEffort: "medium", description: "Medium reasoning effort" },
      { reasoningEffort: "high", description: "High reasoning effort" },
    ],
    defaultReasoningEffort: "medium",
    isDefault: false,
    ...overrides,
  };
}

describe("resolvePreferredManagerProviderId", () => {
  it("prefers claude-code when it is available", () => {
    expect(
      resolvePreferredManagerProviderId([
        makeProvider("codex"),
        makeProvider("claude-code"),
      ]),
    ).toBe("claude-code");
  });

  it("falls back to the first available provider", () => {
    expect(resolvePreferredManagerProviderId([makeProvider("codex")])).toBe("codex");
  });
});

describe("resolvePreferredManagerReasoningLevel", () => {
  it("uses the model default for the preferred Opus 4.7 1M manager model", () => {
    expect(
      resolvePreferredManagerReasoningLevel(
        makeModel("claude-opus-4-7[1m]", {
          defaultReasoningEffort: "xhigh",
          supportedReasoningEfforts: [
            { reasoningEffort: "medium", description: "Medium reasoning effort" },
            { reasoningEffort: "xhigh", description: "Extra high reasoning effort" },
          ],
        }),
      ),
    ).toBe("xhigh");
  });

  it("falls back to the model default for non-manager-preferred models", () => {
    expect(
      resolvePreferredManagerReasoningLevel(
        makeModel("claude-sonnet-4-6", {
          defaultReasoningEffort: "high",
        }),
      ),
    ).toBe("high");
  });
});

describe("resolvePreferredManagerModel", () => {
  it("prefers claude-opus-4-7 1M when available", () => {
    expect(
      resolvePreferredManagerModel([
        makeModel("claude-sonnet-4-6", { isDefault: true }),
        makeModel("claude-opus-4-7[1m]"),
      ]),
    ).toBe("claude-opus-4-7[1m]");
  });

  it("falls back to the provider default model", () => {
    expect(
      resolvePreferredManagerModel([
        makeModel("claude-sonnet-4-6", { isDefault: true }),
        makeModel("claude-haiku-4-5"),
      ]),
    ).toBe("claude-sonnet-4-6");
  });
});
