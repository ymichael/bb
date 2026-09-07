import { reasoningLevelValues, type ReasoningLevel } from "./shared-types.js";

export function reconcileReasoningLevel(
  previous: ReasoningLevel,
  supported: readonly ReasoningLevel[],
): ReasoningLevel {
  if (supported.length === 0) {
    throw new Error(
      "reconcileReasoningLevel requires at least one supported level",
    );
  }
  if (supported.includes(previous)) return previous;

  const effectivePrevious = previous === "ultracode" ? "xhigh" : previous;
  if (supported.includes(effectivePrevious)) return effectivePrevious;

  const previousRank = reasoningRank(effectivePrevious);
  let bestLevel = supported[0];
  let bestDistance = Math.abs(reasoningRank(bestLevel) - previousRank);
  for (const candidate of supported.slice(1)) {
    const distance = Math.abs(reasoningRank(candidate) - previousRank);
    if (distance < bestDistance) {
      bestLevel = candidate;
      bestDistance = distance;
      continue;
    }
    if (
      distance === bestDistance &&
      reasoningRank(candidate) > reasoningRank(bestLevel)
    ) {
      bestLevel = candidate;
    }
  }
  return bestLevel;
}

function reasoningRank(level: ReasoningLevel): number {
  return reasoningLevelValues.indexOf(level);
}
