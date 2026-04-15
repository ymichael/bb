import type {
  EnvironmentCleanupMode,
  EnvironmentOperationKind,
  WorkspaceProvisionType,
} from "@bb/domain";
import { isActiveLifecycleOperationState } from "@bb/domain";
import {
  countLiveThreadsInEnvironment,
  getEnvironment,
  getEnvironmentOperation,
  getEnvironmentOperationByCommandId,
  getActiveSession,
  getPendingEnvironmentCommand,
  hasPendingThreadShutdownInEnvironment,
  queueCommand,
} from "@bb/db";
import {
  markEnvironmentOperationRecordCompleted,
  markEnvironmentOperationRecordFailed,
  markEnvironmentOperationRecordQueued,
  recordEnvironmentCleanupRequest,
  setEnvironmentRecordDestroyed,
  setEnvironmentStatus,
  upsertEnvironmentOperationRecord,
} from "@bb/db/internal-lifecycle";
import { hostDaemonCommandResultSchemaByType } from "@bb/host-daemon-contract";
import { z } from "zod";
import { ApiError } from "../../errors.js";
import type { AppDeps, SandboxWorkSessionDeps } from "../../types.js";
import { queueCommandAndWait } from "../hosts/command-wait.js";
import { parseJsonWithSchema } from "../lib/json-parsing.js";

export interface EnvironmentDestroyTarget {
  hostId: string;
  id: string;
  path: string;
  workspaceProvisionType: WorkspaceProvisionType;
}

export interface AdvanceEnvironmentCleanupArgs {
  environmentId: string | null | undefined;
}

export interface RequestEnvironmentCleanupArgs {
  environmentId: string | null | undefined;
  mode: EnvironmentCleanupMode;
}

export interface EnvironmentCleanupCommandMutationArgs {
  commandId: string;
}

export interface FailEnvironmentCleanupForCommandArgs
  extends EnvironmentCleanupCommandMutationArgs {
  failureReason: string;
}

export interface ValidateEnvironmentCleanupRequestArgs {
  environmentId: string | null | undefined;
  mode: EnvironmentCleanupMode;
}

export interface WouldCleanupEnvironmentArgs {
  environmentId: string | null | undefined;
  excludeThreadId: string;
}

const destroyOperationPayloadSchema = z.object({
  mode: z.enum(["safe", "force"]),
});
type DestroyOperationPayload = z.infer<typeof destroyOperationPayloadSchema>;

function hasConnectedHostSession(
  deps: Pick<AppDeps, "db">,
  hostId: string,
): boolean {
  const session = getActiveSession(deps.db, hostId);
  return session !== null && session.leaseExpiresAt > Date.now();
}

function workspaceHasRiskyChanges(
  workspaceStatus: ReturnType<
    typeof hostDaemonCommandResultSchemaByType["workspace.status"]["parse"]
  >["workspaceStatus"],
): boolean {
  return (
    workspaceStatus.workingTree.hasUncommittedChanges ||
    workspaceStatus.mergeBase?.hasCommittedUnmergedChanges === true
  );
}

async function assertWorkspaceCanBeSafelyCleaned(
  deps: SandboxWorkSessionDeps,
  environmentId: string,
): Promise<boolean> {
  const environment = getEnvironment(deps.db, environmentId);
  if (
    !environment ||
    !environment.managed ||
    environment.status === "destroyed" ||
    environment.status !== "ready" ||
    !environment.path
  ) {
    return false;
  }

  if (!hasConnectedHostSession(deps, environment.hostId)) {
    return false;
  }

  if (
    getPendingEnvironmentCommand(deps.db, {
      environmentId: environment.id,
      type: "workspace.status",
    })
  ) {
    return false;
  }

  const mergeBaseBranch = environment.mergeBaseBranch ?? environment.defaultBranch;
  if (environment.isGitRepo && !mergeBaseBranch) {
    return false;
  }

  let rawResult: unknown;
  try {
    rawResult = await queueCommandAndWait(deps, {
      hostId: environment.hostId,
      timeoutMs: 30_000,
      command: {
        type: "workspace.status",
        environmentId: environment.id,
        workspaceContext: {
          workspacePath: environment.path,
          workspaceProvisionType: environment.workspaceProvisionType,
        },
        ...(mergeBaseBranch ? { mergeBaseBranch } : {}),
      },
    });
  } catch (error) {
    // Workspace path is gone (e.g. user deleted the worktree out-of-band).
    // Nothing to inspect and nothing risky to lose — let cleanup proceed so
    // the environment is marked destroyed via the idempotent destroy command.
    if (error instanceof ApiError && error.body.code === "path_not_found") {
      return true;
    }
    throw error;
  }
  const result = hostDaemonCommandResultSchemaByType["workspace.status"].parse(rawResult);
  if (workspaceHasRiskyChanges(result.workspaceStatus)) {
    throw new ApiError(
      409,
      "archive_confirmation_required",
      "Archiving this thread would clean up a workspace that contains work.",
    );
  }

  return true;
}

