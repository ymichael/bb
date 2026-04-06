import { describe, expect, it } from "vitest";
import type { ThreadEventItemType, ThreadEventType } from "@bb/domain";
import {
  compactSummaryStoredEventRows,
} from "../../src/services/threads/timeline.js";
import type { StoredEventRow } from "../../src/services/threads/thread-data.js";

interface BuildStoredEventRowArgs {
  itemId?: string | null;
  itemKind?: ThreadEventItemType | null;
  sequence: number;
  type: ThreadEventType;
}

function buildStoredEventRow(args: BuildStoredEventRowArgs): StoredEventRow {
  return {
    createdAt: args.sequence,
    data: "{}",
    id: `event-${args.sequence}`,
    itemId: args.itemId ?? null,
    itemKind: args.itemKind ?? null,
    providerThreadId: null,
    sequence: args.sequence,
    threadId: "thread-1",
    turnId: null,
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

  it("retains delta rows without an itemId even when compaction is enabled", () => {
    const completedMessageDeltas = Array.from({ length: 1000 }, (_, index) =>
      buildStoredEventRow({
        sequence: index + 1,
        type: "item/agentMessage/delta",
        itemId: "msg-1",
      }),
    );
    const missingItemIdDelta = buildStoredEventRow({
      sequence: 1001,
      type: "item/agentMessage/delta",
      itemId: null,
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
        missingItemIdDelta,
        completedMessage,
      ]),
    ).toEqual([
      completedMessageDeltas[0],
      missingItemIdDelta,
      completedMessage,
    ]);
  });
});
