import { describe, expect, it } from "vitest";
import {
  resolvePreferredManagerModel,
  resolvePreferredManagerProviderId,
} from "@/lib/manager-hire-defaults";

describe("HireManagerModal helpers", () => {
  it("prefers claude-code when available", () => {
    expect(
      resolvePreferredManagerProviderId([
        { id: "openai", displayName: "OpenAI", capabilities: { supportsRename: true, supportsServiceTier: true, supportedPermissionModes: ["full", "workspace-write", "readonly"] }, available: true },
        { id: "claude-code", displayName: "Claude Code", capabilities: { supportsRename: true, supportsServiceTier: true, supportedPermissionModes: ["full", "workspace-write", "readonly"] }, available: true },
        { id: "pi", displayName: "Pi", capabilities: { supportsRename: true, supportsServiceTier: true, supportedPermissionModes: ["full"] }, available: true },
      ]),
    ).toBe("claude-code");
  });

  it("falls back to the first provider when claude-code is unavailable", () => {
    expect(
      resolvePreferredManagerProviderId([
        { id: "openai", displayName: "OpenAI", capabilities: { supportsRename: true, supportsServiceTier: true, supportedPermissionModes: ["full", "workspace-write", "readonly"] }, available: true },
        { id: "pi", displayName: "Pi", capabilities: { supportsRename: true, supportsServiceTier: true, supportedPermissionModes: ["full"] }, available: true },
      ]),
    ).toBe("openai");
  });

  it("prefers claude-opus-4-6 over the provider default model", () => {
    expect(
      resolvePreferredManagerModel([
        {
          id: "claude-sonnet-4",
          model: "claude-sonnet-4",
          displayName: "Claude Sonnet 4",
          description: "",
          supportedReasoningEfforts: [],
          defaultReasoningEffort: "medium",
          isDefault: true,
        },
        {
          id: "claude-opus-4-6",
          model: "claude-opus-4-6",
          displayName: "Claude Opus 4.6",
          description: "",
          supportedReasoningEfforts: [],
          defaultReasoningEffort: "medium",
          isDefault: false,
        },
      ]),
    ).toBe("claude-opus-4-6");
  });

  it("falls back to the provider default model when opus is unavailable", () => {
    expect(
      resolvePreferredManagerModel([
        {
          id: "claude-sonnet-4",
          model: "claude-sonnet-4",
          displayName: "Claude Sonnet 4",
          description: "",
          supportedReasoningEfforts: [],
          defaultReasoningEffort: "medium",
          isDefault: true,
        },
        {
          id: "claude-haiku-4-5",
          model: "claude-haiku-4-5",
          displayName: "Claude Haiku 4.5",
          description: "",
          supportedReasoningEfforts: [],
          defaultReasoningEffort: "medium",
          isDefault: false,
        },
      ]),
    ).toBe("claude-sonnet-4");
  });
});
