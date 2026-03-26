import { and, desc, eq } from "drizzle-orm";
import {
  deleteEnvironment,
  events,
  getCursor,
  getThread,
  hostDaemonCommands,
  setCursor,
  threads,
  transitionThreadStatus,
  updateEnvironment,
} from "@bb/db";
import { turnRequestEventDataSchema } from "@bb/domain";
import type { HostDaemonCommandResultReport } from "@bb/host-daemon-contract";
import type { AppDeps } from "../types.js";
import {
  appendProvisioningEvent,
  appendSystemErrorEvent,
  appendThreadInterruptedEvent,
} from "../services/thread-events.js";
import { queueThreadStartCommand } from "../services/thread-commands.js";

interface CommandPayloadRecord {
  environmentId?: string;
  threadId?: string;
}

function parsePayload(payload: string): CommandPayloadRecord {
  return JSON.parse(payload) as CommandPayloadRecord;
}

export function advanceHostCursor(
  deps: Pick<AppDeps, "db" | "hub">,
  hostId: string,
): void {
  const currentCursor = getCursor(deps.db, deps.hub, hostId);
  const rows = deps.db
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

  if (nextCursor !== currentCursor) {
    setCursor(deps.db, deps.hub, hostId, nextCursor);
  }
}

function handleProvisionCommandResult(
  deps: Pick<AppDeps, "db" | "hub">,
  report: Extract<HostDaemonCommandResultReport, { type: "environment.provision" }>,
  commandRow: typeof hostDaemonCommands.$inferSelect,
): void {
  const payload = parsePayload(commandRow.payload);
  if (!payload.environmentId) {
    return;
  }

  const boundThreads = deps.db
    .select()
    .from(threads)
    .where(eq(threads.environmentId, payload.environmentId))
    .all();

  if (report.ok) {
    updateEnvironment(deps.db, deps.hub, payload.environmentId, {
      path: report.result.path,
      status: "ready",
      isGitRepo: report.result.isGitRepo,
      isWorktree: report.result.isWorktree,
      branchName: report.result.branchName,
    });

    for (const thread of boundThreads) {
      appendProvisioningEvent(deps, {
        threadId: thread.id,
        environmentId: payload.environmentId,
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

      try {
        if (thread.status === "created" || thread.status === "provisioning") {
          transitionThreadStatus(deps.db, deps.hub, thread.id, "idle");
        }
      } catch {
        // Ignore already-transitioned threads.
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

      const refreshedThread = getThread(deps.db, thread.id);
      if (!refreshedThread) {
        continue;
      }

      queueThreadStartCommand(deps, {
        thread: refreshedThread,
        environment: {
          id: payload.environmentId,
          hostId: commandRow.hostId,
          path: report.result.path,
        },
        input: parsedStartEvent.data.input,
        execution: parsedStartEvent.data.execution,
        projectId: refreshedThread.projectId,
        providerId: refreshedThread.providerId,
      });
      try {
        transitionThreadStatus(deps.db, deps.hub, thread.id, "active");
      } catch {
        // Ignore already-transitioned threads.
      }
    }

    return;
  }

  updateEnvironment(deps.db, deps.hub, payload.environmentId, {
    status: "error",
  });

  for (const thread of boundThreads) {
    appendProvisioningEvent(deps, {
      threadId: thread.id,
      environmentId: payload.environmentId,
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
      environmentId: payload.environmentId,
      code: "thread_provisioning_failed",
      message: `Thread provisioning failed for project ${thread.projectId}`,
      detail: report.errorMessage,
    });
    try {
      if (thread.status === "created") {
        transitionThreadStatus(deps.db, deps.hub, thread.id, "provisioning");
      }
      transitionThreadStatus(deps.db, deps.hub, thread.id, "error");
    } catch {
      // Ignore invalid transitions caused by concurrent updates.
    }
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
  const payload = parsePayload(commandRow.payload);
  if (!payload.environmentId) {
    return;
  }
  deleteEnvironment(deps.db, deps.hub, payload.environmentId);
}

function handleThreadStopResult(
  deps: Pick<AppDeps, "db" | "hub">,
  report: Extract<HostDaemonCommandResultReport, { type: "thread.stop" }>,
  commandRow: typeof hostDaemonCommands.$inferSelect,
): void {
  if (!report.ok) {
    return;
  }
  const payload = parsePayload(commandRow.payload);
  if (!payload.threadId) {
    return;
  }
  const thread = getThread(deps.db, payload.threadId);
  if (!thread) {
    return;
  }
  if (thread.status === "active") {
    try {
      transitionThreadStatus(deps.db, deps.hub, thread.id, "idle");
    } catch {
      // Ignore invalid transitions caused by concurrent provider events.
    }
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
