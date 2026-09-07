import { createHash } from "node:crypto";
import Ajv from "ajv";
import type { BbPluginApi } from "@get-bb/plugin-sdk";
import { z } from "zod";
import {
  WORKFLOW_CALL_CACHE_VERSION,
  computeWorkflowCallCacheKey,
  reusableSuccessfulResult,
} from "./cache.js";
import {
  activeChildThreadsForRun,
  attachCallThread,
  beginNotificationAttempt,
  cancelRun,
  claimQueuedRun,
  countCallsForRun,
  createRun,
  deleteTerminalRuns,
  getCall,
  getCallByChildThread,
  getLatestRunForOriginThread,
  getRun,
  getRunRequired,
  incrementRepairAttempts,
  listCallsForRun,
  listCallsForRunPage,
  listExpiredTerminalRuns,
  listActiveRunsForOriginThread,
  listRuns,
  listPendingNotificationRuns,
  listRunningCalls,
  listTimedOutRuns,
  markCallReplayedSameRun,
  markNotificationSent,
  queueCallProviderRetry,
  recordNotificationFailure,
  recoverInterruptedRuns,
  settleNotificationUndeliverable,
  settleCall,
  settleRun,
  startCall,
  storeStructuredResult,
  updateRunPhase,
  type Db,
  type WorkflowCallCounts,
  type WorkflowCallRow,
  type WorkflowRunRow,
} from "./data.js";
import { parseWorkflowSource } from "./parser.js";
import { WORKFLOW_RUNS_REALTIME_CHANNEL } from "./realtime-channel.js";
import { executeWorkflowScript } from "./runtime.js";
import {
  DEFAULT_WORKFLOW_SETTINGS,
  parseStoredWorkflowSettings,
  type WorkflowSettings,
} from "./settings.js";
import { workflowReferenceToSourceInput } from "./source-resolution.js";
import type {
  JsonSchema,
  JsonValue,
  NestedWorkflowContext,
  WorkflowAgentOptions,
  WorkflowCapabilities,
  WorkflowReference,
} from "./types.js";
import { parseStoredAgentOptions } from "./validation.js";
import { prepareWorkflowSource } from "./workflow-input.js";

const executionValuesSchema = z.object({
  model: z.string().min(1),
  reasoningLevel: z.enum([
    "none",
    "low",
    "medium",
    "high",
    "xhigh",
    "ultracode",
    "max",
    "ultra",
  ]),
  permissionMode: z.enum(["accept-edits", "auto", "full"]),
});

const selectedExecutionSchema = z.object({
  providerId: z.string().min(1),
  model: z.string().min(1),
  reasoningLevel: executionValuesSchema.shape.reasoningLevel,
  permissionMode: executionValuesSchema.shape.permissionMode,
});
type ResolvedSelection = z.infer<typeof selectedExecutionSchema>;

const MAX_REPAIR_ATTEMPTS = 2;
const WORKER_PROMPT_VERSION = "workflow-worker-prompt-v1";
const RESULT_PROTOCOL_VERSION = "workflow-result-protocol-v1";
const SCHEMA_LIMITS = { bytes: 64 * 1024, nodes: 4_096, depth: 64 };
const VALUE_LIMITS = { bytes: 1024 * 1024, nodes: 100_000, depth: 128 };
const NOTIFICATION_RETRY_BASE_MS = 1_000;
const NOTIFICATION_RETRY_MAX_MS = 60 * 60 * 1_000;
const PROVIDER_RETRY_DELAYS_MS = [1_000, 4_000] as const;
const RETENTION_SWEEP_RUNS = 20;

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function isRetryableProviderFailure(error: unknown): boolean {
  if (typeof error === "object" && error !== null) {
    const candidate = error as Record<string, unknown>;
    if (candidate.retryable === true) return true;
    const status = candidate.status ?? candidate.statusCode;
    if (
      typeof status === "number" &&
      [429, 500, 502, 503, 504, 529].includes(status)
    ) {
      return true;
    }
    if (
      typeof candidate.code === "string" &&
      /^(?:ECONNRESET|ECONNREFUSED|ETIMEDOUT|EHOSTUNREACH|ENETUNREACH)$/.test(
        candidate.code,
      )
    ) {
      return true;
    }
  }
  const detail = message(error).toLowerCase();
  return [
    /provider[^\n]*(?:overload|capacity|busy|temporar|unavailable|rate.?limit)/,
    /(?:rate.?limit|too many requests)/,
    /(?:http|status|api error|error)\s*(?:429|500|502|503|504|529)\b/,
    /\b(?:econnreset|econnrefused|etimedout|ehostunreach|enetunreach)\b/,
    /(?:connection reset|connection closed|socket hang up|network error)/,
  ].some((pattern) => pattern.test(detail));
}

function utf8Prefix(text: string, maximumBytes: number): string {
  if (maximumBytes <= 0) return "";
  let result = "";
  let bytes = 0;
  for (const character of text) {
    const next = Buffer.byteLength(character, "utf8");
    if (bytes + next > maximumBytes) break;
    result += character;
    bytes += next;
  }
  return result;
}

export function formatWorkflowNotification(
  run: WorkflowRunRow,
  maximumBytes: number,
): string {
  const prefix = `[BB workflow finished · ${run.id}]\n\nRun ${run.id} (${run.name}) ${run.status}.\n`;
  const suffix = `\nRun \`bb workflows status ${run.id}\` for authoritative details.`;
  const detail =
    run.status === "succeeded"
      ? `Result: ${run.resultJson ?? "null"}`
      : `Error: ${run.error ?? run.status}`;
  const full = `${prefix}${detail}${suffix}`;
  if (Buffer.byteLength(full, "utf8") <= maximumBytes) return full;
  const marker = "\n…[truncated]";
  const available =
    maximumBytes -
    Buffer.byteLength(prefix, "utf8") -
    Buffer.byteLength(marker, "utf8") -
    Buffer.byteLength(suffix, "utf8");
  if (available >= 0) {
    return `${prefix}${utf8Prefix(detail, available)}${marker}${suffix}`;
  }
  return utf8Prefix(
    `[BB workflow ${run.id}] ${run.status} — run bb workflows status ${run.id}`,
    maximumBytes,
  );
}

