import { describe, expect, it } from "vitest";
import type {
  ThreadTimelineResponse,
  TimelineCommandWorkRow,
  TimelinePaginationCursor,
  TimelineRow,
  TimelineTurnRow,
  TimelineUserConversationRow,
} from "@bb/server-contract";
import {
  mergeLoadedTimelineWithLatest,
  mergeLatestTimelineRows,
  prependOlderTimelineRows,
  recoverLoadedTimelineAfterStaleCursor,
  type LoadedTimelineState,
} from "./useThreadTimelinePages";

interface TimelineTestRowArgs {
  id: string;
  sequence: number;
}

function timelineCursor(args: TimelineTestRowArgs): TimelinePaginationCursor {
  return {
    anchorSeq: args.sequence,
    anchorId: args.id,
  };
}

function userRow(args: TimelineTestRowArgs): TimelineUserConversationRow {
  return {
    id: args.id,
    threadId: "thread-1",
    turnId: "turn-1",
    sourceSeqStart: args.sequence,
    sourceSeqEnd: args.sequence,
    startedAt: args.sequence,
    createdAt: args.sequence,
    kind: "conversation",
    role: "user",
    text: args.id,
    attachments: null,
    userRequest: { kind: "message", status: "accepted" },
  };
}

function commandRow(args: TimelineTestRowArgs): TimelineCommandWorkRow {
  return {
    id: args.id,
    threadId: "thread-1",
    turnId: "turn-1",
    sourceSeqStart: args.sequence,
    sourceSeqEnd: args.sequence,
    startedAt: args.sequence,
    createdAt: args.sequence,
    kind: "work",
    workKind: "command",
    status: "completed",
    callId: args.id,
    command: "pnpm test",
    cwd: null,
    source: null,
    output: "",
    exitCode: 0,
    completedAt: args.sequence,
    approvalStatus: null,
    activityIntents: [],
  };
}

function turnSummaryRow(args: TimelineTestRowArgs): TimelineTurnRow {
  return {
    id: args.id,
    threadId: "thread-1",
    turnId: "turn-1",
    sourceSeqStart: args.sequence,
    sourceSeqEnd: args.sequence,
    startedAt: args.sequence,
    createdAt: args.sequence,
    kind: "turn",
    status: "completed",
    summaryCount: 1,
    completedAt: args.sequence,
    children: null,
  };
}

function makeTimelineResponse(
  rows: TimelineRow[],
  olderCursor: TimelinePaginationCursor | null,
): ThreadTimelineResponse {
  return {
    rows,
    activeThinking: null,
    timelinePage: {
      kind: "latest",
      segmentLimit: 20,
      returnedSegmentCount: rows.length > 0 ? 1 : 0,
      hasOlderRows: olderCursor !== null,
      olderCursor,
    },
  };
}

function makeLoadedTimelineState(
  rows: TimelineRow[],
  olderCursor: TimelinePaginationCursor | null,
): LoadedTimelineState {
  return {
    rows,
    olderCursor,
    surfaceKey: "thread-1:default",
  };
}

describe("timeline page row merging", () => {
  it("prepends older server-ordered rows without sorting by source sequence", () => {
    const olderUser = userRow({ id: "older-user", sequence: 10 });
    const olderCommand = commandRow({ id: "older-command", sequence: 1 });
    const latestUser = userRow({ id: "latest-user", sequence: 20 });

    const rows = prependOlderTimelineRows({
      olderRows: [olderUser, olderCommand],
      loadedRows: [latestUser],
    });

    expect(rows.map((row) => row.id)).toEqual([
      "older-user",
      "older-command",
      "latest-user",
    ]);
  });

  it("keeps server-ordered worked-for rows after the first user when their source sequence sorts earlier", () => {
    const firstUser = userRow({ id: "first-user", sequence: 10 });
    const workedForSummary = turnSummaryRow({
      id: "worked-for-summary",
      sequence: 1,
    });
    const latestUser = userRow({ id: "latest-user", sequence: 20 });

    const rows = prependOlderTimelineRows({
      olderRows: [firstUser, workedForSummary],
      loadedRows: [latestUser],
    });

    expect(rows.map((row) => row.id)).toEqual([
      "first-user",
      "worked-for-summary",
      "latest-user",
    ]);
  });

  it("replaces the overlapping latest tail while preserving loaded history", () => {
    const olderUser = userRow({ id: "older-user", sequence: 1 });
    const oldTail = userRow({ id: "live-tail", sequence: 20 });
    const updatedTail = {
      ...oldTail,
      text: "updated tail",
    };
    const newStreamingRow = commandRow({
      id: "new-streaming-row",
      sequence: 21,
    });

    const merge = mergeLatestTimelineRows({
      loadedRows: [olderUser, oldTail],
      latestRows: [updatedTail, newStreamingRow],
    });

    expect(merge.rows.map((row) => row.id)).toEqual([
      "older-user",
      "live-tail",
      "new-streaming-row",
    ]);
    expect(merge.rows[1]).toMatchObject({ text: "updated tail" });
  });

  it("keeps loaded rows and the oldest cursor when latest advances without overlap", () => {
    const oldestCursor = timelineCursor({ id: "oldest", sequence: 1 });
    const latestCursor = timelineCursor({ id: "latest-page", sequence: 40 });
    const current = makeLoadedTimelineState(
      [userRow({ id: "oldest", sequence: 1 })],
      oldestCursor,
    );
    const latestTimeline = makeTimelineResponse(
      [userRow({ id: "latest", sequence: 50 })],
      latestCursor,
    );

    const next = mergeLoadedTimelineWithLatest({
      current,
      latestTimeline,
      surfaceKey: "thread-1:default",
    });

    expect(next.rows.map((row) => row.id)).toEqual(["oldest", "latest"]);
    expect(next.olderCursor).toEqual(oldestCursor);
  });

  it("recovers from a stale cursor with a fresh latest cursor without dropping loaded rows", () => {
    const staleCursor = timelineCursor({ id: "stale-cursor", sequence: 1 });
    const freshCursor = timelineCursor({ id: "fresh-cursor", sequence: 40 });
    const olderUser = userRow({ id: "older-user", sequence: 1 });
    const oldTail = userRow({ id: "live-tail", sequence: 20 });
    const updatedTail = {
      ...oldTail,
      text: "updated tail",
    };
    const latestTimeline = makeTimelineResponse([updatedTail], freshCursor);

    const next = recoverLoadedTimelineAfterStaleCursor({
      current: makeLoadedTimelineState([olderUser, oldTail], staleCursor),
      latestTimeline,
      surfaceKey: "thread-1:default",
    });

    expect(next.rows.map((row) => row.id)).toEqual(["older-user", "live-tail"]);
    expect(next.rows[1]).toMatchObject({ text: "updated tail" });
    expect(next.olderCursor).toEqual(freshCursor);
  });
});
