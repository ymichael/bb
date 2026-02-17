import {
  sqliteTable,
  text,
  integer,
  index,
  primaryKey,
} from "drizzle-orm/sqlite-core";
import type { ThreadEventType } from "@beanbag/core";

export const projects = sqliteTable("projects", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  rootPath: text("root_path").notNull(),
  createdAt: integer("created_at").notNull(),
  updatedAt: integer("updated_at").notNull(),
});

export const threads = sqliteTable(
  "threads",
  {
    id: text("id").primaryKey(),
    projectId: text("project_id")
      .notNull()
      .references(() => projects.id),
    title: text("title"),
    status: text("status").notNull().default("created"),
    archivedAt: integer("archived_at"),
    createdAt: integer("created_at").notNull(),
    updatedAt: integer("updated_at").notNull(),
  },
  (table) => [
    index("threads_project_updated_idx").on(table.projectId, table.updatedAt),
  ]
);

export const events = sqliteTable(
  "events",
  {
    id: text("id").primaryKey(),
    threadId: text("thread_id")
      .notNull()
      .references(() => threads.id),
    seq: integer("seq").notNull(),
    type: text("type").$type<ThreadEventType>().notNull(),
    normType: text("norm_type").notNull().default(""),
    turnId: text("turn_id"),
    providerThreadId: text("provider_thread_id"),
    isTurnLifecycle: integer("is_turn_lifecycle", { mode: "boolean" })
      .notNull()
      .default(false),
    isThreadIdentity: integer("is_thread_identity", { mode: "boolean" })
      .notNull()
      .default(false),
    data: text("data").notNull().default("{}"),
    createdAt: integer("created_at").notNull(),
  },
  (table) => [index("events_thread_seq_idx").on(table.threadId, table.seq)]
);

export const tasks = sqliteTable(
  "tasks",
  {
    id: text("id").primaryKey(),
    projectId: text("project_id")
      .notNull()
      .references(() => projects.id),
    title: text("title").notNull(),
    description: text("description"),
    status: text("status").notNull().default("open"),
    closeReason: text("close_reason"),
    assignee: text("assignee"),
    archivedAt: integer("archived_at"),
    closedAt: integer("closed_at"),
    resultSummary: text("result_summary"),
    createdAt: integer("created_at").notNull(),
    updatedAt: integer("updated_at").notNull(),
  },
  (table) => [
    index("tasks_project_updated_idx").on(table.projectId, table.updatedAt),
    index("tasks_project_status_idx").on(table.projectId, table.status),
    index("tasks_assignee_idx").on(table.assignee),
  ],
);

export const taskDependencies = sqliteTable(
  "task_dependencies",
  {
    taskId: text("task_id")
      .notNull()
      .references(() => tasks.id),
    dependsOnTaskId: text("depends_on_task_id")
      .notNull()
      .references(() => tasks.id),
    type: text("type").notNull(),
    createdAt: integer("created_at").notNull(),
  },
  (table) => [
    primaryKey({
      columns: [table.taskId, table.dependsOnTaskId, table.type],
    }),
    index("task_deps_task_type_idx").on(table.taskId, table.type),
    index("task_deps_depends_on_type_idx").on(table.dependsOnTaskId, table.type),
  ],
);

export const taskEvents = sqliteTable(
  "task_events",
  {
    id: text("id").primaryKey(),
    taskId: text("task_id")
      .notNull()
      .references(() => tasks.id),
    seq: integer("seq").notNull(),
    type: text("type").notNull(),
    data: text("data").notNull().default("{}"),
    createdAt: integer("created_at").notNull(),
  },
  (table) => [
    index("task_events_task_seq_idx").on(table.taskId, table.seq),
  ],
);
