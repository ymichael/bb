import { and, desc, eq, or } from "drizzle-orm";
import {
  applyProvisionedEnvironment,
  events,
  getEnvironment,
  getThread,
  hostDaemonCommands,
  threads,
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
  appendThreadInterruptedEvent,
} from "../services/thread-events.js";
import { queueThreadStartCommand } from "../services/thread-commands.js";
import { queueEnvironmentDestroyCommand } from "../services/environment-cleanup.js";
import { tryTransition } from "../services/thread-transitions.js";

function parseCommand(
  commandRow: typeof hostDaemonCommands.$inferSelect,
) {
  return hostDaemonCommandSchema.parse(JSON.parse(commandRow.payload));
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

  const environment = getEnvironment(deps.db, command.environmentId);
  const boundThreads = deps.db
    .select()
    .from(threads)
    .where(eq(threads.environmentId, command.environmentId))
    .all();

  if (report.ok) {
    const shouldDestroyAfterProvision = environment?.status === "destroying";
    applyProvisionedEnvironment(deps.db, deps.hub, command.environmentId, {
      path: report.result.path,
      status: shouldDestroyAfterProvision ? "destroying" : "ready",
      isGitRepo: report.result.isGitRepo,
      isWorktree: report.result.isWorktree,
      branchName: report.result.branchName,
      defaultBranch: report.result.defaultBranch,
    });

    if (shouldDestroyAfterProvision) {
      queueEnvironmentDestroyCommand(deps, {
        hostId: commandRow.hostId,
        id: command.environmentId,
        path: report.result.path,
        workspaceProvisionType: command.workspaceProvisionType,
      });
      return;
    }

    const cwdBranchEntries = buildCwdBranchEntries({
      path: report.result.path,
      branchName: report.result.branchName,
    });

    for (const thread of boundThreads) {
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

      if (thread.status === "created" || thread.status === "provisioning") {
        tryTransition(deps.db, deps.hub, thread.id, "idle");
      } else {
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

      await queueThreadStartCommand(deps, {
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
      tryTransition(deps.db, deps.hub, thread.id, "active");
    }

    return;
  }

  updateEnvironmentStatus(deps.db, deps.hub, command.environmentId, {
    status: "error",
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
}

function handleEnvironmentDestroyResult(
  deps: Pick<AppDeps, "db" | "hub">,
  report: Extract<HostDaemonCommandResultReport, { type: "environment.destroy" }>,
  commandRow: typeof hostDaemonCommands.$inferSelect,
): void {
  if (!report.ok) {
    return;
  }
  const command = parseCommand(commandRow);
  if (command.type !== "environment.destroy") {
    return;
  }
  const environment = getEnvironment(deps.db, command.environmentId);
  if (environment?.status !== "destroying") {
    return;
  }
  updateEnvironmentStatus(deps.db, deps.hub, command.environmentId, {
    status: "destroyed",
  });
}

function handleThreadStopResult(
  deps: Pick<AppDeps, "db" | "hub">,
  report: Extract<HostDaemonCommandResultReport, { type: "thread.stop" }>,
  commandRow: typeof hostDaemonCommands.$inferSelect,
): void {
  if (!report.ok) {
    return;
  }
  const command = parseCommand(commandRow);
  if (command.type !== "thread.stop") {
    return;
  }
  const thread = getThread(deps.db, command.threadId);
  if (!thread) {
    return;
  }
  if (thread.status === "active") {
    tryTransition(deps.db, deps.hub, thread.id, "idle");
  }
  appendThreadInterruptedEvent(deps, {
    threadId: thread.id,
    message: "Thread stopped by user request",
  });
}

export async function handleCommandResultSideEffects(
  deps: Pick<AppDeps, "db" | "hub">,
  report: HostDaemonCommandResultReport,
  commandRow: typeof hostDaemonCommands.$inferSelect,
): Promise<void> {
  switch (report.type) {
    case "environment.provision":
      await handleProvisionCommandResult(deps, report, commandRow);
      return;
    case "environment.destroy":
      handleEnvironmentDestroyResult(deps, report, commandRow);
      return;
    case "thread.stop":
      handleThreadStopResult(deps, report, commandRow);
      return;
    default:
      return;
  }
}
