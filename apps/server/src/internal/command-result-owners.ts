import { and, eq, gt } from "drizzle-orm";
import {
  clearThreadStopRequested,
  events,
  getEnvironment,
  getHost,
  getThread,
  getThreadOperation,
  threads,
  type HostDaemonCommandRow,
} from "@bb/db";
import {
  applyProvisionedEnvironmentRecord,
  clearEnvironmentCleanupRequestRecord,
} from "@bb/db/internal-lifecycle";
import {
  hostDaemonCommandSchema,
  type HostDaemonCommandResult,
  type HostDaemonCommandResultReportWithoutSession,
} from "@bb/host-daemon-contract";
import {
  isActiveLifecycleOperationState,
  threadScope,
  turnScope,
  type ProvisioningTranscriptEntry,
  systemThreadProvisioningEventDataSchema,
} from "@bb/domain";
import type { ThreadEventScope } from "@bb/domain";
import type {
  InteractiveLifecycleCoordinationDeps,
  LifecycleCoordinationDeps,
} from "../lifecycle-coordination-deps.js";
import {
  advanceEnvironmentCleanup,
  completeEnvironmentDestroyForCommand,
  failEnvironmentDestroyForCommand,
  hasActiveEnvironmentDestroyOperationForCommand,
} from "../services/environments/environment-cleanup.js";
import {
  completeEnvironmentProvisioningForCommand,
  failEnvironmentProvisioningDurably,
  getEnvironmentProvisioningIdForCommand,
  hasActiveEnvironmentProvisionOperationForCommand,
} from "../services/environments/environment-provisioning.js";
import { destroyEphemeralHostIfReady } from "../services/hosts/host-lifecycle.js";
import {
  completeSandboxRuntimeMaterialSyncForCommand,
  failSandboxRuntimeMaterialSyncForCommand,
  hasActiveSandboxRuntimeMaterialSyncOperationForCommand,
} from "../services/hosts/sandbox-runtime-material-operation.js";
import { queueThreadRenameCommand } from "../services/threads/thread-commands.js";
import {
  appendThreadProvisioningEvent,
  appendSystemErrorEvent,
  buildCwdBranchEntries,
} from "../services/threads/thread-events.js";
import {
  advanceThreadProvisioning,
  recordThreadProvisionWorkspaceReady,
  shouldSyncGeneratedThreadTitle,
} from "../services/threads/thread-provisioning.js";
import {
  completeThreadStartForCommand,
  failThreadStartForCommand,
  failThreadStopForCommand,
  finalizeStoppedThread,
  hasActiveThreadStartOperationForCommand,
  hasActiveThreadStopOperationForCommand,
} from "../services/threads/thread-lifecycle.js";
import { tryTransition } from "../services/threads/thread-transitions.js";
import {
  COMMAND_RESULT_SIDE_EFFECT_FAILURE_CODE,
  COMMAND_RESULT_SIDE_EFFECT_FAILURE_SUMMARY,
  type CommandResultSideEffectFailureArgs,
  type CommandResultSideEffectFailureDeps,
  settledCommandSideEffectFailureReason,
} from "./command-result-side-effect-failure-common.js";

export type CommandResultSideEffectsDeps = InteractiveLifecycleCoordinationDeps;
export type CommandResultSideEffectReport =
  HostDaemonCommandResultReportWithoutSession;

function parseCommand(commandRow: HostDaemonCommandRow) {
  return hostDaemonCommandSchema.parse(JSON.parse(commandRow.payload));
}

type ParsedHostDaemonCommand = ReturnType<typeof parseCommand>;
type ParsedCommandType = ParsedHostDaemonCommand["type"];
type ParsedCommandForType<TType extends ParsedCommandType> = Extract<
  ParsedHostDaemonCommand,
  { type: TType }
>;
interface CommandResultFailureReportForType<
  TType extends ParsedCommandType,
