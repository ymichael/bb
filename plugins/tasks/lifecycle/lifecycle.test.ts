import {
  createFakePluginHost,
  makeThreadResponse,
} from "@get-bb/plugin-sdk/testing";
import { describe, expect, it, vi } from "vitest";
import { createStore } from "../api";
import type { TaskThreadLiveStatus } from "../db";
import {
  registerLifecycle,
  THREAD_STATUS_IDLE_INTERVAL_MS,
  THREAD_STATUS_RECONCILE_INTERVAL_MS,
} from ".";

interface TrackedThreadFixture {
  bb: ReturnType<typeof createFakePluginHost>["bb"];
  harness: ReturnType<typeof createFakePluginHost>["harness"];
  store: ReturnType<typeof createStore>;
  taskId: string;
  taskThreadId: string;
}

function trackedThreadFixture(
  liveStatus: TaskThreadLiveStatus,
  sdkStatus: "idle" | "starting" | "active" | "stopping" | "error",
): TrackedThreadFixture {
  const host = createFakePluginHost({
    pluginId: "tasks",
    sdk: {
      threads: {
        get: async () =>
          makeThreadResponse({
            id: "thr_worker",
            title: "Lifecycle worker",
            status: sdkStatus,
          }),
      },
    },
  });
  const store = createStore(host.bb);
  const project = store.tasks.createProject({
    name: "Tasks plugin",
    prefix: "TASK",
    color: "blue",
  });
  const task = store.tasks.createTask({
    projectId: project.id,
    title: "Track lifecycle",
  });
  const taskThread = store.tasks.upsertTaskThread({
    taskId: task.id,
    threadId: "thr_worker",
    presetName: "GPT-5.6 · high",
    title: "Lifecycle worker",
    liveStatus,
  });

  return {
    ...host,
    store,
    taskId: task.id,
    taskThreadId: taskThread.id,
  };
}

