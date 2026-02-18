import { useMemo, useState } from "react";
import type {
  TaskEvent,
  TaskStatus,
  TaskThreadRole,
  UIMessage,
} from "@beanbag/core";
import { ChevronDown } from "lucide-react";
import { Link, useParams } from "react-router-dom";
import { PromptBox } from "@/components/promptbox/PromptBox";
import { ConversationEntry } from "@/components/messages/ConversationEntry";
import { ConversationMarkdown } from "@/components/messages/ConversationMarkdown";
import {
  CollapsibleHeader,
  COLLAPSIBLE_HEADER_TEXT_CLASS,
  getCollapsibleHeaderToneClass,
} from "@/components/messages/CollapsibleHeader";
import { ConversationWorkingIndicator } from "@/components/messages/ConversationWorkingIndicator";
import { PageShell } from "@/components/layout/PageShell";
import {
  DetailCard,
  DetailMessageRow,
  DetailRow,
} from "@/components/shared/DetailCard";
import { ScrollToBottomButton } from "@/components/shared/ScrollToBottomButton";
import { TaskAssigneeSelector } from "@/components/tasks/TaskAssigneeSelector";
import {
  useSetTaskAssignee,
  useTask,
  useTaskChat,
  useTaskEvents,
  useRoles,
  useThreadEventsBatch,
  useThreads,
  useUpdateTask,
} from "@/hooks/useApi";
import { useAutoScroll } from "@/hooks/useAutoScroll";
import { usePromptDraftStorage } from "@/hooks/usePromptDraftStorage";
import { usePromptFileMentions } from "@/hooks/usePromptFileMentions";
import { useScrollToBottomIndicator } from "@/hooks/useScrollToBottomIndicator";
import { formatRelativeTime, formatSnakeCaseLabel } from "@/lib/formatting";
import { toTaskThreadTurnMessages } from "./taskDetailActivity";

const TASK_STATUS_OPTIONS: TaskStatus[] = [
  "open",
  "in_progress",
  "blocked",
  "closed",
];

function formatDate(timestamp: number): string {
  return new Date(timestamp).toLocaleString();
}

function formatCreatedThreadLabel(taskRole: TaskThreadRole | undefined): string {
  switch (taskRole) {
    case "primary":
      return "Created primary thread";
    case "worker":
      return "Created child thread";
    default:
      return "Created thread";
  }
}

function summarizeTaskEvent(event: TaskEvent): string {
  switch (event.type) {
    case "task.created":
      return "Task created";
    case "task.updated.title":
      return "Updated title";
    case "task.updated.description":
      return "Updated description";
    case "task.updated.status":
      return `Updated status to ${formatSnakeCaseLabel(event.data.status)}`;
    case "task.assigned":
      if (event.data.assignee.length > 0) {
        return `Assigned to ${event.data.assignee}`;
      }
      return "Task assigned";
    case "task.archived":
      return "Task archived";
    case "task.dependency_added":
    case "task.dependency_removed": {
      const action = event.type === "task.dependency_added" ? "Added" : "Removed";
      return `${action} ${event.data.type} dependency on ${event.data.dependsOnTaskId.slice(0, 8)}`;
    }
    case "task.chat.message":
      if (event.data.fromThreadId === null) {
        return "User sent a message";
      }
      return `Thread ${event.data.fromThreadId.slice(0, 8)} sent a message`;
    case "task.chat.thread_created":
      return formatCreatedThreadLabel(event.data.taskRole);
  }
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
      kind: "task-chat-message";
      id: string;
      createdAt: number;
      order: number;
      message: UIMessage;
    }
  | {
      kind: "agent-message";
      id: string;
      createdAt: number;
      order: number;
      message: TaskThreadTurnMessage;
    }
  | {
      kind: "thread-completed";
      id: string;
      createdAt: number;
      order: number;
      message: TaskThreadTurnMessage;
    };

type TaskThreadTurnMessage = Extract<UIMessage, { kind: "assistant-text" }>;

function toTaskChatActivityMessage(event: TaskEvent): UIMessage | null {
  if (event.type !== "task.chat.message") return null;

  const text =
    event.data.message.trim().length > 0 ? event.data.message : "(no text)";

  if (event.data.fromThreadId === null) {
    return {
      kind: "user",
      id: `task-chat:user:${event.id}`,
      threadId: `task-${event.taskId}`,
      sourceSeqStart: event.seq,
      sourceSeqEnd: event.seq,
      createdAt: event.createdAt,
      text,
    };
  }

  return {
    kind: "assistant-text",
    id: `task-chat:thread:${event.id}`,
    threadId: event.data.fromThreadId,
    sourceSeqStart: event.seq,
    sourceSeqEnd: event.seq,
    createdAt: event.createdAt,
    text,
    status: "completed",
  };
}

