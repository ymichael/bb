import { and, desc, eq, or } from "drizzle-orm";
import {
  applyProvisionedEnvironment,
  deleteThread,
  events,
  getEnvironment,
  getEnvironmentOperationByCommandId,
  getHost,
  getThread,
  getThreadOperationByCommandId,
  hostDaemonCommands,
  markEnvironmentOperationCompleted,
  markEnvironmentOperationFailed,
  markEnvironmentDestroyed,
  threads,
  requestEnvironmentCleanup,
  updateEnvironmentStatus,
} from "@bb/db";
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
} from "../services/thread-events.js";
import {
  completeThreadStart,
  failThreadStart,
  failThreadStop,
  finalizeStoppedThread,
  requestThreadStart,
} from "../services/thread-stop.js";
import {
  advanceEnvironmentCleanup,
} from "../services/environment-cleanup.js";
import { destroyEphemeralHostIfReady } from "../services/host-lifecycle.js";
import { tryTransition } from "../services/thread-transitions.js";

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

  const operation = getEnvironmentOperationByCommandId(deps.db, commandRow.id);
  const boundThreads = deps.db
    .select()
    .from(threads)
    .where(eq(threads.environmentId, command.environmentId))
    .all();

  if (report.ok) {
    if (operation?.state === "completed") {
      return;
    }

    applyProvisionedEnvironment(deps.db, deps.hub, command.environmentId, {
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
        const environmentId = thread.environmentId;
        deleteThread(deps.db, deps.hub, thread.id);
        if (environmentId !== null) {
          requestEnvironmentCleanup(deps.db, deps.hub, environmentId, {
            cleanupMode: "force",
          });
        }
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

    if (operation) {
      markEnvironmentOperationCompleted(deps.db, {
        environmentId: command.environmentId,
        kind: operation.kind,
      });
    }

    await advanceEnvironmentCleanup(deps, {
      environmentId: command.environmentId,
    });

    return;
  }

  if (operation?.state === "failed") {
    return;
  }

  updateEnvironmentStatus(deps.db, deps.hub, command.environmentId, {
    status: "error",
  });
  if (operation) {
    markEnvironmentOperationFailed(deps.db, {
      environmentId: command.environmentId,
      kind: operation.kind,
      failureReason: report.errorMessage,
    });
  }

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
  const operation = getEnvironmentOperationByCommandId(deps.db, commandRow.id);
  const environment = getEnvironment(deps.db, command.environmentId);

  if (!report.ok) {
    if (operation) {
      markEnvironmentOperationFailed(deps.db, {
        environmentId: command.environmentId,
        kind: operation.kind,
        failureReason: report.errorMessage,
      });
    }
    if (environment?.status === "destroying") {
      updateEnvironmentStatus(deps.db, deps.hub, command.environmentId, {
        status: environment.path ? "ready" : "error",
      });
    }
    return;
  }

  if (operation?.state === "completed") {
    return;
  }

  if (environment?.status !== "destroying") {
    return;
  }
  markEnvironmentDestroyed(deps.db, deps.hub, command.environmentId);
  if (operation) {
    markEnvironmentOperationCompleted(deps.db, {
      environmentId: command.environmentId,
      kind: operation.kind,
    });
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

  const operation = getThreadOperationByCommandId(deps.db, commandRow.id);
  if (!report.ok) {
    failThreadStart(deps, {
      threadId: command.threadId,
      failureReason: report.errorMessage,
    });
    return;
  }

  if (operation?.state === "completed") {
    return;
  }

  const thread = getThread(deps.db, command.threadId);
  if (!thread) {
    return;
  }

  completeThreadStart(deps, {
    threadId: thread.id,
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
  const operation = getThreadOperationByCommandId(deps.db, commandRow.id);

  if (!report.ok) {
    failThreadStop(deps, {
      threadId: command.threadId,
      failureReason: report.errorMessage,
    });
    return Promise.resolve();
  }

  if (operation?.state === "completed") {
    return Promise.resolve();
  }
  return finalizeStoppedThread(deps, {
    threadId: command.threadId,
    cancelPendingCommand: false,
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

export async function handleCommandResultSideEffects(
  deps: Pick<AppDeps, "config" | "db" | "hub" | "logger" | "sandboxRegistry">,
  report: HostDaemonCommandResultReport,
  commandRow: typeof hostDaemonCommands.$inferSelect,
): Promise<void> {
  switch (report.type) {
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