describe("task thread lifecycle", () => {
  it("moves a working thread to completed, comments, and publishes", async () => {
    const fixture = trackedThreadFixture("working", "active");
    await registerLifecycle(fixture.bb, fixture.store);

    await fixture.harness.emitThreadEvent("thread.deleted", {
      thread: makeThreadResponse({
        id: "thr_worker",
        title: "Lifecycle worker",
        deletedAt: Date.now(),
      }),
    });

    expect(
      fixture.store.tasks.getTaskThread(fixture.taskThreadId)?.liveStatus,
    ).toBe("completed");
    expect(fixture.store.tasks.listComments(fixture.taskId)).toContainEqual(
      expect.objectContaining({
        kind: "system",
        authorName: "Tasks",
        presetName: "GPT-5.6 · high",
        threadId: "thr_worker",
        body: 'Thread "Lifecycle worker" completed — final message posted · thr_worker',
      }),
    );
    expect(fixture.harness.realtimeSignals).toEqual([
      { channel: "threads:changed", payload: { taskId: fixture.taskId } },
      { channel: "comments:changed", payload: { taskId: fixture.taskId } },
    ]);

    await fixture.harness.dispose();
  });

  it("recovers a failed thread without recording failure as terminal", async () => {
    const fixture = trackedThreadFixture("working", "active");
    await registerLifecycle(fixture.bb, fixture.store);

    await fixture.harness.emitThreadEvent("thread.failed", {
      thread: makeThreadResponse({
        id: "thr_worker",
        title: "Lifecycle worker",
        status: "error",
      }),
      error: "provider exited",
    });

    expect(
      fixture.store.tasks.getTaskThread(fixture.taskThreadId)?.liveStatus,
    ).toBe("failed");
    const commentsAfterFailure = fixture.store.tasks.listComments(
      fixture.taskId,
    );
    expect(commentsAfterFailure).toContainEqual(
      expect.objectContaining({
        kind: "system",
        body: 'Thread "Lifecycle worker" failed · thr_worker',
      }),
    );
    expect(fixture.harness.realtimeSignals).toEqual([
      { channel: "threads:changed", payload: { taskId: fixture.taskId } },
      { channel: "comments:changed", payload: { taskId: fixture.taskId } },
    ]);

    await fixture.harness.emitThreadEvent("thread.active", {
      thread: makeThreadResponse({
        id: "thr_worker",
        title: "Lifecycle worker",
        status: "active",
      }),
    });
    expect(
      fixture.store.tasks.getTaskThread(fixture.taskThreadId)?.liveStatus,
    ).toBe("working");
    expect(fixture.store.tasks.listComments(fixture.taskId)).toEqual(
      commentsAfterFailure,
    );

    await fixture.harness.dispose();
  });

  it("reconciles a stale non-terminal row on load", async () => {
    const fixture = trackedThreadFixture("starting", "idle");

    await registerLifecycle(fixture.bb, fixture.store);

    expect(fixture.harness.sdk.callsTo("threads.get")).toEqual([
      [{ threadId: "thr_worker" }],
      [{ threadId: "thr_worker" }],
    ]);
    expect(
      fixture.store.tasks.getTaskThread(fixture.taskThreadId)?.liveStatus,
    ).toBe("idle");
    expect(fixture.harness.realtimeSignals).toEqual([
      { channel: "threads:changed", payload: { taskId: fixture.taskId } },
      { channel: "comments:changed", payload: { taskId: fixture.taskId } },
    ]);

    await fixture.harness.dispose();
  });

  it("registers all lifecycle listeners before startup reconciliation", async () => {
    let handlersAtFirstRead:
      | ReturnType<
          typeof createFakePluginHost
        >["harness"]["registrations"]["threadEventHandlers"]
      | undefined;
    const host = createFakePluginHost({
      pluginId: "tasks",
      sdk: {
        threads: {
          get: async () => {
            handlersAtFirstRead =
              host.harness.registrations.threadEventHandlers;
            return makeThreadResponse({
              id: "thr_fast",
              status: "starting",
            });
          },
        },
      },
    });
    const store = createStore(host.bb);
    const project = store.tasks.createProject({
      name: "Fast lifecycle",
      prefix: "FAST",
      color: "blue",
    });
    const task = store.tasks.createTask({
      projectId: project.id,
      title: "Catch active",
    });
    const tracked = store.tasks.upsertTaskThread({
      taskId: task.id,
      threadId: "thr_fast",
      presetName: "Default",
      title: "Fast worker",
      liveStatus: "starting",
    });

    await registerLifecycle(host.bb, store);

    expect(handlersAtFirstRead).toMatchObject({
      "thread.created": 1,
      "thread.active": 1,
      "thread.idle": 1,
      "thread.failed": 1,
      "thread.deleted": 1,
    });
    expect(host.harness.sdk.callsTo("threads.get")).toHaveLength(2);
    expect(store.tasks.getTaskThread(tracked.id)?.liveStatus).toBe("starting");

    await host.harness.dispose();
  });

  it("moves a starting thread to working from thread.active without an SDK subscription", async () => {
    const fixture = trackedThreadFixture("starting", "starting");
    await registerLifecycle(fixture.bb, fixture.store);

    await fixture.harness.emitThreadEvent("thread.active", {
      thread: makeThreadResponse({
        id: "thr_worker",
        title: "Lifecycle worker",
        status: "active",
      }),
    });

    expect(
      fixture.store.tasks.getTaskThread(fixture.taskThreadId)?.liveStatus,
    ).toBe("working");
    expect(fixture.harness.sdk.callsTo("threads.get")).toHaveLength(2);
    expect(fixture.harness.sdk.callsTo("subscribe")).toEqual([]);

    await fixture.harness.dispose();
  });

  it("sweeps active threads every five minutes as a missed-event safety net", async () => {
    vi.useFakeTimers();
    let reads = 0;
    const host = createFakePluginHost({
      pluginId: "tasks",
      sdk: {
        threads: {
          get: async () => {
            reads += 1;
            return makeThreadResponse({
              id: "thr_safety_net",
              status: reads <= 2 ? "starting" : "active",
            });
          },
        },
      },
    });
    const store = createStore(host.bb);
    const project = store.tasks.createProject({
      name: "Safety net lifecycle",
      prefix: "SAFE",
      color: "blue",
    });
    const task = store.tasks.createTask({
      projectId: project.id,
      title: "Recover a missed event",
    });
    const tracked = store.tasks.upsertTaskThread({
      taskId: task.id,
      threadId: "thr_safety_net",
      presetName: "Default",
      title: "Safety net worker",
      liveStatus: "starting",
    });

    try {
      await registerLifecycle(host.bb, store);
      const service = host.harness.runService("thread-status-reconcile");

      await vi.advanceTimersByTimeAsync(
        THREAD_STATUS_RECONCILE_INTERVAL_MS - 1,
      );
      expect(store.tasks.getTaskThread(tracked.id)?.liveStatus).toBe(
        "starting",
      );

      await vi.advanceTimersByTimeAsync(1);
      expect(store.tasks.getTaskThread(tracked.id)?.liveStatus).toBe("working");
      expect(host.harness.sdk.callsTo("subscribe")).toEqual([]);
      service.controller.abort();
      await service.done;
    } finally {
      vi.useRealTimers();
      await host.harness.dispose();
    }
  });

  it("backs off reconciliation while no non-terminal task threads exist", async () => {
    vi.useFakeTimers();
    const host = createFakePluginHost({
      pluginId: "tasks",
      sdk: {
        threads: {
          get: async () =>
            makeThreadResponse({ id: "thr_later", status: "active" }),
        },
      },
    });
    const store = createStore(host.bb);
    const project = store.tasks.createProject({
      name: "Idle polling",
      prefix: "IDLE",
      color: "blue",
    });
    const task = store.tasks.createTask({
      projectId: project.id,
      title: "Attach later",
    });

    try {
      await registerLifecycle(host.bb, store);
      const service = host.harness.runService("thread-status-reconcile");
      const tracked = store.tasks.upsertTaskThread({
        taskId: task.id,
        threadId: "thr_later",
        presetName: "Default",
        title: "Later worker",
        liveStatus: "starting",
      });

      await vi.advanceTimersByTimeAsync(THREAD_STATUS_IDLE_INTERVAL_MS);
      expect(host.harness.sdk.callsTo("threads.get")).toEqual([]);

      await vi.advanceTimersByTimeAsync(
        THREAD_STATUS_RECONCILE_INTERVAL_MS - 1,
      );
      expect(host.harness.sdk.callsTo("threads.get")).toEqual([]);

      await vi.advanceTimersByTimeAsync(1);
      expect(host.harness.sdk.callsTo("threads.get")).toEqual([
        [{ threadId: "thr_later" }],
      ]);
      expect(store.tasks.getTaskThread(tracked.id)?.liveStatus).toBe("working");

      service.controller.abort();
      await service.done;
    } finally {
      vi.useRealTimers();
      await host.harness.dispose();
    }
  });

  it("ignores lifecycle events for non-tracked threads", async () => {
    const { bb, harness } = createFakePluginHost({ pluginId: "tasks" });
    const store = createStore(bb);
    await registerLifecycle(bb, store);

    await harness.emitThreadEvent("thread.failed", {
      thread: makeThreadResponse({ id: "thr_untracked", status: "error" }),
      error: "not ours",
    });

    expect(harness.realtimeSignals).toEqual([]);
    expect(store.tasks.listTasks()).toEqual([]);

    await harness.dispose();
  });
});
