import { randomUUID } from "node:crypto";
import {
  type HostDaemonCommand,
  type HostDaemonCommandResult,
  type HostDaemonSettledCommandType,
} from "@bb/host-daemon-contract";
import { ApiError } from "../../errors.js";
import {
  buildCommandResultSettlementDeps,
  type CommandResultPostCommitAction,
  type CommandResultSettlementDeps,
  type CommandResultSideEffectsDeps,
  type CommandResultSideEffectsResult,
  type HostDaemonCommandExecutionRecord,
  type HostDaemonCommandForType,
  type LiveHostCommandFailureResultReportForType,
  type LiveHostCommandSuccessResultReportForType,
} from "../../internal/command-result-side-effects.js";
import { handleLiveCommandResultSideEffects } from "../../internal/command-results.js";
import { NotificationBuffer } from "../lib/notification-buffer.js";
import { callHostOnlineRpc } from "./online-rpc.js";

export const LIVE_DAEMON_COMMAND_TIMEOUT_MS = 24 * 60 * 60 * 1000;

interface RunLiveHostCommandArgs<TType extends HostDaemonSettledCommandType> {
  command: Extract<HostDaemonCommand, { type: TType }>;
  execution?: HostDaemonCommandExecutionRecord;
  hostId: string;
  timeoutMs: number;
}

interface LiveHostCommandErrorHandlerArgs<
  TType extends HostDaemonSettledCommandType,
> {
  command: Extract<HostDaemonCommand, { type: TType }>;
  error: Error;
  execution: HostDaemonCommandExecutionRecord;
  hostId: string;
}

type LiveHostCommandErrorHandler<TType extends HostDaemonSettledCommandType> = (
  args: LiveHostCommandErrorHandlerArgs<TType>,
) => void;

interface StartLiveHostCommandArgs<
  TType extends HostDaemonSettledCommandType,
> extends RunLiveHostCommandArgs<TType> {
  onError?: LiveHostCommandErrorHandler<TType>;
  onExpectedError?: LiveHostCommandErrorHandler<TType>;
  onSettled?: () => void | Promise<void>;
}

type LiveHostCommandResultReportForType<
  TType extends HostDaemonSettledCommandType,
> =
  | LiveHostCommandSuccessResultReportForType<TType>
  | LiveHostCommandFailureResultReportForType<TType>;

interface ApplyLiveHostCommandReportArgs<
  TType extends HostDaemonSettledCommandType,
> {
  command: HostDaemonCommandForType<TType>;
  execution: HostDaemonCommandExecutionRecord;
  report: LiveHostCommandResultReportForType<TType>;
}

interface BuildLiveHostCommandSuccessReportArgs<
  TType extends HostDaemonSettledCommandType,
> {
  command: HostDaemonCommandForType<TType>;
  completedAt: number;
  execution: HostDaemonCommandExecutionRecord;
  result: HostDaemonCommandResult<TType>;
}

interface BuildLiveHostCommandFailureReportArgs<
  TType extends HostDaemonSettledCommandType,
> {
  command: HostDaemonCommandForType<TType>;
  completedAt: number;
  error: Error;
  execution: HostDaemonCommandExecutionRecord;
}

interface ExpectedLiveHostCommandErrorLogFields {
  errorCode: string;
  errorMessage: string;
  errorStatus: number;
}

interface LiveHostCommandBaseLogFields {
  commandType: HostDaemonSettledCommandType;
  environmentId?: string;
  executionId: string;
  hostId: string;
  threadId?: string;
}

const EXPECTED_LIVE_HOST_COMMAND_ERROR_CODES = new Set(["provision_cancelled"]);

function commandFailureCode(error: Error): string {
  if (error instanceof ApiError) {
    return error.body.code;
  }
  return "live_command_failed";
}

function liveHostCommandBaseLogFields<
  TType extends HostDaemonSettledCommandType,
>(args: LiveHostCommandErrorHandlerArgs<TType>): LiveHostCommandBaseLogFields {
  return {
    commandType: args.command.type,
    ...("environmentId" in args.command
      ? { environmentId: args.command.environmentId }
      : {}),
    executionId: args.execution.id,
    hostId: args.hostId,
    ...("threadId" in args.command ? { threadId: args.command.threadId } : {}),
  };
}

export function expectedLiveHostCommandErrorLogFields(
  error: Error,
): ExpectedLiveHostCommandErrorLogFields | null {
  if (
    !(error instanceof ApiError) ||
    !EXPECTED_LIVE_HOST_COMMAND_ERROR_CODES.has(error.body.code)
  ) {
    return null;
  }
  return {
    errorCode: error.body.code,
    errorMessage: error.body.message,
    errorStatus: error.status,
  };
}

export function buildLiveHostCommandFailureReport<
  TType extends HostDaemonSettledCommandType,
