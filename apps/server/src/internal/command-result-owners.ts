import { and, eq } from "drizzle-orm";
import {
  events,
  getEnvironment,
  listStoredThreadProvisioningRowsByProvisioningId,
  getThread,
  getThreadOperation,
  threads,
  type DbNotifier,
  type DbTransaction,
  type HostDaemonCommandRow,
} from "@bb/db";
import { applyProvisionedEnvironmentRecord } from "@bb/db/internal-lifecycle";
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
import type { InteractiveLifecycleCoordinationDeps } from "../lifecycle-coordination-deps.js";
import type { AppDeps } from "../types.js";
import {
  completeEnvironmentDestroyForCommand,
  failEnvironmentDestroyForCommand,
  hasActiveEnvironmentDestroyOperationForCommand,
  runEnvironmentCleanupAdvance,
} from "../services/environments/environment-cleanup.js";
import {
  completeEnvironmentProvisioningForCommand,
  getEnvironmentProvisioningIdForCommand,
  hasActiveEnvironmentProvisionOperationForCommand,
  recordEnvironmentProvisioningFailureInTransaction,
} from "../services/environments/environment-provisioning.js";
import { queueThreadRenameCommandInTransaction } from "../services/threads/thread-commands.js";
import {
  appendThreadProvisioningEventInTransaction,
  appendSystemErrorEventInTransaction,
  buildCwdBranchEntries,
} from "../services/threads/thread-events.js";
import {
  advanceThreadProvisioning,
  recordThreadProvisionWorkspaceReadyInTransaction,
  shouldSyncGeneratedThreadTitle,
} from "../services/threads/thread-provisioning.js";
import {
  completeThreadStartForCommand,
  failThreadStartForCommand,
  failThreadStopForCommand,
  finalizeStoppedThreadInTransaction,
  hasActiveThreadStartOperationForCommand,
  hasActiveThreadStopOperationForCommand,
  queueSettledArchivedThreadProviderArchiveCommand,
} from "../services/threads/thread-lifecycle.js";
import {
  queueManagedThreadTurnNotificationBestEffort,
  type QueueManagedThreadTurnNotificationArgs,
} from "../services/threads/managed-thread-notifications.js";
import { tryTransitionInTransaction } from "../services/threads/thread-transitions.js";

export type CommandResultSideEffectsDeps =
  InteractiveLifecycleCoordinationDeps & Pick<AppDeps, "terminalSessions">;
export type CommandResultSettlementDeps = Omit<
  CommandResultSideEffectsDeps,
  "db" | "hub"
> & {
  db: DbTransaction;
  hub: DbNotifier;
};
export type CommandResultSideEffectReport =
  HostDaemonCommandResultReportWithoutSession;
export interface CommandResultPostCommitActionContext {
  environmentId?: string | null;
  hostId?: string;
  threadId?: string;
}

export interface CommandResultPostCommitAction {
  context?: CommandResultPostCommitActionContext;
  name: string;
  run(deps: CommandResultSideEffectsDeps): Promise<void> | void;
}

export interface CommandResultSideEffectsResult {
  postCommitActions: CommandResultPostCommitAction[];
}

export interface BuildCommandResultSettlementDepsArgs {
  db: DbTransaction;
  deps: CommandResultSideEffectsDeps;
  hub: DbNotifier;
}

export function buildCommandResultSettlementDeps(
  args: BuildCommandResultSettlementDepsArgs,
): CommandResultSettlementDeps {
  return {
    ...args.deps,
    db: args.db,
    hub: args.hub,
  };
}

function parseCommand(commandRow: HostDaemonCommandRow) {
  return hostDaemonCommandSchema.parse(JSON.parse(commandRow.payload));
}

type ParsedHostDaemonCommand = ReturnType<typeof parseCommand>;
type ParsedCommandType = ParsedHostDaemonCommand["type"];
type ParsedCommandForType<TType extends ParsedCommandType> = Extract<
  ParsedHostDaemonCommand,
  { type: TType }
