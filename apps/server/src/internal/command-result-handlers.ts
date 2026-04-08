import { and, desc, eq, or } from "drizzle-orm";
import {
  events,
  getEnvironment,
  getHost,
  getThread,
  hostDaemonCommands,
  threads,
} from "@bb/db";
import { applyProvisionedEnvironmentRecord } from "@bb/db/internal-lifecycle";
import {
  hostDaemonCommandSchema,
  type HostDaemonCommandResultReport,
} from "@bb/host-daemon-contract";
import type { AppDeps } from "../types.js";
import {
  appendProvisioningEvent,
  buildCwdBranchEntries,
  parseStoredTurnRequestEvent,
  appendSystemErrorEvent,
} from "../services/threads/thread-events.js";
import {
  completeThreadStartForCommand,
  failThreadStartForCommand,
  failThreadStopForCommand,
  finalizeStoppedThread,
  hasActiveThreadStartOperationForCommand,
  hasActiveThreadStopOperationForCommand,
  requestThreadStart,
} from "../services/threads/thread-lifecycle.js";
import {
  advanceEnvironmentCleanup,
  completeEnvironmentDestroyForCommand,
  failEnvironmentDestroyForCommand,
  hasActiveEnvironmentDestroyOperationForCommand,
} from "../services/environments/environment-cleanup.js";
import {
  completeEnvironmentProvisioningForCommand,
  failEnvironmentProvisioningForCommand,
  hasActiveEnvironmentProvisionOperationForCommand,
} from "../services/environments/environment-provisioning.js";
import { destroyEphemeralHostIfReady } from "../services/hosts/host-lifecycle.js";
import {
  completeSandboxRuntimeMaterialSyncForCommand,
  failSandboxRuntimeMaterialSyncForCommand,
  hasActiveSandboxRuntimeMaterialSyncOperationForCommand,
} from "../services/hosts/sandbox-runtime-material.js";
import { tryTransition } from "../services/threads/thread-transitions.js";

function parseCommand(
  commandRow: typeof hostDaemonCommands.$inferSelect,
) {
  return hostDaemonCommandSchema.parse(JSON.parse(commandRow.payload));
}

type ParsedHostDaemonCommand = ReturnType<typeof parseCommand>;
type WorkspaceMutationResultReport = Extract<
  HostDaemonCommandResultReport,
  {
    type:
      | "workspace.commit"
      | "workspace.squash_merge"
      | "workspace.promote"
      | "workspace.demote";
  }
>;
type EnvironmentScopedCommand = Extract<
  ParsedHostDaemonCommand,
  { environmentId: string }
>;
type WorkspaceMutationCommand = Extract<
  EnvironmentScopedCommand,
  {
    type: WorkspaceMutationResultReport["type"];
  }
>;

