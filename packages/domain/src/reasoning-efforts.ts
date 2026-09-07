import type { ModelReasoningEffort } from "./provider-types.js";
import type { ReasoningLevel } from "./shared-types.js";

export const NONE_REASONING_EFFORT: ModelReasoningEffort = {
  reasoningEffort: "none",
  description: "No extended thinking",
};
export const LOW_REASONING_EFFORT: ModelReasoningEffort = {
  reasoningEffort: "low",
  description: "Low reasoning effort",
};
export const MEDIUM_REASONING_EFFORT: ModelReasoningEffort = {
  reasoningEffort: "medium",
  description: "Medium reasoning effort",
};
export const HIGH_REASONING_EFFORT: ModelReasoningEffort = {
  reasoningEffort: "high",
  description: "High reasoning effort",
};
export const XHIGH_REASONING_EFFORT: ModelReasoningEffort = {
  reasoningEffort: "xhigh",
  description: "Extra high reasoning effort",
};
export const ULTRACODE_REASONING_EFFORT: ModelReasoningEffort = {
  reasoningEffort: "ultracode",
  description:
    "Extra high reasoning effort plus multi-agent workflow orchestration",
};
export const MAX_REASONING_EFFORT: ModelReasoningEffort = {
  reasoningEffort: "max",
  description: "Maximum reasoning effort",
};
const ULTRA_REASONING_EFFORT: ModelReasoningEffort = {
  reasoningEffort: "ultra",
  description: "Maximum reasoning with automatic task delegation",
};

const REASONING_EFFORT_BY_LEVEL: Record<ReasoningLevel, ModelReasoningEffort> =
  {
    none: NONE_REASONING_EFFORT,
    low: LOW_REASONING_EFFORT,
    medium: MEDIUM_REASONING_EFFORT,
    high: HIGH_REASONING_EFFORT,
    xhigh: XHIGH_REASONING_EFFORT,
    ultracode: ULTRACODE_REASONING_EFFORT,
    max: MAX_REASONING_EFFORT,
    ultra: ULTRA_REASONING_EFFORT,
  };

export function reasoningEffortsForLevels(
  levels: readonly ReasoningLevel[],
): ModelReasoningEffort[] {
  return levels.map((level) => ({ ...REASONING_EFFORT_BY_LEVEL[level] }));
}