>;
interface CommandResultFailureReportForType<TType extends ParsedCommandType> {
  commandId: string;
  completedAt: number;
  errorCode: string;
  errorMessage: string;
  ok: false;
  type: TType;
}
interface CommandResultSuccessReportForType<TType extends ParsedCommandType> {
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
  | "workspace.squash_merge";
type WorkspaceMutationCommand =
  ParsedCommandForType<WorkspaceMutationCommandType>;
type WorkspaceMutationResultReport =
  CommandResultReportForType<WorkspaceMutationCommandType>;
type ThreadFailureCommand = ParsedCommandForType<
  "thread.start" | "turn.submit"
>;
type ThreadFailureResultReport =
  | CommandResultFailureReportForType<"thread.start">
  | CommandResultFailureReportForType<"turn.submit">;

// Command-result owners apply durable DB side effects before the command row is
// marked terminal. Work that can queue or wait for another daemon command must
// be returned as an explicit post-commit action.
interface ApplyCommandResultSideEffectsArgs<TType extends ParsedCommandType> {
  command: ParsedCommandForType<TType>;
  commandRow: HostDaemonCommandRow;
  deps: CommandResultSettlementDeps;
  report: CommandResultReportForType<TType>;
}

interface CommandResultOwner<TType extends ParsedCommandType> {
  applySideEffects?(
    args: ApplyCommandResultSideEffectsArgs<TType>,
  ): CommandResultSideEffectsResult | void;
}

function emptyCommandResultSideEffects(): CommandResultSideEffectsResult {
  return { postCommitActions: [] };
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

// Once a terminal turn event exists, event side effects own the actual turn
// outcome. Command-result failure handling is only the fallback for missing
// terminal events, regardless of whether the event outcome was failed,
// completed, or interrupted.
function hasExpectedTurnCompletedEvent(
  deps: CommandResultSettlementDeps,
  command: ThreadFailureCommand,
): boolean {
  if (command.type !== "turn.submit" || command.target.mode === "start") {
    return false;
  }
  const turnId = command.target.expectedTurnId;
  if (!turnId) {
    return false;
  }

  return (
    deps.db
      .select({ id: events.id })
      .from(events)
      .where(
        and(
          eq(events.threadId, command.threadId),
          eq(events.turnId, turnId),
          eq(events.type, "turn/completed"),
        ),
      )
      .limit(1)
      .get() !== undefined
  );
}

function buildManagedThreadCommandFailureNotification(
  args: QueueManagedThreadTurnNotificationArgs,
): CommandResultPostCommitAction {
  return {
    name: "Managed thread command failure notification",
    context: {
      threadId: args.managedThreadId,
    },
    run: (deps) =>
      queueManagedThreadTurnNotificationBestEffort(deps, {
        managedThreadId: args.managedThreadId,
        managerThreadId: args.managerThreadId,
        title: args.title,
        turnStatus: args.turnStatus,
      }),
  };
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
  deps: CommandResultSettlementDeps,
  threadId: string,
  provisioningId: string,
): boolean {
  const rows = listStoredThreadProvisioningRowsByProvisioningId(deps.db, {
    threadId,
    provisioningId,
  });

  return rows.some((row) => {
    const eventData = systemThreadProvisioningEventDataSchema.parse(
      JSON.parse(row.data),
    );
    return (
      eventData.provisioningId === provisioningId &&
      eventData.entries.some(isWorkspaceProvisioningTranscriptEntry)
    );
  });
}

function hasActiveThreadProvisionOperation(
  deps: Pick<CommandResultSettlementDeps, "db">,
  threadId: string,
): boolean {
  const operation = getThreadOperation(deps.db, {
    threadId,
    kind: "provision",
  });
  return Boolean(operation && isActiveLifecycleOperationState(operation.state));
}

function handleProvisionCommandResult(
  args: ApplyCommandResultSideEffectsArgs<"environment.provision">,
): CommandResultSideEffectsResult {
  const postCommitActions: CommandResultPostCommitAction[] = [];
  if (
    !hasActiveEnvironmentProvisionOperationForCommand(args.deps, {
      commandId: args.commandRow.id,
    })
  ) {
    return emptyCommandResultSideEffects();
  }

  const environmentProvisioningId = getEnvironmentProvisioningIdForCommand(
    args.deps,
    {
      commandId: args.commandRow.id,
    },
  );
  if (environmentProvisioningId === null) {
    return emptyCommandResultSideEffects();
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
        finalizeStoppedThreadInTransaction(args.deps, {
          threadId: thread.id,
        });
        postCommitActions.push({
          name: "Environment cleanup advance after deleted thread finalize",
          context: {
            environmentId: args.command.environmentId,
            threadId: thread.id,
          },
          run: (deps) =>
            runEnvironmentCleanupAdvance(deps, {
              environmentId: args.command.environmentId,
            }),
        });
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
              args.command.initiator.provisioningId,
            )
          : false;
      const entries = hasStreamedTranscript
        ? []
        : isInitiator && args.report.result.transcript.length > 0
          ? args.report.result.transcript
          : cwdBranchEntries;

      if (!hasActiveThreadProvisionOperation(args.deps, thread.id)) {
        appendThreadProvisioningEventInTransaction(args.deps.db, {
          threadId: thread.id,
          environmentId: args.command.environmentId,
          provisioningId: environmentProvisioningId,
          status: thread.status === "provisioning" ? "active" : "completed",
          entries,
        });
        args.deps.hub.notifyThread(thread.id, ["events-appended"], {
          eventTypes: ["system/thread-provisioning"],
        });
        continue;
      }

      recordThreadProvisionWorkspaceReadyInTransaction(args.deps, {
        threadId: thread.id,
        environmentId: args.command.environmentId,
        entries,
      });
      postCommitActions.push({
        name: "Thread provisioning advance after workspace ready",
        context: {
          environmentId: args.command.environmentId,
          threadId: thread.id,
        },
        run: (deps) => advanceThreadProvisioning(deps, { threadId: thread.id }),
      });
    }

    completeEnvironmentProvisioningForCommand(args.deps, {
      commandId: args.commandRow.id,
    });

    postCommitActions.push({
      name: "Environment cleanup advance after provision result",
      context: {
        environmentId: args.command.environmentId,
      },
      run: (deps) =>
        runEnvironmentCleanupAdvance(deps, {
          environmentId: args.command.environmentId,
        }),
    });
    return { postCommitActions };
  }

