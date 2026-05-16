import { getCommand } from "@bb/db";
import {
  hostDaemonCommandSchema,
  type HostDaemonCommand,
  type HostDaemonCommandResultReport,
} from "@bb/host-daemon-contract";
import type { AppDeps } from "../../types.js";
import {
  buildCommandResultSettlementDeps,
  handleCommandResultSideEffects,
} from "../../internal/command-result-owners.js";
import { dispatchCommandResultPostCommitActions } from "../../internal/command-result-post-commit-actions.js";
import { NotificationBuffer } from "../lib/notification-buffer.js";
import { parseJsonWithSchema } from "../lib/json-parsing.js";

const EXPIRED_COMMAND_ERROR_CODE = "command_expired";
const EXPIRED_COMMAND_ERROR_MESSAGE = "Command expired after retry";
const EXPIRED_COMMAND_SESSION_ID = "expired";

type LifecycleFailureReport =
  | Extract<HostDaemonCommandResultReport, { type: "environment.destroy" }>
  | Extract<HostDaemonCommandResultReport, { type: "environment.provision" }>
  | Extract<HostDaemonCommandResultReport, { type: "thread.start" }>
  | Extract<HostDaemonCommandResultReport, { type: "thread.stop" }>
  | Extract<HostDaemonCommandResultReport, { type: "interactive.resolve" }>;

type ExpiredCommandDeps = Pick<
  AppDeps,
  | "config"
  | "db"
  | "hostLifecycle"
  | "hub"
  | "lifecycleDedupers"
  | "logger"
  | "machineAuth"
  | "pendingInteractions"
  | "terminalSessions"
>;

interface RecordExpiredCommandWaiterResponseArgs {
  commandId: string;
  type: HostDaemonCommand["type"];
}

type ExpiredCommandWaiterResponseDeps = Pick<ExpiredCommandDeps, "hub">;

function recordExpiredCommandWaiterResponse(
  deps: ExpiredCommandWaiterResponseDeps,
  args: RecordExpiredCommandWaiterResponseArgs,
): void {
  deps.hub.recordCommandResult(args.commandId, {
    commandId: args.commandId,
    errorCode: EXPIRED_COMMAND_ERROR_CODE,
    errorMessage: EXPIRED_COMMAND_ERROR_MESSAGE,
    ok: false,
    type: args.type,
  });
}

function buildExpiredLifecycleFailureReport(args: {
  commandId: string;
  completedAt: number;
  type: LifecycleFailureReport["type"];
}): LifecycleFailureReport {
  return {
    commandId: args.commandId,
    completedAt: args.completedAt,
    errorCode: EXPIRED_COMMAND_ERROR_CODE,
    errorMessage: EXPIRED_COMMAND_ERROR_MESSAGE,
    ok: false,
    sessionId: EXPIRED_COMMAND_SESSION_ID,
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
      case "environment.destroy":
      case "environment.provision":
      case "thread.start":
      case "thread.stop":
      case "interactive.resolve": {
        const notificationBuffer = new NotificationBuffer();
        const failureReport = buildExpiredLifecycleFailureReport({
          commandId,
          completedAt,
          type: command.type,
        });
        const sideEffects = deps.db.transaction(
          (tx) =>
            handleCommandResultSideEffects(
              buildCommandResultSettlementDeps({
                db: tx,
                deps,
                hub: notificationBuffer,
              }),
              failureReport,
              commandRow,
            ),
          { behavior: "immediate" },
        );
        notificationBuffer.flushInto(deps.hub);
        recordExpiredCommandWaiterResponse(deps, {
          commandId,
          type: command.type,
        });
        // Expired-command sweeps already run outside daemon ingress, so execute
        // the shared post-commit actions inline and surface failures to the
        // sweep caller.
        await dispatchCommandResultPostCommitActions({
          actions: sideEffects.postCommitActions,
          command: commandRow,
          deps,
          mode: "inline",
        });
        continue;
      }
      default:
        break;
    }

    recordExpiredCommandWaiterResponse(deps, {
      commandId,
      type: command.type,
    });
  }
}
