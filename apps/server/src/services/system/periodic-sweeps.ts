import { and, eq, isNull } from "drizzle-orm";
import {
  CLOSED_SESSION_ROW_RETENTION_MS,
  compactDatabase,
  COMPLETED_EVENT_OUTPUT_RETENTION_MS,
  DATABASE_COMPACTION_MIN_RECLAIMABLE_BYTES,
  DATABASE_COMPACTION_MIN_RECLAIMABLE_RATIO,
  DATABASE_INCREMENTAL_VACUUM_MAX_PAGES,
  DATABASE_INCREMENTAL_VACUUM_MIN_FREELIST_PAGES,
  DEFAULT_CLOSED_SESSION_PRUNE_BATCH_SIZE,
  DEFAULT_COMPLETED_EVENT_OUTPUT_TRUNCATION_BATCH_SIZE,
  DEFAULT_DESTROYED_ENVIRONMENT_EVENT_DETACH_BATCH_SIZE,
  DEFAULT_DESTROYED_ENVIRONMENT_PRUNE_BATCH_SIZE,
  DESTROYED_ENVIRONMENT_TTL_MS,
  dropDeferredLegacyTables,
  getDatabaseAutoVacuumMode,
  getDatabaseCompactionStats,
  getDatabaseFreelistStats,
  getDatabaseMaintenanceActivity,
  isDatabaseMaintenanceIdle,
  listDeferredLegacyTables,
  environments,
  pruneClosedSessions,
  pruneDestroyedEnvironments,
  runIncrementalVacuum,
  shouldCompactDatabase,
  shouldRunIncrementalVacuum,
  sweepManagedEnvironments,
  threads,
  truncateCompletedEventItemOutputs,
} from "@bb/db";
import type {
  AppDeps,
  LoggedPendingInteractionWorkSessionDeps,
} from "../../types.js";
import {
  recoverOrphanedEnvironmentDestroyRequests,
  runEnvironmentCleanupAdvance,
} from "../environments/environment-cleanup-internal.js";
import {
  isCommandTimeoutError,
  isHostUnavailableError,
  runtimeErrorLogFields,
} from "../lib/error-log-fields.js";
import { advanceEnvironmentProvisioning } from "../environments/environment-provisioning-internal.js";
import {
  advanceProjectDeletion,
  listProjectsPendingDeletion,
} from "../projects/project-deletion.js";
import { hasLiveThreadStartInFlight } from "../threads/thread-lifecycle.js";
import { advanceThreadProvisioning } from "../threads/thread-provisioning.js";
import {
  runQueuedMessageDispatch,
  type QueueWaitPluginDirectory,
} from "../threads/queued-message-dispatch.js";
import { deliverLegacyDeferredThreadMessages } from "../threads/legacy-deferred-messages.js";
import { LIVE_DAEMON_COMMAND_TIMEOUT_MS } from "../hosts/live-command.js";
import { runEventLoopWork, runEventLoopWorkSync } from "./event-loop-work.js";

type DatabaseMaintenanceSweepDeps = Pick<AppDeps, "db" | "logger">;

interface PluginScheduleSweeper {
  sweepDueSchedules(now: number): Promise<void>;
}

type PeriodicSweepDeps = LoggedPendingInteractionWorkSessionDeps & {
  pluginSchedules: PluginScheduleSweeper;
  /** Liveness directory for `plugin:<id>` wait holders. */
  plugins: QueueWaitPluginDirectory;
};

const DATABASE_MAINTENANCE_CHECK_INTERVAL_MS = 60 * 60_000;
const MANAGED_ENVIRONMENT_ARCHIVE_CLEANUP_RECOVERY_INTERVAL_MS = 15 * 60_000;
const ORPHANED_ENVIRONMENT_DESTROY_RECOVERY_DELAY_MS =
  LIVE_DAEMON_COMMAND_TIMEOUT_MS;

type PeriodicSweepJobCategory =
  | "retention"
  | "durable-intent-retry"
  | "orphan-cleanup"
  | "maintenance"
  | "scheduler";

export interface PeriodicSweepJob {
  cadenceMs: number;
  category: PeriodicSweepJobCategory;
  name: string;
  run(deps: PeriodicSweepDeps, now: number): Promise<void> | void;
}

interface PeriodicSweepJobState {
  lastStartedAt: number;
  running: boolean;
}

interface ManagedEnvironmentArchiveCleanupEvaluationResult {
  candidates: number;
  hostUnavailableDeferrals: number;
}

type PeriodicSweepJobList = readonly PeriodicSweepJob[];
type HostUnavailableDeferralsByHostId = ReadonlyMap<string, number>;

