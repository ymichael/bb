import { migrate as drizzleMigrate } from "drizzle-orm/better-sqlite3/migrator";
import { dirname, join, resolve } from "node:path";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type { DbConnection } from "./connection.js";

export interface ResolveMigrationsFolderForModuleDirArgs {
  moduleDir: string;
}

interface SqliteTableInfoColumn {
  name: string;
  type: string;
  notNull: boolean;
  primaryKey: boolean;
}

interface SqliteForeignKey {
  table: string;
  from: string;
  to: string;
  onUpdate: string;
  onDelete: string;
}

interface SqliteIndex {
  name: string;
  unique: boolean;
}

interface ExpectedColumn {
  name: string;
  type: string;
  notNull: boolean;
  primaryKey: boolean;
}

interface ExpectedForeignKey {
  name: string;
  table: string;
  from: string;
  to: string;
  onUpdate: string;
  onDelete: string;
}

interface ExpectedIndex {
  name: string;
  columns: string[];
  unique: boolean;
}

const migrationModuleFilename = fileURLToPath(import.meta.url);
const migrationModuleDirname = dirname(migrationModuleFilename);
const migrationJournalPath = join("meta", "_journal.json");
const pendingInteractionColumns: ExpectedColumn[] = [
  { name: "id", type: "text", notNull: true, primaryKey: true },
  { name: "thread_id", type: "text", notNull: true, primaryKey: false },
  { name: "turn_id", type: "text", notNull: true, primaryKey: false },
  { name: "provider_id", type: "text", notNull: true, primaryKey: false },
  {
    name: "provider_thread_id",
    type: "text",
    notNull: true,
    primaryKey: false,
  },
  {
    name: "provider_request_id",
    type: "text",
    notNull: true,
    primaryKey: false,
  },
  { name: "session_id", type: "text", notNull: true, primaryKey: false },
  {
    name: "resolving_command_id",
    type: "text",
    notNull: false,
    primaryKey: false,
  },
  { name: "status", type: "text", notNull: true, primaryKey: false },
  { name: "payload", type: "text", notNull: true, primaryKey: false },
  { name: "resolution", type: "text", notNull: false, primaryKey: false },
  {
    name: "status_reason",
    type: "text",
    notNull: false,
    primaryKey: false,
  },
  { name: "created_at", type: "integer", notNull: true, primaryKey: false },
  { name: "resolved_at", type: "integer", notNull: false, primaryKey: false },
  { name: "updated_at", type: "integer", notNull: true, primaryKey: false },
];
const pendingInteractionForeignKeys: ExpectedForeignKey[] = [
  {
    name: "pending_interactions.thread_id",
    table: "threads",
    from: "thread_id",
    to: "id",
    onUpdate: "NO ACTION",
    onDelete: "CASCADE",
  },
  {
    name: "pending_interactions.resolving_command_id",
    table: "host_daemon_commands",
    from: "resolving_command_id",
    to: "id",
    onUpdate: "NO ACTION",
    onDelete: "SET NULL",
  },
];
const pendingInteractionIndexes: ExpectedIndex[] = [
  {
    name: "pending_interactions_provider_request_idx",
    columns: [
      "session_id",
      "provider_id",
      "provider_thread_id",
      "provider_request_id",
    ],
    unique: true,
  },
  {
    name: "pending_interactions_thread_created_idx",
    columns: ["thread_id", "created_at"],
    unique: false,
  },
  {
    name: "pending_interactions_thread_status_created_idx",
    columns: ["thread_id", "status", "created_at"],
    unique: false,
  },
  {
    name: "pending_interactions_status_created_idx",
    columns: ["status", "created_at"],
    unique: false,
  },
  {
    name: "pending_interactions_resolving_command_idx",
    columns: ["resolving_command_id"],
    unique: false,
  },
];

function hasMigrationJournal(migrationsFolder: string): boolean {
  return existsSync(resolve(migrationsFolder, migrationJournalPath));
}

export function resolveMigrationsFolderForModuleDir(
  args: ResolveMigrationsFolderForModuleDirArgs,
): string {
  const sourcePackageCandidate = resolve(args.moduleDir, "..", "drizzle");
  const bundledAssetCandidate = resolve(args.moduleDir, "drizzle");
  const candidates = [sourcePackageCandidate, bundledAssetCandidate];

  for (const candidate of candidates) {
    if (hasMigrationJournal(candidate)) {
      return candidate;
    }
  }

  throw new Error(
    `Missing database migrations. Expected ${migrationJournalPath} under one of: ${candidates.join(", ")}`,
  );
}

