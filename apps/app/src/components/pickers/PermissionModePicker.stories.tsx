import type { PermissionMode } from "@bb/domain";
import { PermissionModePicker } from "./PermissionModePicker";
import type { PickerOption } from "./OptionPicker";
import { StoryCard, StoryRow } from "../../../.ladle/story-card";

export default {
  title: "pickers/Permission Mode Picker",
};

// Mirrors PERMISSION_MODE_OPTIONS in useThreadCreationOptions.ts
const allOptions: readonly PickerOption<PermissionMode>[] = [
  { value: "full", label: "Full Access", tone: "warning" },
  { value: "workspace-write", label: "Workspace Write" },
  { value: "readonly", label: "Readonly" },
];

const noop = () => {};

export function Overview() {
  return (
    <StoryCard>
      <StoryRow label="default" hint="muted by default — used in prompt-box only">
        <PermissionModePicker
          value="workspace-write"
          options={allOptions}
          onChange={noop}
          supported
        />
      </StoryRow>
      <StoryRow label="full access selected" hint='warning tone'>
        <PermissionModePicker
          value="full"
          options={allOptions}
          onChange={noop}
          supported
        />
      </StoryRow>
      <StoryRow
        label="non-muted"
        hint="explicit muted={false} — for non-prompt-box use"
      >
        <PermissionModePicker
          value="workspace-write"
          options={allOptions}
          onChange={noop}
          supported
          muted={false}
        />
      </StoryRow>
      <StoryRow label="open menu" hint="defaultOpen + modal=false">
        <PermissionModePicker
          value="workspace-write"
          options={allOptions}
          onChange={noop}
          supported
          defaultOpen
          modal={false}
        />
      </StoryRow>
    </StoryCard>
  );
}
