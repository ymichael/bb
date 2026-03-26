import { and, count, eq, isNull } from "drizzle-orm";
import {
  getEnvironment,
  getActiveSession,
  queueCommand,
  updateEnvironment,
} from "@bb/db";
import { threads } from "@bb/db";
import type { AppDeps } from "../types.js";

export async function maybeCleanupEnvironment(
  deps: Pick<AppDeps, "db" | "hub">,
  environmentId: string | null | undefined,
): Promise<void> {
  if (!environmentId) {
    return;
  }

  const environment = getEnvironment(deps.db, environmentId);
  if (!environment || !environment.managed || environment.status === "destroying") {
    return;
  }

  const liveThreadCount = deps.db
    .select({ count: count() })
    .from(threads)
    .where(
      and(eq(threads.environmentId, environmentId), isNull(threads.archivedAt)),
    )
    .get();

  if ((liveThreadCount?.count ?? 0) > 0) {
    return;
  }

  updateEnvironment(deps.db, deps.hub, environmentId, {
    status: "destroying",
  });

  const session = getActiveSession(deps.db, environment.hostId);
  queueCommand(deps.db, deps.hub, {
    hostId: environment.hostId,
    sessionId: session?.id ?? null,
    type: "environment.destroy",
    payload: JSON.stringify({
      type: "environment.destroy",
      environmentId: environment.id,
      path: environment.path ?? "",
      workspaceProvisionType: environment.workspaceProvisionType ?? "unmanaged",
    }),
  });
}
