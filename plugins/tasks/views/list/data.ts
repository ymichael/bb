import { listAllTasks, useTasksQuery } from "../../shell/data.js";
import type {
  Label,
  Task,
  TaskPriority,
  TaskStatus,
  TaskThread,
} from "../../shared/contract.js";

interface ListTaskFilters {
  statuses: readonly TaskStatus[];
  priorities: readonly TaskPriority[];
  labelIds: readonly string[] | null;
}

export function useListTasks(
  projectId: string | null,
  activeOnly: boolean,
  filters: ListTaskFilters,
) {
  return useTasksQuery(
    async (rpc) =>
      listAllTasks(rpc, {
        ...(projectId === null ? {} : { projectId }),
        ...(filters.statuses.length > 0
          ? { statuses: [...filters.statuses] }
          : {}),
        ...(filters.priorities.length > 0
          ? { priorities: [...filters.priorities] }
          : {}),
        ...(filters.labelIds !== null
          ? { labelIds: [...filters.labelIds] }
          : {}),
        activeOnly,
        parentTaskId: null,
      }),
    ["tasks:changed", "threads:changed"],
    [
      projectId,
      activeOnly,
      filters.statuses.join(),
      filters.priorities.join(),
      filters.labelIds === null ? "" : `active:${filters.labelIds.join()}`,
    ],
  );
}

export function useLabels(projectIds: readonly string[]) {
  return useTasksQuery<Label[]>(
    async (rpc) => {
      const results = await Promise.all(
        projectIds.map((projectId) => rpc.call("listLabels", { projectId })),
      );
      return results.flatMap((result) => result.labels);
    },
    ["projects:changed"],
    [projectIds.join()],
  );
}

export interface TaskRowMeta {
  activeThreads: TaskThread[];
}

export function useTaskListMeta(tasks: readonly Task[] | undefined) {
  const taskIds = (tasks ?? []).map((task) => task.id);
  return useTasksQuery<Map<string, TaskRowMeta>>(
    async (rpc) => {
      const entries = await Promise.all(
        taskIds.map(async (taskId) => {
          const threads = await rpc.call("listTaskThreads", { taskId });
          const meta: TaskRowMeta = {
            activeThreads: threads.taskThreads.filter(
              (thread) =>
                thread.liveStatus === "starting" ||
                thread.liveStatus === "working",
            ),
          };
          return [taskId, meta] as const;
        }),
      );
      return new Map(entries);
    },
    ["threads:changed", "tasks:changed"],
    [taskIds.join()],
  );
}
