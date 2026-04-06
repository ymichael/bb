import {
  check,
  index,
  integer,
  sqliteTable,
  text,
  uniqueIndex,
} from "drizzle-orm/sqlite-core";
import { sql } from "drizzle-orm";
import type { AnySQLiteColumn } from "drizzle-orm/sqlite-core";
import { threadStatusValues } from "@bb/domain";
import type {
  EnvironmentOperationKind,
  EnvironmentCleanupMode,
  EnvironmentStatus,
  HostType,
  LifecycleOperationState,
  ProjectOperationKind,
  ProjectSourceType,
  ThreadOperationKind,
  ThreadEventItemType,
  ThreadEventType,
  ThreadType,
  WorkspaceProvisionType,
} from "@bb/domain";

export const hosts = sqliteTable(
  "hosts",
  {
    id: text("id").primaryKey(),
    name: text("name").notNull(),
    type: text("type").$type<HostType>().notNull(),
    provider: text("provider"),
    externalId: text("external_id"),
    destroyedAt: integer("destroyed_at"),
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
    type: text("type").$type<ProjectSourceType>().notNull(),
    hostId: text("host_id").references(() => hosts.id, { onDelete: "cascade" }),
    path: text("path"),
    repoUrl: text("repo_url"),
    isDefault: integer("is_default", { mode: "boolean" }).notNull().default(false),
    createdAt: integer("created_at").notNull(),
    updatedAt: integer("updated_at").notNull(),
  },
  (table) => [
    index("project_sources_project_idx").on(table.projectId),
    index("project_sources_host_idx").on(table.hostId),
    uniqueIndex("project_sources_project_host_idx").on(table.projectId, table.hostId),
    check(
      "project_sources_shape_check",
      sql`(
        (${table.type} = 'local_path' AND ${table.hostId} IS NOT NULL AND ${table.path} IS NOT NULL AND ${table.repoUrl} IS NULL)
        OR
        (${table.type} = 'github_repo' AND ${table.hostId} IS NULL AND ${table.path} IS NULL AND ${table.repoUrl} IS NOT NULL)
      )`,
    ),
    // NOTE: Drizzle does not support partial/filtered unique indexes.
    // The constraint "only one default source per project" (WHERE is_default = 1)
    // must be enforced in application code.
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
    isWorktree: integer("is_worktree", { mode: "boolean" })
      .notNull()
      .default(false),
    branchName: text("branch_name"),
    defaultBranch: text("default_branch"),
    mergeBaseBranch: text("merge_base_branch"),
    cleanupRequestedAt: integer("cleanup_requested_at"),
    cleanupMode: text("cleanup_mode").$type<EnvironmentCleanupMode>(),
    workspaceProvisionType: text("workspace_provision_type")
      .$type<WorkspaceProvisionType>()
      .notNull(),
    status: text("status").$type<EnvironmentStatus>().notNull().default("provisioning"),
    createdAt: integer("created_at").notNull(),
    updatedAt: integer("updated_at").notNull(),
  },
  (table) => [
    uniqueIndex("environments_host_path_idx").on(table.hostId, table.path),
    index("environments_project_idx").on(table.projectId),
    index("environments_cleanup_requested_idx").on(table.cleanupRequestedAt),
    index("environments_status_idx").on(table.status),
  ],
);

