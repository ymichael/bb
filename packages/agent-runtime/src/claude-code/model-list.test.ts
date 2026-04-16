import { describe, expect, it } from "vitest";
import { listClaudeCodeModels } from "./model-list.js";

describe("listClaudeCodeModels", () => {
  it("returns the full static Claude Code catalog with version-pinned models", () => {
    expect(listClaudeCodeModels().map((model) => model.model)).toEqual([
      "claude-opus-4-7[1m]",
      "claude-opus-4-7",
      "claude-opus-4-6[1m]",
      "claude-opus-4-6",
      "claude-sonnet-4-6[1m]",
      "claude-sonnet-4-6",
      "claude-haiku-4-5",
    ]);
  });

  it("defaults to Opus 1M", () => {
    const models = listClaudeCodeModels();
    expect(models[0]).toEqual(
      expect.objectContaining({
        id: "claude-opus-4-7[1m]",
        model: "claude-opus-4-7[1m]",
        defaultReasoningEffort: "medium",
        isDefault: true,
      }),
    );
  });

  it("keeps Opus 4.6 as an active option", () => {
    const models = listClaudeCodeModels();
    expect(models).toContainEqual(
      expect.objectContaining({
        id: "claude-opus-4-6",
        model: "claude-opus-4-6",
        displayName: "Opus 4.6",
        isDefault: false,
      }),
    );
  });

  it("keeps legacy aliases selected-only", () => {
    const activeModels = listClaudeCodeModels().map((model) => model.model);
    for (const alias of ["opus[1m]", "opus", "sonnet[1m]", "sonnet", "haiku"]) {
      expect(activeModels).not.toContain(alias);
    }

    expect(listClaudeCodeModels({ selectedModel: "opus[1m]" })[0]).toEqual(
      expect.objectContaining({ model: "opus[1m]", displayName: "Opus Alias (1M, Legacy)" }),
    );
    expect(listClaudeCodeModels({ selectedModel: "opus" })[0]).toEqual(
      expect.objectContaining({ model: "opus", displayName: "Opus Alias (Legacy)" }),
    );
    expect(listClaudeCodeModels({ selectedModel: "sonnet[1m]" })[0]).toEqual(
      expect.objectContaining({ model: "sonnet[1m]", displayName: "Sonnet Alias (1M, Legacy)" }),
    );
    expect(listClaudeCodeModels({ selectedModel: "sonnet" })[0]).toEqual(
      expect.objectContaining({ model: "sonnet", displayName: "Sonnet Alias (Legacy)" }),
    );
    expect(listClaudeCodeModels({ selectedModel: "haiku" })[0]).toEqual(
      expect.objectContaining({ model: "haiku", displayName: "Haiku Alias (Legacy)" }),
    );
  });
});
