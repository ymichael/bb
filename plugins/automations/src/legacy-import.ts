import { mkdir, readFile, rename, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import type { BbPluginApi } from "@get-bb/plugin-sdk";
import type { Db } from "./data.js";
import {
  automationOriginSchema,
  automationRunModeSchema,
  automationRunStatusSchema,
  automationRunTriggerSchema,
  automationTriggerSchema,
  agentEnvironmentSchema,
  automationScriptInterpreterSchema,
} from "./rpc-types.js";
import { automationScriptDir } from "./script-files.js";

const LEGACY_IMPORT_DONE_KEY = "legacy-import-done";

const legacyAutomationRowSchema = z
  .object({
    id: z.string().min(1),
    projectId: z.string().min(1),
    targetThreadId: z.string().min(1).nullable(),
    name: z.string().min(1),
    enabled: z.boolean(),
    triggerType: z.enum(["schedule", "once"]),
    triggerConfig: z.string().min(1),
    runMode: automationRunModeSchema,
    execution: z.string().min(1),
    environment: z.string().min(1),
    autoArchive: z.boolean(),
    origin: automationOriginSchema,
    createdByThreadId: z.string().min(1).nullable(),
    nextRunAt: z.number().int().nullable(),
    lastRunAt: z.number().int().nullable(),
    runCount: z.number().int().min(0),
    lastRunStatus: automationRunStatusSchema.nullable(),
    lastRunThreadId: z.string().min(1).nullable(),
    lastError: z.string().nullable(),
    createdAt: z.number().int(),
    updatedAt: z.number().int(),
  })
  .strict();

const legacyRunRowSchema = z
  .object({
    id: z.string().min(1),
    automationId: z.string().min(1),
    runMode: automationRunModeSchema,
    threadId: z.string().min(1).nullable(),
    status: automationRunStatusSchema,
    trigger: automationRunTriggerSchema,
    skipReason: z.string().nullable(),
    error: z.string().nullable(),
    output: z.string().nullable(),
    exitCode: z.number().int().nullable(),
    idempotencyKey: z.string().min(1).nullable(),
    scheduledFor: z.number().int(),
    startedAt: z.number().int(),
    finishedAt: z.number().int().nullable(),
  })
  .strict();

const legacyScriptSchema = z
  .object({
    fileName: z.string().min(1),
    content: z.string(),
  })
  .strict();

const legacyAgentExecutionSchema = z
  .object({
    mode: z.literal("agent"),
    prompt: z.string().min(1),
    providerId: z.string().min(1),
    model: z.string().min(1),
    permissionMode: z.enum([
      "accept-edits",
      "auto",
      "full",
      "workspace-write",
      "readonly",
    ]),
    targetThreadId: z.string().min(1).optional(),
  })
  .strict();

const legacyScriptExecutionSchema = z
  .object({
    mode: z.literal("script"),
    script: z.string().min(1).optional(),
    scriptFile: z.string().min(1).optional(),
    interpreter: automationScriptInterpreterSchema.optional(),
    timeoutMs: z.number().int().positive().default(120_000),
    env: z.record(z.string(), z.string()).optional(),
  })
  .strict();

const legacyExecutionSchema = z.discriminatedUnion("mode", [
  legacyAgentExecutionSchema,
  legacyScriptExecutionSchema,
]);

export const legacyImportFileSchema = z
  .object({
    automations: z.array(legacyAutomationRowSchema),
    runs: z.array(legacyRunRowSchema),
    scripts: z.record(z.string(), legacyScriptSchema),
  })
  .strict();

type LegacyImportApi = {
  storage: { kv: Pick<BbPluginApi["storage"]["kv"], "get" | "set"> };
  log: Pick<BbPluginApi["log"], "info">;
};

async function fileExists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

function normalizeExecution(
  row: z.infer<typeof legacyAutomationRowSchema>,
): string {
  const execution = legacyExecutionSchema.parse(JSON.parse(row.execution));
  if (execution.mode !== row.runMode) {
    throw new Error(`Automation ${row.id} runMode does not match execution`);
  }
  if (execution.mode === "script" && row.targetThreadId !== null) {
    throw new Error(
      `Automation ${row.id} targetThreadId does not match execution`,
    );
  }
  if (execution.mode === "agent") {
    if (
      execution.targetThreadId !== undefined &&
      execution.targetThreadId !== row.targetThreadId
    ) {
      throw new Error(
        `Automation ${row.id} targetThreadId does not match execution`,
      );
    }
    const environment = agentEnvironmentSchema.parse(
      JSON.parse(row.environment),
    );
    const permissionMode =
      execution.permissionMode === "workspace-write" ||
      execution.permissionMode === "readonly"
        ? "accept-edits"
        : execution.permissionMode;
    return JSON.stringify({
      ...execution,
      permissionMode,
      environment,
      ...(row.targetThreadId === null
        ? {}
        : { targetThreadId: row.targetThreadId }),
    });
  }
  const { script: _script, ...scriptExecution } = execution;
  return JSON.stringify(scriptExecution);
}

function validateTriggerConfig(
  row: z.infer<typeof legacyAutomationRowSchema>,
): void {
  const trigger = automationTriggerSchema.parse(JSON.parse(row.triggerConfig));
  if (trigger.triggerType !== row.triggerType) {
    throw new Error(
      `Automation ${row.id} triggerType does not match triggerConfig`,
    );
  }
}

export async function ingestLegacyImport(args: {
  bb: LegacyImportApi;
  db: Db;
  pluginDataDir: string;
}): Promise<void> {
  const done = await args.bb.storage.kv.get<boolean>(LEGACY_IMPORT_DONE_KEY);
  const importPath = join(
    args.pluginDataDir,
    "import",
    "legacy-automations.json",
  );
  if (done === true || !(await fileExists(importPath))) return;

  const payload = legacyImportFileSchema.parse(
    JSON.parse(await readFile(importPath, "utf8")),
  );

  args.db.transaction(() => {
    for (const row of payload.automations) {
      validateTriggerConfig(row);
      args.db
        .prepare(
          `INSERT OR IGNORE INTO automations (
             id, project_id, target_thread_id, name, enabled, trigger_type,
             trigger_config, run_mode, execution, origin,
             created_by_thread_id, next_run_at, last_run_at, run_count,
             last_run_status, last_run_thread_id, last_error, created_at,
             updated_at
           ) VALUES (
             @id, @projectId, @targetThreadId, @name, @enabled, @triggerType,
             @triggerConfig, @runMode, @execution, @origin,
             @createdByThreadId, @nextRunAt, @lastRunAt, @runCount,
             @lastRunStatus, @lastRunThreadId, @lastError, @createdAt,
             @updatedAt
           )`,
        )
        .run({
          ...row,
          enabled: row.enabled ? 1 : 0,
          execution: normalizeExecution(row),
        });
    }
    for (const run of payload.runs) {
      args.db
        .prepare(
          `INSERT OR IGNORE INTO automation_runs (
             id, automation_id, run_mode, thread_id, status, trigger,
             skip_reason, error, output, exit_code, idempotency_key,
             scheduled_for, started_at, finished_at
           ) VALUES (
             @id, @automationId, @runMode, @threadId, @status, @trigger,
             @skipReason, @error, @output, @exitCode, @idempotencyKey,
             @scheduledFor, @startedAt, @finishedAt
           )`,
        )
        .run(run);
      if (run.threadId !== null) {
        args.db
          .prepare(
            `INSERT OR IGNORE INTO automation_thread_marks (
               thread_id, automation_id, run_id, created_at
             ) VALUES (?, ?, ?, ?)`,
          )
          .run(run.threadId, run.automationId, run.id, run.startedAt);
      }
    }
  })();

  for (const [automationId, script] of Object.entries(payload.scripts)) {
    const dir = automationScriptDir(args.pluginDataDir, automationId);
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, script.fileName), script.content, {
      mode: 0o700,
    });
  }

  await args.bb.storage.kv.set(LEGACY_IMPORT_DONE_KEY, true);
  await rename(importPath, `${importPath}.imported`);
  args.bb.log.info(
    `Imported ${payload.automations.length} legacy automations and ${payload.runs.length} runs`,
  );
}
