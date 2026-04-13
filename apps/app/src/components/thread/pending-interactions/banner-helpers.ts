import {
  getPendingInteractionCommandApprovalDecisionKind,
  toGrantedPendingInteractionPermissions,
} from "@bb/core-ui";
import {
  type PendingInteractionCommandApprovalDecision,
  type PendingInteractionGrantablePermissionProfile,
  type PermissionRequestPendingInteractionResolution,
} from "@bb/domain";

export interface PermissionDecisionButtonConfig {
  label: string;
  resolution: PermissionRequestPendingInteractionResolution;
  variant: "default" | "outline";
}

export function labelForCommandDecision(
  decision: PendingInteractionCommandApprovalDecision,
): string {
  switch (getPendingInteractionCommandApprovalDecisionKind(decision)) {
    case "accept":
      return "Yes";
    case "accept_for_session":
      return "Yes, and don't ask again this session";
    case "accept_with_exec_policy_amendment":
      return "Yes, and always allow similar commands";
    case "apply_network_policy_amendment":
      return "Yes, and always allow this host";
    case "decline":
      return "No";
    case "cancel":
      return "Cancel";
  }
}

export function buildPermissionDecisionButtons(
  permissions: PendingInteractionGrantablePermissionProfile,
): PermissionDecisionButtonConfig[] {
  const grantedPermissions = toGrantedPendingInteractionPermissions(permissions);
  return [
    {
      label: "Allow for turn",
      resolution: {
        kind: "permission_request",
        decision: "allow",
        permissions: grantedPermissions,
        scope: "turn",
      },
      variant: "default",
    },
    {
      label: "Allow for session",
      resolution: {
        kind: "permission_request",
        decision: "allow",
        permissions: grantedPermissions,
        scope: "session",
      },
      variant: "default",
    },
    {
      label: "Deny",
      resolution: {
        kind: "permission_request",
        decision: "deny",
      },
      variant: "outline",
    },
  ];
}
