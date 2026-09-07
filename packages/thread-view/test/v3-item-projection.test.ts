import { describe, expect, it } from "vitest";
import type { TimelineRow, TimelineWorkRow } from "@bb/server-contract";
import type { ThreadTimelineViewRow } from "../src/index.js";
import type { ThreadEventItemPresentation } from "@bb/domain";
import {
  buildTimelineActivityIntentTitles,
  buildTimelineRowTitle,
  buildTimelineViewRows,
  timelineRowActivityIntents,
} from "../src/index.js";
import {
  createTimelineEventFactory,
  renderTimelineFixture,
} from "./timeline-test-harness.js";

function flattenRows(rows: readonly TimelineRow[]): TimelineRow[] {
  return rows.flatMap((row) =>
    row.kind === "turn" && row.children
      ? [row, ...flattenRows(row.children)]
      : row.kind === "work" && row.workKind === "delegation"
        ? [row, ...flattenRows(row.childRows)]
        : [row],
  );
}

function workRows(rows: readonly TimelineRow[]): TimelineWorkRow[] {
  return flattenRows(rows).filter(
    (row): row is TimelineWorkRow => row.kind === "work",
  );
}

function workRow<K extends TimelineWorkRow["workKind"]>(
  rows: readonly TimelineRow[],
  workKind: K,
  callId: string,
): Extract<TimelineWorkRow, { workKind: K }> {
  const row = workRows(rows).find(
    (candidate): candidate is Extract<TimelineWorkRow, { workKind: K }> =>
      candidate.workKind === workKind &&
      "callId" in candidate &&
      candidate.callId === callId,
  );
  if (!row) {
    throw new Error(`no ${workKind} row for ${callId}`);
  }
  return row;
}

function plainTitle(row: ThreadTimelineViewRow): string {
  return buildTimelineRowTitle(row, {
    summaryStyle: "bundle",
    workStyle: "default",
  }).plain;
}

const READ_PRESENTATION: ThreadEventItemPresentation = {
  label: { pending: "Reading file", completed: "Read file" },
  icon: { glyph: "FileText" },
  title: "index.ts",
};

const SEARCH_PRESENTATION: ThreadEventItemPresentation = {
  label: { pending: "Searching files", completed: "Searched files" },
  icon: { glyph: "Search" },
  title: "TODO",
};

const SUPPRESSED_TOOL_PRESENTATION: ThreadEventItemPresentation = {
  label: { pending: "Searching tools", completed: "Searched tools" },
  icon: { glyph: "Toolbox" },
  suppress: true,
};

const JS_PRESENTATION: ThreadEventItemPresentation = {
  label: { pending: "Running JavaScript", completed: "Ran JavaScript" },
  icon: { glyph: "Code" },
  title: "Compute primes",
  detail: "Sieve of Eratosthenes up to 10k",
};

const ECHO_PRESENTATION: ThreadEventItemPresentation = {
  label: { pending: "Echoing", completed: "Echoed" },
  icon: { glyph: "MessageSquare" },
  title: "hello",
  detail: "**hello** world",
  tint: { light: "#1d4ed8", dark: "#93c5fd" },
};

const SANDBOX_ESCAPED_COMMAND_PRESENTATION: ThreadEventItemPresentation = {
  label: { pending: "Running command", completed: "Ran command" },
  icon: { glyph: "Terminal" },
  title: "ls -la ~/.claude/ide",
  badge: {
    glyph: "SquareUnlock02",
    label: "Outside of sandbox",
    hint: "Outside of sandbox",
    tone: "destructive",
  },
};

const PLAN_PRESENTATION: ThreadEventItemPresentation = {
  label: { pending: "Updating plan", completed: "Updated plan" },
  icon: { glyph: "ListTodo" },
  title: "Wire the renderer",
};

const SUBAGENT_PRESENTATION: ThreadEventItemPresentation = {
  label: { pending: "Running subagent", completed: "Subagent finished" },
  icon: { glyph: "UserRound" },
  title: "Review the diff",
  detail: "reviewer agent · model opus",
};

