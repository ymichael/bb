import { queueCommand } from "@bb/db";
import { performance } from "node:perf_hooks";
import {
  hostDaemonCommandResultSchemaByType,
  type HostDaemonCommand,
  type HostDaemonCommandResult,
  type HostDaemonCommandType,
} from "@bb/host-daemon-contract";
import type { CommandResultWaiterResponse } from "../../internal/command-result-response.js";
import type { AppDeps, LoggedSandboxWorkSessionDeps } from "../../types.js";
import { ApiError } from "../../errors.js";
import { roundDurationMs } from "../lib/duration.js";
import { ensureHostSessionReadyForWork } from "./host-lifecycle.js";
import { assertDaemonCommandWaitAllowed } from "./command-wait-context.js";

export interface QueueCommandAndWaitArgs<TType extends HostDaemonCommandType> {
  command: Extract<HostDaemonCommand, { type: TType }>;
  hostId: string;
  timeoutMs: number;
}

export interface WaitForQueuedCommandResultArgs<
  TType extends HostDaemonCommandType,
> {
  commandId: string;
  timeoutMs: number;
  type: TType;
}

type WorkspaceStatusCommand = Extract<
  HostDaemonCommand,
  { type: "workspace.status" }
>;
type WorkspaceStatusCommandWorkspaceContext =
  WorkspaceStatusCommand["workspaceContext"];

interface WorkspaceStatusCommandCacheScope {
  environmentId: string;
  hostId: string;
  workspaceContext: WorkspaceStatusCommandWorkspaceContext;
}

interface WorkspaceStatusCommandCacheScopeArgs {
  command: WorkspaceStatusCommand;
  hostId: string;
}

interface QueueWorkspaceStatusCommandAndWaitArgs {
  command: WorkspaceStatusCommand;
  hostId: string;
  timeoutMs: number;
}

interface WorkspaceStatusCommandCacheEntry {
  expiresAt: number;
  promise: Promise<HostDaemonCommandResult<"workspace.status">>;
  scope: WorkspaceStatusCommandCacheScope;
}

type SlowCommandWaitOutcome =
  | "success"
  | "timeout"
  | "provider_error"
  | "result_type_mismatch"
  | "api_error"
  | "unknown_error";

interface LogSlowCommandWaitArgs {
  commandId: string;
  commandType: HostDaemonCommandType;
  completed: boolean;
  durationMs: number;
  errorCode?: string;
  errorName?: string;
  hostId: string;
  outcome: SlowCommandWaitOutcome;
  sessionId: string;
  status?: number;
}

interface SlowCommandWaitFailureLogFields {
  errorCode?: string;
  errorName?: string;
  outcome: Exclude<SlowCommandWaitOutcome, "success">;
  status?: number;
}

const WORKSPACE_STATUS_COMMAND_CACHE_TTL_MS = 1_000;
const SLOW_HOST_COMMAND_WAIT_LOG_THRESHOLD_MS = 1_000;
/**
 * Coalesces bursty workspace.status reads during thread-detail initial load.
 * In-flight commands share one daemon round trip, and successful results stay
 * reusable for a short freshness window. Failures/timeouts are evicted so the
 * next caller can queue a real retry.
 */
const workspaceStatusCommandCache = new Map<
  string,
  WorkspaceStatusCommandCacheEntry
>();

function logSlowCommandWait(
  deps: LoggedSandboxWorkSessionDeps,
  args: LogSlowCommandWaitArgs,
): void {
  if (args.durationMs < SLOW_HOST_COMMAND_WAIT_LOG_THRESHOLD_MS) {
    return;
  }
  deps.logger.debug(
    {
      commandId: args.commandId,
      commandType: args.commandType,
      completed: args.completed,
      durationMs: roundDurationMs(args.durationMs),
      ...(args.errorCode ? { errorCode: args.errorCode } : {}),
      ...(args.errorName ? { errorName: args.errorName } : {}),
      hostId: args.hostId,
      outcome: args.outcome,
      sessionId: args.sessionId,
      ...(args.status !== undefined ? { status: args.status } : {}),
    },
    "Slow host command wait",
  );
}

