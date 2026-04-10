import {
  type PendingInteraction,
  type PendingInteractionCommandApprovalDecision,
  type PendingInteractionGrantedPermissionProfile,
  type PendingInteractionPermissionGrantScope,
  type PendingInteractionRequestedPermissionProfile,
  getPendingInteractionCommandApprovalDecisionKind,
  summarizePendingInteractionRequestedPermissions,
} from "@bb/domain";

export interface UserInputDraftState {
  customAnswersByQuestionId: Record<string, string>;
  selectedOptionsByQuestionId: Record<string, string[]>;
}

export type FileChangeDecisionAction = "accept_for_session" | "decline" | "cancel";

export interface CommandDecisionButtonConfig {
  decision: PendingInteractionCommandApprovalDecision;
  label: string;
  variant: "default" | "outline" | "ghost";
}

export interface PermissionDecisionButtonConfig {
  label: string;
  permissions: PendingInteractionGrantedPermissionProfile;
  scope: PendingInteractionPermissionGrantScope;
  variant: "default" | "outline";
}

export function describeCommandDecision(
  decision: PendingInteractionCommandApprovalDecision,
): CommandDecisionButtonConfig {
  switch (getPendingInteractionCommandApprovalDecisionKind(decision)) {
    case "accept":
      return {
        decision,
        label: "Approve",
        variant: "default",
      };
    case "accept_for_session":
      return {
        decision,
        label: "Approve for session",
        variant: "default",
      };
    case "decline":
      return {
        decision,
        label: "Deny",
        variant: "outline",
      };
    case "cancel":
      return {
        decision,
        label: "Cancel",
        variant: "ghost",
      };
    case "accept_with_exec_policy_amendment":
      return {
        decision,
        label: "Approve with exec policy amendment",
        variant: "default",
      };
    case "apply_network_policy_amendment":
      return {
        decision,
        label: "Approve with network policy amendment",
        variant: "default",
      };
  }
}

export function hasExpandableDetails(interaction: PendingInteraction): boolean {
  switch (interaction.payload.kind) {
    case "command_approval":
      return (
        interaction.payload.reason !== null ||
        interaction.payload.command !== null ||
        interaction.payload.cwd !== null ||
        interaction.payload.commandActions.length > 0 ||
        interaction.payload.requestedPermissions !== null ||
        interaction.payload.availableDecisions.some((decision) => typeof decision !== "string")
      );
    case "file_change_approval":
      return interaction.payload.grantRoot !== null || interaction.payload.reason !== null;
    case "permission_request":
      return (
        interaction.payload.reason !== null ||
        interaction.payload.toolName !== null ||
        summarizePendingInteractionRequestedPermissions(
          interaction.payload.permissions,
        ).length > 0
      );
    case "user_input_request":
      return true;
  }
}

function describeGrantedPermissions(
  permissions: PendingInteractionRequestedPermissionProfile,
): PendingInteractionGrantedPermissionProfile {
  return {
    network: permissions.network?.enabled === true
      ? { enabled: true }
      : null,
    fileSystem: permissions.fileSystem
      ? {
          read: permissions.fileSystem.read,
          write: permissions.fileSystem.write,
        }
      : null,
  };
}

export function buildPermissionDecisionButtons(
  permissions: PendingInteractionRequestedPermissionProfile,
): PermissionDecisionButtonConfig[] {
  const grantedPermissions = describeGrantedPermissions(permissions);
  return [
    {
      label: "Allow for turn",
      permissions: grantedPermissions,
      scope: "turn",
      variant: "default",
    },
    {
      label: "Allow for session",
      permissions: grantedPermissions,
      scope: "session",
      variant: "default",
    },
    {
      label: "Deny",
      permissions: {
        network: null,
        fileSystem: null,
      },
      scope: "turn",
      variant: "outline",
    },
  ];
}
