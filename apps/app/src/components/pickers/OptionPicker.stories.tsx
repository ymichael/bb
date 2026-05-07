import {
  OptionPicker,
  type PickerOption,
} from "./OptionPicker";
import { StoryCard, StoryRow } from "../../../.ladle/story-card";

export default {
  title: "pickers/Option Picker",
};

// Mirrors REASONING_LABELS from useThreadCreationOptions.ts
const reasoningOptions: readonly PickerOption<string>[] = [
  { value: "low", label: "Low" },
  { value: "medium", label: "Medium" },
  { value: "high", label: "High" },
  { value: "xhigh", label: "Extra High" },
];

const noop = () => {};

export function Overview() {
  return (
    <StoryCard>
      <StoryRow label="default">
        <OptionPicker
          label="Reasoning"
          value="medium"
          options={reasoningOptions}
          onChange={noop}
        />
      </StoryRow>
      <StoryRow label="muted" hint="prompt-box treatment">
        <OptionPicker
          label="Reasoning"
          value="medium"
          options={reasoningOptions}
          onChange={noop}
          muted
        />
      </StoryRow>
      <StoryRow label="open menu" hint="defaultOpen + modal=false">
        <OptionPicker
          label="Reasoning"
          value="medium"
          options={reasoningOptions}
          onChange={noop}
          defaultOpen
          modal={false}
        />
      </StoryRow>
    </StoryCard>
  );
}
