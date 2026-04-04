import { and, eq, inArray, sql } from "drizzle-orm";
import {
  advanceManagerThreadNudgeAfterFire,
  advanceManagerThreadNudgeAfterFireInTransaction,
  type DbConnection,
  type DbTransaction,
  deleteManagerThreadNudge,
  type DueManagerThreadNudgeCursor,
  getActiveSession,
  getEnvironment,
  getThread,
  hostDaemonCommands,
  listDueManagerThreadNudges,
} from "@bb/db";
import type { PromptInput, ResolvedThreadExecutionOptions } from "@bb/domain";
import type { AppDeps } from "../types.js";
import {
  appendClientTurnEventInTransaction,
  getLastProviderThreadId,
} from "./thread-events.js";
import {
  addEventSequenceToTurnRunCommandPayload,
  buildExecutionOptions,
  prepareTurnRunCommandPayload,
  type PreparedTurnRunCommandPayload,
  queueTurnRunCommandInTransaction,
} from "./thread-commands.js";
import { computeNextScheduledTime } from "./schedule-helpers.js";
import { tryTransition } from "./thread-transitions.js";

const SCHEDULED_NUDGE_PREFIX = "[bb system] Scheduled nudge:";
const DUE_NUDGE_BATCH_SIZE = 100;
type DueManagerThreadNudgeRow = ReturnType<typeof listDueManagerThreadNudges>[number];

interface SweepDueNudgesArgs {
  now?: number;
}

interface PendingTurnRunCommandArgs {
  hostId: string;
  threadId: string;
}

interface NudgeSweepCache {
  environmentById: Map<string, ReturnType<typeof getEnvironment>>;
  pendingTurnRunByThreadId: Map<string, boolean>;
  providerThreadIdByThreadId: Map<string, string | null>;
}

function buildScheduledNudgeInput(name: string): PromptInput[] {
  return [
    {
      type: "text",
      text: `${SCHEDULED_NUDGE_PREFIX} ${name}. Check ASYNC.md.`,
    },
  ];
}

function advanceSkippedNudge(
  deps: Pick<AppDeps, "db" | "hub" | "logger">,
  args: {
    now: number;
    nudge: DueManagerThreadNudgeRow;
    reason: string;
  },
): void {
  const nextFireAt = computeNextScheduledTime({
    cron: args.nudge.cron,
    timezone: args.nudge.timezone,
    now: args.now,
  });
  const advanced = advanceManagerThreadNudgeAfterFire(deps.db, deps.hub, {
    nudgeId: args.nudge.id,
    expectedNextFireAt: args.nudge.nextFireAt,
    nextFireAt,
    projectId: args.nudge.projectId,
    now: args.now,
  });

  if (advanced) {
    deps.logger.info(
      {
        nudgeId: args.nudge.id,
        reason: args.reason,
        threadId: args.nudge.threadId,
      },
      "Skipped due manager nudge",
    );
  }
}

function createNudgeSweepCache(): NudgeSweepCache {
  return {
    environmentById: new Map(),
    pendingTurnRunByThreadId: new Map(),
    providerThreadIdByThreadId: new Map(),
  };
}

function hasPendingTurnRunCommand(
  db: DbConnection | DbTransaction,
  args: PendingTurnRunCommandArgs,
  cache?: NudgeSweepCache,
): boolean {
  const cached = cache?.pendingTurnRunByThreadId.get(args.threadId);
  if (cached !== undefined) {
    return cached;
  }

  const existing = db.select({ id: hostDaemonCommands.id })
    .from(hostDaemonCommands)
    .where(
      and(
        eq(hostDaemonCommands.hostId, args.hostId),
        eq(hostDaemonCommands.type, "turn.run"),
        inArray(hostDaemonCommands.state, ["pending", "fetched"]),
        sql`json_extract(${hostDaemonCommands.payload}, '$.threadId') = ${args.threadId}`,
      ),
    )
    .get();

  const hasPending = existing !== undefined;
  cache?.pendingTurnRunByThreadId.set(args.threadId, hasPending);
  return hasPending;
}

function getCachedEnvironment(
  db: DbConnection,
  cache: NudgeSweepCache,
  environmentId: string,
) {
  if (cache.environmentById.has(environmentId)) {
    return cache.environmentById.get(environmentId) ?? null;
  }
  const environment = getEnvironment(db, environmentId);
  cache.environmentById.set(environmentId, environment);
  return environment;
}

function getCachedProviderThreadId(
  deps: Pick<AppDeps, "db">,
  cache: NudgeSweepCache,
  threadId: string,
) {
  if (cache.providerThreadIdByThreadId.has(threadId)) {
    return cache.providerThreadIdByThreadId.get(threadId) ?? null;
  }
  const providerThreadId = getLastProviderThreadId(deps, threadId);
  cache.providerThreadIdByThreadId.set(threadId, providerThreadId);
  return providerThreadId;
}

function toDueManagerThreadNudgeCursor(
  nudge: DueManagerThreadNudgeRow,
): DueManagerThreadNudgeCursor {
  return {
    createdAt: nudge.createdAt,
    id: nudge.id,
    nextFireAt: nudge.nextFireAt,
  };
}

