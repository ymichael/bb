import {
  CLOSED_SESSION_ROW_RETENTION_MS,
  compactDatabase,
  COMPLETED_COMMAND_ROW_RETENTION_MS,
  COMPLETED_COMMAND_PAYLOAD_RETENTION_MS,
  COMPLETED_EVENT_OUTPUT_RETENTION_MS,
  DATABASE_COMPACTION_MIN_RECLAIMABLE_BYTES,
  DATABASE_COMPACTION_MIN_RECLAIMABLE_RATIO,
  DEFAULT_CLOSED_SESSION_PRUNE_BATCH_SIZE,
  DEFAULT_COMPLETED_COMMAND_PRUNE_BATCH_SIZE,
  DEFAULT_COMPLETED_EVENT_OUTPUT_TRUNCATION_BATCH_SIZE,
  getDatabaseCompactionStats,
  getDatabaseMaintenanceActivity,
  getActiveSession,
  getEnvironment,
  getThread,
  isDatabaseMaintenanceIdle,
  listHostThreadIds,
  listStopRequestedThreads,
  listEnvironmentOperations,
  listThreadOperations,
  pruneClosedSessions,
  pruneCompletedCommands,
  pruneCompletedCommandPayloads,
  shouldCompactDatabase,
  sweepEphemeralHostsPendingCleanup,
  sweepIdleEphemeralHostsEligibleForSuspend,
  sweepDestroyingEnvironments,
  sweepExpiredCommands,
  sweepExpiredLeases,
  sweepManagedEnvironments,
  truncateCompletedEventItemOutputs,
} from "@bb/db";
import { activeLifecycleOperationStates } from "@bb/domain";
import type {
  AppDeps,
  LoggedPendingInteractionWorkSessionDeps,
  LoggedSandboxWorkSessionDeps,
  ServerAppDeps,
} from "../../types.js";
import { sweepDueAutomations } from "../scheduling/automation-sweep.js";
import { advanceEnvironmentCleanup } from "../environments/environment-cleanup.js";
import {
  advanceEnvironmentProvisioning,
  completeEnvironmentProvisioning,
} from "../environments/environment-provisioning.js";
import { handleExpiredCommands } from "../hosts/expired-commands.js";
import {
  destroyHost,
  maybeSuspendIdleSandbox,
} from "../hosts/host-lifecycle.js";
import { sweepDueNudges } from "../scheduling/nudge-sweep.js";
import {
  advanceProjectDeletion,
  listProjectsPendingDeletion,
} from "../projects/project-deletion.js";
import {
  advanceThreadStart,
  completeThreadStart,
  finalizeStoppedThreadAndAdvanceCleanup,
  requestThreadStop,
} from "../threads/thread-lifecycle.js";
import { advanceThreadProvisioning } from "../threads/thread-provisioning.js";
import { runQueuedMessageAutoSendSweep } from "../threads/queued-messages.js";

export type EvaluateManagedEnvironmentArchiveCleanupFn =
  typeof advanceEnvironmentCleanup;
export type DestroyHostFn = typeof destroyHost;
export type DatabaseMaintenanceSweepDeps = Pick<AppDeps, "db" | "logger">;

const DATABASE_MAINTENANCE_CHECK_INTERVAL_MS = 60 * 60_000;

let lastDatabaseMaintenanceCheckAt = 0;
let databaseMaintenanceRunning = false;

export function runDatabaseMaintenanceSweep(
  deps: DatabaseMaintenanceSweepDeps,
  now: number = Date.now(),
): void {
  if (databaseMaintenanceRunning) {
    return;
  }

  if (
    now - lastDatabaseMaintenanceCheckAt <
    DATABASE_MAINTENANCE_CHECK_INTERVAL_MS
  ) {
    return;
  }

  lastDatabaseMaintenanceCheckAt = now;

  const activity = getDatabaseMaintenanceActivity(deps.db);
  if (!isDatabaseMaintenanceIdle(activity)) {
    deps.logger.debug(
      { activity },
      "Database maintenance skipped while app work is active",
    );
    return;
  }

  const stats = getDatabaseCompactionStats(deps.db);
  if (
    !shouldCompactDatabase({
      minReclaimableBytes: DATABASE_COMPACTION_MIN_RECLAIMABLE_BYTES,
      minReclaimableRatio: DATABASE_COMPACTION_MIN_RECLAIMABLE_RATIO,
      stats,
    })
  ) {
    deps.logger.debug(
      { stats },
      "Database maintenance skipped below compaction threshold",
    );
    return;
  }

  databaseMaintenanceRunning = true;
  try {
    const result = compactDatabase(deps.db);
    deps.logger.info({ result }, "Database compaction completed");
  } catch (error) {
    deps.logger.warn({ err: error }, "Database compaction failed");
  } finally {
    databaseMaintenanceRunning = false;
  }
}

