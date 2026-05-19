import type {
  EnvironmentWorkspaceDisplayKind,
  ThreadListEntry,
} from "@bb/domain";
import { isBusyThread } from "@/lib/thread-activity";

export interface ManagerThreadStats {
  managedChildCount: number;
  managedChildBusyCount: number;
}

export interface EnvironmentThreadGroup {
  environmentId: string;
  threads: ThreadListEntry[];
}

// A single render slot in a project's or manager's thread list. Threads,
// env groups, and nested manager groups interleave by recency, so the
// renderer iterates one ordered list rather than three parallel arrays.
export type ProjectThreadItem =
  | { kind: "thread"; thread: ThreadListEntry }
  | { kind: "environment"; group: EnvironmentThreadGroup }
  | { kind: "manager"; group: ManagerThreadGroup };

export interface ManagerThreadGroup {
  managerThread: ThreadListEntry;
  managedItems: ProjectThreadItem[];
  stats: ManagerThreadStats;
}

export interface ProjectThreadGroups {
  managerThreadGroups: ManagerThreadGroup[];
  unmanagedItems: ProjectThreadItem[];
}

type WorktreeDisplayKind = "managed-worktree" | "unmanaged-worktree";

function isWorktreeDisplayKind(
  kind: EnvironmentWorkspaceDisplayKind,
): kind is WorktreeDisplayKind {
  return kind === "managed-worktree" || kind === "unmanaged-worktree";
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

function compareByLatestAttentionAtDescending(
  left: ThreadListEntry,
  right: ThreadListEntry,
): number {
  const latestAttentionAtDelta =
    right.latestAttentionAt - left.latestAttentionAt;
  if (latestAttentionAtDelta !== 0) {
    return latestAttentionAtDelta;
  }

  return compareByCreatedAtDescending(left, right);
}

function compareStandardThreads(
  left: ThreadListEntry,
  right: ThreadListEntry,
): number {
  // Use durable thread.status for the active bucket, not ephemeral runtime
  // display state. Active rows stream frequent updates, so pin their position
  // to createdAt; inactive rows use attention recency so read/archive metadata
  // updates do not reshuffle the sidebar.
  const leftIsActive = left.status === "active";
  const rightIsActive = right.status === "active";

  if (leftIsActive !== rightIsActive) {
    return leftIsActive ? -1 : 1;
  }

  if (leftIsActive) {
    return compareByCreatedAtDescending(left, right);
  }

  return compareByLatestAttentionAtDescending(left, right);
}

function representativeThread(item: ProjectThreadItem): ThreadListEntry {
  switch (item.kind) {
    case "thread":
      return item.thread;
    case "environment":
      return item.group.threads[0];
    case "manager":
      return item.group.managerThread;
  }
}

function compareProjectThreadItems(
  left: ProjectThreadItem,
  right: ProjectThreadItem,
): number {
  return compareStandardThreads(
    representativeThread(left),
    representativeThread(right),
  );
}

function buildSortedStandardItems(
  threads: ThreadListEntry[],
): ProjectThreadItem[] {
  const { environmentThreadGroups, looseThreads } =
    bucketWorktreeEnvironmentGroups(threads);
  const items: ProjectThreadItem[] = [
    ...looseThreads.map((thread) => ({ kind: "thread" as const, thread })),
    ...environmentThreadGroups.map((group) => ({
      kind: "environment" as const,
      group,
    })),
  ];
  items.sort(compareProjectThreadItems);
  return items;
}

interface BuildManagerGroupArgs {
  managerThread: ThreadListEntry;
  childrenByParentId: ReadonlyMap<string, ThreadListEntry[]>;
  visited: Set<string>;
}

function buildManagerGroup({
  managerThread,
  childrenByParentId,
  visited,
}: BuildManagerGroupArgs): ManagerThreadGroup {
  // Defensive cycle guard. The server enforces parent must be a live manager
  // in the same project, but does not prevent a manager from being its own
  // ancestor. If we revisit, drop the cycle edge rather than recurse.
  if (visited.has(managerThread.id)) {
    return {
      managerThread,
      managedItems: [],
      stats: { managedChildBusyCount: 0, managedChildCount: 0 },
    };
  }
  visited.add(managerThread.id);

  const directChildren = childrenByParentId.get(managerThread.id) ?? [];
  const standardChildren: ThreadListEntry[] = [];
  const managerChildren: ThreadListEntry[] = [];
  for (const child of directChildren) {
    if (child.type === "manager") {
      managerChildren.push(child);
    } else {
      standardChildren.push(child);
    }
  }

  const standardItems = buildSortedStandardItems(standardChildren);
  const nestedManagerItems: ProjectThreadItem[] = managerChildren
    .slice()
    .sort(compareByCreatedAtDescending)
    .map((child) => ({
      kind: "manager" as const,
      group: buildManagerGroup({
        managerThread: child,
        childrenByParentId,
        visited,
      }),
    }));
  const managedItems: ProjectThreadItem[] = [
    ...standardItems,
    ...nestedManagerItems,
  ];
  managedItems.sort(compareProjectThreadItems);

  let managedChildBusyCount = 0;
  for (const child of directChildren) {
    if (isBusyThread(child)) {
      managedChildBusyCount += 1;
    }
  }

  return {
    managerThread,
    managedItems,
    stats: {
      managedChildBusyCount,
      managedChildCount: directChildren.length,
    },
  };
}

export function buildProjectThreadGroups(
  projectThreads: ThreadListEntry[],
): ProjectThreadGroups {
  const managerThreads = projectThreads.filter(
    (thread) => thread.type === "manager",
  );
  const managerThreadIds = new Set(managerThreads.map((thread) => thread.id));

  const childrenByParentId = new Map<string, ThreadListEntry[]>();
  const unmanagedStandardThreads: ThreadListEntry[] = [];

  for (const thread of projectThreads) {
    const parentId = thread.parentThreadId;
    // A child sits under a manager only when its parent is a live manager in
    // this project. Children of unknown parents (cross-project, deleted) fall
    // through to the project-root unmanaged bucket so they remain reachable.
    if (parentId !== null && managerThreadIds.has(parentId)) {
      let bucket = childrenByParentId.get(parentId);
      if (!bucket) {
        bucket = [];
        childrenByParentId.set(parentId, bucket);
      }
      bucket.push(thread);
      continue;
    }
    if (thread.type === "standard") {
      unmanagedStandardThreads.push(thread);
    }
    // Manager threads without an in-project manager parent become root
    // managers in the next pass; standard threads without one are unmanaged.
  }

  const rootManagerThreads = managerThreads
    .filter((manager) => {
      const parentId = manager.parentThreadId;
      return parentId === null || !managerThreadIds.has(parentId);
    })
    .sort(compareByCreatedAtDescending);

  const visited = new Set<string>();
  const managerThreadGroups: ManagerThreadGroup[] = [];
  for (const managerThread of rootManagerThreads) {
    managerThreadGroups.push(
      buildManagerGroup({ managerThread, childrenByParentId, visited }),
    );
  }
  // Any manager not reached from an explicit root is part of a cycle with no
  // entry point. Promote each unvisited manager to a root so it still
  // surfaces in the tree — buildManagerGroup's visited guard breaks the
  // cycle when it would recurse back into a placed manager.
  const orphanedCycleManagers = managerThreads
    .filter((manager) => !visited.has(manager.id))
    .sort(compareByCreatedAtDescending);
  for (const managerThread of orphanedCycleManagers) {
    if (visited.has(managerThread.id)) continue;
    managerThreadGroups.push(
      buildManagerGroup({ managerThread, childrenByParentId, visited }),
    );
  }

  return {
    managerThreadGroups,
    unmanagedItems: buildSortedStandardItems(unmanagedStandardThreads),
  };
}

interface BucketWorktreeEnvironmentGroupsResult {
  environmentThreadGroups: EnvironmentThreadGroup[];
  looseThreads: ThreadListEntry[];
}

// Bucket threads by shared worktree environmentId. A bucket only becomes a
// group when ≥2 threads share the environment; solo threads stay loose so
// we don't render degenerate 1-thread groups. Callers pass standard threads
// that are siblings in the same render context (project-level or under a
// single manager).
function bucketWorktreeEnvironmentGroups(
  threads: ThreadListEntry[],
): BucketWorktreeEnvironmentGroupsResult {
  const threadsByEnvironmentId = new Map<string, ThreadListEntry[]>();
  for (const thread of threads) {
    if (thread.environmentId === null) continue;
    if (!isWorktreeDisplayKind(thread.environmentWorkspaceDisplayKind)) continue;
    let bucket = threadsByEnvironmentId.get(thread.environmentId);
    if (!bucket) {
      bucket = [];
      threadsByEnvironmentId.set(thread.environmentId, bucket);
    }
    bucket.push(thread);
  }

  const groupedEnvironmentIds = new Set<string>();
  const environmentThreadGroups: EnvironmentThreadGroup[] = [];
  for (const [environmentId, bucket] of threadsByEnvironmentId) {
    if (bucket.length < 2) continue;
    bucket.sort(compareStandardThreads);
    groupedEnvironmentIds.add(environmentId);
    environmentThreadGroups.push({ environmentId, threads: bucket });
  }

  const looseThreads = threads.filter(
    (thread) =>
      thread.environmentId === null ||
      !groupedEnvironmentIds.has(thread.environmentId),
  );
  looseThreads.sort(compareStandardThreads);

  return { environmentThreadGroups, looseThreads };
}
