import { describe, expect, it } from "vitest";
import type { AvailableModel } from "@bb/domain";
import type { SystemProviderInfo } from "@bb/server-contract";
import {
  resolvePreferredManagerModel,
  resolvePreferredManagerProviderId,
} from "./manager-hire-defaults";

function makeProvider(id: string): SystemProviderInfo {
  return {
    id,
    displayName: id,
    capabilities: {
      supportsRename: true,
      supportsServiceTier: true,
      supportedPermissionModes: ["readonly", "workspace-write", "full"],
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
    supportedReasoningEfforts: [],
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

describe("resolvePreferredManagerModel", () => {
  it("prefers claude-opus-4-6 when available", () => {
    expect(
      resolvePreferredManagerModel([
        makeModel("claude-sonnet-4-6", { isDefault: true }),
        makeModel("claude-opus-4-6"),
      ]),
    ).toBe("claude-opus-4-6");
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
