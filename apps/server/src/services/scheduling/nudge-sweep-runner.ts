import {
  advanceManagerThreadNudgeAfterFire,
  advanceManagerThreadNudgeAfterFireInTransaction,
  type DbConnection,
  type DbTransaction,
  deleteManagerThreadNudge,
  type DueManagerThreadNudgeCursor,
  getActiveStoredTurnId,
  getEnvironment,
  getThread,
  hasPendingHostCommandForThread,
  listDueManagerThreadNudges,
} from "@bb/db";
import type {
  PromptInput,
  ResolvedThreadExecutionOptions,
  TurnRequestTarget,
} from "@bb/domain";
import type { TurnSubmitTarget } from "@bb/host-daemon-contract";
import type { AppDeps, LoggedWorkSessionDeps } from "../../types.js";
import {
  appendClientTurnEventInTransaction,
  getActiveTurnId,
  getLastProviderThreadId,
} from "../threads/thread-events.js";
import {
  addRequestIdToTurnSubmitCommandPayload,
  buildExecutionOptions,
  prepareTurnSubmitCommandPayload,
  type PreparedTurnSubmitCommandPayload,
  queueTurnSubmitCommandInTransaction,
} from "../threads/thread-commands.js";
import { resolvePermissionEscalation } from "../threads/thread-runtime-config.js";
import { ensureHostSessionReadyForWork } from "../hosts/host-lifecycle.js";
import {
  computeNextScheduledTimeForExpressionSet,
  ScheduleValidationError,
} from "./schedule-helpers.js";
import { tryTransition } from "../threads/thread-transitions.js";
import { renderTemplate } from "@bb/templates";
import {
  type ManagerDynamicFileDeliveryStateUpdate,
  prependManagerPreferencesSystemMessageIfChanged,
  recordManagerDynamicFileDeliveryInTransaction,
  withManagerPreferencesDeliveryThreadIdLock,
} from "../threads/manager-dynamic-file-delivery.js";

export const DUE_NUDGE_BATCH_SIZE = 100;
export type DueManagerThreadNudgeRow = ReturnType<
  typeof listDueManagerThreadNudges
>[number];

interface PendingTurnSubmitCommandArgs {
  hostId: string;
  threadId: string;
}

export interface NudgeSweepCache {
  environmentById: Map<string, ReturnType<typeof getEnvironment>>;
  pendingTurnSubmitByThreadId: Map<string, boolean>;
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
  preparedCommand: PreparedTurnSubmitCommandPayload;
  sessionId: string;
  stateUpdate: ManagerDynamicFileDeliveryStateUpdate | null;
  targetIntent: NudgeTurnTargetIntent;
  thread: NudgeThread;
}

type DueNudgePreparation =
  | DeleteDueNudgePreparation
  | SkipDueNudgePreparation
  | QueueDueNudgePreparation;

interface StartNudgeTurnTargetIntent {
  kind: "start";
}

interface AutoNudgeTurnTargetIntent {
  expectedTurnId: string | null;
  kind: "auto";
}

type NudgeTurnTargetIntent =
  | AutoNudgeTurnTargetIntent
  | StartNudgeTurnTargetIntent;

interface BuildNudgeTurnTargetIntentArgs {
  expectedTurnId: string | null;
  thread: NudgeThread;
}

interface IsNudgePreparationCurrentArgs {
  preparation: QueueDueNudgePreparation;
}

interface PendingTurnSubmitNudgeResult {
  kind: "pending-turn-submit";
}

interface QueuedNudgeResult {
  kind: "queued";
}

interface LostRaceNudgeResult {
  kind: "lost-race";
}

type QueueDueNudgeResult =
  | LostRaceNudgeResult
  | PendingTurnSubmitNudgeResult
  | QueuedNudgeResult;

