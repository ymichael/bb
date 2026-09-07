import {
  LEGACY_CODEX_GOAL_EXTENSION_KIND,
  parseStoredThreadEvent,
  threadScope,
} from "@bb/domain";
import { describe, expect, it } from "vitest";
import { extractThreadTimelineGoal } from "../src/goal-snapshot-extraction.js";
import type { ThreadEventWithMeta } from "../src/build-event-projection.js";

function goalUpdatedEvent({
  objective,
  seq,
}: {
  objective: string;
  seq: number;
}): ThreadEventWithMeta {
  return {
    event: {
      type: "thread/extensionState/updated",
      threadId: "thread-1",
      providerThreadId: "provider-thread-1",
      scope: threadScope(),
      kind: LEGACY_CODEX_GOAL_EXTENSION_KIND,
      payload: {
        objective,
        status: "active",
        tokenBudget: 10_000,
        tokensUsed: 250,
        timeUsedSeconds: 30,
      },
    },
    meta: {
      id: `event-${seq}`,
      seq,
      createdAt: seq * 100,
    },
  };
}

function goalClearedEvent(seq: number): ThreadEventWithMeta {
  return {
    event: {
      type: "thread/extensionState/updated",
      threadId: "thread-1",
      providerThreadId: "provider-thread-1",
      scope: threadScope(),
      kind: LEGACY_CODEX_GOAL_EXTENSION_KIND,
      payload: null,
    },
    meta: {
      id: `event-${seq}`,
      seq,
      createdAt: seq * 100,
    },
  };
}

function legacyGoalRow(
  type: "thread/goal/updated" | "thread/goal/cleared",
  seq: number,
  objective = "Legacy goal",
): ThreadEventWithMeta {
  return {
    event: parseStoredThreadEvent({
      type,
      data:
        type === "thread/goal/updated"
          ? {
              objective,
              status: "paused",
              tokenBudget: null,
              tokensUsed: 5,
              timeUsedSeconds: 6,
            }
          : {},
      providerThreadId: "provider-thread-1",
      scope: threadScope(),
      threadId: "thread-1",
    }),
    meta: { id: `event-${seq}`, seq, createdAt: seq * 100 },
  };
}

describe("extractThreadTimelineGoal", () => {
  it("returns the latest goal update", () => {
    expect(
      extractThreadTimelineGoal([
        goalUpdatedEvent({ seq: 1, objective: "Old goal" }),
        goalUpdatedEvent({ seq: 2, objective: "Current goal" }),
      ]),
    ).toEqual({
      sourceSeq: 2,
      updatedAt: 200,
      objective: "Current goal",
      status: "active",
      tokenBudget: 10_000,
      tokensUsed: 250,
      timeUsedSeconds: 30,
    });
  });

  it("returns null when a later clear supersedes an update", () => {
    expect(
      extractThreadTimelineGoal([
        goalUpdatedEvent({ seq: 1, objective: "Current goal" }),
        goalClearedEvent(2),
      ]),
    ).toBeNull();
  });

  it("reads goals persisted as legacy thread/goal rows through read-time conversion", () => {
    expect(
      extractThreadTimelineGoal([
        legacyGoalRow("thread/goal/updated", 1),
        goalUpdatedEvent({ seq: 2, objective: "Live goal" }),
        legacyGoalRow("thread/goal/updated", 3, "Latest legacy goal"),
      ]),
    ).toEqual({
      sourceSeq: 3,
      updatedAt: 300,
      objective: "Latest legacy goal",
      status: "paused",
      tokenBudget: null,
      tokensUsed: 5,
      timeUsedSeconds: 6,
    });
    expect(
      extractThreadTimelineGoal([
        goalUpdatedEvent({ seq: 1, objective: "Live goal" }),
        legacyGoalRow("thread/goal/cleared", 2),
      ]),
    ).toBeNull();
  });

  it("ignores thread state of other kinds", () => {
    expect(
      extractThreadTimelineGoal([
        goalUpdatedEvent({ seq: 1, objective: "Goal" }),
        {
          event: {
            type: "thread/extensionState/updated",
            threadId: "thread-1",
            providerThreadId: "provider-thread-1",
            scope: threadScope(),
            kind: "other-plugin/widget",
            payload: null,
          },
          meta: { id: "event-2", seq: 2, createdAt: 200 },
        },
      ])?.objective,
    ).toBe("Goal");
  });
});
