import type { BbPluginApi, PluginAgentToolResult } from "@get-bb/plugin-sdk";
import { z } from "zod";
import { registerWorkflowCli } from "./cli.js";
import { migrations } from "./data.js";
import { toJsonValue } from "./json-value.js";
import { createWorkflowService } from "./service.js";
import {
  DEFAULT_WORKFLOW_SETTINGS,
  registerWorkflowSettings,
} from "./settings.js";
import type { JsonValue } from "./types.js";
import { prepareWorkflowSource } from "./workflow-input.js";
import { workflowUiRpcContract } from "./ui-contract.js";
import { buildWorkflowRunView } from "./ui-view.js";

const sourceInputFields = {
  script: z
    .string()
    .min(1)
    .describe(
      "Self-contained workflow script. Must begin with `export const meta = { name, description, phases }` (pure literal, no computed values) followed by the script body using agent()/parallel()/pipeline()/phase().",
    )
    .optional(),
  source: z
    .string()
    .min(1)
    .describe("Alias for `script`. Do not provide both `source` and `script`.")
    .optional(),
  scriptPath: z
    .string()
    .min(1)
    .describe(
      "Path to a workflow script file on the origin environment's host. Relative paths start at the workspace root and all paths must remain inside that workspace.",
    )
    .optional(),
  name: z
    .string()
    .min(1)
    .describe(
      "Name of a saved workflow from the current workspace's .bb/workflows/ directory. Resolves to a self-contained script.",
    )
    .optional(),
} as const;
const freeformJson = z.unknown();

const runInputSchema = z
  .object({
    ...sourceInputFields,
    args: freeformJson
      .describe(
        "Optional input value exposed to the script as the global `args`, verbatim. Pass arrays/objects as actual JSON values, NOT as a JSON-encoded string — a stringified list breaks `args.filter`/`args.map` in the script. Use for parameterized named workflows (e.g. a research question).",
      )
      .default(null),
    resumeRunId: z
      .string()
      .min(1)
      .nullable()
      .describe(
        "Run ID of a prior BB workflow to resume from. Calls in the causally safe, longest unchanged prefix return cached results; the first edited, new, or concurrent call and everything after it run live. The prior run must be terminal and from the same project and environment.",
      )
      .default(null),
  })
  .strict();
const resultInputSchema = z
  .object({
    value: freeformJson.describe(
      "The final value matching the requested JSON Schema.",
    ),
  })
  .strict();

function jsonResult(value: unknown): PluginAgentToolResult {
  return JSON.stringify(value, null, 2);
}

function errorResult(error: string): PluginAgentToolResult {
  return { content: [{ type: "text", text: error }], isError: true };
}

