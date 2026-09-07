import {
  promptInputHasCommandMention,
  type ThreadTimelineActivePromptMode,
  type PromptTextMention,
} from "@bb/domain";

interface PromptModeInput {
  mentionRanges: readonly PromptTextMention[];
  planModeCopy: string | undefined;
  value: string;
}

interface PermissionDisplayOverride {
  label: string;
  compactLabel?: string;
  description?: string;
  title?: string;
}

function planPermissionDisplay(
  planModeCopy: string,
): PermissionDisplayOverride {
  return {
    label: "Plan Mode",
    compactLabel: "Plan",
    description: planModeCopy,
  };
}

export function isPlanModePrompt({
  mentionRanges,
  planModeCopy,
  value,
}: PromptModeInput): boolean {
  return (
    planModeCopy !== undefined &&
    promptInputHasCommandMention(
      [{ type: "text", text: value, mentions: [...mentionRanges] }],
      { trigger: "/", name: "plan" },
    )
  );
}

export function permissionDisplayForPromptMode(
  args: PromptModeInput,
): PermissionDisplayOverride | undefined {
  if (args.planModeCopy === undefined || !isPlanModePrompt(args)) {
    return undefined;
  }
  return planPermissionDisplay(args.planModeCopy);
}

export function permissionDisplayForActivePromptMode(
  activePromptMode: ThreadTimelineActivePromptMode | null | undefined,
  planModeCopy: string | undefined,
): PermissionDisplayOverride | undefined {
  if (activePromptMode?.mode === "plan" && planModeCopy !== undefined) {
    return planPermissionDisplay(planModeCopy);
  }
  return undefined;
}

export function shouldDisablePermissionPickerForActivePromptMode(
  activePromptMode: ThreadTimelineActivePromptMode | null | undefined,
): boolean {
  return activePromptMode?.mode === "plan";
}