> {
  commandId: string;
  completedAt: number;
  errorCode: string;
  errorMessage: string;
  ok: false;
  type: TType;
}
interface CommandResultSuccessReportForType<
  TType extends ParsedCommandType,
> {
  commandId: string;
  completedAt: number;
  ok: true;
  result: HostDaemonCommandResult<TType>;
  type: TType;
}
type CommandResultReportForType<TType extends ParsedCommandType> =
  | CommandResultFailureReportForType<TType>
  | CommandResultSuccessReportForType<TType>;
type WorkspaceMutationCommandType =
  | "workspace.commit"
  | "workspace.demote"
  | "workspace.promote"
  | "workspace.squash_merge";
type WorkspaceMutationCommand = ParsedCommandForType<WorkspaceMutationCommandType>;
type WorkspaceMutationResultReport =
  CommandResultReportForType<WorkspaceMutationCommandType>;
type ThreadFailureCommand = ParsedCommandForType<"thread.start" | "turn.submit">;
type ThreadFailureResultReport =
  | CommandResultFailureReportForType<"thread.start">
  | CommandResultFailureReportForType<"turn.submit">;
type CommandResultOwnerMode =
  | "result-handler-error"
  | "settled-active-side-effects";

interface ApplyCommandResultSideEffectsArgs<
  TType extends ParsedCommandType,
> {
  command: ParsedCommandForType<TType>;
  commandRow: HostDaemonCommandRow;
  deps: CommandResultSideEffectsDeps;
  report: CommandResultReportForType<TType>;
}

interface FailCommandResultSideEffectsArgs<
  TType extends ParsedCommandType,
> extends CommandResultSideEffectFailureArgs {
  command: ParsedCommandForType<TType>;
  deps: CommandResultSideEffectFailureDeps;
  mode: CommandResultOwnerMode;
}

interface CommandResultOwner<TType extends ParsedCommandType> {
  applySideEffects?(
    args: ApplyCommandResultSideEffectsArgs<TType>,
  ): Promise<void> | void;
  failSettledSideEffects: boolean;
  failSideEffects?(
    args: FailCommandResultSideEffectsArgs<TType>,
  ): Promise<boolean> | boolean;
  replaySettledSideEffects: boolean;
}

function getThreadFailureCommandErrorScope(
  command: ThreadFailureCommand,
): ThreadEventScope {
  if (command.type !== "turn.submit") {
    return threadScope();
  }

  return command.target.mode !== "start" && command.target.expectedTurnId
    ? turnScope(command.target.expectedTurnId)
    : threadScope();
}

type CommandResultOwnerRegistry = {
  [TType in ParsedCommandType]: CommandResultOwner<TType> | null;
};

function defineCommandResultOwner<TType extends ParsedCommandType>(
  owner: CommandResultOwner<TType>,
): CommandResultOwner<TType> {
  return owner;
}

function reportMatchesCommandType<TType extends ParsedCommandType>(
  command: ParsedCommandForType<TType>,
  report: CommandResultSideEffectReport,
): report is CommandResultReportForType<TType> {
  return report.type === command.type;
}

function getCommandResultOwner<TType extends ParsedCommandType>(
  command: ParsedCommandForType<TType>,
): CommandResultOwner<TType> | null {
  return commandResultOwners[command.type];
}

function isWorkspaceProvisioningTranscriptEntry(
  entry: ProvisioningTranscriptEntry,
): boolean {
  return WORKSPACE_PROVISIONING_TRANSCRIPT_KEYS.has(entry.key);
}

const WORKSPACE_PROVISIONING_TRANSCRIPT_KEYS = new Set([
  "git-checkout-completed",
  "git-checkout-failed",
  "git-checkout-started",
  "git-clone-completed",
  "git-clone-failed",
  "git-clone-started",
  "git-worktree-command",
  "git-worktree-completed",
  "git-worktree-failed",
  "git-worktree-started",
  "setup-completed",
  "setup-failed",
  "setup-started",
  "workspace-branch",
  "workspace-path",
  "workspace-source",
  "workspace-target",
]);