  const failureRecorded = recordEnvironmentProvisioningFailureInTransaction(
    args.deps,
    {
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
    },
  );
  if (failureRecorded) {
    postCommitActions.push({
      name: "Environment cleanup advance after provision failure",
      context: {
        environmentId: args.command.environmentId,
      },
      run: (deps) =>
        runEnvironmentCleanupAdvance(deps, {
          environmentId: args.command.environmentId,
        }),
    });
  }
  return { postCommitActions };
}

function handleEnvironmentDestroyResult(
  args: ApplyCommandResultSideEffectsArgs<"environment.destroy">,
): CommandResultSideEffectsResult {
  const postCommitActions: CommandResultPostCommitAction[] = [];
  if (
    !hasActiveEnvironmentDestroyOperationForCommand(args.deps, {
      commandId: args.commandRow.id,
    })
  ) {
    return emptyCommandResultSideEffects();
  }

  const environment = getEnvironment(args.deps.db, args.command.environmentId);
  if (!args.report.ok) {
    failEnvironmentDestroyForCommand(args.deps, {
      commandId: args.commandRow.id,
      failureReason: args.report.errorMessage,
    });
    return emptyCommandResultSideEffects();
  }
  if (!environment) {
    return emptyCommandResultSideEffects();
  }
  if (
    !completeEnvironmentDestroyForCommand(args.deps, {
      commandId: args.commandRow.id,
    })
  ) {
    return emptyCommandResultSideEffects();
  }

  postCommitActions.push({
    name: "Terminal cleanup after environment destroy",
    context: {
      environmentId: environment.id,
    },
    run: (deps) =>
      deps.terminalSessions.closeDestroyedEnvironmentTerminals({
        environmentId: environment.id,
      }),
  });
  return { postCommitActions };
}

