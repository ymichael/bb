import { describe, expect, it } from "vitest";
import type {
  TimelineActivityIntent,
  TimelineCommandWorkRow,
  TimelineDelegationWorkRow,
  TimelineFileChangeWorkRow,
  TimelineRowBase,
  TimelineRowStatus,
} from "@bb/server-contract";
import {
  buildTimelineActivitySummaryLabel,
  buildTimelineViewRows,
  type ThreadTimelineViewRow,
  type TimelineActivitySummaryRow,
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

function expectActivitySummaryRow(
  row: ThreadTimelineViewRow | undefined,
): TimelineActivitySummaryRow {
  if (!row || row.kind !== "activity-summary") {
    throw new Error("Expected activity summary row");
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
  it("wraps a single command work run in an activity summary", () => {
    const rows = buildTimelineViewRows([commandRow()]);

    expect(rows).toHaveLength(1);
    const row = expectActivitySummaryRow(rows[0]);

    expect(buildTimelineActivitySummaryLabel(row)).toBe("Ran 1 command");
    expect(row).toMatchObject({
      status: "completed",
      sourceSeqStart: 1,
      sourceSeqEnd: 1,
      startedAt: 1,
      createdAt: 1,
      turnId: "turn-1",
    });
    expect(row.children).toHaveLength(1);
    expect(row.children[0]).toMatchObject({
      id: "command-1",
      callId: "call-1",
      command: "pnpm test",
      durationMs: 200,
      status: "completed",
    });
  });

  it("does not label a denied command summary as ran work", () => {
    const rows = buildTimelineViewRows([deniedCommandRow()]);

    expect(rows).toHaveLength(1);
    const row = expectActivitySummaryRow(rows[0]);

    expect(buildTimelineActivitySummaryLabel(row)).toBe("Denied 1 command");
    expect(row.status).toBe("completed");
    expect(row.children).toHaveLength(1);
    expect(row.children[0]).toMatchObject({
      id: "command-denied-1",
      approvalStatus: "denied",
      command: "git push",
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
    const firstSummary = expectActivitySummaryRow(firstRows[0]);
    const nextSummary = expectActivitySummaryRow(nextRows[0]);

    expect(nextSummary.id).toBe(firstSummary.id);
    expect(nextSummary.status).toBe("completed");
    expect(nextSummary.sourceSeqStart).toBe(1);
    expect(nextSummary.sourceSeqEnd).toBe(2);
    expect(nextSummary.children.map((child) => child.id)).toEqual([
      "command-1",
      "command-2",
    ]);
    expect(buildTimelineActivitySummaryLabel(nextSummary)).toBe(
      "Ran 2 commands",
    );
  });

  it("uses active labels for command, subagent, and file-edit runs", () => {
    const commandSummary = expectActivitySummaryRow(
      buildTimelineViewRows([
        commandRow({ id: "command-pending", status: "pending" }),
      ])[0],
    );
    const delegationSummary = expectActivitySummaryRow(
      buildTimelineViewRows([
        delegationRow({ id: "delegation-pending", status: "pending" }),
      ])[0],
    );
    const fileEditSummary = expectActivitySummaryRow(
      buildTimelineViewRows([
        fileChangeRow({ id: "file-change-pending", status: "pending" }),
      ])[0],
    );

    expect(buildTimelineActivitySummaryLabel(commandSummary)).toBe(
      "Running 1 command",
    );
    expect(buildTimelineActivitySummaryLabel(delegationSummary)).toBe(
      "Running 1 subagent",
    );
    expect(buildTimelineActivitySummaryLabel(fileEditSummary)).toBe(
      "Editing 1 file",
    );
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

    const parentSummary = expectActivitySummaryRow(rows[0]);
    const delegation = expectDelegationWorkRow(parentSummary.children[0]);
    const childSummary = expectActivitySummaryRow(delegation.childRows[0]);

    expect(buildTimelineActivitySummaryLabel(parentSummary)).toBe(
      "Ran 1 subagent",
    );
    expect(parentSummary.children).toHaveLength(1);
    expect(delegation.childRows).toHaveLength(1);
    expect(buildTimelineActivitySummaryLabel(childSummary)).toBe(
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
        callId: child.callId,
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