>(
  args: BuildLiveHostCommandFailureReportArgs<TType>,
): LiveHostCommandFailureResultReportForType<TType> {
  return {
    executionId: args.execution.id,
    type: args.command.type,
    completedAt: args.completedAt,
    ok: false,
    errorCode: commandFailureCode(args.error),
    errorMessage: args.error.message,
  };
}

export function buildLiveHostCommandSuccessReport<
  TType extends HostDaemonSettledCommandType,
>(
  args: BuildLiveHostCommandSuccessReportArgs<TType>,
): LiveHostCommandSuccessResultReportForType<TType> {
  return {
    executionId: args.execution.id,
    type: args.command.type,
    completedAt: args.completedAt,
    ok: true,
    result: args.result,
  };
}

async function runPostCommitActions(
  deps: CommandResultSideEffectsDeps,
  actions: readonly CommandResultPostCommitAction[],
): Promise<void> {
  for (const action of actions) {
    await action.run(deps);
  }
}

export async function runLiveHostCommandSettlement(
  deps: CommandResultSideEffectsDeps,
  settle: (
    settlementDeps: CommandResultSettlementDeps,
  ) => CommandResultSideEffectsResult,
): Promise<void> {
  const notificationBuffer = new NotificationBuffer();
  const sideEffects = deps.db.transaction(
    (tx) =>
      settle(
        buildCommandResultSettlementDeps({
          db: tx,
          deps,
          hub: notificationBuffer,
        }),
      ),
    { behavior: "immediate" },
  );
  notificationBuffer.flushInto(deps.hub);
  await runPostCommitActions(deps, sideEffects.postCommitActions);
}

async function applyLiveHostCommandReport<
  TType extends HostDaemonSettledCommandType,
>(
  deps: CommandResultSideEffectsDeps,
  args: ApplyLiveHostCommandReportArgs<TType>,
): Promise<void> {
  await runLiveHostCommandSettlement(deps, (settlementDeps) =>
    handleLiveCommandResultSideEffects(settlementDeps, args),
  );
}

export function createLiveHostCommandExecution(
  hostId: string,
): HostDaemonCommandExecutionRecord {
  return {
    createdAt: Date.now(),
    hostId,
    id: `rpc_${randomUUID()}`,
  };
}

export async function runLiveHostCommand<
  TType extends HostDaemonSettledCommandType,
>(
  deps: CommandResultSideEffectsDeps,
  args: RunLiveHostCommandArgs<TType>,
): Promise<HostDaemonCommandResult<TType>> {
  const execution =
    args.execution ?? createLiveHostCommandExecution(args.hostId);
  try {
    const result = await callHostOnlineRpc(deps, {
      command: args.command,
      hostId: args.hostId,
      timeoutMs: args.timeoutMs,
    });
    await applyLiveHostCommandReport(deps, {
      command: args.command,
      execution,
      report: buildLiveHostCommandSuccessReport({
        command: args.command,
        completedAt: Date.now(),
        execution,
        result,
      }),
    });
    return result;
  } catch (error) {
    const normalized =
      error instanceof Error ? error : new Error(String(error));
    const failureReport = buildLiveHostCommandFailureReport({
      command: args.command,
      completedAt: Date.now(),
      error: normalized,
      execution,
    });
    try {
      await applyLiveHostCommandReport(deps, {
        command: args.command,
        execution,
        report: failureReport,
      });
    } catch (settlementError) {
      deps.logger.error(
        {
          err: settlementError,
          commandType: args.command.type,
          originalError: normalized,
        },
        "Live command failure settlement failed",
      );
    }
    throw normalized;
  }
}

export function startLiveHostCommand<
  TType extends HostDaemonSettledCommandType,
>(
  deps: CommandResultSideEffectsDeps,
  args: StartLiveHostCommandArgs<TType>,
): void {
  const execution =
    args.execution ?? createLiveHostCommandExecution(args.hostId);
  void runLiveHostCommand(deps, { ...args, execution })
    .catch((error) => {
      const normalized =
        error instanceof Error ? error : new Error(String(error));
      const handlerArgs: LiveHostCommandErrorHandlerArgs<TType> = {
        command: args.command,
        error: normalized,
        execution,
        hostId: args.hostId,
      };
      const expectedErrorFields =
        expectedLiveHostCommandErrorLogFields(normalized);
      if (expectedErrorFields !== null) {
        deps.logger.debug(
          {
            ...liveHostCommandBaseLogFields(handlerArgs),
            ...expectedErrorFields,
          },
          "Expected live host command failure",
        );
        args.onExpectedError?.(handlerArgs);
        return;
      }
      args.onError?.(handlerArgs);
    })
    .finally(async () => {
      try {
        await args.onSettled?.();
      } catch (error) {
        deps.logger.error(
          { err: error, commandType: args.command.type },
          "Live command settled callback failed",
        );
      }
    });
}
