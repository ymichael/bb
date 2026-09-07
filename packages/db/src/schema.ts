import {
  blob,
  check,
  index,
  integer,
  primaryKey,
  sqliteTable,
  text,
  uniqueIndex,
} from "drizzle-orm/sqlite-core";
import { sql } from "drizzle-orm";
import type { AnySQLiteColumn } from "drizzle-orm/sqlite-core";
import { threadStatusValues } from "@bb/domain/thread-status";
import { threadOriginKindValues } from "@bb/domain/thread-origin-kind";
import { threadVisibilityValues } from "@bb/domain/thread-visibility";
import type {
  EnvironmentStatus,
  FaviconColorPreference,
  HostType,
  PendingInteractionStatus,
  PermissionMode,
  PromptHistoryScope,
  ProjectSourceType,
  QueuedMessagePayloadKind,
  QueuedMessageWaitHolder,
  ReasoningLevel,
  ServiceTier,
  TerminalSessionCloseReason,
  TerminalSessionStatus,
  ThreadDynamicContextFileStatus,
  ThreadSearchSourceKind,
  ThreadEventItemType,
  ThreadEventScopeKind,
  ThreadEventType,
  WorkspaceProvisionType,
  ProjectKind,
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
    connectMachineId: text("connect_machine_id"),
    maxPermissionMode: text("max_permission_mode")
      .$type<PermissionMode>()
      .notNull()
      .default("full"),
    destroyedAt: integer("destroyed_at"),
    lastSeenAt: integer("last_seen_at"),
    lastRejectedProtocolVersion: integer("last_rejected_protocol_version"),
    createdAt: integer("created_at").notNull(),
    updatedAt: integer("updated_at").notNull(),
  },
  (table) => [index("hosts_last_seen_idx").on(table.lastSeenAt)],
);

export const projects = sqliteTable(
  "projects",
  {
    id: text("id").primaryKey(),
    kind: text("kind").$type<ProjectKind>().notNull().default("standard"),
    name: text("name").notNull(),
    gitRemoteUrl: text("git_remote_url"),
    sortKey: text("sort_key").notNull().default("V"),
    deletedAt: integer("deleted_at"),
    createdAt: integer("created_at").notNull(),
    updatedAt: integer("updated_at").notNull(),
  },
  (table) => [
    index("projects_updated_idx").on(table.updatedAt),
    index("projects_deleted_idx").on(table.deletedAt),
    index("projects_sort_idx").on(table.sortKey, table.id),
    uniqueIndex("projects_personal_singleton_idx")
      .on(table.kind)
      .where(sql`${table.kind} = 'personal'`),
  ],
);

