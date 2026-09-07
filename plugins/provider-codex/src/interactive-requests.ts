import {
  ProviderRequestDecodeError as ProviderRequestDecodeErrorValue,
  ProviderResponseEncodeError,
  type ApprovalInteractionOutcome,
  type DecodedInteractiveRequest,
  type ProviderInboundRequest,
  type PendingInteractionApprovalDecision,
  type PendingInteractionGrantablePermissionProfile,
  type PendingInteractionGrantedPermissionProfile,
  type PendingInteractionRequestedPermissionProfile,
} from "@get-bb/plugin-sdk/provider-bridge";
import type { CodexMacOsPermissionItem } from "./extension-kinds.js";
import { normalizePendingInteractionRequestedPermissionProfile } from "./pending-interaction-normalization.js";
import type { CommandExecutionRequestApprovalResponse } from "./generated/codex-app-server/schema/v2/CommandExecutionRequestApprovalResponse.js";
import type { FileChangeRequestApprovalResponse } from "./generated/codex-app-server/schema/v2/FileChangeRequestApprovalResponse.js";
import type { PermissionsRequestApprovalResponse } from "./generated/codex-app-server/schema/v2/PermissionsRequestApprovalResponse.js";
import {
  codexCommandExecutionRequestApprovalParamsSchema,
  codexFileChangeRequestApprovalParamsSchema,
  codexPermissionsRequestApprovalParamsSchema,
} from "./schemas.js";
import type {
  CodexAdditionalPermissions,
  CodexCommandApprovalDecision,
  CodexRequestedPermissionProfile,
  CodexSimpleCommandApprovalDecision,
} from "./schemas.js";

type CodexInteractiveResponse =
  | CommandExecutionRequestApprovalResponse
  | FileChangeRequestApprovalResponse
  | PermissionsRequestApprovalResponse;

function assertNever(value: never): never {
  throw new ProviderResponseEncodeError(`Unexpected value: ${String(value)}`);
}

function requireGrantedPermissions(
  args: Extract<
    ApprovalInteractionOutcome["resolution"],
    { decision: "allow_once" | "allow_for_session" }
  >,
) {
  if (args.grantedPermissions === null) {
    throw new ProviderResponseEncodeError(
      "Permission grant approval must include granted permissions",
    );
  }
  return args.grantedPermissions;
}

function hasGrantablePermissions(
  permissions: PendingInteractionGrantablePermissionProfile | null,
): boolean {
  const fileSystem = permissions?.fileSystem ?? null;
  return (
    permissions?.network?.enabled === true ||
    (fileSystem !== null &&
      (fileSystem.read.length > 0 || fileSystem.write.length > 0))
  );
}

function filterSessionDecisionWithoutGrant(
  decisions: PendingInteractionApprovalDecision[],
  sessionGrant: PendingInteractionGrantablePermissionProfile | null,
): PendingInteractionApprovalDecision[] {
  if (hasGrantablePermissions(sessionGrant)) {
    return decisions;
  }

  const filtered = decisions.filter(
    (decision) => decision !== "allow_for_session",
  );
  if (filtered.length === 0) {
    throw new ProviderRequestDecodeErrorValue(
      "Approval request did not include decisions compatible with the requested permissions",
    );
  }
  return filtered;
}

