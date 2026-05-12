import { queueCommand } from "@bb/db";
import {
  hostDaemonCommandResultSchemaByType,
  type HostDaemonCommand,
  type HostDaemonCommandResult,
  type HostDaemonCommandType,
} from "@bb/host-daemon-contract";
import type { CommandResultWaiterResponse } from "../../internal/command-result-response.js";
import type { AppDeps, SandboxWorkSessionDeps } from "../../types.js";
import { ApiError } from "../../errors.js";
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

interface QueueWorkspaceStatusCommandAndWaitArgs {
  command: WorkspaceStatusCommand;
  hostId: string;
  timeoutMs: number;
}

interface WorkspaceStatusCommandCacheEntry {
  expiresAt: number;
  promise: Promise<HostDaemonCommandResult<"workspace.status">>;
}

const WORKSPACE_STATUS_COMMAND_CACHE_TTL_MS = 1_000;
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

function assertQueueCommandAndWaitAllowed(
  args: QueueCommandAndWaitArgs<HostDaemonCommandType>,
): void {
  assertDaemonCommandWaitAllowed({
    commandId: null,
    commandType: args.command.type,
    operation: "queue-and-wait",
  });
}

function buildWorkspaceStatusCommandCacheKey({
  command,
  hostId,
}: QueueWorkspaceStatusCommandAndWaitArgs): string {
  return JSON.stringify([
    hostId,
    command.environmentId,
    command.workspaceContext.workspacePath,
    command.workspaceContext.workspaceProvisionType,
    command.mergeBaseBranch ?? "",
  ]);
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
  deps: SandboxWorkSessionDeps,
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
  };
  workspaceStatusCommandCache.set(key, entry);
  scheduleWorkspaceStatusCacheCleanup(key, entry);
  return entry.promise;
}

export function queueCommandAndWait<TType extends HostDaemonCommandType>(
  deps: SandboxWorkSessionDeps,
  args: QueueCommandAndWaitArgs<TType>,
): Promise<HostDaemonCommandResult<TType>>;
export async function queueCommandAndWait(
  deps: SandboxWorkSessionDeps,
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
  return queueCommandAndWaitUncached(deps, args);
}

function queueCommandAndWaitUncached<TType extends HostDaemonCommandType>(
  deps: SandboxWorkSessionDeps,
  args: QueueCommandAndWaitArgs<TType>,
): Promise<HostDaemonCommandResult<TType>>;
async function queueCommandAndWaitUncached(
  deps: SandboxWorkSessionDeps,
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

  return waitForQueuedCommandResult(deps, {
    commandId: queuedCommand.id,
    timeoutMs: args.timeoutMs,
    type: args.command.type,
  });
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
      "internal_error",
      `Command ${args.commandId} completed with unexpected type ${completed.type}`,
    );
  }

  return hostDaemonCommandResultSchemaByType[args.type].parse(completed.result);
}
