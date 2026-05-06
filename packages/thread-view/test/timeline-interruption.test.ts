import { describe, expect, it } from "vitest";
import type { ThreadEventRow } from "@bb/domain";
import type { TimelineRow } from "@bb/server-contract";
import {
  createTimelineEventFactory,
  renderTimelineFixture,
} from "./timeline-test-harness.js";

type TimelineWorkRow = Extract<TimelineRow, { kind: "work" }>;

function getNestedRows(row: TimelineRow): readonly TimelineRow[] {
  if (row.kind === "turn") {
    return row.children ?? [];
  }
  if (row.kind === "work" && row.workKind === "delegation") {
    return row.childRows;
  }
  return [];
}

function flattenTimelineRows(rows: readonly TimelineRow[]): TimelineRow[] {
  const flattenedRows: TimelineRow[] = [];
  const visitRows = (currentRows: readonly TimelineRow[]): void => {
    for (const row of currentRows) {
      flattenedRows.push(row);
      visitRows(getNestedRows(row));
    }
  };
  visitRows(rows);
  return flattenedRows;
}

function getOnlyWorkRowByCallId(
  rows: readonly TimelineRow[],
  callId: string,
): TimelineWorkRow {
  const matches = flattenTimelineRows(rows).filter(
    (row): row is TimelineWorkRow =>
      row.kind === "work" &&
      "callId" in row &&
      row.callId === callId,
  );
  expect(matches).toHaveLength(1);
  const row = matches[0];
  if (!row) {
    throw new Error(`Expected work row for ${callId}`);
  }
  return row;
}

function renderIdleTimeline(events: ThreadEventRow[]) {
  return renderTimelineFixture({
    events,
    projectionOptions: {
      systemClientRequestVisibility: "hidden",
      threadStatus: "idle",
      turnMessageDetail: "full",
    },
  });
}

describe("timeline interruption projection", () => {
  it("uses interrupted turn completion time for pending command and tool rows", () => {
    const event = createTimelineEventFactory({ threadId: "thread-1" });
    const timeline = renderIdleTimeline([
      event.turnStarted({ createdAt: 0 }),
      event.commandStarted({
        itemId: "cmd-1",
        command: "pnpm test",
        createdAt: 1_000,
      }),
      event.toolCallStarted({
        itemId: "tool-1",
        tool: "LookupTool",
        arguments: { query: "select:TodoWrite" },
        createdAt: 2_000,
      }),
      event.turnCompleted({
        status: "interrupted",
        createdAt: 6_000,
      }),
    ]);

    const commandRow = getOnlyWorkRowByCallId(timeline.rows, "cmd-1");
    const toolRow = getOnlyWorkRowByCallId(timeline.rows, "tool-1");

    expect(commandRow).toMatchObject({
      workKind: "command",
      status: "interrupted",
      startedAt: 1_000,
      completedAt: 6_000,
    });
    expect(toolRow).toMatchObject({
      workKind: "tool",
      status: "interrupted",
      startedAt: 2_000,
      completedAt: 6_000,
    });
  });

  it("uses system interruption time for pending command and web rows", () => {
    const event = createTimelineEventFactory({ threadId: "thread-1" });
    const timeline = renderIdleTimeline([
      event.turnStarted({ createdAt: 0 }),
      event.commandStarted({
        itemId: "cmd-1",
        command: "pnpm test",
        createdAt: 1_000,
      }),
      event.webSearchStarted({
        itemId: "web-1",
        queries: ["timeline renderer"],
        createdAt: 2_000,
      }),
      event.systemThreadInterrupted({ createdAt: 5_000 }),
    ]);

    const commandRow = getOnlyWorkRowByCallId(timeline.rows, "cmd-1");
    const webRow = getOnlyWorkRowByCallId(timeline.rows, "web-1");

    expect(commandRow).toMatchObject({
      workKind: "command",
      status: "interrupted",
      startedAt: 1_000,
      completedAt: 5_000,
    });
    expect(webRow).toMatchObject({
      workKind: "web-search",
      status: "interrupted",
      startedAt: 2_000,
      completedAt: 5_000,
    });
  });
});
