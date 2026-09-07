import path from "node:path";
import { z } from "zod";
import {
  normalizeProviderThreadNameEvent,
  toProviderExternalThreadName,
} from "@bb/domain";
import type { DynamicTool, InstructionMode, ThreadEvent } from "@bb/domain";
import type { AdapterCommand } from "./provider-adapter.js";
import {
  BRIDGE_JSON_RPC_ERRORS,
  providerHealthResultSchema,
  providerInstallationRunResultSchema,
  providerInstallationStatusSchema,
  providerUsageResultSchema,
  ThreadEventGrammar,
  threadIdentityResultSchema,
} from "@bb/provider-bridge-protocol";
import {
  JsonRpcResponseError,
  getJsonRpcStringParam,
  ignoredJsonRpcResultSchema,
  parseJsonRpcLine,
  sendJsonRpcError,
  sendJsonRpcRequest,
  settleJsonRpcResponse,
} from "@bb/provider-bridge-protocol/bridge-kit";
import type {
  JsonRpcObject,
  ProviderCommandPlan,
  ProviderRequestCommandPlan,
  SendJsonRpcRequestArgs,
} from "@bb/provider-bridge-protocol/bridge-kit";
import {
  assertProviderSupportsExecutionOptions,
  toProviderExecutionContext,
} from "./execution-options.js";
import {
  handleRuntimeProviderRequest,
  type ResolveRuntimeProviderRequestThreadIdArgs,
  type RuntimeProviderRequestKind,
} from "./runtime-provider-requests.js";
import {
  RuntimeProviderProcessManager,
  hasChildProcessExited,
  type RuntimeProviderProcess,
} from "./runtime-provider-process.js";
import {
  RuntimeThreadIdentityRegistry,
  stampThreadEventScope,
} from "./runtime-thread-identity.js";
import { RuntimeThreadGoalState } from "./runtime-thread-goal-state.js";
import { RuntimeBackgroundWorkState } from "./runtime-background-work-state.js";
import { RuntimeTurnState } from "./runtime-turn-state.js";
import type {
  AgentRuntimeContributedEnvEntry,
  AgentRuntime,
  AgentRuntimeProviderRecoveryHint,
  AgentRuntimeBridgeLaunch,
  AgentRuntimeExecutionOptions,
  AgentRuntimeOptions,
  ReapedIdleProviderSession,
} from "./types.js";
import {
  resolveThreadEnvironment,
  type DroppedThreadEnvironmentContribution,
  type ResolvedThreadEnvironmentEntry,
} from "./thread-shell-environment.js";
import { bridgeLaunchProcessKey } from "./bridge-launch-process-key.js";

interface RecordThreadExecutionOptionsArgs {
  options: AgentRuntimeExecutionOptions;
  threadId: string;
}

interface RestartThreadBridgeArgs {
  instructions: string | undefined;
  options: AgentRuntimeExecutionOptions;
  threadId: string;
}

interface RunThreadOperationArgs<TResult> {
  threadId: string;
  work: () => Promise<TResult>;
}

interface PreparedThreadRewind {
  state: "prepared";
  cleanupPromise: Promise<void> | null;
  cleanupTimer: ReturnType<typeof setTimeout> | null;
  processKey: string;
  providerId: string;
  providerState: RuntimeProviderProcess["identity"];
  providerThreadId: string;
  stagingThreadId: string;
  threadId: string;
}

interface PreparingThreadRewind {
  state: "preparing";
  promise: Promise<{ providerThreadId: string }>;
}

type StagedThreadRewind = PreparingThreadRewind | PreparedThreadRewind;

interface ReapIdleProviderSessionCandidate {
  idleSinceMs: number;
  providerThreadId: string;
  threadId: string;
  runtimeConfig: ThreadRuntimeConfig;
}

interface FindReapableIdleProviderSessionArgs {
  idleForMs: number;
  nowMs: number;
  threadId: string;
}

interface ResolveProviderProcessKeyArgs {
  bridgeLaunch: AgentRuntimeBridgeLaunch;
  providerId: string;
}

interface ArchiveOrUnarchiveThreadArgs {
  bridgeLaunch?: AgentRuntimeBridgeLaunch;
  commandType: "thread/archive" | "thread/unarchive";
  providerId: string;
  providerThreadId: string;
  threadId: string;
}

interface RequestRecoveryArgs {
  bridgeLaunch?: AgentRuntimeBridgeLaunch;
  providerId: string;
  providerThreadId: string;
  threadId: string;
}

export class AgentRuntimeRecoveryError extends Error {
  readonly code: "auth_required" | "rate_limited";
  readonly recovery: AgentRuntimeProviderRecoveryHint;

  constructor(args: {
    code: "auth_required" | "rate_limited";
    message: string;
    recovery: AgentRuntimeProviderRecoveryHint;
    cause: unknown;
  }) {
    super(args.message, { cause: args.cause });
    this.name = "AgentRuntimeRecoveryError";
    this.code = args.code;
    this.recovery = args.recovery;
  }
}

const DEFAULT_RATE_LIMITED_RETRY_DELAYS_MS = [2_000, 8_000] as const;

interface ResolveProviderRequestThreadIdArgs extends ResolveRuntimeProviderRequestThreadIdArgs {
  proc: ProviderProcess;
}

interface ResolveThreadStoragePathArgs {
  options: AgentRuntimeOptions;
  threadId: string;
}

const providerThreadStopResultSchema = z
  .object({
    providerCheckpointId: z.string().min(1).nullable().optional(),
  })
  .passthrough();

function defaultBridgeNodeEnv(): Record<string, string> | undefined {
  if (process.versions.electron === undefined) {
    return undefined;
  }
  return { ELECTRON_RUN_AS_NODE: "1" };
}

type ProviderProcess = RuntimeProviderProcess;

const threadGoalClearResultSchema = z.object({ cleared: z.boolean() }).strict();
const THREAD_GOAL_CLEAR_EVENT_TIMEOUT_MS = 5_000;
const PREPARED_THREAD_REWIND_TTL_MS = 5 * 60_000;
const PREPARED_THREAD_REWIND_RETRY_MS = 30_000;

interface ThreadRuntimeConfig {
  bridgeLaunch: AgentRuntimeBridgeLaunch;
  contributedEnv: readonly AgentRuntimeContributedEnvEntry[];
  dynamicTools?: DynamicTool[];
  disallowedTools?: readonly string[];
  environmentId: string;
  instructionMode: InstructionMode;
  instructions?: string;
  envVars: Record<string, string>;
  options: AgentRuntimeExecutionOptions;
  processKey: string;
  projectId?: string;
  providerId: string;
  sessionRestorable: boolean;
}

interface RuntimeParsedMessageArgs {
  parsed: JsonRpcObject;
  proc: ProviderProcess;
}

interface EmitTranslatedEventsArgs {
  events: ThreadEvent[];
  proc: ProviderProcess;
  sourceThreadId?: string;
}

interface RequireProviderRequestPlanArgs {
  commandType: AdapterCommand["type"];
  plan: ProviderCommandPlan;
  providerId: string;
}

const DEFAULT_THREAD_CREATION_REQUEST_TIMEOUT_MS = 2 * 60_000;
const FAILED_CONSTRUCTION_RELEASE_TIMEOUT_MS = 5_000;

async function delay(ms: number): Promise<void> {
  await new Promise<void>((resolve) => {
    setTimeout(resolve, ms);
  });
}

function resolveThreadStoragePath(
  args: ResolveThreadStoragePathArgs,
): string | undefined {
  const rootPath = args.options.threadStorageRootPath;
  if (!rootPath) {
    return undefined;
  }
  return path.join(rootPath, args.threadId);
}

