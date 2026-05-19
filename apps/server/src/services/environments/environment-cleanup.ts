import type {
  EnvironmentOperationKind,
  WorkspaceProvisionType,
} from "@bb/domain";
import {
  isActiveLifecycleOperationState,
  resolveEnvironmentMergeBaseBranch,
} from "@bb/domain";
import {
  cancelCommand,
  countLiveThreadsInEnvironment,
  getCommand,
  getEnvironment,
  getEnvironmentOperation,
  getEnvironmentOperationByCommandId,
  getActiveSession,
  getPendingEnvironmentCommand,
  hasPendingThreadShutdownInEnvironment,
  queueCommand,
  type DbNotifier,
  type DbQueryConnection,
} from "@bb/db";
import {
  cancelEnvironmentOperationRecord,
  clearEnvironmentCleanupRequestRecord,
  markEnvironmentOperationRecordCompleted,
  markEnvironmentOperationRecordFailed,
  markEnvironmentOperationRecordQueued,
  recordEnvironmentCleanupRequest,
  setEnvironmentRecordDestroyed,
  setEnvironmentStatus,
  upsertEnvironmentOperationRecord,
} from "@bb/db/internal-lifecycle";
import {
  hostDaemonCommandResultSchemaByType,
  type HostDaemonCommandResult,
} from "@bb/host-daemon-contract";
import { ApiError } from "../../errors.js";
import type { AppDeps, LoggedWorkSessionDeps } from "../../types.js";
import { queueCommandAndWait } from "../hosts/command-wait.js";
import { scheduleAfterDaemonIngressResponse } from "../hosts/command-wait-context.js";

export interface EnvironmentDestroyTarget {
  hostId: string;
  id: string;
  path: string;
  workspaceProvisionType: WorkspaceProvisionType;
}

export interface AdvanceEnvironmentCleanupArgs {
  environmentId: string;
}

export interface RequestEnvironmentCleanupAdvanceArgs {
  environmentId: string | null | undefined;
}

export interface RequestEnvironmentCleanupArgs {
  environmentId: string | null | undefined;
}

export interface CancelPendingEnvironmentCleanupArgs {
  environmentId: string | null | undefined;
}

export type CancelPendingEnvironmentCleanupResult =
  | "cancelled"
  | "in_progress"
  | "not_requested";

export interface EnvironmentCleanupCommandMutationArgs {
  commandId: string;
}

export interface FailEnvironmentCleanupForCommandArgs extends EnvironmentCleanupCommandMutationArgs {
  failureReason: string;
}

export interface WouldCleanupEnvironmentArgs {
  environmentId: string | null | undefined;
  excludeThreadId: string;
}

interface EnvironmentCleanupReadDeps {
  db: DbQueryConnection;
}

interface EnvironmentCleanupWriteDeps extends EnvironmentCleanupReadDeps {
  hub: DbNotifier;
}

function hasConnectedHostSession(
  deps: Pick<AppDeps, "db">,
  hostId: string,
): boolean {
  const session = getActiveSession(deps.db, hostId);
  return session !== null && session.leaseExpiresAt > Date.now();
}

function workspaceHasRiskyChanges(
  workspaceStatus: ReturnType<
    (typeof hostDaemonCommandResultSchemaByType)["workspace.status"]["parse"]
  >["workspaceStatus"],
): boolean {
  return (
    workspaceStatus.workingTree.hasUncommittedChanges ||
    workspaceStatus.mergeBase?.hasCommittedUnmergedChanges === true
  );
}

