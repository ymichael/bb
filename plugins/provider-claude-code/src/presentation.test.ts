import type { ThreadEvent } from "@bb/domain";
import { describe, expect, it } from "vitest";
import {
  createClaudeDeltaHarness,
  spawningToolUseFor,
} from "./delta-test-harness.js";
import { createClaudeDeltaTranslator } from "./delta-translation.js";

function toolUse(
  id: string,
  name: string,
  input: unknown,
): Record<string, unknown> {
  return {
    type: "assistant",
    message: {
      role: "assistant",
      content: [{ type: "tool_use", id, name, input }],
    },
    session_id: "sess-1",
  };
}

function toolResult(
  id: string,
  content: unknown,
  extra: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    type: "user",
    message: {
      role: "user",
      content: [{ type: "tool_result", tool_use_id: id, content }],
    },
    session_id: "sess-1",
    ...extra,
  };
}

function startedItems(events: ThreadEvent[]) {
  return events.flatMap((event) =>
    event.type === "item/started" ? [event.item] : [],
  );
}

function completedItems(events: ThreadEvent[]) {
  return events.flatMap((event) =>
    event.type === "item/completed" ? [event.item] : [],
  );
}

type StartedItem = ReturnType<typeof startedItems>[number];

function presentationOf(item: StartedItem | undefined): unknown {
  return item !== undefined && "presentation" in item
    ? item.presentation
    : undefined;
}