export default async function plugin(bb: BbPluginApi) {
  const settings = registerWorkflowSettings(bb);
  const db = bb.storage.database();
  bb.storage.migrate(db, migrations);
  let initialSettings = DEFAULT_WORKFLOW_SETTINGS;
  try {
    initialSettings = await settings.get();
  } catch (error) {
    bb.status.needsConfiguration(
      `Workflow settings are invalid; defaults are active until the settings are corrected: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  const service = createWorkflowService(bb, db, initialSettings);
  settings.onChange(
    (next) => service.updateSettings(next),
    (error) =>
      bb.status.needsConfiguration(
        `Workflow settings are invalid; the last valid values remain active: ${error.message}`,
      ),
  );
  registerWorkflowCli(bb, service);

  function workflowForThread(threadId: string, runId: string | null) {
    const run =
      runId === null
        ? service.inspectLatestForThread(threadId)
        : service.inspect(runId);
    if (run === null) return null;
    if (run.originThreadId !== threadId) {
      throw new Error("This workflow run is not available in this thread");
    }
    return run;
  }

  bb.rpc.register(workflowUiRpcContract, {
    workflowActiveRuns({ threadId }) {
      return {
        runs: service
          .inspectActiveForThread(threadId)
          .map(buildWorkflowRunView),
      };
    },
    workflowRunView({ threadId, runId }) {
      const run = workflowForThread(threadId, runId);
      return { run: run === null ? null : buildWorkflowRunView(run) };
    },
    async workflowStopRun({ threadId, runId }) {
      const run = workflowForThread(threadId, runId);
      if (run === null) throw new Error(`Unknown workflow run ${runId}`);
      const stopped = await service.stop(run.id);
      const latest = workflowForThread(threadId, run.id);
      if (latest === null) throw new Error(`Unknown workflow run ${runId}`);
      return { stopped, run: buildWorkflowRunView(latest) };
    },
  });

  bb.agents.registerTool({
    name: "bb_workflow_run",
    presentation: {
      label: { pending: "Starting workflow", completed: "Started workflow" },
      icon: { glyph: "Workflow" },
    },
    description:
      "Execute a workflow script that orchestrates multiple subagents deterministically. Workflows run in the background — this tool returns immediately with a run ID and a `previewDirective`. After a successful call, emit that directive exactly once on its own line (not in a code fence) so BB renders live progress in chat. A completion notification is sent to the origin thread. Use `bb workflows status <run-id>` for a compact summary. For detailed history, redirect a bounded JSONL page from `bb workflows history <run-id> --cursor <call-index> --limit <1-100>` into `$BB_THREAD_STORAGE`, then inspect the file with normal filesystem tools.",
    parameters: runInputSchema,
    async execute(input, ctx) {
      try {
        const prepared = await prepareWorkflowSource(bb, ctx, input);
        const run = await service.start({
          projectId: ctx.projectId,
          originThreadId: ctx.threadId,
          source: prepared.source,
          args: toJsonValue(input.args, "args"),
          resumedFromRunId: input.resumeRunId,
        });
        const previewDirective = `::workflow-preview{run="${run.id}"}`;
        return jsonResult({
          runId: run.id,
          status: run.status,
          name: run.name,
          previewDirective,
        });
      } catch (error) {
        return errorResult(
          error instanceof Error ? error.message : String(error),
        );
      }
    },
  });

  bb.agents.registerTool({
    name: "bb_workflow_result",
    presentation: {
      label: {
        pending: "Returning structured result",
        completed: "Returned structured result",
      },
      icon: { glyph: "Workflow" },
      suppress: true,
    },
    description:
      'Use this tool to return your final response in the requested structured format. You MUST call this tool exactly once at the end of your response with {"value": ...} to provide the structured output.',
    parameters: resultInputSchema,
    async execute({ value }, ctx) {
      let parsed: JsonValue;
      try {
        parsed = toJsonValue(value, "value");
      } catch (error) {
        return errorResult(
          error instanceof Error ? error.message : String(error),
        );
      }
      const result = await service.submitStructuredResult(ctx.threadId, parsed);
      if (result.ok) return jsonResult({ accepted: true });
      return errorResult(result.error);
    },
  });

  bb.agents.configure((context) => {
    const worker = service.agentConfiguration(context.thread.id);
    if (worker !== null) {
      return {
        tools:
          worker.terminal || worker.resultParameters === null
            ? []
            : [
                {
                  name: "bb_workflow_result",
                  parameters: worker.resultParameters,
                },
              ],
        skills: [],
        ...(worker.instructions === null
          ? {}
          : { instructions: worker.instructions }),
      };
    }
    if (context.origin.pluginId === bb.pluginId) {
      return {
        tools: ["bb_workflow_result"],
        skills: [],
        instructions:
          "You are starting as a BB workflow worker. Follow the workflow prompt. Your final text IS the return value, not a human-facing message. If the prompt requests structured output, call bb_workflow_result exactly once at the end of your response.",
      };
    }
    return {
      tools: ["bb_workflow_run"],
      skills: ["workflows"],
      instructions:
        "When bb_workflow_run succeeds, copy its previewDirective into your response exactly once as a standalone line. Do not wrap it in backticks or a code fence, and do not invent or edit the run ID. The directive renders live workflow progress in BB chat. `bb workflows status <run-id>` returns a compact summary. For detailed history, redirect `bb workflows history <run-id> --cursor <call-index> --limit <1-100>` into a file under `$BB_THREAD_STORAGE`, then inspect that JSONL file with normal filesystem tools. Use each page record's `nextCursor` to continue.",
    };
  });

  bb.events.on("thread.idle", ({ thread, lastAssistantText }) => {
    service.onThreadIdle(thread.id, lastAssistantText);
  });
  bb.events.on("thread.failed", ({ thread, error }) => {
    service.onThreadFailed(thread.id, error);
  });
  bb.events.on("thread.deleted", ({ thread }) => {
    service.onThreadDeleted(thread.id);
  });

  bb.background.service("workflow-worker", {
    start(signal) {
      return service.runWorker(signal);
    },
  });
}
