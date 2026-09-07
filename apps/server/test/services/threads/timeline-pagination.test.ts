import { describe, expect, it } from "vitest";
import type {
  TimelineRow,
  TimelineUserConversationRow,
} from "@bb/server-contract";
import { paginateTimelineRows } from "../../../src/services/threads/timeline-pagination.js";

function userRow(args: {
  id: string;
  seq: number;
  text: string;
}): TimelineUserConversationRow {
  return {
    id: args.id,
    kind: "conversation",
    role: "user",
    threadId: "thread-1",
    turnId: "turn-1",
    sourceSeqStart: args.seq,
    sourceSeqEnd: args.seq,
    startedAt: args.seq,
    createdAt: args.seq,
    text: args.text,
    mentions: [],
    attachments: null,
    initiator: "user",
    senderThreadId: null,
    systemMessageKind: "unlabeled",
    systemMessageSubject: null,
    turnRequest: { isGrouped: false, kind: "message", status: "accepted" },
  };
}

describe("paginateTimelineRows", () => {
  it("keeps grouped user rows from one request in the same segment", () => {
    const rows: TimelineRow[] = [
      userRow({
        id: "thread-1:user-seed:1",
        seq: 1,
        text: "older",
      }),
      userRow({
        id: "thread-1:user-seed:2",
        seq: 2,
        text: "group first",
      }),
      userRow({
        id: "thread-1:user-seed:2-1",
        seq: 2,
        text: "group second",
      }),
      userRow({
        id: "thread-1:user-seed:3",
        seq: 3,
        text: "newer",
      }),
    ];

    const page = paginateTimelineRows({
      contextBoundarySeq: null,
      sequenceWindowStart: null,
      knownHasOlderSegments: null,
      page: { kind: "latest", segmentLimit: 2 },
      rows,
    });

    expect(page.rows.map((row) => row.id)).toEqual([
      "thread-1:user-seed:2",
      "thread-1:user-seed:2-1",
      "thread-1:user-seed:3",
    ]);
    expect(page.olderCursor).toEqual({
      anchorId: "thread-1:user-seed:2",
      anchorSeq: 2,
    });
  });
});
