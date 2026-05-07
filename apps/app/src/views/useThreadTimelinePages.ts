import { useCallback, useEffect, useState } from "react";
import type {
  ManagerTimelineView,
  ThreadTimelineResponse,
  TimelinePaginationCursor,
  TimelineRow,
} from "@bb/server-contract";
import { useThreadTimeline } from "@/hooks/queries/thread-queries";
import * as api from "@/lib/api";

interface UseThreadTimelinePagesArgs {
  managerTimelineView: ManagerTimelineView | undefined;
  threadId: string;
}

interface UseThreadTimelinePagesResult {
  activeThinking: ThreadTimelineResponse["activeThinking"];
  contextWindowUsage: ThreadTimelineResponse["contextWindowUsage"];
  hasOlderTimelineRows: boolean;
  isLoadingOlderTimelineRows: boolean;
  loadOlderTimelineRows: () => Promise<void>;
  timelineError: Error | null;
  timelineLoading: boolean;
  timelineRows: TimelineRow[];
}

type NullableTimelinePaginationCursor = TimelinePaginationCursor | null;

export interface LoadedTimelineState {
  olderCursor: NullableTimelinePaginationCursor;
  rows: TimelineRow[];
  surfaceKey: string;
}

interface BuildLoadedTimelineStateArgs {
  latestRows: readonly TimelineRow[];
  olderCursor: NullableTimelinePaginationCursor;
  surfaceKey: string;
}

interface AreTimelinePaginationCursorsEqualArgs {
  left: NullableTimelinePaginationCursor;
  right: NullableTimelinePaginationCursor;
}

export interface MergeLatestTimelineRowsArgs {
  latestRows: readonly TimelineRow[];
  loadedRows: readonly TimelineRow[];
}

interface MergeLatestTimelineRowsResult {
  hasLatestOverlap: boolean;
  rows: TimelineRow[];
}

export interface PrependOlderTimelineRowsArgs {
  loadedRows: readonly TimelineRow[];
  olderRows: readonly TimelineRow[];
}

export interface MergeLoadedTimelineWithLatestArgs {
  current: LoadedTimelineState;
  latestTimeline: ThreadTimelineResponse;
  surfaceKey: string;
}

export interface RecoverLoadedTimelineAfterStaleCursorArgs {
  current: LoadedTimelineState;
  latestTimeline: ThreadTimelineResponse;
  surfaceKey: string;
}

function buildSurfaceKey({
  managerTimelineView,
  threadId,
}: UseThreadTimelinePagesArgs): string {
  return `${threadId}:${managerTimelineView ?? "default"}`;
}

function buildLoadedTimelineState({
  latestRows,
  olderCursor,
  surfaceKey,
}: BuildLoadedTimelineStateArgs): LoadedTimelineState {
  return {
    olderCursor,
    rows: [...latestRows],
    surfaceKey,
  };
}

function areTimelinePaginationCursorsEqual({
  left,
  right,
}: AreTimelinePaginationCursorsEqualArgs): boolean {
  if (left === null || right === null) {
    return left === right;
  }
  return left.anchorSeq === right.anchorSeq && left.anchorId === right.anchorId;
}

function appendTimelineRowsPreservingOrder(
  target: TimelineRow[],
  rows: readonly TimelineRow[],
): void {
  const seenIds = new Set(target.map((row) => row.id));
  for (const row of rows) {
    if (seenIds.has(row.id)) {
      continue;
    }
    seenIds.add(row.id);
    target.push(row);
  }
}

export function prependOlderTimelineRows({
  loadedRows,
  olderRows,
}: PrependOlderTimelineRowsArgs): TimelineRow[] {
  const rows: TimelineRow[] = [];
  appendTimelineRowsPreservingOrder(rows, olderRows);
  appendTimelineRowsPreservingOrder(rows, loadedRows);
  return rows;
}

export function mergeLatestTimelineRows({
  latestRows,
  loadedRows,
}: MergeLatestTimelineRowsArgs): MergeLatestTimelineRowsResult {
  if (loadedRows.length === 0) {
    return {
      hasLatestOverlap: false,
      rows: [...latestRows],
    };
  }

  const latestRowIds = new Set(latestRows.map((row) => row.id));
  const firstLatestOverlapIndex = loadedRows.findIndex((row) =>
    latestRowIds.has(row.id),
  );
  if (firstLatestOverlapIndex === -1) {
    const rows = [...loadedRows];
    appendTimelineRowsPreservingOrder(rows, latestRows);
    return {
      hasLatestOverlap: false,
      rows,
    };
  }

  return {
    hasLatestOverlap: true,
    rows: [...loadedRows.slice(0, firstLatestOverlapIndex), ...latestRows],
  };
}

export function mergeLoadedTimelineWithLatest({
  current,
  latestTimeline,
  surfaceKey,
}: MergeLoadedTimelineWithLatestArgs): LoadedTimelineState {
  if (
    current.surfaceKey !== surfaceKey ||
    (current.rows.length === 0 && current.olderCursor === null)
  ) {
    return buildLoadedTimelineState({
      latestRows: latestTimeline.rows,
      olderCursor: latestTimeline.timelinePage.olderCursor,
      surfaceKey,
    });
  }

  const latestMerge = mergeLatestTimelineRows({
    latestRows: latestTimeline.rows,
    loadedRows: current.rows,
  });

  return {
    ...current,
    olderCursor: current.olderCursor,
    rows: latestMerge.rows,
  };
}

