import { queueCommand } from "@bb/db";
import type {
  HostDaemonCommand,
  HostDaemonCommandType,
} from "@bb/host-daemon-contract";
import type { AppDeps } from "../types.js";
import { ApiError } from "../errors.js";
import { requireConnectedHostSession } from "./entity-lookup.js";

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
  deps: Pick<AppDeps, "db" | "hub">,
  args: QueueCommandAndWaitArgs<TType>,
): Promise<unknown> {
  const session = requireConnectedHostSession(deps, args.hostId);

  const queuedCommand = queueCommand(deps.db, deps.hub, {
    hostId: args.hostId,
    sessionId: session.id,
    type: args.command.type,
    payload: JSON.stringify(args.command),
  });

  let completed: unknown;
  try {
    completed = await deps.hub.waitForCommandResult(
      queuedCommand.id,
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
