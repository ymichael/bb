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
    lastSeenAt: integer("last_seen_at").notNull(),
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
    path: text("path"),
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
    index("threads_project_updated_idx").on(table.projectId, table.updatedAt),
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
    turnId: text("turn_id"),
    providerThreadId: text("provider_thread_id"),
    sequence: integer("sequence").notNull(),
    type: text("type").$type<ThreadEventType>().notNull(),
    data: text("data").notNull().default("{}"),
    createdAt: integer("created_at").notNull(),
  },
  (table) => [
    uniqueIndex("events_thread_sequence_idx").on(table.threadId, table.sequence),
    index("events_environment_idx").on(table.environmentId),
  ],
);

export const queuedThreadMessages = sqliteTable(
  "queued_thread_messages",
  {
    id: text("id").primaryKey(),
    threadId: text("thread_id")
      .notNull()
      .references(() => threads.id, { onDelete: "cascade" }),
    content: text("content").notNull(),
    mode: text("mode").notNull(),
    reasoningLevel: text("reasoning_level").notNull(),
    sandboxMode: text("sandbox_mode").notNull(),
    createdAt: integer("created_at").notNull(),
    updatedAt: integer("updated_at").notNull(),
  },
  (table) => [
    index("queued_thread_messages_thread_updated_idx").on(
      table.threadId,
      table.updatedAt,
    ),
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
    hostName: text("host_name").notNull(),
    hostType: text("host_type").notNull(),
    protocolVersion: integer("protocol_version").notNull(),
    heartbeatIntervalMs: integer("heartbeat_interval_ms").notNull(),
    leaseTimeoutMs: integer("lease_timeout_ms").notNull(),
    status: text("status").notNull(),
    leaseExpiresAt: integer("lease_expires_at").notNull(),
    lastHeartbeatAt: integer("last_heartbeat_at"),
    closedAt: integer("closed_at"),
    closeReason: text("close_reason"),
    createdAt: integer("created_at").notNull(),
    updatedAt: integer("updated_at").notNull(),
  },
  (table) => [
    index("host_daemon_sessions_host_status_idx").on(table.hostId, table.status),
  ],
);

export const hostDaemonCommands = sqliteTable(
  "host_daemon_commands",
  {
    id: text("id").primaryKey(),
    sessionId: text("session_id")
      .notNull()
      .references(() => hostDaemonSessions.id, { onDelete: "cascade" }),
    cursor: integer("cursor").notNull(),
    type: text("type").notNull(),
    payload: text("payload").notNull(),
    state: text("state").notNull(),
    retryCount: integer("retry_count").notNull().default(0),
    resultPayload: text("result_payload"),
    createdAt: integer("created_at").notNull(),
    fetchedAt: integer("fetched_at"),
    completedAt: integer("completed_at"),
  },
  (table) => [
    uniqueIndex("host_daemon_commands_session_cursor_idx").on(
      table.sessionId,
      table.cursor,
    ),
    index("host_daemon_commands_session_state_idx").on(
      table.sessionId,
      table.state,
    ),
  ],
);

export const hostDaemonCursors = sqliteTable("host_daemon_cursors", {
  hostId: text("host_id")
    .primaryKey()
    .references(() => hosts.id, { onDelete: "cascade" }),
  cursor: integer("cursor").notNull(),
  updatedAt: integer("updated_at").notNull(),
});
