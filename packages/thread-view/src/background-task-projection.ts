import { itemStatusToExecStatus } from "./exec-lifecycle.js";
import type { ThreadEvent, ThreadEventBackgroundTaskItem } from "@bb/domain";
import type { EventMeta } from "./event-decode.js";
import type {
  EventProjectionMessage,
  EventProjectionWorkflowMessage,
} from "./event-projection-message.js";

export interface BackgroundTaskProjectionState {
  messages: EventProjectionMessage[];
  backgroundTasksByItemId: Map<string, EventProjectionWorkflowMessage>;
}

interface BackgroundTaskLifecycleEvent {
  kind: "begin" | "update" | "end";
  item: ThreadEventBackgroundTaskItem;
}

export function parseBackgroundTaskLifecycleEvent(
  decoded: ThreadEvent,
): BackgroundTaskLifecycleEvent | null {
  if (
    (decoded.type === "item/started" || decoded.type === "item/completed") &&
    decoded.item.type === "backgroundTask"
  ) {
    return {
      kind: decoded.type === "item/started" ? "begin" : "end",
      item: decoded.item,
    };
  }
  if (decoded.type === "item/backgroundTask/progress") {
    return { kind: "update", item: decoded.item };
  }
  if (decoded.type === "item/backgroundTask/completed") {
    return { kind: "end", item: decoded.item };
  }
  return null;
}

function applyBackgroundTaskItem(
  message: EventProjectionWorkflowMessage,
  lifecycle: BackgroundTaskLifecycleEvent,
  meta: EventMeta,
): void {
  const item = lifecycle.item;
  message.familyId = item.familyId ?? null;
  message.taskType = item.taskType;
  message.workflowName = item.workflowName ?? null;
  message.description = item.description;
  message.status = itemStatusToExecStatus(item.status);
  message.taskStatus = item.taskStatus;
  message.skipTranscript = item.skipTranscript;
  message.workflow = item.workflow ?? null;
  message.usage = item.usage ?? null;
  message.summary = item.summary ?? null;
  message.error = item.error ?? null;
  if (lifecycle.kind === "end" && message.completedAt === null) {
    message.completedAt = meta.createdAt;
  }
}

export function upsertBackgroundTaskMessage(
  state: BackgroundTaskProjectionState,
  meta: EventMeta,
  decoded: ThreadEvent,
): boolean {
  const lifecycle = parseBackgroundTaskLifecycleEvent(decoded);
  if (!lifecycle) {
    return false;
  }

  const existing = state.backgroundTasksByItemId.get(lifecycle.item.id);
  if (existing) {
    applyBackgroundTaskItem(existing, lifecycle, meta);
    existing.createdAt = Math.max(existing.createdAt, meta.createdAt);
    return true;
  }

  const message: EventProjectionWorkflowMessage = {
    kind: "workflow",
    id: lifecycle.item.id,
    threadId: decoded.threadId,
    sourceSeqStart: meta.seq,
    sourceSeqEnd: meta.seq,
    createdAt: meta.createdAt,
    scope: decoded.scope,
    startedAt: meta.createdAt,
    ...(lifecycle.item.parentToolCallId
      ? { parentToolCallId: lifecycle.item.parentToolCallId }
      : {}),
    ...(lifecycle.item.presentation
      ? { presentation: lifecycle.item.presentation }
      : {}),
    itemId: lifecycle.item.id,
    familyId: lifecycle.item.familyId ?? null,
    taskType: lifecycle.item.taskType,
    workflowName: lifecycle.item.workflowName ?? null,
    description: lifecycle.item.description,
    model: null,
    status: itemStatusToExecStatus(lifecycle.item.status),
    taskStatus: lifecycle.item.taskStatus,
    skipTranscript: lifecycle.item.skipTranscript,
    workflow: lifecycle.item.workflow ?? null,
    usage: lifecycle.item.usage ?? null,
    summary: lifecycle.item.summary ?? null,
    error: lifecycle.item.error ?? null,
    completedAt: lifecycle.kind === "end" ? meta.createdAt : null,
  };
  state.backgroundTasksByItemId.set(lifecycle.item.id, message);
  state.messages.push(message);
  return true;
}
