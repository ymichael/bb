import { describe, expect, it } from "vitest";
import type { TimelineRow } from "@bb/server-contract";
import {
  createTimelineEventFactory,
  renderTimelineFixture,
} from "./timeline-test-harness.js";

type TimelineDelegationRow = Extract<
  TimelineRow,
  { kind: "work"; workKind: "delegation" }
>;

function findDelegationRow(
  rows: readonly TimelineRow[],
  callId: string,
): TimelineDelegationRow {
  for (const row of rows) {
    if (
      row.kind === "work" &&
      row.workKind === "delegation" &&
      row.callId === callId
    ) {
      return row;
    }
    if (row.kind === "turn" && row.children) {
      const nested = row.children.find(
        (child): child is TimelineDelegationRow =>
          child.kind === "work" &&
          child.workKind === "delegation" &&
          child.callId === callId,
      );
      if (nested) return nested;
    }
  }
  throw new Error(`no delegation row for ${callId}`);
}

describe("delegation item projection", () => {
  it("renders a delegation item as a delegation row with its child content nested", () => {
    const event = createTimelineEventFactory({ threadId: "thread-1" });
    const timeline = renderTimelineFixture({
      events: [
        event.turnStarted({ turnId: "parent-turn", createdAt: 0 }),
        event.delegationStarted({
          turnId: "parent-turn",
          itemId: "call-1",
          childRef: "agent-thread-1",
          label: "/root/read_readme",
          createdAt: 1_000,
        }),
        event.turnStarted({
          turnId: "child-turn",
          parentToolCallId: "call-1",
          createdAt: 2_000,
        }),
        event.assistantCompleted({
          turnId: "child-turn",
          parentToolCallId: "call-1",
          itemId: "child-message",
          text: "README says hello.",
          createdAt: 3_000,
        }),
        event.turnCompleted({ turnId: "child-turn", createdAt: 4_000 }),
        event.delegationCompleted({
          turnId: "parent-turn",
          itemId: "call-1",
          childRef: "agent-thread-1",
          label: "/root/read_readme",
          summary: "Read the README.",
          createdAt: 5_000,
        }),
        event.turnCompleted({ turnId: "parent-turn", createdAt: 6_000 }),
      ],
      projectionOptions: {
        threadStatus: "idle",
        turnMessageDetail: "full",
      },
    });

    const row = findDelegationRow(timeline.rows, "call-1");
    expect(row).toEqual(
      expect.objectContaining({
        workKind: "delegation",
        status: "completed",
        description: "/root/read_readme",
        output: "Read the README.",
        completedAt: 5_000,
      }),
    );
    expect(
      row.childRows.map((child) =>
        child.kind === "conversation" ? child.text : child.kind,
      ),
    ).toContain("README says hello.");
    const rootConversationTexts = timeline.rows.flatMap((row) =>
      row.kind === "turn"
        ? (row.children ?? []).flatMap((child) =>
            child.kind === "conversation" ? [child.text] : [],
          )
        : row.kind === "conversation"
          ? [row.text]
          : [],
    );
    expect(rootConversationTexts).not.toContain("README says hello.");
  });

  it("keeps a delegation pending across the settled parent turn", () => {
    const event = createTimelineEventFactory({ threadId: "thread-1" });
    const timeline = renderTimelineFixture({
      events: [
        event.turnStarted({ turnId: "parent-turn", createdAt: 0 }),
        event.delegationStarted({
          turnId: "parent-turn",
          itemId: "call-1",
          childRef: "agent-thread-1",
          label: "/root/review",
          createdAt: 1_000,
        }),
        event.turnCompleted({ turnId: "parent-turn", createdAt: 2_000 }),
      ],
      projectionOptions: {
        threadStatus: "active",
        turnMessageDetail: "full",
      },
    });
    expect(findDelegationRow(timeline.rows, "call-1")).toEqual(
      expect.objectContaining({
        status: "pending",
        description: "/root/review",
      }),
    );
  });
});
