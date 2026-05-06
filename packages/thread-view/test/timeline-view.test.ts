import { describe, expect, it } from "vitest";
import type {
  TimelineActivityIntent,
  TimelineCommandWorkRow,
  TimelineConversationRow,
  TimelineDelegationWorkRow,
  TimelineFileChangeWorkRow,
  TimelineRowBase,
  TimelineRowStatus,
  TimelineToolWorkRow,
} from "@bb/server-contract";
import {
  buildTimelineWorkSummaryLabel,
  buildTimelineViewRows,
  type ThreadTimelineViewRow,
  type TimelineBundleSummaryRow,
  type TimelineStepSummaryRow,
  type TimelineViewDelegationWorkRow,
} from "../src/timeline-view.js";

interface WorkRowOverrides {
  createdAt?: number;
  id?: string;
  sourceSeqEnd?: number;
  sourceSeqStart?: number;
  startedAt?: number;
  status?: TimelineRowStatus;
  turnId?: string | null;
}

function baseRow(id: string, overrides: WorkRowOverrides = {}): TimelineRowBase {
  return {
    id,
    threadId: "thread-1",
    turnId: overrides.turnId ?? "turn-1",
    sourceSeqStart: overrides.sourceSeqStart ?? 1,
    sourceSeqEnd: overrides.sourceSeqEnd ?? 1,
    startedAt: overrides.startedAt ?? 1,
    createdAt: overrides.createdAt ?? 1,
  };
}

function assistantRow({
  id,
  text = "",
  ...overrides
}: WorkRowOverrides & { id: string; text?: string }): TimelineConversationRow {
  return {
    ...baseRow(id, overrides),
    kind: "conversation",
    role: "assistant",
    text,
    attachments: null,
    userRequest: null,
  };
}

interface CommandRowOverrides extends WorkRowOverrides {
  activityIntents?: TimelineActivityIntent[];
  callId?: string;
  command?: string;
  durationMs?: number | null;
}

function commandRow({
  activityIntents = [],
  callId = "call-1",
  command = "pnpm test",
  durationMs = 200,
  id = "command-1",
  sourceSeqEnd = 1,
  sourceSeqStart = 1,
  status = "completed",
  ...baseOverrides
}: CommandRowOverrides = {}): TimelineCommandWorkRow {
  return {
    ...baseRow(id, { ...baseOverrides, sourceSeqEnd, sourceSeqStart }),
    kind: "work",
    workKind: "command",
    inClosedStep: false,
    status,
    callId,
    command,
    cwd: null,
    source: null,
    output: "",
    exitCode: 0,
    durationMs,
    approvalStatus: null,
    activityIntents,
  };
}

function readIntent(path: string): TimelineActivityIntent {
  return {
    type: "read",
    command: `cat ${path}`,
    name: path.split("/").pop() ?? path,
    path,
  };
}

interface FileChangeRowOverrides extends WorkRowOverrides {
  callId?: string;
  path?: string;
}

function fileChangeRow({
  callId = "file-edit-1",
  id = "file-change-1",
  path = "src/app.ts",
  status = "completed",
  ...baseOverrides
}: FileChangeRowOverrides = {}): TimelineFileChangeWorkRow {
  return {
    ...baseRow(id, baseOverrides),
    kind: "work",
    workKind: "file-change",
    inClosedStep: false,
    status,
    callId,
    change: {
      path,
      kind: "update",
      movePath: null,
      diff: "@@ -1 +1 @@\n-before\n+after",
      diffStats: {
        added: 1,
        removed: 1,
      },
    },
    stdout: null,
    stderr: null,
    approvalStatus: null,
  };
}

interface ToolRowOverrides extends WorkRowOverrides {
  activityIntents?: TimelineActivityIntent[];
  callId?: string;
  durationMs?: number | null;
  label?: string;
  output?: string;
  toolArgs?: TimelineToolWorkRow["toolArgs"];
  toolName?: string;
}

function toolRow({
  activityIntents = [],
  callId = "tool-call-1",
  durationMs = 200,
  id = "tool-1",
  label = "LookupTool select:TodoWrite",
  output = "",
  status = "completed",
  toolArgs = { query: "select:TodoWrite" },
  toolName = "LookupTool",
  ...baseOverrides
}: ToolRowOverrides = {}): TimelineToolWorkRow {
  return {
    ...baseRow(id, baseOverrides),
    kind: "work",
    workKind: "tool",
    inClosedStep: false,
    status,
    callId,
    toolName,
    toolArgs,
    label,
    output,
    durationMs,
    approvalStatus: null,
    activityIntents,
  };
}