function hasStreamedProvisioningTranscript(
  deps: CommandResultSideEffectsDeps,
  threadId: string,
  afterSequence: number,
): boolean {
  const rows = deps.db
    .select({ data: events.data })
    .from(events)
    .where(
      and(
        eq(events.threadId, threadId),
        eq(events.type, "system/thread-provisioning"),
        gt(events.sequence, afterSequence),
      ),
    )
    .all();

  return rows.some((row) => {
    const eventData = systemThreadProvisioningEventDataSchema.parse(
      JSON.parse(row.data),
    );
    return eventData.entries.some(isWorkspaceProvisioningTranscriptEntry);
  });
}

function hasActiveThreadProvisionOperation(
  deps: Pick<LifecycleCoordinationDeps, "db">,
  threadId: string,
): boolean {
  const operation = getThreadOperation(deps.db, {
    threadId,
    kind: "provision",
  });
  return Boolean(operation && isActiveLifecycleOperationState(operation.state));
}

async function handleProvisionCommandResult(
  args: ApplyCommandResultSideEffectsArgs<"environment.provision">,
): Promise<void> {
  if (
    !hasActiveEnvironmentProvisionOperationForCommand(args.deps, {
      commandId: args.commandRow.id,
    })
  ) {
    return;
  }

  const environmentProvisioningId = getEnvironmentProvisioningIdForCommand(
    args.deps,
    {
      commandId: args.commandRow.id,
    },
  );
  if (environmentProvisioningId === null) {
    return;
  }

  const boundThreads = args.deps.db
    .select()
    .from(threads)
    .where(eq(threads.environmentId, args.command.environmentId))
    .all();

  if (args.report.ok) {
    applyProvisionedEnvironmentRecord(
      args.deps.db,
      args.deps.hub,
      args.command.environmentId,
      {
        path: args.report.result.path,
        status: "ready",
        isGitRepo: args.report.result.isGitRepo,
        isWorktree: args.report.result.isWorktree,
        branchName: args.report.result.branchName,
        defaultBranch: args.report.result.defaultBranch,
      },
    );
    args.deps.hub.notifyEnvironment(args.command.environmentId, [
      "work-status-changed",
    ]);

    const cwdBranchEntries = buildCwdBranchEntries({
      path: args.report.result.path,
      branchName: args.report.result.branchName,
    });

    for (const thread of boundThreads) {
      if (thread.deletedAt !== null) {
        await finalizeStoppedThread(args.deps, { threadId: thread.id });
        continue;
      }
      if (thread.archivedAt !== null || thread.stopRequestedAt !== null) {
        continue;
      }

      const isInitiator = thread.id === args.command.initiator?.threadId;
      const hasStreamedTranscript =
        isInitiator && args.command.initiator
          ? hasStreamedProvisioningTranscript(
              args.deps,
              thread.id,
              args.command.initiator.eventSequence,
            )
          : false;
      const entries = hasStreamedTranscript
        ? []
        : isInitiator && args.report.result.transcript.length > 0
          ? args.report.result.transcript
          : cwdBranchEntries;

      if (!hasActiveThreadProvisionOperation(args.deps, thread.id)) {
        appendThreadProvisioningEvent(args.deps, {
          threadId: thread.id,
          environmentId: args.command.environmentId,
          provisioningId: environmentProvisioningId,
          status: thread.status === "provisioning" ? "active" : "completed",
          entries,
        });
        continue;
      }

      recordThreadProvisionWorkspaceReady(args.deps, {
        threadId: thread.id,
        environmentId: args.command.environmentId,
        entries,
      });
      await advanceThreadProvisioning(args.deps, {
        threadId: thread.id,
      });
    }

    completeEnvironmentProvisioningForCommand(args.deps, {
      commandId: args.commandRow.id,
    });

    await advanceEnvironmentCleanup(args.deps, {
      environmentId: args.command.environmentId,
    });
    return;
  }

  await failEnvironmentProvisioningDurably(args.deps, {
    commandId: args.commandRow.id,
    environmentId: args.command.environmentId,
    failureReason: args.report.errorMessage,
    failureEntry: {
      type: "step",
      key: "workspace-failed",
      text: "Workspace setup failed",
      status: "failed",
      startedAt: args.commandRow.createdAt,
      metadata: { durationMs: Date.now() - args.commandRow.createdAt },
    },
  });
}

