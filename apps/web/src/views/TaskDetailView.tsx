import { useMemo, useState } from "react";
import type { TaskEvent, TaskStatus, UIMessage } from "@beanbag/core";
import { ChevronDown, ChevronRight } from "lucide-react";
import { Link, useParams } from "react-router-dom";
import { PromptBox } from "@/components/promptbox/PromptBox";
import { ConversationEntry } from "@/components/messages/ConversationEntry";
import { ConversationWorkingIndicator } from "@/components/messages/ConversationWorkingIndicator";
import { TaskAssigneeSelector } from "@/components/tasks/TaskAssigneeSelector";
import {
  useSetTaskAssignee,
  useTask,
  useTaskChat,
  useTaskEvents,
  useThread,
  useThreadEvents,
  useUpdateTask,
} from "@/hooks/useApi";
import { usePromptDraftStorage } from "@/hooks/usePromptDraftStorage";
import { usePromptFileMentions } from "@/hooks/usePromptFileMentions";
import { toUIMessages } from "@beanbag/core";

const TASK_STATUS_OPTIONS: Array<{ value: TaskStatus; label: string }> = [
  { value: "open", label: "open" },
  { value: "in_progress", label: "in progress" },
  { value: "blocked", label: "blocked" },
  { value: "closed", label: "closed" },
];

const EVENT_HEADER_COLLAPSED_TONE_CLASS =
  "text-muted-foreground/90 transition-colors group-hover:text-foreground/90 group-focus-within:text-foreground/90";
const EVENT_HEADER_EXPANDED_TONE_CLASS = "text-foreground/90";
const EVENT_HEADER_BUTTON_BASE_CLASS =
  "inline-flex max-w-full items-center gap-1 overflow-hidden py-0.5 text-left text-sm";
const EVENT_HEADER_TEXT_CLASS = "min-w-0 truncate";
const EVENT_HEADER_CHEVRON_COLLAPSED_CLASS =
  "size-4 shrink-0 opacity-0 transition-opacity group-hover:opacity-100";

function formatDate(timestamp: number): string {
  return new Date(timestamp).toLocaleString();
}

function formatRelativeTime(timestamp: number): string {
  const elapsedSeconds = Math.max(1, Math.floor((Date.now() - timestamp) / 1000));

  if (elapsedSeconds < 60) return `${elapsedSeconds}s`;
  const elapsedMinutes = Math.floor(elapsedSeconds / 60);
  if (elapsedMinutes < 60) return `${elapsedMinutes}m`;
  const elapsedHours = Math.floor(elapsedMinutes / 60);
  if (elapsedHours < 24) return `${elapsedHours}h`;
  const elapsedDays = Math.floor(elapsedHours / 24);
  if (elapsedDays < 7) return `${elapsedDays}d`;
  const elapsedWeeks = Math.floor(elapsedDays / 7);
  return `${elapsedWeeks}w`;
}

function formatPrimitiveValue(value: unknown): string {
  if (typeof value === "string") {
    return value.length > 72 ? `${value.slice(0, 69)}...` : value;
  }
  if (typeof value === "number" || typeof value === "boolean") {
    return String(value);
  }
  if (Array.isArray(value)) {
    return `${value.length} items`;
  }
  if (value && typeof value === "object") {
    return "details";
  }
  if (value === null) {
    return "null";
  }
  return "value";
}

function summarizeTaskEvent(event: TaskEvent): string {
  const data = event.data ?? {};

  switch (event.type) {
    case "task.created":
      return "Task created";
    case "task.updated": {
      const maybeUpdates = data.updates;
      if (maybeUpdates && typeof maybeUpdates === "object") {
        const keys = Object.keys(maybeUpdates as Record<string, unknown>);
        if (keys.length > 0) {
          return `Updated ${keys.join(", ")}`;
        }
      }
      return "Task updated";
    }
    case "task.assigned": {
      const assignee = data.assignee;
      if (typeof assignee === "string" && assignee.length > 0) {
        return `Assigned to ${assignee}`;
      }
      return "Task assigned";
    }
    case "task.dependency_added":
    case "task.dependency_removed": {
      const type = typeof data.type === "string" ? data.type : "dependency";
      const dependsOnTaskId =
        typeof data.dependsOnTaskId === "string"
          ? data.dependsOnTaskId.slice(0, 8)
          : "unknown";
      const action = event.type.endsWith("added") ? "Added" : "Removed";
      return `${action} ${type} dependency on ${dependsOnTaskId}`;
    }
    case "task.chat.thread_bound": {
      const threadId =
        typeof data.threadId === "string" && data.threadId.length > 0
          ? data.threadId.slice(0, 8)
          : "unknown";
      return `Linked agent thread ${threadId}`;
    }
    case "task.chat.message_sent": {
      const preview =
        typeof data.preview === "string" && data.preview.trim().length > 0
          ? data.preview
          : "sent a message";
      return `Message sent: ${preview}`;
    }
    default: {
      const entries = Object.entries(data);
      if (entries.length === 0) {
        return "Event recorded";
      }
      const [key, value] = entries[0];
      return `${key}: ${formatPrimitiveValue(value)}`;
    }
  }
}

