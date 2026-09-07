import type { WorkspaceProvisionType } from "@bb/domain";
import { threadScope } from "@bb/domain";
import {
  countLiveThreadsInEnvironment,
  getEnvironment,
  hasPendingThreadShutdownInEnvironment,
  hasRevivableArchivedThreadInEnvironment,
  listLiveThreadsInEnvironment,
  type DbNotifier,
  type DbQueryConnection,
  type DbTransaction,
} from "@bb/db";
import { listStaleDestroyingManagedEnvironments } from "@bb/db/internal-environment-lifecycle";
import {
  emptyCommandResultSideEffects,
  type CommandResultReportForType,
  type CommandResultSideEffectsDeps,
  type CommandResultSideEffectsResult,
  type HostDaemonCommandExecutionRecord,
  type HostDaemonCommandForType,
} from "../../internal/command-result-side-effects.js";
import type { AppDeps, LoggedWorkSessionDeps } from "../../types.js";
import {
  createLiveHostCommandExecution,
  LIVE_DAEMON_COMMAND_TIMEOUT_MS,
  startLiveHostCommand,
} from "../hosts/live-command.js";
import { deferAfterResponse } from "../lib/response-deferral.js";
import { appendSystemErrorEventInTransaction } from "../threads/thread-events.js";
import { applyLoggedThreadLifecycleEventInTransaction } from "../threads/lifecycle-outcome.js";
import {
  applyLoggedEnvironmentLifecycleEvent,
  applyLoggedEnvironmentLifecycleEventInTransaction,
} from "./lifecycle-outcome.js";
import { workspaceContextFromPath } from "./workspace-command-target.js";

interface EnvironmentDestroyTarget {
  hostId: string;
  id: string;
  path: string;
  workspaceProvisionType: WorkspaceProvisionType;
}

interface AdvanceEnvironmentCleanupArgs {
  environmentId: string;
}

interface RequestEnvironmentCleanupAdvanceArgs {
  environmentId: string | null | undefined;
}

interface RequestEnvironmentCleanupArgs {
  environmentId: string | null | undefined;
}

interface RecoverOrphanedEnvironmentDestroyRequestsArgs {
  updatedBefore: number;
}

interface RecoverOrphanedEnvironmentDestroyRequestsResult {
  destroyed: number;
  errored: number;
}

type EnvironmentDestroyCommand =
  HostDaemonCommandForType<"environment.destroy">;
type EnvironmentDestroyCommandResultReport =
  CommandResultReportForType<"environment.destroy">;

const TEARDOWN_TIMEOUT_MS = 15 * 60 * 1000;

interface SettleEnvironmentDestroyCommandResultArgs {
  command: EnvironmentDestroyCommand;
  deps: EnvironmentCleanupSettlementDeps;
  execution: HostDaemonCommandExecutionRecord;
  report: EnvironmentDestroyCommandResultReport;
}

interface WouldCleanupEnvironmentArgs {
  environmentId: string | null | undefined;
  excludeThreadId?: string;
}

interface EnvironmentCleanupReadDeps {
  db: DbQueryConnection;
}

interface EnvironmentCleanupWriteDeps extends EnvironmentCleanupReadDeps {
  hub: DbNotifier;
  logger: AppDeps["logger"];
}

type EnvironmentCleanupRecoveryDeps = Pick<AppDeps, "db" | "hub" | "logger">;

interface EnvironmentCleanupSettlementDeps extends EnvironmentCleanupWriteDeps {
  db: DbTransaction;
  logger: AppDeps["logger"];
}

type EnvironmentCleanupDecisionDeps = Pick<AppDeps, "db">;

function workspaceCanBeDestroyedNow(
  deps: LoggedWorkSessionDeps,
  environmentId: string,
): boolean {
  const environment = getEnvironment(deps.db, environmentId);
  if (
    !environment ||
    !environment.managed ||
    (environment.status !== "retiring" && environment.status !== "error") ||
    !environment.path
  ) {
    return false;
  }

  if (!deps.hub.hasDaemonForHost(environment.hostId)) {
    return false;
  }

  return true;
}