export const automations = sqliteTable(
  "automations",
  {
    id: text("id").primaryKey(),
    projectId: text("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    enabled: integer("enabled", { mode: "boolean" }).notNull().default(true),
    triggerType: text("trigger_type").notNull(),
    triggerConfig: text("trigger_config").notNull(),
    action: text("action").notNull(),
    autoArchive: integer("auto_archive", { mode: "boolean" }).notNull().default(false),
    nextRunAt: integer("next_run_at"),
    lastRunAt: integer("last_run_at"),
    runCount: integer("run_count").notNull().default(0),
    createdAt: integer("created_at").notNull(),
    updatedAt: integer("updated_at").notNull(),
  },
  (table) => [
    index("automations_project_idx").on(table.projectId),
    index("automations_due_idx").on(table.enabled, table.triggerType, table.nextRunAt),
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
    automationId: text("automation_id").references(() => automations.id, {
      onDelete: "set null",
    }),
    providerId: text("provider_id").notNull(),
    type: text("type").$type<ThreadType>().notNull().default("standard"),
    title: text("title"),
    titleFallback: text("title_fallback"),
    status: text("status", { enum: threadStatusValues }).notNull().default("created"),
    parentThreadId: text("parent_thread_id").references(
      (): AnySQLiteColumn => threads.id,
      { onDelete: "set null" },
    ),
    archivedAt: integer("archived_at"),
    stopRequestedAt: integer("stop_requested_at"),
    deletedAt: integer("deleted_at"),
    lastReadAt: integer("last_read_at"),
    createdAt: integer("created_at").notNull(),
    updatedAt: integer("updated_at").notNull(),
  },
  (table) => [
    index("threads_project_updated_idx").on(table.projectId, table.updatedAt),
    index("threads_environment_idx").on(table.environmentId),
    index("threads_automation_runtime_idx").on(
      table.automationId,
      table.archivedAt,
      table.deletedAt,
      table.status,
    ),
    index("threads_parent_idx").on(table.parentThreadId),
    index("threads_archived_status_idx").on(table.archivedAt, table.status),
    index("threads_environment_archived_deleted_idx").on(
      table.environmentId,
      table.archivedAt,
      table.deletedAt,
    ),
  ],
);


export const managerThreadNudges = sqliteTable(
  "manager_thread_nudges",
  {
    id: text("id").primaryKey(),
    projectId: text("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    threadId: text("thread_id")
      .notNull()
      .references(() => threads.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    cron: text("cron").notNull(),
    timezone: text("timezone").notNull(),
    enabled: integer("enabled", { mode: "boolean" }).notNull().default(true),
    nextFireAt: integer("next_fire_at").notNull(),
    lastFiredAt: integer("last_fired_at"),
    createdAt: integer("created_at").notNull(),
    updatedAt: integer("updated_at").notNull(),
  },
  (table) => [
    index("manager_thread_nudges_due_idx").on(table.enabled, table.nextFireAt),
    index("manager_thread_nudges_project_idx").on(table.projectId),
    uniqueIndex("manager_thread_nudges_sync_key_idx").on(
      table.projectId,
      table.threadId,
      table.name,
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
    environmentId: text("environment_id").references(() => environments.id, {
      onDelete: "set null",
    }),
    turnId: text("turn_id"),
    providerThreadId: text("provider_thread_id"),
    sequence: integer("sequence").notNull(),
    type: text("type").$type<ThreadEventType>().notNull(),
    itemId: text("item_id"),
    itemKind: text("item_kind").$type<ThreadEventItemType>(),
    data: text("data").notNull().default("{}"),
    createdAt: integer("created_at").notNull(),
  },
  (table) => [
    uniqueIndex("events_thread_sequence_idx").on(table.threadId, table.sequence),
    index("events_thread_type_item_kind_sequence_idx").on(
      table.threadId,
      table.type,
      table.itemKind,
      table.sequence,
    ),
    index("events_thread_item_id_sequence_idx").on(
      table.threadId,
      table.itemId,
      table.sequence,
    ),
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
    model: text("model").notNull(),
    reasoningLevel: text("reasoning_level").notNull(),
    sandboxMode: text("sandbox_mode").notNull(),
    serviceTier: text("service_tier").notNull(),
    claimedAt: integer("claimed_at"),
    createdAt: integer("created_at").notNull(),
    updatedAt: integer("updated_at").notNull(),
  },
  (table) => [
    index("queued_thread_messages_thread_created_idx").on(
      table.threadId,
      table.createdAt,
      table.id,
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
    hostType: text("host_type").$type<HostType>().notNull(),
    dataDir: text("data_dir"),
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
    hostId: text("host_id")
      .notNull()
      .references(() => hosts.id),
    sessionId: text("session_id").references(() => hostDaemonSessions.id, {
      onDelete: "set null",
    }),
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
    uniqueIndex("host_daemon_commands_host_cursor_idx").on(
      table.hostId,
      table.cursor,
    ),
    index("host_daemon_commands_host_state_idx").on(
      table.hostId,
      table.state,
    ),
  ],
);

export const projectOperations = sqliteTable(
  "project_operations",
  {
    id: text("id").primaryKey(),
    projectId: text("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    kind: text("kind").$type<ProjectOperationKind>().notNull(),
    state: text("state").$type<LifecycleOperationState>().notNull(),
    payload: text("payload").notNull(),
    commandId: text("command_id").references(() => hostDaemonCommands.id, {
      onDelete: "set null",
    }),
    requestedAt: integer("requested_at").notNull(),
    queuedAt: integer("queued_at"),
    completedAt: integer("completed_at"),
    failureReason: text("failure_reason"),
    createdAt: integer("created_at").notNull(),
    updatedAt: integer("updated_at").notNull(),
  },
  (table) => [
    uniqueIndex("project_operations_project_kind_idx").on(
      table.projectId,
      table.kind,
    ),
    uniqueIndex("project_operations_command_idx").on(table.commandId),
    index("project_operations_state_idx").on(table.state),
    index("project_operations_project_idx").on(table.projectId),
  ],
);

export const environmentOperations = sqliteTable(
  "environment_operations",
  {
    id: text("id").primaryKey(),
    environmentId: text("environment_id")
      .notNull()
      .references(() => environments.id, { onDelete: "cascade" }),
    kind: text("kind").$type<EnvironmentOperationKind>().notNull(),
    state: text("state").$type<LifecycleOperationState>().notNull(),
    payload: text("payload").notNull(),
    commandId: text("command_id").references(() => hostDaemonCommands.id, {
      onDelete: "set null",
    }),
    requestedAt: integer("requested_at").notNull(),
    queuedAt: integer("queued_at"),
    completedAt: integer("completed_at"),
    failureReason: text("failure_reason"),
    createdAt: integer("created_at").notNull(),
    updatedAt: integer("updated_at").notNull(),
  },
  (table) => [
    uniqueIndex("environment_operations_environment_kind_idx").on(
      table.environmentId,
      table.kind,
    ),
    uniqueIndex("environment_operations_command_idx").on(table.commandId),
    index("environment_operations_state_idx").on(table.state),
    index("environment_operations_environment_idx").on(table.environmentId),
  ],
);

export const threadOperations = sqliteTable(
  "thread_operations",
  {
    id: text("id").primaryKey(),
    threadId: text("thread_id")
      .notNull()
      .references(() => threads.id, { onDelete: "cascade" }),
    kind: text("kind").$type<ThreadOperationKind>().notNull(),
    state: text("state").$type<LifecycleOperationState>().notNull(),
    payload: text("payload").notNull(),
    commandId: text("command_id").references(() => hostDaemonCommands.id, {
      onDelete: "set null",
    }),
    requestedAt: integer("requested_at").notNull(),
    queuedAt: integer("queued_at"),
    completedAt: integer("completed_at"),
    failureReason: text("failure_reason"),
    createdAt: integer("created_at").notNull(),
    updatedAt: integer("updated_at").notNull(),
  },
  (table) => [
    uniqueIndex("thread_operations_thread_kind_idx").on(
      table.threadId,
      table.kind,
    ),
    uniqueIndex("thread_operations_command_idx").on(table.commandId),
    index("thread_operations_state_idx").on(table.state),
    index("thread_operations_thread_idx").on(table.threadId),
  ],
);
