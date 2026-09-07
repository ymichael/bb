import { useCallback, useEffect, useState } from "react";
import type { ThreadTimelineResponse, TimelineRow } from "@bb/server-contract";
import {
  areTimelinePaginationCursorsEqual,
  buildLoadedTimelineState,
  mergeLoadedTimelineWithLatest,
  prependOlderTimelineRows,
  recoverLoadedTimelineAfterStaleCursor,
  type LoadedTimelineState,
} from "@bb/client-core";
import { useConnectionAwareQueryState } from "@/hooks/queries/connection-aware-query-state";
import { isTransientReadError } from "@/hooks/queries/query-helpers";
import { useThreadTimeline } from "@/hooks/queries/thread-queries";
import { BbHttpError, sdk } from "@/lib/sdk";

interface UseThreadTimelineControllerArgs {
  enabled?: boolean;
  surfaceKey?: string;
  threadId: string;
}

export interface UseThreadTimelineControllerResult {
  activePromptMode: ThreadTimelineResponse["activePromptMode"];
  activeThinking: ThreadTimelineResponse["activeThinking"];
  activeWorkflows: ThreadTimelineResponse["activeWorkflows"];
  activeBackgroundCommands: ThreadTimelineResponse["activeBackgroundCommands"];
  contextBoundarySeq: ThreadTimelineResponse["contextBoundarySeq"];
  contextWindowUsage: ThreadTimelineResponse["contextWindowUsage"];
  goal: ThreadTimelineResponse["goal"];
  modelFallback: ThreadTimelineResponse["modelFallback"];
  hasOlderTimelineRows: boolean;
  isLoadingOlderTimelineRows: boolean;
  loadOlderTimelineRows: () => Promise<void>;
  pendingTodos: ThreadTimelineResponse["pendingTodos"];
  timelineError: Error | null;
  timelineLoading: boolean;
  timelineRows: TimelineRow[];
}

function isStaleTimelinePaginationCursorError(error: Error): boolean {
  return (
    error instanceof BbHttpError &&
    error.status === 400 &&
    error.code === "invalid_request"
  );
}

export function useThreadTimelineController({
  enabled = true,
  surfaceKey: explicitSurfaceKey,
  threadId,
}: UseThreadTimelineControllerArgs): UseThreadTimelineControllerResult {
  const latestTimelineQuery = useThreadTimeline(threadId, {
    enabled,
    refetchOnMount: true,
  });
  const baseSurfaceKey = explicitSurfaceKey ?? threadId;
  const contextBoundarySeq =
    latestTimelineQuery.data?.contextBoundarySeq ?? null;
  const surfaceKey =
    contextBoundarySeq === null
      ? baseSurfaceKey
      : `${baseSurfaceKey}:context-boundary:${contextBoundarySeq}`;
  const [loadedTimeline, setLoadedTimeline] = useState<LoadedTimelineState>(
    () =>
      buildLoadedTimelineState({
        latestWindowEndSequence: null,
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
              latestWindowEndSequence: null,
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
    if (
      !enabled ||
      !nextOlderCursor ||
      !threadId ||
      isLoadingOlderTimelineRows
    ) {
      return;
    }

    setIsLoadingOlderTimelineRows(true);
    try {
      const response = await sdk.threads.timeline({
        beforeAnchorId: nextOlderCursor.anchorId,
        beforeAnchorSeq: String(nextOlderCursor.anchorSeq),
        threadId,
      });
      const olderRows = [...response.rows];
      setLoadedTimeline((current) => {
        if (current.surfaceKey !== surfaceKey) {
          return current;
        }
        return {
          ...current,
          olderCursor: areTimelinePaginationCursorsEqual({
            left: current.olderCursor,
            right: nextOlderCursor,
          })
            ? response.timelinePage.olderCursor
            : current.olderCursor,
          rows: prependOlderTimelineRows({
            loadedRows: current.rows,
            olderRows,
          }),
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
    enabled,
    isLoadingOlderTimelineRows,
    latestTimeline,
    nextOlderCursor,
    refetchLatestTimeline,
    surfaceKey,
    threadId,
  ]);
  const timelineRows =
    loadedTimeline.surfaceKey === surfaceKey && loadedTimeline.rows.length > 0
      ? loadedTimeline.rows
      : (latestTimeline?.rows ?? []);
  const timelineQueryState = useConnectionAwareQueryState({
    hasResolvedData:
      latestTimelineQuery.data !== undefined || timelineRows.length > 0,
    isFetching: latestTimelineQuery.isFetching,
    isLoadingError: latestTimelineQuery.isLoadingError,
    isRecoverableLoadingError: isTransientReadError(latestTimelineQuery.error),
  });
  const timelineLoading =
    latestTimelineQuery.isLoading ||
    (timelineQueryState.status === "loading" && timelineRows.length === 0) ||
    (latestTimelineQuery.isFetching && timelineRows.length === 0);
  const timelineError =
    timelineLoading || timelineQueryState.status !== "unavailable"
      ? null
      : latestTimelineQuery.error;

  return {
    activePromptMode: latestTimeline?.activePromptMode ?? null,
    activeThinking: latestTimeline?.activeThinking ?? null,
    activeWorkflows: latestTimeline?.activeWorkflows ?? [],
    activeBackgroundCommands: latestTimeline?.activeBackgroundCommands ?? [],
    contextBoundarySeq,
    contextWindowUsage: latestTimeline?.contextWindowUsage,
    goal: latestTimeline?.goal ?? null,
    modelFallback: latestTimeline?.modelFallback ?? null,
    hasOlderTimelineRows,
    isLoadingOlderTimelineRows,
    loadOlderTimelineRows,
    pendingTodos: latestTimeline?.pendingTodos ?? null,
    timelineError,
    timelineLoading,
    timelineRows,
  };
}