interface DelegationRowOverrides extends WorkRowOverrides {
  callId?: string;
  childRows?: TimelineDelegationWorkRow["childRows"];
}

function delegationRow({
  callId = "delegation-call-1",
  childRows = [],
  id = "delegation-1",
  status = "completed",
  ...baseOverrides
}: DelegationRowOverrides = {}): TimelineDelegationWorkRow {
  return {
    ...baseRow(id, baseOverrides),
    kind: "work",
    workKind: "delegation",
    inClosedStep: false,
    status,
    callId,
    toolName: "spawnAgent",
    subagentType: "reviewer",
    description: "Review timeline grouping",
    output: "",
    durationMs: 500,
    childRows,
  };
}

function deniedCommandRow(): TimelineCommandWorkRow {
  return {
    ...commandRow(),
    id: "command-denied-1",
    callId: "call-denied-1",
    command: "git push",
    approvalStatus: "denied",
  };
}

function expectStepSummaryRow(
  row: ThreadTimelineViewRow | undefined,
): TimelineStepSummaryRow {
  if (!row || row.kind !== "step-summary") {
    throw new Error("Expected step summary row");
  }
  return row;
}

function expectBundleSummaryRow(
  row: ThreadTimelineViewRow | undefined,
): TimelineBundleSummaryRow {
  if (!row || row.kind !== "bundle-summary") {
    throw new Error("Expected bundle summary row");
  }
  return row;
}

function expectDelegationWorkRow(
  row: ThreadTimelineViewRow | undefined,
): TimelineViewDelegationWorkRow {
  if (!row || row.kind !== "work" || row.workKind !== "delegation") {
    throw new Error("Expected delegation work row");
  }
  return row;
}

