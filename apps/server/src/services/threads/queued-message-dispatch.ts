import {
  getQueuedThreadMessage,
  getThread,
  listDueScheduledQueuedThreadMessages,
  listIdleThreadsWithQueuedMessages,
  listQueuedThreadMessagePluginWaitRefs,
  listQueuedThreadMessagesByWaitHolder,
  listQueuedThreadMessagesWaitingOnKind,
  listThreadIdsWithHostOfflineQueueWaits,
} from "@bb/db";
import {
  QUEUED_MESSAGE_PLUGIN_WAIT_HOLDER_PREFIX,
  type QueuedMessageWaitingOnKind,
} from "@bb/domain";
import type { LoggedPendingInteractionWorkSessionDeps } from "../../types.js";
import { deferAfterResponse } from "../lib/response-deferral.js";
import {
  isCommandTimeoutError,
  runtimeErrorLogFields,
} from "../lib/error-log-fields.js";
import { isDispatchRequeuedRecently } from "./dispatch-hooks.js";
import { recordQueuedMessageDrainFailure } from "./queue-drain-failure.js";
import { clearQueuedMessageWait } from "./queue-waits.js";
import {
  createAutomaticQueuedMessageGroupEligibility,
  releaseStaleQueuedMessageDispatchClaims,
  sendNextQueuedMessageIfPresent,
  sendQueuedMessage,
} from "./queued-messages.js";

export interface QueueWaitPluginDirectory {
  isPluginLoaded(pluginId: string): boolean;
}

export type QueuedMessageDispatchWake =
  | { kind: "thread-ready"; threadId: string }
  | { kind: "turn-started"; threadId: string }
  | { kind: "workspace-ready"; threadId: string }
  | { kind: "provisioning-ended"; threadId: string }
  | { kind: "interaction-settled"; threadId: string }
  | { kind: "host-connected"; hostId: string }
  | { kind: "time-reached"; now: number }
  | { kind: "plugin-recheck" }
  | { kind: "plugin-unregistered"; pluginId: string }
  | { kind: "idle-recovery"; now: number }
  | {
      kind: "orphaned-plugin-recovery";
      plugins: QueueWaitPluginDirectory;
    };

type QueueDispatchDeps = LoggedPendingInteractionWorkSessionDeps;

interface QueuedMessageDispatchRef {
  id: string;
  threadId: string;
}

type PreparedQueuedMessageDispatchWake = Exclude<
  QueuedMessageDispatchWake,
  { kind: "provisioning-ended" } | { kind: "host-connected" }
>;

const pendingPluginRechecks = new WeakSet<
  QueueDispatchDeps["lifecycleDedupers"]
>();

function clearThreadQueueWaitsOfKind(
  deps: Pick<QueueDispatchDeps, "db" | "hub">,
  args: { threadId: string; kind: QueuedMessageWaitingOnKind },
): number {
  const rows = listQueuedThreadMessagesWaitingOnKind(deps.db, args);
  for (const row of rows) {
    clearQueuedMessageWait(deps, {
      queuedMessageId: row.id,
      threadId: args.threadId,
    });
  }
  return rows.length;
}

function prepareQueuedMessageDispatchWake(
  deps: Pick<QueueDispatchDeps, "db" | "hub" | "logger">,
  wake: QueuedMessageDispatchWake,
): PreparedQueuedMessageDispatchWake[] {
  switch (wake.kind) {
    case "workspace-ready":
      return [wake];
    case "provisioning-ended":
      clearThreadQueueWaitsOfKind(deps, {
        threadId: wake.threadId,
        kind: "provisioning",
      });
      return [];
    case "host-connected": {
      const prepared: PreparedQueuedMessageDispatchWake[] = [];
      for (const threadId of listThreadIdsWithHostOfflineQueueWaits(
        deps.db,
        wake.hostId,
      )) {
        const cleared = clearThreadQueueWaitsOfKind(deps, {
          threadId,
          kind: "host-offline",
        });
        if (cleared > 0) {
          prepared.push({ kind: "thread-ready", threadId });
        }
      }
      return prepared;
    }
    default:
      return [wake];
  }
}

function dispatchWakeContext(
  wake: PreparedQueuedMessageDispatchWake,
): Record<string, number | string | undefined> {
  switch (wake.kind) {
    case "workspace-ready":
    case "thread-ready":
    case "turn-started":
    case "interaction-settled":
      return { threadId: wake.threadId, wake: wake.kind };
    case "idle-recovery":
      return { now: wake.now, wake: wake.kind };
    case "orphaned-plugin-recovery":
      return { wake: wake.kind };
    case "time-reached":
      return { now: wake.now, wake: wake.kind };
    case "plugin-recheck":
      return { wake: wake.kind };
    case "plugin-unregistered":
      return { pluginId: wake.pluginId, wake: wake.kind };
  }
}

