import type {
  Thread,
  ThreadEvent,
  ThreadEventPlanStep,
  ThreadTimelinePendingTodoItem,
  ThreadTimelinePendingTodoItemStatus,
  ThreadTimelinePendingTodos,
} from "@bb/domain";
import type { ThreadEventWithMeta } from "./build-event-projection.js";
import { getOrderedThreadEvents } from "./group-event-projection-turns.js";

const TODO_TEXT_MAX_LENGTH = 240;

function trimAndTruncate(value: string): string {
  const trimmed = value.trim();
  if (trimmed.length <= TODO_TEXT_MAX_LENGTH) return trimmed;
  return trimmed.slice(0, TODO_TEXT_MAX_LENGTH);
}

interface SnapshotCandidate {
  seq: number;
  createdAt: number;
  items: ThreadTimelinePendingTodoItem[];
}

interface SnapshotCandidateMeta {
  seq: number;
  createdAt: number;
}

function todoIdFor(seq: number, index: number): string {
  return `seq:${seq}:${index}`;
}

const PLAN_STEP_TODO_STATUSES: Readonly<
  Record<
    NonNullable<ThreadEventPlanStep["status"]>,
    ThreadTimelinePendingTodoItemStatus
  >
> = {
  pending: "pending",
  active: "in_progress",
  completed: "completed",
  failed: "completed",
};

function extractPlanStepsCandidate(
  event: ThreadEvent,
  meta: SnapshotCandidateMeta,
): SnapshotCandidate | null {
  if (event.type !== "item/completed" || event.item.type !== "planSteps") {
    return null;
  }
  const items: ThreadTimelinePendingTodoItem[] = [];
  for (const [index, step] of event.item.steps.entries()) {
    const text = trimAndTruncate(step.step);
    if (text.length === 0) continue;
    items.push({
      id: todoIdFor(meta.seq, index),
      text,
      status: PLAN_STEP_TODO_STATUSES[step.status ?? "pending"],
    });
  }
  return { seq: meta.seq, createdAt: meta.createdAt, items };
}

export function extractThreadTimelinePendingTodos(
  threadStatus: Thread["status"],
  events: readonly ThreadEventWithMeta[],
): ThreadTimelinePendingTodos | null {
  if (threadStatus !== "active") return null;

  let best: SnapshotCandidate | null = null;
  for (const { event, meta } of getOrderedThreadEvents(events)) {
    const candidate = extractPlanStepsCandidate(event, meta);
    if (!candidate) continue;
    if (best === null || candidate.seq > best.seq) {
      best = candidate;
    }
  }
  if (best === null) return null;
  return {
    sourceSeq: best.seq,
    updatedAt: best.createdAt,
    items: best.items,
  };
}
