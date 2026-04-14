import { eq } from "drizzle-orm";
import {
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
  appendThreadProvisioningEvent,
  appendSystemErrorEvent,
} from "../services/threads/thread-events.js";
import {
  completeThreadStartForCommand,
  failThreadStartForCommand,
  failThreadStopForCommand,
  finalizeStoppedThread,
  hasActiveThreadStartOperationForCommand,
  hasActiveThreadStopOperationForCommand,
} from "../services/threads/thread-lifecycle.js";
import {
  advanceEnvironmentCleanup,
  completeEnvironmentDestroyForCommand,
  failEnvironmentDestroyForCommand,
  hasActiveEnvironmentDestroyOperationForCommand,
} from "../services/environments/environment-cleanup.js";
import {
  completeEnvironmentProvisioningForCommand,
  failEnvironmentProvisioningDurably,
  hasActiveEnvironmentProvisionOperationForCommand,
} from "../services/environments/environment-provisioning.js";
import { destroyEphemeralHostIfReady } from "../services/hosts/host-lifecycle.js";
import {
  completeSandboxRuntimeMaterialSyncForCommand,
  failSandboxRuntimeMaterialSyncForCommand,
  hasActiveSandboxRuntimeMaterialSyncOperationForCommand,
} from "../services/hosts/sandbox-runtime-material-operation.js";
import {
  tryTransition,
} from "../services/threads/thread-transitions.js";
import { advanceThreadProvisioning } from "../services/threads/thread-provisioning.js";

export type CommandResultSideEffectsDeps = Pick<
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
type InteractiveResolveResultReport = Extract<
  HostDaemonCommandResultReport,
  { type: "interactive.resolve" }
>;
function isWorkspaceMutationCommand(
  command: ParsedHostDaemonCommand,
  expectedType: WorkspaceMutationResultReport["type"],
): command is WorkspaceMutationCommand {
  return "environmentId" in command && command.type === expectedType;
}

async function handleProvisionCommandResult(
  deps: CommandResultSideEffectsDeps,
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

    for (const thread of boundThreads) {
      if (thread.deletedAt !== null) {
        await finalizeStoppedThread(deps, { threadId: thread.id });
        continue;
      }

      if (thread.archivedAt !== null || thread.stopRequestedAt !== null) {
        continue;
      }

      await advanceThreadProvisioning(deps, {
        threadId: thread.id,
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

  await failEnvironmentProvisioningDurably(deps, {
    commandId: commandRow.id,
    environmentId: command.environmentId,
    failureReason: report.errorMessage,
    failureEntry: {
      type: "step",
      key: "workspace-failed",
      text: "Workspace setup failed",
      status: "failed",
      startedAt: commandRow.createdAt,
      metadata: { durationMs: Date.now() - commandRow.createdAt },
    },
  });
}

async function handleEnvironmentDestroyResult(
  deps: Pick<
    AppDeps,
    "config" | "db" | "hostLifecycle" | "hub" | "logger" | "sandboxRegistry"
  >,
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
  const thread = getThread(deps.db, command.threadId);
  if (!thread) {
    return;
  }

  if (!report.ok) {
    failThreadStartForCommand(deps, {
      commandId: commandRow.id,
      failureReason: report.errorMessage,
    });
    appendThreadProvisioningEvent(deps, {
      threadId: thread.id,
      environmentId: command.environmentId,
      status: "failed",
      entries: [
        {
          type: "step",
          key: "agent-session-failed",
          text: "Agent session failed",
          status: "failed",
          startedAt: commandRow.createdAt,
          metadata: { durationMs: Date.now() - commandRow.createdAt },
        },
      ],
    });
    return;
  }

  appendThreadProvisioningEvent(deps, {
    threadId: thread.id,
    environmentId: command.environmentId,
    status: "completed",
    entries: [
      {
        type: "step",
        key: "agent-session-completed",
        text: "Agent session ready",
        status: "completed",
        startedAt: commandRow.createdAt,
        metadata: { durationMs: Date.now() - commandRow.createdAt },
      },
    ],
  });

  completeThreadStartForCommand(deps, {
    commandId: commandRow.id,
  });
}

function handleThreadStopResult(
  deps: CommandResultSideEffectsDeps,
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

function handleInteractiveResolveResult(
  deps: CommandResultSideEffectsDeps,
  report: InteractiveResolveResultReport,
  commandRow: typeof hostDaemonCommands.$inferSelect,
): void {
  const command = parseCommand(commandRow);
  if (command.type !== "interactive.resolve") {
    return;
  }

  if (!report.ok) {
    deps.pendingInteractions.interruptPendingInteraction({
      interactionId: command.interactionId,
      reason: report.errorMessage,
    });
    return;
  }

  const completed = deps.pendingInteractions.completeResolvingInteraction({
    interactionId: command.interactionId,
    resolution: command.resolution,
  });
  if (!completed) {
    deps.logger.info(
      {
        commandId: commandRow.id,
        interactionId: command.interactionId,
      },
      "Interactive resolve command result did not advance pending interaction",
    );
  }
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
  deps: CommandResultSideEffectsDeps,
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
    case "interactive.resolve":
      handleInteractiveResolveResult(deps, report, commandRow);
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
