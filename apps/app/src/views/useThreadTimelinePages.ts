import { useCallback, useEffect, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import type {
  ManagerTimelineView,
  ThreadTimelineResponse,
  TimelinePaginationCursor,
  TimelineRow,
} from "@bb/server-contract";
import { useThreadTimeline } from "@/hooks/queries/thread-queries";
import { threadTimelineOlderQueryKey } from "@/hooks/queries/query-keys";
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

interface LoadedTimelineState {
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

interface MergeLatestTimelineRowsArgs {
  latestRows: readonly TimelineRow[];
  loadedRows: readonly TimelineRow[];
}

interface MergeLatestTimelineRowsResult {
  hasLatestOverlap: boolean;
  rows: TimelineRow[];
}

interface PrependOlderTimelineRowsArgs {
  loadedRows: readonly TimelineRow[];
  olderRows: readonly TimelineRow[];
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

function compareTimelineRows(rowA: TimelineRow, rowB: TimelineRow): number {
  if (rowA.sourceSeqStart !== rowB.sourceSeqStart) {
    return rowA.sourceSeqStart - rowB.sourceSeqStart;
  }
  if (rowA.id === rowB.id) {
    return 0;
  }
  return rowA.id < rowB.id ? -1 : 1;
}

function areTimelinePaginationCursorsEqual({
  left,
  right,
}: AreTimelinePaginationCursorsEqualArgs): boolean {
  if (left === null || right === null) {
    return left === right;
  }
  return left.seq === right.seq && left.id === right.id;
}

function prependOlderTimelineRows({
  loadedRows,
  olderRows,
}: PrependOlderTimelineRowsArgs): TimelineRow[] {
  const rowsById = new Map<string, TimelineRow>();
  for (const row of olderRows) {
    rowsById.set(row.id, row);
  }
  for (const row of loadedRows) {
    rowsById.set(row.id, row);
  }
  return [...rowsById.values()].sort(compareTimelineRows);
}

function mergeLatestTimelineRows({
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
    return {
      hasLatestOverlap: false,
      rows: prependOlderTimelineRows({
        loadedRows: latestRows,
        olderRows: loadedRows,
      }),
    };
  }

  return {
    hasLatestOverlap: true,
    rows: [...loadedRows.slice(0, firstLatestOverlapIndex), ...latestRows],
  };
}

function mergeLoadedTimelineWithLatest(
  current: LoadedTimelineState,
  latestTimeline: ThreadTimelineResponse,
  surfaceKey: string,
): LoadedTimelineState {
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
    olderCursor: latestMerge.hasLatestOverlap
      ? current.olderCursor
      : (latestTimeline.timelinePage.olderCursor ?? current.olderCursor),
    rows: latestMerge.rows,
  };
}

export function useThreadTimelinePages({
  managerTimelineView,
  threadId,
}: UseThreadTimelinePagesArgs): UseThreadTimelinePagesResult {
  const queryClient = useQueryClient();
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
      mergeLoadedTimelineWithLatest(current, latestTimeline, surfaceKey),
    );
  }, [latestTimeline, surfaceKey]);

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
      const response = await queryClient.fetchQuery({
        queryKey: threadTimelineOlderQueryKey(
          threadId,
          managerTimelineView,
          nextOlderCursor,
        ),
        queryFn: () =>
          api.getThreadTimeline({
            beforeCursor: nextOlderCursor,
            id: threadId,
            managerTimelineView,
          }),
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
    } finally {
      setIsLoadingOlderTimelineRows(false);
    }
  }, [
    isLoadingOlderTimelineRows,
    managerTimelineView,
    nextOlderCursor,
    queryClient,
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