function parseJson(text: string, path: string): JsonValue {
  try {
    return JSON.parse(text) as JsonValue;
  } catch (error) {
    throw new Error(`${path} is corrupt: ${message(error)}`);
  }
}

function normalizeWholeOutputJsonFence(text: string): string {
  const trimmed = text.trim();
  const fenced = /^```(?:json)?[\t ]*\r?\n([\s\S]*)\r?\n```$/i.exec(trimmed);
  return fenced?.[1] ?? trimmed;
}

function assertBoundedJson(
  value: unknown,
  path: string,
  limits: { bytes: number; nodes: number; depth: number },
): void {
  const ancestors = new Set<object>();
  let nodes = 0;

  function visit(current: unknown, depth: number): void {
    nodes += 1;
    if (nodes > limits.nodes) {
      throw new Error(`${path} exceeds the ${limits.nodes} node limit`);
    }
    if (depth > limits.depth) {
      throw new Error(`${path} exceeds the maximum depth of ${limits.depth}`);
    }
    if (
      current === null ||
      typeof current === "string" ||
      typeof current === "boolean"
    ) {
      return;
    }
    if (typeof current === "number") {
      if (!Number.isFinite(current)) {
        throw new Error(`${path} contains a non-finite number`);
      }
      return;
    }
    if (typeof current !== "object") {
      throw new Error(`${path} contains a non-JSON value`);
    }
    if (ancestors.has(current)) {
      throw new Error(`${path} contains a cyclic value`);
    }
    ancestors.add(current);
    try {
      if (Array.isArray(current)) {
        const keys = Object.keys(current);
        if (
          keys.length !== current.length ||
          keys.some((key, index) => key !== String(index))
        ) {
          throw new Error(`${path} contains a sparse or decorated array`);
        }
        for (const item of current) visit(item, depth + 1);
        return;
      }

      const prototype = Object.getPrototypeOf(current);
      if (prototype !== Object.prototype && prototype !== null) {
        throw new Error(`${path} contains an object with an unsafe prototype`);
      }
      for (const key of Reflect.ownKeys(current)) {
        if (typeof key !== "string") {
          throw new Error(`${path} contains a symbol-keyed property`);
        }
        const descriptor = Object.getOwnPropertyDescriptor(current, key);
        if (
          descriptor === undefined ||
          !descriptor.enumerable ||
          !("value" in descriptor)
        ) {
          throw new Error(`${path} contains an unsafe property`);
        }
        visit(descriptor.value, depth + 1);
      }
    } finally {
      ancestors.delete(current);
    }
  }

  visit(value, 0);
  const serialized = JSON.stringify(value);
  if (serialized === undefined) throw new Error(`${path} is not JSON`);
  const bytes = Buffer.byteLength(serialized, "utf8");
  if (bytes > limits.bytes) {
    throw new Error(`${path} exceeds the ${limits.bytes} byte limit`);
  }
}

function validateValue(
  schema: JsonSchema,
  value: JsonValue,
): { valid: true } | { valid: false; error: string } {
  try {
    assertBoundedJson(schema, "JSON Schema", SCHEMA_LIMITS);
    assertBoundedJson(value, "JSON value", VALUE_LIMITS);
    const ajv = new Ajv({ strict: false, allErrors: true });
    const validate = ajv.compile(schema);
    if (validate(value)) return { valid: true };
    return {
      valid: false,
      error: ajv.errorsText(validate.errors, {
        separator: "; ",
        dataVar: "value",
      }),
    };
  } catch (error) {
    return { valid: false, error: message(error) };
  }
}

function resultToolParameters(
  outputSchema: JsonSchema,
): Record<string, unknown> {
  return {
    type: "object",
    properties: { value: outputSchema },
    required: ["value"],
    additionalProperties: false,
  };
}

function resolveStructuredValue(
  schema: JsonSchema,
  value: JsonValue,
): { value: JsonValue; validation: ReturnType<typeof validateValue> } {
  const validation = validateValue(schema, value);
  if (validation.valid || typeof value !== "string") {
    return { value, validation };
  }
  let unwrapped: JsonValue;
  try {
    unwrapped = JSON.parse(value) as JsonValue;
  } catch {
    return { value, validation };
  }
  const unwrappedValidation = validateValue(schema, unwrapped);
  if (unwrappedValidation.valid) {
    return { value: unwrapped, validation: unwrappedValidation };
  }
  return {
    value,
    validation: {
      valid: false,
      error: `${validation.error}. The value was a JSON-encoded string; pass the JSON value itself, not a string. After decoding it still fails validation: ${unwrappedValidation.error}`,
    },
  };
}

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) return resolve();
    const settle = () => {
      clearTimeout(timeout);
      signal.removeEventListener("abort", settle);
      resolve();
    };
    const timeout = setTimeout(settle, ms);
    signal.addEventListener("abort", settle, { once: true });
  });
}

interface StartWorkflowInput {
  projectId: string;
  originThreadId: string;
  source: string;
  args: JsonValue;
  resumedFromRunId: string | null;
}

export interface WorkflowService {
  start(input: StartWorkflowInput): Promise<WorkflowRunRow>;
  get(runId: string): WorkflowRunRow | null;
  inspect(runId: string): WorkflowRunInspection | null;
  inspectPage(
    runId: string,
    afterCallIndex: number,
    limit: number,
  ): WorkflowRunInspectionPage | null;
  inspectLatestForThread(threadId: string): WorkflowRunInspection | null;
  inspectActiveForThread(threadId: string): WorkflowRunInspection[];
  list(projectId: string, limit: number): WorkflowRunRow[];
  stop(runId: string): Promise<boolean>;
  updateSettings(settings: WorkflowSettings): void;
  runWorker(signal: AbortSignal): Promise<void>;
  onThreadIdle(threadId: string, output: string | null): void;
  onThreadFailed(threadId: string, error: string | null): void;
  onThreadDeleted(threadId: string): void;
  submitStructuredResult(
    threadId: string,
    value: JsonValue,
  ): Promise<{ ok: true } | { ok: false; terminal: boolean; error: string }>;
  agentConfiguration(threadId: string): {
    resultParameters: Record<string, unknown> | null;
    terminal: boolean;
    instructions: string | null;
  } | null;
}