export function decodeCodexInteractiveRequest(
  request: ProviderInboundRequest,
): DecodedInteractiveRequest | null {
  if (typeof request.id !== "string" && typeof request.id !== "number") {
    return null;
  }

  switch (request.method) {
    case "item/commandExecution/requestApproval": {
      const parsed = codexCommandExecutionRequestApprovalParamsSchema.safeParse(
        request.params,
      );
      if (!parsed.success) {
        return null;
      }
      const availableDecisions = parseCodexAvailableDecisions(
        parsed.data.availableDecisions,
      );
      if (!parsed.data.command) {
        throw new ProviderRequestDecodeErrorValue(
          "Command approval request did not include a command subject",
        );
      }
      const sessionGrant = parsed.data.additionalPermissions
        ? toPendingInteractionGrantablePermissionProfile(
            parsed.data.additionalPermissions,
          )
        : null;
      return {
        requestId: request.id,
        method: request.method,
        providerThreadId: parsed.data.threadId,
        turnId: parsed.data.turnId,
        payload: {
          kind: "approval",
          subject: {
            kind: "command",
            itemId: parsed.data.itemId,
            command: parsed.data.command,
            cwd: parsed.data.cwd ?? null,
            actions: parsed.data.commandActions ?? [],
            sessionGrant: hasGrantablePermissions(sessionGrant)
              ? sessionGrant
              : null,
          },
          reason: parsed.data.reason ?? null,
          availableDecisions: filterSessionDecisionWithoutGrant(
            availableDecisions,
            sessionGrant,
          ),
        },
      };
    }
    case "item/fileChange/requestApproval": {
      const parsed = codexFileChangeRequestApprovalParamsSchema.safeParse(
        request.params,
      );
      if (!parsed.success) {
        return null;
      }
      const sessionGrant: PendingInteractionGrantablePermissionProfile | null =
        parsed.data.grantRoot
          ? {
              network: null,
              fileSystem: {
                read: [],
                write: [parsed.data.grantRoot],
              },
            }
          : null;
      return {
        requestId: request.id,
        method: request.method,
        providerThreadId: parsed.data.threadId,
        turnId: parsed.data.turnId,
        payload: {
          kind: "approval",
          subject: {
            kind: "file_change",
            itemId: parsed.data.itemId,
            writeScope: parsed.data.grantRoot ?? null,
            sessionGrant,
          },
          reason: parsed.data.reason ?? null,
          availableDecisions: filterSessionDecisionWithoutGrant(
            ["allow_once", "allow_for_session", "deny"],
            sessionGrant,
          ),
        },
      };
    }
    case "item/permissions/requestApproval": {
      const parsed = codexPermissionsRequestApprovalParamsSchema.safeParse(
        request.params,
      );
      if (!parsed.success) {
        return null;
      }
      const permissions = toPendingInteractionGrantablePermissionProfile(
        parsed.data.permissions,
      );
      return {
        requestId: request.id,
        method: request.method,
        providerThreadId: parsed.data.threadId,
        turnId: parsed.data.turnId,
        payload: {
          kind: "approval",
          subject: {
            kind: "permission_grant",
            itemId: parsed.data.itemId,
            toolName: null,
            permissions,
          },
          reason: parsed.data.reason,
          availableDecisions: ["allow_once", "allow_for_session", "deny"],
        },
      };
    }
    default:
      return null;
  }
}

export function buildCodexInteractiveResponse(
  args: ApprovalInteractionOutcome,
): CodexInteractiveResponse {
  switch (args.payload.subject.kind) {
    case "command": {
      const response: CommandExecutionRequestApprovalResponse = {
        decision: toCodexCommandApprovalDecision(args.resolution.decision),
      };
      return response;
    }
    case "file_change": {
      const response: FileChangeRequestApprovalResponse = {
        decision:
          pendingInteractionToCodexFileChangeApprovalDecision[
            args.resolution.decision
          ],
      };
      return response;
    }
    case "permission_grant": {
      if (args.resolution.decision === "deny") {
        const response: PermissionsRequestApprovalResponse = {
          permissions: {},
          scope: "turn",
        };
        return response;
      }
      const response: PermissionsRequestApprovalResponse = {
        permissions: toCodexGrantedPermissionProfile(
          requireGrantedPermissions(args.resolution),
        ),
        scope:
          args.resolution.decision === "allow_for_session" ? "session" : "turn",
      };
      return response;
    }
    case "plan":
      throw new ProviderResponseEncodeError(
        "Codex plan-review interactive requests are unsupported",
      );
    case "tool_use":
      throw new ProviderResponseEncodeError(
        "tool_use approval subjects are not produced by the Codex bridge",
      );
    default:
      return assertNever(args.payload.subject);
  }
}

