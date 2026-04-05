import { and, eq, inArray, isNotNull, sql } from "drizzle-orm";
import type {
  EnvironmentCleanupMode,
  WorkspaceProvisionType,
} from "@bb/domain";
import {
  countLiveThreadsInEnvironment,
  getEnvironment,
  getActiveSession,
  hostDaemonCommands,
  markEnvironmentDestroyed,
  queueCommand,
  requestEnvironmentCleanup as requestEnvironmentCleanupRecord,
  threads,
  updateEnvironmentStatus,
} from "@bb/db";
import { hostDaemonCommandResultSchemaByType } from "@bb/host-daemon-contract";
import { ApiError } from "../errors.js";
import type { AppDeps } from "../types.js";
import { queueCommandAndWait } from "./command-wait.js";

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

export interface ValidateEnvironmentCleanupRequestArgs {
  environmentId: string | null | undefined;
  mode: EnvironmentCleanupMode;
}

export interface WouldCleanupEnvironmentArgs {
  environmentId: string | null | undefined;
  excludeThreadId: string;
}

function hasConnectedHostSession(
  deps: Pick<AppDeps, "db">,
  hostId: string,
): boolean {
  const session = getActiveSession(deps.db, hostId);
  return session !== null && session.leaseExpiresAt > Date.now();
}

// Soft-deleted active threads still block environment cleanup until stop
// finalization or reconnect reconciliation confirms the runtime is gone.
function hasPendingThreadShutdowns(
  deps: Pick<AppDeps, "db">,
  environmentId: string,
): boolean {
  const pendingStopThread = deps.db
    .select({ id: threads.id })
    .from(threads)
    .where(
      and(
        eq(threads.environmentId, environmentId),
        isNotNull(threads.stopRequestedAt),
      ),
    )
    .get();

  return pendingStopThread !== undefined;
}

function hasPendingCommandForEnvironment(
  deps: Pick<AppDeps, "db">,
  args: {
    environmentId: string;
    type: "environment.destroy" | "workspace.status";
  },
): boolean {
  const pendingCommand = deps.db
    .select({ id: hostDaemonCommands.id })
    .from(hostDaemonCommands)
    .where(
      and(
        eq(hostDaemonCommands.type, args.type),
        inArray(hostDaemonCommands.state, ["pending", "fetched"]),
        sql`json_extract(${hostDaemonCommands.payload}, '$.environmentId') = ${args.environmentId}`,
      ),
    )
    .get();

  return pendingCommand !== undefined;
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
  deps: Pick<AppDeps, "db" | "hub">,
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
    hasPendingCommandForEnvironment(deps, {
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

  const rawResult = await queueCommandAndWait(deps, {
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

export async function validateEnvironmentCleanupRequest(
  deps: Pick<AppDeps, "db" | "hub">,
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

  requestEnvironmentCleanupRecord(deps.db, deps.hub, environment.id, {
    cleanupMode: args.mode,
  });
}

export function queueEnvironmentDestroyCommand(
  deps: Pick<AppDeps, "db" | "hub">,
  environment: EnvironmentDestroyTarget,
): void {
  if (
    hasPendingCommandForEnvironment(deps, {
      environmentId: environment.id,
      type: "environment.destroy",
    })
  ) {
    return;
  }

  const session = getActiveSession(deps.db, environment.hostId);
  queueCommand(deps.db, deps.hub, {
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
}

function queueDestroyAndMarkDestroying(
  deps: Pick<AppDeps, "db" | "hub">,
  environment: EnvironmentDestroyTarget & {
    status: NonNullable<ReturnType<typeof getEnvironment>>["status"];
  },
): void {
  queueEnvironmentDestroyCommand(deps, environment);
  if (environment.status !== "destroying") {
    updateEnvironmentStatus(deps.db, deps.hub, environment.id, {
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
  deps: Pick<AppDeps, "db" | "hub">,
  args: AdvanceEnvironmentCleanupArgs,
): Promise<void> {
  if (!args.environmentId) {
    return;
  }

  const environment = getEnvironment(deps.db, args.environmentId);
  if (
    !environment ||
    !environment.managed ||
    environment.status === "destroyed" ||
    environment.cleanupRequestedAt === null ||
    environment.cleanupMode === null
  ) {
    return;
  }

  if (countLiveThreadsInEnvironment(deps.db, { environmentId: environment.id }) > 0) {
    return;
  }

  if (hasPendingThreadShutdowns(deps, environment.id)) {
    return;
  }

  if (!environment.path) {
    if (environment.status === "provisioning") {
      return;
    }

    markEnvironmentDestroyed(deps.db, deps.hub, environment.id);
    return;
  }

  if (environment.status === "destroying") {
    queueEnvironmentDestroyCommand(deps, {
      hostId: environment.hostId,
      id: environment.id,
      path: environment.path,
      workspaceProvisionType: environment.workspaceProvisionType,
    });
    return;
  }

  if (environment.cleanupMode === "safe") {
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
      refreshedEnvironment.cleanupRequestedAt === null ||
      refreshedEnvironment.cleanupMode === null ||
      refreshedEnvironment.status !== "ready" ||
      !refreshedEnvironment.path
    ) {
      return;
    }

    if (countLiveThreadsInEnvironment(deps.db, { environmentId: refreshedEnvironment.id }) > 0) {
      return;
    }

    if (hasPendingThreadShutdowns(deps, refreshedEnvironment.id)) {
      return;
    }

    queueDestroyAndMarkDestroying(deps, {
      hostId: refreshedEnvironment.hostId,
      id: refreshedEnvironment.id,
      path: refreshedEnvironment.path,
      status: refreshedEnvironment.status,
      workspaceProvisionType: refreshedEnvironment.workspaceProvisionType,
    });
    return;
  }

  queueDestroyAndMarkDestroying(deps, {
    hostId: environment.hostId,
    id: environment.id,
    path: environment.path,
    status: environment.status,
    workspaceProvisionType: environment.workspaceProvisionType,
  });
}
