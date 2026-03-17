/**
 * Database schema — single source of truth for all table definitions.
 *
 * To make a schema change:
 *   1. Edit this file
 *   2. Run `pnpm --filter @bb/db db:generate` — Drizzle Kit generates a new migration SQL file
 *   3. Review the generated SQL (Drizzle Kit sometimes generates suboptimal SQLite
 *      migrations like unnecessary table rebuilds — edit if needed)
 *   4. Run tests to validate
 *   5. Commit both the schema change and the migration file
 *
 * Rules:
 *   - Never hand-write migration SQL unless Drizzle Kit output is incorrect
 *   - Never modify the schema without generating a corresponding migration
 *   - Migration files are append-only (never edit a shipped migration)
 */
import {
  sqliteTable,
  text,
  integer,
  index,
  uniqueIndex,
} from "drizzle-orm/sqlite-core";
import type { AnySQLiteColumn } from "drizzle-orm/sqlite-core";
import type { ThreadEventType } from "@bb/core";

export const projects = sqliteTable("projects", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  rootPath: text("root_path").notNull(),
  projectInstructions: text("project_instructions"),
  defaultProviderId: text("default_provider_id"),
  primaryCheckoutThreadId: text("primary_checkout_thread_id").references((): AnySQLiteColumn => threads.id, { onDelete: "set null" }),
  primaryManagerThreadId: text("primary_manager_thread_id").references((): AnySQLiteColumn => threads.id, { onDelete: "set null" }),
  createdAt: integer("created_at").notNull(),
  updatedAt: integer("updated_at").notNull(),
}, (table) => [
  index("projects_primary_checkout_thread_idx").on(table.primaryCheckoutThreadId),
  index("projects_primary_manager_thread_idx").on(table.primaryManagerThreadId),
]);

export const environments = sqliteTable(
  "environments",
  {
    id: text("id").primaryKey(),
    projectId: text("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    descriptor: text("descriptor").notNull(),
    managed: integer("managed", { mode: "boolean" }).notNull().default(false),
    requestedRuntimeKind: text("requested_runtime_kind"),
    runtimeState: text("runtime_state"),
    createdAt: integer("created_at").notNull(),
    updatedAt: integer("updated_at").notNull(),
  },
  (table) => [
    index("environments_project_updated_idx").on(table.projectId, table.updatedAt),
  ],
);

export const threads = sqliteTable(
  "threads",
  {
    id: text("id").primaryKey(),
    projectId: text("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    providerId: text("provider_id").notNull().default("codex"),
    type: text("type").notNull().default("standard"),
    title: text("title"),
    status: text("status").notNull().default("created"),
    environmentId: text("environment_id").references(() => environments.id, { onDelete: "set null" }),
    mergeBaseBranch: text("merge_base_branch"),
    parentThreadId: text("parent_thread_id").references((): AnySQLiteColumn => threads.id, { onDelete: "set null" }),
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
    index("threads_archived_environment_idx").on(table.archivedAt, table.environmentId),
  ]
);

export const threadEnvironmentAttachments = sqliteTable(
  "thread_environment_attachments",
  {
    threadId: text("thread_id")
      .primaryKey()
      .references(() => threads.id, { onDelete: "cascade" }),
    environmentId: text("environment_id")
      .notNull()
      .references(() => environments.id, { onDelete: "cascade" }),
    createdAt: integer("created_at").notNull(),
    updatedAt: integer("updated_at").notNull(),
  },
  (table) => [
    index("thread_environment_attachments_environment_idx").on(table.environmentId),
  ],
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
      .references(() => threads.id, { onDelete: "cascade" }),
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
    environmentId: text("environment_id").references(() => environments.id, {
      onDelete: "cascade",
    }),
    agentId: text("agent_id").notNull(),
    agentInstanceId: text("agent_instance_id").notNull(),
    protocolVersion: integer("protocol_version").notNull(),
    workerName: text("worker_name"),
    workerVersion: text("worker_version"),
    workerBuildId: text("worker_build_id"),
    providerMetadata: text("provider_metadata"),
    selectedCapabilities: text("selected_capabilities"),
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
    index("environment_agent_sessions_environment_status_idx").on(
      table.environmentId,
      table.status,
    ),
    index("environment_agent_sessions_agent_status_idx").on(
      table.agentId,
      table.status,
    ),
    index("environment_agent_sessions_lease_expires_idx").on(
      table.leaseExpiresAt,
    ),
    index("environment_agent_sessions_status_lease_idx").on(
      table.status,
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
