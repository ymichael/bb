import { describe, expect, it } from "vitest";
import type { ThreadEventItemType, ThreadEventType } from "@bb/domain";
import type { StoredEventRow } from "@bb/db";
import { compactSummaryStoredEventRows } from "../../src/services/threads/timeline.js";

interface BuildStoredEventRowArgs {
  itemId?: string | null;
  itemKind?: ThreadEventItemType | null;
  parentToolCallId?: string;
  sequence: number;
  turnId?: string | null;
  type: ThreadEventType;
}

function buildStoredEventRowData(args: BuildStoredEventRowArgs): string {
  if (args.type === "item/agentMessage/delta") {
    return JSON.stringify({
      ...(args.itemId ? { itemId: args.itemId } : {}),
      ...(args.parentToolCallId
        ? { parentToolCallId: args.parentToolCallId }
        : {}),
      delta: `chunk-${args.sequence}`,
    });
  }

  if (args.type === "item/completed" && args.itemKind === "agentMessage") {
    return JSON.stringify({
      item: {
        id: args.itemId ?? `msg-${args.sequence}`,
        type: "agentMessage",
        text: `message-${args.sequence}`,
        ...(args.parentToolCallId
          ? { parentToolCallId: args.parentToolCallId }
          : {}),
      },
    });
  }

  return "{}";
}

function buildStoredEventRow(args: BuildStoredEventRowArgs): StoredEventRow {
  return {
    createdAt: args.sequence,
    data: buildStoredEventRowData(args),
    id: `event-${args.sequence}`,
    itemId: args.itemId ?? null,
    itemKind: args.itemKind ?? null,
    providerThreadId: "provider-thread-1",
    sequence: args.sequence,
    threadId: "thread-1",
    turnId: args.turnId ?? "turn-1",
    type: args.type,
  };
}

describe("compactSummaryStoredEventRows", () => {
  it("returns the original rows when the delta threshold is not met", () => {
    const rows = Array.from({ length: 999 }, (_, index) =>
      buildStoredEventRow({
        sequence: index + 1,
        type: "item/agentMessage/delta",
        itemId: "msg-1",
      }),
    );

    expect(compactSummaryStoredEventRows(rows)).toBe(rows);
  });

  it("returns the original rows when there are no completed agent messages to compact", () => {
    const rows = Array.from({ length: 1000 }, (_, index) =>
      buildStoredEventRow({
        sequence: index + 1,
        type: "item/agentMessage/delta",
        itemId: "msg-1",
      }),
    );

    expect(compactSummaryStoredEventRows(rows)).toBe(rows);
  });

  it("keeps only the first completed agent-message delta once compaction is enabled", () => {
    const completedMessageDeltas = Array.from({ length: 1000 }, (_, index) =>
      buildStoredEventRow({
        sequence: index + 1,
        type: "item/agentMessage/delta",
        itemId: "msg-1",
      }),
    );
    const incompleteMessageDelta = buildStoredEventRow({
      sequence: 1001,
      type: "item/agentMessage/delta",
      itemId: "msg-2",
    });
    const completedMessage = buildStoredEventRow({
      sequence: 1002,
      type: "item/completed",
      itemId: "msg-1",
      itemKind: "agentMessage",
    });

    expect(
      compactSummaryStoredEventRows([
        ...completedMessageDeltas,
        incompleteMessageDelta,
        completedMessage,
      ]),
    ).toEqual([
      completedMessageDeltas[0],
      incompleteMessageDelta,
      completedMessage,
    ]);
  });

  it("keeps the first delta for each completed agent message independently", () => {
    const firstMessageDeltas = Array.from({ length: 500 }, (_, index) =>
      buildStoredEventRow({
        sequence: index + 1,
        type: "item/agentMessage/delta",
        itemId: "msg-1",
      }),
    );
    const secondMessageDeltas = Array.from({ length: 500 }, (_, index) =>
      buildStoredEventRow({
        sequence: index + 501,
        type: "item/agentMessage/delta",
        itemId: "msg-2",
      }),
    );
    const incompleteMessageDelta = buildStoredEventRow({
      sequence: 1001,
      type: "item/agentMessage/delta",
      itemId: "msg-3",
    });
    const firstCompletedMessage = buildStoredEventRow({
      sequence: 1002,
      type: "item/completed",
      itemId: "msg-1",
      itemKind: "agentMessage",
    });
    const secondCompletedMessage = buildStoredEventRow({
      sequence: 1003,
      type: "item/completed",
      itemId: "msg-2",
      itemKind: "agentMessage",
    });

    expect(
      compactSummaryStoredEventRows([
        ...firstMessageDeltas,
        ...secondMessageDeltas,
        incompleteMessageDelta,
        firstCompletedMessage,
        secondCompletedMessage,
      ]),
    ).toEqual([
      firstMessageDeltas[0],
      secondMessageDeltas[0],
      incompleteMessageDelta,
      firstCompletedMessage,
      secondCompletedMessage,
    ]);
  });

  it("does not compact later-turn deltas when the same item id is reused across turns", () => {
    const completedTurnDeltas = Array.from({ length: 1000 }, (_, index) =>
      buildStoredEventRow({
        sequence: index + 1,
        turnId: "turn-1",
        type: "item/agentMessage/delta",
        itemId: "msg-1",
      }),
    );
    const laterTurnDeltaOne = buildStoredEventRow({
      sequence: 1001,
      turnId: "turn-2",
      type: "item/agentMessage/delta",
      itemId: "msg-1",
    });
    const laterTurnDeltaTwo = buildStoredEventRow({
      sequence: 1002,
      turnId: "turn-2",
      type: "item/agentMessage/delta",
      itemId: "msg-1",
    });
    const completedTurnMessage = buildStoredEventRow({
      sequence: 1003,
      turnId: "turn-1",
      type: "item/completed",
      itemId: "msg-1",
      itemKind: "agentMessage",
    });

    expect(
      compactSummaryStoredEventRows([
        ...completedTurnDeltas,
        laterTurnDeltaOne,
        laterTurnDeltaTwo,
        completedTurnMessage,
      ]),
    ).toEqual([
      completedTurnDeltas[0],
      laterTurnDeltaOne,
      laterTurnDeltaTwo,
      completedTurnMessage,
    ]);
  });

  it("keeps same-turn deltas for a different parent tool call even when item ids match", () => {
    const completedParentDeltas = Array.from({ length: 1000 }, (_, index) =>
      buildStoredEventRow({
        sequence: index + 1,
        type: "item/agentMessage/delta",
        itemId: "msg-1",
        parentToolCallId: "tool-1",
      }),
    );
    const siblingParentDeltaOne = buildStoredEventRow({
      sequence: 1001,
      type: "item/agentMessage/delta",
      itemId: "msg-1",
      parentToolCallId: "tool-2",
    });
    const siblingParentDeltaTwo = buildStoredEventRow({
      sequence: 1002,
      type: "item/agentMessage/delta",
      itemId: "msg-1",
      parentToolCallId: "tool-2",
    });
    const completedMessage = buildStoredEventRow({
      sequence: 1003,
      type: "item/completed",
      itemId: "msg-1",
      itemKind: "agentMessage",
      parentToolCallId: "tool-1",
    });

    expect(
      compactSummaryStoredEventRows([
        ...completedParentDeltas,
        siblingParentDeltaOne,
        siblingParentDeltaTwo,
        completedMessage,
      ]),
    ).toEqual([
      completedParentDeltas[0],
      siblingParentDeltaOne,
      siblingParentDeltaTwo,
      completedMessage,
    ]);
  });
});