export async function runManagedEnvironmentArchiveCleanupSweep(
  deps: LoggedSandboxWorkSessionDeps,
  evaluateCleanup: EvaluateManagedEnvironmentArchiveCleanupFn,
): Promise<void> {
  for (const environment of sweepManagedEnvironments(deps.db)) {
    try {
      await evaluateCleanup(deps, {
        environmentId: environment.id,
      });
    } catch (error) {
      deps.logger.warn(
        {
          err: error,
          environmentId: environment.id,
        },
        "Managed environment archive cleanup sweep failed",
      );
    }
  }
}

export async function runEphemeralHostCleanupSweep(
  deps: Pick<
    AppDeps,
    | "cloudAuth"
    | "config"
    | "db"
    | "hostLifecycle"
    | "hub"
    | "logger"
    | "sandboxEnv"
    | "sandboxRegistry"
  >,
  destroySandboxHost: DestroyHostFn,
): Promise<void> {
  for (const host of sweepEphemeralHostsPendingCleanup(deps.db)) {
    if (host.suspendedAt !== null) {
      continue;
    }
    if (getActiveSession(deps.db, host.id)) {
      continue;
    }

    try {
      await destroySandboxHost(deps, host.id);
    } catch (error) {
      deps.logger.warn(
        {
          err: error,
          hostId: host.id,
        },
        "Ephemeral host cleanup sweep failed",
      );
    }
  }
}

export async function runProjectDeletionSweep(
  deps: Pick<
    ServerAppDeps,
    | "cloudAuth"
    | "config"
    | "db"
    | "hostLifecycle"
    | "hub"
    | "lifecycleDedupers"
    | "logger"
    | "machineAuth"
    | "pendingInteractions"
    | "sandboxEnv"
    | "sandboxRegistry"
    | "terminalSessions"
  >,
): Promise<void> {
  for (const projectId of listProjectsPendingDeletion(deps)) {
    try {
      await advanceProjectDeletion(deps, { projectId });
    } catch (error) {
      deps.logger.warn(
        {
          err: error,
          projectId,
        },
        "Project deletion sweep failed",
      );
    }
  }
}

export async function runEnvironmentProvisioningSweep(
  deps: Pick<
    AppDeps,
    | "cloudAuth"
    | "config"
    | "db"
    | "hostLifecycle"
    | "hub"
    | "lifecycleDedupers"
    | "logger"
    | "machineAuth"
    | "sandboxEnv"
    | "sandboxRegistry"
  >,
): Promise<void> {
  const seenEnvironmentIds = new Set<string>();

  for (const operation of listEnvironmentOperations(deps.db, {
    kinds: ["provision", "reprovision"],
    states: [...activeLifecycleOperationStates],
  })) {
    if (seenEnvironmentIds.has(operation.environmentId)) {
      continue;
    }
    seenEnvironmentIds.add(operation.environmentId);

    try {
      const environment = getEnvironment(deps.db, operation.environmentId);
      if (!environment) {
        continue;
      }
      if (environment.status === "ready") {
        completeEnvironmentProvisioning(deps, {
          environmentId: environment.id,
        });
        continue;
      }
      await advanceEnvironmentProvisioning(deps, {
        environmentId: environment.id,
      });
    } catch (error) {
      deps.logger.warn(
        {
          err: error,
          environmentId: operation.environmentId,
          operationKind: operation.kind,
        },
        "Environment provisioning sweep failed",
      );
    }
  }
}

export async function runIdleSandboxSuspendSweep(
  deps: Pick<
    AppDeps,
    | "cloudAuth"
    | "config"
    | "db"
    | "hostLifecycle"
    | "hub"
    | "logger"
    | "sandboxEnv"
    | "sandboxRegistry"
  >,
): Promise<void> {
  for (const host of sweepIdleEphemeralHostsEligibleForSuspend(deps.db, {
    inactiveBefore: Date.now() - deps.config.sandboxIdleThresholdMs,
  })) {
    try {
      await maybeSuspendIdleSandbox(deps, {
        hostId: host.id,
      });
    } catch (error) {
      deps.logger.warn(
        {
          err: error,
          hostId: host.id,
        },
        "Idle sandbox suspend sweep failed",
      );
    }
  }
}

