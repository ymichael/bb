import { useState } from "react";
import {
  UrlLink as UrlLink,
  useBbNavigate,
  useRpc,
} from "@get-bb/plugin-sdk/app";
import type { DelegationRpcContract } from "../../delegate/contract.js";
import type {
  Preset,
  TaskPullRequest,
  TaskThread,
} from "../../shared/contract.js";
import {
  PR_STATE_META,
  THREAD_STATUS_META,
  formatRelativeTime,
  isActiveThread,
} from "./meta.js";
import { PresetDialog, savePresetDraft } from "../manage/preset-dialog.js";
import { ConfirmDialog } from "../../components/confirm-dialog.js";
import { useTasksRpc } from "../../shell/data.js";
import { Button } from "@bb/shared-ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuTrigger,
} from "@bb/shared-ui/dropdown-menu";
import { Icon } from "@bb/shared-ui/icon";
import { cn } from "@bb/shared-ui/lib/utils";

function ThreadPullRequestPill({
  pullRequest,
  unavailable,
}: {
  pullRequest: TaskPullRequest | undefined;
  unavailable: boolean;
}) {
  if (pullRequest) {
    const meta = PR_STATE_META[pullRequest.state];
    return (
      <UrlLink
        href={pullRequest.url}
        target="_blank"
        rel="noopener noreferrer"
        title={`${pullRequest.title} (${meta.label})`}
        aria-label={`Pull request #${pullRequest.number}: ${pullRequest.title} (${meta.label})`}
        className="flex shrink-0 items-center gap-1 rounded-full border border-border bg-secondary px-2 py-0.5 text-xs font-medium shadow-2xs hover:border-input"
      >
        <Icon name={meta.icon} className={cn("size-3", meta.textClassName)} />#
        {pullRequest.number}
      </UrlLink>
    );
  }
  if (unavailable) {
    return (
      <span
        title="Couldn't check this thread's pull request"
        className="shrink-0 text-xs text-muted-foreground"
      >
        PR unavailable
      </span>
    );
  }
  return null;
}

function ThreadCard({
  thread,
  pullRequest,
  pullRequestUnavailable,
  busy,
  onDetach,
}: {
  thread: TaskThread;
  pullRequest: TaskPullRequest | undefined;
  pullRequestUnavailable: boolean;
  busy: boolean;
  onDetach: () => void;
}) {
  const navigate = useBbNavigate();
  const meta = THREAD_STATUS_META[thread.liveStatus];
  return (
    <div className="mb-2 flex items-center gap-3 rounded-md border border-border bg-card px-3 py-2 shadow-2xs">
      <span
        className={cn(
          "flex shrink-0 items-center gap-1.5 text-xs font-medium",
          meta.textClassName,
        )}
      >
        <span
          aria-hidden
          className={cn("size-1.5 rounded-full", meta.dotClassName)}
        />
        {meta.label}
      </span>
      <div className="min-w-0 flex-1">
        <div className="truncate text-sm font-medium">{thread.title}</div>
        <div className="text-xs text-muted-foreground">
          {thread.presetName} · attached {formatRelativeTime(thread.attachedAt)}
        </div>
      </div>
      <ThreadPullRequestPill
        pullRequest={pullRequest}
        unavailable={pullRequestUnavailable}
      />
      <button
        type="button"
        className="flex shrink-0 items-center gap-1 text-xs font-medium underline decoration-input underline-offset-2 hover:decoration-current"
        onClick={() => navigate.toThread(thread.threadId)}
      >
        Open thread
        <Icon name="ArrowUpRight" className="size-3" />
      </button>
      <button
        type="button"
        aria-label={`Detach ${thread.title}`}
        title="Detach from task"
        disabled={busy}
        className="shrink-0 rounded p-0.5 text-muted-foreground hover:bg-state-hover hover:text-foreground disabled:opacity-70"
        onClick={onDetach}
      >
        <Icon name="X" className="size-3" />
      </button>
    </div>
  );
}

const LAST_PRESET_STORAGE_KEY = "bb-tasks:last-dispatch-preset";

function loadLastPresetId(): string | null {
  try {
    return window.localStorage.getItem(LAST_PRESET_STORAGE_KEY);
  } catch {
    return null;
  }
}

function storeLastPresetId(presetId: string): void {
  try {
    window.localStorage.setItem(LAST_PRESET_STORAGE_KEY, presetId);
  } catch {}
}

interface DispatchControlProps {
  taskId: string;
  presets: Preset[] | undefined;
  onError: (message: string) => void;
  align?: "start" | "end";
  className?: string;
}

