import { threadScope, turnScope } from "@bb/domain";
import type {
  ThreadEvent,
  ThreadEventBackgroundTaskItem,
  WorkflowProgressSnapshot,
} from "@bb/domain";
import type { TimelineRow, TimelineWorkflowWorkRow } from "@bb/server-contract";
import { describe, expect, it } from "vitest";
import {
  buildThreadTimelineFromEvents,
  type ThreadEventWithMeta,
} from "../src/index.js";
import { EMPTY_ACCEPTED_CLIENT_REQUEST_CONTEXT } from "../src/accepted-client-request-context.js";
import type { ThreadTimelineFromEventsResult } from "../src/build-thread-timeline.js";

function withMeta(event: ThreadEvent, seq: number): ThreadEventWithMeta {
  return {
    event,
    meta: {
      id: `event-${seq}`,
      seq,
      createdAt: seq * 1_000,
    },
  };
}

function buildTimeline(
  events: ThreadEventWithMeta[],
  options: {
    includeNestedRows?: boolean;
    turnMessageDetail?: "summary" | "full";
  } = {},
): ThreadTimelineFromEventsResult {
  return buildThreadTimelineFromEvents({
    acceptedClientRequestContext: EMPTY_ACCEPTED_CLIENT_REQUEST_CONTEXT,
    contextWindowEvents: [],
    events,
    options: {
      includeNestedRows: options.includeNestedRows ?? true,
      includeProviderUnhandledOperations: false,
      isLatestPage: true,
      threadStatus: "idle",
      threadName: "",
      turnMessageDetail: options.turnMessageDetail ?? "full",
      workspaceRoot: null,
    },
  });
}

function buildTimelineRows(events: ThreadEventWithMeta[]): TimelineRow[] {
  return buildTimeline(events).rows;
}

function findWorkflowRows(rows: TimelineRow[]): TimelineWorkflowWorkRow[] {
  const found: TimelineWorkflowWorkRow[] = [];
  for (const row of rows) {
    if (row.kind === "work" && row.workKind === "workflow") {
      found.push(row);
    }
    if (row.kind === "turn" && row.children) {
      found.push(...findWorkflowRows(row.children));
    }
  }
  return found;
}

function taskItem(args: {
  taskStatus: ThreadEventBackgroundTaskItem["taskStatus"];
  status: ThreadEventBackgroundTaskItem["status"];
  workflow?: WorkflowProgressSnapshot;
  skipTranscript?: boolean;
  summary?: string;
  id?: string;
  workflowName?: string;
}): ThreadEventBackgroundTaskItem {
  return {
    type: "backgroundTask",
    id: args.id ?? "task:wf-1",
    taskType: "local_workflow",
    description: "Tiny fixture workflow",
    status: args.status,
    taskStatus: args.taskStatus,
    skipTranscript: args.skipTranscript ?? false,
    workflowName: args.workflowName ?? "fixture-mini",
    ...(args.workflow ? { workflow: args.workflow } : {}),
    ...(args.summary ? { summary: args.summary } : {}),
    usage: { totalTokens: 26674, toolUses: 0, durationMs: 3277 },
  };
}

function bashTaskItem(args: {
  taskStatus: ThreadEventBackgroundTaskItem["taskStatus"];
  status: ThreadEventBackgroundTaskItem["status"];
  summary?: string;
  id?: string;
  description?: string;
  parentToolCallId?: string;
}): ThreadEventBackgroundTaskItem {
  return {
    type: "backgroundTask",
    id: args.id ?? "task:bmn5wv33k",
    taskType: "local_bash",
    description:
      args.description ?? "Count ticks from 1 to 6 with 1 second delays",
    status: args.status,
    taskStatus: args.taskStatus,
    skipTranscript: false,
    ...(args.summary ? { summary: args.summary } : {}),
    ...(args.parentToolCallId
      ? { parentToolCallId: args.parentToolCallId }
      : {}),
  };
}

function agentTaskItem(args: {
  taskStatus: ThreadEventBackgroundTaskItem["taskStatus"];
  status: ThreadEventBackgroundTaskItem["status"];
  id?: string;
  familyId?: string;
  description?: string;
  parentToolCallId?: string;
}): ThreadEventBackgroundTaskItem {
  return {
    type: "backgroundTask",
    id: args.id ?? "task:agent-1",
    ...(args.familyId ? { familyId: args.familyId } : {}),
    taskType: "local_agent",
    description: args.description ?? "Map test coverage",
    status: args.status,
    taskStatus: args.taskStatus,
    skipTranscript: false,
    ...(args.parentToolCallId
      ? { parentToolCallId: args.parentToolCallId }
      : {}),
  };
}