async function handleEnvironmentDestroyResult(
  args: ApplyCommandResultSideEffectsArgs<"environment.destroy">,
): Promise<void> {
  if (
    !hasActiveEnvironmentDestroyOperationForCommand(args.deps, {
      commandId: args.commandRow.id,
    })
  ) {
    return;
  }

  const environment = getEnvironment(args.deps.db, args.command.environmentId);
  if (!args.report.ok) {
    failEnvironmentDestroyForCommand(args.deps, {
      commandId: args.commandRow.id,
      failureReason: args.report.errorMessage,
    });
    return;
  }
  if (!environment) {
    return;
  }
  if (
    !completeEnvironmentDestroyForCommand(args.deps, {
      commandId: args.commandRow.id,
    })
  ) {
    return;
  }

  const host = getHost(args.deps.db, environment.hostId);
  if (host?.type !== "ephemeral") {
    return;
  }

  try {
    await destroyEphemeralHostIfReady(args.deps, host.id);
  } catch (error) {
    args.deps.logger.warn(
      {
        environmentId: environment.id,
        err: error,
        hostId: host.id,
      },
      "Ephemeral sandbox host cleanup failed after environment destroy",
    );
  }
}

function handleThreadCommandFailure(
  deps: Pick<LifecycleCoordinationDeps, "db" | "hub">,
  command: ThreadFailureCommand,
  report: ThreadFailureResultReport,
): void {
  const thread = getThread(deps.db, command.threadId);
  if (!thread || thread.deletedAt !== null || thread.stopRequestedAt !== null) {
    return;
  }
  appendSystemErrorEvent(deps, {
    threadId: thread.id,
    environmentId: command.environmentId,
    code: "thread_command_failed",
    message: `Command ${report.type} failed`,
    detail: report.errorMessage,
    scope: getThreadFailureCommandErrorScope(command),
  });
  tryTransition(deps.db, deps.hub, thread.id, "error");
}

function handleThreadStartResult(
  args: ApplyCommandResultSideEffectsArgs<"thread.start">,
): void {
  const thread = getThread(args.deps.db, args.command.threadId);
  if (!thread) {
    return;
  }
  if (!args.report.ok) {
    if (
      hasActiveThreadStartOperationForCommand(args.deps, {
        commandId: args.commandRow.id,
      })
    ) {
      failThreadStartForCommand(args.deps, {
        commandId: args.commandRow.id,
        failureReason: args.report.errorMessage,
      });
    }
    handleThreadCommandFailure(args.deps, args.command, args.report);
    return;
  }

  if (
    !hasActiveThreadStartOperationForCommand(args.deps, {
      commandId: args.commandRow.id,
    })
  ) {
    return;
  }

  completeThreadStartForCommand(args.deps, {
    commandId: args.commandRow.id,
  });
  if (thread.title && shouldSyncGeneratedThreadTitle(args.deps, thread.id)) {
    queueThreadRenameCommand(args.deps, {
      environment: {
        id: args.command.environmentId,
        hostId: args.commandRow.hostId,
      },
      providerId: thread.providerId,
      threadId: thread.id,
      title: thread.title,
    });
  }
}

