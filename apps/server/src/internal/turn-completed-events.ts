import { and, desc, eq, inArray } from "drizzle-orm";
import { events, getThread, transitionThreadStatus } from "@bb/db";
import { providerEventSchema } from "@bb/domain";
import type { AppDeps } from "../types.js";
import { decodeEventRow } from "../services/thread-data.js";

export function applyTurnCompletedEvent(
  deps: Pick<AppDeps, "db" | "hub">,
  payload: Extract<
    ReturnType<typeof providerEventSchema.parse>,
    { type: "turn/completed" }
  >,
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
    .select({
      createdAt: events.createdAt,
      data: events.data,
      id: events.id,
      providerThreadId: events.providerThreadId,
      sequence: events.sequence,
      threadId: events.threadId,
      turnId: events.turnId,
      type: events.type,
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
    if (!row.providerThreadId || !row.turnId) {
      continue;
    }
    const decodedRow = decodeEventRow(row);
    const payload = providerEventSchema.parse({
      ...decodedRow.data,
      type: decodedRow.type,
      threadId: decodedRow.threadId,
      providerThreadId: row.providerThreadId,
      turnId: row.turnId,
    });
    if (payload.type !== "turn/completed") {
      continue;
    }
    applyTurnCompletedEvent(deps, payload);
  }
}
