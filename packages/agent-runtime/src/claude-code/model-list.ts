import type {
  AvailableModel,
  ModelReasoningEffort,
} from "@bb/domain";
import {
  HIGH_REASONING_EFFORT,
  LOW_REASONING_EFFORT,
  MEDIUM_REASONING_EFFORT,
  XHIGH_REASONING_EFFORT,
} from "../shared/adapter-utils.js";

type ClaudeCodeCatalogEntry = {
  id: string;
  model: string;
  displayName: string;
  description: string;
  supportedReasoningEfforts: readonly ModelReasoningEffort[];
  defaultReasoningEffort: AvailableModel["defaultReasoningEffort"];
};

const SONNET_REASONING_EFFORTS: readonly ModelReasoningEffort[] = [
  LOW_REASONING_EFFORT,
  MEDIUM_REASONING_EFFORT,
  HIGH_REASONING_EFFORT,
];

const OPUS_REASONING_EFFORTS: readonly ModelReasoningEffort[] = [
  LOW_REASONING_EFFORT,
  MEDIUM_REASONING_EFFORT,
  HIGH_REASONING_EFFORT,
  XHIGH_REASONING_EFFORT,
];

const HAIKU_REASONING_EFFORTS: readonly ModelReasoningEffort[] = [
  LOW_REASONING_EFFORT,
];

const CLAUDE_CODE_CATALOG: readonly ClaudeCodeCatalogEntry[] = [
  {
    id: "opus[1m]",
    model: "opus[1m]",
    displayName: "Opus 4.6 (1M)",
    description: "Opus 4.6 with 1M context for complex long coding sessions",
    supportedReasoningEfforts: OPUS_REASONING_EFFORTS,
    defaultReasoningEffort: "medium",
  },
  {
    id: "opus",
    model: "opus",
    displayName: "Opus 4.6",
    description: "Opus 4.6 for complex coding tasks",
    supportedReasoningEfforts: OPUS_REASONING_EFFORTS,
    defaultReasoningEffort: "medium",
  },
  {
    id: "sonnet[1m]",
    model: "sonnet[1m]",
    displayName: "Sonnet 4.6 (1M)",
    description: "Sonnet 4.6 with 1M context for long coding sessions",
    supportedReasoningEfforts: SONNET_REASONING_EFFORTS,
    defaultReasoningEffort: "medium",
  },
  {
    id: "sonnet",
    model: "sonnet",
    displayName: "Sonnet 4.6",
    description: "Sonnet 4.6 for everyday coding tasks",
    supportedReasoningEfforts: SONNET_REASONING_EFFORTS,
    defaultReasoningEffort: "medium",
  },
  {
    id: "haiku",
    model: "haiku",
    displayName: "Haiku 4.5",
    description: "Haiku 4.5 for quick answers",
    supportedReasoningEfforts: HAIKU_REASONING_EFFORTS,
    defaultReasoningEffort: "low",
  },
];

function cloneReasoningEfforts(
  efforts: readonly ModelReasoningEffort[],
): ModelReasoningEffort[] {
  return efforts.map((effort) => ({ ...effort }));
}

function buildCatalogModel(
  entry: ClaudeCodeCatalogEntry,
): AvailableModel {
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

function markDefaultModel(models: AvailableModel[]): AvailableModel[] {
  return models.map((model, index) =>
    index === 0 ? { ...model, isDefault: true } : model,
  );
}

export function listClaudeCodeModels(): AvailableModel[] {
  return markDefaultModel(CLAUDE_CODE_CATALOG.map(buildCatalogModel));
}
