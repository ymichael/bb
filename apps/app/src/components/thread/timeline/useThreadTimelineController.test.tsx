// @vitest-environment jsdom

import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import type {
  ThreadTimelineResponse,
  TimelineRow,
  TimelineUserConversationRow,
} from "@bb/server-contract";
import { mergeLatestTimelineRows } from "@bb/client-core";
import { afterEach, describe, expect, it, vi } from "vitest";
import { BbHttpError, sdk } from "@/lib/sdk";
import { OPTIMISTIC_TIMELINE_ROW_ID_PREFIX } from "@bb/client-core";
import { threadTimelineQueryKey } from "@/hooks/queries/query-keys";
import { createQueryClientTestHarness } from "@/test/queryClientTestHarness";
import { useThreadTimelineController } from "./useThreadTimelineController";
import { makeThreadTimelineResponse as makeTimelineResponse } from "@/test/fixtures/thread-responses";

vi.mock("@/lib/sdk", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/sdk")>();
  return {
    ...actual,
    sdk: { threads: { timeline: vi.fn() } },
  };
});

vi.mock("@/hooks/useRealtimeSubscription", () => ({
  useThreadDetailRealtimeSubscription: vi.fn(),
}));

vi.mock("@/hooks/useServerConnectionState", () => ({
  useServerConnectionState: () => "connected",
}));

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

function makeUserRow(
  id: string,
  sourceSeq: number,
): TimelineUserConversationRow {
  return {
    id,
    kind: "conversation",
    role: "user",
    threadId: "thread-1",
    turnId: null,
    sourceSeqStart: sourceSeq,
    sourceSeqEnd: sourceSeq,
    startedAt: 1,
    createdAt: 1,
    text: "hello",
    mentions: [],
    attachments: null,
    initiator: "user",
    senderThreadId: null,
    systemMessageKind: "unlabeled",
    systemMessageSubject: null,
    turnRequest: { isGrouped: false, kind: "message", status: "accepted" },
  };
}

describe("mergeLatestTimelineRows", () => {
  it("replaces a retained optimistic row with the server row it stands in for", () => {
    const optimistic = makeUserRow(`${OPTIMISTIC_TIMELINE_ROW_ID_PREFIX}a1`, 0);
    const serverRow = makeUserRow("thread-1:user-seed:5", 5);

    const merged = mergeLatestTimelineRows({
      latestRows: [serverRow],
      latestWindowStartSequence: 0,
      loadedRows: [optimistic],
    });

    expect(merged.rows.map((row) => row.id)).toEqual([serverRow.id]);
  });

  it("still appends genuinely disjoint server rows to retained ones", () => {
    const older = makeUserRow("thread-1:user-seed:1", 1);
    const newer = makeUserRow("thread-1:user-seed:5", 5);

    const merged = mergeLatestTimelineRows({
      latestRows: [newer],
      latestWindowStartSequence: 5,
      loadedRows: [older],
    });

    expect(merged.rows.map((row) => row.id)).toEqual([older.id, newer.id]);
  });

  it("keeps a pending optimistic row that the latest snapshot still carries", () => {
    const optimistic = makeUserRow(`${OPTIMISTIC_TIMELINE_ROW_ID_PREFIX}a1`, 0);

    const merged = mergeLatestTimelineRows({
      latestRows: [optimistic],
      latestWindowStartSequence: 0,
      loadedRows: [optimistic],
    });

    expect(merged.rows.map((row) => row.id)).toEqual([optimistic.id]);
  });
});

