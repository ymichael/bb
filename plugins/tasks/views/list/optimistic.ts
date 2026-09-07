import type { Task, TaskPriority, TaskStatus } from "../../shared/contract.js";

export interface TaskEdit {
  status?: TaskStatus;
  priority?: TaskPriority;
  dueDate?: string | null;
  labelIds?: string[];
  position?: number;
}

type EditField = keyof TaskEdit;
const EDIT_FIELDS: readonly EditField[] = [
  "status",
  "priority",
  "dueDate",
  "labelIds",
  "position",
];

interface TaskEntry {
  edit: TaskEdit;
  gens: Partial<Record<EditField, number>>;
  inFlight: number;
}

export type TaskEntries = ReadonlyMap<string, TaskEntry>;

function sameIds(
  a: readonly string[] | null | undefined,
  b: readonly string[] | null | undefined,
): boolean {
  const left = a ?? [];
  const right = b ?? [];
  if (left.length !== right.length) return false;
  const set = new Set(right);
  return left.every((id) => set.has(id));
}

function hasFields(edit: TaskEdit): boolean {
  return EDIT_FIELDS.some((field) => edit[field] !== undefined);
}

function fieldSettled(task: Task, field: EditField, edit: TaskEdit): boolean {
  if (field === "labelIds") return sameIds(edit.labelIds, task.labelIds);
  return task[field] === edit[field];
}

export function applyEdit(task: Task, edit: TaskEdit | undefined): Task {
  if (edit === undefined || !hasFields(edit)) return task;
  return {
    ...task,
    ...(edit.status !== undefined ? { status: edit.status } : {}),
    ...(edit.priority !== undefined ? { priority: edit.priority } : {}),
    ...(edit.dueDate !== undefined ? { dueDate: edit.dueDate } : {}),
    ...(edit.labelIds !== undefined ? { labelIds: edit.labelIds } : {}),
    ...(edit.position !== undefined ? { position: edit.position } : {}),
  };
}

export function editedTasks(
  serverTasks: readonly Task[],
  entries: TaskEntries,
): Task[] {
  if (entries.size === 0) return [...serverTasks];
  return serverTasks.map((task) => applyEdit(task, entries.get(task.id)?.edit));
}

export function matchesFilters(
  task: Task,
  statuses: readonly TaskStatus[],
  priorities: readonly TaskPriority[],
  labelIds: readonly string[],
): boolean {
  return (
    (statuses.length === 0 || statuses.includes(task.status)) &&
    (priorities.length === 0 || priorities.includes(task.priority)) &&
    (labelIds.length === 0 || task.labelIds.some((id) => labelIds.includes(id)))
  );
}

function makeEntry(prev: TaskEntry | undefined): {
  edit: TaskEdit;
  gens: Partial<Record<EditField, number>>;
} {
  return { edit: { ...prev?.edit }, gens: { ...prev?.gens } };
}

export function beginEdit(
  entries: TaskEntries,
  taskId: string,
  patch: TaskEdit,
  gen: number,
): TaskEntries {
  const prev = entries.get(taskId);
  const edit: TaskEdit = { ...prev?.edit, ...patch };
  const gens = { ...prev?.gens };
  for (const field of EDIT_FIELDS) {
    if (patch[field] !== undefined) gens[field] = gen;
  }
  const next = new Map(entries);
  next.set(taskId, { edit, gens, inFlight: (prev?.inFlight ?? 0) + 1 });
  return next;
}

function finalize(
  entries: TaskEntries,
  taskId: string,
  edit: TaskEdit,
  gens: Partial<Record<EditField, number>>,
  inFlight: number,
): TaskEntries {
  const next = new Map(entries);
  if (!hasFields(edit) && inFlight <= 0) next.delete(taskId);
  else next.set(taskId, { edit, gens, inFlight: Math.max(0, inFlight) });
  return next;
}

export function settleSuccess(
  entries: TaskEntries,
  taskId: string,
  patch: TaskEdit,
  gen: number,
  serverTask: Task,
): TaskEntries {
  const prev = entries.get(taskId);
  if (prev === undefined) return entries;
  const { edit, gens } = makeEntry(prev);
  if (patch.status !== undefined && gens.status === gen) {
    edit.position = serverTask.position;
    gens.position = gen;
  }
  return finalize(entries, taskId, edit, gens, prev.inFlight - 1);
}

export function settleFailure(
  entries: TaskEntries,
  taskId: string,
  patch: TaskEdit,
  gen: number,
): TaskEntries {
  const prev = entries.get(taskId);
  if (prev === undefined) return entries;
  const { edit, gens } = makeEntry(prev);
  for (const field of EDIT_FIELDS) {
    if (patch[field] !== undefined && gens[field] === gen) {
      delete edit[field];
      delete gens[field];
    }
  }
  return finalize(entries, taskId, edit, gens, prev.inFlight - 1);
}

function sameEntry(a: TaskEntry, b: TaskEntry): boolean {
  if (a.inFlight !== b.inFlight) return false;
  for (const field of EDIT_FIELDS) {
    if (a.gens[field] !== b.gens[field]) return false;
    if (field === "labelIds") {
      if (!sameIds(a.edit.labelIds, b.edit.labelIds)) return false;
    } else if (a.edit[field] !== b.edit[field]) {
      return false;
    }
  }
  return true;
}

function sameEntries(a: TaskEntries, b: TaskEntries): boolean {
  if (a.size !== b.size) return false;
  for (const [id, entryA] of a) {
    const entryB = b.get(id);
    if (entryB === undefined || !sameEntry(entryA, entryB)) return false;
  }
  return true;
}

export function reconcileEntries(
  entries: TaskEntries,
  tasks: readonly Task[],
): TaskEntries {
  if (entries.size === 0) return entries;
  const byId = new Map(tasks.map((task) => [task.id, task]));
  const next = new Map<string, TaskEntry>();
  for (const [id, entry] of entries) {
    const task = byId.get(id);
    if (task === undefined) continue;
    const edit: TaskEdit = {};
    const gens: Partial<Record<EditField, number>> = {};
    for (const field of EDIT_FIELDS) {
      const value = entry.edit[field];
      if (value === undefined || fieldSettled(task, field, entry.edit))
        continue;
      Object.assign(edit, { [field]: value });
      gens[field] = entry.gens[field];
    }
    if (hasFields(edit) || entry.inFlight > 0) {
      next.set(id, { edit, gens, inFlight: entry.inFlight });
    }
  }
  return sameEntries(entries, next) ? entries : next;
}

export function pendingIds(entries: TaskEntries): ReadonlySet<string> {
  const ids = new Set<string>();
  for (const [id, entry] of entries) {
    if (entry.inFlight > 0) ids.add(id);
  }
  return ids;
}
