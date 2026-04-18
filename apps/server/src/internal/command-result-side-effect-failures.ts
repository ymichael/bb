import { and, eq, inArray, sql } from "drizzle-orm";
import {
  clearThreadStopRequested,
  getCommand,
  getThread,
  type HostDaemonCommandRow,
  hostDaemonCommands,
  listEnvironmentOperations,
  listHostOperations,
  listPendingInteractionsByStatus,
  listThreadOperations,
} from "@bb/db";
import { clearEnvironmentCleanupRequestRecord } from "@bb/db/internal-lifecycle";
import { activeLifecycleOperationStates } from "@bb/domain";
import { hostDaemonCommandSchema } from "@bb/host-daemon-contract";
import type { AppDeps } from "../types.js";
import {
  appendSystemErrorEvent,
  appendThreadProvisioningEvent,
} from "../services/threads/thread-events.js";
import {
  failThreadStartForCommand,
  failThreadStopForCommand,
  hasActiveThreadStartOperationForCommand,
} from "../services/threads/thread-lifecycle.js";
import {
  failEnvironmentDestroyForCommand,
  hasActiveEnvironmentDestroyOperationForCommand,
} from "../services/environments/environment-cleanup.js";
import {
  failEnvironmentProvisioningDurably,
  hasActiveEnvironmentProvisionOperationForCommand,
} from "../services/environments/environment-provisioning.js";
import { failSandboxRuntimeMaterialSyncForCommand } from "../services/hosts/sandbox-runtime-material-operation.js";
import { tryTransition } from "../services/threads/thread-transitions.js";

/**
 * Command settlement and command-result side effects are not atomic. This module
 * keeps interrupted result handling from leaving lifecycle operations active
 * forever after their host command is already terminal. The entry points cover
 * three recovery moments: the original side-effect exception, an identical
 * daemon retry for an already-settled command, and the periodic sweep that finds
 * active lifecycle operations still attached to terminal command rows. Thread
 * turn failures are surfaced inline only; settled retries intentionally do not
 * replay turn.submit side effects because a repeated provider failure should
 * not append duplicate user-visible error events.
 */
export const COMMAND_RESULT_SIDE_EFFECT_FAILURE_CODE =
  "command_result_side_effect_failed";
const COMMAND_RESULT_SIDE_EFFECT_FAILURE_SUMMARY =
  "Server failed to apply command result side effects";
const SETTLED_COMMAND_SIDE_EFFECT_FAILURE_DETAIL =
  "Command result reached terminal state before lifecycle side effects completed";

type ParsedCommand = ReturnType<typeof parseCommand>;
type EnvironmentProvisionCommand = Extract<
  ParsedCommand,
  { type: "environment.provision" }
>;
type EnvironmentDestroyCommand = Extract<
  ParsedCommand,
  { type: "environment.destroy" }
>;
type ThreadStartCommand = Extract<ParsedCommand, { type: "thread.start" }>;
type ThreadStopCommand = Extract<ParsedCommand, { type: "thread.stop" }>;
type TurnSubmitCommand = Extract<ParsedCommand, { type: "turn.submit" }>;
type TerminalCommandState = Extract<
  HostDaemonCommandRow["state"],
  "success" | "error"
>;

export type CommandResultSideEffectFailureDeps = Pick<
  AppDeps,
  | "cloudAuth"
  | "config"
  | "db"
  | "hostLifecycle"
  | "hub"
  | "logger"
  | "machineAuth"
  | "pendingInteractions"
  | "sandboxEnv"
  | "sandboxRegistry"
>;

export interface CommandResultSideEffectFailureArgs {
  commandRow: HostDaemonCommandRow;
  failureReason: string;
}

export interface CommandResultSideEffectFailureResponse {
  commandId: string;
  errorCode: typeof COMMAND_RESULT_SIDE_EFFECT_FAILURE_CODE;
  errorMessage: string;
  ok: false;
  type: string;
}

export interface BuildCommandResultSideEffectFailureResponseArgs {
  commandId: string;
  commandType: string;
  failureReason: string;
}

export interface SettledCommandLifecycleFailureSweepResult {
  failed: number;
}