function countHostUnavailableDeferrals(
  deferralsByHostId: HostUnavailableDeferralsByHostId,
): number {
  let total = 0;
  for (const count of deferralsByHostId.values()) {
    total += count;
  }
  return total;
}

let lastDatabaseMaintenanceCheckAt = 0;
let databaseMaintenanceRunning = false;
let lastManagedEnvironmentArchiveCleanupRecoveryAt = 0;
const periodicSweepJobStates = new Map<string, PeriodicSweepJobState>();

function getPeriodicSweepJobState(
  job: PeriodicSweepJob,
): PeriodicSweepJobState {
  const existing = periodicSweepJobStates.get(job.name);
  if (existing) {
    return existing;
  }

  const created: PeriodicSweepJobState = {
    lastStartedAt: 0,
    running: false,
  };
  periodicSweepJobStates.set(job.name, created);
  return created;
}

async function runPeriodicSweepJob(
  deps: PeriodicSweepDeps,
  job: PeriodicSweepJob,
  now: number,
): Promise<void> {
  const state = getPeriodicSweepJobState(job);
  if (state.running) {
    deps.logger.debug(
      { sweepJob: job.name, sweepJobCategory: job.category },
      "Periodic sweep job skipped while already running",
    );
    return;
  }

  if (job.cadenceMs > 0 && now - state.lastStartedAt < job.cadenceMs) {
    return;
  }

  state.lastStartedAt = now;
  state.running = true;
  try {
    await runEventLoopWork(`sweep:${job.name}`, () => job.run(deps, now));
  } catch (error) {
    deps.logger.error(
      {
        err: error,
        sweepJob: job.name,
        sweepJobCategory: job.category,
      },
      "Periodic sweep job failed",
    );
  } finally {
    state.running = false;
  }
}

export async function runPeriodicSweepJobs(
  deps: PeriodicSweepDeps,
  jobs: PeriodicSweepJobList,
  now: number,
): Promise<void> {
  for (const job of jobs) {
    await runPeriodicSweepJob(deps, job, now);
  }
}

async function advanceRetiringManagedEnvironments(
  deps: LoggedPendingInteractionWorkSessionDeps,
): Promise<ManagedEnvironmentArchiveCleanupEvaluationResult> {
  const environmentsToClean = sweepManagedEnvironments(deps.db);
  if (environmentsToClean.length === 0) {
    return {
      candidates: 0,
      hostUnavailableDeferrals: 0,
    };
  }

  const hostUnavailableDeferralsByHostId = new Map<string, number>();
  for (const environment of environmentsToClean) {
    if (environment.path && !deps.hub.hasDaemonForHost(environment.hostId)) {
      hostUnavailableDeferralsByHostId.set(
        environment.hostId,
        (hostUnavailableDeferralsByHostId.get(environment.hostId) ?? 0) + 1,
      );
      continue;
    }

    try {
      await runEnvironmentCleanupAdvance(deps, {
        environmentId: environment.id,
      });
    } catch (error) {
      if (isCommandTimeoutError(error)) {
        deps.logger.debug(
          {
            environmentId: environment.id,
            ...runtimeErrorLogFields(deps.config, error),
          },
          "Managed environment archive cleanup deferred by host timeout",
        );
        continue;
      }
      if (isHostUnavailableError(error)) {
        hostUnavailableDeferralsByHostId.set(
          environment.hostId,
          (hostUnavailableDeferralsByHostId.get(environment.hostId) ?? 0) + 1,
        );
        continue;
      }
      deps.logger.warn(
        {
          environmentId: environment.id,
          err: error,
        },
        "Managed environment archive cleanup sweep failed",
      );
    }
  }

  const hostUnavailableDeferrals = countHostUnavailableDeferrals(
    hostUnavailableDeferralsByHostId,
  );
  if (
    hostUnavailableDeferrals > 0 &&
    hostUnavailableDeferrals < environmentsToClean.length
  ) {
    deps.logger.debug(
      {
        deferredEnvironmentCount: hostUnavailableDeferrals,
        deferredHostIds: Array.from(hostUnavailableDeferralsByHostId.keys()),
      },
      "Managed environment archive cleanup deferred some candidates until host reconnects",
    );
  }

  return {
    candidates: environmentsToClean.length,
    hostUnavailableDeferrals,
  };
}