function getTaskEventThreadId(event: TaskEvent): string | undefined {
  const threadId = event.data?.threadId;
  if (typeof threadId !== "string" || threadId.length === 0) return undefined;
  return threadId;
}

function resolveTaskAgentThreadId(events: TaskEvent[]): string | undefined {
  for (let i = events.length - 1; i >= 0; i -= 1) {
    const threadId = getTaskEventThreadId(events[i]);
    if (threadId) return threadId;
  }
  return undefined;
}

function isTaskStatus(value: unknown): value is TaskStatus {
  return (
    value === "open" ||
    value === "in_progress" ||
    value === "blocked" ||
    value === "closed"
  );
}

function formatTaskStatusLabel(status: TaskStatus): string {
  return status.replace("_", " ");
}

function getTaskUpdateData(event: TaskEvent): Record<string, unknown> | null {
  if (event.type !== "task.updated") return null;
  const maybeUpdates = event.data?.updates;
  if (
    !maybeUpdates ||
    typeof maybeUpdates !== "object" ||
    Array.isArray(maybeUpdates)
  ) {
    return null;
  }
  return maybeUpdates as Record<string, unknown>;
}

type TaskEventRow =
  | {
      kind: "status-updated";
      event: TaskEvent;
      fromStatus?: TaskStatus;
      toStatus: TaskStatus;
    }
  | {
      kind: "title-updated";
      event: TaskEvent;
      fromTitle?: string;
      toTitle: string;
    }
  | {
      kind: "created";
      event: TaskEvent;
      createdTitle?: string;
    }
  | {
      kind: "generic";
      event: TaskEvent;
    };

type TaskActivityRow =
  | {
      kind: "task-event";
      id: string;
      createdAt: number;
      order: number;
      row: TaskEventRow;
    }
  | {
      kind: "agent-message";
      id: string;
      createdAt: number;
      order: number;
      message: UIMessage;
    };

function buildTaskEventRows(events: TaskEvent[]): TaskEventRow[] {
  let inferredStatus: TaskStatus = "open";
  let inferredTitle: string | undefined;

  return events.map((event) => {
    const data = event.data ?? {};

    if (event.type === "task.created") {
      const createdTitle =
        typeof data.title === "string" && data.title.trim().length > 0
          ? data.title
          : undefined;
      if (createdTitle) inferredTitle = createdTitle;
      inferredStatus = "open";
      return {
        kind: "created",
        event,
        createdTitle,
      };
    }

    const updates = getTaskUpdateData(event);
    if (updates) {
      const nextStatus = isTaskStatus(updates.status) ? updates.status : undefined;
      const nextTitle =
        typeof updates.title === "string" && updates.title.trim().length > 0
          ? updates.title
          : undefined;

      if (nextStatus) {
        const row: TaskEventRow = {
          kind: "status-updated",
          event,
          fromStatus: inferredStatus,
          toStatus: nextStatus,
        };
        inferredStatus = nextStatus;
        if (nextTitle) inferredTitle = nextTitle;
        return row;
      }

      if (nextTitle) {
        const row: TaskEventRow = {
          kind: "title-updated",
          event,
          fromTitle: inferredTitle,
          toTitle: nextTitle,
        };
        inferredTitle = nextTitle;
        return row;
      }
    }

    if (event.type === "task.assigned" && inferredStatus === "open") {
      inferredStatus = "in_progress";
    }

    return {
      kind: "generic",
      event,
    };
  });
}