const codexToPendingInteractionApprovalDecision = {
  accept: "allow_once",
  acceptForSession: "allow_for_session",
  decline: "deny",
  cancel: "deny",
} satisfies Record<
  CodexSimpleCommandApprovalDecision,
  PendingInteractionApprovalDecision
>;

const pendingInteractionToCodexSimpleApprovalDecision = {
  allow_once: "accept",
  allow_for_session: "acceptForSession",
  deny: "decline",
} satisfies Record<
  PendingInteractionApprovalDecision,
  Exclude<CodexSimpleCommandApprovalDecision, "cancel">
>;

const pendingInteractionToCodexFileChangeApprovalDecision = {
  allow_once: "accept",
  allow_for_session: "acceptForSession",
  deny: "decline",
} satisfies Record<
  PendingInteractionApprovalDecision,
  FileChangeRequestApprovalResponse["decision"]
>;

function toPendingInteractionPermissionProfile(
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

function toPendingInteractionGrantablePermissionProfile(
  permissions: CodexAdditionalPermissions | CodexRequestedPermissionProfile,
): PendingInteractionGrantablePermissionProfile {
  const normalized = toPendingInteractionPermissionProfile(permissions);
  return {
    network: normalized.network,
    fileSystem: normalized.fileSystem,
  };
}

export interface CodexMacOsPermissionRequest {
  providerThreadId: string;
  turnId: string;
  item: CodexMacOsPermissionItem;
}

export function extractCodexMacOsPermissionRequest(
  request: ProviderInboundRequest,
): CodexMacOsPermissionRequest | null {
  if (request.method !== "item/commandExecution/requestApproval") {
    return null;
  }
  const parsed = codexCommandExecutionRequestApprovalParamsSchema.safeParse(
    request.params,
  );
  if (!parsed.success) {
    return null;
  }
  const macos = parsed.data.additionalPermissions?.macos;
  if (macos === null || macos === undefined) {
    return null;
  }
  return {
    providerThreadId: parsed.data.threadId,
    turnId: parsed.data.turnId,
    item: {
      approvalItemId: parsed.data.itemId,
      reason: parsed.data.reason ?? null,
      permissions: macos,
    },
  };
}

function toCodexGrantedPermissionProfile(
  args: PendingInteractionGrantedPermissionProfile,
): PermissionsRequestApprovalResponse["permissions"] {
  return {
    ...(args.network ? { network: { enabled: args.network.enabled } } : {}),
    ...(args.fileSystem
      ? {
          fileSystem: {
            read: args.fileSystem.read.length > 0 ? args.fileSystem.read : null,
            write:
              args.fileSystem.write.length > 0 ? args.fileSystem.write : null,
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

type CodexPolicyAmendmentDecision = Extract<
  CodexCommandApprovalDecision,
  object
>;

function isCodexPolicyAmendmentDecision(
  decision: CodexCommandApprovalDecision,
): decision is CodexPolicyAmendmentDecision {
  return (
    typeof decision === "object" &&
    decision !== null &&
    ("acceptWithExecpolicyAmendment" in decision ||
      "applyNetworkPolicyAmendment" in decision)
  );
}

function toCodexCommandApprovalDecision(
  decision: PendingInteractionApprovalDecision,
): CommandExecutionRequestApprovalResponse["decision"] {
  return pendingInteractionToCodexSimpleApprovalDecision[decision];
}

function parseCodexAvailableDecisions(
  decisions: CodexCommandApprovalDecision[] | null | undefined,
): PendingInteractionApprovalDecision[] {
  if (!decisions) {
    return ["allow_once", "allow_for_session", "deny"];
  }
  if (decisions.length === 0) {
    throw new ProviderRequestDecodeErrorValue(
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
    throw new ProviderRequestDecodeErrorValue(
      "Command approval request did not include provider-neutral decisions",
    );
  }
  return uniqueDecisions;
}
