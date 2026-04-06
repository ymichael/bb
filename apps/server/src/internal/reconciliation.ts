import { and, eq, inArray, isNotNull, isNull, notInArray, or } from "drizzle-orm";
import {
  deleteThread,
  environments,
  requestEnvironmentCleanup,
  threads,
} from "@bb/db";
import type { HostDaemonActiveThread } from "@bb/host-daemon-contract";
import type { AppDeps } from "../types.js";
import { advanceEnvironmentCleanup } from "../services/environment-cleanup.js";
import {
  completeThreadStart,
  finalizeStoppedThread,
  requestThreadStop,
} from "../services/thread-stop.js";
import { tryTransition } from "../services/thread-transitions.js";

export async function reconcileSessionThreads(
  deps: Pick<AppDeps, "db" | "hub">,
  hostId: string,
  activeThreads: HostDaemonActiveThread[],
): Promise<void> {
  const activeThreadIds = activeThreads.map((thread) => thread.threadId);

  const pendingThreads = deps.db
    .select({
      deletedAt: threads.deletedAt,
      environmentId: threads.environmentId,
      id: threads.id,
      status: threads.status,
      archivedAt: threads.archivedAt,
      stopRequestedAt: threads.stopRequestedAt,
    })
    .from(threads)
    .innerJoin(environments, eq(threads.environmentId, environments.id))
    .where(
      and(
        eq(environments.hostId, hostId),
        inArray(threads.status, ["active", "created", "idle", "error", "provisioning"]),
        or(isNotNull(threads.deletedAt), isNotNull(threads.stopRequestedAt)),
      ),
    )
    .all();

  for (const thread of pendingThreads) {
    const isActive = activeThreadIds.includes(thread.id);

    if (isActive && thread.environmentId) {
      requestThreadStop(deps, {
        environmentId: thread.environmentId,
        hostId,
        stopRequestedAt: thread.stopRequestedAt,
        threadId: thread.id,
      });
      continue;
    }

    if (thread.stopRequestedAt !== null && !isActive) {
      const finalized = await finalizeStoppedThread(deps, {
        threadId: thread.id,
      });
      if (finalized) {
        continue;
      }
    }

    if (thread.deletedAt !== null && !isActive) {
      const environmentId = thread.environmentId;
      deleteThread(deps.db, deps.hub, thread.id);
      if (environmentId !== null) {
        requestEnvironmentCleanup(deps.db, deps.hub, environmentId, {
          cleanupMode: "force",
        });
      }
      void advanceEnvironmentCleanup(deps, { environmentId });
    }
  }

  if (activeThreadIds.length > 0) {
    const erroredThreads = deps.db
      .select({ id: threads.id })
      .from(threads)
      .innerJoin(environments, eq(threads.environmentId, environments.id))
      .where(
        and(
          eq(environments.hostId, hostId),
          eq(threads.status, "error"),
          isNull(threads.deletedAt),
          isNull(threads.stopRequestedAt),
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
          isNull(threads.deletedAt),
          isNull(threads.stopRequestedAt),
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
    const inactiveButActive = deps.db
      .select({ id: threads.id })
      .from(threads)
      .innerJoin(environments, eq(threads.environmentId, environments.id))
      .where(
        and(
          eq(environments.hostId, hostId),
          inArray(threads.status, ["created", "provisioning", "idle"]),
          isNull(threads.deletedAt),
          isNull(threads.stopRequestedAt),
          inArray(threads.id, activeThreadIds),
        ),
      )
      .all();

    for (const thread of inactiveButActive) {
      tryTransition(deps.db, deps.hub, thread.id, "active");
      completeThreadStart(deps, {
        threadId: thread.id,
      });
    }
  }
}
