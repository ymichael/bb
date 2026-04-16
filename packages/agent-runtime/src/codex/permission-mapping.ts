import type {
  PendingInteractionApprovalDecision,
  PendingInteractionGrantedPermissionProfile,
  PendingInteractionGrantablePermissionProfile,
  PendingInteractionRequestedPermissionProfile,
} from "@bb/domain";
import type { CommandExecutionRequestApprovalResponse } from "./generated/codex-app-server/schema/v2/CommandExecutionRequestApprovalResponse.js";
import type { FileChangeRequestApprovalResponse } from "./generated/codex-app-server/schema/v2/FileChangeRequestApprovalResponse.js";
import type { PermissionsRequestApprovalResponse } from "./generated/codex-app-server/schema/v2/PermissionsRequestApprovalResponse.js";
import { normalizePendingInteractionRequestedPermissionProfile } from "../shared/pending-interaction-normalization.js";
import { ProviderRequestDecodeError } from "../runtime-json-rpc.js";
import type {
  CodexAdditionalPermissions,
  CodexCommandApprovalDecision,
  CodexRequestedPermissionProfile,
  CodexSimpleCommandApprovalDecision,
} from "./schemas.js";

const codexToPendingInteractionApprovalDecision = {
  accept: "allow_once",
  acceptForSession: "allow_for_session",
  decline: "deny",
  cancel: "deny",
} satisfies Record<
  CodexSimpleCommandApprovalDecision,
  PendingInteractionApprovalDecision
>;

export const pendingInteractionToCodexSimpleApprovalDecision = {
  allow_once: "accept",
  allow_for_session: "acceptForSession",
  deny: "decline",
} satisfies Record<
  PendingInteractionApprovalDecision,
  Exclude<CodexSimpleCommandApprovalDecision, "cancel">
>;

export const pendingInteractionToCodexFileChangeApprovalDecision = {
  allow_once: "accept",
  allow_for_session: "acceptForSession",
  deny: "decline",
} satisfies Record<
  PendingInteractionApprovalDecision,
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
  permissions: CodexAdditionalPermissions | CodexRequestedPermissionProfile,
): PendingInteractionGrantablePermissionProfile {
  if (
    "macos" in permissions
    && permissions.macos !== null
    && permissions.macos !== undefined
  ) {
    throw new ProviderRequestDecodeError(
      "Codex macOS permission grants are not supported by the provider-neutral permission layer",
    );
  }
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
  decision: CodexSimpleCommandApprovalDecision,
): PendingInteractionApprovalDecision {
  return codexToPendingInteractionApprovalDecision[decision];
}

type CodexPolicyAmendmentDecision = Extract<CodexCommandApprovalDecision, object>;

function isCodexPolicyAmendmentDecision(
  decision: CodexCommandApprovalDecision,
): decision is CodexPolicyAmendmentDecision {
  return (
    typeof decision === "object" &&
    decision !== null &&
    (
      "acceptWithExecpolicyAmendment" in decision ||
      "applyNetworkPolicyAmendment" in decision
    )
  );
}

export function toCodexCommandApprovalDecision(
  decision: PendingInteractionApprovalDecision,
): CommandExecutionRequestApprovalResponse["decision"] {
  return pendingInteractionToCodexSimpleApprovalDecision[decision];
}

export function parseCodexAvailableDecisions(
  decisions: CodexCommandApprovalDecision[] | null | undefined,
): PendingInteractionApprovalDecision[] {
  if (!decisions) {
    return ["allow_once", "allow_for_session", "deny"];
  }
  if (decisions.length === 0) {
    throw new ProviderRequestDecodeError(
      "Command approval requests must include at least one available decision",
    );
  }

  const mappedDecisions: PendingInteractionApprovalDecision[] = [];
  for (const decision of decisions) {
    if (isCodexPolicyAmendmentDecision(decision)) {
      continue;
    }
    mappedDecisions.push(fromCodexCommandApprovalDecision(decision));
  }
  const uniqueDecisions = [...new Set(mappedDecisions)];
  if (uniqueDecisions.length === 0) {
    throw new ProviderRequestDecodeError(
      "Command approval request did not include provider-neutral decisions",
    );
  }
  return uniqueDecisions;
}
