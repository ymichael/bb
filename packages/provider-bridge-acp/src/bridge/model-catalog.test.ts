import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { SAMPLE_LIST } from "./model-catalog.fixture.js";
import {
  buildAgentModelCatalog,
  buildAcpNativeReasoningSupport,
  buildModelCatalogFromConfigOptions,
  acpNativeReasoningLevelToValue,
  findAcpModelConfigOption,
  findAcpThoughtLevelConfigOption,
  parseAgentModelLines,
  splitPrimaryModels,
} from "./model-catalog.js";

function catalogFromSample() {
  const catalog = buildAgentModelCatalog(parseAgentModelLines(SAMPLE_LIST));
  if (!catalog) {
    throw new Error("expected a catalog from the sample list");
  }
  return catalog;
}

describe("acp model catalog", () => {
  it("parses id - name lines and skips chatter", () => {
    expect(parseAgentModelLines("header\n\na-1 - Model A\nnoise")).toEqual([
      { id: "a-1", displayName: "Model A" },
    ]);
  });

  it("parses bare model id lines", () => {
    expect(
      parseAgentModelLines(
        "Available models\n\nopenai/gpt-5.3-codex\nopencode/big-pickle\n",
      ),
    ).toEqual([
      {
        id: "openai/gpt-5.3-codex",
        displayName: "openai/gpt-5.3-codex",
      },
      { id: "opencode/big-pickle", displayName: "opencode/big-pickle" },
    ]);
  });

  it("parses Grok's bulleted model list", () => {
    expect(
      parseAgentModelLines(
        [
          "You are logged in with grok.com.",
          "",
          "Default model: grok-4.5",
          "",
          "Available models:",
          "  * grok-4.5 (default)",
          "  - grok-composer-2.5-fast",
        ].join("\n"),
      ),
    ).toEqual([
      { id: "grok-4.5", displayName: "grok-4.5" },
      {
        id: "grok-composer-2.5-fast",
        displayName: "grok-composer-2.5-fast",
      },
    ]);
  });

  it("groups effort variants into families keyed by the default variant", () => {
    const catalog = catalogFromSample();
    const codex = catalog.models.find((m) => m.id === "gpt-5.3-codex");
    expect(codex).toMatchObject({
      model: "gpt-5.3-codex",
      displayName: "Codex 5.3",
      defaultReasoningEffort: "medium",
    });
    expect(
      codex?.supportedReasoningEfforts.map((e) => e.reasoningEffort),
    ).toEqual(["low", "medium", "high", "xhigh"]);
  });

  it("keys a real Cursor list's Grok 4.6 family by its -medium variant (#1688)", () => {
    const catalog = buildAgentModelCatalog(
      parseAgentModelLines(
        readFileSync(
          new URL("./issue-1688-cursor-list-models.txt", import.meta.url),
          "utf8",
        ),
      ),
    );
    const grok46 = catalog?.models.find(
      (m) => m.displayName === "Cursor Grok 4.6",
    );
    expect(grok46?.id).toBe("cursor-grok-4.6-medium");
    expect(
      grok46?.supportedReasoningEfforts.map((e) => e.reasoningEffort),
    ).toEqual(["low", "medium", "high", "xhigh"]);
  });

  it("folds -fast variants into the family as a service tier", () => {
    const catalog = catalogFromSample();
    expect(catalog.models.some((m) => m.id.endsWith("-fast"))).toBe(false);
    expect(
      catalog.models.find((m) => m.id === "gpt-5.3-codex-fast"),
    ).toBeUndefined();
    const codex = catalog.models.find((m) => m.id === "gpt-5.3-codex");
    expect(
      codex?.supportedReasoningEfforts.map((e) => e.reasoningEffort),
    ).toEqual(["low", "medium", "high", "xhigh"]);
    expect(
      catalog.resolveVariant({
        model: "gpt-5.3-codex",
        reasoningLevel: "low",
        serviceTier: "fast",
      }),
    ).toBe("gpt-5.3-codex-low-fast");
    expect(
      catalog.resolveVariant({
        model: "gpt-5.3-codex",
        reasoningLevel: "low",
        serviceTier: "default",
      }),
    ).toBe("gpt-5.3-codex-low");
    expect(
      catalog.resolveVariant({
        model: "gpt-5.3-codex",
        reasoningLevel: "high",
        serviceTier: "fast",
      }),
    ).toBe("gpt-5.3-codex-high");
  });

  it("resolves fast at the default effort when no reasoning level is given", () => {
    const catalog = buildAgentModelCatalog(
      parseAgentModelLines(
        [
          "composer-2.5 - Composer 2.5",
          "composer-2.5-fast - Composer 2.5 Fast",
        ].join("\n"),
      ),
    );
    expect(catalog?.models.map((m) => m.id)).toEqual(["composer-2.5"]);
    expect(
      catalog?.resolveVariant({ model: "composer-2.5", serviceTier: "fast" }),
    ).toBe("composer-2.5-fast");
    expect(catalog?.resolveVariant({ model: "composer-2.5" })).toBe(
      "composer-2.5",
    );
  });

  it("maps the extra-high spelling onto xhigh and resolves it back exactly", () => {
    const catalog = catalogFromSample();
    const gpt55 = catalog.models.find((m) => m.id === "gpt-5.5-medium");
    expect(
      gpt55?.supportedReasoningEfforts.map((e) => e.reasoningEffort),
    ).toEqual(["none", "low", "medium", "xhigh"]);
    expect(
      catalog.resolveVariant({
        model: "gpt-5.5-medium",
        reasoningLevel: "xhigh",
      }),
    ).toBe("gpt-5.5-extra-high");
  });

  it("uses the explicit -medium variant id as the family id", () => {
    const catalog = catalogFromSample();
    expect(
      catalog.models.find((m) => m.id === "gpt-5.1-codex-max-medium"),
    ).toBeDefined();
    expect(
      catalog.resolveVariant({
        model: "gpt-5.1-codex-max-medium",
        reasoningLevel: "high",
      }),
    ).toBe("gpt-5.1-codex-max-high");
  });

  it("strips the effort word and picker noise from the family name", () => {
    const catalog = buildAgentModelCatalog(
      parseAgentModelLines(
        [
          "claude-opus-4-8-medium - Opus 4.8 1M Medium",
          "claude-opus-4-8-high - Opus 4.8 1M",
          "claude-fable-5-thinking-medium - Fable 5 1M Medium Thinking (NO ZDR)",
        ].join("\n"),
      ),
    );
    expect(catalog?.models.map((m) => m.displayName)).toEqual([
      "Opus 4.8",
      "Fable 5",
    ]);
    expect(
      catalog?.models[0]?.supportedReasoningEfforts.map((e) => e.description),
    ).toEqual(["Opus 4.8 1M Medium", "Opus 4.8 1M"]);
  });

  it("strips 1M, NO ZDR, and Cursor's default/current annotations", () => {
    const catalog = buildAgentModelCatalog(
      parseAgentModelLines(
        [
          "composer-2.5 - Composer 2.5 (current)",
          "composer-2.5-fast - Composer 2.5 Fast (default)",
          "gpt-5.5-medium - GPT-5.5 1M",
          "claude-fable-5-high - Fable 5 1M (NO ZDR)",
        ].join("\n"),
      ),
    );
    expect(catalog?.models.map((m) => m.displayName)).toEqual([
      "Composer 2.5",
      "GPT-5.5",
      "Fable 5",
    ]);
    expect(catalog?.models.map((m) => m.id)).toEqual([
      "composer-2.5",
      "gpt-5.5-medium",
      "claude-fable-5-high",
    ]);
  });

  it("merges infix-thinking variants into one entry with a none level", () => {
    const catalog = buildAgentModelCatalog(
      parseAgentModelLines(
        [
          "claude-opus-4-8-low - Opus 4.8 1M Low",
          "claude-opus-4-8-medium - Opus 4.8 1M Medium",
          "claude-opus-4-8-thinking-low - Opus 4.8 1M Low Thinking",
          "claude-opus-4-8-thinking-medium - Opus 4.8 1M Medium Thinking",
        ].join("\n"),
      ),
    );
    expect(catalog?.models).toHaveLength(1);
    const opus = catalog?.models[0];
    expect(opus?.id).toBe("claude-opus-4-8-thinking-medium");
    expect(opus?.displayName).toBe("Opus 4.8");
    expect(opus?.defaultReasoningEffort).toBe("medium");
    expect(
      opus?.supportedReasoningEfforts.map((e) => e.reasoningEffort),
    ).toEqual(["none", "low", "medium"]);
    expect(
      catalog?.resolveVariant({
        model: "claude-opus-4-8-thinking-medium",
        reasoningLevel: "none",
      }),
    ).toBe("claude-opus-4-8-medium");
    expect(
      catalog?.resolveVariant({
        model: "claude-opus-4-8-thinking-medium",
        reasoningLevel: "low",
      }),
    ).toBe("claude-opus-4-8-thinking-low");
  });

  it("orders reasoning efforts low → max regardless of listing order", () => {
    const catalog = buildAgentModelCatalog(
      parseAgentModelLines(
        [
          "thinky-medium - Thinky Medium",
          "thinky-high - Thinky High",
          "thinky-extra-high - Thinky Extra High",
          "thinky-low - Thinky Low",
          "thinky-max - Thinky Max",
        ].join("\n"),
      ),
    );
    expect(
      catalog?.models[0]?.supportedReasoningEfforts.map(
        (e) => e.reasoningEffort,
      ),
    ).toEqual(["low", "medium", "high", "xhigh", "max"]);
  });

  it("keeps brand words that collide with effort spellings", () => {
    const catalog = catalogFromSample();
    expect(
      catalog.models.find((m) => m.id === "gpt-5.1-codex-max-medium")
        ?.displayName,
    ).toBe("Codex 5.1 Max");
  });

  it("folds an explicit -none id into the family's none level", () => {
    const catalog = catalogFromSample();
    expect(catalog.models.find((m) => m.id === "gpt-5.5-none")).toBeUndefined();
    expect(
      catalog.resolveVariant({
        model: "gpt-5.5-medium",
        reasoningLevel: "none",
      }),
    ).toBe("gpt-5.5-none");
  });

  it("merges thinking with its non-thinking twins, defaulting to a thinking effort when there is no medium", () => {
    const catalog = catalogFromSample();
    const opus = catalog.models.find(
      (m) => m.id === "claude-4.6-opus-high-thinking",
    );
    expect(opus).toMatchObject({ defaultReasoningEffort: "high" });
    expect(
      opus?.supportedReasoningEfforts.map((e) => e.reasoningEffort),
    ).toEqual(["none", "high"]);
    expect(
      catalog.resolveVariant({
        model: "claude-4.6-opus-high-thinking",
        reasoningLevel: "high",
      }),
    ).toBe("claude-4.6-opus-high-thinking");
    expect(
      catalog.resolveVariant({
        model: "claude-4.6-opus-high-thinking",
        reasoningLevel: "none",
      }),
    ).toBe("claude-4.6-opus-high");
  });

  it("marks only the first listed family as default", () => {
    const catalog = catalogFromSample();
    expect(catalog.models.filter((m) => m.isDefault).map((m) => m.id)).toEqual([
      "auto",
    ]);
  });

  it("returns undefined for unknown families and unavailable efforts", () => {
    const catalog = catalogFromSample();
    expect(
      catalog.resolveVariant({ model: "unknown", reasoningLevel: "high" }),
    ).toBeUndefined();
    expect(
      catalog.resolveVariant({ model: "auto", reasoningLevel: "high" }),
    ).toBeUndefined();
  });

  it("returns null for an empty list", () => {
    expect(buildAgentModelCatalog([])).toBeNull();
  });
});