interface FailEnvironmentProvisionSideEffectsArgs extends CommandResultSideEffectFailureArgs {
  command: EnvironmentProvisionCommand;
}

interface FailEnvironmentDestroySideEffectsArgs extends CommandResultSideEffectFailureArgs {
  command: EnvironmentDestroyCommand;
}

interface FailThreadStartSideEffectsArgs extends CommandResultSideEffectFailureArgs {
  command: ThreadStartCommand;
}

interface FailThreadStopSideEffectsArgs extends CommandResultSideEffectFailureArgs {
  command: ThreadStopCommand;
}

interface FailThreadCommandSideEffectsArgs extends CommandResultSideEffectFailureArgs {
  command: TurnSubmitCommand;
}

function parseCommand(commandRow: HostDaemonCommandRow) {
  return hostDaemonCommandSchema.parse(JSON.parse(commandRow.payload));
}

function isTerminalCommandState(
  state: HostDaemonCommandRow["state"],
): state is TerminalCommandState {
  return state === "success" || state === "error";
}

export function commandResultSideEffectFailureReason(detail: string): string {
  return `${COMMAND_RESULT_SIDE_EFFECT_FAILURE_SUMMARY}: ${detail}`;
}

export function settledCommandSideEffectFailureReason(): string {
  return commandResultSideEffectFailureReason(
    SETTLED_COMMAND_SIDE_EFFECT_FAILURE_DETAIL,
  );
}

