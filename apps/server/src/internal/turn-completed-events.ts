import { and, desc, eq, inArray } from "drizzle-orm";
import { events, getThread, transitionThreadStatus } from "@bb/db";
import type { ThreadEvent } from "@bb/domain";
import type { AppDeps } from "../types.js";
import {
  parseStoredEvent,
  storedEventRowFields,
} from "../services/thread-data.js";

export function applyTurnCompletedEvent(
  deps: Pick<AppDeps, "db" | "hub">,
  payload: Extract<ThreadEvent, { type: "turn/completed" }>,
): void {
  const thread = getThread(deps.db, payload.threadId);
  if (!thread) {
    return;
  }

  try {
    if (payload.status === "failed") {
      transitionThreadStatus(deps.db, deps.hub, payload.threadId, "error");
    } else if (payload.status === "interrupted") {
      transitionThreadStatus(deps.db, deps.hub, payload.threadId, "idle");
    } else if (thread.status === "active" || thread.status === "error") {
      transitionThreadStatus(deps.db, deps.hub, payload.threadId, "idle");
    }
  } catch {
    // Ignore invalid transitions from concurrent changes.
  }
}

export function handleTurnCompletedEvents(
  deps: Pick<AppDeps, "db" | "hub">,
  threadIds: string[],
): void {
  if (threadIds.length === 0) {
    return;
  }

  const rows = deps.db
    .select(storedEventRowFields)
    .from(events)
    .where(
      and(
        inArray(events.threadId, threadIds),
        eq(events.type, "turn/completed"),
      ),
    )
    .orderBy(desc(events.sequence))
    .all();

  const seenThreadIds = new Set<string>();
  for (const row of rows) {
    if (seenThreadIds.has(row.threadId)) {
      continue;
    }
    seenThreadIds.add(row.threadId);
    const payload = parseStoredEvent(row);
    if (payload.type !== "turn/completed") {
      continue;
    }
    applyTurnCompletedEvent(deps, payload);
  }
}
