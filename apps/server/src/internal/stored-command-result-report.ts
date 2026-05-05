import { z } from "zod";
import type { HostDaemonCommandRow } from "@bb/db";
import { hostDaemonCommandTypeSchema } from "@bb/host-daemon-contract";
import type { CommandResultWaiterResponse } from "./command-result-response.js";
import type { CommandResultSideEffectReport } from "./command-result-owners.js";

const storedCommandErrorPayloadSchema = z.object({
  errorCode: z.string().min(1),
  errorMessage: z.string().min(1),
});

export function buildStoredCommandResultReport(
  commandRow: HostDaemonCommandRow,
): CommandResultSideEffectReport | null {
  if (!commandRow.completedAt || !commandRow.resultPayload) {
    return null;
  }
  const commandType = hostDaemonCommandTypeSchema.parse(commandRow.type);

  if (commandRow.state === "success") {
    return {
      commandId: commandRow.id,
      completedAt: commandRow.completedAt,
      type: commandType,
      ok: true,
      result: JSON.parse(commandRow.resultPayload),
    };
  }

  if (commandRow.state === "error") {
    const payload = storedCommandErrorPayloadSchema.parse(
      JSON.parse(commandRow.resultPayload),
    );
    return {
      commandId: commandRow.id,
      completedAt: commandRow.completedAt,
      type: commandType,
      ok: false,
      errorCode: payload.errorCode,
      errorMessage: payload.errorMessage,
    };
  }

  return null;
}

export function buildStoredCommandResultResponse(
  commandRow: HostDaemonCommandRow,
): CommandResultWaiterResponse | null {
  const report = buildStoredCommandResultReport(commandRow);
  if (!report) {
    return null;
  }

  if (report.ok) {
    return {
      commandId: report.commandId,
      ok: true,
      result: report.result,
      type: report.type,
    };
  }

  return {
    commandId: report.commandId,
    errorCode: report.errorCode,
    errorMessage: report.errorMessage,
    ok: false,
    type: report.type,
  };
}
