import {
  getCommand,
  reportCommandResult,
  type HostDaemonCommandRow,
} from "@bb/db";
import type { HostDaemonCommandResultReport } from "@bb/host-daemon-contract";
import {
  handleCommandResultSideEffects,
  type CommandResultSideEffectsDeps,
} from "./command-result-handlers.js";
import {
  buildCommandResultSideEffectFailureResponse,
  commandResultSideEffectFailureReason,
  errorDetail,
  failCommandResultSideEffects,
  failSettledCommandActiveSideEffects,
  settledCommandSideEffectFailureReason,
} from "./command-result-side-effect-failures.js";

type SuccessfulCommandResultReport = Extract<
  HostDaemonCommandResultReport,
  { ok: true }
>;
type FailedCommandResultReport = Extract<
  HostDaemonCommandResultReport,
  { ok: false }
>;

export type CommandResultWaiterResponse =
  | {
      commandId: string;
      ok: true;
      result: SuccessfulCommandResultReport["result"];
      type: SuccessfulCommandResultReport["type"];
    }
  | {
      commandId: string;
      errorCode: FailedCommandResultReport["errorCode"];
      errorMessage: string;
      ok: false;
      type: FailedCommandResultReport["type"];
    };

function buildCommandResultResponse(
  commandId: string,
  report: HostDaemonCommandResultReport,
): CommandResultWaiterResponse {
  if (report.ok) {
    return {
      commandId,
      ok: true,
      result: report.result,
      type: report.type,
    };
  }

  return {
    commandId,
    ok: false,
    errorCode: report.errorCode,
    errorMessage: report.errorMessage,
    type: report.type,
  };
}

function settledCommandMatchesReport(
  command: HostDaemonCommandRow,
  report: HostDaemonCommandResultReport,
): boolean {
  if (command.type !== report.type) {
    return false;
  }
  return report.ok ? command.state === "success" : command.state === "error";
}

export async function handleCommandResult(
  deps: CommandResultSideEffectsDeps,
  report: HostDaemonCommandResultReport,
): Promise<HostDaemonCommandRow | null> {
  const command = getCommand(deps.db, report.commandId);

  if (!command) {
    return null;
  }

  if (command.state === "success" || command.state === "error") {
    const failedActiveSideEffects = settledCommandMatchesReport(command, report)
      ? await failSettledCommandActiveSideEffects(deps, command)
      : false;
    deps.hub.recordCommandResult(
      command.id,
      failedActiveSideEffects
        ? buildCommandResultSideEffectFailureResponse({
            commandId: command.id,
            commandType: report.type,
            failureReason: settledCommandSideEffectFailureReason(),
          })
        : buildCommandResultResponse(command.id, report),
    );
    return command;
  }

  const resultPayload = report.ok
    ? JSON.stringify(report.result)
    : JSON.stringify({
        errorCode: report.errorCode,
        errorMessage: report.errorMessage,
      });

  const updated = reportCommandResult(deps.db, deps.hub, {
    commandId: command.id,
    state: report.ok ? "success" : "error",
    completedAt: report.completedAt,
    resultPayload,
  });
  if (!updated) {
    return null;
  }

  try {
    await handleCommandResultSideEffects(deps, report, updated);
  } catch (error) {
    const failureReason = commandResultSideEffectFailureReason(
      errorDetail(error),
    );
    deps.logger.error(
      {
        commandId: command.id,
        err: error,
        reportOk: report.ok,
        reportType: report.type,
      },
      "Command result side effects failed",
    );
    await failCommandResultSideEffects(deps, {
      commandRow: updated,
      failureReason,
    });
    deps.hub.recordCommandResult(
      command.id,
      buildCommandResultSideEffectFailureResponse({
        commandId: command.id,
        commandType: report.type,
        failureReason,
      }),
    );
    return updated;
  }

  deps.hub.recordCommandResult(
    command.id,
    buildCommandResultResponse(command.id, report),
  );
  return updated;
}
