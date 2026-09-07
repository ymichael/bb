import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { threadScope, turnScope } from "@bb/domain";
import type {
  ThreadEvent,
  ThreadEventBackgroundTaskItem,
  ThreadEventItem,
} from "@bb/domain";
import {
  TURN_1,
  TURN_2,
  createClaudeDeltaHarness,
  loadFixture,
  loadSessionFixture,
  spawningToolUseFor,
  spawningToolUseMessage,
} from "./delta-test-harness.js";

const PROGRESS_THROTTLE_MS = 500;

function isBackgroundTaskItem(
  item: ThreadEventItem,
): item is ThreadEventBackgroundTaskItem {
  return item.type === "backgroundTask";
}

function backgroundTaskItem(event: ThreadEvent): ThreadEventBackgroundTaskItem {
  if (
    (event.type === "item/started" ||
      event.type === "item/backgroundTask/progress" ||
      event.type === "item/backgroundTask/completed") &&
    isBackgroundTaskItem(event.item)
  ) {
    return event.item;
  }
  throw new Error(`Event ${event.type} did not carry a backgroundTask item`);
}

const TASK_EVENT_TYPES = [
  "item/backgroundTask/progress",
  "item/backgroundTask/completed",
] as const;

function collectTaskEvents(events: ThreadEvent[]): ThreadEvent[] {
  return events.filter(
    (event) =>
      (TASK_EVENT_TYPES as readonly string[]).includes(event.type) ||
      (event.type === "item/started" && isBackgroundTaskItem(event.item)),
  );
}

