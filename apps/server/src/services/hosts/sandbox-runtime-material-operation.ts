import {
  getCommand,
  getHostOperation,
  getHostOperationByCommandId,
} from "@bb/db";
import {
  markHostOperationRecordFailed,
  markHostOperationRecordCompletedWithPayload,
  resetHostOperationRecordToRequested,
} from "@bb/db/internal-lifecycle";
import {
  activeLifecycleOperationStates,
  isActiveLifecycleOperationState,
} from "@bb/domain";
import {
  hostRuntimeMaterialSnapshotSchema,
  type HostRuntimeMaterialSnapshot,
} from "@bb/host-daemon-contract";
import { z } from "zod";
import type { AppDeps } from "../../types.js";
import { parseJsonWithSchema } from "../lib/json-parsing.js";

const SANDBOX_RUNTIME_MATERIAL_OPERATION_KIND = "sync_runtime_material";

const sandboxRuntimeMaterialOperationPayloadSchema = z.object({
  appliedVersion: z.string().min(1).nullable(),
  desiredVersion: hostRuntimeMaterialSnapshotSchema.shape.version,
}).strict();

export type SandboxRuntimeMaterialOperationPayload = z.infer<
  typeof sandboxRuntimeMaterialOperationPayloadSchema
>;

export function buildDesiredRuntimeMaterialOperationPayload(
  desiredSnapshot: HostRuntimeMaterialSnapshot,
  existingPayload: SandboxRuntimeMaterialOperationPayload | null,
): SandboxRuntimeMaterialOperationPayload {
  return {
    appliedVersion: existingPayload?.appliedVersion ?? null,
    desiredVersion: desiredSnapshot.version,
  };
}

export function parseRuntimeMaterialOperationPayload(
  payload: string,
): SandboxRuntimeMaterialOperationPayload {
  return parseJsonWithSchema(
    payload,
    sandboxRuntimeMaterialOperationPayloadSchema,
  );
}

export function getRuntimeMaterialOperation(
  deps: Pick<AppDeps, "db">,
  hostId: string,
) {
  return getHostOperation(deps.db, {
    hostId,
    kind: SANDBOX_RUNTIME_MATERIAL_OPERATION_KIND,
  });
}

export function getRuntimeMaterialOperationByCommandId(
  deps: Pick<AppDeps, "db">,
  commandId: string,
) {
  const operation = getHostOperationByCommandId(deps.db, commandId);
  if (
    !operation
    || operation.kind !== SANDBOX_RUNTIME_MATERIAL_OPERATION_KIND
  ) {
    return null;
  }

  return operation;
}

export function hasDesiredRuntimeMaterialApplied(
  payload: SandboxRuntimeMaterialOperationPayload,
): boolean {
  return payload.appliedVersion === payload.desiredVersion;
}

export function hasQueuedRuntimeMaterialCommand(
  deps: Pick<AppDeps, "db">,
  commandId: string | null,
): boolean {
  if (!commandId) {
    return false;
  }

  const command = getCommand(deps.db, commandId);
  return command !== null
    && (command.state === "pending" || command.state === "fetched");
}

export function resetRuntimeMaterialOperationToRequested(
  deps: Pick<AppDeps, "db">,
  args: {
    hostId: string;
    payload: SandboxRuntimeMaterialOperationPayload;
  },
): void {
  resetHostOperationRecordToRequested(deps.db, {
    hostId: args.hostId,
    kind: SANDBOX_RUNTIME_MATERIAL_OPERATION_KIND,
    payload: JSON.stringify(args.payload),
  });
}

export function hasActiveSandboxRuntimeMaterialSyncOperationForCommand(
  deps: Pick<AppDeps, "db">,
  args: { commandId: string },
): boolean {
  const operation = getRuntimeMaterialOperationByCommandId(deps, args.commandId);
  return operation !== null
    && isActiveLifecycleOperationState(operation.state);
}

export function completeSandboxRuntimeMaterialSyncForCommand(
  deps: Pick<AppDeps, "db">,
  args: { appliedVersion: string; commandId: string; completedAt?: number },
): boolean {
  const operation = getRuntimeMaterialOperationByCommandId(deps, args.commandId);
  if (
    !operation
    || !isActiveLifecycleOperationState(operation.state)
  ) {
    return false;
  }

  const payload = parseRuntimeMaterialOperationPayload(operation.payload);
  return markHostOperationRecordCompletedWithPayload(deps.db, {
    hostId: operation.hostId,
    kind: SANDBOX_RUNTIME_MATERIAL_OPERATION_KIND,
    allowedCurrentStates: activeLifecycleOperationStates,
    commandId: operation.commandId,
    completedAt: args.completedAt ?? Date.now(),
    payload: JSON.stringify({
      ...payload,
      appliedVersion: args.appliedVersion,
    }),
    queuedAt: operation.queuedAt,
  }) !== null;
}

export function failSandboxRuntimeMaterialSyncForCommand(
  deps: Pick<AppDeps, "db">,
  args: { commandId: string; completedAt?: number; failureReason: string },
): boolean {
  const operation = getRuntimeMaterialOperationByCommandId(deps, args.commandId);
  if (
    !operation
    || !isActiveLifecycleOperationState(operation.state)
  ) {
    return false;
  }

  return markHostOperationRecordFailed(deps.db, {
    hostId: operation.hostId,
    kind: SANDBOX_RUNTIME_MATERIAL_OPERATION_KIND,
    completedAt: args.completedAt,
    failureReason: args.failureReason,
  }) !== null;
}

export function reconcileSandboxRuntimeMaterialAfterSessionOpen(
  deps: Pick<AppDeps, "db">,
  args: { hostId: string },
): boolean {
  const operation = getRuntimeMaterialOperation(deps, args.hostId);
  if (!operation) {
    return false;
  }

  const payload = parseRuntimeMaterialOperationPayload(operation.payload);
  if (operation.state === "completed" && hasDesiredRuntimeMaterialApplied(payload)) {
    return false;
  }

  const queuedCommand =
    operation.commandId !== null
      ? getCommand(deps.db, operation.commandId)
      : null;
  const hasReusablePendingCommand = queuedCommand?.state === "pending";

  if (hasReusablePendingCommand || operation.state === "requested") {
    return false;
  }

  return resetHostOperationRecordToRequested(deps.db, {
    hostId: args.hostId,
    kind: SANDBOX_RUNTIME_MATERIAL_OPERATION_KIND,
    allowedCurrentStates: ["completed", "failed", "cancelled", "fetched", "queued"],
    payload: JSON.stringify(payload),
  }) !== null;
}
