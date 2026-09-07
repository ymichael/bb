import { TASK_STATUSES, type TaskStatus } from "../../shared/contract.js";

export const BOARD_STATUSES = [
  "backlog",
  "todo",
  "in_progress",
  "in_review",
  "done",
] as const satisfies readonly TaskStatus[];

export function visibleBoardStatuses(
  columns: Readonly<Record<TaskStatus, readonly unknown[]>>,
): TaskStatus[] {
  return [
    ...BOARD_STATUSES,
    ...(columns.canceled.length > 0 ? (["canceled"] as const) : []),
  ];
}

interface BoardDropNeighbors {
  beforeTaskId: string | null;
  afterTaskId: string | null;
}

export function dropNeighborsForIndex(
  columnTaskIds: readonly string[],
  draggedTaskId: string,
  dropIndex: number,
): BoardDropNeighbors {
  const ids = columnTaskIds.filter((id) => id !== draggedTaskId);
  const index = Math.max(0, Math.min(dropIndex, ids.length));
  return {
    beforeTaskId: ids[index - 1] ?? null,
    afterTaskId: ids[index] ?? null,
  };
}

export function dropIndexForPointer(
  cardCenterYs: readonly number[],
  pointerY: number,
): number {
  let index = 0;
  for (const centerY of cardCenterYs) {
    if (pointerY > centerY) index += 1;
  }
  return index;
}

export function applyBoardMove<T extends { id: string; status: TaskStatus }>(
  columns: Readonly<Record<TaskStatus, readonly T[]>>,
  taskId: string,
  toStatus: TaskStatus,
  dropIndex: number,
): Record<TaskStatus, T[]> {
  let moved: T | undefined;
  const next: Record<TaskStatus, T[]> = {
    backlog: [],
    todo: [],
    in_progress: [],
    in_review: [],
    done: [],
    canceled: [],
  };
  for (const status of TASK_STATUSES) {
    next[status] = columns[status].filter((task) => {
      if (task.id !== taskId) return true;
      moved = task;
      return false;
    });
  }
  if (!moved) return next;
  const destination = next[toStatus];
  const index = Math.max(0, Math.min(dropIndex, destination.length));
  destination.splice(index, 0, { ...moved, status: toStatus });
  return next;
}