describe("claude-code background task translation", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  function advanceClock(ms: number): void {
    vi.setSystemTime(Date.now() + ms);
  }

  it("translates a captured workflow session into one started/progress/completed lifecycle", () => {
    const harness = createClaudeDeltaHarness();
    const allEvents: ThreadEvent[] = [];

    for (const message of loadSessionFixture("workflow-mini.ndjson")) {
      advanceClock(PROGRESS_THROTTLE_MS + 1);
      allEvents.push(
        ...harness.translate(message, {
          threadId: "bb-thread-1",
        }),
      );
    }

    const taskEvents = collectTaskEvents(allEvents);
    const started = taskEvents.filter((e) => e.type === "item/started");
    const progress = taskEvents.filter(
      (e) => e.type === "item/backgroundTask/progress",
    );
    const completed = taskEvents.filter(
      (e) => e.type === "item/backgroundTask/completed",
    );

    expect(started).toHaveLength(1);
    expect(progress.length).toBeGreaterThanOrEqual(1);
    expect(completed).toHaveLength(1);

    const startedItem = backgroundTaskItem(started[0]!);
    expect(startedItem).toMatchObject({
      id: harness.itemId("task:wu7ol9ras", "bb-thread-1"),
      taskType: "local_workflow",
      workflowName: "fixture-mini",
      status: "pending",
      taskStatus: "running",
      skipTranscript: false,
      parentToolCallId: harness.itemId(
        "toolu_012BkJCmbBgNqL6SXPKNfPvE",
        "bb-thread-1",
      ),
    });
    expect(started[0]!.scope.kind).toBe("turn");
    for (const event of [...progress, ...completed]) {
      expect(event.scope).toEqual(threadScope());
    }

    const finalItem = backgroundTaskItem(completed[0]!);
    expect(finalItem.status).toBe("completed");
    expect(finalItem.taskStatus).toBe("completed");
    expect(finalItem.summary).toBe(
      'Dynamic workflow "Tiny fixture workflow for BB capture" completed',
    );
    expect(finalItem.usage).toEqual({
      totalTokens: 26674,
      toolUses: 0,
      durationMs: 3277,
    });
    expect(finalItem.workflow?.agents.map((a) => a.label)).toEqual([
      "alpha",
      "bravo",
      "combine",
    ]);
    expect(finalItem.workflow?.agents.map((a) => a.state)).toEqual([
      "done",
      "done",
      "done",
    ]);
    expect(finalItem.workflow?.phases.map((p) => p.title)).toEqual([
      "Scan",
      "Summarize",
    ]);
  });

  it("folds delta batches: agents from earlier batches survive later partial batches", () => {
    const harness = createClaudeDeltaHarness();
    const context = { threadId: "bb-thread-1" };

    harness.translate(
      spawningToolUseFor(loadFixture("task-started-workflow.json")),
      context,
    );
    harness.translate(loadFixture("task-started-workflow.json"), context);

    advanceClock(PROGRESS_THROTTLE_MS + 1);
    const batch1 = harness.translate(
      loadFixture("task-progress-workflow-batch1.json"),
      context,
    );
    const batch1Item = backgroundTaskItem(batch1[0]!);
    expect(batch1Item.workflow?.agents).toHaveLength(2);

    advanceClock(PROGRESS_THROTTLE_MS + 1);
    const batch2 = harness.translate(
      loadFixture("task-progress-workflow-delta.json"),
      context,
    );
    const batch2Item = backgroundTaskItem(batch2[0]!);
    expect(batch2Item.workflow?.agents.map((a) => a.label)).toEqual([
      "alpha",
      "bravo",
    ]);
    expect(batch2Item.workflow?.agents[0]).toMatchObject({
      state: "running",
      tokens: 8886,
    });
    expect(batch2Item.workflow?.agents[1]).toMatchObject({
      state: "running",
      label: "bravo",
    });
    expect(batch2Item.workflow?.agents[1]?.tokens).toBeUndefined();
    expect(batch2Item.workflow?.phases).toHaveLength(2);
  });

  it("throttles progress events but flushes status transitions immediately", () => {
    const harness = createClaudeDeltaHarness();
    const context = { threadId: "bb-thread-1" };

    harness.translate(
      spawningToolUseFor(loadFixture("task-started-workflow.json")),
      context,
    );
    harness.translate(loadFixture("task-started-workflow.json"), context);

    advanceClock(100);
    const throttled = harness.translate(
      loadFixture("task-progress-workflow-batch1.json"),
      context,
    );
    expect(collectTaskEvents(throttled)).toHaveLength(0);

    advanceClock(100);
    const updated = harness.translate(
      {
        type: "system",
        subtype: "task_updated",
        task_id: "wu7ol9ras",
        patch: { status: "paused" },
        uuid: "u-1",
        session_id: "s-1",
      },
      context,
    );
    const updatedTaskEvents = collectTaskEvents(updated);
    expect(updatedTaskEvents).toHaveLength(1);
    const pausedItem = backgroundTaskItem(updatedTaskEvents[0]!);
    expect(pausedItem.taskStatus).toBe("paused");
    expect(pausedItem.status).toBe("pending");
    expect(pausedItem.workflow?.agents).toHaveLength(2);

    advanceClock(PROGRESS_THROTTLE_MS + 1);
    const flushed = harness.translate(
      loadFixture("task-progress-workflow-delta.json"),
      context,
    );
    expect(collectTaskEvents(flushed)).toHaveLength(1);
  });

  it("maps killed to a failed item and stopped to an interrupted item", () => {
    const harness = createClaudeDeltaHarness();
    const context = { threadId: "bb-thread-1" };

    harness.translate(
      spawningToolUseFor(loadFixture("task-started-workflow.json")),
      context,
    );
    harness.translate(loadFixture("task-started-workflow.json"), context);
    const killed = harness.translate(
      {
        type: "system",
        subtype: "task_updated",
        task_id: "wu7ol9ras",
        patch: { status: "killed", error: "killed by user" },
        uuid: "u-1",
        session_id: "s-1",
      },
      context,
    );
    const killedItem = backgroundTaskItem(collectTaskEvents(killed)[0]!);
    expect(killedItem.status).toBe("failed");
    expect(killedItem.taskStatus).toBe("killed");
    expect(killedItem.error).toBe("killed by user");

    const stopped = harness.translate(
      {
        type: "system",
        subtype: "task_notification",
        task_id: "wu7ol9ras",
        status: "stopped",
        output_file: "",
        summary: "Dynamic workflow stopped",
        uuid: "u-2",
        session_id: "s-1",
      },
      context,
    );
    const stoppedEvents = collectTaskEvents(stopped);
    expect(stoppedEvents[0]?.type).toBe("item/backgroundTask/completed");
    const stoppedItem = backgroundTaskItem(stoppedEvents[0]!);
    expect(stoppedItem.status).toBe("interrupted");
    expect(stoppedItem.taskStatus).toBe("stopped");
    expect(stoppedItem.outputFile).toBeUndefined();
  });

  it("materializes subagent tasks while preserving the delegation tool call", () => {
    const harness = createClaudeDeltaHarness();
    const allEvents: ThreadEvent[] = [];

    for (const message of loadSessionFixture("subagent-foreground.ndjson")) {
      advanceClock(PROGRESS_THROTTLE_MS + 1);
      allEvents.push(
        ...harness.translate(message, {
          threadId: "bb-thread-1",
        }),
      );
    }

    const taskEvents = collectTaskEvents(allEvents);
    expect(taskEvents.map((event) => event.type)).toEqual([
      "item/started",
      "item/backgroundTask/completed",
    ]);
    const taskItemId = harness.itemId("task:a35aa0d9e98a8e8e6", "bb-thread-1");
    expect(backgroundTaskItem(taskEvents[0]!)).toMatchObject({
      id: taskItemId,
      taskType: "local_agent",
      description: "Single subagent reply test",
      status: "pending",
      taskStatus: "running",
      parentToolCallId: harness.itemId(
        "toolu_01W1cLr7AsTRvbya9LM5LSAV",
        "bb-thread-1",
      ),
    });
    expect(backgroundTaskItem(taskEvents[1]!)).toMatchObject({
      id: taskItemId,
      taskType: "local_agent",
      status: "completed",
      taskStatus: "completed",
      summary: "Single subagent reply test",
    });
    expect(
      allEvents.some(
        (event) =>
          event.type === "item/started" && event.item.type === "toolCall",
      ),
    ).toBe(true);
  });

  it("ignores progress for unknown task ids (daemon restarted mid-run)", () => {
    const harness = createClaudeDeltaHarness();
    const events = harness.translate(
      loadFixture("task-progress-workflow-batch1.json"),
      { threadId: "bb-thread-1" },
    );
    expect(events).toHaveLength(0);
  });

  it("tracks monitors as open work without timeline rows", () => {
    const harness = createClaudeDeltaHarness();
    const context = { threadId: "bb-thread-monitor" };

    const started = harness.translate(
      {
        type: "system",
        subtype: "task_started",
        task_id: "monitor-1",
        description: "Watch the build",
        task_type: "monitor",
        uuid: "u-monitor-1",
        session_id: "s-monitor-1",
      },
      context,
    );

    expect(started).toEqual([]);
    expect(harness.translator.hasOpenSessionWork(context.threadId)).toBe(true);

    const completed = harness.translate(
      {
        type: "system",
        subtype: "task_notification",
        task_id: "monitor-1",
        status: "completed",
        output_file: "",
        summary: "Build complete",
        uuid: "u-monitor-2",
        session_id: "s-monitor-1",
      },
      context,
    );

    expect(completed).toEqual([]);
    expect(harness.translator.hasOpenSessionWork(context.threadId)).toBe(false);
  });

  it("preserves skip_transcript on the item", () => {
    const harness = createClaudeDeltaHarness();
    harness.translate(
      spawningToolUseFor(loadFixture("task-started-workflow.json")),
      { threadId: "bb-thread-1" },
    );
    const started = harness.translate(
      {
        ...loadFixture("task-started-workflow.json"),
        skip_transcript: true,
      },
      { threadId: "bb-thread-1" },
    );
    const item = backgroundTaskItem(collectTaskEvents(started)[0]!);
    expect(item.skipTranscript).toBe(true);
  });

  it("settles open tasks as interrupted when the thread resumes", () => {
    const harness = createClaudeDeltaHarness();
    const context = { threadId: "bb-thread-1" };

    harness.translate(
      spawningToolUseFor(loadFixture("task-started-workflow.json")),
      context,
    );
    harness.translate(loadFixture("task-started-workflow.json"), context);
    harness.translate(
      {
        type: "user",
        message: {
          role: "user",
          content: [
            {
              type: "tool_result",
              tool_use_id: "toolu_012BkJCmbBgNqL6SXPKNfPvE",
              content: "Workflow started in the background",
              is_error: false,
            },
          ],
        },
        session_id: "sess-1",
      },
      context,
    );

    const events = harness.settleSession("bb-thread-1");

    const completed = events.filter(
      (event) => event.type === "item/backgroundTask/completed",
    );
    expect(completed).toHaveLength(1);
    const item = backgroundTaskItem(completed[0]!);
    expect(item).toMatchObject({
      id: harness.itemId("task:wu7ol9ras", "bb-thread-1"),
      status: "interrupted",
      taskStatus: "stopped",
    });
    expect(events[0]).toMatchObject({
      type: "turn/completed",
      status: "interrupted",
    });

    const repeat = harness.settleSession("bb-thread-1");
    expect(
      repeat.filter((event) => event.type === "item/backgroundTask/completed"),
    ).toHaveLength(0);
  });

  it("settling preserves an already-completed status reported before the terminal notification", () => {
    const harness = createClaudeDeltaHarness();
    const context = { threadId: "bb-thread-1" };

    harness.translate(
      spawningToolUseFor(loadFixture("task-started-workflow.json")),
      context,
    );
    harness.translate(loadFixture("task-started-workflow.json"), context);
    harness.translate(
      {
        type: "system",
        subtype: "task_updated",
        task_id: "wu7ol9ras",
        patch: { status: "completed" },
        uuid: "u-1",
        session_id: "s-1",
      },
      context,
    );

    const events = harness.settleSession("bb-thread-1");

    const completed = events.filter(
      (event) => event.type === "item/backgroundTask/completed",
    );
    expect(completed).toHaveLength(1);
    expect(backgroundTaskItem(completed[0]!)).toMatchObject({
      id: harness.itemId("task:wu7ol9ras", "bb-thread-1"),
      status: "completed",
      taskStatus: "completed",
    });
  });

  it("settles open tasks as interrupted when the thread detaches (process exit)", () => {
    const harness = createClaudeDeltaHarness();
    const context = { threadId: "bb-thread-1" };

    harness.translate(
      spawningToolUseFor(loadFixture("task-started-workflow.json")),
      context,
    );
    harness.translate(loadFixture("task-started-workflow.json"), context);

    const events = harness.settleSession("bb-thread-1");
    const completed = events.filter(
      (event) => event.type === "item/backgroundTask/completed",
    );
    expect(completed).toHaveLength(1);
    expect(backgroundTaskItem(completed[0]!).status).toBe("interrupted");

    expect(harness.settleSession("bb-thread-other")).toEqual([]);
  });

  it("preserves the parent link when a settled Claude task restarts", () => {
    const harness = createClaudeDeltaHarness();
    const context = { threadId: "bb-thread-1" };

    harness.translate(
      spawningToolUseFor(loadFixture("task-started-workflow.json")),
      context,
    );
    harness.translate(loadFixture("task-started-workflow.json"), context);
    harness.translate(loadFixture("task-notification-workflow.json"), context);

    advanceClock(PROGRESS_THROTTLE_MS + 1);
    const late = harness.translate(
      loadFixture("task-progress-workflow-batch1.json"),
      context,
    );
    expect(collectTaskEvents(late)).toHaveLength(0);

    const reopened = harness.translate(
      {
        ...loadFixture("task-started-workflow.json"),
        tool_use_id: "toolu_send_message_1",
      },
      context,
    );
    const reopenedStarted = collectTaskEvents(reopened).filter(
      (event) => event.type === "item/started",
    );
    expect(reopenedStarted).toHaveLength(1);
    const secondGenerationId = harness.itemId(
      "task:wu7ol9ras#2",
      "bb-thread-1",
    );
    expect(secondGenerationId).not.toBe("");
    expect(secondGenerationId).not.toBe(
      harness.itemId("task:wu7ol9ras", "bb-thread-1"),
    );
    expect(backgroundTaskItem(reopenedStarted[0]!)).toMatchObject({
      id: secondGenerationId,
      familyId: "wu7ol9ras",
      parentToolCallId: harness.itemId("toolu_send_message_1", "bb-thread-1"),
    });
  });

  it("materializes a backgrounded shell command (task_type local_bash)", () => {
    const harness = createClaudeDeltaHarness();
    const context = { threadId: "bb-thread-1" };

    harness.translate(
      spawningToolUseMessage({
        toolUseId: "toolu_bash_1",
        toolName: "Bash",
        input: {
          command: "for i in 1 2 3 4 5 6; do echo $i; sleep 1; done",
          run_in_background: true,
        },
      }),
      context,
    );
    const started = harness.translate(
      {
        type: "system",
        subtype: "task_started",
        task_id: "bmn5wv33k",
        tool_use_id: "toolu_bash_1",
        description: "Count ticks from 1 to 6 with 1 second delays",
        task_type: "local_bash",
        uuid: "u-1",
        session_id: "s-1",
      },
      context,
    );
    const startedTask = collectTaskEvents(started);
    expect(startedTask).toHaveLength(1);
    expect(startedTask[0]!.type).toBe("item/started");
    const startedItem = backgroundTaskItem(startedTask[0]!);
    expect(startedItem).toMatchObject({
      id: harness.itemId("task:bmn5wv33k", "bb-thread-1"),
      familyId: "bmn5wv33k",
      taskType: "local_bash",
      description: "Count ticks from 1 to 6 with 1 second delays",
      status: "pending",
      taskStatus: "running",
      skipTranscript: false,
      parentToolCallId: harness.itemId("toolu_bash_1", "bb-thread-1"),
    });
    expect(startedItem.workflow).toBeUndefined();
    expect(startedItem.workflowName).toBeUndefined();

    const notified = harness.translate(
      {
        type: "system",
        subtype: "task_notification",
        task_id: "bmn5wv33k",
        tool_use_id: "toolu_bash_1",
        status: "completed",
        output_file: "/tmp/tasks/bmn5wv33k.output",
        summary:
          'Background command "Count ticks from 1 to 6 with 1 second delays" completed (exit code 0)',
        uuid: "u-2",
        session_id: "s-1",
      },
      context,
    );
    const completed = notified.filter(
      (event) => event.type === "item/backgroundTask/completed",
    );
    expect(completed).toHaveLength(1);
    expect(backgroundTaskItem(completed[0]!)).toMatchObject({
      id: harness.itemId("task:bmn5wv33k", "bb-thread-1"),
      taskType: "local_bash",
      status: "completed",
      taskStatus: "completed",
      summary:
        'Background command "Count ticks from 1 to 6 with 1 second delays" completed (exit code 0)',
    });
  });

  it("ignores tasks spawned by an unforwarded child (workflow agent)", () => {
    const harness = createClaudeDeltaHarness();
    const context = { threadId: "bb-thread-1" };

    harness.translate(
      spawningToolUseFor(loadFixture("task-started-workflow.json")),
      context,
    );
    harness.translate(loadFixture("task-started-workflow.json"), context);
    const settled = harness.translate(
      { type: "result", subtype: "end_turn", session_id: "sess-1" },
      context,
    );
    expect(settled).toContainEqual(
      expect.objectContaining({ type: "turn/completed" }),
    );

    const childCommand = harness.translate(
      {
        type: "system",
        subtype: "task_started",
        task_id: "b0blaygur",
        tool_use_id: "toolu_workflow_child_bash",
        description: "Gate runner progress",
        task_type: "local_bash",
        is_backgrounded: true,
        uuid: "u-child-1",
        session_id: "s-1",
      },
      context,
    );
    expect(childCommand).toEqual([]);
    expect(harness.itemId("toolu_workflow_child_bash", "bb-thread-1")).toBe("");

    const childAgent = harness.translate(
      {
        type: "system",
        subtype: "task_started",
        task_id: "a-child-agent",
        tool_use_id: "toolu_workflow_child_agent",
        description: "Review one file",
        task_type: "local_agent",
        subagent_type: "general-purpose",
        uuid: "u-child-2",
        session_id: "s-1",
      },
      context,
    );
    expect(childAgent).toEqual([]);

    const notified = harness.translate(
      {
        type: "system",
        subtype: "task_notification",
        task_id: "b0blaygur",
        tool_use_id: "toolu_workflow_child_bash",
        status: "completed",
        output_file: "/tmp/tasks/b0blaygur.output",
        summary:
          'Background command "Gate runner progress" completed (exit code 0)',
        uuid: "u-child-3",
        session_id: "s-1",
      },
      context,
    );
    expect(notified).toEqual([]);

    harness.translate(
      spawningToolUseMessage({
        toolUseId: "toolu_parent_bash",
        toolName: "Bash",
        input: { command: "sleep 30", run_in_background: true },
      }),
      context,
    );
    const parentCommand = harness.translate(
      {
        type: "system",
        subtype: "task_started",
        task_id: "parent-bash",
        tool_use_id: "toolu_parent_bash",
        description: "Sleep",
        task_type: "local_bash",
        uuid: "u-parent-1",
        session_id: "s-1",
      },
      context,
    );
    expect(collectTaskEvents(parentCommand)).toHaveLength(1);
    expect(
      backgroundTaskItem(collectTaskEvents(parentCommand)[0]!),
    ).toMatchObject({
      taskType: "local_bash",
      parentToolCallId: harness.itemId("toolu_parent_bash", "bb-thread-1"),
    });
  });

  it("materializes background subagents with legacy task_type local_subagent", () => {
    const harness = createClaudeDeltaHarness();
    harness.translate(
      spawningToolUseMessage({
        toolUseId: "toolu_sub_1",
        toolName: "Agent",
        input: {
          description: "background subagent",
          prompt: "background subagent",
          subagent_type: "Explore",
          run_in_background: true,
        },
      }),
      { threadId: "bb-thread-1" },
    );
    const events = harness.translate(
      {
        type: "system",
        subtype: "task_started",
        task_id: "sub-1",
        tool_use_id: "toolu_sub_1",
        description: "background subagent",
        task_type: "local_subagent",
        subagent_type: "Explore",
        uuid: "u-1",
        session_id: "s-1",
      },
      { threadId: "bb-thread-1" },
    );

    const taskEvents = collectTaskEvents(events);
    expect(taskEvents).toHaveLength(1);
    expect(backgroundTaskItem(taskEvents[0]!)).toMatchObject({
      id: harness.itemId("task:sub-1", "bb-thread-1"),
      taskType: "local_subagent",
      description: "background subagent",
      status: "pending",
      taskStatus: "running",
      parentToolCallId: harness.itemId("toolu_sub_1", "bb-thread-1"),
    });
  });

  it("keeps one logical turn open across Claude background-agent reinvocations", () => {
    const harness = createClaudeDeltaHarness();
    const context = { threadId: "bb-thread-1" };

    harness.translate(
      {
        type: "assistant",
        message: {
          role: "assistant",
          content: [{ type: "text", text: "I will wait for the agent." }],
        },
        session_id: "sess-1",
      },
      context,
    );
    harness.translate(
      spawningToolUseFor(loadFixture("task-started-subagent.json")),
      context,
    );
    harness.translate(loadFixture("task-started-subagent.json"), context);

    const intermediateResult = harness.translate(
      {
        type: "result",
        subtype: "end_turn",
        session_id: "sess-1",
      },
      context,
    );
    expect(intermediateResult).not.toContainEqual(
      expect.objectContaining({ type: "turn/completed" }),
    );

    harness.translate(loadFixture("task-notification-subagent.json"), context);
    const resumed = harness.translate(
      {
        type: "assistant",
        message: {
          role: "assistant",
          content: [{ type: "text", text: "The agent finished." }],
        },
        session_id: "sess-1",
      },
      context,
    );
    expect(resumed).not.toContainEqual(
      expect.objectContaining({ type: "turn/started" }),
    );
    expect(resumed).toContainEqual(
      expect.objectContaining({
        type: "item/completed",
        scope: turnScope(TURN_1),
        item: expect.objectContaining({
          type: "agentMessage",
          text: "The agent finished.",
        }),
      }),
    );

    const finalResult = harness.translate(
      {
        type: "result",
        subtype: "end_turn",
        session_id: "sess-1",
      },
      context,
    );
    expect(finalResult).toContainEqual(
      expect.objectContaining({
        type: "turn/completed",
        scope: turnScope(TURN_1),
        status: "completed",
      }),
    );
  });

  it("treats legacy subagents as completion-blocking", () => {
    const blockingTasks = [
      {
        type: "system",
        subtype: "task_started",
        task_id: "subagent-1",
        tool_use_id: "tool-subagent-1",
        description: "Legacy subagent",
        task_type: "local_subagent",
        subagent_type: "Explore",
        uuid: "uuid-subagent-1",
        session_id: "sess-1",
      },
    ];

    for (const [index, task] of blockingTasks.entries()) {
      const harness = createClaudeDeltaHarness();
      const context = { threadId: `bb-thread-${index}` };
      harness.translate(
        {
          type: "assistant",
          message: {
            role: "assistant",
            content: [{ type: "text", text: "waiting" }],
          },
          session_id: "sess-1",
        },
        context,
      );
      harness.translate(spawningToolUseFor(task), context);
      harness.translate(task, context);

      const events = harness.translate(
        {
          type: "result",
          subtype: "end_turn",
          session_id: "sess-1",
        },
        context,
      );
      expect(events).not.toContainEqual(
        expect.objectContaining({ type: "turn/completed" }),
      );
    }
  });

  it("does not let detached or ambient tasks block turn completion", () => {
    for (const task of [
      {
        task_id: "bash-1",
        task_type: "local_bash",
        description: "Run a detached server",
      },
      {
        task_id: "ambient-agent-1",
        task_type: "local_agent",
        description: "Ambient agent",
        skip_transcript: true,
      },
    ]) {
      const harness = createClaudeDeltaHarness();
      const context = { threadId: `bb-thread-${task.task_id}` };
      harness.translate(
        {
          type: "assistant",
          message: {
            role: "assistant",
            content: [{ type: "text", text: "done" }],
          },
          session_id: "sess-1",
        },
        context,
      );
      harness.translate(
        spawningToolUseFor({ tool_use_id: `tool-${task.task_id}`, ...task }),
        context,
      );
      harness.translate(
        {
          type: "system",
          subtype: "task_started",
          tool_use_id: `tool-${task.task_id}`,
          uuid: `uuid-${task.task_id}`,
          session_id: "sess-1",
          ...task,
        },
        context,
      );

      const events = harness.translate(
        {
          type: "result",
          subtype: "end_turn",
          session_id: "sess-1",
        },
        context,
      );
      expect(events).toContainEqual(
        expect.objectContaining({
          type: "turn/completed",
          scope: turnScope(TURN_1),
          status: "completed",
        }),
      );
    }
  });

  it("completes the turn while a workflow keeps running, leaving the task open", () => {
    const harness = createClaudeDeltaHarness();
    const context = { threadId: "bb-thread-workflow" };
    harness.translate(
      {
        type: "assistant",
        message: {
          role: "assistant",
          content: [{ type: "text", text: "started the workflow" }],
        },
        session_id: "sess-1",
      },
      context,
    );
    harness.translate(
      spawningToolUseFor(loadFixture("task-started-workflow.json")),
      context,
    );
    const started = harness.translate(
      loadFixture("task-started-workflow.json"),
      context,
    );

    const events = harness.translate(
      {
        type: "result",
        subtype: "end_turn",
        session_id: "sess-1",
      },
      context,
    );

    expect(events).toContainEqual(
      expect.objectContaining({
        type: "turn/completed",
        scope: turnScope(TURN_1),
        status: "completed",
      }),
    );
    expect(started).toContainEqual(
      expect.objectContaining({
        type: "item/started",
        item: expect.objectContaining({
          type: "backgroundTask",
          taskType: "local_workflow",
          status: "pending",
        }),
      }),
    );
  });

  it("opens a fresh turn when a settled workflow reinvokes the model", () => {
    const harness = createClaudeDeltaHarness();
    const context = { threadId: "bb-thread-workflow-settle" };
    harness.translate(
      {
        type: "assistant",
        message: {
          role: "assistant",
          content: [{ type: "text", text: "started the workflow" }],
        },
        session_id: "sess-1",
      },
      context,
    );
    harness.translate(
      spawningToolUseFor(loadFixture("task-started-workflow.json")),
      context,
    );
    harness.translate(loadFixture("task-started-workflow.json"), context);
    harness.translate(
      { type: "result", subtype: "end_turn", session_id: "sess-1" },
      context,
    );

    harness.translate(loadFixture("task-notification-workflow.json"), context);
    const reinvoked = harness.translate(
      {
        type: "assistant",
        message: {
          role: "assistant",
          content: [{ type: "text", text: "The workflow finished." }],
        },
        session_id: "sess-1",
      },
      context,
    );

    expect(reinvoked).toContainEqual(
      expect.objectContaining({
        type: "turn/started",
        scope: turnScope(TURN_2),
      }),
    );
    expect(
      harness.translate(
        { type: "result", subtype: "end_turn", session_id: "sess-1" },
        context,
      ),
    ).toContainEqual(
      expect.objectContaining({
        type: "turn/completed",
        scope: turnScope(TURN_2),
        status: "completed",
      }),
    );
  });

  it("closes a failed result even while a background agent is open", () => {
    const harness = createClaudeDeltaHarness();
    const context = { threadId: "bb-thread-1" };
    harness.translate(
      {
        type: "assistant",
        message: { role: "assistant", content: [{ type: "text", text: "x" }] },
        session_id: "sess-1",
      },
      context,
    );
    harness.translate(
      spawningToolUseFor(loadFixture("task-started-subagent.json")),
      context,
    );
    harness.translate(loadFixture("task-started-subagent.json"), context);

    const events = harness.translate(
      {
        type: "result",
        subtype: "error",
        session_id: "sess-1",
      },
      context,
    );
    expect(events).toContainEqual(
      expect.objectContaining({
        type: "turn/completed",
        scope: turnScope(TURN_1),
        status: "failed",
      }),
    );
  });
});
