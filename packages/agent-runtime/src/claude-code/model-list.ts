import type { ModelInfo } from "@anthropic-ai/claude-agent-sdk";
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

const FALLBACK_CLAUDE_CODE_MODELS: AvailableModel[] = [
  {
    id: "claude-sonnet-4-6",
    model: "claude-sonnet-4-6",
    displayName: "Claude Sonnet 4.6",
    description: "Fast, intelligent model for everyday coding tasks",
    supportedReasoningEfforts: [LOW_REASONING_EFFORT, MEDIUM_REASONING_EFFORT, HIGH_REASONING_EFFORT],
    defaultReasoningEffort: "medium",
    isDefault: true,
  },
  {
    id: "claude-opus-4-6",
    model: "claude-opus-4-6",
    displayName: "Claude Opus 4.6",
    description: "Most capable model for complex coding tasks",
    supportedReasoningEfforts: [LOW_REASONING_EFFORT, MEDIUM_REASONING_EFFORT, HIGH_REASONING_EFFORT, XHIGH_REASONING_EFFORT],
    defaultReasoningEffort: "medium",
    isDefault: false,
  },
  {
    id: "claude-haiku-4-5",
    model: "claude-haiku-4-5",
    displayName: "Claude Haiku 4.5",
    description: "Fast, compact model for simple tasks",
    supportedReasoningEfforts: [LOW_REASONING_EFFORT, MEDIUM_REASONING_EFFORT],
    defaultReasoningEffort: "low",
    isDefault: false,
  },
];

type ClaudeSdkModelInfo = Pick<
  ModelInfo,
  | "value"
  | "displayName"
  | "description"
  | "supportsEffort"
  | "supportedEffortLevels"
>;

function cloneAvailableModel(model: AvailableModel): AvailableModel {
  return {
    ...model,
    supportedReasoningEfforts: [...model.supportedReasoningEfforts],
  };
}

function toClaudeReasoningEfforts(
  model: ClaudeSdkModelInfo,
): ModelReasoningEffort[] {
  if (!model.supportsEffort) {
    return [LOW_REASONING_EFFORT];
  }

  const levels = model.supportedEffortLevels ?? ["low", "medium", "high"];
  const efforts: ModelReasoningEffort[] = [];
  for (const level of levels) {
    if (level === "low") {
      efforts.push(LOW_REASONING_EFFORT);
      continue;
    }
    if (level === "medium") {
      efforts.push(MEDIUM_REASONING_EFFORT);
      continue;
    }
    if (level === "high") {
      efforts.push(HIGH_REASONING_EFFORT);
      continue;
    }
    if (level === "max") {
      efforts.push(XHIGH_REASONING_EFFORT);
    }
  }

  return efforts.length > 0 ? efforts : [LOW_REASONING_EFFORT];
}

function toDefaultReasoningEffort(
  supportedReasoningEfforts: readonly ModelReasoningEffort[],
): AvailableModel["defaultReasoningEffort"] {
  if (supportedReasoningEfforts.some((effort) => effort.reasoningEffort === "medium")) {
    return "medium";
  }
  return supportedReasoningEfforts[0]?.reasoningEffort ?? "low";
}

function resolveDefaultClaudeModelId(
  models: readonly AvailableModel[],
): string | undefined {
  const providerDefault = models.find((model) => model.model === "default");
  if (providerDefault) {
    return providerDefault.id;
  }

  const oneMillionDefault = models.find((model) => model.model.endsWith("[1m]"));
  if (oneMillionDefault) {
    return oneMillionDefault.id;
  }

  return models[0]?.id;
}

export function buildClaudeCodeAvailableModels(
  modelInfos: readonly ClaudeSdkModelInfo[],
): AvailableModel[] {
  const models = modelInfos.map((modelInfo) => {
    const supportedReasoningEfforts = toClaudeReasoningEfforts(modelInfo);
    return {
      id: modelInfo.value,
      model: modelInfo.value,
      displayName: modelInfo.displayName,
      description: modelInfo.description,
      supportedReasoningEfforts,
      defaultReasoningEffort: toDefaultReasoningEffort(
        supportedReasoningEfforts,
      ),
      isDefault: false,
    };
  });

  const defaultModelId = resolveDefaultClaudeModelId(models);
  return models.map((model) =>
    model.id === defaultModelId ? { ...model, isDefault: true } : model,
  );
}

export function listFallbackClaudeCodeModels(): AvailableModel[] {
  return FALLBACK_CLAUDE_CODE_MODELS.map(cloneAvailableModel);
}
