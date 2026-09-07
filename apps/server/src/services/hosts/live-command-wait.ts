import { performance } from "node:perf_hooks";
import {
  type HostDaemonCommand,
  type HostDaemonCommandResult,
  type HostDaemonSettledCommandType,
} from "@bb/host-daemon-contract";
import type { LoggedWorkSessionDeps } from "../../types.js";
import { ApiError } from "../../errors.js";
import { roundDurationMs } from "../lib/duration.js";
import { callHostOnlineRpc } from "./online-rpc.js";

interface RunLiveCommandAndWaitArgs<
  TType extends HostDaemonSettledCommandType,
> {
  command: Extract<HostDaemonCommand, { type: TType }>;
  hostId: string;
  timeoutMs: number;
}

type SlowCommandWaitOutcome =
  | "success"
  | "timeout"
  | "provider_error"
  | "result_type_mismatch"
  | "api_error"
  | "unknown_error";

interface LogSlowCommandWaitArgs {
  commandType: HostDaemonSettledCommandType;
  completed: boolean;
  durationMs: number;
  errorCode?: string;
  errorName?: string;
  hostId: string;
  outcome: SlowCommandWaitOutcome;
  status?: number;
}

interface SlowCommandWaitFailureLogFields {
  errorCode?: string;
  errorName?: string;
  outcome: Exclude<SlowCommandWaitOutcome, "success">;
  status?: number;
}

const SLOW_HOST_COMMAND_WAIT_LOG_THRESHOLD_MS = 1_000;

function logSlowCommandWait(
  deps: LoggedWorkSessionDeps,
  args: LogSlowCommandWaitArgs,
): void {
  if (args.durationMs < SLOW_HOST_COMMAND_WAIT_LOG_THRESHOLD_MS) {
    return;
  }
  deps.logger.debug(
    {
      commandType: args.commandType,
      completed: args.completed,
      durationMs: roundDurationMs(args.durationMs),
      ...(args.errorCode ? { errorCode: args.errorCode } : {}),
      ...(args.errorName ? { errorName: args.errorName } : {}),
      hostId: args.hostId,
      outcome: args.outcome,
      ...(args.status !== undefined ? { status: args.status } : {}),
    },
    "Slow live host command wait",
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

export function runLiveCommandAndWait<
  TType extends HostDaemonSettledCommandType,
>(
  deps: LoggedWorkSessionDeps,
  args: RunLiveCommandAndWaitArgs<TType>,
): Promise<HostDaemonCommandResult<TType>>;
export async function runLiveCommandAndWait(
  deps: LoggedWorkSessionDeps,
  args: RunLiveCommandAndWaitArgs<HostDaemonSettledCommandType>,
): Promise<HostDaemonCommandResult> {
  const startedAt = performance.now();
  let logOutcome: SlowCommandWaitOutcome = "success";
  let completed = true;
  let failureLogFields: SlowCommandWaitFailureLogFields | null = null;
  try {
    return await callHostOnlineRpc(deps, {
      command: args.command,
      hostId: args.hostId,
      timeoutMs: args.timeoutMs,
    });
  } catch (error) {
    completed = false;
    failureLogFields = classifySlowCommandWaitFailure(error);
    logOutcome = failureLogFields.outcome;
    throw error;
  } finally {
    logSlowCommandWait(deps, {
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
      ...(failureLogFields?.status !== undefined
        ? { status: failureLogFields.status }
        : {}),
    });
  }
}