function buildScheduledNudgeInput(name: string): PromptInput[] {
  return [
    {
      type: "text",
      text: renderTemplate("systemMessageScheduledNudge", { name }),
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
  let nextFireAt: number;
  try {
    nextFireAt = computeNextScheduledTimeForExpressionSet({
      expressionSet: args.nudge.cron,
      now: args.now,
      timezone: args.nudge.timezone,
    });
  } catch (error) {
    if (error instanceof ScheduleValidationError) {
      deleteManagerThreadNudge(deps.db, deps.hub, args.nudge.id);
      deps.logger.warn(
        {
          nudgeId: args.nudge.id,
          reason: error.message,
          threadId: args.nudge.threadId,
        },
        "Deleted manager nudge with invalid stored schedule",
      );
      return;
    }
    throw error;
  }
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

function computeNextFireAt(
  nudge: DueManagerThreadNudgeRow,
  now: number,
): number {
  return computeNextScheduledTimeForExpressionSet({
    expressionSet: nudge.cron,
    now,
    timezone: nudge.timezone,
  });
}

function canQueueNudgeForThread(thread: NudgeThread): boolean {
  return thread.status === "idle" || thread.status === "active";
}

function buildNudgeTurnTargetIntent(
  args: BuildNudgeTurnTargetIntentArgs,
): NudgeTurnTargetIntent {
  if (args.thread.status === "active") {
    return {
      kind: "auto",
      expectedTurnId: args.expectedTurnId,
    };
  }

  return { kind: "start" };
}

function renderNudgeTurnSubmitTarget(
  intent: NudgeTurnTargetIntent,
): TurnSubmitTarget {
  switch (intent.kind) {
    case "start":
      return { mode: "start" };
    case "auto":
      return {
        mode: "auto",
        expectedTurnId: intent.expectedTurnId,
      };
  }
}

function renderNudgeTurnRequestTarget(
  intent: NudgeTurnTargetIntent,
): TurnRequestTarget {
  switch (intent.kind) {
    case "start":
      return { kind: "new-turn" };
    case "auto":
      return {
        kind: "auto",
        expectedTurnId: intent.expectedTurnId,
      };
  }
}

function nudgeTurnTargetIntentsEqual(
  left: NudgeTurnTargetIntent,
  right: NudgeTurnTargetIntent,
): boolean {
  switch (left.kind) {
    case "start":
      return right.kind === "start";
    case "auto":
      return (
        right.kind === "auto" && right.expectedTurnId === left.expectedTurnId
      );
  }
}

function isNudgePreparationCurrent(
  tx: DbTransaction,
  args: IsNudgePreparationCurrentArgs,
): boolean {
  const latestThread = getThread(tx, args.preparation.thread.id);
  if (
    !latestThread ||
    latestThread.archivedAt !== null ||
    latestThread.deletedAt !== null ||
    latestThread.environmentId !== args.preparation.environment.id ||
    !canQueueNudgeForThread(latestThread)
  ) {
    return false;
  }

  const expectedTurnId =
    latestThread.status === "active"
      ? getActiveStoredTurnId(tx, latestThread.id)
      : null;
  const currentTargetIntent = buildNudgeTurnTargetIntent({
    expectedTurnId,
    thread: latestThread,
  });

  return nudgeTurnTargetIntentsEqual(
    args.preparation.targetIntent,
    currentTargetIntent,
  );
}

export function createNudgeSweepCache(): NudgeSweepCache {
  return {
    environmentById: new Map(),
    pendingTurnSubmitByThreadId: new Map(),
    providerThreadIdByThreadId: new Map(),
  };
}

export function resetNudgeSweepBatchCache(cache: NudgeSweepCache): void {
  cache.pendingTurnSubmitByThreadId.clear();
}

function hasPendingTurnSubmitCommand(
  db: DbConnection | DbTransaction,
  args: PendingTurnSubmitCommandArgs,
  cache?: NudgeSweepCache,
): boolean {
  const cached = cache?.pendingTurnSubmitByThreadId.get(args.threadId);
  if (cached !== undefined) {
    return cached;
  }

  const hasPending = hasPendingHostCommandForThread(db, {
    hostId: args.hostId,
    threadId: args.threadId,
    type: "turn.submit",
  });
  cache?.pendingTurnSubmitByThreadId.set(args.threadId, hasPending);
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

export function toDueManagerThreadNudgeCursor(
  nudge: DueManagerThreadNudgeRow,
): DueManagerThreadNudgeCursor {
  return {
    createdAt: nudge.createdAt,
    id: nudge.id,
    nextFireAt: nudge.nextFireAt,
  };
}

async function prepareDueNudge(
  deps: LoggedWorkSessionDeps,
  cache: NudgeSweepCache,
  nudge: DueManagerThreadNudgeRow,
  now: number,
): Promise<DueNudgePreparation> {
  const thread = getThread(deps.db, nudge.threadId);
  if (!thread || thread.archivedAt !== null || thread.deletedAt !== null) {
    return { kind: "delete" };
  }

  if (!canQueueNudgeForThread(thread)) {
    return {
      kind: "skip",
      reason: "thread-not-runnable",
    };
  }

  if (!thread.environmentId) {
    return {
      kind: "skip",
      reason: "thread-missing-environment",
    };
  }

  const environment = getCachedEnvironment(
    deps.db,
    cache,
    thread.environmentId,
  );
  if (!environment || environment.status !== "ready" || !environment.path) {
    return {
      kind: "skip",
      reason: "environment-not-ready",
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

  if (
    hasPendingTurnSubmitCommand(
      deps.db,
      {
        hostId: environment.hostId,
        threadId: thread.id,
      },
      cache,
    )
  ) {
    return {
      kind: "skip",
      reason: "pending-turn-submit",
    };
  }

  if (
    hasPendingHostCommandForThread(deps.db, {
      hostId: environment.hostId,
      threadId: thread.id,
      type: "thread.archive",
    })
  ) {
    return {
      kind: "skip",
      reason: "pending-native-archive",
    };
  }

  try {
    const session = await ensureHostSessionReadyForWork(deps, {
      hostId: environment.hostId,
    });
    const execution = await buildExecutionOptions(
      deps,
      {},
      { threadId: thread.id },
      "client/turn/requested",
    );
    const expectedTurnId =
      thread.status === "active" ? getActiveTurnId(deps, thread.id) : null;
    const targetIntent = buildNudgeTurnTargetIntent({
      expectedTurnId,
      thread,
    });
    const preparedInput = await prependManagerPreferencesSystemMessageIfChanged(
      deps,
      {
        hostId: environment.hostId,
        input,
        mode: "change-detection",
        thread,
      },
    );
    const preparedCommand = await prepareTurnSubmitCommandPayload(deps, {
      environment: {
        id: environment.id,
        hostId: environment.hostId,
        path: environment.path,
        workspaceProvisionType: environment.workspaceProvisionType,
      },
      execution,
      permissionEscalation: resolvePermissionEscalation({
        thread,
        initiator: "system",
      }),
      input: preparedInput.input,
      providerThreadId,
      target: renderNudgeTurnSubmitTarget(targetIntent),
      thread,
    });

    return {
      environment,
      execution,
      input: preparedInput.input,
      kind: "queue",
      preparedCommand,
      sessionId: session.id,
      stateUpdate: preparedInput.stateUpdate,
      targetIntent,
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
    nextFireAt: number;
    preparation: QueueDueNudgePreparation;
  },
): QueueDueNudgeResult {
  if (
    hasPendingTurnSubmitCommand(tx, {
      hostId: args.preparation.environment.hostId,
      threadId: args.preparation.thread.id,
    })
  ) {
    const advanced = advanceManagerThreadNudgeAfterFireInTransaction(tx, {
      expectedNextFireAt: args.nudge.nextFireAt,
      nextFireAt: args.nextFireAt,
      nudgeId: args.nudge.id,
      now: args.now,
    });

    return advanced ? { kind: "pending-turn-submit" } : { kind: "lost-race" };
  }

  if (!isNudgePreparationCurrent(tx, { preparation: args.preparation })) {
    return { kind: "lost-race" };
  }

  if (
    hasPendingHostCommandForThread(tx, {
      hostId: args.preparation.environment.hostId,
      threadId: args.preparation.thread.id,
      type: "thread.archive",
    })
  ) {
    return { kind: "lost-race" };
  }

  if (
    !advanceManagerThreadNudgeAfterFireInTransaction(tx, {
      expectedNextFireAt: args.nudge.nextFireAt,
      nextFireAt: args.nextFireAt,
      nudgeId: args.nudge.id,
      now: args.now,
    })
  ) {
    return { kind: "lost-race" };
  }

  const request = appendClientTurnEventInTransaction(tx, {
    threadId: args.preparation.thread.id,
    environmentId: args.preparation.environment.id,
    type: "client/turn/requested",
    input: args.preparation.input,
    execution: args.preparation.execution,
    initiator: "system",
    senderThreadId: null,
    requestMethod: "turn/start",
    source: "tell",
    target: renderNudgeTurnRequestTarget(args.preparation.targetIntent),
  });
  recordManagerDynamicFileDeliveryInTransaction(
    tx,
    args.preparation.stateUpdate,
  );

  queueTurnSubmitCommandInTransaction(tx, {
    command: addRequestIdToTurnSubmitCommandPayload({
      requestId: request.requestId,
      preparedCommand: args.preparation.preparedCommand,
    }),
    hostId: args.preparation.environment.hostId,
    sessionId: args.preparation.sessionId,
  });

  return { kind: "queued" };
}

async function runDueNudgeWithPreferencesLockHeld(
  deps: LoggedWorkSessionDeps,
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

  let nextFireAt: number;
  try {
    nextFireAt = computeNextFireAt(nudge, now);
  } catch (error) {
    if (error instanceof ScheduleValidationError) {
      deleteManagerThreadNudge(deps.db, deps.hub, nudge.id);
      deps.logger.warn(
        {
          nudgeId: nudge.id,
          reason: error.message,
          threadId: nudge.threadId,
        },
        "Deleted manager nudge with invalid stored schedule",
      );
      return;
    }
    throw error;
  }

  const transactionResult = deps.db.transaction(
    (tx) =>
      queueDueNudgeInTransaction(tx, {
        nudge,
        now,
        nextFireAt,
        preparation,
      }),
    { behavior: "immediate" },
  );

  if (transactionResult.kind === "lost-race") {
    return;
  }

  if (transactionResult.kind === "pending-turn-submit") {
    cache.pendingTurnSubmitByThreadId.set(preparation.thread.id, true);
    deps.hub.notifyProject(nudge.projectId, ["nudges-changed"]);
    deps.logger.info(
      {
        nudgeId: nudge.id,
        reason: "pending-turn-submit",
        threadId: preparation.thread.id,
      },
      "Skipped due manager nudge",
    );
    return;
  }

  cache.pendingTurnSubmitByThreadId.set(preparation.thread.id, true);
  deps.hub.notifyProject(nudge.projectId, ["nudges-changed"]);
  deps.hub.notifyThread(preparation.thread.id, ["events-appended"], {
    eventTypes: ["client/turn/requested"],
  });
  deps.hub.notifyCommand(preparation.environment.hostId);
  tryTransition(deps.db, deps.hub, preparation.thread.id, "active");
}

export async function runDueNudge(
  deps: LoggedWorkSessionDeps,
  cache: NudgeSweepCache,
  nudge: DueManagerThreadNudgeRow,
  now: number,
): Promise<void> {
  await withManagerPreferencesDeliveryThreadIdLock(
    { threadId: nudge.threadId },
    () => runDueNudgeWithPreferencesLockHeld(deps, cache, nudge, now),
  );
}