export function createAgentRuntime(options: AgentRuntimeOptions): AgentRuntime {
  const additionalWorkspaceWriteRoots =
    options.additionalWorkspaceWriteRoots ?? [];
  const skillRoots = options.skillRoots ?? [];
  for (const skillRoot of skillRoots) {
    if (!path.isAbsolute(skillRoot.path)) {
      throw new Error(
        `Agent runtime skill root "${skillRoot.id}" must use an absolute path: ${skillRoot.path}`,
      );
    }
  }
  let nextRequestId = 1;
  const threadIdentityRegistry = new RuntimeThreadIdentityRegistry();
  const threadRuntimeConfigs = new Map<string, ThreadRuntimeConfig>();
  const rateLimitedRetryDelaysMs =
    options.rateLimitRetry?.delaysMs ?? DEFAULT_RATE_LIMITED_RETRY_DELAYS_MS;
  const threadCreationRequestTimeoutMs =
    options.threadCreation?.requestTimeoutMs ??
    DEFAULT_THREAD_CREATION_REQUEST_TIMEOUT_MS;
  const threadsAwaitingBridgeRestart = new Map<
    string,
    AgentRuntimeProviderRecoveryHint
  >();
  const threadsRetryingBridgeRestartOnIdle = new Set<string>();
  const idleProviderSessionSinceMsByThreadId = new Map<string, number>();
  const pendingTurnStarts = new Map<
    string,
    { sinceMs: number; watchdogFired: boolean }
  >();
  const turnStartWatchdogThresholdMs =
    options.turnStartWatchdog?.thresholdMs ?? 120_000;
  const turnStartWatchdogTimer = setInterval(() => {
    const nowMs = Date.now();
    for (const [threadId, entry] of pendingTurnStarts) {
      if (
        entry.watchdogFired ||
        nowMs - entry.sinceMs < turnStartWatchdogThresholdMs
      ) {
        continue;
      }
      entry.watchdogFired = true;
      options.onEvent({
        type: "system/error",
        threadId,
        scope: { kind: "thread" },
        code: "provider_turn_start_timeout",
        message: `The provider accepted a turn but did not start it within ${Math.round(turnStartWatchdogThresholdMs / 1000)}s. The request may be stalled; stopping the thread interrupts it.`,
      });
    }
  }, options.turnStartWatchdog?.intervalMs ?? 15_000);
  turnStartWatchdogTimer.unref?.();
  const threadOperationCounts = new Map<string, number>();
  const stagedThreadRewinds = new Map<string, StagedThreadRewind>();
  const suppressedThreadEventIds = new Set<string>();
  const threadGoalState = new RuntimeThreadGoalState();
  const turnState = new RuntimeTurnState();
  const backgroundWorkState = new RuntimeBackgroundWorkState();
  const threadEventGrammar = new ThreadEventGrammar();
  const bridgeNodeEnv = defaultBridgeNodeEnv();

  const providerProcesses = new RuntimeProviderProcessManager({
    additionalWorkspaceWriteRoots,
    bridgeBundleDir: options.bridgeBundleDir,
    ...(bridgeNodeEnv !== undefined ? { bridgeNodeEnv } : {}),
    bridgeNodeExecutablePath: process.execPath,
    captureThreadExitState: (threadId) => ({
      activeTurnId: turnState.getActiveTurnId(threadId),
      pendingTurnStart: pendingTurnStarts.has(threadId),
      providerThreadId:
        threadIdentityRegistry.getProviderThreadId(threadId) ?? null,
      threadId,
    }),
    createProviderIdentityState: (providerId) =>
      threadIdentityRegistry.createProviderState({ providerId }),
    env: options.env,
    getNextRequestId: () => nextRequestId++,
    handleStdoutLine: (args) =>
      handleStdoutLine(args.line, args.providerProcess),
    onProcessExit: options.onProcessExit,
    onProviderThreadDetached: (threadId) => {
      threadIdentityRegistry.clearThread(threadId);
      clearThreadRuntimeConfig(threadId);
      turnState.clearThread(threadId);
      backgroundWorkState.clearThread(threadId);
      threadEventGrammar.clearThread(threadId);
    },
    onStderr: options.onStderr,
    skillRoots,
    workspacePath: options.workspacePath,
  });

  function resolveProviderProcessKey(
    args: ResolveProviderProcessKeyArgs,
  ): string {
    return `${args.providerId}#bridge:${bridgeLaunchProcessKey(args.bridgeLaunch)}`;
  }

  function requireProviderProcessForThread(threadId: string): ProviderProcess {
    const providerId =
      threadIdentityRegistry.resolveProviderForThread(threadId);
    const config = threadRuntimeConfigs.get(threadId);
    if (config === undefined) {
      throw new Error(
        `Thread "${threadId}" has no live provider session on "${providerId}"`,
      );
    }
    return providerProcesses.requireProviderProcess({
      processKey: config.processKey,
      providerId,
    });
  }

  async function releaseThreadOnBridgeBestEffort(args: {
    proc: ProviderProcess;
    threadId: string;
  }): Promise<void> {
    if (hasChildProcessExited(args.proc.child)) {
      return;
    }
    const providerThreadId =
      threadIdentityRegistry.getProviderThreadId(args.threadId) ??
      args.threadId;
    const plan = args.proc.adapter.buildCommandPlan({
      type: "thread/stop",
      threadId: args.threadId,
      providerThreadId,
      activeTurnId: null,
    });
    if (plan.kind !== "request") {
      return;
    }
    try {
      await sendCommand({
        proc: args.proc,
        message: plan,
        resultSchema: ignoredJsonRpcResultSchema,
        timeoutMs: FAILED_CONSTRUCTION_RELEASE_TIMEOUT_MS,
      });
    } catch (error) {
      options.onStderr?.(
        `Best-effort release of thread "${args.threadId}" after a failed session construction did not complete: ${error instanceof Error ? error.message : String(error)}`,
        args.threadId,
      );
    }
  }

  async function releaseIdleProviderProcess(
    proc: ProviderProcess,
  ): Promise<void> {
    if (proc.identity.threadIds.size > 0) {
      return;
    }
    await providerProcesses.shutdownProvider({
      processKey: proc.processKey,
      providerId: proc.providerId,
    });
  }

  async function abandonFailedSessionConstruction(args: {
    proc: ProviderProcess;
    threadId: string;
  }): Promise<void> {
    await releaseThreadOnBridgeBestEffort(args);
    forgetThreadRuntimeStateForProviderState(args.proc.identity, args.threadId);
    try {
      await releaseIdleProviderProcess(args.proc);
    } catch (shutdownError) {
      options.onStderr?.(
        `Failed to retire the provider after thread "${args.threadId}" session construction failed: ${shutdownError instanceof Error ? shutdownError.message : String(shutdownError)}`,
      );
    }
  }

  async function sendCommand<TResult>(args: {
    proc: ProviderProcess;
    message: SendJsonRpcRequestArgs<TResult>["message"];
    resultSchema: SendJsonRpcRequestArgs<TResult>["resultSchema"];
    timeoutMs?: number;
    recovery?: RequestRecoveryArgs;
  }): Promise<TResult> {
    return sendRequestWithRecovery({
      allowUnarchive: true,
      proc: args.proc,
      recovery: args.recovery,
      request: {
        child: args.proc.child,
        getNextId: () => nextRequestId++,
        message: args.message,
        pending: args.proc.pending,
        resultSchema: args.resultSchema,
        ...(args.timeoutMs !== undefined ? { timeoutMs: args.timeoutMs } : {}),
      },
    });
  }

  interface RequestRecoveryPolicy<TResult> {
    allowUnarchive: boolean;
    proc: ProviderProcess;
    recovery: RequestRecoveryArgs | undefined;
    request: SendJsonRpcRequestArgs<TResult>;
  }

  async function sendRequestWithRecovery<TResult>(
    args: RequestRecoveryPolicy<TResult>,
  ): Promise<TResult> {
    try {
      return await sendJsonRpcRequest({
        ...args.request,
        child: args.proc.child,
        pending: args.proc.pending,
      });
    } catch (error) {
      const hint = rejectionHint(error, {
        providerId: args.proc.providerId,
        ...(args.recovery === undefined
          ? {}
          : { threadId: args.recovery.threadId }),
      });
      if (hint === null) {
        throw error;
      }
      return await actOnRejection({ ...args, error, hint });
    }
  }

  async function actOnRejection<TResult>(
    args: RequestRecoveryPolicy<TResult> & {
      error: unknown;
      hint: AgentRuntimeProviderRecoveryHint;
    },
  ): Promise<TResult> {
    const { error, hint, recovery } = args;
    switch (hint.kind) {
      case "sessionArchived":
        if (recovery !== undefined && hint.retryable && args.allowUnarchive) {
          return await unarchiveAndRetryRequest({
            error,
            proc: args.proc,
            recovery,
            request: args.request,
          });
        }
        throw error;
      case "rateLimited":
        if (recovery !== undefined && hint.retryable) {
          return await retryRateLimitedRequest({
            allowUnarchive: args.allowUnarchive,
            error,
            hint,
            proc: args.proc,
            recovery,
            request: args.request,
          });
        }
        handleRecoveryHint({ hint, proc: args.proc, source: "rejection" });
        throw toRecoveryError({ cause: error, code: "rate_limited", hint });
      case "authRequired":
        handleRecoveryHint({ hint, proc: args.proc, source: "rejection" });
        throw toRecoveryError({ cause: error, code: "auth_required", hint });
      case "restartRecommended":
        handleRecoveryHint({ hint, proc: args.proc, source: "rejection" });
        throw error;
      case "staleTurn":
        throw error;
    }
  }

  function rejectionHint(
    error: unknown,
    scope: { providerId: string; threadId?: string },
  ): AgentRuntimeProviderRecoveryHint | null {
    if (!(error instanceof JsonRpcResponseError) || error.recovery === null) {
      return null;
    }
    return { ...scope, ...error.recovery };
  }

  function toRecoveryError(args: {
    cause: unknown;
    code: AgentRuntimeRecoveryError["code"];
    hint: AgentRuntimeProviderRecoveryHint;
  }): AgentRuntimeRecoveryError {
    return new AgentRuntimeRecoveryError({
      cause: args.cause,
      code: args.code,
      message: args.hint.message,
      recovery: args.hint,
    });
  }

  interface RetryableRequestArgs<TResult> {
    error: unknown;
    proc: ProviderProcess;
    recovery: RequestRecoveryArgs;
    request: SendJsonRpcRequestArgs<TResult>;
  }

  async function unarchiveAndRetryRequest<TResult>(
    args: RetryableRequestArgs<TResult>,
  ): Promise<TResult> {
    const { error, recovery } = args;
    options.onStderr?.(
      `Session "${recovery.providerThreadId}" is archived; unarchiving before retrying thread "${recovery.threadId}".`,
    );
    let retryProc: ProviderProcess;
    try {
      await archiveOrUnarchiveThread({
        commandType: "thread/unarchive",
        ...recovery,
      });
      retryProc = providerProcesses.requireProviderProcess({
        processKey: args.proc.processKey,
        providerId: args.proc.providerId,
      });
    } catch (recoveryError) {
      const message = error instanceof Error ? error.message : String(error);
      throw new Error(message, { cause: recoveryError });
    }

    return sendRequestWithRecovery({
      allowUnarchive: false,
      proc: retryProc,
      recovery,
      request: args.request,
    });
  }

  async function retryRateLimitedRequest<TResult>(
    args: RetryableRequestArgs<TResult> & {
      allowUnarchive: boolean;
      hint: AgentRuntimeProviderRecoveryHint;
    },
  ): Promise<TResult> {
    let lastError = args.error;
    let lastHint = args.hint;
    for (const retryDelayMs of rateLimitedRetryDelaysMs) {
      options.onStderr?.(
        `Provider "${args.recovery.providerId}" is rate limited; retrying thread "${args.recovery.threadId}" in ${retryDelayMs}ms.`,
      );
      await delay(retryDelayMs);
      const proc = providerProcesses.requireProviderProcess({
        processKey: args.proc.processKey,
        providerId: args.proc.providerId,
      });
      try {
        return await sendJsonRpcRequest({
          ...args.request,
          child: proc.child,
          pending: proc.pending,
        });
      } catch (retryError) {
        const nextHint = rejectionHint(retryError, {
          providerId: args.recovery.providerId,
          threadId: args.recovery.threadId,
        });
        if (nextHint === null) {
          throw retryError;
        }
        if (!(nextHint.kind === "rateLimited" && nextHint.retryable)) {
          return await actOnRejection({
            allowUnarchive: args.allowUnarchive,
            error: retryError,
            hint: nextHint,
            proc,
            recovery: args.recovery,
            request: args.request,
          });
        }
        lastError = retryError;
        lastHint = nextHint;
      }
    }
    handleRecoveryHint({
      hint: lastHint,
      proc: args.proc,
      source: "rejection",
    });
    throw toRecoveryError({
      cause: lastError,
      code: "rate_limited",
      hint: lastHint,
    });
  }

  function resolveBbThreadIdForProcess(
    proc: ProviderProcess,
    providerThreadId: string | undefined,
  ): string | undefined {
    return threadIdentityRegistry.resolveBbThreadIdForProviderThread({
      providerState: proc.identity,
      providerThreadId,
    });
  }

  function formatProviderRequestKindForSentence(
    requestKind: RuntimeProviderRequestKind,
  ): string {
    return requestKind === "tool call" ? "Tool call" : "Interactive request";
  }

  function resolveProviderRequestThreadId(
    args: ResolveProviderRequestThreadIdArgs,
  ): string | null {
    const resolvedThreadId = resolveBbThreadIdForProcess(
      args.proc,
      args.providerThreadId,
    );
    if (!resolvedThreadId) {
      sendJsonRpcError({
        child: args.proc.child,
        id: args.parsedId,
        message: `Unable to resolve BB thread id for ${args.requestKind} on provider thread "${args.providerThreadId}"`,
      });
      return null;
    }
    if (args.threadIdHint && args.threadIdHint !== resolvedThreadId) {
      sendJsonRpcError({
        child: args.proc.child,
        id: args.parsedId,
        message: `${formatProviderRequestKindForSentence(args.requestKind)} thread hint "${args.threadIdHint}" did not match resolved BB thread "${resolvedThreadId}" for provider thread "${args.providerThreadId}"`,
      });
      return null;
    }

    return resolvedThreadId;
  }

  function requireProviderRequestPlan(
    args: RequireProviderRequestPlanArgs,
  ): ProviderRequestCommandPlan {
    if (args.plan.kind === "request") {
      return args.plan;
    }
    throw new Error(
      `Adapter "${args.providerId}" returned no provider request for ${args.commandType}: ${args.plan.reason}`,
    );
  }

  function setThreadRuntimeConfig(
    threadId: string,
    config: ThreadRuntimeConfig,
  ): void {
    threadRuntimeConfigs.set(threadId, config);
  }

  function updateSessionRestoreCapability(
    threadId: string,
    sessionRestorable: boolean | undefined,
  ): void {
    if (sessionRestorable === undefined) {
      return;
    }
    const current = threadRuntimeConfigs.get(threadId);
    if (current) {
      threadRuntimeConfigs.set(threadId, { ...current, sessionRestorable });
    }
  }

  function clearThreadRuntimeConfig(threadId: string): void {
    threadsAwaitingBridgeRestart.delete(threadId);
    threadsRetryingBridgeRestartOnIdle.delete(threadId);
    idleProviderSessionSinceMsByThreadId.delete(threadId);
    pendingTurnStarts.delete(threadId);
    threadGoalState.clearThread(threadId);
    threadRuntimeConfigs.delete(threadId);
  }

  function beginThreadOperation(threadId: string): void {
    threadOperationCounts.set(
      threadId,
      (threadOperationCounts.get(threadId) ?? 0) + 1,
    );
  }

  function finishThreadOperation(threadId: string): void {
    const current = threadOperationCounts.get(threadId);
    if (current === undefined || current <= 1) {
      threadOperationCounts.delete(threadId);
      retryBridgeRestartOnIdle(threadId);
      return;
    }
    threadOperationCounts.set(threadId, current - 1);
  }

  function retryBridgeRestartOnIdle(threadId: string): void {
    if (!threadsRetryingBridgeRestartOnIdle.has(threadId)) {
      return;
    }
    queueMicrotask(() => {
      const hint = threadsAwaitingBridgeRestart.get(threadId);
      if (hint === undefined) {
        threadsRetryingBridgeRestartOnIdle.delete(threadId);
        return;
      }
      if (
        threadHasInFlightOperation(threadId) ||
        turnState.getActiveTurnId(threadId) !== null
      ) {
        return;
      }
      threadsRetryingBridgeRestartOnIdle.delete(threadId);
      scheduleBridgeRestart({ hint, threadId, retryOnIdle: true });
    });
  }

  function threadHasInFlightOperation(threadId: string): boolean {
    return threadOperationCounts.has(threadId);
  }

  async function runThreadOperation<TResult>(
    args: RunThreadOperationArgs<TResult>,
  ): Promise<TResult> {
    beginThreadOperation(args.threadId);
    try {
      return await args.work();
    } finally {
      finishThreadOperation(args.threadId);
    }
  }

  function assertThreadCanStartTurn(threadId: string): void {
    if (
      turnState.getActiveTurnId(threadId) !== null ||
      pendingTurnStarts.has(threadId)
    ) {
      throw new Error(
        `Refusing to start a competing turn for thread "${threadId}" while another turn is active or starting`,
      );
    }
  }

  function recordProviderThreadIdentity(
    proc: ProviderProcess,
    threadId: string,
    providerThreadId: string,
  ): void {
    threadIdentityRegistry.recordProviderThreadIdentity({
      providerState: proc.identity,
      threadId,
      providerThreadId,
    });
  }

  function forgetThreadRuntimeStateForProviderState(
    providerState: RuntimeProviderProcess["identity"],
    threadId: string,
  ): void {
    threadIdentityRegistry.forgetThread({
      providerState,
      threadId,
    });
    clearThreadRuntimeConfig(threadId);
    turnState.clearThread(threadId);
    backgroundWorkState.clearThread(threadId);
    threadEventGrammar.clearThread(threadId);
  }

  function markProviderSessionNotIdle(threadId: string): void {
    idleProviderSessionSinceMsByThreadId.delete(threadId);
  }

  function markHostedProviderSessionIdle(threadId: string): void {
    if (
      threadIdentityRegistry.getProviderSession(threadId) === null ||
      turnState.getActiveTurnId(threadId) !== null ||
      pendingTurnStarts.has(threadId)
    ) {
      return;
    }
    if (!idleProviderSessionSinceMsByThreadId.has(threadId)) {
      idleProviderSessionSinceMsByThreadId.set(threadId, Date.now());
    }
  }

  function observeProviderSessionIdleState(event: ThreadEvent): void {
    if (event.type === "turn/started") {
      pendingTurnStarts.delete(event.threadId);
      markProviderSessionNotIdle(event.threadId);
      return;
    }

    if (event.type === "turn/completed") {
      pendingTurnStarts.delete(event.threadId);
      markHostedProviderSessionIdle(event.threadId);
      return;
    }

    if (event.type === "provider/error" && event.willRetry !== true) {
      pendingTurnStarts.delete(event.threadId);
      markHostedProviderSessionIdle(event.threadId);
    }
  }

  function findReapableIdleProviderSession(
    args: FindReapableIdleProviderSessionArgs,
  ): ReapIdleProviderSessionCandidate | null {
    if (
      threadHasInFlightOperation(args.threadId) ||
      pendingTurnStarts.has(args.threadId) ||
      turnState.getActiveTurnId(args.threadId) !== null
    ) {
      return null;
    }

    const runtimeConfig = threadRuntimeConfigs.get(args.threadId);
    if (!runtimeConfig?.sessionRestorable) {
      return null;
    }

    const providerThreadId = threadIdentityRegistry.getProviderThreadId(
      args.threadId,
    );
    if (!providerThreadId) {
      return null;
    }

    const idleSinceMs = idleProviderSessionSinceMsByThreadId.get(args.threadId);
    if (idleSinceMs === undefined) {
      return null;
    }

    if (args.nowMs - idleSinceMs < args.idleForMs) {
      return null;
    }

    return {
      idleSinceMs,
      providerThreadId,
      runtimeConfig,
      threadId: args.threadId,
    };
  }

  function requireProviderThreadId(threadId: string): string {
    const providerThreadId =
      threadIdentityRegistry.getProviderThreadId(threadId);
    if (!providerThreadId) {
      throw new Error(`No provider thread id available for ${threadId}`);
    }
    return providerThreadId;
  }

  function handleRecoveryHint(args: {
    hint: AgentRuntimeProviderRecoveryHint;
    proc: ProviderProcess;
    source: "rejection" | "unsolicited";
  }): void {
    const { hint } = args;
    options.onProviderRecovery?.(hint);
    if (hint.kind === "restartRecommended" && hint.threadId !== undefined) {
      scheduleBridgeRestart({
        hint,
        retryOnIdle: args.source === "unsolicited",
        threadId: hint.threadId,
      });
    }
  }

  function scheduleBridgeRestart(args: {
    hint: AgentRuntimeProviderRecoveryHint;
    retryOnIdle: boolean;
    threadId: string;
  }): void {
    if (!threadRuntimeConfigs.has(args.threadId)) {
      return;
    }
    threadsAwaitingBridgeRestart.set(args.threadId, args.hint);
    if (turnState.getActiveTurnId(args.threadId) !== null) {
      return;
    }
    if (threadHasInFlightOperation(args.threadId)) {
      if (args.retryOnIdle) {
        threadsRetryingBridgeRestartOnIdle.add(args.threadId);
      }
      return;
    }
    threadsRetryingBridgeRestartOnIdle.delete(args.threadId);
    void runThreadOperation({
      threadId: args.threadId,
      work: async () => {
        const currentConfig = threadRuntimeConfigs.get(args.threadId);
        if (!currentConfig) {
          threadsAwaitingBridgeRestart.delete(args.threadId);
          return;
        }
        await restartThreadBridgeIfRecommended({
          threadId: args.threadId,
          options: currentConfig.options,
          instructions: currentConfig.instructions,
        });
      },
    }).catch((error: unknown) => {
      options.onStderr?.(
        `Bridge restart for thread "${args.threadId}" failed: ${error instanceof Error ? error.message : String(error)}`,
        args.threadId,
      );
    });
  }

  async function restartThreadBridgeIfRecommended(
    args: RestartThreadBridgeArgs,
  ): Promise<void> {
    const hint = threadsAwaitingBridgeRestart.get(args.threadId);
    if (hint === undefined) {
      return;
    }
    const currentConfig = threadRuntimeConfigs.get(args.threadId);
    if (!currentConfig) {
      threadsAwaitingBridgeRestart.delete(args.threadId);
      return;
    }
    if (turnState.getActiveTurnId(args.threadId) !== null) {
      return;
    }
    const proc = providerProcesses.requireProviderProcess({
      processKey: currentConfig.processKey,
      providerId: currentConfig.providerId,
    });
    const hostedThreadIds = [...proc.identity.threadIds].filter(
      (threadId) => threadId !== args.threadId,
    );
    const busyThreadId = hostedThreadIds.find(
      (threadId) =>
        turnState.getActiveTurnId(threadId) !== null ||
        pendingTurnStarts.has(threadId) ||
        threadHasInFlightOperation(threadId) ||
        backgroundWorkState.hasOpenThreadWork(threadId),
    );
    if (busyThreadId !== undefined) {
      options.onStderr?.(
        `Deferring the "${currentConfig.providerId}" bridge restart recommended for thread "${args.threadId}": thread "${busyThreadId}" is mid-turn or has open background work on the same process.`,
        args.threadId,
      );
      return;
    }
    threadsAwaitingBridgeRestart.delete(args.threadId);
    const providerThreadId = requireProviderThreadId(args.threadId);
    const hostedSessions = hostedThreadIds.flatMap((threadId) => {
      const config = threadRuntimeConfigs.get(threadId);
      const hostedProviderThreadId =
        threadIdentityRegistry.getProviderThreadId(threadId);
      return config !== undefined && hostedProviderThreadId !== undefined
        ? [{ config, providerThreadId: hostedProviderThreadId, threadId }]
        : [];
    });
    options.onStderr?.(
      `Restarting the "${currentConfig.providerId}" bridge for thread "${args.threadId}": ${hint.message}`,
      args.threadId,
    );
    await providerProcesses.shutdownProvider({
      processKey: proc.processKey,
      providerId: proc.providerId,
    });
    await resumeThreadFromConfig({
      currentConfig,
      instructions: args.instructions,
      options: args.options,
      providerThreadId,
      threadId: args.threadId,
    });
    for (const hosted of hostedSessions) {
      if (
        threadIdentityRegistry.getProviderSession(hosted.threadId) !== null ||
        threadHasInFlightOperation(hosted.threadId) ||
        pendingTurnStarts.has(hosted.threadId) ||
        turnState.getActiveTurnId(hosted.threadId) !== null
      ) {
        continue;
      }
      try {
        await resumeThreadFromConfig({
          currentConfig: hosted.config,
          instructions: hosted.config.instructions,
          options: hosted.config.options,
          providerThreadId: hosted.providerThreadId,
          threadId: hosted.threadId,
        });
      } catch (error) {
        options.onStderr?.(
          `Failed to resume thread "${hosted.threadId}" after the bridge restart: ${error instanceof Error ? error.message : String(error)}`,
          hosted.threadId,
        );
      }
    }
  }

  async function resumeThreadFromConfig(args: {
    currentConfig: ThreadRuntimeConfig;
    instructions: string | undefined;
    options: AgentRuntimeExecutionOptions;
    providerThreadId: string;
    threadId: string;
  }): Promise<void> {
    const { currentConfig } = args;
    const resumeInstructions = args.instructions ?? currentConfig.instructions;
    await runtime.resumeThread({
      bridgeLaunch: currentConfig.bridgeLaunch,
      environmentId: currentConfig.environmentId,
      threadId: args.threadId,
      ...(currentConfig.projectId !== undefined
        ? { projectId: currentConfig.projectId }
        : {}),
      providerThreadId: args.providerThreadId,
      providerId: currentConfig.providerId,
      contributedEnv: currentConfig.contributedEnv,
      options: args.options,
      ...(resumeInstructions !== undefined
        ? { instructions: resumeInstructions }
        : {}),
      ...(currentConfig.dynamicTools !== undefined
        ? { dynamicTools: currentConfig.dynamicTools }
        : {}),
      ...(currentConfig.disallowedTools !== undefined
        ? { disallowedTools: currentConfig.disallowedTools }
        : {}),
      instructionMode: currentConfig.instructionMode,
    });
  }

  async function archiveOrUnarchiveThread(
    args: ArchiveOrUnarchiveThreadArgs,
  ): Promise<void> {
    const { commandType, providerId, providerThreadId, threadId } = args;
    const threadConfig = threadRuntimeConfigs.get(threadId);
    const bridgeLaunch = args.bridgeLaunch ?? threadConfig?.bridgeLaunch;
    if (bridgeLaunch === undefined) {
      throw new Error(
        `Cannot ${commandType} thread "${threadId}" on "${providerId}": the thread has no live session and the request carried no bridge launch`,
      );
    }
    const processKey =
      threadConfig?.processKey ??
      resolveProviderProcessKey({ bridgeLaunch, providerId });
    await providerProcesses.ensureProvider({
      processKey,
      providerId,
      bridgeLaunch,
    });
    const proc = providerProcesses.requireProviderProcess({
      processKey,
      providerId,
    });
    if (!proc.adapter.capabilities.supportsThreadArchive) {
      throw new Error(
        `Provider "${providerId}" does not support thread archive.`,
      );
    }

    const adapterCommand: AdapterCommand = {
      type: commandType,
      threadId,
      providerThreadId,
    };
    const cmd = requireProviderRequestPlan({
      commandType: adapterCommand.type,
      plan: proc.adapter.buildCommandPlan(adapterCommand),
      providerId,
    });
    await sendCommand({
      proc,
      message: cmd,
      resultSchema: ignoredJsonRpcResultSchema,
    });
    if (commandType === "thread/archive") {
      forgetThreadRuntimeStateForProviderState(proc.identity, threadId);
    }
    await releaseIdleProviderProcess(proc);
  }

  function recordThreadExecutionOptions(
    args: RecordThreadExecutionOptionsArgs,
  ): void {
    const currentConfig = threadRuntimeConfigs.get(args.threadId);
    if (!currentConfig) {
      return;
    }
    setThreadRuntimeConfig(args.threadId, {
      ...currentConfig,
      options: args.options,
    });
  }

  function environmentRecordsEqual(
    left: Readonly<Record<string, string>>,
    right: Readonly<Record<string, string>>,
  ): boolean {
    const leftEntries = Object.entries(left);
    const rightEntries = Object.entries(right);
    return (
      leftEntries.length === rightEntries.length &&
      leftEntries.every(([name, value]) => right[name] === value)
    );
  }

  function emitResolvedProviderEnvironment(args: {
    droppedContributions: DroppedThreadEnvironmentContribution[];
    entries: ResolvedThreadEnvironmentEntry[];
    providerThreadId: string;
    threadId: string;
  }): void {
    options.onEvent({
      type: "provider.env-resolved",
      threadId: args.threadId,
      providerThreadId: args.providerThreadId,
      entries: args.entries,
      scope: { kind: "thread" },
    });
    for (const contribution of args.droppedContributions) {
      options.onEvent({
        type: "provider/warning",
        threadId: args.threadId,
        providerThreadId: args.providerThreadId,
        category: "config",
        summary: `Dropped environment variable "${contribution.name}" from plugin "${contribution.plugin}".`,
        details:
          "BB_SERVER_URL is unavailable, so its serverPath contribution was not applied.",
        scope: { kind: "thread" },
      });
    }
  }

  function resolveRuntimeThreadEnvironment(args: {
    contributedEnv: readonly AgentRuntimeContributedEnvEntry[];
    environmentId: string;
    projectId?: string;
    threadId: string;
  }): {
    droppedContributions: DroppedThreadEnvironmentContribution[];
    envVars: Record<string, string>;
    entries: ResolvedThreadEnvironmentEntry[];
  } {
    return resolveThreadEnvironment({
      baseShellEnv: options.shellEnv,
      contributedEnv: args.contributedEnv,
      environmentId: args.environmentId,
      projectId: args.projectId,
      threadStoragePath: resolveThreadStoragePath({
        options,
        threadId: args.threadId,
      }),
      threadId: args.threadId,
    });
  }

  function emitTranslatedEvents(args: EmitTranslatedEventsArgs): void {
    for (const event of args.events) {
      if (event.type !== "thread/identity" || !event.providerThreadId) {
        continue;
      }

      if (args.proc.identity.threadIds.has(event.threadId)) {
        recordProviderThreadIdentity(
          args.proc,
          event.threadId,
          event.providerThreadId,
        );
        continue;
      }

      const bbThreadId =
        threadIdentityRegistry.resolvePendingProviderThreadIdentity(
          args.proc.identity,
        );
      if (bbThreadId) {
        recordProviderThreadIdentity(
          args.proc,
          bbThreadId,
          event.providerThreadId,
        );
      }
    }

    for (const event of args.events) {
      const resolvedBbThreadId =
        threadIdentityRegistry.resolveProviderEventThreadId({
          eventThreadId: event.threadId,
          providerState: args.proc.identity,
          sourceThreadId: args.sourceThreadId,
        });

      if (!resolvedBbThreadId) {
        options.onStderr?.(
          `Dropping unscoped provider event ${event.type}; no bb thread could be resolved`,
        );
        continue;
      }
      const targetThreadId = resolvedBbThreadId;

      if (suppressedThreadEventIds.has(targetThreadId)) {
        continue;
      }
      const stampedEvent = stampThreadEventScope({
        event,
        providerThreadId:
          threadIdentityRegistry.getProviderThreadId(targetThreadId),
        threadId: targetThreadId,
      });

      const grammarResult = threadEventGrammar.observe(stampedEvent);
      if (grammarResult.kind === "violation") {
        options.onStderr?.(
          `Dropping ${stampedEvent.type} from provider "${args.proc.providerId}" in thread "${targetThreadId}" (${grammarResult.rule}): ${grammarResult.reason}.`,
        );
        continue;
      }

      const normalizedEvent = normalizeProviderThreadNameEvent(stampedEvent);
      turnState.observe(normalizedEvent);
      backgroundWorkState.observe(normalizedEvent);
      observeProviderSessionIdleState(normalizedEvent);
      options.onEvent(normalizedEvent);
      threadGoalState.observe(normalizedEvent);
    }
  }

  function handleProviderNotification(args: RuntimeParsedMessageArgs): void {
    const sourceThreadId = getJsonRpcStringParam(args.parsed, "threadId");
    if (
      sourceThreadId !== undefined &&
      suppressedThreadEventIds.has(sourceThreadId)
    ) {
      return;
    }
    const recoveryHint = args.proc.adapter.decodeRecoveryHint?.(args.parsed);
    if (recoveryHint !== null && recoveryHint !== undefined) {
      if (
        recoveryHint.threadId !== undefined &&
        !args.proc.identity.threadIds.has(recoveryHint.threadId)
      ) {
        options.onStderr?.(
          `Dropping provider/recovery ${recoveryHint.kind} from "${args.proc.providerId}": it names thread "${recoveryHint.threadId}", which that process does not host.`,
        );
        return;
      }
      handleRecoveryHint({
        hint: { providerId: args.proc.providerId, ...recoveryHint },
        proc: args.proc,
        source: "unsolicited",
      });
      return;
    }
    emitTranslatedEvents({
      events: args.proc.adapter.translateEvent(args.parsed),
      proc: args.proc,
      sourceThreadId,
    });
  }

  function handleStdoutLine(line: string, proc: ProviderProcess): void {
    const parsedLine = parseJsonRpcLine(line);
    if (
      parsedLine.kind === "non_json" ||
      parsedLine.kind === "invalid_json_rpc"
    ) {
      options.onStderr?.(line);
      return;
    }

    if (parsedLine.kind === "response") {
      settleJsonRpcResponse({
        id: parsedLine.parsedId,
        pending: proc.pending,
        response: parsedLine.parsed,
      });
      return;
    }

    if (parsedLine.kind === "request") {
      handleRuntimeProviderRequest({
        getActiveTurnId: (threadId) => turnState.getActiveTurnId(threadId),
        getThreadExecutionOptions: (threadId) =>
          threadRuntimeConfigs.get(threadId)?.options,
        onInteractiveRequest: options.onInteractiveRequest,
        onToolCall: options.onToolCall,
        parsedId: parsedLine.parsedId,
        parsedMethod: parsedLine.parsedMethod,
        providerProcess: proc,
        rawRequest: parsedLine.rawRequest,
        resolveThreadId: (request) =>
          resolveProviderRequestThreadId({
            ...request,
            proc,
          }),
      });
      return;
    }

    handleProviderNotification({
      parsed: parsedLine.parsed,
      proc,
    });
  }

  function schedulePreparedThreadRewindCleanup(
    leaseId: string,
    prepared: PreparedThreadRewind,
    delayMs: number,
  ): void {
    if (prepared.cleanupTimer !== null) {
      clearTimeout(prepared.cleanupTimer);
    }
    prepared.cleanupTimer = setTimeout(() => {
      void discardStagedThreadRewind(leaseId);
    }, delayMs);
    prepared.cleanupTimer.unref?.();
  }

  function finishPreparedThreadRewindCleanup(
    leaseId: string,
    prepared: PreparedThreadRewind,
  ): void {
    if (prepared.cleanupTimer !== null) {
      clearTimeout(prepared.cleanupTimer);
      prepared.cleanupTimer = null;
    }
    if (stagedThreadRewinds.get(leaseId) === prepared) {
      stagedThreadRewinds.delete(leaseId);
    }
    suppressedThreadEventIds.delete(prepared.stagingThreadId);
  }

  async function sendStagedThreadDiscard(
    proc: ProviderProcess,
    stagingThreadId: string,
    providerThreadId: string,
  ): Promise<void> {
    const command = proc.adapter.buildCommandPlan({
      type: "thread/discard",
      threadId: stagingThreadId,
      providerThreadId,
    });
    if (command.kind === "request") {
      await sendCommand({
        proc,
        message: command,
        resultSchema: ignoredJsonRpcResultSchema,
      });
    }
  }

  async function discardStagedThreadRewind(leaseId: string): Promise<void> {
    const staged = stagedThreadRewinds.get(leaseId);
    if (staged?.state === "preparing") {
      try {
        await staged.promise;
      } catch {
        return;
      }
    }
    const prepared = stagedThreadRewinds.get(leaseId);
    if (prepared === undefined || prepared.state !== "prepared") {
      return;
    }
    if (prepared.cleanupPromise !== null) {
      await prepared.cleanupPromise;
      return;
    }

    const cleanup = (async () => {
      let proc: ProviderProcess;
      try {
        proc = providerProcesses.requireProviderProcess({
          processKey: prepared.processKey,
          providerId: prepared.providerId,
        });
      } catch {
        forgetThreadRuntimeStateForProviderState(
          prepared.providerState,
          prepared.stagingThreadId,
        );
        finishPreparedThreadRewindCleanup(leaseId, prepared);
        return;
      }

      try {
        await sendStagedThreadDiscard(
          proc,
          prepared.stagingThreadId,
          prepared.providerThreadId,
        );
      } catch (error) {
        schedulePreparedThreadRewindCleanup(
          leaseId,
          prepared,
          PREPARED_THREAD_REWIND_RETRY_MS,
        );
        options.onStderr?.(
          `Failed to discard staged rewind ${leaseId}; retrying: ${error instanceof Error ? error.message : String(error)}`,
        );
        return;
      }

      forgetThreadRuntimeStateForProviderState(
        proc.identity,
        prepared.stagingThreadId,
      );
      finishPreparedThreadRewindCleanup(leaseId, prepared);
      try {
        await releaseIdleProviderProcess(proc);
      } catch (error) {
        options.onStderr?.(
          `Failed to stop the idle provider after discarding staged rewind ${leaseId}: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    })();
    prepared.cleanupPromise = cleanup;
    try {
      await cleanup;
    } finally {
      if (
        stagedThreadRewinds.get(leaseId) === prepared &&
        prepared.cleanupPromise === cleanup
      ) {
        prepared.cleanupPromise = null;
      }
    }
  }

  const runtime: AgentRuntime = {
    async ensureProvider({ providerId, bridgeLaunch }) {
      await providerProcesses.ensureProvider({
        processKey: resolveProviderProcessKey({ bridgeLaunch, providerId }),
        providerId,
        bridgeLaunch,
      });
    },

    async startThread({
      environmentId,
      threadId,
      projectId,
      providerId,
      bridgeLaunch,
      contributedEnv = [],
      clientRequestId,
      input,
      inputGroups,
      options: execOpts,
      instructions,
      dynamicTools,
      disallowedTools,
      instructionMode = "append",
      fork,
    }) {
      return runThreadOperation({
        threadId,
        work: async () => {
          const processKey = resolveProviderProcessKey({
            bridgeLaunch,
            providerId,
          });
          await runtime.ensureProvider({ providerId, bridgeLaunch });

          const proc = providerProcesses.requireProviderProcess({
            processKey,
            providerId,
          });
          assertProviderSupportsExecutionOptions({
            adapter: proc.adapter,
            options: execOpts,
            providerId,
          });
          const resolvedEnvironment = resolveRuntimeThreadEnvironment({
            contributedEnv,
            environmentId,
            projectId,
            threadId,
          });
          threadIdentityRegistry.registerThreadProvider({
            providerId,
            providerState: proc.identity,
            expectsIdentityNotification: true,
            threadId,
          });
          setThreadRuntimeConfig(threadId, {
            bridgeLaunch,
            contributedEnv,
            dynamicTools,
            disallowedTools,
            environmentId,
            envVars: resolvedEnvironment.envVars,
            instructionMode,
            instructions,
            options: execOpts,
            processKey,
            projectId,
            providerId,
            sessionRestorable: false,
          });

          const providerExecutionContext = toProviderExecutionContext({
            envVars: resolvedEnvironment.envVars,
            execOpts,
            instructions,
            skillRoots,
          });
          const adapterCommand: AdapterCommand = fork
            ? {
                type: "thread/fork",
                threadId,
                cwd: options.workspacePath,
                sourceProviderThreadId: fork.sourceProviderThreadId,
                ...(fork.sourceProviderCheckpointId !== undefined
                  ? {
                      sourceProviderCheckpointId:
                        fork.sourceProviderCheckpointId,
                    }
                  : {}),
                options: providerExecutionContext,
                dynamicTools,
                disallowedTools,
                instructionMode,
              }
            : {
                type: "thread/start",
                threadId,
                cwd: options.workspacePath,
                options: providerExecutionContext,
                dynamicTools,
                disallowedTools,
                instructionMode,
              };
          let resolved: string;
          try {
            const cmd = requireProviderRequestPlan({
              commandType: adapterCommand.type,
              plan: proc.adapter.buildCommandPlan(adapterCommand),
              providerId,
            });
            const result = await sendCommand({
              proc,
              message: cmd,
              resultSchema: threadIdentityResultSchema,
              timeoutMs: threadCreationRequestTimeoutMs,
              ...(fork
                ? {
                    recovery: {
                      providerId,
                      providerThreadId: fork.sourceProviderThreadId,
                      threadId,
                    },
                  }
                : {}),
            });
            updateSessionRestoreCapability(threadId, result.sessionRestorable);
            recordProviderThreadIdentity(
              proc,
              threadId,
              result.providerThreadId,
            );
            resolved = result.providerThreadId;
            emitResolvedProviderEnvironment({
              droppedContributions: resolvedEnvironment.droppedContributions,
              entries: resolvedEnvironment.entries,
              providerThreadId: resolved,
              threadId,
            });
          } catch (startError) {
            await abandonFailedSessionConstruction({ proc, threadId });
            throw startError;
          }

          if (input && input.length > 0) {
            if (clientRequestId === undefined) {
              throw new Error(
                `Thread start with input requires a client request id for ${threadId}`,
              );
            }
            await runtime.runTurn({
              threadId,
              input,
              ...(inputGroups !== undefined ? { inputGroups } : {}),
              clientRequestId,
              options: execOpts,
              contributedEnv,
              instructions,
            });
          }

          markHostedProviderSessionIdle(threadId);
          return { providerThreadId: resolved };
        },
      });
    },

    async prepareThreadRewind({
      environmentId,
      threadId,
      leaseId,
      projectId,
      providerId,
      contributedEnv = [],
      sourceProviderThreadId,
      retainThroughProviderCheckpoint,
      bridgeLaunch,
      options: execOpts,
      instructions,
      dynamicTools,
      disallowedTools,
      instructionMode = "append",
    }) {
      const existing = stagedThreadRewinds.get(leaseId);
      if (existing !== undefined) {
        return existing.state === "preparing"
          ? existing.promise
          : { providerThreadId: existing.providerThreadId };
      }

      const preparation = runThreadOperation({
        threadId,
        work: async () => {
          const processKey = resolveProviderProcessKey({
            bridgeLaunch,
            providerId,
          });
          await runtime.ensureProvider({ providerId, bridgeLaunch });
          const proc = providerProcesses.requireProviderProcess({
            processKey,
            providerId,
          });
          if (!proc.adapter.capabilities.supportsFork) {
            throw new Error(
              `Preparing a thread rewind is not supported by ${providerId}`,
            );
          }
          assertProviderSupportsExecutionOptions({
            adapter: proc.adapter,
            options: execOpts,
            providerId,
          });

          const stagingThreadId = `${threadId}:rewind:${leaseId}`;
          suppressedThreadEventIds.add(stagingThreadId);
          threadIdentityRegistry.registerThreadProvider({
            providerId,
            providerState: proc.identity,
            expectsIdentityNotification: true,
            threadId: stagingThreadId,
          });
          let retainedForDiscard = false;
          let providerThreadIdForCleanup: string | undefined;
          try {
            const resolvedEnvironment = resolveRuntimeThreadEnvironment({
              contributedEnv,
              environmentId,
              projectId,
              threadId,
            });
            const adapterCommand: AdapterCommand = {
              type: "thread/fork",
              threadId: stagingThreadId,
              cwd: options.workspacePath,
              sourceProviderThreadId,
              sourceProviderCheckpointId: retainThroughProviderCheckpoint,
              options: toProviderExecutionContext({
                envVars: resolvedEnvironment.envVars,
                execOpts,
                instructions,
                skillRoots,
              }),
              dynamicTools,
              disallowedTools,
              instructionMode,
            };
            const command = requireProviderRequestPlan({
              commandType: adapterCommand.type,
              plan: proc.adapter.buildCommandPlan(adapterCommand),
              providerId,
            });
            const result = await sendCommand({
              proc,
              message: command,
              resultSchema: threadIdentityResultSchema,
              timeoutMs: threadCreationRequestTimeoutMs,
              recovery: {
                bridgeLaunch,
                providerId,
                providerThreadId: sourceProviderThreadId,
                threadId: stagingThreadId,
              },
            });
            const providerThreadId = result.providerThreadId;
            providerThreadIdForCleanup = providerThreadId;
            recordProviderThreadIdentity(
              proc,
              stagingThreadId,
              providerThreadId,
            );
            const prepared: PreparedThreadRewind = {
              state: "prepared",
              cleanupPromise: null,
              cleanupTimer: null,
              processKey,
              providerId,
              providerState: proc.identity,
              providerThreadId,
              stagingThreadId,
              threadId,
            };
            stagedThreadRewinds.set(leaseId, prepared);
            schedulePreparedThreadRewindCleanup(
              leaseId,
              prepared,
              PREPARED_THREAD_REWIND_TTL_MS,
            );
            retainedForDiscard = true;
            return { providerThreadId };
          } finally {
            if (!retainedForDiscard) {
              if (providerThreadIdForCleanup !== undefined) {
                try {
                  await sendStagedThreadDiscard(
                    proc,
                    stagingThreadId,
                    providerThreadIdForCleanup,
                  );
                } catch (error) {
                  options.onStderr?.(
                    `Failed to discard unretained staged rewind ${leaseId}: ${error instanceof Error ? error.message : String(error)}`,
                  );
                }
              } else {
                await releaseThreadOnBridgeBestEffort({
                  proc,
                  threadId: stagingThreadId,
                });
              }
              suppressedThreadEventIds.delete(stagingThreadId);
              threadIdentityRegistry.forgetThread({
                providerState: proc.identity,
                threadId: stagingThreadId,
              });
            }
          }
        },
      });
      stagedThreadRewinds.set(leaseId, {
        state: "preparing",
        promise: preparation,
      });
      try {
        return await preparation;
      } catch (error) {
        const current = stagedThreadRewinds.get(leaseId);
        if (current?.state === "preparing" && current.promise === preparation) {
          stagedThreadRewinds.delete(leaseId);
        }
        throw error;
      }
    },

    async discardThreadRewind({ leaseId }) {
      await discardStagedThreadRewind(leaseId);
    },

    async resumeThread({
      environmentId,
      threadId,
      projectId,
      providerThreadId,
      providerId,
      bridgeLaunch,
      contributedEnv = [],
      options: execOpts,
      instructions,
      dynamicTools,
      disallowedTools,
      instructionMode = "append",
    }) {
      return runThreadOperation({
        threadId,
        work: async () => {
          const processKey = resolveProviderProcessKey({
            bridgeLaunch,
            providerId,
          });
          await runtime.ensureProvider({ providerId, bridgeLaunch });

          const proc = providerProcesses.requireProviderProcess({
            processKey,
            providerId,
          });
          assertProviderSupportsExecutionOptions({
            adapter: proc.adapter,
            options: execOpts,
            providerId,
          });
          const resolvedEnvironment = resolveRuntimeThreadEnvironment({
            contributedEnv,
            environmentId,
            projectId,
            threadId,
          });
          threadIdentityRegistry.registerThreadProvider({
            providerId,
            providerState: proc.identity,
            expectsIdentityNotification: providerThreadId === undefined,
            threadId,
          });
          setThreadRuntimeConfig(threadId, {
            bridgeLaunch,
            contributedEnv,
            dynamicTools,
            disallowedTools,
            environmentId,
            envVars: resolvedEnvironment.envVars,
            instructionMode,
            instructions,
            options: execOpts,
            processKey,
            projectId,
            providerId,
            sessionRestorable: false,
          });

          if (providerThreadId) {
            recordProviderThreadIdentity(proc, threadId, providerThreadId);
          }

          const adapterCommand: AdapterCommand = {
            type: "thread/resume",
            threadId,
            cwd: options.workspacePath,
            providerThreadId:
              providerThreadId ?? requireProviderThreadId(threadId),
            options: toProviderExecutionContext({
              envVars: resolvedEnvironment.envVars,
              execOpts,
              instructions,
              skillRoots,
            }),
            dynamicTools,
            disallowedTools,
            instructionMode,
          };
          const plan = proc.adapter.buildCommandPlan(adapterCommand);
          if (plan.kind === "noop") {
            emitResolvedProviderEnvironment({
              droppedContributions: resolvedEnvironment.droppedContributions,
              entries: resolvedEnvironment.entries,
              providerThreadId: adapterCommand.providerThreadId,
              threadId,
            });
            return { providerThreadId: adapterCommand.providerThreadId };
          }

          let resolved: string;
          try {
            const result = await sendCommand({
              proc,
              message: plan,
              resultSchema: threadIdentityResultSchema,
              recovery: {
                providerId,
                providerThreadId: adapterCommand.providerThreadId,
                threadId,
              },
            });
            recordProviderThreadIdentity(
              proc,
              threadId,
              result.providerThreadId,
            );
            updateSessionRestoreCapability(threadId, result.sessionRestorable);
            resolved = result.providerThreadId;
            emitResolvedProviderEnvironment({
              droppedContributions: resolvedEnvironment.droppedContributions,
              entries: resolvedEnvironment.entries,
              providerThreadId: resolved,
              threadId,
            });
          } catch (resumeError) {
            await abandonFailedSessionConstruction({ proc, threadId });
            throw resumeError;
          }
          markHostedProviderSessionIdle(threadId);
          return { providerThreadId: resolved };
        },
      });
    },

    async runTurn({
      threadId,
      input,
      inputGroups,
      clientRequestId,
      options: execOpts,
      contributedEnv,
      instructions,
    }) {
      return runThreadOperation({
        threadId,
        work: async () => {
          const pid = threadIdentityRegistry.resolveProviderForThread(threadId);
          requireProviderProcessForThread(threadId);
          assertThreadCanStartTurn(threadId);
          await restartThreadBridgeIfRecommended({
            threadId,
            options: execOpts,
            instructions,
          });
          const proc = requireProviderProcessForThread(threadId);
          assertProviderSupportsExecutionOptions({
            adapter: proc.adapter,
            options: execOpts,
            providerId: pid,
          });
          const currentConfig = threadRuntimeConfigs.get(threadId);
          if (!currentConfig) {
            throw new Error(`No runtime configuration for thread ${threadId}`);
          }
          const resolvedContributedEnv =
            contributedEnv ?? currentConfig.contributedEnv;
          const resolvedEnvironment = resolveRuntimeThreadEnvironment({
            contributedEnv: resolvedContributedEnv,
            environmentId: currentConfig.environmentId,
            projectId: currentConfig.projectId,
            threadId,
          });
          const environmentChanged = !environmentRecordsEqual(
            currentConfig.envVars,
            resolvedEnvironment.envVars,
          );
          recordThreadExecutionOptions({
            threadId,
            options: execOpts,
          });

          const providerThreadId = requireProviderThreadId(threadId);
          const adapterCommand: AdapterCommand = {
            type: "turn/start",
            threadId,
            providerThreadId,
            input,
            ...(inputGroups !== undefined ? { inputGroups } : {}),
            clientRequestId,
            options: toProviderExecutionContext({
              envVars: resolvedEnvironment.envVars,
              execOpts,
              instructions,
            }),
          };
          const cmd = requireProviderRequestPlan({
            commandType: adapterCommand.type,
            plan: proc.adapter.buildCommandPlan(adapterCommand),
            providerId: pid,
          });
          assertThreadCanStartTurn(threadId);
          pendingTurnStarts.set(threadId, {
            sinceMs: Date.now(),
            watchdogFired: false,
          });
          markProviderSessionNotIdle(threadId);
          try {
            await sendCommand({
              proc,
              message: cmd,
              resultSchema: ignoredJsonRpcResultSchema,
              recovery: {
                providerId: pid,
                providerThreadId: adapterCommand.providerThreadId,
                threadId,
              },
            });
            setThreadRuntimeConfig(threadId, {
              ...currentConfig,
              contributedEnv: resolvedContributedEnv,
              envVars: resolvedEnvironment.envVars,
              options: execOpts,
            });
            if (environmentChanged) {
              emitResolvedProviderEnvironment({
                droppedContributions: resolvedEnvironment.droppedContributions,
                entries: resolvedEnvironment.entries,
                providerThreadId,
                threadId,
              });
            }
          } catch (error) {
            pendingTurnStarts.delete(threadId);
            markHostedProviderSessionIdle(threadId);
            throw error;
          }
        },
      });
    },

    async steerTurn({
      threadId,
      expectedTurnId,
      input,
      inputGroups,
      clientRequestId,
      options: execOpts,
      contributedEnv,
      instructions,
    }) {
      return runThreadOperation({
        threadId,
        work: async () => {
          const pid = threadIdentityRegistry.resolveProviderForThread(threadId);
          const currentProc = requireProviderProcessForThread(threadId);
          assertProviderSupportsExecutionOptions({
            adapter: currentProc.adapter,
            options: execOpts,
            providerId: pid,
          });

          const activeTurnId = turnState.getActiveTurnId(threadId);
          if (activeTurnId !== expectedTurnId) {
            options.onStderr?.(
              `Ignoring stale steer for thread "${threadId}" on turn "${expectedTurnId}"; active turn is ${activeTurnId ?? "none"}.`,
            );
            return {
              status: "stale",
              activeTurnId,
            };
          }

          await restartThreadBridgeIfRecommended({
            threadId,
            options: execOpts,
            instructions,
          });
          const proc = requireProviderProcessForThread(threadId);
          const currentConfig = threadRuntimeConfigs.get(threadId);
          if (!currentConfig) {
            throw new Error(`No runtime configuration for thread ${threadId}`);
          }
          const resolvedContributedEnv =
            contributedEnv ?? currentConfig.contributedEnv;
          const resolvedEnvironment = resolveRuntimeThreadEnvironment({
            contributedEnv: resolvedContributedEnv,
            environmentId: currentConfig.environmentId,
            projectId: currentConfig.projectId,
            threadId,
          });
          const environmentChanged = !environmentRecordsEqual(
            currentConfig.envVars,
            resolvedEnvironment.envVars,
          );
          recordThreadExecutionOptions({
            threadId,
            options: execOpts,
          });

          const providerThreadId = requireProviderThreadId(threadId);
          const adapterCommand: AdapterCommand = {
            type: "turn/steer",
            threadId,
            providerThreadId,
            expectedTurnId,
            input,
            ...(inputGroups !== undefined ? { inputGroups } : {}),
            clientRequestId,
            options: toProviderExecutionContext({
              envVars: resolvedEnvironment.envVars,
              execOpts,
              instructions,
            }),
          };
          const cmd = requireProviderRequestPlan({
            commandType: adapterCommand.type,
            plan: proc.adapter.buildCommandPlan(adapterCommand),
            providerId: pid,
          });
          try {
            await sendCommand({
              proc,
              message: cmd,
              resultSchema: ignoredJsonRpcResultSchema,
              recovery: {
                providerId: pid,
                providerThreadId: adapterCommand.providerThreadId,
                threadId,
              },
            });
            setThreadRuntimeConfig(threadId, {
              ...currentConfig,
              contributedEnv: resolvedContributedEnv,
              envVars: resolvedEnvironment.envVars,
              options: execOpts,
            });
            if (environmentChanged) {
              emitResolvedProviderEnvironment({
                droppedContributions: resolvedEnvironment.droppedContributions,
                entries: resolvedEnvironment.entries,
                providerThreadId,
                threadId,
              });
            }
          } catch (error) {
            if (
              error instanceof JsonRpcResponseError &&
              error.recovery?.kind === "staleTurn"
            ) {
              options.onStderr?.(
                `Dropping stale steer for thread "${threadId}": ${error.recovery.message}`,
                threadId,
              );
              turnState.clearThread(threadId);
              return { status: "stale", activeTurnId: null };
            }
            if (
              error instanceof JsonRpcResponseError &&
              error.code === BRIDGE_JSON_RPC_ERRORS.NO_ACTIVE_TURN
            ) {
              turnState.clearThread(threadId);
              return { status: "stale", activeTurnId: null };
            }
            throw error;
          }
          return { status: "steered" };
        },
      });
    },

    async stopThread({ threadId }) {
      return runThreadOperation({
        threadId,
        work: async () => {
          const pid = threadIdentityRegistry.resolveProviderForThread(threadId);
          const proc = requireProviderProcessForThread(threadId);
          const providerThreadId = requireProviderThreadId(threadId);
          const activeTurnId = turnState.getActiveTurnId(threadId);
          const adapterCommand: AdapterCommand = {
            type: "thread/stop",
            threadId,
            providerThreadId,
            activeTurnId,
          };
          const cmd = proc.adapter.buildCommandPlan(adapterCommand);

          if (cmd.kind === "noop") {
            if (activeTurnId) {
              throw new Error(
                `Adapter "${pid}" returned no provider request for thread/stop with active turn: ${cmd.reason}`,
              );
            }
            forgetThreadRuntimeStateForProviderState(proc.identity, threadId);
            await releaseIdleProviderProcess(proc);
            return { providerCheckpointId: null };
          }

          const result = await sendCommand({
            proc,
            message: cmd,
            resultSchema: providerThreadStopResultSchema,
          });
          forgetThreadRuntimeStateForProviderState(proc.identity, threadId);
          await releaseIdleProviderProcess(proc);
          return {
            providerCheckpointId: result.providerCheckpointId ?? null,
          };
        },
      });
    },

    async clearThreadGoal({ threadId }) {
      return runThreadOperation({
        threadId,
        work: async () => {
          const pid = threadIdentityRegistry.resolveProviderForThread(threadId);
          const proc = requireProviderProcessForThread(threadId);
          const adapterCommand: AdapterCommand = {
            type: "thread/goal/clear",
            threadId,
            providerThreadId: requireProviderThreadId(threadId),
          };
          const cmd = requireProviderRequestPlan({
            commandType: adapterCommand.type,
            plan: proc.adapter.buildCommandPlan(adapterCommand),
            providerId: pid,
          });
          const clearRevision = threadGoalState.getClearRevision(threadId);
          const result = await sendCommand({
            proc,
            message: cmd,
            resultSchema: threadGoalClearResultSchema,
          });
          if (
            !result.cleared &&
            threadGoalState.getClearRevision(threadId) > clearRevision
          ) {
            return { cleared: true };
          }
          const confirmed = await threadGoalState.waitForGoalClear({
            afterRevision: clearRevision,
            threadId,
            timeoutMs: THREAD_GOAL_CLEAR_EVENT_TIMEOUT_MS,
          });
          return { cleared: confirmed };
        },
      });
    },

    async renameThread({ threadId, title }) {
      return runThreadOperation({
        threadId,
        work: async () => {
          const pid = threadIdentityRegistry.resolveProviderForThread(threadId);
          const proc = requireProviderProcessForThread(threadId);
          if (!proc.adapter.capabilities.supportsThreadRename) {
            throw new Error(
              `Provider "${pid}" does not support thread rename.`,
            );
          }

          const adapterCommand: AdapterCommand = {
            type: "thread/name/set",
            threadId,
            providerThreadId: requireProviderThreadId(threadId),
            title: toProviderExternalThreadName(title),
          };
          const cmd = requireProviderRequestPlan({
            commandType: adapterCommand.type,
            plan: proc.adapter.buildCommandPlan(adapterCommand),
            providerId: pid,
          });
          await sendCommand({
            proc,
            message: cmd,
            resultSchema: ignoredJsonRpcResultSchema,
            recovery: {
              providerId: pid,
              providerThreadId: adapterCommand.providerThreadId,
              threadId,
            },
          });
        },
      });
    },

    async archiveThread({
      threadId,
      providerId,
      providerThreadId,
      bridgeLaunch,
    }) {
      return runThreadOperation({
        threadId,
        work: async () => {
          await archiveOrUnarchiveThread({
            bridgeLaunch,
            commandType: "thread/archive",
            providerId,
            providerThreadId,
            threadId,
          });
        },
      });
    },

    async unarchiveThread({
      threadId,
      providerId,
      providerThreadId,
      bridgeLaunch,
    }) {
      return runThreadOperation({
        threadId,
        work: async () => {
          await archiveOrUnarchiveThread({
            bridgeLaunch,
            commandType: "thread/unarchive",
            providerId,
            providerThreadId,
            threadId,
          });
        },
      });
    },

    async listModels({ providerId, bridgeLaunch, cwd }) {
      await runtime.ensureProvider({ providerId, bridgeLaunch });
      const proc = providerProcesses.requireProviderProcess({
        processKey: resolveProviderProcessKey({ bridgeLaunch, providerId }),
        providerId,
      });
      const command = requireProviderRequestPlan({
        commandType: "model/list",
        plan: proc.adapter.buildCommandPlan({
          type: "model/list",
          ...(cwd !== undefined ? { cwd } : {}),
        }),
        providerId,
      });
      const result = await sendCommand({
        proc,
        message: command,
        resultSchema: ignoredJsonRpcResultSchema,
      });
      return proc.adapter.parseModelListResult(result);
    },

    async providerHealth({ providerId, bridgeLaunch, cwd }) {
      await runtime.ensureProvider({ providerId, bridgeLaunch });
      const proc = providerProcesses.requireProviderProcess({
        processKey: resolveProviderProcessKey({ bridgeLaunch, providerId }),
        providerId,
      });
      const plan = proc.adapter.buildCommandPlan({
        type: "provider/health",
        ...(cwd !== undefined ? { cwd } : {}),
      });
      if (plan.kind === "noop") {
        return { supported: false };
      }
      return await sendCommand({
        proc,
        message: plan,
        resultSchema: providerHealthResultSchema,
      });
    },

    async providerUsage({ providerId, bridgeLaunch, cwd }) {
      await runtime.ensureProvider({ providerId, bridgeLaunch });
      const proc = providerProcesses.requireProviderProcess({
        processKey: resolveProviderProcessKey({ bridgeLaunch, providerId }),
        providerId,
      });
      const plan = proc.adapter.buildCommandPlan({
        type: "provider/usage",
        ...(cwd !== undefined ? { cwd } : {}),
      });
      if (plan.kind === "noop") {
        return { supported: false };
      }
      return await sendCommand({
        proc,
        message: plan,
        resultSchema: providerUsageResultSchema,
      });
    },

    async providerInstallationStatus({
      providerId,
      bridgeLaunch,
      cwd,
      requirement,
    }) {
      await runtime.ensureProvider({ providerId, bridgeLaunch });
      const proc = providerProcesses.requireProviderProcess({
        processKey: resolveProviderProcessKey({ bridgeLaunch, providerId }),
        providerId,
      });
      const plan = requireProviderRequestPlan({
        commandType: "provider/installation/status",
        plan: proc.adapter.buildCommandPlan({
          type: "provider/installation/status",
          ...(cwd !== undefined ? { cwd } : {}),
          ...(requirement !== undefined ? { requirement } : {}),
        }),
        providerId,
      });
      return await sendCommand({
        proc,
        message: plan,
        resultSchema: providerInstallationStatusSchema,
      });
    },

    async providerInstallationRun({ providerId, bridgeLaunch, cwd, action }) {
      await runtime.ensureProvider({ providerId, bridgeLaunch });
      const proc = providerProcesses.requireProviderProcess({
        processKey: resolveProviderProcessKey({ bridgeLaunch, providerId }),
        providerId,
      });
      const plan = requireProviderRequestPlan({
        commandType: "provider/installation/run",
        plan: proc.adapter.buildCommandPlan({
          type: "provider/installation/run",
          action,
          ...(cwd !== undefined ? { cwd } : {}),
        }),
        providerId,
      });
      return await sendCommand({
        proc,
        message: plan,
        resultSchema: providerInstallationRunResultSchema,
      });
    },

    listRunningProviders() {
      return providerProcesses.listRunningProviders();
    },

    getActiveTurnId(threadId) {
      return turnState.getActiveTurnId(threadId);
    },

    waitForActiveTurn(threadId, args) {
      return turnState.waitForActiveTurn({
        threadId,
        timeoutMs: args.timeoutMs,
      });
    },

    getProviderSession(threadId) {
      return threadIdentityRegistry.getProviderSession(threadId);
    },

    async reapIdleProviderSessions({ idleForMs, nowMs, runThreadExclusive }) {
      const reapedSessions: ReapedIdleProviderSession[] = [];
      for (const threadId of [...threadRuntimeConfigs.keys()]) {
        const release = async (): Promise<ReapedIdleProviderSession | null> => {
          const candidate = findReapableIdleProviderSession({
            idleForMs,
            nowMs,
            threadId,
          });
          if (!candidate) {
            return null;
          }

          try {
            providerProcesses.requireProviderProcess({
              processKey: candidate.runtimeConfig.processKey,
              providerId: candidate.runtimeConfig.providerId,
            });
          } catch {
            return null;
          }
          if (backgroundWorkState.hasOpenThreadWork(candidate.threadId)) {
            return null;
          }

          try {
            await runtime.stopThread({ threadId: candidate.threadId });
          } catch (error) {
            options.onStderr?.(
              `Provider session release failed for ${candidate.threadId}: ${
                error instanceof Error ? error.message : String(error)
              }`,
            );
            return null;
          }
          return {
            idleForMs: Math.max(0, nowMs - candidate.idleSinceMs),
            providerId: candidate.runtimeConfig.providerId,
            providerThreadId: candidate.providerThreadId,
            threadId: candidate.threadId,
          };
        };
        const reaped = runThreadExclusive
          ? await runThreadExclusive(threadId, release)
          : await release();
        if (reaped) {
          reapedSessions.push(reaped);
        }
      }

      return { reapedSessions };
    },

    hasThread(threadId) {
      return threadIdentityRegistry.getProviderSession(threadId) !== null;
    },

    getLiveThreadIds() {
      return [
        ...new Set([
          ...turnState.getActiveThreadIds(),
          ...pendingTurnStarts.keys(),
        ]),
      ];
    },

    hasOpenBackgroundWork() {
      return backgroundWorkState.hasOpenWork();
    },

    async shutdown() {
      clearInterval(turnStartWatchdogTimer);
      await Promise.all(
        [...stagedThreadRewinds.keys()].map((leaseId) =>
          discardStagedThreadRewind(leaseId),
        ),
      );
      idleProviderSessionSinceMsByThreadId.clear();
      pendingTurnStarts.clear();
      threadOperationCounts.clear();
      threadGoalState.clear();
      turnState.clear();
      backgroundWorkState.clear();
      threadEventGrammar.clear();
      await providerProcesses.shutdown();
    },
  };

  return runtime;
}
