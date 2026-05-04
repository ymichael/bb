import type { ThreadListEntry, ThreadType } from "@bb/domain";

export interface ManagerSelectorOption {
  label: string;
  value: string;
}

interface ThreadAssignmentState {
  parentThreadId: string | null;
  type: ThreadType;
}

export interface BuildManagerSelectorOptionsArgs {
  currentThreadId: string | undefined;
  isManagerThread: boolean;
  managerThreads: readonly ThreadListEntry[];
  parentThreadDisplayName: string | null | undefined;
  parentThreadId: string | null | undefined;
}

export function isUnassignedStandardThread(
  thread: ThreadAssignmentState | undefined,
): boolean {
  return thread?.type === "standard" && thread.parentThreadId === null;
}

export function buildManagerSelectorOptions({
  currentThreadId,
  isManagerThread,
  managerThreads,
  parentThreadDisplayName,
  parentThreadId,
}: BuildManagerSelectorOptionsArgs): ManagerSelectorOption[] {
  if (!currentThreadId || isManagerThread) {
    return [];
  }

  const options: ManagerSelectorOption[] = [{ value: "none", label: "None" }];
  const seen = new Set<string>(["none"]);
  const addOption = (value: string | undefined, label: string) => {
    if (!value || value === currentThreadId || seen.has(value)) {
      return;
    }
    seen.add(value);
    options.push({ value, label });
  };

  addOption(parentThreadId ?? undefined, parentThreadDisplayName ?? "Manager");
  for (const manager of managerThreads) {
    addOption(manager.id, manager.title?.trim() ? manager.title : "Manager");
  }

  return options;
}