function canRequestCleanup(
  environment: NonNullable<ReturnType<typeof getEnvironment>>,
): boolean {
  return environment.managed && environment.status !== "destroyed";
}

function resolveRequestedCleanupMode(
  current: EnvironmentCleanupMode,
  requested: EnvironmentCleanupMode,
): EnvironmentCleanupMode {
  if (current === "force" || requested === "force") {
    return "force";
  }

  return "safe";
}

function getDestroyOperationPayload(
  deps: Pick<AppDeps, "db">,
  environmentId: string,
): DestroyOperationPayload | null {
  const operation = getEnvironmentOperation(deps.db, {
    environmentId,
    kind: "destroy",
  });

  if (operation) {
    return parseJsonWithSchema(operation.payload, destroyOperationPayloadSchema);
  }

  const environment = getEnvironment(deps.db, environmentId);
  if (!environment || environment.cleanupMode === null) {
    return null;
  }

  return { mode: environment.cleanupMode };
}

function getActiveDestroyOperationByCommandId(
  deps: Pick<AppDeps, "db">,
  commandId: string,
) {
  const operation = getEnvironmentOperationByCommandId(deps.db, commandId);
  if (
    !operation
    || operation.kind !== "destroy"
    || !isActiveLifecycleOperationState(operation.state)
  ) {
    return null;
  }

  return operation;
}

export function hasActiveEnvironmentDestroyOperationForCommand(
  deps: Pick<AppDeps, "db">,
  args: EnvironmentCleanupCommandMutationArgs,
): boolean {
  return getActiveDestroyOperationByCommandId(deps, args.commandId) !== null;
}

export function completeEnvironmentDestroyForCommand(
  deps: Pick<AppDeps, "db" | "hub">,
  args: EnvironmentCleanupCommandMutationArgs,
): boolean {
  const operation = getActiveDestroyOperationByCommandId(deps, args.commandId);
  if (!operation) {
    return false;
  }

  const environment = getEnvironment(deps.db, operation.environmentId);
  if (!environment || environment.status !== "destroying") {
    return false;
  }

  setEnvironmentRecordDestroyed(deps.db, deps.hub, operation.environmentId);
  markEnvironmentOperationRecordCompleted(deps.db, {
    environmentId: operation.environmentId,
    kind: operation.kind,
  });
  return true;
}

export function failEnvironmentDestroyForCommand(
  deps: Pick<AppDeps, "db" | "hub">,
  args: FailEnvironmentCleanupForCommandArgs,
): boolean {
  const operation = getActiveDestroyOperationByCommandId(deps, args.commandId);
  if (!operation) {
    return false;
  }

  markEnvironmentOperationRecordFailed(deps.db, {
    environmentId: operation.environmentId,
    kind: operation.kind,
    failureReason: args.failureReason,
  });

  const environment = getEnvironment(deps.db, operation.environmentId);
  if (
    environment
    && environment.status === "destroying"
  ) {
    setEnvironmentStatus(deps.db, deps.hub, operation.environmentId, {
      status: environment.path ? "ready" : "error",
    });
  }

  return true;
}

export async function validateEnvironmentCleanupRequest(
  deps: SandboxWorkSessionDeps,
  args: ValidateEnvironmentCleanupRequestArgs,
): Promise<void> {
  if (!args.environmentId || args.mode === "force") {
    return;
  }

  const environment = getEnvironment(deps.db, args.environmentId);
  if (!environment || !canRequestCleanup(environment)) {
    return;
  }

  await assertWorkspaceCanBeSafelyCleaned(deps, environment.id);
}

export function requestEnvironmentCleanup(
  deps: Pick<AppDeps, "db" | "hub">,
  args: RequestEnvironmentCleanupArgs,
): void {
  if (!args.environmentId) {
    return;
  }

  const environment = getEnvironment(deps.db, args.environmentId);
  if (!environment || !canRequestCleanup(environment)) {
    return;
  }

  const currentPayload = getDestroyOperationPayload(deps, environment.id);
  const mode = currentPayload
    ? resolveRequestedCleanupMode(currentPayload.mode, args.mode)
    : args.mode;

  upsertEnvironmentOperationRecord(deps.db, {
    environmentId: environment.id,
    kind: "destroy",
    payload: JSON.stringify({ mode }),
    requestedAt: environment.cleanupRequestedAt ?? undefined,
  });
  recordEnvironmentCleanupRequest(deps.db, deps.hub, environment.id, {
    cleanupMode: mode,
  });
}