function modelAgentToolCallStarted(seq: number): ThreadEventWithMeta {
  return withMeta(
    {
      type: "item/started",
      threadId: "thread-1",
      providerThreadId: "provider-1",
      scope: turnScope("turn-1"),
      item: {
        type: "toolCall",
        id: "toolu-root-agent",
        tool: "Agent",
        arguments: {
          description: "Inspect the mobile banner",
          model: "haiku",
          prompt: "Inspect the mobile banner",
          subagent_type: "general-purpose",
        },
        status: "pending",
      },
    },
    seq,
  );
}

function agentTaskStarted(
  item: ThreadEventBackgroundTaskItem,
  seq: number,
): ThreadEventWithMeta {
  return withMeta(
    {
      type: "item/started",
      threadId: "thread-1",
      providerThreadId: "provider-1",
      scope: turnScope("turn-1"),
      item,
    },
    seq,
  );
}

function agentTaskCompleted(
  item: ThreadEventBackgroundTaskItem,
  seq: number,
): ThreadEventWithMeta {
  return withMeta(
    {
      type: "item/backgroundTask/completed",
      threadId: "thread-1",
      providerThreadId: "provider-1",
      scope: threadScope(),
      item,
    },
    seq,
  );
}

const RUNNING_SNAPSHOT: WorkflowProgressSnapshot = {
  phases: [
    { index: 1, title: "Scan" },
    { index: 2, title: "Summarize" },
  ],
  agents: [
    {
      index: 1,
      label: "alpha",
      state: "done",
      model: "claude-haiku-4-5",
      attempt: 1,
      cached: false,
      lastProgressAt: 1,
      phaseIndex: 1,
      phaseTitle: "Scan",
    },
    {
      index: 2,
      label: "bravo",
      state: "running",
      model: "claude-haiku-4-5",
      attempt: 1,
      cached: false,
      lastProgressAt: 2,
      phaseIndex: 1,
      phaseTitle: "Scan",
    },
  ],
};

const DONE_SNAPSHOT: WorkflowProgressSnapshot = {
  ...RUNNING_SNAPSHOT,
  agents: RUNNING_SNAPSHOT.agents.map((agent) => ({
    ...agent,
    state: "done" as const,
  })),
};

function turnStarted(turnId: string, seq: number): ThreadEventWithMeta {
  return withMeta(
    {
      type: "turn/started",
      threadId: "thread-1",
      providerThreadId: "provider-1",
      scope: turnScope(turnId),
    },
    seq,
  );
}

function turnCompleted(turnId: string, seq: number): ThreadEventWithMeta {
  return withMeta(
    {
      type: "turn/completed",
      threadId: "thread-1",
      providerThreadId: "provider-1",
      scope: turnScope(turnId),
      status: "completed",
    },
    seq,
  );
}

