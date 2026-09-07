export interface SegmentedChoiceOption<T extends string> {
  value: T;
  label: string;
}

export interface SegmentedChoiceProps<T extends string> {
  options: readonly SegmentedChoiceOption<T>[];
  value: T;
  onChange: (value: T) => void;
  disabled?: boolean;
  testID?: string;
  testIDPrefix?: string;
}