async function runNudge(
  deps: Pick<AppDeps, "db" | "hub" | "logger">,
  cache: NudgeSweepCache,
  nudge: DueManagerThreadNudgeRow,
  now: number,
): Promise<void> {
  const thread = getThread(deps.db, nudge.threadId);
  if (!thread || thread.archivedAt !== null || thread.deletedAt !== null) {
    deleteManagerThreadNudge(deps.db, deps.hub, nudge.id);
    return;
  }

  if (thread.status !== "idle") {
    advanceSkippedNudge(deps, {
      now,
      nudge,
      reason: "thread-not-idle",
    });
    return;
  }

  if (!thread.environmentId) {
    advanceSkippedNudge(deps, {
      now,
      nudge,
      reason: "thread-missing-environment",
    });
    return;
  }

  const environment = getCachedEnvironment(deps.db, cache, thread.environmentId);
  if (!environment || environment.status !== "ready" || !environment.path) {
    advanceSkippedNudge(deps, {
      now,
      nudge,
      reason: "environment-not-ready",
    });
    return;
  }

  const session = getActiveSession(deps.db, environment.hostId);
  if (!session) {
    advanceSkippedNudge(deps, {
      now,
      nudge,
      reason: "host-disconnected",
    });
    return;
  }

  const input = buildScheduledNudgeInput(nudge.name);
  const providerThreadId = getCachedProviderThreadId(deps, cache, thread.id);
  if (!providerThreadId) {
    advanceSkippedNudge(deps, {
      now,
      nudge,
      reason: "missing-provider-thread",
    });
    return;
  }

  if (hasPendingTurnRunCommand(deps.db, {
    hostId: environment.hostId,
    threadId: thread.id,
  }, cache)) {
    advanceSkippedNudge(deps, {
      now,
      nudge,
      reason: "pending-turn-run",
    });
    return;
  }

  let execution: ResolvedThreadExecutionOptions;
  let preparedCommand: PreparedTurnRunCommandPayload;
  try {
    execution = await buildExecutionOptions(
      deps,
      {},
      { threadId: thread.id },
      "client/turn/requested",
    );
    preparedCommand = await prepareTurnRunCommandPayload(deps, {
      environment: {
        id: environment.id,
        hostId: environment.hostId,
        path: environment.path,
        workspaceProvisionType: environment.workspaceProvisionType,
      },
      execution,
      input,
      providerThreadId,
      thread,
    });
  } catch (error) {
    deps.logger.warn(
      {
        err: error,
        nudgeId: nudge.id,
        threadId: thread.id,
      },
      "Skipping due manager nudge after runtime preparation failed",
    );
    advanceSkippedNudge(deps, {
      now,
      nudge,
      reason: "runtime-preparation-failed",
    });
    return;
  }

  const nextFireAt = computeNextScheduledTime({
    cron: nudge.cron,
    timezone: nudge.timezone,
    now,
  });
  let queuedCommand = false;
  let appendedEvent = false;
  let advancedWithoutQueue = false;

  deps.db.transaction((tx) => {
    if (hasPendingTurnRunCommand(tx, {
      hostId: environment.hostId,
      threadId: thread.id,
    })) {
      if (
        advanceManagerThreadNudgeAfterFireInTransaction(tx, {
          expectedNextFireAt: nudge.nextFireAt,
          nextFireAt,
          nudgeId: nudge.id,
          now,
        })
      ) {
        advancedWithoutQueue = true;
      }
      return;
    }

    if (
      !advanceManagerThreadNudgeAfterFireInTransaction(tx, {
        expectedNextFireAt: nudge.nextFireAt,
        nextFireAt,
        nudgeId: nudge.id,
        now,
      })
    ) {
      return;
    }

    const eventSequence = appendClientTurnEventInTransaction(tx, {
      threadId: thread.id,
      environmentId: environment.id,
      type: "client/turn/requested",
      input,
      execution,
      initiator: "system",
      requestMethod: "turn/start",
      source: "tell",
    });

    queueTurnRunCommandInTransaction(tx, {
      command: addEventSequenceToTurnRunCommandPayload({
        eventSequence,
        preparedCommand,
      }),
      hostId: environment.hostId,
      sessionId: session.id,
    });
    appendedEvent = true;
    queuedCommand = true;
  }, { behavior: "immediate" });

  if (advancedWithoutQueue) {
    cache.pendingTurnRunByThreadId.set(thread.id, true);
    deps.hub.notifyProject(nudge.projectId, ["nudges-changed"]);
    deps.logger.info(
      {
        nudgeId: nudge.id,
        reason: "pending-turn-run",
        threadId: thread.id,
      },
      "Skipped due manager nudge",
    );
    return;
  }

  if (!queuedCommand) {
    return;
  }

  cache.pendingTurnRunByThreadId.set(thread.id, true);
  deps.hub.notifyProject(nudge.projectId, ["nudges-changed"]);
  if (appendedEvent) {
    deps.hub.notifyThread(thread.id, ["events-appended"]);
  }
  deps.hub.notifyCommand(environment.hostId);
  tryTransition(deps.db, deps.hub, thread.id, "active");
}

export async function sweepDueNudges(
  deps: Pick<AppDeps, "db" | "hub" | "logger">,
  args: SweepDueNudgesArgs = {},
): Promise<void> {
  const now = args.now ?? Date.now();
  const cache = createNudgeSweepCache();
  let after: DueManagerThreadNudgeCursor | undefined;

  while (true) {
    const dueNudges = listDueManagerThreadNudges(deps.db, {
      now,
      after,
      limit: DUE_NUDGE_BATCH_SIZE,
    });
    for (const nudge of dueNudges) {
      try {
        await runNudge(deps, cache, nudge, now);
      } catch (error) {
        deps.logger.error(
          {
            err: error,
            nudgeId: nudge.id,
            threadId: nudge.threadId,
          },
          "Failed to process a due manager nudge",
        );
      }
    }
    if (dueNudges.length < DUE_NUDGE_BATCH_SIZE) {
      return;
    }
    after = toDueManagerThreadNudgeCursor(dueNudges[dueNudges.length - 1]!);
  }
}
