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
import { threadStatusValues } from "@bb/domain/thread-status";
import type {
  EnvironmentOperationKind,
  EnvironmentCleanupMode,
  EnvironmentStatus,
  HostType,
  PendingInteractionStatus,
  LifecycleOperationState,
  PermissionMode,
  ProjectOperationKind,
  PromptHistoryScope,
  ProjectSourceType,
  ReasoningLevel,
  ServiceTier,
  TerminalSessionCloseReason,
  TerminalSessionStatus,
  ThreadDynamicContextFileStatus,
  ThreadOperationKind,
  ThreadProvisioningStage,
  ThreadType,
  ThreadEventItemType,
  ThreadEventScopeKind,
  ThreadEventType,
  WorkspaceProvisionType,
} from "@bb/domain";

export const authUsers = sqliteTable(
  "user",
  {
    id: text("id").primaryKey(),
    name: text("name").notNull(),
    email: text("email").notNull(),
    emailVerified: integer("emailVerified", { mode: "boolean" }).notNull(),
    image: text("image"),
    createdAt: integer("createdAt", { mode: "timestamp_ms" }).notNull(),
    updatedAt: integer("updatedAt", { mode: "timestamp_ms" }).notNull(),
  },
  (table) => [uniqueIndex("user_email_unique").on(table.email)],
);

export const authApiKeys = sqliteTable(
  "apikey",
  {
    id: text("id").primaryKey(),
    name: text("name"),
    start: text("start"),
    prefix: text("prefix"),
    key: text("key").notNull(),
    referenceId: text("referenceId")
      .notNull()
      .references(() => authUsers.id, { onDelete: "cascade" }),
    refillInterval: integer("refillInterval"),
    refillAmount: integer("refillAmount"),
    lastRefillAt: integer("lastRefillAt", { mode: "timestamp_ms" }),
    enabled: integer("enabled", { mode: "boolean" }).notNull(),
    rateLimitEnabled: integer("rateLimitEnabled", {
      mode: "boolean",
    }).notNull(),
    rateLimitTimeWindow: integer("rateLimitTimeWindow").notNull(),
    rateLimitMax: integer("rateLimitMax").notNull(),
    requestCount: integer("requestCount").notNull(),
    remaining: integer("remaining"),
    lastRequest: integer("lastRequest", { mode: "timestamp_ms" }),
    expiresAt: integer("expiresAt", { mode: "timestamp_ms" }),
    createdAt: integer("createdAt", { mode: "timestamp_ms" }).notNull(),
    updatedAt: integer("updatedAt", { mode: "timestamp_ms" }).notNull(),
    permissions: text("permissions"),
    metadata: text("metadata"),
    configId: text("configId").notNull(),
  },
  (table) => [
    uniqueIndex("apikey_key_unique").on(table.key),
    index("apikey_reference_id_idx").on(table.referenceId),
    index("apikey_config_id_idx").on(table.configId),
  ],
);