function classifySlowCommandWaitFailure(
  error: unknown,
): SlowCommandWaitFailureLogFields {
  if (error instanceof ApiError) {
    const errorCode = error.body.code;
    if (errorCode === "command_timeout") {
      return {
        errorCode,
        outcome: "timeout",
        status: error.status,
      };
    }
    if (errorCode === "command_result_type_mismatch") {
      return {
        errorCode,
        outcome: "result_type_mismatch",
        status: error.status,
      };
    }
    if (error.status === 502) {
      return {
        errorCode,
        outcome: "provider_error",
        status: error.status,
      };
    }
    return {
      errorCode,
      outcome: "api_error",
      status: error.status,
    };
  }

  if (error instanceof Error) {
    return {
      errorName: error.name,
      outcome: "unknown_error",
    };
  }

  return {
    outcome: "unknown_error",
  };
}

function assertQueueCommandAndWaitAllowed(
  args: QueueCommandAndWaitArgs<HostDaemonCommandType>,
): void {
  assertDaemonCommandWaitAllowed({
    commandId: null,
    commandType: args.command.type,
    operation: "queue-and-wait",
  });
}

function buildWorkspaceStatusCommandCacheScope({
  command,
  hostId,
}: WorkspaceStatusCommandCacheScopeArgs): WorkspaceStatusCommandCacheScope {
  return {
    environmentId: command.environmentId,
    hostId,
    workspaceContext: command.workspaceContext,
  };
}

function buildWorkspaceStatusCommandCacheKey({
  command,
  hostId,
}: QueueWorkspaceStatusCommandAndWaitArgs): string {
  const scope = buildWorkspaceStatusCommandCacheScope({ command, hostId });
  return JSON.stringify([
    scope.hostId,
    scope.environmentId,
    scope.workspaceContext.workspacePath,
    scope.workspaceContext.workspaceProvisionType,
    command.mergeBaseBranch ?? "",
  ]);
}

function workspaceStatusCacheScopeMatches(
  first: WorkspaceStatusCommandCacheScope,
  second: WorkspaceStatusCommandCacheScope,
): boolean {
  return (
    first.hostId === second.hostId &&
    first.environmentId === second.environmentId &&
    first.workspaceContext.workspacePath ===
      second.workspaceContext.workspacePath &&
    first.workspaceContext.workspaceProvisionType ===
      second.workspaceContext.workspaceProvisionType
  );
}

function invalidateWorkspaceStatusCommandCache(
  scope: WorkspaceStatusCommandCacheScope,
): void {
  for (const [key, entry] of workspaceStatusCommandCache) {
    if (workspaceStatusCacheScopeMatches(entry.scope, scope)) {
      workspaceStatusCommandCache.delete(key);
    }
  }
}

function invalidateWorkspaceStatusCacheForMutation(
  args: QueueCommandAndWaitArgs<HostDaemonCommandType>,
): void {
  switch (args.command.type) {
    case "workspace.commit":
    case "workspace.squash_merge":
      invalidateWorkspaceStatusCommandCache({
        environmentId: args.command.environmentId,
        hostId: args.hostId,
        workspaceContext: args.command.workspaceContext,
      });
      return;
    default:
      return;
  }
}

function scheduleWorkspaceStatusCacheCleanup(
  key: string,
  entry: WorkspaceStatusCommandCacheEntry,
): void {
  void entry.promise.then(
    () => {
      setTimeout(() => {
        const currentEntry = workspaceStatusCommandCache.get(key);
        if (currentEntry === entry && currentEntry.expiresAt <= Date.now()) {
          workspaceStatusCommandCache.delete(key);
        }
      }, WORKSPACE_STATUS_COMMAND_CACHE_TTL_MS);
    },
    () => undefined,
  );
}

function queueWorkspaceStatusCommandAndWait(
  deps: LoggedSandboxWorkSessionDeps,
  args: QueueWorkspaceStatusCommandAndWaitArgs,
): Promise<HostDaemonCommandResult<"workspace.status">> {
  const now = Date.now();
  const key = buildWorkspaceStatusCommandCacheKey(args);
  const cached = workspaceStatusCommandCache.get(key);
  if (cached && cached.expiresAt > now) {
    return cached.promise;
  }

  const entry: WorkspaceStatusCommandCacheEntry = {
    expiresAt: Number.POSITIVE_INFINITY,
    promise: queueCommandAndWaitUncached(deps, args)
      .then((result) => {
        entry.expiresAt = Date.now() + WORKSPACE_STATUS_COMMAND_CACHE_TTL_MS;
        return result;
      })
      .catch((error) => {
        // Do not cache daemon failures or waiter timeouts; callers need the
        // next identical status read to enqueue a fresh command.
        if (workspaceStatusCommandCache.get(key) === entry) {
          workspaceStatusCommandCache.delete(key);
        }
        throw error;
      }),
    scope: buildWorkspaceStatusCommandCacheScope(args),
  };
  workspaceStatusCommandCache.set(key, entry);
  scheduleWorkspaceStatusCacheCleanup(key, entry);
  return entry.promise;
}