function canRequestCleanup(
  environment: NonNullable<ReturnType<typeof getEnvironment>>,
): boolean {
  return environment.managed && environment.status === "ready";
}

function canAdvanceCleanup(
  deps: EnvironmentCleanupReadDeps,
  environmentId: string,
): boolean {
  const environment = getEnvironment(deps.db, environmentId);
  return (
    environment !== null &&
    (environment.status === "retiring" || environment.status === "error")
  );
}

function markLiveThreadsErroredAfterDestroySuccess(
  deps: EnvironmentCleanupSettlementDeps,
  environmentId: string,
): void {
  const liveThreads = listLiveThreadsInEnvironment(deps.db, { environmentId });
  for (const thread of liveThreads) {
    appendSystemErrorEventInTransaction(deps, {
      threadId: thread.id,
      environmentId,
      code: "environment_workspace_destroyed",
      message:
        "The workspace for this thread was destroyed before the thread could be stopped.",
      scope: threadScope(),
    });
    const outcome = applyLoggedThreadLifecycleEventInTransaction(deps, {
      event: { type: "run.failed" },
      threadId: thread.id,
    });
    if (outcome.applied) {
      deps.hub.notifyThread(thread.id, ["status-changed"]);
    }
  }
}

export function settleEnvironmentDestroyCommandResult(
  args: SettleEnvironmentDestroyCommandResultArgs,
): CommandResultSideEffectsResult {
  if (!args.report.ok) {
    const outcome = applyLoggedEnvironmentLifecycleEventInTransaction(
      args.deps,
      {
        environmentId: args.command.environmentId,
        event: {
          type: "destroy.failed",
          destroyAttemptId: args.execution.id,
        },
      },
    );
    if (outcome.applied) {
      args.deps.hub.notifyEnvironment(
        args.command.environmentId,
        outcome.changes,
      );
    }
    return emptyCommandResultSideEffects();
  }

  const environment = getEnvironment(args.deps.db, args.command.environmentId);
  if (!environment) {
    return emptyCommandResultSideEffects();
  }
  if (environment.status !== "destroyed") {
    const outcome = applyLoggedEnvironmentLifecycleEventInTransaction(
      args.deps,
      {
        environmentId: args.command.environmentId,
        event: {
          type: "destroy.completed",
          destroyAttemptId: args.execution.id,
        },
      },
    );
    if (!outcome.applied) {
      return emptyCommandResultSideEffects();
    }
    args.deps.hub.notifyEnvironment(
      args.command.environmentId,
      outcome.changes,
    );
  }

  markLiveThreadsErroredAfterDestroySuccess(
    args.deps,
    args.command.environmentId,
  );

  return {
    postCommitActions: [
      {
        run: (deps) =>
          deps.terminalSessions.closeDestroyedEnvironmentTerminals({
            environmentId: environment.id,
          }),
      },
    ],
  };
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

  applyLoggedEnvironmentLifecycleEvent(deps, {
    environmentId: environment.id,
    event: { type: "retire.requested" },
  });
}

function dispatchEnvironmentDestroy(
  deps: CommandResultSideEffectsDeps,
  environment: EnvironmentDestroyTarget,
  execution: HostDaemonCommandExecutionRecord,
) {
  startLiveHostCommand(deps, {
    command: {
      type: "environment.destroy",
      environmentId: environment.id,
      workspaceContext: workspaceContextFromPath(environment),
      teardownTimeoutMs: TEARDOWN_TIMEOUT_MS,
    },
    execution,
    hostId: environment.hostId,
    timeoutMs: LIVE_DAEMON_COMMAND_TIMEOUT_MS,
    onError: ({ error }) => {
      deps.logger.warn(
        { err: error, environmentId: environment.id },
        "Live environment destroy command failed",
      );
    },
  });
}