export function runDatabaseMaintenanceSweep(
  deps: DatabaseMaintenanceSweepDeps,
  now: number,
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

  const deferredLegacyTables = listDeferredLegacyTables(deps.db);
  if (deferredLegacyTables.length > 0) {
    const activity = getDatabaseMaintenanceActivity(deps.db);
    if (!isDatabaseMaintenanceIdle(activity)) {
      deps.logger.debug(
        { activity, deferredLegacyTables },
        "Deferred legacy database table cleanup skipped while app work is active",
      );
      return;
    }

    databaseMaintenanceRunning = true;
    try {
      const result = dropDeferredLegacyTables(deps.db);
      deps.logger.info(
        { result },
        "Deferred legacy database table cleanup completed",
      );
    } catch (error) {
      deps.logger.warn(
        { err: error },
        "Deferred legacy database table cleanup failed",
      );
    } finally {
      databaseMaintenanceRunning = false;
    }
    return;
  }

  const autoVacuumMode = getDatabaseAutoVacuumMode(deps.db);

  if (autoVacuumMode === "incremental") {
    const freelistStats = getDatabaseFreelistStats(deps.db);
    if (
      !shouldRunIncrementalVacuum({
        minFreelistPages: DATABASE_INCREMENTAL_VACUUM_MIN_FREELIST_PAGES,
        stats: freelistStats,
      })
    ) {
      deps.logger.debug(
        { freelistStats },
        "Incremental database vacuum skipped below freelist threshold",
      );
      return;
    }
    databaseMaintenanceRunning = true;
    try {
      const result = runIncrementalVacuum(deps.db, {
        maxPages: DATABASE_INCREMENTAL_VACUUM_MAX_PAGES,
      });
      deps.logger.info({ result }, "Incremental database vacuum completed");
    } catch (error) {
      deps.logger.warn({ err: error }, "Incremental database vacuum failed");
    } finally {
      databaseMaintenanceRunning = false;
    }
    return;
  }

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

export async function runManagedEnvironmentArchiveCleanupRecoverySweep(
  deps: LoggedPendingInteractionWorkSessionDeps,
  now: number,
): Promise<void> {
  if (
    now - lastManagedEnvironmentArchiveCleanupRecoveryAt >=
    MANAGED_ENVIRONMENT_ARCHIVE_CLEANUP_RECOVERY_INTERVAL_MS
  ) {
    recoverOrphanedEnvironmentDestroyRequests(deps, {
      updatedBefore: now - ORPHANED_ENVIRONMENT_DESTROY_RECOVERY_DELAY_MS,
    });
    lastManagedEnvironmentArchiveCleanupRecoveryAt = now;
  }

  await advanceRetiringManagedEnvironments(deps);
}

async function runProjectDeletionSweep(
  deps: LoggedPendingInteractionWorkSessionDeps,
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
  deps: LoggedPendingInteractionWorkSessionDeps,
): Promise<void> {
  const provisioningEnvironments = deps.db
    .select({ id: environments.id })
    .from(environments)
    .where(eq(environments.status, "provisioning"))
    .all();

  for (const environment of provisioningEnvironments) {
    try {
      await advanceEnvironmentProvisioning(deps, {
        environmentId: environment.id,
      });
    } catch (error) {
      deps.logger.warn(
        {
          err: error,
          environmentId: environment.id,
        },
        "Environment provisioning sweep failed",
      );
    }
  }
}

async function runThreadProvisioningOrphanCleanupSweep(
  deps: LoggedPendingInteractionWorkSessionDeps,
): Promise<void> {
  const provisioningThreads = deps.db
    .select({
      id: threads.id,
      status: threads.status,
    })
    .from(threads)
    .where(and(eq(threads.status, "starting"), isNull(threads.deletedAt)))
    .all();

  for (const thread of provisioningThreads) {
    try {
      if (hasLiveThreadStartInFlight(thread.id)) {
        continue;
      }
      await advanceThreadProvisioning(deps, {
        threadId: thread.id,
      });
    } catch (error) {
      deps.logger.warn(
        {
          err: error,
          threadId: thread.id,
        },
        "Thread provisioning sweep failed",
      );
    }
  }
}

export async function runThreadLifecycleSweep(
  deps: LoggedPendingInteractionWorkSessionDeps,
): Promise<void> {
  await runThreadProvisioningOrphanCleanupSweep(deps);
}

async function runMachineAuthPruneSweep(
  deps: LoggedPendingInteractionWorkSessionDeps,
): Promise<void> {
  await deps.machineAuth.pruneExpiredKeys();
}

function runCompletedEventOutputTruncationSweep(
  deps: LoggedPendingInteractionWorkSessionDeps,
  now: number,
): void {
  truncateCompletedEventItemOutputs(deps.db, {
    createdBefore: now - COMPLETED_EVENT_OUTPUT_RETENTION_MS,
    limit: DEFAULT_COMPLETED_EVENT_OUTPUT_TRUNCATION_BATCH_SIZE,
    truncatedAt: now,
  });
}

function runClosedSessionPruneSweep(
  deps: LoggedPendingInteractionWorkSessionDeps,
  now: number,
): void {
  pruneClosedSessions(deps.db, {
    closedBefore: now - CLOSED_SESSION_ROW_RETENTION_MS,
    limit: DEFAULT_CLOSED_SESSION_PRUNE_BATCH_SIZE,
  });
}

async function runDestroyedEnvironmentPruneSweep(
  deps: LoggedPendingInteractionWorkSessionDeps,
  now: number,
): Promise<void> {
  for (
    let pruned = 0;
    pruned < DEFAULT_DESTROYED_ENVIRONMENT_PRUNE_BATCH_SIZE;
    pruned += 1
  ) {
    const { deleted, detachedEvents } = runEventLoopWorkSync(
      "sweep:destroyed-environment-prune:advance",
      () =>
        pruneDestroyedEnvironments(deps.db, deps.hub, {
          updatedBefore: now - DESTROYED_ENVIRONMENT_TTL_MS,
          eventBatchSize: DEFAULT_DESTROYED_ENVIRONMENT_EVENT_DETACH_BATCH_SIZE,
          limit: 1,
        }),
    );
    if (deleted === 0 && detachedEvents === 0) {
      break;
    }
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
}

const PERIODIC_SWEEP_JOBS: PeriodicSweepJob[] = [
  {
    cadenceMs: 0,
    category: "retention",
    name: "machine-auth-prune",
    run: runMachineAuthPruneSweep,
  },
  {
    cadenceMs: 0,
    category: "retention",
    name: "completed-event-output-truncation",
    run: runCompletedEventOutputTruncationSweep,
  },
  {
    cadenceMs: 0,
    category: "retention",
    name: "closed-session-prune",
    run: runClosedSessionPruneSweep,
  },
  {
    cadenceMs: 0,
    category: "retention",
    name: "destroyed-environment-prune",
    run: runDestroyedEnvironmentPruneSweep,
  },
  {
    cadenceMs: 0,
    category: "orphan-cleanup",
    name: "environment-provisioning-orphan-cleanup",
    run: runEnvironmentProvisioningSweep,
  },
  {
    cadenceMs: 0,
    category: "orphan-cleanup",
    name: "thread-provisioning-orphan-cleanup",
    run: runThreadProvisioningOrphanCleanupSweep,
  },
  {
    cadenceMs: 0,
    category: "durable-intent-retry",
    name: "queued-message-auto-send",
    run: (deps, now) =>
      runQueuedMessageDispatch(deps, {
        kind: "idle-recovery",
        now,
      }),
  },
  {
    cadenceMs: 0,
    category: "durable-intent-retry",
    name: "due-scheduled-queue-dispatch",
    run: (deps, now) =>
      runQueuedMessageDispatch(deps, { kind: "time-reached", now }),
  },
  {
    cadenceMs: 0,
    category: "durable-intent-retry",
    name: "orphaned-queue-wait-clear",
    run: (deps) =>
      runQueuedMessageDispatch(deps, {
        kind: "orphaned-plugin-recovery",
        plugins: deps.plugins,
      }),
  },
  {
    cadenceMs: 0,
    category: "durable-intent-retry",
    name: "managed-environment-archive-cleanup-recovery",
    run: runManagedEnvironmentArchiveCleanupRecoverySweep,
  },
  {
    cadenceMs: 0,
    category: "durable-intent-retry",
    name: "project-deletion",
    run: runProjectDeletionSweep,
  },
  {
    cadenceMs: 0,
    category: "scheduler",
    name: "plugin-schedule",
    run: (deps, now) => deps.pluginSchedules.sweepDueSchedules(now),
  },
  {
    cadenceMs: DATABASE_MAINTENANCE_CHECK_INTERVAL_MS,
    category: "maintenance",
    name: "database-maintenance",
    run: runDatabaseMaintenanceSweep,
  },
];

export async function runStartupRecoverySweep(
  deps: LoggedPendingInteractionWorkSessionDeps,
): Promise<void> {
  await deliverLegacyDeferredThreadMessages(deps);
  await runEnvironmentProvisioningSweep(deps);
  await runThreadLifecycleSweep(deps);
  recoverOrphanedEnvironmentDestroyRequests(deps, {
    updatedBefore: Date.now() - ORPHANED_ENVIRONMENT_DESTROY_RECOVERY_DELAY_MS,
  });
  await advanceRetiringManagedEnvironments(deps);
}

export async function runPeriodicSweeps(
  deps: PeriodicSweepDeps,
): Promise<void> {
  const now = Date.now();
  await runPeriodicSweepJobs(deps, PERIODIC_SWEEP_JOBS, now);
}
