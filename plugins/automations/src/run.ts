import type { BbPluginApi } from "@get-bb/plugin-sdk";
import { z } from "zod";
import {
  closeAutomationRun,
  disableAutomationsForDeletedThread,
  getAutomation,
  listRunningAutomationRuns,
  listRunningAutomationRunsByThread,
  markAutomationThread,
  setAutomationEnabled,
  setAutomationRunThread,
  type AutomationRow,
  type AutomationRunRow,
  type Db,
} from "./data.js";
import { publishAutomationChange } from "./realtime.js";
import { executeStoredScript, mapScriptResultToRun } from "./script-runner.js";
import type { AutomationExecution } from "./rpc-types.js";

type RunFailureHandler = (error: unknown) => void;
type AgentThreadsSdk = {
  get(
    args: Parameters<BbPluginApi["sdk"]["threads"]["get"]>[0],
  ): Promise<unknown>;
  send(
    args: Parameters<BbPluginApi["sdk"]["threads"]["send"]>[0],
  ): Promise<unknown>;
  spawn(
    args: Parameters<BbPluginApi["sdk"]["threads"]["spawn"]>[0],
  ): Promise<unknown>;
};
type AgentRunApi = Pick<BbPluginApi, "realtime" | "log"> & {
  sdk: { threads: AgentThreadsSdk };
};

const sdkThreadSchema = z
  .object({
    id: z.string(),
    archivedAt: z.number().nullable(),
    deletedAt: z.number().nullable(),
    status: z.enum([
      "pending",
      "idle",
      "active",
      "starting",
      "stopping",
      "error",
    ]),
  })
  .passthrough();
type SdkThread = z.infer<typeof sdkThreadSchema>;

const projectGoneErrorSchema = z
  .object({
    status: z.literal(404),
    code: z.enum(["project_not_found", "project_unavailable"]),
  })
  .passthrough();

const threadGoneErrorSchema = z
  .object({ status: z.literal(404) })
  .passthrough();