describe("acp configOptions model catalog", () => {
  it("finds the model select by category before falling back to id", () => {
    const byId = {
      id: "model",
      category: "mode",
      type: "select",
      options: [{ value: "wrong", name: "Wrong" }],
    };
    const byCategory = {
      id: "provider-model",
      category: "model",
      type: "select",
      options: [{ value: "right", name: "Right" }],
    };

    expect(findAcpModelConfigOption([byId, byCategory])).toBe(byCategory);
    expect(findAcpModelConfigOption([byId])).toBe(byId);
  });

  it("maps model configOptions values, names, and currentValue into picker models", () => {
    const reasoningByModel = new Map([
      [
        "opencode/deepseek-v4-flash-free",
        buildAcpNativeReasoningSupport({
          id: "effort",
          category: "thought_level",
          type: "select",
          currentValue: "high",
          options: [
            { value: "none" },
            { value: "low" },
            { value: "medium" },
            { value: "high" },
            { value: "xhigh" },
          ],
        }),
      ],
    ]);
    const models = buildModelCatalogFromConfigOptions(
      {
        id: "model",
        name: "Model",
        category: "model",
        type: "select",
        currentValue: "opencode/deepseek-v4-flash-free",
        options: [
          {
            value: "opencode/big-pickle",
            name: "OpenCode Zen/Big Pickle",
          },
          {
            value: "opencode/deepseek-v4-flash-free",
            name: "OpenCode Zen/DeepSeek V4 Flash Free",
          },
        ],
      },
      reasoningByModel,
    );

    expect(models).toMatchObject([
      {
        id: "opencode/big-pickle",
        model: "opencode/big-pickle",
        displayName: "OpenCode Zen/Big Pickle",
        isDefault: false,
        defaultReasoningEffort: "medium",
      },
      {
        id: "opencode/deepseek-v4-flash-free",
        model: "opencode/deepseek-v4-flash-free",
        displayName: "OpenCode Zen/DeepSeek V4 Flash Free",
        isDefault: true,
        defaultReasoningEffort: "high",
        supportedReasoningEfforts: [
          { reasoningEffort: "none" },
          { reasoningEffort: "low" },
          { reasoningEffort: "medium" },
          { reasoningEffort: "high" },
          { reasoningEffort: "xhigh" },
        ],
      },
    ]);
  });

  it("finds and maps ACP thought_level config options", () => {
    const thoughtLevel = {
      id: "effort",
      category: "thought_level",
      type: "select",
      currentValue: "medium",
      options: [{ value: "low" }, { value: "medium" }, { value: "xhigh" }],
    };
    expect(findAcpThoughtLevelConfigOption([thoughtLevel])).toBe(thoughtLevel);
    const support = buildAcpNativeReasoningSupport(thoughtLevel);
    expect(support.defaultReasoningEffort).toBe("medium");
    expect(
      support.supportedReasoningEfforts.map((e) => e.reasoningEffort),
    ).toEqual(["low", "medium", "xhigh"]);
    expect(acpNativeReasoningLevelToValue("max", thoughtLevel)).toBe("xhigh");
    expect(
      acpNativeReasoningLevelToValue("high", thoughtLevel),
    ).toBeUndefined();
  });

  it("preserves an explicit empty thought_level option as no reasoning control", () => {
    expect(
      buildAcpNativeReasoningSupport({
        id: "effort",
        category: "thought_level",
        type: "select",
        options: [],
      }),
    ).toEqual({
      supportedReasoningEfforts: [],
      defaultReasoningEffort: "medium",
    });
  });

  it("returns no reasoning control for declared values that bb cannot map", () => {
    expect(
      buildAcpNativeReasoningSupport({
        id: "mode",
        category: "thought_level",
        type: "select",
        currentValue: "smart",
        options: [{ value: "smart" }, { value: "fast" }],
      }),
    ).toEqual({
      supportedReasoningEfforts: [],
      defaultReasoningEffort: "medium",
    });
  });

  it("maps Hermes-style ACP reasoning values", () => {
    const thoughtLevel = {
      id: "reasoning_effort",
      category: "thought_level",
      type: "select",
      currentValue: "max",
      options: [
        { value: "none" },
        { value: "minimal", name: "Minimal" },
        { value: "low", name: "Low" },
        { value: "medium" },
        { value: "high" },
        { value: "xhigh" },
        { value: "max" },
      ],
    };

    const support = buildAcpNativeReasoningSupport(thoughtLevel);
    expect(support.defaultReasoningEffort).toBe("max");
    expect(
      support.supportedReasoningEfforts.map((e) => [
        e.reasoningEffort,
        e.description,
      ]),
    ).toEqual([
      ["none", "none"],
      ["low", "Low"],
      ["medium", "medium"],
      ["high", "high"],
      ["xhigh", "xhigh"],
      ["max", "max"],
    ]);
    expect(acpNativeReasoningLevelToValue("low", thoughtLevel)).toBe("low");
    expect(acpNativeReasoningLevelToValue("max", thoughtLevel)).toBe("max");
  });

  it("uses Hermes minimal as bb low when ACP does not advertise low", () => {
    const thoughtLevel = {
      id: "reasoning_effort",
      category: "thought_level",
      type: "select",
      currentValue: "minimal",
      options: [
        { value: "none" },
        { value: "minimal", name: "Minimal" },
        { value: "medium" },
      ],
    };

    const support = buildAcpNativeReasoningSupport(thoughtLevel);
    expect(support.defaultReasoningEffort).toBe("low");
    expect(acpNativeReasoningLevelToValue("low", thoughtLevel)).toBe("minimal");
  });

  it("falls back to the first model when currentValue is absent or stale", () => {
    expect(
      buildModelCatalogFromConfigOptions({
        id: "model",
        category: "model",
        type: "select",
        options: [
          { value: "first", name: "First" },
          { value: "second", name: "Second" },
        ],
      }).map((model) => model.isDefault),
    ).toEqual([true, false]);

    expect(
      buildModelCatalogFromConfigOptions({
        id: "model",
        category: "model",
        type: "select",
        currentValue: "missing",
        options: [
          { value: "first", name: "First" },
          { value: "second", name: "Second" },
        ],
      }).map((model) => model.isDefault),
    ).toEqual([true, false]);
  });

  it("returns no models when the session has no model select options", () => {
    expect(buildModelCatalogFromConfigOptions(undefined)).toEqual([]);
    expect(
      buildModelCatalogFromConfigOptions({
        id: "model",
        category: "model",
        type: "select",
        options: [],
      }),
    ).toEqual([]);
  });
});