export const projectExecutionDefaults = sqliteTable(
  "project_execution_defaults",
  {
    projectId: text("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    providerId: text("provider_id").notNull(),
    model: text("model").notNull(),
    serviceTier: text("service_tier").$type<ServiceTier>().notNull(),
    reasoningLevel: text("reasoning_level").$type<ReasoningLevel>().notNull(),
    permissionMode: text("permission_mode").$type<PermissionMode>().notNull(),
    updatedAt: integer("updated_at").notNull(),
  },
  (table) => [
    uniqueIndex("project_execution_defaults_project_idx").on(table.projectId),
  ],
);

export const systemExperiments = sqliteTable("system_experiments", {
  key: text("key").primaryKey(),
  value: integer("value", { mode: "boolean" }).notNull(),
  updatedAt: integer("updated_at").notNull(),
});

export const appSettingsValues = sqliteTable("app_settings_values", {
  key: text("key").primaryKey(),
  value: text("value").notNull(),
  updatedAt: integer("updated_at").notNull(),
});

export const appSettings = sqliteTable("app_settings", {
  id: text("id").primaryKey(),
  caffeinate: integer("caffeinate", { mode: "boolean" })
    .notNull()
    .default(false),
  showKeyboardHints: integer("show_keyboard_hints", { mode: "boolean" })
    .notNull()
    .default(true),
  steerActiveThreadOnEnter: integer("steer_active_thread_on_enter", {
    mode: "boolean",
  })
    .notNull()
    .default(false),
  showUnhandledProviderEvents: integer("show_unhandled_provider_events", {
    mode: "boolean",
  })
    .notNull()
    .default(false),
  codexMemoryEnabled: integer("codex_memory_enabled", { mode: "boolean" })
    .notNull()
    .default(true),
  claudeCodeMemoryEnabled: integer("claude_code_memory_enabled", {
    mode: "boolean",
  })
    .notNull()
    .default(true),
  codexSubagentsDisabled: integer("codex_subagents_disabled", {
    mode: "boolean",
  })
    .notNull()
    .default(false),
  claudeCodeSubagentsDisabled: integer("claude_code_subagents_disabled", {
    mode: "boolean",
  })
    .notNull()
    .default(false),
  claudeCodeWorkflowsDisabled: integer("claude_code_workflows_disabled", {
    mode: "boolean",
  })
    .notNull()
    .default(false),
  keybindingOverrides: text("keybinding_overrides").notNull().default("[]"),
  onboardingCompletedAt: text("onboarding_completed_at"),
  updatedAt: integer("updated_at").notNull(),
});

export const installedPlugins = sqliteTable("plugins", {
  id: text("id").primaryKey(),
  source: text("source").notNull(),
  provenance: text("provenance", {
    enum: ["builtin", "direct", "catalog"],
  })
    .notNull()
    .default("direct"),
  catalogEntryId: text("catalog_entry_id"),
  catalogMarketplaceName: text("catalog_marketplace_name"),
  sourceKind: text("source_kind", {
    enum: ["path", "builtin", "npm", "git"],
  })
    .notNull()
    .default("path"),
  sourcePath: text("source_path"),
  sourceBuiltinName: text("source_builtin_name"),
  sourceNpmPackage: text("source_npm_package"),
  sourceNpmRegistry: text("source_npm_registry"),
  sourceNpmRequestedSpec: text("source_npm_requested_spec"),
  sourceNpmSpecKind: text("source_npm_spec_kind", {
    enum: ["default", "exact", "tag", "range"],
  }),
  sourceGitUrl: text("source_git_url"),
  sourceGitSubdirectory: text("source_git_subdirectory"),
  sourceGitRequestedRef: text("source_git_requested_ref"),
  sourceGitRefKind: text("source_git_ref_kind", {
    enum: ["branch", "tag", "commit"],
  }),
  sourceGitRange: text("source_git_range"),
  sourceGitTagPrefix: text("source_git_tag_prefix"),
  sourceGitResolvedTag: text("source_git_resolved_tag"),
  npmResolvedVersion: text("npm_resolved_version"),
  npmIntegrity: text("npm_integrity"),
  gitResolvedCommit: text("git_resolved_commit"),
  lastUpdateCheckAt: integer("last_update_check_at"),
  availableCompatibleVersion: text("available_compatible_version"),
  newestIncompatibleVersion: text("newest_incompatible_version"),
  updateStatusDetail: text("update_status_detail"),
  lastFailureVersion: text("last_failure_version"),
  lastFailureAt: integer("last_failure_at"),
  lastFailureDetail: text("last_failure_detail"),
  activeArtifactId: text("active_artifact_id").references(
    (): AnySQLiteColumn => pluginArtifacts.id,
  ),
  normalizationVersion: integer("normalization_version").notNull().default(0),
  rootDir: text("root_dir").notNull(),
  version: text("version").notNull(),
  enabled: integer("enabled", { mode: "boolean" }).notNull().default(true),
  removedAt: integer("removed_at"),
  installedAt: integer("installed_at").notNull(),
  updatedAt: integer("updated_at").notNull(),
});

export const pluginArtifacts = sqliteTable(
  "plugin_artifacts",
  {
    id: text("id").primaryKey(),
    pluginId: text("plugin_id").notNull(),
    sourceKind: text("source_kind", { enum: ["npm", "git"] }).notNull(),
    npmResolvedVersion: text("npm_resolved_version"),
    gitResolvedCommit: text("git_resolved_commit"),
    gitCheckoutRoot: text("git_checkout_root"),
    path: text("path").notNull(),
    integrity: text("integrity"),
    contentHash: text("content_hash"),
    validationResult: text("validation_result", {
      enum: ["pending", "valid"],
    }).notNull(),
    createdAt: integer("created_at").notNull(),
    updatedAt: integer("updated_at").notNull(),
    validatedAt: integer("validated_at"),
  },
  (table) => [index("plugin_artifacts_plugin_idx").on(table.pluginId)],
);

export const pluginMarketplaces = sqliteTable("plugin_marketplaces", {
  name: text("name").primaryKey(),
  sourceKind: text("source_kind", { enum: ["https", "git", "path"] })
    .notNull()
    .default("https"),
  manifestUrl: text("manifest_url").notNull(),
  sourceGitRef: text("source_git_ref"),
  sourceGitCommit: text("source_git_commit"),
  manifestJson: text("manifest_json").notNull(),
  statsJson: text("stats_json"),
  etag: text("etag"),
  lastModified: text("last_modified"),
  lastSuccessfulRefreshAt: integer("last_successful_refresh_at"),
  lastAttemptedRefreshAt: integer("last_attempted_refresh_at"),
  lastError: text("last_error"),
  createdAt: integer("created_at").notNull(),
  updatedAt: integer("updated_at").notNull(),
});

export const pluginMarketplaceIcons = sqliteTable(
  "plugin_marketplace_icons",
  {
    marketplaceName: text("marketplace_name").notNull(),
    entryId: text("entry_id").notNull(),
    sourceUrl: text("source_url").notNull(),
    contentType: text("content_type").notNull(),
    etag: text("etag"),
    contentHash: text("content_hash").notNull(),
    bytes: blob("bytes", { mode: "buffer" }).notNull(),
    updatedAt: integer("updated_at").notNull(),
  },
  (table) => [primaryKey({ columns: [table.marketplaceName, table.entryId] })],
);

export const pluginStateSnapshots = sqliteTable(
  "plugin_state_snapshots",
  {
    id: text("id").primaryKey(),
    pluginId: text("plugin_id").notNull(),
    fromArtifactId: text("from_artifact_id"),
    toArtifactId: text("to_artifact_id").notNull(),
    snapshotPath: text("snapshot_path").notNull(),
    databasePath: text("database_path"),
    statePath: text("state_path").notNull(),
    secretsPath: text("secrets_path"),
    registrationPath: text("registration_path"),
    status: text("status", {
      enum: [
        "pending",
        "ready",
        "rollback-pending",
        "restoring",
        "restored",
        "failed",
      ],
    }).notNull(),
    rollbackCandidateVersion: text("rollback_candidate_version"),
    rollbackSourceFingerprint: text("rollback_source_fingerprint"),
    rollbackBbVersion: text("rollback_bb_version"),
    rollbackSdkVersion: text("rollback_sdk_version"),
    rollbackDetail: text("rollback_detail"),
    createdAt: integer("created_at").notNull(),
    retainedUntil: integer("retained_until").notNull(),
    updatedAt: integer("updated_at").notNull(),
  },
  (table) => [
    index("plugin_state_snapshots_plugin_idx").on(table.pluginId),
    index("plugin_state_snapshots_retention_idx").on(table.retainedUntil),
  ],
);

export const pluginKv = sqliteTable(
  "plugin_kv",
  {
    pluginId: text("plugin_id").notNull(),
    key: text("key").notNull(),
    value: text("value").notNull(),
    updatedAt: integer("updated_at").notNull(),
  },
  (table) => [primaryKey({ columns: [table.pluginId, table.key] })],
);

export const pluginSettings = sqliteTable(
  "plugin_settings",
  {
    pluginId: text("plugin_id").notNull(),
    key: text("key").notNull(),
    value: text("value").notNull(),
    updatedAt: integer("updated_at").notNull(),
  },
  (table) => [primaryKey({ columns: [table.pluginId, table.key] })],
);

export const pluginSchedules = sqliteTable(
  "plugin_schedules",
  {
    pluginId: text("plugin_id").notNull(),
    name: text("name").notNull(),
    cron: text("cron").notNull(),
    nextRunAt: integer("next_run_at").notNull(),
    lastRunAt: integer("last_run_at"),
    lastStatus: text("last_status").$type<"running" | "ok" | "error">(),
    lastError: text("last_error"),
    updatedAt: integer("updated_at").notNull(),
  },
  (table) => [primaryKey({ columns: [table.pluginId, table.name] })],
);

export const appTheme = sqliteTable("app_theme", {
  id: text("id").primaryKey(),
  themeId: text("theme_id").notNull(),
  faviconColor: text("favicon_color")
    .$type<FaviconColorPreference>()
    .notNull()
    .default("default"),
  updatedAt: integer("updated_at").notNull(),
});

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
  ],
);

