import {
  access,
  mkdir,
  readdir,
  readFile,
  rename,
  rmdir,
  stat,
} from "node:fs/promises";
import { dirname, join } from "node:path";
import type { DevInstanceConfig } from "@bb/config/runtime";

export interface LegacyDevDataMigrationResult {
  migratedEntries: string[];
  skippedReason?: LegacyDevDataMigrationSkippedReason;
}

export type LegacyDevDataMigrationSkippedReason =
  | "legacy-data-not-found"
  | "legacy-data-empty"
  | "legacy-dev-process-running"
  | "target-exists";

interface MigrateLegacyDevDataArgs {
  config: DevInstanceConfig;
  dependencies?: LegacyDevDataMigrationDependencies;
  output?: MigrationOutput;
}

interface MigrationOutput {
  write(text: string): void;
}

interface LegacyDevDataMigrationDependencies {
  rename(sourcePath: string, targetPath: string): Promise<void>;
}

interface RollbackMigratedEntriesArgs {
  entries: string[];
  legacyDataDir: string;
  removeTargetDataDir: boolean;
  targetDataDir: string;
}

const LEGACY_DEV_DATA_DIR_NAME = ".bb-dev";
const LEGACY_DEV_SUPERVISOR_DIR_NAME = "dev-supervisors";
const LEGACY_DEV_SUPERVISOR_PID_FILE_NAMES = [
  "host-daemon.pid",
  "server.pid",
] as const;
const MIGRATABLE_LEGACY_ENTRY_NAMES = new Set([
  "attachments",
  "auth-secret",
  "auth.json",
  "bb.db",
  "bb.db-shm",
  "bb.db-wal",
  "host-id",
  "logs",
  "replays",
  "thread-storage",
]);

export async function pathExists(pathToCheck: string): Promise<boolean> {
  try {
    await access(pathToCheck);
    return true;
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") {
      return false;
    }
    throw error;
  }
}

async function isDirectoryEmpty(pathToCheck: string): Promise<boolean> {
  try {
    return (await readdir(pathToCheck)).length === 0;
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") {
      return true;
    }
    throw error;
  }
}

function isMigratableLegacyEntryName(entryName: string): boolean {
  return (
    MIGRATABLE_LEGACY_ENTRY_NAMES.has(entryName) || /^bb\.db\./u.test(entryName)
  );
}

async function isProcessRunning(pidPath: string): Promise<boolean> {
  let rawPid: string;
  try {
    rawPid = await readFile(pidPath, "utf8");
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") {
      return false;
    }
    throw error;
  }

  const pid = Number.parseInt(rawPid.trim(), 10);
  if (!Number.isInteger(pid) || pid <= 0) {
    return false;
  }

  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ESRCH") {
      return false;
    }
    if (error instanceof Error && "code" in error && error.code === "EPERM") {
      return true;
    }
    throw error;
  }
}

async function isLegacyDevProcessRunning(
  legacyDataDir: string,
): Promise<boolean> {
  for (const pidFileName of LEGACY_DEV_SUPERVISOR_PID_FILE_NAMES) {
    if (
      await isProcessRunning(
        join(legacyDataDir, LEGACY_DEV_SUPERVISOR_DIR_NAME, pidFileName),
      )
    ) {
      return true;
    }
  }

  return false;
}

async function listMigratableLegacyEntries(
  legacyDataDir: string,
): Promise<string[]> {
  const entries = await readdir(legacyDataDir, { withFileTypes: true });
  return entries
    .filter((entry) => isMigratableLegacyEntryName(entry.name))
    .map((entry) => entry.name)
    .sort((left, right) => left.localeCompare(right));
}

function formatMigratedEntries(entries: string[]): string {
  return entries
    .map((entry) => `${LEGACY_DEV_DATA_DIR_NAME}/${entry}`)
    .join(", ");
}

async function rollbackMigratedEntries(
  args: RollbackMigratedEntriesArgs,
): Promise<void> {
  for (const entry of [...args.entries].reverse()) {
    const legacyPath = join(args.legacyDataDir, entry);
    const targetPath = join(args.targetDataDir, entry);
    if ((await pathExists(targetPath)) && !(await pathExists(legacyPath))) {
      await rename(targetPath, legacyPath);
    }
  }

  if (
    args.removeTargetDataDir &&
    (await pathExists(args.targetDataDir)) &&
    (await isDirectoryEmpty(args.targetDataDir))
  ) {
    await rmdir(args.targetDataDir);
  }
}

export async function migrateLegacyDevData(
  args: MigrateLegacyDevDataArgs,
): Promise<LegacyDevDataMigrationResult> {
  const dependencies: LegacyDevDataMigrationDependencies =
    args.dependencies ?? {
      rename,
    };
  const legacyDataDir = dirname(args.config.dataDir);
  const targetExists = await pathExists(args.config.dataDir);
  if (targetExists && !(await isDirectoryEmpty(args.config.dataDir))) {
    return {
      migratedEntries: [],
      skippedReason: "target-exists",
    };
  }

  if (!(await pathExists(legacyDataDir))) {
    return {
      migratedEntries: [],
      skippedReason: "legacy-data-not-found",
    };
  }

  if ((await stat(legacyDataDir)).isDirectory() === false) {
    return {
      migratedEntries: [],
      skippedReason: "legacy-data-not-found",
    };
  }

  const entries = await listMigratableLegacyEntries(legacyDataDir);
  if (entries.length === 0) {
    return {
      migratedEntries: [],
      skippedReason: "legacy-data-empty",
    };
  }

  if (await isLegacyDevProcessRunning(legacyDataDir)) {
    return {
      migratedEntries: [],
      skippedReason: "legacy-dev-process-running",
    };
  }

  const shouldRemoveTargetDataDirOnRollback = !targetExists;
  await mkdir(args.config.dataDir, { recursive: true });
  const migratedEntries: string[] = [];
  try {
    for (const entry of entries) {
      await dependencies.rename(
        join(legacyDataDir, entry),
        join(args.config.dataDir, entry),
      );
      migratedEntries.push(entry);
    }
  } catch (error) {
    await rollbackMigratedEntries({
      entries: migratedEntries,
      legacyDataDir,
      removeTargetDataDir: shouldRemoveTargetDataDirOnRollback,
      targetDataDir: args.config.dataDir,
    });
    throw error;
  }

  args.output?.write(
    `[dev] Migrated legacy dev data into ${args.config.dataDir}: ${formatMigratedEntries(entries)}\n`,
  );
  return {
    migratedEntries: entries,
  };
}
