import { describe, expect, it } from "vitest";
import {
  buildAgentModelCatalog,
  parseAgentModelLines,
} from "./bridge/model-catalog.js";
import {
  buildCursorParameterizedModelCatalog,
  cursorParameterizedSelection,
} from "./cursor-model-selection.js";

describe("Cursor parameterized model selection", () => {
  it("keeps bare ACP ids while preserving CLI reasoning variants", () => {
    const catalog = buildAgentModelCatalog(
      parseAgentModelLines(
        [
          "auto - Auto (default)",
          "cursor-grok-4.6-low - Cursor Grok 4.6 Low",
          "cursor-grok-4.6-medium - Cursor Grok 4.6 Medium",
          "cursor-grok-4.6-high - Cursor Grok 4.6 High",
          "gemini-3.8-flash-low - Gemini 3.8 Flash Low",
          "gemini-3.8-flash-medium - Gemini 3.8 Flash Medium",
          "gemini-3.8-flash-high - Gemini 3.8 Flash High",
        ].join("\n"),
      ),
    );
    if (catalog === null) {
      throw new Error("expected Cursor model catalog");
    }

    const models = buildCursorParameterizedModelCatalog(catalog.models);
    expect(models.map((model) => model.id)).toEqual([
      "default",
      "grok-4.6",
      "gemini-3.8-flash",
    ]);
    expect(
      models
        .find((model) => model.id === "gemini-3.8-flash")
        ?.supportedReasoningEfforts.map((effort) => effort.reasoningEffort),
    ).toEqual(["low", "medium", "high"]);
    expect(models[0]?.isDefault).toBe(true);
  });

  it("merges legacy fixed-effort families into their bare model", () => {
    const catalog = buildAgentModelCatalog(
      parseAgentModelLines(
        [
          "gemini-3.6-flash-minimal - Gemini 3.6 Flash Minimal",
          "gemini-3.6-flash-medium - Gemini 3.6 Flash Medium",
          "gemini-3.6-flash-high - Gemini 3.6 Flash High",
        ].join("\n"),
      ),
    );
    if (catalog === null) {
      throw new Error("expected Cursor model catalog");
    }

    const models = buildCursorParameterizedModelCatalog(catalog.models);
    expect(models).toHaveLength(1);
    expect(models[0]).toMatchObject({
      id: "gemini-3.6-flash",
      displayName: "Gemini 3.6 Flash",
      defaultReasoningEffort: "medium",
    });
    expect(
      models[0]?.supportedReasoningEfforts.map(
        (effort) => effort.reasoningEffort,
      ),
    ).toEqual(["low", "medium", "high"]);
  });

  it("normalizes a legacy variant before session selection", () => {
    expect(
      cursorParameterizedSelection("cursor-grok-4.6-medium", "high"),
    ).toEqual({ modelId: "grok-4.6", reasoningLevel: "high" });
  });
});
