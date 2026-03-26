import { and, desc, eq } from "drizzle-orm";
import {
  deleteEnvironment,
  events,
  getThread,
  hostDaemonCursors,
  hostDaemonCommands,
  threads,
  updateEnvironment,
} from "@bb/db";
import { turnRequestEventDataSchema } from "@bb/domain";
import {
  hostDaemonCommandSchema,
  type HostDaemonCommandResultReport,
} from "@bb/host-daemon-contract";
import type { AppDeps } from "../types.js";
import {
  appendProvisioningEvent,
  appendSystemErrorEvent,
  appendThreadInterruptedEvent,
} from "../services/thread-events.js";
import { queueThreadStartCommand } from "../services/thread-commands.js";
import { tryTransition } from "../services/thread-transitions.js";

function parseCommand(
  commandRow: typeof hostDaemonCommands.$inferSelect,
) {
  return hostDaemonCommandSchema.parse(JSON.parse(commandRow.payload));
}

export function advanceHostCursor(
  deps: Pick<AppDeps, "db" | "hub">,
  hostId: string,
): void {
  deps.db.transaction((tx) => {
    const currentCursor =
      tx
        .select({ cursor: hostDaemonCursors.cursor })
        .from(hostDaemonCursors)
        .where(eq(hostDaemonCursors.hostId, hostId))
        .get()?.cursor ?? 0;
    const rows = tx
      .select({
        cursor: hostDaemonCommands.cursor,
        state: hostDaemonCommands.state,
      })
      .from(hostDaemonCommands)
      .where(eq(hostDaemonCommands.hostId, hostId))
      .orderBy(hostDaemonCommands.cursor)
      .all();

    let nextCursor = currentCursor;
    for (const row of rows) {
      if (row.cursor !== nextCursor + 1) {
        continue;
      }
      if (row.state !== "success" && row.state !== "error") {
        break;
      }
      nextCursor = row.cursor;
    }

    if (nextCursor === currentCursor) {
      return;
    }

    const now = Date.now();
    const existing = tx
      .select({ hostId: hostDaemonCursors.hostId })
      .from(hostDaemonCursors)
      .where(eq(hostDaemonCursors.hostId, hostId))
      .get();
    if (existing) {
      tx.update(hostDaemonCursors)
        .set({ cursor: nextCursor, updatedAt: now })
        .where(eq(hostDaemonCursors.hostId, hostId))
        .run();
      return;
    }

    tx.insert(hostDaemonCursors)
      .values({
        hostId,
        cursor: nextCursor,
        updatedAt: now,
      })
      .run();
  });
}

function handleProvisionCommandResult(
  deps: Pick<AppDeps, "db" | "hub">,
  report: Extract<HostDaemonCommandResultReport, { type: "environment.provision" }>,
  commandRow: typeof hostDaemonCommands.$inferSelect,
): void {
  const command = parseCommand(commandRow);
  if (command.type !== "environment.provision") {
    return;
  }

  const boundThreads = deps.db
    .select()
    .from(threads)
    .where(eq(threads.environmentId, command.environmentId))
    .all();

  if (report.ok) {
    updateEnvironment(deps.db, deps.hub, command.environmentId, {
      path: report.result.path,
      status: "ready",
      isGitRepo: report.result.isGitRepo,
      isWorktree: report.result.isWorktree,
      branchName: report.result.branchName,
    });

    for (const thread of boundThreads) {
      appendProvisioningEvent(deps, {
        threadId: thread.id,
        environmentId: command.environmentId,
        status: "completed",
        entries: [
          {
            type: "step",
            key: "environment",
            text: `environment ready: ${report.result.path}`,
            status: "completed",
          },
        ],
      });

      if (thread.status === "created" || thread.status === "provisioning") {
        tryTransition(deps.db, deps.hub, thread.id, "idle");
      }

      const startEvent = deps.db
        .select({ data: events.data })
        .from(events)
        .where(
          and(
            eq(events.threadId, thread.id),
            eq(events.type, "client/thread/start"),
          ),
        )
        .orderBy(desc(events.sequence))
        .limit(1)
        .get();
      if (!startEvent) {
        continue;
      }

      const parsedStartEvent = turnRequestEventDataSchema.safeParse(
        JSON.parse(startEvent.data),
      );
      if (
        !parsedStartEvent.success ||
        !parsedStartEvent.data.input ||
        parsedStartEvent.data.input.length === 0
      ) {
        continue;
      }

      queueThreadStartCommand(deps, {
        thread,
        environment: {
          id: command.environmentId,
          hostId: commandRow.hostId,
          path: report.result.path,
        },
        input: parsedStartEvent.data.input,
        execution: parsedStartEvent.data.execution,
        projectId: thread.projectId,
        providerId: thread.providerId,
      });
      tryTransition(deps.db, deps.hub, thread.id, "active");
    }

    return;
  }

  updateEnvironment(deps.db, deps.hub, command.environmentId, {
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
    if (thread.status === "created" && !tryTransition(deps.db, deps.hub, thread.id, "provisioning")) {
      continue;
    }
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
  deleteEnvironment(deps.db, deps.hub, command.environmentId);
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

export function handleCommandResultSideEffects(
  deps: Pick<AppDeps, "db" | "hub">,
  report: HostDaemonCommandResultReport,
  commandRow: typeof hostDaemonCommands.$inferSelect,
): void {
  switch (report.type) {
    case "environment.provision":
      handleProvisionCommandResult(deps, report, commandRow);
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