describe("claude item presentation", () => {
  it("emits a TodoWrite call as a collapsed tool row plus a settled planSteps snapshot", () => {
    const harness = createClaudeDeltaHarness();
    const events = harness.translate(
      toolUse("todo-1", "TodoWrite", {
        todos: [
          { content: "Read the spec", status: "completed" },
          {
            content: "Write the code",
            status: "in_progress",
            activeForm: "Writing the code",
          },
          { content: "Run the tests", status: "pending" },
          { content: "Mystery", status: "cancelled" },
        ],
      }),
    );
    const started = startedItems(events);
    expect(started).toEqual([
      expect.objectContaining({
        type: "toolCall",
        tool: "TodoWrite",
        presentation: {
          label: { pending: "Updating todos", completed: "Updated todos" },
          icon: { glyph: "ListTodo" },
          suppress: true,
        },
      }),
    ]);
    expect(completedItems(events)).toEqual([
      {
        type: "planSteps",
        id: expect.any(String),
        steps: [
          { step: "Read the spec", status: "completed" },
          { step: "Writing the code", status: "active" },
          { step: "Run the tests", status: "pending" },
        ],
        status: "completed",
        presentation: {
          label: { pending: "Updating plan", completed: "Updated plan" },
          icon: { glyph: "ListTodo" },
          suppress: true,
          title: "Writing the code",
        },
      },
    ]);
  });

  it("folds TaskCreate/TaskUpdate/TaskList results into planSteps snapshots", () => {
    const harness = createClaudeDeltaHarness();
    harness.translate(
      toolUse("create-1", "TaskCreate", {
        subject: "Ship the bridge",
        activeForm: "Shipping the bridge",
      }),
    );
    const created = harness.translate(
      toolResult("create-1", "Task #1 created successfully: Ship the bridge", {
        tool_use_result: { task: { id: "1", subject: "Ship the bridge" } },
      }),
    );
    expect(completedItems(created)).toEqual([
      expect.objectContaining({
        type: "toolCall",
        tool: "TaskCreate",
        result: "Task #1 created successfully: Ship the bridge",
        presentation: expect.objectContaining({
          suppress: true,
          title: "Ship the bridge",
        }),
      }),
      expect.objectContaining({
        type: "planSteps",
        steps: [{ step: "Ship the bridge", status: "pending" }],
      }),
    ]);

    harness.translate(
      toolUse("update-1", "TaskUpdate", { taskId: "1", status: "in_progress" }),
    );
    const updated = harness.translate(
      toolResult("update-1", "Updated task #1 status", {
        tool_use_result: { success: true, taskId: "1" },
      }),
    );
    expect(completedItems(updated)).toEqual([
      expect.objectContaining({ type: "toolCall", tool: "TaskUpdate" }),
      expect.objectContaining({
        type: "planSteps",
        steps: [{ step: "Shipping the bridge", status: "active" }],
        presentation: expect.objectContaining({
          title: "Shipping the bridge",
        }),
      }),
    ]);

    harness.translate(
      toolUse("update-2", "TaskUpdate", { taskId: "9", status: "completed" }),
    );
    const unknown = harness.translate(
      toolResult("update-2", "Updated task #9 status", {
        tool_use_result: { success: true, taskId: "9" },
      }),
    );
    expect(completedItems(unknown).map((item) => item.type)).toEqual([
      "toolCall",
    ]);

    harness.translate(toolUse("list-1", "TaskList", {}));
    const listed = harness.translate(
      toolResult("list-1", "2 tasks", {
        tool_use_result: {
          tasks: [
            { id: "1", subject: "Ship the bridge", status: "completed" },
            { id: "2", subject: "Old task", status: "deleted" },
            { id: "3", subject: "Review", status: "pending" },
          ],
        },
      }),
    );
    expect(completedItems(listed)).toContainEqual(
      expect.objectContaining({
        type: "planSteps",
        steps: [
          { step: "Ship the bridge", status: "completed" },
          { step: "Review", status: "pending" },
        ],
      }),
    );
  });

  it("collapses the low-value housekeeping calls and titles them from their arguments", () => {
    const harness = createClaudeDeltaHarness();
    const events = harness.translate({
      type: "assistant",
      message: {
        role: "assistant",
        content: [
          {
            type: "tool_use",
            id: "ts-1",
            name: "ToolSearch",
            input: { query: "select:Monitor", max_results: 1 },
          },
          { type: "tool_use", id: "to-1", name: "TaskOutput", input: {} },
          {
            type: "tool_use",
            id: "mon-1",
            name: "Monitor",
            input: { command: "tail -f build.log" },
          },
          {
            type: "tool_use",
            id: "sw-1",
            name: "ScheduleWakeup",
            input: { delaySeconds: 600, reason: "watching CI" },
          },
          {
            type: "tool_use",
            id: "sm-1",
            name: "SendMessage",
            input: { to: "reviewer", message: "done" },
          },
          { type: "tool_use", id: "q-1", name: "AskUserQuestion", input: {} },
        ],
      },
      session_id: "sess-1",
    });
    const byTool = new Map(
      startedItems(events).flatMap((item) =>
        item.type === "toolCall" ? [[item.tool, item] as const] : [],
      ),
    );
    expect(byTool.get("ToolSearch")?.presentation).toEqual({
      label: { pending: "Searching tools", completed: "Searched tools" },
      icon: { glyph: "Toolbox" },
      suppress: true,
      title: "select:Monitor",
    });
    expect(byTool.get("TaskOutput")?.presentation).toMatchObject({
      suppress: true,
    });
    expect(byTool.get("Monitor")?.presentation).toMatchObject({
      suppress: true,
      title: "tail -f build.log",
    });
    expect(byTool.get("ScheduleWakeup")?.presentation).toMatchObject({
      suppress: true,
      title: "watching CI",
    });
    expect(byTool.get("SendMessage")?.presentation).toMatchObject({
      suppress: true,
      title: "reviewer",
    });
    expect(byTool.get("AskUserQuestion")?.presentation).toMatchObject({
      suppress: true,
    });
  });

  it("splits an MCP-served tool into server and tool with a generic presentation", () => {
    const harness = createClaudeDeltaHarness();
    const events = harness.translate(
      toolUse("mcp-1", "mcp__claude_ai_Intuit__expert_search", { q: "cpa" }),
    );
    expect(startedItems(events)).toEqual([
      expect.objectContaining({
        type: "toolCall",
        server: "claude_ai_Intuit",
        tool: "expert_search",
        arguments: { q: "cpa" },
        presentation: {
          label: {
            pending: "Running expert_search",
            completed: "Ran expert_search",
          },
          icon: { glyph: "Toolbox" },
          title: "claude_ai_Intuit",
        },
      }),
    ]);
  });

  it("emits a bb-injected tool call as server:bb with the definition's presentation", () => {
    const translator = createClaudeDeltaTranslator({ sandboxEnabled: false });
    translator.configureInjectedTools([
      {
        name: "bb_workflow_result",
        presentation: {
          label: {
            pending: "Reading workflow result",
            completed: "Read workflow result",
          },
          icon: { glyph: "Workflow" },
          suppress: true,
        },
      },
      { name: "bb_thread_list" },
    ]);
    const deltas = translator.translate(
      {
        type: "assistant",
        message: {
          role: "assistant",
          content: [
            {
              type: "tool_use",
              id: "bb-1",
              name: "mcp__bb-bridge__bb_workflow_result",
              input: { runId: "wfr_1" },
            },
            {
              type: "tool_use",
              id: "bb-2",
              name: "mcp__bb-bridge__bb_thread_list",
              input: {},
            },
            {
              type: "tool_use",
              id: "bb-3",
              name: "mcp__bb-bridge__not_in_session",
              input: {},
            },
          ],
        },
        session_id: "sess-1",
      },
      { threadId: "t" },
    );
    const opens = deltas.filter((delta) => delta.kind === "item.open");
    expect(opens).toEqual([
      expect.objectContaining({
        item: {
          type: "tool",
          tool: "bb_workflow_result",
          server: "bb",
          args: { runId: "wfr_1" },
        },
        presentation: {
          label: {
            pending: "Reading workflow result",
            completed: "Read workflow result",
          },
          icon: { glyph: "Workflow" },
          suppress: true,
        },
      }),
      expect.objectContaining({
        item: { type: "tool", tool: "bb_thread_list", server: "bb", args: {} },
        presentation: {
          label: {
            pending: "Running bb_thread_list",
            completed: "Ran bb_thread_list",
          },
          icon: { glyph: "Toolbox" },
        },
      }),
      expect.objectContaining({
        item: { type: "tool", tool: "not_in_session", server: "bb", args: {} },
      }),
    ]);
  });

  it("presents an unknown tool generically, without suppression", () => {
    const harness = createClaudeDeltaHarness();
    const events = harness.translate(
      toolUse("x-1", "BrandNewTool", { anything: 1 }),
    );
    expect(presentationOf(startedItems(events)[0])).toEqual({
      label: { pending: "Running BrandNewTool", completed: "Ran BrandNewTool" },
      icon: { glyph: "Toolbox" },
    });
  });

  it("uses the established skill glyph for native Skill calls", () => {
    const harness = createClaudeDeltaHarness();
    const events = harness.translate(
      toolUse("skill-1", "Skill", { skill: "debugging" }),
    );

    expect(presentationOf(startedItems(events)[0])).toEqual({
      label: { pending: "Loading skill", completed: "Loaded skill" },
      icon: { glyph: "Zap" },
      title: "debugging",
    });
  });

  it("maps MultiEdit and NotebookEdit to file changes with their own verbs", () => {
    const harness = createClaudeDeltaHarness();
    const events = harness.translate({
      type: "assistant",
      message: {
        role: "assistant",
        content: [
          {
            type: "tool_use",
            id: "me-1",
            name: "MultiEdit",
            input: {
              file_path: "/repo/src/a.ts",
              edits: [
                { old_string: "a", new_string: "b" },
                { old_string: "c", new_string: "d" },
              ],
            },
          },
          {
            type: "tool_use",
            id: "nb-1",
            name: "NotebookEdit",
            input: { notebook_path: "/repo/nb.ipynb", new_source: "print(1)" },
          },
          {
            type: "tool_use",
            id: "w-1",
            name: "Write",
            input: { file_path: "/repo/new.txt", content: "hi" },
          },
        ],
      },
      session_id: "sess-1",
    });
    const started = startedItems(events);
    expect(started[0]).toMatchObject({
      type: "fileChange",
      changes: [
        { path: "/repo/src/a.ts", kind: "update" },
        { path: "/repo/src/a.ts", kind: "update" },
      ],
      presentation: {
        label: { pending: "Editing file", completed: "Edited file" },
        icon: { glyph: "EditFile" },
        title: "a.ts",
      },
    });
    expect(started[1]).toMatchObject({
      type: "fileChange",
      changes: [{ path: "/repo/nb.ipynb", kind: "update" }],
      presentation: {
        label: { pending: "Editing notebook", completed: "Edited notebook" },
        title: "nb.ipynb",
      },
    });
    expect(started[2]).toMatchObject({
      type: "fileChange",
      changes: [{ path: "/repo/new.txt", kind: "add" }],
      presentation: {
        label: { pending: "Writing file", completed: "Wrote file" },
        title: "new.txt",
      },
    });
  });

  it("labels a backgrounded Bash call as a launch and titles commands by their first line", () => {
    const harness = createClaudeDeltaHarness();
    const events = harness.translate({
      type: "assistant",
      message: {
        role: "assistant",
        content: [
          {
            type: "tool_use",
            id: "b-1",
            name: "Bash",
            input: {
              command: "pnpm dev\n# keep going",
              run_in_background: true,
            },
          },
          {
            type: "tool_use",
            id: "b-2",
            name: "Bash",
            input: { command: "ls -la" },
          },
        ],
      },
      session_id: "sess-1",
    });
    const started = startedItems(events);
    expect(presentationOf(started[0])).toEqual({
      label: {
        pending: "Starting background command",
        completed: "Started background command",
      },
      icon: { glyph: "Terminal" },
      title: "pnpm dev",
    });
    expect(presentationOf(started[1])).toEqual({
      label: { pending: "Running command", completed: "Ran command" },
      icon: { glyph: "Terminal" },
      title: "ls -la",
    });
  });

  it("badges a Bash call that opts out of the session sandbox", () => {
    const harness = createClaudeDeltaHarness({ sandboxEnabled: true });
    const events = harness.translate({
      type: "assistant",
      message: {
        role: "assistant",
        content: [
          {
            type: "tool_use",
            id: "b-1",
            name: "Bash",
            input: {
              command: "ls -la ~/.claude/ide",
              dangerouslyDisableSandbox: true,
            },
          },
          {
            type: "tool_use",
            id: "b-2",
            name: "Bash",
            input: { command: "ls -la ~/.claude/ide" },
          },
        ],
      },
      session_id: "sess-1",
    });
    const started = startedItems(events);
    expect(presentationOf(started[0])).toEqual({
      label: { pending: "Running command", completed: "Ran command" },
      icon: { glyph: "Terminal" },
      title: "ls -la ~/.claude/ide",
      badge: {
        glyph: "SquareUnlock02",
        label: "Outside of sandbox",
        hint: "Outside of sandbox",
        tone: "destructive",
      },
    });
    expect(presentationOf(started[1])).not.toHaveProperty("badge");
  });

  it("omits the sandbox badge when the session never enabled the sandbox", () => {
    const harness = createClaudeDeltaHarness({ sandboxEnabled: false });
    const events = harness.translate({
      type: "assistant",
      message: {
        role: "assistant",
        content: [
          {
            type: "tool_use",
            id: "b-1",
            name: "Bash",
            input: { command: "ls", dangerouslyDisableSandbox: true },
          },
        ],
      },
      session_id: "sess-1",
    });
    expect(presentationOf(startedItems(events)[0])).not.toHaveProperty("badge");
  });

  it("presents a close without an open from the tool name alone", () => {
    const harness = createClaudeDeltaHarness();
    harness.translate({
      type: "assistant",
      message: { role: "assistant", content: [{ type: "text", text: "hi" }] },
      session_id: "sess-1",
    });
    const events = harness.translate({
      type: "user",
      message: {
        role: "user",
        content: [
          {
            type: "tool_result",
            tool_use_id: "lost-1",
            tool_name: "Edit",
            content: "ok",
          },
        ],
      },
      session_id: "sess-1",
    });
    expect(completedItems(events)).toEqual([
      expect.objectContaining({
        type: "fileChange",
        changes: [],
        presentation: {
          label: { pending: "Editing file", completed: "Edited file" },
          icon: { glyph: "EditFile" },
        },
      }),
    ]);
  });

  it("attaches a presentation to every item.open and item.close delta", () => {
    const translator = createClaudeDeltaTranslator({ sandboxEnabled: false });
    const context = { threadId: "t" };
    const deltas = [
      ...translator.translate(
        {
          type: "assistant",
          message: {
            role: "assistant",
            content: [
              {
                type: "tool_use",
                id: "1",
                name: "Bash",
                input: { command: "ls" },
              },
              {
                type: "tool_use",
                id: "2",
                name: "Read",
                input: { file_path: "/a" },
              },
              {
                type: "tool_use",
                id: "3",
                name: "Grep",
                input: { pattern: "x" },
              },
              {
                type: "tool_use",
                id: "4",
                name: "Glob",
                input: { pattern: "*" },
              },
              {
                type: "tool_use",
                id: "5",
                name: "Edit",
                input: { file_path: "/a", old_string: "a", new_string: "b" },
              },
              {
                type: "tool_use",
                id: "6",
                name: "WebSearch",
                input: { query: "q" },
              },
              {
                type: "tool_use",
                id: "7",
                name: "WebFetch",
                input: { url: "https://x" },
              },
              {
                type: "tool_use",
                id: "8",
                name: "Agent",
                input: {
                  description: "d",
                  prompt: "p",
                  subagent_type: "Explore",
                },
              },
              {
                type: "tool_use",
                id: "9",
                name: "TodoWrite",
                input: { todos: [] },
              },
              {
                type: "tool_use",
                id: "10",
                name: "ToolSearch",
                input: { query: "q" },
              },
              { type: "tool_use", id: "11", name: "Whatever", input: {} },
              { type: "tool_use", id: "12", name: "mcp__srv__tool", input: {} },
              { type: "tool_use", id: "13", name: "Bash", input: "bad" },
              { type: "tool_use", id: "14", name: "Read", input: {} },
            ],
          },
          session_id: "sess-1",
        },
        context,
      ),
      ...translator.translate(
        {
          type: "user",
          message: {
            role: "user",
            content: Array.from({ length: 14 }, (_, index) => ({
              type: "tool_result",
              tool_use_id: String(index + 1),
              content: "done",
            })),
          },
          session_id: "sess-1",
        },
        context,
      ),
      ...translator.translate(
        {
          type: "system",
          subtype: "status",
          status: "compacting",
          session_id: "sess-1",
        },
        context,
      ),
      ...translator.translate(
        {
          type: "system",
          subtype: "status",
          status: null,
          session_id: "sess-1",
        },
        context,
      ),
    ];
    const lifecycle = deltas.filter(
      (delta) => delta.kind === "item.open" || delta.kind === "item.close",
    );
    expect(lifecycle.length).toBeGreaterThanOrEqual(30);
    for (const delta of lifecycle) {
      expect(
        delta.kind === "item.open" || delta.kind === "item.close"
          ? delta.presentation
          : undefined,
        `${delta.kind} ${JSON.stringify("item" in delta ? delta.item : null)}`,
      ).toBeDefined();
    }
  });
});

