import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { resolveMigrationsFolderForModuleDir } from "../src/migrate.js";

const tempDirs: string[] = [];

function createTempDir(): string {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "bb-db-migrations-"));
  tempDirs.push(tempDir);
  return tempDir;
}

function writeMigrationJournal(migrationsFolder: string): void {
  fs.mkdirSync(path.join(migrationsFolder, "meta"), { recursive: true });
  fs.writeFileSync(
    path.join(migrationsFolder, "meta", "_journal.json"),
    JSON.stringify({ entries: [] }),
    "utf8",
  );
}

afterEach(() => {
  for (const tempDir of tempDirs.splice(0)) {
    fs.rmSync(tempDir, { force: true, recursive: true });
  }
});

describe("resolveMigrationsFolderForModuleDir", () => {
  it("resolves the source package migration folder", () => {
    const packageRoot = createTempDir();
    const sourceModuleDir = path.join(packageRoot, "src");
    const sourceMigrationsFolder = path.join(packageRoot, "drizzle");
    fs.mkdirSync(sourceModuleDir, { recursive: true });
    writeMigrationJournal(sourceMigrationsFolder);

    expect(
      resolveMigrationsFolderForModuleDir({ moduleDir: sourceModuleDir }),
    ).toBe(sourceMigrationsFolder);
  });

  it("resolves the bundled migration folder", () => {
    const packageRoot = createTempDir();
    const bundledModuleDir = path.join(packageRoot, "dist");
    const bundledMigrationsFolder = path.join(bundledModuleDir, "drizzle");
    fs.mkdirSync(bundledModuleDir, { recursive: true });
    writeMigrationJournal(bundledMigrationsFolder);

    expect(
      resolveMigrationsFolderForModuleDir({ moduleDir: bundledModuleDir }),
    ).toBe(bundledMigrationsFolder);
  });

  it("prefers source package migrations when both layouts exist", () => {
    const packageRoot = createTempDir();
    const sourceModuleDir = path.join(packageRoot, "src");
    const sourceMigrationsFolder = path.join(packageRoot, "drizzle");
    const bundledMigrationsFolder = path.join(sourceModuleDir, "drizzle");
    fs.mkdirSync(sourceModuleDir, { recursive: true });
    writeMigrationJournal(sourceMigrationsFolder);
    writeMigrationJournal(bundledMigrationsFolder);

    expect(
      resolveMigrationsFolderForModuleDir({ moduleDir: sourceModuleDir }),
    ).toBe(sourceMigrationsFolder);
  });

  it("throws a clear error when no migration journal exists", () => {
    const packageRoot = createTempDir();
    const moduleDir = path.join(packageRoot, "dist");
    fs.mkdirSync(moduleDir, { recursive: true });

    expect(() => resolveMigrationsFolderForModuleDir({ moduleDir })).toThrow(
      `Missing database migrations. Expected ${path.join("meta", "_journal.json")} under one of:`,
    );
  });
});