export function recoverLoadedTimelineAfterStaleCursor({
  current,
  latestTimeline,
  surfaceKey,
}: RecoverLoadedTimelineAfterStaleCursorArgs): LoadedTimelineState {
  if (current.surfaceKey !== surfaceKey) {
    return buildLoadedTimelineState({
      latestRows: latestTimeline.rows,
      olderCursor: latestTimeline.timelinePage.olderCursor,
      surfaceKey,
    });
  }

  const latestMerge = mergeLatestTimelineRows({
    latestRows: latestTimeline.rows,
    loadedRows: current.rows,
  });

  return {
    olderCursor: latestTimeline.timelinePage.olderCursor,
    rows: latestMerge.rows,
    surfaceKey,
  };
}

export function isStaleTimelinePaginationCursorError(error: Error): boolean {
  return (
    error instanceof api.HttpError &&
    error.status === 400 &&
    error.code === "invalid_request"
  );
}

export function useThreadTimelinePages({
  managerTimelineView,
  threadId,
}: UseThreadTimelinePagesArgs): UseThreadTimelinePagesResult {
  const latestTimelineQuery = useThreadTimeline(threadId, {
    refetchOnMount: "always",
    managerTimelineView,
  });
  const surfaceKey = buildSurfaceKey({ managerTimelineView, threadId });
  const [loadedTimeline, setLoadedTimeline] = useState<LoadedTimelineState>(
    () =>
      buildLoadedTimelineState({
        latestRows: [],
        olderCursor: null,
        surfaceKey,
      }),
  );
  const [isLoadingOlderTimelineRows, setIsLoadingOlderTimelineRows] =
    useState(false);
  const latestTimeline = latestTimelineQuery.data;

  useEffect(() => {
    if (!latestTimeline) {
      setLoadedTimeline((current) =>
        current.surfaceKey === surfaceKey
          ? current
          : buildLoadedTimelineState({
              latestRows: [],
              olderCursor: null,
              surfaceKey,
            }),
      );
      return;
    }

    setLoadedTimeline((current) =>
      mergeLoadedTimelineWithLatest({
        current,
        latestTimeline,
        surfaceKey,
      }),
    );
  }, [latestTimeline, surfaceKey]);
  const refetchLatestTimeline = latestTimelineQuery.refetch;

  const nextOlderCursor =
    loadedTimeline.surfaceKey === surfaceKey
      ? loadedTimeline.olderCursor
      : null;
  const hasOlderTimelineRows = nextOlderCursor !== null;
  const loadOlderTimelineRows = useCallback(async (): Promise<void> => {
    if (!nextOlderCursor || !threadId || isLoadingOlderTimelineRows) {
      return;
    }

    setIsLoadingOlderTimelineRows(true);
    try {
      const response = await api.getThreadTimeline({
        beforeCursor: nextOlderCursor,
        id: threadId,
        managerTimelineView,
      });
      setLoadedTimeline((current) => {
        if (current.surfaceKey !== surfaceKey) {
          return current;
        }
        return {
          olderCursor: areTimelinePaginationCursorsEqual({
            left: current.olderCursor,
            right: nextOlderCursor,
          })
            ? response.timelinePage.olderCursor
            : current.olderCursor,
          rows: prependOlderTimelineRows({
            loadedRows: current.rows,
            olderRows: response.rows,
          }),
          surfaceKey,
        };
      });
    } catch (error) {
      if (
        !(error instanceof Error) ||
        !isStaleTimelinePaginationCursorError(error)
      ) {
        throw error;
      }

      const latestTimelineResult = await refetchLatestTimeline();
      const recoveredLatestTimeline =
        latestTimelineResult.data ?? latestTimeline;
      setLoadedTimeline((current) => {
        if (current.surfaceKey !== surfaceKey) {
          return current;
        }
        if (!recoveredLatestTimeline) {
          return {
            ...current,
            olderCursor: null,
          };
        }
        return recoverLoadedTimelineAfterStaleCursor({
          current,
          latestTimeline: recoveredLatestTimeline,
          surfaceKey,
        });
      });
    } finally {
      setIsLoadingOlderTimelineRows(false);
    }
  }, [
    isLoadingOlderTimelineRows,
    latestTimeline,
    managerTimelineView,
    nextOlderCursor,
    refetchLatestTimeline,
    surfaceKey,
    threadId,
  ]);

  return {
    activeThinking: latestTimeline?.activeThinking ?? null,
    contextWindowUsage: latestTimeline?.contextWindowUsage,
    hasOlderTimelineRows,
    isLoadingOlderTimelineRows,
    loadOlderTimelineRows,
    timelineError: latestTimelineQuery.error,
    timelineLoading: latestTimelineQuery.isLoading,
    timelineRows:
      loadedTimeline.surfaceKey === surfaceKey && loadedTimeline.rows.length > 0
        ? loadedTimeline.rows
        : (latestTimeline?.rows ?? []),
  };
}
