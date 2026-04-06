import {
  environments,
  getEnvironment,
  getThread,
  listEnvironmentOperations,
  listThreadOperations,
  markEnvironmentOperationCompleted,
  markThreadOperationCompleted,
  sweepEphemeralHostsPendingCleanup,
  sweepDestroyingEnvironments,
  sweepExpiredCommands,
  sweepExpiredLeases,
  sweepManagedEnvironments,
  threads,
} from "@bb/db";
import { eq, isNotNull } from "drizzle-orm";
import type { AppDeps } from "../types.js";
import { sweepDueAutomations } from "./automation-sweep.js";
import { advanceEnvironmentCleanup } from "./environment-cleanup.js";
import { advanceEnvironmentProvisioning } from "./environment-provisioning.js";
import { handleExpiredCommands } from "./expired-commands.js";
import { destroyHost } from "./host-lifecycle.js";
import { sweepDueNudges } from "./nudge-sweep.js";
import {
  advanceProjectDeletion,
  listProjectsPendingDeletion,
} from "./project-deletion.js";
import {
  advanceThreadStart,
  requestThreadStop,
} from "./thread-stop.js";

export type EvaluateManagedEnvironmentArchiveCleanupFn =
  typeof advanceEnvironmentCleanup;
export type DestroyHostFn = typeof destroyHost;
const activeLifecycleOperationStates = [
  "requested",
  "queued",
  "fetched",
] as const;

export async function runManagedEnvironmentArchiveCleanupSweep(
  deps: Pick<AppDeps, "db" | "hub" | "logger">,
  evaluateCleanup: EvaluateManagedEnvironmentArchiveCleanupFn,
): Promise<void> {
  for (const environment of sweepManagedEnvironments(deps.db)) {
    try {
      await evaluateCleanup(
        { db: deps.db, hub: deps.hub },
        {
          environmentId: environment.id,
        },
      );
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
  deps: Pick<AppDeps, "config" | "db" | "hub" | "logger" | "sandboxRegistry">,
  destroySandboxHost: DestroyHostFn,
): Promise<void> {
  for (const host of sweepEphemeralHostsPendingCleanup(deps.db)) {
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
  deps: Pick<AppDeps, "config" | "db" | "hub" | "logger">,
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
  deps: Pick<AppDeps, "db" | "hub" | "logger">,
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
        markEnvironmentOperationCompleted(deps.db, {
          environmentId: environment.id,
          kind: operation.kind,
        });
        continue;
      }
      advanceEnvironmentProvisioning(deps, {
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

export async function runThreadLifecycleSweep(
  deps: Pick<AppDeps, "db" | "hub" | "logger">,
): Promise<void> {
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
        markThreadOperationCompleted(deps.db, {
          threadId: thread.id,
          kind: operation.kind,
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

  const stopRequestedThreads = deps.db
    .select({
      environmentId: threads.environmentId,
      hostId: environments.hostId,
      status: threads.status,
      stopRequestedAt: threads.stopRequestedAt,
      threadId: threads.id,
    })
    .from(threads)
    .innerJoin(environments, eq(threads.environmentId, environments.id))
    .where(isNotNull(threads.stopRequestedAt))
    .all();

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

      const stopOperation = listThreadOperations(deps.db, {
        kinds: ["stop"],
        states: [...activeLifecycleOperationStates],
        threadIds: [thread.threadId],
      })[0];
      if (thread.stopRequestedAt === null || !stopOperation) {
        continue;
      }
      if (thread.status !== "active") {
        markThreadOperationCompleted(deps.db, {
          threadId: thread.threadId,
          kind: stopOperation.kind,
        });
      }
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
  deps: Pick<AppDeps, "config" | "db" | "hub" | "logger" | "sandboxRegistry">,
): Promise<void> {
  try {
    const expired = sweepExpiredCommands(deps.db, deps.hub);
    if (expired.erroredCommandIds.length > 0) {
      await handleExpiredCommands(deps, {
        commandIds: expired.erroredCommandIds,
      });
    }
    sweepExpiredLeases(deps.db, deps.hub);
    sweepDestroyingEnvironments(deps.db, deps.hub);
    await sweepDueAutomations(deps);
    await sweepDueNudges(deps);
    await runEnvironmentProvisioningSweep(deps);
    await runThreadLifecycleSweep(deps);
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