async function handleThreadStopResult(
  args: ApplyCommandResultSideEffectsArgs<"thread.stop">,
): Promise<void> {
  if (
    !hasActiveThreadStopOperationForCommand(args.deps, {
      commandId: args.commandRow.id,
    })
  ) {
    return;
  }
  if (!args.report.ok) {
    failThreadStopForCommand(args.deps, {
      commandId: args.commandRow.id,
      failureReason: args.report.errorMessage,
    });
    return;
  }

  await finalizeStoppedThread(args.deps, {
    threadId: args.command.threadId,
    cancelPendingCommand: false,
    expectedCommandId: args.commandRow.id,
  });
}

function handleInteractiveResolveResult(
  args: ApplyCommandResultSideEffectsArgs<"interactive.resolve">,
): void {
  if (!args.report.ok) {
    args.deps.pendingInteractions.interruptPendingInteraction({
      interactionId: args.command.interactionId,
      reason: args.report.errorMessage,
    });
    return;
  }

  const completed = args.deps.pendingInteractions.completeResolvingInteraction({
    interactionId: args.command.interactionId,
    resolution: args.command.resolution,
  });
  if (!completed) {
    args.deps.logger.info(
      {
        commandId: args.commandRow.id,
        interactionId: args.command.interactionId,
      },
      "Interactive resolve command result did not advance pending interaction",
    );
  }
}

function handleWorkspaceMutationResult(
  deps: Pick<LifecycleCoordinationDeps, "hub">,
  command: WorkspaceMutationCommand,
  report: WorkspaceMutationResultReport,
): void {
  if (!report.ok) {
    return;
  }
  deps.hub.notifyEnvironment(command.environmentId, ["work-status-changed"]);
}

function handleSandboxRuntimeMaterialResult(
  args: ApplyCommandResultSideEffectsArgs<"host.sync_runtime_material">,
): void {
  if (
    !hasActiveSandboxRuntimeMaterialSyncOperationForCommand(args.deps, {
      commandId: args.commandRow.id,
    })
  ) {
    return;
  }

  if (!args.report.ok) {
    failSandboxRuntimeMaterialSyncForCommand(args.deps, {
      commandId: args.commandRow.id,
      completedAt: args.report.completedAt,
      failureReason: args.report.errorMessage,
    });
    return;
  }

  completeSandboxRuntimeMaterialSyncForCommand(args.deps, {
    appliedVersion: args.report.result.appliedVersion,
    commandId: args.commandRow.id,
    completedAt: args.report.completedAt,
  });
}

function commandStartedAt(commandRow: HostDaemonCommandRow): number {
  return commandRow.completedAt ?? commandRow.createdAt;
}

