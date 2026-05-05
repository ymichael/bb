import {
  getCommand,
  reportCommandResult,
  type HostDaemonCommandRow,
} from "@bb/db";
import type { HostDaemonCommandResultReport } from "@bb/host-daemon-contract";
import {
  handleCommandResultSideEffects,
  failCommandResultSideEffects,
  type CommandResultSideEffectsDeps,
  failSettledCommandActiveSideEffects,
} from "./command-result-owners.js";
import type { CommandResultWaiterResponse } from "./command-result-response.js";
import {
  buildCommandResultSideEffectFailureResponse,
  commandResultSideEffectFailureReason,
  errorDetail,
  settledCommandSideEffectFailureReason,
} from "./command-result-side-effect-failure-common.js";
import { replaySettledCommandActiveSideEffects } from "./command-result-side-effect-sweep.js";
import { buildStoredCommandResultResponse } from "./stored-command-result-report.js";

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
    const reportMatchesCommand = settledCommandMatchesReport(command, report);
    const replayedActiveSideEffects = reportMatchesCommand
      ? await replaySettledCommandActiveSideEffects(deps, command)
      : false;
    const failedActiveSideEffects =
      reportMatchesCommand && !replayedActiveSideEffects
        ? await failSettledCommandActiveSideEffects(deps, command)
        : false;
    const settledResponse = failedActiveSideEffects
      ? buildCommandResultSideEffectFailureResponse({
          commandId: command.id,
          commandType: report.type,
          failureReason: settledCommandSideEffectFailureReason(),
        })
      : buildStoredCommandResultResponse(command);
    if (settledResponse) {
      deps.hub.recordCommandResult(command.id, settledResponse);
    }
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