function isWorkspaceMutationCommand(
  command: ParsedHostDaemonCommand,
  expectedType: WorkspaceMutationResultReport["type"],
): command is WorkspaceMutationCommand {
  return "environmentId" in command && command.type === expectedType;
}
async function handleProvisionCommandResult(
  deps: Pick<AppDeps, "db" | "hub">,
  report: Extract<HostDaemonCommandResultReport, { type: "environment.provision" }>,
  commandRow: typeof hostDaemonCommands.$inferSelect,
): Promise<void> {
  const command = parseCommand(commandRow);
  if (command.type !== "environment.provision") {
    return;
  }

  if (!hasActiveEnvironmentProvisionOperationForCommand(deps, {
    commandId: commandRow.id,
  })) {
    return;
  }
  const boundThreads = deps.db
    .select()
    .from(threads)
    .where(eq(threads.environmentId, command.environmentId))
    .all();

  if (report.ok) {
    applyProvisionedEnvironmentRecord(deps.db, deps.hub, command.environmentId, {
      path: report.result.path,
      status: "ready",
      isGitRepo: report.result.isGitRepo,
      isWorktree: report.result.isWorktree,
      branchName: report.result.branchName,
      defaultBranch: report.result.defaultBranch,
    });
    deps.hub.notifyEnvironment(command.environmentId, ["work-status-changed"]);

    const cwdBranchEntries = buildCwdBranchEntries({
      path: report.result.path,
      branchName: report.result.branchName,
    });

    for (const thread of boundThreads) {
      if (thread.deletedAt !== null) {
        await finalizeStoppedThread(deps, { threadId: thread.id });
        continue;
      }

      if (thread.archivedAt !== null || thread.stopRequestedAt !== null) {
        continue;
      }

      const isInitiator = thread.id === command.initiator?.threadId;
      let entries = cwdBranchEntries;
      if (isInitiator && report.result.transcript.length > 0) {
        entries = report.result.transcript;
      }
      const completedEventSequence = appendProvisioningEvent(deps, {
        threadId: thread.id,
        environmentId: command.environmentId,
        status: "completed",
        entries,
      });

      if (thread.status !== "created" && thread.status !== "provisioning") {
        continue;
      }

      const startEvent = deps.db
        .select({
          data: events.data,
          sequence: events.sequence,
          threadId: events.threadId,
          type: events.type,
        })
        .from(events)
        .where(
          and(
            eq(events.threadId, thread.id),
            or(
              eq(events.type, "client/thread/start"),
              eq(events.type, "client/turn/requested"),
            ),
          ),
        )
        .orderBy(desc(events.sequence))
        .limit(1)
        .get();
      if (!startEvent) {
        continue;
      }

      const parsedStartEvent = parseStoredTurnRequestEvent({
        data: startEvent.data,
        sequence: startEvent.sequence,
        threadId: startEvent.threadId,
        type: startEvent.type,
      });
      if (!parsedStartEvent.input || parsedStartEvent.input.length === 0) {
        continue;
      }

      await requestThreadStart(deps, {
        thread,
        environment: {
          id: command.environmentId,
          hostId: commandRow.hostId,
          path: report.result.path,
          workspaceProvisionType: command.workspaceProvisionType,
        },
        eventSequence: completedEventSequence,
        input: parsedStartEvent.input,
        execution: parsedStartEvent.execution,
        projectId: thread.projectId,
        providerId: thread.providerId,
      });
    }

    completeEnvironmentProvisioningForCommand(deps, {
      commandId: commandRow.id,
    });

    await advanceEnvironmentCleanup(deps, {
      environmentId: command.environmentId,
    });

    return;
  }

  failEnvironmentProvisioningForCommand(deps, {
    commandId: commandRow.id,
    failureReason: report.errorMessage,
  });

  for (const thread of boundThreads) {
    appendProvisioningEvent(deps, {
      threadId: thread.id,
      environmentId: command.environmentId,
      status: "failed",
      entries: [
        {
          type: "step",
          key: "environment",
          text: report.errorMessage,
          status: "failed",
        },
      ],
    });
    appendSystemErrorEvent(deps, {
      threadId: thread.id,
      environmentId: command.environmentId,
      code: "thread_provisioning_failed",
      message: `Thread provisioning failed for project ${thread.projectId}`,
      detail: report.errorMessage,
    });
    tryTransition(deps.db, deps.hub, thread.id, "error");
  }

  await advanceEnvironmentCleanup(deps, {
    environmentId: command.environmentId,
  });
}

async function handleEnvironmentDestroyResult(
  deps: Pick<AppDeps, "config" | "db" | "hub" | "logger" | "sandboxRegistry">,
  report: Extract<HostDaemonCommandResultReport, { type: "environment.destroy" }>,
  commandRow: typeof hostDaemonCommands.$inferSelect,
): Promise<void> {
  const command = parseCommand(commandRow);
  if (command.type !== "environment.destroy") {
    return;
  }

  if (!hasActiveEnvironmentDestroyOperationForCommand(deps, {
    commandId: commandRow.id,
  })) {
    return;
  }
  const environment = getEnvironment(deps.db, command.environmentId);

  if (!report.ok) {
    failEnvironmentDestroyForCommand(deps, {
      commandId: commandRow.id,
      failureReason: report.errorMessage,
    });
    return;
  }

  if (!environment || environment.status !== "destroying") {
    return;
  }
  if (!completeEnvironmentDestroyForCommand(deps, {
    commandId: commandRow.id,
  })) {
    return;
  }

  const host = getHost(deps.db, environment.hostId);
  if (host?.type !== "ephemeral") {
    return;
  }

  try {
    await destroyEphemeralHostIfReady(deps, host.id);
  } catch (error) {
    deps.logger.warn(
      {
        environmentId: environment.id,
        err: error,
        hostId: host.id,
      },
      "Ephemeral sandbox host cleanup failed after environment destroy",
    );
  }
}

function handleThreadStartResult(
  deps: Pick<AppDeps, "db" | "hub">,
  report: Extract<HostDaemonCommandResultReport, { type: "thread.start" }>,
  commandRow: typeof hostDaemonCommands.$inferSelect,
): void {
  const command = parseCommand(commandRow);
  if (command.type !== "thread.start") {
    return;
  }

  if (!hasActiveThreadStartOperationForCommand(deps, {
    commandId: commandRow.id,
  })) {
    return;
  }
  if (!report.ok) {
    failThreadStartForCommand(deps, {
      commandId: commandRow.id,
      failureReason: report.errorMessage,
    });
    return;
  }

  const thread = getThread(deps.db, command.threadId);
  if (!thread) {
    return;
  }

  completeThreadStartForCommand(deps, {
    commandId: commandRow.id,
  });
}