export const environments = sqliteTable(
  "environments",
  {
    id: text("id").primaryKey(),
    name: text("name"),
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
    destroyAttemptId: text("destroy_attempt_id"),
    retireRequestedAt: integer("retire_requested_at"),
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
    uniqueIndex("environments_project_host_path_idx").on(
      table.projectId,
      table.hostId,
      table.path,
    ),
    index("environments_host_path_lookup_idx").on(table.hostId, table.path),
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
    modelOverride: text("model_override"),
    reasoningLevelOverride: text(
      "reasoning_level_override",
    ).$type<ReasoningLevel>(),
    title: text("title"),
    titleFallback: text("title_fallback"),
    sectionId: text("section_id").references(() => threadSections.id, {
      onDelete: "set null",
    }),
    status: text("status", { enum: threadStatusValues })
      .notNull()
      .default("starting"),
    // How a `pending` thread will be established once its first message clears
    // a dispatch attempt: the resolved environment intent, the fork descriptor,
    // the provider-facing input and the `startedOnBehalfOf`/title facts that
    // `requestThreadProvision` needs and that nothing else persists.
    //
    // It lives on the THREAD rather than on the queued message because it
    // describes how to start the thread, not what to say once it has started —
    // and because the live provisioning context is in-memory and only valid
    // while a thread is `starting`, so a thread queued for a week (or across a
    // restart) would otherwise have nothing to start from. Written only when a
    // first message actually queues, and cleared when the thread leaves
    // `pending`, so it is NULL for every thread that started immediately.
    pendingStartContext: text("pending_start_context"),
    parentThreadId: text("parent_thread_id").references(
      (): AnySQLiteColumn => threads.id,
      { onDelete: "set null" },
    ),
    sourceThreadId: text("source_thread_id").references(
      (): AnySQLiteColumn => threads.id,
      { onDelete: "set null" },
    ),
    originKind: text("origin_kind", {
      enum: threadOriginKindValues,
    }),
    originPluginId: text("origin_plugin_id"),
    visibility: text("visibility", { enum: threadVisibilityValues })
      .notNull()
      .default("visible"),
    archivedAt: integer("archived_at"),
    pinnedAt: integer("pinned_at"),
    pinSortKey: text("pin_sort_key"),
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
    index("threads_pin_sort_idx")
      .on(table.archivedAt, table.deletedAt, table.pinSortKey, table.id)
      .where(sql`${table.pinnedAt} IS NOT NULL`),
    index("threads_environment_idx").on(table.environmentId),
    index("threads_parent_idx").on(table.parentThreadId),
    index("threads_source_origin_idx").on(
      table.sourceThreadId,
      table.originKind,
    ),
    index("threads_origin_plugin_archived_idx").on(
      table.originPluginId,
      table.archivedAt,
    ),
    index("threads_section_archived_deleted_idx").on(
      table.sectionId,
      table.archivedAt,
      table.deletedAt,
      table.id,
    ),
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

export const threadTabs = sqliteTable("thread_tabs", {
  threadId: text("thread_id")
    .primaryKey()
    .references(() => threads.id, { onDelete: "cascade" }),
  tabsJson: text("tabs_json").notNull(),
  revision: integer("revision").notNull(),
  updatedAt: integer("updated_at").notNull(),
});

export const threadSections = sqliteTable(
  "thread_sections",
  {
    id: text("id").primaryKey(),
    name: text("name").notNull(),
    createdAt: integer("created_at").notNull(),
    updatedAt: integer("updated_at").notNull(),
  },
  (table) => [uniqueIndex("thread_sections_name_idx").on(table.name)],
);

export const threadSearchSegments = sqliteTable(
  "thread_search_segments",
  {
    id: text("id").primaryKey(),
    threadId: text("thread_id")
      .notNull()
      .references(() => threads.id, { onDelete: "cascade" }),
    sourceKind: text("source_kind").$type<ThreadSearchSourceKind>().notNull(),
    sourceKey: text("source_key").notNull(),
    sourceSeq: integer("source_seq"),
    text: text("text").notNull(),
    createdAt: integer("created_at").notNull(),
    updatedAt: integer("updated_at").notNull(),
  },
  (table) => [
    uniqueIndex("thread_search_segments_source_idx").on(
      table.threadId,
      table.sourceKind,
      table.sourceKey,
    ),
    index("thread_search_segments_thread_source_seq_idx").on(
      table.threadId,
      table.sourceSeq,
    ),
  ],
);

export const threadConversationOutlines = sqliteTable(
  "thread_conversation_outlines",
  {
    threadId: text("thread_id")
      .primaryKey()
      .references(() => threads.id, { onDelete: "cascade" }),
    projectionKey: text("projection_key").notNull(),
    itemsJson: text("items_json").notNull(),
  },
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
    parentToolCallId: text("parent_tool_call_id"),
    data: text("data").notNull().default("{}"),
    createdAt: integer("created_at").notNull(),
  },
  (table) => [
    uniqueIndex("events_thread_sequence_idx").on(
      table.threadId,
      table.sequence,
    ),
    index("events_delegating_item_lookup_idx")
      .on(table.threadId, table.itemId, table.sequence, table.itemKind)
      .where(sql`${table.itemKind} IN ('toolCall', 'delegation')`),
    index("events_plan_steps_thread_sequence_idx")
      .on(table.threadId, table.sequence)
      .where(
        sql`(${table.itemKind} = 'planSteps' AND ${table.type} = 'item/completed') OR ${table.type} = 'turn/plan/updated'`,
      ),
    index("events_parent_tool_call_thread_parent_sequence_idx")
      .on(table.threadId, table.parentToolCallId, table.sequence)
      .where(sql`${table.parentToolCallId} IS NOT NULL`),
    index("events_thread_type_item_kind_sequence_idx").on(
      table.threadId,
      table.type,
      table.itemKind,
      table.sequence,
    ),
    index("events_background_task_thread_type_item_sequence_idx")
      .on(table.threadId, table.type, table.itemId, table.sequence)
      .where(sql`${table.itemKind} = 'backgroundTask'`),
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
    index("events_item_lifecycle_thread_item_sequence_idx")
      .on(table.threadId, table.itemId, table.sequence)
      .where(
        sql`${table.type} IN ('item/started', 'item/completed', 'item/backgroundTask/completed')`,
      ),
    index("events_environment_idx").on(table.environmentId),
    index("events_completed_item_truncation_idx")
      .on(table.itemKind, table.createdAt, table.id)
      .where(sql`${table.type} = 'item/completed'`),
    index("events_thread_state_thread_sequence_idx")
      .on(table.threadId, table.sequence)
      .where(
        sql`${table.type} IN ('thread/goal/updated', 'thread/goal/cleared', 'thread/extensionState/updated')`,
      ),
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
    // JSON `{ kind, subject }` when this row is one of core's own system
    // notices rather than somebody's message; NULL for every ordinary row.
    // Owned by the server, which is the only thing that writes or reads it.
    systemNotice: text("system_notice"),
    threadId: text("thread_id")
      .notNull()
      .references(() => threads.id, { onDelete: "cascade" }),
    content: text("content").notNull(),
    senderThreadId: text("sender_thread_id"),
    model: text("model").notNull(),
    reasoningLevel: text("reasoning_level").notNull(),
    permissionMode: text("permission_mode").$type<PermissionMode>().notNull(),
    serviceTier: text("service_tier").notNull(),
    groupWithNext: integer("group_with_next", { mode: "boolean" })
      .notNull()
      .default(false),
    // Epoch ms this row is scheduled to attempt dispatch. NULL means "as soon
    // as the other waits clear", which is what an ordinary queued row is.
    sendAt: integer("send_at"),
    // JSON `QueuedMessageWaitingOn`: the typed reason this row is queued.
    // NULL for a plain queued row that is simply next in line behind the
    // running turn — including every row written before waits were typed, for
    // which inventing a reason would be a lie.
    //
    // A plugin wait's authored reason lives HERE and nowhere else. There is
    // deliberately no `wait_reason` column: nothing queries on the reason, and
    // every read that renders it already has the whole row in hand.
    waitingOn: text("waiting_on"),
    // Denormalized `plugin:<id>` owner of a plugin wait, NULL otherwise.
    // Unlike the reason, this IS queried — the orphan sweep and the
    // per-plugin release both need "every row this plugin holds" as an
    // indexed equality lookup, which JSON cannot serve. Written only by the
    // same statement that writes `waiting_on`, derived from it, so the two
    // cannot drift.
    waitHolder: text("wait_holder").$type<QueuedMessageWaitHolder>(),
    // Why this row's last DRAIN attempt failed outright, NULL when it has not
    // failed one. Its own column rather than a shape inside `waiting_on`
    // because writing a wait rewrites that column wholesale on every attempt, which
    // would erase a failure recorded there before anybody could read it. The
    // row stays waiting on whatever it was waiting on; this only says what went
    // wrong the last time the drain tried to send it.
    failureReason: text("failure_reason"),
    payloadKind: text("payload_kind")
      .$type<QueuedMessagePayloadKind>()
      .notNull()
      .default("inline"),
    // Set together, and only on a `retry` row: the ORIGINAL request this row
    // re-submits, which attempt it is (2 is the first retry), and why it is
    // being retried in the retrier's words ("Rate limited").
    //
    // The reason is a column of the retry rather than part of `waiting_on`
    // because a retry can wait on the clock, on a plugin, or on nothing, and
    // the reason outlives all three: it is a fact about the retry, not about
    // what is currently holding it, so a re-queue that rewrites the wait must
    // not erase it.
    retryOfTurnRequestId: text("retry_of_turn_request_id"),
    retryAttempt: integer("retry_attempt"),
    retryReason: text("retry_reason"),
    claimedAt: integer("claimed_at"),
    claimToken: text("claim_token"),
    sortKey: text("sort_key").notNull(),
    createdAt: integer("created_at").notNull(),
    updatedAt: integer("updated_at").notNull(),
  },
  (table) => [
    index("queued_thread_messages_thread_created_idx").on(
      table.threadId,
      table.createdAt,
      table.id,
    ),
    index("queued_thread_messages_thread_sort_idx").on(
      table.threadId,
      table.sortKey,
      table.id,
    ),
    // The due-scheduled sweep: "every unclaimed row whose send_at has
    // arrived", ordered by when it came due. Partial on the two liveness
    // predicates so the index holds only rows the sweep can actually act on.
    index("queued_thread_messages_due_idx")
      .on(table.sendAt, table.id)
      .where(
        sql`${table.sendAt} IS NOT NULL AND ${table.claimedAt} IS NULL AND ${table.claimToken} IS NULL`,
      ),
    // Plugin-holder lookup for the orphan sweep and per-plugin release.
    index("queued_thread_messages_wait_holder_idx")
      .on(table.waitHolder, table.id)
      .where(sql`${table.waitHolder} IS NOT NULL`),
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

export const terminalSessions = sqliteTable(
  "terminal_sessions",
  {
    id: text("id").primaryKey(),
    threadId: text("thread_id").references(() => threads.id, {
      onDelete: "cascade",
    }),
    environmentId: text("environment_id").references(() => environments.id, {
      onDelete: "cascade",
    }),
    hostId: text("host_id")
      .notNull()
      .references(() => hosts.id, { onDelete: "cascade" }),
    daemonSessionId: text("daemon_session_id").references(
      () => hostDaemonSessions.id,
      { onDelete: "set null" },
    ),
    title: text("title").notNull(),
    initialCwd: text("initial_cwd").notNull(),
    cols: integer("cols").notNull(),
    rows: integer("rows").notNull(),
    status: text("status").$type<TerminalSessionStatus>().notNull(),
    exitCode: integer("exit_code"),
    closeReason: text("close_reason").$type<TerminalSessionCloseReason>(),
    createdAt: integer("created_at").notNull(),
    updatedAt: integer("updated_at").notNull(),
    lastUserInputAt: integer("last_user_input_at"),
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
    originKind: text("origin_kind")
      .$type<"provider" | "plugin">()
      .notNull()
      .default("provider"),
    turnId: text("turn_id"),
    providerId: text("provider_id"),
    providerThreadId: text("provider_thread_id"),
    providerRequestId: text("provider_request_id"),
    pluginId: text("plugin_id"),
    rendererId: text("renderer_id"),
    status: text("status").$type<PendingInteractionStatus>().notNull(),
    payload: text("payload").notNull(),
    resolution: text("resolution"),
    statusReason: text("status_reason"),
    createdAt: integer("created_at").notNull(),
    expiresAt: integer("expires_at"),
    resolvedAt: integer("resolved_at"),
    updatedAt: integer("updated_at").notNull(),
  },
  (table) => [
    uniqueIndex("pending_interactions_provider_request_idx").on(
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
    index("pending_interactions_plugin_status_created_idx").on(
      table.pluginId,
      table.status,
      table.createdAt,
    ),
  ],
);
