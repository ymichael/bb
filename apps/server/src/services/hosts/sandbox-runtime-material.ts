import { createHash } from "node:crypto";
import {
  getActiveSession,
  getCommand,
  getHost,
  getHostOperation,
  getHostOperationByCommandId,
  queueCommand,
} from "@bb/db";
import {
  markHostOperationRecordFailed,
  markHostOperationRecordQueued,
  updateHostOperationRecord,
  upsertHostOperationRecord,
} from "@bb/db/internal-lifecycle";
import {
  activeLifecycleOperationStates,
  isActiveLifecycleOperationState,
} from "@bb/domain";
import {
  hostDaemonCommandResultSchemaByType,
  hostRuntimeMaterialSnapshotSchema,
  type HostRuntimeMaterialSnapshot,
} from "@bb/host-daemon-contract";
import { z } from "zod";
import { ApiError } from "../../errors.js";
import type { AppDeps, ServerRuntimeConfig } from "../../types.js";
import { parseJsonWithSchema } from "../lib/json-parsing.js";
import { waitForQueuedCommandResult } from "./command-wait.js";

const DEFAULT_RUNTIME_MATERIAL_SYNC_TIMEOUT_MS = 60_000;
const SANDBOX_RUNTIME_MATERIAL_OPERATION_KIND = "sync_runtime_material";

const sandboxRuntimeMaterialOperationPayloadSchema = z.object({
  appliedVersion: z.string().min(1).nullable(),
  desiredSnapshot: hostRuntimeMaterialSnapshotSchema,
}).strict();
type SandboxRuntimeMaterialOperationPayload = z.infer<
  typeof sandboxRuntimeMaterialOperationPayloadSchema
>;

interface EnsureSandboxRuntimeMaterialSyncedArgs {
  hostId: string;
  timeoutMs?: number;
}

function buildManagedRuntimeEnv(
  config: Pick<
    ServerRuntimeConfig,
    "anthropicApiKey" | "githubPat" | "openAiApiKey"
  >,
): Record<string, string> {
  const env: Record<string, string> = {};

  if (config.githubPat !== "") {
    env.GITHUB_TOKEN = config.githubPat;
  }
  if (config.openAiApiKey !== "") {
    env.OPENAI_API_KEY = config.openAiApiKey;
  }
  if (config.anthropicApiKey !== "") {
    env.ANTHROPIC_API_KEY = config.anthropicApiKey;
  }

  return env;
}

function toStableEnvEntries(
  env: Record<string, string>,
): Array<readonly [string, string]> {
  return Object.entries(env).sort(([left], [right]) => left.localeCompare(right));
}

function buildSnapshotVersion(env: Record<string, string>): string {
  const stableEntries = JSON.stringify(toStableEnvEntries(env));
  return createHash("sha256").update(stableEntries).digest("hex");
}

function parseRuntimeMaterialOperationPayload(
  payload: string,
): SandboxRuntimeMaterialOperationPayload {
  return parseJsonWithSchema(
    payload,
    sandboxRuntimeMaterialOperationPayloadSchema,
  );
}

function buildDesiredOperationPayload(
  desiredSnapshot: HostRuntimeMaterialSnapshot,
  existingPayload: SandboxRuntimeMaterialOperationPayload | null,
): SandboxRuntimeMaterialOperationPayload {
  return {
    appliedVersion: existingPayload?.appliedVersion ?? null,
    desiredSnapshot,
  };
}

function getRuntimeMaterialOperation(
  deps: Pick<AppDeps, "db">,
  hostId: string,
) {
  return getHostOperation(deps.db, {
    hostId,
    kind: SANDBOX_RUNTIME_MATERIAL_OPERATION_KIND,
  });
}

function getRuntimeMaterialOperationByCommandId(
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

function hasDesiredRuntimeMaterialApplied(
  payload: SandboxRuntimeMaterialOperationPayload,
): boolean {
  return payload.appliedVersion === payload.desiredSnapshot.version;
}

function hasQueuedRuntimeMaterialCommand(
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

function resetRuntimeMaterialOperationToRequested(
  deps: Pick<AppDeps, "db">,
  args: {
    hostId: string;
    payload: SandboxRuntimeMaterialOperationPayload;
  },
): void {
  updateHostOperationRecord(deps.db, {
    hostId: args.hostId,
    kind: SANDBOX_RUNTIME_MATERIAL_OPERATION_KIND,
    commandId: null,
    completedAt: null,
    failureReason: null,
    payload: JSON.stringify(args.payload),
    queuedAt: null,
    state: "requested",
  });
}

export function buildSandboxRuntimeMaterialSnapshot(
  config: Pick<
    ServerRuntimeConfig,
    "anthropicApiKey" | "githubPat" | "openAiApiKey"
  >,
): HostRuntimeMaterialSnapshot {
  const env = buildManagedRuntimeEnv(config);
  return {
    env,
    version: buildSnapshotVersion(env),
  };
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
    && existingPayload.desiredSnapshot.version === desiredSnapshot.version
    && hasDesiredRuntimeMaterialApplied(existingPayload)
  ) {
    return desiredSnapshot;
  }

  if (
    existingOperation === null
    && desiredSnapshot.version === buildSnapshotVersion({})
  ) {
    return desiredSnapshot;
  }

  if (
    existingOperation
    && existingPayload
    && existingPayload.desiredSnapshot.version === desiredSnapshot.version
  ) {
    return desiredSnapshot;
  }

  upsertHostOperationRecord(deps.db, {
    hostId: args.hostId,
    kind: SANDBOX_RUNTIME_MATERIAL_OPERATION_KIND,
    payload: JSON.stringify(
      buildDesiredOperationPayload(desiredSnapshot, existingPayload),
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
      version: payload.desiredSnapshot.version,
      env: payload.desiredSnapshot.env,
    }),
  });
  markHostOperationRecordQueued(deps.db, {
    hostId: args.hostId,
    kind: SANDBOX_RUNTIME_MATERIAL_OPERATION_KIND,
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
    return payload.desiredSnapshot;
  }

  const commandId = advanceSandboxRuntimeMaterialSync(deps, {
    hostId: args.hostId,
  });
  if (!commandId) {
    throw new ApiError(502, "host_disconnected", "Host is not connected");
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
  return updateHostOperationRecord(deps.db, {
    hostId: operation.hostId,
    kind: SANDBOX_RUNTIME_MATERIAL_OPERATION_KIND,
    allowedCurrentStates: activeLifecycleOperationStates,
    commandId: operation.commandId,
    completedAt: args.completedAt ?? Date.now(),
    failureReason: null,
    payload: JSON.stringify({
      ...payload,
      appliedVersion: args.appliedVersion,
    }),
    queuedAt: operation.queuedAt,
    state: "completed",
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

export function invalidateSandboxRuntimeMaterialAfterSessionOpen(
  deps: Pick<AppDeps, "db">,
  args: { hostId: string },
): boolean {
  const operation = getRuntimeMaterialOperation(deps, args.hostId);
  if (!operation) {
    return false;
  }

  const payload = parseRuntimeMaterialOperationPayload(operation.payload);
  return updateHostOperationRecord(deps.db, {
    hostId: args.hostId,
    kind: SANDBOX_RUNTIME_MATERIAL_OPERATION_KIND,
    commandId: null,
    completedAt: null,
    failureReason: null,
    payload: JSON.stringify({
      ...payload,
      appliedVersion: null,
    }),
    queuedAt: null,
    state: "requested",
  }) !== null;
}
