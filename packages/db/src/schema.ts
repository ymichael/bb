import {
  sqliteTable,
  text,
  integer,
  index,
  uniqueIndex,
} from "drizzle-orm/sqlite-core";
import type { ThreadEventType } from "@beanbag/agent-core";

export const projects = sqliteTable("projects", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  rootPath: text("root_path").notNull(),
  projectInstructions: text("project_instructions"),
  primaryCheckoutThreadId: text("primary_checkout_thread_id"),
  createdAt: integer("created_at").notNull(),
  updatedAt: integer("updated_at").notNull(),
}, (table) => [
  index("projects_primary_checkout_thread_idx").on(table.primaryCheckoutThreadId),
]);

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
    mergeBaseBranch: text("merge_base_branch"),
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
    index("threads_archived_status_idx").on(table.archivedAt, table.status),
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
    serviceTier: text("service_tier"),
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

export const environmentAgentSessions = sqliteTable(
  "environment_agent_sessions",
  {
    id: text("id").primaryKey(),
    threadId: text("thread_id")
      .notNull()
      .references(() => threads.id, { onDelete: "cascade" }),
    agentId: text("agent_id").notNull(),
    agentInstanceId: text("agent_instance_id").notNull(),
    protocolVersion: integer("protocol_version").notNull(),
    controlBaseUrl: text("control_base_url"),
    controlAuthToken: text("control_auth_token"),
    status: text("status").notNull(),
    leaseExpiresAt: integer("lease_expires_at").notNull(),
    lastHeartbeatAt: integer("last_heartbeat_at"),
    closedAt: integer("closed_at"),
    closeReason: text("close_reason"),
    createdAt: integer("created_at").notNull(),
    updatedAt: integer("updated_at").notNull(),
  },
  (table) => [
    index("environment_agent_sessions_thread_status_idx").on(
      table.threadId,
      table.status,
    ),
    index("environment_agent_sessions_agent_status_idx").on(
      table.agentId,
      table.status,
    ),
    index("environment_agent_sessions_lease_expires_idx").on(
      table.leaseExpiresAt,
    ),
  ],
);

export const environmentAgentCursors = sqliteTable(
  "environment_agent_cursors",
  {
    threadId: text("thread_id")
      .primaryKey()
      .references(() => threads.id, { onDelete: "cascade" }),
    generation: integer("generation").notNull(),
    sequence: integer("sequence").notNull(),
    updatedAt: integer("updated_at").notNull(),
  },
);

export const environmentAgentCommands = sqliteTable(
  "environment_agent_commands",
  {
    id: text("id").primaryKey(),
    threadId: text("thread_id")
      .notNull()
      .references(() => threads.id, { onDelete: "cascade" }),
    sessionId: text("session_id").references(() => environmentAgentSessions.id, {
      onDelete: "set null",
    }),
    commandCursor: integer("command_cursor").notNull(),
    commandType: text("command_type").notNull(),
    payload: text("payload").notNull(),
    state: text("state").notNull(),
    result: text("result"),
    errorCode: text("error_code"),
    errorMessage: text("error_message"),
    createdAt: integer("created_at").notNull(),
    updatedAt: integer("updated_at").notNull(),
  },
  (table) => [
    uniqueIndex("environment_agent_commands_thread_cursor_idx").on(
      table.threadId,
      table.commandCursor,
    ),
    index("environment_agent_commands_thread_state_updated_idx").on(
      table.threadId,
      table.state,
      table.updatedAt,
    ),
    index("environment_agent_commands_session_state_idx").on(
      table.sessionId,
      table.state,
    ),
  ],
);
