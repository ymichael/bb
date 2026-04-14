import {
  type PendingInteraction,
  type PendingInteractionApprovalDecision,
  type PendingInteractionGrantedPermissionProfile,
  type PendingInteractionResolution,
} from "@bb/domain";
import { ApiError } from "../../errors.js";

type GrantedPendingInteractionResolution = Extract<
  PendingInteractionResolution,
  { decision: "allow_once" | "allow_for_session" }
>;

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

function grantedResolutionEquals(
  left: GrantedPendingInteractionResolution,
  right: GrantedPendingInteractionResolution,
): boolean {
  if (left.grantedPermissions === null || right.grantedPermissions === null) {
    return left.grantedPermissions === right.grantedPermissions;
  }
  return permissionProfileEquals(left.grantedPermissions, right.grantedPermissions);
}

function hasGrantedPermissions(
  permissions: PendingInteractionGrantedPermissionProfile,
): boolean {
  if (permissions.network?.enabled === true) {
    return true;
  }

  return (
    (permissions.fileSystem?.read.length ?? 0) > 0
    || (permissions.fileSystem?.write.length ?? 0) > 0
  );
}

export function pendingInteractionResolutionEquals(
  left: PendingInteraction["resolution"],
  right: PendingInteraction["resolution"],
): boolean {
  if (left === null || right === null) {
    return left === right;
  }

  switch (left.decision) {
    case "deny":
      return right.decision === "deny";
    case "allow_once":
      return right.decision === "allow_once" && grantedResolutionEquals(left, right);
    case "allow_for_session":
      return right.decision === "allow_for_session" && grantedResolutionEquals(left, right);
  }
}

function validateAvailableDecision(
  interaction: PendingInteraction,
  decision: PendingInteractionApprovalDecision,
): void {
  if (interaction.payload.availableDecisions.includes(decision)) {
    return;
  }

  throw new ApiError(
    400,
    "invalid_request",
    `Approval decision '${decision}' is not available for interaction ${interaction.id}`,
  );
}

function getRequestedPermissions(
  interaction: PendingInteraction,
  decision: PendingInteractionApprovalDecision,
): PendingInteractionGrantedPermissionProfile | null {
  if (interaction.payload.subject.kind === "permission_grant") {
    return interaction.payload.subject.permissions;
  }
  if (decision !== "allow_for_session") {
    return null;
  }
  if (
    interaction.payload.subject.kind === "command"
    || interaction.payload.subject.kind === "file_change"
  ) {
    return interaction.payload.subject.sessionGrant;
  }
  return null;
}

function validateGrantedPermissions(
  interaction: PendingInteraction,
  decision: PendingInteractionApprovalDecision,
  permissions: PendingInteractionGrantedPermissionProfile,
): void {
  const requestedPermissions = getRequestedPermissions(interaction, decision);
  if (requestedPermissions === null) {
    throw new ApiError(
      400,
      "invalid_request",
      "This approval subject and decision cannot grant the requested permissions",
    );
  }

  if (!hasGrantedPermissions(permissions)) {
    throw new ApiError(
      400,
      "invalid_request",
      "Allowed permission resolutions must grant at least one permission",
    );
  }

  if (permissions.network !== null) {
    if (
      requestedPermissions.network?.enabled !== true
      || permissions.network.enabled !== true
    ) {
      throw new ApiError(
        400,
        "invalid_request",
        "Granted network permissions must be a subset of the requested permissions",
      );
    }
  }

  if (permissions.fileSystem !== null) {
    const requestedFileSystem = requestedPermissions.fileSystem;
    if (requestedFileSystem === null) {
      throw new ApiError(
        400,
        "invalid_request",
        "Granted file-system permissions must be a subset of the requested permissions",
      );
    }

    const unknownReadPaths = permissions.fileSystem.read.filter(
      (path) => !requestedFileSystem.read.includes(path),
    );
    const unknownWritePaths = permissions.fileSystem.write.filter(
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

function validateCommandOrFileChangeSessionGrant(
  interaction: PendingInteraction,
  permissions: PendingInteractionGrantedPermissionProfile,
): void {
  if (
    interaction.payload.subject.kind !== "command"
    && interaction.payload.subject.kind !== "file_change"
  ) {
    return;
  }

  const sessionGrant = interaction.payload.subject.sessionGrant;
  if (sessionGrant === null) {
    return;
  }

  if (!permissionProfileEquals(permissions, sessionGrant)) {
    throw new ApiError(
      400,
      "invalid_request",
      "Command and file-change session approvals must grant the requested session permissions exactly",
    );
  }
}

export function validatePendingInteractionResolution(
  interaction: PendingInteraction,
  resolution: PendingInteractionResolution,
): void {
  validateAvailableDecision(interaction, resolution.decision);
  if (resolution.decision !== "deny") {
    if (resolution.grantedPermissions !== null) {
      validateGrantedPermissions(
        interaction,
        resolution.decision,
        resolution.grantedPermissions,
      );
      if (resolution.decision === "allow_for_session") {
        validateCommandOrFileChangeSessionGrant(
          interaction,
          resolution.grantedPermissions,
        );
      }
    } else if (interaction.payload.subject.kind === "permission_grant") {
      throw new ApiError(
        400,
        "invalid_request",
        "Allowed permission-grant resolutions must include granted permissions",
      );
    } else if (
      resolution.decision === "allow_for_session"
      && (
        interaction.payload.subject.kind === "command"
        || interaction.payload.subject.kind === "file_change"
      )
    ) {
      throw new ApiError(
        400,
        "invalid_request",
        "Session approval resolutions must include granted permissions",
      );
    }
  }
}
