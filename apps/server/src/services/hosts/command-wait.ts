import { queueCommand } from "@bb/db";
import type {
  HostDaemonCommand,
  HostDaemonCommandType,
} from "@bb/host-daemon-contract";
import type { AppDeps, SandboxWorkSessionDeps } from "../../types.js";
import { ApiError } from "../../errors.js";
import { ensureHostSessionReadyForWork } from "./host-lifecycle.js";

export interface CompletedCommandResult {
  commandId: string;
  errorCode?: string;
  errorMessage?: string;
  ok: boolean;
  result?: unknown;
  type: string;
}

export interface QueueCommandAndWaitArgs<TType extends HostDaemonCommandType> {
  command: Extract<HostDaemonCommand, { type: TType }>;
  hostId: string;
  timeoutMs: number;
}

export interface WaitForQueuedCommandResultArgs {
  commandId: string;
  timeoutMs: number;
}

function isCompletedCommandResult(value: unknown): value is CompletedCommandResult {
  if (value == null || typeof value !== "object") {
    return false;
  }
  if (!("commandId" in value) || !("ok" in value) || !("type" in value)) {
    return false;
  }
  return true;
}

export async function queueCommandAndWait<TType extends HostDaemonCommandType>(
  deps: SandboxWorkSessionDeps,
  args: QueueCommandAndWaitArgs<TType>,
): Promise<unknown> {
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
  });
}

export async function waitForQueuedCommandResult(
  deps: Pick<AppDeps, "hub">,
  args: WaitForQueuedCommandResultArgs,
): Promise<unknown> {
  let completed: unknown;
  try {
    completed = await deps.hub.waitForCommandResult(
      args.commandId,
      args.timeoutMs,
    );
  } catch {
    throw new ApiError(504, "command_timeout", "Timed out waiting for command result");
  }

  if (!isCompletedCommandResult(completed)) {
    throw new ApiError(500, "internal_error", "Invalid command result payload");
  }

  if (!completed.ok) {
    throw new ApiError(
      502,
      completed.errorCode ?? "provider_rpc_error",
      completed.errorMessage ?? "Command failed",
      false,
    );
  }

  return completed.result;
}
