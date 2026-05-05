// @vitest-environment jsdom

import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type {
  TimelineRow,
  TimelineTurnRow,
  TimelineTurnSummaryDetailsResponse,
} from "@bb/server-contract";
import { useTurnSummaryRowLoader } from "./useTurnSummaryRowLoader";

type HookProps = Parameters<typeof useTurnSummaryRowLoader>[0];
type LoadTurnSummaryRows = HookProps["loadTurnSummaryRows"];
type LoadTurnSummaryRowsArgs = Parameters<LoadTurnSummaryRows>[0];

interface TurnSummaryRowTestOptions {
  sourceSeqEnd?: number;
  sourceSeqStart?: number;
  turnId?: string;
}

interface Deferred<T> {
  promise: Promise<T>;
  resolve: (value: T) => void;
}

function createDeferred<T>(): Deferred<T> {
  let resolvePromise: ((value: T) => void) | null = null;
  const promise = new Promise<T>((resolve) => {
    resolvePromise = resolve;
  });

  return {
    promise,
    resolve(value) {
      if (!resolvePromise) {
        throw new Error("Deferred promise resolver was not initialized");
      }
      resolvePromise(value);
    },
  };
}

function turnSummaryRow(
  options: TurnSummaryRowTestOptions = {},
): TimelineTurnRow {
  const turnId = options.turnId ?? "turn-1";
  const sourceSeqStart = options.sourceSeqStart ?? 1;
  const sourceSeqEnd = options.sourceSeqEnd ?? 3;
  return {
    id: "turn-summary-1",
    kind: "turn",
    threadId: "thread-1",
    turnId,
    status: "completed",
    summaryCount: 1,
    durationMs: 1_000,
    children: null,
    sourceSeqStart,
    sourceSeqEnd,
    startedAt: 1,
    createdAt: 3,
  };
}

function detailRow(text: string): TimelineRow {
  return {
    id: `detail-${text}`,
    kind: "conversation",
    role: "assistant",
    threadId: "thread-1",
    turnId: "turn-1",
    text,
    attachments: null,
    userRequest: null,
    sourceSeqStart: 2,
    sourceSeqEnd: 2,
    startedAt: 2,
    createdAt: 2,
  };
}

afterEach(() => {
  cleanup();
});

