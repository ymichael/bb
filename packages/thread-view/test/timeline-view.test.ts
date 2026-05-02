import { describe, expect, it } from "vitest";
import type {
  TimelineCommandWorkRow,
  TimelineRowBase,
} from "@bb/server-contract";
import {
  buildTimelineActivitySummaryLabel,
  buildTimelineViewRows,
} from "../src/index.js";

function baseRow(id: string): TimelineRowBase {
  return {
    id,
    threadId: "thread-1",
    turnId: "turn-1",
    sourceSeqStart: 1,
    sourceSeqEnd: 1,
    startedAt: 1,
    createdAt: 1,
  };
}

function commandRow(): TimelineCommandWorkRow {
  return {
    ...baseRow("command-1"),
    kind: "work",
    workKind: "command",
    status: "completed",
    callId: "call-1",
    command: "pnpm test",
    cwd: null,
    source: null,
    output: "",
    exitCode: 0,
    durationMs: 200,
    approvalStatus: null,
    activityIntents: [],
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

describe("buildTimelineViewRows", () => {
  it("wraps a single command work run in an activity summary", () => {
    const rows = buildTimelineViewRows([commandRow()]);

    expect(rows).toHaveLength(1);
    const row = rows[0];
    if (!row || row.kind !== "activity-summary") {
      throw new Error("Expected one-row command run to be summarized");
    }

    expect(buildTimelineActivitySummaryLabel(row)).toBe("Ran 1 command");
    expect(row.children).toHaveLength(1);
    expect(row.children[0]?.id).toBe("command-1");
  });

  it("does not label a denied command summary as ran work", () => {
    const rows = buildTimelineViewRows([deniedCommandRow()]);

    expect(rows).toHaveLength(1);
    const row = rows[0];
    if (!row || row.kind !== "activity-summary") {
      throw new Error("Expected denied command run to be summarized");
    }

    expect(buildTimelineActivitySummaryLabel(row)).toBe("Denied 1 command");
    expect(row.children).toHaveLength(1);
    expect(row.children[0]?.id).toBe("command-denied-1");
  });
});
