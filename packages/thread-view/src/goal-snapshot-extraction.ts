import {
  LEGACY_CODEX_GOAL_EXTENSION_KIND,
  threadTimelineGoalStatusSchema,
} from "@bb/domain";
import type { ThreadEvent, ThreadTimelineGoal } from "@bb/domain";
import { z } from "zod";
import type { ThreadEventWithMeta } from "./build-event-projection.js";
import { getOrderedThreadEvents } from "./group-event-projection-turns.js";

const goalStatePayloadSchema = z.union([
  z.object({
    objective: z.string(),
    status: threadTimelineGoalStatusSchema,
    tokenBudget: z.number().nullable(),
    tokensUsed: z.number(),
    timeUsedSeconds: z.number(),
  }),
  z.null(),
]);

type GoalSnapshotCandidate =
  | {
      kind: "updated";
      goal: ThreadTimelineGoal;
      seq: number;
    }
  | {
      kind: "cleared";
      seq: number;
    };

function extractGoalSnapshotCandidate(
  event: ThreadEvent,
  meta: { createdAt: number; seq: number },
): GoalSnapshotCandidate | null {
  if (
    event.type !== "thread/extensionState/updated" ||
    event.kind !== LEGACY_CODEX_GOAL_EXTENSION_KIND
  ) {
    return null;
  }
  const payload = goalStatePayloadSchema.safeParse(event.payload);
  if (!payload.success) {
    return null;
  }
  if (payload.data === null) {
    return { kind: "cleared", seq: meta.seq };
  }
  return {
    kind: "updated",
    seq: meta.seq,
    goal: {
      sourceSeq: meta.seq,
      updatedAt: meta.createdAt,
      objective: payload.data.objective,
      status: payload.data.status,
      tokenBudget: payload.data.tokenBudget,
      tokensUsed: payload.data.tokensUsed,
      timeUsedSeconds: payload.data.timeUsedSeconds,
    },
  };
}

export function extractThreadTimelineGoal(
  events: readonly ThreadEventWithMeta[],
): ThreadTimelineGoal | null {
  let best: GoalSnapshotCandidate | null = null;
  for (const { event, meta } of getOrderedThreadEvents(events)) {
    const candidate = extractGoalSnapshotCandidate(event, meta);
    if (!candidate) continue;
    if (best === null || candidate.seq > best.seq) {
      best = candidate;
    }
  }
  if (best === null || best.kind === "cleared") return null;
  return best.goal;
}
