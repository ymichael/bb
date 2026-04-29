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

export function queueCommandAndWait<TType extends HostDaemonCommandType>(
  deps: SandboxWorkSessionDeps,
  args: QueueCommandAndWaitArgs<TType>,
): Promise<HostDaemonCommandResult<TType>>;
export async function queueCommandAndWait(
  deps: SandboxWorkSessionDeps,
  args: QueueCommandAndWaitArgs<HostDaemonCommandType>,
): Promise<HostDaemonCommandResult> {
  assertDaemonCommandWaitAllowed({
    commandId: null,
    commandType: args.command.type,
    operation: "queue-and-wait",
  });
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
