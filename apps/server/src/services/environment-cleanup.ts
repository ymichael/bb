import { and, eq, inArray, isNotNull, sql } from "drizzle-orm";
import type { WorkspaceProvisionType } from "@bb/domain";
import {
  countLiveThreadsInEnvironment,
  getEnvironment,
  getActiveSession,
  hostDaemonCommands,
  queueCommand,
  threads,
  updateEnvironmentStatus,
} from "@bb/db";
import { hostDaemonCommandResultSchemaByType } from "@bb/host-daemon-contract";
import type { AppDeps } from "../types.js";
import { queueCommandAndWait } from "./command-wait.js";

export interface EnvironmentDestroyTarget {
  hostId: string;
  id: string;
  path: string;
  workspaceProvisionType: WorkspaceProvisionType;
}

export interface EvaluateManagedEnvironmentArchiveCleanupArgs {
  environmentId: string | null | undefined;
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

export function maybeStartEnvironmentCleanup(
  deps: Pick<AppDeps, "db" | "hub">,
  environmentId: string | null | undefined,
): void {
  if (!environmentId) {
    return;
  }

  const environment = getEnvironment(deps.db, environmentId);
  if (
    !environment ||
    !environment.managed ||
    environment.status === "destroyed"
  ) {
    return;
  }

  if (countLiveThreadsInEnvironment(deps.db, { environmentId }) > 0) {
    return;
  }

  if (hasPendingThreadShutdowns(deps, environmentId)) {
    return;
  }

  if (environment.status !== "destroying") {
    updateEnvironmentStatus(deps.db, deps.hub, environmentId, {
      status: "destroying",
    });
  }

  if (!environment.path) {
    return;
  }

  queueEnvironmentDestroyCommand(deps, {
    hostId: environment.hostId,
    id: environment.id,
    path: environment.path,
    workspaceProvisionType: environment.workspaceProvisionType,
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

export async function evaluateManagedEnvironmentArchiveCleanup(
  deps: Pick<AppDeps, "db" | "hub">,
  args: EvaluateManagedEnvironmentArchiveCleanupArgs,
): Promise<void> {
  if (!args.environmentId) {
    return;
  }

  const environment = getEnvironment(deps.db, args.environmentId);
  if (
    !environment ||
    !environment.managed ||
    environment.status === "destroyed"
  ) {
    return;
  }

  if (countLiveThreadsInEnvironment(deps.db, { environmentId: environment.id }) > 0) {
    return;
  }

  if (hasPendingThreadShutdowns(deps, environment.id)) {
    return;
  }

  if (environment.status === "destroying") {
    if (!environment.path) {
      return;
    }

    queueEnvironmentDestroyCommand(deps, {
      hostId: environment.hostId,
      id: environment.id,
      path: environment.path,
      workspaceProvisionType: environment.workspaceProvisionType,
    });
    return;
  }

  if (environment.status !== "ready" || !environment.path) {
    maybeStartEnvironmentCleanup(deps, environment.id);
    return;
  }

  if (!hasConnectedHostSession(deps, environment.hostId)) {
    return;
  }

  if (
    hasPendingCommandForEnvironment(deps, {
      environmentId: environment.id,
      type: "workspace.status",
    })
  ) {
    return;
  }

  const mergeBaseBranch = environment.mergeBaseBranch ?? environment.defaultBranch;
  if (environment.isGitRepo && !mergeBaseBranch) {
    return;
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
    return;
  }

  maybeStartEnvironmentCleanup(deps, environment.id);
}
