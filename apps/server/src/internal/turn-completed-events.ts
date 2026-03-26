import { and, desc, eq, inArray } from "drizzle-orm";
import { events, getThread, transitionThreadStatus } from "@bb/db";
import type { AppDeps } from "../types.js";

export function handleTurnCompletedEvents(
  deps: Pick<AppDeps, "db" | "hub">,
  threadIds: string[],
): void {
  if (threadIds.length === 0) {
    return;
  }

  const rows = deps.db
    .select({
      data: events.data,
      threadId: events.threadId,
    })
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
    const payload = JSON.parse(row.data) as { status?: string };
    const thread = getThread(deps.db, row.threadId);
    if (!thread) {
      continue;
    }
    try {
      if (payload.status === "failed") {
        transitionThreadStatus(deps.db, deps.hub, row.threadId, "error");
      } else if (payload.status === "interrupted") {
        transitionThreadStatus(deps.db, deps.hub, row.threadId, "idle");
      } else if (thread.status === "active") {
        transitionThreadStatus(deps.db, deps.hub, row.threadId, "idle");
      }
    } catch {
      // Ignore invalid transitions from concurrent changes.
    }
  }
}
