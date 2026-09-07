import type { BbPluginApi } from "@get-bb/plugin-sdk";
import { publishCommentsChanged, type TasksApiStore } from "../api";
import type { TaskThread, TaskThreadLiveStatus } from "../db";
import { createSystemComment, publishThreadsChanged } from "../delegate";

const TERMINAL_LIVE_STATUSES = new Set<TaskThreadLiveStatus>(["completed"]);
export const THREAD_STATUS_RECONCILE_INTERVAL_MS = 5 * 60_000;
export const THREAD_STATUS_IDLE_INTERVAL_MS = 60_000;

type SdkThread = Awaited<ReturnType<BbPluginApi["sdk"]["threads"]["get"]>>;

function liveStatusFromThread(thread: SdkThread): TaskThreadLiveStatus {
  if (thread.status === "error") return "failed";
  if (thread.deletedAt !== null) return "completed";

  switch (thread.status) {
    // A pending thread has been created but has never dispatched. It is on
    // its way to running, which is exactly what "starting" means to a task.
    case "pending":
    case "starting":
      return "starting";
    case "active":
    case "stopping":
      return "working";
    case "idle":
      return "idle";
  }
}

function trackedThreads(store: TasksApiStore, threadId?: string): TaskThread[] {
  const tracked: TaskThread[] = [];
  for (const task of store.tasks.listTasks()) {
    for (const thread of store.tasks.listTaskThreads(task.id)) {
      if (threadId === undefined || thread.threadId === threadId) {
        tracked.push(thread);
      }
    }
  }
  return tracked;
}

function statusCommentBody(
  thread: TaskThread,
  liveStatus: Extract<TaskThreadLiveStatus, "completed" | "failed">,
): string {
  const outcome =
    liveStatus === "completed" ? "completed — final message posted" : "failed";
  return `Thread "${thread.title}" ${outcome} · ${thread.threadId}`;
}

function sdkErrorCode(error: unknown): string | undefined {
  if (typeof error !== "object" || error === null || !("code" in error)) {
    return undefined;
  }
  return typeof error.code === "string" ? error.code : undefined;
}

function transitionThread(
  bb: BbPluginApi,
  store: TasksApiStore,
  thread: TaskThread,
  liveStatus: TaskThreadLiveStatus,
): void {
  if (
    thread.liveStatus === liveStatus ||
    TERMINAL_LIVE_STATUSES.has(thread.liveStatus)
  ) {
    return;
  }

  store.transaction(() => {
    store.tasks.updateTaskThreadStatus(thread.id, liveStatus);
    if (liveStatus === "completed" || liveStatus === "failed") {
      createSystemComment(store.tasks, {
        taskId: thread.taskId,
        presetName: thread.presetName,
        threadId: thread.threadId,
        body: statusCommentBody(thread, liveStatus),
      });
    }
  });

  publishThreadsChanged(bb, thread.taskId);
  publishCommentsChanged(bb, thread.taskId);
}

function transitionTrackedThread(
  bb: BbPluginApi,
  store: TasksApiStore,
  threadId: string,
  liveStatus: TaskThreadLiveStatus,
): void {
  for (const thread of trackedThreads(store, threadId)) {
    transitionThread(bb, store, thread, liveStatus);
  }
}

async function reconcileTrackedThread(
  bb: BbPluginApi,
  store: TasksApiStore,
  trackedThread: TaskThread,
): Promise<void> {
  try {
    const thread = await bb.sdk.threads.get({
      threadId: trackedThread.threadId,
    });
    transitionThread(bb, store, trackedThread, liveStatusFromThread(thread));
  } catch (error) {
    if (sdkErrorCode(error) === "thread_not_found") {
      transitionThread(bb, store, trackedThread, "completed");
      return;
    }
    bb.log.warn(
      `Could not reconcile task thread ${trackedThread.threadId}: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }
}

async function reconcileTrackedThreads(
  bb: BbPluginApi,
  store: TasksApiStore,
): Promise<void> {
  const nonTerminalThreads = trackedThreads(store).filter(
    (thread) => !TERMINAL_LIVE_STATUSES.has(thread.liveStatus),
  );

  for (const trackedThread of nonTerminalThreads) {
    await reconcileTrackedThread(bb, store, trackedThread);
  }
}

function hasNonTerminalTrackedThreads(store: TasksApiStore): boolean {
  return trackedThreads(store).some(
    (thread) => !TERMINAL_LIVE_STATUSES.has(thread.liveStatus),
  );
}

function waitForNextReconciliation(
  signal: AbortSignal,
  intervalMs: number,
): Promise<void> {
  if (signal.aborted) return Promise.resolve();
  return new Promise((resolve) => {
    const onAbort = () => {
      clearTimeout(timer);
      resolve();
    };
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, intervalMs);
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

export async function registerLifecycle(
  bb: BbPluginApi,
  store: TasksApiStore,
): Promise<void> {
  bb.events.on("thread.created", ({ thread }) => {
    transitionTrackedThread(bb, store, thread.id, liveStatusFromThread(thread));
  });
  bb.events.on("thread.active", ({ thread }) => {
    transitionTrackedThread(bb, store, thread.id, "working");
  });
  bb.events.on("thread.idle", ({ thread }) => {
    transitionTrackedThread(bb, store, thread.id, "idle");
  });
  bb.events.on("thread.failed", ({ thread }) => {
    transitionTrackedThread(bb, store, thread.id, "failed");
  });
  bb.events.on("thread.deleted", ({ thread }) => {
    transitionTrackedThread(bb, store, thread.id, "completed");
  });

  bb.background.service("thread-status-reconcile", {
    async start(signal) {
      while (!signal.aborted) {
        if (!hasNonTerminalTrackedThreads(store)) {
          await waitForNextReconciliation(
            signal,
            THREAD_STATUS_IDLE_INTERVAL_MS,
          );
          continue;
        }
        await waitForNextReconciliation(
          signal,
          THREAD_STATUS_RECONCILE_INTERVAL_MS,
        );
        if (signal.aborted) break;
        await reconcileTrackedThreads(bb, store);
      }
    },
  });

  await reconcileTrackedThreads(bb, store);
  await reconcileTrackedThreads(bb, store);
}
