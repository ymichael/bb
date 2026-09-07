import { describe, expect, it } from "vitest";
import type {
  ThreadEvent,
  ThreadEventBackgroundTaskItem,
  ThreadEventDelegationItem,
} from "@bb/domain";
import { threadScope, turnScope } from "@bb/domain";
import { RuntimeBackgroundWorkState } from "./runtime-background-work-state.js";

interface TaskOptions {
  skipTranscript?: boolean;
  status?: ThreadEventBackgroundTaskItem["status"];
  taskType?: string;
}

function task(
  id: string,
  options: TaskOptions = {},
): ThreadEventBackgroundTaskItem {
  return {
    type: "backgroundTask",
    id,
    taskType: options.taskType ?? "local_workflow",
    description: `task ${id}`,
    status: options.status ?? "pending",
    taskStatus: options.status === undefined ? "running" : "completed",
    skipTranscript: options.skipTranscript ?? false,
  };
}

function taskStarted(
  id: string,
  options: TaskOptions & { threadId?: string } = {},
): ThreadEvent {
  return {
    type: "item/started",
    threadId: options.threadId ?? "t1",
    providerThreadId: "p1",
    scope: turnScope("turn-1"),
    item: task(id, options),
  };
}

function taskCompleted(
  id: string,
  options: { threadId?: string } = {},
): ThreadEvent {
  return {
    type: "item/backgroundTask/completed",
    threadId: options.threadId ?? "t1",
    providerThreadId: "p1",
    scope: threadScope(),
    item: task(id, { status: "completed" }),
  };
}

function delegation(
  id: string,
  status: ThreadEventDelegationItem["status"] = "pending",
  background = false,
): ThreadEventDelegationItem {
  return {
    type: "delegation",
    id,
    childRef: `agent-${id}`,
    label: `/root/${id}`,
    status,
    background,
  };
}

describe("RuntimeBackgroundWorkState", () => {
  it("counts an open delegation as open work until it settles", () => {
    const state = new RuntimeBackgroundWorkState();
    state.observe({
      type: "item/started",
      threadId: "t1",
      providerThreadId: "p1",
      scope: turnScope("turn-1"),
      item: delegation("d1"),
    });
    expect(state.hasOpenThreadWork("t1")).toBe(true);

    state.observe({
      type: "turn/completed",
      threadId: "t1",
      providerThreadId: "p1",
      scope: turnScope("turn-1"),
      status: "completed",
    });
    expect(state.hasOpenThreadWork("t1")).toBe(true);

    state.observe({
      type: "item/completed",
      threadId: "t1",
      providerThreadId: "p1",
      scope: turnScope("turn-1"),
      item: delegation("d1", "completed"),
    });
    expect(state.hasOpenThreadWork("t1")).toBe(false);
  });

  it("re-opens a settled delegation the provider reopened for a followup", () => {
    const state = new RuntimeBackgroundWorkState();
    const started: ThreadEvent = {
      type: "item/started",
      threadId: "t1",
      providerThreadId: "p1",
      scope: turnScope("turn-1"),
      item: delegation("d1"),
    };
    state.observe(started);
    state.observe({
      type: "item/completed",
      threadId: "t1",
      providerThreadId: "p1",
      scope: turnScope("turn-1"),
      item: delegation("d1", "completed"),
    });
    expect(state.hasOpenThreadWork("t1")).toBe(false);

    state.observe(started);
    expect(state.hasOpenThreadWork("t1")).toBe(true);
  });

  it("settles a background delegation through its thread-scoped events", () => {
    const state = new RuntimeBackgroundWorkState();
    state.observe({
      type: "item/started",
      threadId: "t1",
      providerThreadId: "p1",
      scope: turnScope("turn-1"),
      item: delegation("d1", "pending", true),
    });
    state.observe({
      type: "item/delegation/progress",
      threadId: "t1",
      providerThreadId: "p1",
      scope: threadScope(),
      item: delegation("d1", "pending", true),
    });
    expect(state.hasOpenThreadWork("t1")).toBe(true);
    state.observe({
      type: "item/delegation/completed",
      threadId: "t1",
      providerThreadId: "p1",
      scope: threadScope(),
      item: delegation("d1", "failed", true),
    });
    expect(state.hasOpenThreadWork("t1")).toBe(false);
  });

  it("reports open work until every task settles", () => {
    const state = new RuntimeBackgroundWorkState();
    expect(state.hasOpenWork()).toBe(false);

    state.observe(taskStarted("task-1"));
    state.observe(taskStarted("task-2"));
    expect(state.hasOpenWork()).toBe(true);

    state.observe(taskCompleted("task-1"));
    expect(state.hasOpenWork()).toBe(true);

    state.observe(taskCompleted("task-2"));
    expect(state.hasOpenWork()).toBe(false);
  });

  it("settles a task that only reports a terminal status through progress", () => {
    const state = new RuntimeBackgroundWorkState();
    state.observe(taskStarted("task-1"));

    state.observe({
      type: "item/backgroundTask/progress",
      threadId: "t1",
      providerThreadId: "p1",
      scope: threadScope(),
      item: task("task-1", { status: "failed" }),
    });

    expect(state.hasOpenWork()).toBe(false);
  });

  it("keeps ambient tasks open because a shutdown would still kill them", () => {
    const state = new RuntimeBackgroundWorkState();

    state.observe(taskStarted("task-1", { skipTranscript: true }));

    expect(state.hasOpenWork()).toBe(true);
  });

  it("forgets a thread's open work without disturbing other threads", () => {
    const state = new RuntimeBackgroundWorkState();
    state.observe(taskStarted("task-1", { threadId: "t1" }));
    state.observe(taskStarted("task-2", { threadId: "t2" }));

    state.clearThread("t1");
    expect(state.hasOpenWork()).toBe(true);

    state.clearThread("t2");
    expect(state.hasOpenWork()).toBe(false);
  });

  it("ignores non-background item lifecycle events", () => {
    const state = new RuntimeBackgroundWorkState();

    state.observe({
      type: "item/started",
      threadId: "t1",
      providerThreadId: "p1",
      scope: turnScope("turn-1"),
      item: {
        type: "agentMessage",
        id: "msg-1",
        text: "hello",
      },
    });

    expect(state.hasOpenWork()).toBe(false);
  });
});