function buildTaskEventDetailLine(row: TaskEventRow): string {
  if (row.kind === "status-updated") {
    return `From ${formatTaskStatusLabel(row.fromStatus ?? row.toStatus)}`;
  }

  if (row.kind === "title-updated") {
    if (row.fromTitle && row.fromTitle.trim().length > 0) {
      return `From ${row.fromTitle} to ${row.toTitle}`;
    }
    return `Set title to ${row.toTitle}`;
  }

  if (row.kind === "created") {
    return row.createdTitle
      ? `Title ${row.createdTitle}`
      : `Created ${formatDate(row.event.createdAt)}`;
  }

  const data = row.event.data ?? {};
  if (row.event.type === "task.assigned") {
    const assignee = data.assignee;
    if (typeof assignee === "string" && assignee.length > 0) {
      return `Assigned to ${assignee}`;
    }
  }
  if (
    row.event.type === "task.dependency_added" ||
    row.event.type === "task.dependency_removed"
  ) {
    const type = typeof data.type === "string" ? data.type : "dependency";
    const dependsOnTaskId =
      typeof data.dependsOnTaskId === "string"
        ? data.dependsOnTaskId.slice(0, 8)
        : "unknown";
    const action = row.event.type.endsWith("added") ? "Added" : "Removed";
    return `${action} ${type} dependency on ${dependsOnTaskId}`;
  }
  if (row.event.type === "task.chat.thread_bound") {
    const threadId =
      typeof data.threadId === "string" && data.threadId.length > 0
        ? data.threadId
        : "unknown";
    const assignee =
      typeof data.assignee === "string" && data.assignee.length > 0
        ? data.assignee
        : "unknown";
    return `Bound ${assignee} to thread ${threadId}`;
  }
  if (row.event.type === "task.chat.message_sent") {
    const preview =
      typeof data.preview === "string" && data.preview.trim().length > 0
        ? data.preview
        : "sent a message";
    return preview;
  }

  const entries = Object.entries(data);
  if (entries.length === 0) return `Recorded ${formatDate(row.event.createdAt)}`;
  const [key, value] = entries[0];
  return `${key}: ${formatPrimitiveValue(value)}`;
}

function TaskEventLogEntry({
  row,
}: {
  row: TaskEventRow;
}) {
  const event = row.event;
  const [isExpanded, setIsExpanded] = useState(false);
  const headerToneClass = isExpanded
    ? EVENT_HEADER_EXPANDED_TONE_CLASS
    : EVENT_HEADER_COLLAPSED_TONE_CLASS;
  const relativeTime = formatRelativeTime(event.createdAt);

  const summaryContent =
    row.kind === "status-updated" ? (
      <span className="inline-flex min-w-0 items-center gap-1.5">
        <span className="shrink-0 text-muted-foreground/90">Updated status to</span>
        <span className="truncate font-semibold text-foreground/95">
          {formatTaskStatusLabel(row.toStatus)}
        </span>
        <span className="shrink-0 text-muted-foreground/80">· {relativeTime}</span>
      </span>
    ) : row.kind === "title-updated" ? (
      <span className="inline-flex min-w-0 items-center gap-1.5">
        <span className="shrink-0 text-muted-foreground/90">Updated title to</span>
        <span className="truncate font-semibold text-foreground/95">
          {row.toTitle}
        </span>
        <span className="shrink-0 text-muted-foreground/80">· {relativeTime}</span>
      </span>
    ) : row.kind === "created" ? (
      `Task created · ${relativeTime}`
    ) : (
      `${summarizeTaskEvent(event)} · ${relativeTime}`
    );
  const expandedDetail = buildTaskEventDetailLine(row);

  return (
    <div className="group w-full" style={{ overflowAnchor: "none" }}>
      <div className="mr-auto w-full">
        <div className="rounded-md text-muted-foreground">
          <div className={isExpanded ? "px-2 pb-0 pt-1" : "px-2 py-1"}>
            <button
              type="button"
              onClick={() => setIsExpanded((value) => !value)}
              className={`${EVENT_HEADER_BUTTON_BASE_CLASS} ${headerToneClass}`}
            >
              <span
                className={
                  row.kind === "status-updated" || row.kind === "title-updated"
                    ? "min-w-0"
                    : EVENT_HEADER_TEXT_CLASS
                }
              >
                {summaryContent}
              </span>
              {isExpanded ? (
                <ChevronDown className="size-4 shrink-0" />
              ) : (
                <ChevronRight className={EVENT_HEADER_CHEVRON_COLLAPSED_CLASS} />
              )}
            </button>
          </div>
          {isExpanded ? (
            <div className="px-2 pb-0.5">
              <p
                className="truncate text-sm text-foreground/80"
                title={expandedDetail}
              >
                {expandedDetail}
              </p>
            </div>
          ) : null}
        </div>
      </div>
    </div>
  );
}

