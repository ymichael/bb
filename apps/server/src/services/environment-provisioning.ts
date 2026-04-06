import {
  type EnvironmentOperationRow,
  getActiveSession,
  getCommand,
  getEnvironment,
  getEnvironmentOperation,
  queueCommand,
} from "@bb/db";
import {
  markEnvironmentOperationRecordCompleted,
  markEnvironmentOperationRecordFailed,
  markEnvironmentOperationRecordQueued,
  setEnvironmentStatus,
  upsertEnvironmentOperationRecord,
} from "@bb/db/internal-lifecycle";
import type {
  Environment,
  EnvironmentOperationKind,
  Thread,
} from "@bb/domain";
import {
  environmentProvisionCommandSchema,
  type HostDaemonCommand,
} from "@bb/host-daemon-contract";
import type { AppDeps } from "../types.js";
import { ApiError } from "../errors.js";
import {
  appendProvisioningEvent,
} from "./thread-events.js";
import {
  buildEnvironmentProvisionCommand,
  buildManagedBranchNameFromSeed,
  buildManagedTargetPath,
  SETUP_SCRIPT_NAME,
  SETUP_TIMEOUT_MS,
  requireSourceForHost,
} from "./thread-create-helpers.js";
import { requireConnectedHostSession } from "./entity-lookup.js";
import { parseJsonWithSchema } from "./json-parsing.js";
import { tryTransition } from "./thread-transitions.js";

type EnvironmentProvisionOperationKind = Extract<
  EnvironmentOperationKind,
  "provision" | "reprovision"
>;

type EnvironmentProvisionCommand = Extract<
  HostDaemonCommand,
  { type: "environment.provision" }
>;

export interface RequestEnvironmentProvisionArgs {
  command: EnvironmentProvisionCommand;
  environmentId: string;
  kind: EnvironmentProvisionOperationKind;
}

export interface AdvanceEnvironmentProvisioningArgs {
  environmentId: string | null | undefined;
}

export interface EnvironmentProvisioningMutationArgs {
  environmentId: string;
}

export interface FailEnvironmentProvisioningArgs
  extends EnvironmentProvisioningMutationArgs {
  failureReason: string;
}

function isActiveProvisionOperationState(
  state: EnvironmentOperationRow["state"],
): boolean {
  return state === "requested" || state === "queued" || state === "fetched";
}

function toProvisioningLabel(
  workspaceProvisionType: Environment["workspaceProvisionType"],
): string {
  switch (workspaceProvisionType) {
    case "unmanaged":
      return "Environment";
    case "managed-worktree":
      return "Worktree";
    case "managed-clone":
      return "Clone";
  }
}

function getActiveProvisionOperation(
  deps: Pick<AppDeps, "db">,
  environmentId: string,
) {
  for (const kind of ["reprovision", "provision"] as const) {
    const operation = getEnvironmentOperation(deps.db, {
      environmentId,
      kind,
    });
    if (operation && isActiveProvisionOperationState(operation.state)) {
      return operation;
    }
  }

  return null;
}