async function failEnvironmentProvisionSideEffects(
  args: FailCommandResultSideEffectsArgs<"environment.provision">,
): Promise<boolean> {
  if (
    !hasActiveEnvironmentProvisionOperationForCommand(args.deps, {
      commandId: args.commandRow.id,
    })
  ) {
    return false;
  }

  await failEnvironmentProvisioningDurably(args.deps, {
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
  args: FailCommandResultSideEffectsArgs<"environment.destroy">,
): boolean {
  if (
    !hasActiveEnvironmentDestroyOperationForCommand(args.deps, {
      commandId: args.commandRow.id,
    })
  ) {
    return false;
  }

  const failed = failEnvironmentDestroyForCommand(args.deps, {
    commandId: args.commandRow.id,
    failureReason: args.failureReason,
  });
  if (failed) {
    clearEnvironmentCleanupRequestRecord(
      args.deps.db,
      args.deps.hub,
      args.command.environmentId,
    );
  }
  return failed;
}

function failThreadStartSideEffects(
  args: FailCommandResultSideEffectsArgs<"thread.start">,
): boolean {
  if (
    !hasActiveThreadStartOperationForCommand(args.deps, {
      commandId: args.commandRow.id,
    })
  ) {
    return false;
  }

  const failed = failThreadStartForCommand(args.deps, {
    commandId: args.commandRow.id,
    failureReason: args.failureReason,
  });
  if (!failed) {
    return false;
  }

  const thread = getThread(args.deps.db, args.command.threadId);
  if (!thread) {
    return true;
  }
  if (thread.deletedAt === null && thread.stopRequestedAt === null) {
    appendSystemErrorEvent(args.deps, {
      threadId: thread.id,
      environmentId: args.command.environmentId,
      code: COMMAND_RESULT_SIDE_EFFECT_FAILURE_CODE,
      message: "Thread start failed",
      detail: args.failureReason,
      scope: threadScope(),
    });
    tryTransition(args.deps.db, args.deps.hub, thread.id, "error");
  }
  return true;
}

function failThreadStopSideEffects(
  args: FailCommandResultSideEffectsArgs<"thread.stop">,
): boolean {
  const failed = failThreadStopForCommand(args.deps, {
    commandId: args.commandRow.id,
    failureReason: args.failureReason,
  });
  if (!failed) {
    return false;
  }

  const thread = getThread(args.deps.db, args.command.threadId);
  if (!thread) {
    return true;
  }
  if (thread.stopRequestedAt !== null) {
    clearThreadStopRequested(args.deps.db, args.deps.hub, thread.id);
  }
  if (thread.deletedAt === null) {
    appendSystemErrorEvent(args.deps, {
      threadId: thread.id,
      environmentId: args.command.environmentId,
      code: COMMAND_RESULT_SIDE_EFFECT_FAILURE_CODE,
      message: "Thread stop result handling failed",
      detail: args.failureReason,
      scope: threadScope(),
    });
    tryTransition(args.deps.db, args.deps.hub, thread.id, "error");
  }
  return true;
}

function failThreadCommandSideEffects(
  args: FailCommandResultSideEffectsArgs<"turn.submit">,
): boolean {
  const thread = getThread(args.deps.db, args.command.threadId);
  if (!thread || thread.deletedAt !== null || thread.stopRequestedAt !== null) {
    return false;
  }
  appendSystemErrorEvent(args.deps, {
    threadId: thread.id,
    environmentId: args.command.environmentId,
    code: COMMAND_RESULT_SIDE_EFFECT_FAILURE_CODE,
    message: "Thread command result handling failed",
    detail: args.failureReason,
    scope: getThreadFailureCommandErrorScope(args.command),
  });
  tryTransition(args.deps.db, args.deps.hub, thread.id, "error");
  return true;
}

const commandResultOwners: CommandResultOwnerRegistry = {
  "environment.destroy": defineCommandResultOwner({
    replaySettledSideEffects: true,
    failSettledSideEffects: true,
    applySideEffects: handleEnvironmentDestroyResult,
    failSideEffects: failEnvironmentDestroySideEffects,
  }),
  "environment.provision": defineCommandResultOwner({
    replaySettledSideEffects: true,
    failSettledSideEffects: true,
    applySideEffects: handleProvisionCommandResult,
    failSideEffects: failEnvironmentProvisionSideEffects,
  }),
  "host.sync_runtime_material": defineCommandResultOwner({
    replaySettledSideEffects: true,
    failSettledSideEffects: true,
    applySideEffects: handleSandboxRuntimeMaterialResult,
    failSideEffects: ({ deps, commandRow, failureReason }) =>
      failSandboxRuntimeMaterialSyncForCommand(deps, {
        commandId: commandRow.id,
        completedAt: Date.now(),
        failureReason,
      }),
  }),
  "host.list_files": null,
  "host.read_file": null,
  "interactive.resolve": defineCommandResultOwner({
    replaySettledSideEffects: true,
    failSettledSideEffects: true,
    applySideEffects: handleInteractiveResolveResult,
    failSideEffects: ({ deps, command, failureReason }) =>
      deps.pendingInteractions.interruptPendingInteraction({
        interactionId: command.interactionId,
        reason: failureReason,
      }) !== null,
  }),
  "provider.list": null,
  "provider.list_models": null,
  "replay.capture_delete": null,
  "replay.capture_get": null,
  "replay.capture_list": null,
  "replay.run": null,
  "thread.deleted": null,
  "thread.rename": null,
  "thread.start": defineCommandResultOwner({
    replaySettledSideEffects: true,
    failSettledSideEffects: true,
    applySideEffects: handleThreadStartResult,
    failSideEffects: failThreadStartSideEffects,
  }),
  "thread.stop": defineCommandResultOwner({
    replaySettledSideEffects: true,
    failSettledSideEffects: true,
    applySideEffects: handleThreadStopResult,
    failSideEffects: failThreadStopSideEffects,
  }),
  "turn.submit": defineCommandResultOwner({
    replaySettledSideEffects: false,
    failSettledSideEffects: false,
    applySideEffects: ({ deps, command, report }) => {
      if (!report.ok) {
        handleThreadCommandFailure(deps, command, report);
      }
    },
    failSideEffects: failThreadCommandSideEffects,
  }),
  "workspace.commit": defineCommandResultOwner({
    replaySettledSideEffects: false,
    failSettledSideEffects: false,
    applySideEffects: ({ deps, command, report }) => {
      handleWorkspaceMutationResult(deps, command, report);
    },
  }),
  "workspace.demote": defineCommandResultOwner({
    replaySettledSideEffects: false,
    failSettledSideEffects: false,
    applySideEffects: ({ deps, command, report }) => {
      handleWorkspaceMutationResult(deps, command, report);
    },
  }),
  "workspace.diff": null,
  "workspace.list_branches": null,
  "workspace.list_files": null,
  "workspace.promote": defineCommandResultOwner({
    replaySettledSideEffects: false,
    failSettledSideEffects: false,
    applySideEffects: ({ deps, command, report }) => {
      handleWorkspaceMutationResult(deps, command, report);
    },
  }),
  "workspace.squash_merge": defineCommandResultOwner({
    replaySettledSideEffects: false,
    failSettledSideEffects: false,
    applySideEffects: ({ deps, command, report }) => {
      handleWorkspaceMutationResult(deps, command, report);
    },
  }),
  "workspace.status": null,
};

export function commandResultOwnerReplaysSettledSideEffects(
  commandRow: HostDaemonCommandRow,
): boolean {
  const command = parseCommand(commandRow);
  return getCommandResultOwner(command)?.replaySettledSideEffects ?? false;
}

export async function handleCommandResultSideEffects(
  deps: CommandResultSideEffectsDeps,
  report: CommandResultSideEffectReport,
  commandRow: HostDaemonCommandRow,
): Promise<void> {
  const command = parseCommand(commandRow);
  if (!reportMatchesCommandType(command, report)) {
    return;
  }
  await getCommandResultOwner(command)?.applySideEffects?.({
    deps,
    report,
    command,
    commandRow,
  });
}

export async function failCommandResultSideEffects(
  deps: CommandResultSideEffectFailureDeps,
  args: CommandResultSideEffectFailureArgs,
): Promise<boolean> {
  const command = parseCommand(args.commandRow);
  return (
    (await getCommandResultOwner(command)?.failSideEffects?.({
      ...args,
      command,
      deps,
      mode: "result-handler-error",
    })) ?? false
  );
}

export async function failSettledCommandActiveSideEffects(
  deps: CommandResultSideEffectFailureDeps,
  commandRow: HostDaemonCommandRow,
): Promise<boolean> {
  const command = parseCommand(commandRow);
  const owner = getCommandResultOwner(command);
  if (!owner?.failSettledSideEffects) {
    return false;
  }
  return (
    (await owner.failSideEffects?.({
      command,
      commandRow,
      deps,
      failureReason: settledCommandSideEffectFailureReason(),
      mode: "settled-active-side-effects",
    })) ?? false
  );
}
