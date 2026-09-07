import {
  HIGH_REASONING_EFFORT,
  LOW_REASONING_EFFORT,
  MAX_REASONING_EFFORT,
  MEDIUM_REASONING_EFFORT,
  ULTRACODE_REASONING_EFFORT,
  XHIGH_REASONING_EFFORT,
  type AvailableModel,
  type ModelReasoningEffort,
} from "@get-bb/plugin-sdk/provider-bridge";
import type { ModelInfo } from "@anthropic-ai/claude-agent-sdk";
import {
  CLAUDE_CODE_ACTIVE_CATALOG,
  CLAUDE_XHIGH_CAPABLE_REASONING_EFFORTS,
  DEFAULT_CLAUDE_CODE_MODEL,
  cloneReasoningEfforts,
  type ClaudeCodeCatalogEntry,
} from "./model-catalog.js";

const SONNET_REASONING_EFFORTS: readonly ModelReasoningEffort[] = [
  LOW_REASONING_EFFORT,
  MEDIUM_REASONING_EFFORT,
  HIGH_REASONING_EFFORT,
  MAX_REASONING_EFFORT,
];

const HAIKU_REASONING_EFFORTS: readonly ModelReasoningEffort[] = [
  LOW_REASONING_EFFORT,
];

const CLAUDE_OPUS_4_8_MODEL = "claude-opus-4-8";
const CLAUDE_OPUS_4_7_MODEL = "claude-opus-4-7";
const CLAUDE_OPUS_4_6_MODEL = "claude-opus-4-6";
const CLAUDE_SONNET_4_6_MODEL = "claude-sonnet-4-6";
const CLAUDE_HAIKU_4_5_MODEL = "claude-haiku-4-5";

function withOneMillionContext(model: string): string {
  return `${model}[1m]`;
}

const CLAUDE_CODE_SELECTED_ONLY_CATALOG: readonly ClaudeCodeCatalogEntry[] = [
  {
    id: withOneMillionContext(CLAUDE_SONNET_4_6_MODEL),
    model: withOneMillionContext(CLAUDE_SONNET_4_6_MODEL),
    displayName: "Sonnet 4.6 (1M)",
    description: "Sonnet 4.6 with 1M context for long coding sessions",
    supportedReasoningEfforts: SONNET_REASONING_EFFORTS,
    defaultReasoningEffort: "medium",
  },
  {
    id: CLAUDE_SONNET_4_6_MODEL,
    model: CLAUDE_SONNET_4_6_MODEL,
    displayName: "Sonnet 4.6",
    description: "Sonnet 4.6 for everyday coding tasks",
    supportedReasoningEfforts: SONNET_REASONING_EFFORTS,
    defaultReasoningEffort: "medium",
  },
  {
    id: CLAUDE_HAIKU_4_5_MODEL,
    model: CLAUDE_HAIKU_4_5_MODEL,
    displayName: "Haiku 4.5",
    description: "Haiku 4.5 for quick answers",
    supportedReasoningEfforts: HAIKU_REASONING_EFFORTS,
    defaultReasoningEffort: "low",
  },
  {
    id: CLAUDE_OPUS_4_8_MODEL,
    model: CLAUDE_OPUS_4_8_MODEL,
    displayName: "Opus 4.8 (Legacy)",
    description:
      "Legacy Opus 4.8 model retained for existing non-1M selections",
    supportedReasoningEfforts: CLAUDE_XHIGH_CAPABLE_REASONING_EFFORTS,
    defaultReasoningEffort: "high",
  },
  {
    id: CLAUDE_OPUS_4_7_MODEL,
    model: CLAUDE_OPUS_4_7_MODEL,
    displayName: "Opus 4.7 (Legacy)",
    description:
      "Legacy Opus 4.7 model retained for existing non-1M selections",
    supportedReasoningEfforts: CLAUDE_XHIGH_CAPABLE_REASONING_EFFORTS,
    defaultReasoningEffort: "medium",
  },
  {
    id: withOneMillionContext(CLAUDE_OPUS_4_6_MODEL),
    model: withOneMillionContext(CLAUDE_OPUS_4_6_MODEL),
    displayName: "Opus 4.6 (1M, Legacy)",
    description: "Legacy Opus 4.6 1M model retained for existing selections",
    supportedReasoningEfforts: SONNET_REASONING_EFFORTS,
    defaultReasoningEffort: "medium",
  },
  {
    id: CLAUDE_OPUS_4_6_MODEL,
    model: CLAUDE_OPUS_4_6_MODEL,
    displayName: "Opus 4.6 (Legacy)",
    description: "Legacy Opus 4.6 model retained for existing selections",
    supportedReasoningEfforts: SONNET_REASONING_EFFORTS,
    defaultReasoningEffort: "medium",
  },
  {
    id: "best",
    model: "best",
    displayName: "Best Alias",
    description:
      "Moving best alias retained for existing selections; resolves to the current Fable model where available",
    supportedReasoningEfforts: CLAUDE_XHIGH_CAPABLE_REASONING_EFFORTS,
    defaultReasoningEffort: "high",
  },
  {
    id: "fable",
    model: "fable",
    displayName: "Fable Alias",
    description:
      "Moving Fable alias retained for existing selections; resolves to the current Claude Fable model",
    supportedReasoningEfforts: CLAUDE_XHIGH_CAPABLE_REASONING_EFFORTS,
    defaultReasoningEffort: "high",
  },
  {
    id: "opus[1m]",
    model: "opus[1m]",
    displayName: "Opus Alias (1M, Current)",
    description:
      "Moving Opus 1M alias accepted by Claude Code; resolves to the current Opus 1M model",
    supportedReasoningEfforts: CLAUDE_XHIGH_CAPABLE_REASONING_EFFORTS,
    defaultReasoningEffort: "high",
  },
  {
    id: "opus",
    model: "opus",
    displayName: "Opus Alias (Current)",
    description:
      "Moving Opus alias accepted by Claude Code; resolves to the current Opus model",
    supportedReasoningEfforts: CLAUDE_XHIGH_CAPABLE_REASONING_EFFORTS,
    defaultReasoningEffort: "high",
  },
  {
    id: "sonnet[1m]",
    model: "sonnet[1m]",
    displayName: "Sonnet Alias (1M, Legacy)",
    description:
      "Legacy moving Sonnet 1M alias retained for existing selections",
    supportedReasoningEfforts: SONNET_REASONING_EFFORTS,
    defaultReasoningEffort: "medium",
  },
  {
    id: "sonnet",
    model: "sonnet",
    displayName: "Sonnet Alias (Legacy)",
    description: "Legacy moving Sonnet alias retained for existing selections",
    supportedReasoningEfforts: SONNET_REASONING_EFFORTS,
    defaultReasoningEffort: "medium",
  },
  {
    id: "haiku",
    model: "haiku",
    displayName: "Haiku Alias (Legacy)",
    description: "Legacy moving Haiku alias retained for existing selections",
    supportedReasoningEfforts: HAIKU_REASONING_EFFORTS,
    defaultReasoningEffort: "low",
  },
];

