import {
  sqliteTable,
  text,
  integer,
  index,
} from "drizzle-orm/sqlite-core";
import type { ThreadEventType } from "@beanbag/agent-core";

export const projects = sqliteTable("projects", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  rootPath: text("root_path").notNull(),
  workflowInstructions: text("workflow_instructions"),
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
    environmentId: text("environment_id"),
    environmentRecord: text("environment_record"),
    agentDiffSource: text("agent_diff_source"),
    agentChangedFiles: integer("agent_changed_files"),
    agentInsertions: integer("agent_insertions"),
    agentDeletions: integer("agent_deletions"),
    agentDiffCapturedAt: integer("agent_diff_captured_at"),
    parentThreadId: text("parent_thread_id"),
    archivedAt: integer("archived_at"),
    lastReadAt: integer("last_read_at").notNull().default(0),
    createdAt: integer("created_at").notNull(),
    updatedAt: integer("updated_at").notNull(),
  },
  (table) => [
    index("threads_project_updated_idx").on(table.projectId, table.updatedAt),
    index("threads_environment_idx").on(table.environmentId),
    index("threads_parent_thread_idx").on(table.parentThreadId),
  ]
);

export const queuedThreadMessages = sqliteTable(
  "queued_thread_messages",
  {
    seq: integer("seq").primaryKey({ autoIncrement: true }),
    id: text("id").notNull().unique(),
    threadId: text("thread_id")
      .notNull()
      .references(() => threads.id, { onDelete: "cascade" }),
    input: text("input").notNull().default("[]"),
    model: text("model"),
    reasoningLevel: text("reasoning_level").notNull(),
    sandboxMode: text("sandbox_mode").notNull(),
    createdAt: integer("created_at").notNull(),
  },
  (table) => [
    index("queued_thread_messages_thread_seq_idx").on(table.threadId, table.seq),
    index("queued_thread_messages_thread_created_idx").on(
      table.threadId,
      table.createdAt,
    ),
  ],
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
