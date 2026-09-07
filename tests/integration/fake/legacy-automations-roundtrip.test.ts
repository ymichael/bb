import {
  access,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createConnection } from "@bb/db";
import { exportLegacyAutomationsForPluginImport } from "../../../apps/server/src/legacy-automations-export.js";
import {
  getAutomation,
  listAutomationRuns,
  migrations as automationMigrations,
  parseAutomationExecution,
} from "../../../plugins/automations/src/data.js";
import {
  ingestLegacyImport,
  legacyImportFileSchema,
} from "../../../plugins/automations/src/legacy-import.js";

const testLogger = {
  error: () => {},
  info: () => {},
};

function createLegacyTables(db: ReturnType<typeof createConnection>): void {
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

function insertLegacyAutomation(
  db: ReturnType<typeof createConnection>,
  args: {
    id: string;
    name: string;
    runMode: "agent" | "script";
    execution: object;
    environment: object;
    targetThreadId: string | null;
    createdAt: number;
  },
): void {
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
      args.id,
      "proj_legacy",
      args.targetThreadId,
      args.name,
      1,
      "schedule",
      JSON.stringify({
        triggerType: "schedule",
        cron: "*/15 * * * *",
        timezone: "America/Los_Angeles",
      }),
      args.runMode,
      JSON.stringify(args.execution),
      JSON.stringify(args.environment),
      1,
      "agent",
      "thr_creator",
      1_800_000,
      1_700_000,
      3,
      "succeeded",
      args.targetThreadId,
      null,
      args.createdAt,
      args.createdAt + 1,
    );
}

describe("legacy automation export/import round trip", () => {
  it("exports kernel rows that the automations plugin schema can parse and ingest", async () => {
    const dataDir = await mkdtemp(join(tmpdir(), "bb-legacy-roundtrip-"));
    const legacyDb = createConnection(":memory:");
    const pluginDb = createConnection(":memory:");
    try {
      createLegacyTables(legacyDb);
      for (const migration of automationMigrations) {
        pluginDb.$client.exec(migration);
      }
      await mkdir(join(dataDir, "automation-scripts", "auto_script"), {
        recursive: true,
      });
      await writeFile(
        join(dataDir, "automation-scripts", "auto_script", "check.sh"),
        "echo migrated\n",
      );

      insertLegacyAutomation(legacyDb, {
        id: "auto_agent",
        name: "Legacy agent",
        runMode: "agent",
        targetThreadId: "thr_target",
        execution: {
          mode: "agent",
          prompt: "Summarize the repo",
          providerId: "openai",
          model: "gpt-5",
          permissionMode: "workspace-write",
        },
        environment: { type: "project-default" },
        createdAt: 100,
      });
      insertLegacyAutomation(legacyDb, {
        id: "auto_script",
        name: "Legacy script",
        runMode: "script",
        targetThreadId: null,
        execution: { mode: "script", scriptFile: "check.sh" },
        environment: { type: "project-default" },
        createdAt: 200,
      });
      legacyDb.$client
        .prepare(
          `INSERT INTO automation_runs (
             id, automation_id, run_mode, thread_id, status, trigger,
             skip_reason, error, output, exit_code, idempotency_key,
             scheduled_for, started_at, finished_at
           ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          "run_script",
          "auto_script",
          "script",
          null,
          "succeeded",
          "schedule",
          null,
          null,
          "migrated\n",
          0,
          "legacy-idempotency",
          1_800_000,
          1_800_001,
          1_800_002,
        );

      exportLegacyAutomationsForPluginImport({
        dataDir,
        db: legacyDb,
        logger: testLogger,
      });
      const pluginDataDir = join(dataDir, "plugins", "automations");
      const importPath = join(
        pluginDataDir,
        "import",
        "legacy-automations.json",
      );
      const exported = legacyImportFileSchema.parse(
        JSON.parse(await readFile(importPath, "utf8")),
      );
      expect(exported.automations.map((row) => row.id).sort()).toEqual([
        "auto_agent",
        "auto_script",
      ]);

      await ingestLegacyImport({
        bb: {
          storage: {
            kv: {
              async get(): Promise<undefined> {
                return undefined;
              },
              async set(): Promise<void> {
                return undefined;
              },
            },
          },
          log: { info: () => {} },
        },
        db: pluginDb.$client,
        pluginDataDir,
      });

      const agent = getAutomation(pluginDb.$client, "auto_agent");
      expect(agent?.targetThreadId).toBe("thr_target");
      expect(parseAutomationExecution(agent?.execution ?? "")).toMatchObject({
        mode: "agent",
        environment: { type: "project-default" },
        targetThreadId: "thr_target",
      });
      const script = getAutomation(pluginDb.$client, "auto_script");
      expect(parseAutomationExecution(script?.execution ?? "")).toMatchObject({
        mode: "script",
        scriptFile: "check.sh",
        timeoutMs: 120_000,
      });
      expect(
        await readFile(
          join(pluginDataDir, "scripts", "auto_script", "check.sh"),
          "utf8",
        ),
      ).toBe("echo migrated\n");
      expect(
        listAutomationRuns(pluginDb.$client, {
          automationId: "auto_script",
          limit: 10,
        }),
      ).toMatchObject([{ id: "run_script", output: "migrated\n" }]);
      await expect(access(importPath)).rejects.toThrow();
      await expect(access(`${importPath}.imported`)).resolves.toBeUndefined();
    } finally {
      legacyDb.$client.close();
      pluginDb.$client.close();
      await rm(dataDir, { recursive: true, force: true });
    }
  });
});