function buildCatalogModel(entry: ClaudeCodeCatalogEntry): AvailableModel {
  return {
    id: entry.id,
    model: entry.model,
    displayName: entry.displayName,
    description: entry.description,
    supportedReasoningEfforts: cloneReasoningEfforts(
      entry.supportedReasoningEfforts,
    ),
    defaultReasoningEffort: entry.defaultReasoningEffort,
    isDefault: false,
  };
}

function buildDiscoveredModel(modelInfo: ModelInfo): AvailableModel {
  const supportedReasoningEfforts = cloneReasoningEfforts(
    modelInfo.supportedEffortLevels?.length
      ? modelInfo.supportedEffortLevels.flatMap((level) => {
          switch (level) {
            case "low":
              return [LOW_REASONING_EFFORT];
            case "medium":
              return [MEDIUM_REASONING_EFFORT];
            case "high":
              return [HIGH_REASONING_EFFORT];
            case "xhigh":
              return [XHIGH_REASONING_EFFORT, ULTRACODE_REASONING_EFFORT];
            case "max":
              return [MAX_REASONING_EFFORT];
          }
        })
      : [LOW_REASONING_EFFORT],
  );
  const supportedLevels = supportedReasoningEfforts.map(
    (effort) => effort.reasoningEffort,
  );
  const defaultReasoningEffort = supportedLevels.includes("high")
    ? "high"
    : supportedLevels.includes("medium")
      ? "medium"
      : (supportedLevels[0] ?? "low");
  const model = modelInfo.resolvedModel ?? modelInfo.value;
  return {
    id: model,
    model,
    displayName: modelInfo.displayName,
    description: modelInfo.description,
    supportedReasoningEfforts,
    defaultReasoningEffort,
    isDefault: false,
  };
}

function modelIsDiscovered(
  model: string,
  discoveredModels: readonly ModelInfo[],
): boolean {
  return discoveredModels.some(
    (discovered) =>
      discovered.value === model || discovered.resolvedModel === model,
  );
}

function resolveDiscoveredDefaultModel(
  discoveredModels: readonly ModelInfo[],
): string | null {
  const defaultModel = discoveredModels.find(
    (model) => model.value === "default",
  );
  return defaultModel?.resolvedModel ?? null;
}

function markDefaultModel(
  models: AvailableModel[],
  discoveredModels: readonly ModelInfo[],
): AvailableModel[] {
  const discoveredDefault = resolveDiscoveredDefaultModel(discoveredModels);
  const defaultModel =
    discoveredDefault &&
    models.some((model) => model.model === discoveredDefault)
      ? discoveredDefault
      : models.some((model) => model.model === DEFAULT_CLAUDE_CODE_MODEL)
        ? DEFAULT_CLAUDE_CODE_MODEL
        : models[0]?.model;
  return models.map((model) =>
    model.model === defaultModel ? { ...model, isDefault: true } : model,
  );
}

interface ListClaudeCodeModelsResult {
  models: AvailableModel[];
  selectedOnlyModels: AvailableModel[];
}

export function buildClaudeCodeModels(
  discoveredModels: readonly ModelInfo[],
): ListClaudeCodeModelsResult {
  const models = CLAUDE_CODE_ACTIVE_CATALOG.map(buildCatalogModel);
  for (const discovered of [
    ...discoveredModels.filter((model) => model.value !== "default"),
    ...discoveredModels.filter((model) => model.value === "default"),
  ]) {
    const resolvedModel = discovered.resolvedModel ?? discovered.value;
    if (models.some((model) => model.model === resolvedModel)) {
      continue;
    }
    models.push(buildDiscoveredModel(discovered));
  }
  const selectedOnlyModels = CLAUDE_CODE_SELECTED_ONLY_CATALOG.filter(
    (entry) =>
      modelIsDiscovered(entry.model, discoveredModels) &&
      !models.some((model) => model.model === entry.model),
  ).map(buildCatalogModel);
  return {
    models: markDefaultModel(models, discoveredModels),
    selectedOnlyModels,
  };
}