export interface WorkflowCallInspection extends WorkflowCallRow {
  options: WorkflowAgentOptions;
  execution: {
    provider: string;
    model: string;
    reasoningLevel: string;
    permissionMode: string;
  };
  source: "cached" | "live";
}

export interface WorkflowRunInspection extends WorkflowRunRow {
  calls: WorkflowCallInspection[];
}

export interface WorkflowRunInspectionPage {
  run: WorkflowRunRow;
  calls: WorkflowCallInspection[];
  callCounts: WorkflowCallCounts;
}

export function createWorkflowService(
  bb: BbPluginApi,
  db: Db,
  initialSettings: WorkflowSettings = DEFAULT_WORKFLOW_SETTINGS,
): WorkflowService {
  let shuttingDown = false;
  let currentSettings = initialSettings;
  const controllers = new Map<string, AbortController>();
  const idleHandlers = new Set<string>();
  const handlerTasks = new Set<Promise<void>>();
  const idleHandlerTasks = new Map<string, Promise<void>>();
  const childStops = new Map<string, Promise<void>>();
  const waiters = new Map<
    string,
    { resolve: (value: JsonValue) => void; reject: (error: Error) => void }
  >();

  function throwIfCancelled(signal: AbortSignal): void {
    if (signal.aborted) throw new Error("Workflow cancelled");
  }

  function publishRunsChanged(originThreadId: string): void {
    bb.realtime.publish(WORKFLOW_RUNS_REALTIME_CHANNEL, {
      threadId: originThreadId,
    });
  }

  async function stopChild(threadId: string): Promise<void> {
    const pending = childStops.get(threadId);
    if (pending !== undefined) return pending;
    const stopping = bb.sdk.threads
      .stop({ threadId })
      .then(() => undefined)
      .catch((error) => {
        if (!isMissingThread(error)) {
          bb.log.warn(
            `Could not stop workflow worker ${threadId}: ${message(error)}`,
          );
        }
      })
      .finally(() => childStops.delete(threadId));
    childStops.set(threadId, stopping);
    return stopping;
  }

  async function stopChildren(threadIds: Iterable<string>): Promise<void> {
    await Promise.all(Array.from(threadIds, (threadId) => stopChild(threadId)));
  }

  async function resolveOrigin(input: StartWorkflowInput) {
    const thread = await bb.sdk.threads.get({ threadId: input.originThreadId });
    if (thread.environmentId === null) {
      throw new Error("Workflow origin thread has no environment");
    }
    const defaults = executionValuesSchema.parse(
      await bb.sdk.threads.defaultExecutionOptions({
        threadId: input.originThreadId,
      }),
    );
    return {
      environmentId: thread.environmentId,
      providerId: thread.providerId,
      ...defaults,
    };
  }

  async function start(input: StartWorkflowInput): Promise<WorkflowRunRow> {
    const parsed = parseWorkflowSource(input.source);
    assertBoundedJson(input.args, "Workflow args", VALUE_LIMITS);
    if (parsed.metadata.inputSchema !== null) {
      assertBoundedJson(
        parsed.metadata.inputSchema,
        "Workflow input schema",
        SCHEMA_LIMITS,
      );
    }
    if (parsed.metadata.outputSchema !== null) {
      assertBoundedJson(
        parsed.metadata.outputSchema,
        "Workflow output schema",
        SCHEMA_LIMITS,
      );
    }
    if (parsed.metadata.inputSchema !== null) {
      const validation = validateValue(parsed.metadata.inputSchema, input.args);
      if (!validation.valid)
        throw new Error(`Workflow args are invalid: ${validation.error}`);
    }
    const origin = await resolveOrigin(input);
    if (input.resumedFromRunId !== null) {
      const previous = getRun(db, input.resumedFromRunId);
      if (previous === null || previous.projectId !== input.projectId) {
        throw new Error(
          `Cannot resume unknown workflow run ${input.resumedFromRunId}`,
        );
      }
      if (previous.status === "queued" || previous.status === "running") {
        throw new Error(
          `Cannot resume workflow run ${input.resumedFromRunId} before it is terminal`,
        );
      }
      if (previous.environmentId !== origin.environmentId) {
        throw new Error(
          `Cannot resume workflow run ${input.resumedFromRunId} from a different environment or workspace`,
        );
      }
    }
    const created = createRun(db, {
      projectId: input.projectId,
      originThreadId: input.originThreadId,
      environmentId: origin.environmentId,
      originProvider: origin.providerId,
      originModel: origin.model,
      originReasoningLevel: origin.reasoningLevel,
      originPermissionMode: origin.permissionMode,
      name: parsed.metadata.name,
      source: input.source,
      sourceHash: createHash("sha256").update(input.source).digest("hex"),
      argsJson: JSON.stringify(input.args),
      settingsJson: JSON.stringify(currentSettings),
      resumedFromRunId: input.resumedFromRunId,
    });
    publishRunsChanged(created.originThreadId);
    return created;
  }

  function settingsForRun(run: WorkflowRunRow): WorkflowSettings {
    return parseStoredWorkflowSettings(
      parseJson(run.settingsJson, "workflow settings snapshot"),
    );
  }

  function inspectCall(call: WorkflowCallRow): WorkflowCallInspection {
    return {
      ...call,
      options: parseStoredAgentOptions(
        parseJson(call.optionsJson, "workflow call options"),
      ),
      execution: {
        provider: call.resolvedProvider,
        model: call.resolvedModel,
        reasoningLevel: call.resolvedReasoningLevel,
        permissionMode: call.resolvedPermissionMode,
      },
      source: call.replaySource === null ? "live" : "cached",
    };
  }

  function inspect(runId: string): WorkflowRunInspection | null {
    const run = getRun(db, runId);
    if (run === null) return null;
    return {
      ...run,
      calls: listCallsForRun(db, runId).map(inspectCall),
    };
  }

  function inspectPage(
    runId: string,
    afterCallIndex: number,
    limit: number,
  ): WorkflowRunInspectionPage | null {
    if (!Number.isInteger(afterCallIndex) || afterCallIndex < -1) {
      throw new Error("afterCallIndex must be an integer of -1 or greater");
    }
    if (!Number.isInteger(limit) || limit < 1 || limit > 101) {
      throw new Error("limit must be an integer from 1 to 101");
    }
    const run = getRun(db, runId);
    if (run === null) return null;
    return {
      run,
      calls: listCallsForRunPage(db, {
        runId,
        afterCallIndex,
        limit,
      }).map(inspectCall),
      callCounts: countCallsForRun(db, runId),
    };
  }

  function inspectLatestForThread(
    threadId: string,
  ): WorkflowRunInspection | null {
    const run = getLatestRunForOriginThread(db, threadId);
    return run === null ? null : inspect(run.id);
  }

  function inspectActiveForThread(threadId: string): WorkflowRunInspection[] {
    return listActiveRunsForOriginThread(db, threadId).map((run) => {
      const inspection = inspect(run.id);
      if (inspection === null) {
        throw new Error(`Unknown workflow run ${run.id}`);
      }
      return inspection;
    });
  }

  async function validateSelection(
    run: WorkflowRunRow,
    options: WorkflowAgentOptions,
    signal: AbortSignal,
  ): Promise<ResolvedSelection> {
    const inherited = options.selection === null;
    const requested = options.selection ?? {
      provider: run.originProvider,
      model: run.originModel,
      reasoningLevel: run.originReasoningLevel,
    };
    const providers = await bb.sdk.providers.list({
      environmentId: run.environmentId,
    });
    throwIfCancelled(signal);
    const provider = providers.find(
      (candidate) => candidate.id === requested.provider && candidate.available,
    );
    if (provider === undefined) {
      throw new Error(
        `Provider ${JSON.stringify(requested.provider)} is not available on this workflow host`,
      );
    }
    const catalog = await bb.sdk.providers.models({
      environmentId: run.environmentId,
      providerId: requested.provider,
    });
    throwIfCancelled(signal);
    if (catalog.modelLoadError !== null) {
      throw new Error(
        `Could not load models for provider ${requested.provider}: ${catalog.modelLoadError.code}`,
      );
    }
    const eligibleModels = inherited
      ? [...catalog.models, ...catalog.selectedOnlyModels]
      : catalog.models;
    const model = eligibleModels.find(
      (candidate) =>
        candidate.id === requested.model || candidate.model === requested.model,
    );
    if (model === undefined) {
      throw new Error(
        `Model ${JSON.stringify(requested.model)} is not available for provider ${requested.provider}`,
      );
    }
    if (
      !model.supportedReasoningEfforts.some(
        (effort) => effort.reasoningEffort === requested.reasoningLevel,
      )
    ) {
      throw new Error(
        `Reasoning level ${JSON.stringify(requested.reasoningLevel)} is not supported by ${requested.provider}/${requested.model}`,
      );
    }
    const permissionMode = executionValuesSchema.shape.permissionMode.parse(
      run.originPermissionMode,
    );
    if (!provider.capabilities.permissionModes.includes(permissionMode)) {
      throw new Error(
        `Permission mode ${JSON.stringify(run.originPermissionMode)} is not supported by provider ${requested.provider}`,
      );
    }
    return selectedExecutionSchema.parse({
      providerId: requested.provider,
      model: model.model,
      reasoningLevel: requested.reasoningLevel,
      permissionMode,
    });
  }

  function childPrompt(
    run: WorkflowRunRow,
    prompt: string,
    options: WorkflowAgentOptions,
  ) {
    const header = `[BB workflow ${run.name} · run ${run.id}]`;
    if (options.outputSchema === null) {
      return `${header}\n\n${prompt}\n\nYour final text IS the return value (not a human-facing message), so return raw data.`;
    }
    return `${header}\n\n${prompt}\n\nUse bb_workflow_result to return your final response in the requested structured format. You MUST call this tool exactly once at the end of your response with {"value": ...} to provide the structured output. The value must satisfy this JSON Schema:\n${JSON.stringify(options.outputSchema, null, 2)}\nIf the tool is unavailable during startup, return only the JSON value in your final response as a fallback. If the tool reports validation errors, correct the value and retry. You have at most ${MAX_REPAIR_ATTEMPTS} corrective retries.`;
  }

  function canReplayCall(run: WorkflowRunRow): boolean {
    return run.replaySafetyVersion === 1;
  }

  function waitForCall(
    call: WorkflowCallRow,
    signal: AbortSignal,
  ): Promise<JsonValue> {
    if (signal.aborted) return Promise.reject(new Error("Workflow cancelled"));
    const latest = getCall(db, call.runId, call.callIndex);
    if (latest?.status === "succeeded" && latest.resultJson !== null) {
      return Promise.resolve(
        parseJson(latest.resultJson, "workflow call result"),
      );
    }
    if (latest?.status === "failed" || latest?.status === "cancelled") {
      return Promise.reject(
        new Error(latest.error ?? `Workflow call ${latest.status}`),
      );
    }
    return new Promise((resolve, reject) => {
      waiters.set(call.id, { resolve, reject });
      signal.addEventListener(
        "abort",
        () => {
          waiters.delete(call.id);
          reject(new Error("Workflow cancelled"));
        },
        { once: true },
      );
    });
  }

  async function runAgentCall(
    run: WorkflowRunRow,
    callIndex: number,
    prompt: string,
    options: WorkflowAgentOptions,
    replay: { prefix: boolean },
    identity: Promise<{
      cacheKey: string;
      selection: ResolvedSelection;
    }>,
    replayDecision: { previous: Promise<void>; release: () => void },
    signal: AbortSignal,
  ): Promise<JsonValue> {
    await replayDecision.previous;
    let call: WorkflowCallRow;
    let selection: ResolvedSelection;
    try {
      throwIfCancelled(signal);
      if (options.outputSchema !== null) {
        assertBoundedJson(
          options.outputSchema,
          "Agent output schema",
          SCHEMA_LIMITS,
        );
      }
      const resolvedIdentity = await identity;
      const cacheKey = resolvedIdentity.cacheKey;
      selection = resolvedIdentity.selection;
      const sameRunCall = getCall(db, run.id, callIndex);
      if (replay.prefix) {
        if (sameRunCall !== null) {
          const sourceRun = getRunRequired(db, run.id);
          if (!canReplayCall(sourceRun)) {
            replay.prefix = false;
          }
          if (replay.prefix) {
            const result =
              sameRunCall.resultJson === null
                ? null
                : parseJson(sameRunCall.resultJson, "workflow call result");
            const reuse = reusableSuccessfulResult({
              status: sameRunCall.status,
              result,
            });
            if (sameRunCall.cacheKey === cacheKey && reuse.reusable) {
              markCallReplayedSameRun(db, sameRunCall.id);
              return reuse.result;
            }
          }
          replay.prefix = false;
        } else if (run.resumedFromRunId !== null) {
          const currentRun = getRunRequired(db, run.id);
          const sourceRun = getRunRequired(db, run.resumedFromRunId);
          if (!canReplayCall(currentRun) || !canReplayCall(sourceRun)) {
            replay.prefix = false;
          }
          if (replay.prefix) {
            const candidate = getCall(db, run.resumedFromRunId, callIndex);
            const result =
              candidate?.resultJson === null || candidate === null
                ? null
                : parseJson(
                    candidate.resultJson,
                    "resumed workflow call result",
                  );
            const reuse = reusableSuccessfulResult(
              candidate === null ? null : { status: candidate.status, result },
            );
            if (candidate?.cacheKey === cacheKey && reuse.reusable) {
              startCall(db, {
                runId: run.id,
                callIndex,
                cacheKey,
                prompt,
                options,
                selection,
                replay: { callId: candidate.id, result: reuse.result },
              });
              return reuse.result;
            }
          }
          replay.prefix = false;
        }
      }

      call = startCall(db, {
        runId: run.id,
        callIndex,
        cacheKey,
        prompt,
        options,
        selection,
        replay: null,
      });
    } finally {
      replayDecision.release();
    }
    while (true) {
      try {
        throwIfCancelled(signal);
        const child = await bb.sdk.threads.spawn({
          projectId: run.projectId,
          environment: { type: "reuse", environmentId: run.environmentId },
          prompt: childPrompt(run, prompt, options),
          title: options.title ?? `${run.name} · ${callIndex + 1}`,
          providerId: selection.providerId,
          model: selection.model,
          reasoningLevel: selection.reasoningLevel,
          permissionMode: selection.permissionMode,
          visibility: "hidden",
        });
        if (signal.aborted) {
          await stopChild(child.id);
          throw new Error("Workflow cancelled");
        }
        const attached = attachCallThread(db, call.id, child.id);
        if (!attached || signal.aborted) {
          await stopChild(child.id);
          throw new Error("Workflow cancelled");
        }
        const stopOnAbort = () => void stopChild(child.id);
        signal.addEventListener("abort", stopOnAbort, { once: true });
        try {
          const current = await bb.sdk.threads.get({ threadId: child.id });
          throwIfCancelled(signal);
          if (current.status === "idle") {
            const output = await bb.sdk.threads.output({ threadId: child.id });
            throwIfCancelled(signal);
            onThreadIdle(child.id, output.output);
          } else if (current.status === "error") {
            failThreadCall(
              child.id,
              "Workflow worker failed before attachment completed",
            );
          }
        } catch (error) {
          if (signal.aborted) {
            await stopChild(child.id);
            throw error;
          }
          bb.log.warn(
            `Could not reconcile new workflow worker ${child.id}: ${message(error)}`,
          );
        }
        try {
          return await waitForCall(call, signal);
        } finally {
          signal.removeEventListener("abort", stopOnAbort);
        }
      } catch (error) {
        throwIfCancelled(signal);
        const delay = PROVIDER_RETRY_DELAYS_MS[call.providerRetryAttempts];
        if (delay === undefined || !isRetryableProviderFailure(error)) {
          throw error;
        }
        const detail = message(error);
        const queued = queueCallProviderRetry(db, call.id, detail);
        if (queued === null) throw error;
        call = queued;
        bb.log.warn(
          `[${run.id}] Retrying agent call ${callIndex + 1} after transient provider failure ` +
            `(${call.providerRetryAttempts}/${PROVIDER_RETRY_DELAYS_MS.length}) in ${delay} ms: ${detail}`,
        );
        await sleep(delay, signal);
      }
    }
  }

  function wakeCall(call: WorkflowCallRow): void {
    const waiter = waiters.get(call.id);
    if (waiter === undefined) return;
    waiters.delete(call.id);
    const latest = getCall(db, call.runId, call.callIndex);
    if (latest?.status === "succeeded" && latest.resultJson !== null) {
      try {
        waiter.resolve(parseJson(latest.resultJson, "workflow call result"));
      } catch (error) {
        waiter.reject(
          error instanceof Error ? error : new Error(message(error)),
        );
      }
      return;
    }
    waiter.reject(new Error(latest?.error ?? "Workflow call failed"));
  }

  async function handleThreadIdle(
    threadId: string,
    output: string | null,
  ): Promise<void> {
    const call = getCallByChildThread(db, threadId);
    if (call === null || call.status !== "running") return;
    const options = parseStoredAgentOptions(JSON.parse(call.optionsJson));
    if (options.outputSchema !== null) {
      if (call.resultJson !== null) {
        settleCall(db, {
          id: call.id,
          status: "succeeded",
          result: parseJson(call.resultJson, "structured result"),
          error: null,
        });
        wakeCall(call);
        return;
      }

      let fallback:
        | { parsed: false; error: string }
        | {
            parsed: true;
            value: JsonValue;
            validation: ReturnType<typeof validateValue>;
          } = {
        parsed: false,
        error: "the worker did not return a JSON value",
      };
      if (output !== null) {
        try {
          const value = parseJson(
            normalizeWholeOutputJsonFence(output),
            "worker JSON response",
          );
          const resolved = resolveStructuredValue(options.outputSchema, value);
          fallback = {
            parsed: true,
            value: resolved.value,
            validation: resolved.validation,
          };
        } catch (error) {
          fallback = { parsed: false, error: message(error) };
        }
      }
      if (fallback.parsed && fallback.validation.valid) {
        const stored = storeStructuredResult(db, call.id, fallback.value);
        if (stored === "accepted" || stored === "idempotent") {
          settleCall(db, {
            id: call.id,
            status: "succeeded",
            result: fallback.value,
            error: null,
          });
          wakeCall(call);
          return;
        }
      }

      const attempts = incrementRepairAttempts(db, call.id);
      if (attempts === null) {
        wakeCall(call);
        return;
      }
      const detail = fallback.parsed
        ? fallback.validation.valid
          ? "a structured result was already recorded"
          : fallback.validation.error
        : fallback.error;
      if (attempts > MAX_REPAIR_ATTEMPTS) {
        const error = `Structured output failed after ${MAX_REPAIR_ATTEMPTS} corrective turns: ${detail}`;
        settleCall(db, { id: call.id, status: "failed", result: null, error });
        wakeCall(call);
        await stopChild(threadId);
        return;
      }

      try {
        await bb.sdk.threads.send({
          threadId,
          mode: "auto",
          input: [
            {
              type: "text",
              text: `Structured result missing or invalid (${detail}). Call bb_workflow_result with one value matching the required schema. Corrective turn ${attempts} of ${MAX_REPAIR_ATTEMPTS}.`,
              mentions: [],
            },
          ],
        });
        return;
      } catch (error) {
        const correctionError = `Could not request structured-output correction: ${message(error)}`;
        settleCall(db, {
          id: call.id,
          status: "failed",
          result: null,
          error: correctionError,
        });
        wakeCall(call);
        await stopChild(threadId);
      }
    } else {
      settleCall(db, {
        id: call.id,
        status: "succeeded",
        result: output ?? "",
        error: null,
      });
    }
    wakeCall(call);
  }

  function onThreadIdle(threadId: string, output: string | null): void {
    const call = getCallByChildThread(db, threadId);
    if (call === null || idleHandlers.has(call.id)) return;
    idleHandlers.add(call.id);
    const task = handleThreadIdle(threadId, output)
      .catch((error) => {
        bb.log.error(
          `Could not handle idle workflow worker ${threadId}: ${message(error)}`,
        );
        failThreadCall(
          threadId,
          `Could not handle worker result: ${message(error)}`,
        );
      })
      .finally(() => {
        idleHandlers.delete(call.id);
        idleHandlerTasks.delete(call.id);
        handlerTasks.delete(task);
      });
    handlerTasks.add(task);
    idleHandlerTasks.set(call.id, task);
  }

  function failThreadCall(threadId: string, error: string): void {
    const call = getCallByChildThread(db, threadId);
    if (call === null || call.status !== "running") return;
    settleCall(db, { id: call.id, status: "failed", result: null, error });
    wakeCall(call);
  }

  async function submitStructuredResult(
    threadId: string,
    value: JsonValue,
  ): Promise<{ ok: true } | { ok: false; terminal: boolean; error: string }> {
    const call = getCallByChildThread(db, threadId);
    if (call === null) {
      return {
        ok: false,
        terminal: true,
        error: "This thread is not an active workflow worker",
      };
    }
    const options = parseStoredAgentOptions(JSON.parse(call.optionsJson));
    if (options.outputSchema === null) {
      return {
        ok: false,
        terminal: true,
        error: "This workflow call does not require structured output",
      };
    }
    const resolved = resolveStructuredValue(options.outputSchema, value);
    const validation = resolved.validation;
    if (validation.valid) {
      const stored = storeStructuredResult(db, call.id, resolved.value);
      if (stored === "accepted") {
        settleCall(db, {
          id: call.id,
          status: "succeeded",
          result: resolved.value,
          error: null,
        });
        wakeCall(call);
        await stopChild(threadId);
        return { ok: true };
      }
      if (stored === "idempotent") {
        await stopChild(threadId);
        return { ok: true };
      }
      if (stored === "conflict") {
        return {
          ok: false,
          terminal: true,
          error:
            "A different structured result was already accepted for this workflow call",
        };
      }
      return {
        ok: false,
        terminal: true,
        error: "This workflow call is no longer active",
      };
    }
    const attempts = incrementRepairAttempts(db, call.id);
    if (attempts === null) {
      return {
        ok: false,
        terminal: true,
        error:
          call.resultJson === null
            ? "This workflow call is no longer active"
            : "A different structured result was already accepted for this workflow call",
      };
    }
    if (attempts > MAX_REPAIR_ATTEMPTS) {
      const error = `Structured output failed after ${MAX_REPAIR_ATTEMPTS} corrective retries: ${validation.error}`;
      settleCall(db, { id: call.id, status: "failed", result: null, error });
      wakeCall(call);
      await stopChild(threadId);
      return { ok: false, terminal: true, error };
    }
    return {
      ok: false,
      terminal: false,
      error: `Value does not match the required schema (${validation.error}). Correct it and retry; ${MAX_REPAIR_ATTEMPTS - attempts + 1} corrective ${MAX_REPAIR_ATTEMPTS - attempts + 1 === 1 ? "retry remains" : "retries remain"}.`,
    };
  }

  function agentConfiguration(threadId: string) {
    const call = getCallByChildThread(db, threadId);
    if (call === null) return null;
    const options = parseStoredAgentOptions(JSON.parse(call.optionsJson));
    return {
      resultParameters:
        call.status === "running" && options.outputSchema !== null
          ? resultToolParameters(options.outputSchema)
          : null,
      terminal: call.status !== "running",
      instructions:
        call.status !== "running"
          ? "This workflow worker is already terminal. Do not perform more work."
          : options.outputSchema === null
            ? null
            : `You are a BB workflow worker. Submit your final value with bb_workflow_result. Required schema: ${JSON.stringify(options.outputSchema)}`,
    };
  }

  async function notify(run: WorkflowRunRow): Promise<void> {
    const latest = getRunRequired(db, run.id);
    if (latest.notificationSent) return;
    const settings = settingsForRun(latest);
    if (!beginNotificationAttempt(db, run.id)) return;
    try {
      await bb.sdk.threads.send({
        threadId: latest.originThreadId,
        mode: "steer-if-active",
        input: [
          {
            type: "text",
            text: formatWorkflowNotification(
              latest,
              settings.maxNotificationBytes,
            ),
            mentions: [],
            visibility: "agent-only",
          },
        ],
      });
      markNotificationSent(db, run.id);
    } catch (error) {
      const detail = message(error);
      if (isMissingThread(error)) {
        settleNotificationUndeliverable(
          db,
          run.id,
          `Origin thread is unavailable: ${detail}`,
        );
        bb.log.warn(
          `Settled workflow notification ${run.id} without delivery because its origin thread is unavailable`,
        );
        return;
      }
      const exponent = Math.min(latest.notificationAttemptCount, 20);
      const delay = Math.min(
        NOTIFICATION_RETRY_MAX_MS,
        NOTIFICATION_RETRY_BASE_MS * 2 ** exponent,
      );
      recordNotificationFailure(db, {
        id: run.id,
        error: detail,
        nextAttemptAt: Date.now() + delay,
      });
      bb.log.error(
        `Could not notify workflow origin for ${run.id}; retrying in ${delay} ms: ${detail}`,
      );
    }
  }

  async function settleRunAndStopOutstanding(
    args: Parameters<typeof settleRun>[1],
  ): Promise<void> {
    const outstanding = settleRun(db, args);
    const settled = getRun(db, args.id);
    if (settled !== null) publishRunsChanged(settled.originThreadId);
    controllers.get(args.id)?.abort();
    for (const call of outstanding) wakeCall(call);
    await stopChildren(
      outstanding.flatMap((call) =>
        call.childThreadId === null ? [] : [call.childThreadId],
      ),
    );
  }

  async function executeRun(
    run: WorkflowRunRow,
    signal: AbortSignal,
  ): Promise<void> {
    const parsed = parseWorkflowSource(run.source);
    const runSettings = settingsForRun(run);
    let callIndex = 0;
    const replay = { prefix: true };
    const inFlightCalls = new Set<Promise<JsonValue>>();
    let previousCacheKey = Promise.resolve<string | null>(null);
    let previousReplayDecision = Promise.resolve();
    let nestedLaunchQueue = Promise.resolve();
    const capabilities: WorkflowCapabilities = {
      agent(prompt, options, callSignal) {
        const index = callIndex;
        callIndex += 1;
        const computeIdentity = async (previousKey: string | null) => {
          const selection = await validateSelection(run, options, callSignal);
          const cacheKey = computeWorkflowCallCacheKey({
            version: WORKFLOW_CALL_CACHE_VERSION,
            previousCacheKey: previousKey,
            prompt,
            selection,
            outputSchema: options.outputSchema,
            executionSemantics: {
              workerPromptVersion: WORKER_PROMPT_VERSION,
              resultProtocolVersion: RESULT_PROTOCOL_VERSION,
              maxRepairAttempts: MAX_REPAIR_ATTEMPTS,
            },
          });
          return { cacheKey, selection };
        };
        const identity = previousCacheKey.then(computeIdentity, async () => {
          replay.prefix = false;
          return computeIdentity(null);
        });
        previousCacheKey = identity.then(
          (value) => value.cacheKey,
          () => {
            replay.prefix = false;
            return null;
          },
        );
        const priorDecision = previousReplayDecision;
        let releaseDecision = (): void => undefined;
        previousReplayDecision = new Promise<void>((resolve) => {
          releaseDecision = resolve;
        });
        const call = runAgentCall(
          run,
          index,
          prompt,
          options,
          replay,
          identity,
          { previous: priorDecision, release: releaseDecision },
          callSignal,
        );
        inFlightCalls.add(call);
        void call.catch(() => undefined);
        void call
          .finally(() => {
            inFlightCalls.delete(call);
          })
          .catch(() => undefined);
        return call;
      },
      async workflow(
        reference: WorkflowReference,
        childArgs: JsonValue,
        context: NestedWorkflowContext,
      ) {
        const prepareAndLaunch = async () => {
          const prepared = await prepareWorkflowSource(
            bb,
            { projectId: run.projectId, environmentId: run.environmentId },
            workflowReferenceToSourceInput(reference),
          );
          throwIfCancelled(context.signal);
          const child = parseWorkflowSource(prepared.source);
          if (child.metadata.inputSchema !== null) {
            const validation = validateValue(
              child.metadata.inputSchema,
              childArgs,
            );
            if (!validation.valid) {
              throw new Error(
                `Nested workflow ${child.metadata.name} args are invalid: ${validation.error}`,
              );
            }
          }
          const execution = executeWorkflowScript({
            args: childArgs,
            body: child.body,
            capabilities,
            signal: context.signal,
            depth: context.depth,
            scheduler: context.scheduler,
          });
          return { child, execution };
        };
        const launch = nestedLaunchQueue.then(
          prepareAndLaunch,
          prepareAndLaunch,
        );
        nestedLaunchQueue = launch.then(
          () => undefined,
          () => undefined,
        );
        const { child: launchedChild, execution } = await launch;
        const result = await execution;
        if (launchedChild.metadata.outputSchema !== null) {
          const validation = validateValue(
            launchedChild.metadata.outputSchema,
            result,
          );
          if (!validation.valid) {
            throw new Error(
              `Nested workflow ${launchedChild.metadata.name} result is invalid: ${validation.error}`,
            );
          }
        }
        return result;
      },
      log(text) {
        bb.log.info(`[${run.id}] ${text}`);
      },
      phase(title) {
        updateRunPhase(db, run.id, title);
      },
    };
    try {
      const result = await executeWorkflowScript({
        args: parseJson(run.argsJson, "workflow args"),
        body: parsed.body,
        signal,
        capabilities,
        limits: {
          maxAgentCalls: runSettings.maxAgentCalls,
          maxConcurrentAgents: runSettings.maxConcurrentAgents,
        },
      });
      if (shuttingDown && signal.aborted) return;
      if (parsed.metadata.outputSchema !== null) {
        const validation = validateValue(parsed.metadata.outputSchema, result);
        if (!validation.valid) {
          throw new Error(`Workflow result is invalid: ${validation.error}`);
        }
      }
      await settleRunAndStopOutstanding({
        id: run.id,
        status: "succeeded",
        result,
        error: null,
      });
    } catch (error) {
      const latest = getRunRequired(db, run.id);
      if (shuttingDown && signal.aborted && latest.status === "running") {
        return;
      }
      if (latest.status !== "cancelled") {
        await settleRunAndStopOutstanding({
          id: run.id,
          status: signal.aborted ? "cancelled" : "failed",
          result: null,
          error: message(error),
        });
      }
    } finally {
      await Promise.allSettled(inFlightCalls);
      controllers.delete(run.id);
    }
  }

  function isMissingThread(error: unknown): boolean {
    if (typeof error !== "object" || error === null) return false;
    const candidate = error as { status?: unknown; code?: unknown };
    return candidate.status === 404 || candidate.code === "thread_not_found";
  }

  async function reconcileRunningCalls(): Promise<void> {
    for (const call of listRunningCalls(db, 100)) {
      const threadId = call.childThreadId!;
      try {
        const thread = await bb.sdk.threads.get({ threadId });
        if (thread.status === "idle") {
          const output = await bb.sdk.threads.output({ threadId });
          onThreadIdle(threadId, output.output);
          await idleHandlerTasks.get(call.id);
        } else if (thread.status === "error") {
          failThreadCall(threadId, "Workflow worker is in an error state");
        }
      } catch (error) {
        if (isMissingThread(error)) {
          failThreadCall(threadId, "Workflow worker was deleted");
        } else {
          bb.log.warn(
            `Could not reconcile workflow worker ${threadId}: ${message(error)}`,
          );
        }
      }
    }
  }

  async function enforceTimeouts(now: number): Promise<void> {
    for (const run of listTimedOutRuns(db, now, 100)) {
      const settings = settingsForRun(run);
      await settleRunAndStopOutstanding({
        id: run.id,
        status: "failed",
        result: null,
        error: `Workflow run timed out after ${settings.totalRunTimeoutMs} ms`,
      });
      controllers.get(run.id)?.abort();
    }
  }

  async function archiveRetiredWorker(threadId: string): Promise<boolean> {
    try {
      await bb.sdk.threads.archive({ threadId });
      return true;
    } catch (error) {
      if (isMissingThread(error)) return true;
      bb.log.warn(
        `Could not archive retired workflow worker ${threadId}: ${message(error)}`,
      );
      return false;
    }
  }

  async function sweepExpiredRuns(now: number): Promise<void> {
    const expired = listExpiredTerminalRuns(db, now, RETENTION_SWEEP_RUNS);
    if (expired.runIds.length === 0) return;
    for (const threadId of expired.childThreadIds) {
      if (await archiveRetiredWorker(threadId)) continue;
      bb.log.warn(
        `Retention kept ${expired.runIds.length} expired workflow runs until their workers archive`,
      );
      return;
    }
    deleteTerminalRuns(db, expired.runIds);
  }

  async function maintenanceTick(): Promise<void> {
    const now = Date.now();
    const isolated = async (
      name: string,
      operation: () => void | Promise<void>,
    ) => {
      try {
        await operation();
      } catch (error) {
        bb.log.error(
          `Workflow maintenance step ${name} failed: ${message(error)}`,
        );
      }
    };
    await isolated("reconcile-workers", reconcileRunningCalls);
    await isolated("enforce-timeouts", () => enforceTimeouts(now));
    await isolated("retention", () => sweepExpiredRuns(now));
  }

  async function runWorker(signal: AbortSignal): Promise<void> {
    signal.addEventListener(
      "abort",
      () => {
        shuttingDown = true;
        for (const controller of controllers.values()) controller.abort();
      },
      { once: true },
    );
    await stopChildren(recoverInterruptedRuns(db));
    const active = new Set<Promise<void>>();
    let nextMaintenanceAt = 0;
    while (!signal.aborted) {
      while (active.size < currentSettings.maxActiveRuns) {
        const run = claimQueuedRun(db, currentSettings.maxActiveRuns);
        if (run === null) break;
        publishRunsChanged(run.originThreadId);
        const controller = new AbortController();
        controllers.set(run.id, controller);
        const abortRun = () => controller.abort();
        signal.addEventListener("abort", abortRun, { once: true });
        const execution = executeRun(run, controller.signal).finally(() => {
          signal.removeEventListener("abort", abortRun);
          active.delete(execution);
        });
        active.add(execution);
      }
      if (Date.now() >= nextMaintenanceAt) {
        await maintenanceTick();
        nextMaintenanceAt = Date.now() + 1_000;
      }
      for (const pending of listPendingNotificationRuns(db, Date.now(), 100)) {
        try {
          await notify(pending);
        } catch (error) {
          bb.log.error(
            `Workflow notification maintenance failed for ${pending.id}: ${message(error)}`,
          );
        }
      }
      await sleep(active.size === 0 ? 250 : 50, signal);
    }
    shuttingDown = true;
    for (const controller of controllers.values()) controller.abort();
    await Promise.allSettled(active);
    await Promise.allSettled(handlerTasks);
    await stopChildren(recoverInterruptedRuns(db));
    await Promise.allSettled(childStops.values());
  }

  async function stop(runId: string): Promise<boolean> {
    const childThreadIds = activeChildThreadsForRun(db, runId);
    const stopped = cancelRun(db, runId);
    if (stopped) {
      const run = getRun(db, runId);
      if (run !== null) publishRunsChanged(run.originThreadId);
    }
    controllers.get(runId)?.abort();
    await stopChildren(childThreadIds);
    return stopped;
  }

  return {
    start,
    get: (runId) => getRun(db, runId),
    inspect,
    inspectPage,
    inspectLatestForThread,
    inspectActiveForThread,
    list: (projectId, limit) => listRuns(db, { projectId, limit }),
    stop,
    updateSettings(settings) {
      currentSettings = settings;
    },
    runWorker,
    onThreadIdle,
    onThreadFailed: (threadId, error) =>
      failThreadCall(threadId, error ?? "Workflow worker failed"),
    onThreadDeleted: (threadId) =>
      failThreadCall(threadId, "Workflow worker was deleted"),
    submitStructuredResult,
    agentConfiguration,
  };
}