describe("background task timeline projection", () => {
  it("folds started → progress → completed into one workflow row", () => {
    const rows = buildTimelineRows([
      turnStarted("turn-1", 1),
      withMeta(
        {
          type: "item/started",
          threadId: "thread-1",
          providerThreadId: "provider-1",
          scope: turnScope("turn-1"),
          item: taskItem({ status: "pending", taskStatus: "running" }),
        },
        2,
      ),
      withMeta(
        {
          type: "item/backgroundTask/progress",
          threadId: "thread-1",
          providerThreadId: "provider-1",
          scope: threadScope(),
          item: taskItem({
            status: "pending",
            taskStatus: "running",
            workflow: RUNNING_SNAPSHOT,
          }),
        },
        3,
      ),
      withMeta(
        {
          type: "item/backgroundTask/completed",
          threadId: "thread-1",
          providerThreadId: "provider-1",
          scope: threadScope(),
          item: taskItem({
            status: "completed",
            taskStatus: "completed",
            workflow: DONE_SNAPSHOT,
            summary: "Dynamic workflow completed",
          }),
        },
        4,
      ),
    ]);

    const workflowRows = findWorkflowRows(rows);
    expect(workflowRows).toHaveLength(1);
    const row = workflowRows[0]!;
    expect(row).toMatchObject({
      workKind: "workflow",
      status: "completed",
      taskStatus: "completed",
      workflowName: "fixture-mini",
      summary: "Dynamic workflow completed",
      usage: { totalTokens: 26674, toolUses: 0, durationMs: 3277 },
    });
    expect(row.workflow?.agents.map((agent) => agent.state)).toEqual([
      "done",
      "done",
    ]);
    expect(row.completedAt).not.toBeNull();
  });

  it("keeps one row when completion arrives turns after the spawning turn", () => {
    const rows = buildTimelineRows([
      turnStarted("turn-1", 1),
      withMeta(
        {
          type: "item/started",
          threadId: "thread-1",
          providerThreadId: "provider-1",
          scope: turnScope("turn-1"),
          item: taskItem({ status: "pending", taskStatus: "running" }),
        },
        2,
      ),
      turnCompleted("turn-1", 3),
      turnStarted("turn-2", 4),
      turnCompleted("turn-2", 5),
      withMeta(
        {
          type: "item/backgroundTask/completed",
          threadId: "thread-1",
          providerThreadId: "provider-1",
          scope: threadScope(),
          item: taskItem({
            status: "interrupted",
            taskStatus: "stopped",
            workflow: RUNNING_SNAPSHOT,
          }),
        },
        6,
      ),
    ]);

    const workflowRows = findWorkflowRows(rows);
    expect(workflowRows).toHaveLength(1);
    expect(workflowRows[0]).toMatchObject({
      status: "interrupted",
      taskStatus: "stopped",
    });
  });

  it("keeps the spawning turn's source range pinned when task events arrive after later turns", () => {
    const rows = buildTimelineRows([
      turnStarted("turn-1", 1),
      withMeta(
        {
          type: "item/started",
          threadId: "thread-1",
          providerThreadId: "provider-1",
          scope: turnScope("turn-1"),
          item: taskItem({ status: "pending", taskStatus: "running" }),
        },
        2,
      ),
      turnCompleted("turn-1", 3),
      turnStarted("turn-2", 4),
      turnCompleted("turn-2", 5),
      withMeta(
        {
          type: "item/backgroundTask/completed",
          threadId: "thread-1",
          providerThreadId: "provider-1",
          scope: threadScope(),
          item: taskItem({
            status: "completed",
            taskStatus: "completed",
            workflow: DONE_SNAPSHOT,
            summary: "Dynamic workflow completed",
          }),
        },
        6,
      ),
    ]);

    const spawningTurnRow = rows.find(
      (row) => row.kind === "turn" && row.turnId === "turn-1",
    );
    expect(spawningTurnRow).toMatchObject({
      sourceSeqStart: 1,
      sourceSeqEnd: 3,
    });

    const workflowRows = findWorkflowRows(rows);
    expect(workflowRows).toHaveLength(1);
    expect(workflowRows[0]).toMatchObject({
      sourceSeqStart: 2,
      sourceSeqEnd: 2,
      status: "completed",
      taskStatus: "completed",
      summary: "Dynamic workflow completed",
    });
  });

  it("renders the degraded row when no workflow_progress was reported", () => {
    const rows = buildTimelineRows([
      turnStarted("turn-1", 1),
      withMeta(
        {
          type: "item/started",
          threadId: "thread-1",
          providerThreadId: "provider-1",
          scope: turnScope("turn-1"),
          item: taskItem({ status: "pending", taskStatus: "running" }),
        },
        2,
      ),
    ]);

    const workflowRows = findWorkflowRows(rows);
    expect(workflowRows).toHaveLength(1);
    expect(workflowRows[0]).toMatchObject({
      status: "pending",
      workflow: null,
      description: "Tiny fixture workflow",
    });
  });

  it("surfaces an active workflow when the spawning turn is summarized", () => {
    const timeline = buildTimeline(
      [
        turnStarted("turn-1", 1),
        withMeta(
          {
            type: "item/started",
            threadId: "thread-1",
            providerThreadId: "provider-1",
            scope: turnScope("turn-1"),
            item: taskItem({ status: "pending", taskStatus: "running" }),
          },
          2,
        ),
        turnCompleted("turn-1", 3),
        withMeta(
          {
            type: "item/backgroundTask/progress",
            threadId: "thread-1",
            providerThreadId: "provider-1",
            scope: threadScope(),
            item: taskItem({
              status: "pending",
              taskStatus: "running",
              workflow: RUNNING_SNAPSHOT,
            }),
          },
          4,
        ),
      ],
      { includeNestedRows: false, turnMessageDetail: "summary" },
    );

    expect(findWorkflowRows(timeline.rows)).toHaveLength(0);
    expect(timeline.activeWorkflows[0]).toMatchObject({
      itemId: "task:wf-1",
      status: "pending",
      taskStatus: "running",
      workflowName: "fixture-mini",
    });
  });

  it("folds a backgrounded shell command into one background-command row", () => {
    const rows = buildTimelineRows([
      turnStarted("turn-1", 1),
      withMeta(
        {
          type: "item/started",
          threadId: "thread-1",
          providerThreadId: "provider-1",
          scope: turnScope("turn-1"),
          item: bashTaskItem({ status: "pending", taskStatus: "running" }),
        },
        2,
      ),
      withMeta(
        {
          type: "item/backgroundTask/completed",
          threadId: "thread-1",
          providerThreadId: "provider-1",
          scope: threadScope(),
          item: bashTaskItem({
            status: "completed",
            taskStatus: "completed",
            summary:
              'Background command "Count ticks from 1 to 6 with 1 second delays" completed (exit code 0)',
          }),
        },
        3,
      ),
    ]);

    const workflowRows = findWorkflowRows(rows);
    expect(workflowRows).toHaveLength(1);
    const row = workflowRows[0]!;
    expect(row).toMatchObject({
      workKind: "workflow",
      taskType: "local_bash",
      status: "completed",
      taskStatus: "completed",
      workflowName: null,
      workflow: null,
      description: "Count ticks from 1 to 6 with 1 second delays",
      summary:
        'Background command "Count ticks from 1 to 6 with 1 second delays" completed (exit code 0)',
    });
    expect(row.completedAt).not.toBeNull();
  });

  it("keeps backgrounded shell commands out of the active-workflow banner", () => {
    const timeline = buildTimeline(
      [
        turnStarted("turn-1", 1),
        withMeta(
          {
            type: "item/started",
            threadId: "thread-1",
            providerThreadId: "provider-1",
            scope: turnScope("turn-1"),
            item: bashTaskItem({ status: "pending", taskStatus: "running" }),
          },
          2,
        ),
        turnCompleted("turn-1", 3),
        withMeta(
          {
            type: "item/backgroundTask/progress",
            threadId: "thread-1",
            providerThreadId: "provider-1",
            scope: threadScope(),
            item: bashTaskItem({ status: "pending", taskStatus: "running" }),
          },
          4,
        ),
      ],
      { includeNestedRows: false, turnMessageDetail: "summary" },
    );

    expect(timeline.activeWorkflows).toHaveLength(0);
    expect(timeline.activeBackgroundCommands).toHaveLength(1);
    expect(timeline.activeBackgroundCommands[0]).toMatchObject({
      itemId: "task:bmn5wv33k",
      taskType: "local_bash",
      status: "pending",
    });
  });

  it("lists every concurrently running workflow most-recent-first", () => {
    const timeline = buildTimeline(
      [
        turnStarted("turn-1", 1),
        withMeta(
          {
            type: "item/started",
            threadId: "thread-1",
            providerThreadId: "provider-1",
            scope: turnScope("turn-1"),
            item: taskItem({
              status: "pending",
              taskStatus: "running",
              id: "task:wf-early",
              workflowName: "rfn-pass-a-balance",
            }),
          },
          2,
        ),
        withMeta(
          {
            type: "item/started",
            threadId: "thread-1",
            providerThreadId: "provider-1",
            scope: turnScope("turn-1"),
            item: taskItem({
              status: "pending",
              taskStatus: "running",
              id: "task:wf-late",
              workflowName: "rfn-visual-identity",
            }),
          },
          3,
        ),
        turnCompleted("turn-1", 4),
      ],
      { includeNestedRows: false, turnMessageDetail: "summary" },
    );

    expect(timeline.activeWorkflows.map((row) => row.workflowName)).toEqual([
      "rfn-visual-identity",
      "rfn-pass-a-balance",
    ]);
  });

  it("drops a workflow from the active list once it settles", () => {
    const timeline = buildTimeline(
      [
        turnStarted("turn-1", 1),
        withMeta(
          {
            type: "item/started",
            threadId: "thread-1",
            providerThreadId: "provider-1",
            scope: turnScope("turn-1"),
            item: taskItem({
              status: "pending",
              taskStatus: "running",
              id: "task:wf-early",
              workflowName: "rfn-pass-a-balance",
            }),
          },
          2,
        ),
        withMeta(
          {
            type: "item/started",
            threadId: "thread-1",
            providerThreadId: "provider-1",
            scope: turnScope("turn-1"),
            item: taskItem({
              status: "pending",
              taskStatus: "running",
              id: "task:wf-late",
              workflowName: "rfn-visual-identity",
            }),
          },
          3,
        ),
        withMeta(
          {
            type: "item/backgroundTask/completed",
            threadId: "thread-1",
            providerThreadId: "provider-1",
            scope: threadScope(),
            item: taskItem({
              status: "completed",
              taskStatus: "completed",
              id: "task:wf-late",
              workflowName: "rfn-visual-identity",
            }),
          },
          4,
        ),
        turnCompleted("turn-1", 5),
      ],
      { includeNestedRows: false, turnMessageDetail: "summary" },
    );

    expect(timeline.activeWorkflows.map((row) => row.workflowName)).toEqual([
      "rfn-pass-a-balance",
    ]);
  });

  it("lists running background commands and agents most-recent-first and excludes workflows", () => {
    const timeline = buildTimeline(
      [
        turnStarted("turn-1", 1),
        withMeta(
          {
            type: "item/started",
            threadId: "thread-1",
            providerThreadId: "provider-1",
            scope: turnScope("turn-1"),
            item: taskItem({ status: "pending", taskStatus: "running" }),
          },
          2,
        ),
        withMeta(
          {
            type: "item/started",
            threadId: "thread-1",
            providerThreadId: "provider-1",
            scope: turnScope("turn-1"),
            item: bashTaskItem({
              status: "pending",
              taskStatus: "running",
              id: "task:cmd-early",
              description: "Run the dev server",
            }),
          },
          3,
        ),
        withMeta(
          {
            type: "item/started",
            threadId: "thread-1",
            providerThreadId: "provider-1",
            scope: turnScope("turn-1"),
            item: bashTaskItem({
              status: "pending",
              taskStatus: "running",
              id: "task:cmd-late",
              description: "Watch and re-run tests",
            }),
          },
          4,
        ),
        withMeta(
          {
            type: "item/started",
            threadId: "thread-1",
            providerThreadId: "provider-1",
            scope: turnScope("turn-1"),
            item: agentTaskItem({
              status: "pending",
              taskStatus: "running",
              id: "task:agent-latest",
              description: "Inspect related code",
            }),
          },
          5,
        ),
        turnCompleted("turn-1", 6),
      ],
      { includeNestedRows: false, turnMessageDetail: "summary" },
    );

    expect(timeline.activeWorkflows[0]).toMatchObject({
      taskType: "local_workflow",
    });
    expect(timeline.activeBackgroundCommands.map((row) => row.itemId)).toEqual([
      "task:agent-latest",
      "task:cmd-late",
      "task:cmd-early",
    ]);
  });

  it("projects the spawning delegation model onto an active background agent", () => {
    const timeline = buildTimeline(
      [
        turnStarted("turn-1", 1),
        withMeta(
          {
            type: "item/started",
            threadId: "thread-1",
            providerThreadId: "provider-1",
            scope: turnScope("turn-1"),
            item: {
              type: "toolCall",
              id: "toolu-root-agent",
              tool: "Agent",
              arguments: {
                description: "Inspect the mobile banner",
                model: "haiku",
                prompt: "Inspect the mobile banner",
                subagent_type: "general-purpose",
              },
              status: "pending",
            },
          },
          2,
        ),
        withMeta(
          {
            type: "item/started",
            threadId: "thread-1",
            providerThreadId: "provider-1",
            scope: turnScope("turn-1"),
            item: agentTaskItem({
              status: "pending",
              taskStatus: "running",
              description: "Inspect the mobile banner",
              parentToolCallId: "toolu-root-agent",
            }),
          },
          3,
        ),
      ],
      { includeNestedRows: false, turnMessageDetail: "summary" },
    );

    expect(timeline.activeBackgroundCommands).toMatchObject([
      {
        description: "Inspect the mobile banner",
        model: null,
        taskType: "local_agent",
      },
    ]);
  });

  it("carries the model into a restarted agent generation without a parent call", () => {
    const timeline = buildTimeline(
      [
        turnStarted("turn-1", 1),
        modelAgentToolCallStarted(2),
        agentTaskStarted(
          agentTaskItem({
            status: "pending",
            taskStatus: "running",
            id: "task:agent-restart",
            description: "Inspect the mobile banner",
            parentToolCallId: "toolu-root-agent",
          }),
          3,
        ),
        agentTaskCompleted(
          agentTaskItem({
            status: "completed",
            taskStatus: "completed",
            id: "task:agent-restart",
            description: "Inspect the mobile banner",
            parentToolCallId: "toolu-root-agent",
          }),
          4,
        ),
        agentTaskStarted(
          agentTaskItem({
            status: "pending",
            taskStatus: "running",
            id: "task:agent-restart#2",
            description: "Inspect the mobile banner",
          }),
          5,
        ),
      ],
      { includeNestedRows: false, turnMessageDetail: "summary" },
    );

    expect(timeline.activeBackgroundCommands).toMatchObject([
      {
        itemId: "task:agent-restart#2",
        model: null,
        status: "pending",
        taskType: "local_agent",
      },
    ]);
  });

  it("correlates restarted generations through the explicit familyId under assembler-minted item ids", () => {
    const timeline = buildTimeline(
      [
        turnStarted("turn-1", 1),
        modelAgentToolCallStarted(2),
        agentTaskStarted(
          agentTaskItem({
            status: "pending",
            taskStatus: "running",
            id: "abc-i7",
            familyId: "agent-restart",
            description: "Inspect the mobile banner",
            parentToolCallId: "toolu-root-agent",
          }),
          3,
        ),
        agentTaskCompleted(
          agentTaskItem({
            status: "completed",
            taskStatus: "completed",
            id: "abc-i7",
            familyId: "agent-restart",
            description: "Inspect the mobile banner",
            parentToolCallId: "toolu-root-agent",
          }),
          4,
        ),
        agentTaskStarted(
          agentTaskItem({
            status: "pending",
            taskStatus: "running",
            id: "abc-i9",
            familyId: "agent-restart",
            description: "Inspect the mobile banner",
          }),
          5,
        ),
      ],
      { includeNestedRows: false, turnMessageDetail: "summary" },
    );

    expect(timeline.activeBackgroundCommands).toMatchObject([
      {
        itemId: "abc-i9",
        model: null,
        status: "pending",
        taskType: "local_agent",
      },
    ]);
  });

  it("preserves the model on a completed background-agent row", () => {
    const timeline = buildTimeline([
      turnStarted("turn-1", 1),
      modelAgentToolCallStarted(2),
      agentTaskStarted(
        agentTaskItem({
          status: "pending",
          taskStatus: "running",
          id: "task:agent-restart",
          description: "Inspect the mobile banner",
          parentToolCallId: "toolu-root-agent",
        }),
        3,
      ),
      agentTaskCompleted(
        agentTaskItem({
          status: "completed",
          taskStatus: "completed",
          id: "task:agent-restart",
          description: "Inspect the mobile banner",
          parentToolCallId: "toolu-root-agent",
        }),
        4,
      ),
      agentTaskStarted(
        agentTaskItem({
          status: "pending",
          taskStatus: "running",
          id: "task:agent-restart#2",
          description: "Inspect the mobile banner",
        }),
        5,
      ),
      agentTaskCompleted(
        agentTaskItem({
          status: "completed",
          taskStatus: "completed",
          id: "task:agent-restart#2",
          description: "Inspect the mobile banner",
        }),
        6,
      ),
    ]);

    expect(
      findWorkflowRows(timeline.rows).find(
        (row) => row.itemId === "task:agent-restart#2",
      ),
    ).toMatchObject({
      model: null,
      status: "completed",
      taskType: "local_agent",
    });
    expect(timeline.activeBackgroundCommands).toHaveLength(0);
  });

  it("excludes background tasks spawned inside a background agent from the parent active list", () => {
    const timeline = buildTimeline(
      [
        turnStarted("turn-1", 1),
        withMeta(
          {
            type: "item/started",
            threadId: "thread-1",
            providerThreadId: "provider-1",
            scope: turnScope("turn-1"),
            item: {
              type: "toolCall",
              id: "toolu-root-agent",
              tool: "Agent",
              arguments: {
                description: "Sleep then write poem",
                prompt: "Sleep then write poem",
              },
              status: "pending",
            },
          },
          2,
        ),
        withMeta(
          {
            type: "item/started",
            threadId: "thread-1",
            providerThreadId: "provider-1",
            scope: turnScope("turn-1"),
            item: agentTaskItem({
              status: "pending",
              taskStatus: "running",
              id: "task:root-agent",
              description: "Sleep then write poem",
              parentToolCallId: "toolu-root-agent",
            }),
          },
          3,
        ),
        withMeta(
          {
            type: "item/started",
            threadId: "thread-1",
            providerThreadId: "provider-1",
            scope: turnScope("turn-1"),
            item: {
              type: "commandExecution",
              id: "toolu-nested-bash",
              command: "sleep 10",
              cwd: "/tmp",
              status: "pending",
              approvalStatus: null,
              parentToolCallId: "toolu-root-agent",
            },
          },
          4,
        ),
        withMeta(
          {
            type: "item/started",
            threadId: "thread-1",
            providerThreadId: "provider-1",
            scope: turnScope("turn-1"),
            item: bashTaskItem({
              status: "pending",
              taskStatus: "running",
              id: "task:nested-bash",
              description: "Wait 10 seconds",
              parentToolCallId: "toolu-nested-bash",
            }),
          },
          5,
        ),
        turnCompleted("turn-1", 6),
      ],
      { includeNestedRows: false, turnMessageDetail: "summary" },
    );

    expect(timeline.activeBackgroundCommands.map((row) => row.itemId)).toEqual([
      "task:root-agent",
    ]);
  });

  it("surfaces a nested command after its owning background agent settles", () => {
    const timeline = buildTimeline(
      [
        turnStarted("turn-1", 1),
        withMeta(
          {
            type: "item/started",
            threadId: "thread-1",
            providerThreadId: "provider-1",
            scope: turnScope("turn-1"),
            item: {
              type: "toolCall",
              id: "toolu-root-agent",
              tool: "Agent",
              status: "pending",
            },
          },
          2,
        ),
        withMeta(
          {
            type: "item/started",
            threadId: "thread-1",
            providerThreadId: "provider-1",
            scope: turnScope("turn-1"),
            item: agentTaskItem({
              status: "pending",
              taskStatus: "running",
              id: "task:root-agent",
              description: "Run the tests",
              parentToolCallId: "toolu-root-agent",
            }),
          },
          3,
        ),
        withMeta(
          {
            type: "item/started",
            threadId: "thread-1",
            providerThreadId: "provider-1",
            scope: turnScope("turn-1"),
            item: {
              type: "commandExecution",
              id: "toolu-nested-wait",
              command: "until tests-finish; do sleep 5; done",
              cwd: "/tmp",
              status: "pending",
              approvalStatus: null,
              parentToolCallId: "toolu-root-agent",
            },
          },
          4,
        ),
        withMeta(
          {
            type: "item/started",
            threadId: "thread-1",
            providerThreadId: "provider-1",
            scope: turnScope("turn-1"),
            item: bashTaskItem({
              status: "pending",
              taskStatus: "running",
              id: "task:nested-wait",
              description: "Wait for tests",
              parentToolCallId: "toolu-nested-wait",
            }),
          },
          5,
        ),
        withMeta(
          {
            type: "item/backgroundTask/completed",
            threadId: "thread-1",
            providerThreadId: "provider-1",
            scope: threadScope(),
            item: agentTaskItem({
              status: "completed",
              taskStatus: "completed",
              id: "task:root-agent",
              description: "Run the tests",
              parentToolCallId: "toolu-root-agent",
            }),
          },
          6,
        ),
        turnCompleted("turn-1", 7),
      ],
      { includeNestedRows: false, turnMessageDetail: "summary" },
    );

    expect(timeline.activeBackgroundCommands.map((row) => row.itemId)).toEqual([
      "task:nested-wait",
    ]);
  });

  it("hides skip_transcript tasks from the timeline", () => {
    const timeline = buildTimeline([
      turnStarted("turn-1", 1),
      withMeta(
        {
          type: "item/started",
          threadId: "thread-1",
          providerThreadId: "provider-1",
          scope: turnScope("turn-1"),
          item: taskItem({
            status: "pending",
            taskStatus: "running",
            skipTranscript: true,
          }),
        },
        2,
      ),
    ]);

    expect(findWorkflowRows(timeline.rows)).toHaveLength(0);
    expect(timeline.activeWorkflows).toHaveLength(0);
  });
});
