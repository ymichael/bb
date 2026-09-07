import { describe, expect, it } from "vitest";
import type { ThreadTimelineResponse, TimelineRow } from "@bb/server-contract";
import {
  DEFAULT_MAX_INLINE_OUTPUT_CHARS,
  truncateTimelineResponseOutputs,
} from "../../../src/services/threads/timeline-output-truncation.js";

const base = {
  id: "row",
  threadId: "thr_x",
  turnId: "turn_1",
  sourceSeqStart: 1,
  sourceSeqEnd: 2,
  startedAt: 0,
  createdAt: 0,
};

function response(rows: TimelineRow[]): ThreadTimelineResponse {
  return {
    rows,
    contextBoundarySeq: null,
    activePromptMode: null,
    activeThinking: null,
    activeWorkflows: [],
    activeBackgroundCommands: [],
    pendingTodos: null,
    goal: null,
    modelFallback: null,
    maxSeq: 0,
    timelinePage: {
      kind: "latest",
      segmentLimit: 20,
      returnedSegmentCount: 0,
      hasOlderRows: false,
      olderCursor: null,
    },
  };
}

function commandRow(output: string): TimelineRow {
  return {
    ...base,
    kind: "work",
    status: "completed",
    workKind: "command",
    callId: "c1",
    command: "echo",
    cwd: null,
    source: null,
    output,
    exitCode: 0,
    completedAt: 1,
    approvalStatus: null,
    activityIntents: [],
  };
}

describe("truncateTimelineResponseOutputs", () => {
  it("truncates a command output above the cap and keeps a marker", () => {
    const big = "x".repeat(DEFAULT_MAX_INLINE_OUTPUT_CHARS + 5_000);
    const out = truncateTimelineResponseOutputs(response([commandRow(big)]));
    const row = out.rows[0] as Extract<
      TimelineRow,
      { kind: "work"; workKind: "command" }
    >;
    expect(row.output.length).toBeLessThan(big.length);
    expect(row.output).toContain("more characters truncated");
    expect(
      row.output.startsWith("x".repeat(DEFAULT_MAX_INLINE_OUTPUT_CHARS)),
    ).toBe(true);
  });

  it("leaves small outputs and their row identity untouched", () => {
    const input = response([commandRow("ok")]);
    const out = truncateTimelineResponseOutputs(input);
    expect(out).toBe(input);
    expect(out.rows[0]).toBe(input.rows[0]);
  });

  it("recurses into turn children", () => {
    const big = "y".repeat(DEFAULT_MAX_INLINE_OUTPUT_CHARS + 1_000);
    const turn: TimelineRow = {
      ...base,
      kind: "turn",
      turnId: "turn_1",
      status: "completed",
      summaryCount: 1,
      completedAt: 1,
      children: [commandRow(big)],
    };
    const out = truncateTimelineResponseOutputs(response([turn]));
    const turnOut = out.rows[0] as Extract<TimelineRow, { kind: "turn" }>;
    const child = turnOut.children![0] as Extract<
      TimelineRow,
      { kind: "work"; workKind: "command" }
    >;
    expect(child.output).toContain("more characters truncated");
  });
});
