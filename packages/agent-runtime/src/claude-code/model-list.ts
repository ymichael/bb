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
import { includeSelectedOnlyModels } from "../shared/model-list-visibility.js";

type ClaudeCodeCatalogEntry = {
  id: string;
  model: string;
  displayName: string;
  description: string;
  supportedReasoningEfforts: readonly ModelReasoningEffort[];
  defaultReasoningEffort: AvailableModel["defaultReasoningEffort"];
};

export interface ListClaudeCodeModelsArgs {
  selectedModel?: string;
}

const OPUS_REASONING_EFFORTS: readonly ModelReasoningEffort[] = [
  LOW_REASONING_EFFORT,
  MEDIUM_REASONING_EFFORT,
  HIGH_REASONING_EFFORT,
  XHIGH_REASONING_EFFORT,
];

const OPUS_4_6_REASONING_EFFORTS: readonly ModelReasoningEffort[] = [
  LOW_REASONING_EFFORT,
  MEDIUM_REASONING_EFFORT,
  HIGH_REASONING_EFFORT,
];

const SONNET_REASONING_EFFORTS: readonly ModelReasoningEffort[] = [
  LOW_REASONING_EFFORT,
  MEDIUM_REASONING_EFFORT,
  HIGH_REASONING_EFFORT,
];

const HAIKU_REASONING_EFFORTS: readonly ModelReasoningEffort[] = [
  LOW_REASONING_EFFORT,
];

const CLAUDE_OPUS_4_7_MODEL = "claude-opus-4-7";
const CLAUDE_OPUS_4_6_MODEL = "claude-opus-4-6";
const CLAUDE_SONNET_4_6_MODEL = "claude-sonnet-4-6";
const CLAUDE_HAIKU_4_5_MODEL = "claude-haiku-4-5";

function withOneMillionContext(model: string): string {
  return `${model}[1m]`;
}

// Keep the active catalog version-pinned. Moving aliases and future retired
// model strings live in the selected-only catalog so existing stored selections
// can render without offering them as fresh choices.
const CLAUDE_CODE_CATALOG: readonly ClaudeCodeCatalogEntry[] = [
  {
    id: withOneMillionContext(CLAUDE_OPUS_4_7_MODEL),
    model: withOneMillionContext(CLAUDE_OPUS_4_7_MODEL),
    displayName: "Opus 4.7 (1M)",
    description: "Opus 4.7 with 1M context for complex long coding sessions",
    supportedReasoningEfforts: OPUS_REASONING_EFFORTS,
    defaultReasoningEffort: "medium",
  },
  {
    id: CLAUDE_OPUS_4_7_MODEL,
    model: CLAUDE_OPUS_4_7_MODEL,
    displayName: "Opus 4.7",
    description: "Opus 4.7 for complex coding tasks",
    supportedReasoningEfforts: OPUS_REASONING_EFFORTS,
    defaultReasoningEffort: "medium",
  },
  {
    id: withOneMillionContext(CLAUDE_OPUS_4_6_MODEL),
    model: withOneMillionContext(CLAUDE_OPUS_4_6_MODEL),
    displayName: "Opus 4.6 (1M)",
    description: "Opus 4.6 with 1M context for complex long coding sessions",
    supportedReasoningEfforts: OPUS_4_6_REASONING_EFFORTS,
    defaultReasoningEffort: "medium",
  },
  {
    id: CLAUDE_OPUS_4_6_MODEL,
    model: CLAUDE_OPUS_4_6_MODEL,
    displayName: "Opus 4.6",
    description: "Opus 4.6 for complex coding tasks",
    supportedReasoningEfforts: OPUS_4_6_REASONING_EFFORTS,
    defaultReasoningEffort: "medium",
  },
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
];

const CLAUDE_CODE_SELECTED_ONLY_CATALOG: readonly ClaudeCodeCatalogEntry[] = [
  {
    id: "opus[1m]",
    model: "opus[1m]",
    displayName: "Opus Alias (1M, Legacy)",
    description: "Legacy moving Opus 1M alias retained for existing selections",
    supportedReasoningEfforts: OPUS_4_6_REASONING_EFFORTS,
    defaultReasoningEffort: "medium",
  },
  {
    id: "opus",
    model: "opus",
    displayName: "Opus Alias (Legacy)",
    description: "Legacy moving Opus alias retained for existing selections",
    supportedReasoningEfforts: OPUS_4_6_REASONING_EFFORTS,
    defaultReasoningEffort: "medium",
  },
  {
    id: "sonnet[1m]",
    model: "sonnet[1m]",
    displayName: "Sonnet Alias (1M, Legacy)",
    description: "Legacy moving Sonnet 1M alias retained for existing selections",
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

export function listClaudeCodeModels(
  args: ListClaudeCodeModelsArgs = {},
): AvailableModel[] {
  return includeSelectedOnlyModels({
    activeModels: markDefaultModel(CLAUDE_CODE_CATALOG.map(buildCatalogModel)),
    selectedModel: args.selectedModel,
    selectedOnlyModels: CLAUDE_CODE_SELECTED_ONLY_CATALOG.map(buildCatalogModel),
  });
}
