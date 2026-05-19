import type { AgentProviderId } from "@bb/agent-providers";
import type { PromptInput } from "@bb/domain";

export type ManagerUserMessageToolName =
  | "mcp__bb-bridge__message_user"
  | "message_user";

export function resolveManagerUserMessageToolName(
  providerId: AgentProviderId,
): ManagerUserMessageToolName {
  switch (providerId) {
    case "claude-code":
      return "mcp__bb-bridge__message_user";
    case "codex":
    case "pi":
      return "message_user";
  }
  const unsupportedProviderId: never = providerId;
  return unsupportedProviderId;
}

export function buildManagerToolReminderText(
  providerId: AgentProviderId,
): string {
  return `[bb system] Reminder: call ${resolveManagerUserMessageToolName(providerId)} to send any user-visible message. Plain assistant text is internal and not shown to the user.`;
}

export function appendManagerToolReminder(
  input: PromptInput[],
  providerId: AgentProviderId,
): PromptInput[] {
  const reminderText = buildManagerToolReminderText(providerId);
  const lastInput = input[input.length - 1];
  if (lastInput?.type === "text" && lastInput.text === reminderText) {
    return input;
  }

  return [...input, { type: "text", text: reminderText }];
}