function queueEnvironmentDestroyCommand(
  deps: Pick<AppDeps, "db" | "hub">,
  environment: EnvironmentDestroyTarget,
) {
  const pendingCommand = getPendingEnvironmentCommand(deps.db, {
    environmentId: environment.id,
    type: "environment.destroy",
  });
  if (pendingCommand) {
    return pendingCommand.id;
  }

  const session = getActiveSession(deps.db, environment.hostId);
  const queuedCommand = queueCommand(deps.db, deps.hub, {
    hostId: environment.hostId,
    sessionId: session?.id ?? null,
    type: "environment.destroy",
    payload: JSON.stringify({
      type: "environment.destroy",
      environmentId: environment.id,
      workspaceContext: {
        workspacePath: environment.path,
        workspaceProvisionType: environment.workspaceProvisionType,
      },
    }),
  });

  return queuedCommand.id;
}

function queueDestroyAndMarkDestroying(
  deps: Pick<AppDeps, "db" | "hub">,
  environment: EnvironmentDestroyTarget & {
    operationKind: Extract<EnvironmentOperationKind, "destroy">;
    status: NonNullable<ReturnType<typeof getEnvironment>>["status"];
  },
): void {
  const commandId = queueEnvironmentDestroyCommand(deps, environment);
  markEnvironmentOperationRecordQueued(deps.db, {
    environmentId: environment.id,
    kind: environment.operationKind,
    commandId,
  });
  if (environment.status !== "destroying") {
    setEnvironmentStatus(deps.db, deps.hub, environment.id, {
      status: "destroying",
    });
  }
}

export function wouldCleanupEnvironment(
  deps: Pick<AppDeps, "db">,
  args: WouldCleanupEnvironmentArgs,
): boolean {
  if (!args.environmentId) {
    return false;
  }

  const environment = getEnvironment(deps.db, args.environmentId);
  if (!environment || !environment.managed) {
    return false;
  }

  return countLiveThreadsInEnvironment(deps.db, {
    environmentId: environment.id,
    excludeThreadId: args.excludeThreadId,
  }) === 0;
}

export async function advanceEnvironmentCleanup(
  deps: SandboxWorkSessionDeps,
  args: AdvanceEnvironmentCleanupArgs,
): Promise<void> {
  if (!args.environmentId) {
    return;
  }

  const environment = getEnvironment(deps.db, args.environmentId);
  let destroyOperation = getEnvironmentOperation(deps.db, {
    environmentId: args.environmentId,
    kind: "destroy",
  });
  const destroyPayload = getDestroyOperationPayload(deps, args.environmentId);
  if (
    !environment ||
    !environment.managed ||
    environment.status === "destroyed" ||
    destroyPayload === null
  ) {
    return;
  }

  if (countLiveThreadsInEnvironment(deps.db, { environmentId: environment.id }) > 0) {
    return;
  }

  if (!destroyOperation) {
    destroyOperation = upsertEnvironmentOperationRecord(deps.db, {
      environmentId: environment.id,
      kind: "destroy",
      payload: JSON.stringify(destroyPayload),
      requestedAt: environment.cleanupRequestedAt ?? undefined,
    });
  }

  if (
    hasPendingThreadShutdownInEnvironment(deps.db, {
      environmentId: environment.id,
    })
  ) {
    return;
  }

  if (!environment.path) {
    if (environment.status === "provisioning") {
      return;
    }

    if (destroyOperation) {
      markEnvironmentOperationRecordCompleted(deps.db, {
        environmentId: environment.id,
        kind: "destroy",
      });
    }
    setEnvironmentRecordDestroyed(deps.db, deps.hub, environment.id);
    return;
  }

  if (
    destroyOperation
    && (destroyOperation.state === "queued" || destroyOperation.state === "fetched")
    && destroyOperation.commandId
    && getPendingEnvironmentCommand(deps.db, {
      environmentId: environment.id,
      type: "environment.destroy",
    })
  ) {
    return;
  }

  if (destroyPayload.mode === "safe") {
    const canDestroyNow = await assertWorkspaceCanBeSafelyCleaned(
      deps,
      environment.id,
    );
    if (!canDestroyNow) {
      return;
    }

    const refreshedEnvironment = getEnvironment(deps.db, environment.id);
    if (
      !refreshedEnvironment ||
      refreshedEnvironment.status === "destroyed" ||
      refreshedEnvironment.status !== "ready" ||
      !refreshedEnvironment.path
    ) {
      return;
    }

    if (countLiveThreadsInEnvironment(deps.db, { environmentId: refreshedEnvironment.id }) > 0) {
      return;
    }

    if (
      hasPendingThreadShutdownInEnvironment(deps.db, {
        environmentId: refreshedEnvironment.id,
      })
    ) {
      return;
    }

    queueDestroyAndMarkDestroying(deps, {
      hostId: refreshedEnvironment.hostId,
      id: refreshedEnvironment.id,
      operationKind: "destroy",
      path: refreshedEnvironment.path,
      status: refreshedEnvironment.status,
      workspaceProvisionType: refreshedEnvironment.workspaceProvisionType,
    });
    return;
  }

  queueDestroyAndMarkDestroying(deps, {
    hostId: environment.hostId,
    id: environment.id,
    operationKind: "destroy",
    path: environment.path,
    status: environment.status,
    workspaceProvisionType: environment.workspaceProvisionType,
  });
}
