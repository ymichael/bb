import type { ThreadEvent, ThreadEventItemStatus, ViewTaskEntry, ViewTasksMessage } from "@bb/domain";
import type { EventMeta } from "./event-decode.js";
import { getEventParentToolCallId } from "./event-decode.js";
import { messageId } from "./format-helpers.js";
import { toRecord } from "./unknown-helpers.js";

interface TodoArgumentShape {
  content?: string;
  status?: string;
}

function toTodoArgumentShape(value: unknown): TodoArgumentShape | null {
  const record = toRecord(value);
  if (!record) {
    return null;
  }

  return {
    content: typeof record.content === "string" ? record.content : undefined,
    status: typeof record.status === "string" ? record.status : undefined,
  };
}

function toViewTaskStatus(
  value: string | undefined,
): ViewTaskEntry["status"] {
  switch (value) {
    case "in_progress":
    case "active":
      return "active";
    case "completed":
      return "completed";
    case "failed":
      return "failed";
    default:
      return "pending";
  }
}

function toTaskMessageStatus(
  status: ThreadEventItemStatus,
): ViewTasksMessage["status"] {
  switch (status) {
    case "pending":
      return "pending";
    case "completed":
      return "completed";
    case "failed":
      return "error";
    case "interrupted":
      return "interrupted";
  }
}

function asTodoTasks(value: unknown): ViewTaskEntry[] {
  if (!Array.isArray(value)) {
    return [];
  }

  const tasks: ViewTaskEntry[] = [];
  for (const entry of value) {
    const todo = toTodoArgumentShape(entry);
    if (!todo) continue;
    if (!todo.content || todo.content.trim().length === 0) {
      continue;
    }
    tasks.push({
      text: todo.content,
      status: toViewTaskStatus(todo.status),
    });
  }
  return tasks;
}

function planTaskTitle(status: ViewTasksMessage["status"]): string {
  switch (status) {
    case "pending":
      return "Updating tasks";
    case "error":
      return "Task update failed";
    case "interrupted":
      return "Task update interrupted";
    case "completed":
      return "Tasks updated";
  }
}

export function shouldSuppressLowValueToolCall(decoded: ThreadEvent): boolean {
  if (
    (decoded.type !== "item/started" && decoded.type !== "item/completed") ||
    decoded.item.type !== "toolCall"
  ) {
    return false;
  }

  if (decoded.item.tool !== "TodoRead") {
    return false;
  }

  return decoded.item.status === "pending" || decoded.item.status === "completed";
}

export function parseTaskMessage(
  decoded: ThreadEvent,
  meta: EventMeta,
  parentToolCallIdOverride?: string,
): ViewTasksMessage | null {
  const parentToolCallId =
    parentToolCallIdOverride ?? getEventParentToolCallId(decoded);

  if (decoded.type === "turn/plan/updated") {
    const tasks = decoded.plan
      .map((entry) => {
        const text = entry.step.trim();
        if (text.length === 0) return null;
        return {
          text,
          status: toViewTaskStatus(entry.status),
        };
      })
      .filter((entry): entry is ViewTaskEntry => Boolean(entry));

    if (tasks.length === 0) {
      return null;
    }

    return {
      kind: "tasks",
      id: messageId(decoded.threadId, "tasks", `plan:${decoded.turnId}:${meta.seq}`),
      threadId: decoded.threadId,
      sourceSeqStart: meta.seq,
      sourceSeqEnd: meta.seq,
      createdAt: meta.createdAt,
      turnId: decoded.turnId,
      source: "plan",
      status: "completed",
      title: "Tasks updated",
      tasks,
      ...(parentToolCallId ? { parentToolCallId } : {}),
    };
  }

  if (
    (decoded.type !== "item/started" && decoded.type !== "item/completed") ||
    decoded.item.type !== "toolCall" ||
    decoded.item.tool !== "TodoWrite"
  ) {
    return null;
  }

  const tasks = asTodoTasks(decoded.item.arguments?.todos);
  if (tasks.length === 0) {
    return null;
  }

  const status = toTaskMessageStatus(decoded.item.status);
  return {
    kind: "tasks",
    id: messageId(decoded.threadId, "tasks", `todo:${decoded.item.id}:${meta.seq}`),
    threadId: decoded.threadId,
    sourceSeqStart: meta.seq,
    sourceSeqEnd: meta.seq,
    createdAt: meta.createdAt,
    turnId: decoded.turnId,
    source: "todo",
    callId: decoded.item.id,
    status,
    title: planTaskTitle(status),
    tasks,
    ...(parentToolCallId ? { parentToolCallId } : {}),
  };
}
