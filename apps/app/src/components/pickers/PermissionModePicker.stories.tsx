import type { PermissionMode } from "@bb/domain";
import { PermissionModePicker } from "./PermissionModePicker";
import type { PickerOption } from "./OptionPicker";
import { StoryCard, StoryRow } from "../../../.ladle/story-card";

export default {
  title: "pickers/Permission Mode Picker",
};

const allOptions: readonly PickerOption<PermissionMode>[] = [
  {
    value: "accept-edits",
    label: "Accept Edits",
    description:
      "Applies edits inside the workspace automatically. Anything beyond the workspace asks you first.",
  },
  {
    value: "auto",
    label: "Approve for me",
    description:
      "Same workspace sandbox, with requests reviewed automatically. High-risk actions can still come back to you.",
  },
  {
    value: "full",
    label: "Full Access",
    tone: "warning",
    description:
      "No sandbox and no approvals — the agent can run anything on your machine.",
  },
];

const longOptions: readonly PickerOption<PermissionMode>[] = [
  {
    value: "accept-edits",
    label: "Accept Edits with repository-scoped writes and background tasks",
    description:
      "Allows file edits in the workspace while keeping the menu content wrapped within the picker width.",
  },
  {
    value: "auto",
    label: "Approve for me with provider-native automatic request review",
    description:
      "Long automatic-review explanations should wrap instead of stretching or clipping the permission menu.",
  },
  {
    value: "full",
    label: "Full Access with approval before every workspace-changing command",
    description:
      "Use this when the agent needs broad execution capability, but the picker should still wrap the warning copy inside the menu.",
    tone: "warning",
  },
];

const noop = () => {};

export function Overview() {
  return (
    <StoryCard>
      <StoryRow
        label="default"
        hint="muted by default — used in prompt-box only"
      >
        <PermissionModePicker
          value="accept-edits"
          options={allOptions}
          onChange={noop}
          supported
        />
      </StoryRow>
      <StoryRow label="full access selected" hint="warning tone">
        <PermissionModePicker
          value="full"
          options={allOptions}
          onChange={noop}
          supported
        />
      </StoryRow>
      <StoryRow
        label="plan mode locked"
        hint="effective Plan Mode display, underlying permission unchanged"
      >
        <PermissionModePicker
          value="full"
          options={allOptions}
          onChange={noop}
          supported
          disabled
          showChevronWhenDisabled
          displayOverride={{
            label: "Plan Mode",
            compactLabel: "Plan",
            description:
              "Claude Code will plan without normal full-access execution.",
          }}
        />
      </StoryRow>
      <StoryRow
        label="non-muted"
        hint="explicit muted={false} — for non-prompt-box use"
      >
        <PermissionModePicker
          value="accept-edits"
          options={allOptions}
          onChange={noop}
          supported
          muted={false}
        />
      </StoryRow>
      <StoryRow label="open menu" hint="defaultOpen + modal=false">
        <PermissionModePicker
          value="accept-edits"
          options={allOptions}
          onChange={noop}
          supported
          defaultOpen
          modal={false}
        />
      </StoryRow>
      <StoryRow label="wrapping menu" hint="long labels and descriptions">
        <PermissionModePicker
          value="accept-edits"
          options={longOptions}
          onChange={noop}
          supported
          defaultOpen
          modal={false}
        />
      </StoryRow>
    </StoryCard>
  );
}
