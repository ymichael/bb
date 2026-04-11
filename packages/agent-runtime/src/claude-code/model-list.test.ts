import { describe, expect, it } from "vitest";
import { listClaudeCodeModels } from "./model-list.js";

describe("listClaudeCodeModels", () => {
  it("returns the full static Claude Code catalog including 1M aliases", () => {
    expect(listClaudeCodeModels().map((model) => model.model)).toEqual([
      "opus[1m]",
      "opus",
      "sonnet[1m]",
      "sonnet",
      "haiku",
    ]);
  });

  it("defaults to Opus 1M", () => {
    const models = listClaudeCodeModels();
    expect(models[0]).toEqual(
      expect.objectContaining({
        id: "opus[1m]",
        model: "opus[1m]",
        isDefault: true,
      }),
    );
  });
});