function isThreadGoneError(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  return threadGoneErrorSchema.safeParse(error).success;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isProjectGoneError(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  return projectGoneErrorSchema.safeParse(error).success;
}

function renderAutomationDueMessage(args: {
  automationId: string;
  prompt: string;
}): string {
  return `[bb automation due:${args.automationId}]\n\n${args.prompt}`;
}

function isThreadReusable(thread: SdkThread): boolean {
  return (
    thread.deletedAt === null &&
    thread.archivedAt === null &&
    (thread.status === "idle" || thread.status === "active")
  );
}

interface AgentRunArgs {
  automation: AutomationRow;
  run: AutomationRunRow;
  execution: Extract<AutomationExecution, { mode: "agent" }>;
  onFailure: RunFailureHandler;
}

export async function executeAgentRun(
  bb: AgentRunApi,
  db: Db,
  args: AgentRunArgs,
): Promise<void> {
  try {
    if (args.automation.targetThreadId !== null) {
      await reuseTargetThreadForRun(bb, db, {
        ...args,
        targetThreadId: args.automation.targetThreadId,
      });
      return;
    }
    const thread = sdkThreadSchema.parse(
      await bb.sdk.threads.spawn({
        projectId: args.automation.projectId,
        environment: args.execution.environment,
        prompt: args.execution.prompt,
        title: args.automation.name,
        providerId: args.execution.providerId,
        model: args.execution.model,
        reasoningLevel: args.execution.reasoningLevel,
        ...(args.execution.serviceTier === undefined
          ? {}
          : { serviceTier: args.execution.serviceTier }),
        permissionMode: args.execution.permissionMode,
      }),
    );
    setAutomationRunThread(db, { runId: args.run.id, threadId: thread.id });
    markAutomationThread(db, {
      automationId: args.automation.id,
      runId: args.run.id,
      threadId: thread.id,
      now: Date.now(),
    });
  } catch (error) {
    settleDispatchFailure(bb, db, args, error);
  } finally {
    publishAutomationChange(bb, args.automation.projectId, [
      "automations-changed",
      "automation-runs-changed",
    ]);
  }
}

function settleDispatchFailure(
  bb: Pick<BbPluginApi, "log">,
  db: Db,
  args: AgentRunArgs,
  error: unknown,
): void {
  const message = errorMessage(error);
  if (isProjectGoneError(error)) {
    setAutomationEnabled(db, {
      projectId: args.automation.projectId,
      automationId: args.automation.id,
      enabled: false,
      nextRunAt: null,
      lastError: message,
    });
    closeAutomationRun(db, {
      runId: args.run.id,
      status: "failed",
      error: message,
      now: Date.now(),
    });
  } else {
    args.onFailure(error);
  }
  bb.log.error(
    `Failed to dispatch automation ${args.automation.id}: ${message}`,
  );
}

async function reuseTargetThreadForRun(
  bb: AgentRunApi,
  db: Db,
  args: AgentRunArgs & { targetThreadId: string },
): Promise<void> {
  let thread: SdkThread;
  try {
    thread = sdkThreadSchema.parse(
      await bb.sdk.threads.get({ threadId: args.targetThreadId }),
    );
  } catch (error) {
    if (!isThreadGoneError(error)) throw error;
    closeRunForUnusableTargetThread(bb, db, {
      ...args,
      detail: errorMessage(error),
    });
    return;
  }

  if (!isThreadReusable(thread)) {
    closeRunForUnusableTargetThread(bb, db, {
      ...args,
      detail: "missing, deleted, archived, or not runnable",
    });
    return;
  }

  setAutomationRunThread(db, {
    runId: args.run.id,
    threadId: args.targetThreadId,
  });
  markAutomationThread(db, {
    automationId: args.automation.id,
    runId: args.run.id,
    threadId: args.targetThreadId,
    now: Date.now(),
  });
  await bb.sdk.threads.send({
    threadId: args.targetThreadId,
    mode: "steer-if-active",
    input: [
      {
        type: "text",
        text: renderAutomationDueMessage({
          automationId: args.automation.id,
          prompt: args.execution.prompt,
        }),
        mentions: [],
      },
    ],
    permissionMode: args.execution.permissionMode,
  });
}

function closeRunForUnusableTargetThread(
  bb: Pick<BbPluginApi, "log">,
  db: Db,
  args: AgentRunArgs & { targetThreadId: string; detail: string },
): void {
  const now = Date.now();
  disableAutomationsForDeletedThread(db, {
    threadId: args.targetThreadId,
    now,
  });
  closeAutomationRun(db, {
    runId: args.run.id,
    status: "failed",
    error: `Target thread ${args.targetThreadId} is unavailable: ${args.detail}`,
    now,
  });
  bb.log.error(
    `Automation ${args.automation.id} target thread ${args.targetThreadId} is unavailable: ${args.detail}`,
  );
}

export async function executeScriptRun(
  bb: Pick<BbPluginApi, "realtime" | "log">,
  db: Db,
  args: {
    pluginDataDir: string;
    automation: AutomationRow;
    run: AutomationRunRow;
    execution: Extract<AutomationExecution, { mode: "script" }>;
    onFailure: RunFailureHandler;
    serverUrl: string;
  },
): Promise<void> {
  try {
    const scriptFile = args.execution.scriptFile;
    if (scriptFile === undefined) {
      closeAutomationRun(db, {
        runId: args.run.id,
        status: "failed",
        error: "Script automation is missing a stored script file",
        now: Date.now(),
      });
      return;
    }
    const result = await executeStoredScript({
      pluginDataDir: args.pluginDataDir,
      automationId: args.automation.id,
      runId: args.run.id,
      projectId: args.automation.projectId,
      scriptFile,
      interpreter: args.execution.interpreter,
      timeoutMs: args.execution.timeoutMs,
      env: args.execution.env,
      serverUrl: args.serverUrl,
    });
    const mapped = mapScriptResultToRun(result);
    closeAutomationRun(db, {
      runId: args.run.id,
      status: mapped.status,
      skipReason: mapped.skipReason,
      output: mapped.output,
      exitCode: mapped.exitCode,
      error: mapped.error,
      now: Date.now(),
    });
  } catch (error) {
    args.onFailure(error);
    bb.log.error(
      `Failed to run script for automation ${args.automation.id}: ${errorMessage(error)}`,
    );
  } finally {
    publishAutomationChange(bb, args.automation.projectId, [
      "automations-changed",
      "automation-runs-changed",
    ]);
  }
}

export function closeAutomationRunForSettledThread(
  bb: Pick<BbPluginApi, "realtime">,
  db: Db,
  args: { threadId: string; status: "idle" | "failed"; error?: string | null },
): void {
  const runs = listRunningAutomationRunsByThread(db, args.threadId);
  const now = Date.now();
  const changedProjects = new Set<string>();
  for (const run of runs) {
    const closed = closeAutomationRun(db, {
      runId: run.id,
      status: args.status === "idle" ? "succeeded" : "failed",
      error: args.status === "idle" ? null : (args.error ?? "Turn failed"),
      threadId: args.threadId,
      now,
    });
    if (!closed) continue;
    const automation = getAutomation(db, closed.automationId);
    if (automation) changedProjects.add(automation.projectId);
  }
  for (const projectId of changedProjects) {
    publishAutomationChange(bb, projectId, [
      "automations-changed",
      "automation-runs-changed",
    ]);
  }
}

type ReconcileOutcome =
  | { status: "succeeded" }
  | { status: "failed"; error: string }
  | { status: "skipped"; skipReason: string };

export async function reconcileRunningAutomationRuns(
  bb: AgentRunApi,
  db: Db,
): Promise<void> {
  const changedProjects = new Set<string>();
  for (const run of listRunningAutomationRuns(db)) {
    const outcome = await reconcileOutcome(bb, run);
    if (outcome === null) continue;
    const closed = closeAutomationRun(db, {
      runId: run.id,
      ...outcome,
      now: Date.now(),
    });
    if (!closed) continue;
    const automation = getAutomation(db, closed.automationId);
    if (automation) changedProjects.add(automation.projectId);
    bb.log.info(
      `Automation run ${run.id} settled as ${outcome.status} on startup: ${
        outcome.status === "succeeded"
          ? "its thread is idle"
          : outcome.status === "failed"
            ? outcome.error
            : outcome.skipReason
      }`,
    );
  }
  for (const projectId of changedProjects) {
    publishAutomationChange(bb, projectId, [
      "automations-changed",
      "automation-runs-changed",
    ]);
  }
}

async function reconcileOutcome(
  bb: AgentRunApi,
  run: AutomationRunRow,
): Promise<ReconcileOutcome | null> {
  if (run.runMode === "script") {
    return {
      status: "skipped",
      skipReason:
        "interrupted: the server restarted while the script was running",
    };
  }
  if (run.threadId === null) {
    return {
      status: "skipped",
      skipReason:
        "interrupted: the server restarted before a thread was attached",
    };
  }
  let thread: SdkThread;
  try {
    thread = sdkThreadSchema.parse(
      await bb.sdk.threads.get({ threadId: run.threadId }),
    );
  } catch (error) {
    if (isThreadGoneError(error)) {
      return {
        status: "skipped",
        skipReason: `interrupted: thread ${run.threadId} no longer exists`,
      };
    }
    bb.log.warn(
      `Could not check thread ${run.threadId} for running automation run ${run.id}; leaving it running: ${errorMessage(error)}`,
    );
    return null;
  }
  if (thread.deletedAt !== null || thread.archivedAt !== null) {
    return {
      status: "skipped",
      skipReason: `interrupted: thread ${run.threadId} was ${
        thread.deletedAt !== null ? "deleted" : "archived"
      }`,
    };
  }
  switch (thread.status) {
    case "idle":
      return { status: "succeeded" };
    case "error":
      return {
        status: "failed",
        error: "Turn failed while the automations plugin was not running",
      };
    // Still going somewhere: leave the run marked running and re-check later.
    // `pending` belongs here — the thread's first dispatch is queued, not
    // failed, so the run has neither succeeded nor finished.
    case "pending":
    case "starting":
    case "active":
    case "stopping":
      return null;
  }
}

export function disableAutomationsForDeletedThreadEvent(
  bb: Pick<BbPluginApi, "realtime">,
  db: Db,
  threadId: string,
): void {
  const disabled = disableAutomationsForDeletedThread(db, {
    threadId,
    now: Date.now(),
  });
  for (const automation of disabled) {
    publishAutomationChange(bb, automation.projectId, "automations-changed");
  }
}
