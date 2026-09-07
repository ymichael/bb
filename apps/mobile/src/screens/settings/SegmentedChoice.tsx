import { View } from "react-native";
import { Button } from "@/ui";
import type { SegmentedChoiceProps } from "./segmented-choice-types";

export function SegmentedChoice<T extends string>({
  options,
  value,
  onChange,
  disabled = false,
  testID,
  testIDPrefix,
}: SegmentedChoiceProps<T>) {
  const prefix = testIDPrefix ?? testID;
  return (
    <View className="flex-row flex-wrap gap-2" testID={testID}>
      {options.map((option) => (
        <Button
          key={option.value}
          size="sm"
          variant={option.value === value ? "default" : "outline"}
          disabled={disabled}
          onPress={() => onChange(option.value)}
          testID={prefix ? `${prefix}-${option.value}` : undefined}
        >
          {option.label}
        </Button>
      ))}
    </View>
  );
}

export type {
  SegmentedChoiceOption,
  SegmentedChoiceProps,
} from "./segmented-choice-types";
