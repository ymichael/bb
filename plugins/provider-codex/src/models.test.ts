import { describe, expect, it } from "vitest";
import {
  mapBbReasoningLevelToCodex,
  mapCodexReasoningLevelToBb,
  parseModelsResponse,
} from "./models.js";

describe("mapCodexReasoningLevelToBb", () => {
  it("returns null for unknown values", () => {
    expect(mapCodexReasoningLevelToBb("ludicrous")).toBeNull();
    expect(mapCodexReasoningLevelToBb(42)).toBeNull();
    expect(mapCodexReasoningLevelToBb(undefined)).toBeNull();
  });
});

describe("mapBbReasoningLevelToCodex", () => {
  it("returns null for none and ultracode", () => {
    expect(mapBbReasoningLevelToCodex("none")).toBeNull();
    expect(mapBbReasoningLevelToCodex("ultracode")).toBeNull();
  });
});

describe("parseModelsResponse", () => {
  it("parses a live-shaped Codex payload with max and ultra", () => {
    const models = parseModelsResponse({
      data: [
        {
          id: "gpt-5.5",
          model: "gpt-5.5",
          displayName: "GPT-5.5",
          description: "Frontier model",
          supportedReasoningEfforts: [
            { reasoningEffort: "low", description: "Low" },
            { reasoningEffort: "medium", description: "Medium" },
            { reasoningEffort: "high", description: "High" },
            { reasoningEffort: "xhigh", description: "XHigh" },
          ],
          defaultReasoningEffort: "medium",
          isDefault: true,
        },
        {
          id: "gpt-5.6-sol",
          model: "gpt-5.6-sol",
          displayName: "GPT-5.6-Sol",
          description: "Latest frontier",
          supportedReasoningEfforts: [
            { reasoningEffort: "low", description: "Low" },
            { reasoningEffort: "medium", description: "Medium" },
            { reasoningEffort: "high", description: "High" },
            { reasoningEffort: "xhigh", description: "XHigh" },
            { reasoningEffort: "max", description: "Max" },
            {
              reasoningEffort: "ultra",
              description: "Maximum with delegation",
            },
          ],
          defaultReasoningEffort: "low",
          isDefault: false,
        },
      ],
    });

    expect(models).toHaveLength(2);
    expect(models[0]?.id).toBe("gpt-5.5");
    expect(
      models[1]?.supportedReasoningEfforts.map((e) => e.reasoningEffort),
    ).toEqual(["low", "medium", "high", "xhigh", "max", "ultra"]);
    expect(models[1]?.defaultReasoningEffort).toBe("low");
  });

  it("skips unknown reasoning efforts without rejecting the model", () => {
    const models = parseModelsResponse({
      data: [
        {
          id: "future-model",
          model: "future-model",
          supportedReasoningEfforts: [
            { reasoningEffort: "low", description: "Low" },
            { reasoningEffort: "quantum", description: "Brand new" },
            { reasoningEffort: "high", description: "High" },
          ],
          defaultReasoningEffort: "quantum",
        },
      ],
    });

    expect(models).toHaveLength(1);
    expect(
      models[0]?.supportedReasoningEfforts.map((e) => e.reasoningEffort),
    ).toEqual(["low", "high"]);
    expect(models[0]?.defaultReasoningEffort).toBe("low");
  });

  it("falls back to default efforts when every effort is unknown", () => {
    const models = parseModelsResponse({
      data: [
        {
          id: "odd-model",
          model: "odd-model",
          supportedReasoningEfforts: [
            { reasoningEffort: "quantum", description: "Brand new" },
          ],
          defaultReasoningEffort: "quantum",
        },
      ],
    });

    expect(models).toHaveLength(1);
    expect(
      models[0]?.supportedReasoningEfforts.map((e) => e.reasoningEffort),
    ).toEqual(["low", "medium", "high", "xhigh"]);
    expect(models[0]?.defaultReasoningEffort).toBe("low");
  });

  it("skips malformed model entries and keeps valid ones", () => {
    const models = parseModelsResponse({
      data: [
        { notAModel: true },
        null,
        "garbage",
        {
          id: "good",
          model: "good",
          displayName: "Good",
          supportedReasoningEfforts: [
            { reasoningEffort: "medium", description: "Medium" },
          ],
          defaultReasoningEffort: "medium",
          isDefault: true,
        },
      ],
    });

    expect(models).toEqual([
      {
        id: "good",
        model: "good",
        displayName: "Good",
        description: "",
        supportedReasoningEfforts: [
          { reasoningEffort: "medium", description: "Medium" },
        ],
        defaultReasoningEffort: "medium",
        isDefault: true,
      },
    ]);
  });

  it("uses defaults when supportedReasoningEfforts is empty", () => {
    const models = parseModelsResponse({
      data: [
        {
          id: "codex-mini",
          model: "codex-mini",
          supportedReasoningEfforts: [],
          defaultReasoningEffort: "medium",
          isDefault: true,
        },
      ],
    });

    expect(
      models[0]?.supportedReasoningEfforts.map((e) => e.reasoningEffort),
    ).toEqual(["low", "medium", "high", "xhigh"]);
    expect(models[0]?.defaultReasoningEffort).toBe("medium");
  });

  it("throws when the envelope is not a model list", () => {
    expect(() => parseModelsResponse(null)).toThrow(
      "Invalid response from codex model/list.",
    );
    expect(() => parseModelsResponse({})).toThrow(
      "Invalid response from codex model/list.",
    );
    expect(() => parseModelsResponse({ data: "nope" })).toThrow(
      "Invalid response from codex model/list.",
    );
  });

  it("throws when every model entry is unusable", () => {
    expect(() =>
      parseModelsResponse({
        data: [{ missing: "id" }, null, 3],
      }),
    ).toThrow("Codex model/list returned no supported models.");
  });
});