function buildTaskEventRows(events: TaskEvent[]): TaskEventRow[] {
  let inferredStatus: TaskStatus = "open";
  let inferredTitle: string | undefined;

  return events.map((event) => {
    if (event.type === "task.created") {
      const createdTitle =
        event.data.title.trim().length > 0
          ? event.data.title
          : undefined;
      if (createdTitle) inferredTitle = createdTitle;
      inferredStatus = "open";
      return {
        kind: "created",
        event,
        createdTitle,
      };
    }

    if (event.type === "task.updated.status") {
      const row: TaskEventRow = {
        kind: "status-updated",
        event,
        fromStatus: inferredStatus,
        toStatus: event.data.status,
      };
      inferredStatus = event.data.status;
      return row;
    }

    if (event.type === "task.updated.title") {
      const nextTitle =
        event.data.title.trim().length > 0 ? event.data.title : undefined;
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
    return `From ${formatSnakeCaseLabel(row.fromStatus ?? row.toStatus)}`;
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

  switch (row.event.type) {
    case "task.assigned":
      if (row.event.data.assignee.length > 0) {
        return `Assigned to ${row.event.data.assignee}`;
      }
      return "Task assigned";
    case "task.dependency_added":
    case "task.dependency_removed": {
      const action = row.event.type === "task.dependency_added" ? "Added" : "Removed";
      return `${action} ${row.event.data.type} dependency on ${row.event.data.dependsOnTaskId.slice(0, 8)}`;
    }
    case "task.chat.message":
      if (row.event.data.fromThreadId === null) {
        return `User: ${row.event.data.message.trim().length > 0 ? row.event.data.message : "(no text)"}`;
      }
      return `Thread ${row.event.data.fromThreadId}: ${row.event.data.message.trim().length > 0 ? row.event.data.message : "(no text)"}`;
    case "task.chat.thread_created":
      return row.event.data.threadId.length > 0
        ? `${formatCreatedThreadLabel(row.event.data.taskRole)} ${row.event.data.threadId}`
        : formatCreatedThreadLabel(row.event.data.taskRole);
    case "task.updated.title":
      return `Set title to ${row.event.data.title}`;
    case "task.updated.description":
      return row.event.data.description.trim().length > 0
        ? row.event.data.description
        : "Cleared description";
    case "task.updated.status":
      return row.event.data.closeReason
        ? `Set status to ${formatSnakeCaseLabel(row.event.data.status)} (${row.event.data.closeReason})`
        : `Set status to ${formatSnakeCaseLabel(row.event.data.status)}`;
    case "task.archived":
      return `Archived at ${formatDate(row.event.data.archivedAt)}`;
    case "task.created":
      return "Task created";
  }
}

function isNonExpandableTaskEventRow(row: TaskEventRow): boolean {
  if (row.kind !== "generic") return false;
  return (
    row.event.type === "task.assigned" ||
    row.event.type === "task.dependency_added" ||
    row.event.type === "task.dependency_removed" ||
    row.event.type === "task.chat.thread_created"
  );
}

function TaskEventLogEntry({
  row,
  roleNameById,
  threadDisplayNameById,
  threadRoleById,
  threadAgentRoleIdById,
  projectId,
}: {
  row: TaskEventRow;
  roleNameById: Map<string, string>;
  threadDisplayNameById: Map<string, string>;
  threadRoleById: Map<string, TaskThreadRole>;
  threadAgentRoleIdById: Map<string, string>;
  projectId: string;
}) {
  const event = row.event;
  const [isExpanded, setIsExpanded] = useState(false);
  const isAssigneeEvent = row.kind === "generic" && event.type === "task.assigned";
  const isThreadCreatedEvent =
    row.kind === "generic" && event.type === "task.chat.thread_created";
  const isExpandable = !isNonExpandableTaskEventRow(row);
  const headerToneClass = getCollapsibleHeaderToneClass(isExpanded);
  const relativeTime = formatRelativeTime(event.createdAt);

  const assigneeRoleName =
    isAssigneeEvent && event.data.assignee.length > 0
      ? roleNameById.get(event.data.assignee) ?? event.data.assignee
      : null;
  const createdThreadDisplayName =
    isThreadCreatedEvent && event.data.threadId.length > 0
      ? threadDisplayNameById.get(event.data.threadId) ?? event.data.threadId
      : null;
  const createdThreadRole =
    isThreadCreatedEvent && event.data.threadId.length > 0
      ? event.data.taskRole ?? threadRoleById.get(event.data.threadId)
      : undefined;
  const createdThreadAgentRoleId =
    isThreadCreatedEvent && event.data.threadId.length > 0
      ? threadAgentRoleIdById.get(event.data.threadId)
      : undefined;
  const createdThreadAgentRoleName = createdThreadAgentRoleId
    ? (roleNameById.get(createdThreadAgentRoleId) ?? createdThreadAgentRoleId)
    : null;
  const createdThreadLabel = formatCreatedThreadLabel(createdThreadRole);

  const summaryContent =
    isAssigneeEvent && assigneeRoleName ? (
      <span className="inline-flex min-w-0 items-center gap-1.5">
        <span className="shrink-0 text-muted-foreground/90">Assigned to</span>
        <Link
          to={`/roles/${encodeURIComponent(event.data.assignee)}`}
          className="min-w-0 truncate text-foreground/95 underline underline-offset-2"
        >
          {assigneeRoleName}
        </Link>
        <span className="shrink-0 text-muted-foreground/80">· {relativeTime}</span>
      </span>
    ) : isThreadCreatedEvent && createdThreadDisplayName ? (
      <span className="inline-flex min-w-0 items-center gap-1.5">
        <span className="shrink-0 text-muted-foreground/90">{createdThreadLabel}</span>
        <Link
          to={`/projects/${projectId}/threads/${event.data.threadId}`}
          className="min-w-0 truncate text-foreground/95 underline underline-offset-2"
        >
          {createdThreadDisplayName}
        </Link>
        {createdThreadAgentRoleId && createdThreadAgentRoleName ? (
          <>
            <span className="shrink-0 text-muted-foreground/80">as</span>
            <Link
              to={`/roles/${encodeURIComponent(createdThreadAgentRoleId)}`}
              className="min-w-0 truncate text-foreground/95 underline underline-offset-2"
            >
              {createdThreadAgentRoleName}
            </Link>
          </>
        ) : null}
        <span className="shrink-0 text-muted-foreground/80">· {relativeTime}</span>
      </span>
    ) : isThreadCreatedEvent ? (
      `${createdThreadLabel} · ${relativeTime}`
    ) : row.kind === "status-updated" ? (
      <span className="inline-flex min-w-0 items-center gap-1.5">
        <span className="shrink-0 text-muted-foreground/90">Updated status to</span>
        <span className="truncate font-semibold text-foreground/95">
          {formatSnakeCaseLabel(row.toStatus)}
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
  const expandedDetail = isExpandable ? buildTaskEventDetailLine(row) : null;

  return (
    <div className="group w-full" style={{ overflowAnchor: "none" }}>
      <div className="mr-auto w-full">
        <div className="rounded-md text-muted-foreground">
          <div className={isExpanded ? "px-2 pb-0 pt-1" : "px-2 py-1"}>
            {isExpandable ? (
              <CollapsibleHeader
                isExpanded={isExpanded}
                onToggle={() => setIsExpanded((value) => !value)}
                toneClassName={headerToneClass}
                summaryClassName={
                  row.kind === "status-updated" || row.kind === "title-updated"
                    ? "min-w-0"
                    : COLLAPSIBLE_HEADER_TEXT_CLASS
                }
                summaryContent={summaryContent}
              />
            ) : (
              <CollapsibleHeader
                toneClassName={headerToneClass}
                summaryClassName={COLLAPSIBLE_HEADER_TEXT_CLASS}
                summaryContent={summaryContent}
              />
            )}
          </div>
          {isExpanded && expandedDetail ? (
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

function TaskThreadCompletionEntry({
  message,
  threadDisplayNameById,
  threadRoleById,
  threadAgentRoleIdById,
  roleNameById,
  projectId,
}: {
  message: TaskThreadTurnMessage;
  threadDisplayNameById: Map<string, string>;
  threadRoleById: Map<string, TaskThreadRole>;
  threadAgentRoleIdById: Map<string, string>;
  roleNameById: Map<string, string>;
  projectId: string;
}) {
  const [isExpanded, setIsExpanded] = useState(false);
  const headerToneClass = getCollapsibleHeaderToneClass(isExpanded);
  const relativeTime = formatRelativeTime(message.createdAt);
  const threadDisplayName =
    threadDisplayNameById.get(message.threadId) ?? message.threadId;
  const threadRole = threadRoleById.get(message.threadId);
  const threadAgentRoleId = threadAgentRoleIdById.get(message.threadId);
  const threadAgentRoleName = threadAgentRoleId
    ? (roleNameById.get(threadAgentRoleId) ?? threadAgentRoleId)
    : null;
  const completionLabel =
    threadRole === "worker" ? "Child thread completed" : "Thread completed";

  return (
    <div className="group w-full" style={{ overflowAnchor: "none" }}>
      <div className="mr-auto w-full">
        <div className="rounded-md text-muted-foreground">
          <div className={isExpanded ? "px-2 pb-0 pt-1" : "px-2 py-1"}>
            <CollapsibleHeader
              isExpanded={isExpanded}
              onToggle={() => setIsExpanded((value) => !value)}
              toneClassName={headerToneClass}
              summaryClassName={COLLAPSIBLE_HEADER_TEXT_CLASS}
              summaryContent={
                <span className="inline-flex min-w-0 items-center gap-1.5">
                  <span className="shrink-0 text-muted-foreground/90">
                    {completionLabel}
                  </span>
                  <Link
                    to={`/projects/${projectId}/threads/${message.threadId}`}
                    className="min-w-0 truncate text-foreground/95 underline underline-offset-2"
                  >
                    {threadDisplayName}
                  </Link>
                  {threadAgentRoleId && threadAgentRoleName ? (
                    <>
                      <span className="shrink-0 text-muted-foreground/80">as</span>
                      <Link
                        to={`/roles/${encodeURIComponent(threadAgentRoleId)}`}
                        className="min-w-0 truncate text-foreground/95 underline underline-offset-2"
                      >
                        {threadAgentRoleName}
                      </Link>
                    </>
                  ) : null}
                  <span className="shrink-0 text-muted-foreground/80">
                    · {relativeTime}
                  </span>
                </span>
              }
            />
          </div>
          {isExpanded ? (
            <div className="px-2 pb-0.5">
              <div className="overflow-hidden rounded-lg border border-border/60 bg-background/70">
                <div className="max-h-[280px] overflow-auto px-3 py-2">
                  <ConversationMarkdown content={message.text} />
                </div>
              </div>
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
  const rolesQuery = useRoles();
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
  const taskThreadsQuery = useThreads(
    task
      ? {
          projectId: task.projectId,
          taskId: task.id,
          includeArchived: true,
        }
      : undefined,
    { enabled: Boolean(task) },
  );
  const taskThreads = useMemo(
    () => (taskThreadsQuery.data ?? []).slice().sort((a, b) => a.createdAt - b.createdAt),
    [taskThreadsQuery.data],
  );
  const primaryThreads = useMemo(
    () =>
      taskThreads.filter(
        (thread) => thread.taskRole === "primary" || thread.taskRole === undefined,
      ),
    [taskThreads],
  );
  const currentPrimaryThread = useMemo(
    () => primaryThreads.filter((thread) => thread.archivedAt === undefined).at(-1),
    [primaryThreads],
  );
  const currentPrimaryThreadId = currentPrimaryThread?.id;
  const currentPrimaryThreadDisplayName =
    currentPrimaryThread?.title?.trim() || currentPrimaryThreadId;
  const currentPrimaryThreadRoleId = currentPrimaryThread?.agentRoleId;
  const primaryThreadIdSet = useMemo(
    () => new Set(primaryThreads.map((thread) => thread.id)),
    [primaryThreads],
  );
  const taskThreadIds = useMemo(
    () => taskThreads.map((thread) => thread.id),
    [taskThreads],
  );
  const taskThreadEventsQueries = useThreadEventsBatch(taskThreadIds);
  const taskThreadMessages = useMemo(() => {
    const messages: TaskThreadTurnMessage[] = [];
    for (let i = 0; i < taskThreads.length; i += 1) {
      const thread = taskThreads[i];
      const threadEvents = taskThreadEventsQueries[i]?.data ?? [];
      for (const message of toTaskThreadTurnMessages(thread, threadEvents)) {
        if (message.kind !== "assistant-text") continue;
        messages.push(message);
      }
    }
    messages.sort((a, b) => {
      if (a.createdAt !== b.createdAt) return a.createdAt - b.createdAt;
      return a.sourceSeqStart - b.sourceSeqStart;
    });
    return messages;
  }, [taskThreadEventsQueries, taskThreads]);
  const isTaskThreadEventsLoading = taskThreadEventsQueries.some(
    (query) => query.isLoading,
  );
  const taskActivityRows = useMemo(() => {
    const activityRows: TaskActivityRow[] = [];
    for (let i = 0; i < taskEventRows.length; i += 1) {
      const row = taskEventRows[i];
      const taskChatMessage = toTaskChatActivityMessage(row.event);
      if (taskChatMessage) {
        activityRows.push({
          kind: "task-chat-message",
          id: `task-chat-message:${row.event.id}`,
          createdAt: row.event.createdAt,
          order: i,
          message: taskChatMessage,
        });
      } else {
        activityRows.push({
          kind: "task-event",
          id: `task-event:${row.event.id}`,
          createdAt: row.event.createdAt,
          order: i,
          row,
        });
      }
    }
    const offset = taskEventRows.length;
    for (let i = 0; i < taskThreadMessages.length; i += 1) {
      const message = taskThreadMessages[i];
      if (primaryThreadIdSet.has(message.threadId)) {
        activityRows.push({
          kind: "agent-message",
          id: `agent-message:${message.id}`,
          createdAt: message.createdAt,
          order: offset + i,
          message,
        });
      } else {
        activityRows.push({
          kind: "thread-completed",
          id: `thread-completed:${message.id}`,
          createdAt: message.createdAt,
          order: offset + i,
          message,
        });
      }
    }

    activityRows.sort((a, b) => {
      if (a.createdAt !== b.createdAt) return a.createdAt - b.createdAt;
      return a.order - b.order;
    });
    return activityRows;
  }, [primaryThreadIdSet, taskThreadMessages, taskEventRows]);
  const { containerRef, handleScroll: baseHandleScroll } = useAutoScroll(
    taskActivityRows,
    taskId,
  );
  const { showScrollToBottom, handleScroll, scrollToBottom } =
    useScrollToBottomIndicator({
      containerRef,
      onBaseScroll: baseHandleScroll,
      resetDep: taskId,
    });
  const showAgentWorking =
    taskChat.isPending ||
    taskThreads.some(
      (thread) =>
        thread.archivedAt === undefined &&
        (thread.status === "active" ||
          thread.status === "created" ||
          thread.status === "provisioning"),
    );
  const taskThreadDisplayNameById = useMemo(() => {
    return new Map(
      taskThreads.map((thread) => [thread.id, thread.title?.trim() || thread.id]),
    );
  }, [taskThreads]);
  const taskThreadRoleById = useMemo(() => {
    const roleById = new Map<string, TaskThreadRole>();
    for (const thread of taskThreads) {
      if (thread.taskRole) {
        roleById.set(thread.id, thread.taskRole);
      }
    }
    return roleById;
  }, [taskThreads]);
  const taskThreadAgentRoleIdById = useMemo(() => {
    const roleById = new Map<string, string>();
    for (const thread of taskThreads) {
      if (thread.agentRoleId) {
        roleById.set(thread.id, thread.agentRoleId);
      }
    }
    return roleById;
  }, [taskThreads]);
  const roleNameById = useMemo(() => {
    return new Map((rolesQuery.data ?? []).map((role) => [role.id, role.name]));
  }, [rolesQuery.data]);

  if (!projectId || !taskId) {
    return (
      <PageShell contentClassName="min-h-full items-center justify-center">
        <p className="py-12 text-center text-sm text-destructive">Not found</p>
      </PageShell>
    );
  }

  if (isLoading) {
    return (
      <PageShell contentClassName="min-h-full items-center justify-center">
        <p className="py-12 text-center text-sm text-muted-foreground">
          Loading task...
        </p>
      </PageShell>
    );
  }

  if (error || !task || task.projectId !== projectId) {
    return (
      <PageShell contentClassName="min-h-full items-center justify-center">
        <p className="py-12 text-center text-sm text-destructive">
          {error ? error.message : "Not found"}
        </p>
      </PageShell>
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
    <PageShell
      scrollRef={containerRef}
      onScroll={handleScroll}
      contentClassName="gap-3 pt-0"
      footerUsesPromptPadding
      footer={
        <>
          <ScrollToBottomButton
            visible={showScrollToBottom}
            onClick={scrollToBottom}
          />
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
        </>
      }
    >
      <section className="sticky top-0 z-10 shrink-0 bg-background pt-2">
        <DetailCard>
          {task.description && task.description.trim().length > 0 ? (
            <div className="py-1">
              <dt className="sr-only">Description</dt>
              <dd className="min-w-0 break-words text-sm text-foreground/90">
                {task.description}
              </dd>
            </div>
          ) : null}
          <DetailRow label="Status" align="center">
            <div className="inline-flex max-w-full">
              <div className="relative inline-flex items-center rounded-sm px-0.5 focus-within:ring-1 focus-within:ring-ring">
                <span className="pointer-events-none text-sm text-foreground">
                  {formatSnakeCaseLabel(task.status)}
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
                  {TASK_STATUS_OPTIONS.map((statusOption) => (
                    <option key={statusOption} value={statusOption}>
                      {formatSnakeCaseLabel(statusOption)}
                    </option>
                  ))}
                </select>
              </div>
            </div>
          </DetailRow>
          {statusErrorMessage ? (
            <DetailMessageRow>
              <p className="text-xs text-destructive">{statusErrorMessage}</p>
            </DetailMessageRow>
          ) : null}
          {task.status === "closed" ? (
            <DetailMessageRow>
              <p className="text-xs text-muted-foreground">
                Closed tasks cannot be reopened.
              </p>
            </DetailMessageRow>
          ) : null}
          <DetailRow label="Assignee" align="center">
            <TaskAssigneeSelector
              value={task.assignee}
              onChange={(nextRoleId) => {
                if (assignmentErrorMessage) setAssignmentErrorMessage(null);
                handleAssignRole(nextRoleId);
              }}
              className="h-auto px-0 text-sm text-foreground/90 hover:text-foreground"
            />
          </DetailRow>
          {assignmentErrorMessage ? (
            <DetailMessageRow>
              <p className="text-xs text-destructive">
                {assignmentErrorMessage}
              </p>
            </DetailMessageRow>
          ) : null}
          {currentPrimaryThreadId ? (
            <DetailRow label="Primary Thread" valueClassName="min-w-0 truncate">
              <Link
                to={`/projects/${projectId}/threads/${currentPrimaryThreadId}`}
                className="underline underline-offset-2"
              >
                {currentPrimaryThreadDisplayName}
              </Link>
            </DetailRow>
          ) : null}
          {currentPrimaryThreadRoleId ? (
            <DetailRow label="Primary Role" valueClassName="min-w-0 truncate">
              <Link
                to={`/roles/${encodeURIComponent(currentPrimaryThreadRoleId)}`}
                className="underline underline-offset-2"
              >
                {roleNameById.get(currentPrimaryThreadRoleId) ??
                  currentPrimaryThreadRoleId}
              </Link>
            </DetailRow>
          ) : null}
          <DetailRow label="Created">{formatDate(task.createdAt)}</DetailRow>
          <DetailRow label="Updated">{formatDate(task.updatedAt)}</DetailRow>
          {task.closeReason ? (
            <DetailRow label="Close Reason">{task.closeReason}</DetailRow>
          ) : null}
        </DetailCard>
      </section>

      <section className="min-h-0">
        {taskEventsQuery.isLoading ||
        taskThreadsQuery.isLoading ||
        isTaskThreadEventsLoading ? (
          <div className="py-6 text-center text-sm text-muted-foreground">
            Loading task activity...
          </div>
        ) : taskActivityRows.length === 0 ? (
          <div className="py-6 text-center text-sm text-muted-foreground">
            No task activity yet.
          </div>
        ) : (
          <div className="space-y-0.5 py-1">
            {taskActivityRows.map((activityRow) =>
              activityRow.kind === "task-event" ? (
                <TaskEventLogEntry
                  key={activityRow.id}
                  row={activityRow.row}
                  roleNameById={roleNameById}
                  threadDisplayNameById={taskThreadDisplayNameById}
                  threadRoleById={taskThreadRoleById}
                  threadAgentRoleIdById={taskThreadAgentRoleIdById}
                  projectId={projectId}
                />
              ) : activityRow.kind === "thread-completed" ? (
                <TaskThreadCompletionEntry
                  key={activityRow.id}
                  message={activityRow.message}
                  threadDisplayNameById={taskThreadDisplayNameById}
                  threadRoleById={taskThreadRoleById}
                  threadAgentRoleIdById={taskThreadAgentRoleIdById}
                  roleNameById={roleNameById}
                  projectId={projectId}
                />
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
      </section>
    </PageShell>
  );
}