describe("useThreadTimelineController", () => {
  it("replaces loaded rows when realtime data starts a new context epoch", async () => {
    const oldRow = makeUserRow("thread-1:user-seed:1", 1);
    const boundaryRow: TimelineRow = {
      id: "context-clear-10",
      kind: "system",
      threadId: "thread-1",
      turnId: null,
      sourceSeqStart: 10,
      sourceSeqEnd: 10,
      startedAt: 10,
      createdAt: 10,
      systemKind: "operation",
      operationKind: "generic",
      title: "Context cleared",
      detail: null,
      status: "completed",
      completedAt: 10,
    };
    vi.mocked(sdk.threads.timeline).mockResolvedValue(
      makeTimelineResponse({ rows: [oldRow], maxSeq: 1 }),
    );

    const { queryClient, wrapper } = createQueryClientTestHarness();
    const { result } = renderHook(
      () => useThreadTimelineController({ threadId: "thread-1" }),
      { wrapper },
    );
    await waitFor(() => {
      expect(result.current.timelineRows.map((row) => row.id)).toEqual([
        oldRow.id,
      ]);
    });

    act(() => {
      queryClient.setQueryData(
        threadTimelineQueryKey("thread-1"),
        makeTimelineResponse({
          contextBoundarySeq: 10,
          maxSeq: 10,
          rows: [boundaryRow],
        }),
      );
    });

    await waitFor(() => {
      expect(result.current.contextBoundarySeq).toBe(10);
      expect(result.current.timelineRows.map((row) => row.id)).toEqual([
        boundaryRow.id,
      ]);
    });
  });

  it("discards an in-flight older page when a context reset changes the surface", async () => {
    const oldRow = makeUserRow("thread-1:user-seed:1", 1);
    const olderRow = makeUserRow("thread-1:user-seed:0", 0);
    const boundaryRow: TimelineRow = {
      id: "context-clear-10",
      kind: "system",
      threadId: "thread-1",
      turnId: null,
      sourceSeqStart: 10,
      sourceSeqEnd: 10,
      startedAt: 10,
      createdAt: 10,
      systemKind: "operation",
      operationKind: "generic",
      title: "Context cleared",
      detail: null,
      status: "completed",
      completedAt: 10,
    };
    let resolveOlder: (value: ThreadTimelineResponse) => void = () => {};
    vi.mocked(sdk.threads.timeline)
      .mockResolvedValueOnce(
        makeTimelineResponse({
          rows: [oldRow],
          maxSeq: 1,
          timelinePage: {
            hasOlderRows: true,
            olderCursor: { anchorId: oldRow.id, anchorSeq: 1 },
          },
        }),
      )
      .mockImplementationOnce(
        () =>
          new Promise<ThreadTimelineResponse>((resolve) => {
            resolveOlder = resolve;
          }),
      );

    const { queryClient, wrapper } = createQueryClientTestHarness();
    const { result } = renderHook(
      () => useThreadTimelineController({ threadId: "thread-1" }),
      { wrapper },
    );
    await waitFor(() => {
      expect(result.current.hasOlderTimelineRows).toBe(true);
    });

    let olderRequest: Promise<void> = Promise.resolve();
    act(() => {
      olderRequest = result.current.loadOlderTimelineRows();
    });
    await waitFor(() => {
      expect(sdk.threads.timeline).toHaveBeenCalledTimes(2);
    });
    act(() => {
      queryClient.setQueryData(
        threadTimelineQueryKey("thread-1"),
        makeTimelineResponse({
          contextBoundarySeq: 10,
          maxSeq: 10,
          rows: [boundaryRow],
        }),
      );
    });
    await waitFor(() => {
      expect(result.current.timelineRows.map((row) => row.id)).toEqual([
        boundaryRow.id,
      ]);
    });

    resolveOlder(
      makeTimelineResponse({
        rows: [olderRow],
        maxSeq: 1,
        timelinePage: { kind: "older" },
      }),
    );
    await act(async () => {
      await olderRequest;
    });

    expect(result.current.contextBoundarySeq).toBe(10);
    expect(result.current.timelineRows.map((row) => row.id)).toEqual([
      boundaryRow.id,
    ]);
  });

  it("keeps an initial timeline refetch in loading state instead of showing the previous error", async () => {
    const response = makeTimelineResponse();
    let resolveRefetch: (value: ThreadTimelineResponse) => void = () => {};
    vi.mocked(sdk.threads.timeline)
      .mockRejectedValueOnce(
        new BbHttpError({
          body: null,
          code: null,
          status: 500,
          message: "Server error",
        }),
      )
      .mockImplementationOnce(
        () =>
          new Promise<ThreadTimelineResponse>((resolve) => {
            resolveRefetch = resolve;
          }),
      );

    const { queryClient, wrapper } = createQueryClientTestHarness();
    const { result } = renderHook(
      () => useThreadTimelineController({ threadId: "thread-1" }),
      { wrapper },
    );

    await waitFor(() => {
      expect(result.current.timelineError).toBeInstanceOf(BbHttpError);
    });

    act(() => {
      void queryClient.refetchQueries({
        queryKey: threadTimelineQueryKey("thread-1"),
      });
    });

    await waitFor(() => {
      expect(result.current.timelineLoading).toBe(true);
    });
    expect(result.current.timelineError).toBeNull();

    resolveRefetch(response);

    await waitFor(() => {
      expect(result.current.timelineLoading).toBe(false);
      expect(result.current.timelineError).toBeNull();
      expect(sdk.threads.timeline).toHaveBeenCalledTimes(2);
    });
  });
});
