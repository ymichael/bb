import { and, eq, inArray, notInArray } from "drizzle-orm";
import { environments, threads } from "@bb/db";
import type { HostDaemonActiveThread } from "@bb/host-daemon-contract";
import type { AppDeps } from "../types.js";
import { tryTransition } from "../services/thread-transitions.js";

export function reconcileSessionThreads(
  deps: Pick<AppDeps, "db" | "hub">,
  hostId: string,
  activeThreads: HostDaemonActiveThread[],
): void {
  const activeThreadIds = activeThreads.map((thread) => thread.threadId);

  if (activeThreadIds.length > 0) {
    const erroredThreads = deps.db
      .select({ id: threads.id })
      .from(threads)
      .innerJoin(environments, eq(threads.environmentId, environments.id))
      .where(
        and(
          eq(environments.hostId, hostId),
          eq(threads.status, "error"),
          inArray(threads.id, activeThreadIds),
        ),
      )
      .all();

    for (const thread of erroredThreads) {
      tryTransition(deps.db, deps.hub, thread.id, "active");
    }
  }

  const activeButMissing = deps.db
    .select({ id: threads.id })
    .from(threads)
    .innerJoin(environments, eq(threads.environmentId, environments.id))
    .where(
      and(
        eq(environments.hostId, hostId),
        eq(threads.status, "active"),
        activeThreadIds.length > 0
          ? notInArray(threads.id, activeThreadIds)
          : undefined,
      ),
    )
    .all();

  for (const thread of activeButMissing) {
    tryTransition(deps.db, deps.hub, thread.id, "idle");
  }

  if (activeThreadIds.length > 0) {
    const idleButActive = deps.db
      .select({ id: threads.id })
      .from(threads)
      .innerJoin(environments, eq(threads.environmentId, environments.id))
      .where(
        and(
          eq(environments.hostId, hostId),
          eq(threads.status, "idle"),
          inArray(threads.id, activeThreadIds),
        ),
      )
      .all();

    for (const thread of idleButActive) {
      tryTransition(deps.db, deps.hub, thread.id, "active");
    }
  }
}
