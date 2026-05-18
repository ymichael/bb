import { describe, expect, it } from "vitest";
import { listClaudeCodeModels } from "./model-list.js";

describe("listClaudeCodeModels", () => {
  it("returns the full static Claude Code catalog with version-pinned models", () => {
    const { models } = listClaudeCodeModels();
    expect(models.map((model) => model.model)).toEqual([
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
    const { models } = listClaudeCodeModels();
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
    const { models } = listClaudeCodeModels();
    expect(models).toContainEqual(
      expect.objectContaining({
        id: "claude-opus-4-6",
        model: "claude-opus-4-6",
        displayName: "Opus 4.6",
        isDefault: false,
      }),
    );
  });

  it("advertises Claude Code max effort for supported models", () => {
    const { models } = listClaudeCodeModels();
    const effortLevelsByModel = new Map(
      models.map((model) => [
        model.model,
        model.supportedReasoningEfforts.map((effort) => effort.reasoningEffort),
      ]),
    );

    expect(effortLevelsByModel.get("claude-opus-4-7")).toEqual([
      "low",
      "medium",
      "high",
      "xhigh",
      "max",
    ]);
    expect(effortLevelsByModel.get("claude-opus-4-6")).toEqual([
      "low",
      "medium",
      "high",
      "max",
    ]);
    expect(effortLevelsByModel.get("claude-sonnet-4-6")).toEqual([
      "low",
      "medium",
      "high",
      "max",
    ]);
  });

  it("routes legacy moving aliases to the selected-only bucket", () => {
    const { models, selectedOnlyModels } = listClaudeCodeModels();
    const activeIds = models.map((model) => model.model);
    const selectedOnlyIds = selectedOnlyModels.map((model) => model.model);
    for (const alias of ["opus[1m]", "opus", "sonnet[1m]", "sonnet", "haiku"]) {
      expect(activeIds).not.toContain(alias);
      expect(selectedOnlyIds).toContain(alias);
    }
    expect(
      selectedOnlyModels.find((model) => model.model === "opus[1m]"),
    ).toEqual(
      expect.objectContaining({
        displayName: "Opus Alias (1M, Legacy)",
      }),
    );
  });
});
