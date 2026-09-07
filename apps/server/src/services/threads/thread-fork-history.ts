import {
  copyStoredThreadEventsInTransaction,
  findLastCompletedRootStoredTurn,
  findLastRootStoredTurnStarted,
  listStoredEventRows,
  listStoredTurnCompletedRowsByTurnIds,
  type StoredEventRow,
} from "@bb/db";
import type { Thread, ThreadEvent, ThreadEventType } from "@bb/domain";
import type { AppDeps } from "../../types.js";
import { ApiError } from "../../errors.js";
import { parseStoredEvent } from "./thread-data.js";
import {
  getLastProviderThreadId,
  parseStoredTurnRequestEvent,
} from "./thread-events.js";
import { resolveTurnProviderCheckpointId } from "./thread-edit-message.js";
import type { ThreadForkDescriptor } from "./thread-provisioning-context.js";

export interface ThreadForkPoint {
  descriptor: ThreadForkDescriptor;
  historyEndSequence: number | null;
  sourceThreadId: string;
}

function forkPointUnavailable(message: string): never {
  throw new ApiError(400, "fork_source_session_unavailable", message);
}

interface StoredTurnCompletion {
  event: Extract<ThreadEvent, { type: "turn/completed" }>;
  sequence: number;
}

function readTurnCompletion(
  deps: Pick<AppDeps, "db">,
  args: { threadId: string; turnId: string },
): StoredTurnCompletion | null {
  const row = listStoredTurnCompletedRowsByTurnIds(deps.db, {
    threadId: args.threadId,
    turnIds: [args.turnId],
  }).at(-1);
  if (row === undefined) {
    return null;
  }
  const event = parseStoredEvent(row);
  if (event.type !== "turn/completed") {
    throw new Error(`Expected turn/completed event #${row.sequence}`);
  }
  return { event, sequence: row.sequence };
}

function resolveCheckpointForkDescriptor(args: {
  completion: StoredTurnCompletion;
  providerId: string;
  turnId: string;
}): ThreadForkDescriptor | null {
  if (args.completion.event.providerThreadId === null) {
    return null;
  }
  const sourceProviderCheckpointId = resolveTurnProviderCheckpointId({
    providerCheckpointId: args.completion.event.providerCheckpointId,
    providerId: args.providerId,
    turnId: args.turnId,
  });
  if (sourceProviderCheckpointId === null) {
    return null;
  }
  return {
    sourceProviderThreadId: args.completion.event.providerThreadId,
    sourceProviderCheckpointId,
  };
}

function resolveAnchoredForkPoint(
  deps: Pick<AppDeps, "db" | "providerRegistry">,
  args: { sourceSeqEnd: number; sourceThread: Thread },
): ThreadForkPoint {
  const anchor = findLastRootStoredTurnStarted(deps.db, {
    atOrBeforeSequence: args.sourceSeqEnd,
    threadId: args.sourceThread.id,
  });
  if (anchor === null) {
    forkPointUnavailable(
      `Cannot fork at sequence ${args.sourceSeqEnd}: no turn has started at or before it`,
    );
  }
  const completion = readTurnCompletion(deps, {
    threadId: args.sourceThread.id,
    turnId: anchor.turnId,
  });
  if (completion === null) {
    forkPointUnavailable(
      `Cannot fork at sequence ${args.sourceSeqEnd}: the turn containing it has not completed`,
    );
  }
  if (completion.event.providerThreadId === null) {
    forkPointUnavailable(
      `Cannot fork at sequence ${args.sourceSeqEnd}: the turn containing it has no provider session`,
    );
  }
  const latestRootTurn = findLastRootStoredTurnStarted(deps.db, {
    threadId: args.sourceThread.id,
  });
  const anchorIsTip = latestRootTurn?.turnId === anchor.turnId;
  if (
    !deps.providerRegistry.supportsSessionRewind(args.sourceThread.providerId)
  ) {
    if (!anchorIsTip) {
      forkPointUnavailable(
        `Provider ${args.sourceThread.providerId} can only fork at the end of a session, not from an earlier point in it`,
      );
    }
    return {
      descriptor: {
        sourceProviderThreadId: completion.event.providerThreadId,
      },
      historyEndSequence: completion.sequence,
      sourceThreadId: args.sourceThread.id,
    };
  }
  const descriptor = resolveCheckpointForkDescriptor({
    completion,
    providerId: args.sourceThread.providerId,
    turnId: anchor.turnId,
  });
  if (descriptor === null) {
    forkPointUnavailable(
      `Cannot fork at sequence ${args.sourceSeqEnd}: the turn containing it recorded no provider checkpoint`,
    );
  }
  return {
    descriptor,
    historyEndSequence: completion.sequence,
    sourceThreadId: args.sourceThread.id,
  };
}

