import {
  getActiveSession,
  getEnvironment,
  getThread,
  listStopRequestedThreads,
  listEnvironmentOperations,
  listThreadOperations,
  sweepEphemeralHostsPendingCleanup,
  sweepIdleEphemeralHostsEligibleForSuspend,
  sweepDestroyingEnvironments,
  sweepExpiredCommands,
  sweepExpiredLeases,
  sweepManagedEnvironments,
} from "@bb/db";
import { activeLifecycleOperationStates } from "@bb/domain";
import type {
  AppDeps,
  LoggedPendingInteractionWorkSessionDeps,
  LoggedSandboxWorkSessionDeps,
} from "../../types.js";
import { sweepDueAutomations } from "../scheduling/automation-sweep.js";
import { advanceEnvironmentCleanup } from "../environments/environment-cleanup.js";
import {
  advanceEnvironmentProvisioning,
  completeEnvironmentProvisioning,
} from "../environments/environment-provisioning.js";
import { handleExpiredCommands } from "../hosts/expired-commands.js";
import { failActiveLifecycleOperationsWithSettledCommands } from "../../internal/command-result-side-effect-failures.js";
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
  finalizeStoppedThread,
  requestThreadStop,
} from "../threads/thread-lifecycle.js";
import { advanceThreadProvisioning } from "../threads/thread-provisioning.js";

export type EvaluateManagedEnvironmentArchiveCleanupFn =
  typeof advanceEnvironmentCleanup;
export type DestroyHostFn = typeof destroyHost;

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
    AppDeps,
    | "cloudAuth"
    | "config"
    | "db"
    | "hostLifecycle"
    | "hub"
    | "logger"
    | "machineAuth"
    | "pendingInteractions"
    | "sandboxEnv"
    | "sandboxRegistry"
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

      await finalizeStoppedThread(deps, {
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
    AppDeps,
    | "cloudAuth"
    | "config"
    | "db"
    | "hostLifecycle"
    | "hub"
    | "logger"
    | "machineAuth"
    | "pendingInteractions"
    | "sandboxEnv"
    | "sandboxRegistry"
  >,
): Promise<void> {
  try {
    await deps.machineAuth.pruneExpiredKeys();
    const expired = sweepExpiredCommands(deps.db, deps.hub);
    if (expired.erroredCommandIds.length > 0) {
      await handleExpiredCommands(deps, {
        commandIds: expired.erroredCommandIds,
      });
    }
    await failActiveLifecycleOperationsWithSettledCommands(deps);
    const expiredLeases = sweepExpiredLeases(deps.db, deps.hub);
    if (expiredLeases.expiredSessionIds.length > 0) {
      deps.pendingInteractions.interruptPendingInteractionsForSessionIds({
        sessionIds: expiredLeases.expiredSessionIds,
        reason:
          "Host daemon session expired while awaiting user interaction; retry the thread to continue",
      });
    }
    sweepDestroyingEnvironments(deps.db, deps.hub);
    await sweepDueAutomations(deps);
    await sweepDueNudges(deps);
    await runEnvironmentProvisioningSweep(deps);
    await runThreadLifecycleSweep(deps);
    await runIdleSandboxSuspendSweep(deps);
    await runManagedEnvironmentArchiveCleanupSweep(
      deps,
      advanceEnvironmentCleanup,
    );
    await runProjectDeletionSweep(deps);
    await runEphemeralHostCleanupSweep(deps, destroyHost);
  } catch (error) {
    deps.logger.error({ err: error }, "Periodic sweep failed");
  }
}
