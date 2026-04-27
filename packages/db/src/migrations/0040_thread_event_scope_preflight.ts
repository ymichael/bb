import type { DbConnection } from "../connection.js";

interface SqlitePresentRow {
  present: number;
}

interface SqliteTableInfoRow {
  name: string;
}

interface AmbiguousThreadEventScopeRow {
  id: string;
  sequence: number;
  thread_id: string;
  type: string;
}

export interface MigrationPreflight {
  name: string;
  run(sqlite: DbConnection["$client"]): void;
}

const TURN_ONLY_EVENT_TYPES_BEFORE_0040 = [
  "turn/started",
  "turn/completed",
  "turn/input/accepted",
  "thread/compacted",
  "item/started",
  "item/completed",
  "item/agentMessage/delta",
  "item/commandExecution/outputDelta",
  "item/fileChange/outputDelta",
  "item/reasoning/summaryTextDelta",
  "item/reasoning/textDelta",
  "item/plan/delta",
  "item/mcpToolCall/progress",
  "item/toolCall/progress",
  "thread/tokenUsage/updated",
  "thread/contextWindowUsage/updated",
  "turn/plan/updated",
  "turn/diff/updated",
  "system/permissionGrant/lifecycle",
] as const;

function quoteSqlString(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

function hasEventsTable(sqlite: DbConnection["$client"]): boolean {
  const row = sqlite
    .prepare<
      [],
      SqlitePresentRow
    >("SELECT 1 AS present FROM sqlite_master WHERE type = 'table' AND name = 'events'")
    .get();
  return row?.present === 1;
}

function hasEventScopeKindColumn(sqlite: DbConnection["$client"]): boolean {
  const rows = sqlite
    .prepare<[], SqliteTableInfoRow>("PRAGMA table_info('events')")
    .all();
  return rows.some((row) => row.name === "scope_kind");
}

function preflightThreadEventScopeMigration(
  sqlite: DbConnection["$client"],
): void {
  if (!hasEventsTable(sqlite) || hasEventScopeKindColumn(sqlite)) {
    return;
  }

  const turnOnlyTypes = TURN_ONLY_EVENT_TYPES_BEFORE_0040.map(quoteSqlString).join(
    ", ",
  );
  const rows = sqlite
    .prepare<[], AmbiguousThreadEventScopeRow>(
      `SELECT id, type, thread_id, sequence
       FROM events
       WHERE turn_id IS NULL AND type IN (${turnOnlyTypes})
       ORDER BY thread_id, sequence
       LIMIT 25`,
    )
    .all();

  if (rows.length === 0) {
    return;
  }

  console.error(
    "Cannot migrate thread events to explicit scope because turn-only events are missing turn_id.",
    rows,
  );
  throw new Error(
    `Cannot backfill thread event scope for ${rows.length} turn-only event row(s) without turn_id`,
  );
}

export const threadEventScopeMigrationPreflight = {
  name: "0040_thread_event_scope",
  run: preflightThreadEventScopeMigration,
} satisfies MigrationPreflight;