describe("claude background-task presentation", () => {
  function taskStarted(
    taskType: string,
    extra: Record<string, unknown> = {},
  ): Record<string, unknown> {
    return {
      type: "system",
      subtype: "task_started",
      task_id: `task-${taskType}`,
      tool_use_id: `call-${taskType}`,
      description: "Survey the build",
      task_type: taskType,
      session_id: "sess-1",
      ...extra,
    };
  }

  it("presents workflows, background commands and background subagents on open and close", () => {
    const harness = createClaudeDeltaHarness();
    const presentations = new Map<string, unknown>();
    for (const [taskType, extra] of [
      ["local_workflow", { workflow_name: "review-changes" }],
      ["local_bash", {}],
      ["local_agent", { subagent_type: "Explore" }],
    ] as const) {
      harness.translate(spawningToolUseFor(taskStarted(taskType, extra)));
      const opened = harness.translate(taskStarted(taskType, extra));
      const started = startedItems(opened)[0];
      presentations.set(
        `${taskType}:open`,
        started !== undefined && "presentation" in started
          ? started.presentation
          : undefined,
      );
      const closed = harness.translate({
        type: "system",
        subtype: "task_notification",
        task_id: `task-${taskType}`,
        tool_use_id: `call-${taskType}`,
        status: "completed",
        output_file: "",
        summary: "done",
        session_id: "sess-1",
      });
      const completed = closed.find(
        (event) => event.type === "item/backgroundTask/completed",
      );
      presentations.set(
        `${taskType}:close`,
        completed?.type === "item/backgroundTask/completed"
          ? completed.item.presentation
          : undefined,
      );
    }
    expect(presentations.get("local_workflow:open")).toEqual({
      label: { pending: "Running workflow", completed: "Workflow finished" },
      icon: { glyph: "Workflow" },
      title: "review-changes",
    });
    expect(presentations.get("local_workflow:close")).toEqual(
      presentations.get("local_workflow:open"),
    );
    expect(presentations.get("local_bash:open")).toEqual({
      label: {
        pending: "Running background command",
        completed: "Background command finished",
      },
      icon: { glyph: "Terminal" },
      title: "Survey the build",
    });
    expect(presentations.get("local_agent:close")).toEqual({
      label: {
        pending: "Running background agent",
        completed: "Background agent finished",
      },
      icon: { glyph: "UserRound" },
      title: "Survey the build",
    });
  });
});
