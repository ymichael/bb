import { migrate as drizzleMigrate } from "drizzle-orm/better-sqlite3/migrator";
import { dirname, join, resolve } from "node:path";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type { DbConnection } from "./connection.js";

export interface ResolveMigrationsFolderForModuleDirArgs {
  moduleDir: string;
}

const migrationModuleFilename = fileURLToPath(import.meta.url);
const migrationModuleDirname = dirname(migrationModuleFilename);
const migrationJournalPath = join("meta", "_journal.json");

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
}
