export const TASK_SORTS = ["manual", "priority", "due"] as const;
export type TaskSort = (typeof TASK_SORTS)[number];

export const TASKS_PAGE_DEFAULT_LIMIT = 100;

export const TASKS_PAGE_MAX_LIMIT = 500;
