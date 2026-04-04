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
  hasPendingHostCommandForThread,
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

type NudgeThread = NonNullable<ReturnType<typeof getThread>>;
type NudgeEnvironment = NonNullable<ReturnType<typeof getEnvironment>>;

interface DeleteDueNudgePreparation {
  kind: "delete";
}

interface SkipDueNudgePreparation {
  kind: "skip";
  reason: string;
}

interface QueueDueNudgePreparation {
  environment: NudgeEnvironment;
  execution: ResolvedThreadExecutionOptions;
  input: PromptInput[];
  kind: "queue";
  preparedCommand: PreparedTurnRunCommandPayload;
  sessionId: string;
  thread: NudgeThread;
}

type DueNudgePreparation =
  | DeleteDueNudgePreparation
  | SkipDueNudgePreparation
  | QueueDueNudgePreparation;

interface PendingTurnRunNudgeResult {
  kind: "pending-turn-run";
}

interface QueuedNudgeResult {
  kind: "queued";
}

interface LostRaceNudgeResult {
  kind: "lost-race";
}

type QueueDueNudgeResult =
  | LostRaceNudgeResult
  | PendingTurnRunNudgeResult
  | QueuedNudgeResult;

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

  const hasPending = hasPendingHostCommandForThread(db, {
    hostId: args.hostId,
    threadId: args.threadId,
    type: "turn.run",
  });
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

async function prepareDueNudge(
  deps: Pick<AppDeps, "db" | "hub" | "logger">,
  cache: NudgeSweepCache,
  nudge: DueManagerThreadNudgeRow,
  now: number,
): Promise<DueNudgePreparation> {
  const thread = getThread(deps.db, nudge.threadId);
  if (!thread || thread.archivedAt !== null || thread.deletedAt !== null) {
    return { kind: "delete" };
  }

  if (thread.status !== "idle") {
    return {
      kind: "skip",
      reason: "thread-not-idle",
    };
  }

  if (!thread.environmentId) {
    return {
      kind: "skip",
      reason: "thread-missing-environment",
    };
  }

  const environment = getCachedEnvironment(deps.db, cache, thread.environmentId);
  if (!environment || environment.status !== "ready" || !environment.path) {
    return {
      kind: "skip",
      reason: "environment-not-ready",
    };
  }

  const session = getActiveSession(deps.db, environment.hostId);
  if (!session) {
    return {
      kind: "skip",
      reason: "host-disconnected",
    };
  }

  const input = buildScheduledNudgeInput(nudge.name);
  const providerThreadId = getCachedProviderThreadId(deps, cache, thread.id);
  if (!providerThreadId) {
    return {
      kind: "skip",
      reason: "missing-provider-thread",
    };
  }

  if (hasPendingTurnRunCommand(deps.db, {
    hostId: environment.hostId,
    threadId: thread.id,
  }, cache)) {
    return {
      kind: "skip",
      reason: "pending-turn-run",
    };
  }

  try {
    const execution = await buildExecutionOptions(
      deps,
      {},
      { threadId: thread.id },
      "client/turn/requested",
    );
    const preparedCommand = await prepareTurnRunCommandPayload(deps, {
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

    return {
      environment,
      execution,
      input,
      kind: "queue",
      preparedCommand,
      sessionId: session.id,
      thread,
    };
  } catch (error) {
    deps.logger.warn(
      {
        err: error,
        nudgeId: nudge.id,
        threadId: thread.id,
      },
      "Skipping due manager nudge after runtime preparation failed",
    );
    return {
      kind: "skip",
      reason: "runtime-preparation-failed",
    };
  }
}

function queueDueNudgeInTransaction(
  tx: DbTransaction,
  args: {
    nudge: DueManagerThreadNudgeRow;
    now: number;
    preparation: QueueDueNudgePreparation;
  },
): QueueDueNudgeResult {
  const nextFireAt = computeNextScheduledTime({
    cron: args.nudge.cron,
    timezone: args.nudge.timezone,
    now: args.now,
  });

  if (hasPendingTurnRunCommand(tx, {
    hostId: args.preparation.environment.hostId,
    threadId: args.preparation.thread.id,
  })) {
    const advanced = advanceManagerThreadNudgeAfterFireInTransaction(tx, {
      expectedNextFireAt: args.nudge.nextFireAt,
      nextFireAt,
      nudgeId: args.nudge.id,
      now: args.now,
    });

    return advanced
      ? { kind: "pending-turn-run" }
      : { kind: "lost-race" };
  }

  if (
    !advanceManagerThreadNudgeAfterFireInTransaction(tx, {
      expectedNextFireAt: args.nudge.nextFireAt,
      nextFireAt,
      nudgeId: args.nudge.id,
      now: args.now,
    })
  ) {
    return { kind: "lost-race" };
  }

  const eventSequence = appendClientTurnEventInTransaction(tx, {
    threadId: args.preparation.thread.id,
    environmentId: args.preparation.environment.id,
    type: "client/turn/requested",
    input: args.preparation.input,
    execution: args.preparation.execution,
    initiator: "system",
    requestMethod: "turn/start",
    source: "tell",
  });

  queueTurnRunCommandInTransaction(tx, {
    command: addEventSequenceToTurnRunCommandPayload({
      eventSequence,
      preparedCommand: args.preparation.preparedCommand,
    }),
    hostId: args.preparation.environment.hostId,
    sessionId: args.preparation.sessionId,
  });

  return { kind: "queued" };
}

async function runNudge(
  deps: Pick<AppDeps, "db" | "hub" | "logger">,
  cache: NudgeSweepCache,
  nudge: DueManagerThreadNudgeRow,
  now: number,
): Promise<void> {
  const preparation = await prepareDueNudge(deps, cache, nudge, now);
  if (preparation.kind === "delete") {
    deleteManagerThreadNudge(deps.db, deps.hub, nudge.id);
    return;
  }

  if (preparation.kind === "skip") {
    advanceSkippedNudge(deps, {
      now,
      nudge,
      reason: preparation.reason,
    });
    return;
  }

  const transactionResult = deps.db.transaction((tx) =>
    queueDueNudgeInTransaction(tx, {
      nudge,
      now,
      preparation,
    }), { behavior: "immediate" });

  if (transactionResult.kind === "lost-race") {
    return;
  }

  if (transactionResult.kind === "pending-turn-run") {
    cache.pendingTurnRunByThreadId.set(preparation.thread.id, true);
    deps.hub.notifyProject(nudge.projectId, ["nudges-changed"]);
    deps.logger.info(
      {
        nudgeId: nudge.id,
        reason: "pending-turn-run",
        threadId: preparation.thread.id,
      },
      "Skipped due manager nudge",
    );
    return;
  }

  cache.pendingTurnRunByThreadId.set(preparation.thread.id, true);
  deps.hub.notifyProject(nudge.projectId, ["nudges-changed"]);
  deps.hub.notifyThread(preparation.thread.id, ["events-appended"]);
  deps.hub.notifyCommand(preparation.environment.hostId);
  tryTransition(deps.db, deps.hub, preparation.thread.id, "active");
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
