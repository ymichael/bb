import { beforeAll, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { publishedMigrationWhensByTag } from "../src/migration-history.js";
import { defaultAppSettings } from "@bb/domain";
import {
  createQueuedThreadMessage,
  createThread,
  createConnection,
  createProject,
  getAppKeybindingOverrides,
  getAppSettings,
  migrate,
  noopNotifier,
  upsertHost,
  type DbConnection,
  type MigrationWarningLogger,
} from "../src/index.js";
import {
  createMigratedConnection,
  prepareMigratedConnectionTemplate,
} from "./helpers/migrated-connection.js";

type InsertMigrationParameters = [string, number];
type DeleteMigrationParameters = [number];
type DeleteMigrationsParameters = [number, number, number, number];
type TableNameParameters = [string];
type QueuedMessageMigrationInsertParameters = [string, string, number, number];
type ProjectSortKeyMigrationInsertParameters = [string, string, number, number];
type ThreadSortKeyMigrationInsertParameters = [string, string, string, number];

interface IndexNameRow {
  name: string;
}

interface TableNameRow {
  name: string;
}

interface MigrationCreatedAtRow {
  createdAt: number;
}

interface LatestMigrationCreatedAtRow {
  createdAt: number | null;
}

interface MigratedQueuedMessageRow {
  id: string;
  sortKey: string;
  threadId: string;
}

interface MigratedPermissionModeRow {
  id: string;
  permissionMode: string;
}

interface MigratedProjectRow {
  id: string;
  sortKey: string;
}

interface MigratedThreadOriginRow {
  id: string;
  originKind: string | null;
  originPluginId: string | null;
  visibility: string;
}

interface MigratedThreadSortKeyRow {
  id: string;
  sortKey: string | null;
}

interface MigratedManagerCleanupDefaultRow {
  model: string;
  permissionMode: string;
  providerId: string;
  reasoningLevel: string;
  serviceTier: string;
}

interface MigratedManagerCleanupThreadRow {
  id: string;
  parentThreadId: string | null;
}

interface MigratedThreadProvenanceRow {
  id: string;
  originKind: string | null;
  parentThreadId: string | null;
  sourceThreadId: string | null;
}

interface MigratedThreadVisibilityRow {
  id: string;
  visibility: string;
}

interface MigratedTerminalSessionRow {
  id: string;
  threadId: string | null;
  environmentId: string;
  hostId: string;
  daemonSessionId: string | null;
  title: string;
  initialCwd: string;
  cols: number;
  rows: number;
  status: string;
  exitCode: number | null;
  closeReason: string | null;
  createdAt: number;
  updatedAt: number;
  lastUserInputAt: number | null;
}

interface OperationBackfillProjectRow {
  deletedAt: number | null;
}

interface OperationBackfillEnvironmentRow {
  status: string;
}

interface OperationBackfillThreadRow {
  status: string;
}

interface MigratedEventRow {
  createdAt: number;
  data: string;
  environmentId: string | null;
  id: string;
  itemId: string | null;
  itemKind: string | null;
  providerThreadId: string | null;
  scopeKind: string;
  sequence: number;
  threadId: string;
  turnId: string | null;
  type: string;
}

interface MigratedEventDataRow {
  data: string;
}

interface MigratedEventParentRow {
  id: string;
  parentToolCallId: string | null;
}

interface MigratedExperimentRow {
  key: string;
  updatedAt: number;
  value: number;
}

interface MigratedThreadSearchSegmentRow {
  threadId: string;
}

interface MigratedPendingInteractionStatusRow {
  id: string;
  resolvedAt: number | null;
  status: string;
  statusReason: string | null;
  updatedAt: number;
}

interface MigratedPendingInteractionEventStatusRow {
  id: string;
  status: string | null;
  statusReason: string | null;
}

interface PersonalProjectMigrationRow {
  count: number;
}

interface MigrationCountRow {
  count: number;
}

interface MigratedPluginCatalogProvenanceRow {
  id: string;
  provenance: string;
  catalogEntryId: string | null;
}

interface MigratedNamedCatalogProvenanceRow {
  id: string;
  catalogMarketplaceName: string | null;
}

interface MigratedPluginCatalogRow {
  catalogJson: string;
  lastAttemptedRefreshAt: number | null;
}

interface TableInfoRow {
  name: string;
  notnull: number;
}

interface ReadIndexNamesArgs {
  db: DbConnection;
  tableName: string;
}

interface ReplaceAppliedMigrationHashArgs {
  db: DbConnection;
  createdAt: number;
  hash: string;
}

interface RunMigrationFileArgs {
  db: DbConnection;
  migrationPath: string;
}

interface SeedPre0017TerminalSessionMigrationArgs {
  db: DbConnection;
}

interface SeedEventLargeValueBackfillEventArgs {
  createdAt: number;
  data: string;
  id: string;
  itemId: string;
  itemKind: string;
  sequence: number;
  type?: string;
}

interface SeededLargeValueBackfillValues {
  commandOutput: string;
  firstDiff: string;
  secondDiff: string;
  toolResult: { body: string };
  webFetchResult: string;
  webSearchResult: string;
}

const __dirname = dirname(fileURLToPath(import.meta.url));

const latestMigrationWhen = Math.max(
  ...(
    JSON.parse(
      readFileSync(
        resolve(__dirname, "../drizzle/meta/_journal.json"),
        "utf-8",
      ),
    ) as { entries: { when: number }[] }
  ).entries.map((entry) => entry.when),
);

function restoreWideExperimentsTable(db: DbConnection): void {
  const columns = db.$client
    .prepare<[], TableInfoRow>("PRAGMA table_info(system_experiments)")
    .all();
  if (!columns.some((column) => column.name === "key")) return;

  db.$client.exec(`
    CREATE TABLE __wide_system_experiments (
      id text PRIMARY KEY NOT NULL,
      claude_code_mock_cli_traffic integer NOT NULL,
      new_onboarding integer DEFAULT false NOT NULL,
      tools_hub integer DEFAULT false NOT NULL,
      updated_at integer NOT NULL
    );
    INSERT INTO __wide_system_experiments (
      id,
      claude_code_mock_cli_traffic,
      new_onboarding,
      tools_hub,
      updated_at
    ) VALUES (
      'current',
      COALESCE((SELECT value FROM system_experiments WHERE key = 'claudeCodeMockCliTraffic'), false),
      COALESCE((SELECT value FROM system_experiments WHERE key = 'newOnboarding'), false),
      COALESCE((SELECT value FROM system_experiments WHERE key = 'toolsHub'), false),
      COALESCE((SELECT MAX(updated_at) FROM system_experiments), 0)
    );
    DROP TABLE system_experiments;
    ALTER TABLE __wide_system_experiments RENAME TO system_experiments;
  `);
}

function dropAppSettingsValuesTable(db: DbConnection): void {
  db.$client.prepare("DROP TABLE IF EXISTS app_settings_values").run();
}

function dropThreadConversationOutlinesTable(db: DbConnection): void {
  db.$client.prepare("DROP TABLE IF EXISTS thread_conversation_outlines").run();
}

function dropRewindAddedTables(db: DbConnection): void {
  dropThreadConversationOutlinesTable(db);
  db.$client.prepare("DROP TABLE IF EXISTS thread_tabs").run();
  db.$client.prepare("DROP TABLE IF EXISTS automation_runs").run();
  db.$client.prepare("DROP TABLE IF EXISTS automations").run();
  db.$client.prepare("DROP TABLE IF EXISTS app_theme").run();
  db.$client.prepare("DROP TABLE IF EXISTS app_settings").run();
  dropAppSettingsValuesTable(db);
  db.$client.prepare("DROP TABLE IF EXISTS plugin_state_snapshots").run();
  db.$client.prepare("DROP TABLE IF EXISTS plugin_artifacts").run();
  db.$client.prepare("DROP TABLE IF EXISTS plugin_catalog").run();
  db.$client.prepare("DROP TABLE IF EXISTS marketplaces").run();
  dropMarketplaceCatalogSchema(db);
  dropEventParentToolCallIdColumn(db);
  dropQueueReworkSchema(db);
  db.$client.prepare("DROP TABLE IF EXISTS plugins").run();
  db.$client.prepare("DROP TABLE IF EXISTS plugin_kv").run();
  db.$client.prepare("DROP TABLE IF EXISTS plugin_settings").run();
  db.$client.prepare("DROP TABLE IF EXISTS plugin_schedules").run();
  db.$client
    .prepare("ALTER TABLE hosts DROP COLUMN last_rejected_protocol_version")
    .run();
  dropHostMaxPermissionModeColumn(db);
  dropEnvironmentRetireRequestedAtColumn(db);
  dropPluginArtifactGitCheckoutRootColumn(db);
  dropThreadSectionSchema(db);
  restoreWideExperimentsTable(db);
  const experimentColumns = new Set(
    db.$client
      .prepare<[], TableInfoRow>("PRAGMA table_info(system_experiments)")
      .all()
      .map((column) => column.name),
  );
  if (experimentColumns.has("plugins")) {
    db.$client
      .prepare("ALTER TABLE system_experiments DROP COLUMN plugins")
      .run();
  }
  if (experimentColumns.has("bb_connect")) {
    db.$client
      .prepare("ALTER TABLE system_experiments DROP COLUMN bb_connect")
      .run();
  }
  if (experimentColumns.has("multi_machine")) {
    db.$client
      .prepare("ALTER TABLE system_experiments DROP COLUMN multi_machine")
      .run();
  }
  if (experimentColumns.has("thread_splits")) {
    db.$client
      .prepare("ALTER TABLE system_experiments DROP COLUMN thread_splits")
      .run();
  }
  dropSideChatPluginExperimentColumn(db);
  dropToolsHubExperimentColumn(db);
  dropNewOnboardingExperimentColumn(db);
  dropSteerActiveThreadOnEnterColumn(db);
  dropOnboardingCompletedAtColumn(db);
  db.$client.prepare("ALTER TABLE threads DROP COLUMN visibility").run();
  db.$client.exec("DROP INDEX IF EXISTS `threads_origin_plugin_archived_idx`");
  db.$client.prepare("ALTER TABLE threads DROP COLUMN origin_plugin_id").run();
  dropProjectGitRemoteUrlColumn(db);
}

function requirePublishedMigrationWhen(tag: string): number {
  const when = publishedMigrationWhensByTag.get(tag);
  if (when === undefined) {
    throw new Error(`No published migration timestamp for ${tag}`);
  }

  return when;
}

const baselineWhen = requirePublishedMigrationWhen("0000_baseline");
const publishedTerminalSessionUserInputWhen = requirePublishedMigrationWhen(
  "0001_terminal_session_user_input",
);
const closedSessionPruneIndexesWhen = requirePublishedMigrationWhen(
  "0002_closed_session_prune_indexes",
);
const threadDynamicContextFileStatesWhen = 1779139400002;
const commandLookupIndexesWhen = 1779943370189;
const threadPinningMigrationWhen = 1779990051923;
const operationStateBackfillMigrationWhen = 1780687798957;
const eventProducerColumnsMigrationWhen = 1780692763264;
const terminalSessionRuntimeStateHonestyWhen = 1780718665310;
const hostDaemonSessionObservabilityMigrationWhen = 1780719536955;
const threadTypeRemovalMigrationWhen = 1780973302146;
const threadSearchMigrationWhen = 1781660000001;
const threadSearchRowidFtsMigrationWhen = 1781660000002;
const branchLocalThreadSearchMigrationWhen = 1781403656070;
const branchLocalThreadSearchRowidFtsMigrationWhen = 1781403656071;
const rowidThreadSearchMigrationHash =
  "025358fe89253aec7f5bd970dc3eb88d0e834f0d58fb9d75329a5d39899340f4";
const legacyExperimentsMigrationWhen = 1781299832942;
const eventLargeValuesMigrationWhen = 1781403656069;
const eventLargeValuesRestoreMigrationWhen = 1781557200000;
const cleanupModeDropMigrationWhen = 1781557300000;
const stopRequestedAtDropMigrationWhen = 1781557400000;
const cleanupRequestedAtDropMigrationWhen = 1781557500000;
const threadSourceOriginMigrationWhen = 1781660000000;
const threadlessTerminalSessionsMigrationWhen = 1782173519934;
const threadSectionsMigrationWhen = 1782252763916;
const threadSectionsRepairMigrationWhen = 1784257485616;
const queuedMessageGroupingMigrationWhen = 1782273194188;
const pendingInteractionsMigrationWhen = 1783626227375;
const permissionModesMigrationWhen = 1784311522462;
const branchLocalThreadTabsMigrationWhen = 1783633750817;
const eventParentToolCallMigrationWhen = 1787181956957;
const eventParentToolCallPreJsonValidMigrationHash =
  "79d39e7b68d1db8ba02614fe4cc227cc0c154d77c7183f2e37ed2d8475412993";
const eventLargeValuesPreOptimizationHash =
  "bc111f5134183c37cf135af70231ec5a79823f9868818fdd8377e1ab3c05a23f";
const queuedMessageSortKeyMigrationPath = resolve(
  __dirname,
  "..",
  "drizzle",
  "0004_wild_justice.sql",
);
const pluginCatalogMigrationPath = resolve(
  __dirname,
  "..",
  "drizzle",
  "0072_bizarre_the_liberteens.sql",
);
const sideChatVisibilityBackfillMigrationPath = resolve(
  __dirname,
  "..",
  "drizzle",
  "0079_side_chat_plugin.sql",
);
const sideChatPluginOnlyMigrationPath = resolve(
  __dirname,
  "..",
  "drizzle",
  "0084_side_chat_plugin_only.sql",
);
const experimentKeyValueMigrationPath = resolve(
  __dirname,
  "..",
  "drizzle",
  "0090_equal_reaper.sql",
);
const appSettingsKeyValueMigrationPath = resolve(
  __dirname,
  "..",
  "drizzle",
  "0102_app_settings_key_value.sql",
);
const steerOnEnterDefaultMigrationPath = resolve(
  __dirname,
  "..",
  "drizzle",
  "0112_steer_on_enter_default.sql",
);
const providerSettingsToPluginsMigrationPath = resolve(
  __dirname,
  "..",
  "drizzle",
  "0105_provider_settings_to_plugins.sql",
);
const retireRequestedAtMigrationPath = resolve(
  __dirname,
  "..",
  "drizzle",
  "0091_daffy_dark_phoenix.sql",
);
const pluginArtifactCheckoutRootMigrationPath = resolve(
  __dirname,
  "..",
  "drizzle",
  "0094_mighty_polaris.sql",
);
const namedMarketplaceCatalogMigrationPath = resolve(
  __dirname,
  "..",
  "drizzle",
  "0095_normal_elektra.sql",
);
const curatedMarketplaceRenameMigrationPath = resolve(
  __dirname,
  "..",
  "drizzle",
  "0098_rename_curated_marketplace.sql",
);
const sidebarOrderingMigrationPath = resolve(
  __dirname,
  "..",
  "drizzle",
  "0005_strong_exodus.sql",
);
const threadPinningMigrationPath = resolve(
  __dirname,
  "..",
  "drizzle",
  "0008_thread_pinning.sql",
);
const pendingInteractionSchemaHonestyMigrationPath = resolve(
  __dirname,
  "..",
  "drizzle",
  "0019_pending_interactions_schema_honesty.sql",
);
const eventLargeValuesMigrationPath = resolve(
  __dirname,
  "..",
  "drizzle",
  "0031_mysterious_zaran.sql",
);
function closeConnection(db: DbConnection): void {
  db.$client.close();
}

function restoreSideChatPluginExperimentColumn(db: DbConnection): void {
  const columns = db.$client
    .prepare<[], TableInfoRow>("PRAGMA table_info(system_experiments)")
    .all();
  if (!columns.some((column) => column.name === "side_chat_plugin")) {
    db.$client.exec(
      "ALTER TABLE `system_experiments` ADD `side_chat_plugin` integer DEFAULT false NOT NULL",
    );
  }
}

function dropSideChatPluginExperimentColumn(db: DbConnection): void {
  const columns = db.$client
    .prepare<[], TableInfoRow>("PRAGMA table_info(system_experiments)")
    .all();
  if (columns.some((column) => column.name === "side_chat_plugin")) {
    db.$client
      .prepare("ALTER TABLE system_experiments DROP COLUMN side_chat_plugin")
      .run();
  }
}

function restoreLegacyThreadOriginColumn(db: DbConnection): void {
  const columns = db.$client
    .prepare<[], TableInfoRow>("PRAGMA table_info(threads)")
    .all();
  if (!columns.some((column) => column.name === "child_origin")) {
    db.$client
      .prepare("ALTER TABLE threads ADD COLUMN child_origin text")
      .run();
  }
}

function restorePluginsExperimentColumn(db: DbConnection): void {
  const columns = db.$client
    .prepare<[], TableInfoRow>("PRAGMA table_info(system_experiments)")
    .all();
  if (!columns.some((column) => column.name === "plugins")) {
    db.$client
      .prepare(
        "ALTER TABLE system_experiments ADD `plugins` integer DEFAULT false NOT NULL",
      )
      .run();
  }
}

function dropToolsHubExperimentColumn(db: DbConnection): void {
  const columns = db.$client
    .prepare<[], TableInfoRow>("PRAGMA table_info(system_experiments)")
    .all();
  if (columns.some((column) => column.name === "tools_hub")) {
    db.$client
      .prepare("ALTER TABLE system_experiments DROP COLUMN tools_hub")
      .run();
  }
}

function dropNewOnboardingExperimentColumn(db: DbConnection): void {
  const columns = db.$client
    .prepare<[], TableInfoRow>("PRAGMA table_info(system_experiments)")
    .all();
  if (columns.some((column) => column.name === "new_onboarding")) {
    db.$client
      .prepare("ALTER TABLE system_experiments DROP COLUMN new_onboarding")
      .run();
  }
}

function dropHostMaxPermissionModeColumn(db: DbConnection): void {
  const columns = db.$client
    .prepare<[], TableInfoRow>("PRAGMA table_info(hosts)")
    .all();
  if (columns.some((column) => column.name === "max_permission_mode")) {
    db.$client
      .prepare("ALTER TABLE hosts DROP COLUMN max_permission_mode")
      .run();
  }
}

function dropSteerActiveThreadOnEnterColumn(db: DbConnection): void {
  const columns = db.$client
    .prepare<[], TableInfoRow>("PRAGMA table_info(app_settings)")
    .all();
  if (
    columns.some((column) => column.name === "steer_active_thread_on_enter")
  ) {
    db.$client
      .prepare(
        "ALTER TABLE app_settings DROP COLUMN steer_active_thread_on_enter",
      )
      .run();
  }
}

function dropOnboardingCompletedAtColumn(db: DbConnection): void {
  const columns = db.$client
    .prepare<[], TableInfoRow>("PRAGMA table_info(app_settings)")
    .all();
  if (columns.some((column) => column.name === "onboarding_completed_at")) {
    db.$client
      .prepare("ALTER TABLE app_settings DROP COLUMN onboarding_completed_at")
      .run();
  }
}

function resetMigrationsAfterThreadSearch(db: DbConnection): void {
  restoreLegacyThreadOriginColumn(db);
  dropRewindAddedTables(db);
  db.$client
    .prepare<[number]>("DELETE FROM __drizzle_migrations WHERE created_at > ?")
    .run(threadSearchRowidFtsMigrationWhen);
}

function dropMarketplaceCatalogSchema(db: DbConnection): void {
  db.$client.prepare("DROP TABLE IF EXISTS plugin_marketplace_icons").run();
  db.$client.prepare("DROP TABLE IF EXISTS plugin_marketplaces").run();
  const columns = new Set(
    db.$client
      .prepare<[], TableInfoRow>("PRAGMA table_info(plugins)")
      .all()
      .map((column) => column.name),
  );
  for (const column of [
    "catalog_marketplace_name",
    "source_git_range",
    "source_git_tag_prefix",
    "source_git_resolved_tag",
  ]) {
    if (columns.has(column)) {
      db.$client.prepare(`ALTER TABLE plugins DROP COLUMN ${column}`).run();
    }
  }
}

function dropEventToolNameColumn(db: DbConnection): void {
  dropThreadConversationOutlinesTable(db);
  db.$client.exec("DROP INDEX IF EXISTS events_delegating_item_lookup_idx");
  db.$client.exec("DROP INDEX IF EXISTS events_plan_steps_thread_sequence_idx");
  // The same rewind also rewinds the later deferred-message table (0108).
  db.$client.prepare("DROP TABLE IF EXISTS deferred_thread_messages").run();
  // Generated columns are omitted from table_info but included in table_xinfo.
  const columns = db.$client
    .prepare<[], TableInfoRow>("PRAGMA table_xinfo(events)")
    .all();
  if (columns.some((column) => column.name === "tool_name")) {
    db.$client.exec(
      "DROP INDEX IF EXISTS events_todo_tool_call_thread_tool_sequence_idx",
    );
    db.$client.prepare("ALTER TABLE events DROP COLUMN tool_name").run();
  }
}

function dropEventParentToolCallIdColumn(db: DbConnection): void {
  dropEventToolNameColumn(db);
  const columns = db.$client
    .prepare<[], TableInfoRow>("PRAGMA table_info(events)")
    .all();
  if (columns.some((column) => column.name === "parent_tool_call_id")) {
    db.$client.exec(
      "DROP INDEX IF EXISTS events_parent_tool_call_thread_parent_sequence_idx",
    );
    db.$client
      .prepare("ALTER TABLE events DROP COLUMN parent_tool_call_id")
      .run();
  }
}

function dropMarketplaceStatsColumn(db: DbConnection): void {
  const columns = db.$client
    .prepare<[], TableInfoRow>("PRAGMA table_info(plugin_marketplaces)")
    .all();
  if (columns.some((column) => column.name === "stats_json")) {
    db.$client
      .prepare("ALTER TABLE plugin_marketplaces DROP COLUMN stats_json")
      .run();
  }
}

/**
 * Undo migration 0110, the dispatch-queue rework.
 *
 * 0110 adds the queue's wait columns (schedule, typed wait, wait holder,
 * payload kind and its retry reference), the system-notice and failure-reason
 * sidecars, their two partial indexes, and the thread's pending start
 * context.
 * A rewind that clears its journal row must remove all of them before the
 * replay's ADDs hit a table that already has them.
 *
 * The table 0110 DROPs (`deferred_thread_messages`, added by 0108) needs
 * nothing here. Every rewind that clears 0110's journal row also clears
 * 0108's, so the replay recreates the table before 0110 drops it again.
 */
function dropQueueReworkSchema(db: DbConnection): void {
  // Indexes first: SQLite refuses to drop a column an existing index names.
  for (const index of [
    "queued_thread_messages_due_idx",
    "queued_thread_messages_wait_holder_idx",
  ]) {
    db.$client.prepare(`DROP INDEX IF EXISTS ${index}`).run();
  }
  const queuedColumns = db.$client
    .prepare<[], TableInfoRow>("PRAGMA table_info(queued_thread_messages)")
    .all();
  for (const name of [
    "system_notice",
    "send_at",
    "waiting_on",
    "wait_holder",
    "failure_reason",
    "payload_kind",
    "retry_of_turn_request_id",
    "retry_attempt",
    "retry_reason",
  ]) {
    if (!queuedColumns.some((column) => column.name === name)) continue;
    db.$client
      .prepare(`ALTER TABLE queued_thread_messages DROP COLUMN ${name}`)
      .run();
  }
  const threadColumns = db.$client
    .prepare<[], TableInfoRow>("PRAGMA table_info(threads)")
    .all();
  if (threadColumns.some((column) => column.name === "pending_start_context")) {
    db.$client
      .prepare("ALTER TABLE threads DROP COLUMN pending_start_context")
      .run();
  }
}

function dropEnvironmentNameColumn(db: DbConnection): void {
  db.$client.prepare("ALTER TABLE environments DROP COLUMN name").run();
}

function dropEnvironmentDestroyAttemptIdColumn(db: DbConnection): void {
  db.$client
    .prepare("ALTER TABLE environments DROP COLUMN destroy_attempt_id")
    .run();
}

function dropPluginArtifactGitCheckoutRootColumn(db: DbConnection): void {
  const columns = db.$client
    .prepare<[], TableInfoRow>("PRAGMA table_info(plugin_artifacts)")
    .all();
  if (columns.some((column) => column.name === "git_checkout_root")) {
    db.$client
      .prepare("ALTER TABLE plugin_artifacts DROP COLUMN git_checkout_root")
      .run();
  }
}

function dropEnvironmentRetireRequestedAtColumn(db: DbConnection): void {
  const columns = db.$client
    .prepare<[], TableInfoRow>("PRAGMA table_info(environments)")
    .all();
  if (columns.some((column) => column.name === "retire_requested_at")) {
    db.$client
      .prepare("ALTER TABLE environments DROP COLUMN retire_requested_at")
      .run();
  }
}

function restoreEnvironmentCleanupModeColumn(db: DbConnection): void {
  db.$client
    .prepare("ALTER TABLE environments ADD COLUMN cleanup_mode text")
    .run();
}

function restoreEnvironmentCleanupRequestedAtColumn(db: DbConnection): void {
  const columns = db.$client
    .prepare<[], TableInfoRow>("PRAGMA table_info(environments)")
    .all()
    .map((row) => row.name);
  if (!columns.includes("cleanup_requested_at")) {
    db.$client
      .prepare(
        "ALTER TABLE environments ADD COLUMN cleanup_requested_at integer",
      )
      .run();
  }
  db.$client
    .prepare(
      "CREATE INDEX IF NOT EXISTS environments_cleanup_requested_idx ON environments (cleanup_requested_at)",
    )
    .run();
}

function restoreThreadStopRequestedAtColumn(db: DbConnection): void {
  db.$client
    .prepare("ALTER TABLE threads ADD COLUMN stop_requested_at integer")
    .run();
}

function dropQueuedMessageSenderThreadIdColumn(db: DbConnection): void {
  db.$client
    .prepare("ALTER TABLE queued_thread_messages DROP COLUMN sender_thread_id")
    .run();
}

function dropPost0023Tables(db: DbConnection): void {
  dropEventParentToolCallIdColumn(db);
  dropQueueReworkSchema(db);
  dropEnvironmentRetireRequestedAtColumn(db);
  dropPluginArtifactGitCheckoutRootColumn(db);
  dropProjectGitRemoteUrlColumn(db);
  db.$client.prepare("DROP TABLE IF EXISTS thread_tabs").run();
  db.$client.exec(`
    DROP TRIGGER IF EXISTS thread_search_segments_after_text_update;
    DROP TRIGGER IF EXISTS thread_search_segments_after_delete;
    DROP TRIGGER IF EXISTS thread_search_segments_after_insert;
    DROP TABLE IF EXISTS thread_search_segments_fts;
    DROP TABLE IF EXISTS thread_search_segments;
  `);

  for (const table of [
    "workflow_run_events",
    "workflow_run_operations",
    "workflow_runs",
    "project_workflow_policies",
    "system_experiments",
    "event_large_values",
  ]) {
    db.$client.prepare(`DROP TABLE IF EXISTS ${table}`).run();
  }

  dropThreadSectionSchema(db);
}

function dropProjectGitRemoteUrlColumn(db: DbConnection): void {
  const columns = db.$client
    .prepare<[], TableInfoRow>("PRAGMA table_info(projects)")
    .all();
  if (columns.some((column) => column.name === "git_remote_url")) {
    db.$client.prepare("ALTER TABLE projects DROP COLUMN git_remote_url").run();
  }
}

function dropThreadSectionSchema(db: DbConnection): void {
  db.$client.exec("DROP INDEX IF EXISTS threads_folder_archived_deleted_idx;");
  db.$client.exec("DROP INDEX IF EXISTS threads_section_archived_deleted_idx;");
  const threadColumns = db.$client
    .prepare<[], TableInfoRow>("PRAGMA table_info(threads)")
    .all();
  if (threadColumns.some((row) => row.name === "section_id")) {
    db.$client.prepare("ALTER TABLE threads DROP COLUMN section_id").run();
  }
  db.$client.exec("DROP TABLE IF EXISTS thread_sections;");
}

function restorePre0022ThreadTypeSchema(db: DbConnection): void {
  db.$client.exec(`
    ALTER TABLE project_execution_defaults
      ADD COLUMN thread_type text DEFAULT 'standard' NOT NULL;
    DROP INDEX project_execution_defaults_project_idx;
    CREATE UNIQUE INDEX project_execution_defaults_project_thread_type_idx
      ON project_execution_defaults (project_id, thread_type);
    CREATE INDEX project_execution_defaults_project_idx
      ON project_execution_defaults (project_id);

    ALTER TABLE threads ADD COLUMN type text DEFAULT 'standard' NOT NULL;
    ALTER TABLE threads ADD COLUMN sort_key text;
    CREATE INDEX threads_project_type_sort_idx
      ON threads (project_id, type, sort_key, id);

    -- Drop columns/indexes added by migrations after this restore point so the
    -- forward replay re-applies them without duplicate-column errors.
    DROP INDEX IF EXISTS threads_source_origin_idx;
    ALTER TABLE threads DROP COLUMN source_thread_id;
    ALTER TABLE threads DROP COLUMN origin_kind;
  `);
  const threadColumns = db.$client
    .prepare<[], TableInfoRow>("PRAGMA table_info(threads)")
    .all();
  if (threadColumns.some((row) => row.name === "child_origin")) {
    db.$client.prepare("ALTER TABLE threads DROP COLUMN child_origin").run();
  }
}

function readIndexNames(args: ReadIndexNamesArgs): string[] {
  return args.db.$client
    .prepare<TableNameParameters, IndexNameRow>(
      `
        SELECT name
        FROM sqlite_master
        WHERE type = 'index'
          AND tbl_name = ?
        ORDER BY name
      `,
    )
    .all(args.tableName)
    .map((row) => row.name);
}

function readTableNames(db: DbConnection): string[] {
  return db.$client
    .prepare<[], TableNameRow>(
      `
        SELECT name
        FROM sqlite_master
        WHERE type = 'table'
        ORDER BY name
      `,
    )
    .all()
    .map((row) => row.name);
}

function readLatestAppliedMigrationCreatedAt(db: DbConnection): number {
  const row = db.$client
    .prepare<[], LatestMigrationCreatedAtRow>(
      `
        SELECT MAX(created_at) AS createdAt
        FROM __drizzle_migrations
      `,
    )
    .get();
  const createdAt = row?.createdAt;
  if (typeof createdAt !== "number") {
    throw new Error("Expected at least one applied migration timestamp");
  }
  return createdAt;
}

function readAppliedMigrationCreatedAts(db: DbConnection): number[] {
  return db.$client
    .prepare<[], MigrationCreatedAtRow>(
      `
        SELECT created_at AS createdAt
        FROM __drizzle_migrations
        ORDER BY created_at
      `,
    )
    .all()
    .map((row) => row.createdAt);
}

function replaceAppliedMigrationHash(
  args: ReplaceAppliedMigrationHashArgs,
): void {
  args.db.$client
    .prepare<DeleteMigrationParameters>(
      `
        DELETE FROM __drizzle_migrations
        WHERE created_at = ?
      `,
    )
    .run(args.createdAt);
  args.db.$client
    .prepare<InsertMigrationParameters>(
      `
        INSERT INTO __drizzle_migrations (hash, created_at)
        VALUES (?, ?)
      `,
    )
    .run(args.hash, args.createdAt);
}

function runMigrationFile(args: RunMigrationFileArgs): void {
  const migrationSql = readFileSync(args.migrationPath, "utf-8");

  const statements = migrationSql
    .split("--> statement-breakpoint")
    .map((statement) => statement.trim())
    .filter((statement) => statement.length > 0);

  for (const statement of statements) {
    args.db.$client.exec(statement);
  }
}

function markEventLargeValuesMigrationUnapplied(db: DbConnection): void {
  db.$client.prepare("DROP TABLE IF EXISTS event_large_values").run();
  restoreEnvironmentCleanupModeColumn(db);
  restoreEnvironmentCleanupRequestedAtColumn(db);
  restoreThreadStopRequestedAtColumn(db);
  dropThreadSectionSchema(db);
  db.$client
    .prepare<DeleteMigrationParameters>(
      `
        DELETE FROM __drizzle_migrations
        WHERE created_at >= ?
      `,
    )
    .run(eventLargeValuesMigrationWhen);
  db.$client.prepare("DROP INDEX IF EXISTS `threads_source_origin_idx`").run();
  db.$client
    .prepare("ALTER TABLE `threads` DROP COLUMN `source_thread_id`")
    .run();
  db.$client.prepare("ALTER TABLE `threads` DROP COLUMN `origin_kind`").run();
  const threadColumns = db.$client
    .prepare<[], TableInfoRow>("PRAGMA table_info(threads)")
    .all();
  if (threadColumns.some((row) => row.name === "child_origin")) {
    db.$client.prepare("ALTER TABLE threads DROP COLUMN child_origin").run();
  }
  db.$client.exec(`
    DROP TRIGGER IF EXISTS thread_search_segments_after_text_update;
    DROP TRIGGER IF EXISTS thread_search_segments_after_delete;
    DROP TRIGGER IF EXISTS thread_search_segments_after_insert;
    DROP TABLE IF EXISTS thread_search_segments_fts;
    DROP TABLE IF EXISTS thread_search_segments;
  `);
}

function seedEventLargeValueBackfillThread(db: DbConnection): void {
  db.$client.exec(`
    INSERT INTO projects (id, name, created_at, updated_at)
    VALUES ('proj_large_value_backfill', 'Large Value Backfill', 1000, 1000);

    INSERT INTO threads (
      id,
      project_id,
      provider_id,
      latest_attention_at,
      created_at,
      updated_at
    )
    VALUES (
      'thr_large_value_backfill',
      'proj_large_value_backfill',
      'codex',
      1000,
      1000,
      1000
    );
  `);
}

function seedEventLargeValueBackfillEvent(
  db: DbConnection,
  args: SeedEventLargeValueBackfillEventArgs,
): void {
  db.$client
    .prepare<[string, number, string, string, string, string, number]>(
      `
        INSERT INTO events (
          id,
          thread_id,
          scope_kind,
          turn_id,
          sequence,
          type,
          item_id,
          item_kind,
          data,
          created_at
        )
        VALUES (
          ?,
          'thr_large_value_backfill',
          'turn',
          'turn_large_value_backfill',
          ?,
          ?,
          ?,
          ?,
          ?,
          ?
        )
      `,
    )
    .run(
      args.id,
      args.sequence,
      args.type ?? "item/completed",
      args.itemId,
      args.itemKind,
      args.data,
      args.createdAt,
    );
}

function seedEventLargeValueBackfillEvents(
  db: DbConnection,
): SeededLargeValueBackfillValues {
  const values: SeededLargeValueBackfillValues = {
    commandOutput: "command output ".repeat(48),
    toolResult: { body: "tool result ".repeat(48) },
    webFetchResult: "web fetch result ".repeat(40),
    webSearchResult: "web search result ".repeat(40),
    firstDiff: "first diff ".repeat(60),
    secondDiff: "second diff ".repeat(60),
  };

  seedEventLargeValueBackfillEvent(db, {
    id: "evt_large_command_output",
    itemId: "cmd_large",
    itemKind: "commandExecution",
    sequence: 1,
    createdAt: 2001,
    data: JSON.stringify({
      item: {
        id: "cmd_large",
        type: "commandExecution",
        aggregatedOutput: values.commandOutput,
      },
    }),
  });
  seedEventLargeValueBackfillEvent(db, {
    id: "evt_large_tool_result",
    itemId: "tool_large",
    itemKind: "toolCall",
    sequence: 2,
    createdAt: 2002,
    data: JSON.stringify({
      item: {
        id: "tool_large",
        type: "toolCall",
        result: values.toolResult,
      },
    }),
  });
  seedEventLargeValueBackfillEvent(db, {
    id: "evt_large_web_fetch",
    itemId: "web_fetch_large",
    itemKind: "webFetch",
    sequence: 3,
    createdAt: 2003,
    data: JSON.stringify({
      item: {
        id: "web_fetch_large",
        type: "webFetch",
        resultText: values.webFetchResult,
      },
    }),
  });
  seedEventLargeValueBackfillEvent(db, {
    id: "evt_large_web_search",
    itemId: "web_search_large",
    itemKind: "webSearch",
    sequence: 4,
    createdAt: 2004,
    data: JSON.stringify({
      item: {
        id: "web_search_large",
        type: "webSearch",
        resultText: values.webSearchResult,
      },
    }),
  });
  seedEventLargeValueBackfillEvent(db, {
    id: "evt_large_file_diffs",
    itemId: "file_large",
    itemKind: "fileChange",
    sequence: 5,
    createdAt: 2005,
    data: JSON.stringify({
      item: {
        id: "file_large",
        type: "fileChange",
        changes: [
          { path: "a.ts", diff: values.firstDiff },
          { path: "b.ts", diff: "small diff" },
          { path: "c.ts", diff: values.secondDiff },
        ],
      },
    }),
  });

  return values;
}

function readMigratedEventData(db: DbConnection, eventId: string): string {
  const row = db.$client
    .prepare<[string], MigratedEventDataRow>(
      `
        SELECT data
        FROM events
        WHERE id = ?
      `,
    )
    .get(eventId);
  if (!row) {
    throw new Error(`Expected migrated event ${eventId}`);
  }
  return row.data;
}

function expectEventLargeValuesInline(
  db: DbConnection,
  values: SeededLargeValueBackfillValues,
): void {
  const commandData = JSON.parse(
    readMigratedEventData(db, "evt_large_command_output"),
  );
  expect(commandData.item.aggregatedOutput).toBe(values.commandOutput);
  expect(commandData.item.truncation).toBeUndefined();

  const toolData = JSON.parse(
    readMigratedEventData(db, "evt_large_tool_result"),
  );
  expect(toolData.item.result).toEqual(values.toolResult);
  expect(toolData.item.truncation).toBeUndefined();

  const webFetchData = JSON.parse(
    readMigratedEventData(db, "evt_large_web_fetch"),
  );
  expect(webFetchData.item.resultText).toBe(values.webFetchResult);
  expect(webFetchData.item.truncation).toBeUndefined();

  const webSearchData = JSON.parse(
    readMigratedEventData(db, "evt_large_web_search"),
  );
  expect(webSearchData.item.resultText).toBe(values.webSearchResult);
  expect(webSearchData.item.truncation).toBeUndefined();

  const fileData = JSON.parse(
    readMigratedEventData(db, "evt_large_file_diffs"),
  );
  expect(fileData.item.changes).toEqual([
    { path: "a.ts", diff: values.firstDiff },
    { path: "b.ts", diff: "small diff" },
    { path: "c.ts", diff: values.secondDiff },
  ]);
}

function seedPre0017TerminalSessionMigration(
  args: SeedPre0017TerminalSessionMigrationArgs,
): void {
  args.db.$client.pragma("foreign_keys = OFF");
  try {
    args.db.$client.exec(`
      DROP TABLE terminal_sessions;
      CREATE TABLE terminal_sessions (
        id text PRIMARY KEY NOT NULL,
        thread_id text NOT NULL,
        environment_id text NOT NULL,
        host_id text NOT NULL,
        daemon_session_id text,
        title text NOT NULL,
        initial_cwd text NOT NULL,
        current_cwd text,
        cols integer NOT NULL,
        rows integer NOT NULL,
        status text NOT NULL,
        exit_code integer,
        close_reason text,
        created_at integer NOT NULL,
        updated_at integer NOT NULL,
        last_user_input_at integer,
        last_connected_at integer,
        exited_at integer,
        FOREIGN KEY (thread_id) REFERENCES threads(id) ON DELETE cascade,
        FOREIGN KEY (environment_id) REFERENCES environments(id) ON DELETE cascade,
        FOREIGN KEY (host_id) REFERENCES hosts(id) ON DELETE cascade,
        FOREIGN KEY (daemon_session_id) REFERENCES host_daemon_sessions(id) ON DELETE set null
      );
      CREATE INDEX terminal_sessions_thread_status_updated_idx
        ON terminal_sessions (thread_id, status, updated_at);
      CREATE INDEX terminal_sessions_environment_status_idx
        ON terminal_sessions (environment_id, status);
      CREATE INDEX terminal_sessions_host_status_idx
        ON terminal_sessions (host_id, status);
      CREATE INDEX terminal_sessions_daemon_session_idx
        ON terminal_sessions (daemon_session_id);
    `);
  } finally {
    args.db.$client.pragma("foreign_keys = ON");
  }

  args.db.$client.exec(`
    INSERT INTO hosts (id, name, type, created_at, updated_at)
    VALUES ('host_pre0017', 'pre-0017 host', 'persistent', 1000, 1000);

    INSERT INTO projects (id, name, created_at, updated_at)
    VALUES ('proj_pre0017', 'pre-0017 project', 1000, 1000);

    INSERT INTO environments (
      id,
      project_id,
      host_id,
      path,
      workspace_provision_type,
      status,
      created_at,
      updated_at
    )
    VALUES (
      'env_pre0017',
      'proj_pre0017',
      'host_pre0017',
      '/tmp/pre0017',
      'unmanaged',
      'ready',
      1000,
      1000
    );

    INSERT INTO threads (
      id,
      project_id,
      environment_id,
      provider_id,
      latest_attention_at,
      created_at,
      updated_at
    )
    VALUES (
      'thr_pre0017',
      'proj_pre0017',
      'env_pre0017',
      'codex',
      1000,
      1000,
      1000
    );

    INSERT INTO host_daemon_sessions (
      id,
      host_id,
      instance_id,
      host_name,
      host_type,
      data_dir,
      protocol_version,
      heartbeat_interval_ms,
      lease_timeout_ms,
      status,
      lease_expires_at,
      created_at,
      updated_at
    )
    VALUES (
      'sess_pre0017',
      'host_pre0017',
      'inst_pre0017',
      'pre-0017 host',
      'persistent',
      '/tmp/pre0017-data',
      32,
      10000,
      30000,
      'active',
      9000,
      1000,
      1000
    );

    INSERT INTO terminal_sessions (
      id,
      thread_id,
      environment_id,
      host_id,
      daemon_session_id,
      title,
      initial_cwd,
      current_cwd,
      cols,
      rows,
      status,
      exit_code,
      close_reason,
      created_at,
      updated_at,
      last_user_input_at,
      last_connected_at,
      exited_at
    )
    VALUES (
      'term_pre0017',
      'thr_pre0017',
      'env_pre0017',
      'host_pre0017',
      'sess_pre0017',
      'Terminal 1',
      '/tmp/pre0017',
      '/tmp/derived-runtime-cwd',
      120,
      40,
      'running',
      NULL,
      NULL,
      1100,
      1200,
      1300,
      1400,
      NULL
    );
  `);
}

function addPre0017TerminalRuntimeColumns(db: DbConnection): void {
  db.$client.exec(`
    ALTER TABLE terminal_sessions ADD COLUMN current_cwd text;
    ALTER TABLE terminal_sessions ADD COLUMN last_connected_at integer;
    ALTER TABLE terminal_sessions ADD COLUMN exited_at integer;
  `);
}

function runQueuedMessageSortKeyMigration(db: DbConnection): void {
  runMigrationFile({ db, migrationPath: queuedMessageSortKeyMigrationPath });
}

function runSidebarOrderingMigration(db: DbConnection): void {
  runMigrationFile({ db, migrationPath: sidebarOrderingMigrationPath });
}

function runThreadPinningMigration(db: DbConnection): void {
  runMigrationFile({ db, migrationPath: threadPinningMigrationPath });
}

function deleteDeferredCleanupMigrationRows(db: DbConnection): void {
  db.$client
    .prepare<DeleteMigrationsParameters>(
      `
        DELETE FROM __drizzle_migrations
        WHERE created_at IN (?, ?, ?, ?)
      `,
    )
    .run(
      operationStateBackfillMigrationWhen,
      eventProducerColumnsMigrationWhen,
      terminalSessionRuntimeStateHonestyWhen,
      hostDaemonSessionObservabilityMigrationWhen,
    );
}

describe("migrate", () => {
  beforeAll(() => {
    prepareMigratedConnectionTemplate();
  });

  it("backfills the first checkout commit component for every artifact shape", () => {
    const db = createConnection(":memory:");
    const commit = "d".repeat(40);
    try {
      db.$client.exec(`
        CREATE TABLE plugin_artifacts (
          id text PRIMARY KEY NOT NULL,
          source_kind text NOT NULL,
          git_resolved_commit text,
          path text NOT NULL
        );
      `);
      const insert = db.$client.prepare<
        [string, string, string | null, string]
      >(
        "INSERT INTO plugin_artifacts (id, source_kind, git_resolved_commit, path) VALUES (?, ?, ?, ?)",
      );
      insert.run("root", "git", commit, `/cache/repo/${commit}`);
      insert.run("nested", "git", commit, `/cache/repo/${commit}/plugins/a`);
      insert.run(
        "collision",
        "git",
        commit,
        `/cache/repo/${commit}/vendor/${commit}`,
      );
      insert.run(
        "windows",
        "git",
        commit,
        `C:\\cache\\repo\\${commit}\\plugins\\a`,
      );
      insert.run("npm", "npm", null, "/cache/npm/package/1.0.0");
      insert.run("unresolved-git", "git", null, "/cache/git/legacy");

      runMigrationFile({
        db,
        migrationPath: pluginArtifactCheckoutRootMigrationPath,
      });

      expect(
        db.$client
          .prepare<[], { id: string; root: string | null }>(
            "SELECT id, git_checkout_root AS root FROM plugin_artifacts ORDER BY id",
          )
          .all(),
      ).toEqual([
        { id: "collision", root: `/cache/repo/${commit}` },
        { id: "nested", root: `/cache/repo/${commit}` },
        { id: "npm", root: null },
        { id: "root", root: `/cache/repo/${commit}` },
        { id: "unresolved-git", root: null },
        { id: "windows", root: `C:\\cache\\repo\\${commit}` },
      ]);
    } finally {
      closeConnection(db);
    }
  });

  it("backfills the retirement clock only for environments already retiring", () => {
    const db = createConnection(":memory:");
    try {
      db.$client.exec(`
        CREATE TABLE environments (
          id text PRIMARY KEY NOT NULL,
          status text NOT NULL,
          updated_at integer NOT NULL
        );
        INSERT INTO environments (id, status, updated_at) VALUES
          ('env_retiring', 'retiring', 1234),
          ('env_ready', 'ready', 2345);
      `);

      runMigrationFile({
        db,
        migrationPath: retireRequestedAtMigrationPath,
      });

      expect(
        db.$client
          .prepare<[], { id: string; retireRequestedAt: number | null }>(
            `
              SELECT
                id,
                retire_requested_at AS retireRequestedAt
              FROM environments
              ORDER BY id
            `,
          )
          .all(),
      ).toEqual([
        { id: "env_ready", retireRequestedAt: null },
        { id: "env_retiring", retireRequestedAt: 1234 },
      ]);
    } finally {
      closeConnection(db);
    }
  });

  it("moves experiment columns into key/value rows without losing values", () => {
    const db = createConnection(":memory:");

    try {
      db.$client.exec(`
        CREATE TABLE system_experiments (
          id text PRIMARY KEY NOT NULL,
          claude_code_mock_cli_traffic integer NOT NULL,
          new_onboarding integer DEFAULT false NOT NULL,
          tools_hub integer DEFAULT false NOT NULL,
          updated_at integer NOT NULL
        );
        INSERT INTO system_experiments VALUES ('current', true, false, true, 1234);
      `);

      runMigrationFile({ db, migrationPath: experimentKeyValueMigrationPath });

      expect(
        db.$client
          .prepare<[], MigratedExperimentRow>(
            `
            SELECT key, value, updated_at AS updatedAt
            FROM system_experiments
            ORDER BY key
          `,
          )
          .all(),
      ).toEqual([
        { key: "claudeCodeMockCliTraffic", updatedAt: 1234, value: 1 },
        { key: "newOnboarding", updatedAt: 1234, value: 0 },
        { key: "toolsHub", updatedAt: 1234, value: 1 },
      ]);
    } finally {
      closeConnection(db);
    }
  });

  it("moves app settings columns into key/value rows without losing values", () => {
    const db = createConnection(":memory:");

    try {
      db.$client.exec(`
        CREATE TABLE app_settings (
          id text PRIMARY KEY NOT NULL,
          caffeinate integer DEFAULT false NOT NULL,
          show_keyboard_hints integer DEFAULT true NOT NULL,
          steer_active_thread_on_enter integer DEFAULT false NOT NULL,
          show_unhandled_provider_events integer DEFAULT false NOT NULL,
          codex_memory_enabled integer DEFAULT true NOT NULL,
          claude_code_memory_enabled integer DEFAULT true NOT NULL,
          codex_subagents_disabled integer DEFAULT false NOT NULL,
          claude_code_subagents_disabled integer DEFAULT false NOT NULL,
          claude_code_workflows_disabled integer DEFAULT false NOT NULL,
          keybinding_overrides text DEFAULT '[]' NOT NULL,
          onboarding_completed_at text,
          updated_at integer NOT NULL
        );
        INSERT INTO app_settings VALUES (
          'current', true, false, true, true, false, true, true, false, true,
          '[{"command":"thread.new","shortcut":null}]',
          '2026-08-01T00:00:00.000Z',
          1234
        );
      `);

      runMigrationFile({ db, migrationPath: appSettingsKeyValueMigrationPath });

      expect(getAppSettings(db)).toEqual({
        showKeyboardHints: false,
        steerActiveThreadOnEnter: true,
        showUnhandledProviderEvents: true,
        providerOrder: [],
        defaultProviderId: null,
        streamerMode: false,
        managedBranchPrefix: "bb/",
      });
      expect(
        db.$client
          .prepare<[], { key: string; value: string }>(
            "SELECT key, value FROM app_settings_values WHERE key LIKE 'codex%' OR key LIKE 'claudeCode%' ORDER BY key",
          )
          .all(),
      ).toEqual([
        { key: "claudeCodeMemoryEnabled", value: "true" },
        { key: "claudeCodeSubagentsDisabled", value: "false" },
        { key: "claudeCodeWorkflowsDisabled", value: "true" },
        { key: "codexMemoryEnabled", value: "false" },
        { key: "codexSubagentsDisabled", value: "true" },
      ]);
      expect(getAppKeybindingOverrides(db)).toEqual([
        { command: "thread.new", shortcut: null },
      ]);
      expect(
        db.$client
          .prepare<[], { updatedAt: number }>(
            "SELECT updated_at AS updatedAt FROM app_settings_values WHERE key = 'showKeyboardHints'",
          )
          .get(),
      ).toEqual({ updatedAt: 1234 });
    } finally {
      closeConnection(db);
    }
  });

  it("carries the provider knobs into plugin settings and retires the shared rows", () => {
    const db = createConnection(":memory:");
    try {
      db.$client.exec(`
        CREATE TABLE app_settings_values (
          key text PRIMARY KEY NOT NULL,
          value text NOT NULL,
          updated_at integer NOT NULL
        );
        CREATE TABLE plugin_settings (
          plugin_id text NOT NULL,
          key text NOT NULL,
          value text NOT NULL,
          updated_at integer NOT NULL,
          PRIMARY KEY (plugin_id, key)
        );
        INSERT INTO app_settings_values (key, value, updated_at) VALUES
          ('showKeyboardHints', 'false', 10),
          ('codexMemoryEnabled', 'false', 11),
          ('codexSubagentsDisabled', 'true', 12),
          ('claudeCodeMemoryEnabled', 'true', 13),
          ('claudeCodeSubagentsDisabled', 'false', 14),
          ('claudeCodeWorkflowsDisabled', 'true', 15);
        -- A plugin row written before the migration wins over the old value.
        INSERT INTO plugin_settings (plugin_id, key, value, updated_at) VALUES
          ('provider-claude-code', 'memoryEnabled', 'false', 99);
      `);

      runMigrationFile({
        db,
        migrationPath: providerSettingsToPluginsMigrationPath,
      });

      expect(
        db.$client
          .prepare<
            [],
            { pluginId: string; key: string; value: string; updatedAt: number }
          >(
            "SELECT plugin_id AS pluginId, key, value, updated_at AS updatedAt FROM plugin_settings ORDER BY plugin_id, key",
          )
          .all(),
      ).toEqual([
        {
          pluginId: "provider-claude-code",
          key: "memoryEnabled",
          value: "false",
          updatedAt: 99,
        },
        {
          pluginId: "provider-claude-code",
          key: "subagentsDisabled",
          value: "false",
          updatedAt: 14,
        },
        {
          pluginId: "provider-claude-code",
          key: "workflowsDisabled",
          value: "true",
          updatedAt: 15,
        },
        {
          pluginId: "provider-codex",
          key: "memoryEnabled",
          value: "false",
          updatedAt: 11,
        },
        {
          pluginId: "provider-codex",
          key: "subagentsDisabled",
          value: "true",
          updatedAt: 12,
        },
      ]);
      expect(
        db.$client
          .prepare<[], { key: string }>(
            "SELECT key FROM app_settings_values ORDER BY key",
          )
          .all(),
      ).toEqual([{ key: "showKeyboardHints" }]);
    } finally {
      closeConnection(db);
    }
  });

  it("keeps a never-onboarded install null through the app settings move", () => {
    const db = createConnection(":memory:");

    try {
      db.$client.exec(`
        CREATE TABLE app_settings (
          id text PRIMARY KEY NOT NULL,
          caffeinate integer DEFAULT false NOT NULL,
          show_keyboard_hints integer DEFAULT true NOT NULL,
          steer_active_thread_on_enter integer DEFAULT false NOT NULL,
          show_unhandled_provider_events integer DEFAULT false NOT NULL,
          codex_memory_enabled integer DEFAULT true NOT NULL,
          claude_code_memory_enabled integer DEFAULT true NOT NULL,
          codex_subagents_disabled integer DEFAULT false NOT NULL,
          claude_code_subagents_disabled integer DEFAULT false NOT NULL,
          claude_code_workflows_disabled integer DEFAULT false NOT NULL,
          keybinding_overrides text DEFAULT '[]' NOT NULL,
          onboarding_completed_at text,
          updated_at integer NOT NULL
        );
        INSERT INTO app_settings (id, updated_at) VALUES ('current', 1234);
      `);

      runMigrationFile({ db, migrationPath: appSettingsKeyValueMigrationPath });

      expect(getAppSettings(db)).toEqual({
        ...defaultAppSettings,
        steerActiveThreadOnEnter: false,
      });
      expect(getAppKeybindingOverrides(db)).toEqual([]);
    } finally {
      closeConnection(db);
    }
  });

  it("leaves app settings unset when there is no legacy row", () => {
    const db = createConnection(":memory:");

    try {
      db.$client.exec(`
        CREATE TABLE app_settings (
          id text PRIMARY KEY NOT NULL,
          caffeinate integer DEFAULT false NOT NULL,
          show_keyboard_hints integer DEFAULT true NOT NULL,
          steer_active_thread_on_enter integer DEFAULT false NOT NULL,
          show_unhandled_provider_events integer DEFAULT false NOT NULL,
          codex_memory_enabled integer DEFAULT true NOT NULL,
          claude_code_memory_enabled integer DEFAULT true NOT NULL,
          codex_subagents_disabled integer DEFAULT false NOT NULL,
          claude_code_subagents_disabled integer DEFAULT false NOT NULL,
          claude_code_workflows_disabled integer DEFAULT false NOT NULL,
          keybinding_overrides text DEFAULT '[]' NOT NULL,
          onboarding_completed_at text,
          updated_at integer NOT NULL
        );
      `);

      runMigrationFile({ db, migrationPath: appSettingsKeyValueMigrationPath });

      expect(
        db.$client
          .prepare<[], { count: number }>(
            "SELECT COUNT(*) AS count FROM app_settings_values",
          )
          .get(),
      ).toEqual({ count: 0 });
      expect(getAppSettings(db)).toEqual(defaultAppSettings);
    } finally {
      closeConnection(db);
    }
  });

  it("keeps queue-on-enter for a store that predates the steer default", () => {
    const db = createConnection(":memory:");

    try {
      db.$client.exec(`
        CREATE TABLE app_settings_values (
          key text PRIMARY KEY NOT NULL,
          value text NOT NULL,
          updated_at integer NOT NULL
        );
        CREATE TABLE projects (id text PRIMARY KEY NOT NULL, kind text NOT NULL);
        CREATE TABLE threads (id text PRIMARY KEY NOT NULL);
        INSERT INTO projects (id, kind) VALUES ('proj_personal', 'personal');
        INSERT INTO projects (id, kind) VALUES ('project-1', 'standard');
      `);

      runMigrationFile({ db, migrationPath: steerOnEnterDefaultMigrationPath });

      expect(getAppSettings(db).steerActiveThreadOnEnter).toBe(false);
    } finally {
      closeConnection(db);
    }
  });

  it("keeps queue-on-enter for a store whose only work is a personal thread", () => {
    const db = createConnection(":memory:");

    try {
      db.$client.exec(`
        CREATE TABLE app_settings_values (
          key text PRIMARY KEY NOT NULL,
          value text NOT NULL,
          updated_at integer NOT NULL
        );
        CREATE TABLE projects (id text PRIMARY KEY NOT NULL, kind text NOT NULL);
        CREATE TABLE threads (id text PRIMARY KEY NOT NULL);
        INSERT INTO projects (id, kind) VALUES ('proj_personal', 'personal');
        INSERT INTO threads (id) VALUES ('thread-1');
      `);

      runMigrationFile({ db, migrationPath: steerOnEnterDefaultMigrationPath });

      expect(getAppSettings(db).steerActiveThreadOnEnter).toBe(false);
    } finally {
      closeConnection(db);
    }
  });

  it("steers on enter for a store that only holds the seeded personal project", () => {
    const db = createConnection(":memory:");

    try {
      db.$client.exec(`
        CREATE TABLE app_settings_values (
          key text PRIMARY KEY NOT NULL,
          value text NOT NULL,
          updated_at integer NOT NULL
        );
        CREATE TABLE projects (id text PRIMARY KEY NOT NULL, kind text NOT NULL);
        CREATE TABLE threads (id text PRIMARY KEY NOT NULL);
        INSERT INTO projects (id, kind) VALUES ('proj_personal', 'personal');
      `);

      runMigrationFile({ db, migrationPath: steerOnEnterDefaultMigrationPath });

      expect(
        db.$client
          .prepare<[], { count: number }>(
            "SELECT COUNT(*) AS count FROM app_settings_values",
          )
          .get(),
      ).toEqual({ count: 0 });
      expect(getAppSettings(db).steerActiveThreadOnEnter).toBe(true);
    } finally {
      closeConnection(db);
    }
  });

  it("steers on enter for a store built by a full migration run", () => {
    const db = createConnection(":memory:");

    try {
      migrate(db);

      expect(getAppSettings(db).steerActiveThreadOnEnter).toBe(true);
    } finally {
      closeConnection(db);
    }
  });

  it("keeps a chosen steer preference through the steer default change", () => {
    const db = createConnection(":memory:");

    try {
      db.$client.exec(`
        CREATE TABLE app_settings_values (
          key text PRIMARY KEY NOT NULL,
          value text NOT NULL,
          updated_at integer NOT NULL
        );
        CREATE TABLE projects (id text PRIMARY KEY NOT NULL, kind text NOT NULL);
        CREATE TABLE threads (id text PRIMARY KEY NOT NULL);
        INSERT INTO projects (id, kind) VALUES ('project-1', 'standard');
        INSERT INTO app_settings_values (key, value, updated_at)
        VALUES ('steerActiveThreadOnEnter', 'true', 1234);
      `);

      runMigrationFile({ db, migrationPath: steerOnEnterDefaultMigrationPath });

      expect(
        db.$client
          .prepare<[], { value: string; updatedAt: number }>(
            "SELECT value, updated_at AS updatedAt FROM app_settings_values WHERE key = 'steerActiveThreadOnEnter'",
          )
          .get(),
      ).toEqual({ value: "true", updatedAt: 1234 });
      expect(getAppSettings(db).steerActiveThreadOnEnter).toBe(true);
    } finally {
      closeConnection(db);
    }
  });

  it("adopts legacy side chats as the side-chat plugin's hidden forks", () => {
    const db = createConnection(":memory:");

    try {
      migrate(db);
      const host = upsertHost(db, noopNotifier, {
        name: "side-chat-adoption-host",
        type: "persistent",
      });
      const { project } = createProject(db, noopNotifier, {
        name: "side-chat-adoption-project",
        source: {
          type: "local_path",
          hostId: host.id,
          path: "/tmp/side-chat-adoption",
        },
      });
      const source = createThread(db, noopNotifier, {
        projectId: project.id,
        providerId: "codex",
      });
      const sideChat = createThread(db, noopNotifier, {
        projectId: project.id,
        providerId: "codex",
        originKind: "fork",
        sourceThreadId: source.id,
      });
      const orphanSideChat = createThread(db, noopNotifier, {
        projectId: project.id,
        providerId: "codex",
      });
      const pluginFork = createThread(db, noopNotifier, {
        projectId: project.id,
        providerId: "codex",
        originKind: "fork",
        originPluginId: "workflows",
        sourceThreadId: source.id,
      });
      db.$client
        .prepare(
          "UPDATE threads SET origin_kind = 'side-chat' WHERE id IN (?, ?)",
        )
        .run(sideChat.id, orphanSideChat.id);

      db.$client.exec(
        "DROP INDEX IF EXISTS `threads_origin_plugin_archived_idx`",
      );
      restoreSideChatPluginExperimentColumn(db);
      restoreLegacyThreadOriginColumn(db);
      runMigrationFile({ db, migrationPath: sideChatPluginOnlyMigrationPath });

      const rows = db.$client
        .prepare<[], MigratedThreadOriginRow>(
          "SELECT id, origin_kind AS originKind, origin_plugin_id AS originPluginId, visibility FROM threads",
        )
        .all();
      const byId = new Map(rows.map((row) => [row.id, row]));

      expect(byId.get(sideChat.id)).toMatchObject({
        originKind: "fork",
        originPluginId: "side-chat",
        visibility: "hidden",
      });
      expect(byId.get(orphanSideChat.id)).toMatchObject({
        originKind: null,
        originPluginId: null,
        visibility: "visible",
      });
      expect(byId.get(pluginFork.id)).toMatchObject({
        originKind: "fork",
        originPluginId: "workflows",
      });
      expect(rows.filter((row) => row.originKind === "side-chat")).toHaveLength(
        0,
      );
    } finally {
      closeConnection(db);
    }
  });

  it("migrates mutable permission state while preserving side-chat source intent", () => {
    const db = createConnection(":memory:");

    try {
      migrate(db);
      const host = upsertHost(db, noopNotifier, {
        name: "permission-migration-host",
        type: "persistent",
      });
      const { project } = createProject(db, noopNotifier, {
        name: "permission-migration-project",
        source: {
          type: "local_path",
          hostId: host.id,
          path: "/tmp/permission-migration-project",
        },
      });
      const sourceWithHistory = createThread(db, noopNotifier, {
        projectId: project.id,
        providerId: "codex",
        status: "idle",
      });
      const sourceWithoutHistory = createThread(db, noopNotifier, {
        projectId: project.id,
        providerId: "codex",
        status: "idle",
      });
      const sideChatWithHistory = createThread(db, noopNotifier, {
        originKind: "fork",
        projectId: project.id,
        providerId: "codex",
        sourceThreadId: sourceWithHistory.id,
        status: "idle",
      });
      const sideChatWithoutHistory = createThread(db, noopNotifier, {
        originKind: "fork",
        projectId: project.id,
        providerId: "codex",
        sourceThreadId: sourceWithoutHistory.id,
        status: "idle",
      });
      db.$client
        .prepare(
          "UPDATE threads SET origin_kind = 'side-chat' WHERE id IN (?, ?)",
        )
        .run(sideChatWithHistory.id, sideChatWithoutHistory.id);
      const regularThread = createThread(db, noopNotifier, {
        projectId: project.id,
        providerId: "codex",
        status: "idle",
      });
      const workspaceWriteQueue = createQueuedThreadMessage(db, noopNotifier, {
        threadId: regularThread.id,
        content: [
          { type: "text", text: "legacy workspace write", mentions: [] },
        ],
        model: "gpt-5",
        permissionMode: "full",
        reasoningLevel: "medium",
        serviceTier: "default",
        waitingOn: null,
        sendAt: null,
        payload: { kind: "inline" },
        systemNotice: null,
      });
      const inheritedQueue = createQueuedThreadMessage(db, noopNotifier, {
        threadId: sideChatWithHistory.id,
        content: [{ type: "text", text: "legacy side chat", mentions: [] }],
        model: "gpt-5",
        permissionMode: "full",
        reasoningLevel: "medium",
        serviceTier: "default",
        waitingOn: null,
        sendAt: null,
        payload: { kind: "inline" },
        systemNotice: null,
      });
      const fallbackQueue = createQueuedThreadMessage(db, noopNotifier, {
        threadId: sideChatWithoutHistory.id,
        content: [{ type: "text", text: "legacy fallback", mentions: [] }],
        model: "gpt-5",
        permissionMode: "full",
        reasoningLevel: "medium",
        serviceTier: "default",
        waitingOn: null,
        sendAt: null,
        payload: { kind: "inline" },
        systemNotice: null,
      });
      db.$client
        .prepare(
          `
            INSERT INTO events (
              id,
              thread_id,
              scope_kind,
              sequence,
              type,
              data,
              created_at
            ) VALUES (?, ?, 'thread', 1, 'client/turn/requested', ?, ?)
          `,
        )
        .run(
          "evt_permission_source_full",
          sourceWithHistory.id,
          JSON.stringify({ execution: { permissionMode: "full" } }),
          Date.now(),
        );
      db.$client
        .prepare(
          `
            INSERT INTO project_execution_defaults (
              project_id,
              provider_id,
              model,
              service_tier,
              reasoning_level,
              permission_mode,
              updated_at
            ) VALUES (?, 'codex', 'gpt-5', 'default', 'medium', 'readonly', ?)
          `,
        )
        .run(project.id, Date.now());
      db.$client
        .prepare(
          `
            UPDATE queued_thread_messages
            SET permission_mode = CASE id
              WHEN ? THEN 'workspace-write'
              ELSE 'readonly'
            END
            WHERE id IN (?, ?, ?)
          `,
        )
        .run(
          workspaceWriteQueue.id,
          workspaceWriteQueue.id,
          inheritedQueue.id,
          fallbackQueue.id,
        );
      restoreWideExperimentsTable(db);
      db.$client
        .prepare<DeleteMigrationParameters>(
          "DELETE FROM __drizzle_migrations WHERE created_at >= ?",
        )
        .run(permissionModesMigrationWhen);
      dropSideChatPluginExperimentColumn(db);
      dropToolsHubExperimentColumn(db);
      restorePluginsExperimentColumn(db);
      dropSteerActiveThreadOnEnterColumn(db);
      dropOnboardingCompletedAtColumn(db);
      dropAppSettingsValuesTable(db);
      dropNewOnboardingExperimentColumn(db);
      dropHostMaxPermissionModeColumn(db);
      dropEnvironmentRetireRequestedAtColumn(db);
      dropPluginArtifactGitCheckoutRootColumn(db);
      dropMarketplaceCatalogSchema(db);
      dropEventParentToolCallIdColumn(db);
      dropQueueReworkSchema(db);

      restoreLegacyThreadOriginColumn(db);
      migrate(db);

      expect(
        db.$client
          .prepare<[string], { permissionMode: string }>(
            `
              SELECT permission_mode AS permissionMode
              FROM project_execution_defaults
              WHERE project_id = ?
            `,
          )
          .get(project.id),
      ).toEqual({ permissionMode: "accept-edits" });
      expect(
        db.$client
          .prepare<[string, string, string], MigratedPermissionModeRow>(
            `
              SELECT id, permission_mode AS permissionMode
              FROM queued_thread_messages
              WHERE id IN (?, ?, ?)
              ORDER BY id
            `,
          )
          .all(workspaceWriteQueue.id, inheritedQueue.id, fallbackQueue.id),
      ).toEqual(
        [
          { id: workspaceWriteQueue.id, permissionMode: "accept-edits" },
          { id: inheritedQueue.id, permissionMode: "full" },
          { id: fallbackQueue.id, permissionMode: "accept-edits" },
        ].sort((left, right) => left.id.localeCompare(right.id)),
      );
    } finally {
      closeConnection(db);
    }
  });

  it("provisions the singleton personal project", () => {
    const db = createConnection(":memory:");

    try {
      migrate(db);

      const personalProject = db.$client
        .prepare<[], PersonalProjectMigrationRow>(
          `
            SELECT COUNT(*) AS count
            FROM projects
            WHERE id = 'proj_personal'
              AND kind = 'personal'
              AND name = 'Personal'
          `,
        )
        .get();
      expect(personalProject?.count).toBe(1);

      expect(() =>
        db.$client
          .prepare(
            `
              INSERT INTO projects (id, kind, name, sort_key, created_at, updated_at)
              VALUES ('proj_second_personal', 'personal', 'Second personal', 'V', 1, 1)
            `,
          )
          .run(),
      ).toThrow();
    } finally {
      closeConnection(db);
    }
  });

  it("applies rowid thread search rebuild after the compatible thread search hash", () => {
    const db = createConnection(":memory:");

    try {
      migrate(db);
      replaceAppliedMigrationHash({
        db,
        createdAt: threadSearchMigrationWhen,
        hash: rowidThreadSearchMigrationHash,
      });
      db.$client
        .prepare<DeleteMigrationParameters>(
          "DELETE FROM __drizzle_migrations WHERE created_at = ?",
        )
        .run(threadSearchRowidFtsMigrationWhen);
      resetMigrationsAfterThreadSearch(db);

      expect(() => migrate(db)).not.toThrow();

      expect(
        db.$client
          .prepare<[], TableInfoRow>(
            "PRAGMA table_info(thread_search_segments_fts)",
          )
          .all()
          .map((row) => row.name),
      ).toEqual(["text"]);
      expect(
        db.$client
          .prepare<[number], MigrationCountRow>(
            `
              SELECT COUNT(*) AS count
              FROM __drizzle_migrations
              WHERE created_at = ?
            `,
          )
          .get(threadSearchRowidFtsMigrationWhen),
      ).toEqual({ count: 1 });
    } finally {
      closeConnection(db);
    }
  });

  it("replays canonical thread search migrations after branch-local thread search migrations", () => {
    const db = createConnection(":memory:");

    try {
      migrate(db);
      db.$client.exec(`
        INSERT INTO projects (id, name, created_at, updated_at)
        VALUES ('proj_branch_thread_search', 'Branch Thread Search', 1000, 1000);

        INSERT INTO threads (
          id,
          project_id,
          provider_id,
          title,
          latest_attention_at,
          created_at,
          updated_at
        )
        VALUES (
          'thr_branch_thread_search',
          'proj_branch_thread_search',
          'codex',
          'branchcompatneedle',
          1000,
          1000,
          1000
        );
      `);
      db.$client
        .prepare<DeleteMigrationsParameters>(
          `
            DELETE FROM __drizzle_migrations
            WHERE created_at IN (?, ?, ?, ?)
          `,
        )
        .run(
          threadSearchMigrationWhen,
          threadSearchRowidFtsMigrationWhen,
          branchLocalThreadSearchMigrationWhen,
          branchLocalThreadSearchRowidFtsMigrationWhen,
        );
      db.$client
        .prepare<InsertMigrationParameters>(
          `
            INSERT INTO __drizzle_migrations (hash, created_at)
            VALUES (?, ?)
          `,
        )
        .run(
          "branch-local-thread-search-hash",
          branchLocalThreadSearchMigrationWhen,
        );
      db.$client
        .prepare<InsertMigrationParameters>(
          `
            INSERT INTO __drizzle_migrations (hash, created_at)
            VALUES (?, ?)
          `,
        )
        .run(
          "branch-local-thread-search-rowid-fts-hash",
          branchLocalThreadSearchRowidFtsMigrationWhen,
        );
      resetMigrationsAfterThreadSearch(db);

      expect(() => migrate(db)).not.toThrow();

      expect(
        db.$client
          .prepare<[], TableInfoRow>(
            "PRAGMA table_info(thread_search_segments_fts)",
          )
          .all()
          .map((row) => row.name),
      ).toEqual(["text"]);
      expect(
        db.$client
          .prepare<[], MigratedThreadSearchSegmentRow>(
            `
              SELECT s.thread_id AS threadId
              FROM thread_search_segments_fts
              JOIN thread_search_segments AS s
                ON s.rowid = thread_search_segments_fts.rowid
              WHERE thread_search_segments_fts MATCH 'branchcompatneedle'
            `,
          )
          .get(),
      ).toEqual({ threadId: "thr_branch_thread_search" });
      expect(
        db.$client
          .prepare<[number], MigrationCountRow>(
            `
              SELECT COUNT(*) AS count
              FROM __drizzle_migrations
              WHERE created_at = ?
            `,
          )
          .get(threadSearchMigrationWhen),
      ).toEqual({ count: 1 });
      expect(
        db.$client
          .prepare<[number], MigrationCountRow>(
            `
              SELECT COUNT(*) AS count
              FROM __drizzle_migrations
              WHERE created_at = ?
            `,
          )
          .get(branchLocalThreadSearchMigrationWhen),
      ).toEqual({ count: 0 });
    } finally {
      closeConnection(db);
    }
  });

  it("replays pending-interactions migration after branch-local tab history", () => {
    const db = createConnection(":memory:");

    try {
      migrate(db);
      db.$client.exec(`
        DROP TABLE pending_interactions;
        CREATE TABLE pending_interactions (
          id text PRIMARY KEY NOT NULL,
          thread_id text NOT NULL,
          turn_id text NOT NULL,
          provider_id text NOT NULL,
          provider_thread_id text NOT NULL,
          provider_request_id text NOT NULL,
          status text NOT NULL,
          payload text NOT NULL,
          resolution text,
          status_reason text,
          created_at integer NOT NULL,
          resolved_at integer,
          updated_at integer NOT NULL,
          FOREIGN KEY (thread_id) REFERENCES threads(id) ON DELETE CASCADE
        );
        CREATE UNIQUE INDEX pending_interactions_provider_request_idx
          ON pending_interactions (provider_id, provider_thread_id, provider_request_id);
        CREATE INDEX pending_interactions_thread_created_idx
          ON pending_interactions (thread_id, created_at);
        CREATE INDEX pending_interactions_thread_status_created_idx
          ON pending_interactions (thread_id, status, created_at);
        CREATE INDEX pending_interactions_status_created_idx
          ON pending_interactions (status, created_at);
      `);
      db.$client
        .prepare<DeleteMigrationParameters>(
          "DELETE FROM __drizzle_migrations WHERE created_at = ?",
        )
        .run(pendingInteractionsMigrationWhen);
      db.$client
        .prepare<InsertMigrationParameters>(
          `
            INSERT INTO __drizzle_migrations (hash, created_at)
            VALUES (?, ?)
          `,
        )
        .run("branch-local-thread-tabs", branchLocalThreadTabsMigrationWhen);

      migrate(db);

      const columns = db.$client
        .prepare<[], TableNameRow>(
          "SELECT name FROM pragma_table_info('pending_interactions') ORDER BY cid",
        )
        .all()
        .map((row) => row.name);
      expect(columns).toContain("origin_kind");
      expect(columns).toContain("plugin_id");
      expect(columns).toContain("renderer_id");
      expect(columns).toContain("expires_at");
      expect(readAppliedMigrationCreatedAts(db)).toContain(
        pendingInteractionsMigrationWhen,
      );
    } finally {
      closeConnection(db);
    }
  });

  it("replays canonical thread search migrations when pre-canonical search tables exist without ledger rows", () => {
    const db = createConnection(":memory:");

    try {
      migrate(db);
      db.$client.exec(`
        INSERT INTO projects (id, name, created_at, updated_at)
        VALUES ('proj_precanonical_thread_search', 'Precanonical Thread Search', 1000, 1000);

        INSERT INTO threads (
          id,
          project_id,
          provider_id,
          title,
          latest_attention_at,
          created_at,
          updated_at
        )
        VALUES (
          'thr_precanonical_thread_search',
          'proj_precanonical_thread_search',
          'codex',
          'precanonicalneedle',
          1000,
          1000,
          1000
        );
      `);
      db.$client
        .prepare<DeleteMigrationsParameters>(
          `
            DELETE FROM __drizzle_migrations
            WHERE created_at IN (?, ?, ?, ?)
          `,
        )
        .run(
          threadSearchMigrationWhen,
          threadSearchRowidFtsMigrationWhen,
          branchLocalThreadSearchMigrationWhen,
          branchLocalThreadSearchRowidFtsMigrationWhen,
        );
      resetMigrationsAfterThreadSearch(db);

      expect(() => migrate(db)).not.toThrow();

      expect(
        db.$client
          .prepare<[], MigratedThreadSearchSegmentRow>(
            `
              SELECT s.thread_id AS threadId
              FROM thread_search_segments_fts
              JOIN thread_search_segments AS s
                ON s.rowid = thread_search_segments_fts.rowid
              WHERE thread_search_segments_fts MATCH 'precanonicalneedle'
            `,
          )
          .get(),
      ).toEqual({ threadId: "thr_precanonical_thread_search" });
      expect(
        db.$client
          .prepare<[number], MigrationCountRow>(
            `
              SELECT COUNT(*) AS count
              FROM __drizzle_migrations
              WHERE created_at = ?
            `,
          )
          .get(threadSearchMigrationWhen),
      ).toEqual({ count: 1 });
    } finally {
      closeConnection(db);
    }
  });

  it("repairs branch-local queued grouping history that skipped thread sections", () => {
    const db = createConnection(":memory:");

    try {
      migrate(db);
      dropThreadSectionSchema(db);
      restoreWideExperimentsTable(db);
      db.$client
        .prepare(
          "ALTER TABLE system_experiments ADD COLUMN thread_splits integer DEFAULT false NOT NULL",
        )
        .run();
      db.$client
        .prepare<DeleteMigrationParameters>(
          "DELETE FROM __drizzle_migrations WHERE created_at = ?",
        )
        .run(threadSectionsMigrationWhen);
      db.$client
        .prepare<DeleteMigrationParameters>(
          "DELETE FROM __drizzle_migrations WHERE created_at >= ?",
        )
        .run(threadSectionsRepairMigrationWhen);
      dropSideChatPluginExperimentColumn(db);
      dropToolsHubExperimentColumn(db);
      restorePluginsExperimentColumn(db);
      dropSteerActiveThreadOnEnterColumn(db);
      dropOnboardingCompletedAtColumn(db);
      dropAppSettingsValuesTable(db);
      dropNewOnboardingExperimentColumn(db);
      dropHostMaxPermissionModeColumn(db);
      dropEnvironmentRetireRequestedAtColumn(db);
      dropPluginArtifactGitCheckoutRootColumn(db);
      dropMarketplaceCatalogSchema(db);
      dropEventParentToolCallIdColumn(db);
      dropQueueReworkSchema(db);

      restoreLegacyThreadOriginColumn(db);
      expect(
        db.$client
          .prepare<[number], MigrationCountRow>(
            `
              SELECT COUNT(*) AS count
              FROM __drizzle_migrations
              WHERE created_at = ?
            `,
          )
          .get(queuedMessageGroupingMigrationWhen),
      ).toEqual({ count: 1 });
      expect(() => migrate(db)).not.toThrow();

      expect(readTableNames(db)).toContain("thread_sections");
      expect(
        db.$client
          .prepare<[], TableInfoRow>("PRAGMA table_info(threads)")
          .all()
          .map((row) => row.name),
      ).toContain("section_id");
      expect(readIndexNames({ db, tableName: "threads" })).toContain(
        "threads_section_archived_deleted_idx",
      );
      expect(
        db.$client
          .prepare<[number], MigrationCountRow>(
            `
              SELECT COUNT(*) AS count
              FROM __drizzle_migrations
              WHERE created_at = ?
            `,
          )
          .get(threadSectionsMigrationWhen),
      ).toEqual({ count: 1 });
    } finally {
      closeConnection(db);
    }
  });

  it("renames thread section storage without losing assignments", () => {
    const db = createConnection(":memory:");

    try {
      migrate(db);
      restoreWideExperimentsTable(db);
      db.$client.exec(`
        INSERT INTO projects (id, name, created_at, updated_at)
        VALUES ('proj_section_migration', 'Section migration', 1000, 1000);

        INSERT INTO thread_sections (id, name, created_at, updated_at)
        VALUES ('sec_preserved', 'Release QA', 1000, 1000);

        INSERT INTO threads (
          id,
          project_id,
          provider_id,
          section_id,
          latest_attention_at,
          created_at,
          updated_at
        )
        VALUES (
          'thr_section_migration',
          'proj_section_migration',
          'codex',
          'sec_preserved',
          1000,
          1000,
          1000
        );

        DROP INDEX threads_section_archived_deleted_idx;
        DROP INDEX thread_sections_name_idx;
        ALTER TABLE thread_sections RENAME TO thread_folders;
        CREATE UNIQUE INDEX thread_folders_name_idx
          ON thread_folders (name);
        ALTER TABLE threads RENAME COLUMN section_id TO folder_id;
        CREATE INDEX threads_folder_archived_deleted_idx
          ON threads (folder_id, archived_at, deleted_at, id);
        ALTER TABLE system_experiments
          ADD COLUMN thread_splits integer DEFAULT false NOT NULL;
      `);
      db.$client
        .prepare<DeleteMigrationParameters>(
          "DELETE FROM __drizzle_migrations WHERE created_at >= ?",
        )
        .run(threadSectionsRepairMigrationWhen);
      dropSideChatPluginExperimentColumn(db);
      dropToolsHubExperimentColumn(db);
      restorePluginsExperimentColumn(db);
      dropSteerActiveThreadOnEnterColumn(db);
      dropOnboardingCompletedAtColumn(db);
      dropAppSettingsValuesTable(db);
      dropNewOnboardingExperimentColumn(db);
      dropHostMaxPermissionModeColumn(db);
      dropEnvironmentRetireRequestedAtColumn(db);
      dropPluginArtifactGitCheckoutRootColumn(db);
      dropMarketplaceCatalogSchema(db);
      dropEventParentToolCallIdColumn(db);
      dropQueueReworkSchema(db);

      restoreLegacyThreadOriginColumn(db);
      expect(() => migrate(db)).not.toThrow();

      expect(readTableNames(db)).toContain("thread_sections");
      expect(readTableNames(db)).not.toContain("thread_folders");
      expect(
        db.$client
          .prepare<[], { sectionId: string | null }>(
            `
              SELECT section_id AS sectionId
              FROM threads
              WHERE id = 'thr_section_migration'
            `,
          )
          .get(),
      ).toEqual({ sectionId: "sec_preserved" });
      expect(readIndexNames({ db, tableName: "threads" })).toContain(
        "threads_section_archived_deleted_idx",
      );
      expect(db.$client.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
    } finally {
      closeConnection(db);
    }
  });

  it("removes manager thread type schema while preserving existing threads", () => {
    const db = createConnection(":memory:");

    try {
      migrate(db);
      dropRewindAddedTables(db);
      restorePre0022ThreadTypeSchema(db);
      db.$client.exec(`
        INSERT INTO projects (id, name, created_at, updated_at)
        VALUES ('proj_manager_cleanup', 'Manager cleanup', 1000, 1000);

        INSERT INTO threads (
          id,
          project_id,
          provider_id,
          type,
          sort_key,
          title,
          status,
          latest_attention_at,
          created_at,
          updated_at
        )
        VALUES (
          'thr_former_manager',
          'proj_manager_cleanup',
          'codex',
          'manager',
          '0000000000000001',
          'Former manager',
          'idle',
          2000,
          2000,
          2000
        );

        INSERT INTO threads (
          id,
          project_id,
          provider_id,
          type,
          parent_thread_id,
          title,
          status,
          latest_attention_at,
          created_at,
          updated_at
        )
        VALUES (
          'thr_former_child',
          'proj_manager_cleanup',
          'codex',
          'standard',
          'thr_former_manager',
          'Former child',
          'idle',
          3000,
          3000,
          3000
        );

        INSERT INTO project_execution_defaults (
          project_id,
          provider_id,
          thread_type,
          model,
          service_tier,
          reasoning_level,
          permission_mode,
          updated_at
        )
        VALUES
          (
            'proj_manager_cleanup',
            'codex',
            'standard',
            'gpt-5',
            'default',
            'medium',
            'full',
            4000
          ),
          (
            'proj_manager_cleanup',
            'codex',
            'manager',
            'gpt-5.5',
            'default',
            'xhigh',
            'full',
            5000
          );

      `);
      db.$client
        .prepare<DeleteMigrationParameters>(
          `
            DELETE FROM __drizzle_migrations
            WHERE created_at >= ?
          `,
        )
        .run(threadTypeRemovalMigrationWhen);
      dropPost0023Tables(db);
      restoreEnvironmentCleanupModeColumn(db);
      restoreEnvironmentCleanupRequestedAtColumn(db);
      restoreThreadStopRequestedAtColumn(db);

      migrate(db);

      const threadColumns = db.$client
        .prepare<[], TableInfoRow>("PRAGMA table_info(threads)")
        .all()
        .map((row) => row.name);
      expect(threadColumns).not.toContain("type");
      expect(threadColumns).not.toContain("sort_key");

      const defaultsColumns = db.$client
        .prepare<[], TableInfoRow>(
          "PRAGMA table_info(project_execution_defaults)",
        )
        .all()
        .map((row) => row.name);
      expect(defaultsColumns).not.toContain("thread_type");

      expect(
        db.$client
          .prepare<[], MigratedManagerCleanupThreadRow>(
            `
              SELECT id, parent_thread_id AS parentThreadId
              FROM threads
              WHERE id IN ('thr_former_manager', 'thr_former_child')
              ORDER BY id
            `,
          )
          .all(),
      ).toEqual([
        {
          id: "thr_former_child",
          parentThreadId: "thr_former_manager",
        },
        {
          id: "thr_former_manager",
          parentThreadId: null,
        },
      ]);

      expect(
        db.$client
          .prepare<[], MigratedManagerCleanupDefaultRow>(
            `
              SELECT
                provider_id AS providerId,
                model,
                service_tier AS serviceTier,
                reasoning_level AS reasoningLevel,
                permission_mode AS permissionMode
              FROM project_execution_defaults
              WHERE project_id = 'proj_manager_cleanup'
            `,
          )
          .get(),
      ).toEqual({
        providerId: "codex",
        model: "gpt-5",
        serviceTier: "default",
        reasoningLevel: "medium",
        permissionMode: "full",
      });
    } finally {
      closeConnection(db);
    }
  });

  it("moves fork and side-chat provenance out of parent_thread_id", () => {
    const db = createConnection(":memory:");

    try {
      migrate(db);
      db.$client
        .prepare("DROP INDEX IF EXISTS `threads_source_origin_idx`")
        .run();
      db.$client
        .prepare("ALTER TABLE `threads` DROP COLUMN `source_thread_id`")
        .run();
      db.$client
        .prepare("ALTER TABLE `threads` DROP COLUMN `origin_kind`")
        .run();
      restoreLegacyThreadOriginColumn(db);
      db.$client
        .prepare<DeleteMigrationParameters>(
          `
            DELETE FROM __drizzle_migrations
            WHERE created_at >= ?
          `,
        )
        .run(threadSourceOriginMigrationWhen);
      dropRewindAddedTables(db);
      db.$client.exec(`
        DROP TRIGGER IF EXISTS thread_search_segments_after_text_update;
        DROP TRIGGER IF EXISTS thread_search_segments_after_delete;
        DROP TRIGGER IF EXISTS thread_search_segments_after_insert;
        DROP TABLE IF EXISTS thread_search_segments_fts;
        DROP TABLE IF EXISTS thread_search_segments;
      `);

      db.$client.exec(`
        INSERT INTO projects (id, kind, name, sort_key, created_at, updated_at)
        VALUES ('proj_thread_provenance', 'standard', 'Thread provenance', 'a', 1000, 1000);

        INSERT INTO threads (
          id,
          project_id,
          provider_id,
          title,
          status,
          latest_attention_at,
          created_at,
          updated_at
        )
        VALUES (
          'thr_source',
          'proj_thread_provenance',
          'codex',
          'Source',
          'idle',
          1000,
          1000,
          1000
        );

        INSERT INTO threads (
          id,
          project_id,
          provider_id,
          parent_thread_id,
          child_origin,
          title,
          status,
          latest_attention_at,
          created_at,
          updated_at
        )
        VALUES
          (
            'thr_delegated_child',
            'proj_thread_provenance',
            'codex',
            'thr_source',
            NULL,
            'Delegated child',
            'idle',
            1100,
            1100,
            1100
          ),
          (
            'thr_fork',
            'proj_thread_provenance',
            'codex',
            'thr_source',
            'fork',
            'Fork',
            'idle',
            1200,
            1200,
            1200
          ),
          (
            'thr_side_chat',
            'proj_thread_provenance',
            'codex',
            'thr_source',
            'side-chat',
            'Side chat',
            'idle',
            1300,
            1300,
            1300
          );
      `);

      migrate(db);

      expect(
        db.$client
          .prepare<[], MigratedThreadProvenanceRow>(
            `
              SELECT
                id,
                parent_thread_id AS parentThreadId,
                source_thread_id AS sourceThreadId,
                origin_kind AS originKind
              FROM threads
              WHERE id IN ('thr_delegated_child', 'thr_fork', 'thr_side_chat')
              ORDER BY id
            `,
          )
          .all(),
      ).toEqual([
        {
          id: "thr_delegated_child",
          parentThreadId: "thr_source",
          sourceThreadId: null,
          originKind: null,
        },
        {
          id: "thr_fork",
          parentThreadId: null,
          sourceThreadId: "thr_source",
          originKind: "fork",
        },
        {
          id: "thr_side_chat",
          parentThreadId: null,
          sourceThreadId: "thr_source",
          originKind: "fork",
        },
      ]);
      expect(
        db.$client
          .prepare<[], TableInfoRow>("PRAGMA table_info(threads)")
          .all()
          .some((column) => column.name === "child_origin"),
      ).toBe(false);
    } finally {
      closeConnection(db);
    }
  });

  it("repairs history for cleanup migrations already reflected in schema", () => {
    const db = createConnection(":memory:");

    try {
      migrate(db);
      db.$client.exec(`
        ALTER TABLE environments
          ADD COLUMN cleanup_mode text DEFAULT 'defer' NOT NULL;
        ALTER TABLE environments
          ADD COLUMN cleanup_requested_at integer;
        CREATE INDEX environments_cleanup_requested_idx
          ON environments (cleanup_requested_at);
        ALTER TABLE threads
          ADD COLUMN stop_requested_at integer;
      `);
      db.$client
        .prepare<[number, number, number]>(
          `
            DELETE FROM __drizzle_migrations
            WHERE created_at IN (?, ?, ?)
          `,
        )
        .run(
          cleanupModeDropMigrationWhen,
          stopRequestedAtDropMigrationWhen,
          cleanupRequestedAtDropMigrationWhen,
        );

      migrate(db);

      const environmentColumns = db.$client
        .prepare<[], TableInfoRow>("PRAGMA table_info(environments)")
        .all()
        .map((row) => row.name);
      expect(environmentColumns).not.toContain("cleanup_mode");
      expect(environmentColumns).not.toContain("cleanup_requested_at");

      const threadColumns = db.$client
        .prepare<[], TableInfoRow>("PRAGMA table_info(threads)")
        .all()
        .map((row) => row.name);
      expect(threadColumns).not.toContain("stop_requested_at");

      const appliedCreatedAts = db.$client
        .prepare<[number, number, number], MigrationCreatedAtRow>(
          `
            SELECT created_at AS createdAt
            FROM __drizzle_migrations
            WHERE created_at IN (?, ?, ?)
            ORDER BY created_at
          `,
        )
        .all(
          cleanupModeDropMigrationWhen,
          stopRequestedAtDropMigrationWhen,
          cleanupRequestedAtDropMigrationWhen,
        )
        .map((row) => row.createdAt);
      expect(appliedCreatedAts).toEqual([
        cleanupModeDropMigrationWhen,
        stopRequestedAtDropMigrationWhen,
        cleanupRequestedAtDropMigrationWhen,
      ]);
    } finally {
      closeConnection(db);
    }
  });

  it("normalizes legacy expired pending interactions and drops session_id", () => {
    const db = createConnection(":memory:");

    try {
      db.$client.exec(`
        CREATE TABLE pending_interactions (
          id text PRIMARY KEY NOT NULL,
          thread_id text NOT NULL,
          turn_id text NOT NULL,
          provider_id text NOT NULL,
          provider_thread_id text NOT NULL,
          provider_request_id text NOT NULL,
          session_id text NOT NULL,
          status text NOT NULL,
          payload text NOT NULL,
          resolution text,
          status_reason text,
          created_at integer NOT NULL,
          resolved_at integer,
          updated_at integer NOT NULL
        );
        INSERT INTO pending_interactions (
          id,
          thread_id,
          turn_id,
          provider_id,
          provider_thread_id,
          provider_request_id,
          session_id,
          status,
          payload,
          resolution,
          status_reason,
          created_at,
          resolved_at,
          updated_at
        )
        VALUES
          (
            'pi_expired_without_reason',
            'thr_legacy_pending',
            'turn_legacy_pending_1',
            'codex',
            'provider-thread-legacy-pending',
            'request-legacy-pending-1',
            'session-legacy-pending',
            'expired',
            '{}',
            NULL,
            NULL,
            10,
            NULL,
            20
          ),
          (
            'pi_expired_with_reason',
            'thr_legacy_pending',
            'turn_legacy_pending_2',
            'codex',
            'provider-thread-legacy-pending',
            'request-legacy-pending-2',
            'session-legacy-pending',
            'expired',
            '{}',
            NULL,
            'Already expired',
            30,
            50,
            40
          ),
          (
            'pi_interrupted',
            'thr_legacy_pending',
            'turn_legacy_pending_3',
            'codex',
            'provider-thread-legacy-pending',
            'request-legacy-pending-3',
            'session-legacy-pending',
            'interrupted',
            '{}',
            NULL,
            'Manual stop',
            60,
            70,
            80
          );
        CREATE TABLE events (
          id text PRIMARY KEY NOT NULL,
          type text NOT NULL,
          data text NOT NULL
        );
        INSERT INTO events (id, type, data)
        VALUES
          (
            'evt_expired_permission_grant',
            'system/permissionGrant/lifecycle',
            '{"status":"expired","statusReason":"Already expired"}'
          ),
          (
            'evt_expired_user_question',
            'system/userQuestion/lifecycle',
            '{"status":"expired"}'
          ),
          (
            'evt_interrupted_permission_grant',
            'system/permissionGrant/lifecycle',
            '{"status":"interrupted","statusReason":"Manual stop"}'
          ),
          (
            'evt_other_expired',
            'system/operation',
            '{"status":"expired"}'
          );
      `);

      runMigrationFile({
        db,
        migrationPath: pendingInteractionSchemaHonestyMigrationPath,
      });

      const rows = db.$client
        .prepare<[], MigratedPendingInteractionStatusRow>(
          `
            SELECT
              id,
              status,
              status_reason AS statusReason,
              resolved_at AS resolvedAt,
              updated_at AS updatedAt
            FROM pending_interactions
            ORDER BY id
          `,
        )
        .all();

      expect(rows).toEqual([
        {
          id: "pi_expired_with_reason",
          status: "interrupted",
          statusReason: "Already expired",
          resolvedAt: 50,
          updatedAt: 50,
        },
        {
          id: "pi_expired_without_reason",
          status: "interrupted",
          statusReason: "Pending interaction expired",
          resolvedAt: 20,
          updatedAt: 20,
        },
        {
          id: "pi_interrupted",
          status: "interrupted",
          statusReason: "Manual stop",
          resolvedAt: 70,
          updatedAt: 80,
        },
      ]);
      const pendingInteractionColumns = db.$client
        .prepare<[], TableNameRow>(
          `
            SELECT name
            FROM pragma_table_info('pending_interactions')
            ORDER BY cid
          `,
        )
        .all()
        .map((row) => row.name);
      expect(pendingInteractionColumns).toEqual([
        "id",
        "thread_id",
        "turn_id",
        "provider_id",
        "provider_thread_id",
        "provider_request_id",
        "status",
        "payload",
        "resolution",
        "status_reason",
        "created_at",
        "resolved_at",
        "updated_at",
      ]);
      const eventRows = db.$client
        .prepare<[], MigratedPendingInteractionEventStatusRow>(
          `
            SELECT
              id,
              json_extract(data, '$.status') AS status,
              json_extract(data, '$.statusReason') AS statusReason
            FROM events
            ORDER BY id
          `,
        )
        .all();
      expect(eventRows).toEqual([
        {
          id: "evt_expired_permission_grant",
          status: "interrupted",
          statusReason: "Already expired",
        },
        {
          id: "evt_expired_user_question",
          status: "interrupted",
          statusReason: "Pending interaction expired",
        },
        {
          id: "evt_interrupted_permission_grant",
          status: "interrupted",
          statusReason: "Manual stop",
        },
        {
          id: "evt_other_expired",
          status: "expired",
          statusReason: null,
        },
      ]);
    } finally {
      closeConnection(db);
    }
  });

  it("warns when applied migration timestamps are in the future", () => {
    const db = createConnection(":memory:");
    const logger = {
      warn: vi.fn(),
    } satisfies MigrationWarningLogger;

    try {
      migrate(db);
      const latestMigrationCreatedAt = readLatestAppliedMigrationCreatedAt(db);
      vi.useFakeTimers();
      vi.setSystemTime(latestMigrationCreatedAt + 10_000);

      migrate(db, { logger });
      expect(logger.warn).not.toHaveBeenCalled();

      const futureCreatedAt = Date.now() + 60_000;
      db.$client
        .prepare<InsertMigrationParameters>(
          `
            INSERT INTO __drizzle_migrations (hash, created_at)
            VALUES (?, ?)
          `,
        )
        .run("future-migration-hash", futureCreatedAt);

      migrate(db, { logger });

      expect(logger.warn).toHaveBeenCalledTimes(1);
      expect(logger.warn).toHaveBeenCalledWith(
        {
          migrations: [
            {
              createdAt: futureCreatedAt,
              hash: "future-migration-hash",
            },
          ],
          now: expect.any(Number),
        },
        "Applied database migrations have future timestamps",
      );
    } finally {
      closeConnection(db);
      vi.useRealTimers();
    }
  });

  it("can defer destructive legacy cleanup while preserving state backfills", () => {
    const db = createConnection(":memory:");

    try {
      migrate(db);
      db.$client.prepare("DROP INDEX projects_deleted_idx").run();
      db.$client.prepare("ALTER TABLE projects DROP COLUMN deleted_at").run();
      db.$client.prepare("ALTER TABLE events ADD producer_event_id text").run();
      db.$client
        .prepare("ALTER TABLE events ADD producer_event_payload_hash text")
        .run();
      db.$client
        .prepare(
          "CREATE UNIQUE INDEX events_producer_event_id_idx ON events (producer_event_id)",
        )
        .run();
      db.$client
        .prepare(
          "ALTER TABLE hosts ADD command_cursor integer DEFAULT 0 NOT NULL",
        )
        .run();
      db.$client.exec(`
        CREATE TABLE host_daemon_commands (
          id text PRIMARY KEY NOT NULL
        );
        CREATE TABLE host_daemon_command_attempts (
          id text PRIMARY KEY NOT NULL
        );
        CREATE TABLE client_turn_requests (
          id text PRIMARY KEY NOT NULL
        );
        CREATE TABLE environment_operations (
          id text PRIMARY KEY NOT NULL,
          environment_id text NOT NULL,
          kind text NOT NULL,
          state text NOT NULL
        );
        CREATE TABLE project_operations (
          id text PRIMARY KEY NOT NULL,
          project_id text NOT NULL,
          kind text NOT NULL,
          state text NOT NULL,
          requested_at integer NOT NULL
        );
        CREATE TABLE thread_operations (
          id text PRIMARY KEY NOT NULL,
          thread_id text NOT NULL,
          kind text NOT NULL,
          state text NOT NULL,
          payload text NOT NULL,
          requested_at integer NOT NULL
        );
        INSERT INTO hosts (
          id,
          name,
          type,
          command_cursor,
          created_at,
          updated_at
        )
        VALUES (
          'host_deferred_cleanup',
          'Deferred cleanup host',
          'persistent',
          0,
          1000,
          1000
        );
        INSERT INTO projects (
          id,
          name,
          created_at,
          updated_at
        )
        VALUES (
          'proj_deferred_cleanup',
          'Deferred cleanup project',
          1000,
          1000
        );
        INSERT INTO environments (
          id,
          project_id,
          host_id,
          path,
          workspace_provision_type,
          status,
          created_at,
          updated_at
        )
        VALUES (
          'env_deferred_cleanup',
          'proj_deferred_cleanup',
          'host_deferred_cleanup',
          '/tmp/deferred-cleanup',
          'managed-worktree',
          'provisioning',
          1000,
          1000
        );
        INSERT INTO threads (
          id,
          project_id,
          environment_id,
          provider_id,
          status,
          latest_attention_at,
          created_at,
          updated_at
        )
        VALUES (
          'thr_deferred_cleanup',
          'proj_deferred_cleanup',
          'env_deferred_cleanup',
          'codex',
          'provisioning',
          1000,
          1000,
          1000
        ),
        (
          'thr_deferred_bad_stop_reason',
          'proj_deferred_cleanup',
          'env_deferred_cleanup',
          'codex',
          'active',
          1000,
          1000,
          1000
        );
        INSERT INTO thread_operations (
          id,
          thread_id,
          kind,
          state,
          payload,
          requested_at
        )
        VALUES
          (
            'top_deferred_provision',
            'thr_deferred_cleanup',
            'provision',
            'queued',
            '{}',
            2000
          ),
          (
            'top_deferred_stop',
            'thr_deferred_cleanup',
            'stop',
            'requested',
            '{"interruptionReason":"host-daemon-restarted"}',
            2500
          ),
          (
            'top_deferred_bad_stop_reason',
            'thr_deferred_bad_stop_reason',
            'stop',
            'queued',
            '{"interruptionReason":"legacy-freeform-reason"}',
            2550
          );
        INSERT INTO environment_operations (
          id,
          environment_id,
          kind,
          state
        )
        VALUES (
          'eop_deferred_provision',
          'env_deferred_cleanup',
          'provision',
          'queued'
        );
        INSERT INTO project_operations (
          id,
          project_id,
          kind,
          state,
          requested_at
        )
        VALUES (
          'pop_deferred_delete',
          'proj_deferred_cleanup',
          'delete',
          'requested',
          3000
        );
      `);
      deleteDeferredCleanupMigrationRows(db);
      restoreEnvironmentCleanupRequestedAtColumn(db);
      restoreThreadStopRequestedAtColumn(db);

      migrate(db, { deferDestructiveLegacyCleanup: true });

      expect(readTableNames(db)).toEqual(
        expect.arrayContaining([
          "client_turn_requests",
          "environment_operations",
          "host_daemon_command_attempts",
          "host_daemon_commands",
          "project_operations",
          "thread_operations",
        ]),
      );
      expect(
        db.$client
          .prepare<[], TableInfoRow>("PRAGMA table_info(events)")
          .all()
          .map((row) => row.name),
      ).toEqual(expect.arrayContaining(["producer_event_id"]));
      expect(
        db.$client
          .prepare<[], TableInfoRow>("PRAGMA table_info(hosts)")
          .all()
          .map((row) => row.name),
      ).toEqual(expect.arrayContaining(["command_cursor"]));
      expect(
        db.$client
          .prepare<[], OperationBackfillThreadRow>(
            `
              SELECT status
              FROM threads
              WHERE id = 'thr_deferred_cleanup'
            `,
          )
          .get(),
      ).toEqual({
        status: "error",
      });
      expect(
        db.$client
          .prepare<[], OperationBackfillProjectRow>(
            `
              SELECT deleted_at AS deletedAt
              FROM projects
              WHERE id = 'proj_deferred_cleanup'
            `,
          )
          .get(),
      ).toEqual({
        deletedAt: 3_000,
      });
      expect(
        db.$client
          .prepare<[], OperationBackfillEnvironmentRow>(
            `
              SELECT status
              FROM environments
              WHERE id = 'env_deferred_cleanup'
            `,
          )
          .get(),
      ).toEqual({
        status: "error",
      });
      expect(
        db.$client
          .prepare<[], MigratedEventRow>(
            `
              SELECT
                id,
                thread_id AS threadId,
                environment_id AS environmentId,
                scope_kind AS scopeKind,
                turn_id AS turnId,
                provider_thread_id AS providerThreadId,
                sequence,
                type,
                item_id AS itemId,
                item_kind AS itemKind,
                data,
                created_at AS createdAt
              FROM events
              WHERE id = 'evt_top_deferred_stop'
            `,
          )
          .get(),
      ).toEqual({
        createdAt: 2_500,
        data: '{"reason":"host-daemon-restarted"}',
        environmentId: "env_deferred_cleanup",
        id: "evt_top_deferred_stop",
        itemId: null,
        itemKind: null,
        providerThreadId: null,
        scopeKind: "thread",
        sequence: 1,
        threadId: "thr_deferred_cleanup",
        turnId: null,
        type: "system/thread/interrupted",
      });
      expect(
        db.$client
          .prepare<[], Pick<MigratedEventRow, "data">>(
            `
              SELECT data
              FROM events
              WHERE id = 'evt_top_deferred_bad_stop_reason'
            `,
          )
          .get(),
      ).toEqual({
        data: '{"reason":"manual-stop"}',
      });

      const migrationCreatedAts = db.$client
        .prepare<[], MigrationCreatedAtRow>(
          `
            SELECT created_at AS createdAt
            FROM __drizzle_migrations
            ORDER BY created_at
          `,
        )
        .all()
        .map((row) => row.createdAt);
      expect(migrationCreatedAts).toEqual(
        expect.arrayContaining([
          operationStateBackfillMigrationWhen,
          eventProducerColumnsMigrationWhen,
          terminalSessionRuntimeStateHonestyWhen,
          hostDaemonSessionObservabilityMigrationWhen,
        ]),
      );
    } finally {
      closeConnection(db);
    }
  });

  it("applies 0002 after a database already applied main's 0001 timestamp", () => {
    const db = createConnection(":memory:");

    try {
      migrate(db);
      dropRewindAddedTables(db);
      restorePre0022ThreadTypeSchema(db);
      addPre0017TerminalRuntimeColumns(db);

      db.$client
        .prepare("DROP INDEX host_daemon_sessions_closed_prune_idx")
        .run();
      db.$client
        .prepare(
          "DROP INDEX thread_dynamic_context_file_states_thread_file_idx",
        )
        .run();
      db.$client.prepare("DROP INDEX projects_sort_idx").run();
      db.$client.prepare("DROP INDEX projects_personal_singleton_idx").run();
      db.$client.prepare("DROP INDEX threads_project_type_sort_idx").run();
      db.$client.prepare("DROP INDEX threads_pin_sort_idx").run();
      db.$client.prepare("DROP TABLE IF EXISTS thread_schedules").run();
      db.$client
        .prepare(
          `
            CREATE TABLE manager_thread_nudges (
              id text PRIMARY KEY NOT NULL,
              project_id text NOT NULL,
              thread_id text NOT NULL,
              name text NOT NULL,
              cron text NOT NULL,
              timezone text NOT NULL,
              enabled integer DEFAULT true NOT NULL,
              next_fire_at integer NOT NULL,
              last_fired_at integer,
              created_at integer NOT NULL,
              updated_at integer NOT NULL,
              FOREIGN KEY (project_id) REFERENCES projects(id) ON UPDATE no action ON DELETE cascade,
              FOREIGN KEY (thread_id) REFERENCES threads(id) ON UPDATE no action ON DELETE cascade
            )
          `,
        )
        .run();
      db.$client.prepare("DROP TABLE thread_dynamic_context_file_states").run();
      dropPost0023Tables(db);
      db.$client.prepare("DELETE FROM projects WHERE kind = 'personal'").run();
      db.$client.prepare("ALTER TABLE projects DROP COLUMN kind").run();
      db.$client.prepare("ALTER TABLE projects DROP COLUMN sort_key").run();
      db.$client.prepare("ALTER TABLE threads DROP COLUMN sort_key").run();
      db.$client.prepare("ALTER TABLE threads DROP COLUMN pinned_at").run();
      db.$client.prepare("ALTER TABLE threads DROP COLUMN pin_sort_key").run();
      db.$client
        .prepare("ALTER TABLE threads DROP COLUMN model_override")
        .run();
      db.$client
        .prepare("ALTER TABLE threads DROP COLUMN reasoning_level_override")
        .run();
      db.$client.prepare("ALTER TABLE events ADD producer_event_id text").run();
      db.$client
        .prepare("ALTER TABLE events ADD producer_event_payload_hash text")
        .run();
      db.$client
        .prepare(
          "CREATE UNIQUE INDEX events_producer_event_id_idx ON events (producer_event_id)",
        )
        .run();
      db.$client.prepare("DROP INDEX projects_deleted_idx").run();
      db.$client.prepare("ALTER TABLE projects DROP COLUMN deleted_at").run();
      db.$client
        .prepare(
          "ALTER TABLE hosts ADD command_cursor integer DEFAULT 0 NOT NULL",
        )
        .run();
      db.$client.exec(`
        CREATE TABLE host_daemon_commands (
          id text PRIMARY KEY NOT NULL,
          host_id text NOT NULL,
          session_id text,
          cursor integer NOT NULL,
          type text NOT NULL,
          payload text NOT NULL,
          state text NOT NULL,
          retry_count integer DEFAULT 0 NOT NULL,
          result_payload text,
          created_at integer NOT NULL,
          fetched_at integer,
          completed_at integer,
          FOREIGN KEY (host_id) REFERENCES hosts(id) ON UPDATE no action ON DELETE cascade,
          FOREIGN KEY (session_id) REFERENCES host_daemon_sessions(id) ON UPDATE no action ON DELETE set null
        );
        CREATE TABLE environment_operations (
          id text PRIMARY KEY NOT NULL,
          environment_id text NOT NULL,
          kind text NOT NULL,
          state text NOT NULL,
          payload text NOT NULL,
          command_id text,
          requested_at integer NOT NULL,
          queued_at integer,
          completed_at integer,
          failure_reason text,
          created_at integer NOT NULL,
          updated_at integer NOT NULL,
          FOREIGN KEY (environment_id) REFERENCES environments(id) ON UPDATE no action ON DELETE cascade,
          FOREIGN KEY (command_id) REFERENCES host_daemon_commands(id) ON UPDATE no action ON DELETE set null
        );
        CREATE UNIQUE INDEX environment_operations_environment_kind_idx ON environment_operations (environment_id, kind);
        CREATE UNIQUE INDEX environment_operations_command_idx ON environment_operations (command_id);
        CREATE INDEX environment_operations_state_idx ON environment_operations (state);
        CREATE INDEX environment_operations_environment_idx ON environment_operations (environment_id);
        CREATE TABLE project_operations (
          id text PRIMARY KEY NOT NULL,
          project_id text NOT NULL,
          kind text NOT NULL,
          state text NOT NULL,
          payload text NOT NULL,
          command_id text,
          requested_at integer NOT NULL,
          queued_at integer,
          completed_at integer,
          failure_reason text,
          created_at integer NOT NULL,
          updated_at integer NOT NULL,
          FOREIGN KEY (project_id) REFERENCES projects(id) ON UPDATE no action ON DELETE cascade,
          FOREIGN KEY (command_id) REFERENCES host_daemon_commands(id) ON UPDATE no action ON DELETE set null
        );
        CREATE UNIQUE INDEX project_operations_project_kind_idx ON project_operations (project_id, kind);
        CREATE UNIQUE INDEX project_operations_command_idx ON project_operations (command_id);
        CREATE INDEX project_operations_state_idx ON project_operations (state);
        CREATE INDEX project_operations_project_idx ON project_operations (project_id);
        CREATE TABLE thread_operations (
          id text PRIMARY KEY NOT NULL,
          thread_id text NOT NULL,
          kind text NOT NULL,
          state text NOT NULL,
          payload text NOT NULL,
          provisioning_id text,
          provisioning_stage text,
          provisioning_environment_id text,
          provision_event_sequence integer,
          workspace_ready_event_sequence integer,
          command_id text,
          requested_at integer NOT NULL,
          queued_at integer,
          completed_at integer,
          failure_reason text,
          created_at integer NOT NULL,
          updated_at integer NOT NULL,
          FOREIGN KEY (thread_id) REFERENCES threads(id) ON UPDATE no action ON DELETE cascade,
          FOREIGN KEY (provisioning_environment_id) REFERENCES environments(id) ON UPDATE no action ON DELETE set null,
          FOREIGN KEY (command_id) REFERENCES host_daemon_commands(id) ON UPDATE no action ON DELETE set null
        );
        CREATE UNIQUE INDEX thread_operations_thread_kind_idx ON thread_operations (thread_id, kind);
        CREATE UNIQUE INDEX thread_operations_command_idx ON thread_operations (command_id);
        CREATE INDEX thread_operations_state_idx ON thread_operations (state);
        CREATE INDEX thread_operations_thread_idx ON thread_operations (thread_id);
      `);
      db.$client.exec(`
        INSERT INTO hosts (
          id,
          name,
          type,
          command_cursor,
          destroyed_at,
          last_seen_at,
          created_at,
          updated_at
        )
        VALUES (
          'host_legacy_operation_backfill',
          'Legacy operation backfill host',
          'persistent',
          0,
          NULL,
          NULL,
          1000,
          1000
        );
        INSERT INTO projects (
          id,
          name,
          created_at,
          updated_at
        )
        VALUES (
          'proj_legacy_operation_backfill',
          'Legacy operation backfill project',
          1000,
          1000
        );
        INSERT INTO environments (
          id,
          project_id,
          host_id,
          path,
          managed,
          is_git_repo,
          is_worktree,
          workspace_provision_type,
          status,
          created_at,
          updated_at
        )
        VALUES (
          'env_legacy_operation_backfill',
          'proj_legacy_operation_backfill',
          'host_legacy_operation_backfill',
          '/tmp/legacy-operation-backfill',
          1,
          1,
          1,
          'managed-worktree',
          'provisioning',
          1000,
          1000
        );
        INSERT INTO threads (
          id,
          project_id,
          environment_id,
          provider_id,
          status,
          latest_attention_at,
          created_at,
          updated_at
        )
        VALUES (
          'thr_legacy_operation_backfill',
          'proj_legacy_operation_backfill',
          'env_legacy_operation_backfill',
          'codex',
          'provisioning',
          1000,
          1000,
          1000
        );
        INSERT INTO threads (
          id,
          project_id,
          environment_id,
          provider_id,
          status,
          latest_attention_at,
          created_at,
          updated_at
        )
        VALUES (
          'thr_legacy_bad_stop_reason',
          'proj_legacy_operation_backfill',
          'env_legacy_operation_backfill',
          'codex',
          'active',
          1000,
          1000,
          1000
        );
        INSERT INTO thread_operations (
          id,
          thread_id,
          kind,
          state,
          payload,
          provisioning_id,
          provisioning_stage,
          provisioning_environment_id,
          provision_event_sequence,
          workspace_ready_event_sequence,
          command_id,
          requested_at,
          queued_at,
          completed_at,
          failure_reason,
          created_at,
          updated_at
        )
        VALUES (
          'top_legacy_provision_backfill',
          'thr_legacy_operation_backfill',
          'provision',
          'queued',
          '{"workspaceProvisionType":"managed-worktree"}',
          'tpv_legacy_operation_backfill',
          'workspace-ready',
          'env_legacy_operation_backfill',
          41,
          42,
          NULL,
          2000,
          2010,
          NULL,
          NULL,
          2000,
          2010
        );
        INSERT INTO thread_operations (
          id,
          thread_id,
          kind,
          state,
          payload,
          provisioning_id,
          provisioning_stage,
          provisioning_environment_id,
          provision_event_sequence,
          workspace_ready_event_sequence,
          command_id,
          requested_at,
          queued_at,
          completed_at,
          failure_reason,
          created_at,
          updated_at
        )
        VALUES (
          'top_legacy_stop_backfill',
          'thr_legacy_operation_backfill',
          'stop',
          'requested',
          '{"interruptionReason":"host-daemon-restarted"}',
          NULL,
          NULL,
          NULL,
          NULL,
          NULL,
          NULL,
          2500,
          NULL,
          NULL,
          NULL,
          2500,
          2500
        );
        INSERT INTO thread_operations (
          id,
          thread_id,
          kind,
          state,
          payload,
          provisioning_id,
          provisioning_stage,
          provisioning_environment_id,
          provision_event_sequence,
          workspace_ready_event_sequence,
          command_id,
          requested_at,
          queued_at,
          completed_at,
          failure_reason,
          created_at,
          updated_at
        )
        VALUES (
          'top_legacy_bad_stop_reason',
          'thr_legacy_bad_stop_reason',
          'stop',
          'queued',
          '{"interruptionReason":"legacy-freeform-reason"}',
          NULL,
          NULL,
          NULL,
          NULL,
          NULL,
          NULL,
          2550,
          2560,
          NULL,
          NULL,
          2550,
          2560
        );
        INSERT INTO environment_operations (
          id,
          environment_id,
          kind,
          state,
          payload,
          command_id,
          requested_at,
          queued_at,
          completed_at,
          failure_reason,
          created_at,
          updated_at
        )
        VALUES (
          'eop_legacy_provision_backfill',
          'env_legacy_operation_backfill',
          'provision',
          'queued',
          '{}',
          NULL,
          2600,
          2610,
          NULL,
          NULL,
          2600,
          2610
        );
        INSERT INTO project_operations (
          id,
          project_id,
          kind,
          state,
          payload,
          command_id,
          requested_at,
          queued_at,
          completed_at,
          failure_reason,
          created_at,
          updated_at
        )
        VALUES (
          'pop_legacy_delete_backfill',
          'proj_legacy_operation_backfill',
          'delete',
          'requested',
          '{}',
          NULL,
          3000,
          NULL,
          NULL,
          NULL,
          3000,
          3000
        );
      `);
      db.$client
        .prepare(
          "ALTER TABLE host_daemon_sessions ADD COLUMN last_heartbeat_at integer",
        )
        .run();
      db.$client
        .prepare(
          "ALTER TABLE pending_interactions ADD COLUMN session_id text NOT NULL DEFAULT 'legacy-session'",
        )
        .run();
      db.$client.prepare("DELETE FROM __drizzle_migrations").run();
      db.$client
        .prepare<InsertMigrationParameters>(
          `
            INSERT INTO __drizzle_migrations (hash, created_at)
            VALUES (?, ?)
          `,
        )
        .run("baseline-hash", baselineWhen);
      db.$client
        .prepare<InsertMigrationParameters>(
          `
            INSERT INTO __drizzle_migrations (hash, created_at)
            VALUES (?, ?)
          `,
        )
        .run("main-0001-hash", publishedTerminalSessionUserInputWhen);
      dropEnvironmentNameColumn(db);
      dropEnvironmentDestroyAttemptIdColumn(db);
      restoreEnvironmentCleanupModeColumn(db);
      restoreEnvironmentCleanupRequestedAtColumn(db);
      restoreThreadStopRequestedAtColumn(db);
      dropPost0023Tables(db);

      expect(
        readIndexNames({ db, tableName: "host_daemon_sessions" }),
      ).not.toContain("host_daemon_sessions_closed_prune_idx");

      migrate(db);

      expect(
        readIndexNames({ db, tableName: "host_daemon_sessions" }),
      ).toContain("host_daemon_sessions_closed_prune_idx");
      expect(readTableNames(db)).not.toEqual(
        expect.arrayContaining([
          "client_turn_requests",
          "environment_operations",
          "host_daemon_command_attempts",
          "host_daemon_commands",
          "project_operations",
          "thread_operations",
        ]),
      );
      expect(
        db.$client
          .prepare<[], TableInfoRow>("PRAGMA table_info(hosts)")
          .all()
          .map((row) => row.name),
      ).not.toContain("command_cursor");
      expect(
        db.$client
          .prepare<[], TableInfoRow>("PRAGMA table_info(events)")
          .all()
          .map((row) => row.name),
      ).toEqual([
        "id",
        "thread_id",
        "environment_id",
        "scope_kind",
        "turn_id",
        "provider_thread_id",
        "sequence",
        "type",
        "item_id",
        "item_kind",
        "data",
        "created_at",
        "parent_tool_call_id",
      ]);
      const eventIndexNames = readIndexNames({
        db,
        tableName: "events",
      }).filter((name) => !name.startsWith("sqlite_"));
      expect(eventIndexNames).toEqual([
        "events_background_task_thread_type_item_sequence_idx",
        "events_completed_item_truncation_idx",
        "events_delegating_item_lookup_idx",
        "events_environment_idx",
        "events_item_lifecycle_thread_item_sequence_idx",
        "events_parent_tool_call_thread_parent_sequence_idx",
        "events_plan_steps_thread_sequence_idx",
        "events_thread_sequence_idx",
        "events_thread_state_thread_sequence_idx",
        "events_thread_turn_type_item_sequence_idx",
        "events_thread_type_item_kind_sequence_idx",
        "events_thread_type_sequence_idx",
      ]);

      const migrationCreatedAts = db.$client
        .prepare<[], MigrationCreatedAtRow>(
          `
            SELECT created_at AS createdAt
            FROM __drizzle_migrations
            ORDER BY created_at
          `,
        )
        .all()
        .map((row) => row.createdAt);
      expect(migrationCreatedAts).toContain(closedSessionPruneIndexesWhen);
      expect(migrationCreatedAts).toContain(threadDynamicContextFileStatesWhen);
      expect(migrationCreatedAts).toContain(commandLookupIndexesWhen);
      expect(migrationCreatedAts).toContain(threadPinningMigrationWhen);
      expect(
        db.$client
          .prepare<[], OperationBackfillThreadRow>(
            `
            SELECT status
              FROM threads
              WHERE id = 'thr_legacy_operation_backfill'
            `,
          )
          .get(),
      ).toEqual({
        status: "error",
      });
      const interruptedEvent = db.$client
        .prepare<[], MigratedEventRow>(
          `
            SELECT
              id,
              thread_id AS threadId,
              environment_id AS environmentId,
              scope_kind AS scopeKind,
              turn_id AS turnId,
              provider_thread_id AS providerThreadId,
              sequence,
              type,
              item_id AS itemId,
              item_kind AS itemKind,
              data,
              created_at AS createdAt
            FROM events
            WHERE id = 'evt_top_legacy_stop_backfill'
          `,
        )
        .get();
      expect(interruptedEvent).toEqual({
        createdAt: 2_500,
        data: '{"reason":"host-daemon-restarted"}',
        environmentId: "env_legacy_operation_backfill",
        id: "evt_top_legacy_stop_backfill",
        itemId: null,
        itemKind: null,
        providerThreadId: null,
        scopeKind: "thread",
        sequence: 1,
        threadId: "thr_legacy_operation_backfill",
        turnId: null,
        type: "system/thread/interrupted",
      });
      expect(
        db.$client
          .prepare<[], Pick<MigratedEventRow, "data">>(
            `
              SELECT data
              FROM events
              WHERE id = 'evt_top_legacy_bad_stop_reason'
            `,
          )
          .get(),
      ).toEqual({
        data: '{"reason":"manual-stop"}',
      });
      expect(
        db.$client
          .prepare<[], OperationBackfillEnvironmentRow>(
            `
              SELECT status
              FROM environments
              WHERE id = 'env_legacy_operation_backfill'
            `,
          )
          .get(),
      ).toEqual({
        status: "error",
      });
      expect(
        db.$client
          .prepare<[], OperationBackfillProjectRow>(
            `
              SELECT deleted_at AS deletedAt
              FROM projects
              WHERE id = 'proj_legacy_operation_backfill'
            `,
          )
          .get(),
      ).toEqual({
        deletedAt: 3_000,
      });
    } finally {
      closeConnection(db);
    }
  });

  it("preserves durable terminal session data when applying 0017", () => {
    const db = createConnection(":memory:");

    try {
      migrate(db);
      dropRewindAddedTables(db);
      restorePre0022ThreadTypeSchema(db);
      seedPre0017TerminalSessionMigration({ db });
      db.$client
        .prepare(
          "ALTER TABLE host_daemon_sessions ADD COLUMN last_heartbeat_at integer",
        )
        .run();
      db.$client
        .prepare<DeleteMigrationParameters>(
          `
            DELETE FROM __drizzle_migrations
            WHERE created_at >= ?
          `,
        )
        .run(terminalSessionRuntimeStateHonestyWhen);
      dropEnvironmentNameColumn(db);
      dropEnvironmentDestroyAttemptIdColumn(db);
      dropQueuedMessageSenderThreadIdColumn(db);
      restoreEnvironmentCleanupModeColumn(db);
      restoreEnvironmentCleanupRequestedAtColumn(db);
      restoreThreadStopRequestedAtColumn(db);
      dropPost0023Tables(db);

      migrate(db);

      expect(
        db.$client
          .prepare<[], MigratedTerminalSessionRow>(
            `
              SELECT
                id,
                thread_id AS threadId,
                environment_id AS environmentId,
                host_id AS hostId,
                daemon_session_id AS daemonSessionId,
                title,
                initial_cwd AS initialCwd,
                cols,
                rows,
                status,
                exit_code AS exitCode,
                close_reason AS closeReason,
                created_at AS createdAt,
                updated_at AS updatedAt,
                last_user_input_at AS lastUserInputAt
              FROM terminal_sessions
              WHERE id = 'term_pre0017'
            `,
          )
          .get(),
      ).toEqual({
        id: "term_pre0017",
        threadId: "thr_pre0017",
        environmentId: "env_pre0017",
        hostId: "host_pre0017",
        daemonSessionId: "sess_pre0017",
        title: "Terminal 1",
        initialCwd: "/tmp/pre0017",
        cols: 120,
        rows: 40,
        status: "running",
        exitCode: null,
        closeReason: null,
        createdAt: 1100,
        updatedAt: 1200,
        lastUserInputAt: 1300,
      });

      const terminalSessionColumns = db.$client
        .prepare<[], TableInfoRow>("PRAGMA table_info(terminal_sessions)")
        .all();
      const terminalSessionColumnNames = terminalSessionColumns.map(
        (column) => column.name,
      );
      expect(terminalSessionColumnNames).not.toContain("current_cwd");
      expect(terminalSessionColumnNames).not.toContain("last_connected_at");
      expect(terminalSessionColumnNames).not.toContain("exited_at");
      expect(
        terminalSessionColumns.find((column) => column.name === "thread_id")
          ?.notnull,
      ).toBe(0);
      expect(readAppliedMigrationCreatedAts(db)).toContain(
        threadlessTerminalSessionsMigrationWhen,
      );

      const hostDaemonSessionColumns = db.$client
        .prepare<[], TableInfoRow>("PRAGMA table_info(host_daemon_sessions)")
        .all()
        .map((column) => column.name);
      expect(hostDaemonSessionColumns).not.toContain("last_heartbeat_at");
    } finally {
      closeConnection(db);
    }
  });

  it("skips legacy large event value round trip when values are already inline", () => {
    const db = createMigratedConnection();

    try {
      dropRewindAddedTables(db);
      seedEventLargeValueBackfillThread(db);
      const values = seedEventLargeValueBackfillEvents(db);

      markEventLargeValuesMigrationUnapplied(db);
      db.$client
        .prepare<DeleteMigrationParameters>(
          `
            DELETE FROM __drizzle_migrations
            WHERE created_at = ?
          `,
        )
        .run(legacyExperimentsMigrationWhen);

      migrate(db);

      expect(readLatestAppliedMigrationCreatedAt(db)).toBe(latestMigrationWhen);
      expect(readTableNames(db)).not.toContain("event_large_values");
      expect(
        db.$client
          .prepare<[number], MigrationCountRow>(
            `
              SELECT COUNT(*) AS count
              FROM __drizzle_migrations
              WHERE created_at = ?
            `,
          )
          .get(eventLargeValuesMigrationWhen),
      ).toEqual({ count: 1 });
      expect(
        db.$client
          .prepare<[number], MigrationCountRow>(
            `
              SELECT COUNT(*) AS count
              FROM __drizzle_migrations
              WHERE created_at = ?
            `,
          )
          .get(eventLargeValuesRestoreMigrationWhen),
      ).toEqual({ count: 1 });

      expectEventLargeValuesInline(db, values);
    } finally {
      closeConnection(db);
    }
  });

  it("restores legacy large event values to inline payloads", () => {
    const db = createMigratedConnection();

    try {
      dropRewindAddedTables(db);
      seedEventLargeValueBackfillThread(db);
      const values = seedEventLargeValueBackfillEvents(db);

      markEventLargeValuesMigrationUnapplied(db);
      runMigrationFile({ db, migrationPath: eventLargeValuesMigrationPath });
      replaceAppliedMigrationHash({
        db,
        createdAt: eventLargeValuesMigrationWhen,
        hash: eventLargeValuesPreOptimizationHash,
      });

      migrate(db);

      expect(readAppliedMigrationCreatedAts(db)).toContain(
        eventLargeValuesRestoreMigrationWhen,
      );
      expect(readLatestAppliedMigrationCreatedAt(db)).toBe(latestMigrationWhen);
      expect(readTableNames(db)).not.toContain("event_large_values");
      expectEventLargeValuesInline(db, values);
    } finally {
      closeConnection(db);
    }
  });

  it("throws when an applied migration hash is missing behind the latest timestamp", () => {
    const db = createConnection(":memory:");

    try {
      migrate(db);
      db.$client
        .prepare<DeleteMigrationParameters>(
          `
            DELETE FROM __drizzle_migrations
            WHERE created_at = ?
          `,
        )
        .run(threadPinningMigrationWhen);

      expect(() => migrate(db)).toThrow(
        /Missing applied migration timestamps: 0008_thread_pinning/,
      );
    } finally {
      closeConnection(db);
    }
  });

  it("accepts a published migration row with a released timestamp and historical hash", () => {
    const db = createConnection(":memory:");

    try {
      migrate(db);
      replaceAppliedMigrationHash({
        db,
        createdAt: closedSessionPruneIndexesWhen,
        hash: "published-0002-historical-hash",
      });

      expect(() => migrate(db)).not.toThrow();
    } finally {
      closeConnection(db);
    }
  });

  it("accepts the pre-optimization event large values migration hash", () => {
    const db = createConnection(":memory:");

    try {
      migrate(db);
      replaceAppliedMigrationHash({
        db,
        createdAt: eventLargeValuesMigrationWhen,
        hash: eventLargeValuesPreOptimizationHash,
      });

      expect(() => migrate(db)).not.toThrow();
    } finally {
      closeConnection(db);
    }
  });

  it("accepts the event parent migration hash from before its JSON guard", () => {
    const db = createConnection(":memory:");

    try {
      migrate(db);
      db.$client
        .prepare(
          "UPDATE __drizzle_migrations SET hash = ? WHERE created_at = ?",
        )
        .run(
          eventParentToolCallPreJsonValidMigrationHash,
          eventParentToolCallMigrationWhen,
        );

      expect(() => migrate(db)).not.toThrow();
    } finally {
      closeConnection(db);
    }
  });

  it("fails clearly before provider-request uniqueness migration when pending interaction duplicates exist", () => {
    const db = createConnection(":memory:");

    try {
      db.$client.exec(`
        CREATE TABLE pending_interactions (
          provider_id text,
          provider_thread_id text,
          provider_request_id text,
          session_id text NOT NULL
        );
        INSERT INTO pending_interactions (
          provider_id,
          provider_thread_id,
          provider_request_id,
          session_id
        )
        VALUES
          ('codex', 'provider-thread-1', 'request-1', 'session-1'),
          ('codex', 'provider-thread-1', 'request-1', 'session-2'),
          (NULL, NULL, NULL, 'plugin-session-1'),
          (NULL, NULL, NULL, 'plugin-session-2');
      `);

      expect(() => migrate(db)).toThrow(
        /Duplicates: codex\/provider-thread-1\/request-1 count=2\./,
      );
    } finally {
      closeConnection(db);
    }
  });

  it("rejects a non-published migration row with a matching timestamp and wrong hash", () => {
    const db = createConnection(":memory:");

    try {
      migrate(db);
      replaceAppliedMigrationHash({
        db,
        createdAt: threadPinningMigrationWhen,
        hash: "non-published-0008-wrong-hash",
      });

      expect(() => migrate(db)).toThrow(
        /Mismatched applied migration hashes: 0008_thread_pinning/,
      );
    } finally {
      closeConnection(db);
    }
  });

  it("backfills queued message sort keys in existing created order", () => {
    const db = createConnection(":memory:");

    try {
      db.$client.exec(`
        CREATE TABLE threads (
          id text PRIMARY KEY NOT NULL
        );
        CREATE TABLE queued_thread_messages (
          id text PRIMARY KEY NOT NULL,
          thread_id text NOT NULL,
          content text NOT NULL,
          model text NOT NULL,
          reasoning_level text NOT NULL,
          permission_mode text NOT NULL,
          service_tier text NOT NULL,
          claimed_at integer,
          claim_token text,
          created_at integer NOT NULL,
          updated_at integer NOT NULL,
          FOREIGN KEY (thread_id) REFERENCES threads(id) ON DELETE cascade
        );
      `);
      db.$client
        .prepare("INSERT INTO threads (id) VALUES (?), (?)")
        .run("thr_a", "thr_b");
      const insertQueuedMessage =
        db.$client.prepare<QueuedMessageMigrationInsertParameters>(
          `
          INSERT INTO queued_thread_messages (
            id,
            thread_id,
            content,
            model,
            reasoning_level,
            permission_mode,
            service_tier,
            created_at,
            updated_at
          )
          VALUES (?, ?, '[]', 'gpt-5', 'medium', 'full', 'default', ?, ?)
        `,
        );
      insertQueuedMessage.run("qmsg_b", "thr_a", 1_000, 1_000);
      insertQueuedMessage.run("qmsg_a", "thr_a", 1_000, 1_000);
      insertQueuedMessage.run("qmsg_c", "thr_a", 2_000, 2_000);
      insertQueuedMessage.run("qmsg_other", "thr_b", 500, 500);

      runQueuedMessageSortKeyMigration(db);

      expect(
        db.$client
          .prepare<[], MigratedQueuedMessageRow>(
            `
              SELECT id, thread_id AS threadId, sort_key AS sortKey
              FROM queued_thread_messages
              ORDER BY thread_id, sort_key
            `,
          )
          .all(),
      ).toEqual([
        { id: "qmsg_a", threadId: "thr_a", sortKey: "0000000000000001" },
        { id: "qmsg_b", threadId: "thr_a", sortKey: "0000000000000002" },
        { id: "qmsg_c", threadId: "thr_a", sortKey: "0000000000000003" },
        {
          id: "qmsg_other",
          threadId: "thr_b",
          sortKey: "0000000000000001",
        },
      ]);
    } finally {
      closeConnection(db);
    }
  });

  it("backfills project and manager thread sort keys", () => {
    const db = createConnection(":memory:");

    try {
      db.$client.exec(`
        CREATE TABLE projects (
          id text PRIMARY KEY NOT NULL,
          name text NOT NULL,
          created_at integer NOT NULL,
          updated_at integer NOT NULL
        );
        CREATE TABLE threads (
          id text PRIMARY KEY NOT NULL,
          project_id text NOT NULL,
          type text NOT NULL,
          created_at integer NOT NULL
        );
      `);
      const insertProject =
        db.$client.prepare<ProjectSortKeyMigrationInsertParameters>(
          `
            INSERT INTO projects (id, name, created_at, updated_at)
            VALUES (?, ?, ?, ?)
          `,
        );
      insertProject.run("proj_b", "Project B", 1_000, 1_000);
      insertProject.run("proj_a", "Project A", 1_000, 1_000);
      insertProject.run("proj_c", "Project C", 2_000, 2_000);

      const insertThread =
        db.$client.prepare<ThreadSortKeyMigrationInsertParameters>(
          `
            INSERT INTO threads (id, project_id, type, created_at)
            VALUES (?, ?, ?, ?)
          `,
        );
      insertThread.run("thr_manager_b", "proj_a", "manager", 1_000);
      insertThread.run("thr_manager_a", "proj_a", "manager", 2_000);
      insertThread.run("thr_standard", "proj_a", "standard", 3_000);
      insertThread.run("thr_other", "proj_b", "manager", 500);

      runSidebarOrderingMigration(db);

      expect(
        db.$client
          .prepare<[], MigratedProjectRow>(
            `
              SELECT id, sort_key AS sortKey
              FROM projects
              ORDER BY sort_key
            `,
          )
          .all(),
      ).toEqual([
        { id: "proj_a", sortKey: "0000000000000001" },
        { id: "proj_b", sortKey: "0000000000000002" },
        { id: "proj_c", sortKey: "0000000000000003" },
      ]);
      expect(
        db.$client
          .prepare<[], MigratedThreadSortKeyRow>(
            `
              SELECT id, sort_key AS sortKey
              FROM threads
              WHERE project_id = 'proj_a'
              ORDER BY sort_key
            `,
          )
          .all(),
      ).toEqual([
        { id: "thr_standard", sortKey: null },
        { id: "thr_manager_a", sortKey: "0000000000000001" },
        { id: "thr_manager_b", sortKey: "0000000000000002" },
      ]);
    } finally {
      closeConnection(db);
    }
  });

  it("adds nullable thread pinning columns and index", () => {
    const db = createConnection(":memory:");

    try {
      db.$client.exec(`
        CREATE TABLE threads (
          id text PRIMARY KEY NOT NULL,
          project_id text NOT NULL,
          archived_at integer,
          deleted_at integer
        );
      `);

      runThreadPinningMigration(db);

      const columns = db.$client
        .prepare<[], TableInfoRow>("PRAGMA table_info(threads)")
        .all();
      const columnsByName = new Map(
        columns.map((column) => [column.name, column]),
      );
      expect(columnsByName.get("pinned_at")?.notnull).toBe(0);
      expect(columnsByName.get("pin_sort_key")?.notnull).toBe(0);
      expect(readIndexNames({ db, tableName: "threads" })).toContain(
        "threads_pin_sort_idx",
      );
    } finally {
      closeConnection(db);
    }
  });

  it("migrates official marketplace provenance to the singleton catalog without changing direct source data", () => {
    const db = createConnection(":memory:");
    try {
      db.$client.exec(`
        CREATE TABLE plugins (
          id text PRIMARY KEY NOT NULL,
          provenance text NOT NULL,
          marketplace_id text,
          marketplace_entry_id text,
          source text NOT NULL
        );
        CREATE TABLE marketplaces (
          id text PRIMARY KEY NOT NULL,
          source_kind text NOT NULL,
          location text NOT NULL,
          requested_git_ref text,
          catalog_json text,
          last_successful_refresh_at integer,
          last_attempted_refresh_at integer,
          last_error text,
          created_at integer NOT NULL,
          updated_at integer NOT NULL
        );
        INSERT INTO marketplaces VALUES
          ('bb-official', 'git', 'https://github.com/ymichael/bb.git', 'main', '{"schemaVersion":1,"name":"bb-official","displayName":"BB Official","plugins":[]}', 10, 20, NULL, 1, 20),
          ('other', 'git', 'https://example.test/catalog.git', 'main', '{"schemaVersion":1}', 30, 40, NULL, 2, 40);
        INSERT INTO plugins VALUES
          ('official', 'marketplace', 'bb-official', 'notes', 'npm:notes@^1'),
          ('third-party', 'marketplace', 'other', 'tasks', 'git:https://example.test/tasks@main'),
          ('already-direct', 'direct', NULL, NULL, 'path:/tmp/plugin');
      `);

      runMigrationFile({ db, migrationPath: pluginCatalogMigrationPath });

      expect(
        db.$client
          .prepare<[], MigratedPluginCatalogProvenanceRow>(
            `
            SELECT id, provenance, catalog_entry_id AS catalogEntryId
            FROM plugins ORDER BY id
          `,
          )
          .all(),
      ).toEqual([
        {
          id: "already-direct",
          provenance: "direct",
          catalogEntryId: null,
        },
        { id: "official", provenance: "catalog", catalogEntryId: "notes" },
        {
          id: "third-party",
          provenance: "direct",
          catalogEntryId: null,
        },
      ]);
      expect(
        db.$client
          .prepare<[], MigratedPluginCatalogRow>(
            `
            SELECT catalog_json AS catalogJson,
              last_attempted_refresh_at AS lastAttemptedRefreshAt
            FROM plugin_catalog
          `,
          )
          .get(),
      ).toEqual({
        catalogJson: '{"schemaVersion":1,"plugins":[]}',
        lastAttemptedRefreshAt: 20,
      });
      expect(readTableNames(db)).not.toContain("marketplaces");
      expect(
        db.$client
          .prepare<[], { source: string }>(
            "SELECT source FROM plugins WHERE id = 'third-party'",
          )
          .get(),
      ).toEqual({ source: "git:https://example.test/tasks@main" });
    } finally {
      closeConnection(db);
    }
  });

  it("does not grant catalog provenance to a custom marketplace named bb-official", () => {
    const db = createConnection(":memory:");
    try {
      db.$client.exec(`
        CREATE TABLE plugins (
          id text PRIMARY KEY NOT NULL,
          provenance text NOT NULL,
          marketplace_id text,
          marketplace_entry_id text,
          source text NOT NULL
        );
        CREATE TABLE marketplaces (
          id text PRIMARY KEY NOT NULL,
          source_kind text NOT NULL,
          location text NOT NULL,
          requested_git_ref text,
          catalog_json text,
          last_successful_refresh_at integer,
          last_attempted_refresh_at integer,
          last_error text,
          created_at integer NOT NULL,
          updated_at integer NOT NULL
        );
        INSERT INTO marketplaces VALUES (
          'bb-official',
          'git',
          'https://example.test/custom.git',
          'main',
          '{"schemaVersion":1}',
          10,
          20,
          NULL,
          1,
          20
        );
        INSERT INTO plugins VALUES (
          'custom',
          'marketplace',
          'bb-official',
          'custom-entry',
          'npm:bb-plugin-custom@^1'
        );
      `);

      runMigrationFile({ db, migrationPath: pluginCatalogMigrationPath });

      expect(
        db.$client
          .prepare<[], MigratedPluginCatalogProvenanceRow>(
            `
            SELECT id, provenance, catalog_entry_id AS catalogEntryId
            FROM plugins
          `,
          )
          .get(),
      ).toEqual({
        id: "custom",
        provenance: "direct",
        catalogEntryId: null,
      });
      expect(
        db.$client
          .prepare<[], MigrationCountRow>(
            "SELECT COUNT(*) AS count FROM plugin_catalog",
          )
          .get(),
      ).toEqual({ count: 0 });
    } finally {
      closeConnection(db);
    }
  });

  it("moves the curated marketplace, its icons, and its installs together", () => {
    const db = createConnection(":memory:");
    try {
      db.$client.exec(`
        CREATE TABLE plugin_marketplaces (
          name text PRIMARY KEY NOT NULL,
          etag text,
          last_modified text
        );
        CREATE TABLE plugin_marketplace_icons (
          marketplace_name text NOT NULL,
          entry_id text NOT NULL,
          PRIMARY KEY (marketplace_name, entry_id)
        );
        CREATE TABLE plugins (
          id text PRIMARY KEY NOT NULL,
          catalog_marketplace_name text
        );
        INSERT INTO plugin_marketplaces VALUES
          ('bb-official', 'W/\"abc\"', 'Wed, 01 Jan 2025 00:00:00 GMT'),
          ('acme', 'W/\"xyz\"', 'Thu, 02 Jan 2025 00:00:00 GMT');
        INSERT INTO plugin_marketplace_icons VALUES
          ('bb-official', 'notes'),
          ('acme', 'tasks');
        INSERT INTO plugins VALUES
          ('notes', 'bb-official'),
          ('tasks', 'acme'),
          ('local', NULL);
      `);

      runMigrationFile({
        db,
        migrationPath: curatedMarketplaceRenameMigrationPath,
      });

      expect(
        db.$client
          .prepare<[], { name: string }>(
            "SELECT name FROM plugin_marketplaces ORDER BY name",
          )
          .all(),
      ).toEqual([{ name: "acme" }, { name: "bb-community" }]);
      expect(
        db.$client
          .prepare<[], { marketplaceName: string }>(
            "SELECT marketplace_name AS marketplaceName FROM plugin_marketplace_icons ORDER BY marketplace_name",
          )
          .all(),
      ).toEqual([
        { marketplaceName: "acme" },
        { marketplaceName: "bb-community" },
      ]);
      expect(
        db.$client
          .prepare<[], { id: string; catalogMarketplaceName: string | null }>(
            "SELECT id, catalog_marketplace_name AS catalogMarketplaceName FROM plugins ORDER BY id",
          )
          .all(),
      ).toEqual([
        { id: "local", catalogMarketplaceName: null },
        { id: "notes", catalogMarketplaceName: "bb-community" },
        { id: "tasks", catalogMarketplaceName: "acme" },
      ]);

      expect(
        db.$client
          .prepare<
            [],
            { name: string; etag: string | null; lastModified: string | null }
          >(
            "SELECT name, etag, last_modified AS lastModified FROM plugin_marketplaces ORDER BY name",
          )
          .all(),
      ).toEqual([
        {
          name: "acme",
          etag: 'W/"xyz"',
          lastModified: "Thu, 02 Jan 2025 00:00:00 GMT",
        },
        { name: "bb-community", etag: null, lastModified: null },
      ]);
    } finally {
      closeConnection(db);
    }
  });

  it("names only catalog provenance during the marketplace upgrade", () => {
    const db = createConnection(":memory:");
    try {
      db.$client.exec(`
        CREATE TABLE plugins (
          id text PRIMARY KEY NOT NULL,
          provenance text NOT NULL,
          catalog_entry_id text
        );
        INSERT INTO plugins VALUES
          ('catalog-plugin', 'catalog', 'catalog-entry'),
          ('direct-plugin', 'direct', NULL),
          ('builtin-plugin', 'builtin', NULL);
      `);

      runMigrationFile({
        db,
        migrationPath: namedMarketplaceCatalogMigrationPath,
      });

      expect(
        db.$client
          .prepare<[], MigratedNamedCatalogProvenanceRow>(
            `
              SELECT id,
                catalog_marketplace_name AS catalogMarketplaceName
              FROM plugins
              ORDER BY id
            `,
          )
          .all(),
      ).toEqual([
        { id: "builtin-plugin", catalogMarketplaceName: null },
        { id: "catalog-plugin", catalogMarketplaceName: "bb-official" },
        { id: "direct-plugin", catalogMarketplaceName: null },
      ]);
    } finally {
      closeConnection(db);
    }
  });

  it("seeds the Keep Awake configuration from the legacy preference", () => {
    const db = createConnection(":memory:");
    try {
      migrate(db);
      db.$client.exec(`
        INSERT INTO app_settings (id, caffeinate, updated_at)
        VALUES ('current', 1, 123)
        ON CONFLICT (id) DO UPDATE SET caffeinate = 1, updated_at = 123;
        DELETE FROM plugin_kv
        WHERE plugin_id = 'keep-awake' AND key = 'configuration';
      `);
      migrate(db);
      expect(
        db.$client
          .prepare<
            [],
            {
              key: string;
              pluginId: string;
              updatedAt: number;
              value: string;
            }
          >(
            `
              SELECT
                plugin_id AS pluginId,
                key,
                value,
                updated_at AS updatedAt
              FROM plugin_kv
              WHERE plugin_id = 'keep-awake' AND key = 'configuration'
            `,
          )
          .get(),
      ).toEqual({
        pluginId: "keep-awake",
        key: "configuration",
        value: JSON.stringify({
          enabled: true,
          selection: { mode: "all" },
        }),
        updatedAt: 123,
      });
    } finally {
      closeConnection(db);
    }
  });

  it("backfills legacy side-chat rows to hidden visibility", () => {
    const db = createConnection(":memory:");
    try {
      migrate(db);
      const host = upsertHost(db, noopNotifier, {
        id: "host-side-chat-visibility",
        name: "Migration Host",
        type: "persistent",
      });
      const { project } = createProject(db, noopNotifier, {
        name: "Migration Project",
        source: {
          type: "local_path",
          hostId: host.id,
          path: "/tmp/side-chat-visibility",
        },
      });
      const originKindSideChat = createThread(db, noopNotifier, {
        projectId: project.id,
        providerId: "codex",
        originKind: "fork",
      });
      restoreLegacyThreadOriginColumn(db);
      const legacyOriginSideChat = createThread(db, noopNotifier, {
        projectId: project.id,
        providerId: "codex",
      });
      const fork = createThread(db, noopNotifier, {
        projectId: project.id,
        providerId: "codex",
        originKind: "fork",
      });
      db.$client
        .prepare("UPDATE threads SET origin_kind = 'side-chat' WHERE id = ?")
        .run(originKindSideChat.id);
      db.$client
        .prepare("UPDATE threads SET child_origin = 'side-chat' WHERE id = ?")
        .run(legacyOriginSideChat.id);

      dropSideChatPluginExperimentColumn(db);
      runMigrationFile({
        db,
        migrationPath: sideChatVisibilityBackfillMigrationPath,
      });

      expect(
        db.$client
          .prepare<[], MigratedThreadVisibilityRow>(
            "SELECT id, visibility FROM threads ORDER BY id",
          )
          .all()
          .filter((row) =>
            [originKindSideChat.id, legacyOriginSideChat.id, fork.id].includes(
              row.id,
            ),
          )
          .sort((left, right) => left.id.localeCompare(right.id)),
      ).toEqual(
        [
          { id: originKindSideChat.id, visibility: "hidden" },
          { id: legacyOriginSideChat.id, visibility: "hidden" },
          { id: fork.id, visibility: "visible" },
        ].sort((left, right) => left.id.localeCompare(right.id)),
      );
    } finally {
      closeConnection(db);
    }
  });

  it("backfills normalized parent tool-call ids from legacy event payloads", () => {
    const db = createConnection(":memory:");

    try {
      migrate(db);
      const host = upsertHost(db, noopNotifier, {
        name: "event-parent-migration-host",
        type: "persistent",
      });
      const { project } = createProject(db, noopNotifier, {
        name: "event-parent-migration-project",
        source: {
          type: "local_path",
          hostId: host.id,
          path: "/tmp/event-parent-migration",
        },
      });
      const thread = createThread(db, noopNotifier, {
        projectId: project.id,
        providerId: "codex",
      });

      dropEventParentToolCallIdColumn(db);
      dropMarketplaceStatsColumn(db);
      dropQueueReworkSchema(db);
      db.$client
        .prepare<DeleteMigrationParameters>(
          "DELETE FROM __drizzle_migrations WHERE created_at >= ?",
        )
        .run(eventParentToolCallMigrationWhen);
      db.$client.exec(`
        INSERT INTO events (
          id, thread_id, scope_kind, turn_id, sequence, type, item_id, item_kind, data, created_at
        ) VALUES
          (
            'evt_top_level_parent',
            '${thread.id}',
            'turn',
            'legacy-turn',
            1,
            'turn/started',
            NULL,
            NULL,
            '{"parentToolCallId":"parent-top-level"}',
            1
          ),
          (
            'evt_item_parent',
            '${thread.id}',
            'turn',
            'legacy-turn',
            2,
            'item/completed',
            'child-message',
            'agentMessage',
            '{"item":{"id":"child-message","type":"agentMessage","parentToolCallId":"parent-item"}}',
            2
          ),
          (
            'evt_no_parent',
            '${thread.id}',
            'thread',
            NULL,
            3,
            'system/error',
            NULL,
            NULL,
            '{"message":"parentToolCallId is only text here"}',
            3
          ),
          (
            'evt_malformed_parent',
            '${thread.id}',
            'thread',
            NULL,
            4,
            'system/error',
            NULL,
            NULL,
            '{"parentToolCallId":',
            4
          );
      `);

      migrate(db);

      expect(
        db.$client
          .prepare<[], MigratedEventParentRow>(
            `
              SELECT id, parent_tool_call_id AS parentToolCallId
              FROM events
              WHERE id LIKE 'evt_%_parent'
              ORDER BY id
            `,
          )
          .all(),
      ).toEqual([
        { id: "evt_item_parent", parentToolCallId: "parent-item" },
        { id: "evt_malformed_parent", parentToolCallId: null },
        { id: "evt_no_parent", parentToolCallId: null },
        { id: "evt_top_level_parent", parentToolCallId: "parent-top-level" },
      ]);
      expect(readIndexNames({ db, tableName: "events" })).toContain(
        "events_parent_tool_call_thread_parent_sequence_idx",
      );
    } finally {
      closeConnection(db);
    }
  });
});
