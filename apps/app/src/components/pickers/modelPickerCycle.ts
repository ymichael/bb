import { reasoningLevelValues, type ReasoningLevel } from "@bb/domain";
import type { PickerOption } from "./OptionPicker";

export function nextCycleValue<T extends string>(
  options: readonly PickerOption<T>[],
  current: T,
): T | null {
  if (options.length === 0) return null;
  const index = options.findIndex((option) => option.value === current);
  const next = options[(index + 1) % options.length];
  if (next === undefined || next.value === current) return null;
  return next.value;
}

export function previousCycleValue<T extends string>(
  options: readonly PickerOption<T>[],
  current: T,
): T | null {
  return nextCycleValue([...options].reverse(), current);
}

export function cycleReasoningValue(
  options: readonly PickerOption<ReasoningLevel>[],
  current: ReasoningLevel,
  direction: "forward" | "backward",
): ReasoningLevel | null {
  const supported = new Set(options.map((option) => option.value));
  const orderedOptions = reasoningLevelValues.filter((level) =>
    supported.has(level),
  );
  const currentRank = reasoningLevelValues.indexOf(current);
  let candidate: ReasoningLevel | undefined;
  if (direction === "forward") {
    candidate = orderedOptions.find(
      (level) => reasoningLevelValues.indexOf(level) > currentRank,
    );
    candidate ??= orderedOptions[0];
  } else {
    for (let index = orderedOptions.length - 1; index >= 0; index -= 1) {
      const level = orderedOptions[index];
      if (
        level !== undefined &&
        reasoningLevelValues.indexOf(level) < currentRank
      ) {
        candidate = level;
        break;
      }
    }
    candidate ??= orderedOptions.at(-1);
  }
  if (candidate === undefined || candidate === current) return null;
  return candidate;
}
