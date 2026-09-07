import SegmentedControl from "@expo/ui/community/segmented-control";
import { haptic } from "@/lib/haptics";
import type { SegmentedChoiceProps } from "./segmented-choice-types";

export function SegmentedChoice<T extends string>({
  options,
  value,
  onChange,
  disabled = false,
  testID,
}: SegmentedChoiceProps<T>) {
  const selectedIndex = Math.max(
    0,
    options.findIndex((option) => option.value === value),
  );
  return (
    <SegmentedControl
      values={options.map((option) => option.label)}
      selectedIndex={selectedIndex}
      enabled={!disabled}
      onChange={(event) => {
        const option = options[event.nativeEvent.selectedSegmentIndex];
        if (option === undefined || option.value === value) return;
        haptic("selection");
        onChange(option.value);
      }}
      testID={testID}
    />
  );
}

export type {
  SegmentedChoiceOption,
  SegmentedChoiceProps,
} from "./segmented-choice-types";
