import type {
  DbConnection,
  DbNotifier,
  DbQueryConnection,
  DbTransaction,
} from "@bb/db";
import {
  applyEnvironmentLifecycleEvent,
  applyEnvironmentLifecycleEventInTransaction,
  type ApplyEnvironmentLifecycleEventArgs,
  type ApplyEnvironmentLifecycleEventOutcome,
} from "@bb/db/internal-environment-lifecycle";
import type { ServerLogger } from "../../types.js";

interface ApplyLoggedEnvironmentLifecycleEventDeps {
  db: DbQueryConnection;
  hub: DbNotifier;
  logger: ServerLogger;
}

interface ApplyLoggedEnvironmentLifecycleEventTransactionDeps {
  db: DbTransaction;
  logger: ServerLogger;
}

function logUnappliedEnvironmentLifecycleEvent(
  logger: ServerLogger,
  args: ApplyEnvironmentLifecycleEventArgs,
  outcome: ApplyEnvironmentLifecycleEventOutcome,
): void {
  if (outcome.applied) {
    return;
  }
  logger.info(
    {
      detail: outcome.detail,
      environmentId: args.environmentId,
      event: args.event.type,
      reason: outcome.reason,
    },
    "Environment lifecycle event not applied",
  );
}

function isDbConnection(db: DbQueryConnection): db is DbConnection {
  return "$client" in db;
}

export function applyLoggedEnvironmentLifecycleEvent(
  deps: ApplyLoggedEnvironmentLifecycleEventDeps,
  args: ApplyEnvironmentLifecycleEventArgs,
): ApplyEnvironmentLifecycleEventOutcome {
  const outcome = isDbConnection(deps.db)
    ? applyEnvironmentLifecycleEvent(deps.db, deps.hub, args)
    : applyEnvironmentLifecycleEventInTransaction(deps.db, args);
  if (!isDbConnection(deps.db) && outcome.applied) {
    deps.hub.notifyEnvironment(args.environmentId, outcome.changes);
  }
  logUnappliedEnvironmentLifecycleEvent(deps.logger, args, outcome);
  return outcome;
}

export function applyLoggedEnvironmentLifecycleEventInTransaction(
  deps: ApplyLoggedEnvironmentLifecycleEventTransactionDeps,
  args: ApplyEnvironmentLifecycleEventArgs,
): ApplyEnvironmentLifecycleEventOutcome {
  const outcome = applyEnvironmentLifecycleEventInTransaction(deps.db, args);
  logUnappliedEnvironmentLifecycleEvent(deps.logger, args, outcome);
  return outcome;
}