describe("acp primary model split", () => {
  it("splits families into primary and selected-only pools", () => {
    const catalog = catalogFromSample();
    const split = splitPrimaryModels(catalog.models, [
      "auto",
      "gpt-5.5-medium",
    ]);
    expect(split.models.map((m) => m.id)).toEqual(["auto", "gpt-5.5-medium"]);
    expect(split.selectedOnlyModels.map((m) => m.id)).toContain(
      "gpt-5.3-codex",
    );
    expect(split.models.filter((m) => m.isDefault).map((m) => m.id)).toEqual([
      "auto",
    ]);
    expect(split.selectedOnlyModels.some((m) => m.isDefault)).toBe(false);
  });

  it("re-anchors the default flag when the default family is not primary", () => {
    const catalog = catalogFromSample();
    const split = splitPrimaryModels(catalog.models, ["gpt-5.5-medium"]);
    expect(split.models.map((m) => m.id)).toEqual(["gpt-5.5-medium"]);
    expect(split.models[0]?.isDefault).toBe(true);
    expect(split.selectedOnlyModels.some((m) => m.isDefault)).toBe(false);
  });

  it("serves everything as primary when no name matches", () => {
    const catalog = catalogFromSample();
    const split = splitPrimaryModels(catalog.models, ["renamed-away"]);
    expect(split.models).toEqual(catalog.models);
    expect(split.selectedOnlyModels).toEqual([]);
  });
});
