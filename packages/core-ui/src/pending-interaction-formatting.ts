import type {
  PendingInteractionApprovalDecision,
  PendingInteractionCommandAction,
  PendingInteractionGrantablePermissionProfile,
  PendingInteractionGrantedPermissionProfile,
  PendingInteractionMacOsPermissions,
  PendingInteraction,
  PendingInteractionResolution,
  PendingInteractionRequestedPermissionProfile,
} from "@bb/domain";
import { isApprovalPendingInteractionPayload } from "@bb/domain";
import { assertNever } from "./assert-never.js";

type PendingInteractionPermissionSummaryProfile =
  | PendingInteractionGrantablePermissionProfile
  | PendingInteractionRequestedPermissionProfile;

function summarizeRequestedMacOsPermissions(
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
    summaries.push(
      `macOS preferences (${permissions.preferences.replace("_", " ")})`,
    );
  }
  if (permissions.contacts !== "none") {
    summaries.push(
      `macOS contacts (${permissions.contacts.replace("_", " ")})`,
    );
  }
  if (permissions.automations === "all") {
    summaries.push("macOS automation (all apps)");
  } else if (
    permissions.automations !== "none" &&
    permissions.automations.bundleIds.length > 0
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
    ...summarizeRequestedMacOsPermissions(
      "macos" in permissions ? permissions.macos : null,
    ),
  ];
}

function summarizeCommandActions(
  actions: PendingInteractionCommandAction[],
): string[] {
  return actions.map((action) => {
    switch (action.type) {
      case "read":
        return `Read ${action.path}`;
      case "listFiles":
        return action.path ? `List files in ${action.path}` : "List files";
      case "search":
        return action.query
          ? `Search for ${action.query}${action.path ? ` in ${action.path}` : ""}`
          : action.path
            ? `Search in ${action.path}`
            : "Search files";
      case "unknown":
        return action.command;
      default:
        return assertNever(action);
    }
  });
}

function formatPermissionSummaryLine(
  label: string,
  permissions: PendingInteractionGrantablePermissionProfile | null,
): string | null {
  if (permissions === null) {
    return null;
  }
  const summaries =
    summarizePendingInteractionRequestedPermissions(permissions);
  return summaries.length > 0 ? `${label}: ${summaries.join(", ")}` : null;
}

export function formatPendingInteractionSubjectDetailLines(
  interaction: PendingInteraction,
): string[] {
  if (!isApprovalPendingInteractionPayload(interaction.payload)) {
    return interaction.payload.questions.map((question) => question.prompt);
  }
  switch (interaction.payload.subject.kind) {
    case "command": {
      const actionLines = summarizeCommandActions(
        interaction.payload.subject.actions,
      ).map((action) => `Action: ${action}`);
      const sessionGrant = formatPermissionSummaryLine(
        "Session grant",
        interaction.payload.subject.sessionGrant,
      );
      return [
        `Command: ${interaction.payload.subject.command}`,
        ...(interaction.payload.subject.cwd
          ? [`Cwd: ${interaction.payload.subject.cwd}`]
          : []),
        ...actionLines,
        ...(sessionGrant ? [sessionGrant] : []),
      ];
    }
    case "file_change": {
      const sessionGrant = formatPermissionSummaryLine(
        "Session grant",
        interaction.payload.subject.sessionGrant,
      );
      return [
        `Item: ${interaction.payload.subject.itemId}`,
        ...(interaction.payload.subject.writeScope
          ? [`Write root: ${interaction.payload.subject.writeScope}`]
          : []),
        ...(sessionGrant ? [sessionGrant] : []),
      ];
    }
    case "permission_grant": {
      const permissions = summarizePendingInteractionRequestedPermissions(
        interaction.payload.subject.permissions,
      );
      return [
        ...(interaction.payload.subject.toolName
          ? [`Tool: ${interaction.payload.subject.toolName}`]
          : []),
        ...permissions.map((permission) => `Permission: ${permission}`),
      ];
    }
    default:
      return assertNever(interaction.payload.subject);
  }
}

function toGrantedPermissions(
  permissions: PendingInteractionPermissionSummaryProfile,
): PendingInteractionGrantedPermissionProfile {
  return {
    network: permissions.network?.enabled === true ? { enabled: true } : null,
    fileSystem: permissions.fileSystem
      ? {
          read: permissions.fileSystem.read,
          write: permissions.fileSystem.write,
        }
      : null,
  };
}

export function formatPendingInteractionApprovalResolutionOutcome(
  decision: PendingInteractionApprovalDecision,
): string {
  switch (decision) {
    case "allow_once":
      return "approved";
    case "allow_for_session":
      return "approved for this session";
    case "deny":
      return "denied";
    default:
      return assertNever(decision);
  }
}

function resolveGrantedPermissionsForApproval(
  interaction: PendingInteraction,
  decision: PendingInteractionApprovalDecision,
): PendingInteractionGrantedPermissionProfile | null {
  if (!isApprovalPendingInteractionPayload(interaction.payload)) {
    return null;
  }
  if (interaction.payload.subject.kind === "permission_grant") {
    return toGrantedPermissions(interaction.payload.subject.permissions);
  }

  if (decision !== "allow_for_session") {
    return null;
  }

  if (
    interaction.payload.subject.kind === "command" ||
    interaction.payload.subject.kind === "file_change"
  ) {
    return interaction.payload.subject.sessionGrant;
  }

  return null;
}

export function buildPendingInteractionApprovalResolution(
  interaction: PendingInteraction,
  decision: PendingInteractionApprovalDecision,
): PendingInteractionResolution {
  if (decision === "deny") {
    return {
      decision,
    };
  }

  return {
    decision,
    grantedPermissions: resolveGrantedPermissionsForApproval(
      interaction,
      decision,
    ),
  };
}
