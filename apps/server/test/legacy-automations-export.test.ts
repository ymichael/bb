import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createConnection, type DbConnection } from "@bb/db";
import { exportLegacyAutomationsForPluginImport } from "../src/legacy-automations-export.js";
import { initDb } from "../src/db.js";
import { testLogger } from "./helpers/test-app.js";

function createLegacyTables(db: DbConnection): void {
  db.$client.exec(`
    CREATE TABLE automations (
      id text PRIMARY KEY NOT NULL,
      project_id text NOT NULL,
      target_thread_id text,
      name text NOT NULL,
      enabled integer NOT NULL,
      trigger_type text NOT NULL,
      trigger_config text NOT NULL,
      run_mode text NOT NULL,
      execution text NOT NULL,
      environment text NOT NULL,
      auto_archive integer NOT NULL,
      origin text NOT NULL,
      created_by_thread_id text,
      next_run_at integer,
      last_run_at integer,
      run_count integer NOT NULL,
      last_run_status text,
      last_run_thread_id text,
      last_error text,
      created_at integer NOT NULL,
      updated_at integer NOT NULL
    );
    CREATE TABLE automation_runs (
      id text PRIMARY KEY NOT NULL,
      automation_id text NOT NULL,
      run_mode text NOT NULL,
      thread_id text,
      status text NOT NULL,
      trigger text NOT NULL,
      skip_reason text,
      error text,
      output text,
      exit_code integer,
      idempotency_key text,
      scheduled_for integer NOT NULL,
      started_at integer NOT NULL,
      finished_at integer
    );
  `);
}

describe("exportLegacyAutomationsForPluginImport", () => {
  let dataDir: string;
  let db: DbConnection;

  beforeEach(async () => {
    dataDir = await mkdtemp(join(tmpdir(), "bb-legacy-automations-"));
    db = createConnection(":memory:");
  });

  afterEach(async () => {
    db.$client.close();
    await rm(dataDir, { recursive: true, force: true });
  });

  it("does nothing when the legacy table is absent", () => {
    expect(() =>
      exportLegacyAutomationsForPluginImport({
        dataDir,
        db,
        logger: testLogger,
      }),
    ).not.toThrow();
  });

  it("refuses to migrate legacy automation rows without plugin export context", () => {
    const dbPath = join(dataDir, "legacy.sqlite");
    const legacyDb = createConnection(dbPath);
    legacyDb.$client.exec(`
      CREATE TABLE automations (id text PRIMARY KEY NOT NULL);
      INSERT INTO automations (id) VALUES ('auto_legacy');
    `);
    legacyDb.$client.close();

    expect(() => initDb(dbPath)).toThrow(
      "Cannot migrate legacy automations without dataDir and logger",
    );
  });

  it("exports legacy rows and referenced script files for plugin import", async () => {
    createLegacyTables(db);
    await mkdir(join(dataDir, "automation-scripts", "auto_1"), {
      recursive: true,
    });
    await writeFile(
      join(dataDir, "automation-scripts", "auto_1", "check.sh"),
      "echo ok\n",
    );

    db.$client
      .prepare(
        `INSERT INTO automations (
           id, project_id, target_thread_id, name, enabled, trigger_type,
           trigger_config, run_mode, execution, environment, auto_archive,
           origin, created_by_thread_id, next_run_at, last_run_at, run_count,
           last_run_status, last_run_thread_id, last_error, created_at,
           updated_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        "auto_1",
        "proj_1",
        "thread_1",
        "Daily check",
        1,
        "schedule",
        JSON.stringify({
          triggerType: "schedule",
          cron: "0 9 * * *",
          timezone: "America/Los_Angeles",
        }),
        "script",
        JSON.stringify({ mode: "script", scriptFile: "check.sh" }),
        JSON.stringify({ kind: "existing", environmentId: "env_1" }),
        0,
        "agent",
        "thread_created",
        123,
        100,
        2,
        "succeeded",
        "thread_last",
        null,
        10,
        20,
      );
    db.$client
      .prepare(
        `INSERT INTO automation_runs (
           id, automation_id, run_mode, thread_id, status, trigger,
           skip_reason, error, output, exit_code, idempotency_key,
           scheduled_for, started_at, finished_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        "run_1",
        "auto_1",
        "script",
        null,
        "succeeded",
        "schedule",
        null,
        null,
        "ok\n",
        0,
        "idem",
        123,
        124,
        125,
      );

    exportLegacyAutomationsForPluginImport({
      dataDir,
      db,
      logger: testLogger,
    });

    const payload = JSON.parse(
      await readFile(
        join(
          dataDir,
          "plugins",
          "automations",
          "import",
          "legacy-automations.json",
        ),
        "utf8",
      ),
    );
    expect(payload).toMatchObject({
      automations: [
        {
          id: "auto_1",
          enabled: true,
          autoArchive: false,
          execution: JSON.stringify({ mode: "script", scriptFile: "check.sh" }),
        },
      ],
      runs: [{ id: "run_1", automationId: "auto_1", output: "ok\n" }],
      scripts: {
        auto_1: { fileName: "check.sh", content: "echo ok\n" },
      },
    });
  });

  it("exports a script automation whose script file is missing instead of aborting", async () => {
    createLegacyTables(db);
    db.$client
      .prepare(
        `INSERT INTO automations (
           id, project_id, target_thread_id, name, enabled, trigger_type,
           trigger_config, run_mode, execution, environment, auto_archive,
           origin, created_by_thread_id, next_run_at, last_run_at, run_count,
           last_run_status, last_run_thread_id, last_error, created_at,
           updated_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        "auto_gone",
        "proj_1",
        null,
        "Dangling script",
        1,
        "schedule",
        JSON.stringify({
          triggerType: "schedule",
          cron: "0 9 * * *",
          timezone: "America/Los_Angeles",
        }),
        "script",
        JSON.stringify({ mode: "script", scriptFile: "gone.sh" }),
        JSON.stringify({ kind: "existing", environmentId: "env_1" }),
        0,
        "agent",
        null,
        123,
        null,
        0,
        null,
        null,
        null,
        10,
        20,
      );

    exportLegacyAutomationsForPluginImport({
      dataDir,
      db,
      logger: testLogger,
    });

    const payload = JSON.parse(
      await readFile(
        join(
          dataDir,
          "plugins",
          "automations",
          "import",
          "legacy-automations.json",
        ),
        "utf8",
      ),
    );
    expect(payload.automations).toMatchObject([{ id: "auto_gone" }]);
    expect(payload.scripts).toEqual({});
  });
});