export async function runThreadLifecycleSweep(
  deps: LoggedPendingInteractionWorkSessionDeps,
): Promise<void> {
  for (const operation of listThreadOperations(deps.db, {
    kinds: ["provision"],
    states: [...activeLifecycleOperationStates],
  })) {
    try {
      await advanceThreadProvisioning(deps, {
        threadId: operation.threadId,
      });
    } catch (error) {
      deps.logger.warn(
        {
          err: error,
          threadId: operation.threadId,
          operationKind: operation.kind,
        },
        "Thread provisioning sweep failed",
      );
    }
  }

  for (const operation of listThreadOperations(deps.db, {
    kinds: ["start"],
    states: [...activeLifecycleOperationStates],
  })) {
    try {
      const thread = getThread(deps.db, operation.threadId);
      if (!thread || thread.deletedAt !== null || !thread.environmentId) {
        continue;
      }
      if (thread.status === "active") {
        completeThreadStart(deps, {
          threadId: thread.id,
        });
        continue;
      }
      if (thread.status === "error") {
        continue;
      }

      const environment = getEnvironment(deps.db, thread.environmentId);
      if (!environment) {
        continue;
      }

      await advanceThreadStart(deps, {
        hostId: environment.hostId,
        threadId: thread.id,
      });
    } catch (error) {
      deps.logger.warn(
        {
          err: error,
          threadId: operation.threadId,
          operationKind: operation.kind,
        },
        "Thread start sweep failed",
      );
    }
  }

  const stopRequestedThreads = listStopRequestedThreads(deps.db);

  for (const thread of stopRequestedThreads) {
    try {
      if (thread.status === "active" && thread.environmentId !== null) {
        requestThreadStop(deps, {
          environmentId: thread.environmentId,
          hostId: thread.hostId,
          stopRequestedAt: thread.stopRequestedAt,
          threadId: thread.threadId,
        });
        continue;
      }

      await finalizeStoppedThreadAndAdvanceCleanup(deps, {
        threadId: thread.threadId,
      });
    } catch (error) {
      deps.logger.warn(
        {
          err: error,
          threadId: thread.threadId,
        },
        "Thread stop sweep failed",
      );
    }
  }
}

export async function runPeriodicSweeps(
  deps: Pick<
    ServerAppDeps,
    | "cloudAuth"
    | "config"
    | "db"
    | "hostLifecycle"
    | "hub"
    | "lifecycleDedupers"
    | "logger"
    | "machineAuth"
    | "pendingInteractions"
    | "sandboxEnv"
    | "sandboxRegistry"
    | "terminalSessions"
  >,
): Promise<void> {
  try {
    const now = Date.now();

    await deps.machineAuth.pruneExpiredKeys();
    const expired = sweepExpiredCommands(deps.db, deps.hub);
    if (expired.erroredCommandIds.length > 0) {
      await handleExpiredCommands(deps, {
        commandIds: expired.erroredCommandIds,
      });
    }
    pruneCompletedCommandPayloads(deps.db, {
      completedBefore: now - COMPLETED_COMMAND_PAYLOAD_RETENTION_MS,
    });
    truncateCompletedEventItemOutputs(deps.db, {
      createdBefore: now - COMPLETED_EVENT_OUTPUT_RETENTION_MS,
      limit: DEFAULT_COMPLETED_EVENT_OUTPUT_TRUNCATION_BATCH_SIZE,
      truncatedAt: now,
    });
    pruneCompletedCommands(deps.db, {
      completedBefore: now - COMPLETED_COMMAND_ROW_RETENTION_MS,
      limit: DEFAULT_COMPLETED_COMMAND_PRUNE_BATCH_SIZE,
    });
    pruneClosedSessions(deps.db, {
      closedBefore: now - CLOSED_SESSION_ROW_RETENTION_MS,
      limit: DEFAULT_CLOSED_SESSION_PRUNE_BATCH_SIZE,
    });
    const expiredLeases = sweepExpiredLeases(deps.db, deps.hub);
    if (expiredLeases.expiredSessionIds.length > 0) {
      for (const sessionId of expiredLeases.expiredSessionIds) {
        deps.hub.closeDaemonSession(sessionId, "expired");
      }
      deps.pendingInteractions.interruptPendingInteractionsForSessionIds({
        sessionIds: expiredLeases.expiredSessionIds,
        reason:
          "Host daemon connection expired while awaiting user interaction; retry the thread to continue",
      });
      for (const hostId of expiredLeases.expiredHostIds) {
        for (const threadId of listHostThreadIds(deps.db, { hostId })) {
          deps.hub.notifyThread(threadId, ["status-changed"]);
        }
      }
    }
    sweepDestroyingEnvironments(deps.db, deps.hub);
    await sweepDueAutomations(deps);
    await sweepDueNudges(deps);
    await runEnvironmentProvisioningSweep(deps);
    await runThreadLifecycleSweep(deps);
    await runQueuedMessageAutoSendSweep(deps);
    await runIdleSandboxSuspendSweep(deps);
    await runManagedEnvironmentArchiveCleanupSweep(
      deps,
      advanceEnvironmentCleanup,
    );
    await runProjectDeletionSweep(deps);
    await runEphemeralHostCleanupSweep(deps, destroyHost);
    runDatabaseMaintenanceSweep(deps, now);
  } catch (error) {
    deps.logger.error({ err: error }, "Periodic sweep failed");
  }
}