export function wouldCleanupEnvironment(
  deps: EnvironmentCleanupDecisionDeps,
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

export function recoverOrphanedEnvironmentDestroyRequests(
  deps: EnvironmentCleanupRecoveryDeps,
  args: RecoverOrphanedEnvironmentDestroyRequestsArgs,
): RecoverOrphanedEnvironmentDestroyRequestsResult {
  const staleEnvironments = listStaleDestroyingManagedEnvironments(deps.db, {
    updatedBefore: args.updatedBefore,
  });

  let destroyed = 0;
  let errored = 0;
  for (const environment of staleEnvironments) {
    const outcome = applyLoggedEnvironmentLifecycleEvent(deps, {
      environmentId: environment.id,
      event: { type: "destroy.lost" },
    });
    if (!outcome.applied) {
      continue;
    }
    if (outcome.environment.status === "destroyed") {
      destroyed += 1;
    } else {
      errored += 1;
    }
  }

  return { destroyed, errored };
}

async function advanceEnvironmentCleanup(
  deps: CommandResultSideEffectsDeps,
  args: AdvanceEnvironmentCleanupArgs,
): Promise<void> {
  const environment = getEnvironment(deps.db, args.environmentId);
  if (
    !environment ||
    !environment.managed ||
    environment.status === "destroyed" ||
    !canAdvanceCleanup(deps, args.environmentId)
  ) {
    return;
  }

  if (
    countLiveThreadsInEnvironment(deps.db, { environmentId: environment.id }) >
    0
  ) {
    return;
  }

  if (
    hasPendingThreadShutdownInEnvironment(deps.db, {
      environmentId: environment.id,
    })
  ) {
    return;
  }

  if (!environment.path) {
    const execution = createLiveHostCommandExecution(environment.hostId);
    const startOutcome = applyLoggedEnvironmentLifecycleEvent(deps, {
      environmentId: environment.id,
      event: { type: "destroy.started", destroyAttemptId: execution.id },
    });
    if (!startOutcome.applied) {
      return;
    }
    applyLoggedEnvironmentLifecycleEvent(deps, {
      environmentId: environment.id,
      event: {
        type: "destroy.completed",
        destroyAttemptId: execution.id,
      },
    });
    return;
  }

  const canDestroyNow = workspaceCanBeDestroyedNow(deps, environment.id);
  if (!canDestroyNow) {
    return;
  }

  const refreshedEnvironment = getEnvironment(deps.db, environment.id);
  if (
    !refreshedEnvironment ||
    (refreshedEnvironment.status !== "retiring" &&
      refreshedEnvironment.status !== "error")
  ) {
    return;
  }

  if (
    refreshedEnvironment.status === "retiring" &&
    refreshedEnvironment.path !== null &&
    refreshedEnvironment.retireRequestedAt !== null &&
    Date.now() - refreshedEnvironment.retireRequestedAt <
      deps.config.managedEnvironmentRetireGraceMs &&
    hasRevivableArchivedThreadInEnvironment(deps.db, {
      environmentId: refreshedEnvironment.id,
    })
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

  const execution = createLiveHostCommandExecution(refreshedEnvironment.hostId);
  const claimOutcome = applyLoggedEnvironmentLifecycleEvent(deps, {
    environmentId: refreshedEnvironment.id,
    event: { type: "destroy.started", destroyAttemptId: execution.id },
  });
  if (!claimOutcome.applied) {
    return;
  }
  const claimedEnvironment = claimOutcome.environment;
  if (!claimedEnvironment.path) {
    applyLoggedEnvironmentLifecycleEvent(deps, {
      environmentId: claimedEnvironment.id,
      event: {
        type: "destroy.completed",
        destroyAttemptId: execution.id,
      },
    });
    return;
  }

  dispatchEnvironmentDestroy(
    deps,
    {
      hostId: claimedEnvironment.hostId,
      id: claimedEnvironment.id,
      path: claimedEnvironment.path,
      workspaceProvisionType: claimedEnvironment.workspaceProvisionType,
    },
    execution,
  );
}

export async function runEnvironmentCleanupAdvance(
  deps: CommandResultSideEffectsDeps,
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
  deps: CommandResultSideEffectsDeps,
  args: RequestEnvironmentCleanupAdvanceArgs,
): void {
  if (!args.environmentId) {
    return;
  }
  const environmentId = args.environmentId;

  deferAfterResponse({
    config: deps.config,
    context: {
      environmentId,
    },
    logger: deps.logger,
    name: "Environment cleanup advance request",
    work: () => runEnvironmentCleanupAdvance(deps, { environmentId }),
  });
}