function resolveMigrationsFolder(): string {
  return resolveMigrationsFolderForModuleDir({
    moduleDir: migrationModuleDirname,
  });
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function parseTableInfoColumn(value: unknown): SqliteTableInfoColumn {
  if (!isObject(value)) {
    throw new Error("Unexpected PRAGMA table_info row shape");
  }

  const name = value.name;
  const type = value.type;
  const notNull = value.notnull;
  const primaryKey = value.pk;
  if (
    typeof name !== "string" ||
    typeof type !== "string" ||
    typeof notNull !== "number" ||
    typeof primaryKey !== "number"
  ) {
    throw new Error("Unexpected PRAGMA table_info column fields");
  }

  return {
    name,
    type: type.toLowerCase(),
    notNull: notNull !== 0,
    primaryKey: primaryKey !== 0,
  };
}

function parseForeignKey(value: unknown): SqliteForeignKey {
  if (!isObject(value)) {
    throw new Error("Unexpected PRAGMA foreign_key_list row shape");
  }

  const table = value.table;
  const from = value.from;
  const to = value.to;
  const onUpdate = value.on_update;
  const onDelete = value.on_delete;
  if (
    typeof table !== "string" ||
    typeof from !== "string" ||
    typeof to !== "string" ||
    typeof onUpdate !== "string" ||
    typeof onDelete !== "string"
  ) {
    throw new Error("Unexpected PRAGMA foreign_key_list fields");
  }

  return {
    table,
    from,
    to,
    onUpdate,
    onDelete,
  };
}

function parseIndex(value: unknown): SqliteIndex {
  if (!isObject(value)) {
    throw new Error("Unexpected PRAGMA index_list row shape");
  }

  const name = value.name;
  const unique = value.unique;
  if (typeof name !== "string" || typeof unique !== "number") {
    throw new Error("Unexpected PRAGMA index_list fields");
  }

  return {
    name,
    unique: unique !== 0,
  };
}

function parseIndexColumnName(value: unknown): string {
  if (!isObject(value) || typeof value.name !== "string") {
    throw new Error("Unexpected PRAGMA index_info row shape");
  }

  return value.name;
}

function getTableInfo(
  db: DbConnection,
  tableName: string,
): SqliteTableInfoColumn[] {
  const rows = db.$client.pragma(`table_info(${tableName})`);
  if (!Array.isArray(rows)) {
    throw new Error(`Unexpected PRAGMA table_info(${tableName}) result`);
  }

  return rows.map(parseTableInfoColumn);
}

function getForeignKeys(
  db: DbConnection,
  tableName: string,
): SqliteForeignKey[] {
  const rows = db.$client.pragma(`foreign_key_list(${tableName})`);
  if (!Array.isArray(rows)) {
    throw new Error(`Unexpected PRAGMA foreign_key_list(${tableName}) result`);
  }

  return rows.map(parseForeignKey);
}

function getIndexes(db: DbConnection, tableName: string): SqliteIndex[] {
  const rows = db.$client.pragma(`index_list(${tableName})`);
  if (!Array.isArray(rows)) {
    throw new Error(`Unexpected PRAGMA index_list(${tableName}) result`);
  }

  return rows.map(parseIndex);
}

function getIndexColumnNames(db: DbConnection, indexName: string): string[] {
  const rows = db.$client.pragma(`index_info(${indexName})`);
  if (!Array.isArray(rows)) {
    throw new Error(`Unexpected PRAGMA index_info(${indexName}) result`);
  }

  return rows.map(parseIndexColumnName);
}

function formatExpectedColumn(column: ExpectedColumn): string {
  return `${column.name} ${column.type} notNull=${column.notNull} primaryKey=${column.primaryKey}`;
}

function formatActualColumn(column: SqliteTableInfoColumn): string {
  return `${column.name} ${column.type} notNull=${column.notNull} primaryKey=${column.primaryKey}`;
}

function validatePendingInteractionsSchema(db: DbConnection): void {
  const columns = getTableInfo(db, "pending_interactions");
  const actualColumnNames = columns.map((column) => column.name);
  const expectedColumnNames = pendingInteractionColumns.map(
    (column) => column.name,
  );
  const missingColumns = expectedColumnNames.filter(
    (column) => !actualColumnNames.includes(column),
  );
  const extraColumns = actualColumnNames.filter(
    (column) => !expectedColumnNames.includes(column),
  );
  const columnMismatches: string[] = [];
  for (const expectedColumn of pendingInteractionColumns) {
    const actualColumn = columns.find(
      (column) => column.name === expectedColumn.name,
    );
    if (actualColumn === undefined) {
      continue;
    }

    if (
      actualColumn.type !== expectedColumn.type ||
      actualColumn.notNull !== expectedColumn.notNull ||
      actualColumn.primaryKey !== expectedColumn.primaryKey
    ) {
      columnMismatches.push(
        `${expectedColumn.name}: expected ${formatExpectedColumn(expectedColumn)}, got ${formatActualColumn(actualColumn)}`,
      );
    }
  }

  const foreignKeys = getForeignKeys(db, "pending_interactions");
  const missingForeignKeys = pendingInteractionForeignKeys.filter(
    (expectedForeignKey) =>
      !foreignKeys.some(
        (foreignKey) =>
          foreignKey.table === expectedForeignKey.table &&
          foreignKey.from === expectedForeignKey.from &&
          foreignKey.to === expectedForeignKey.to &&
          foreignKey.onUpdate === expectedForeignKey.onUpdate &&
          foreignKey.onDelete === expectedForeignKey.onDelete,
      ),
  );

  const indexes = getIndexes(db, "pending_interactions");
  const missingOrMismatchedIndexes: string[] = [];
  for (const expectedIndex of pendingInteractionIndexes) {
    const actualIndex = indexes.find(
      (index) => index.name === expectedIndex.name,
    );
    if (actualIndex === undefined) {
      missingOrMismatchedIndexes.push(`${expectedIndex.name}: missing`);
      continue;
    }

    const actualColumns = getIndexColumnNames(db, expectedIndex.name);
    if (
      actualIndex.unique !== expectedIndex.unique ||
      actualColumns.length !== expectedIndex.columns.length ||
      actualColumns.some(
        (column, index) => column !== expectedIndex.columns[index],
      )
    ) {
      missingOrMismatchedIndexes.push(
        `${expectedIndex.name}: expected unique=${expectedIndex.unique} columns=${expectedIndex.columns.join(",")}, got unique=${actualIndex.unique} columns=${actualColumns.join(",")}`,
      );
    }
  }

  if (
    missingColumns.length > 0 ||
    extraColumns.length > 0 ||
    columnMismatches.length > 0 ||
    missingForeignKeys.length > 0 ||
    missingOrMismatchedIndexes.length > 0
  ) {
    throw new Error(
      [
        "Database schema drift detected for pending_interactions after migration.",
        missingColumns.length > 0
          ? `Missing columns: ${missingColumns.join(", ")}.`
          : null,
        extraColumns.length > 0
          ? `Unexpected columns: ${extraColumns.join(", ")}.`
          : null,
        columnMismatches.length > 0
          ? `Column mismatches: ${columnMismatches.join("; ")}.`
          : null,
        missingForeignKeys.length > 0
          ? `Missing foreign keys: ${missingForeignKeys.map((foreignKey) => foreignKey.name).join(", ")}.`
          : null,
        missingOrMismatchedIndexes.length > 0
          ? `Missing or mismatched indexes: ${missingOrMismatchedIndexes.join("; ")}.`
          : null,
        "This usually means the local DB was created by an incompatible prelaunch migration history. Restart BB so migrations can run; if this persists in development, back up the DB and run pnpm reset:dev.",
      ]
        .filter((line): line is string => line !== null)
        .join(" "),
    );
  }
}

export function migrate(db: DbConnection): void {
  const migrationsFolder = resolveMigrationsFolder();
  const sqlite = db.$client;

  sqlite.pragma("foreign_keys = OFF");
  try {
    drizzleMigrate(db, { migrationsFolder });
  } finally {
    sqlite.pragma("foreign_keys = ON");
  }

  const violations = sqlite.pragma("foreign_key_check");
  if (Array.isArray(violations) && violations.length > 0) {
    console.error(
      `foreign_key_check found ${violations.length} violation(s) after migration`,
      violations.slice(0, 10),
    );
  }

  validatePendingInteractionsSchema(db);
}
