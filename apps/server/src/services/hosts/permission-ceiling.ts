import { getEnvironment, getHost } from "@bb/db";
import { clampPermissionModeToCeiling, type PermissionMode } from "@bb/domain";
import { ApiError } from "../../errors.js";
import type { AppDeps } from "../../types.js";

type PermissionCeilingDeps = Pick<AppDeps, "db">;

interface ClampPermissionModeToHostArgs {
  hostId: string | null;
  permissionMode: PermissionMode;
  providerId?: string;
}

class HostPermissionCeilingConflictError extends ApiError {}

export function isHostPermissionCeilingConflictError(
  error: unknown,
): error is HostPermissionCeilingConflictError {
  return error instanceof HostPermissionCeilingConflictError;
}

export function getHostPermissionCeiling(
  deps: PermissionCeilingDeps,
  hostId: string | null,
): PermissionMode {
  if (hostId === null) return "full";
  return getHost(deps.db, hostId)?.maxPermissionMode ?? "full";
}

export function resolveEnvironmentHostId(
  deps: PermissionCeilingDeps,
  environmentId: string | null,
): string | null {
  if (environmentId === null) return null;
  return getEnvironment(deps.db, environmentId)?.hostId ?? null;
}

export function clampPermissionModeToHost(
  deps: Pick<AppDeps, "db" | "providerRegistry">,
  args: ClampPermissionModeToHostArgs,
): PermissionMode {
  const ceiling = getHostPermissionCeiling(deps, args.hostId);
  const supported = args.providerId
    ? deps.providerRegistry.getSupportedPermissionModes(args.providerId)
    : null;
  const clamped = clampPermissionModeToCeiling({
    ceiling,
    permissionMode: args.permissionMode,
    ...(supported ? { permissionModes: supported } : {}),
  });
  if (clamped === null) {
    throw new HostPermissionCeilingConflictError(
      400,
      "host_permission_ceiling_conflict",
      `This machine limits permission mode to ${ceiling}, and provider ${args.providerId} requires a higher mode.`,
    );
  }
  return clamped;
}
