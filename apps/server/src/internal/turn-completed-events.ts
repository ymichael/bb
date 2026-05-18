import { getThread, transitionThreadStatus } from "@bb/db";
import type { ThreadEvent, ThreadStatus } from "@bb/domain";
import type { AppDeps } from "../types.js";
import {
  pruneThreadEventHistoryBestEffort,
  resetActiveThreadEventPruningState,
} from "../services/system/event-pruning.js";
import { isPreStartThreadStatus } from "../services/threads/thread-status.js";

export interface ApplyTurnCompletedEventResult {
  nextStatus: ThreadStatus | null;
  thread: ReturnType<typeof getThread>;
}

export function applyTurnCompletedEvent(
  deps: Pick<AppDeps, "db" | "hub" | "logger">,
  payload: Extract<ThreadEvent, { type: "turn/completed" }>,
): ApplyTurnCompletedEventResult {
  const thread = getThread(deps.db, payload.threadId);
  if (!thread) {
    return { nextStatus: null, thread: null };
  }

  let nextStatus: ThreadStatus | null = null;
  if (payload.status === "failed") {
    if (thread.stopRequestedAt === null) {
      nextStatus = "error";
    }
  } else if (payload.status === "interrupted") {
    nextStatus = "idle";
  } else if (
    isPreStartThreadStatus(thread.status) ||
    thread.status === "active" ||
    thread.status === "error"
  ) {
    nextStatus = "idle";
  }

  try {
    if (nextStatus) {
      transitionThreadStatus(deps.db, deps.hub, payload.threadId, nextStatus);
    }
  } catch {
    // Ignore invalid transitions from concurrent changes.
  }

  if (nextStatus) {
    resetActiveThreadEventPruningState(payload.threadId);
  }

  if (nextStatus === "idle") {
    pruneThreadEventHistoryBestEffort(deps, {
      mode: "idle",
      threadId: payload.threadId,
    });
  }

  return { nextStatus, thread };
}
