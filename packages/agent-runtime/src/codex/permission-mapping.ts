import type {
  PendingInteractionCommandApprovalDecision,
  PendingInteractionCommandApprovalSimpleDecision,
  PendingInteractionFileChangeApprovalDecision,
  PendingInteractionGrantedPermissionProfile,
  PendingInteractionGrantablePermissionProfile,
  PendingInteractionRequestedPermissionProfile,
} from "@bb/domain";
import type { CommandExecutionRequestApprovalResponse } from "./generated/codex-app-server/schema/v2/CommandExecutionRequestApprovalResponse.js";
import type { FileChangeRequestApprovalResponse } from "./generated/codex-app-server/schema/v2/FileChangeRequestApprovalResponse.js";
import type { PermissionsRequestApprovalResponse } from "./generated/codex-app-server/schema/v2/PermissionsRequestApprovalResponse.js";
import { normalizePendingInteractionRequestedPermissionProfile } from "../shared/pending-interaction-normalization.js";
import type {
  CodexAdditionalPermissions,
  CodexCommandApprovalDecision,
  CodexRequestedPermissionProfile,
  CodexSimpleCommandApprovalDecision,
} from "./schemas.js";

const codexToPendingInteractionSimpleCommandApprovalDecision = {
  accept: "accept",
  acceptForSession: "accept_for_session",
  decline: "decline",
  cancel: "cancel",
} satisfies Record<
  CodexSimpleCommandApprovalDecision,
  PendingInteractionCommandApprovalSimpleDecision
>;

const pendingInteractionToCodexSimpleCommandApprovalDecision = {
  accept: "accept",
  accept_for_session: "acceptForSession",
  decline: "decline",
  cancel: "cancel",
} satisfies Record<
  PendingInteractionCommandApprovalSimpleDecision,
  CodexSimpleCommandApprovalDecision
>;

export const pendingInteractionToCodexFileChangeApprovalDecision = {
  accept: "accept",
  accept_for_session: "acceptForSession",
  decline: "decline",
  cancel: "cancel",
} satisfies Record<
  PendingInteractionFileChangeApprovalDecision,
  FileChangeRequestApprovalResponse["decision"]
>;

export function toPendingInteractionPermissionProfile(
  permissions: CodexAdditionalPermissions | CodexRequestedPermissionProfile,
): PendingInteractionRequestedPermissionProfile {
  return normalizePendingInteractionRequestedPermissionProfile({
    network: permissions.network
      ? { enabled: permissions.network.enabled }
      : null,
    fileSystem: permissions.fileSystem
      ? {
          read: permissions.fileSystem.read ?? [],
          write: permissions.fileSystem.write ?? [],
        }
      : null,
    macos:
      "macos" in permissions && permissions.macos
        ? {
            preferences: permissions.macos.preferences,
            automations: permissions.macos.automations,
            launchServices: permissions.macos.launchServices,
            accessibility: permissions.macos.accessibility,
            calendar: permissions.macos.calendar,
            reminders: permissions.macos.reminders,
            contacts: permissions.macos.contacts,
          }
        : null,
  });
}

export function toPendingInteractionGrantablePermissionProfile(
  permissions: CodexRequestedPermissionProfile,
): PendingInteractionGrantablePermissionProfile {
  const normalized = toPendingInteractionPermissionProfile(permissions);
  return {
    network: normalized.network,
    fileSystem: normalized.fileSystem,
  };
}

export function toCodexGrantedPermissionProfile(
  args: PendingInteractionGrantedPermissionProfile,
): PermissionsRequestApprovalResponse["permissions"] {
  return {
    ...(args.network ? { network: { enabled: args.network.enabled } } : {}),
    ...(args.fileSystem
      ? {
          fileSystem: {
            read: args.fileSystem.read.length > 0 ? args.fileSystem.read : null,
            write: args.fileSystem.write.length > 0 ? args.fileSystem.write : null,
          },
        }
      : {}),
  };
}

function fromCodexCommandApprovalDecision(
  decision: CodexCommandApprovalDecision,
): PendingInteractionCommandApprovalDecision {
  if (typeof decision === "string") {
    return codexToPendingInteractionSimpleCommandApprovalDecision[decision];
  }

  if ("acceptWithExecpolicyAmendment" in decision) {
    return {
      kind: "accept_with_exec_policy_amendment",
      execPolicyAmendment: decision.acceptWithExecpolicyAmendment.execpolicy_amendment,
    };
  }

  return {
    kind: "apply_network_policy_amendment",
    networkPolicyAmendment: {
      host: decision.applyNetworkPolicyAmendment.network_policy_amendment.host,
      action: decision.applyNetworkPolicyAmendment.network_policy_amendment.action,
    },
  };
}

export function toCodexCommandApprovalDecision(
  decision: PendingInteractionCommandApprovalDecision,
): CommandExecutionRequestApprovalResponse["decision"] {
  if (typeof decision === "string") {
    return pendingInteractionToCodexSimpleCommandApprovalDecision[decision];
  }

  switch (decision.kind) {
    case "accept_with_exec_policy_amendment":
      return {
        acceptWithExecpolicyAmendment: {
          execpolicy_amendment: decision.execPolicyAmendment,
        },
      };
    case "apply_network_policy_amendment":
      return {
        applyNetworkPolicyAmendment: {
          network_policy_amendment: {
            host: decision.networkPolicyAmendment.host,
            action: decision.networkPolicyAmendment.action,
          },
        },
      };
  }
}

export function parseCodexAvailableDecisions(
  decisions: CodexCommandApprovalDecision[] | null | undefined,
): PendingInteractionCommandApprovalDecision[] | null {
  if (!decisions) {
    return ["accept", "accept_for_session", "decline", "cancel"];
  }
  if (decisions.length === 0) {
    return null;
  }

  return decisions.map(fromCodexCommandApprovalDecision);
}
