import type {
  PendingInteraction,
  PendingInteractionUserQuestionQuestion,
} from "@bb/domain";
import {
  isApprovalPendingInteractionPayload,
  isUserQuestionPendingInteractionPayload,
} from "@bb/domain";
import { assertNever } from "./assert-never.js";
import { summarizePendingInteractionRequestedPermissions } from "./pending-interaction-formatting.js";
import { describePendingInteractionToolUse } from "./pending-interaction-tool-use.js";

type PendingInteractionPresentationSurface = "app" | "cli";

interface FormatPendingInteractionSummaryArgs {
  interaction: PendingInteraction;
  surface: PendingInteractionPresentationSurface;
}

interface FormatPendingInteractionUserQuestionOptionLabelArgs {
  question: PendingInteractionUserQuestionQuestion;
  value: string;
}

export function formatPendingInteractionUserQuestionOptionLabel({
  question,
  value,
}: FormatPendingInteractionUserQuestionOptionLabelArgs): string {
  return (
    question.options?.find((option) => option.value === value)?.label ?? value
  );
}

export function formatPendingInteractionSummary(
  args: FormatPendingInteractionSummaryArgs,
): string {
  const { interaction, surface } = args;

  if (isUserQuestionPendingInteractionPayload(interaction.payload)) {
    return interaction.payload.questions[0]?.prompt ?? "User answer requested";
  }

  if (!isApprovalPendingInteractionPayload(interaction.payload)) {
    return interaction.payload.title;
  }

  if (interaction.payload.reason) {
    return interaction.payload.reason;
  }

  switch (interaction.payload.subject.kind) {
    case "command":
      return interaction.payload.subject.command;
    case "file_change":
      return "File changes pending approval";
    case "plan":
      return "Plan ready for review";
    case "tool_use":
      return describePendingInteractionToolUse({
        ...interaction.payload,
        subject: interaction.payload.subject,
      }).title;
    case "permission_grant":
      break;
    default:
      return assertNever(interaction.payload.subject);
  }

  if (surface === "app") {
    const requestedPermissionSummary =
      summarizePendingInteractionRequestedPermissions(
        interaction.payload.subject.permissions,
      );
    if (requestedPermissionSummary.length > 0) {
      return requestedPermissionSummary.join(" . ");
    }
    return "Review requested permissions";
  }

  return interaction.payload.subject.toolName ?? "Permission request";
}