export function DispatchControl({
  taskId,
  presets,
  onError,
  align = "end",
  className,
}: DispatchControlProps) {
  const rpc = useRpc<DelegationRpcContract>();
  const tasksRpc = useTasksRpc();
  const [dispatching, setDispatching] = useState(false);
  const [lastPresetId, setLastPresetId] = useState(loadLastPresetId);
  const [createDialogKey, setCreateDialogKey] = useState<number | null>(null);

  const dispatch = async (presetId: string) => {
    setDispatching(true);
    try {
      await rpc.call("delegate", { taskId, presetId });
    } catch (error) {
      onError(error instanceof Error ? error.message : String(error));
    } finally {
      setDispatching(false);
    }
  };

  const pickPreset = (preset: Preset) => {
    setLastPresetId(preset.id);
    storeLastPresetId(preset.id);
    void dispatch(preset.id);
  };

  const primarySegment =
    "bg-primary text-primary-foreground hover:bg-primary/90";

  if (presets !== undefined && presets.length === 0) {
    return (
      <>
        <Button
          size="sm"
          className={cn("h-7 gap-1.5", primarySegment, className)}
          onClick={() => setCreateDialogKey(Date.now())}
        >
          <Icon name="Plus" className="size-3.5 shrink-0" />
          Add a preset…
        </Button>
        {createDialogKey !== null ? (
          <PresetDialog
            key={createDialogKey}
            open
            onOpenChange={(open) => {
              if (!open) setCreateDialogKey(null);
            }}
            editing={null}
            onSave={(draft) => savePresetDraft(tasksRpc, null, draft)}
          />
        ) : null}
      </>
    );
  }

  const current =
    presets?.find((preset) => preset.id === lastPresetId) ??
    (presets
      ? [...presets].sort((a, b) => a.name.localeCompare(b.name))[0]
      : undefined);

  return (
    <>
      <div className={cn("flex min-w-0", className)}>
        <Button
          size="sm"
          disabled={dispatching || !current}
          className={cn(
            "h-7 min-w-0 flex-1 gap-1.5 rounded-r-none",
            primarySegment,
          )}
          onClick={() => {
            if (current) pickPreset(current);
          }}
        >
          <span className="truncate">
            {dispatching ? "Dispatching…" : (current?.name ?? "Dispatch")}
          </span>
        </Button>
        <DropdownMenu>
          <DropdownMenuTrigger asChild disabled={dispatching || !current}>
            <Button
              size="sm"
              aria-label="Choose dispatch preset"
              className={cn(
                "h-7 shrink-0 rounded-l-none border-l border-primary-foreground/25 px-1",
                primarySegment,
              )}
            >
              <Icon name="ChevronDown" className="size-3.5" />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align={align}>
            <DropdownMenuLabel>Dispatch with preset</DropdownMenuLabel>
            {(presets ?? []).map((preset) => (
              <DropdownMenuItem
                key={preset.id}
                onSelect={() => pickPreset(preset)}
              >
                <span className="min-w-0 flex-1 truncate">{preset.name}</span>
                <span className="text-xs text-muted-foreground">
                  {preset.modelId}
                </span>
                {preset.id === current?.id ? (
                  <Icon name="Check" className="size-3.5" />
                ) : null}
              </DropdownMenuItem>
            ))}
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
    </>
  );
}

interface ThreadsSectionProps {
  threads: TaskThread[];
  pullRequests: TaskPullRequest[] | undefined;
  unavailableThreadIds: string[];
  onDetach: (thread: TaskThread) => Promise<void>;
  onError: (message: string) => void;
}

export function ThreadsSection({
  threads,
  pullRequests,
  unavailableThreadIds,
  onDetach,
  onError,
}: ThreadsSectionProps) {
  const [confirm, setConfirm] = useState<TaskThread | null>(null);
  const [pending, setPending] = useState<ReadonlySet<string>>(new Set());

  const performDetach = async (thread: TaskThread) => {
    setPending((current) => new Set(current).add(thread.id));
    try {
      await onDetach(thread);
    } catch (error) {
      onError(error instanceof Error ? error.message : String(error));
    } finally {
      setPending((current) => {
        const next = new Set(current);
        next.delete(thread.id);
        return next;
      });
    }
  };

  const activeCount = threads.filter(isActiveThread).length;
  const pullRequestByThread = new Map<string, TaskPullRequest>();
  for (const pullRequest of pullRequests ?? []) {
    for (const threadId of pullRequest.threadIds) {
      pullRequestByThread.set(threadId, pullRequest);
    }
  }
  const unavailable = new Set(unavailableThreadIds);

  return (
    <section>
      <div className="mb-2 flex items-center gap-2 pt-1.5 text-xs font-semibold text-muted-foreground">
        Agent threads
        {activeCount > 0 ? (
          <span className="font-normal">{activeCount} working now</span>
        ) : null}
      </div>
      {threads.map((thread) => (
        <ThreadCard
          key={thread.id}
          thread={thread}
          pullRequest={pullRequestByThread.get(thread.threadId)}
          pullRequestUnavailable={unavailable.has(thread.threadId)}
          busy={pending.has(thread.id)}
          onDetach={() => setConfirm(thread)}
        />
      ))}
      <ConfirmDialog
        open={confirm !== null}
        onOpenChange={(open) => {
          if (!open) setConfirm(null);
        }}
        title="Detach thread?"
        description={
          confirm
            ? `"${confirm.title}" will no longer be listed on this task. The thread itself is not deleted; re-attach it with bb tasks attach.`
            : ""
        }
        confirmLabel="Detach"
        onConfirm={() => {
          if (confirm) void performDetach(confirm);
        }}
      />
    </section>
  );
}