export function queueCommandAndWait<TType extends HostDaemonCommandType>(
  deps: LoggedSandboxWorkSessionDeps,
  args: QueueCommandAndWaitArgs<TType>,
): Promise<HostDaemonCommandResult<TType>>;
export async function queueCommandAndWait(
  deps: LoggedSandboxWorkSessionDeps,
  args: QueueCommandAndWaitArgs<HostDaemonCommandType>,
): Promise<HostDaemonCommandResult> {
  assertQueueCommandAndWaitAllowed(args);
  if (args.command.type === "workspace.status") {
    return queueWorkspaceStatusCommandAndWait(deps, {
      command: args.command,
      hostId: args.hostId,
      timeoutMs: args.timeoutMs,
    });
  }
  const result = await queueCommandAndWaitUncached(deps, args);
  invalidateWorkspaceStatusCacheForMutation(args);
  return result;
}

function queueCommandAndWaitUncached<TType extends HostDaemonCommandType>(
  deps: LoggedSandboxWorkSessionDeps,
  args: QueueCommandAndWaitArgs<TType>,
): Promise<HostDaemonCommandResult<TType>>;
async function queueCommandAndWaitUncached(
  deps: LoggedSandboxWorkSessionDeps,
  args: QueueCommandAndWaitArgs<HostDaemonCommandType>,
): Promise<HostDaemonCommandResult> {
  const session = await ensureHostSessionReadyForWork(deps, {
    hostId: args.hostId,
  });
  const queuedCommand = queueCommand(deps.db, deps.hub, {
    hostId: args.hostId,
    sessionId: session.id,
    type: args.command.type,
    payload: JSON.stringify(args.command),
  });

  const startedAt = performance.now();
  let logOutcome: SlowCommandWaitOutcome = "success";
  let completed = true;
  let failureLogFields: SlowCommandWaitFailureLogFields | null = null;
  try {
    return await waitForQueuedCommandResult(deps, {
      commandId: queuedCommand.id,
      timeoutMs: args.timeoutMs,
      type: args.command.type,
    });
  } catch (error) {
    completed = false;
    failureLogFields = classifySlowCommandWaitFailure(error);
    logOutcome = failureLogFields.outcome;
    throw error;
  } finally {
    logSlowCommandWait(deps, {
      commandId: queuedCommand.id,
      commandType: args.command.type,
      completed,
      durationMs: performance.now() - startedAt,
      ...(failureLogFields?.errorCode
        ? { errorCode: failureLogFields.errorCode }
        : {}),
      ...(failureLogFields?.errorName
        ? { errorName: failureLogFields.errorName }
        : {}),
      hostId: args.hostId,
      outcome: logOutcome,
      sessionId: session.id,
      ...(failureLogFields?.status !== undefined
        ? { status: failureLogFields.status }
        : {}),
    });
  }
}

export function waitForQueuedCommandResult<TType extends HostDaemonCommandType>(
  deps: Pick<AppDeps, "hub">,
  args: WaitForQueuedCommandResultArgs<TType>,
): Promise<HostDaemonCommandResult<TType>>;
export async function waitForQueuedCommandResult(
  deps: Pick<AppDeps, "hub">,
  args: WaitForQueuedCommandResultArgs<HostDaemonCommandType>,
): Promise<HostDaemonCommandResult> {
  assertDaemonCommandWaitAllowed({
    commandId: args.commandId,
    commandType: args.type,
    operation: "wait",
  });
  let completed: CommandResultWaiterResponse;
  try {
    completed = await deps.hub.waitForCommandResult(
      args.commandId,
      args.timeoutMs,
    );
  } catch {
    throw new ApiError(
      504,
      "command_timeout",
      "Timed out waiting for command result",
    );
  }

  if (!completed.ok) {
    throw new ApiError(
      502,
      completed.errorCode ?? "provider_rpc_error",
      completed.errorMessage ?? "Command failed",
      false,
    );
  }

  if (completed.type !== args.type) {
    throw new ApiError(
      500,
      "command_result_type_mismatch",
      `Command ${args.commandId} completed with unexpected type ${completed.type}`,
    );
  }

  return hostDaemonCommandResultSchemaByType[args.type].parse(completed.result);
}