export function TaskDetailView() {
  const { projectId, taskId } = useParams<{ projectId: string; taskId: string }>();
  const { data: task, isLoading, error } = useTask(taskId ?? "");
  const taskEventsQuery = useTaskEvents(taskId ?? "");
  const setTaskAssignee = useSetTaskAssignee();
  const taskChat = useTaskChat();
  const updateTask = useUpdateTask();
  const taskPromptDraft = usePromptDraftStorage({
    projectId,
    threadId: taskId ? `task-${taskId}` : null,
  });
  const fileMentions = usePromptFileMentions(projectId);
  const [statusErrorMessage, setStatusErrorMessage] = useState<string | null>(null);
  const [assignmentErrorMessage, setAssignmentErrorMessage] = useState<string | null>(
    null,
  );
  const [chatErrorMessage, setChatErrorMessage] = useState<string | null>(null);

  const taskEvents = useMemo(
    () => (taskEventsQuery.data ?? []).slice().sort((a, b) => a.seq - b.seq),
    [taskEventsQuery.data],
  );
  const taskEventRows = useMemo(() => buildTaskEventRows(taskEvents), [taskEvents]);
  const boundAgentThreadId = useMemo(
    () => resolveTaskAgentThreadId(taskEvents),
    [taskEvents],
  );
  const { data: boundAgentThread } = useThread(boundAgentThreadId ?? "");
  const boundAgentThreadEventsQuery = useThreadEvents(boundAgentThreadId ?? "");
  const boundAgentMessages = useMemo(
    () =>
      toUIMessages(boundAgentThreadEventsQuery.data, {
        threadStatus: boundAgentThread?.status,
      }).filter((entry) => entry.kind !== "assistant-reasoning"),
    [boundAgentThread?.status, boundAgentThreadEventsQuery.data],
  );
  const taskActivityRows = useMemo(() => {
    const activityRows: TaskActivityRow[] = [];
    for (let i = 0; i < taskEventRows.length; i += 1) {
      const row = taskEventRows[i];
      activityRows.push({
        kind: "task-event",
        id: `task-event:${row.event.id}`,
        createdAt: row.event.createdAt,
        order: i,
        row,
      });
    }
    const offset = taskEventRows.length;
    for (let i = 0; i < boundAgentMessages.length; i += 1) {
      const message = boundAgentMessages[i];
      activityRows.push({
        kind: "agent-message",
        id: `agent-message:${message.id}`,
        createdAt: message.createdAt,
        order: offset + i,
        message,
      });
    }

    activityRows.sort((a, b) => {
      if (a.createdAt !== b.createdAt) return a.createdAt - b.createdAt;
      return a.order - b.order;
    });
    return activityRows;
  }, [boundAgentMessages, taskEventRows]);
  const showAgentWorking = taskChat.isPending || boundAgentThread?.status === "active";

  if (!projectId || !taskId) {
    return <p className="py-12 text-center text-sm text-destructive">Not found</p>;
  }

  if (isLoading) {
    return (
      <p className="py-12 text-center text-sm text-muted-foreground">
        Loading task...
      </p>
    );
  }

  if (error || !task || task.projectId !== projectId) {
    return (
      <p className="py-12 text-center text-sm text-destructive">
        {error ? error.message : "Not found"}
      </p>
    );
  }

  const submitTaskPrompt = () => {
    if (!task) return;
    const message = taskPromptDraft.value.trim();
    if (!task.assignee || message.length === 0 || taskChat.isPending) return;

    setChatErrorMessage(null);
    taskChat.mutate(
      {
        id: task.id,
        req: {
          input: [{ type: "text", text: message }],
        },
      },
      {
        onSuccess: () => {
          taskPromptDraft.clear();
        },
        onError: (chatError) => {
          setChatErrorMessage(
            chatError instanceof Error
              ? chatError.message
              : "Unable to send task message.",
          );
        },
      },
    );
  };

  const canEditStatus = task.status !== "closed" && !updateTask.isPending;

  const handleStatusChange = (nextStatus: TaskStatus) => {
    if (nextStatus === task.status || updateTask.isPending) return;

    setStatusErrorMessage(null);

    updateTask.mutate(
      {
        id: task.id,
        req:
          nextStatus === "closed"
            ? { status: nextStatus, closeReason: task.closeReason ?? "completed" }
            : { status: nextStatus },
      },
      {
        onError: (updateError) => {
          setStatusErrorMessage(
            updateError instanceof Error
              ? updateError.message
              : "Unable to update task status.",
          );
        },
      },
    );
  };

  const handleAssignRole = (nextRoleId: string) => {
    if (setTaskAssignee.isPending || nextRoleId === task.assignee) return;
    setAssignmentErrorMessage(null);
    setTaskAssignee.mutate(
      { id: task.id, assignee: nextRoleId },
      {
        onError: (assignError) => {
          setAssignmentErrorMessage(
            assignError instanceof Error
              ? assignError.message
              : "Unable to update role.",
          );
        },
      },
    );
  };

  return (
    <div className="-mx-4 -mt-4 flex h-full min-h-0 flex-1 flex-col overflow-hidden md:-mx-5 md:-mt-5">
      <div className="mx-auto flex h-full min-h-0 w-full max-w-[800px] flex-col px-4 pb-4 pt-2">
        <section className="sticky top-0 z-10 shrink-0 space-y-1 bg-background pb-3">
            <dl className="rounded-md border border-border/60 bg-background/40 px-2 py-1">
              {task.description && task.description.trim().length > 0 ? (
                <div className="py-1">
                  <dt className="sr-only">Description</dt>
                  <dd className="min-w-0 break-words text-sm text-foreground/90">
                    {task.description}
                  </dd>
                </div>
              ) : null}
              <div className="grid grid-cols-[92px_minmax(0,1fr)] items-center gap-2 py-1 text-sm sm:grid-cols-[124px_minmax(0,1fr)]">
                <dt className="text-xs text-muted-foreground">
                  Status
                </dt>
                <dd className="min-w-0">
                  <div className="inline-flex max-w-full">
                    <div className="relative inline-flex items-center rounded-sm px-0.5 focus-within:ring-1 focus-within:ring-ring">
                      <span className="pointer-events-none text-sm text-foreground">
                        {formatTaskStatusLabel(task.status)}
                      </span>
                      <ChevronDown className="pointer-events-none ml-1 size-3 text-muted-foreground" />
                      <select
                        value={task.status}
                        onChange={(event) =>
                          handleStatusChange(event.target.value as TaskStatus)
                        }
                        disabled={!canEditStatus}
                        aria-label="Task status"
                        className="absolute inset-0 h-full w-full cursor-pointer appearance-none bg-transparent opacity-0 disabled:cursor-not-allowed"
                      >
                        {TASK_STATUS_OPTIONS.map((option) => (
                          <option key={option.value} value={option.value}>
                            {option.label}
                          </option>
                        ))}
                      </select>
                    </div>
                  </div>
                </dd>
              </div>
              {statusErrorMessage ? (
                <div className="grid grid-cols-[92px_minmax(0,1fr)] gap-2 py-0.5 text-sm sm:grid-cols-[124px_minmax(0,1fr)]">
                  <div aria-hidden="true" />
                  <p className="text-xs text-destructive">{statusErrorMessage}</p>
                </div>
              ) : null}
              {task.status === "closed" ? (
                <div className="grid grid-cols-[92px_minmax(0,1fr)] gap-2 py-0.5 text-sm sm:grid-cols-[124px_minmax(0,1fr)]">
                  <div aria-hidden="true" />
                  <p className="text-xs text-muted-foreground">
                    Closed tasks cannot be reopened.
                  </p>
                </div>
              ) : null}
              <div className="grid grid-cols-[92px_minmax(0,1fr)] items-center gap-2 py-1 text-sm sm:grid-cols-[124px_minmax(0,1fr)]">
                <dt className="text-xs text-muted-foreground">
                  Assignee
                </dt>
                <dd className="min-w-0">
                  <TaskAssigneeSelector
                    value={task.assignee}
                    onChange={(nextRoleId) => {
                      if (assignmentErrorMessage) setAssignmentErrorMessage(null);
                      handleAssignRole(nextRoleId);
                    }}
                    className="h-auto px-0 text-sm text-foreground/90 hover:text-foreground"
                  />
                </dd>
              </div>
              {assignmentErrorMessage ? (
                <div className="grid grid-cols-[92px_minmax(0,1fr)] gap-2 py-0.5 text-sm sm:grid-cols-[124px_minmax(0,1fr)]">
                  <div aria-hidden="true" />
                  <p className="text-xs text-destructive">
                    {assignmentErrorMessage}
                  </p>
                </div>
              ) : null}
              {boundAgentThreadId ? (
                <div className="grid grid-cols-[92px_minmax(0,1fr)] gap-2 py-1 text-sm sm:grid-cols-[124px_minmax(0,1fr)]">
                  <dt className="text-xs text-muted-foreground">
                    Agent Thread
                  </dt>
                  <dd className="min-w-0 truncate">
                    <Link
                      to={`/projects/${projectId}/threads/${boundAgentThreadId}`}
                      className="underline-offset-2 hover:underline"
                    >
                      {boundAgentThreadId}
                    </Link>
                  </dd>
                </div>
              ) : null}
              <div className="grid grid-cols-[92px_minmax(0,1fr)] gap-2 py-1 text-sm sm:grid-cols-[124px_minmax(0,1fr)]">
                <dt className="text-xs text-muted-foreground">
                  Created
                </dt>
                <dd>{formatDate(task.createdAt)}</dd>
              </div>
              <div className="grid grid-cols-[92px_minmax(0,1fr)] gap-2 py-1 text-sm sm:grid-cols-[124px_minmax(0,1fr)]">
                <dt className="text-xs text-muted-foreground">
                  Updated
                </dt>
                <dd>{formatDate(task.updatedAt)}</dd>
              </div>
              {task.closeReason ? (
                <div className="grid grid-cols-[92px_minmax(0,1fr)] gap-2 py-1 text-sm sm:grid-cols-[124px_minmax(0,1fr)]">
                  <dt className="text-xs text-muted-foreground">
                    Close Reason
                  </dt>
                  <dd>{task.closeReason}</dd>
                </div>
              ) : null}
              {task.resultSummary ? (
                <div className="grid grid-cols-[92px_minmax(0,1fr)] gap-2 py-1 text-sm sm:grid-cols-[124px_minmax(0,1fr)]">
                  <dt className="text-xs text-muted-foreground">
                    Result Summary
                  </dt>
                  <dd className="min-w-0 break-words text-foreground/90">
                    {task.resultSummary}
                  </dd>
                </div>
              ) : null}
            </dl>
          </section>

          <section className="min-h-0 flex flex-1 flex-col">
            <div className="min-h-0 flex flex-1 flex-col overflow-hidden">
              <div className="min-h-0 flex-1 overflow-y-auto pb-2">
                {taskEventsQuery.isLoading ||
                (boundAgentThreadId && boundAgentThreadEventsQuery.isLoading) ? (
                  <div className="px-3 py-6 text-center text-sm text-muted-foreground">
                    Loading task activity...
                  </div>
                ) : taskActivityRows.length === 0 ? (
                  <div className="px-3 py-6 text-center text-sm text-muted-foreground">
                    No task activity yet.
                  </div>
                ) : (
                  <div className="space-y-0.5 py-1">
                    {taskActivityRows.map((activityRow) =>
                      activityRow.kind === "task-event" ? (
                        <TaskEventLogEntry key={activityRow.id} row={activityRow.row} />
                      ) : (
                        <ConversationEntry
                          key={activityRow.id}
                          message={activityRow.message}
                          initialExpanded={false}
                        />
                      ),
                    )}
                    {showAgentWorking ? (
                      <ConversationWorkingIndicator isThinking={false} />
                    ) : null}
                  </div>
                )}
              </div>

              <div className="shrink-0 bg-background/30 p-3">
                <PromptBox
                  id="task-detail-chat-prompt"
                  value={taskPromptDraft.value}
                  onChange={(value) => {
                    taskPromptDraft.setValue(value);
                    if (chatErrorMessage) setChatErrorMessage(null);
                  }}
                  onSubmit={submitTaskPrompt}
                  isSubmitting={taskChat.isPending}
                  submitDisabled={
                    !task.assignee ||
                    taskPromptDraft.value.trim().length === 0 ||
                    taskChat.isPending
                  }
                  submitTitle={taskChat.isPending ? "Sending..." : "Send"}
                  placeholder={
                    task.assignee
                      ? "Message the assigned task agent"
                      : "Assign a role before chatting"
                  }
                  mentionSuggestions={fileMentions.suggestions}
                  mentionLoading={fileMentions.isLoading}
                  mentionError={fileMentions.isError}
                  onMentionQueryChange={fileMentions.setQuery}
                />
                {chatErrorMessage ? (
                  <p className="px-1 pt-2 text-xs text-destructive">
                    {chatErrorMessage}
                  </p>
                ) : null}
              </div>
            </div>
          </section>
      </div>
    </div>
  );
}