function handleThreadCommandFailure(
  deps: CommandResultSettlementDeps,
  command: ThreadFailureCommand,
  report: ThreadFailureResultReport,
): CommandResultSideEffectsResult {
  const postCommitActions: CommandResultPostCommitAction[] = [];
  const thread = getThread(deps.db, command.threadId);
  if (!thread || thread.deletedAt !== null || thread.stopRequestedAt !== null) {
    return emptyCommandResultSideEffects();
  }
  // Preserve the event-owned outcome when the daemon reports a late command
  // failure after the expected turn already reached a terminal event.
  if (hasExpectedTurnCompletedEvent(deps, command)) {
    return emptyCommandResultSideEffects();
  }
  appendSystemErrorEventInTransaction(deps, {
    threadId: thread.id,
    environmentId: command.environmentId,
    code: "thread_command_failed",
    message: `Command ${report.type} failed`,
    detail: report.errorMessage,
    scope: getThreadFailureCommandErrorScope(command),
  });
  tryTransitionInTransaction(deps.db, deps.hub, thread.id, "error");
  if (thread.parentThreadId !== null) {
    postCommitActions.push(
      buildManagedThreadCommandFailureNotification({
        managedThreadId: thread.id,
        managerThreadId: thread.parentThreadId,
        title: thread.title,
        turnStatus: "failed",
      }),
    );
  }
  return { postCommitActions };
}

function handleThreadStartResult(
  args: ApplyCommandResultSideEffectsArgs<"thread.start">,
): CommandResultSideEffectsResult {
  const thread = getThread(args.deps.db, args.command.threadId);
  if (!thread) {
    return emptyCommandResultSideEffects();
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
    return handleThreadCommandFailure(args.deps, args.command, args.report);
  }

  if (
    !hasActiveThreadStartOperationForCommand(args.deps, {
      commandId: args.commandRow.id,
    })
  ) {
    return emptyCommandResultSideEffects();
  }

  completeThreadStartForCommand(args.deps, {
    commandId: args.commandRow.id,
  });
  if (thread.title && shouldSyncGeneratedThreadTitle(args.deps, thread.id)) {
    const queuedRename = queueThreadRenameCommandInTransaction(args.deps.db, {
      environment: {
        id: args.command.environmentId,
        hostId: args.commandRow.hostId,
      },
      providerId: thread.providerId,
      threadId: thread.id,
      title: thread.title,
    });
    if (queuedRename) {
      args.deps.hub.notifyCommand(args.commandRow.hostId);
    }
  }
  return emptyCommandResultSideEffects();
}

function handleThreadStopResult(
  args: ApplyCommandResultSideEffectsArgs<"thread.stop">,
): CommandResultSideEffectsResult {
  const postCommitActions: CommandResultPostCommitAction[] = [];
  if (
    !hasActiveThreadStopOperationForCommand(args.deps, {
      commandId: args.commandRow.id,
    })
  ) {
    return emptyCommandResultSideEffects();
  }
  if (!args.report.ok) {
    failThreadStopForCommand(args.deps, {
      commandId: args.commandRow.id,
      failureReason: args.report.errorMessage,
    });
    return emptyCommandResultSideEffects();
  }

  finalizeStoppedThreadInTransaction(args.deps, {
    cancelPendingCommand: false,
    expectedCommandId: args.commandRow.id,
    threadId: args.command.threadId,
  });
  postCommitActions.push({
    name: "Provider archive forwarding after thread stop",
    context: {
      environmentId: args.command.environmentId,
      threadId: args.command.threadId,
    },
    run: (deps) => {
      queueSettledArchivedThreadProviderArchiveCommand(deps, {
        threadId: args.command.threadId,
      });
    },
  });
  postCommitActions.push({
    name: "Environment cleanup advance after thread stop",
    context: {
      environmentId: args.command.environmentId,
      threadId: args.command.threadId,
    },
    run: (deps) =>
      runEnvironmentCleanupAdvance(deps, {
        environmentId: args.command.environmentId,
      }),
  });
  return { postCommitActions };
}