export const hosts = sqliteTable(
  "hosts",
  {
    id: text("id").primaryKey(),
    name: text("name").notNull(),
    type: text("type").$type<HostType>().notNull(),
    commandCursor: integer("command_cursor").notNull().default(0),
    destroyedAt: integer("destroyed_at"),
    lastSeenAt: integer("last_seen_at"),
    createdAt: integer("created_at").notNull(),
    updatedAt: integer("updated_at").notNull(),
  },
  (table) => [index("hosts_last_seen_idx").on(table.lastSeenAt)],
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

export const projectExecutionDefaults = sqliteTable(
  "project_execution_defaults",
  {
    projectId: text("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    providerId: text("provider_id").notNull(),
    threadType: text("thread_type").$type<ThreadType>().notNull(),
    model: text("model").notNull(),
    serviceTier: text("service_tier").$type<ServiceTier>().notNull(),
    reasoningLevel: text("reasoning_level").$type<ReasoningLevel>().notNull(),
    permissionMode: text("permission_mode").$type<PermissionMode>().notNull(),
    updatedAt: integer("updated_at").notNull(),
  },
  (table) => [
    uniqueIndex("project_execution_defaults_project_thread_type_idx").on(
      table.projectId,
      table.threadType,
    ),
    index("project_execution_defaults_project_idx").on(table.projectId),
  ],
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
    isDefault: integer("is_default", { mode: "boolean" })
      .notNull()
      .default(false),
    createdAt: integer("created_at").notNull(),
    updatedAt: integer("updated_at").notNull(),
  },
  (table) => [
    index("project_sources_project_idx").on(table.projectId),
    index("project_sources_host_idx").on(table.hostId),
    uniqueIndex("project_sources_project_host_idx").on(
      table.projectId,
      table.hostId,
    ),
    check(
      "project_sources_shape_check",
      sql`(
        ${table.type} = 'local_path' AND ${table.hostId} IS NOT NULL AND ${table.path} IS NOT NULL
      )`,
    ),
    // NOTE: Drizzle does not support partial/filtered unique indexes.
    // The baseline migration adds the database constraint for at most one
    // default source per project.
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
    baseBranch: text("base_branch"),
    defaultBranch: text("default_branch"),
    mergeBaseBranch: text("merge_base_branch"),
    cleanupRequestedAt: integer("cleanup_requested_at"),
    cleanupMode: text("cleanup_mode").$type<EnvironmentCleanupMode>(),
    workspaceProvisionType: text("workspace_provision_type")
      .$type<WorkspaceProvisionType>()
      .notNull(),
    status: text("status")
      .$type<EnvironmentStatus>()
      .notNull()
      .default("provisioning"),
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
    autoArchive: integer("auto_archive", { mode: "boolean" })
      .notNull()
      .default(false),
    nextRunAt: integer("next_run_at"),
    lastRunAt: integer("last_run_at"),
    runCount: integer("run_count").notNull().default(0),
    createdAt: integer("created_at").notNull(),
    updatedAt: integer("updated_at").notNull(),
  },
  (table) => [
    index("automations_project_idx").on(table.projectId),
    index("automations_due_idx").on(
      table.enabled,
      table.triggerType,
      table.nextRunAt,
    ),
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
    status: text("status", { enum: threadStatusValues })
      .notNull()
      .default("created"),
    parentThreadId: text("parent_thread_id").references(
      (): AnySQLiteColumn => threads.id,
      { onDelete: "set null" },
    ),
    archivedAt: integer("archived_at"),
    stopRequestedAt: integer("stop_requested_at"),
    deletedAt: integer("deleted_at"),
    lastReadAt: integer("last_read_at"),
    latestAttentionAt: integer("latest_attention_at").notNull(),
    createdAt: integer("created_at").notNull(),
    updatedAt: integer("updated_at").notNull(),
  },
  (table) => [
    index("threads_project_updated_idx").on(table.projectId, table.updatedAt),
    index("threads_project_archived_deleted_idx").on(
      table.projectId,
      table.archivedAt,
      table.deletedAt,
      table.id,
    ),
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
    index("threads_active_maintenance_idx")
      .on(table.status)
      .where(sql`${table.deletedAt} IS NULL`),
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

export const threadDynamicContextFileStates = sqliteTable(
  "thread_dynamic_context_file_states",
  {
    threadId: text("thread_id")
      .notNull()
      .references(() => threads.id, { onDelete: "cascade" }),
    fileKey: text("file_key").notNull(),
    contentStatus: text("content_status")
      .$type<ThreadDynamicContextFileStatus>()
      .notNull(),
    contentHash: text("content_hash").notNull(),
    shownAt: integer("shown_at").notNull(),
    createdAt: integer("created_at").notNull(),
    updatedAt: integer("updated_at").notNull(),
  },
  (table) => [
    uniqueIndex("thread_dynamic_context_file_states_thread_file_idx").on(
      table.threadId,
      table.fileKey,
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
    scopeKind: text("scope_kind").$type<ThreadEventScopeKind>().notNull(),
    turnId: text("turn_id"),
    providerThreadId: text("provider_thread_id"),
    sequence: integer("sequence").notNull(),
    type: text("type").$type<ThreadEventType>().notNull(),
    itemId: text("item_id"),
    itemKind: text("item_kind").$type<ThreadEventItemType>(),
    producerEventId: text("producer_event_id"),
    producerEventPayloadHash: text("producer_event_payload_hash"),
    data: text("data").notNull().default("{}"),
    createdAt: integer("created_at").notNull(),
  },
  (table) => [
    uniqueIndex("events_thread_sequence_idx").on(
      table.threadId,
      table.sequence,
    ),
    uniqueIndex("events_producer_event_id_idx").on(table.producerEventId),
    index("events_thread_type_item_kind_sequence_idx").on(
      table.threadId,
      table.type,
      table.itemKind,
      table.sequence,
    ),
    index("events_thread_type_sequence_idx").on(
      table.threadId,
      table.type,
      table.sequence,
    ),
    index("events_thread_turn_type_item_sequence_idx").on(
      table.threadId,
      table.turnId,
      table.type,
      table.itemId,
      table.sequence,
    ),
    index("events_environment_idx").on(table.environmentId),
    index("events_completed_item_truncation_idx")
      .on(table.itemKind, table.createdAt, table.id)
      .where(sql`${table.type} = 'item/completed'`),
    check(
      "events_scope_shape_check",
      sql`(
        (${table.scopeKind} = 'turn' AND ${table.turnId} IS NOT NULL)
        OR
        (${table.scopeKind} = 'thread' AND ${table.turnId} IS NULL)
      )`,
    ),
  ],
);

export const maintenanceScanCursors = sqliteTable(
  "maintenance_scan_cursors",
  {
    id: text("id").primaryKey(),
    policy: text("policy").notNull(),
    version: integer("version").notNull(),
    itemKind: text("item_kind").$type<ThreadEventItemType>().notNull(),
    outputPath: text("output_path").notNull(),
    lastCreatedAt: integer("last_created_at").notNull().default(0),
    lastEventId: text("last_event_id").notNull().default(""),
    updatedAt: integer("updated_at").notNull(),
  },
  (table) => [
    uniqueIndex("maintenance_scan_cursors_path_idx").on(
      table.policy,
      table.version,
      table.itemKind,
      table.outputPath,
    ),
  ],
);

export const promptHistoryEntries = sqliteTable(
  "prompt_history_entries",
  {
    id: text("id").primaryKey(),
    projectId: text("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    threadId: text("thread_id")
      .notNull()
      .references(() => threads.id, { onDelete: "cascade" }),
    scope: text("scope").$type<PromptHistoryScope>().notNull(),
    requestSequence: integer("request_sequence").notNull(),
    input: text("input").notNull(),
    createdAt: integer("created_at").notNull(),
  },
  (table) => [
    uniqueIndex("prompt_history_entries_thread_request_idx").on(
      table.threadId,
      table.requestSequence,
    ),
    index("prompt_history_entries_project_scope_created_idx").on(
      table.projectId,
      table.scope,
      table.createdAt,
      table.requestSequence,
      table.id,
    ),
    index("prompt_history_entries_thread_scope_created_idx").on(
      table.threadId,
      table.scope,
      table.createdAt,
      table.requestSequence,
      table.id,
    ),
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
    permissionMode: text("permission_mode").$type<PermissionMode>().notNull(),
    serviceTier: text("service_tier").notNull(),
    claimedAt: integer("claimed_at"),
    claimToken: text("claim_token"),
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
    dataDir: text("data_dir").notNull(),
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
    index("host_daemon_sessions_host_status_idx").on(
      table.hostId,
      table.status,
    ),
    index("host_daemon_sessions_host_latest_idx").on(
      table.hostId,
      table.updatedAt,
      table.createdAt,
      table.id,
    ),
    index("host_daemon_sessions_closed_prune_idx").on(
      table.status,
      table.closedAt,
      table.id,
    ),
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
    index("host_daemon_commands_session_idx").on(table.sessionId),
    index("host_daemon_commands_host_state_cursor_idx").on(
      table.hostId,
      table.state,
      table.cursor,
    ),
    index("host_daemon_commands_state_fetched_at_idx").on(
      table.state,
      table.fetchedAt,
    ),
    index("host_daemon_commands_payload_prune_idx")
      .on(table.state, table.completedAt)
      .where(
        sql`${table.completedAt} IS NOT NULL
          AND (${table.payload} <> '{}' OR ${table.resultPayload} IS NOT NULL)`,
      ),
    index("host_daemon_commands_completed_prune_idx")
      .on(table.completedAt)
      .where(sql`${table.completedAt} IS NOT NULL`),
  ],
);

export const terminalSessions = sqliteTable(
  "terminal_sessions",
  {
    id: text("id").primaryKey(),
    threadId: text("thread_id")
      .notNull()
      .references(() => threads.id, { onDelete: "cascade" }),
    environmentId: text("environment_id")
      .notNull()
      .references(() => environments.id, { onDelete: "cascade" }),
    hostId: text("host_id")
      .notNull()
      .references(() => hosts.id, { onDelete: "cascade" }),
    daemonSessionId: text("daemon_session_id").references(
      () => hostDaemonSessions.id,
      { onDelete: "set null" },
    ),
    title: text("title").notNull(),
    initialCwd: text("initial_cwd").notNull(),
    currentCwd: text("current_cwd"),
    cols: integer("cols").notNull(),
    rows: integer("rows").notNull(),
    status: text("status").$type<TerminalSessionStatus>().notNull(),
    exitCode: integer("exit_code"),
    closeReason: text("close_reason").$type<TerminalSessionCloseReason>(),
    createdAt: integer("created_at").notNull(),
    updatedAt: integer("updated_at").notNull(),
    lastUserInputAt: integer("last_user_input_at"),
    lastConnectedAt: integer("last_connected_at"),
    exitedAt: integer("exited_at"),
  },
  (table) => [
    index("terminal_sessions_thread_status_updated_idx").on(
      table.threadId,
      table.status,
      table.updatedAt,
    ),
    index("terminal_sessions_environment_status_idx").on(
      table.environmentId,
      table.status,
    ),
    index("terminal_sessions_host_status_idx").on(table.hostId, table.status),
    index("terminal_sessions_daemon_session_idx").on(table.daemonSessionId),
  ],
);

export const pendingInteractions = sqliteTable(
  "pending_interactions",
  {
    id: text("id").primaryKey(),
    threadId: text("thread_id")
      .notNull()
      .references(() => threads.id, { onDelete: "cascade" }),
    turnId: text("turn_id").notNull(),
    providerId: text("provider_id").notNull(),
    providerThreadId: text("provider_thread_id").notNull(),
    providerRequestId: text("provider_request_id").notNull(),
    sessionId: text("session_id").notNull(),
    resolvingCommandId: text("resolving_command_id").references(
      () => hostDaemonCommands.id,
      { onDelete: "set null" },
    ),
    status: text("status").$type<PendingInteractionStatus>().notNull(),
    payload: text("payload").notNull(),
    resolution: text("resolution"),
    statusReason: text("status_reason"),
    createdAt: integer("created_at").notNull(),
    resolvedAt: integer("resolved_at"),
    updatedAt: integer("updated_at").notNull(),
  },
  (table) => [
    uniqueIndex("pending_interactions_provider_request_idx").on(
      table.sessionId,
      table.providerId,
      table.providerThreadId,
      table.providerRequestId,
    ),
    index("pending_interactions_thread_created_idx").on(
      table.threadId,
      table.createdAt,
    ),
    index("pending_interactions_thread_status_created_idx").on(
      table.threadId,
      table.status,
      table.createdAt,
    ),
    index("pending_interactions_status_created_idx").on(
      table.status,
      table.createdAt,
    ),
    index("pending_interactions_resolving_command_idx").on(
      table.resolvingCommandId,
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
    provisioningId: text("provisioning_id"),
    provisioningStage:
      text("provisioning_stage").$type<ThreadProvisioningStage>(),
    provisioningEnvironmentId: text("provisioning_environment_id").references(
      () => environments.id,
      { onDelete: "set null" },
    ),
    provisionEventSequence: integer("provision_event_sequence"),
    workspaceReadyEventSequence: integer("workspace_ready_event_sequence"),
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
