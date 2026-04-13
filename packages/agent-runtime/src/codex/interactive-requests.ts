import type { CommandExecutionRequestApprovalResponse } from "./generated/codex-app-server/schema/v2/CommandExecutionRequestApprovalResponse.js";
import type { FileChangeRequestApprovalResponse } from "./generated/codex-app-server/schema/v2/FileChangeRequestApprovalResponse.js";
import type { PermissionsRequestApprovalResponse } from "./generated/codex-app-server/schema/v2/PermissionsRequestApprovalResponse.js";
import type {
  DecodedInteractiveRequest,
  JsonRpcMessage,
  ProviderAdapter,
} from "../provider-adapter.js";
import {
  parseCodexAvailableDecisions,
  pendingInteractionToCodexFileChangeApprovalDecision,
  toCodexCommandApprovalDecision,
  toCodexGrantedPermissionProfile,
  toPendingInteractionGrantablePermissionProfile,
  toPendingInteractionPermissionProfile,
} from "./permission-mapping.js";
import {
  codexCommandExecutionRequestApprovalParamsSchema,
  codexFileChangeRequestApprovalParamsSchema,
  codexPermissionsRequestApprovalParamsSchema,
} from "./schemas.js";

type BuildCodexInteractiveResponseArgs = Parameters<
  NonNullable<ProviderAdapter["buildInteractiveResponse"]>
>[0];

export type CodexInteractiveResponse =
  | CommandExecutionRequestApprovalResponse
  | FileChangeRequestApprovalResponse
  | PermissionsRequestApprovalResponse;

function assertNever(value: never, message?: string): never {
  throw new Error(message ?? `Unexpected value: ${String(value)}`);
}

export function decodeCodexInteractiveRequest(
  request: JsonRpcMessage,
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
      return {
        requestId: request.id,
        method: request.method,
        providerThreadId: parsed.data.threadId,
        turnId: parsed.data.turnId,
        payload: {
          kind: "command_approval",
          itemId: parsed.data.itemId,
          reason: parsed.data.reason ?? null,
          command: parsed.data.command ?? null,
          cwd: parsed.data.cwd ?? null,
          commandActions: parsed.data.commandActions ?? [],
          requestedPermissions: parsed.data.additionalPermissions
            ? toPendingInteractionPermissionProfile(parsed.data.additionalPermissions)
            : null,
          availableDecisions,
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
      return {
        requestId: request.id,
        method: request.method,
        providerThreadId: parsed.data.threadId,
        turnId: parsed.data.turnId,
        payload: {
          kind: "file_change_approval",
          itemId: parsed.data.itemId,
          reason: parsed.data.reason ?? null,
          grantRoot: parsed.data.grantRoot ?? null,
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
      return {
        requestId: request.id,
        method: request.method,
        providerThreadId: parsed.data.threadId,
        turnId: parsed.data.turnId,
        payload: {
          kind: "permission_request",
          itemId: parsed.data.itemId,
          reason: parsed.data.reason,
          toolName: null,
          permissions: toPendingInteractionGrantablePermissionProfile(
            parsed.data.permissions,
          ),
        },
      };
    }
    default:
      return null;
  }
}

export function buildCodexInteractiveResponse(
  args: BuildCodexInteractiveResponseArgs,
): CodexInteractiveResponse {
  switch (args.request.payload.kind) {
    case "command_approval": {
      if (args.resolution.kind !== "command_approval") {
        throw new Error("Interactive response kind mismatch for command approval");
      }
      const response: CommandExecutionRequestApprovalResponse = {
        decision: toCodexCommandApprovalDecision(args.resolution.decision),
      };
      return response;
    }
    case "file_change_approval": {
      if (args.resolution.kind !== "file_change_approval") {
        throw new Error("Interactive response kind mismatch for file change approval");
      }
      const response: FileChangeRequestApprovalResponse = {
        decision:
          pendingInteractionToCodexFileChangeApprovalDecision[
            args.resolution.decision
          ],
      };
      return response;
    }
    case "permission_request": {
      if (args.resolution.kind !== "permission_request") {
        throw new Error("Interactive response kind mismatch for permission request");
      }
      if (args.resolution.decision === "deny") {
        const response: PermissionsRequestApprovalResponse = {
          permissions: {},
          scope: "turn",
        };
        return response;
      }
      const response: PermissionsRequestApprovalResponse = {
        permissions: toCodexGrantedPermissionProfile(args.resolution.permissions),
        scope: args.resolution.scope,
      };
      return response;
    }
    default:
      return assertNever(args.request.payload);
  }
}