function schedulePreparedQueuedMessageDispatch(
  deps: QueueDispatchDeps,
  wake: PreparedQueuedMessageDispatchWake,
): void {
  if (wake.kind === "plugin-recheck") {
    if (pendingPluginRechecks.has(deps.lifecycleDedupers)) return;
    pendingPluginRechecks.add(deps.lifecycleDedupers);
  }
  deferAfterResponse({
    config: deps.config,
    context: dispatchWakeContext(wake),
    logger: deps.logger,
    name: "Queued message dispatch",
    work: async () => {
      if (wake.kind === "plugin-recheck") {
        pendingPluginRechecks.delete(deps.lifecycleDedupers);
      }
      await executePreparedQueuedMessageDispatch(deps, wake);
    },
  });
}

export function requestQueuedMessageDispatch(
  deps: QueueDispatchDeps,
  wake: QueuedMessageDispatchWake,
): void {
  for (const prepared of prepareQueuedMessageDispatchWake(deps, wake)) {
    schedulePreparedQueuedMessageDispatch(deps, prepared);
  }
}

export async function runQueuedMessageDispatch(
  deps: QueueDispatchDeps,
  wake: QueuedMessageDispatchWake,
): Promise<void> {
  for (const prepared of prepareQueuedMessageDispatchWake(deps, wake)) {
    await executePreparedQueuedMessageDispatch(deps, prepared);
  }
}

async function executePreparedQueuedMessageDispatch(
  deps: QueueDispatchDeps,
  wake: PreparedQueuedMessageDispatchWake,
): Promise<void> {
  switch (wake.kind) {
    case "workspace-ready":
      await runWorkspaceReadyDispatch(deps, wake.threadId);
      return;
    case "thread-ready":
      await runThreadReadyDispatch(deps, wake.threadId);
      return;
    case "turn-started":
      await runTurnStartedDispatch(deps, wake.threadId);
      return;
    case "interaction-settled":
      await runInteractionSettledDispatch(deps, wake.threadId);
      return;
    case "plugin-recheck":
      await runPluginRecheckDispatch(deps);
      return;
    case "plugin-unregistered":
      await runPluginUnregisteredDispatch(deps, wake.pluginId);
      return;
    case "time-reached":
      await runDueScheduledDispatch(deps, wake.now);
      return;
    case "idle-recovery":
      releaseStaleQueuedMessageDispatchClaims(deps, wake.now);
      await runIdleThreadRecovery(deps);
      return;
    case "orphaned-plugin-recovery":
      await runOrphanedPluginWaitRecovery(deps, wake.plugins);
      return;
  }
}

async function runThreadReadyDispatch(
  deps: QueueDispatchDeps,
  threadId: string,
): Promise<void> {
  try {
    await deps.lifecycleDedupers.queuedMessageDispatch.run(
      threadId,
      async () => {
        await sendNextQueuedMessageIfPresent(deps, { threadId });
      },
    );
  } catch (error) {
    const log = isCommandTimeoutError(error)
      ? deps.logger.debug.bind(deps.logger)
      : deps.logger.warn.bind(deps.logger);
    log(
      { threadId, ...runtimeErrorLogFields(deps.config, error) },
      "Queued message dispatch failed",
    );
  }
}

async function runTurnStartedDispatch(
  deps: QueueDispatchDeps,
  threadId: string,
): Promise<void> {
  const turnStartingRows = listQueuedThreadMessagesWaitingOnKind(deps.db, {
    kind: "turn-starting",
    threadId,
  });
  const provisioningRows = listQueuedThreadMessagesWaitingOnKind(deps.db, {
    kind: "provisioning",
    threadId,
  });
  for (const row of provisioningRows) {
    clearQueuedMessageWait(deps, {
      queuedMessageId: row.id,
      threadId,
    });
  }
  const rows = [...turnStartingRows, ...provisioningRows].sort(
    (left, right) => {
      if (left.sortKey !== right.sortKey) {
        return left.sortKey < right.sortKey ? -1 : 1;
      }
      if (left.id === right.id) return 0;
      return left.id < right.id ? -1 : 1;
    },
  );
  for (const row of rows) {
    await attemptAutomaticQueuedMessage(deps, row, {
      now: Date.now(),
      respectRequeuePacing: false,
    });
  }
}

async function runWorkspaceReadyDispatch(
  deps: QueueDispatchDeps,
  threadId: string,
): Promise<void> {
  const thread = getThread(deps.db, threadId);
  if (thread?.status === "starting") return;
  const rows = listQueuedThreadMessagesWaitingOnKind(deps.db, {
    kind: "provisioning",
    threadId,
  });
  for (const row of rows) {
    clearQueuedMessageWait(deps, {
      queuedMessageId: row.id,
      threadId,
    });
  }
  for (const row of rows) {
    await attemptAutomaticQueuedMessage(deps, row, {
      now: Date.now(),
      respectRequeuePacing: false,
    });
  }
}

