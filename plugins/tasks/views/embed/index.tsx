import { useCallback, useEffect, useRef, useState } from "react";
import type {
  PluginMessageDirectiveProps,
  PluginThreadPanelProps,
} from "@get-bb/plugin-sdk";
import { useBbNavigate, useRealtime } from "@get-bb/plugin-sdk/app";
import { Button } from "@bb/shared-ui/button";
import { Icon } from "@bb/shared-ui/icon";
import { Skeleton } from "@bb/shared-ui/skeleton";
import type { Task } from "../../shared/contract.js";
import { useTasksRpc } from "../../shell/data.js";
import { TasksRefreshProvider } from "../../shell/refresh.js";
import { PANEL_PATH, tasksRouteToSubPath } from "../../shell/routes.js";
import { DetailView } from "../detail/index.js";
import { PRIORITY_LABELS, STATUS_LABELS } from "../list/lib.js";
import { PriorityIcon, StatusIcon } from "../list/icons.js";

const TASK_KEY_PATTERN = /^[A-Za-z][A-Za-z0-9]{0,9}-\d+$/;

type TaskEmbedState =
  | { kind: "loading" }
  | { kind: "found"; task: Task }
  | { kind: "not_found" }
  | { kind: "error" };

function useTaskEmbed(taskKey: string): {
  state: TaskEmbedState;
  retry: () => void;
} {
  const rpc = useTasksRpc();
  const [state, setState] = useState<TaskEmbedState>({ kind: "loading" });
  const seqRef = useRef(0);
  const stateRef = useRef(state);
  stateRef.current = state;

  const refresh = useCallback(() => {
    if (taskKey === "") return;
    const seq = ++seqRef.current;
    rpc.call("getTaskByKey", { taskKey }).then(
      ({ task }) => {
        if (seq !== seqRef.current) return;
        setState(task ? { kind: "found", task } : { kind: "not_found" });
      },
      () => {
        if (seq !== seqRef.current) return;
        setState({ kind: "error" });
      },
    );
  }, [rpc, taskKey]);

  useEffect(() => {
    setState({ kind: "loading" });
    refresh();
  }, [refresh]);

  const onEvent = useCallback(
    (matches: (task: Task) => boolean) => {
      const current = stateRef.current;
      if (current.kind !== "found" || matches(current.task)) refresh();
    },
    [refresh],
  );
  useRealtime("tasks:changed", (payload) => {
    const taskId = isRecord(payload) ? payload.taskId : undefined;
    onEvent((task) => typeof taskId !== "string" || taskId === task.id);
  });
  useRealtime("projects:changed", (payload) => {
    const projectId = isRecord(payload) ? payload.projectId : undefined;
    onEvent(
      (task) => typeof projectId !== "string" || projectId === task.projectId,
    );
  });

  return { state, retry: refresh };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function taskDetailSubPath(taskKey: string): string {
  return tasksRouteToSubPath({ kind: "task", taskKey });
}

function OpenInTasksButton({
  label,
  subPath,
}: {
  label: string;
  subPath?: string;
}) {
  const navigate = useBbNavigate();
  return (
    <Button
      className="size-8 shrink-0"
      size="icon"
      variant="ghost"
      aria-label={label}
      onClick={() =>
        navigate.toPluginPanel(
          PANEL_PATH,
          subPath === undefined ? {} : { subPath },
        )
      }
    >
      <Icon name="ArrowUpRight" className="size-4" />
    </Button>
  );
}

function CardShell({
  dashed = false,
  children,
}: {
  dashed?: boolean;
  children: React.ReactNode;
}) {
  return (
    <div
      className={
        dashed
          ? "my-3 flex h-11 items-center gap-1 rounded-lg border border-dashed border-border bg-surface-recessed-solid px-2"
          : "my-3 flex h-11 items-center gap-1 rounded-lg border border-border bg-card px-2 shadow-sm transition-colors hover:bg-state-hover"
      }
    >
      {children}
    </div>
  );
}

function embedAriaLabel(task: Task): string {
  const parts = [
    `${task.key} — ${task.title}`,
    STATUS_LABELS[task.status].toLowerCase(),
  ];
  if (task.priority !== "none") {
    parts.push(`${PRIORITY_LABELS[task.priority].toLowerCase()} priority`);
  }
  return `${parts.join(", ")} — open in side panel`;
}

export function TaskDirectiveCard({ attributes }: PluginMessageDirectiveProps) {
  const navigate = useBbNavigate();
  const taskKey = attributes.key?.trim() ?? "";
  const fallbackTitle = attributes.title?.trim() || null;
  const validKey = TASK_KEY_PATTERN.test(taskKey);
  const { state, retry } = useTaskEmbed(validKey ? taskKey : "");

  if (!validKey) {
    return (
      <div className="my-3 rounded-lg border border-destructive/40 bg-destructive/5 p-3 text-sm text-destructive">
        Invalid task link. Expected a task key like TSK-4.
      </div>
    );
  }

  if (state.kind === "loading") {
    return (
      <CardShell>
        <div
          role="status"
          aria-label={`Loading task ${taskKey}`}
          className="flex min-w-0 flex-1 items-center gap-2 px-1"
        >
          <Skeleton className="size-3.5 shrink-0 rounded-full" />
          <span className="shrink-0 font-mono text-xs text-muted-foreground">
            {taskKey}
          </span>
          {fallbackTitle ? (
            <span className="min-w-0 flex-1 truncate text-sm font-medium text-muted-foreground">
              {fallbackTitle}
            </span>
          ) : (
            <Skeleton className="h-3.5 w-1/2" />
          )}
        </div>
      </CardShell>
    );
  }

  if (state.kind === "not_found") {
    return (
      <CardShell dashed>
        <div className="flex min-w-0 flex-1 items-center gap-2 px-1">
          <StatusIcon status="backlog" />
          <span className="shrink-0 font-mono text-xs text-muted-foreground">
            {taskKey}
          </span>
          <span className="min-w-0 flex-1 truncate text-sm text-muted-foreground">
            {fallbackTitle
              ? `${fallbackTitle} · not found`
              : "Task not found — deleted, or its key changed"}
          </span>
        </div>
        <OpenInTasksButton label="Open Tasks" />
      </CardShell>
    );
  }

  if (state.kind === "error") {
    return (
      <CardShell dashed>
        <div className="flex min-w-0 flex-1 items-center gap-2 px-1">
          <Icon
            name="AlertCircle"
            className="size-3.5 shrink-0 text-muted-foreground"
          />
          <span className="shrink-0 font-mono text-xs text-muted-foreground">
            {taskKey}
          </span>
          <span className="min-w-0 flex-1 truncate text-sm text-muted-foreground">
            Couldn't load this task
          </span>
        </div>
        <Button variant="ghost" size="sm" className="shrink-0" onClick={retry}>
          Retry
        </Button>
      </CardShell>
    );
  }

  const { task } = state;
  const openInSidePanel = () => {
    const opened = navigate.openThreadPanel({
      actionId: "task",
      title: task.key,
      params: { taskKey: task.key },
    });
    if (!opened) {
      navigate.toPluginPanel(PANEL_PATH, {
        subPath: taskDetailSubPath(task.key),
      });
    }
  };

  return (
    <CardShell>
      <button
        type="button"
        className="flex min-w-0 flex-1 items-center gap-2 rounded-md px-1 py-1 text-left focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
        aria-label={embedAriaLabel(task)}
        onClick={openInSidePanel}
      >
        <span aria-hidden>
          <StatusIcon status={task.status} />
        </span>
        <span
          aria-hidden
          className="shrink-0 font-mono text-xs text-muted-foreground"
        >
          {task.key}
        </span>
        <span
          aria-hidden
          className="min-w-0 flex-1 truncate text-sm font-medium"
        >
          {task.title}
        </span>
        {task.priority !== "none" ? (
          <span aria-hidden className="shrink-0">
            <PriorityIcon priority={task.priority} />
          </span>
        ) : null}
      </button>
      <OpenInTasksButton
        label={`Open ${task.key} in Tasks`}
        subPath={taskDetailSubPath(task.key)}
      />
    </CardShell>
  );
}

function TaskEmbedPanelContent({ params }: PluginThreadPanelProps) {
  const taskKey =
    isRecord(params) && typeof params.taskKey === "string"
      ? params.taskKey
      : null;
  if (taskKey === null || !TASK_KEY_PATTERN.test(taskKey.trim())) {
    return (
      <div className="p-3 text-sm text-muted-foreground">
        Open a task card from a message to view it here.
      </div>
    );
  }
  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex h-10 shrink-0 items-center gap-2 border-b border-border pb-2">
        <div className="min-w-0 flex-1 truncate font-mono text-xs text-muted-foreground">
          {taskKey.trim()}
        </div>
        <OpenInTasksButton
          label={`Open ${taskKey.trim()} in Tasks`}
          subPath={taskDetailSubPath(taskKey.trim())}
        />
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto">
        <DetailView taskKey={taskKey.trim()} />
      </div>
    </div>
  );
}

export function TaskEmbedPanel(props: PluginThreadPanelProps) {
  return (
    <TasksRefreshProvider>
      <TaskEmbedPanelContent {...props} />
    </TasksRefreshProvider>
  );
}