describe("useTurnSummaryRowLoader", () => {
  it("resets cached turn details when manager timeline view changes", async () => {
    const requests: LoadTurnSummaryRowsArgs[] = [];
    const loadTurnSummaryRows: LoadTurnSummaryRows = (args) => {
      requests.push(args);
      return Promise.resolve({ rows: [detailRow("conversation detail")] });
    };

    const { result, rerender } = renderHook(
      (props: HookProps) => useTurnSummaryRowLoader(props),
      {
        initialProps: {
          loadTurnSummaryRows,
          managerTimelineView: "conversation",
          timelineRows: [turnSummaryRow()],
          threadId: "thread-1",
        },
      },
    );

    act(() => {
      result.current.handleLoadTurnSummaryRows(turnSummaryRow());
    });

    await waitFor(() => {
      expect(result.current.turnSummaryRowsById["turn-summary-1"]).toEqual([
        detailRow("conversation detail"),
      ]);
    });

    rerender({
      loadTurnSummaryRows,
      managerTimelineView: "standard",
      timelineRows: [turnSummaryRow()],
      threadId: "thread-1",
    });

    await waitFor(() => {
      expect(result.current.turnSummaryRowsById).toEqual({});
      expect(result.current.loadingTurnSummaryIds.size).toBe(0);
      expect(result.current.erroredTurnSummaryIds.size).toBe(0);
    });

    act(() => {
      result.current.handleLoadTurnSummaryRows(turnSummaryRow());
    });

    await waitFor(() => {
      expect(requests).toHaveLength(2);
    });
  });

  it("ignores stale turn details that resolve after manager timeline view changes", async () => {
    const deferred = createDeferred<TimelineTurnSummaryDetailsResponse>();
    const requests: LoadTurnSummaryRowsArgs[] = [];
    const loadTurnSummaryRows: LoadTurnSummaryRows = (args) => {
      requests.push(args);
      return deferred.promise;
    };

    const { result, rerender } = renderHook(
      (props: HookProps) => useTurnSummaryRowLoader(props),
      {
        initialProps: {
          loadTurnSummaryRows,
          managerTimelineView: "conversation",
          timelineRows: [turnSummaryRow()],
          threadId: "thread-1",
        },
      },
    );

    act(() => {
      result.current.handleLoadTurnSummaryRows(turnSummaryRow());
    });

    await waitFor(() => {
      expect(result.current.loadingTurnSummaryIds.has("turn-summary-1")).toBe(
        true,
      );
    });
    expect(requests).toEqual([
      {
        id: "thread-1",
        turnId: "turn-1",
        sourceSeqStart: 1,
        sourceSeqEnd: 3,
      },
    ]);

    rerender({
      loadTurnSummaryRows,
      managerTimelineView: "standard",
      timelineRows: [turnSummaryRow()],
      threadId: "thread-1",
    });

    await waitFor(() => {
      expect(result.current.loadingTurnSummaryIds.size).toBe(0);
    });

    await act(async () => {
      deferred.resolve({ rows: [detailRow("stale conversation detail")] });
      await deferred.promise;
    });

    expect(result.current.turnSummaryRowsById).toEqual({});
    expect(result.current.erroredTurnSummaryIds.size).toBe(0);
    expect(result.current.loadingTurnSummaryIds.size).toBe(0);
  });

  it("deduplicates repeated load requests while keeping the load callback stable", async () => {
    const deferred = createDeferred<TimelineTurnSummaryDetailsResponse>();
    const loadTurnSummaryRows = vi.fn<LoadTurnSummaryRows>(() => {
      return deferred.promise;
    });

    const { result, rerender } = renderHook(
      (props: HookProps) => useTurnSummaryRowLoader(props),
      {
        initialProps: {
          loadTurnSummaryRows,
          managerTimelineView: "standard",
          timelineRows: [turnSummaryRow()],
          threadId: "thread-1",
        },
      },
    );
    const initialLoadCallback = result.current.handleLoadTurnSummaryRows;

    act(() => {
      result.current.handleLoadTurnSummaryRows(turnSummaryRow());
      result.current.handleLoadTurnSummaryRows(turnSummaryRow());
    });

    expect(loadTurnSummaryRows).toHaveBeenCalledTimes(1);
    await waitFor(() => {
      expect(result.current.loadingTurnSummaryIds.has("turn-summary-1")).toBe(
        true,
      );
    });
    expect(result.current.handleLoadTurnSummaryRows).toBe(initialLoadCallback);

    await act(async () => {
      deferred.resolve({ rows: [detailRow("loaded detail")] });
      await deferred.promise;
    });

    await waitFor(() => {
      expect(result.current.turnSummaryRowsById["turn-summary-1"]).toEqual([
        detailRow("loaded detail"),
      ]);
    });
    expect(result.current.handleLoadTurnSummaryRows).toBe(initialLoadCallback);

    const nextLoadTurnSummaryRows: LoadTurnSummaryRows = () =>
      Promise.resolve({ rows: [detailRow("next detail")] });
    rerender({
      loadTurnSummaryRows: nextLoadTurnSummaryRows,
      managerTimelineView: "standard",
      timelineRows: [turnSummaryRow()],
      threadId: "thread-1",
    });

    expect(result.current.handleLoadTurnSummaryRows).toBe(initialLoadCallback);
  });

  it("drops cached details when a capped timeline removes the parent row", async () => {
    const requests: LoadTurnSummaryRowsArgs[] = [];
    const loadTurnSummaryRows: LoadTurnSummaryRows = (args) => {
      requests.push(args);
      return Promise.resolve({ rows: [detailRow("loaded detail")] });
    };

    const { result, rerender } = renderHook(
      (props: HookProps) => useTurnSummaryRowLoader(props),
      {
        initialProps: {
          loadTurnSummaryRows,
          managerTimelineView: "standard",
          timelineRows: [turnSummaryRow()],
          threadId: "thread-1",
        },
      },
    );

    act(() => {
      result.current.handleLoadTurnSummaryRows(turnSummaryRow());
    });

    await waitFor(() => {
      expect(result.current.turnSummaryRowsById["turn-summary-1"]).toEqual([
        detailRow("loaded detail"),
      ]);
    });

    rerender({
      loadTurnSummaryRows,
      managerTimelineView: "standard",
      timelineRows: [],
      threadId: "thread-1",
    });

    await waitFor(() => {
      expect(result.current.turnSummaryRowsById).toEqual({});
      expect(result.current.loadingTurnSummaryIds.size).toBe(0);
      expect(result.current.erroredTurnSummaryIds.size).toBe(0);
    });

    rerender({
      loadTurnSummaryRows,
      managerTimelineView: "standard",
      timelineRows: [turnSummaryRow()],
      threadId: "thread-1",
    });

    act(() => {
      result.current.handleLoadTurnSummaryRows(turnSummaryRow());
    });

    await waitFor(() => {
      expect(requests).toHaveLength(2);
    });
  });

  it("hydrates details by turn id and source range when a visible row id is reused", async () => {
    const initialRow = turnSummaryRow({
      sourceSeqStart: 1,
      sourceSeqEnd: 3,
      turnId: "turn-1",
    });
    const nextRow = turnSummaryRow({
      sourceSeqStart: 10,
      sourceSeqEnd: 12,
      turnId: "turn-1",
    });
    const requests: LoadTurnSummaryRowsArgs[] = [];
    const loadTurnSummaryRows: LoadTurnSummaryRows = (args) => {
      requests.push(args);
      return Promise.resolve({
        rows: [detailRow(`detail-${args.sourceSeqStart}`)],
      });
    };

    const { result, rerender } = renderHook(
      (props: HookProps) => useTurnSummaryRowLoader(props),
      {
        initialProps: {
          loadTurnSummaryRows,
          managerTimelineView: "standard",
          timelineRows: [initialRow],
          threadId: "thread-1",
        },
      },
    );

    act(() => {
      result.current.handleLoadTurnSummaryRows(initialRow);
    });

    await waitFor(() => {
      expect(result.current.turnSummaryRowsById["turn-summary-1"]).toEqual([
        detailRow("detail-1"),
      ]);
    });

    rerender({
      loadTurnSummaryRows,
      managerTimelineView: "standard",
      timelineRows: [nextRow],
      threadId: "thread-1",
    });

    await waitFor(() => {
      expect(result.current.turnSummaryRowsById).toEqual({});
    });

    act(() => {
      result.current.handleLoadTurnSummaryRows(nextRow);
    });

    await waitFor(() => {
      expect(requests).toEqual([
        {
          id: "thread-1",
          turnId: "turn-1",
          sourceSeqStart: 1,
          sourceSeqEnd: 3,
        },
        {
          id: "thread-1",
          turnId: "turn-1",
          sourceSeqStart: 10,
          sourceSeqEnd: 12,
        },
      ]);
      expect(result.current.turnSummaryRowsById["turn-summary-1"]).toEqual([
        detailRow("detail-10"),
      ]);
    });
  });

  it("ignores stale details that resolve after a visible row range changes", async () => {
    const initialRow = turnSummaryRow({
      sourceSeqStart: 1,
      sourceSeqEnd: 3,
    });
    const nextRow = turnSummaryRow({
      sourceSeqStart: 10,
      sourceSeqEnd: 12,
    });
    const deferred = createDeferred<TimelineTurnSummaryDetailsResponse>();
    const requests: LoadTurnSummaryRowsArgs[] = [];
    const loadTurnSummaryRows: LoadTurnSummaryRows = (args) => {
      requests.push(args);
      if (args.sourceSeqStart === 1) {
        return deferred.promise;
      }
      return Promise.resolve({ rows: [detailRow("fresh detail")] });
    };

    const { result, rerender } = renderHook(
      (props: HookProps) => useTurnSummaryRowLoader(props),
      {
        initialProps: {
          loadTurnSummaryRows,
          managerTimelineView: "standard",
          timelineRows: [initialRow],
          threadId: "thread-1",
        },
      },
    );

    act(() => {
      result.current.handleLoadTurnSummaryRows(initialRow);
    });

    await waitFor(() => {
      expect(result.current.loadingTurnSummaryIds.has("turn-summary-1")).toBe(
        true,
      );
    });

    rerender({
      loadTurnSummaryRows,
      managerTimelineView: "standard",
      timelineRows: [nextRow],
      threadId: "thread-1",
    });

    await waitFor(() => {
      expect(result.current.loadingTurnSummaryIds.size).toBe(0);
    });

    await act(async () => {
      deferred.resolve({ rows: [detailRow("stale detail")] });
      await deferred.promise;
    });

    expect(result.current.turnSummaryRowsById).toEqual({});

    act(() => {
      result.current.handleLoadTurnSummaryRows(nextRow);
    });

    await waitFor(() => {
      expect(requests).toEqual([
        {
          id: "thread-1",
          turnId: "turn-1",
          sourceSeqStart: 1,
          sourceSeqEnd: 3,
        },
        {
          id: "thread-1",
          turnId: "turn-1",
          sourceSeqStart: 10,
          sourceSeqEnd: 12,
        },
      ]);
      expect(result.current.turnSummaryRowsById["turn-summary-1"]).toEqual([
        detailRow("fresh detail"),
      ]);
    });
  });
});