async function runInteractionSettledDispatch(
  deps: QueueDispatchDeps,
  threadId: string,
): Promise<void> {
  if (deps.pendingInteractions.hasPendingThreadInteraction(threadId)) return;
  const cleared = clearThreadQueueWaitsOfKind(deps, {
    threadId,
    kind: "interaction",
  });
  if (cleared > 0) {
    await runThreadReadyDispatch(deps, threadId);
  }
}

async function attemptAutomaticQueuedMessage(
  deps: QueueDispatchDeps,
  row: QueuedMessageDispatchRef,
  args: { now: number; respectRequeuePacing: boolean },
): Promise<void> {
  if (args.respectRequeuePacing && isDispatchRequeuedRecently(row.threadId))
    return;
  if (getQueuedThreadMessage(deps.db, row.id) === null) return;
  const thread = getThread(deps.db, row.threadId);
  if (!thread || thread.deletedAt !== null) return;
  try {
    await sendQueuedMessage(deps, {
      claimPolicy: {
        kind: "automatic",
        isGroupEligible: createAutomaticQueuedMessageGroupEligibility(deps, {
          now: args.now,
          thread,
        }),
      },
      mode: "auto",
      queuedMessageId: row.id,
      threadId: row.threadId,
    });
  } catch (error) {
    if (isCommandTimeoutError(error)) {
      deps.logger.debug(
        {
          queuedMessageId: row.id,
          threadId: row.threadId,
          ...runtimeErrorLogFields(deps.config, error),
        },
        "Queued message dispatch deferred by host timeout",
      );
      return;
    }
    recordQueuedMessageDrainFailure(deps, { error, row, thread });
    deps.logger.warn(
      {
        queuedMessageId: row.id,
        threadId: row.threadId,
        ...runtimeErrorLogFields(deps.config, error),
      },
      "Queued message dispatch failed",
    );
  }
}

async function runPluginRecheckDispatch(
  deps: QueueDispatchDeps,
): Promise<void> {
  const now = Date.now();
  for (const row of listQueuedThreadMessagePluginWaitRefs(deps.db)) {
    await attemptAutomaticQueuedMessage(deps, row, {
      now,
      respectRequeuePacing: true,
    });
  }
}

async function runPluginUnregisteredDispatch(
  deps: QueueDispatchDeps,
  pluginId: string,
): Promise<void> {
  const holder =
    `${QUEUED_MESSAGE_PLUGIN_WAIT_HOLDER_PREFIX}${pluginId}` as const;
  const threadIds = new Set<string>();
  for (const row of listQueuedThreadMessagesByWaitHolder(deps.db, holder)) {
    deps.logger.info(
      { queuedMessageId: row.id, pluginId, threadId: row.threadId },
      "Clearing a queue wait: its holding plugin was unregistered",
    );
    clearQueuedMessageWait(deps, {
      queuedMessageId: row.id,
      threadId: row.threadId,
    });
    threadIds.add(row.threadId);
  }
  await runThreadReadyDispatches(deps, threadIds);
}

async function runDueScheduledDispatch(
  deps: QueueDispatchDeps,
  now: number,
): Promise<void> {
  for (const row of listDueScheduledQueuedThreadMessages(deps.db, now)) {
    await attemptAutomaticQueuedMessage(deps, row, {
      now,
      respectRequeuePacing: true,
    });
  }
}

async function runIdleThreadRecovery(deps: QueueDispatchDeps): Promise<void> {
  for (const candidate of listIdleThreadsWithQueuedMessages(deps.db)) {
    await runThreadReadyDispatch(deps, candidate.threadId);
  }
}

async function runOrphanedPluginWaitRecovery(
  deps: QueueDispatchDeps,
  plugins: QueueWaitPluginDirectory,
): Promise<void> {
  const threadIds = new Set<string>();
  for (const row of listQueuedThreadMessagePluginWaitRefs(deps.db)) {
    const pluginId = row.waitHolder.slice(
      QUEUED_MESSAGE_PLUGIN_WAIT_HOLDER_PREFIX.length,
    );
    if (plugins.isPluginLoaded(pluginId)) continue;
    deps.logger.info(
      { queuedMessageId: row.id, pluginId, threadId: row.threadId },
      "Clearing a queue wait: its holding plugin is no longer running",
    );
    clearQueuedMessageWait(deps, {
      queuedMessageId: row.id,
      threadId: row.threadId,
    });
    threadIds.add(row.threadId);
  }
  await runThreadReadyDispatches(deps, threadIds);
}

async function runThreadReadyDispatches(
  deps: QueueDispatchDeps,
  threadIds: Iterable<string>,
): Promise<void> {
  for (const threadId of threadIds) {
    await runThreadReadyDispatch(deps, threadId);
  }
}
