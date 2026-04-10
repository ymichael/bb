import type {
  PendingInteractionCommandApprovalDecision,
  PendingInteractionFileChangeApprovalDecision,
  PendingInteractionGrantablePermissionProfile,
  PendingInteractionGrantedPermissionProfile,
  PendingInteractionMacOsPermissions,
  PermissionRequestPendingInteractionResolution,
  PendingInteractionRequestedPermissionProfile,
} from "@bb/domain";

export type PendingInteractionCommandApprovalDecisionKind =
  | "accept"
  | "accept_for_session"
  | "decline"
  | "cancel"
  | "accept_with_exec_policy_amendment"
  | "apply_network_policy_amendment";

export type PendingInteractionPermissionResolutionSummaryArgs =
  PermissionRequestPendingInteractionResolution;
type PendingInteractionPermissionSummaryProfile =
  | PendingInteractionGrantablePermissionProfile
  | PendingInteractionRequestedPermissionProfile;

export function summarizePendingInteractionRequestedMacOsPermissions(
  permissions: PendingInteractionMacOsPermissions | null,
): string[] {
  if (permissions === null) {
    return [];
  }

  const summaries: string[] = [];
  if (permissions.accessibility) {
    summaries.push("macOS accessibility");
  }
  if (permissions.launchServices) {
    summaries.push("macOS launch services");
  }
  if (permissions.calendar) {
    summaries.push("macOS calendar");
  }
  if (permissions.reminders) {
    summaries.push("macOS reminders");
  }
  if (permissions.preferences !== "none") {
    summaries.push(`macOS preferences (${permissions.preferences.replace("_", " ")})`);
  }
  if (permissions.contacts !== "none") {
    summaries.push(`macOS contacts (${permissions.contacts.replace("_", " ")})`);
  }
  if (permissions.automations === "all") {
    summaries.push("macOS automation (all apps)");
  } else if (
    permissions.automations !== "none"
    && permissions.automations.bundleIds.length > 0
  ) {
    summaries.push(
      permissions.automations.bundleIds.length === 1
        ? "macOS automation (1 app)"
        : `macOS automation (${permissions.automations.bundleIds.length} apps)`,
    );
  }

  return summaries;
}

export function summarizePendingInteractionRequestedPermissions(
  permissions: PendingInteractionPermissionSummaryProfile,
): string[] {
  const summaries: string[] = [];
  if (permissions.network?.enabled === true) {
    summaries.push("Network access");
  }
  if (permissions.fileSystem) {
    if (permissions.fileSystem.read.length > 0) {
      summaries.push(
        permissions.fileSystem.read.length === 1
          ? "Read 1 path"
          : `Read ${permissions.fileSystem.read.length} paths`,
      );
    }
    if (permissions.fileSystem.write.length > 0) {
      summaries.push(
        permissions.fileSystem.write.length === 1
          ? "Write 1 path"
          : `Write ${permissions.fileSystem.write.length} paths`,
      );
    }
  }

  return [
    ...summaries,
    ...summarizePendingInteractionRequestedMacOsPermissions(
      "macos" in permissions ? permissions.macos : null,
    ),
  ];
}

export function toGrantedPendingInteractionPermissions(
  permissions: PendingInteractionPermissionSummaryProfile,
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

export function getPendingInteractionCommandApprovalDecisionKind(
  decision: PendingInteractionCommandApprovalDecision,
): PendingInteractionCommandApprovalDecisionKind {
  return typeof decision === "string" ? decision : decision.kind;
}

export function formatPendingInteractionCommandApprovalDecision(
  decision: PendingInteractionCommandApprovalDecision,
): string {
  if (typeof decision === "string") {
    return decision;
  }

  switch (decision.kind) {
    case "accept_with_exec_policy_amendment":
      return `accept_with_exec_policy_amendment(${decision.execPolicyAmendment.join(", ")})`;
    case "apply_network_policy_amendment":
      return `apply_network_policy_amendment(${decision.networkPolicyAmendment.action} ${decision.networkPolicyAmendment.host})`;
  }
}

export function formatPendingInteractionCommandApprovalResolutionOutcome(
  decision: PendingInteractionCommandApprovalDecision,
): string {
  if (typeof decision === "string") {
    switch (decision) {
      case "accept":
        return "approved";
      case "accept_for_session":
        return "approved for this session";
      case "decline":
        return "denied";
      case "cancel":
        return "cancelled";
    }
  }

  switch (decision.kind) {
    case "accept_with_exec_policy_amendment":
      return "approved with exec policy amendment";
    case "apply_network_policy_amendment":
      return "approved with network policy amendment";
  }
}

export function formatPendingInteractionCommandApprovalResolutionMessage(
  decision: PendingInteractionCommandApprovalDecision,
): string {
  if (typeof decision === "string" && decision === "cancel") {
    return "Command request cancelled";
  }

  return `Command ${formatPendingInteractionCommandApprovalResolutionOutcome(decision)}`;
}

export function isPendingInteractionCommandApprovalPositiveDecision(
  decision: PendingInteractionCommandApprovalDecision,
): boolean {
  switch (getPendingInteractionCommandApprovalDecisionKind(decision)) {
    case "accept":
    case "accept_for_session":
    case "accept_with_exec_policy_amendment":
    case "apply_network_policy_amendment":
      return true;
    case "decline":
    case "cancel":
      return false;
  }
}

export function formatPendingInteractionFileChangeApprovalResolutionOutcome(
  decision: PendingInteractionFileChangeApprovalDecision,
): string {
  switch (decision) {
    case "accept":
      return "approved";
    case "accept_for_session":
      return "approved for this session";
    case "decline":
      return "denied";
    case "cancel":
      return "cancelled";
  }
}

export function formatPendingInteractionFileChangeApprovalResolutionMessage(
  decision: PendingInteractionFileChangeApprovalDecision,
): string {
  if (decision === "cancel") {
    return "File-change request cancelled";
  }

  return `File changes ${formatPendingInteractionFileChangeApprovalResolutionOutcome(decision)}`;
}

function hasPendingInteractionGrantedPermissions(
  permissions: PendingInteractionGrantedPermissionProfile,
): boolean {
  return (
    permissions.network?.enabled === true ||
    (permissions.fileSystem !== null
      && (permissions.fileSystem.read.length > 0 || permissions.fileSystem.write.length > 0))
  );
}

export function formatPendingInteractionPermissionResolutionOutcome(
  args: PendingInteractionPermissionResolutionSummaryArgs,
): string {
  if (args.decision === "deny") {
    return "denied";
  }

  if (!hasPendingInteractionGrantedPermissions(args.permissions)) {
    return "denied";
  }

  switch (args.scope) {
    case "turn":
      return "granted for this turn";
    case "session":
      return "granted for this session";
  }
}

export function formatPendingInteractionPermissionResolutionMessage(
  args: PendingInteractionPermissionResolutionSummaryArgs,
): string {
  if (args.decision === "deny") {
    return "Permission request denied";
  }

  if (!hasPendingInteractionGrantedPermissions(args.permissions)) {
    return "Permission request denied";
  }

  return `Permissions ${formatPendingInteractionPermissionResolutionOutcome(args)}`;
}