function handleThreadStopResult(
  deps: Pick<AppDeps, "db" | "hub">,
  report: Extract<HostDaemonCommandResultReport, { type: "thread.stop" }>,
  commandRow: typeof hostDaemonCommands.$inferSelect,
): Promise<void> {
  const command = parseCommand(commandRow);
  if (command.type !== "thread.stop") {
    return Promise.resolve();
  }

  if (!hasActiveThreadStopOperationForCommand(deps, {
    commandId: commandRow.id,
  })) {
    return Promise.resolve();
  }

  if (!report.ok) {
    failThreadStopForCommand(deps, {
      commandId: commandRow.id,
      failureReason: report.errorMessage,
    });
    return Promise.resolve();
  }
  return finalizeStoppedThread(deps, {
    threadId: command.threadId,
    cancelPendingCommand: false,
    expectedCommandId: commandRow.id,
  }).then(() => undefined);
}

function handleThreadCommandFailure(
  deps: Pick<AppDeps, "db" | "hub">,
  report: HostDaemonCommandResultReport & { ok: false },
  commandRow: typeof hostDaemonCommands.$inferSelect,
): void {
  const command = parseCommand(commandRow);
  if (
    command.type !== "thread.start" &&
    command.type !== "turn.run" &&
    command.type !== "turn.steer"
  ) {
    return;
  }
  const thread = getThread(deps.db, command.threadId);
  if (!thread) {
    return;
  }
  if (thread.deletedAt !== null || thread.stopRequestedAt !== null) {
    return;
  }
  appendSystemErrorEvent(deps, {
    threadId: thread.id,
    environmentId: command.environmentId,
    code: "thread_command_failed",
    message: `Command ${report.type} failed`,
    detail: report.errorMessage,
  });
  tryTransition(deps.db, deps.hub, thread.id, "error");
}

function handleWorkspaceMutationResult(
  deps: Pick<AppDeps, "db" | "hub">,
  report: WorkspaceMutationResultReport,
  commandRow: typeof hostDaemonCommands.$inferSelect,
): void {
  if (!report.ok) {
    return;
  }
  const command = parseCommand(commandRow);
  if (!isWorkspaceMutationCommand(command, report.type)) {
    return;
  }
  // Keep mutation-triggered invalidation alongside passive file watching so
  // clients still refresh when the watcher is unavailable or misses a host-local
  // change burst.
  deps.hub.notifyEnvironment(command.environmentId, ["work-status-changed"]);
}

function handleSandboxRuntimeMaterialResult(
  deps: Pick<AppDeps, "db">,
  report: Extract<
    HostDaemonCommandResultReport,
    { type: "host.sync_runtime_material" }
  >,
  commandRow: typeof hostDaemonCommands.$inferSelect,
): void {
  if (!hasActiveSandboxRuntimeMaterialSyncOperationForCommand(deps, {
    commandId: commandRow.id,
  })) {
    return;
  }

  if (!report.ok) {
    failSandboxRuntimeMaterialSyncForCommand(deps, {
      commandId: commandRow.id,
      completedAt: report.completedAt,
      failureReason: report.errorMessage,
    });
    return;
  }

  completeSandboxRuntimeMaterialSyncForCommand(deps, {
    appliedVersion: report.result.appliedVersion,
    commandId: commandRow.id,
    completedAt: report.completedAt,
  });
}

export async function handleCommandResultSideEffects(
  deps: Pick<AppDeps, "config" | "db" | "hub" | "logger" | "sandboxRegistry">,
  report: HostDaemonCommandResultReport,
  commandRow: typeof hostDaemonCommands.$inferSelect,
): Promise<void> {
  switch (report.type) {
    case "host.sync_runtime_material":
      handleSandboxRuntimeMaterialResult(deps, report, commandRow);
      return;
    case "environment.provision":
      await handleProvisionCommandResult(deps, report, commandRow);
      return;
    case "environment.destroy":
      await handleEnvironmentDestroyResult(deps, report, commandRow);
      return;
    case "thread.stop":
      await handleThreadStopResult(deps, report, commandRow);
      return;
    case "thread.start":
      handleThreadStartResult(deps, report, commandRow);
      if (!report.ok) {
        handleThreadCommandFailure(deps, report, commandRow);
      }
      return;
    case "turn.run":
    case "turn.steer":
      if (!report.ok) {
        handleThreadCommandFailure(deps, report, commandRow);
      }
      return;
    case "workspace.commit":
    case "workspace.squash_merge":
    case "workspace.promote":
    case "workspace.demote":
      handleWorkspaceMutationResult(deps, report, commandRow);
      return;
    default:
      return;
  }
}
