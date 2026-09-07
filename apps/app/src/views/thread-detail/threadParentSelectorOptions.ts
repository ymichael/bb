import type { ThreadListEntry } from "@bb/domain";

interface ParentSelectorOption {
  label: string;
  value: string;
}

interface ThreadAssignmentState {
  id: string;
  parentThreadId: string | null;
  visibility?: ThreadListEntry["visibility"];
}

interface CollectDescendantThreadIdsArgs {
  currentThreadId: string;
  threads: readonly ThreadListEntry[];
}

interface BuildParentSelectorOptionsArgs {
  currentThreadId: string | undefined;
  parentThreads: readonly ThreadListEntry[];
  parentThreadDisplayName: string | null | undefined;
  parentThreadId: string | null | undefined;
}

export function isRootThread(
  thread: ThreadAssignmentState | undefined,
): boolean {
  return (
    thread !== undefined &&
    thread.parentThreadId === null &&
    !isHiddenThread(thread)
  );
}

function isHiddenThread(
  thread: Pick<ThreadAssignmentState, "visibility">,
): boolean {
  return thread.visibility === "hidden";
}

function collectDescendantThreadIds({
  currentThreadId,
  threads,
}: CollectDescendantThreadIdsArgs): Set<string> {
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

  const descendantThreadIds = new Set<string>();
  const stack = [...(childrenByParentId.get(currentThreadId) ?? [])];
  while (stack.length > 0) {
    const child = stack.pop();
    if (child === undefined || descendantThreadIds.has(child.id)) continue;
    descendantThreadIds.add(child.id);
    stack.push(...(childrenByParentId.get(child.id) ?? []));
  }
  return descendantThreadIds;
}

export function buildParentSelectorOptions({
  currentThreadId,
  parentThreads,
  parentThreadDisplayName,
  parentThreadId,
}: BuildParentSelectorOptionsArgs): ParentSelectorOption[] {
  if (!currentThreadId) {
    return [];
  }

  const descendantThreadIds = collectDescendantThreadIds({
    currentThreadId,
    threads: parentThreads,
  });
  const options: ParentSelectorOption[] = [{ value: "none", label: "None" }];
  const seen = new Set<string>(["none"]);
  const addOption = (value: string | undefined, label: string) => {
    if (
      !value ||
      value === currentThreadId ||
      descendantThreadIds.has(value) ||
      seen.has(value)
    ) {
      return;
    }
    seen.add(value);
    options.push({ value, label });
  };

  addOption(
    parentThreadId ?? undefined,
    parentThreadDisplayName ?? "Parent thread",
  );
  const threadIdsWithChildren = new Set<string>();
  for (const thread of parentThreads) {
    if (thread.parentThreadId !== null) {
      threadIdsWithChildren.add(thread.parentThreadId);
    }
  }
  for (const hasChildren of [true, false]) {
    for (const parentThread of parentThreads) {
      if (
        isHiddenThread(parentThread) ||
        threadIdsWithChildren.has(parentThread.id) !== hasChildren
      ) {
        continue;
      }
      addOption(
        parentThread.id,
        parentThread.title?.trim() ? parentThread.title : "Parent thread",
      );
    }
  }

  return options;
}