describe("buildTimelineViewRows", () => {
  it("keeps a single completed command work run visible as a leaf", () => {
    const rows = buildTimelineViewRows([commandRow()]);

    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      kind: "work",
      workKind: "command",
      id: "command-1",
      callId: "call-1",
      command: "pnpm test",
      durationMs: 200,
      status: "completed",
      sourceSeqStart: 1,
      sourceSeqEnd: 1,
      startedAt: 1,
      createdAt: 1,
      turnId: "turn-1",
    });
  });

  it("keeps single terminal work rows as direct leaves regardless of status", () => {
    // Per Q1: single terminal rows are always muted leaves; the old behavior
    // of wrapping single denied/error/interrupted in a 1-child summary is gone.
    const cases = [
      commandRow({ id: "command-error", status: "error" }),
      commandRow({ id: "command-interrupted", status: "interrupted" }),
      {
        ...commandRow({ id: "command-denied" }),
        approvalStatus: "denied" as const,
      },
      fileChangeRow({ id: "file-change-error", status: "error" }),
      fileChangeRow({ id: "file-change-interrupted", status: "interrupted" }),
      {
        ...fileChangeRow({ id: "file-change-denied" }),
        approvalStatus: "denied" as const,
      },
      toolRow({ id: "tool-error", status: "error" }),
      toolRow({ id: "tool-interrupted", status: "interrupted" }),
      {
        ...toolRow({ id: "tool-denied" }),
        approvalStatus: "denied" as const,
      },
    ] as const;

    for (const inputRow of cases) {
      const rows = buildTimelineViewRows([inputRow]);

      expect(rows).toHaveLength(1);
      expect(rows[0]?.kind).toBe("work");
      expect(rows[0]?.id).toBe(inputRow.id);
    }
  });

  it("keeps a single denied command as a leaf row", () => {
    const rows = buildTimelineViewRows([deniedCommandRow()]);

    expect(rows).toHaveLength(1);
    expect(rows[0]?.kind).toBe("work");
    expect(rows[0]).toMatchObject({
      id: "command-denied-1",
      approvalStatus: "denied",
    });
  });

  it("keeps activity summary identity stable as a run grows", () => {
    const firstRows = buildTimelineViewRows([
      commandRow({
        id: "command-1",
        sourceSeqStart: 1,
        sourceSeqEnd: 1,
      }),
    ]);
    const nextRows = buildTimelineViewRows([
      commandRow({
        id: "command-1",
        sourceSeqStart: 1,
        sourceSeqEnd: 1,
      }),
      commandRow({
        id: "command-2",
        sourceSeqStart: 2,
        sourceSeqEnd: 2,
      }),
    ]);
    const nextSummary = expectBundleSummaryRow(nextRows[0]);

    expect(firstRows[0]).toMatchObject({
      kind: "work",
      workKind: "command",
      id: "command-1",
    });
    expect(nextSummary.id).toBe(
      "thread-1:turn-1:work-summary:command-1",
    );
    expect(nextSummary.status).toBe("completed");
    expect(nextSummary.sourceSeqStart).toBe(1);
    expect(nextSummary.sourceSeqEnd).toBe(2);
    expect(nextSummary.children.map((child) => child.id)).toEqual([
      "command-1",
      "command-2",
    ]);
    expect(buildTimelineWorkSummaryLabel(nextSummary)).toBe(
      "Ran 2 commands",
    );
  });

  it("keeps bundle row identity stable across activity transitions", () => {
    const pendingRows = buildTimelineViewRows([
      commandRow({
        id: "command-1",
        sourceSeqStart: 1,
        status: "pending",
      }),
      commandRow({
        id: "command-2",
        sourceSeqStart: 2,
        status: "pending",
      }),
    ]);
    const completedRows = buildTimelineViewRows([
      commandRow({
        id: "command-1",
        sourceSeqStart: 1,
        status: "completed",
      }),
      commandRow({
        id: "command-2",
        sourceSeqStart: 2,
        status: "completed",
      }),
    ]);

    const pendingSummary = expectBundleSummaryRow(pendingRows[0]);
    const completedSummary = expectBundleSummaryRow(completedRows[0]);

    expect(pendingSummary.id).toBe("thread-1:turn-1:work-summary:command-1");
    expect(completedSummary.id).toBe(pendingSummary.id);
    // Active-latest treatment is decided by list-level renderers, not by the
    // grouper. The label generator opts in to active wording only when asked.
    expect(buildTimelineWorkSummaryLabel(pendingSummary, { active: true })).toBe(
      "Running 2 commands",
    );
    expect(buildTimelineWorkSummaryLabel(completedSummary)).toBe(
      "Ran 2 commands",
    );
  });

  it("keeps single non-terminal work rows visible as leaves", () => {
    const pendingRows = buildTimelineViewRows([
      commandRow({ id: "command-pending", status: "pending" }),
    ]);
    const waitingRows = buildTimelineViewRows([
      {
        ...commandRow({ id: "command-waiting" }),
        approvalStatus: "waiting_for_approval",
      },
    ]);

    expect(pendingRows).toHaveLength(1);
    expect(pendingRows[0]).toMatchObject({
      kind: "work",
      workKind: "command",
      id: "command-pending",
      status: "pending",
    });
    expect(waitingRows).toHaveLength(1);
    expect(waitingRows[0]).toMatchObject({
      kind: "work",
      workKind: "command",
      id: "command-waiting",
      approvalStatus: "waiting_for_approval",
    });
  });

  it("groups same-concept consecutive work into a bundle regardless of status mix", () => {
    // The new grouping is concept-based; mixing completed and pending of the
    // same concept stays in one bundle (active-latest decided by the renderer).
    const rows = buildTimelineViewRows([
      commandRow({ id: "command-completed", sourceSeqStart: 1 }),
      commandRow({
        id: "command-pending",
        sourceSeqStart: 2,
        status: "pending",
      }),
    ]);

    expect(rows).toHaveLength(1);
    const bundle = expectBundleSummaryRow(rows[0]);
    expect(bundle.children.map((c) => c.id)).toEqual([
      "command-completed",
      "command-pending",
    ]);
  });

  it("uses active labels for command, subagent, and file-edit runs", () => {
    const commandSummary = expectBundleSummaryRow(
      buildTimelineViewRows([
        commandRow({
          id: "command-pending-1",
          sourceSeqStart: 1,
          status: "pending",
        }),
        commandRow({
          id: "command-pending-2",
          sourceSeqStart: 2,
          status: "pending",
        }),
      ])[0],
    );
    const delegationSummary = expectBundleSummaryRow(
      buildTimelineViewRows([
        delegationRow({
          id: "delegation-pending-1",
          sourceSeqStart: 1,
          status: "pending",
        }),
        delegationRow({
          id: "delegation-pending-2",
          sourceSeqStart: 2,
          status: "pending",
        }),
      ])[0],
    );
    const fileEditSummary = expectBundleSummaryRow(
      buildTimelineViewRows([
        fileChangeRow({
          id: "file-change-pending-1",
          path: "src/app.ts",
          sourceSeqStart: 1,
          status: "pending",
        }),
        fileChangeRow({
          id: "file-change-pending-2",
          path: "src/other.ts",
          sourceSeqStart: 2,
          status: "pending",
        }),
      ])[0],
    );

    expect(
      buildTimelineWorkSummaryLabel(commandSummary, { active: true }),
    ).toBe("Running 2 commands");
    expect(
      buildTimelineWorkSummaryLabel(delegationSummary, { active: true }),
    ).toBe("Running 2 subagents");
    expect(
      buildTimelineWorkSummaryLabel(fileEditSummary, { active: true }),
    ).toBe("Editing 2 files");
    expect(commandSummary.status).toBe("pending");
    expect(delegationSummary.status).toBe("pending");
    expect(fileEditSummary.children[0]).toMatchObject({
      workKind: "file-change",
      change: {
        path: "src/app.ts",
        diffStats: {
          added: 1,
          removed: 1,
        },
      },
    });
  });

  it("emits multi-concept step-summary phrasing once an assistant boundary closes the step", () => {
    // Before the assistant boundary the step is open and concepts render as
    // separate leaves/bundles. After the assistant arrives, the step closes
    // into a single multi-concept step-summary.
    const rows = buildTimelineViewRows([
      commandRow({
        activityIntents: [readIntent("src/app.ts")],
        id: "read-1",
        sourceSeqStart: 1,
      }),
      commandRow({
        id: "command-1",
        sourceSeqStart: 2,
      }),
      assistantRow({ id: "assistant-1", sourceSeqStart: 3 }),
    ]);

    const summary = expectStepSummaryRow(rows[0]);
    expect(buildTimelineWorkSummaryLabel(summary)).toBe(
      "Explored 1 file, ran 1 command",
    );
    expect(rows[1]?.kind).toBe("conversation");
  });

  it("uses active labels for tool-only bundle summaries", () => {
    const rows = buildTimelineViewRows([
      toolRow({
        activityIntents: [],
        id: "tool-pending-1",
        sourceSeqStart: 1,
        status: "pending",
      }),
      toolRow({
        activityIntents: [],
        id: "tool-pending-2",
        sourceSeqStart: 2,
        status: "pending",
      }),
    ]);
    const summary = expectBundleSummaryRow(rows[0]);

    expect(
      buildTimelineWorkSummaryLabel(summary, { active: true }),
    ).toBe("Running 2 tools");
  });

  it("groups child work under nested delegation rows", () => {
    const rows = buildTimelineViewRows([
      delegationRow({
        childRows: [
          commandRow({
            id: "child-command-1",
            callId: "child-call-1",
            sourceSeqStart: 10,
            sourceSeqEnd: 10,
            startedAt: 10,
            createdAt: 10,
          }),
          commandRow({
            id: "child-command-2",
            callId: "child-call-2",
            sourceSeqStart: 11,
            sourceSeqEnd: 11,
            startedAt: 11,
            createdAt: 11,
          }),
        ],
      }),
    ]);

    const delegation = expectDelegationWorkRow(rows[0]);
    const childSummary = expectBundleSummaryRow(delegation.childRows[0]);

    expect(rows).toHaveLength(1);
    expect(delegation.childRows).toHaveLength(1);
    expect(buildTimelineWorkSummaryLabel(childSummary)).toBe(
      "Ran 2 commands",
    );
    expect(childSummary).toMatchObject({
      status: "completed",
      sourceSeqStart: 10,
      sourceSeqEnd: 11,
      startedAt: 10,
      createdAt: 11,
      turnId: "turn-1",
    });
    expect(
      childSummary.children.map((child) => ({
        id: child.id,
        callId: child.workKind === "approval" ? null : child.callId,
        command: child.workKind === "command" ? child.command : null,
      })),
    ).toEqual([
      {
        id: "child-command-1",
        callId: "child-call-1",
        command: "pnpm test",
      },
      {
        id: "child-command-2",
        callId: "child-call-2",
        command: "pnpm test",
      },
    ]);
  });
});