function handleInteractiveResolveResult(
  args: ApplyCommandResultSideEffectsArgs<"interactive.resolve">,
): void {
  if (!args.report.ok) {
    args.deps.pendingInteractions.interruptPendingInteractionInTransaction(
      args.deps,
      {
        interactionId: args.command.interactionId,
        reason: args.report.errorMessage,
      },
    );
    return;
  }

  const completed =
    args.deps.pendingInteractions.completeResolvingInteractionInTransaction(
      args.deps,
      {
        interactionId: args.command.interactionId,
        resolution: args.command.resolution,
      },
    );
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
  deps: Pick<CommandResultSettlementDeps, "hub">,
  command: WorkspaceMutationCommand,
  report: WorkspaceMutationResultReport,
): void {
  if (!report.ok) {
    return;
  }
  deps.hub.notifyEnvironment(command.environmentId, ["work-status-changed"]);
}

const commandResultOwners: CommandResultOwnerRegistry = {
  "environment.destroy": defineCommandResultOwner({
    applySideEffects: handleEnvironmentDestroyResult,
  }),
  "environment.provision": defineCommandResultOwner({
    applySideEffects: handleProvisionCommandResult,
  }),
  "host.file_metadata": null,
  "host.list_branches": null,
  "host.list_files": null,
  "host.list_paths": null,
  "host.read_file": null,
  "host.read_file_relative": null,
  "host.status_version": null,
  "codex.inference.complete": null,
  "interactive.resolve": defineCommandResultOwner({
    applySideEffects: handleInteractiveResolveResult,
  }),
  "provider.list": null,
  "provider.list_models": null,
  "replay.capture_delete": null,
  "replay.capture_get": null,
  "replay.capture_list": null,
  "replay.run": null,
  "thread.archive": null,
  "thread.deleted": null,
  "thread.rename": null,
  "thread.unarchive": null,
  "thread.start": defineCommandResultOwner({
    applySideEffects: handleThreadStartResult,
  }),
  "thread.stop": defineCommandResultOwner({
    applySideEffects: handleThreadStopResult,
  }),
  "turn.submit": defineCommandResultOwner({
    applySideEffects: ({ deps, command, report }) => {
      if (!report.ok) {
        return handleThreadCommandFailure(deps, command, report);
      }
      return emptyCommandResultSideEffects();
    },
  }),
  "codex.voice.transcribe": null,
  "workspace.commit": defineCommandResultOwner({
    applySideEffects: ({ deps, command, report }) => {
      handleWorkspaceMutationResult(deps, command, report);
    },
  }),
  "workspace.diff": null,
  "workspace.squash_merge": defineCommandResultOwner({
    applySideEffects: ({ deps, command, report }) => {
      handleWorkspaceMutationResult(deps, command, report);
    },
  }),
  "workspace.status": null,
};

export function handleCommandResultSideEffects(
  deps: CommandResultSettlementDeps,
  report: CommandResultSideEffectReport,
  commandRow: HostDaemonCommandRow,
): CommandResultSideEffectsResult {
  const command = parseCommand(commandRow);
  if (!reportMatchesCommandType(command, report)) {
    return emptyCommandResultSideEffects();
  }
  return (
    getCommandResultOwner(command)?.applySideEffects?.({
      deps,
      report,
      command,
      commandRow,
    }) ?? emptyCommandResultSideEffects()
  );
}