describe("v3 item projection", () => {
  it("projects fileRead and search items to file-read and search rows; bare tool calls derive no intent", () => {
    const event = createTimelineEventFactory({ threadId: "thread-1" });
    const v3 = renderTimelineFixture({
      events: [
        event.turnStarted({ turnId: "turn-1", createdAt: 0 }),
        event.fileReadStarted({
          turnId: "turn-1",
          itemId: "read-1",
          path: "src/index.ts",
          presentation: READ_PRESENTATION,
          createdAt: 1_000,
        }),
        event.fileReadCompleted({
          turnId: "turn-1",
          itemId: "read-1",
          path: "src/index.ts",
          presentation: READ_PRESENTATION,
          createdAt: 2_000,
        }),
        event.searchStarted({
          turnId: "turn-1",
          itemId: "grep-1",
          mode: "content",
          query: "TODO",
          path: "src",
          presentation: SEARCH_PRESENTATION,
          createdAt: 3_000,
        }),
        event.searchCompleted({
          turnId: "turn-1",
          itemId: "grep-1",
          mode: "content",
          query: "TODO",
          path: "src",
          presentation: SEARCH_PRESENTATION,
          createdAt: 4_000,
        }),
        event.searchStarted({
          turnId: "turn-1",
          itemId: "glob-1",
          mode: "path",
          query: "**/*.ts",
          path: "src",
          createdAt: 5_000,
        }),
        event.searchCompleted({
          turnId: "turn-1",
          itemId: "glob-1",
          mode: "path",
          query: "**/*.ts",
          path: "src",
          createdAt: 6_000,
        }),
        event.turnCompleted({ turnId: "turn-1", createdAt: 7_000 }),
      ],
      projectionOptions: { threadStatus: "idle", turnMessageDetail: "full" },
    });
    const legacy = renderTimelineFixture({
      events: [
        event.turnStarted({ turnId: "turn-1", createdAt: 0 }),
        event.toolCallStarted({
          turnId: "turn-1",
          itemId: "read-1",
          tool: "Read",
          arguments: { file_path: "src/index.ts" },
          createdAt: 1_000,
        }),
        event.toolCallCompleted({
          turnId: "turn-1",
          itemId: "read-1",
          tool: "Read",
          arguments: { file_path: "src/index.ts" },
          createdAt: 2_000,
        }),
        event.toolCallStarted({
          turnId: "turn-1",
          itemId: "grep-1",
          tool: "Grep",
          arguments: { pattern: "TODO", path: "src" },
          createdAt: 3_000,
        }),
        event.toolCallCompleted({
          turnId: "turn-1",
          itemId: "grep-1",
          tool: "Grep",
          arguments: { pattern: "TODO", path: "src" },
          createdAt: 4_000,
        }),
        event.toolCallStarted({
          turnId: "turn-1",
          itemId: "glob-1",
          tool: "Glob",
          arguments: { pattern: "**/*.ts", path: "src" },
          createdAt: 5_000,
        }),
        event.toolCallCompleted({
          turnId: "turn-1",
          itemId: "glob-1",
          tool: "Glob",
          arguments: { pattern: "**/*.ts", path: "src" },
          createdAt: 6_000,
        }),
        event.turnCompleted({ turnId: "turn-1", createdAt: 7_000 }),
      ],
      projectionOptions: { threadStatus: "idle", turnMessageDetail: "full" },
    });

    const read = workRow(v3.rows, "file-read", "read-1");
    expect(read).toMatchObject({
      path: "src/index.ts",
      cmd: null,
      status: "completed",
      completedAt: 2_000,
      presentation: READ_PRESENTATION,
    });
    const grep = workRow(v3.rows, "search", "grep-1");
    expect(grep).toMatchObject({
      mode: "content",
      query: "TODO",
      path: "src",
      presentation: SEARCH_PRESENTATION,
    });
    const glob = workRow(v3.rows, "search", "glob-1");
    expect(glob).not.toHaveProperty("presentation");

    const intents = (rows: TimelineWorkRow[]) =>
      rows.flatMap((row) =>
        row.workKind === "file-read" || row.workKind === "search"
          ? timelineRowActivityIntents(row).map(
              ({ command: _command, ...intent }) =>
                intent.type === "read" ? { ...intent, name: "" } : intent,
            )
          : [],
      );
    expect(intents(workRows(v3.rows))).toEqual([
      { type: "read", name: "", path: "src/index.ts" },
      { type: "search", query: "TODO", path: "src" },
      { type: "list_files", path: "src" },
    ]);
    expect(intents(workRows(legacy.rows))).toEqual(intents(workRows(v3.rows)));
    expect(
      workRows(legacy.rows).map((row) =>
        row.workKind === "tool" ? row.toolName : row.workKind,
      ),
    ).toEqual(["file-read", "search", "search"]);
    expect(plainTitle(workRow(legacy.rows, "file-read", "read-1"))).toBe(
      "Read src/index.ts",
    );

    expect(plainTitle(read)).toBe("Read file src/index.ts");
    expect(plainTitle(grep)).toBe("Searched files for TODO in src");
    expect(plainTitle(glob)).toBe("Listed files in src");

    expect(
      buildTimelineActivityIntentTitles(read).map((title) => title.title.plain),
    ).toEqual(["Read src/index.ts"]);
  });

  it("carries a command item's presentation through projection into its title", () => {
    const event = createTimelineEventFactory({ threadId: "thread-1" });
    const rendered = renderTimelineFixture({
      events: [
        event.turnStarted({ turnId: "turn-1", createdAt: 0 }),
        event.commandStarted({
          turnId: "turn-1",
          itemId: "cmd-1",
          command: "ls -la ~/.claude/ide",
          presentation: SANDBOX_ESCAPED_COMMAND_PRESENTATION,
          createdAt: 1_000,
        }),
        event.commandCompleted({
          turnId: "turn-1",
          itemId: "cmd-1",
          command: "ls -la ~/.claude/ide",
          presentation: SANDBOX_ESCAPED_COMMAND_PRESENTATION,
          exitCode: 0,
          createdAt: 2_000,
        }),
      ],
      projectionOptions: { threadStatus: "idle", turnMessageDetail: "full" },
    });

    const row = workRow(rendered.rows, "command", "cmd-1");
    expect(row.presentation).toEqual(SANDBOX_ESCAPED_COMMAND_PRESENTATION);
    expect(plainTitle(row)).toContain("(Outside of sandbox)");
  });

  it("groups v3 exploration rows into one exploration bundle like legacy reads", () => {
    const event = createTimelineEventFactory({ threadId: "thread-1" });
    const rendered = renderTimelineFixture({
      events: [
        event.turnStarted({ turnId: "turn-1", createdAt: 0 }),
        event.fileReadCompleted({
          turnId: "turn-1",
          itemId: "read-1",
          path: "src/a.ts",
          createdAt: 1_000,
        }),
        event.fileReadCompleted({
          turnId: "turn-1",
          itemId: "read-2",
          path: "src/b.ts",
          createdAt: 2_000,
        }),
        event.searchCompleted({
          turnId: "turn-1",
          itemId: "grep-1",
          mode: "content",
          query: "TODO",
          createdAt: 3_000,
        }),
        event.assistantCompleted({
          turnId: "turn-1",
          itemId: "answer",
          text: "Done.",
          createdAt: 4_000,
        }),
        event.turnCompleted({ turnId: "turn-1", createdAt: 5_000 }),
      ],
      projectionOptions: { threadStatus: "idle", turnMessageDetail: "full" },
    });
    const turn = rendered.rows.find((row) => row.kind === "turn");
    const viewRows = buildTimelineViewRows(turn?.children ?? []);
    const bundle = viewRows.find((row) => row.kind === "bundle-summary");
    expect(bundle).toBeDefined();
    expect(bundle && plainTitle(bundle)).toBe("Explored 2 files, 1 search");
  });

  it("labels a generic tool row from its presentation and keeps the headline", () => {
    const event = createTimelineEventFactory({ threadId: "thread-1" });
    const rendered = renderTimelineFixture({
      events: [
        event.turnStarted({ turnId: "turn-1", createdAt: 0 }),
        event.toolCallStarted({
          turnId: "turn-1",
          itemId: "js-1",
          tool: "js",
          arguments: { code: "primes(10000)" },
          presentation: JS_PRESENTATION,
          createdAt: 1_000,
        }),
        event.toolCallCompleted({
          turnId: "turn-1",
          itemId: "js-1",
          tool: "js",
          arguments: { code: "primes(10000)" },
          result: "1229",
          presentation: JS_PRESENTATION,
          createdAt: 2_500,
        }),
        event.toolCallStarted({
          turnId: "turn-1",
          itemId: "js-2",
          tool: "js",
          arguments: { code: "boom()" },
          presentation: JS_PRESENTATION,
          createdAt: 3_000,
        }),
        event.toolCallCompleted({
          turnId: "turn-1",
          itemId: "js-2",
          tool: "js",
          arguments: { code: "boom()" },
          error: "ReferenceError",
          status: "failed",
          presentation: JS_PRESENTATION,
          createdAt: 4_500,
        }),
        event.turnCompleted({ turnId: "turn-1", createdAt: 5_000 }),
      ],
      projectionOptions: { threadStatus: "idle", turnMessageDetail: "full" },
    });
    const ok = workRow(rendered.rows, "tool", "js-1");
    expect(ok.presentation).toEqual(JS_PRESENTATION);
    expect(plainTitle(ok)).toBe("Ran JavaScript Compute primes (2s)");
    const failed = workRow(rendered.rows, "tool", "js-2");
    expect(plainTitle(failed)).toBe(
      "Ran JavaScript Compute primes (2s, error)",
    );
  });

  it("prefers presentation over server-enriched statusLabels on the same row", () => {
    const event = createTimelineEventFactory({ threadId: "thread-1" });
    const rendered = renderTimelineFixture({
      events: [
        event.turnStarted({ turnId: "turn-1", createdAt: 0 }),
        event.toolCallCompleted({
          turnId: "turn-1",
          itemId: "plugin-1",
          tool: "bb_task_update",
          presentation: {
            label: { pending: "Updating task", completed: "Updated task" },
            icon: { glyph: "ListTodo" },
          },
          createdAt: 1_000,
        }),
        event.turnCompleted({ turnId: "turn-1", createdAt: 2_000 }),
      ],
      projectionOptions: { threadStatus: "idle", turnMessageDetail: "full" },
    });
    const row = workRow(rendered.rows, "tool", "plugin-1");
    expect(plainTitle(row)).toBe("Updated task");
  });

  it("projects a planSteps snapshot to a plan-steps row that also feeds the todo banner", () => {
    const event = createTimelineEventFactory({ threadId: "thread-1" });
    const steps = [
      { step: "Read the spec", status: "completed" as const },
      { step: "Wire the renderer", status: "active" as const },
      { step: "Write tests", status: "pending" as const },
    ];
    const rendered = renderTimelineFixture({
      events: [
        event.turnStarted({ turnId: "turn-1", createdAt: 0 }),
        event.planStepsCompleted({
          turnId: "turn-1",
          itemId: "plan-1",
          steps,
          explanation: "Three steps.",
          presentation: PLAN_PRESENTATION,
          createdAt: 1_000,
        }),
      ],
      projectionOptions: { threadStatus: "active", turnMessageDetail: "full" },
    });
    const row = workRow(rendered.rows, "plan-steps", "plan-1");
    expect(row).toMatchObject({
      steps,
      explanation: "Three steps.",
      status: "completed",
      presentation: PLAN_PRESENTATION,
    });
    expect(plainTitle(row)).toBe("Updated plan Wire the renderer");
    expect(rendered.pendingTodos?.items.map((item) => item.status)).toEqual([
      "completed",
      "in_progress",
      "pending",
    ]);
  });

  it("projects an extension item to an extension row carrying kind, payload and presentation", () => {
    const event = createTimelineEventFactory({ threadId: "thread-1" });
    const rendered = renderTimelineFixture({
      events: [
        event.turnStarted({ turnId: "turn-1", createdAt: 0 }),
        event.extensionStarted({
          turnId: "turn-1",
          itemId: "echo-1",
          kind: "provider-echo/echo",
          payload: { text: "hello" },
          presentation: ECHO_PRESENTATION,
          createdAt: 1_000,
        }),
        event.extensionCompleted({
          turnId: "turn-1",
          itemId: "echo-1",
          kind: "provider-echo/echo",
          payload: { text: "hello", echoed: true },
          presentation: ECHO_PRESENTATION,
          createdAt: 2_500,
        }),
        event.turnCompleted({ turnId: "turn-1", createdAt: 3_000 }),
      ],
      projectionOptions: { threadStatus: "idle", turnMessageDetail: "full" },
    });
    const row = workRow(rendered.rows, "extension", "echo-1");
    expect(row).toMatchObject({
      extensionKind: "provider-echo/echo",
      payload: { text: "hello", echoed: true },
      presentation: ECHO_PRESENTATION,
      status: "completed",
      startedAt: 1_000,
      completedAt: 2_500,
    });
    expect(plainTitle(row)).toBe("Echoed hello (2s)");
  });

  it("renders a pending extension row with the present-tense label while the turn runs", () => {
    const event = createTimelineEventFactory({ threadId: "thread-1" });
    const rendered = renderTimelineFixture({
      events: [
        event.turnStarted({ turnId: "turn-1", createdAt: 0 }),
        event.extensionStarted({
          turnId: "turn-1",
          itemId: "echo-1",
          kind: "provider-echo/echo",
          payload: { text: "hello" },
          presentation: ECHO_PRESENTATION,
          createdAt: 1_000,
        }),
      ],
      projectionOptions: {
        threadStatus: "active",
        turnMessageDetail: "full",
      },
    });
    const row = workRow(rendered.rows, "extension", "echo-1");
    expect(row.status).toBe("pending");
    expect(plainTitle(row)).toMatch(/^Echoing hello/);
  });

  it("carries childRef, background and presentation on a v3 delegation row", () => {
    const event = createTimelineEventFactory({ threadId: "thread-1" });
    const rendered = renderTimelineFixture({
      events: [
        event.turnStarted({ turnId: "turn-1", createdAt: 0 }),
        event.delegationStarted({
          turnId: "turn-1",
          itemId: "agent-1",
          childRef: "subagent-7",
          label: "Review the diff",
          background: true,
          presentation: SUBAGENT_PRESENTATION,
          createdAt: 1_000,
        }),
        event.delegationCompleted({
          turnId: "turn-1",
          itemId: "agent-1",
          childRef: "subagent-7",
          label: "Review the diff",
          background: true,
          summary: "Looks good.",
          presentation: SUBAGENT_PRESENTATION,
          createdAt: 4_000,
        }),
        event.turnCompleted({ turnId: "turn-1", createdAt: 5_000 }),
      ],
      projectionOptions: { threadStatus: "idle", turnMessageDetail: "full" },
    });
    const row = workRow(rendered.rows, "delegation", "agent-1");
    expect(row).toMatchObject({
      childRef: "subagent-7",
      background: true,
      description: "Review the diff",
      output: "Looks good.",
      presentation: SUBAGENT_PRESENTATION,
    });
    expect(plainTitle(row)).toBe("Subagent finished Review the diff (3s)");
  });

  it("hides items the bridge marked suppress, whatever their kind, unless they failed", () => {
    const event = createTimelineEventFactory({ threadId: "thread-1" });
    const rendered = renderTimelineFixture({
      events: [
        event.turnStarted({ turnId: "turn-1", createdAt: 0 }),
        event.toolCallCompleted({
          turnId: "turn-1",
          itemId: "ts-1",
          tool: "ToolSearch",
          presentation: SUPPRESSED_TOOL_PRESENTATION,
          createdAt: 1_000,
        }),
        event.planStepsCompleted({
          turnId: "turn-1",
          itemId: "plan-1",
          steps: [{ step: "Do it", status: "active" }],
          presentation: { ...PLAN_PRESENTATION, suppress: true },
          createdAt: 2_000,
        }),
        event.extensionCompleted({
          turnId: "turn-1",
          itemId: "echo-quiet",
          kind: "provider-echo/echo",
          payload: {},
          presentation: { ...ECHO_PRESENTATION, suppress: true },
          createdAt: 3_000,
        }),
        event.extensionCompleted({
          turnId: "turn-1",
          itemId: "echo-failed",
          kind: "provider-echo/echo",
          payload: {},
          status: "failed",
          presentation: { ...ECHO_PRESENTATION, suppress: true },
          createdAt: 4_000,
        }),
        event.toolCallCompleted({
          turnId: "turn-1",
          itemId: "keep-1",
          tool: "Monitor",
          createdAt: 5_000,
        }),
      ],
      projectionOptions: {
        threadStatus: "active",
        turnMessageDetail: "full",
      },
    });
    const callIds = workRows(rendered.rows).map((row) =>
      "callId" in row ? row.callId : null,
    );
    expect(callIds).toEqual(["echo-failed", "keep-1"]);
    expect(rendered.pendingTodos?.items.map((item) => item.text)).toEqual([
      "Do it",
    ]);
  });
});
