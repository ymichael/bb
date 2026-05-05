import type { ThreadListEntry } from "@bb/domain";
import { isBusyThread } from "@/lib/thread-activity";

export interface ProjectThreadGroups {
  managerThreads: ThreadListEntry[];
  managedChildBusyCountsByManagerId: Map<string, number>;
  managedThreadsByManagerId: Map<string, ThreadListEntry[]>;
  otherThreads: ThreadListEntry[];
}

interface KnownManagerParentArgs {
  managerThreadIds: ReadonlySet<string>;
  thread: ThreadListEntry;
}

function sortNewestFirst(threads: ThreadListEntry[]): void {
  threads.sort((a, b) => b.createdAt - a.createdAt);
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
  const managerThreads = projectThreads.filter(
    (thread) => thread.type === "manager",
  );
  sortNewestFirst(managerThreads);

  const managerThreadIds = new Set(managerThreads.map((thread) => thread.id));
  const managedThreadsByManagerId = new Map<string, ThreadListEntry[]>();
  const managedChildBusyCountsByManagerId = new Map<string, number>();
  const otherThreads: ThreadListEntry[] = [];

  for (const thread of projectThreads) {
    const managerId = getKnownManagerParentId({ managerThreadIds, thread });
    if (managerId === null) {
      if (thread.type !== "manager") {
        otherThreads.push(thread);
      }
      continue;
    }

    const existing = managedThreadsByManagerId.get(managerId);
    if (existing) {
      existing.push(thread);
    } else {
      managedThreadsByManagerId.set(managerId, [thread]);
    }

    if (isBusyThread(thread)) {
      managedChildBusyCountsByManagerId.set(
        managerId,
        (managedChildBusyCountsByManagerId.get(managerId) ?? 0) + 1,
      );
    }
  }

  for (const managedThreads of managedThreadsByManagerId.values()) {
    sortNewestFirst(managedThreads);
  }
  sortNewestFirst(otherThreads);

  return {
    managerThreads,
    managedChildBusyCountsByManagerId,
    managedThreadsByManagerId,
    otherThreads,
  };
}
