import { OptionPicker, type PickerOption } from "./OptionPicker";
import { StoryCard, StoryRow } from "../../../.ladle/story-card";

export default {
  title: "pickers/Option Picker",
};

const reasoningOptions: readonly PickerOption<string>[] = [
  { value: "low", label: "Low" },
  { value: "medium", label: "Medium" },
  { value: "high", label: "High" },
  { value: "xhigh", label: "Extra High" },
];

const longOptions: readonly PickerOption<string>[] = [
  {
    value: "short",
    label: "Short option",
    description: "A compact option with one short description line.",
  },
  {
    value: "long",
    label:
      "Use the existing branch and preserve all queued background context before launching",
    description:
      "Long option labels and descriptions should wrap inside the menu instead of forcing the picker wider or truncating important text.",
  },
  {
    value: "warning",
    label: "Require approval before running workspace-write commands",
    description:
      "This warning copy intentionally spans multiple lines so the row height can grow without clipping the checkmark or icon.",
    tone: "warning",
  },
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
      <StoryRow label="wrapping menu" hint="long labels and descriptions">
        <OptionPicker
          label="Launch behavior"
          value="long"
          options={longOptions}
          onChange={noop}
          defaultOpen
          modal={false}
        />
      </StoryRow>
    </StoryCard>
  );
}
