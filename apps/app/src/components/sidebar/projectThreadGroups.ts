import type { ThreadListEntry } from "@bb/domain";
import { isBusyThread } from "@/lib/thread-activity";

export interface ManagerThreadStats {
  managedChildCount: number;
  managedChildBusyCount: number;
}

export interface ManagerThreadGroup {
  managerThread: ThreadListEntry;
  managedThreads: ThreadListEntry[];
  stats: ManagerThreadStats;
}

export interface ProjectThreadGroups {
  managerThreadGroups: ManagerThreadGroup[];
  unmanagedStandardThreads: ThreadListEntry[];
}

interface KnownManagerParentArgs {
  managerThreadIds: ReadonlySet<string>;
  thread: ThreadListEntry;
}

function compareByCreatedAtDescending(
  left: ThreadListEntry,
  right: ThreadListEntry,
): number {
  const createdAtDelta = right.createdAt - left.createdAt;
  if (createdAtDelta !== 0) {
    return createdAtDelta;
  }

  return left.id.localeCompare(right.id);
}

function compareByUpdatedAtDescending(
  left: ThreadListEntry,
  right: ThreadListEntry,
): number {
  const updatedAtDelta = right.updatedAt - left.updatedAt;
  if (updatedAtDelta !== 0) {
    return updatedAtDelta;
  }

  return compareByCreatedAtDescending(left, right);
}

function compareStandardThreads(
  left: ThreadListEntry,
  right: ThreadListEntry,
): number {
  // Use durable thread.status for the active bucket, not ephemeral runtime
  // display state. Active rows stream frequent updates, so pin their position
  // to createdAt; inactive rows use updatedAt recency.
  const leftIsActive = left.status === "active";
  const rightIsActive = right.status === "active";

  if (leftIsActive !== rightIsActive) {
    return leftIsActive ? -1 : 1;
  }

  if (leftIsActive) {
    return compareByCreatedAtDescending(left, right);
  }

  return compareByUpdatedAtDescending(left, right);
}

function getKnownManagerParentId({
  managerThreadIds,
  thread,
}: KnownManagerParentArgs): string | null {
  if (thread.type !== "standard") return null;
  if (thread.parentThreadId === null) return null;
  if (!managerThreadIds.has(thread.parentThreadId)) return null;

  return thread.parentThreadId;
}

export function buildProjectThreadGroups(
  projectThreads: ThreadListEntry[],
): ProjectThreadGroups {
  const managerThreads = projectThreads
    .filter((thread) => thread.type === "manager")
    .sort(compareByCreatedAtDescending);
  const managerThreadIds = new Set(managerThreads.map((thread) => thread.id));
  const managerThreadGroupsById = new Map<string, ManagerThreadGroup>();
  const unmanagedStandardThreads: ThreadListEntry[] = [];

  for (const managerThread of managerThreads) {
    managerThreadGroupsById.set(managerThread.id, {
      managerThread,
      managedThreads: [],
      stats: {
        managedChildBusyCount: 0,
        managedChildCount: 0,
      },
    });
  }

  for (const thread of projectThreads) {
    if (thread.type !== "standard") continue;

    const managerId = getKnownManagerParentId({ managerThreadIds, thread });
    if (managerId === null) {
      unmanagedStandardThreads.push(thread);
      continue;
    }

    const managerThreadGroup = managerThreadGroupsById.get(managerId);
    if (!managerThreadGroup) continue;

    managerThreadGroup.managedThreads.push(thread);
    managerThreadGroup.stats.managedChildCount += 1;
    if (isBusyThread(thread)) {
      managerThreadGroup.stats.managedChildBusyCount += 1;
    }
  }

  const managerThreadGroups = Array.from(managerThreadGroupsById.values());
  for (const managerThreadGroup of managerThreadGroups) {
    managerThreadGroup.managedThreads.sort(compareStandardThreads);
  }
  unmanagedStandardThreads.sort(compareStandardThreads);

  return {
    managerThreadGroups,
    unmanagedStandardThreads,
  };
}
