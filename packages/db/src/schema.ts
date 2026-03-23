import {
  index,
  integer,
  sqliteTable,
  text,
  uniqueIndex,
} from "drizzle-orm/sqlite-core";
import type { AnySQLiteColumn } from "drizzle-orm/sqlite-core";
import type { ThreadEventType } from "@bb/domain";

export const hosts = sqliteTable(
  "hosts",
  {
    id: text("id").primaryKey(),
    name: text("name").notNull(),
    type: text("type").notNull(),
    provider: text("provider"),
    externalId: text("external_id"),
    lastSeenAt: integer("last_seen_at"),
    createdAt: integer("created_at").notNull(),
    updatedAt: integer("updated_at").notNull(),
  },
  (table) => [
    index("hosts_last_seen_idx").on(table.lastSeenAt),
  ],
);

export const projects = sqliteTable(
  "projects",
  {
    id: text("id").primaryKey(),
    name: text("name").notNull(),
    createdAt: integer("created_at").notNull(),
    updatedAt: integer("updated_at").notNull(),
  },
  (table) => [index("projects_updated_idx").on(table.updatedAt)],
);

export const projectSources = sqliteTable(
  "project_sources",
  {
    id: text("id").primaryKey(),
    projectId: text("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    type: text("type").notNull(),
    hostId: text("host_id")
      .notNull()
      .references(() => hosts.id, { onDelete: "cascade" }),
    path: text("path"),
    repoUrl: text("repo_url"),
    createdAt: integer("created_at").notNull(),
    updatedAt: integer("updated_at").notNull(),
  },
  (table) => [
    index("project_sources_project_idx").on(table.projectId),
    index("project_sources_host_idx").on(table.hostId),
  ],
);

export const environments = sqliteTable(
  "environments",
  {
    id: text("id").primaryKey(),
    projectId: text("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    hostId: text("host_id")
      .notNull()
      .references(() => hosts.id, { onDelete: "cascade" }),
    path: text("path").notNull(),
    managed: integer("managed", { mode: "boolean" }).notNull().default(false),
    isGitRepo: integer("is_git_repo", { mode: "boolean" })
      .notNull()
      .default(false),
    branchName: text("branch_name"),
    provisionerId: text("provisioner_id"),
    provisionerState: text("provisioner_state"),
    status: text("status").notNull().default("provisioning"),
    createdAt: integer("created_at").notNull(),
    updatedAt: integer("updated_at").notNull(),
  },
  (table) => [
    uniqueIndex("environments_host_path_idx").on(table.hostId, table.path),
    index("environments_project_idx").on(table.projectId),
    index("environments_status_idx").on(table.status),
  ],
);

export const threads = sqliteTable(
  "threads",
  {
    id: text("id").primaryKey(),
    projectId: text("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    environmentId: text("environment_id").references(() => environments.id, {
      onDelete: "set null",
    }),
    providerId: text("provider_id").notNull(),
    type: text("type").notNull().default("standard"),
    title: text("title"),
    status: text("status").notNull().default("created"),
    mergeBaseBranch: text("merge_base_branch"),
    parentThreadId: text("parent_thread_id").references(
      (): AnySQLiteColumn => threads.id,
      { onDelete: "set null" },
    ),
    archivedAt: integer("archived_at"),
    lastReadAt: integer("last_read_at"),
    createdAt: integer("created_at").notNull(),
    updatedAt: integer("updated_at").notNull(),
  },
  (table) => [
    index("threads_project_idx").on(table.projectId),
    index("threads_environment_idx").on(table.environmentId),
    index("threads_parent_idx").on(table.parentThreadId),
    index("threads_archived_status_idx").on(table.archivedAt, table.status),
  ],
);

export const events = sqliteTable(
  "events",
  {
    id: text("id").primaryKey(),
    threadId: text("thread_id")
      .notNull()
      .references(() => threads.id, { onDelete: "cascade" }),
    environmentId: text("environment_id").references(() => environments.id, {
      onDelete: "set null",
    }),
    seq: integer("seq").notNull(),
    type: text("type").$type<ThreadEventType>().notNull(),
    data: text("data").notNull().default("{}"),
    createdAt: integer("created_at").notNull(),
  },
  (table) => [
    uniqueIndex("events_thread_seq_idx").on(table.threadId, table.seq),
    index("events_environment_idx").on(table.environmentId),
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
    reasoningLevel: text("reasoning_level"),
    sandboxMode: text("sandbox_mode"),
    createdAt: integer("created_at").notNull(),
  },
  (table) => [
    index("queued_thread_messages_thread_seq_idx").on(table.threadId, table.seq),
  ],
);

export const hostDaemonSessions = sqliteTable(
  "host_daemon_sessions",
  {
    id: text("id").primaryKey(),
    hostId: text("host_id")
      .notNull()
      .references(() => hosts.id, { onDelete: "cascade" }),
    instanceId: text("instance_id").notNull(),
    protocolVersion: integer("protocol_version").notNull(),
    status: text("status").notNull(),
    leaseExpiresAt: integer("lease_expires_at").notNull(),
    lastHeartbeatAt: integer("last_heartbeat_at"),
    activeThreads: text("active_threads"),
    createdAt: integer("created_at").notNull(),
    updatedAt: integer("updated_at").notNull(),
  },
  (table) => [
    index("host_daemon_sessions_host_status_idx").on(table.hostId, table.status),
    index("host_daemon_sessions_lease_idx").on(table.leaseExpiresAt),
  ],
);

export const hostDaemonCommands = sqliteTable(
  "host_daemon_commands",
  {
    id: text("id").primaryKey(),
    hostId: text("host_id")
      .notNull()
      .references(() => hosts.id, { onDelete: "cascade" }),
    sessionId: text("session_id").references(() => hostDaemonSessions.id, {
      onDelete: "set null",
    }),
    environmentId: text("environment_id").references(() => environments.id, {
      onDelete: "set null",
    }),
    threadId: text("thread_id").references(() => threads.id, {
      onDelete: "set null",
    }),
    cursor: integer("cursor").notNull(),
    commandType: text("command_type").notNull(),
    payload: text("payload").notNull(),
    state: text("state").notNull(),
    retryCount: integer("retry_count").notNull().default(0),
    result: text("result"),
    errorCode: text("error_code"),
    errorMessage: text("error_message"),
    createdAt: integer("created_at").notNull(),
    updatedAt: integer("updated_at").notNull(),
  },
  (table) => [
    uniqueIndex("host_daemon_commands_host_cursor_idx").on(
      table.hostId,
      table.cursor,
    ),
    index("host_daemon_commands_host_state_idx").on(table.hostId, table.state),
    index("host_daemon_commands_environment_idx").on(table.environmentId),
  ],
);

export const hostDaemonCursors = sqliteTable("host_daemon_cursors", {
  hostId: text("host_id")
    .primaryKey()
    .references(() => hosts.id, { onDelete: "cascade" }),
  cursor: integer("cursor").notNull(),
  updatedAt: integer("updated_at").notNull(),
});
