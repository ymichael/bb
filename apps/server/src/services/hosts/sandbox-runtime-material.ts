import {
  getActiveSession,
  getCurrentSession,
  getHost,
  queueCommand,
} from "@bb/db";
import {
  markHostOperationRecordQueued,
  upsertHostOperationRecord,
} from "@bb/db/internal-lifecycle";
import { isActiveLifecycleOperationState } from "@bb/domain";
import {
  hostDaemonCommandResultSchemaByType,
  type HostRuntimeMaterialSnapshot,
} from "@bb/host-daemon-contract";
import { ApiError } from "../../errors.js";
import type { AppDeps } from "../../types.js";
import { waitForQueuedCommandResult } from "./command-wait.js";
import {
  buildDesiredRuntimeMaterialOperationPayload,
  getRuntimeMaterialOperation,
  hasDesiredRuntimeMaterialApplied,
  hasQueuedRuntimeMaterialCommand,
  parseRuntimeMaterialOperationPayload,
  resetRuntimeMaterialOperationToRequested,
} from "./sandbox-runtime-material-operation.js";
import {
  buildSandboxRuntimeMaterialSnapshot,
  isEmptySandboxRuntimeMaterialSnapshot,
} from "./sandbox-runtime-material-snapshot.js";

const DEFAULT_RUNTIME_MATERIAL_SYNC_TIMEOUT_MS = 60_000;

interface EnsureSandboxRuntimeMaterialSyncedArgs {
  hostId: string;
  timeoutMs?: number;
}

export function requestSandboxRuntimeMaterialSync(
  deps: Pick<AppDeps, "config" | "db">,
  args: { hostId: string },
): HostRuntimeMaterialSnapshot {
  const host = getHost(deps.db, args.hostId);
  if (!host || host.destroyedAt !== null) {
    throw new ApiError(404, "host_not_found", "Host not found");
  }

  const desiredSnapshot = buildSandboxRuntimeMaterialSnapshot(deps.config);
  const existingOperation = getRuntimeMaterialOperation(deps, args.hostId);
  const existingPayload =
    existingOperation
      ? parseRuntimeMaterialOperationPayload(existingOperation.payload)
      : null;

  if (
    existingOperation
    && existingOperation.state === "completed"
    && existingPayload
    && existingPayload.desiredVersion === desiredSnapshot.version
    && hasDesiredRuntimeMaterialApplied(existingPayload)
  ) {
    return desiredSnapshot;
  }

  if (
    existingOperation === null
    && isEmptySandboxRuntimeMaterialSnapshot(desiredSnapshot)
  ) {
    return desiredSnapshot;
  }

  if (
    existingOperation
    && existingPayload
    && existingPayload.desiredVersion === desiredSnapshot.version
  ) {
    return desiredSnapshot;
  }

  upsertHostOperationRecord(deps.db, {
    hostId: args.hostId,
    kind: "sync_runtime_material",
    payload: JSON.stringify(
      buildDesiredRuntimeMaterialOperationPayload(
        desiredSnapshot,
        existingPayload,
      ),
    ),
  });

  return desiredSnapshot;
}

export function advanceSandboxRuntimeMaterialSync(
  deps: Pick<AppDeps, "db" | "hub">,
  args: { hostId: string },
): string | null {
  const operation = getRuntimeMaterialOperation(deps, args.hostId);
  if (!operation) {
    return null;
  }

  const payload = parseRuntimeMaterialOperationPayload(operation.payload);
  if (
    operation.state === "completed"
    && hasDesiredRuntimeMaterialApplied(payload)
  ) {
    return null;
  }

  if (
    isActiveLifecycleOperationState(operation.state)
    && hasQueuedRuntimeMaterialCommand(deps, operation.commandId)
  ) {
    return operation.commandId;
  }

  if (operation.state !== "requested") {
    resetRuntimeMaterialOperationToRequested(deps, {
      hostId: args.hostId,
      payload,
    });
  }

  const session = getActiveSession(deps.db, args.hostId);
  if (!session || session.leaseExpiresAt <= Date.now()) {
    return null;
  }

  const queuedCommand = queueCommand(deps.db, deps.hub, {
    hostId: args.hostId,
    sessionId: session.id,
    type: "host.sync_runtime_material",
    payload: JSON.stringify({
      type: "host.sync_runtime_material",
      version: payload.desiredVersion,
    }),
  });
  markHostOperationRecordQueued(deps.db, {
    hostId: args.hostId,
    kind: "sync_runtime_material",
    commandId: queuedCommand.id,
  });
  return queuedCommand.id;
}

export async function ensureSandboxRuntimeMaterialSynced(
  deps: Pick<AppDeps, "config" | "db" | "hub">,
  args: EnsureSandboxRuntimeMaterialSyncedArgs,
): Promise<HostRuntimeMaterialSnapshot> {
  const desiredSnapshot = requestSandboxRuntimeMaterialSync(deps, {
    hostId: args.hostId,
  });
  const operation = getRuntimeMaterialOperation(deps, args.hostId);

  if (!operation) {
    return desiredSnapshot;
  }

  const payload = parseRuntimeMaterialOperationPayload(operation.payload);
  if (
    operation.state === "completed"
    && hasDesiredRuntimeMaterialApplied(payload)
  ) {
    return desiredSnapshot;
  }

  const commandId = advanceSandboxRuntimeMaterialSync(deps, {
    hostId: args.hostId,
  });
  if (!commandId) {
    const session = getCurrentSession(deps.db, {
      hostId: args.hostId,
    });
    if (!session) {
      throw new ApiError(502, "host_disconnected", "Host is not connected");
    }
    if (session.leaseExpiresAt <= Date.now()) {
      throw new ApiError(
        502,
        "host_session_expired",
        "Host session expired before runtime material sync could be queued",
      );
    }
    throw new ApiError(
      502,
      "runtime_material_sync_unavailable",
      "Runtime material sync could not be queued for the active host session",
    );
  }

  const rawResult = await waitForQueuedCommandResult(deps, {
    commandId,
    timeoutMs: args.timeoutMs ?? DEFAULT_RUNTIME_MATERIAL_SYNC_TIMEOUT_MS,
  });
  const result =
    hostDaemonCommandResultSchemaByType["host.sync_runtime_material"].parse(
      rawResult,
    );
  if (result.appliedVersion !== desiredSnapshot.version) {
    throw new ApiError(
      500,
      "internal_error",
      "Daemon reported a mismatched runtime material version",
    );
  }

  return desiredSnapshot;
}
