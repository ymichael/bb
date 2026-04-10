import type { PendingInteraction } from "@bb/domain";
import { summarizePendingInteractionRequestedPermissions } from "@bb/domain";

export type PendingInteractionPresentationSurface = "app" | "cli";

export interface FormatPendingInteractionKindLabelArgs {
  kind: PendingInteraction["payload"]["kind"];
  surface: PendingInteractionPresentationSurface;
}

export function formatPendingInteractionKindLabel(
  args: FormatPendingInteractionKindLabelArgs,
): string {
  switch (args.kind) {
    case "command_approval":
      return args.surface === "app" ? "Command approval" : "command";
    case "file_change_approval":
      return args.surface === "app" ? "File changes" : "file-change";
    case "permission_request":
      return args.surface === "app" ? "Permission request" : "permission";
    case "user_input_request":
      return args.surface === "app" ? "User input" : "question";
  }
}

export interface FormatPendingInteractionSummaryArgs {
  interaction: PendingInteraction;
  surface: PendingInteractionPresentationSurface;
}

export function formatPendingInteractionSummary(
  args: FormatPendingInteractionSummaryArgs,
): string {
  const { interaction, surface } = args;

  switch (interaction.payload.kind) {
    case "command_approval":
      return surface === "app"
        ? interaction.payload.reason
          ?? interaction.payload.command
          ?? "Review requested command"
        : interaction.payload.command
          ?? interaction.payload.reason
          ?? "(no command provided)";
    case "file_change_approval":
      return surface === "app"
        ? interaction.payload.reason ?? "Allow file changes for this thread"
        : interaction.payload.reason
          ?? interaction.payload.grantRoot
          ?? "File changes pending approval";
    case "permission_request": {
      if (interaction.payload.reason) {
        return interaction.payload.reason;
      }

      if (surface === "app") {
        const requestedPermissionSummary = summarizePendingInteractionRequestedPermissions(
          interaction.payload.permissions,
        );
        if (requestedPermissionSummary.length > 0) {
          return requestedPermissionSummary.join(" . ");
        }
        return "Review requested permissions";
      }

      return interaction.payload.toolName ?? "Permission request";
    }
    case "user_input_request":
      return surface === "app"
        ? interaction.payload.questions.length === 1
          ? interaction.payload.questions[0].question
          : `${interaction.payload.questions.length} questions need answers`
        : `${interaction.payload.questions.length} question(s)`;
  }
}
