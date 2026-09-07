import type {
  ProviderComposerCommand,
  PromptMentionCommandTrigger,
  ProviderComposerAction,
} from "@bb/domain";

export type ProviderPromptActionCommand = ProviderComposerCommand;

interface ProviderPromptAction {
  kind: "goal" | "plan" | "skills";
  text: string;
  command?: ProviderPromptActionCommand;
}

interface ProviderPromptActionProps {
  skillsTrigger: PromptMentionCommandTrigger | null;
  promptActions: readonly ProviderPromptAction[];
}

export function buildProviderPromptActionProps(
  composerActions: readonly ProviderComposerAction[],
): ProviderPromptActionProps {
  const promptActions: ProviderPromptAction[] = [];
  let skillsTrigger: PromptMentionCommandTrigger | null = null;

  for (const action of composerActions) {
    switch (action.kind) {
      case "skills":
        skillsTrigger = action.trigger;
        promptActions.push({
          kind: action.kind,
          text: action.trigger,
        });
        break;
      case "goal":
      case "plan":
        promptActions.push({
          kind: action.kind,
          command: action.command,
          text: serializedProviderCommand(action.command),
        });
        break;
    }
  }

  return { skillsTrigger, promptActions };
}

function serializedProviderCommand(command: ProviderComposerCommand): string {
  return `${command.trigger}${command.name}${command.trailingText}`;
}

export function commandPillDismissedRangeEnd({
  triggerPosition,
  trailingText,
}: {
  triggerPosition: number;
  trailingText: string;
}): number {
  return triggerPosition + 1 + trailingText.length;
}