export function resolveThreadForkPoint(
  deps: Pick<AppDeps, "db" | "providerRegistry">,
  args: { sourceSeqEnd: number | undefined; sourceThread: Thread },
): ThreadForkPoint | null {
  if (args.sourceSeqEnd !== undefined) {
    return resolveAnchoredForkPoint(deps, {
      sourceSeqEnd: args.sourceSeqEnd,
      sourceThread: args.sourceThread,
    });
  }
  const sourceProviderThreadId = getLastProviderThreadId(
    deps,
    args.sourceThread.id,
  );
  if (sourceProviderThreadId === null) {
    return null;
  }
  const lastCompletedTurn = findLastCompletedRootStoredTurn(deps.db, {
    threadId: args.sourceThread.id,
  });
  const tip: ThreadForkPoint = {
    descriptor: { sourceProviderThreadId },
    historyEndSequence: lastCompletedTurn?.completedSequence ?? null,
    sourceThreadId: args.sourceThread.id,
  };
  if (
    lastCompletedTurn === null ||
    !deps.providerRegistry.supportsSessionRewind(args.sourceThread.providerId)
  ) {
    return tip;
  }
  const latestRootTurn = findLastRootStoredTurnStarted(deps.db, {
    threadId: args.sourceThread.id,
  });
  if (latestRootTurn?.turnId === lastCompletedTurn.turnId) {
    return tip;
  }
  const completion = readTurnCompletion(deps, {
    threadId: args.sourceThread.id,
    turnId: lastCompletedTurn.turnId,
  });
  const descriptor =
    completion === null
      ? null
      : resolveCheckpointForkDescriptor({
          completion,
          providerId: args.sourceThread.providerId,
          turnId: lastCompletedTurn.turnId,
        });
  return descriptor === null ? tip : { ...tip, descriptor };
}

/**
 * The events that carry the conversation a fork inherits. Everything else the
 * source recorded is either the source's own bookkeeping (identity,
 * provisioning, usage snapshots, operations), streaming deltas the completed
 * items already fold in, or pending-interaction and goal state that belongs to
 * the source thread alone.
 */
export const INHERITED_EVENT_TYPES = [
  "client/turn/requested",
  "turn/started",
  "turn/input/accepted",
  "item/completed",
  "item/backgroundTask/completed",
  "turn/completed",
  "thread/compacted",
  "system/manager/user_message",
] as const satisfies readonly ThreadEventType[];

function parseAcceptedClientRequestId(row: StoredEventRow): string {
  const event = parseStoredEvent(row);
  if (event.type !== "turn/input/accepted") {
    throw new Error(`Expected turn/input/accepted event #${row.sequence}`);
  }
  return event.clientRequestId;
}

function selectInheritedForkEventRows(
  deps: Pick<AppDeps, "db">,
  args: { historyEndSequence: number; sourceThreadId: string },
): StoredEventRow[] {
  const rows = listStoredEventRows(deps.db, {
    beforeSequence: args.historyEndSequence + 1,
    threadId: args.sourceThreadId,
    types: INHERITED_EVENT_TYPES,
  });
  const completedTurnIds = new Set<string>();
  const acceptedClientRequestIds = new Set<string>();
  for (const row of rows) {
    if (row.type === "turn/completed" && row.turnId !== null) {
      completedTurnIds.add(row.turnId);
    } else if (row.type === "turn/input/accepted") {
      acceptedClientRequestIds.add(parseAcceptedClientRequestId(row));
    }
  }
  return rows.filter((row) => {
    if (row.turnId !== null) {
      return completedTurnIds.has(row.turnId);
    }
    if (row.type !== "client/turn/requested") {
      return true;
    }
    return acceptedClientRequestIds.has(
      parseStoredTurnRequestEvent(row).requestId,
    );
  });
}

export function copyForkSourceHistory(
  deps: Pick<AppDeps, "db" | "hub">,
  args: {
    fork: Pick<Thread, "environmentId" | "id">;
    historyEndSequence: number;
    sourceThreadId: string;
  },
): void {
  const rows = selectInheritedForkEventRows(deps, {
    historyEndSequence: args.historyEndSequence,
    sourceThreadId: args.sourceThreadId,
  }).map((row) => ({ ...row, providerThreadId: null }));
  if (rows.length === 0) {
    return;
  }
  deps.db.transaction(
    (tx) =>
      copyStoredThreadEventsInTransaction(tx, {
        rows,
        targetEnvironmentId: args.fork.environmentId,
        targetThreadId: args.fork.id,
      }),
    { behavior: "immediate" },
  );
  deps.hub.notifyThread(args.fork.id, ["events-appended"], {
    eventTypes: [...new Set(rows.map((row) => row.type))],
  });
}