function hasQueuedProvisionCommand(
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

export function completeEnvironmentProvisioning(
  deps: Pick<AppDeps, "db">,
  args: EnvironmentProvisioningMutationArgs,
): boolean {
  const operation = getActiveProvisionOperation(deps, args.environmentId);
  if (!operation) {
    return false;
  }

  markEnvironmentOperationRecordCompleted(deps.db, {
    environmentId: args.environmentId,
    kind: operation.kind,
  });
  return true;
}

export function failEnvironmentProvisioning(
  deps: Pick<AppDeps, "db" | "hub">,
  args: FailEnvironmentProvisioningArgs,
): boolean {
  const operation = getActiveProvisionOperation(deps, args.environmentId);
  if (operation) {
    markEnvironmentOperationRecordFailed(deps.db, {
      environmentId: args.environmentId,
      kind: operation.kind,
      failureReason: args.failureReason,
    });
  }

  const environment = getEnvironment(deps.db, args.environmentId);
  if (
    environment
    && environment.status !== "destroyed"
    && environment.status !== "error"
  ) {
    setEnvironmentStatus(deps.db, deps.hub, args.environmentId, {
      status: "error",
    });
  }

  return operation !== null || environment !== null;
}

export function requestEnvironmentProvision(
  deps: Pick<AppDeps, "db" | "hub">,
  args: RequestEnvironmentProvisionArgs,
): void {
  upsertEnvironmentOperationRecord(deps.db, {
    environmentId: args.environmentId,
    kind: args.kind,
    payload: JSON.stringify(args.command),
  });

  const environment = getEnvironment(deps.db, args.environmentId);
  if (environment && environment.status !== "provisioning") {
    setEnvironmentStatus(deps.db, deps.hub, environment.id, {
      status: "provisioning",
    });
  }
}

export function advanceEnvironmentProvisioning(
  deps: Pick<AppDeps, "db" | "hub">,
  args: AdvanceEnvironmentProvisioningArgs,
): string | null {
  if (!args.environmentId) {
    return null;
  }

  const environment = getEnvironment(deps.db, args.environmentId);
  if (!environment || environment.status === "destroyed") {
    return null;
  }

  const operation = getActiveProvisionOperation(deps, environment.id);
  if (!operation) {
    return null;
  }

  if (hasQueuedProvisionCommand(deps, operation.commandId)) {
    return operation.commandId;
  }

  const session = getActiveSession(deps.db, environment.hostId);
  if (!session || session.leaseExpiresAt <= Date.now()) {
    return null;
  }

  const command = parseJsonWithSchema(
    operation.payload,
    environmentProvisionCommandSchema,
  );
  const queuedCommand = queueCommand(deps.db, deps.hub, {
    hostId: environment.hostId,
    sessionId: session.id,
    type: command.type,
    payload: JSON.stringify(command),
  });

  markEnvironmentOperationRecordQueued(deps.db, {
    environmentId: environment.id,
    kind: operation.kind,
    commandId: queuedCommand.id,
  });

  return queuedCommand.id;
}

export const MANAGED_REPROVISION_QUEUED = "queued" as const;
export const MANAGED_REPROVISION_IN_PROGRESS = "already-provisioning" as const;
export type ManagedReprovisionResult =
  | typeof MANAGED_REPROVISION_QUEUED
  | typeof MANAGED_REPROVISION_IN_PROGRESS;

export function queueManagedEnvironmentReprovision(
  deps: Pick<AppDeps, "db" | "hub">,
  args: {
    environment: Environment;
    thread: Thread;
  },
): ManagedReprovisionResult {
  const provisionType = args.environment.workspaceProvisionType;
  if (!args.environment.managed || provisionType === "unmanaged") {
    throw new ApiError(
      409,
      "invalid_request",
      "Environment cannot be reprovisioned automatically",
    );
  }

  const activeOperation = getActiveProvisionOperation(deps, args.environment.id);
  if (activeOperation) {
    return MANAGED_REPROVISION_IN_PROGRESS;
  }

  const source = requireSourceForHost(
    deps,
    args.thread.projectId,
    args.environment.hostId,
  );
  requireConnectedHostSession(deps, args.environment.hostId);

  const targetPath =
    args.environment.path ??
    buildManagedTargetPath(source.path, args.thread.projectId, args.thread.id);
  const branchName =
    args.environment.branchName ??
    buildManagedBranchNameFromSeed(
      args.thread.title ?? args.thread.titleFallback ?? args.thread.id,
      args.thread.id,
    );

  if (args.thread.status === "idle") {
    tryTransition(deps.db, deps.hub, args.thread.id, "provisioning");
  }
  const provisionEventSequence = appendProvisioningEvent(deps, {
    threadId: args.thread.id,
    environmentId: args.environment.id,
    status: "started",
    entries: [
      {
        type: "step",
        key: "provision",
        text: `Provisioning ${toProvisioningLabel(args.environment.workspaceProvisionType).toLowerCase()}`,
        status: "started",
      },
    ],
  });

  const command = buildEnvironmentProvisionCommand({
    branchName,
    environmentId: args.environment.id,
    hostId: args.environment.hostId,
    initiator: { threadId: args.thread.id, eventSequence: provisionEventSequence },
    sourcePath: source.path,
    targetPath,
    workspaceProvisionType: provisionType,
    setupScript: SETUP_SCRIPT_NAME,
    setupTimeoutMs: SETUP_TIMEOUT_MS,
  });

  requestEnvironmentProvision(deps, {
    environmentId: args.environment.id,
    kind: "reprovision",
    command,
  });
  advanceEnvironmentProvisioning(deps, {
    environmentId: args.environment.id,
  });
  return MANAGED_REPROVISION_QUEUED;
}