export function errorDetail(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function buildCommandResultSideEffectFailureResponse(
  args: BuildCommandResultSideEffectFailureResponseArgs,
): CommandResultSideEffectFailureResponse {
  return {
    commandId: args.commandId,
    errorCode: COMMAND_RESULT_SIDE_EFFECT_FAILURE_CODE,
    errorMessage: args.failureReason,
    ok: false,
    type: args.commandType,
  };
}

function commandStartedAt(commandRow: HostDaemonCommandRow): number {
  return commandRow.completedAt ?? commandRow.createdAt;
}

async function failEnvironmentProvisionSideEffects(
  deps: CommandResultSideEffectFailureDeps,
  args: FailEnvironmentProvisionSideEffectsArgs,
): Promise<boolean> {
  if (
    !hasActiveEnvironmentProvisionOperationForCommand(deps, {
      commandId: args.commandRow.id,
    })
  ) {
    return false;
  }

  await failEnvironmentProvisioningDurably(deps, {
    commandId: args.commandRow.id,
    environmentId: args.command.environmentId,
    failureReason: args.failureReason,
    failureEntry: {
      type: "step",
      key: "command-result-side-effects-failed",
      text: COMMAND_RESULT_SIDE_EFFECT_FAILURE_SUMMARY,
      status: "failed",
      startedAt: commandStartedAt(args.commandRow),
      metadata: {
        commandId: args.commandRow.id,
        commandType: args.commandRow.type,
      },
    },
  });
  return true;
}

function failEnvironmentDestroySideEffects(
  deps: CommandResultSideEffectFailureDeps,
  args: FailEnvironmentDestroySideEffectsArgs,
): boolean {
  if (
    !hasActiveEnvironmentDestroyOperationForCommand(deps, {
      commandId: args.commandRow.id,
    })
  ) {
    return false;
  }

  const failed = failEnvironmentDestroyForCommand(deps, {
    commandId: args.commandRow.id,
    failureReason: args.failureReason,
  });
  if (failed) {
    clearEnvironmentCleanupRequestRecord(
      deps.db,
      deps.hub,
      args.command.environmentId,
    );
  }
  return failed;
}

function failThreadStartSideEffects(
  deps: CommandResultSideEffectFailureDeps,
  args: FailThreadStartSideEffectsArgs,
): boolean {
  if (
    !hasActiveThreadStartOperationForCommand(deps, {
      commandId: args.commandRow.id,
    })
  ) {
    return false;
  }

  const failed = failThreadStartForCommand(deps, {
    commandId: args.commandRow.id,
    failureReason: args.failureReason,
  });
  if (!failed) {
    return false;
  }

  const thread = getThread(deps.db, args.command.threadId);
  if (!thread) {
    return true;
  }

  appendThreadProvisioningEvent(deps, {
    threadId: thread.id,
    environmentId: args.command.environmentId,
    status: "failed",
    entries: [
      {
        type: "step",
        key: "agent-session-side-effects-failed",
        text: COMMAND_RESULT_SIDE_EFFECT_FAILURE_SUMMARY,
        status: "failed",
        startedAt: commandStartedAt(args.commandRow),
        metadata: {
          commandId: args.commandRow.id,
          commandType: args.commandRow.type,
        },
      },
    ],
  });

  if (thread.deletedAt === null && thread.stopRequestedAt === null) {
    appendSystemErrorEvent(deps, {
      threadId: thread.id,
      environmentId: args.command.environmentId,
      code: COMMAND_RESULT_SIDE_EFFECT_FAILURE_CODE,
      message: "Thread start failed",
      detail: args.failureReason,
    });
    tryTransition(deps.db, deps.hub, thread.id, "error");
  }

  return true;
}

function failThreadStopSideEffects(
  deps: CommandResultSideEffectFailureDeps,
  args: FailThreadStopSideEffectsArgs,
): boolean {
  const failed = failThreadStopForCommand(deps, {
    commandId: args.commandRow.id,
    failureReason: args.failureReason,
  });
  if (!failed) {
    return false;
  }

  const thread = getThread(deps.db, args.command.threadId);
  if (!thread) {
    return true;
  }

  if (thread.stopRequestedAt !== null) {
    clearThreadStopRequested(deps.db, deps.hub, thread.id);
  }
  if (thread.deletedAt === null) {
    appendSystemErrorEvent(deps, {
      threadId: thread.id,
      environmentId: args.command.environmentId,
      code: COMMAND_RESULT_SIDE_EFFECT_FAILURE_CODE,
      message: "Thread stop result handling failed",
      detail: args.failureReason,
    });
    tryTransition(deps.db, deps.hub, thread.id, "error");
  }

  return true;
}

function failThreadCommandSideEffects(
  deps: CommandResultSideEffectFailureDeps,
  args: FailThreadCommandSideEffectsArgs,
): boolean {
  const thread = getThread(deps.db, args.command.threadId);
  if (!thread || thread.deletedAt !== null || thread.stopRequestedAt !== null) {
    return false;
  }

  appendSystemErrorEvent(deps, {
    threadId: thread.id,
    environmentId: args.command.environmentId,
    code: COMMAND_RESULT_SIDE_EFFECT_FAILURE_CODE,
    message: "Thread command result handling failed",
    detail: args.failureReason,
  });
  tryTransition(deps.db, deps.hub, thread.id, "error");
  return true;
}

export async function failCommandResultSideEffects(
  deps: CommandResultSideEffectFailureDeps,
  args: CommandResultSideEffectFailureArgs,
): Promise<boolean> {
  const command = parseCommand(args.commandRow);

  switch (command.type) {
    case "environment.provision":
      return failEnvironmentProvisionSideEffects(deps, {
        ...args,
        command,
      });
    case "environment.destroy":
      return failEnvironmentDestroySideEffects(deps, {
        ...args,
        command,
      });
    case "thread.start":
      return failThreadStartSideEffects(deps, {
        ...args,
        command,
      });
    case "thread.stop":
      return failThreadStopSideEffects(deps, {
        ...args,
        command,
      });
    case "turn.submit":
      return failThreadCommandSideEffects(deps, {
        ...args,
        command,
      });
    case "interactive.resolve":
      return (
        deps.pendingInteractions.interruptPendingInteraction({
          interactionId: command.interactionId,
          reason: args.failureReason,
        }) !== null
      );
    case "host.sync_runtime_material":
      return failSandboxRuntimeMaterialSyncForCommand(deps, {
        commandId: args.commandRow.id,
        completedAt: Date.now(),
        failureReason: args.failureReason,
      });
    default:
      return false;
  }
}

export async function failSettledCommandActiveSideEffects(
  deps: CommandResultSideEffectFailureDeps,
  commandRow: HostDaemonCommandRow,
): Promise<boolean> {
  const command = parseCommand(commandRow);
  const args = {
    commandRow,
    failureReason: settledCommandSideEffectFailureReason(),
  };

  switch (command.type) {
    case "environment.provision":
      return failEnvironmentProvisionSideEffects(deps, {
        ...args,
        command,
      });
    case "environment.destroy":
      return failEnvironmentDestroySideEffects(deps, {
        ...args,
        command,
      });
    case "thread.start":
      return failThreadStartSideEffects(deps, {
        ...args,
        command,
      });
    case "thread.stop":
      return failThreadStopSideEffects(deps, {
        ...args,
        command,
      });
    case "interactive.resolve":
      return (
        deps.pendingInteractions.interruptPendingInteraction({
          interactionId: command.interactionId,
          reason: args.failureReason,
        }) !== null
      );
    case "host.sync_runtime_material":
      return failSandboxRuntimeMaterialSyncForCommand(deps, {
        commandId: commandRow.id,
        completedAt: Date.now(),
        failureReason: args.failureReason,
      });
    default:
      return false;
  }
}

async function failSettledOperationCommand(
  deps: CommandResultSideEffectFailureDeps,
  commandId: string | null,
): Promise<boolean> {
  if (!commandId) {
    return false;
  }

  try {
    const commandRow = getCommand(deps.db, commandId);
    if (!commandRow || !isTerminalCommandState(commandRow.state)) {
      return false;
    }

    const failed = await failSettledCommandActiveSideEffects(deps, commandRow);
    if (failed) {
      deps.logger.error(
        {
          commandId: commandRow.id,
          commandState: commandRow.state,
          commandType: commandRow.type,
        },
        "Failed active lifecycle operation attached to settled command",
      );
    }
    return failed;
  } catch (error) {
    deps.logger.error(
      {
        commandId,
        err: error,
      },
      "Settled command lifecycle failure sweep failed",
    );
    return false;
  }
}

function findSettledInteractiveResolveCommand(
  deps: CommandResultSideEffectFailureDeps,
  interactionId: string,
): HostDaemonCommandRow | null {
  return (
    deps.db
      .select()
      .from(hostDaemonCommands)
      .where(
        and(
          eq(hostDaemonCommands.type, "interactive.resolve"),
          inArray(hostDaemonCommands.state, ["success", "error"]),
          sql`json_extract(${hostDaemonCommands.payload}, '$.interactionId') = ${interactionId}`,
        ),
      )
      .get() ?? null
  );
}

async function failSettledInteractiveResolveCommands(
  deps: CommandResultSideEffectFailureDeps,
): Promise<number> {
  let failed = 0;
  const interactions = listPendingInteractionsByStatus(deps.db, {
    statuses: ["resolving"],
  });

  for (const interaction of interactions) {
    try {
      const commandRow = findSettledInteractiveResolveCommand(
        deps,
        interaction.id,
      );
      if (!commandRow) {
        continue;
      }

      if (await failSettledCommandActiveSideEffects(deps, commandRow)) {
        failed += 1;
      }
    } catch (error) {
      deps.logger.error(
        {
          err: error,
          interactionId: interaction.id,
        },
        "Settled interactive resolve failure sweep failed",
      );
    }
  }

  return failed;
}

export async function failActiveLifecycleOperationsWithSettledCommands(
  deps: CommandResultSideEffectFailureDeps,
): Promise<SettledCommandLifecycleFailureSweepResult> {
  let failed = 0;

  for (const operation of listEnvironmentOperations(deps.db, {
    states: [...activeLifecycleOperationStates],
  })) {
    if (await failSettledOperationCommand(deps, operation.commandId)) {
      failed += 1;
    }
  }

  for (const operation of listThreadOperations(deps.db, {
    states: [...activeLifecycleOperationStates],
  })) {
    if (await failSettledOperationCommand(deps, operation.commandId)) {
      failed += 1;
    }
  }

  for (const operation of listHostOperations(deps.db, {
    states: [...activeLifecycleOperationStates],
  })) {
    if (await failSettledOperationCommand(deps, operation.commandId)) {
      failed += 1;
    }
  }

  failed += await failSettledInteractiveResolveCommands(deps);

  return { failed };
}
