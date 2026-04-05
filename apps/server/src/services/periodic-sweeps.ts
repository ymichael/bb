import {
  sweepEphemeralHostsPendingCleanup,
  sweepDestroyingEnvironments,
  sweepExpiredCommands,
  sweepExpiredLeases,
  sweepManagedEnvironments,
} from "@bb/db";
import type { AppDeps } from "../types.js";
import { sweepDueAutomations } from "./automation-sweep.js";
import { advanceEnvironmentCleanup } from "./environment-cleanup.js";
import { destroyHost } from "./host-lifecycle.js";
import { sweepDueNudges } from "./nudge-sweep.js";

export type EvaluateManagedEnvironmentArchiveCleanupFn =
  typeof advanceEnvironmentCleanup;
export type DestroyHostFn = typeof destroyHost;

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

export async function runPeriodicSweeps(
  deps: Pick<AppDeps, "config" | "db" | "hub" | "logger" | "sandboxRegistry">,
): Promise<void> {
  try {
    sweepExpiredCommands(deps.db, deps.hub);
    sweepExpiredLeases(deps.db, deps.hub);
    sweepDestroyingEnvironments(deps.db, deps.hub);
    await sweepDueAutomations(deps);
    await sweepDueNudges(deps);
      await runManagedEnvironmentArchiveCleanupSweep(
        deps,
        advanceEnvironmentCleanup,
      );
    await runEphemeralHostCleanupSweep(deps, destroyHost);
  } catch (error) {
    deps.logger.error({ err: error }, "Periodic sweep failed");
  }
}