async function workspaceCanBeSafelyCleaned(
  deps: LoggedWorkSessionDeps,
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

  const mergeBaseBranch = resolveEnvironmentMergeBaseBranch(environment);
  if (environment.isGitRepo && !mergeBaseBranch) {
    return false;
  }

  let result: HostDaemonCommandResult<"workspace.status">;
  try {
    result = await queueCommandAndWait(deps, {
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
  return !workspaceHasRiskyChanges(result.workspaceStatus);
}

function canRequestCleanup(
  environment: NonNullable<ReturnType<typeof getEnvironment>>,
): boolean {
  return environment.managed && environment.status !== "destroyed";
}

function hasDestroyOperationRequest(
  deps: EnvironmentCleanupReadDeps,
  environmentId: string,
): boolean {
  const operation = getEnvironmentOperation(deps.db, {
    environmentId,
    kind: "destroy",
  });

  if (operation && isActiveLifecycleOperationState(operation.state)) {
    return true;
  }

  const environment = getEnvironment(deps.db, environmentId);
  return environment !== null && environment.cleanupMode !== null;
}

function getActiveDestroyOperationByCommandId(
  deps: EnvironmentCleanupReadDeps,
  commandId: string,
) {
  const operation = getEnvironmentOperationByCommandId(deps.db, commandId);
  if (
    !operation ||
    operation.kind !== "destroy" ||
    !isActiveLifecycleOperationState(operation.state)
  ) {
    return null;
  }

  return operation;
}

function restoreEnvironmentAfterCleanupCancellation(
  deps: EnvironmentCleanupWriteDeps,
  environment: NonNullable<ReturnType<typeof getEnvironment>>,
): void {
  if (environment.status !== "destroying") {
    return;
  }

  setEnvironmentStatus(deps.db, deps.hub, environment.id, {
    status: environment.path ? "ready" : "error",
  });
}

export function hasActiveEnvironmentDestroyOperationForCommand(
  deps: EnvironmentCleanupReadDeps,
  args: EnvironmentCleanupCommandMutationArgs,
): boolean {
  return getActiveDestroyOperationByCommandId(deps, args.commandId) !== null;
}

export function completeEnvironmentDestroyForCommand(
  deps: EnvironmentCleanupWriteDeps,
  args: EnvironmentCleanupCommandMutationArgs,
): boolean {
  const operation = getActiveDestroyOperationByCommandId(deps, args.commandId);
  if (!operation) {
    return false;
  }

  const environment = getEnvironment(deps.db, operation.environmentId);
  if (!environment) {
    return false;
  }
  if (
    countLiveThreadsInEnvironment(deps.db, {
      environmentId: operation.environmentId,
    }) > 0
  ) {
    cancelEnvironmentOperationRecord(deps.db, {
      environmentId: operation.environmentId,
      kind: operation.kind,
    });
    clearEnvironmentCleanupRequestRecord(
      deps.db,
      deps.hub,
      operation.environmentId,
    );
    restoreEnvironmentAfterCleanupCancellation(deps, environment);
    return false;
  }

  if (environment.status === "destroying") {
    setEnvironmentRecordDestroyed(deps.db, deps.hub, operation.environmentId);
  } else if (environment.status !== "destroyed") {
    return false;
  }

  markEnvironmentOperationRecordCompleted(deps.db, {
    environmentId: operation.environmentId,
    kind: operation.kind,
  });
  return true;
}

export function failEnvironmentDestroyForCommand(
  deps: EnvironmentCleanupWriteDeps,
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
  if (environment && environment.status === "destroying") {
    setEnvironmentStatus(deps.db, deps.hub, operation.environmentId, {
      status: environment.path ? "ready" : "error",
    });
  }

  return true;
}

export function requestEnvironmentCleanup(
  deps: EnvironmentCleanupWriteDeps,
  args: RequestEnvironmentCleanupArgs,
): void {
  if (!args.environmentId) {
    return;
  }

  const environment = getEnvironment(deps.db, args.environmentId);
  if (!environment || !canRequestCleanup(environment)) {
    return;
  }

  upsertEnvironmentOperationRecord(deps.db, {
    environmentId: environment.id,
    kind: "destroy",
    payload: JSON.stringify({}),
    requestedAt: environment.cleanupRequestedAt ?? undefined,
  });
  recordEnvironmentCleanupRequest(deps.db, deps.hub, environment.id, {});
}

export function cancelPendingEnvironmentCleanup(
  deps: EnvironmentCleanupWriteDeps,
  args: CancelPendingEnvironmentCleanupArgs,
): CancelPendingEnvironmentCleanupResult {
  if (!args.environmentId) {
    return "not_requested";
  }

  const environment = getEnvironment(deps.db, args.environmentId);
  if (!environment || environment.cleanupMode === null) {
    return "not_requested";
  }

  const operation = getEnvironmentOperation(deps.db, {
    environmentId: environment.id,
    kind: "destroy",
  });
  if (operation?.commandId) {
    const command = getCommand(deps.db, operation.commandId);
    if (command?.state === "fetched") {
      return "in_progress";
    }
    if (command?.state === "pending") {
      cancelCommand(deps.db, {
        commandId: command.id,
        resultPayload: JSON.stringify({
          errorCode: "environment_cleanup_cancelled",
          errorMessage: "Environment cleanup was cancelled",
        }),
      });
    }
  }

  if (operation) {
    cancelEnvironmentOperationRecord(deps.db, {
      environmentId: environment.id,
      kind: "destroy",
    });
  }
  clearEnvironmentCleanupRequestRecord(deps.db, deps.hub, environment.id);
  restoreEnvironmentAfterCleanupCancellation(deps, environment);
  return "cancelled";
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

  return (
    countLiveThreadsInEnvironment(deps.db, {
      environmentId: environment.id,
      excludeThreadId: args.excludeThreadId,
    }) === 0
  );
}

export async function advanceEnvironmentCleanup(
  deps: LoggedWorkSessionDeps,
  args: AdvanceEnvironmentCleanupArgs,
): Promise<void> {
  const environment = getEnvironment(deps.db, args.environmentId);
  let destroyOperation = getEnvironmentOperation(deps.db, {
    environmentId: args.environmentId,
    kind: "destroy",
  });
  if (
    !environment ||
    !environment.managed ||
    environment.status === "destroyed" ||
    !hasDestroyOperationRequest(deps, args.environmentId)
  ) {
    return;
  }

  if (
    countLiveThreadsInEnvironment(deps.db, { environmentId: environment.id }) >
    0
  ) {
    return;
  }

  if (!destroyOperation) {
    destroyOperation = upsertEnvironmentOperationRecord(deps.db, {
      environmentId: environment.id,
      kind: "destroy",
      payload: JSON.stringify({}),
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
    destroyOperation &&
    isActiveLifecycleOperationState(destroyOperation.state) &&
    destroyOperation.commandId &&
    getPendingEnvironmentCommand(deps.db, {
      environmentId: environment.id,
      type: "environment.destroy",
    })
  ) {
    return;
  }

  const canDestroyNow = await workspaceCanBeSafelyCleaned(
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

  if (
    countLiveThreadsInEnvironment(deps.db, {
      environmentId: refreshedEnvironment.id,
    }) > 0
  ) {
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
}

export async function runEnvironmentCleanupAdvance(
  deps: LoggedWorkSessionDeps,
  args: AdvanceEnvironmentCleanupArgs,
): Promise<void> {
  await deps.lifecycleDedupers.environmentCleanupAdvance.run(
    args.environmentId,
    async () => {
      await advanceEnvironmentCleanup(deps, args);
    },
  );
}

export function requestEnvironmentCleanupAdvance(
  deps: LoggedWorkSessionDeps,
  args: RequestEnvironmentCleanupAdvanceArgs,
): void {
  if (!args.environmentId) {
    return;
  }
  const environmentId = args.environmentId;

  scheduleAfterDaemonIngressResponse({
    context: {
      environmentId,
    },
    logger: deps.logger,
    name: "Environment cleanup advance request",
    work: () => runEnvironmentCleanupAdvance(deps, { environmentId }),
  });
}
