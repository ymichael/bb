import type { ProviderInfo, ReasoningLevel } from "@bb/domain";

const FALLBACK_REASONING_LABELS: Record<ReasoningLevel, string> = {
  none: "None",
  low: "Low",
  medium: "Medium",
  high: "High",
  xhigh: "Extra High",
  ultracode: "Ultracode",
  max: "Max",
  ultra: "Ultra",
};

export type ReasoningLabelSource = Pick<ProviderInfo, "reasoningLevels">;

export function reasoningLevelLabel(
  level: ReasoningLevel,
  provider: ReasoningLabelSource | undefined,
): string {
  const declared = provider?.reasoningLevels?.find(
    (option) => option.id === level,
  );
  return declared?.label ?? FALLBACK_REASONING_LABELS[level] ?? level;
}

const FAST_SERVICE_TIER_ID = "fast";

export function fastServiceTierLabel(
  provider: Pick<ProviderInfo, "serviceTiers"> | undefined,
): string {
  return (
    provider?.serviceTiers?.find((tier) => tier.id === FAST_SERVICE_TIER_ID)
      ?.label ?? "Fast"
  );
}
