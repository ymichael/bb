import {
  sweepDestroyingEnvironments,
  sweepExpiredCommands,
  sweepExpiredLeases,
  sweepManagedEnvironments,
} from "@bb/db";
import type { AppDeps } from "../types.js";
import { evaluateManagedEnvironmentArchiveCleanup } from "./environment-cleanup.js";

export type EvaluateManagedEnvironmentArchiveCleanupFn =
  typeof evaluateManagedEnvironmentArchiveCleanup;

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

export async function runPeriodicSweeps(
  deps: Pick<AppDeps, "db" | "hub" | "logger">,
): Promise<void> {
  try {
    sweepExpiredCommands(deps.db, deps.hub);
    sweepExpiredLeases(deps.db, deps.hub);
    sweepDestroyingEnvironments(deps.db, deps.hub);
    await runManagedEnvironmentArchiveCleanupSweep(
      deps,
      evaluateManagedEnvironmentArchiveCleanup,
    );
  } catch (error) {
    deps.logger.error({ err: error }, "Periodic sweep failed");
  }
}
