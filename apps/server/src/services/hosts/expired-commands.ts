import { getCommand } from "@bb/db";
import {
  hostDaemonCommandSchema,
  type HostDaemonCommandResultReport,
} from "@bb/host-daemon-contract";
import type { AppDeps } from "../../types.js";
import { handleCommandResultSideEffects } from "../../internal/command-result-handlers.js";
import { parseJsonWithSchema } from "../lib/json-parsing.js";

const EXPIRED_COMMAND_ERROR_CODE = "command_expired";
const EXPIRED_COMMAND_ERROR_MESSAGE = "Command expired after retry";

type LifecycleFailureReport =
  | Extract<
    HostDaemonCommandResultReport,
    { type: "host.sync_runtime_material" }
  >
  | Extract<HostDaemonCommandResultReport, { type: "environment.destroy" }>
  | Extract<HostDaemonCommandResultReport, { type: "environment.provision" }>
  | Extract<HostDaemonCommandResultReport, { type: "thread.start" }>
  | Extract<HostDaemonCommandResultReport, { type: "thread.stop" }>;

type ExpiredCommandDeps = Pick<
  AppDeps,
  | "cloudAuth"
  | "config"
  | "db"
  | "hub"
  | "logger"
  | "machineAuth"
  | "sandboxEnv"
  | "sandboxRegistry"
>;

function buildExpiredLifecycleFailureReport(
  args: {
    commandId: string;
    completedAt: number;
    type: LifecycleFailureReport["type"];
  },
): LifecycleFailureReport {
  return {
    commandId: args.commandId,
    completedAt: args.completedAt,
    errorCode: EXPIRED_COMMAND_ERROR_CODE,
    errorMessage: EXPIRED_COMMAND_ERROR_MESSAGE,
    ok: false,
    type: args.type,
  };
}

export async function handleExpiredCommands(
  deps: ExpiredCommandDeps,
  args: {
    commandIds: string[];
  },
): Promise<void> {
  for (const commandId of args.commandIds) {
    const commandRow = getCommand(deps.db, commandId);
    if (!commandRow) {
      continue;
    }

    const command = parseJsonWithSchema(
      commandRow.payload,
      hostDaemonCommandSchema,
    );
    const completedAt = commandRow.completedAt ?? Date.now();

    switch (command.type) {
      case "host.sync_runtime_material":
      case "environment.destroy":
      case "environment.provision":
      case "thread.start":
      case "thread.stop":
        await handleCommandResultSideEffects(
          deps,
          buildExpiredLifecycleFailureReport({
            commandId,
            completedAt,
            type: command.type,
          }),
          commandRow,
        );
        break;
      default:
        break;
    }

    deps.hub.recordCommandResult(commandId, {
      commandId,
      completedAt,
      errorCode: EXPIRED_COMMAND_ERROR_CODE,
      errorMessage: EXPIRED_COMMAND_ERROR_MESSAGE,
      ok: false,
      type: command.type,
    });
  }
}
