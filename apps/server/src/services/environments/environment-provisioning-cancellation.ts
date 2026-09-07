import { and, eq, inArray, isNull, ne } from "drizzle-orm";
import {
  getEnvironment,
  threads,
  type DbQueryConnection,
  type DbTransaction,
} from "@bb/db";

interface EnvironmentProvisionCancellationReadDeps {
  db: DbQueryConnection;
}

interface EnvironmentProvisionCancellationTransactionDeps extends EnvironmentProvisionCancellationReadDeps {
  db: DbTransaction;
}

interface CancelEnvironmentProvisioningForThreadStopArgs {
  environmentId: string;
  threadId: string;
}

type EnvironmentProvisioningCancellationForThreadStopResult =
  | "awaiting_host_cancel"
  | "ready_to_finalize";

function hasOtherLiveThreadDependingOnEnvironmentProvision(
  deps: EnvironmentProvisionCancellationReadDeps,
  args: CancelEnvironmentProvisioningForThreadStopArgs,
): boolean {
  const row = deps.db
    .select({ id: threads.id })
    .from(threads)
    .where(
      and(
        eq(threads.environmentId, args.environmentId),
        ne(threads.id, args.threadId),
        inArray(threads.status, ["starting", "active"]),
        isNull(threads.archivedAt),
        isNull(threads.deletedAt),
      ),
    )
    .limit(1)
    .get();
  return row !== undefined;
}

export function cancelEnvironmentProvisioningForThreadStopInTransaction(
  deps: EnvironmentProvisionCancellationTransactionDeps,
  args: CancelEnvironmentProvisioningForThreadStopArgs,
): EnvironmentProvisioningCancellationForThreadStopResult {
  if (hasOtherLiveThreadDependingOnEnvironmentProvision(deps, args)) {
    return "ready_to_finalize";
  }

  const environment = getEnvironment(deps.db, args.environmentId);
  if (!environment) {
    return "ready_to_finalize";
  }

  if (environment.status === "provisioning") {
    return "awaiting_host_cancel";
  }

  return "ready_to_finalize";
}
