// @vitest-environment jsdom

import { describe, expect, it } from "vitest";
import type {
  ThreadTimelineResponse,
  TimelineCommandWorkRow,
} from "@bb/server-contract";
import { createQueryClientTestHarness } from "@/test/queryClientTestHarness";
import { insertOptimisticTimelineRow } from "./query-cache";
import {
  threadTimelineLatestQueryKey,
  threadTimelineOlderQueryKey,
} from "./query-keys";

type TimelinePageKind = ThreadTimelineResponse["timelinePage"]["kind"];

function emptyTimelineResponse(kind: TimelinePageKind): ThreadTimelineResponse {
  return {
    activeThinking: null,
    rows: [],
    timelinePage: {
      kind,
      turnLimit: 5,
      returnedTopLevelRowCount: 0,
      hasOlderRows: false,
      olderCursor: null,
    },
  };
}

function commandRow(): TimelineCommandWorkRow {
  return {
    id: "command-1",
    threadId: "thread-1",
    turnId: "turn-1",
    sourceSeqStart: 10,
    sourceSeqEnd: 10,
    startedAt: 10,
    createdAt: 10,
    kind: "work",
    workKind: "command",
    status: "pending",
    callId: "command-1",
    command: "pnpm test",
    cwd: null,
    source: null,
    output: "",
    exitCode: null,
    completedAt: null,
    approvalStatus: null,
    activityIntents: [],
  };
}

describe("timeline query cache updates", () => {
  it("keeps optimistic rows out of older timeline page caches", () => {
    const { queryClient } = createQueryClientTestHarness();
    const latestKey = threadTimelineLatestQueryKey("thread-1", undefined);
    const olderKey = threadTimelineOlderQueryKey("thread-1", undefined, {
      seq: 10,
      id: "row-10",
    });
    queryClient.setQueryData<ThreadTimelineResponse>(
      latestKey,
      emptyTimelineResponse("latest"),
    );
    queryClient.setQueryData<ThreadTimelineResponse>(
      olderKey,
      emptyTimelineResponse("older"),
    );

    insertOptimisticTimelineRow(queryClient, "thread-1", commandRow());

    expect(
      queryClient.getQueryData<ThreadTimelineResponse>(latestKey)?.rows,
    ).toHaveLength(1);
    expect(
      queryClient.getQueryData<ThreadTimelineResponse>(olderKey)?.rows,
    ).toHaveLength(0);
  });
});
