import type { ThreadListEntry } from "@bb/domain";
import { compareCodepoint } from "../codepoint-compare.js";
import {
  buildProjectThreadGroups,
  compareStandardThreads,
  type ProjectThreadItem,
  type ProjectThreadNode,
} from "./projectThreadGroups.js";

interface PinnedSidebarState {
  effectivePinnedThreadIds: Set<string>;
  rootNodes: ProjectThreadNode[];
}

interface BuildPinnedSidebarStateArgs {
  draftThreadIds?: ReadonlySet<string>;
  threads: readonly ThreadListEntry[];
}

function compareByPinnedFallback(
  left: ThreadListEntry,
  right: ThreadListEntry,
): number {
  const pinnedAtDelta = (right.pinnedAt ?? 0) - (left.pinnedAt ?? 0);
  if (pinnedAtDelta !== 0) {
    return pinnedAtDelta;
  }

  const createdAtDelta = right.createdAt - left.createdAt;
  if (createdAtDelta !== 0) {
    return createdAtDelta;
  }

  return compareCodepoint(left.id, right.id);
}

function comparePinnedRoots(
  left: ThreadListEntry,
  right: ThreadListEntry,
): number {
  if (left.pinSortKey !== null && right.pinSortKey !== null) {
    const pinSortKeyDelta = compareCodepoint(left.pinSortKey, right.pinSortKey);
    if (pinSortKeyDelta !== 0) {
      return pinSortKeyDelta;
    }
  }

  return compareByPinnedFallback(left, right);
}

function addDescendantThreadIds({
  childrenByParentId,
  effectivePinnedThreadIds,
  parentThreadId,
  visitedThreadIds,
}: AddDescendantThreadIdsArgs): void {
  if (visitedThreadIds.has(parentThreadId)) return;

  visitedThreadIds.add(parentThreadId);
  for (const child of childrenByParentId.get(parentThreadId) ?? []) {
    effectivePinnedThreadIds.add(child.id);
    addDescendantThreadIds({
      childrenByParentId,
      effectivePinnedThreadIds,
      parentThreadId: child.id,
      visitedThreadIds,
    });
  }
}

interface AddDescendantThreadIdsArgs {
  childrenByParentId: ReadonlyMap<string, readonly ThreadListEntry[]>;
  effectivePinnedThreadIds: Set<string>;
  parentThreadId: string;
  visitedThreadIds: Set<string>;
}

function collectRootNodes(
  items: readonly ProjectThreadItem[],
): ProjectThreadNode[] {
  return items.flatMap((item) => {
    switch (item.kind) {
      case "thread":
        return [item.node];
      case "environment":
        return item.group.nodes;
      case "section":
        return collectRootNodes(item.group.items);
    }
  });
}

export function buildPinnedSidebarState({
  draftThreadIds = new Set(),
  threads,
}: BuildPinnedSidebarStateArgs): PinnedSidebarState {
  const explicitlyPinnedThreads = threads.filter(
    (thread) => thread.pinnedAt !== null,
  );
  const childrenByParentId = new Map<string, ThreadListEntry[]>();

  for (const thread of threads) {
    if (thread.parentThreadId === null) continue;

    const children = childrenByParentId.get(thread.parentThreadId);
    if (children) {
      children.push(thread);
    } else {
      childrenByParentId.set(thread.parentThreadId, [thread]);
    }
  }

  const effectivePinnedThreadIds = new Set(
    explicitlyPinnedThreads.map((thread) => thread.id),
  );
  for (const thread of explicitlyPinnedThreads) {
    addDescendantThreadIds({
      childrenByParentId,
      effectivePinnedThreadIds,
      parentThreadId: thread.id,
      visitedThreadIds: new Set(),
    });
  }

  const effectivePinnedThreads = threads.filter((thread) =>
    effectivePinnedThreadIds.has(thread.id),
  );
  const projectItems = buildProjectThreadGroups(
    effectivePinnedThreads,
    compareStandardThreads,
    draftThreadIds,
  );
  const rootNodes = collectRootNodes(projectItems);
  rootNodes.sort((left, right) =>
    comparePinnedRoots(left.thread, right.thread),
  );

  return {
    effectivePinnedThreadIds,
    rootNodes,
  };
}
