import { eq } from "drizzle-orm";
import {
  hostDaemonCommands,
  reportCommandResult,
} from "@bb/db";
import type { HostDaemonCommandResultReport } from "@bb/host-daemon-contract";
import type { AppDeps } from "../types.js";
import {
  advanceHostCursor,
  handleCommandResultSideEffects,
} from "./command-result-handlers.js";

export async function handleCommandResult(
  deps: Pick<AppDeps, "db" | "hub">,
  report: HostDaemonCommandResultReport,
): Promise<typeof hostDaemonCommands.$inferSelect | null> {
  const command = deps.db
    .select()
    .from(hostDaemonCommands)
    .where(eq(hostDaemonCommands.id, report.commandId))
    .get();

  if (!command) {
    return null;
  }

  if (command.state === "success" || command.state === "error") {
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
    resultPayload,
  });
  if (!updated) {
    return null;
  }

  await handleCommandResultSideEffects(deps, report, updated);

  advanceHostCursor(deps, command.hostId);
  const response = report.ok
    ? {
        commandId: command.id,
        ok: true,
        result: report.result,
        type: report.type,
      }
    : {
        commandId: command.id,
        ok: false,
        errorCode: report.errorCode,
        errorMessage: report.errorMessage,
        type: report.type,
      };
  deps.hub.recordCommandResult(command.id, response);
  return updated;
}
