// @vitest-environment jsdom

import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type {
  ThreadTimelineResponse,
  TimelinePaginationCursor,
  TimelineRow,
  TimelineUserConversationRow,
} from "@bb/server-contract";
import * as api from "@/lib/api";
import { createQueryClientTestHarness } from "@/test/queryClientTestHarness";
import { useThreadTimelinePages } from "./useThreadTimelinePages";

vi.mock("@/lib/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/api")>();

  return {
    ...actual,
    getThreadTimeline: vi.fn(),
  };
});

interface TimelineTestRowArgs {
  id: string;
  sequence: number;
  text?: string;
}

interface MakeTimelineResponseArgs {
  kind?: ThreadTimelineResponse["timelinePage"]["kind"];
  olderCursor: TimelinePaginationCursor | null;
  rows: TimelineRow[];
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
    text: args.text ?? args.id,
    attachments: null,
    userRequest: { kind: "message", status: "accepted" },
  };
}

function makeTimelineResponse({
  kind = "latest",
  olderCursor,
  rows,
}: MakeTimelineResponseArgs): ThreadTimelineResponse {
  return {
    rows,
    activeThinking: null,
    timelinePage: {
      kind,
      segmentLimit: 20,
      returnedSegmentCount: rows.length > 0 ? 1 : 0,
      hasOlderRows: olderCursor !== null,
      olderCursor,
    },
  };
}

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe("useThreadTimelinePages", () => {
  it("recovers from stale older cursor errors without dropping loaded rows", async () => {
    const firstCursor = timelineCursor({ id: "first-cursor", sequence: 20 });
    const staleCursor = timelineCursor({ id: "stale-cursor", sequence: 10 });
    const freshCursor = timelineCursor({ id: "fresh-cursor", sequence: 30 });
    const olderRow = userRow({ id: "older-row", sequence: 10 });
    const latestRow = userRow({ id: "latest-row", sequence: 30 });
    const updatedLatestRow = {
      ...latestRow,
      text: "updated latest",
    };
    let latestRequestCount = 0;

    vi.mocked(api.getThreadTimeline).mockImplementation(async (args) => {
      if (!args.beforeCursor) {
        latestRequestCount += 1;
        return latestRequestCount === 1
          ? makeTimelineResponse({
              rows: [latestRow],
              olderCursor: firstCursor,
            })
          : makeTimelineResponse({
              rows: [updatedLatestRow],
              olderCursor: freshCursor,
            });
      }

      if (args.beforeCursor.anchorId === firstCursor.anchorId) {
        return makeTimelineResponse({
          kind: "older",
          rows: [olderRow],
          olderCursor: staleCursor,
        });
      }

      throw new api.HttpError({
        status: 400,
        code: "invalid_request",
        message: "Timeline pagination cursor is no longer available",
      });
    });

    const { wrapper } = createQueryClientTestHarness();
    const { result } = renderHook(
      () =>
        useThreadTimelinePages({
          threadId: "thread-1",
          managerTimelineView: undefined,
        }),
      { wrapper },
    );

    await waitFor(() => {
      expect(result.current.timelineRows.map((row) => row.id)).toEqual([
        "latest-row",
      ]);
    });

    await act(async () => {
      await result.current.loadOlderTimelineRows();
    });
    expect(result.current.timelineRows.map((row) => row.id)).toEqual([
      "older-row",
      "latest-row",
    ]);
    expect(result.current.hasOlderTimelineRows).toBe(true);

    await act(async () => {
      await result.current.loadOlderTimelineRows();
    });

    expect(result.current.isLoadingOlderTimelineRows).toBe(false);
    expect(result.current.timelineRows.map((row) => row.id)).toEqual([
      "older-row",
      "latest-row",
    ]);
    expect(result.current.timelineRows[1]).toMatchObject({
      text: "updated latest",
    });
    expect(result.current.hasOlderTimelineRows).toBe(true);
  });
});
