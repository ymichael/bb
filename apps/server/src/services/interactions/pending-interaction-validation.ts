import {
  formatPendingInteractionCommandApprovalDecision,
} from "@bb/core-ui";
import {
  type PendingInteraction,
  type PendingInteractionCommandApprovalDecision,
  type PendingInteractionFileChangeApprovalDecision,
  type PendingInteractionGrantedPermissionProfile,
  type PendingInteractionResolution,
} from "@bb/domain";
import { ApiError } from "../../errors.js";

function commandApprovalDecisionEquals(
  left: PendingInteractionCommandApprovalDecision,
  right: PendingInteractionCommandApprovalDecision,
): boolean {
  if (typeof left === "string" || typeof right === "string") {
    return left === right;
  }

  if (left.kind !== right.kind) {
    return false;
  }

  if (
    left.kind === "accept_with_exec_policy_amendment"
    && right.kind === "accept_with_exec_policy_amendment"
  ) {
    return (
      left.execPolicyAmendment.length === right.execPolicyAmendment.length
      && left.execPolicyAmendment.every(
        (entry, index) => entry === right.execPolicyAmendment[index],
      )
    );
  }

  if (
    left.kind === "apply_network_policy_amendment"
    && right.kind === "apply_network_policy_amendment"
  ) {
    return (
      left.networkPolicyAmendment.host === right.networkPolicyAmendment.host
      && left.networkPolicyAmendment.action === right.networkPolicyAmendment.action
    );
  }

  return false;
}

function stringSetEquals(left: readonly string[], right: readonly string[]): boolean {
  const leftSet = new Set(left);
  const rightSet = new Set(right);
  if (leftSet.size !== rightSet.size) {
    return false;
  }

  return [...leftSet].every((value) => rightSet.has(value));
}

function permissionProfileEquals(
  left: PendingInteractionGrantedPermissionProfile,
  right: PendingInteractionGrantedPermissionProfile,
): boolean {
  if (left.network?.enabled !== right.network?.enabled) {
    return false;
  }

  if (left.fileSystem === null || right.fileSystem === null) {
    return left.fileSystem === right.fileSystem;
  }

  return (
    stringSetEquals(left.fileSystem.read, right.fileSystem.read)
    && stringSetEquals(left.fileSystem.write, right.fileSystem.write)
  );
}

export function pendingInteractionResolutionEquals(
  left: PendingInteraction["resolution"],
  right: PendingInteraction["resolution"],
): boolean {
  if (left === null || right === null) {
    return left === right;
  }

  if (left.kind !== right.kind) {
    return false;
  }

  switch (left.kind) {
    case "command_approval":
      return (
        right.kind === "command_approval"
        && commandApprovalDecisionEquals(left.decision, right.decision)
      );
    case "file_change_approval":
      return (
        right.kind === "file_change_approval"
        && left.decision === right.decision
      );
    case "permission_request":
      if (right.kind !== "permission_request" || left.decision !== right.decision) {
        return false;
      }
      if (left.decision === "deny" || right.decision === "deny") {
        return left.decision === right.decision;
      }
      return (
        left.scope === right.scope
        && permissionProfileEquals(left.permissions, right.permissions)
      );
  }
}

function validateCommandApprovalResolution(
  interaction: PendingInteraction,
  resolution: PendingInteractionResolution,
): void {
  if (
    interaction.payload.kind !== "command_approval"
    || resolution.kind !== "command_approval"
  ) {
    return;
  }

  if (
    interaction.payload.availableDecisions.some((decision) =>
      commandApprovalDecisionEquals(decision, resolution.decision),
    )
  ) {
    return;
  }

  throw new ApiError(
    400,
    "invalid_request",
    `Command approval decision '${formatPendingInteractionCommandApprovalDecision(resolution.decision)}' is not available for interaction ${interaction.id}`,
  );
}

function validateFileChangeApprovalResolution(
  interaction: PendingInteraction,
  resolution: PendingInteractionResolution,
): void {
  if (
    interaction.payload.kind !== "file_change_approval"
    || resolution.kind !== "file_change_approval"
  ) {
    return;
  }

  const allowedDecisions = new Set<PendingInteractionFileChangeApprovalDecision>([
    "accept",
    "accept_for_session",
    "decline",
    "cancel",
  ]);
  if (allowedDecisions.has(resolution.decision)) {
    return;
  }

  throw new ApiError(
    400,
    "invalid_request",
    `File-change approval decision '${resolution.decision}' is invalid`,
  );
}

function validatePermissionRequestResolution(
  interaction: PendingInteraction,
  resolution: PendingInteractionResolution,
): void {
  if (
    interaction.payload.kind !== "permission_request"
    || resolution.kind !== "permission_request"
  ) {
    return;
  }
  if (resolution.decision === "deny") {
    return;
  }

  if (resolution.permissions.network !== null) {
    if (
      interaction.payload.permissions.network?.enabled !== true
      || resolution.permissions.network.enabled !== true
    ) {
      throw new ApiError(
        400,
        "invalid_request",
        "Granted network permissions must be a subset of the requested permissions",
      );
    }
  }

  if (resolution.permissions.fileSystem !== null) {
    const requestedFileSystem = interaction.payload.permissions.fileSystem;
    if (requestedFileSystem === null) {
      throw new ApiError(
        400,
        "invalid_request",
        "Granted file-system permissions must be a subset of the requested permissions",
      );
    }

    const unknownReadPaths = resolution.permissions.fileSystem.read.filter(
      (path) => !requestedFileSystem.read.includes(path),
    );
    const unknownWritePaths = resolution.permissions.fileSystem.write.filter(
      (path) => !requestedFileSystem.write.includes(path),
    );
    if (unknownReadPaths.length > 0 || unknownWritePaths.length > 0) {
      throw new ApiError(
        400,
        "invalid_request",
        "Granted file-system permissions must be a subset of the requested permissions",
      );
    }
  }
}

export function validatePendingInteractionResolution(
  interaction: PendingInteraction,
  resolution: PendingInteractionResolution,
): void {
  if (interaction.payload.kind !== resolution.kind) {
    throw new ApiError(
      400,
      "invalid_request",
      "Pending interaction resolution kind does not match the interaction payload",
    );
  }

  validateCommandApprovalResolution(interaction, resolution);
  validateFileChangeApprovalResolution(interaction, resolution);
  validatePermissionRequestResolution(interaction, resolution);
}
